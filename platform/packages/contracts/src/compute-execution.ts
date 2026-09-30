import type {
  DataMode,
  DomainResultStatus,
  NonEmptyString,
  OperationRef,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  SourceSnapshot,
  ToolCoverage,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Registered compute execution: the immutable invocation record and the result artifact
 * wrapper (SPEC v0.3a execution-evidence §EX-6).
 *
 * These types live next to `compute.ts`/`operations.ts` because they are the persistence and
 * artifact contracts of the same `data_query.kind=compute` path. They are data + guards only:
 * the executing service lives in `@ontology/tool-services` and reaches the control store
 * through the injected ports below. A record never carries a filesystem path, a URL, a code
 * body or a database credential — the handler is selected by the registered operation ref at
 * composition time and can never be named by model input.
 */

export const COMPUTE_INVOCATION_SCHEMA_VERSION = 'compute-invocation@1'
export const COMPUTE_OUTPUT_BINDINGS_SCHEMA_VERSION = 'typed-output-bindings@1'
export const COMPUTE_RESULT_ARTIFACT_SCHEMA_VERSION = 'compute-result-artifact@1'

/**
 * The lifecycle of one logical compute invocation. `prepared` is the initial record before a
 * worker claims it; `executing` is held under a single owner lease; `completed` is terminal and
 * idempotent (a retry of the same logical key reads the same valid output back); `failed` and
 * `cancelled` keep the appended attempts and are the entries a bounded retry re-claims. There
 * is no `unknown` state: a non-replayable external failure with no completion receipt is an
 * explicit blocked outcome, never a fabricated completed value.
 */
export type ComputeInvocationState = 'prepared' | 'executing' | 'completed' | 'failed' | 'cancelled'

/** One appended failure/cancellation attempt; the prior artifacts are never overwritten. */
export interface ComputeInvocationAttempt {
  readonly attempt: number
  readonly state: 'failed' | 'cancelled'
  readonly code: NonEmptyString
  readonly message: NonEmptyString
  readonly retryable: boolean
  readonly recordedAt: Rfc3339UtcTimestamp
}

/**
 * The immutable-per-logical-key invocation record. Its logical key is
 * scope + taskBindingRef + inputSnapshotDigest + parametersDigest + registeredOperationDigest;
 * the store keys on `logicalKeyDigest` so retrying the same logical action converges on the one
 * effective result instead of running the handler twice.
 */
export interface ComputeInvocationRecord {
  readonly schemaVersion: 'compute-invocation@1'
  readonly invocationId: Uuid
  readonly logicalKeyDigest: Sha256Digest
  readonly taskBindingRef: VersionRef
  readonly operationRef: OperationRef
  readonly registeredOperationDigest: Sha256Digest
  readonly inputSnapshotRef: ResourceRef
  readonly inputSnapshotDigest: Sha256Digest
  readonly parametersRef: ResourceRef
  readonly parametersDigest: Sha256Digest
  readonly state: ComputeInvocationState
  /** 1-based count of times this logical invocation has been attempted. */
  readonly attempt: number
  readonly resultRef?: ResourceRef
  readonly resultDigest?: Sha256Digest
  readonly attempts: readonly ComputeInvocationAttempt[]
  readonly createdAt: Rfc3339UtcTimestamp
  readonly updatedAt: Rfc3339UtcTimestamp
}

export interface ComputeInvocationClaimResult {
  readonly record: ComputeInvocationRecord
  /** False when an existing record was returned unchanged (a completed/reused invocation). */
  readonly created: boolean
}

/**
 * One field of the raw output projection (SPEC v0.3a §EX-7.1, §EX-6). It binds a value pointer
 * into the archived domain output to its row/column identity, the input ref it derives from and
 * its separated unit/currency/time/status axes. `unit` and `currency` are never collapsed: a
 * money value keeps its currency where a quantity keeps its unit.
 */
export interface ComputeFieldBinding {
  readonly rowKey: NonEmptyString
  readonly columnRef: NonEmptyString
  /** JSON pointer into the archived domain output (`outputArtifactRef`). */
  readonly valuePointer: NonEmptyString
  /** JSON pointers to the exact input refs/values this field was computed from. */
  readonly inputRefPointers: readonly NonEmptyString[]
  readonly unit?: NonEmptyString
  readonly currency?: NonEmptyString
  readonly timePointer?: NonEmptyString
  readonly status: DomainResultStatus
  readonly completeness: 'complete' | 'incomplete' | 'truncated'
}

/**
 * The raw output bindings archived *before* the gateway envelope exists (SPEC v0.3a §EX-6,
 * §5.1 step 3). It references the domain output artifact/digest and the registered output
 * schema, and carries one field binding per computed metric. It deliberately carries no gateway
 * `evidenceRef`: the Core typed manifest (issue V03-032) is what binds the real evidence later,
 * so the artifact graph never forms a manifest↔evidence cycle.
 */
export interface ComputeOutputBindings {
  readonly schemaVersion: 'typed-output-bindings@1'
  readonly outputArtifactRef: ResourceRef
  readonly outputDigest: Sha256Digest
  readonly outputSchemaRef: VersionRef
  readonly parametersDigest: Sha256Digest
  readonly inputRefs: readonly ResourceRef[]
  readonly rowKeys: readonly NonEmptyString[]
  readonly fields: readonly ComputeFieldBinding[]
  readonly coverage: ToolCoverage
  readonly domainStatus: DomainResultStatus
  readonly dataMode: DataMode
}

/**
 * The generic `compute-result-artifact@1` wrapper (SPEC v0.3a §EX-6). It pins the invocation,
 * the registered operation/handler/schema digests, the fixed input snapshot and parameters, the
 * archived domain output and its raw output bindings. `DataQueryOutput(resultKind=computation)
 * .computation.resultRef` points at this wrapper; the algorithm/operation fields must agree.
 */
export interface ComputeResultArtifact {
  readonly schemaVersion: 'compute-result-artifact@1'
  readonly invocationId: Uuid
  readonly logicalKeyDigest: Sha256Digest
  readonly taskBindingRef: VersionRef
  readonly operationRef: OperationRef
  readonly registeredOperationDigest: Sha256Digest
  readonly algorithmVersion: VersionRef
  readonly inputSchemaDigest: Sha256Digest
  readonly outputSchemaDigest: Sha256Digest
  readonly inputSnapshotRef: ResourceRef
  readonly inputSnapshotDigest: Sha256Digest
  readonly parametersRef: ResourceRef
  readonly parametersDigest: Sha256Digest
  readonly inputRefs: readonly ResourceRef[]
  readonly outputArtifactRef: ResourceRef
  readonly outputDigest: Sha256Digest
  readonly outputBindingsRef: ResourceRef
  readonly sourceSnapshots: readonly SourceSnapshot[]
  readonly dependencyEvidenceRefs: readonly ResourceRef[]
  readonly coverage: ToolCoverage
  readonly domainStatus: DomainResultStatus
  readonly dataMode: DataMode
}

/** One archived output-bindings body and the ref it is addressed by. */
export interface ArchivedComputeOutputBindings {
  readonly ref: ResourceRef
  readonly bindings: ComputeOutputBindings
}

/** One archived compute result artifact wrapper and the ref it is addressed by. */
export interface ArchivedComputeResultArtifact {
  readonly ref: ResourceRef
  readonly artifact: ComputeResultArtifact
}

/**
 * Idempotent persistence for compute invocation records, keyed on
 * (scope, logicalKeyDigest). `createIfAbsent` is the idempotency gate; `claim` is the single
 * active-owner lease CAS; `complete`/`fail` append the terminal transition without overwriting
 * the prior attempts.
 */
export interface ComputeInvocationStore {
  createIfAbsent(
    scopeRef: ScopeRef,
    record: ComputeInvocationRecord,
    ctx: ToolContext,
  ): Promise<ComputeInvocationClaimResult>
  get(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<ComputeInvocationRecord | undefined>
  /**
   * Move a prepared/failed/cancelled (or lease-expired executing) record to `executing` under
   * `ownerId` until `leaseExpiresAt`. Returns undefined when another live owner holds the lease,
   * so a concurrent duplicate submission never starts a second handler run.
   */
  claim(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    ownerId: Uuid,
    leaseExpiresAt: Rfc3339UtcTimestamp,
    ctx: ToolContext,
  ): Promise<ComputeInvocationRecord | undefined>
  complete(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    result: { readonly resultRef: ResourceRef; readonly resultDigest: Sha256Digest },
    ctx: ToolContext,
  ): Promise<ComputeInvocationRecord>
  fail(
    scopeRef: ScopeRef,
    logicalKeyDigest: Sha256Digest,
    attempt: ComputeInvocationAttempt,
    ctx: ToolContext,
  ): Promise<ComputeInvocationRecord>
}

/** Immutable persistence for raw compute output bindings (idempotent per exact ref digest). */
export interface ComputeOutputBindingsStore {
  putBindings(
    scopeRef: ScopeRef,
    bindingsRef: ResourceRef,
    bindings: ComputeOutputBindings,
    ctx: ToolContext,
  ): Promise<void>
  getBindings(
    scopeRef: ScopeRef,
    bindingsRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedComputeOutputBindings | undefined>
}

/** Immutable persistence for compute result artifact wrappers (idempotent per ref digest). */
export interface ComputeResultArtifactStore {
  putArtifact(
    scopeRef: ScopeRef,
    artifactRef: ResourceRef,
    artifact: ComputeResultArtifact,
    ctx: ToolContext,
  ): Promise<void>
  getArtifact(
    scopeRef: ScopeRef,
    artifactRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedComputeResultArtifact | undefined>
}

/* ----------------------------------------------------------------------------------------- */
/* Runtime guards                                                                             */
/* ----------------------------------------------------------------------------------------- */

const COMPUTE_INVOCATION_STATES: readonly ComputeInvocationState[] = [
  'prepared',
  'executing',
  'completed',
  'failed',
  'cancelled',
]

const DOMAIN_STATUSES: readonly DomainResultStatus[] = [
  'known',
  'unknown',
  'conflict',
  'infeasible',
  'not_applicable',
]

const DATA_MODES: readonly DataMode[] = ['synthetic', 'observed', 'forecast', 'simulation', 'live']

const COMPLETENESS: readonly ComputeFieldBinding['completeness'][] = ['complete', 'incomplete', 'truncated']

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

function isOperationRef(value: unknown): value is OperationRef {
  return isRecord(value) && isNonEmptyString(value['id']) && isNonEmptyString(value['version'])
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

function isResourceRefArray(value: unknown): value is ResourceRef[] {
  return Array.isArray(value) && value.every(isResourceRef)
}

function isToolCoverage(value: unknown): value is ToolCoverage {
  if (!isRecord(value)) return false
  return typeof value['returned'] === 'number' && typeof value['truncated'] === 'boolean'
}

function isSourceSnapshot(value: unknown): value is SourceSnapshot {
  return (
    isRecord(value) &&
    isRecord(value['sourceRef']) &&
    isNonEmptyString(value['schemaVersion']) &&
    isNonEmptyString(value['readAt']) &&
    isNonEmptyString(value['consistency']) &&
    isDigest(value['resultDigest'])
  )
}

function isInvocationState(value: unknown): value is ComputeInvocationState {
  return typeof value === 'string' && (COMPUTE_INVOCATION_STATES as readonly string[]).includes(value)
}

function isDomainStatus(value: unknown): value is DomainResultStatus {
  return typeof value === 'string' && (DOMAIN_STATUSES as readonly string[]).includes(value)
}

function isDataMode(value: unknown): value is DataMode {
  return typeof value === 'string' && (DATA_MODES as readonly string[]).includes(value)
}

function isAttempt(value: unknown): value is ComputeInvocationAttempt {
  if (!isRecord(value)) return false
  return (
    typeof value['attempt'] === 'number' &&
    (value['state'] === 'failed' || value['state'] === 'cancelled') &&
    isNonEmptyString(value['code']) &&
    isNonEmptyString(value['message']) &&
    typeof value['retryable'] === 'boolean' &&
    isNonEmptyString(value['recordedAt'])
  )
}

function isFieldBinding(value: unknown): value is ComputeFieldBinding {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value['rowKey']) &&
    isNonEmptyString(value['columnRef']) &&
    isNonEmptyString(value['valuePointer']) &&
    Array.isArray(value['inputRefPointers']) &&
    value['inputRefPointers'].every(isNonEmptyString) &&
    (value['unit'] === undefined || isNonEmptyString(value['unit'])) &&
    (value['currency'] === undefined || isNonEmptyString(value['currency'])) &&
    (value['timePointer'] === undefined || isNonEmptyString(value['timePointer'])) &&
    isDomainStatus(value['status']) &&
    typeof value['completeness'] === 'string' &&
    (COMPLETENESS as readonly string[]).includes(value['completeness'])
  )
}

export function isComputeInvocationRecord(value: unknown): value is ComputeInvocationRecord {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== COMPUTE_INVOCATION_SCHEMA_VERSION) return false
  if (!isUuid(value['invocationId'])) return false
  if (!isDigest(value['logicalKeyDigest'])) return false
  if (!isVersionRef(value['taskBindingRef'])) return false
  if (!isOperationRef(value['operationRef'])) return false
  if (!isDigest(value['registeredOperationDigest'])) return false
  if (!isResourceRef(value['inputSnapshotRef'])) return false
  if (!isDigest(value['inputSnapshotDigest'])) return false
  if (!isResourceRef(value['parametersRef'])) return false
  if (!isDigest(value['parametersDigest'])) return false
  if (!isInvocationState(value['state'])) return false
  if (typeof value['attempt'] !== 'number' || !Number.isInteger(value['attempt']) || value['attempt'] < 1) {
    return false
  }
  if (value['resultRef'] !== undefined && !isResourceRef(value['resultRef'])) return false
  if (value['resultDigest'] !== undefined && !isDigest(value['resultDigest'])) return false
  if (!Array.isArray(value['attempts']) || !value['attempts'].every(isAttempt)) return false
  if (!isNonEmptyString(value['createdAt']) || !isNonEmptyString(value['updatedAt'])) return false
  return true
}

export function assertComputeInvocationRecordShape(
  value: unknown,
): asserts value is ComputeInvocationRecord {
  if (!isComputeInvocationRecord(value)) {
    throw invalidComputeContract('compute invocation does not match compute-invocation@1')
  }
}

export function isComputeOutputBindings(value: unknown): value is ComputeOutputBindings {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== COMPUTE_OUTPUT_BINDINGS_SCHEMA_VERSION) return false
  if (!isResourceRef(value['outputArtifactRef'])) return false
  if (!isDigest(value['outputDigest'])) return false
  if (!isVersionRef(value['outputSchemaRef'])) return false
  if (!isDigest(value['parametersDigest'])) return false
  if (!isResourceRefArray(value['inputRefs'])) return false
  if (!Array.isArray(value['rowKeys']) || !value['rowKeys'].every(isNonEmptyString)) return false
  if (!Array.isArray(value['fields']) || !value['fields'].every(isFieldBinding)) return false
  if (!isToolCoverage(value['coverage'])) return false
  if (!isDomainStatus(value['domainStatus'])) return false
  return isDataMode(value['dataMode'])
}

export function assertComputeOutputBindingsShape(
  value: unknown,
): asserts value is ComputeOutputBindings {
  if (!isComputeOutputBindings(value)) {
    throw invalidComputeContract('compute output bindings do not match typed-output-bindings@1')
  }
}

export function isComputeResultArtifact(value: unknown): value is ComputeResultArtifact {
  if (!isRecord(value)) return false
  if (value['schemaVersion'] !== COMPUTE_RESULT_ARTIFACT_SCHEMA_VERSION) return false
  if (!isUuid(value['invocationId'])) return false
  if (!isDigest(value['logicalKeyDigest'])) return false
  if (!isVersionRef(value['taskBindingRef'])) return false
  if (!isOperationRef(value['operationRef'])) return false
  if (!isDigest(value['registeredOperationDigest'])) return false
  if (!isVersionRef(value['algorithmVersion'])) return false
  if (!isDigest(value['inputSchemaDigest'])) return false
  if (!isDigest(value['outputSchemaDigest'])) return false
  if (!isResourceRef(value['inputSnapshotRef'])) return false
  if (!isDigest(value['inputSnapshotDigest'])) return false
  if (!isResourceRef(value['parametersRef'])) return false
  if (!isDigest(value['parametersDigest'])) return false
  if (!isResourceRefArray(value['inputRefs'])) return false
  if (!isResourceRef(value['outputArtifactRef'])) return false
  if (!isDigest(value['outputDigest'])) return false
  if (!isResourceRef(value['outputBindingsRef'])) return false
  if (!Array.isArray(value['sourceSnapshots']) || !value['sourceSnapshots'].every(isSourceSnapshot)) {
    return false
  }
  if (!isResourceRefArray(value['dependencyEvidenceRefs'])) return false
  if (!isToolCoverage(value['coverage'])) return false
  if (!isDomainStatus(value['domainStatus'])) return false
  return isDataMode(value['dataMode'])
}

export function assertComputeResultArtifactShape(
  value: unknown,
): asserts value is ComputeResultArtifact {
  if (!isComputeResultArtifact(value)) {
    throw invalidComputeContract('compute result artifact does not match compute-result-artifact@1')
  }
}

function invalidComputeContract(message: string): Error {
  return Object.assign(new Error(message), { name: 'ComputeContractError' })
}
