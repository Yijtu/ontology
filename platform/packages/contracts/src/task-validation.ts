import type {
  CapabilityLimits,
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  TaskFinalizationReceipt,
  TaskPolicyViolation,
  TaskValidationPolicyBinding,
  TaskValidationPolicyReport,
  TaskValidationPolicyStage,
  VersionRef,
} from './generated/contracts'
import type { ScopedArtifactReader } from './ports'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isSha256Digest, isVersionRef } from './asset-workspace'

/**
 * Registered task validation policy ports (SPEC v0.3a execution-evidence §EX-6.1).
 *
 * A validation policy is not a free tool: the trusted registry pins its handler
 * implementation, its declared read-only/limits and its report schema. The server
 * selects the implementation from the binding's policy ref and registry digest, so a
 * client, model or task request can never pick a different implementation, forge a
 * report or point at another scope's artifact. This module is data + guards only; the
 * executing service lives in `@ontology/application`.
 */

export const TASK_POLICY_REPORT_SCHEMA_VERSION = 'task-policy-report@1'
export const TASK_FINALIZATION_RECEIPT_SCHEMA_VERSION = 'task-finalization-receipt@1'

/**
 * One server-side request to execute a registered policy. The trusted run context is
 * passed separately as the second `validate` argument; everything here is derived from
 * the archived run (execution/input/parameter refs, limits, deadline, signal), never from
 * model-writable parameters.
 */
export type TaskValidationRequest =
  | {
      readonly stage: 'input'
      readonly binding: TaskValidationPolicyBinding
      readonly executionBindingRef: ResourceRef
      readonly inputSnapshotRef: ResourceRef
      readonly inputSnapshotDigest: Sha256Digest
      readonly parametersRef: ResourceRef
      readonly parametersDigest: Sha256Digest
      readonly readInput: ScopedArtifactReader
      readonly limits: CapabilityLimits
      readonly deadline: Rfc3339UtcTimestamp
      readonly signal: AbortSignal
    }
  | {
      readonly stage: 'result'
      readonly binding: TaskValidationPolicyBinding
      readonly executionBindingRef: ResourceRef
      readonly inputSnapshotRef: ResourceRef
      readonly inputSnapshotDigest: Sha256Digest
      readonly parametersRef: ResourceRef
      readonly parametersDigest: Sha256Digest
      readonly outputArtifactRef: ResourceRef
      readonly outputDigest: Sha256Digest
      readonly typedResultManifestRef: ResourceRef
      readonly readInput: ScopedArtifactReader
      readonly limits: CapabilityLimits
      readonly deadline: Rfc3339UtcTimestamp
      readonly signal: AbortSignal
    }

/**
 * The trusted implementation a registry record pins. The handler identity is fixed at
 * composition time; the service matches `policyRef` against the resolved record and
 * never accepts an implementation named by the request.
 */
export interface TaskValidationPolicyPort {
  readonly policyRef: VersionRef
  validate(request: TaskValidationRequest, ctx: ToolContext): Promise<TaskValidationPolicyReport>
}

/**
 * One trusted registry record. `handlerRef`/`handlerDigest` pin the implementation, and
 * the declared read-only flag/limits/required capabilities/ report schema all enter the
 * registry digest the published task binding is checked against.
 */
export interface RegisteredTaskValidationPolicy {
  readonly policyRef: VersionRef
  readonly handlerRef: VersionRef
  readonly handlerDigest: Sha256Digest
  readonly stages: readonly TaskValidationPolicyStage[]
  readonly requiredCapabilities: readonly NonEmptyString[]
  readonly readOnly: boolean
  readonly limits: CapabilityLimits
  readonly reportSchemaRef: VersionRef
}

/** The trusted registry content plus its deterministic digest. */
export interface TaskValidationPolicyRegistryData {
  readonly registryVersion: Semver
  readonly registryDigest: Sha256Digest
  readonly policies: readonly RegisteredTaskValidationPolicy[]
}

/** One archived immutable policy report and the ref it is addressed by. */
export interface ArchivedTaskPolicyReport {
  readonly ref: ResourceRef
  readonly report: TaskValidationPolicyReport
  /** Optional ref to a `computation` evidence record produced for the execution. */
  readonly evidenceRef?: ResourceRef
}

/** One archived immutable finalization receipt and the ref it is addressed by. */
export interface ArchivedTaskFinalizationReceipt {
  readonly ref: ResourceRef
  readonly receipt: TaskFinalizationReceipt
}

