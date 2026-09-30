import type {
  ProjectRevisionRef,
  PublishedTaskBinding,
  ResourceRef,
  Rfc3339UtcTimestamp,
  RunExecutionBinding,
  RunExecutionRequest,
  ScopeRef,
  Sha256Digest,
  TaskKind,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isSha256Digest, isUuid, isVersionRef } from './asset-workspace'

/**
 * Versioned task-execution ports and runtime guards (SPEC v0.3a execution-evidence §EX-2,
 * §EX-6.1). These live next to the other control-store ports so an adapter can implement them
 * while depending on `contracts` alone; the application layer receives them by construction
 * injection and never imports an adapter, driver or industry implementation.
 *
 * The published task binding is a declarative record: required capabilities, readiness and an
 * optional registered operation pin. It never carries executable code, an endpoint or a client
 * field. The run execution binding is the immutable record the server archives for one run,
 * pinning the request, profile/runtime and effective time; the run row stores only its ref.
 */

const TASK_KINDS: readonly TaskKind[] = [
  'published_facts',
  'relations',
  'rule_judgement',
  'structured_query',
  'document_qa',
  'compute',
]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isTaskKind(value: unknown): value is TaskKind {
  return TASK_KINDS.includes(value as TaskKind)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString)
}

function isRecordOfUnknown(value: unknown): value is Readonly<Record<string, unknown>> {
  return isRecord(value)
}

function isRawResourceRef(value: unknown): value is ResourceRef {
  return isResourceRef(value)
}

function isVersionRefArray(value: unknown): value is VersionRef[] {
  return Array.isArray(value) && value.every(isVersionRef)
}

function isResourceRefArray(value: unknown): value is ResourceRef[] {
  return Array.isArray(value) && value.every(isResourceRef)
}

function isProjectRevisionRef(value: unknown): value is ProjectRevisionRef {
  return (
    isRecord(value) &&
    isUuid(value['projectId']) &&
    typeof value['revision'] === 'string' &&
    /^(0|[1-9]\d*)$/.test(value['revision']) &&
    isSha256Digest(value['digest'])
  )
}

/**
 * Reject a malformed published task binding before the store persists it: a later reader must
 * never trust an unvalidated binding (AGENTS: boundary data is validated at runtime). The
 * envelope's `taskBindingRef` is a full VersionRef; the body identity is not required here.
 */
export function assertPublishedTaskBindingShape(value: unknown): asserts value is PublishedTaskBinding {
  if (!isRecord(value)) throw invalidTask('published task binding must be an object')
  if (value['schemaVersion'] !== 'published-task-binding@1') {
    throw invalidTask('published task binding must declare schemaVersion published-task-binding@1')
  }
  if (!isVersionRef(value['taskBindingRef'])) throw invalidTask('taskBindingRef is malformed')
  if (!isVersionRef(value['actionDefinitionRef'])) throw invalidTask('actionDefinitionRef is malformed')
  if (!isTaskKind(value['kind'])) throw invalidTask('kind is not a registered task kind')
  if (!isRecordOfUnknown(value['parameterSchema'])) throw invalidTask('parameterSchema must be an object')
  if (!isSha256Digest(value['parameterSchemaDigest'])) throw invalidTask('parameterSchemaDigest is malformed')
  if (!isStringArray(value['requiredCapabilities'])) throw invalidTask('requiredCapabilities must be a string array')
  if (!isStringArray(value['requiredReadiness'])) throw invalidTask('requiredReadiness must be a string array')
  if (!isVersionRef(value['resultSchemaRef'])) throw invalidTask('resultSchemaRef is malformed')
  if (value['operationRef'] !== undefined && !isRecord(value['operationRef'])) {
    throw invalidTask('operationRef is malformed')
  }
  if (value['registeredOperationDigest'] !== undefined && !isSha256Digest(value['registeredOperationDigest'])) {
    throw invalidTask('registeredOperationDigest is malformed')
  }
  if (value['validationPolicies'] !== undefined && !Array.isArray(value['validationPolicies'])) {
    throw invalidTask('validationPolicies must be an array')
  }
  if (value['fixedPlanRef'] !== undefined && !isResourceRef(value['fixedPlanRef'])) {
    throw invalidTask('fixedPlanRef is malformed')
  }
}

/** Reject a malformed immutable execution binding before it is archived against a run. */
export function assertRunExecutionBindingShape(value: unknown): asserts value is RunExecutionBinding {
  if (!isRecord(value)) throw invalidTask('run execution binding must be an object')
  if (value['schemaVersion'] !== 'run-execution-binding@1') {
    throw invalidTask('run execution binding must declare schemaVersion run-execution-binding@1')
  }
  if (!isUuid(value['runId'])) throw invalidTask('runId must be a uuid')
  if (!isRunExecutionRequest(value['request'])) throw invalidTask('request is malformed')
  if (!isRecord(value['resolvedProfileRef'])) throw invalidTask('resolvedProfileRef is malformed')
  if (!isVersionRef(value['runtimeRef'])) throw invalidTask('runtimeRef is malformed')
  if (!isVersionRefArray(value['allowedTaskBindingRefs'])) throw invalidTask('allowedTaskBindingRefs are malformed')
  if (!isSha256Digest(value['inputManifestDigestAtCreation'])) {
    throw invalidTask('inputManifestDigestAtCreation is malformed')
  }
  if (!isVersionRef(value['effectiveLimitsRef'])) throw invalidTask('effectiveLimitsRef is malformed')
  const effectiveTime = value['effectiveTime']
  if (
    !isRecord(effectiveTime) ||
    typeof effectiveTime['validAt'] !== 'string' ||
    typeof effectiveTime['asOfRecordedSeq'] !== 'string'
  ) {
    throw invalidTask('effectiveTime is malformed')
  }
}

