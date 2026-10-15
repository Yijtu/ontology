import { describe, expect, it } from 'vitest'
import {
  RunExecutionPreflightService,
  canonicalJson,
  evaluateTaskCapability,
  registeredOperationDigest,
  sha256DigestOf,
} from '@ontology/application'
import type { RunExecutionPreflightDependencies } from '@ontology/application'
import { RunServiceError } from '@ontology/application'
import type {
  ArchivedRunExecutionBinding,
  CapabilityLimits,
  MappingRef,
  OperationRegistry,
  ProjectReadinessKind,
  ProjectReadinessStore,
  ProjectRevision,
  ProjectRevisionRef,
  PublishedTaskBinding,
  PublishedTaskBindingBody,
  ReadinessProjection,
  ResolvedCapability,
  ResourceRef,
  RunExecutionBinding,
  RunExecutionBindingStore,
  RunExecutionRequest,
  ScopeRef,
  TaskBindingStore,
  TaskInputSnapshot,
  TaskInputSnapshotStore,
  ToolContext,
  UpsertProjectReadinessInput,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { RunExecutionBinderInput, RunProfileBinding } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'
import { SCOPE_A, SCOPE_B } from './profile-resolver-fixtures'

const PROJECT_ID: Uuid = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const RUN_ID: Uuid = '9c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f'
const OTHER_RUN: Uuid = '8b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

const DEFINITION_REF: VersionRef = { id: 'demo-definition', version: '1.0.0', digest: DIGEST }
const RESULT_SCHEMA_REF: VersionRef = { id: 'typed-result-manifest', version: '1.0.0', digest: DIGEST }
const RUNTIME_REF: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: DIGEST }
const EFFECTIVE_LIMITS_REF: VersionRef = { id: 'core-limits', version: '1.0.0', digest: DIGEST }
const APPROVED_INPUT_REF: ResourceRef = { id: PROJECT_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const MAPPING_REF: MappingRef = {
  id: 'mapping-demo',
  version: '1.0.0',
  digest: DIGEST,
  role: 'catalog',
  sourceObjectRef: { sourceRef: { namespace: 'demo', sourceId: 'records' }, objectPath: 'records' },
}
const REVISION_REF: ProjectRevisionRef = { projectId: PROJECT_ID, revision: '3', digest: DIGEST }

const PARAMETER_SCHEMA = { type: 'object', required: ['windowDays'] } as const
const PARAMETER_SCHEMA_DIGEST = sha256DigestOf(canonicalJson(PARAMETER_SCHEMA))

function capability(name: string): ResolvedCapability {
  const limits: CapabilityLimits = { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000, maxConcurrency: 1 }
  return {
    name,
    version: '1.0.0',
    limits,
    consistency: 'repeatable_read',
    cancellation: 'supported',
    pagination: 'cursor',
    supportedDataTypes: ['string', 'integer', 'decimal', 'boolean', 'timestamp', 'json'],
    sourceComponentRef: { id: `${name}-component`, version: '1.0.0', digest: DIGEST },
  }
}

function bindingBody(): PublishedTaskBindingBody {
  return {
    schemaVersion: 'published-task-binding@1',
    taskBindingIdentity: { id: 'task.demo.count', version: '1.0.0' },
    actionDefinitionRef: DEFINITION_REF,
    kind: 'structured_query',
    parameterSchema: { ...PARAMETER_SCHEMA },
    parameterSchemaDigest: PARAMETER_SCHEMA_DIGEST,
    requiredCapabilities: ['structured_query'],
    requiredReadiness: ['dataset'],
    resultSchemaRef: RESULT_SCHEMA_REF,
  }
}

function binding(overrides: Partial<PublishedTaskBinding> = {}): PublishedTaskBinding {
  return {
    schemaVersion: 'published-task-binding@1',
    taskBindingRef: {
      id: 'task.demo.count',
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson(bindingBody())),
    },
    actionDefinitionRef: DEFINITION_REF,
    kind: 'structured_query',
    parameterSchema: { ...PARAMETER_SCHEMA },
    parameterSchemaDigest: PARAMETER_SCHEMA_DIGEST,
    requiredCapabilities: ['structured_query'],
    requiredReadiness: ['dataset'],
    resultSchemaRef: RESULT_SCHEMA_REF,
    ...overrides,
  }
}

