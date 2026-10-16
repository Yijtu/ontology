import { isRecord } from '@ontology/contracts'
import {
  DocumentTargetedReadError,
  ResearchDocumentSetError,
} from '@ontology/contracts'
import { ToolGatewayError } from '@ontology/tool-services'
import type {
  ToolExecutionOutcome,
  ToolExecutionRequest,
  ToolHandler,
} from '@ontology/tool-services'
import type {
  DocumentSpan,
  ResearchDocumentMember,
  ResourceRef,
  SourceRef,
  ToolContext,
  Uuid,
  WebSearchToolPage,
} from '@ontology/contracts'
import type { DocumentTargetedReadService, ResearchDocumentSetService } from '@ontology/application'
import type { WorkspaceResearchContextResolver } from './core-workspace-research-context'

/**
 * The research tool assembly (design §4/§6, S07).
 *
 * A workspace-research run reaches the same four public tools through the same gateway, but its
 * `web_search`/`document_search`/`ontology_lookup` handlers are the **research** ones: every call
 * executes under the receipt-derived research context (never the wide worker context), a public
 * page this run archives is staged into its research evidence set, and `document_search` gains the
 * versioned **targeted read** branch so the agent continues reading the exact archived/authorized
 * document instead of re-searching a summary. A selection that this run never staged — a page in
 * another workspace/run, or a link-only discovery that was never archived — is refused explicitly.
 */

const DEFAULT_TARGETED_MAX_BYTES = 16 * 1024
const MAX_TARGETED_MAX_BYTES = 64 * 1024
const DEFAULT_TARGETED_LIMIT = 8
const MAX_TARGETED_LIMIT = 64
/** The bounded number of staged members a research search may scan (never the whole set). */
const MAX_SEARCH_MEMBERS = 100
const MEMBER_PAGE = 200
const RESEARCH_SET_SOURCE_SCHEMA = 'research-document-set@1'

/** The research source this tool reads; used for the evidence snapshot. */
const RESEARCH_DOCUMENT_SOURCE: SourceRef = { namespace: 'ontology-core-local', sourceId: 'research-document-set' }

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback
  return Math.min(Math.max(n, min), max)
}

function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

function blockedContextError(error: unknown): ToolGatewayError {
  return new ToolGatewayError(
    'HANDLER_FAILED',
    error instanceof Error ? error.message : 'the research run context could not be rebuilt',
    { platformCode: 'CAPABILITY_NOT_CONFIGURED', cause: error },
  )
}

/** Map a targeted-reader / staging refusal onto the canonical tool-gateway classification. */
function mapReadError(error: unknown): ToolGatewayError {
  if (error instanceof DocumentTargetedReadError) {
    const platformCode =
      error.code === 'SCOPE_MISMATCH' || error.code === 'NOT_FOUND' ? 'FORBIDDEN' : 'INVALID_ARGUMENT'
    return new ToolGatewayError(error.code === 'SCOPE_MISMATCH' ? 'SCOPE_MISMATCH' : 'HANDLER_FAILED', error.message, {
      platformCode,
      cause: error,
    })
  }
  if (error instanceof ResearchDocumentSetError) {
    return new ToolGatewayError('HANDLER_FAILED', error.message, { platformCode: 'SOURCE_UNAVAILABLE', cause: error })
  }
  return new ToolGatewayError('HANDLER_FAILED', error instanceof Error ? error.message : 'the research read failed', {
    cause: error,
  })
}

/* --------------------------------------------------------------------------------- document_search */

interface TargetedReadSelectionInput {
  readonly documentRef: ResourceRef
  readonly locator?: DocumentSpan['locator']
  readonly parseId?: Uuid
}

interface TargetedReadInput {
  readonly selections: readonly TargetedReadSelectionInput[]
  readonly cursor?: string
  readonly maxBytes?: number
  readonly limit?: number
}

