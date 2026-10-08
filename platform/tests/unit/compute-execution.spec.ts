import { exampleComputeArtifact } from '../helpers/example-compute-artifact'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { buildComputeArtifact } from '../../scripts/build-compute-artifact.mjs'
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
  computeBuildArtifactDigest,
  createScopedArtifactReader,
  createArtifactComputeHandlers,
  verifyComputeBuildArtifact,
  RegisteredComputeExecutionService,
  computeLogicalKeyDigest,
  createExampleComputeHandlers,
  exampleOperationRegistry,
  exampleRegisteredOperation,
  registeredOperationDigest,
  SyntheticActionTrial,
} from '@ontology/tool-services'
import type { ArtifactComputeHandlerOptions, ComputeBuildArtifactManifest, RegisteredComputeExecutionDependencies, ToolSchemaValidator } from '@ontology/tool-services'
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
    _ctx?: ToolContext,
    signal?: AbortSignal,
  ): Promise<ComputeInvocationRecord> {
    signal?.throwIfAborted()
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
  const baseHandlers = options?.handlers ?? createExampleComputeHandlers(exampleComputeArtifact)
  const handlers: ComputeOperationHandler[] = baseHandlers.map((handler) => ({
    ...handler,
    async execute(request: ComputeOperationRequest) {
      executions.count += 1
      executions.requests.push(request)
      return handler.execute(request)
    },
  }))
  const deps: RegisteredComputeExecutionDependencies = {
    operations: options?.registry ?? exampleOperationRegistry(exampleComputeArtifact),
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
  const operation = exampleRegisteredOperation(exampleComputeArtifact)
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
    const [example] = createExampleComputeHandlers(exampleComputeArtifact)
    if (example === undefined) throw new Error('the example handler is missing')
    const flaky: ComputeOperationHandler = {
      ...example,
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
  const operation = exampleRegisteredOperation(exampleComputeArtifact)
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
      operations: exampleOperationRegistry(exampleComputeArtifact),
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
      operations: exampleOperationRegistry(exampleComputeArtifact),
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

const fixtureRoots: string[] = []
afterAll(async () => {
  for (const root of fixtureRoots) await rm(root, { recursive: true, force: true })
})

async function buildArtifactFixture(change?: 'handler' | 'dependency') {
  const root = await mkdtemp(join(tmpdir(), 'ontology-compute-artifact-'))
  fixtureRoots.push(root)
  const directory = 'packages/tool-services/src/compute'
  await mkdir(join(root, directory), { recursive: true })
  for (const name of ['example-handler.ts', 'example-aggregation.ts', 'errors.ts']) {
    let source = await readFile(new URL(`../../packages/tool-services/src/compute/${name}`, import.meta.url), 'utf8')
    if (change === 'handler' && name === 'example-handler.ts') source = source.replace('returned: aggregation.returned', 'returned: aggregation.returned + 1')
    if (change === 'dependency' && name === 'example-aggregation.ts') source = source.replace('quantity += parsed', 'quantity += parsed * 2n')
    await writeFile(join(root, directory, name), source)
  }
  const built = await buildComputeArtifact({ root, entryPoint: `${directory}/example-handler.ts`, allowedSourceRoots: [directory] })
  const modulePath = join(root, 'handler.mjs')
  await writeFile(modulePath, built.content)
  // This import is confined to generated test fixtures. Production uses the finite static import.
  const module: { readonly createHandlers: ArtifactComputeHandlerOptions['factory'] } = await import(pathToFileURL(modulePath).href)
  const handlers = createArtifactComputeHandlers({ manifest: built.manifest, readArtifact: () => built.content, factory: module.createHandlers })
  const original = exampleRegisteredOperation(exampleComputeArtifact)
  const operation = { ...original, handlerDigest: built.manifest.handlerDigest, handlerRef: { ...original.handlerRef, digest: built.manifest.handlerDigest } }
  const registry: OperationRegistry = { ...exampleOperationRegistry(exampleComputeArtifact), registryVersion: '2.0.0', registryDigest: sha256DigestOf(canonicalOf([operation])), operations: [operation] }
  return { ...built, root, handlers, operation, registry }
}

describe('compute build artifact pinning', () => {
  it('reproduces the checked-in artifact in another directory and includes the controlled dependency closure', async () => {
    const fixture = await buildArtifactFixture()
    expect(fixture.manifest.handlerDigest).toBe(exampleRegisteredOperation(exampleComputeArtifact).handlerDigest)
    const platformRoot = fileURLToPath(new URL('../../', import.meta.url))
    const rebuilt = await buildComputeArtifact({
      root: platformRoot,
      entryPoint: 'packages/tool-services/src/compute/example-handler.ts',
      allowedSourceRoots: ['packages/tool-services/src/compute'],
    })
    expect(rebuilt.content).toEqual(fixture.content)
    for (const entry of fixture.manifest.dependencies) {
      const source = await readFile(join(fixture.root, entry.sourceId), 'utf8')
      await writeFile(join(fixture.root, entry.sourceId), source.replace(/\r?\n/gu, '\r\n'))
    }
    const crlfBuild = await buildComputeArtifact({
      root: fixture.root,
      entryPoint: 'packages/tool-services/src/compute/example-handler.ts',
      allowedSourceRoots: ['packages/tool-services/src/compute'],
    })
    expect(crlfBuild.content).toEqual(rebuilt.content)
    expect(crlfBuild.manifest).toEqual(rebuilt.manifest)
    expect(fixture.manifest.dependencies.map((entry) => entry.sourceId)).toContain('packages/tool-services/src/compute/example-aggregation.ts')
    expect(verifyComputeBuildArtifact(fixture.manifest, fixture.content)).toEqual(fixture.manifest)
  })

  it.each(['handler', 'dependency'] as const)('changes the actual %s without changing version labels and refuses the old binding', async (change) => {
    const fixture = await buildArtifactFixture(change)
    const original = exampleRegisteredOperation(exampleComputeArtifact)
    expect(fixture.operation.operationRef).toEqual(original.operationRef)
    expect(fixture.operation.handlerRef.version).toBe(original.handlerRef.version)
    expect(fixture.manifest.handlerDigest).not.toBe(original.handlerDigest)
    const harness = buildHarness({ handlers: fixture.handlers, registry: fixture.registry })
    await expect(harness.service.execute(executionInput(harness), ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(harness.executions.count).toBe(0)
    expect(harness.invocations.slots.size).toBe(0)

    const result = await harness.service.execute(executionInput(harness, { registeredOperationDigest: registeredOperationDigest(fixture.operation) }), ctxFor())
    expect(result.artifact.registeredOperationDigest).toBe(registeredOperationDigest(fixture.operation))
    expect(result.invocation.registeredOperationDigest).toBe(result.artifact.registeredOperationDigest)
    expect(result.artifact.algorithmVersion.digest).toBe(fixture.manifest.handlerDigest)
    expect(result.artifact.coverage.returned).toBe(change === 'handler' ? 3 : 2)
    if (change === 'dependency') expect(result.payload?.computation?.metrics?.['total_quantity']).toEqual({ amount: '29', unit: 'each' })
  })

  it('rejects new executable code under the old registry, missing artifacts, and inconsistent manifests', async () => {
    const fixture = await buildArtifactFixture('dependency')
    const harness = buildHarness({ handlers: fixture.handlers })
    await expect(harness.service.execute(executionInput(harness), ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(harness.executions.count).toBe(0)
    const factory: ArtifactComputeHandlerOptions['factory'] = () => { throw new Error('must not mint a handler') }
    expect(() => createArtifactComputeHandlers({ manifest: fixture.manifest, readArtifact: () => { throw new Error('missing file') }, factory })).toThrowError(/unavailable/u)
    expect(() => createArtifactComputeHandlers({ manifest: undefined, readArtifact: () => fixture.content, factory })).toThrowError(/manifest/u)
    expect(() => verifyComputeBuildArtifact(fixture.manifest, new Uint8Array([1]))).toThrowError(/pinned manifest/u)
    expect(() => verifyComputeBuildArtifact({ ...fixture.manifest, handlerDigest: DIGEST }, fixture.content)).toThrowError(/pinned manifest/u)
    const unpinned = buildHarness({ handlers: fixture.handlers.map((handler) => ({ operationRef: handler.operationRef, execute: handler.execute })) })
    await expect(unpinned.service.execute(executionInput(unpinned), ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(unpinned.executions.count).toBe(0)
  })

  it('preserves classified input errors across the compiled artifact boundary', async () => {
    const harness = buildHarness()
    harness.artifacts.blobs.set(harness.inputRef.digest, new TextEncoder().encode('{'))
    await expect(harness.service.execute(executionInput(harness), ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_INPUT_MISSING', retryable: false })
    expect([...harness.invocations.slots.values()][0]?.record.state).toBe('failed')
  })

  it('rechecks the artifact on invocation and on completed read-back', async () => {
    const fixture = await buildArtifactFixture()
    let bytes: Uint8Array = fixture.content
    const factory: ArtifactComputeHandlerOptions['factory'] = () => fixture.handlers
    const handlers = createArtifactComputeHandlers({ manifest: fixture.manifest, readArtifact: () => bytes, factory })
    const harness = buildHarness({ handlers })
    const input = executionInput(harness)
    await harness.service.execute(input, ctxFor())
    bytes = new Uint8Array([1])
    await expect(harness.service.execute(input, ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(harness.executions.count).toBe(1)
  })

  it('snapshots the manifest so caller mutation cannot replace an existing artifact pin', async () => {
    const fixture = await buildArtifactFixture()
    const changed = await buildArtifactFixture('dependency')
    const manifest = { ...fixture.manifest }
    let bytes: Uint8Array = fixture.content
    const handlers = createArtifactComputeHandlers({ manifest, readArtifact: () => bytes, factory: () => fixture.handlers })
    const harness = buildHarness({ handlers })
    Object.assign(manifest, changed.manifest)
    bytes = changed.content
    await expect(harness.service.execute(executionInput(harness), ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(harness.executions.count).toBe(0)
  })

  it('keeps pre-start cancellation terminal and keeps invocation scope separate', async () => {
    const harness = buildHarness()
    const controller = new AbortController()
    controller.abort()
    await expect(harness.service.execute(executionInput(harness, { signal: controller.signal }), ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_FUNCTION_FAILED', platformCode: 'DEADLINE_EXCEEDED' })
    expect(harness.executions.count).toBe(0)
    const recorded = [...harness.invocations.slots.values()][0]?.record
    expect(recorded?.state).toBe('cancelled')
    expect(harness.results.entries.size).toBe(0)
    await expect(harness.service.execute(executionInput(harness), ctxFor(TENANT, 'other-space'))).resolves.toMatchObject({ reused: false })
    expect(harness.invocations.slots.size).toBe(2)
  })

  it('refuses same-id inputs with a different version, digest or kind', async () => {
    const harness = buildHarness()
    const reader = createScopedArtifactReader(new MemoryReader(harness.artifacts), [harness.inputRef])
    for (const changed of [{ digest: DIGEST }, { version: '2' }, { kind: 'document' as const }]) {
      await expect(reader.read({ approvedInputRefs: [{ ...harness.inputRef, ...changed }] }, ctxFor())).rejects.toMatchObject({ code: 'RESOURCE_NOT_ALLOWED' })
    }
    await expect(reader.read({ approvedInputRefs: [harness.inputRef] }, ctxFor())).resolves.toEqual(inputBody())
  })

  it('does not complete a cancelled invocation when a non-cooperative artifact handler returns late', async () => {
    const harness = buildHarness()
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const original = harness.artifacts.putBytes.bind(harness.artifacts)
    let started: (() => void) | undefined
    const arrived = new Promise<void>((resolve) => { started = resolve })
    harness.artifacts.putBytes = async (request) => {
      started?.()
      await blocked
      return original(request)
    }
    const controller = new AbortController()
    const pending = harness.service.execute(executionInput(harness, { signal: controller.signal }), ctxFor())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'COMPUTE_FUNCTION_FAILED', platformCode: 'DEADLINE_EXCEEDED' })
    await arrived
    controller.abort()
    await rejected
    release?.()
    await blocked
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect([...harness.invocations.slots.values()][0]?.record.state).toBe('cancelled')
    expect(harness.results.entries.size).toBe(0)
    expect(harness.bindings.entries.size).toBe(0)
  })

  it.each(['bindings', 'artifact'] as const)('does not complete or return a result cancelled while %s persistence is pending', async (phase) => {
    const harness = buildHarness()
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let started: (() => void) | undefined
    const arrived = new Promise<void>((resolve) => { started = resolve })
    if (phase === 'bindings') {
      const original = harness.bindings.putBindings.bind(harness.bindings)
      harness.bindings.putBindings = async (scope, ref, bindings) => {
        started?.()
        await blocked
        return original(scope, ref, bindings)
      }
    } else {
      const original = harness.results.putArtifact.bind(harness.results)
      harness.results.putArtifact = async (scope, ref, artifact) => {
        started?.()
        await blocked
        return original(scope, ref, artifact)
      }
    }
    const controller = new AbortController()
    const pending = harness.service.execute(executionInput(harness, { signal: controller.signal }), ctxFor())
    const rejected = expect(pending).rejects.toMatchObject({ code: 'COMPUTE_FUNCTION_FAILED', platformCode: 'DEADLINE_EXCEEDED' })
    await arrived
    controller.abort()
    release?.()
    await rejected
    const recorded = [...harness.invocations.slots.values()][0]?.record
    expect(recorded?.state).toBe('cancelled')
    expect(recorded?.resultRef).toBeUndefined()
    expect(harness.results.entries.size).toBe(phase === 'bindings' ? 0 : 1)
  })

  it('refuses a cancelled replay while preserving the prior completed invocation', async () => {
    const harness = buildHarness()
    const input = executionInput(harness)
    const first = await harness.service.execute(input, ctxFor())
    const controller = new AbortController()
    controller.abort()
    await expect(harness.service.execute({ ...input, signal: controller.signal }, ctxFor())).rejects.toMatchObject({
      code: 'COMPUTE_FUNCTION_FAILED', platformCode: 'DEADLINE_EXCEEDED', retryable: false,
    })
    expect(harness.executions.count).toBe(1)
    expect([...harness.invocations.slots.values()][0]?.record.state).toBe('completed')
    expect(first.invocation.resultRef).toBeDefined()
  })

  it.each(['prepare', 'claim'] as const)('keeps cancellation through delayed invocation %s without starting the handler', async (phase) => {
    const harness = buildHarness()
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let started: (() => void) | undefined
    const arrived = new Promise<void>((resolve) => { started = resolve })
    if (phase === 'prepare') {
      const original = harness.invocations.createIfAbsent.bind(harness.invocations)
      harness.invocations.createIfAbsent = async (scope, record) => {
        started?.()
        await blocked
        return original(scope, record)
      }
    } else {
      const original = harness.invocations.claim.bind(harness.invocations)
      harness.invocations.claim = async (scope, digest, owner, expires) => {
        started?.()
        await blocked
        return original(scope, digest, owner, expires)
      }
    }
    const controller = new AbortController()
    const pending = harness.service.execute(executionInput(harness, { signal: controller.signal }), ctxFor())
    const rejected = expect(pending).rejects.toMatchObject({ platformCode: 'DEADLINE_EXCEEDED' })
    await arrived
    controller.abort()
    release?.()
    await rejected
    expect(harness.executions.count).toBe(0)
    expect([...harness.invocations.slots.values()][0]?.record.state).toBe('cancelled')
  })

  it.each(['artifact', 'bindings'] as const)('refuses cancellation during delayed %s replay reads', async (phase) => {
    const harness = buildHarness()
    const input = executionInput(harness)
    await harness.service.execute(input, ctxFor())
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let started: (() => void) | undefined
    const arrived = new Promise<void>((resolve) => { started = resolve })
    if (phase === 'artifact') {
      const original = harness.results.getArtifact.bind(harness.results)
      harness.results.getArtifact = async (scope, ref) => {
        started?.()
        await blocked
        return original(scope, ref)
      }
    } else {
      const original = harness.bindings.getBindings.bind(harness.bindings)
      harness.bindings.getBindings = async (scope, ref) => {
        started?.()
        await blocked
        return original(scope, ref)
      }
    }
    const controller = new AbortController()
    const pending = harness.service.execute({ ...input, signal: controller.signal }, ctxFor())
    const rejected = expect(pending).rejects.toMatchObject({ platformCode: 'DEADLINE_EXCEEDED' })
    await arrived
    controller.abort()
    release?.()
    await rejected
    expect(harness.executions.count).toBe(1)
    expect([...harness.invocations.slots.values()][0]?.record.state).toBe('completed')
  })

  it('rejects corrupt archived handler/operation pins before replay', async () => {
    const harness = buildHarness()
    const input = executionInput(harness)
    const result = await harness.service.execute(input, ctxFor())
    if (result.invocation.resultRef === undefined) throw new Error('missing result ref')
    harness.results.entries.set(result.invocation.resultRef.id, { ...result.artifact, registeredOperationDigest: DIGEST })
    await expect(harness.service.execute(input, ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(harness.executions.count).toBe(1)
  })

  it('fails the build on uncontrolled runtime imports', async () => {
    const fixture = await buildArtifactFixture()
    const entryPoint = 'packages/tool-services/src/compute/example-handler.ts'
    await writeFile(join(fixture.root, entryPoint), "import { readFileSync } from 'node:fs'; export const bad = readFileSync('secret')")
    await expect(buildComputeArtifact({ root: fixture.root, entryPoint, allowedSourceRoots: ['packages/tool-services/src/compute'] })).rejects.toThrowError(/outside the controlled source closure/u)
  })

  it('rejects mismatched handlerRef and handlerDigest even when both have valid digest syntax', async () => {
    const operation = { ...exampleRegisteredOperation(exampleComputeArtifact), handlerRef: { ...exampleRegisteredOperation(exampleComputeArtifact).handlerRef, digest: DIGEST } }
    const harness = buildHarness({ registry: { ...exampleOperationRegistry(exampleComputeArtifact), operations: [operation] } })
    await expect(harness.service.execute(executionInput(harness, { registeredOperationDigest: registeredOperationDigest(operation) }), ctxFor())).rejects.toMatchObject({ code: 'COMPUTE_CONTRACT_MISMATCH' })
    expect(harness.executions.count).toBe(0)
  })

  it('rejects duplicate or unsafe dependency paths in a recomputed manifest', async () => {
    const fixture = await buildArtifactFixture()
    const { handlerDigest, ...body } = fixture.manifest
    expect(computeBuildArtifactDigest(body)).toBe(handlerDigest)
    const altered = { ...body, dependencies: [{ sourceId: '../secret', digest: DIGEST }] }
    const manifest: ComputeBuildArtifactManifest = { ...altered, handlerDigest: computeBuildArtifactDigest(altered) }
    expect(() => verifyComputeBuildArtifact(manifest, fixture.content)).toThrowError(/manifest/u)
  })
})