function revision(overrides: Partial<ProjectRevision> = {}): ProjectRevision {
  return {
    ref: { ...REVISION_REF },
    industryPackRef: { id: 'demo-pack', version: '1.0.0', digest: DIGEST },
    definitionRef: DEFINITION_REF,
    mappingRefs: [MAPPING_REF],
    profileRef: { id: 'profile-demo', version: '1.0.0', snapshotHash: DIGEST },
    documentSetRef: { id: '4f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', version: '1.0.0', digest: DIGEST, kind: 'document' },
    approvedInputRef: { ...APPROVED_INPUT_REF },
    semanticPublicationRefs: [DEFINITION_REF],
    sourceVisibilityEpoch: '7',
    changeReason: 'approved',
    ...overrides,
  }
}

class FakeProjectStore {
  constructor(private readonly stored: ProjectRevision | undefined) {}
  async getRevision(
    _scopeRef: ScopeRef,
    projectId: Uuid,
    revisionNumber: string,
    _ctx: ToolContext,
  ): Promise<ProjectRevision | undefined> {
    void _scopeRef
    void _ctx
    if (this.stored === undefined) return undefined
    return this.stored.ref.projectId === projectId && this.stored.ref.revision === revisionNumber
      ? this.stored
      : undefined
  }
}

class FakeTaskBindingStore implements TaskBindingStore {
  readonly #byKey = new Map<string, PublishedTaskBinding>()
  add(value: PublishedTaskBinding): void {
    this.#byKey.set(`${value.taskBindingRef.id}@${value.taskBindingRef.version}#${value.taskBindingRef.digest}`, value)
  }
  async putBinding(_scopeRef: ScopeRef, value: PublishedTaskBinding): Promise<void> {
    this.add(value)
  }
  async getBinding(_scopeRef: ScopeRef, ref: VersionRef): Promise<PublishedTaskBinding | undefined> {
    return this.#byKey.get(`${ref.id}@${ref.version}#${ref.digest}`)
  }
  async listBindings(
    _scopeRef: ScopeRef,
    filter: { definitionRef?: VersionRef; kind?: string },
  ): Promise<PublishedTaskBinding[]> {
    return [...this.#byKey.values()].filter(
      (entry) =>
        (filter.kind === undefined || entry.kind === filter.kind) &&
        (filter.definitionRef === undefined || entry.actionDefinitionRef.id === filter.definitionRef.id),
    )
  }
}

class FakeInputSnapshotStore implements TaskInputSnapshotStore {
  readonly #byKey = new Map<string, TaskInputSnapshot>()
  add(value: TaskInputSnapshot): void {
    this.#byKey.set(`${value.ref.id}@${value.ref.version}#${value.ref.digest}`, value)
  }
  async putSnapshot(_scopeRef: ScopeRef, value: TaskInputSnapshot): Promise<void> {
    this.add(value)
  }
  async getSnapshot(_scopeRef: ScopeRef, ref: ResourceRef): Promise<TaskInputSnapshot | undefined> {
    return this.#byKey.get(`${ref.id}@${ref.version}#${ref.digest}`)
  }
}

class FakeRunExecutionBindingStore implements RunExecutionBindingStore {
  readonly archived: { runId: Uuid; ref: ResourceRef; binding: RunExecutionBinding }[] = []
  async archiveBinding(
    _scopeRef: ScopeRef,
    runId: Uuid,
    ref: ResourceRef,
    value: RunExecutionBinding,
  ): Promise<void> {
    this.archived.push({ runId, ref, binding: value })
  }
  async getBindingByRun(): Promise<ArchivedRunExecutionBinding | undefined> {
    return undefined
  }
  async getBindingByRef(): Promise<ArchivedRunExecutionBinding | undefined> {
    return undefined
  }
}

