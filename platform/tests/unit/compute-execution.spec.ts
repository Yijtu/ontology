import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type {
  ActionCapabilityBinding,
  ActionDeclaration,
  ActionTrialInput,
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  ComputeInvocationAttempt,
  ComputeInvocationClaimResult,
  ComputeInvocationRecord,
  ComputeInvocationStore,
  ComputeOperationHandler,
  ComputeOperationRequest,
  ComputeOutputBindings,
  ComputeOutputBindingsStore,
  ComputeResultArtifact,
  ComputeResultArtifactStore,
  ImmutableArtifactWriter,
  OperationRegistry,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  ScopedArtifactReader,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'
import {
  ComputeExecutionError,
  RegisteredComputeExecutionService,
  computeLogicalKeyDigest,
  createExampleComputeHandlers,
  exampleOperationRegistry,
  exampleRegisteredOperation,
  registeredOperationDigest,
  SyntheticActionTrial,
} from '@ontology/tool-services'
import type { RegisteredComputeExecutionDependencies, ToolSchemaValidator } from '@ontology/tool-services'
import { sha256DigestOf } from '@ontology/core'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-09-30T00:00:00Z'
const DIGEST = `sha256:${'a'.repeat(64)}`

function digestOfBytes(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function ctxFor(tenantId = TENANT, spaceId = SPACE): ToolContext {
  const runId = randomUUID()
  return createToolContext({
    principal: { tenantId, subjectId: 'compute-executor', roles: ['platform-admin', 'operator'], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId,
      grantedAt: NOW,
      expiresAt: '2026-12-31T00:00:00Z',
    },
    allowedResources: {
      tenantId,
      spaceId,
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

  async read(request: { readonly approvedInputRefs: ResourceRef[] }): Promise<Uint8Array> {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('no input ref')
    const bytes = this.#artifacts.blobs.get(ref.digest)
    if (bytes === undefined) throw new Error(`no blob for ${ref.digest}`)
    return bytes
  }
}

interface ClaimSlot {
  record: ComputeInvocationRecord
  ownerId: string | undefined
  leaseExpiresAt: string | undefined
}

class MemoryInvocationStore implements ComputeInvocationStore {
  readonly slots = new Map<string, ClaimSlot>()

  #key(scope: ScopeRef, digest: string): string {
    return `${scope.tenantId}|${scope.spaceId}|${digest}`
  }

  async createIfAbsent(scope: ScopeRef, record: ComputeInvocationRecord): Promise<ComputeInvocationClaimResult> {
    const key = this.#key(scope, record.logicalKeyDigest)
    const existing = this.slots.get(key)
    if (existing !== undefined) return { record: existing.record, created: false }
    this.slots.set(key, { record, ownerId: undefined, leaseExpiresAt: undefined })
    return { record, created: true }
  }

  async get(scope: ScopeRef, digest: string): Promise<ComputeInvocationRecord | undefined> {
    return this.slots.get(this.#key(scope, digest))?.record
  }

  async claim(
    scope: ScopeRef,
    digest: string,
    ownerId: string,
    leaseExpiresAt: Rfc3339UtcTimestamp,
  ): Promise<ComputeInvocationRecord | undefined> {
    const key = this.#key(scope, digest)
    const slot = this.slots.get(key)
    if (slot === undefined) return undefined
    const live =
      slot.record.state === 'executing' &&
      slot.ownerId !== undefined &&
      slot.ownerId !== ownerId &&
      Date.parse(slot.leaseExpiresAt ?? '1970-01-01T00:00:00Z') > Date.now()
    if (live) return undefined
    if (slot.record.state === 'completed') return slot.record
    const attempt =
      slot.record.state === 'failed' || slot.record.state === 'cancelled'
        ? slot.record.attempt + 1
        : slot.record.attempt
    slot.record = { ...slot.record, state: 'executing', attempt, updatedAt: NOW }
    slot.ownerId = ownerId
    slot.leaseExpiresAt = leaseExpiresAt
    return slot.record
  }

  async complete(
    scope: ScopeRef,
    digest: string,
    result: { readonly resultRef: ResourceRef; readonly resultDigest: Sha256Digest },
  ): Promise<ComputeInvocationRecord> {
    const slot = this.slots.get(this.#key(scope, digest))
    if (slot === undefined) throw new Error('no invocation')
    slot.record = {
      ...slot.record,
      state: 'completed',
      resultRef: result.resultRef,
      resultDigest: result.resultDigest,
      updatedAt: NOW,
    }
    slot.ownerId = undefined
    slot.leaseExpiresAt = undefined
    return slot.record
  }

  async fail(scope: ScopeRef, digest: string, attempt: ComputeInvocationAttempt): Promise<ComputeInvocationRecord> {
    const slot = this.slots.get(this.#key(scope, digest))
    if (slot === undefined) throw new Error('no invocation')
    slot.record = { ...slot.record, state: attempt.state, attempts: [...slot.record.attempts, attempt], updatedAt: NOW }
    slot.ownerId = undefined
    slot.leaseExpiresAt = undefined
    return slot.record
  }
}

class MemoryBindingsStore implements ComputeOutputBindingsStore {
  readonly entries = new Map<string, ComputeOutputBindings>()

  async putBindings(_scope: ScopeRef, ref: ResourceRef, bindings: ComputeOutputBindings): Promise<void> {
    this.entries.set(ref.id, bindings)
  }

  async getBindings(_scope: ScopeRef, ref: ResourceRef) {
    const bindings = this.entries.get(ref.id)
    return bindings === undefined ? undefined : { ref, bindings }
  }
}

class MemoryResultStore implements ComputeResultArtifactStore {
  readonly entries = new Map<string, ComputeResultArtifact>()

  async putArtifact(_scope: ScopeRef, ref: ResourceRef, artifact: ComputeResultArtifact): Promise<void> {
    this.entries.set(ref.id, artifact)
  }

  async getArtifact(_scope: ScopeRef, ref: ResourceRef) {
    const artifact = this.entries.get(ref.id)
    return artifact === undefined ? undefined : { ref, artifact }
  }
}

const VALIDATOR: ToolSchemaValidator = {
  validateRef: () => ({ valid: true, issues: [] }),
  validateInline: (_schema: Readonly<Record<string, unknown>>, value: unknown) =>
    typeof value === 'object' && value !== null
      ? { valid: true, issues: [] }
      : { valid: false, issues: [{ pointer: '', reason: 'must be an object' }] },
}

function inputBody(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      rows: [
        { id: 'r1', amount: '10.5', unit: 'each', currency: 'CNY' },
        { id: 'r2', amount: '4', unit: 'each', currency: 'CNY' },
      ],
    }),
  )
}

interface Harness {
  readonly service: RegisteredComputeExecutionService
  readonly invocations: MemoryInvocationStore
  readonly bindings: MemoryBindingsStore
  readonly results: MemoryResultStore
  readonly artifacts: MemoryArtifacts
  readonly inputRef: ResourceRef
  readonly executions: { count: number; requests: ComputeOperationRequest[] }
}

function buildHarness(options?: {
  readonly handlers?: readonly ComputeOperationHandler[]
  readonly registry?: OperationRegistry
}): Harness {
  const artifacts = new MemoryArtifacts()
  const invocations = new MemoryInvocationStore()
  const bindings = new MemoryBindingsStore()
  const results = new MemoryResultStore()
  const executions = { count: 0, requests: [] as ComputeOperationRequest[] }
  const baseHandlers = options?.handlers ?? createExampleComputeHandlers()
  const handlers: ComputeOperationHandler[] = baseHandlers.map((handler) => ({
    operationRef: handler.operationRef,
    async execute(request: ComputeOperationRequest) {
      executions.count += 1
      executions.requests.push(request)
      return handler.execute(request)
    },
  }))
  const deps: RegisteredComputeExecutionDependencies = {
    operations: options?.registry ?? exampleOperationRegistry(),
    handlers,
    artifacts,
    reader: new MemoryReader(artifacts),
    validator: VALIDATOR,
    invocations,
    outputBindings: bindings,
    resultArtifacts: results,
    newId: () => randomUUID(),
    now: () => NOW,
  }
  // Seed the fixed input snapshot bytes under its content digest.
  const bytes = inputBody()
  const digest = digestOfBytes(bytes)
  artifacts.blobs.set(digest, bytes)
  return {
    service: new RegisteredComputeExecutionService(deps),
    invocations,
    bindings,
    results,
    artifacts,
    inputRef: { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' },
    executions,
  }
}

function executionInput(harness: Harness, overrides: Partial<Parameters<RegisteredComputeExecutionService['execute']>[0]> = {}) {
  const operation = exampleRegisteredOperation()
  const parameters = {}
  return {
    taskBindingRef: { id: 'task.example.aggregate', version: '1.0.0', digest: sha256DigestOf('task.example.aggregate@1.0.0') },
    operationRef: operation.operationRef,
    registeredOperationDigest: registeredOperationDigest(operation),
    inputSnapshotRef: harness.inputRef,
    inputSnapshotDigest: harness.inputRef.digest,
    parametersRef: { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf('{}'), kind: 'artifact' as const },
    parametersDigest: sha256DigestOf(canonicalOf(parameters)),
    parameters,
    inputRefs: [harness.inputRef],
    requiredInputRefs: [harness.inputRef],
    deadline: '2026-12-31T00:00:00Z',
    signal: new AbortController().signal,
    ...overrides,
  }
}

/**
 * `registeredOperationDigest` hashes the canonical JSON of the operation record. The harness
 * imports the canonical helper indirectly, so keep the expectation stable by using the same
 * sorted-key serialisation.
 */
function canonicalOf(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalOf).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalOf(entry)}`).join(',')}}`
}

describe('registered compute execution', () => {
  it('executes the example action through the registration chain and archives the result', async () => {
    const harness = buildHarness()
    const ctx = ctxFor()
    const result = await harness.service.execute(executionInput(harness), ctx)

    expect(result.reused).toBe(false)
    expect(result.invocation.state).toBe('completed')
    expect(result.artifact.schemaVersion).toBe('compute-result-artifact@1')
    expect(result.bindings.schemaVersion).toBe('typed-output-bindings@1')
    expect(result.artifact.invocationId).toBe(result.invocation.invocationId)

    const fieldByName = new Map(result.bindings.fields.map((field) => [field.rowKey, field]))
    expect(fieldByName.get('total_quantity')?.unit).toBe('each')
    expect(fieldByName.get('total_quantity')?.currency).toBeUndefined()
    expect(fieldByName.get('total_cost')?.currency).toBe('CNY')
    expect(fieldByName.get('total_cost')?.unit).toBeUndefined()
    expect(fieldByName.get('record_count')?.status).toBe('known')

    // The handler received only the fixed input refs and bounded execution context.
    const captured = harness.executions.requests[0]
    expect(captured?.inputRefs).toEqual([harness.inputRef])
    expect(captured?.limits.maxRows).toBeGreaterThan(0)
    expect(captured?.ctx).toBe(ctx)
    expect(captured?.signal).toBeInstanceOf(AbortSignal)
    expect(Object.keys(captured ?? {})).not.toContain('path')
    expect(Object.keys(captured ?? {})).not.toContain('url')
    expect(Object.keys(captured ?? {})).not.toContain('code')
  })

  it('is idempotent: a retry of the same logical action does not run the handler twice', async () => {
    const harness = buildHarness()
    const ctx = ctxFor()
    const first = await harness.service.execute(executionInput(harness), ctx)
    const second = await harness.service.execute(executionInput(harness), ctx)

    expect(harness.executions.count).toBe(1)
    expect(second.reused).toBe(true)
    expect(second.invocation.invocationId).toBe(first.invocation.invocationId)
    expect(second.artifact.outputDigest).toBe(first.artifact.outputDigest)
  })

  it('blocks a missing required input before running the handler', async () => {
    const harness = buildHarness()
    const ctx = ctxFor()
    await expect(
      harness.service.execute(executionInput(harness, { inputRefs: [], requiredInputRefs: [harness.inputRef] }), ctx),
    ).rejects.toMatchObject({ code: 'COMPUTE_INPUT_MISSING', retryable: false })
    expect(harness.executions.count).toBe(0)
  })

  it('blocks an unbound function and a contract-incompatible binding', async () => {
    const harness = buildHarness()
    const ctx = ctxFor()
    await expect(
      harness.service.execute(
        executionInput(harness, { operationRef: { id: 'example.compute.unknown', version: '1.0.0' } }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'COMPUTE_FUNCTION_UNBOUND' })

    await expect(
      harness.service.execute(
        executionInput(harness, { registeredOperationDigest: `sha256:${'b'.repeat(64)}` }),
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(harness.executions.count).toBe(0)
  })

  it('records a failure attempt and allows a bounded retry of the same logical action', async () => {
    let failFirst = true
    const [example] = createExampleComputeHandlers()
    if (example === undefined) throw new Error('the example handler is missing')
    const flaky: ComputeOperationHandler = {
      operationRef: exampleRegisteredOperation().operationRef,
      async execute(request: ComputeOperationRequest) {
        if (failFirst) {
          failFirst = false
          throw new Error('transient handler failure')
        }
        return example.execute(request)
      },
    }
    const harness = buildHarness({ handlers: [flaky] })
    const ctx = ctxFor()

    await expect(harness.service.execute(executionInput(harness), ctx)).rejects.toMatchObject({
      code: 'COMPUTE_FUNCTION_FAILED',
      retryable: true,
    })
    const recorded = [...harness.invocations.slots.values()][0]?.record
    expect(recorded?.state).toBe('failed')
    expect(recorded?.attempts).toHaveLength(1)

    const retried = await harness.service.execute(executionInput(harness), ctx)
    expect(retried.invocation.state).toBe('completed')
    expect(retried.invocation.attempt).toBe(2)
  })

  it('blocks a concurrent duplicate that holds the execution lease', async () => {
    const harness = buildHarness()
    const ctx = ctxFor()
    const scopeRef: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
    const input = executionInput(harness)
    const logicalKey = computeLogicalKeyDigest(scopeRef, input)
    await harness.invocations.createIfAbsent(scopeRef, {
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
      state: 'executing',
      attempt: 1,
      attempts: [],
      createdAt: NOW,
      updatedAt: NOW,
    })
    // Another worker already holds a live lease on this exact logical action.
    const slot = harness.invocations.slots.get(`${TENANT}|${SPACE}|${logicalKey}`)
    if (slot === undefined) throw new Error('seed missing')
    slot.ownerId = randomUUID()
    slot.leaseExpiresAt = '2099-01-01T00:00:00Z'

    await expect(harness.service.execute(input, ctx)).rejects.toMatchObject({
      code: 'COMPUTE_EXECUTION_IN_PROGRESS',
      retryable: true,
    })
    expect(harness.executions.count).toBe(0)
  })
})

function syntheticTrialInput(executable: boolean): ActionTrialInput {
  const operation = exampleRegisteredOperation()
  const declaration: ActionDeclaration = {
    actionId: 'action.example.aggregate',
    displayName: 'Aggregate example records',
    businessMeaning: 'Sum a quantity and a money total',
    suggestedReason: 'synthetic trial',
    inputSchemaRef: { id: 'example.input', version: '1.0.0', digest: DIGEST },
    outputSchemaRef: { id: 'example.output', version: '1.0.0', digest: DIGEST },
    preconditions: [],
    requiredCapabilities: [],
    permissions: [],
    readOnly: true,
    sideEffect: 'read_only',
    evidenceRequirements: [],
  }
  const binding: ActionCapabilityBinding = {
    actionId: declaration.actionId,
    status: executable ? 'executable' : 'not_executable',
    executable,
    findings: [],
    registryRef: { id: 'example', version: '1.0.0', digest: DIGEST },
    recordedAt: NOW,
    ...(executable
      ? {
          operationRef: operation.operationRef,
          handlerRef: operation.handlerRef,
          handlerDigest: operation.handlerDigest,
          registeredInputSchemaDigest: operation.inputSchemaDigest,
          registeredOutputSchemaDigest: operation.outputSchemaDigest,
        }
      : {}),
  }
  return {
    declaration,
    binding,
    caseId: 'case-1',
    caseKind: 'missing_parameter',
    fields: [{ fieldId: 'amount', value: '10.5', unitCode: 'each' }],
  }
}

describe('synthetic action trial connected to a registered compute action', () => {
  it('runs an executable synthetic action through the registered compute chain', async () => {
    const harness = buildHarness()
    const trial = new SyntheticActionTrial({
      execution: harness.service,
      operations: exampleOperationRegistry(),
      artifacts: harness.artifacts,
      now: () => NOW,
    })
    const receipt = await trial.trial(syntheticTrialInput(true), ctxFor())
    expect(receipt.status).toBe('passed')
    expect(receipt.outputDigest).toBeDefined()
  })

  it('reports a blocked receipt for a non-executable action', async () => {
    const harness = buildHarness()
    const trial = new SyntheticActionTrial({
      execution: harness.service,
      operations: exampleOperationRegistry(),
      artifacts: harness.artifacts,
      now: () => NOW,
    })
    const receipt = await trial.trial(syntheticTrialInput(false), ctxFor())
    expect(receipt.status).toBe('blocked')
    expect(harness.executions.count).toBe(0)
  })
})

describe('compute execution error surface', () => {
  it('classifies each block with a retryable flag', () => {
    expect(new ComputeExecutionError('COMPUTE_INPUT_MISSING', 'x').retryable).toBe(false)
    expect(new ComputeExecutionError('COMPUTE_FUNCTION_FAILED', 'x').retryable).toBe(true)
    expect(new ComputeExecutionError('COMPUTE_EXECUTION_IN_PROGRESS', 'x').retryable).toBe(true)
    expect(new ComputeExecutionError('COMPUTE_FUNCTION_UNBOUND', 'x').platformCode).toBe('CAPABILITY_NOT_CONFIGURED')
  })
})