function locatorOf(value: unknown): DocumentSpan['locator'] | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined
  if (!['page', 'offset', 'approximate_locator'].includes(value.kind)) return undefined
  return {
    kind: value.kind as DocumentSpan['locator']['kind'],
    ...(typeof value.page === 'number' ? { page: value.page } : {}),
    ...(typeof value.startOffset === 'number' ? { startOffset: value.startOffset } : {}),
    ...(typeof value.endOffset === 'number' ? { endOffset: value.endOffset } : {}),
    ...(typeof value.normalizationMapRef === 'string' ? { normalizationMapRef: value.normalizationMapRef } : {}),
  }
}

function refOf(value: unknown): ResourceRef | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.version !== 'string'
    || typeof value.digest !== 'string' || typeof value.kind !== 'string') return undefined
  return { id: value.id, version: value.version, digest: value.digest, kind: value.kind as ResourceRef['kind'] }
}

function readTargetedRead(args: Readonly<Record<string, unknown>>): TargetedReadInput | undefined {
  const raw = args['targetedRead']
  if (raw === undefined) return undefined
  if (!isRecord(raw) || !Array.isArray(raw['selections'])) {
    throw new ToolGatewayError('INVALID_ARGUMENTS', 'targetedRead requires a bounded selections array')
  }
  const selections: TargetedReadSelectionInput[] = []
  for (const entry of raw['selections']) {
    if (!isRecord(entry)) throw new ToolGatewayError('INVALID_ARGUMENTS', 'each targetedRead selection must be an object')
    const documentRef = refOf(entry['documentRef'])
    if (documentRef === undefined) throw new ToolGatewayError('INVALID_ARGUMENTS', 'each targetedRead selection requires a documentRef')
    const locator = locatorOf(entry['locator'])
    selections.push({
      documentRef,
      ...(locator === undefined ? {} : { locator }),
      ...(typeof entry['parseId'] === 'string' ? { parseId: entry['parseId'] } : {}),
    })
  }
  return {
    selections,
    ...(typeof raw['cursor'] === 'string' ? { cursor: raw['cursor'] } : {}),
    ...(typeof raw['maxBytes'] === 'number' ? { maxBytes: raw['maxBytes'] } : {}),
    ...(typeof raw['limit'] === 'number' ? { limit: raw['limit'] } : {}),
  }
}

export interface ResearchDocumentSearchHandlerDependencies {
  readonly runId: Uuid
  readonly workspaceId: Uuid
  readonly context: WorkspaceResearchContextResolver
  /** The run's staged evidence set; membership is what authorizes a targeted read. */
  readonly members: ResearchDocumentSetService
  readonly targetedRead: DocumentTargetedReadService
  readonly sourceRef?: SourceRef
}