/** Persistence for immutable policy reports (idempotent per exact ref digest). */
export interface TaskPolicyReportStore {
  putReport(
    scopeRef: ScopeRef,
    reportRef: ResourceRef,
    report: TaskValidationPolicyReport,
    ctx: ToolContext,
    evidenceRef?: ResourceRef,
  ): Promise<void>
  getReport(
    scopeRef: ScopeRef,
    reportRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTaskPolicyReport | undefined>
}

/** Persistence for immutable finalization receipts (idempotent per exact ref digest). */
export interface TaskFinalizationReceiptStore {
  putReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    receipt: TaskFinalizationReceipt,
    ctx: ToolContext,
  ): Promise<void>
  getReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTaskFinalizationReceipt | undefined>
}

/**
 * Host-owned recorder that archives a `computation` evidence record for one policy
 * execution. It is optional: a deployment without an evidence store simply omits it,
 * and the service never fabricates an evidence ref itself.
 */
export interface TaskPolicyEvidenceRecorder {
  recordPolicyExecution(
    input: {
      readonly scopeRef: ScopeRef
      readonly executionBindingRef: ResourceRef
      readonly reportRef: ResourceRef
      readonly report: TaskValidationPolicyReport
    },
    ctx: ToolContext,
  ): Promise<ResourceRef>
}

const POLICY_STAGES: readonly TaskValidationPolicyStage[] = ['input', 'result']
const REPORT_STATUSES: readonly string[] = ['pass', 'fail', 'unknown', 'incomplete']

function isNonEmptyString(value: unknown): value is NonEmptyString {
  return typeof value === 'string' && value.length > 0
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isPolicyStage(value: unknown): value is TaskValidationPolicyStage {
  return POLICY_STAGES.includes(value as TaskValidationPolicyStage)
}

function isCapabilityLimits(value: unknown): value is CapabilityLimits {
  if (!isRecord(value)) return false
  return (
    typeof value['maxRows'] === 'number' &&
    typeof value['maxBytes'] === 'number' &&
    typeof value['maxDurationMs'] === 'number' &&
    (value['maxConcurrency'] === undefined || typeof value['maxConcurrency'] === 'number')
  )
}

function isToolCoverage(value: unknown): boolean {
  if (!isRecord(value)) return false
  return typeof value['returned'] === 'number' && typeof value['truncated'] === 'boolean'
}

function isTaskPolicyViolation(value: unknown): value is TaskPolicyViolation {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value['code']) &&
    isOptionalString(value['rowKey']) &&
    isOptionalString(value['columnRef']) &&
    isOptionalString(value['pointer']) &&
    isOptionalString(value['expected']) &&
    isOptionalString(value['actual'])
  )
}

/** Validate the declarative policy binding before it is trusted inside a task binding. */
export function assertTaskValidationPolicyBindingShape(
  value: unknown,
): asserts value is TaskValidationPolicyBinding {
  if (!isRecord(value)) throw invalidTaskValidation('policy binding must be an object')
  if (!isVersionRef(value['policyRef'])) throw invalidTaskValidation('policy binding policyRef is malformed')
  if (!isPolicyStage(value['stage'])) throw invalidTaskValidation('policy binding stage is not input/result')
  if (typeof value['required'] !== 'boolean') throw invalidTaskValidation('policy binding required must be a boolean')
  if (!isSha256Digest(value['registryDigest'])) throw invalidTaskValidation('policy binding registryDigest is malformed')
  if (!isVersionRef(value['reportSchemaRef'])) throw invalidTaskValidation('policy binding reportSchemaRef is malformed')
}

/** Validate a trusted registry record before it enters the registry digest. */
export function assertRegisteredTaskValidationPolicyShape(
  value: unknown,
): asserts value is RegisteredTaskValidationPolicy {
  if (!isRecord(value)) throw invalidTaskValidation('registry record must be an object')
  if (!isVersionRef(value['policyRef'])) throw invalidTaskValidation('registry record policyRef is malformed')
  if (!isVersionRef(value['handlerRef'])) throw invalidTaskValidation('registry record handlerRef is malformed')
  if (!isSha256Digest(value['handlerDigest'])) throw invalidTaskValidation('registry record handlerDigest is malformed')
  const stages = value['stages']
  if (!Array.isArray(stages) || stages.length === 0 || !stages.every(isPolicyStage)) {
    throw invalidTaskValidation('registry record stages must be a non-empty input/result array')
  }
  const capabilities = value['requiredCapabilities']
  if (!Array.isArray(capabilities) || !capabilities.every(isNonEmptyString)) {
    throw invalidTaskValidation('registry record requiredCapabilities must be a string array')
  }
  if (typeof value['readOnly'] !== 'boolean') throw invalidTaskValidation('registry record readOnly must be a boolean')
  if (!isCapabilityLimits(value['limits'])) throw invalidTaskValidation('registry record limits are malformed')
  if (!isVersionRef(value['reportSchemaRef'])) throw invalidTaskValidation('registry record reportSchemaRef is malformed')
}

