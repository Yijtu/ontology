import type {
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type { SourceLocator } from './structured-parse'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isRevisionString, isSha256Digest, isUuid } from './asset-workspace'

/**
 * Public instance review: key-field confirmation and entity identity adjudication
 * (SPEC v0.3a asset-data-ui §3.3/§3.4, §8.1, P.FR-5/13/20, A.US-004, P.US-008/010/014).
 *
 * This contract extends the identity-decision surface (`identity-decisions.ts`) and the
 * append-only field-confirmation events (`projects.ts`) with the *record* view a reviewer
 * works on: the raw and normalized value, the exact source, the pending/confirmed/conflict
 * status and the identity confidence for one stable instance record.
 *
 * Three invariants shape it:
 *
 *  - A record has a **stable `recordId`** and an append-only revision chain. Merging two
 *    records onto one entity never deletes either business record; a `match` only changes
 *    the identity state of the surviving view.
 *  - A field is only `confirmed` when it carries an exact source and a schema-valid
 *    normalized value. An unknown field or an unconfirmed relation endpoint stays `pending`
 *    and can never be published (`P.US-008.AC-03`).
 *  - `approve` and `publish` are distinct: approval marks a revision publishable, publishing
 *    pins the published revision that a later read-back returns.
 *
 * The port lives in `contracts` so an adapter implements it while depending on `contracts`
 * alone; the application service receives it by construction injection.
 */

export type InstanceFieldStatus = 'pending' | 'confirmed' | 'conflict'
export type InstancePublicationState = 'draft' | 'approved' | 'published'
export type InstanceIdentityState = 'unresolved' | 'matched' | 'created' | 'rejected' | 'split'
export type InstanceIdentityConfidence = 'exact' | 'candidate' | 'none'
export type InstanceFieldDecision = 'confirm' | 'conflict' | 'reject'
export type InstanceIdentityAdjudicationKind = 'match' | 'cannot_link' | 'split' | 'create'

/** The immutable source a field value was read from. */
export interface InstanceFieldSource {
  readonly documentRef: ResourceRef
  readonly parseId: Uuid
  readonly chunkId: Uuid
  readonly locator: SourceLocator
  readonly textDigest: Sha256Digest
  readonly quoteDigest: Sha256Digest
}

/** The verbatim value exactly as it appeared in the source (never a normalized form). */
export type InstanceRawValue = string | boolean | null

/** The schema-checked value; a quantity keeps its lexical decimal and unit. */
export type InstanceNormalizedValue =
  | { readonly kind: 'scalar'; readonly value: string | number | boolean | null }
  | { readonly kind: 'quantity'; readonly value: string; readonly unitCode: string }
  | { readonly kind: 'reference'; readonly entityId: string }

/** One field of one record revision. `confirmationRevision` is assigned by the store. */
export interface InstanceFieldValue {
  readonly fieldId: string
  readonly rawValue: InstanceRawValue
  readonly normalizedValue?: InstanceNormalizedValue
  readonly source: InstanceFieldSource
  readonly status: InstanceFieldStatus
  readonly reason?: string
  readonly actor?: string
  readonly confirmedAt?: Rfc3339UtcTimestamp
  readonly confirmationRevision: RevisionString
}

/** One recalled entity that the record might denote. A score is supporting evidence only. */
export interface InstanceIdentityCandidate {
  readonly entityId: string
  readonly objectId: string
  readonly displayName: string
  readonly strategy: 'native_id' | 'alias' | 'context' | 'similarity'
  readonly score?: number
}

/** One append-only identity adjudication recorded against a record. */
export interface InstanceIdentityAdjudication {
  readonly decisionId: Uuid
  readonly kind: InstanceIdentityAdjudicationKind
  readonly targetEntityId?: string
  readonly reason: string
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly revision: RevisionString
}

export interface InstanceIdentityView {
  readonly state: InstanceIdentityState
  readonly confidence: InstanceIdentityConfidence
  readonly candidates: readonly InstanceIdentityCandidate[]
  readonly matchedEntityId?: string
  readonly sameNameDifferentMeaning: boolean
  readonly cannotLinkEntityIds: readonly string[]
  readonly adjudications: readonly InstanceIdentityAdjudication[]
  /** The identity adjudication head revision; `0` when none was recorded. */
  readonly decisionRevision: RevisionString
}

/** A relation endpoint is `pending` until the target record is explicitly confirmed. */
export interface InstanceRelationEndpoint {
  readonly relationId: string
  readonly relationTypeRef: string
  readonly fromRecordId: Uuid
  readonly toRecordId?: Uuid
  readonly endpointState: 'resolved' | 'pending'
}