export function createResearchDocumentSearchHandler(
  dependencies: ResearchDocumentSearchHandlerDependencies,
): ToolHandler {
  const sourceRef = dependencies.sourceRef ?? RESEARCH_DOCUMENT_SOURCE

  const loadMembers = async (ctx: ToolContext): Promise<ResearchDocumentMember[]> => {
    const out: ResearchDocumentMember[] = []
    let cursor: string | undefined
    for (let page = 0; page <= MAX_SEARCH_MEMBERS / MEMBER_PAGE; page += 1) {
      const listed = await dependencies.members.listMembers(
        { workspaceId: dependencies.workspaceId, runId: dependencies.runId, limit: MEMBER_PAGE, ...(cursor === undefined ? {} : { cursor }) },
        ctx,
      )
      out.push(...listed.members)
      if (listed.nextCursor === undefined || out.length >= MAX_SEARCH_MEMBERS) return out.slice(0, MAX_SEARCH_MEMBERS)
      cursor = listed.nextCursor
    }
    return out
  }

  const authorizeSelections = (members: readonly ResearchDocumentMember[], selections: readonly TargetedReadSelectionInput[]): void => {
    for (const [index, selection] of selections.entries()) {
      const member = members.find((candidate) =>
        (selection.parseId === undefined ? false : candidate.parseId === selection.parseId)
        || sameRef(candidate.documentRef, selection.documentRef)
        || sameRef(candidate.parseRef, selection.documentRef))
      if (member === undefined) {
        // Covers both a cross-workspace/run ref and a discovery-only link: neither is staged in
        // this run's evidence set, so neither can be read as an archived original (design §6).
        throw new ToolGatewayError(
          'SCOPE_MISMATCH',
          `targeted read selection ${String(index)} is not material this run obtained (not staged for workspace ${dependencies.workspaceId} / run ${dependencies.runId})`,
          { platformCode: 'FORBIDDEN' },
        )
      }
    }
  }

  return {
    toolId: 'document_search',
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
      const resolution = await dependencies.context.resolve(dependencies.runId, request.ctx).catch((error: unknown) => {
        throw blockedContextError(error)
      })
      const ctx = resolution.ctx
      request.signal.throwIfAborted()
      const members = await loadMembers(ctx)
      const targeted = readTargetedRead(request.arguments)

      if (targeted !== undefined) {
        authorizeSelections(members, targeted.selections)
        const maxBytes = clampInt(targeted.maxBytes, DEFAULT_TARGETED_MAX_BYTES, 1, MAX_TARGETED_MAX_BYTES)
        const limit = clampInt(targeted.limit, DEFAULT_TARGETED_LIMIT, 1, MAX_TARGETED_LIMIT)
        const result = await dependencies.targetedRead
          .read(
            {
              schemaVersion: 'document-targeted-read@1',
              workspaceId: dependencies.workspaceId,
              selections: targeted.selections,
              ...(targeted.cursor === undefined ? {} : { cursor: targeted.cursor }),
              maxBytes,
              limit,
            },
            ctx,
          )
          .catch((error: unknown) => {
            throw mapReadError(error)
          })
        request.signal.throwIfAborted()
        return {
          payload: {
            mode: 'targeted_read',
            schemaVersion: result.schemaVersion,
            items: result.items,
            ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
            truncated: result.truncated,
            usage: result.usage,
          },
          status: result.items.length === 0 ? 'empty' : result.truncated ? 'partial' : 'ok',
          coverage: {
            returned: result.items.length,
            truncated: result.truncated,
            completeness: result.truncated ? 'truncated' : 'complete',
          },
          sources: [{ sourceRef, schemaVersion: RESEARCH_SET_SOURCE_SCHEMA, consistency: 'read_time' }],
          dataMode: 'observed',
          usage: { bytes: result.usage.bytes },
        }
      }

      // Search mode: a bounded keyword scan of the run's staged set. There is no index over
      // research staging (design §6: "尚未索引" is readable), so the handler reads each staged
      // member's bounded preface directly and reports the honest matches.
      const query = typeof request.arguments['query'] === 'string' ? request.arguments['query'] : undefined
      if (query === undefined || query.length === 0) {
        throw new ToolGatewayError('INVALID_ARGUMENTS', 'document_search requires a non-empty query or a targetedRead selection')
      }
      const tokens = query.toLowerCase().split(/\s+/u).filter((token) => token.length > 0)
      const spans: DocumentSpan[] = []
      let scannedBytes = 0
      let truncatedScan = false
      for (const member of members) {
        if (spans.length >= MAX_SEARCH_MEMBERS) { truncatedScan = true; break }
        const read = await dependencies.targetedRead
          .read(
            {
              schemaVersion: 'document-targeted-read@1',
              workspaceId: dependencies.workspaceId,
              selections: [{ documentRef: member.documentRef, parseId: member.parseId }],
              maxBytes: DEFAULT_TARGETED_MAX_BYTES,
              limit: 1,
            },
            ctx,
          )
          .catch((error: unknown) => {
            throw mapReadError(error)
          })
        const item = read.items[0]
        if (item === undefined || item.text.length === 0 || item.unavailableReason !== undefined) continue
        scannedBytes += byteLength(item.text)
        const haystack = item.text.toLowerCase()
        if (tokens.every((token) => haystack.includes(token))) {
          spans.push({
            documentRef: item.documentRef,
            locator: item.locator,
            quoteDigest: item.quoteDigest,
            spanKind: 'normalized',
          })
        }
      }
      request.signal.throwIfAborted()
      return {
        payload: {
          mode: 'search',
          spans,
          scoreKind: 'none',
          indexVersion: RESEARCH_SET_SOURCE_SCHEMA,
          completeness: truncatedScan ? 'truncated' : 'complete',
        },
        status: spans.length === 0 ? 'empty' : truncatedScan ? 'partial' : 'ok',
        coverage: {
          returned: spans.length,
          truncated: truncatedScan,
          completeness: truncatedScan ? 'truncated' : 'complete',
        },
        sources: [{ sourceRef, schemaVersion: RESEARCH_SET_SOURCE_SCHEMA, consistency: 'read_time' }],
        dataMode: 'observed',
        usage: { bytes: scannedBytes },
      }
    },
  }
}

