import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresProjectReadinessStore,
  PostgresProjectStore,
  PostgresPublishedTaskBindingStore,
  PostgresRunExecutionBindingStore,
  PostgresTaskInputSnapshotStore,
} from '@ontology/adapter-control-postgres'
import {
  RunExecutionPreflightService,
  canonicalJson,
  sha256DigestOf,
} from '@ontology/application'
import type { RunExecutionBinderInput, RunProfileBinding } from '@ontology/application'
import { ControlStorageError } from '@ontology/adapter-control-postgres'
import { createToolContext } from '@ontology/contracts'
import type {
  CapabilityLimits,
  MappingRef,
  ProjectRevision,
  ProjectRevisionBody,
  ProjectRevisionRef,
  PublishedTaskBinding,
  PublishedTaskBindingBody,
  ResolvedCapability,
  ResourceRef,
  RunExecutionRequest,
  ScopeRef,
  TaskInputSnapshot,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const DEFINITION_REF: VersionRef = { id: 'demo-definition', version: '1.0.0', digest: DIGEST }
const RESULT_SCHEMA_REF: VersionRef = { id: 'typed-result-manifest', version: '1.0.0', digest: DIGEST }
const RUNTIME_REF: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: DIGEST }
const EFFECTIVE_LIMITS_REF: VersionRef = { id: 'core-limits', version: '1.0.0', digest: DIGEST }
const PROJECT_ID: Uuid = randomUUID()
const RUN_ID: Uuid = randomUUID()
const DOCUMENT_SET_ID: Uuid = randomUUID()
const RECORDED_AT = '2026-09-30T00:00:00Z'
const PARAMETER_SCHEMA = { type: 'object', required: ['windowDays'] } as const
const PARAMETER_SCHEMA_DIGEST = sha256DigestOf(canonicalJson(PARAMETER_SCHEMA))

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let projectStore: PostgresProjectStore
let readinessStore: PostgresProjectReadinessStore
let taskBindingStore: PostgresPublishedTaskBindingStore
let inputSnapshotStore: PostgresTaskInputSnapshotStore
let runBindingStore: PostgresRunExecutionBindingStore
let preflight: RunExecutionPreflightService
let approvedInputRef: ResourceRef

function scopeRefOf(target: JobTestScope): ScopeRef {
  return { tenantId: target.tenantId, spaceId: target.spaceId }
}

function ctxFor(target: JobTestScope, runId = RUN_ID): ToolContext {
  return createToolContext({
    principal: {
      tenantId: target.tenantId,
      subjectId: 'task-executor',
      roles: ['platform-admin', 'profile-editor', 'operator'],
      scopes: [],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId,
      grantedAt: RECORDED_AT,
      expiresAt: '2026-12-31T00:00:00Z',
    },
    allowedResources: {
      tenantId: target.tenantId,
      spaceId: target.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: `task-execution:${randomUUID()}`,
  })
}

const MAPPING_REF: MappingRef = {
  id: 'mapping-demo',
  version: '1.0.0',
  digest: DIGEST,
  role: 'catalog',
  sourceObjectRef: { sourceRef: { namespace: 'demo', sourceId: 'records' }, objectPath: 'records' },
}

function revisionBody(): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef: { id: 'demo-pack', version: '1.0.0', digest: DIGEST },
    definitionRef: DEFINITION_REF,
    mappingRefs: [MAPPING_REF],
    profileRef: { id: 'profile-demo', version: '1.0.0', snapshotHash: DIGEST },
    documentSetRef: { id: DOCUMENT_SET_ID, version: '1.0.0', digest: DIGEST, kind: 'document' },
    approvedInputRef: approvedInputRef,
    semanticPublicationRefs: [DEFINITION_REF],
    sourceVisibilityEpoch: '4',
    changeReason: 'initial approval',
  }
}

function revision(): ProjectRevision {
  const body = revisionBody()
  return {
    ref: { projectId: PROJECT_ID, revision: '1', digest: sha256DigestOf(canonicalJson(body)) },
    industryPackRef: body.industryPackRef,
    definitionRef: body.definitionRef,
    mappingRefs: body.mappingRefs,
    profileRef: body.profileRef,
    documentSetRef: body.documentSetRef,
    ...(body.approvedInputRef === undefined ? {} : { approvedInputRef: body.approvedInputRef }),
    semanticPublicationRefs: body.semanticPublicationRefs,
    sourceVisibilityEpoch: body.sourceVisibilityEpoch,
    changeReason: body.changeReason,
  }
}