/** The reviewer-facing record projection. Carries the raw/normalized/source/status triple. */
export interface InstanceRecordView {
  readonly projectId: Uuid
  readonly recordId: Uuid
  readonly recordRevision: RevisionString
  readonly objectTypeRef: string
  readonly identity: InstanceIdentityView
  readonly fields: readonly InstanceFieldValue[]
  readonly relations: readonly InstanceRelationEndpoint[]
  readonly publicationState: InstancePublicationState
  readonly publishedRevision?: RevisionString
  readonly sourceRef: ResourceRef
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface InstanceReviewListFilter {
  readonly status?: InstanceFieldStatus
  readonly publicationState?: InstancePublicationState
  readonly limit?: number
}

/** Append one immutable record revision. `expectedRevision` is the CAS guard (`0` creates). */
export interface AppendInstanceRecordInput {
  readonly recordId: Uuid
  readonly expectedRevision: RevisionString
  readonly objectTypeRef: string
  readonly identityCandidates: readonly InstanceIdentityCandidate[]
  readonly identityState: InstanceIdentityState
  readonly identityConfidence: InstanceIdentityConfidence
  readonly matchedEntityId?: string
  readonly sameNameDifferentMeaning: boolean
  readonly cannotLinkEntityIds: readonly string[]
  readonly adjudications: readonly InstanceIdentityAdjudication[]
  readonly fields: readonly InstanceFieldValue[]
  readonly relations: readonly InstanceRelationEndpoint[]
  readonly publicationState: InstancePublicationState
  readonly publishedRevision?: RevisionString
  readonly sourceRef: ResourceRef
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly idempotencyKey: string
}

export interface AppendInstanceConfirmationInput {
  readonly recordId: Uuid
  readonly fieldId: string
  readonly recordRevision: RevisionString
  readonly status: InstanceFieldStatus
  readonly reason?: string
  readonly sourceRef: ResourceRef
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly idempotencyKey: string
}

export interface InstanceConfirmationEvent {
  readonly projectId: Uuid
  readonly recordId: Uuid
  readonly fieldId: string
  readonly recordRevision: RevisionString
  readonly confirmationRevision: RevisionString
  readonly status: InstanceFieldStatus
  readonly reason?: string
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

/**
 * Control persistence for instance records and their append-only confirmation events
 * (SPEC v0.3a §3.3/§4.1). Every method runs in the trusted tenant/space scope with RLS
 * underneath. `appendRecordRevision` is compare-and-swap on the record head: a concurrent
 * write with a stale `expectedRevision` fails with `VERSION_CONFLICT`.
 */
export interface InstanceReviewStore {
  listRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    filter: InstanceReviewListFilter,
    ctx: ToolContext,
  ): Promise<InstanceRecordView[]>
  getRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<InstanceRecordView | undefined>
  appendRecordRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendInstanceRecordInput,
    ctx: ToolContext,
  ): Promise<InstanceRecordView>
  appendConfirmation(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendInstanceConfirmationInput,
    ctx: ToolContext,
  ): Promise<InstanceConfirmationEvent>
  listConfirmations(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<InstanceConfirmationEvent[]>
}

export type InstanceReviewErrorCode =
  | 'SCOPE_MISMATCH'
  | 'PROJECT_NOT_FOUND'
  | 'RECORD_NOT_FOUND'
  | 'FIELD_NOT_FOUND'
  | 'REVISION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'IDENTITY_CONFLICT'
  | 'PUBLICATION_BLOCKED'
  | 'INVALID_ARGUMENT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STORE_FAILED'

const INSTANCE_HTTP_STATUS: Readonly<Record<InstanceReviewErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  PROJECT_NOT_FOUND: 404,
  RECORD_NOT_FOUND: 404,
  FIELD_NOT_FOUND: 404,
  REVISION_REQUIRED: 428,
  VERSION_CONFLICT: 409,
  IDENTITY_CONFLICT: 409,
  PUBLICATION_BLOCKED: 409,
  INVALID_ARGUMENT: 400,
  IDEMPOTENCY_CONFLICT: 409,
  STORE_FAILED: 500,
}

export class InstanceReviewError extends Error {
  readonly code: InstanceReviewErrorCode
  readonly httpStatus: number

  constructor(code: InstanceReviewErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'InstanceReviewError'
    this.code = code
    this.httpStatus = INSTANCE_HTTP_STATUS[code]
  }
}