/* ------------------------------------------------------------------------------------- web_search */

function pagesOf(payload: unknown): readonly WebSearchToolPage[] {
  if (!isRecord(payload) || !Array.isArray(payload['pages'])) return []
  return payload['pages'] as readonly WebSearchToolPage[]
}

export interface ResearchWebSearchHandlerDependencies {
  /** The already-built, provider-bound `web_search` handler for this run. */
  readonly inner: ToolHandler
  readonly runId: Uuid
  readonly workspaceId: Uuid
  readonly context: WorkspaceResearchContextResolver
  /** Staging: an archived page becomes a readable member of this run's evidence set (design §4). */
  readonly staging: ResearchDocumentSetService
}

/**
 * Wrap the run's provider-bound `web_search` so every archived page is staged into the run's
 * research evidence set under the receipt-derived context. The inner handler still owns the
 * enablement gate and the provider call; this wrapper only adds the staging step and surfaces the
 * discovery-only links honestly instead of silently dropping them.
 */
export function createResearchWebSearchHandler(dependencies: ResearchWebSearchHandlerDependencies): ToolHandler {
  return {
    toolId: 'web_search',
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
      const resolution = await dependencies.context.resolve(dependencies.runId, request.ctx).catch((error: unknown) => {
        throw blockedContextError(error)
      })
      const ctx = resolution.ctx
      const outcome = await dependencies.inner.execute({ ...request, ctx })
      const pages = pagesOf(outcome.payload)
      if (pages.length === 0) return outcome
      const staged = await dependencies.staging
        .stageArchivedDiscoveries({ workspaceId: dependencies.workspaceId, runId: dependencies.runId, pages }, ctx)
        .catch((error: unknown) => {
          throw mapReadError(error)
        })
      if (staged.skipped.length === 0) return outcome
      return {
        ...outcome,
        warnings: [
          ...(outcome.warnings ?? []),
          {
            code: 'WEB_DISCOVERY_ONLY_NOT_STAGED',
            message: `${String(staged.skipped.length)} link-only discovery(ies) were not staged (${staged.skipped.map((entry) => entry.reason).join(', ')}); they cannot ground a candidate`,
          },
        ],
      }
    },
  }
}

/* ------------------------------------------------------------------------------ ontology_lookup */

export interface ResearchOntologyLookupHandlerDependencies {
  /** The base `ontology_lookup` handler; the wrapper re-scopes it to the research workspace. */
  readonly inner: ToolHandler
  readonly runId: Uuid
  readonly context: WorkspaceResearchContextResolver
}

/**
 * Bind `ontology_lookup` to the research run's workspace. The base handler reads the visible
 * definitions/facts through the trusted context; this wrapper resolves the receipt-derived context
 * and forces the lookup's `scopeRef` to that workspace, so a model-supplied scope can never widen
 * the read beyond the workspace the run was admitted against (design §6).
 */
export function createResearchOntologyLookupHandler(
  dependencies: ResearchOntologyLookupHandlerDependencies,
): ToolHandler {
  return {
    toolId: 'ontology_lookup',
    async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
      const resolution = await dependencies.context.resolve(dependencies.runId, request.ctx).catch((error: unknown) => {
        throw blockedContextError(error)
      })
      const ctx = resolution.ctx
      const namespace = isRecord(request.arguments['scopeRef']) && typeof request.arguments['scopeRef']['namespace'] === 'string'
        ? request.arguments['scopeRef']['namespace']
        : undefined
      const scoped = {
        ...request.arguments,
        scopeRef: {
          tenantId: ctx.principal.tenantId,
          spaceId: ctx.allowedResources.spaceId,
          ...(namespace === undefined ? {} : { namespace }),
        },
      }
      return dependencies.inner.execute({ ...request, ctx, arguments: scoped })
    },
  }
}
