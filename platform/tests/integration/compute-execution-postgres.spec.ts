import { exampleComputeArtifact } from '../helpers/example-compute-artifact'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlStorageError,
  PostgresComputeInvocationStore,
  PostgresComputeOutputBindingsStore,
  PostgresComputeResultArtifactStore,
} from '@ontology/adapter-control-postgres'
import {
  RegisteredComputeExecutionService,
  computeLogicalKeyDigest,
  createExampleComputeHandlers,
  exampleOperationRegistry,
  exampleRegisteredOperation,
  registeredOperationDigest,
} from '@ontology/tool-services'
import type { ToolSchemaValidator } from '@ontology/tool-services'
import { createToolContext } from '@ontology/contracts'
import type {
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  ComputeInvocationRecord,
  ImmutableArtifactWriter,
  ResourceRef,
  ScopedArtifactReader,
  ScopedArtifactReaderRequest,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const DIGEST = `sha256:${'a'.repeat(64)}`
const NOW = '2026-09-30T00:00:00Z'

function digestOfBytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function ctxFor(target: JobTestScope): ToolContext {
  const runId = randomUUID()
  return createToolContext({
    principal: { tenantId: target.tenantId, subjectId: 'compute-executor', roles: ['platform-admin', 'operator'], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId, grantedAt: NOW, expiresAt: '2026-12-31T00:00:00Z' },
    allowedResources: {
      tenantId: target.tenantId,
      spaceId: target.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: `compute-execution:${randomUUID()}`,
  })
}

class MemoryArtifacts implements ImmutableArtifactWriter {
  readonly blobs = new Map<string, Uint8Array>()

  async putBytes(request: ArtifactWriteRequest): Promise<BlobPutImmutableResponse> {
    const digest = digestOfBytes(request.content)
    this.blobs.set(digest, request.content)
    return {
      blobRef: { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest, verifiedAt: NOW },
    }
  }
}

class MemoryReader implements ScopedArtifactReader {
  readonly #artifacts: MemoryArtifacts

  constructor(artifacts: MemoryArtifacts) {
    this.#artifacts = artifacts
  }

  async read(request: ScopedArtifactReaderRequest): Promise<Uint8Array> {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('no input ref')
    const bytes = this.#artifacts.blobs.get(ref.digest)
    if (bytes === undefined) throw new Error(`no blob for ${ref.digest}`)
    return bytes
  }
}

const VALIDATOR: ToolSchemaValidator = {
  validateRef: () => ({ valid: true, issues: [] }),
  validateInline: (_schema: Readonly<Record<string, unknown>>, value: unknown) =>
    typeof value === 'object' && value !== null
      ? { valid: true, issues: [] }
      : { valid: false, issues: [{ pointer: '', reason: 'must be an object' }] },
}

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let invocations: PostgresComputeInvocationStore
let bindingsStore: PostgresComputeOutputBindingsStore
let resultsStore: PostgresComputeResultArtifactStore
let service: RegisteredComputeExecutionService
let artifacts: MemoryArtifacts
let inputRef: ResourceRef

function scopeRefOf(target: JobTestScope) {
  return { tenantId: target.tenantId, spaceId: target.spaceId }
}

function executionInput() {
  const operation = exampleRegisteredOperation(exampleComputeArtifact)
  const parameters = {}
  return {
    taskBindingRef: { id: 'task.example.aggregate', version: '1.0.0', digest: DIGEST },
    operationRef: operation.operationRef,
    registeredOperationDigest: registeredOperationDigest(operation),
    inputSnapshotRef: inputRef,
    inputSnapshotDigest: inputRef.digest,
    parametersRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' as const },
    parametersDigest: DIGEST,
    parameters,
    inputRefs: [inputRef],
    requiredInputRefs: [inputRef],
    deadline: '2026-12-31T00:00:00Z',
    signal: new AbortController().signal,
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
  scope = await createJobScope(harness.adminClient, 'compute-execution')
  otherScope = await createJobScope(harness.adminClient, 'compute-execution-other')

  invocations = new PostgresComputeInvocationStore(database)
  bindingsStore = new PostgresComputeOutputBindingsStore(database)
  resultsStore = new PostgresComputeResultArtifactStore(database)

  artifacts = new MemoryArtifacts()
  const bytes = new TextEncoder().encode(
    JSON.stringify({ rows: [{ id: 'r1', amount: '10.5', unit: 'each', currency: 'CNY' }] }),
  )
  const digest = digestOfBytes(bytes)
  artifacts.blobs.set(digest, bytes)
  inputRef = { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' }

  service = new RegisteredComputeExecutionService({
    operations: exampleOperationRegistry(exampleComputeArtifact),
    handlers: createExampleComputeHandlers(exampleComputeArtifact),
    artifacts,
    reader: new MemoryReader(artifacts),
    validator: VALIDATOR,
    invocations,
    outputBindings: bindingsStore,
    resultArtifacts: resultsStore,
  })
})

afterAll(async () => {
  await database?.close()
  await harness?.stop()
})

describe('registered compute execution over real PostgreSQL', () => {
  it('archives the invocation, wrapper and output bindings and reads them back in scope', async () => {
    const ctx = ctxFor(scope)
    const result = await service.execute(executionInput(), ctx)
    expect(result.invocation.state).toBe('completed')
    const operation = exampleRegisteredOperation(exampleComputeArtifact)
    expect(result.invocation.registeredOperationDigest).toBe(registeredOperationDigest(operation))
    expect(result.artifact.registeredOperationDigest).toBe(result.invocation.registeredOperationDigest)
    expect(result.artifact.algorithmVersion.digest).toBe(operation.handlerDigest)

    const resultRef = result.invocation.resultRef
    if (resultRef === undefined) throw new Error('the completed invocation has no result ref')
    const artifact = await resultsStore.getArtifact(scopeRefOf(scope), resultRef, ctx)
    expect(artifact?.artifact.invocationId).toBe(result.invocation.invocationId)
    expect(artifact?.artifact.algorithmVersion.digest).toBe(operation.handlerDigest)
    const bindings = await bindingsStore.getBindings(scopeRefOf(scope), result.artifact.outputBindingsRef, ctx)
    expect(bindings?.bindings.fields.some((field) => field.currency === 'CNY')).toBe(true)
    expect(bindings?.bindings.fields.some((field) => field.unit === 'each')).toBe(true)

    const hidden = await resultsStore.getArtifact(scopeRefOf(otherScope), resultRef, ctxFor(otherScope))
    expect(hidden).toBeUndefined()
  })

  it('is idempotent: a completed logical action is read back without a second invocation row', async () => {
    const ctx = ctxFor(scope)
    const first = await service.execute(executionInput(), ctx)
    const second = await service.execute(executionInput(), ctx)
    expect(second.reused).toBe(true)
    expect(second.invocation.invocationId).toBe(first.invocation.invocationId)

    const stored = await invocations.get(scopeRefOf(scope), first.invocation.logicalKeyDigest, ctx)
    expect(stored?.state).toBe('completed')
  })

  it('enforces a single owner lease and appends a retry attempt', async () => {
    const ctx = ctxFor(scope)
    // A distinct logical action so this test owns its invocation key, independent of the
    // idempotency test above.
    const input = {
      ...executionInput(),
      taskBindingRef: { id: 'task.example.lease', version: '1.0.0', digest: DIGEST },
    }
    const logicalKey = computeLogicalKeyDigest(scopeRefOf(scope), input)
    const prepared: ComputeInvocationRecord = {
      schemaVersion: 'compute-invocation@1',
      invocationId: randomUUID(),
      logicalKeyDigest: logicalKey,
      taskBindingRef: input.taskBindingRef,
      operationRef: input.operationRef,
      registeredOperationDigest: input.registeredOperationDigest,
      inputSnapshotRef: input.inputSnapshotRef,
      inputSnapshotDigest: input.inputSnapshotDigest,
      parametersRef: input.parametersRef,
      parametersDigest: input.parametersDigest,
      state: 'prepared',
      attempt: 1,
      attempts: [],
      createdAt: NOW,
      updatedAt: NOW,
    }
    const created = await invocations.createIfAbsent(scopeRefOf(scope), prepared, ctx)
    expect(created.created).toBe(true)
    const createdAt = await invocations.createIfAbsent(scopeRefOf(scope), prepared, ctx)
    expect(createdAt.created).toBe(false)

    const liveLease = new Date(Date.now() + 60_000).toISOString()
    const ownerA = randomUUID()
    const ownerB = randomUUID()
    const claimed = await invocations.claim(scopeRefOf(scope), logicalKey, ownerA, liveLease, ctx)
    expect(claimed?.state).toBe('executing')
    const blocked = await invocations.claim(scopeRefOf(scope), logicalKey, ownerB, liveLease, ctx)
    expect(blocked).toBeUndefined()

    const failed = await invocations.fail(
      scopeRefOf(scope),
      logicalKey,
      { attempt: 1, state: 'failed', code: 'COMPUTE_FUNCTION_FAILED', message: 'boom', retryable: true, recordedAt: NOW },
      ctx,
    )
    expect(failed.attempts).toHaveLength(1)
    expect(failed.state).toBe('failed')

    const retried = await invocations.claim(scopeRefOf(scope), logicalKey, ownerB, liveLease, ctx)
    expect(retried?.attempt).toBe(2)
  })

  it('rejects a conflicting body for the same output-bindings ref', async () => {
    const ctx = ctxFor(scope)
    const result = await service.execute(executionInput(), ctx)
    const conflicting = { ...result.bindings, parametersDigest: `sha256:${'b'.repeat(64)}` }
    const error = await expectStorageError(
      bindingsStore.putBindings(scopeRefOf(scope), result.artifact.outputBindingsRef, conflicting, ctx),
    )
    expect(error.code).toBe('UNIQUE_VIOLATION')
  })

  it('refuses an unavailable build artifact before creating an invocation, including replay', async () => {
    let available = true
    const pinned = createExampleComputeHandlers({
      readArtifact: () => {
        if (!available) throw new Error('the deployment artifact is missing')
        return exampleComputeArtifact.readArtifact()
      },
    })
    const local = new RegisteredComputeExecutionService({
      operations: exampleOperationRegistry(exampleComputeArtifact), handlers: pinned, artifacts, reader: new MemoryReader(artifacts),
      validator: VALIDATOR, invocations, outputBindings: bindingsStore, resultArtifacts: resultsStore,
    })
    const input = { ...executionInput(), taskBindingRef: { id: 'task.example.artifact-integrity', version: '1.0.0', digest: DIGEST } }
    const ctx = ctxFor(scope)
    const first = await local.execute(input, ctx)
    expect(first.artifact.algorithmVersion.digest).toBe(pinned[0]?.artifact?.handlerDigest)
    available = false
    await expect(local.execute(input, ctx)).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    const fresh = { ...input, taskBindingRef: { ...input.taskBindingRef, id: 'task.example.artifact-missing' } }
    await expect(local.execute(fresh, ctx)).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(await invocations.get(scopeRefOf(scope), computeLogicalKeyDigest(scopeRefOf(scope), fresh), ctx)).toBeUndefined()
  })

  it('records cancellation in PostgreSQL and refuses a late artifact completion', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let started: (() => void) | undefined
    const arrived = new Promise<void>((resolve) => { started = resolve })
    const lateArtifacts: ImmutableArtifactWriter = {
      async putBytes(request) {
        started?.()
        await blocked
        return artifacts.putBytes(request)
      },
    }
    const local = new RegisteredComputeExecutionService({
      operations: exampleOperationRegistry(exampleComputeArtifact), handlers: createExampleComputeHandlers(exampleComputeArtifact), artifacts: lateArtifacts,
      reader: new MemoryReader(artifacts), validator: VALIDATOR, invocations,
      outputBindings: bindingsStore, resultArtifacts: resultsStore,
    })
    const controller = new AbortController()
    const input = { ...executionInput(), taskBindingRef: { id: 'task.example.cancelled', version: '1.0.0', digest: DIGEST }, signal: controller.signal }
    const ctx = ctxFor(scope)
    const pending = local.execute(input, ctx)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'COMPUTE_FUNCTION_FAILED', platformCode: 'DEADLINE_EXCEEDED' })
    await arrived
    controller.abort()
    await rejected
    release?.()
    await blocked
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    const record = await invocations.get(scopeRefOf(scope), computeLogicalKeyDigest(scopeRefOf(scope), input), ctx)
    expect(record?.state).toBe('cancelled')
    expect(record?.resultRef).toBeUndefined()
    expect(record?.attempts[0]?.code).toBe('DEADLINE_EXCEEDED')
  })
})