async function seedProject(): Promise<void> {
  if (harness === undefined) throw new Error('database harness is unavailable')
  await harness.adminClient.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'Task execution project', 1, 'active', $4, $5, 'tester', $6, $6)`,
    [scope.tenantId, scope.spaceId, PROJECT_ID, `project-create-${PROJECT_ID}`, DIGEST, RECORDED_AT],
  )
  const stored = revision()
  await harness.adminClient.query(
    `INSERT INTO agent_platform.project_revisions
       (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason, idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 4, 'initial approval', $6, $7, 'tester', $8)`,
    [scope.tenantId, scope.spaceId, PROJECT_ID, stored.ref.digest, JSON.stringify(revisionBody()), `revision-${PROJECT_ID}`, DIGEST, RECORDED_AT],
  )
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

function binding(): PublishedTaskBinding {
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
  }
}

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

function profileBinding(): RunProfileBinding {
  return {
    profileRef: { id: 'profile-demo', version: '1.0.0' },
    resolvedProfileHash: DIGEST,
    resolvedProfileRef: { id: 'profile-demo', version: '1.0.0', snapshotHash: DIGEST },
    runtimeRef: RUNTIME_REF,
  }
}

function taskRequest(overrides: Partial<Extract<RunExecutionRequest, { mode: 'task' }>> = {}): RunExecutionRequest {
  const revisionRef: ProjectRevisionRef = revision().ref
  return {
    mode: 'task',
    projectRevisionRef: revisionRef,
    inputSnapshotRef: { ...approvedInputRef },
    inputSnapshotDigest: approvedInputRef.digest,
    taskBindingRef: binding().taskBindingRef,
    parameters: { windowDays: 30 },
    ...overrides,
  }
}

function binderInput(request: RunExecutionRequest): RunExecutionBinderInput {
  return { runId: RUN_ID, request, profileBinding: profileBinding() }
}

async function expectStorageError(promise: Promise<unknown>): Promise<ControlStorageError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ControlStorageError) return error
    throw error
  }
  throw new Error('expected a ControlStorageError')
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  scope = await createJobScope(harness.adminClient, 'task-exec')
  otherScope = await createJobScope(harness.adminClient, 'task-exec-other')
  approvedInputRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
  await seedProject()

  projectStore = new PostgresProjectStore(database)
  readinessStore = new PostgresProjectReadinessStore(database)
  taskBindingStore = new PostgresPublishedTaskBindingStore(database)
  inputSnapshotStore = new PostgresTaskInputSnapshotStore(database)
  runBindingStore = new PostgresRunExecutionBindingStore(database)

  await readinessStore.upsertProjection(
    scopeRefOf(scope),
    {
      projectRevisionRef: revision().ref,
      kind: 'dataset',
      targetRef: approvedInputRef,
      state: 'ready',
      completeness: 'complete',
      expectedCount: 3,
      processedCount: 3,
      failedCount: 0,
      targetDigest: DIGEST,
      fenceRevision: '1',
      idempotencyKey: `readiness-${PROJECT_ID}`,
      requestDigest: DIGEST,
      actor: 'tester',
      recordedAt: RECORDED_AT,
    },
    ctxFor(scope),
  )

  preflight = new RunExecutionPreflightService({
    projects: projectStore,
    taskBindings: taskBindingStore,
    inputSnapshots: inputSnapshotStore,
    runExecutionBindings: runBindingStore,
    readiness: readinessStore,
    operations: { namespace: 'test', registryVersion: '1.0.0', registryDigest: DIGEST, operations: [] },
    availableCapabilities: [capability('structured_query')],
    supportedResultSchemaRefs: [RESULT_SCHEMA_REF],
    effectiveLimitsRef: EFFECTIVE_LIMITS_REF,
    // This suite exercises control archival; real business resolution is covered by Core task tests.
    projectQuerySnapshot: async () => ({ ...approvedInputRef, kind: 'dataset' }),
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
    now: () => RECORDED_AT,
  })
})

afterAll(async () => {
  await database?.close()
  await harness?.stop()
})

describe('published task bindings over real PostgreSQL', () => {
  it('stores an immutable binding and rejects a conflicting body for the same version', async () => {
    await taskBindingStore.putBinding(scopeRefOf(scope), binding(), ctxFor(scope))
    const stored = await taskBindingStore.getBinding(scopeRefOf(scope), binding().taskBindingRef, ctxFor(scope))
    expect(stored?.taskBindingRef).toEqual(binding().taskBindingRef)

    const conflicting: PublishedTaskBinding = { ...binding(), requiredCapabilities: ['other'] }
    const error = await expectStorageError(
      taskBindingStore.putBinding(scopeRefOf(scope), conflicting, ctxFor(scope)),
    )
    expect(error.code).toBe('UNIQUE_VIOLATION')
  })

  it('lists bindings for the exact definition and hides another scope', async () => {
    const listed = await taskBindingStore.listBindings(
      scopeRefOf(scope),
      { definitionRef: DEFINITION_REF },
      ctxFor(scope),
    )
    expect(listed.map((entry) => entry.taskBindingRef.id)).toContain('task.demo.count')

    const other = await taskBindingStore.getBinding(scopeRefOf(otherScope), binding().taskBindingRef, ctxFor(otherScope))
    expect(other).toBeUndefined()
  })
})

describe('derived task input snapshots over real PostgreSQL', () => {
  it('stores and reads back a derived input that pins the base revision', async () => {
    const derivedRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'artifact' }
    const snapshot: TaskInputSnapshot = {
      ref: derivedRef,
      body: {
        schemaVersion: 'task-input-snapshot@1',
        projectId: PROJECT_ID,
        projectRevisionRef: revision().ref,
        baseInputRef: { ...approvedInputRef },
        baseInputDigest: approvedInputRef.digest,
        inputSchemaRef: RESULT_SCHEMA_REF,
        dependencies: [],
        producedBy: 'costing-snapshot-service',
        producedAt: RECORDED_AT,
      },
    }
    await inputSnapshotStore.putSnapshot(scopeRefOf(scope), snapshot, ctxFor(scope))
    const stored = await inputSnapshotStore.getSnapshot(scopeRefOf(scope), derivedRef, ctxFor(scope))
    expect(stored?.body.projectRevisionRef).toEqual(revision().ref)
    expect(stored?.body.baseInputRef).toEqual(approvedInputRef)

    const hidden = await inputSnapshotStore.getSnapshot(scopeRefOf(otherScope), derivedRef, ctxFor(otherScope))
    expect(hidden).toBeUndefined()
  })
})

describe('run execution binding preflight over real PostgreSQL', () => {
  it('resolves, archives and reads back the immutable execution binding', async () => {
    const resolution = await preflight.bindExecution(binderInput(taskRequest()), scopeRefOf(scope), ctxFor(scope))
    expect(resolution.capability?.state).toBe('available')

    const archived = await runBindingStore.getBindingByRun(scopeRefOf(scope), RUN_ID, ctxFor(scope))
    expect(archived?.ref.digest).toBe(resolution.executionBindingRef.digest)
    expect(archived?.binding.request.mode).toBe('task')
    expect(archived?.binding.projectDatasetSnapshotRef).toEqual({ ...approvedInputRef, kind: 'dataset' })
    expect(archived?.binding.effectiveTime.asOfRecordedSeq).toBe('4')
    expect(archived?.binding.allowedTaskBindingRefs).toEqual([binding().taskBindingRef])

    const byRef = await runBindingStore.getBindingByRef(
      scopeRefOf(scope),
      resolution.executionBindingRef,
      ctxFor(scope),
    )
    expect(byRef?.binding.runId).toBe(RUN_ID)

    const hidden = await runBindingStore.getBindingByRun(scopeRefOf(otherScope), RUN_ID, ctxFor(otherScope))
    expect(hidden).toBeUndefined()
  })

  it('refuses a second, different binding for the same run', async () => {
    const resolution = await preflight.bindExecution(binderInput(taskRequest()), scopeRefOf(scope), ctxFor(scope))
    const error = await expectStorageError(
      runBindingStore.archiveBinding(
        scopeRefOf(scope),
        RUN_ID,
        resolution.executionBindingRef,
        { ...resolution.binding, effectiveLimitsRef: { ...EFFECTIVE_LIMITS_REF, digest: DIGEST_B } },
        ctxFor(scope),
      ),
    )
    expect(error.code).toBe('UNIQUE_VIOLATION')
  })
})
