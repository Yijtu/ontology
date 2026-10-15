import type { DefinitionCandidateInputDraftRef } from './asset-candidates'
import type { DocumentChunkRecord } from './document-parse'
import type { CandidateSourceSpan } from './extraction'
import type { ResourceRef, RevisionString, ScopeRef, Semver, Uuid } from './generated/contracts'
import type { StructuredCell, StructuredColumn, StructuredParseOptions, SourceLocator } from './structured-parse'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isUuid } from './asset-workspace'

/** An immutable, approved workspace corpus. Retraction appends a new draft/set. */
export interface GroundingDocumentSet {
  readonly schemaVersion: '1.0.0'
  readonly scopeRef: ScopeRef
  readonly workspaceId: Uuid
  readonly sources: readonly GroundingSourceApproval[]
}

/**
 * How much trust a source carries for authoring. `customer_authoritative` and `public_standard`
 * may ground a publishable candidate; `agent_researched` is an agent proposal that defaults to
 * pending confirmation; `synthetic` is sandbox-only and may never ground a real publication.
 */
export type SourceTrustTier = 'customer_authoritative' | 'public_standard' | 'agent_researched' | 'synthetic'

/** The effective tier of an approved source; an omitted tier is a human-approved customer source. */
export function sourceTrustTierOf(source: Pick<GroundingSourceApproval, 'trustTier'>): SourceTrustTier {
  return source.trustTier ?? 'customer_authoritative'
}

/**
 * Whether a source tier may ground a publishable candidate. Only a human-owned customer source or a
 * reviewed public standard qualifies; an agent-researched proposal defaults to pending confirmation
 * and a synthetic source is sandbox-only. The publish gate reads this so provenance is enforced at
 * the artifact boundary, not merely labelled.
 */
export function sourceTrustTierGroundsPublication(tier: SourceTrustTier): boolean {
  return tier === 'customer_authoritative' || tier === 'public_standard'
}

export interface GroundingSourceApproval {
  readonly sourceRef: ResourceRef
  readonly state: 'approved' | 'retracted'
  readonly kind: 'document' | 'table'
  readonly parserVersion: Semver
  readonly parseId: Uuid
  /** Provenance tier of this source. Absent means a human-approved customer source. */
  readonly trustTier?: SourceTrustTier
  /** The exact selection approved at ingestion; parser caps cannot be overridden. */
  readonly tableOptions?: Pick<StructuredParseOptions,
    'headerRow' | 'dataStartRow' | 'delimiter' | 'quote' | 'sheetId' | 'sheetName'>
}

export type SourceGroundingReason =
  | 'NOT_APPROVED' | 'SOURCE_RETRACTED' | 'SCOPE_MISMATCH' | 'DOCUMENT_SET_CHANGED'
  | 'PARSE_NOT_COMPLETE' | 'SOURCE_MISMATCH' | 'DIGEST_MISMATCH' | 'MISSING_ORIGINAL'
  | 'UNSUPPORTED_MEDIA_TYPE' | 'READ_FAILED' | 'EMPTY_SOURCE' | 'SAMPLE_LIMIT'
  | 'FRAGMENT_LIMIT' | 'BYTE_LIMIT' | 'TOKEN_LIMIT' | 'PAGE_LIMIT' | 'READ_BYTE_LIMIT'
  | 'CANCELLED' | 'INVALID_REQUEST'

export class SourceGroundingError extends Error {
  constructor(readonly code: SourceGroundingReason, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SourceGroundingError'
  }
}

export interface GroundedText {
  readonly kind: 'text'
  readonly text: string
  readonly sourceSpan: CandidateSourceSpan
}
export interface GroundedTable {
  readonly kind: 'table'
  readonly format: 'csv' | 'xlsx'
  readonly sheetId?: string
  readonly sheetName?: string
  readonly columns: readonly StructuredColumn[]
  readonly headerRow: number
  /** Only real data rows have candidate spans. A header-only table supplies context,
   * but downstream suggestions must remain ungrounded/pending confirmation. */
  readonly rows: readonly {
    readonly cells: readonly StructuredCell[]
    readonly sourceSpan: CandidateSourceSpan
  }[]
}
export type GroundedSourceContent = GroundedText | GroundedTable
export interface GroundedSource {
  readonly sourceRef: ResourceRef
  readonly trust: 'untrusted_source_data'
  /** The effective provenance tier of this source (see {@link sourceTrustTierOf}). */
  readonly trustTier: SourceTrustTier
  readonly status: 'complete' | 'partial' | 'failed'
  readonly reasons: readonly SourceGroundingReason[]
  readonly contents: readonly GroundedSourceContent[]
}

export interface SourceGroundingUsage {
  readonly fragments: number
  readonly bytes: number
  /** Conservative UTF-8 byte upper bound; a token cannot require less than one byte. */
  readonly inputTokens: number
  readonly pages: number
  readonly readBytes: number
}
export type SourceGroundingLimits = SourceGroundingUsage

/** One controller-owned ledger, shared across pages, calls and retries. */
export interface SourceGroundingBudgetPort {
  readonly signal: AbortSignal
  readonly remainingFragments: number
  check(): void
  chargeRead(bytes: number): void
  chargePage(): void
  accept(content: GroundedSourceContent): SourceGroundingReason | undefined
  usage(): SourceGroundingUsage
}

