import type {
  CapabilityRequirement,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'
import type {
  ActionCapabilityBinding,
  ActionCapabilityBindingInput,
  ActionCapabilityFinding,
  ActionCapabilityStatus,
  ActionDeclaration,
  RuleSupportFinding,
  RuleSupportState,
} from './rule-action-candidates'
import type { RuleConditionState, RuleExceptionNode, RuleExpressionNode } from './rule-extraction'
import type { FiniteRuleConditionEvaluation } from './rule-boolean'
import type { DefinitionRevisionStrategy, DefinitionValidationReport } from './definition-editing'

/**
 * Isolated synthetic instances and the industry validation service (SPEC v0.3a
 * asset-data-ui §3.4, §4.1; execution-evidence EX-05/EX-16; issue V03-014 / #186;
 * A.US-005, A.US-008/010/015, P.US-009/011, P.FR-5/7/16).
 *
 * Two artefacts are kept apart from real project facts:
 *
 *  - a **SyntheticExampleSetVersion** is an isolation-marked sample set. It is fixed
 *    `sourceKind: 'synthetic'` and `dataMode: 'synthetic'`, carries the draft/definition it
 *    validates plus independent expectations, and lives in its own control table. It is a
 *    different asset from `PackAsset.exampleSet` (`FewShotExampleSet`, question/query shapes);
 *    the two never share a field.
 *  - an **IndustryValidationReport** records the outcome of running those samples against the
 *    draft: definition blockers, rule support scope, action contracts and capability
 *    requirements. Semantic publication (`semanticPublished`) and deployment executability
 *    (`deploymentExecutable`) are reported separately, because a candidate may be
 *    semantically publishable while no registered, authorized implementation can execute it.
 *
 * Isolation is enforced in the backend, not the UI: a synthetic set can only enter the
 * validation sandbox; promoting it to `observed`/`live` or another scope is rejected with a
 * typed error before any write. Expectations must be expert-confirmed or come from an
 * independently authored oracle — generation output or the implementation's own result is
 * never accepted as gold.
 */

export const SYNTHETIC_DATA_MODE = 'synthetic' as const
export const SYNTHETIC_SOURCE_KIND = 'synthetic' as const
export const SYNTHETIC_ISOLATION_LABEL = 'synthetic test' as const

export type SyntheticDataMode = typeof SYNTHETIC_DATA_MODE
export type SyntheticSourceKind = typeof SYNTHETIC_SOURCE_KIND
export type SyntheticIsolationLabel = typeof SYNTHETIC_ISOLATION_LABEL

/** The counterexample families a synthetic set must be able to cover (SPEC §3.4). */
export type SyntheticCaseKind =
  | 'missing_parameter'
  | 'same_name_different_meaning'
  | 'contradiction'
  | 'wrong_unit'
  | 'missing_capability'

export const SYNTHETIC_CASE_KINDS: readonly SyntheticCaseKind[] = [
  'missing_parameter',
  'same_name_different_meaning',
  'contradiction',
  'wrong_unit',
  'missing_capability',
]

/** One field of a synthetic case. The value is data only; it never becomes a fact. */
export interface SyntheticCaseField {
  readonly fieldId: string
  readonly value: string | number | boolean | null
  /** Required for a quantity so a wrong/missing unit can be expressed explicitly. */
  readonly unitCode?: string
}

export interface SyntheticCaseRelation {
  readonly relationId: string
  readonly targetObjectRef: string
  readonly endpointResolved: boolean
}

/** One synthetic case: a deliberately isolated counterexample, never a business instance. */
export interface SyntheticCase {
  readonly caseId: string
  readonly caseKind: SyntheticCaseKind
  readonly objectTypeRef: string
  readonly displayName?: string
  /**
   * The other object a same-name/different-meaning case points at. Kept explicit so the
   * collision is data, not a UI label.
   */
  readonly alternateObjectTypeRef?: string
  readonly fields: readonly SyntheticCaseField[]
  readonly relations?: readonly SyntheticCaseRelation[]
  readonly note?: string
}

/**
 * Where an expectation came from. Only `expert_confirmed` and `authored_oracle` are
 * independent; `generated` and `implementation_output` are rejected as gold.
 */
export type SyntheticExpectationOrigin =
  | 'expert_confirmed'
  | 'authored_oracle'
  | 'generated'
  | 'implementation_output'

export const INDEPENDENT_EXPECTATION_ORIGINS: readonly SyntheticExpectationOrigin[] = [
  'expert_confirmed',
  'authored_oracle',
]

export interface SyntheticExpectationBase {
  readonly expectationId: string
  readonly caseId: string
  readonly origin: SyntheticExpectationOrigin
  readonly reason: string
  readonly confirmedBy: string
  readonly confirmedAt: Rfc3339UtcTimestamp
}

/** The expected four-state condition result of one rule against one case. */
export interface SyntheticRuleExpectation extends SyntheticExpectationBase {
  readonly kind: 'rule'
  readonly ruleId: string
  readonly expected: RuleConditionState
}

/** The expected executability of one registered action against one case. */
export interface SyntheticActionExpectation extends SyntheticExpectationBase {
  readonly kind: 'action'
  readonly actionId: string
  readonly expected: 'executable' | 'blocked'
}

export type SyntheticExpectation = SyntheticRuleExpectation | SyntheticActionExpectation

/** Paging of the case refs inside one immutable synthetic set version (SPEC §3.4). */
export interface SyntheticExampleSetPage {
  readonly pageIndex: number
  readonly pageSize: number
  /** Pointers to the paged case bodies; never the real project instance refs. */
  readonly caseRefs: readonly ResourceRef[]
}

/**
 * One immutable, isolation-marked synthetic example set version. `sourceKind`, `dataMode` and
 * `isolationLabel` are literal constants: a set that lost any of them fails the runtime guard
 * instead of being silently treated as real data.
 */
export interface SyntheticExampleSetVersion {
  readonly exampleSetId: Uuid
  readonly workspaceId: Uuid
  readonly sourceKind: SyntheticSourceKind
  readonly dataMode: SyntheticDataMode
  readonly isolationLabel: SyntheticIsolationLabel
  readonly targetDraftRef?: VersionRef
  readonly targetDefinitionRef?: VersionRef
  readonly generationPolicyRef?: VersionRef
  readonly generationCallRef?: ResourceRef
  readonly caseKinds: readonly SyntheticCaseKind[]
  readonly cases: readonly SyntheticCase[]
  readonly expectations: readonly SyntheticExpectation[]
  readonly page: SyntheticExampleSetPage
  /** The previous version this one edits; a synthetic edit appends, never overwrites. */
  readonly replacesExampleSetId?: Uuid
  readonly contentDigest: Sha256Digest
  readonly idempotencyKey: string
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

/* ----------------------------------------------------------------------------------------- */
/* Validation report                                                                          */
/* ----------------------------------------------------------------------------------------- */

export type ValidationIssueSurface = 'semantic' | 'deployment'

export type IndustryValidationIssueCode =
  | 'DEFINITION_BLOCKER'
  | 'RULE_NOT_EXECUTABLE'
  | 'ACTION_NOT_EXECUTABLE'
  | 'MISSING_CAPABILITY'
  | 'TRIAL_FAILED'
  | 'EXPECTATION_MISMATCH'
  | 'EXPECTATION_NOT_INDEPENDENT'
  | 'EXPECTATION_UNKNOWN_CASE'
  | 'EXPECTATION_UNKNOWN_RULE'
  | 'EXPECTATION_UNKNOWN_ACTION'
  | 'CASE_KIND_UNCOVERED'
  | 'NO_INDEPENDENT_EXPECTATIONS'
  | 'SYNTHETIC_MARKER_MISSING'

export interface IndustryValidationIssue {
  readonly code: IndustryValidationIssueCode
  readonly surface: ValidationIssueSurface
  readonly message: string
  readonly caseId?: string
  readonly ruleId?: string
  readonly actionId?: string
  readonly logicalId?: string
}

/** Per-rule validation. `semanticPublished` and `deploymentExecutable` stay separate. */
export interface RuleValidationResult {
  readonly candidateId: Uuid
  readonly ruleId: string
  readonly supportState: RuleSupportState
  readonly semanticPublished: boolean
  readonly deploymentExecutable: boolean
  readonly findings: readonly RuleSupportFinding[]
  readonly coveredCaseIds: readonly string[]
}

export interface ActionTrialInput {
  readonly declaration: ActionDeclaration
  readonly binding: ActionCapabilityBinding
  readonly caseId: string
  readonly caseKind: SyntheticCaseKind
  readonly fields: readonly SyntheticCaseField[]
}

export interface ActionTrialReceipt {
  readonly actionId: string
  readonly caseId: string
  readonly status: 'passed' | 'failed' | 'blocked' | 'not_run'
  readonly message: string
  readonly outputDigest?: Sha256Digest
  readonly recordedAt: Rfc3339UtcTimestamp
}

/**
 * The controlled extension trial for a registered action (SPEC §3.4). The deployment supplies
 * the sandbox executor; the core never evaluates arbitrary code and an unbound action is
 * reported as a concrete blocker instead of a fake pass.
 */
export interface ActionTrialPort {
  trial(input: ActionTrialInput, ctx: ToolContext): Promise<ActionTrialReceipt>
}

/** Per-action validation; capability requirements are surfaced separately from the binding. */
export interface ActionValidationResult {
  readonly candidateId: Uuid
  readonly actionId: string
  readonly bindingStatus: ActionCapabilityStatus
  readonly semanticPublished: boolean
  readonly deploymentExecutable: boolean
  readonly findings: readonly ActionCapabilityFinding[]
  readonly requiredCapabilities: readonly CapabilityRequirement[]
  readonly missingCapabilities: readonly string[]
  readonly trials: readonly ActionTrialReceipt[]
  readonly coveredCaseIds: readonly string[]
}

export interface SyntheticExpectationResult {
  readonly expectationId: string
  readonly caseId: string
  readonly kind: SyntheticExpectation['kind']
  readonly targetId: string
  readonly expected: string
  readonly actual: string
  readonly matched: boolean
  readonly origin: SyntheticExpectationOrigin
  readonly independent: boolean
}

export interface SyntheticCaseCoverage {
  readonly caseId: string
  readonly caseKind: SyntheticCaseKind
  readonly ruleIds: readonly string[]
  readonly actionIds: readonly string[]
}

/** One validation surface. The two surfaces are always reported independently. */
export interface ValidationSurfaceGate {
  readonly passed: boolean
  readonly blockers: readonly IndustryValidationIssue[]
}

export type IndustryValidationGate = 'open' | 'blocked_semantic' | 'blocked_execution' | 'blocked_both'

export interface IndustryValidationReport {
  readonly validationId: Uuid
  readonly workspaceId: Uuid
  readonly revision: RevisionString
  readonly draftRef?: VersionRef
  readonly definitionRef?: VersionRef
  readonly exampleSetId: Uuid
  readonly exampleSetRef: ResourceRef
  readonly validationPolicyRef?: VersionRef
  readonly dataMode: SyntheticDataMode
  readonly isolationLabel: SyntheticIsolationLabel
  /** Synthetic validation never creates a business approval. */
  readonly businessApproval: 'none'
  /** Synthetic samples never become real published facts. */
  readonly realFactsWritten: false
  readonly definition?: DefinitionValidationReport
  readonly rules: readonly RuleValidationResult[]
  readonly actions: readonly ActionValidationResult[]
  readonly semanticPublished: ValidationSurfaceGate
  readonly deploymentExecutable: ValidationSurfaceGate
  readonly publishable: boolean
  readonly gate: IndustryValidationGate
  readonly issues: readonly IndustryValidationIssue[]
  readonly expectationResults: readonly SyntheticExpectationResult[]
  readonly coverage: readonly SyntheticCaseCoverage[]
  readonly contentDigest: Sha256Digest
  readonly idempotencyKey: string
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

/* ----------------------------------------------------------------------------------------- */
/* Ports                                                                                      */
/* ----------------------------------------------------------------------------------------- */

export interface SyntheticExampleSetStore {
  insert(
    scopeRef: ScopeRef,
    set: SyntheticExampleSetVersion,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion>
  get(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    exampleSetId: Uuid,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion | undefined>
  findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion | undefined>
  list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<SyntheticExampleSetVersion[]>
}

export interface IndustryValidationReportStore {
  insert(
    scopeRef: ScopeRef,
    report: IndustryValidationReport,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport>
  get(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    validationId: Uuid,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport | undefined>
  findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport | undefined>
  list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport[]>
}

/**
 * The definition validation surface the industry validation service consumes. The V03-009
 * `DefinitionCandidateEditingService` satisfies this shape, so the service depends only on the
 * smallest possible port and never imports the editing implementation.
 */
export interface DefinitionPublicationValidationPort {
  validateForPublication(
    input: {
      readonly workspaceId: Uuid
      readonly revision: RevisionString
      readonly strategy?: DefinitionRevisionStrategy
    },
    ctx: ToolContext,
  ): Promise<DefinitionValidationReport>
}

/**
 * The finite-grammar case evaluator. The semantic engine implements it with the same frozen
 * subset the publish stage and the evaluator enforce, so a synthetic case is judged by the
 * same compiler rather than a second, looser implementation. Applicability, the business
 * proposition, source conflicts and truncation are reported as separate axes.
 */
export type SyntheticRuleEvaluation = FiniteRuleConditionEvaluation

export interface SyntheticCaseEvaluator {
  evaluateRule(input: {
    readonly condition: RuleExpressionNode
    readonly exceptions: readonly RuleExceptionNode[]
    readonly fields: readonly SyntheticCaseField[]
    /** Set when the caller knows the sample fields were cut off; then a verdict stays unknown. */
    readonly truncated?: boolean
  }): SyntheticRuleEvaluation
}

/* ----------------------------------------------------------------------------------------- */
/* Requests                                                                                   */
/* ----------------------------------------------------------------------------------------- */

export interface GenerateSyntheticExampleSetInput {
  readonly caseKinds: readonly SyntheticCaseKind[]
  readonly cases: readonly SyntheticCase[]
  readonly expectations: readonly SyntheticExpectation[]
  readonly targetDraftRef?: VersionRef
  readonly targetDefinitionRef?: VersionRef
  readonly generationPolicyRef?: VersionRef
  readonly generationCallRef?: ResourceRef
  readonly pageIndex?: number
  readonly pageSize?: number
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

export interface ReviseSyntheticExampleSetInput {
  readonly exampleSetId: Uuid
  readonly cases: readonly SyntheticCase[]
  readonly expectations: readonly SyntheticExpectation[]
  readonly reason: string
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

export interface RunIndustryValidationInput {
  readonly exampleSetId: Uuid
  readonly draftRef?: VersionRef
  readonly definitionRef?: VersionRef
  readonly validationPolicyRef?: VersionRef
  /** Trusted deployment binding context; never read from a request body or a model response. */
  readonly actionBindingContext?: ActionCapabilityBindingInput
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

/* ----------------------------------------------------------------------------------------- */
/* Errors                                                                                     */
/* ----------------------------------------------------------------------------------------- */

export type SyntheticValidationErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FORBIDDEN'
  | 'WORKSPACE_NOT_FOUND'
  | 'EXAMPLE_SET_NOT_FOUND'
  | 'VALIDATION_NOT_FOUND'
  | 'REVISION_REQUIRED'
  | 'VERSION_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SYNTHETIC_MARKER_MISSING'
  | 'SYNTHETIC_NOT_PUBLISHABLE'
  | 'TARGET_SCOPE_MISMATCH'
  | 'EXPECTATION_NOT_INDEPENDENT'
  | 'STORE_FAILED'

const SYNTHETIC_HTTP_STATUS: Readonly<Record<SyntheticValidationErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  FORBIDDEN: 403,
  WORKSPACE_NOT_FOUND: 404,
  EXAMPLE_SET_NOT_FOUND: 404,
  VALIDATION_NOT_FOUND: 404,
  REVISION_REQUIRED: 428,
  VERSION_CONFLICT: 409,
  INVALID_ARGUMENT: 400,
  IDEMPOTENCY_CONFLICT: 409,
  SYNTHETIC_MARKER_MISSING: 422,
  SYNTHETIC_NOT_PUBLISHABLE: 409,
  TARGET_SCOPE_MISMATCH: 403,
  EXPECTATION_NOT_INDEPENDENT: 422,
  STORE_FAILED: 500,
}

export class SyntheticValidationError extends Error {
  readonly code: SyntheticValidationErrorCode
  readonly httpStatus: number

  constructor(code: SyntheticValidationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SyntheticValidationError'
    this.code = code
    this.httpStatus = SYNTHETIC_HTTP_STATUS[code]
  }
}

export function isSyntheticValidationError(value: unknown): value is SyntheticValidationError {
  return value instanceof SyntheticValidationError
}

/* ----------------------------------------------------------------------------------------- */
/* Runtime guards and isolation                                                               */
/* ----------------------------------------------------------------------------------------- */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

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

function isVersionRef(value: unknown): value is VersionRef {
  return isRecord(value) && isNonEmptyString(value['id']) && isNonEmptyString(value['version']) && isDigest(value['digest'])
}

function isResourceRef(value: unknown): value is ResourceRef {
  return (
    isRecord(value) &&
    isUuid(value['id']) &&
    isNonEmptyString(value['version']) &&
    isDigest(value['digest']) &&
    isNonEmptyString(value['kind'])
  )
}

export function isSyntheticCaseKind(value: unknown): value is SyntheticCaseKind {
  return typeof value === 'string' && (SYNTHETIC_CASE_KINDS as readonly string[]).includes(value)
}

export function isIndependentExpectationOrigin(value: unknown): value is SyntheticExpectationOrigin {
  return typeof value === 'string' && (INDEPENDENT_EXPECTATION_ORIGINS as readonly string[]).includes(value)
}

function isCaseField(value: unknown): value is SyntheticCaseField {
  if (!isRecord(value) || !isNonEmptyString(value['fieldId'])) return false
  const field = value['value']
  if (field !== null && typeof field !== 'string' && typeof field !== 'number' && typeof field !== 'boolean') return false
  return value['unitCode'] === undefined || typeof value['unitCode'] === 'string'
}

function isCase(value: unknown): value is SyntheticCase {
  if (!isRecord(value) || !isNonEmptyString(value['caseId']) || !isSyntheticCaseKind(value['caseKind'])) return false
  if (!isNonEmptyString(value['objectTypeRef'])) return false
  if (!Array.isArray(value['fields']) || !value['fields'].every(isCaseField)) return false
  return true
}

function isExpectation(value: unknown): value is SyntheticExpectation {
  if (!isRecord(value) || !isNonEmptyString(value['expectationId']) || !isNonEmptyString(value['caseId'])) return false
  if (typeof value['origin'] !== 'string' || !isNonEmptyString(value['reason'])) return false
  if (!isNonEmptyString(value['confirmedBy']) || !isNonEmptyString(value['confirmedAt'])) return false
  if (value['kind'] === 'rule') {
    return (
      isNonEmptyString(value['ruleId']) &&
      (value['expected'] === 'true' ||
        value['expected'] === 'false' ||
        value['expected'] === 'unknown' ||
        value['expected'] === 'conflict')
    )
  }
  if (value['kind'] === 'action') {
    return (
      isNonEmptyString(value['actionId']) &&
      (value['expected'] === 'executable' || value['expected'] === 'blocked')
    )
  }
  return false
}

/**
 * Validate the synthetic isolation markers of a value. Anything not explicitly marked
 * `sourceKind: 'synthetic'` / `dataMode: 'synthetic'` / `isolationLabel: 'synthetic test'`
 * is rejected, so a set can never masquerade as real project data.
 */
export function assertSyntheticIsolation(value: unknown): void {
  if (!isRecord(value) || !isRecord(value['page'])) {
    throw new SyntheticValidationError('SYNTHETIC_MARKER_MISSING', 'a synthetic example set must be an object')
  }
  const set = value as Partial<SyntheticExampleSetVersion>
  if (set.sourceKind !== SYNTHETIC_SOURCE_KIND) {
    throw new SyntheticValidationError('SYNTHETIC_MARKER_MISSING', 'sourceKind must be synthetic')
  }
  if (set.dataMode !== SYNTHETIC_DATA_MODE) {
    throw new SyntheticValidationError('SYNTHETIC_MARKER_MISSING', 'dataMode must be synthetic')
  }
  if (set.isolationLabel !== SYNTHETIC_ISOLATION_LABEL) {
    throw new SyntheticValidationError('SYNTHETIC_MARKER_MISSING', 'isolationLabel must be "synthetic test"')
  }
}

export function isSyntheticExampleSetVersion(value: unknown): value is SyntheticExampleSetVersion {
  if (!isRecord(value)) return false
  if (!isUuid(value['exampleSetId']) || !isUuid(value['workspaceId'])) return false
  if (value['sourceKind'] !== SYNTHETIC_SOURCE_KIND || value['dataMode'] !== SYNTHETIC_DATA_MODE) return false
  if (value['isolationLabel'] !== SYNTHETIC_ISOLATION_LABEL) return false
  if (value['targetDraftRef'] !== undefined && !isVersionRef(value['targetDraftRef'])) return false
  if (value['targetDefinitionRef'] !== undefined && !isVersionRef(value['targetDefinitionRef'])) return false
  if (!Array.isArray(value['caseKinds']) || !value['caseKinds'].every(isSyntheticCaseKind)) return false
  if (!Array.isArray(value['cases']) || !value['cases'].every(isCase)) return false
  if (!Array.isArray(value['expectations']) || !value['expectations'].every(isExpectation)) return false
  const page = value['page']
  if (!isRecord(page) || !Array.isArray(page['caseRefs']) || !page['caseRefs'].every(isResourceRef)) return false
  if (value['replacesExampleSetId'] !== undefined && !isUuid(value['replacesExampleSetId'])) return false
  if (!isDigest(value['contentDigest']) || !isNonEmptyString(value['idempotencyKey'])) return false
  return isNonEmptyString(value['actor']) && isNonEmptyString(value['recordedAt'])
}

export function assertSyntheticExampleSetVersion(value: unknown): asserts value is SyntheticExampleSetVersion {
  assertSyntheticIsolation(value)
  if (!isSyntheticExampleSetVersion(value)) {
    throw new SyntheticValidationError('SYNTHETIC_MARKER_MISSING', 'the synthetic example set is malformed')
  }
}

/**
 * Hard backend refusal to promote a synthetic artefact as `observed`/`live` data or into a
 * different scope. The check is explicit so the rejection is data-driven, not a UI convention.
 */
export function assertSyntheticNotPublishedAsObserved(input: {
  readonly sourceDataMode: SyntheticDataMode
  readonly targetDataMode: SyntheticDataMode | 'observed' | 'live'
  readonly sourceScopeRef: ScopeRef
  readonly targetScopeRef: ScopeRef
}): void {
  if (input.targetDataMode !== SYNTHETIC_DATA_MODE) {
    throw new SyntheticValidationError(
      'SYNTHETIC_NOT_PUBLISHABLE',
      'a synthetic example set can only be used for validation, never published as observed or live data',
    )
  }
  if (
    input.sourceScopeRef.tenantId !== input.targetScopeRef.tenantId ||
    input.sourceScopeRef.spaceId !== input.targetScopeRef.spaceId
  ) {
    throw new SyntheticValidationError(
      'TARGET_SCOPE_MISMATCH',
      'a synthetic example set can only be used inside the customer/project space it was created in',
    )
  }
}