export function isInstanceReviewError(value: unknown): value is InstanceReviewError {
  return value instanceof InstanceReviewError
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

const FIELD_STATUSES: readonly InstanceFieldStatus[] = ['pending', 'confirmed', 'conflict']
const PUBLICATION_STATES: readonly InstancePublicationState[] = ['draft', 'approved', 'published']
const IDENTITY_STATES: readonly InstanceIdentityState[] = [
  'unresolved',
  'matched',
  'created',
  'rejected',
  'split',
]

function isSourceLocator(value: unknown): value is SourceLocator {
  if (!isRecord(value) || typeof value['kind'] !== 'string') return false
  return true
}

export function isInstanceFieldSource(value: unknown): value is InstanceFieldSource {
  if (!isRecord(value)) return false
  return (
    isResourceRef(value['documentRef']) &&
    isUuid(value['parseId']) &&
    isUuid(value['chunkId']) &&
    isSourceLocator(value['locator']) &&
    isSha256Digest(value['textDigest']) &&
    isSha256Digest(value['quoteDigest'])
  )
}

export function isInstanceNormalizedValue(value: unknown): value is InstanceNormalizedValue {
  if (!isRecord(value)) return false
  switch (value['kind']) {
    case 'scalar':
      return (
        value['value'] === null ||
        typeof value['value'] === 'string' ||
        typeof value['value'] === 'number' ||
        typeof value['value'] === 'boolean'
      )
    case 'quantity':
      return typeof value['value'] === 'string' && isNonEmptyString(value['unitCode'])
    case 'reference':
      return isNonEmptyString(value['entityId'])
    default:
      return false
  }
}

export function isInstanceFieldValue(value: unknown): value is InstanceFieldValue {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['fieldId'])) return false
  const raw = value['rawValue']
  if (raw !== null && typeof raw !== 'string' && typeof raw !== 'boolean') return false
  if (value['normalizedValue'] !== undefined && !isInstanceNormalizedValue(value['normalizedValue'])) return false
  if (!isInstanceFieldSource(value['source'])) return false
  if (typeof value['status'] !== 'string' || !(FIELD_STATUSES as readonly string[]).includes(value['status'])) {
    return false
  }
  return isRevisionString(value['confirmationRevision'])
}

export function isInstanceRelationEndpoint(value: unknown): value is InstanceRelationEndpoint {
  if (!isRecord(value)) return false
  if (!isNonEmptyString(value['relationId'])) return false
  if (!isNonEmptyString(value['relationTypeRef'])) return false
  if (!isUuid(value['fromRecordId'])) return false
  if (value['toRecordId'] !== undefined && !isUuid(value['toRecordId'])) return false
  if (value['endpointState'] !== 'resolved' && value['endpointState'] !== 'pending') return false
  return true
}

export function isInstanceRecordView(value: unknown): value is InstanceRecordView {
  if (!isRecord(value)) return false
  if (!isUuid(value['projectId']) || !isUuid(value['recordId'])) return false
  if (!isRevisionString(value['recordRevision'])) return false
  if (!isNonEmptyString(value['objectTypeRef'])) return false
  if (!isInstanceIdentityView(value['identity'])) return false
  if (!Array.isArray(value['fields']) || !value['fields'].every(isInstanceFieldValue)) return false
  if (!Array.isArray(value['relations']) || !value['relations'].every(isInstanceRelationEndpoint)) return false
  if (
    typeof value['publicationState'] !== 'string' ||
    !(PUBLICATION_STATES as readonly string[]).includes(value['publicationState'])
  ) {
    return false
  }
  if (value['publishedRevision'] !== undefined && !isRevisionString(value['publishedRevision'])) return false
  if (!isResourceRef(value['sourceRef'])) return false
  return isNonEmptyString(value['actor']) && typeof value['recordedAt'] === 'string'
}

function isInstanceIdentityView(value: unknown): value is InstanceIdentityView {
  if (!isRecord(value)) return false
  if (typeof value['state'] !== 'string' || !(IDENTITY_STATES as readonly string[]).includes(value['state'])) {
    return false
  }
  if (value['confidence'] !== 'exact' && value['confidence'] !== 'candidate' && value['confidence'] !== 'none') {
    return false
  }
  if (!Array.isArray(value['candidates'])) return false
  if (typeof value['sameNameDifferentMeaning'] !== 'boolean') return false
  if (!Array.isArray(value['cannotLinkEntityIds'])) return false
  if (!Array.isArray(value['adjudications'])) return false
  return isRevisionString(value['decisionRevision'])
}