export interface GroundedSourceFragment {
  readonly sourceIndex: number
  readonly fragmentIndex: number
  readonly sourceRef: ResourceRef
  /** The effective provenance tier of the fragment's source; a blocking tier may not ground a publishable candidate. */
  readonly trustTier: SourceTrustTier
  readonly sourceSpan: CandidateSourceSpan
  readonly content: Omit<GroundedText, 'sourceSpan'> | {
    readonly kind: 'table'; readonly format: 'csv' | 'xlsx'; readonly columns: readonly StructuredColumn[];
    readonly headerRow: number; readonly cells: readonly StructuredCell[]
  }
}

export interface SourceGroundingReadResult {
  readonly documentSetRef: ResourceRef
  readonly sources: readonly GroundedSource[]
  readonly coverage: 'complete' | 'partial' | 'failed'
  readonly usage: SourceGroundingUsage
}

export interface WorkspaceSourceGroundingView extends SourceGroundingReadResult {
  readonly workspaceRevision: RevisionString
  readonly inputDraftRef: DefinitionCandidateInputDraftRef
  readonly fragments: readonly GroundedSourceFragment[]
}

export interface SourceGroundingPort {
  read(request: SourceGroundingReadRequest, ctx: ToolContext, budget: SourceGroundingBudgetPort): Promise<SourceGroundingReadResult>
}

/**
 * One exact row/cell requested from an approved table, by its durable record id, its source row key,
 * or its locator. A targeted read returns only the named rows and round-trip verifies each, so a
 * costing table row far beyond the sampling cap can still be cited without widening the sample.
 */
export interface SourceGroundingRowSelector {
  readonly sourceRef: ResourceRef
  readonly recordId?: Uuid
  readonly sourceRowKey?: string
  readonly locator?: SourceLocator
}

export interface SourceGroundingReadRequest {
  readonly workspaceId: Uuid
  readonly sourceRefs: readonly ResourceRef[]
  readonly inputDraftRef?: DefinitionCandidateInputDraftRef
  /** Exact rows to read instead of sampling; each is read and verified individually. */
  readonly rowSelectors?: readonly SourceGroundingRowSelector[]
}

export interface GroundingDocumentSetReaderPort {
  read(scope: ScopeRef, ref: ResourceRef, ctx: ToolContext,
    budget: SourceGroundingBudgetPort): Promise<GroundingDocumentSet>
}

export interface SourceGroundingPage {
  readonly contents: readonly GroundedSourceContent[]
  readonly nextCursor?: string
  readonly reasons: readonly SourceGroundingReason[]
}
export interface SourceGroundingReaderPort {
  readPage(scope: ScopeRef, source: GroundingSourceApproval,
    page: { readonly limit: number; readonly cursor?: string }, ctx: ToolContext,
    budget: SourceGroundingBudgetPort): Promise<SourceGroundingPage>
  /** Read only the exact requested rows/cells of one approved table, each round-trip verified. */
  readRows(scope: ScopeRef, source: GroundingSourceApproval,
    request: { readonly limit: number; readonly selectors: readonly Omit<SourceGroundingRowSelector, 'sourceRef'>[] }, ctx: ToolContext,
    budget: SourceGroundingBudgetPort): Promise<SourceGroundingPage>
}
export interface SourceGroundingChunkStore {
  listChunkPage(scope: ScopeRef, parseId: Uuid,
    page: { readonly limit: number; readonly cursor?: string }, ctx: ToolContext): Promise<{
      readonly chunks: readonly DocumentChunkRecord[]; readonly nextCursor?: string
    }>
}

/** Runtime validation at the immutable artifact boundary, including selection options. */
export function assertGroundingDocumentSet(value: unknown): asserts value is GroundingDocumentSet {
  if (!isRecord(value) || value.schemaVersion !== '1.0.0' || !isUuid(value.workspaceId)
    || !isRecord(value.scopeRef) || !isUuid(value.scopeRef.tenantId) || !isUuid(value.scopeRef.spaceId)
    || !Array.isArray(value.sources) || value.sources.length > 256) {
    throw new SourceGroundingError('INVALID_REQUEST', 'invalid approved document set')
  }
  const refs = new Set<string>()
  for (const source of value.sources) {
    if (!isRecord(source) || !isResourceRef(source.sourceRef) || source.sourceRef.kind !== 'document' || !isUuid(source.parseId)
      || typeof source.parserVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(source.parserVersion)
      || !['approved', 'retracted'].includes(String(source.state))
      || !['document', 'table'].includes(String(source.kind))
      || (source.trustTier !== undefined
        && !['customer_authoritative', 'public_standard', 'agent_researched', 'synthetic'].includes(String(source.trustTier)))) {
      throw new SourceGroundingError('INVALID_REQUEST', 'invalid approved source')
    }
    if (refs.has(source.sourceRef.id)) throw new SourceGroundingError('INVALID_REQUEST', 'duplicate source id')
    refs.add(source.sourceRef.id)
    const options = source.tableOptions
    if (options !== undefined) {
      if (!isRecord(options) || Object.keys(options).some((key) =>
        !['headerRow', 'dataStartRow', 'delimiter', 'quote', 'sheetId', 'sheetName'].includes(key))
        || ['headerRow', 'dataStartRow'].some((key) => options[key] !== undefined
          && (!Number.isSafeInteger(options[key]) || Number(options[key]) < 1))
        || (options.delimiter !== undefined && ![',', ';', '\t', '|'].includes(String(options.delimiter)))
        || (options.quote !== undefined && !['"', "'"].includes(String(options.quote)))
        || ['sheetId', 'sheetName'].some((key) => options[key] !== undefined
          && (typeof options[key] !== 'string' || options[key].length === 0))) {
        throw new SourceGroundingError('INVALID_REQUEST', 'invalid approved table selection')
      }
    }
  }
}
