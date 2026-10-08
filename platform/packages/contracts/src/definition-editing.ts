import type {
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type {
  AssetCandidateState,
  DefinitionCandidateKind,
  DefinitionCandidatePayload,
} from './asset-candidates'
import type { IndustryAttributeValueType } from './extraction'
import type { SemanticDefinitionVersion } from './semantic-definitions'
import type { ToolContext } from './trusted'

/**
 * Definition (TBox) editing, disambiguation and compatibility validation (SPEC v0.3a
 * asset-data-ui §3.1/§3.3/§4, issue V03-009 / #183; A.US-003, P.US-005, P.FR-6/FR-7).
 *
 * Generation (V03-008) proposes definition candidates; this module is the *review editing*
 * surface on top of them. It adds no second approve decision table: an edit always appends a
 * NEW immutable candidate revision with a new `candidateId`, so a review recorded against the
 * previous candidate id can never carry over (SPEC §3.1). Merge, split, keep-separate and
 * reject are recorded as append-only *adjudications*, which is a review artefact, not a
 * publication decision.
 *
 * The rules this surface enforces:
 *  - a duplicate identifier, a dangling relation endpoint, a wrong unit or an illegal
 *    type/cardinality value BLOCKS publication instead of being silently repaired;
 *  - the same display name with two different meanings stays independent (keep-separate);
 *  - a breaking change against the published version requires an explicit revision strategy;
 *  - an unsupported rule is saved as non-executable (`executable: false`) and never dropped.
 */

/** The edit operations a reviewer may apply to definition candidates. */
export type DefinitionCandidateOperationKind =
  | 'edit'
  | 'reject'
  | 'merge'
  | 'keep_separate'
  | 'split'

/** What one changed definition affects, so a merge/split shows the full blast radius. */
export type DefinitionAffectedRole = 'object' | 'attribute' | 'relation' | 'identity' | 'rule'

export interface DefinitionAffectedDefinition {
  readonly logicalId: string
  readonly role: DefinitionAffectedRole
  /** The candidate revisions that reference, or are referenced by, the changed definition. */
  readonly relatedCandidateIds: readonly Uuid[]
  readonly impact: string
}

/**
 * A hard or soft finding from validating a definition candidate set. A `blocker` prevents
 * publication; a `warning` is surfaced for a human but does not block.
 */
export type DefinitionValidationCode =
  | 'DUPLICATE_IDENTIFIER'
  | 'DANGLING_ENDPOINT'
  | 'UNIT_MISMATCH'
  | 'INVALID_TYPE_CARDINALITY'
  | 'INVALID_IDENTITY'
  | 'DEFINITION_CONFLICT'
  | 'REVISION_STRATEGY_REQUIRED'
  | 'REVISION_STRATEGY_INVALID'
  | 'CANDIDATE_NOT_APPROVED'

export interface DefinitionValidationFinding {
  readonly code: DefinitionValidationCode
  readonly severity: 'blocker' | 'warning'
  readonly candidateId: Uuid
  readonly logicalId: string
  /** Dotted path to the offending field, e.g. `payload.unitCode`. */
  readonly path: string
  readonly message: string
}

/** A definition that changed relative to the published version. */
export type DefinitionChangeCode =
  | 'OBJECT_ADDED'
  | 'OBJECT_REMOVED'
  | 'OBJECT_CHANGED'
  | 'ATTRIBUTE_ADDED'
  | 'ATTRIBUTE_REMOVED'
  | 'ATTRIBUTE_CHANGED'
  | 'RELATION_ADDED'
  | 'RELATION_REMOVED'
  | 'RELATION_CHANGED'
  | 'VALUE_TYPE_CHANGED'
  | 'UNIT_CHANGED'
  | 'CARDINALITY_CHANGED'
  | 'IDENTITY_CHANGED'
  | 'REFERENCE_CHANGED'

export interface DefinitionChange {
  readonly code: DefinitionChangeCode
  readonly logicalId: string
  readonly kind: DefinitionCandidateKind
  /** True when the change can reinterpret or invalidate already published instances. */
  readonly breaking: boolean
  readonly message: string
  readonly before?: string
  readonly after?: string
}

/**
 * The revision strategy a breaking change must declare before it can be published. The
 * strategy is explicit and recorded; the platform never rewrites an old run, instance or
 * historical fact silently (SPEC §3.1, §3.3).
 */
export type DefinitionRevisionStrategyKind = 'new_version' | 'keep_independent' | 'retire_previous'

export interface DefinitionRevisionStrategy {
  readonly kind: DefinitionRevisionStrategyKind
  readonly reason: string
  /** The published version this revision explicitly supersedes, when one is named. */
  readonly supersedesRef?: VersionRef
}

export interface DefinitionCompatibilityReport {
  readonly workspaceId: Uuid
  readonly revision: RevisionString
  readonly publishedRef?: VersionRef
  readonly additions: readonly DefinitionChange[]
  readonly changes: readonly DefinitionChange[]
  /** Every breaking change; a non-empty list requires an explicit strategy to publish. */
  readonly breakingChanges: readonly DefinitionChange[]
  readonly requiresRevisionStrategy: boolean
  readonly strategy?: DefinitionRevisionStrategy
}

export interface DefinitionValidationReport {
  readonly workspaceId: Uuid
  readonly revision: RevisionString
  /** The candidate revisions that make up the current definition projection. */
  readonly checkedCandidateIds: readonly Uuid[]
  /** Current ledger approvals, pinned for validation and the atomic publication recheck. */
  readonly approvalPins?: readonly DefinitionApprovalPin[]
  readonly blockers: readonly DefinitionValidationFinding[]
  readonly warnings: readonly DefinitionValidationFinding[]
  /** Unsupported rules preserved as non-executable instead of being deleted. */
  readonly nonExecutableRules: readonly UnsupportedDefinitionRule[]
  readonly compatibility: DefinitionCompatibilityReport
  readonly publishable: boolean
}

export interface DefinitionApprovalPin {
  readonly candidateId: Uuid
  readonly contentDigest: Sha256Digest
  readonly reviewRevision: RevisionString
}

/**
 * A rule the platform cannot execute. It is kept verbatim with a classified reason and
 * `executable: false`; an unsupported rule is never silently deleted or weakened into a
 * looser executable rule (SPEC §5.2, issue V03-009).
 */
export interface UnsupportedDefinitionRule {
  readonly ruleId: string
  readonly workspaceId: Uuid
  readonly sourceCandidateId?: Uuid
  readonly reason: string
  /** The offending form, preserved verbatim. */
  readonly rawForm: unknown
  readonly executable: false
  readonly idempotencyKey: string
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** One append-only record of a merge/split/keep-separate/edit/reject adjudication. */
export interface DefinitionEditAdjudication {
  readonly adjudicationId: Uuid
  readonly workspaceId: Uuid
  readonly kind: DefinitionCandidateOperationKind
  /** The original candidates the operation acted on. */
  readonly candidateIds: readonly Uuid[]
  /** The new candidate revisions the operation produced (empty for reject/keep_separate). */
  readonly producedCandidateIds: readonly Uuid[]
  readonly reason: string
  readonly affected: readonly DefinitionAffectedDefinition[]
  /** The validation findings recorded at decision time. */
  readonly findings: readonly DefinitionValidationFinding[]
  readonly compatibility: DefinitionCompatibilityReport
  readonly strategy?: DefinitionRevisionStrategy
  readonly requestDigest: Sha256Digest
  readonly idempotencyKey: string
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** The result of an edit/merge/split/reject: the new revisions plus the recorded adjudication. */
export interface DefinitionEditingResult {
  readonly adjudication: DefinitionEditAdjudication
  /** The new immutable candidate revisions, oldest first. */
  readonly candidates: readonly {
    readonly candidateId: Uuid
    readonly workspaceId: Uuid
    readonly logicalId: string
    readonly kind: DefinitionCandidateKind
    readonly state: AssetCandidateState
    readonly payload: DefinitionCandidatePayload
    readonly replacesCandidateId?: Uuid
    readonly contentDigest: Sha256Digest
  }[]
  /** False when the call replayed an earlier idempotent adjudication. */
  readonly created: boolean
}

export interface EditDefinitionCandidateInput {
  readonly candidateId: Uuid
  /** The workspace head the caller read; `undefined` means the If-Match header was absent. */
  readonly expectedRevision: RevisionString | undefined
  readonly payload: DefinitionCandidatePayload
  readonly reason: string
  readonly idempotencyKey: string
}

export interface MergeDefinitionCandidatesInput {
  readonly candidateIds: readonly Uuid[]
  readonly mergedPayload: DefinitionCandidatePayload
  readonly reason: string
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

export interface SplitDefinitionCandidateInput {
  readonly candidateId: Uuid
  readonly parts: readonly DefinitionCandidatePayload[]
  readonly reason: string
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

export interface KeepDefinitionsSeparateInput {
  readonly candidateIds: readonly Uuid[]
  readonly reason: string
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

export interface RejectDefinitionCandidateInput {
  readonly candidateId: Uuid
  readonly reason: string
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

export interface SaveUnsupportedRuleInput {
  readonly workspaceId: Uuid
  readonly ruleId: string
  readonly sourceCandidateId?: Uuid
  readonly reason: string
  readonly rawForm: unknown
  readonly idempotencyKey: string
}

/** Everything `validateForPublication` needs; a breaking change must carry a strategy. */
export interface DefinitionPublicationValidationInput {
  readonly workspaceId: Uuid
  readonly revision: RevisionString
  readonly strategy?: DefinitionRevisionStrategy
}

/**
 * Read-only access to a published definition version, narrowed to the lookup the
 * compatibility diff needs (SPEC §3.1: 与已发布版本的差异). `SemanticDefinitionStore`
 * satisfies this shape, so the editing service depends on the smallest possible port.
 */
export interface PublishedDefinitionVersionReader {
  findVersion(
    namespace: string,
    definitionId: string,
    version: string,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<SemanticDefinitionVersion | undefined>
}

/**
 * Control persistence for definition editing adjudications and non-executable rules
 * (SPEC v0.3a §4.1). It is separate from the candidate store because an adjudication is the
 * human decision record; the candidate revisions themselves are appended through
 * `AssetCandidateStore`. Every method runs in the trusted tenant/space scope and RLS is a
 * second layer behind the explicit scope predicate.
 */
export interface DefinitionEditingStore {
  appendAdjudication(
    scopeRef: ScopeRef,
    adjudication: DefinitionEditAdjudication,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication>
  listAdjudications(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication[]>
  /** Resolve an adjudication by its Idempotency-Key so a replay never appends a second one. */
  findAdjudicationByIdempotencyKey(
    scopeRef: ScopeRef,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<DefinitionEditAdjudication | undefined>
  recordUnsupportedRule(
    scopeRef: ScopeRef,
    rule: UnsupportedDefinitionRule,
    ctx: ToolContext,
  ): Promise<UnsupportedDefinitionRule>
  listUnsupportedRules(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<UnsupportedDefinitionRule[]>
}

export type DefinitionEditingStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'ADJUDICATION_EXISTS'
  | 'IDEMPOTENCY_CONFLICT'
  | 'UNSUPPORTED_RULE_EXISTS'
  | 'EDITING_STORE_FAILED'

export class DefinitionEditingStoreError extends Error {
  readonly code: DefinitionEditingStoreErrorCode

  constructor(code: DefinitionEditingStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DefinitionEditingStoreError'
    this.code = code
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const VALUE_TYPES: readonly IndustryAttributeValueType[] = [
  'string',
  'number',
  'boolean',
  'timestamp',
  'enum',
  'quantity',
  'reference',
]

export function isDefinitionCandidatePayload(value: unknown): value is DefinitionCandidatePayload {
  if (!isRecord(value)) return false
  const kind = value['kind']
  if (kind !== 'object' && kind !== 'attribute' && kind !== 'relation') return false
  if (!nonEmpty(value['logicalId']) || !nonEmpty(value['displayName'])) return false
  if (typeof value['businessMeaning'] !== 'string' || typeof value['suggestedReason'] !== 'string') return false
  if (!Array.isArray(value['conflicts'])) return false
  if (kind === 'object') {
    return Array.isArray(value['identityAttributeIds']) && value['identityAttributeIds'].every(isString)
  }
  if (kind === 'attribute') {
    return (
      nonEmpty(value['objectLogicalId']) &&
      typeof value['valueType'] === 'string' &&
      (VALUE_TYPES as readonly string[]).includes(value['valueType']) &&
      isCardinality(value['minCardinality']) &&
      isMaxCardinality(value['maxCardinality'])
    )
  }
  return (
    nonEmpty(value['fromObjectLogicalId']) &&
    nonEmpty(value['toObjectLogicalId']) &&
    isCardinality(value['minCardinality']) &&
    isMaxCardinality(value['maxCardinality'])
  )
}

/**
 * Validate one definition candidate payload before it is stored as a revision. The payload is
 * caller-supplied, so a malformed shape is rejected before any write instead of failing later.
 */
export function assertDefinitionCandidatePayloadShape(
  value: unknown,
  expectedKind?: DefinitionCandidateKind,
): asserts value is DefinitionCandidatePayload {
  if (!isDefinitionCandidatePayload(value)) {
    throw new DefinitionEditingStoreError('EDITING_STORE_FAILED', 'definition candidate payload is malformed')
  }
  if (expectedKind !== undefined && value.kind !== expectedKind) {
    throw new DefinitionEditingStoreError(
      'EDITING_STORE_FAILED',
      `definition candidate payload kind ${value.kind} does not match the candidate kind ${expectedKind}`,
    )
  }
}

export function isDefinitionRevisionStrategy(value: unknown): value is DefinitionRevisionStrategy {
  if (!isRecord(value)) return false
  const kind = value['kind']
  if (kind !== 'new_version' && kind !== 'keep_independent' && kind !== 'retire_previous') return false
  if (!nonEmpty(value['reason']) || value['reason'].trim().length === 0) return false
  return value['supersedesRef'] === undefined || isVersionRef(value['supersedesRef'])
}

export function isDefinitionCandidateOperationKind(value: unknown): value is DefinitionCandidateOperationKind {
  return (
    value === 'edit' ||
    value === 'reject' ||
    value === 'merge' ||
    value === 'keep_separate' ||
    value === 'split'
  )
}

export function isDefinitionEditingStoreError(value: unknown): value is DefinitionEditingStoreError {
  return value instanceof DefinitionEditingStoreError
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isCardinality(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isMaxCardinality(value: unknown): boolean {
  return value === 'unbounded' || isCardinality(value)
}

function isDigestString(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function isVersionRef(value: unknown): value is VersionRef {
  if (!isRecord(value)) return false
  return nonEmpty(value['id']) && nonEmpty(value['version']) && isDigestString(value['digest'])
}