class FakeReadinessStore implements ProjectReadinessStore {
  constructor(private projections: readonly ReadinessProjection[]) {}
  set(projections: readonly ReadinessProjection[]): void {
    this.projections = projections
  }
  async upsertProjection(
    _scopeRef: ScopeRef,
    _input: UpsertProjectReadinessInput,
  ): Promise<never> {
    void _scopeRef
    void _input
    throw new Error('not used')
  }
  async getProjection(
    _scopeRef: ScopeRef,
    _ref: ProjectRevisionRef,
    kind: ProjectReadinessKind,
  ): Promise<ReadinessProjection | undefined> {
    return this.projections.find((projection) => projection.kind === kind)
  }
  async listProjections(): Promise<ReadinessProjection[]> {
    return [...this.projections]
  }
}

function readiness(kind: ProjectReadinessKind, state: ReadinessProjection['state']): ReadinessProjection {
  return {
    projectRevisionRef: REVISION_REF,
    kind,
    targetRef: APPROVED_INPUT_REF,
    state,
    completeness: 'complete',
    expectedCount: 5,
    processedCount: 5,
    failedCount: 0,
    targetDigest: DIGEST,
    fenceRevision: '7',
  }
}

function operations(withOperation = false): OperationRegistry {
  const operation = {
    operationRef: { id: 'op.demo', version: '1.0.0' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    inputSchemaDigest: DIGEST,
    outputSchemaDigest: DIGEST,
    handlerRef: { id: 'handler-demo', version: '1.0.0', digest: DIGEST },
    handlerDigest: DIGEST,
    readOnly: true as const,
    requiredCapabilities: ['structured_query'],
    limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000, maxConcurrency: 1 },
    dataMode: 'synthetic' as const,
  }
  return {
    namespace: 'test',
    registryVersion: '1.0.0',
    registryDigest: DIGEST,
    operations: withOperation ? [operation] : [],
  }
}

interface Harness {
  readonly service: RunExecutionPreflightService
  readonly runBindings: FakeRunExecutionBindingStore
  readonly readiness: FakeReadinessStore
  readonly taskBindings: FakeTaskBindingStore
}

function harness(overrides: Partial<RunExecutionPreflightDependencies> = {}, withSnapshotResolver = true): Harness {
  const taskBindings = new FakeTaskBindingStore()
  taskBindings.add(binding())
  const runBindings = new FakeRunExecutionBindingStore()
  const readinessStore = new FakeReadinessStore([readiness('dataset', 'ready')])
  const service = new RunExecutionPreflightService({
    projects: new FakeProjectStore(revision()),
    taskBindings,
    inputSnapshots: new FakeInputSnapshotStore(),
    runExecutionBindings: runBindings,
    readiness: readinessStore,
    operations: operations(),
    availableCapabilities: [capability('structured_query')],
    supportedResultSchemaRefs: [RESULT_SCHEMA_REF],
    effectiveLimitsRef: EFFECTIVE_LIMITS_REF,
    ...(withSnapshotResolver ? { projectQuerySnapshot: async () => ({ ...APPROVED_INPUT_REF, kind: 'dataset' as const }) } : {}),
    parameters: {
      validate: (schema, value) => {
        const required = Array.isArray((schema as { required?: unknown }).required)
          ? (schema as { required: string[] }).required
          : []
        const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
        const missing = required.filter((key) => !(key in record))
        return missing.length === 0 ? { valid: true, issues: [] } : { valid: false, issues: missing }
      },
    },
    ...overrides,
  })
  return { service, runBindings, readiness: readinessStore, taskBindings }
}

