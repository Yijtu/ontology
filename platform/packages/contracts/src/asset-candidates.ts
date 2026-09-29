import type {
  ModelRef,
  ResourceRef,
  Rfc3339UtcTimestamp,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { CandidateSourceSpan, IndustryAttributeValueType } from './extraction'
import type { ToolContext } from './trusted'

/**
 * Ontology **definition** (TBox) candidate contracts (SPEC v0.3a asset-data-ui §3.1/§3.3,
 * §4.3, issue V03-008 / #181; P.US-004.AC-01..03, P.FR-4/FR-5).
 *
 * This module defines the wire shapes for the service that turns sources (a workspace's
 * mounted document set and its mounted industry pack) into new **object type / attribute /
 * relation** candidates, plus the two ports it depends on. There is no implementation and no
 * adapter, driver or industry-package type here.
 *
 * Two families are deliberately kept apart and can never be mixed:
 *
 *  - an **instance candidate** (`extraction_candidates`, `CandidateRecord`) is one project row
 *    of a *known* object type and never changes the schema;
 *  - a **definition candidate** (this module) proposes a *new* object type / attribute /
 *    relation and is `domain: 'definition'`. It carries its business meaning, type/unit or
 *    endpoint, the suggested reason and explicit conflict hints, so a human can review it
 *    before it ever reaches the workspace draft or a published package.
 *
 * A definition candidate is never published truth. Lacking a source locator it is stored as
 * `pending_confirmation` rather than being dropped; the model output is untrusted data and is
 * validated field by field before it becomes a candidate.
 */

/** Every record in this store belongs to the definition (TBox) domain. */
export type AssetCandidateDomain = 'definition'

/**
 * The definition kinds a workspace may generate. `A §3.1` also names `identity_scope`, `rule`
 * and `action`; V03-008 produces the object/attribute/relation triple and leaves the rule and
 * action families to the execution/validation cards, so this store constrains the kind to the
 * three it can actually validate against mounted assets.
 */
export type DefinitionCandidateKind = 'object' | 'attribute' | 'relation'

/**
 * Candidate lifecycle. `pending_confirmation` is a produced suggestion without a source
 * locator that must be confirmed by a human before it is usable (P.US-004.AC-03). `failed`
 * is a hard, queryable problem (unresolved endpoint or a logical-id collision); `rejected`
 * is a later human review outcome. A candidate is never silently promoted to published truth.
 */
export type AssetCandidateState =
  | 'produced'
  | 'pending_review'
  | 'pending_confirmation'
  | 'failed'
  | 'rejected'

/**
 * Why a definition candidate did not cleanly validate. Every code is an explicit, queryable
 * state instead of a dropped row or a coerced value.
 */
export type AssetCandidateIssueCode =
  | 'MISSING_PROVENANCE'
  | 'KIND_NOT_ALLOWED'
  | 'LOGICAL_ID_COLLISION'
  | 'ENDPOINT_UNRESOLVED'
  | 'TERMINOLOGY_MISMATCH'
  | 'UNIT_CONFLICT'
  | 'INVALID_MODEL_OUTPUT'

export interface AssetCandidateIssue {
  readonly code: AssetCandidateIssueCode
  readonly message: string
  /** Dotted path to the offending field, e.g. `payload.objectLogicalId`. */
  readonly path?: string
}

/**
 * An explicit, non-fatal hint that a candidate overlaps an existing term or another candidate.
 * Conflicts are surfaced for a human and never auto-resolved.
 */
export interface DefinitionCandidateConflict {
  readonly kind:
    | 'logical_id_collision'
    | 'endpoint_unresolved'
    | 'terminology_mismatch'
    | 'unit_conflict'
  readonly message: string
  readonly relatedLogicalIds: readonly string[]
}

interface DefinitionCandidateCommon {
  readonly logicalId: string
  readonly displayName: string
  /** Business meaning in plain language; a reviewer reads this before the formal name. */
  readonly businessMeaning: string
  /** Why the model suggested this definition, grounded in the source. */
  readonly suggestedReason: string
  /** Explicit overlap hints (existing term / another candidate), never auto-resolved. */
  readonly conflicts: readonly DefinitionCandidateConflict[]
}

export interface DefinitionObjectCandidate extends DefinitionCandidateCommon {
  readonly kind: 'object'
  /** Attribute logical ids that identify one instance of this object type. */
  readonly identityAttributeIds: readonly string[]
}

export interface DefinitionAttributeCandidate extends DefinitionCandidateCommon {
  readonly kind: 'attribute'
  /** The object type the attribute belongs to (a mounted term or a candidate in the same batch). */
  readonly objectLogicalId: string
  readonly valueType: IndustryAttributeValueType
  readonly unitCode?: string
  readonly dimension?: string
  readonly enumValues?: readonly string[]
  /** For a `reference` attribute: the object type the value points at. */
  readonly referencesObjectLogicalId?: string
  readonly minCardinality: number
  readonly maxCardinality: number | 'unbounded'
}

export interface DefinitionRelationCandidate extends DefinitionCandidateCommon {
  readonly kind: 'relation'
  readonly fromObjectLogicalId: string
  readonly toObjectLogicalId: string
  readonly minCardinality: number
  readonly maxCardinality: number | 'unbounded'
}

export type DefinitionCandidatePayload =
  | DefinitionObjectCandidate
  | DefinitionAttributeCandidate
  | DefinitionRelationCandidate

/**
 * The immutable input version a generation was produced under (SPEC §3.1): the workspace draft
 * revision it was generated against and the published pack it extended, when one was mounted.
 */
export interface DefinitionCandidateInputDraftRef {
  readonly workspaceId: Uuid
  readonly revision: RevisionString
  readonly digest: Sha256Digest
}

/**
 * One immutable **definition** candidate version. It carries the exact source references and
 * spans it was derived from, the draft revision it was produced against and the model/schema
 * call identity, so a reviewer can locate the evidence and a later stage can pin the version.
 * The payload is never mutated in place; a content-changing edit appends a new candidate id.
 */
export interface AssetCandidateVersion {
  readonly candidateId: Uuid
  /** The generation batch that produced this candidate; candidates are never batch-less. */
  readonly batchId: Uuid
  readonly workspaceId: Uuid
  readonly logicalId: string
  readonly domain: 'definition'
  readonly kind: DefinitionCandidateKind
  readonly payload: DefinitionCandidatePayload
  readonly inputDraftRef: DefinitionCandidateInputDraftRef
  /** The immutable artifacts the suggestion is grounded in; empty means no provenance. */
  readonly sourceRefs: readonly ResourceRef[]
  /** Located spans within those artifacts, when the generator could resolve them. */
  readonly sourceSpans: readonly CandidateSourceSpan[]
  readonly state: AssetCandidateState
  readonly issues: readonly AssetCandidateIssue[]
  /**
   * True when the suggestion has no source locator and must be confirmed by a human before it
   * is treated as grounded (P.US-004.AC-03). Always true iff `sourceRefs` is empty.
   */
  readonly pendingConfirmation: boolean
  readonly replacesCandidateId?: Uuid
  readonly generationCallRef?: ResourceRef
  readonly contentDigest: Sha256Digest
  readonly idempotencyKey: Sha256Digest
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** Aggregate counts of one generation batch, so a UI never re-derives them from a page. */
export interface AssetCandidateBatchCounts {
  readonly total: number
  readonly produced: number
  readonly pendingConfirmation: number
  readonly pendingReview: number
  readonly failed: number
}

/** Classified, secret-scrubbed generation failure. `retryable` decides whether a retry helps. */
export interface AssetCandidateBatchError {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

/**
 * One generation batch: the model/schema/source versions and (on failure) the classified error,
 * saved independently of the candidates so a failed generation is auditable and retryable.
 * `idempotencyKey` is unique per scope: replaying the same key with the same `requestDigest`
 * returns the stored batch; a different payload is an `IDEMPOTENCY_CONFLICT`.
 */
export interface AssetCandidateBatch {
  readonly batchId: Uuid
  readonly workspaceId: Uuid
  readonly domain: 'definition'
  readonly inputDraftRef: DefinitionCandidateInputDraftRef
  readonly modelRef: ModelRef
  readonly responseSchemaRef: VersionRef
  readonly schemaDigest?: Sha256Digest
  readonly documentSetRef: ResourceRef
  readonly generationPolicyRef: VersionRef
  readonly state: 'completed' | 'pending_confirmation' | 'failed'
  readonly counts: AssetCandidateBatchCounts
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly error?: AssetCandidateBatchError
  readonly createdBy: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface AssetCandidateQuery {
  readonly kind?: DefinitionCandidateKind
  readonly state?: AssetCandidateState
  /** Bounded page size; a caller never reads an unbounded candidate table. */
  readonly limit?: number
}

export interface AssetCandidateInsertResult {
  readonly batch: AssetCandidateBatch
  readonly candidates: readonly AssetCandidateVersion[]
  /** False when the call replayed an earlier idempotent generation. */
  readonly created: boolean
}

/** An explicit, idempotent state transition. The candidate payload is never mutated. */
export interface AssetCandidateStateTransition {
  readonly state: AssetCandidateState
  readonly issues: readonly AssetCandidateIssue[]
  readonly transitionedAt: Rfc3339UtcTimestamp
}

/**
 * Control persistence for definition candidates (SPEC §4.1). Every method runs in the trusted
 * tenant/space scope and RLS is a second layer behind the explicit scope predicate.
 * `insertBatch` writes the immutable batch and its candidates in one transaction and is
 * idempotent on `idempotencyKey`, so a retry or a crash-reclaim never duplicates a candidate.
 */
export interface AssetCandidateStore {
  insertBatch(
    scopeRef: ScopeRef,
    batch: AssetCandidateBatch,
    candidates: readonly AssetCandidateVersion[],
    ctx: ToolContext,
  ): Promise<AssetCandidateInsertResult>
  getBatch(
    scopeRef: ScopeRef,
    batchId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch | undefined>
  /** Resolve a batch by its Idempotency-Key so a replay never re-invokes the model. */
  findBatchByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch | undefined>
  listBatches(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<AssetCandidateBatch[]>
  getCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion | undefined>
  listCandidates(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    query: AssetCandidateQuery,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion[]>
  /** Every candidate of one batch, bounded; used to replay an idempotent generation exactly. */
  listCandidatesByBatch(
    scopeRef: ScopeRef,
    batchId: Uuid,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion[]>
  transitionCandidate(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: AssetCandidateStateTransition,
    ctx: ToolContext,
  ): Promise<AssetCandidateVersion>
}

export type AssetCandidateStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'BATCH_NOT_FOUND'
  | 'CANDIDATE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_BATCH'
  | 'INVALID_CANDIDATE'
  | 'STORE_FAILED'

export class AssetCandidateStoreError extends Error {
  readonly code: AssetCandidateStoreErrorCode

  constructor(code: AssetCandidateStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AssetCandidateStoreError'
    this.code = code
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REVISION_PATTERN = /^(0|[1-9][0-9]*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function isRevision(value: unknown): value is RevisionString {
  return typeof value === 'string' && REVISION_PATTERN.test(value)
}

const CANDIDATE_STATES: readonly AssetCandidateState[] = [
  'produced',
  'pending_review',
  'pending_confirmation',
  'failed',
  'rejected',
]

const CANDIDATE_KINDS: readonly DefinitionCandidateKind[] = ['object', 'attribute', 'relation']

export function isAssetCandidateState(value: unknown): value is AssetCandidateState {
  return typeof value === 'string' && (CANDIDATE_STATES as readonly string[]).includes(value)
}

export function isDefinitionCandidateKind(value: unknown): value is DefinitionCandidateKind {
  return typeof value === 'string' && (CANDIDATE_KINDS as readonly string[]).includes(value)
}

function invalidCandidate(message: string): AssetCandidateStoreError {
  return new AssetCandidateStoreError('INVALID_CANDIDATE', message)
}

function invalidBatch(message: string): AssetCandidateStoreError {
  return new AssetCandidateStoreError('INVALID_BATCH', message)
}

function assertVersionRef(value: unknown, field: string, error: (message: string) => AssetCandidateStoreError): void {
  if (!isRecord(value) || !isNonEmptyString(value['id']) || !isNonEmptyString(value['version']) || !isDigest(value['digest'])) {
    throw error(`${field} must be a version reference`)
  }
}

function assertCandidatePayload(payload: unknown, kind: DefinitionCandidateKind): void {
  if (!isRecord(payload)) throw invalidCandidate('candidate payload must be an object')
  if (payload['kind'] !== kind) throw invalidCandidate('candidate payload kind does not match the candidate kind')
  if (!isNonEmptyString(payload['logicalId'])) throw invalidCandidate('candidate payload requires a non-empty logicalId')
  if (!isNonEmptyString(payload['displayName'])) throw invalidCandidate('candidate payload requires a non-empty displayName')
  if (!isNonEmptyString(payload['businessMeaning'])) {
    throw invalidCandidate('candidate payload requires a non-empty businessMeaning')
  }
  if (!isNonEmptyString(payload['suggestedReason'])) {
    throw invalidCandidate('candidate payload requires a non-empty suggestedReason')
  }
  if (!Array.isArray(payload['conflicts'])) throw invalidCandidate('candidate payload requires a conflicts array')
  if (kind === 'attribute') {
    if (!isNonEmptyString(payload['objectLogicalId'])) {
      throw invalidCandidate('an attribute payload requires an objectLogicalId')
    }
    if (!isNonEmptyString(payload['valueType'])) {
      throw invalidCandidate('an attribute payload requires a valueType')
    }
  }
  if (kind === 'relation') {
    if (!isNonEmptyString(payload['fromObjectLogicalId']) || !isNonEmptyString(payload['toObjectLogicalId'])) {
      throw invalidCandidate('a relation payload requires both endpoint object logical ids')
    }
  }
}

/**
 * Validate one candidate before it is persisted. The store writes caller-supplied documents, so
 * a malformed candidate is rejected before any SQL runs rather than failing later on read.
 */
export function assertAssetCandidateVersionShape(
  value: unknown,
): asserts value is AssetCandidateVersion {
  if (!isRecord(value)) throw invalidCandidate('definition candidate must be an object')
  if (!isUuid(value['candidateId'])) throw invalidCandidate('candidateId must be a uuid')
  if (!isUuid(value['batchId'])) throw invalidCandidate('batchId must be a uuid')
  if (!isUuid(value['workspaceId'])) throw invalidCandidate('workspaceId must be a uuid')
  if (!isNonEmptyString(value['logicalId'])) throw invalidCandidate('logicalId must be a non-empty string')
  if (value['domain'] !== 'definition') throw invalidCandidate('domain must be definition')
  if (!isDefinitionCandidateKind(value['kind'])) throw invalidCandidate('kind is not a definition kind')
  assertCandidatePayload(value['payload'], value['kind'])
  if (!isRecord(value['inputDraftRef'])) throw invalidCandidate('inputDraftRef must be an object')
  const draftRef = value['inputDraftRef']
  if (!isUuid(draftRef['workspaceId']) || !isRevision(draftRef['revision']) || !isDigest(draftRef['digest'])) {
    throw invalidCandidate('inputDraftRef must carry workspaceId/revision/digest')
  }
  if (!Array.isArray(value['sourceRefs']) || !Array.isArray(value['sourceSpans'])) {
    throw invalidCandidate('sourceRefs and sourceSpans must be arrays')
  }
  if (!isAssetCandidateState(value['state'])) throw invalidCandidate('state is not a known candidate state')
  if (!Array.isArray(value['issues'])) throw invalidCandidate('issues must be an array')
  if (typeof value['pendingConfirmation'] !== 'boolean') {
    throw invalidCandidate('pendingConfirmation must be a boolean')
  }
  if (!isDigest(value['contentDigest'])) throw invalidCandidate('contentDigest must be a sha256 digest')
  if (!isDigest(value['idempotencyKey'])) throw invalidCandidate('idempotencyKey must be a sha256 digest')
  if (value['replacesCandidateId'] !== undefined && !isUuid(value['replacesCandidateId'])) {
    throw invalidCandidate('replacesCandidateId must be a uuid when present')
  }
}

/** Validate one generation batch before it is persisted. */
export function assertAssetCandidateBatchShape(value: unknown): asserts value is AssetCandidateBatch {
  if (!isRecord(value)) throw invalidBatch('definition candidate batch must be an object')
  if (!isUuid(value['batchId'])) throw invalidBatch('batchId must be a uuid')
  if (!isUuid(value['workspaceId'])) throw invalidBatch('workspaceId must be a uuid')
  if (value['domain'] !== 'definition') throw invalidBatch('domain must be definition')
  if (!isRecord(value['inputDraftRef'])) throw invalidBatch('inputDraftRef must be an object')
  const draftRef = value['inputDraftRef']
  if (!isUuid(draftRef['workspaceId']) || !isRevision(draftRef['revision']) || !isDigest(draftRef['digest'])) {
    throw invalidBatch('inputDraftRef must carry workspaceId/revision/digest')
  }
  assertVersionRef(value['responseSchemaRef'], 'responseSchemaRef', invalidBatch)
  assertVersionRef(value['generationPolicyRef'], 'generationPolicyRef', invalidBatch)
  if (!isRecord(value['modelRef']) || !isNonEmptyString((value['modelRef'] as Record<string, unknown>)['modelId'])) {
    throw invalidBatch('modelRef must carry a modelId')
  }
  if (!isRecord(value['documentSetRef'])) throw invalidBatch('documentSetRef must be an object')
  if (value['state'] !== 'completed' && value['state'] !== 'pending_confirmation' && value['state'] !== 'failed') {
    throw invalidBatch('state is not a known batch state')
  }
  if (!isRecord(value['counts'])) throw invalidBatch('counts must be an object')
  if (typeof value['idempotencyKey'] !== 'string' || value['idempotencyKey'].length < 8 || value['idempotencyKey'].length > 256) {
    throw invalidBatch('idempotencyKey must be between 8 and 256 characters')
  }
  if (!isDigest(value['requestDigest'])) throw invalidBatch('requestDigest must be a sha256 digest')
  if (!isNonEmptyString(value['createdBy'])) throw invalidBatch('createdBy must be a non-empty string')
  if (!isNonEmptyString(value['recordedAt'])) throw invalidBatch('recordedAt must be a timestamp')
}
