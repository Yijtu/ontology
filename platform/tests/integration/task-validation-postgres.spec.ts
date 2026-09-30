import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlStorageError,
  PostgresTaskFinalizationReceiptStore,
  PostgresTaskPolicyReportStore,
} from '@ontology/adapter-control-postgres'
import {
  TaskValidationPolicyRegistry,
  TaskValidationService,
  canonicalJson,
  sha256DigestOf,
} from '@ontology/application'
import { createToolContext } from '@ontology/contracts'
import type {
  CapabilityLimits,
  PublishedTaskBinding,
  RegisteredTaskValidationPolicy,
  ResourceRef,
  ScopedArtifactReader,
  TaskValidationPolicyBinding,
  TaskValidationPolicyPort,
  TaskValidationPolicyReport,
  TaskValidationRequest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const DIGEST = `sha256:${'a'.repeat(64)}`
const RECORDED_AT = '2026-09-30T00:00:00Z'
const POLICY_REF: VersionRef = { id: 'policy.business-invariant', version: '1.0.0', digest: DIGEST }
const HANDLER_REF: VersionRef = { id: 'handler.business-invariant', version: '1.0.0', digest: DIGEST }
const REPORT_SCHEMA_REF: VersionRef = { id: 'task-policy-report', version: '1.0.0', digest: DIGEST }
const LIMITS: CapabilityLimits = { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 10_000, maxConcurrency: 1 }

const EXECUTION_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'plan' }
const INPUT_SNAPSHOT_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const PARAMETERS_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const OUTPUT_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'computation' }
const RESULT_MANIFEST_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const TASK_BINDING_REF: VersionRef = { id: 'task.demo.compute', version: '1.0.0', digest: DIGEST }
const READER: ScopedArtifactReader = { read: async () => new Uint8Array() }

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let reportStore: PostgresTaskPolicyReportStore
let receiptStore: PostgresTaskFinalizationReceiptStore
let registry: TaskValidationPolicyRegistry
let service: TaskValidationService

function ctxFor(target: JobTestScope, runId: Uuid): ToolContext {
  return createToolContext({
    principal: {
      tenantId: target.tenantId,
      subjectId: 'policy-executor',
      roles: ['platform-admin', 'operator'],
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
    traceId: `task-validation:${randomUUID()}`,
  })
}

function record(): RegisteredTaskValidationPolicy {
  return {
    policyRef: POLICY_REF,
    handlerRef: HANDLER_REF,
    handlerDigest: DIGEST,
    stages: ['input', 'result'],
    requiredCapabilities: [],
    readOnly: true,
    limits: LIMITS,
    reportSchemaRef: REPORT_SCHEMA_REF,
  }
}

function declaredPolicy(stage: 'input' | 'result'): TaskValidationPolicyBinding {
  return {
    policyRef: POLICY_REF,
    stage,
    required: true,
    registryDigest: registry.registryDigest,
    reportSchemaRef: REPORT_SCHEMA_REF,
  }
}

function binding(): PublishedTaskBinding {
  return {
    schemaVersion: 'published-task-binding@1',
    taskBindingRef: TASK_BINDING_REF,
    actionDefinitionRef: { id: 'definition.demo', version: '1.0.0', digest: DIGEST },
    kind: 'compute',
    parameterSchema: { type: 'object' },
    parameterSchemaDigest: DIGEST,
    requiredCapabilities: [],
    requiredReadiness: [],
    resultSchemaRef: RESULT_MANIFEST_REF,
    operationRef: { id: 'operation.demo', version: '1.0.0' },
    registeredOperationDigest: DIGEST,
    validationPolicies: [declaredPolicy('input'), declaredPolicy('result')],
  }
}

class DeterministicPolicy implements TaskValidationPolicyPort {
  readonly policyRef: VersionRef = POLICY_REF
  readonly #failResult: boolean

  constructor(failResult = false) {
    this.#failResult = failResult
  }

  async validate(request: TaskValidationRequest): Promise<TaskValidationPolicyReport> {
    return {
      schemaVersion: 'task-policy-report@1',
      policyRef: request.binding.policyRef,
      registryDigest: request.binding.registryDigest,
      reportSchemaRef: request.binding.reportSchemaRef,
      stage: request.stage,
      executionBindingRef: request.executionBindingRef,
      inputSnapshotRef: request.inputSnapshotRef,
      inputSnapshotDigest: request.inputSnapshotDigest,
      parametersRef: request.parametersRef,
      parametersDigest: request.parametersDigest,
      ...(request.stage === 'result'
        ? {
            outputArtifactRef: request.outputArtifactRef,
            outputDigest: request.outputDigest,
            typedResultManifestRef: request.typedResultManifestRef,
          }
        : {}),
      status: this.#failResult && request.stage === 'result' ? 'fail' : 'pass',
      coverage: { returned: 1, truncated: false },
      violations: [],
      dependencyEvidenceRefs: [],
    }
  }
}

function inputRequest(): TaskValidationRequest {
  return {
    stage: 'input',
    binding: declaredPolicy('input'),
    executionBindingRef: EXECUTION_REF,
    inputSnapshotRef: INPUT_SNAPSHOT_REF,
    inputSnapshotDigest: DIGEST,
    parametersRef: PARAMETERS_REF,
    parametersDigest: DIGEST,
    readInput: READER,
    limits: LIMITS,
    deadline: '2026-12-31T00:00:00Z',
    signal: new AbortController().signal,
  }
}

function resultRequest(): TaskValidationRequest {
  return {
    stage: 'result',
    binding: declaredPolicy('result'),
    executionBindingRef: EXECUTION_REF,
    inputSnapshotRef: INPUT_SNAPSHOT_REF,
    inputSnapshotDigest: DIGEST,
    parametersRef: PARAMETERS_REF,
    parametersDigest: DIGEST,
    outputArtifactRef: OUTPUT_REF,
    outputDigest: DIGEST,
    typedResultManifestRef: RESULT_MANIFEST_REF,
    readInput: READER,
    limits: LIMITS,
    deadline: '2026-12-31T00:00:00Z',
    signal: new AbortController().signal,
  }
}

function finalizeInput(reportRefs: readonly ResourceRef[]) {
  return {
    taskBinding: binding(),
    executionBindingRef: EXECUTION_REF,
    inputSnapshotRef: INPUT_SNAPSHOT_REF,
    inputSnapshotDigest: DIGEST,
    parametersRef: PARAMETERS_REF,
    parametersDigest: DIGEST,
    outputArtifactRefs: [OUTPUT_REF],
    outputDigests: [DIGEST],
    typedResultManifestRef: RESULT_MANIFEST_REF,
    typedResultManifestDigest: DIGEST,
    policyReportRefs: reportRefs,
  }
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
  scope = await createJobScope(harness.adminClient, 'task-validation')
  otherScope = await createJobScope(harness.adminClient, 'task-validation-other')
  reportStore = new PostgresTaskPolicyReportStore(database)
  receiptStore = new PostgresTaskFinalizationReceiptStore(database)
  registry = new TaskValidationPolicyRegistry('1.0.0', [record()])
  service = new TaskValidationService({
    registry,
    policies: [new DeterministicPolicy()],
    reports: reportStore,
    receipts: receiptStore,
    availableCapabilities: [],
  })
})