function profileBinding(): RunProfileBinding {
  return {
    profileRef: { id: 'profile-demo', version: '1.0.0' },
    resolvedProfileHash: DIGEST,
    resolvedProfileRef: { id: 'profile-demo', version: '1.0.0', snapshotHash: DIGEST },
    runtimeRef: RUNTIME_REF,
  }
}

function taskRequest(overrides: Partial<Extract<RunExecutionRequest, { mode: 'task' }>> = {}): RunExecutionRequest {
  return {
    mode: 'task',
    projectRevisionRef: { ...REVISION_REF },
    inputSnapshotRef: { ...APPROVED_INPUT_REF },
    inputSnapshotDigest: APPROVED_INPUT_REF.digest,
    taskBindingRef: binding().taskBindingRef,
    parameters: { windowDays: 30 },
    ...overrides,
  }
}

function binderInput(request: RunExecutionRequest): RunExecutionBinderInput {
  return { runId: RUN_ID, request, profileBinding: profileBinding() }
}

const OWNER_A = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', RUN_ID)
const OWNER_B = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['business-user'], 'owner-b', RUN_ID)

async function expectRunError(promise: Promise<unknown>): Promise<RunServiceError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof RunServiceError) return error
    throw error
  }
  throw new Error('expected a RunServiceError')
}

describe('evaluateTaskCapability', () => {
  const base = {
    binding: binding(),
    availableCapabilities: [capability('structured_query')],
    readiness: [readiness('dataset', 'ready')],
    operations: operations(),
    supportedResultSchemaRefs: [RESULT_SCHEMA_REF],
  }

  it('reports available when every requirement resolves', () => {
    const status = evaluateTaskCapability(base)
    expect(status.state).toBe('available')
    expect(status.blockers).toEqual([])
    expect(status.requiredCapabilities).toEqual(['structured_query'])
  })

  it('reports not_ready when a required readiness projection is missing', () => {
    const status = evaluateTaskCapability({ ...base, readiness: [] })
    expect(status.state).toBe('not_ready')
    expect(status.blockers[0]).toMatchObject({ code: 'PROJECT_DATA_NOT_READY', readinessKind: 'dataset', retryable: true })
  })

  it('reports unavailable when a required capability is not configured', () => {
    const status = evaluateTaskCapability({ ...base, availableCapabilities: [] })
    expect(status.state).toBe('unavailable')
    expect(status.blockers[0]).toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED', capabilityName: 'structured_query' })
  })

  it('reports unavailable when the result format is not configured', () => {
    const status = evaluateTaskCapability({ ...base, supportedResultSchemaRefs: [] })
    expect(status.state).toBe('unavailable')
    expect(status.blockers[0]?.capabilityName).toContain('result-format')
  })

  it('reports unavailable when a pinned registered operation is not bound', () => {
    const digest = registeredOperationDigest(operations(true).operations[0]!)
    const withOperation = binding({
      operationRef: { id: 'op.demo', version: '1.0.0' },
      registeredOperationDigest: digest,
    })
    expect(evaluateTaskCapability({ ...base, binding: withOperation, operations: operations(true) }).state).toBe('available')

    const missing = evaluateTaskCapability({ ...base, binding: withOperation, operations: operations(false) })
    expect(missing.state).toBe('unavailable')
    expect(missing.blockers[0]?.code).toBe('COMPUTE_CONTRACT_MISMATCH')
  })
})