/** Validate the run execution request discriminated union at the wire boundary. */
export function isRunExecutionRequest(value: unknown): value is RunExecutionRequest {
  if (!isRecord(value)) return false
  if (!isProjectRevisionRef(value['projectRevisionRef'])) return false
  if (!isRawResourceRef(value['inputSnapshotRef'])) return false
  if (!isSha256Digest(value['inputSnapshotDigest'])) return false
  if (value['mode'] === 'question') {
    return (
      value['taskBindingRef'] === undefined &&
      value['parameters'] === undefined
    )
  }
  if (value['mode'] === 'task') {
    return isVersionRef(value['taskBindingRef']) && isRecordOfUnknown(value['parameters'])
  }
  return false
}

export function assertRunExecutionRequestShape(value: unknown): asserts value is RunExecutionRequest {
  if (!isRunExecutionRequest(value)) throw invalidTask('run execution request is malformed')
}

export const TASK_INPUT_SNAPSHOT_SCHEMA_VERSION = 'task-input-snapshot@1'

/**
 * The immutable body of a trusted, run-scoped task input snapshot (SPEC v0.3a §EX-2.1). It pins
 * the base project revision, the approved input it derives from, the input schema and the
 * approved dependencies it was produced from — but never its own ref/digest or a run manifest
 * digest, so a producer can hash the body before the envelope that references it exists.
 */
export interface TaskInputSnapshotBody {
  readonly schemaVersion: 'task-input-snapshot@1'
  readonly projectId: Uuid
  /** The base project revision this derived input was frozen from (never re-pointed). */
  readonly projectRevisionRef: ProjectRevisionRef
  /** Must equal the pinned revision's `approvedInputRef`. */
  readonly baseInputRef: ResourceRef
  readonly baseInputDigest: Sha256Digest
  readonly inputSchemaRef: VersionRef
  /** Approved project artefacts the derived input depends on, all in the same scope. */
  readonly dependencies: readonly ResourceRef[]
  readonly producedBy: string
  readonly producedAt: Rfc3339UtcTimestamp
}

export interface TaskInputSnapshot {
  readonly ref: ResourceRef
  readonly body: TaskInputSnapshotBody
}

/** Validate one immutable derived-input snapshot before it is persisted or trusted. */
export function assertTaskInputSnapshotShape(value: unknown): asserts value is TaskInputSnapshot {
  if (!isRecord(value)) throw invalidTask('task input snapshot must be an object')
  if (!isResourceRef(value['ref'])) throw invalidTask('task input snapshot ref is malformed')
  const body = value['body']
  if (!isRecord(body)) throw invalidTask('task input snapshot body must be an object')
  if (body['schemaVersion'] !== TASK_INPUT_SNAPSHOT_SCHEMA_VERSION) {
    throw invalidTask(`task input snapshot must declare schemaVersion ${TASK_INPUT_SNAPSHOT_SCHEMA_VERSION}`)
  }
  if (!isUuid(body['projectId'])) throw invalidTask('projectId must be a uuid')
  if (!isProjectRevisionRef(body['projectRevisionRef'])) throw invalidTask('projectRevisionRef is malformed')
  if (!isResourceRef(body['baseInputRef'])) throw invalidTask('baseInputRef is malformed')
  if (!isSha256Digest(body['baseInputDigest'])) throw invalidTask('baseInputDigest is malformed')
  if (!isVersionRef(body['inputSchemaRef'])) throw invalidTask('inputSchemaRef is malformed')
  if (!isResourceRefArray(body['dependencies'])) throw invalidTask('dependencies must be resource refs')
  if (!isNonEmptyString(body['producedBy'])) throw invalidTask('producedBy must be a non-empty string')
  if (typeof body['producedAt'] !== 'string') throw invalidTask('producedAt must be a timestamp')
}

function invalidTask(message: string): Error {
  return Object.assign(new Error(message), { name: 'TaskContractError' })
}

/** Persistence for published task bindings (immutable per exact ref). */
export interface TaskBindingStore {
  putBinding(scopeRef: ScopeRef, binding: PublishedTaskBinding, ctx: ToolContext): Promise<void>
  getBinding(
    scopeRef: ScopeRef,
    taskBindingRef: VersionRef,
    ctx: ToolContext,
  ): Promise<PublishedTaskBinding | undefined>
  listBindings(
    scopeRef: ScopeRef,
    filter: { readonly definitionRef?: VersionRef; readonly kind?: TaskKind },
    ctx: ToolContext,
  ): Promise<PublishedTaskBinding[]>
}

/** Persistence for trusted derived task input snapshots (immutable per exact ref). */
export interface TaskInputSnapshotStore {
  putSnapshot(scopeRef: ScopeRef, snapshot: TaskInputSnapshot, ctx: ToolContext): Promise<void>
  getSnapshot(
    scopeRef: ScopeRef,
    snapshotRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<TaskInputSnapshot | undefined>
}

/** One archived execution binding with the ref the run row points at. */
export interface ArchivedRunExecutionBinding {
  readonly ref: ResourceRef
  readonly binding: RunExecutionBinding
}

/** Persistence for immutable run execution bindings, keyed by run. */
export interface RunExecutionBindingStore {
  archiveBinding(
    scopeRef: ScopeRef,
    runId: Uuid,
    ref: ResourceRef,
    binding: RunExecutionBinding,
    ctx: ToolContext,
  ): Promise<void>
  getBindingByRun(
    scopeRef: ScopeRef,
    runId: Uuid,
    ctx: ToolContext,
  ): Promise<ArchivedRunExecutionBinding | undefined>
  getBindingByRef(
    scopeRef: ScopeRef,
    ref: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedRunExecutionBinding | undefined>
}
