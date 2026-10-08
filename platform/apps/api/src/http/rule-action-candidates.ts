import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isResourceRef, isRuleActionCandidateKind } from '@ontology/contracts'
import type {
  ActionCapabilityBindingInput,
  ResourceRef,
  RevisionString,
  RuleActionCandidateKind,
  RuleActionCandidateLifecycle,
  ToolContext,
  RuleActionSourceSelection,
} from '@ontology/contracts'
import type { RuleActionCandidateService, RuleActionCandidateGenerationService } from '@ontology/application'
import { parseRuleActionCandidateOutput, RuleActionCandidateError } from '@ontology/application'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  isRecord,
  readHeader,
  readQueryInteger,
  readQueryString,
  readRevisionHeader,
  readTraceId,
  InvalidRequestFieldError,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 250
const LIFECYCLES: readonly RuleActionCandidateLifecycle[] = ['draft', 'enabled', 'rejected']

export interface RuleActionCandidateRouteDependencies {
  readonly generation?: RuleActionCandidateGenerationService
  readonly service: RuleActionCandidateService
  readonly authenticate: RequestAuthenticator
  /**
   * The trusted deployment binding context for action candidates (registered operations and
   * the capabilities/operations authorized for this host). It is never read from the request
   * body or a model response.
   */
  readonly bindingContext?: (ctx: ToolContext) => ActionCapabilityBindingInput
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new InvalidRequestFieldError(`field ${key} is not accepted by this route`)
    }
  }
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined) {
    throw new InvalidRequestFieldError('an Idempotency-Key header is required')
  }
  return key
}

function readIfMatch(request: FastifyRequest): RevisionString | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new InvalidRequestFieldError('If-Match must be a decimal revision string')
  }
  return header.value
}