describe('RunExecutionPreflightService.resolve', () => {
  it('archives an immutable execution binding for an approved-input task run', async () => {
    const { service, runBindings } = harness()
    const resolution = await service.bindExecution(binderInput(taskRequest()), SCOPE_A, OWNER_A)
    expect(resolution.capability?.state).toBe('available')
    expect(resolution.binding.runId).toBe(RUN_ID)
    expect(resolution.binding.allowedTaskBindingRefs).toEqual([binding().taskBindingRef])
    expect(resolution.binding.projectDatasetSnapshotRef).toEqual({ ...APPROVED_INPUT_REF, kind: 'dataset' })
    expect(resolution.binding.effectiveTime.asOfRecordedSeq).toBe('7')
    expect(resolution.executionBindingRef.id).toBe(RUN_ID)
    expect(runBindings.archived).toHaveLength(1)
    expect(runBindings.archived[0]?.runId).toBe(RUN_ID)
  })

  it('rejects an execution request from another tenant/space scope', async () => {
    const { service } = harness()
    const error = await expectRunError(service.bindExecution(binderInput(taskRequest()), SCOPE_A, OWNER_B))
    expect(error.code).toBe('SCOPE_MISMATCH')
  })

  it('rejects a project revision whose digest does not match the stored revision', async () => {
    const { service } = harness()
    const request = taskRequest({
      projectRevisionRef: { projectId: PROJECT_ID, revision: '3', digest: DIGEST_B },
    })
    const error = await expectRunError(service.bindExecution(binderInput(request), SCOPE_A, OWNER_A))
    expect(error.code).toBe('VERSION_CONFLICT')
  })

  it('rejects an input snapshot digest that does not match the approved input', async () => {
    const { service } = harness()
    const request = taskRequest({ inputSnapshotDigest: DIGEST_B })
    const error = await expectRunError(service.bindExecution(binderInput(request), SCOPE_A, OWNER_A))
    expect(error.code).toBe('INPUT_SNAPSHOT_INVALID')
  })

  it('accepts a registered derived input that pins the base revision and approved input', async () => {
    const taskBindings = new FakeTaskBindingStore()
    taskBindings.add(binding())
    const inputSnapshots = new FakeInputSnapshotStore()
    const derivedRef: ResourceRef = { id: OTHER_RUN, version: '1.0.0', digest: DIGEST_B, kind: 'artifact' }
    inputSnapshots.add({
      ref: derivedRef,
      body: {
        schemaVersion: 'task-input-snapshot@1',
        projectId: PROJECT_ID,
        projectRevisionRef: { ...REVISION_REF },
        baseInputRef: { ...APPROVED_INPUT_REF },
        baseInputDigest: APPROVED_INPUT_REF.digest,
        inputSchemaRef: RESULT_SCHEMA_REF,
        dependencies: [],
        producedBy: 'costing-snapshot-service',
        producedAt: '2026-09-30T00:00:00Z',
      },
    })
    const { service } = harness({ taskBindings, inputSnapshots })
    const request = taskRequest({ inputSnapshotRef: derivedRef, inputSnapshotDigest: derivedRef.digest })
    const resolution = await service.bindExecution(binderInput(request), SCOPE_A, OWNER_A)
    expect(resolution.executionBindingRef.id).toBe(RUN_ID)
  })

  it('rejects a derived input that pins a different base input', async () => {
    const taskBindings = new FakeTaskBindingStore()
    taskBindings.add(binding())
    const inputSnapshots = new FakeInputSnapshotStore()
    const derivedRef: ResourceRef = { id: OTHER_RUN, version: '1.0.0', digest: DIGEST_B, kind: 'artifact' }
    inputSnapshots.add({
      ref: derivedRef,
      body: {
        schemaVersion: 'task-input-snapshot@1',
        projectId: PROJECT_ID,
        projectRevisionRef: { ...REVISION_REF },
        baseInputRef: { ...APPROVED_INPUT_REF, digest: DIGEST_B },
        baseInputDigest: DIGEST_B,
        inputSchemaRef: RESULT_SCHEMA_REF,
        dependencies: [],
        producedBy: 'costing-snapshot-service',
        producedAt: '2026-09-30T00:00:00Z',
      },
    })
    const { service } = harness({ taskBindings, inputSnapshots })
    const request = taskRequest({ inputSnapshotRef: derivedRef, inputSnapshotDigest: derivedRef.digest })
    const error = await expectRunError(service.bindExecution(binderInput(request), SCOPE_A, OWNER_A))
    expect(error.code).toBe('INPUT_SNAPSHOT_INVALID')
  })

  it('rejects an unregistered task binding', async () => {
    const { service } = harness({ taskBindings: new FakeTaskBindingStore() })
    const error = await expectRunError(service.bindExecution(binderInput(taskRequest()), SCOPE_A, OWNER_A))
    expect(error.code).toBe('TASK_NOT_BOUND')
  })

  it('rejects a task binding whose definition differs from the pinned revision', async () => {
    const taskBindings = new FakeTaskBindingStore()
    taskBindings.add(binding({ actionDefinitionRef: { id: 'other-definition', version: '1.0.0', digest: DIGEST } }))
    const { service } = harness({ taskBindings })
    const error = await expectRunError(service.bindExecution(binderInput(taskRequest()), SCOPE_A, OWNER_A))
    expect(error.code).toBe('PROFILE_INCOMPATIBLE')
  })

  it('rejects invalid task parameters before any binding is archived', async () => {
    const { service, runBindings } = harness()
    const request = taskRequest({ parameters: {} })
    const error = await expectRunError(service.bindExecution(binderInput(request), SCOPE_A, OWNER_A))
    expect(error.code).toBe('TASK_PARAMETER_INVALID')
    expect(runBindings.archived).toEqual([])
  })

  it('blocks a task whose required readiness is not ready', async () => {
    const { service, readiness } = harness()
    readiness.set([readinessProjection('building')])
    const error = await expectRunError(service.bindExecution(binderInput(taskRequest()), SCOPE_A, OWNER_A))
    expect(error.code).toBe('TASK_NOT_READY')
    expect(error.reasons?.[0]).toContain('PROJECT_DATA_NOT_READY')
  })

  it('blocks a task whose required capability is missing', async () => {
    const { service } = harness({ availableCapabilities: [] })
    const error = await expectRunError(service.bindExecution(binderInput(taskRequest()), SCOPE_A, OWNER_A))
    expect(error.code).toBe('TASK_UNAVAILABLE')
  })

  it('allows a question-mode request and archives an empty allowed set without bindings', async () => {
    const taskBindings = new FakeTaskBindingStore()
    const { service, runBindings } = harness({ taskBindings })
    const question: RunExecutionRequest = {
      mode: 'question',
      projectRevisionRef: { ...REVISION_REF },
      inputSnapshotRef: { ...APPROVED_INPUT_REF },
      inputSnapshotDigest: APPROVED_INPUT_REF.digest,
    }
    const resolution = await service.bindExecution(binderInput(question), SCOPE_A, OWNER_A)
    expect(resolution.binding.allowedTaskBindingRefs).toEqual([])
    expect(runBindings.archived).toHaveLength(1)
  })
  it('refuses a structured task when its official snapshot resolver is absent', async () => {
    const { service, runBindings } = harness({}, false)
    await expect(service.bindExecution(binderInput(taskRequest()), SCOPE_A, OWNER_A)).rejects.toMatchObject({ code: 'TASK_NOT_READY' })
    expect(runBindings.archived).toEqual([])
  })

  it('refuses a structured task whose definition digest differs despite matching id/version', async () => {
    const taskBindings = new FakeTaskBindingStore()
    taskBindings.add(binding({ actionDefinitionRef: { ...binding().actionDefinitionRef, digest: DIGEST_B } }))
    const { service, runBindings } = harness({ taskBindings })
    await expect(service.bindExecution(binderInput(taskRequest()), SCOPE_A, OWNER_A)).rejects.toMatchObject({ code: 'TASK_NOT_READY' })
    expect(runBindings.archived).toEqual([])
  })

})

function readinessProjection(state: ReadinessProjection['state']): ReadinessProjection {
  return {
    projectRevisionRef: REVISION_REF,
    kind: 'dataset',
    targetRef: APPROVED_INPUT_REF,
    state,
    completeness: 'partial',
    expectedCount: 5,
    processedCount: 2,
    failedCount: 0,
    targetDigest: DIGEST,
    fenceRevision: '7',
  }
}