/**
 * Runtime guard for a policy report. The stage-conditional result fields are enforced
 * here so a result-stage report can never omit the exact output/manifest it validated.
 */
export function isTaskValidationPolicyReport(value: unknown): value is TaskValidationPolicyReport {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== TASK_POLICY_REPORT_SCHEMA_VERSION) return false
  if (!isVersionRef(value['policyRef'])) return false
  if (!isSha256Digest(value['registryDigest'])) return false
  if (!isVersionRef(value['reportSchemaRef'])) return false
  if (!isPolicyStage(value['stage'])) return false
  if (!isResourceRef(value['executionBindingRef'])) return false
  if (!isResourceRef(value['inputSnapshotRef'])) return false
  if (!isSha256Digest(value['inputSnapshotDigest'])) return false
  if (!isResourceRef(value['parametersRef'])) return false
  if (!isSha256Digest(value['parametersDigest'])) return false
  if (typeof value['status'] !== 'string' || !REPORT_STATUSES.includes(value['status'])) return false
  if (!isToolCoverage(value['coverage'])) return false
  const violations = value['violations']
  if (!Array.isArray(violations) || !violations.every(isTaskPolicyViolation)) return false
  const dependencies = value['dependencyEvidenceRefs']
  if (!Array.isArray(dependencies) || !dependencies.every(isResourceRef)) return false
  if (value['stage'] === 'result') {
    return (
      isResourceRef(value['outputArtifactRef']) &&
      isSha256Digest(value['outputDigest']) &&
      isResourceRef(value['typedResultManifestRef'])
    )
  }
  return true
}

export function assertTaskValidationPolicyReportShape(
  value: unknown,
): asserts value is TaskValidationPolicyReport {
  if (!isTaskValidationPolicyReport(value)) {
    throw invalidTaskValidation('task policy report does not match task-policy-report@1')
  }
}

/** Runtime guard for the frozen finalization receipt. */
export function isTaskFinalizationReceipt(value: unknown): value is TaskFinalizationReceipt {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== TASK_FINALIZATION_RECEIPT_SCHEMA_VERSION) return false
  if (!isResourceRef(value['executionBindingRef'])) return false
  if (!isVersionRef(value['taskBindingRef'])) return false
  if (!isResourceRef(value['inputSnapshotRef'])) return false
  if (!isSha256Digest(value['inputSnapshotDigest'])) return false
  if (!isResourceRef(value['parametersRef'])) return false
  if (!isSha256Digest(value['parametersDigest'])) return false
  if (!Array.isArray(value['outputArtifactRefs']) || !value['outputArtifactRefs'].every(isResourceRef)) return false
  if (!Array.isArray(value['outputDigests']) || !value['outputDigests'].every(isSha256Digest)) return false
  if (!isResourceRef(value['typedResultManifestRef'])) return false
  if (!isSha256Digest(value['typedResultManifestDigest'])) return false
  if (!Array.isArray(value['requiredPolicyBindings']) || !value['requiredPolicyBindings'].every(isPolicyBinding)) {
    return false
  }
  if (!Array.isArray(value['policyReportRefs']) || !value['policyReportRefs'].every(isResourceRef)) return false
  return true
}

export function assertTaskFinalizationReceiptShape(
  value: unknown,
): asserts value is TaskFinalizationReceipt {
  if (!isTaskFinalizationReceipt(value)) {
    throw invalidTaskValidation('finalization receipt does not match task-finalization-receipt@1')
  }
}

function isPolicyBinding(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    isVersionRef(value['policyRef']) &&
    isPolicyStage(value['stage']) &&
    typeof value['required'] === 'boolean' &&
    isSha256Digest(value['registryDigest']) &&
    isVersionRef(value['reportSchemaRef'])
  )
}

function invalidTaskValidation(message: string): Error {
  return Object.assign(new Error(message), { name: 'TaskValidationContractError' })
}