afterAll(async () => {
  await database?.close()
  await harness?.stop()
})

describe('registered task validation policies over real PostgreSQL', () => {
  it('archives a report at its canonical digest and reads it back through the same scope', async () => {
    const ctx = ctxFor(scope, randomUUID())
    const archived = await service.validate(inputRequest(), ctx)
    expect(archived.ref.digest).toBe(sha256DigestOf(canonicalJson(archived.report)))

    const stored = await reportStore.getReport(scope.scopeRef, archived.ref, ctx)
    expect(stored?.report).toEqual(archived.report)
  })

  it('hides a report from another scope and refuses a conflicting body for the same ref', async () => {
    const ctx = ctxFor(scope, randomUUID())
    const archived = await service.validate(inputRequest(), ctx)

    const foreign = await reportStore.getReport(otherScope.scopeRef, archived.ref, ctxFor(otherScope, randomUUID()))
    expect(foreign).toBeUndefined()

    const conflicting = { ...archived.report, status: 'unknown' as const }
    const error = await expectStorageError(
      reportStore.putReport(scope.scopeRef, archived.ref, conflicting, ctx),
    )
    expect(error.code).toBe('UNIQUE_VIOLATION')
  })

  it('is idempotent for the exact same report bytes', async () => {
    const ctx = ctxFor(scope, randomUUID())
    const archived = await service.validate(inputRequest(), ctx)
    await expect(reportStore.putReport(scope.scopeRef, archived.ref, archived.report, ctx)).resolves.toBeUndefined()
  })

  it('finalizes an acyclic receipt from the required passed reports and reads it back', async () => {
    const ctx = ctxFor(scope, randomUUID())
    const input = await service.validate(inputRequest(), ctx)
    const result = await service.validate(resultRequest(), ctx)
    const finalized = await service.finalize(finalizeInput([input.ref, result.ref]), ctx)

    expect(finalized.receipt.requiredPolicyBindings).toHaveLength(2)
    expect(finalized.receipt.policyReportRefs).toHaveLength(2)
    // The receipt references the reports and the manifest; the reports never reference it.
    expect(canonicalJson([input.report, result.report]).includes(finalized.ref.id)).toBe(false)

    const stored = await receiptStore.getReceipt(scope.scopeRef, finalized.ref, ctx)
    expect(stored?.receipt).toEqual(finalized.receipt)

    const foreign = await receiptStore.getReceipt(otherScope.scopeRef, finalized.ref, ctxFor(otherScope, randomUUID()))
    expect(foreign).toBeUndefined()
  })

  it('blocks finalization while a required result policy has not passed', async () => {
    const ctx = ctxFor(scope, randomUUID())
    const failing = new TaskValidationService({
      registry,
      policies: [new DeterministicPolicy(true)],
      reports: reportStore,
      receipts: receiptStore,
    })
    const input = await failing.validate(inputRequest(), ctx)
    const result = await failing.validate(resultRequest(), ctx)
    await expect(failing.finalize(finalizeInput([input.ref, result.ref]), ctx)).rejects.toThrowError(
      /required validation policies/u,
    )
    await expect(failing.finalize(finalizeInput([input.ref]), ctx)).rejects.toThrowError(/required validation policies/u)
  })
})