function readNonEmpty(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty string`)
  }
  return value
}

function parseSourceRefs(value: unknown): readonly ResourceRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new InvalidRequestFieldError('sourceRefs must be an array of resource references')
  }
  return value.map((entry, index) => {
    if (!isResourceRef(entry)) {
      throw new InvalidRequestFieldError(`sourceRefs[${String(index)}] must be a resource reference`)
    }
    return entry
  })
}

/**
 * Accept either a raw model response string or already-structured `rules`/`actions` arrays and
 * normalize both to the one JSON body the parser consumes. Human and model input therefore go
 * through exactly the same validation and support checks.
 */
function parseSourceSelections(value: unknown): RuleActionSourceSelection[] {
  if (!Array.isArray(value) || value.length > 128) throw new InvalidRequestFieldError('sourceSelections must be a bounded array')
  return value.map((selection) => {
    if (!isRecord(selection) || typeof selection['path'] !== 'string' || typeof selection['sourceIndex'] !== 'number' || typeof selection['fragmentIndex'] !== 'number') throw new InvalidRequestFieldError('source selection requires path/sourceIndex/fragmentIndex')
    rejectUnknownFields(selection, ['path','sourceIndex','fragmentIndex'])
    return { path: selection['path'], sourceIndex: selection['sourceIndex'], fragmentIndex: selection['fragmentIndex'] }
  })
}

function readRawOutput(body: Record<string, unknown>): string {
  const raw = body['rawOutput']
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new InvalidRequestFieldError('rawOutput must be a non-empty JSON string')
    }
    return raw
  }
  const rules = body['rules'] ?? (body['rule'] === undefined ? undefined : [body['rule']])
  const actions = body['actions'] ?? (body['action'] === undefined ? undefined : [body['action']])
  if (rules === undefined && actions === undefined) {
    throw new InvalidRequestFieldError('provide a rawOutput string or rule/action(s)')
  }
  if (rules !== undefined && !Array.isArray(rules)) {
    throw new InvalidRequestFieldError('rules must be an array')
  }
  if (actions !== undefined && !Array.isArray(actions)) {
    throw new InvalidRequestFieldError('actions must be an array')
  }
  return JSON.stringify({ rules: rules ?? [], actions: actions ?? [] })
}

function readPageSize(request: FastifyRequest): number {
  const raw = readQueryInteger(request, 'pageSize') ?? readQueryInteger(request, 'limit')
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new InvalidRequestFieldError('pageSize must be a positive integer')
  }
  return Math.min(raw, MAX_PAGE_SIZE)
}

/**
 * The rule/action candidate surface (SPEC v0.3a §8.1, issue V03-010 / #184).
 *
 * It reuses the shared Fastify envelope and the trusted request context: identity, scope and
 * trace id come from the server-side authenticator, never the body. Reads are available to any
 * authenticated principal in scope; proposals, edits and enablement are gated by the service
 * on an editor role and use If-Match/CAS. The action binding context is injected by the host,
 * so a model suggestion can never select an unregistered or unauthorized implementation.
 */
export function registerRuleActionCandidateRoutes(
  app: FastifyInstance,
  dependencies: RuleActionCandidateRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string): ToolContext =>
    createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: resourceId })

  app.post<{ Params: { workspaceId: string } }>('/api/v1/industry-workspaces/:workspaceId/rule-action-generations', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const generator = dependencies.generation
    if (generator === undefined) throw new RuleActionCandidateError('MODEL_NOT_CONFIGURED', 'rule/action model generation is not configured')
    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('generation body must be an object')
    rejectUnknownFields(body, ['sourceRefs','kinds','selectedDefinitionCandidateIds','generationPolicyRef','candidateLimit'])
    const kinds = body['kinds']
    if (!Array.isArray(kinds) || !kinds.every(isRuleActionCandidateKind)) throw new InvalidRequestFieldError('kinds must contain rule/action')
    const selected = body['selectedDefinitionCandidateIds']
    if (selected !== undefined && (!Array.isArray(selected) || !selected.every((id) => typeof id === 'string'))) throw new InvalidRequestFieldError('selectedDefinitionCandidateIds must be ids')
    const policy = body['generationPolicyRef']
    if (!isRecord(policy) || typeof policy['id'] !== 'string' || typeof policy['version'] !== 'string' || typeof policy['digest'] !== 'string') throw new InvalidRequestFieldError('generationPolicyRef must be an exact version reference')
    const limit = body['candidateLimit']
    if (limit !== undefined && typeof limit !== 'number') throw new InvalidRequestFieldError('candidateLimit must be numeric')
    const policyRef = { id: policy['id'], version: policy['version'], digest: policy['digest'] }
    const result = await withGenerationSignal(request, reply, (signal) => generator.generate({ workspaceId: request.params.workspaceId,
      expectedRevision: readIfMatch(request), sourceRefs: parseSourceRefs(body['sourceRefs']), kinds,
      generationPolicyRef: policyRef,
      ...(selected === undefined ? {} : { selectedDefinitionCandidateIds: selected }), ...(limit === undefined ? {} : { candidateLimit: limit }),
      idempotencyKey: requireIdempotencyKey(request) }, auth.principal.subjectId, contextFor(auth, traceId, request.params.workspaceId), signal))
    reply.status(result.created ? 201 : 200).send({ data: result, meta: { traceId } })
    return reply
  })

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/rule-action-candidates/ingest',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['rawOutput', 'rules', 'actions', 'sourceRefs'])
      const ctx = contextFor(auth, traceId, workspaceId)
      const bindingContext = dependencies.bindingContext?.(ctx)
      const view = await dependencies.service.ingestRuleActionOutput(
        workspaceId,
        {
          expectedRevision: readIfMatch(request),
          rawOutput: readRawOutput(body),
          sourceRefs: parseSourceRefs(body['sourceRefs']),
          idempotencyKey: requireIdempotencyKey(request),
          ...(bindingContext === undefined ? {} : { bindingContext }),
        },
        auth.principal.subjectId,
        ctx,
      )
      reply.status(201).send({ data: view, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; candidateId: string } }>('/api/v1/industry-workspaces/:workspaceId/rule-action-candidates/:candidateId/source-confirmations', async (request, reply) => {
    const traceId = readTraceId(request), auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const generator = dependencies.generation
    if (generator === undefined) throw new RuleActionCandidateError('MODEL_NOT_CONFIGURED', 'rule/action source confirmation is not configured')
    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('confirmation body must be an object')
    rejectUnknownFields(body, ['contentDigest','sourceRefs','sourceSelections','reason'])
    const result = await withGenerationSignal(request, reply, (signal) => generator.confirmSources({ workspaceId: request.params.workspaceId, candidateId: request.params.candidateId,
      contentDigest: readNonEmpty(body, 'contentDigest'), sourceRefs: parseSourceRefs(body['sourceRefs']), sourceSelections: parseSourceSelections(body['sourceSelections']),
      reason: readNonEmpty(body, 'reason'), expectedRevision: readIfMatch(request), idempotencyKey: requireIdempotencyKey(request) }, auth.principal.subjectId,
      contextFor(auth, traceId, request.params.workspaceId), signal))
    reply.status(result.created ? 201 : 200).send({ data: result, meta: { traceId } }); return reply
  })

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/rule-action-candidates',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const kind = readQueryString(request, 'kind')
      if (kind !== undefined && !isRuleActionCandidateKind(kind)) {
        throw new InvalidRequestFieldError('kind must be rule or action')
      }
      const lifecycle = readQueryString(request, 'lifecycle')
      if (lifecycle !== undefined && !(LIFECYCLES as readonly string[]).includes(lifecycle)) {
        throw new InvalidRequestFieldError(`lifecycle must be one of ${LIFECYCLES.join(', ')}`)
      }
      const candidates = await dependencies.service.listCandidates(
        workspaceId,
        {
          ...(kind === undefined ? {} : { kind: kind as RuleActionCandidateKind }),
          ...(lifecycle === undefined ? {} : { lifecycle: lifecycle as RuleActionCandidateLifecycle }),
          limit: readPageSize(request),
        },
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { candidates }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; candidateId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/rule-action-candidates/:candidateId/edits',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { workspaceId, candidateId } = request.params
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['rule', 'action', 'reason', 'sourceRefs'])
      const reason = readNonEmpty(body, 'reason')
      const key = requireIdempotencyKey(request)
      const sourceRefs = parseSourceRefs(body['sourceRefs'])
      const ctx = contextFor(auth, traceId, workspaceId)
      const parsed = parseRuleActionCandidateOutput(readRawOutput(body))
      const draft = parsed.candidates[0]
      if (parsed.candidates.length !== 1 || draft === undefined) {
        throw new InvalidRequestFieldError('provide exactly one rule or one action to edit')
      }
      if (draft.kind === 'rule') {
        const candidate = await dependencies.service.editRuleCandidate(
          workspaceId,
          {
            candidateId,
            expectedRevision: readIfMatch(request),
            reason,
            idempotencyKey: key,
            displayName: draft.displayName,
            businessMeaning: draft.businessMeaning,
            suggestedReason: draft.suggestedReason,
            ruleId: draft.ruleId,
            applicability: {
              objectId: draft.objectId,
              ...(draft.applicabilityNote === undefined ? {} : { note: draft.applicabilityNote }),
            },
            condition: draft.condition,
            exceptions: draft.exceptions,
            ...(draft.conclusion === undefined ? {} : { conclusion: draft.conclusion }),
            ruleDependencies: draft.ruleDependencies,
            sourceRefs,
          },
          auth.principal.subjectId,
          ctx,
        )
        reply.status(200).send({ data: { candidate }, meta: { traceId } })
        return reply
      }
      const bindingContext = dependencies.bindingContext?.(ctx)
      const candidate = await dependencies.service.editActionCandidate(
        workspaceId,
        {
          candidateId,
          expectedRevision: readIfMatch(request),
          reason,
          idempotencyKey: key,
          declaration: draft.declaration,
          sourceRefs,
          ...(bindingContext === undefined ? {} : { bindingContext }),
        },
        auth.principal.subjectId,
        ctx,
      )
      reply.status(200).send({ data: { candidate }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; candidateId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/rule-action-candidates/:candidateId/enable',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { workspaceId, candidateId } = request.params
      const body = request.body
      if (body !== undefined && !isRecord(body)) {
        throw new InvalidRequestFieldError('the request body must be a JSON object when present')
      }
      const ctx = contextFor(auth, traceId, workspaceId)
      const existing = await dependencies.service.getCandidate(candidateId, ctx)
      if (existing === undefined || existing.workspaceId !== workspaceId) {
        throw new InvalidRequestFieldError('the candidate is not visible in this workspace')
      }
      const input = { candidateId, expectedRevision: readIfMatch(request) }
      const result =
        existing.kind === 'rule'
          ? await dependencies.service.enableRuleCandidate(workspaceId, input, ctx)
          : await dependencies.service.enableActionCandidate(workspaceId, input, ctx)
      reply.status(200).send({ data: result, meta: { traceId } })
      return reply
    },
  )
}

async function withGenerationSignal<T>(request: FastifyRequest, reply: FastifyReply, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => { controller.abort() }
  const close = () => { if (!reply.raw.writableEnded) controller.abort() }
  request.raw.once('aborted', abort); reply.raw.once('close', close)
  if (request.raw.aborted) controller.abort()
  try { return await operation(controller.signal) }
  finally { request.raw.off('aborted', abort); reply.raw.off('close', close) }
}
