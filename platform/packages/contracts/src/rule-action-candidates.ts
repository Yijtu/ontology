import type {
  CapabilityRequirement,
  OperationRef,
  OperationRegistry,
  RegisteredOperation,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { CandidateSourceSpan } from './extraction'
import type {
  RuleApplicabilityState,
  RuleConclusionBinding,
  RuleConditionState,
  RuleExceptionNode,
  RuleExpressionNode,
} from './rule-extraction'
import { findEmbeddedSecretViolations, findIndustryPackViolations } from './industry-packs'
import { findRegisteredOperation } from './operations'
import type { SemanticDefinitionVersion } from './semantic-definitions'
import type { ToolContext } from './trusted'

/**
 * Rule and action candidates with finite-grammar support validation and capability binding
 * (SPEC v0.3a asset-data-ui §3.1/§3.3, execution-evidence §4.1/§4.2/EX-6, issue V03-010 / #184;
 * A.US-003/005/010, P.US-006/007, P.FR-8/9/10).
 *
 * Two families are kept apart:
 *
 *  - a **rule candidate** preserves the model's original condition, exceptions, conclusion,
 *    applicability, source and version verbatim. A static support validator consumes the
 *    frozen finite grammar (`RuleExpressionNode`) and records every form outside the
 *    executable subset as an explicit `not_yet_executable` finding *without deleting or
 *    weakening the condition*. `unknown`, `conflict` and an explicit `false` are distinct
 *    states and are never collapsed.
 *  - an **action declaration** records input/output Schema, preconditions, permissions,
 *    evidence/effect and required capabilities. It may bind only to a REGISTERED, authorized
 *    operation whose contract matches; model-suggested code, arbitrary scripts and arbitrary
 *    addresses are rejected outright. An unbound or contract-incompatible declaration is
 *    saved as `not_executable` with a reason. Semantic publication and deployment
 *    executability stay separate (SPEC §4.2).
 *
 * A candidate may always be saved, but only a fully passing semantic + execution-capability
 * validation may put it in the `enabled` lifecycle: `enableRuleCandidate`/`enableActionCandidate`
 * recompute support/binding and refuse a non-executable candidate instead of dropping a
 * condition to force a pass.
 */

/** The applicability a rule candidate was proposed under (SPEC §3.1 适用范围). */
export interface RuleApplicability {
  readonly objectId: string
  readonly note?: string
  readonly validFrom?: Rfc3339UtcTimestamp
  readonly validTo?: Rfc3339UtcTimestamp
}

/* ----------------------------------------------------------------------------------------- */
/* Rule finite-grammar support                                                                */
/* ----------------------------------------------------------------------------------------- */

export type RuleSupportState = 'executable' | 'not_yet_executable'

/**
 * Why a proposed rule is outside the frozen executable subset. Every code is an explicit,
 * queryable state instead of a silently loosened rule (SPEC §5.2).
 */
export type RuleSupportFindingCode =
  | 'DIFFERENT_CONDITION_OR'
  | 'RELATION_PREMISE_UNSUPPORTED'
  | 'RULE_DEPENDENCY_CYCLE'
  | 'RULE_DEPENDENCY_DEPTH'
  | 'UNSUPPORTED_NEGATION'
  | 'UNSUPPORTED_QUANTIFIER'
  | 'UNSUPPORTED_RANGE'
  | 'UNRESOLVED_REFERENCE'
  | 'MALFORMED_EXPRESSION'
  | 'UNSUPPORTED_EXCEPTION'

export interface RuleSupportFinding {
  readonly code: RuleSupportFindingCode
  readonly message: string
  /** Dotted path to the offending node, e.g. `condition.operands[1]`. */
  readonly path: string
  /** The offending form preserved verbatim; never edited into a looser one. */
  readonly rawForm?: unknown
}

/**
 * The static support report for one rule candidate. `condition` and `exceptions` are echoed
 * back untouched so a reader can prove no condition was dropped to make the rule pass.
 */
export interface RuleSupportReport {
  readonly ruleId: string
  readonly supportState: RuleSupportState
  /** True iff `supportState === 'executable'`. */
  readonly executable: boolean
  readonly findings: readonly RuleSupportFinding[]
  /** The preserved condition the report was computed from. */
  readonly condition: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
  /** The longest declared dependency chain that was followed (0 when there is none). */
  readonly dependencyDepth: number
}

/**
 * One declared relation premise available to a rule against the pinned definition
 * (SPEC v0.3a execution-evidence EX-4.1 `relation_exists`, EX-4.3; issue V03-027 / #195).
 *
 * A relation premise is only executable when it is the declared, ONE-HOP, positive published
 * relation from the current subject to the schema-declared target object. A deeper chain, a
 * cyclic relation, or a nested relation/rule reference is out of the executable subset and is
 * reported as `RELATION_PREMISE_UNSUPPORTED` rather than being loosened into a field lookup.
 */
export interface RuleRelationPremiseDeclaration {
  readonly relationId: string
  readonly fromObjectId: string
  /** The target object the relation binds; its confirmed endpoints are the target entity. */
  readonly toObjectId: string
  /** The pinned definition version the relation was declared in. */
  readonly definitionRef: VersionRef
  /** Relation navigation depth of the premise; the executable subset is exactly one hop. */
  readonly depth: number
  /**
   * The target-entity condition the premise binds (`compare`/`range`/finite `all`/`any`, no nested
   * relation or rule reference). Absent means the premise only witnesses the relation edge.
   */
  readonly targetCondition?: RuleExpressionNode
  /** True when the relation would expand a cycle; then it is never executable. */
  readonly cyclic?: boolean
}

export interface RuleSupportValidationInput {
  readonly ruleId: string
  readonly condition: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
  /** Declared one-way upstream rule ids this rule consumes. */
  readonly ruleDependencies?: readonly string[]
  /** The dependency graph used for cycle/depth checks (`ruleId` → upstream rule ids). */
  readonly dependencyLookup?: ReadonlyMap<string, readonly string[]>
  /**
   * The declared one-hop relation premises available in the pinned definition. A relation node
   * with no matching declaration (or a declaration that is deeper/cyclic/nested) stays
   * `RELATION_PREMISE_UNSUPPORTED`; only an exact one-hop declaration is executable.
   */
  readonly relationPremises?: readonly RuleRelationPremiseDeclaration[]
}

/**
 * Port for the deterministic finite-grammar checker. The implementation lives in the semantic
 * engine so the candidate, preflight, publish and evaluator stages consume the same subset.
 */
export interface RuleSupportValidator {
  validate(input: RuleSupportValidationInput): RuleSupportReport
}

export type RulePropositionState = 'true' | 'false' | 'unknown' | 'conflict'

/**
 * The four-state assessment of a rule candidate. It keeps `unknown`, `conflict` and an
 * explicit `false` apart: a rule that provides no positive support yields `unknown`, not
 * `false`, and a rule with both a satisfied condition and a true exception is `conflict`
 * (SPEC §5.2/EX-4.1).
 */
export interface RuleCandidateAssessment {
  readonly conditionState: RuleConditionState
  readonly exceptionStates: readonly {
    readonly exceptionId: string
    readonly state: RuleConditionState
  }[]
  readonly applicability: RuleApplicabilityState
  readonly propositionState: RulePropositionState
}

function worstConditionState(states: readonly RuleConditionState[]): RuleConditionState {
  if (states.includes('conflict')) return 'conflict'
  if (states.includes('unknown')) return 'unknown'
  if (states.includes('false')) return 'false'
  return 'true'
}

/**
 * Pure four-state assessment. `condition=true` with every exception `false` is the only path
 * to positive support (`propositionState: 'true'`); `false` returns no support and therefore
 * `unknown`, while `conflict` is preserved instead of being resolved to a value.
 */
export function assessRuleSupport(
  conditionState: RuleConditionState,
  exceptionStates: readonly { readonly exceptionId: string; readonly state: RuleConditionState }[],
): RuleCandidateAssessment {
  // No exception is the neutral element: it can never make a satisfied condition inapplicable.
  const worstException =
    exceptionStates.length === 0 ? 'false' : worstConditionState(exceptionStates.map((entry) => entry.state))
  const hasConflict = conditionState === 'conflict' || worstException === 'conflict'
  const hasUnknown = conditionState === 'unknown' || worstException === 'unknown'
  if (hasConflict) {
    return { conditionState, exceptionStates, applicability: 'conflict', propositionState: 'conflict' }
  }
  if (hasUnknown) {
    return { conditionState, exceptionStates, applicability: 'unknown', propositionState: 'unknown' }
  }
  if (conditionState === 'false') {
    return { conditionState, exceptionStates, applicability: 'not_applicable', propositionState: 'unknown' }
  }
  if (worstException === 'true') {
    return { conditionState, exceptionStates, applicability: 'not_applicable', propositionState: 'unknown' }
  }
  return { conditionState, exceptionStates, applicability: 'applicable', propositionState: 'true' }
}

/* ----------------------------------------------------------------------------------------- */
/* Rule candidate                                                                            */
/* ----------------------------------------------------------------------------------------- */

export type RuleActionCandidateLifecycle = 'draft' | 'enabled' | 'rejected'

export interface RuleCandidatePayload {
  readonly kind: 'rule'
  readonly ruleId: string
  readonly applicability: RuleApplicability
  /** The original condition, preserved verbatim. Never deleted to force a pass. */
  readonly condition: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
  readonly conclusion?: RuleConclusionBinding
  readonly ruleDependencies: readonly string[]
  readonly support: RuleSupportReport
}

export type RuleActionCandidateKind = 'rule' | 'action'

/* ----------------------------------------------------------------------------------------- */
/* Action declaration and capability binding                                                  */
/* ----------------------------------------------------------------------------------------- */

export type ActionSideEffect = 'none' | 'read_only' | 'writes' | 'external'

/**
 * The semantic declaration of an action (SPEC §4.2). It carries no implementation: the
 * deployment binds an operation later. `suggestedOperationRef` is an untrusted hint from the
 * model and never executes by itself.
 */
export interface ActionDeclaration {
  readonly actionId: string
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly inputSchemaRef: VersionRef
  readonly outputSchemaRef: VersionRef
  readonly preconditions: readonly string[]
  readonly requiredCapabilities: readonly CapabilityRequirement[]
  readonly permissions: readonly string[]
  readonly readOnly: boolean
  readonly sideEffect: ActionSideEffect
  readonly evidenceRequirements: readonly string[]
  /** The semantic task binding the declaration is published under, when one is named. */
  readonly taskBindingRef?: VersionRef
  /** An untrusted model hint at an implementation; verified against the registry below. */
  readonly suggestedOperationRef?: OperationRef
}

export type ActionCapabilityStatus = 'executable' | 'not_executable'

export type ActionCapabilityReasonCode =
  | 'NO_REGISTERED_OPERATION'
  | 'OPERATION_NOT_AUTHORIZED'
  | 'CONTRACT_INCOMPATIBLE'
  | 'MISSING_CAPABILITY'
  | 'NOT_READ_ONLY'
  | 'MODEL_SUGGESTED_CODE_REJECTED'
  | 'ARBITRARY_SCRIPT_REJECTED'
  | 'ARBITRARY_ADDRESS_REJECTED'
  | 'CREDENTIAL_REJECTED'
  | 'FORBIDDEN_FIELD_REJECTED'

export interface ActionCapabilityFinding {
  readonly code: ActionCapabilityReasonCode
  readonly message: string
  readonly path?: string
}

/** The trusted binding context; never read from a request body or a model response. */
export interface ActionCapabilityBindingInput {
  readonly registry: OperationRegistry
  /** Operation refs the trusted deployment authorized for this scope. */
  readonly authorizedOperations?: readonly OperationRef[]
  /** Capability names the deployment currently provides. */
  readonly availableCapabilities: readonly string[]
  readonly recordedAt: Rfc3339UtcTimestamp
}

/**
 * The result of binding a declaration to a registered, authorized operation. A
 * `not_executable` binding is still saved (semantic publish is allowed) but can never enable
 * an executable action. The registry version/digest is pinned so a later reader can detect a
 * registry drift instead of trusting a mutable head.
 */
export interface ActionCapabilityBinding {
  readonly actionId: string
  readonly status: ActionCapabilityStatus
  readonly executable: boolean
  readonly findings: readonly ActionCapabilityFinding[]
  readonly registryRef: VersionRef
  readonly operationRef?: OperationRef
  readonly handlerRef?: VersionRef
  readonly handlerDigest?: Sha256Digest
  readonly registeredInputSchemaDigest?: Sha256Digest
  readonly registeredOutputSchemaDigest?: Sha256Digest
  readonly recordedAt: Rfc3339UtcTimestamp
}

function capabilityViolationCode(code: string): ActionCapabilityReasonCode {
  switch (code) {
    case 'uri_value':
      return 'ARBITRARY_ADDRESS_REJECTED'
    case 'script_value':
      return 'ARBITRARY_SCRIPT_REJECTED'
    case 'credential_value':
      return 'CREDENTIAL_REJECTED'
    default:
      return 'MODEL_SUGGESTED_CODE_REJECTED'
  }
}

function notExecutable(
  actionId: string,
  input: ActionCapabilityBindingInput,
  findings: readonly ActionCapabilityFinding[],
): ActionCapabilityBinding {
  return {
    actionId,
    status: 'not_executable',
    executable: false,
    findings,
    registryRef: {
      id: input.registry.namespace,
      version: input.registry.registryVersion,
      digest: input.registry.registryDigest,
    },
    recordedAt: input.recordedAt,
  }
}

/**
 * Bind an action declaration to a registered operation.
 *
 * Order of checks:
 *  1. any forbidden executable content (code/script/url/credential) is rejected outright;
 *  2. an absent or unregistered `suggestedOperationRef` is `not_executable`;
 *  3. an operation outside the trusted authorized set is `not_executable`;
 *  4. every required/`available` capability and the input/output schema digests must match;
 *  5. only a read-only declaration may bind a read-only registered operation.
 *
 * A model-suggested operation that happens to match a registered, authorized, contract-equal
 * operation is accepted; the model can never introduce a new implementation.
 */
export function bindActionDeclaration(
  declaration: ActionDeclaration,
  input: ActionCapabilityBindingInput,
): ActionCapabilityBinding {
  const findings: ActionCapabilityFinding[] = []
  const secretViolations = findEmbeddedSecretViolations(declaration)
  const declarationViolations = findIndustryPackViolations(declaration)
  const seen = new Set<string>()
  for (const violation of [...secretViolations, ...declarationViolations]) {
    const key = `${violation.code}\u0000${violation.path}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push({
      code: capabilityViolationCode(violation.code),
      message: violation.message,
      path: violation.path,
    })
  }
  if (findings.length > 0) return notExecutable(declaration.actionId, input, findings)

  const suggested = declaration.suggestedOperationRef
  if (suggested === undefined) {
    findings.push({
      code: 'NO_REGISTERED_OPERATION',
      message: 'the declaration names no implementation; publish the semantic declaration only',
    })
    return notExecutable(declaration.actionId, input, findings)
  }
  const registered = findRegisteredOperation(input.registry, suggested)
  if (registered === undefined) {
    findings.push({
      code: 'NO_REGISTERED_OPERATION',
      message: `operation ${suggested.id}@${suggested.version} is not registered in this deployment`,
    })
    return notExecutable(declaration.actionId, input, findings)
  }
  if (
    input.authorizedOperations !== undefined &&
    !input.authorizedOperations.some(
      (operation) => operation.id === suggested.id && operation.version === suggested.version,
    )
  ) {
    findings.push({
      code: 'OPERATION_NOT_AUTHORIZED',
      message: `operation ${suggested.id}@${suggested.version} is not authorized for this scope`,
    })
  }
  const available = new Set(input.availableCapabilities)
  for (const required of registered.requiredCapabilities) {
    if (!available.has(required)) {
      findings.push({
        code: 'MISSING_CAPABILITY',
        message: `registered operation requires the ${required} capability, which is not available`,
      })
    }
  }
  for (const requirement of declaration.requiredCapabilities) {
    if (!available.has(requirement.name)) {
      findings.push({
        code: 'MISSING_CAPABILITY',
        message: `the declaration requires the ${requirement.name} capability, which is not available`,
      })
    }
  }
  if (registered.inputSchemaDigest !== declaration.inputSchemaRef.digest) {
    findings.push({
      code: 'CONTRACT_INCOMPATIBLE',
      message: 'the declaration input schema does not match the registered operation contract',
      path: 'inputSchemaRef.digest',
    })
  }
  if (registered.outputSchemaDigest !== declaration.outputSchemaRef.digest) {
    findings.push({
      code: 'CONTRACT_INCOMPATIBLE',
      message: 'the declaration output schema does not match the registered operation contract',
      path: 'outputSchemaRef.digest',
    })
  }
  if (!declaration.readOnly || !registered.readOnly) {
    findings.push({
      code: 'NOT_READ_ONLY',
      message: 'only a read-only declaration bound to a read-only operation may execute in this phase',
      path: 'readOnly',
    })
  }
  if (findings.length > 0) return notExecutable(declaration.actionId, input, findings)
  return executableBinding(declaration.actionId, registered, input)
}

function executableBinding(
  actionId: string,
  registered: RegisteredOperation,
  input: ActionCapabilityBindingInput,
): ActionCapabilityBinding {
  return {
    actionId,
    status: 'executable',
    executable: true,
    findings: [],
    registryRef: {
      id: input.registry.namespace,
      version: input.registry.registryVersion,
      digest: input.registry.registryDigest,
    },
    operationRef: registered.operationRef,
    handlerRef: registered.handlerRef,
    handlerDigest: registered.handlerDigest,
    registeredInputSchemaDigest: registered.inputSchemaDigest,
    registeredOutputSchemaDigest: registered.outputSchemaDigest,
    recordedAt: input.recordedAt,
  }
}

export interface ActionCandidatePayload {
  readonly kind: 'action'
  readonly declaration: ActionDeclaration
  /** Absent until a trusted deployment binds it; a declaration may be saved without one. */
  readonly binding?: ActionCapabilityBinding
}

/* ----------------------------------------------------------------------------------------- */
/* Candidate version and store                                                                */
/* ----------------------------------------------------------------------------------------- */

export interface RuleActionCandidateVersion {
  readonly candidateId: Uuid
  readonly workspaceId: Uuid
  readonly logicalId: string
  readonly domain: 'definition'
  readonly kind: RuleActionCandidateKind
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly payload: RuleCandidatePayload | ActionCandidatePayload
  readonly sourceRefs: readonly ResourceRef[]
  readonly sourceSpans: readonly CandidateSourceSpan[]
  readonly lifecycle: RuleActionCandidateLifecycle
  readonly enabledAt?: Rfc3339UtcTimestamp
  readonly replacesCandidateId?: Uuid
  readonly generationCallRef?: ResourceRef
  readonly contentDigest: Sha256Digest
  readonly idempotencyKey: Sha256Digest
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
}

export interface RuleCandidateVersion extends RuleActionCandidateVersion {
  readonly kind: 'rule'
  readonly payload: RuleCandidatePayload
}

export interface ActionCandidateVersion extends RuleActionCandidateVersion {
  readonly kind: 'action'
  readonly payload: ActionCandidatePayload
}

export function isRuleCandidateVersion(value: RuleActionCandidateVersion): value is RuleCandidateVersion {
  return value.kind === 'rule' && value.payload.kind === 'rule'
}

export function isActionCandidateVersion(value: RuleActionCandidateVersion): value is ActionCandidateVersion {
  return value.kind === 'action' && value.payload.kind === 'action'
}

export interface RuleActionCandidateQuery {
  readonly kind?: RuleActionCandidateKind
  readonly lifecycle?: RuleActionCandidateLifecycle
  /** Bounded page size; a caller never reads an unbounded table. */
  readonly limit?: number
}

export interface RuleActionCandidateTransition {
  readonly lifecycle: RuleActionCandidateLifecycle
  readonly enabledAt?: Rfc3339UtcTimestamp
}

/**
 * Control persistence for rule/action candidates (SPEC v0.3a §4.1). Every method runs in the
 * trusted tenant/space scope and RLS is a second layer behind the explicit scope predicate.
 * `insert` is idempotent on `idempotencyKey` and never mutates an existing candidate.
 */
export interface RuleActionCandidateStore {
  insert(
    scopeRef: ScopeRef,
    candidate: RuleActionCandidateVersion,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion>
  get(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion | undefined>
  list(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    query: RuleActionCandidateQuery,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion[]>
  transition(
    scopeRef: ScopeRef,
    candidateId: Uuid,
    transition: RuleActionCandidateTransition,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion>
}

export type RuleActionCandidateStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'CANDIDATE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_CANDIDATE'
  | 'STORE_FAILED'

export class RuleActionCandidateStoreError extends Error {
  readonly code: RuleActionCandidateStoreErrorCode

  constructor(code: RuleActionCandidateStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RuleActionCandidateStoreError'
    this.code = code
  }
}

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LIFECYCLES: readonly RuleActionCandidateLifecycle[] = ['draft', 'enabled', 'rejected']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isRuleActionCandidateLifecycle(value: unknown): value is RuleActionCandidateLifecycle {
  return typeof value === 'string' && (LIFECYCLES as readonly string[]).includes(value)
}

export function isRuleActionCandidateKind(value: unknown): value is RuleActionCandidateKind {
  return value === 'rule' || value === 'action'
}

function invalid(message: string): RuleActionCandidateStoreError {
  return new RuleActionCandidateStoreError('INVALID_CANDIDATE', message)
}

function assertVersionRef(value: unknown, field: string): void {
  if (!isRecord(value) || !isNonEmptyString(value['id']) || !isNonEmptyString(value['version']) || !isDigest(value['digest'])) {
    throw invalid(`${field} must be a version reference`)
  }
}

function assertPayload(payload: unknown, kind: RuleActionCandidateKind): void {
  if (!isRecord(payload)) throw invalid('candidate payload must be an object')
  if (payload['kind'] !== kind) throw invalid('candidate payload kind does not match the candidate kind')
  if (kind === 'rule') {
    if (!isNonEmptyString(payload['ruleId'])) throw invalid('a rule candidate payload requires a ruleId')
    if (!isRecord(payload['applicability'])) throw invalid('a rule candidate requires an applicability')
    if (!isRecord(payload['condition'])) throw invalid('a rule candidate requires a condition')
    if (!Array.isArray(payload['exceptions'])) throw invalid('a rule candidate requires an exceptions array')
    if (!isRecord(payload['support'])) throw invalid('a rule candidate requires a support report')
    return
  }
  const declaration = payload['declaration']
  if (!isRecord(declaration)) throw invalid('an action candidate requires a declaration')
  if (!isNonEmptyString(declaration['actionId'])) throw invalid('an action declaration requires an actionId')
  assertVersionRef(declaration['inputSchemaRef'], 'declaration.inputSchemaRef')
  assertVersionRef(declaration['outputSchemaRef'], 'declaration.outputSchemaRef')
  if (!Array.isArray(declaration['requiredCapabilities'])) {
    throw invalid('an action declaration requires a requiredCapabilities array')
  }
  if (typeof declaration['readOnly'] !== 'boolean') throw invalid('an action declaration requires a readOnly flag')
  const binding = payload['binding']
  if (binding !== undefined) {
    if (!isRecord(binding)) throw invalid('an action binding must be an object')
    if (binding['status'] !== 'executable' && binding['status'] !== 'not_executable') {
      throw invalid('an action binding status must be executable or not_executable')
    }
    if (typeof binding['executable'] !== 'boolean') throw invalid('an action binding requires an executable flag')
    if (binding['executable'] !== (binding['status'] === 'executable')) {
      throw invalid('an action binding executable flag must match its status')
    }
    assertVersionRef(binding['registryRef'], 'binding.registryRef')
  }
}

/** Validate one candidate before it is persisted; a malformed shape is rejected before any write. */
export function assertRuleActionCandidateShape(
  value: unknown,
): asserts value is RuleActionCandidateVersion {
  if (!isRecord(value)) throw invalid('a rule/action candidate must be an object')
  if (!isUuid(value['candidateId'])) throw invalid('candidateId must be a uuid')
  if (!isUuid(value['workspaceId'])) throw invalid('workspaceId must be a uuid')
  if (!isNonEmptyString(value['logicalId'])) throw invalid('logicalId must be a non-empty string')
  if (value['domain'] !== 'definition') throw invalid('domain must be definition')
  if (!isRuleActionCandidateKind(value['kind'])) throw invalid('kind must be rule or action')
  if (!isNonEmptyString(value['displayName'])) throw invalid('displayName must be a non-empty string')
  if (typeof value['businessMeaning'] !== 'string') throw invalid('businessMeaning must be a string')
  if (typeof value['suggestedReason'] !== 'string') throw invalid('suggestedReason must be a string')
  assertPayload(value['payload'], value['kind'])
  if (!Array.isArray(value['sourceRefs'])) throw invalid('sourceRefs must be an array')
  if (!Array.isArray(value['sourceSpans'])) throw invalid('sourceSpans must be an array')
  if (!isRuleActionCandidateLifecycle(value['lifecycle'])) throw invalid('lifecycle is not a known state')
  if (value['replacesCandidateId'] !== undefined && !isUuid(value['replacesCandidateId'])) {
    throw invalid('replacesCandidateId must be a uuid when present')
  }
  if (!isDigest(value['contentDigest'])) throw invalid('contentDigest must be a sha256 digest')
  if (!isDigest(value['idempotencyKey'])) throw invalid('idempotencyKey must be a sha256 digest')
  if (!isNonEmptyString(value['actor'])) throw invalid('actor must be a non-empty string')
  if (!isNonEmptyString(value['recordedAt'])) throw invalid('recordedAt must be a timestamp')
}

/** Derive relation authority from the pinned definition and preserve the reviewed rule's target filter. */
export function relationPremisesFromDefinition(definition: SemanticDefinitionVersion, condition?: RuleExpressionNode): readonly RuleRelationPremiseDeclaration[] {
  const conditions = new Map<string, RuleExpressionNode>()
  const visit = (node: RuleExpressionNode): void => {
    if (node.op === 'relation' && node.targetCondition !== undefined) conditions.set(node.relationId, node.targetCondition)
    else if (node.op === 'all' || node.op === 'any') node.operands.forEach(visit)
    else if (node.op === 'not') visit(node.operand)
  }
  if (condition !== undefined) visit(condition)
  const attributes = new Map(definition.attributes.map((attribute) => [attribute.id, attribute]))
  const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
  const numericOperand = (value: unknown, acceptsExactString: boolean): boolean =>
    (typeof value === 'number' && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) && decimal.test(String(value))) ||
    (acceptsExactString && typeof value === 'string' && decimal.test(value))
  const validTarget = (node: RuleExpressionNode, targetObjectId: string): boolean => {
    if (node.op === 'all' || node.op === 'any') return node.operands.length > 0 && node.operands.every((child) => validTarget(child, targetObjectId))
    if (node.op !== 'compare' && node.op !== 'range') return false
    const attribute = attributes.get(node.attributeId)
    if (attribute === undefined || attribute.objectId !== targetObjectId) return false
    const quantity = attribute.valueType === 'quantity'
    if (quantity ? attribute.unit === undefined || node.unitCode !== attribute.unit.unitCode : node.unitCode !== undefined) return false
    const numeric = quantity || attribute.valueType === 'number'
    if (node.op === 'range') {
      return numeric && (node.min !== undefined || node.max !== undefined) &&
        (node.min === undefined || numericOperand(node.min, false)) &&
        (node.max === undefined || numericOperand(node.max, false)) &&
        (node.min === undefined || node.max === undefined || node.min <= node.max)
    }
    if (!['eq', 'ne', 'lt', 'lte', 'gt', 'gte'].includes(node.operator)) return false
    if (numeric) return numericOperand(node.value, quantity)
    if (node.operator !== 'eq' && node.operator !== 'ne') return false
    switch (attribute.valueType) {
      case 'boolean': return typeof node.value === 'boolean'
      case 'enum': return typeof node.value === 'string' && attribute.enumValues?.includes(node.value) === true
      case 'timestamp': return typeof node.value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(node.value) && Number.isFinite(Date.parse(node.value)) && new Date(Date.parse(node.value)).toISOString().slice(0, 19) === node.value.slice(0, 19)
      case 'reference': return typeof node.value === 'string' && node.value.length > 0
      case 'string': return typeof node.value === 'string'
      default: return false
    }
  }
  return definition.relations.flatMap((relation): RuleRelationPremiseDeclaration[] => {
    const targetCondition = conditions.get(relation.id)
    if (targetCondition !== undefined && !validTarget(targetCondition, relation.toObjectId)) return []
    return [{ relationId: relation.id, fromObjectId: relation.fromObjectId, toObjectId: relation.toObjectId,
      definitionRef: definition.ref, depth: 1, ...(targetCondition === undefined ? {} : { targetCondition }) }]
  })
}
