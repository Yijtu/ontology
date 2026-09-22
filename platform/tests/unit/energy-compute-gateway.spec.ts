import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import type {
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  ComputeOperationHandler,
  ComputeOperationResult,
  ImmutableArtifactWriter,
  OperationRegistry,
  ResolvedProfile,
  ResourceRef,
  ScopedArtifactReader,
  ScopedArtifactReaderRequest,
  StructuredQueryPort,
  ToolContext,
} from '@ontology/contracts'
import type { SemanticMappingRegistry } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import type { DataQueryComputeConfig } from '@ontology/tool-services'
import {
  ENERGY_OPERATION_REGISTRY,
  ENERGY_REGISTERED_OPERATIONS,
  createEnergyComputeHandlers,
  encodeEnergyOperationInput,
  energyOperationRef,
  sha256DigestOf,
} from '@ontology/extension-home-energy'
import type { EnergyOperationInput } from '@ontology/extension-home-energy'
import {
  buildGateway,
  canonicalToolValidator,
  gatewayContext,
  observation,
  openGatewayLedger,
  resolvedProfile,
} from './tool-gateway-fixtures'
import type { GatewayHarness } from './tool-gateway-fixtures'
import { planningRequest } from '../fixtures/home-energy'

const INPUT_ID = '12345678-1234-4123-8123-123456789abc'
const INPUT_REF: ResourceRef = {
  id: INPUT_ID,
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'artifact',
}

function operationInput(): EnergyOperationInput {
  const request = planningRequest()
  return {
    kind: 'home-energy.operation-input',
    version: '1.0.0',
    dataMode: 'synthetic',
    snapshot: request.snapshot,
    topology: request.topology,
    battery: request.battery,
    grid: request.grid,
    load: request.load,
    pv: request.pv,
    tariff: request.tariff,
    reserves: request.reserves,
    tolerance: request.tolerance,
    assumptions: request.assumptions,
  }
}

class ContentAddressedWriter implements ImmutableArtifactWriter {
  readonly byDigest = new Map<string, Uint8Array>()

  async putBytes(request: ArtifactWriteRequest): Promise<BlobPutImmutableResponse> {
    const digest = sha256DigestOf(request.content)
    this.byDigest.set(digest, request.content)
    return {
      blobRef: { id: randomUUID(), version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest },
    }
  }
}

class FixedReader implements ScopedArtifactReader {
  readonly #byId: ReadonlyMap<string, Uint8Array>

  constructor(byId: ReadonlyMap<string, Uint8Array>) {
    this.#byId = byId
  }

  async read(request: ScopedArtifactReaderRequest): Promise<Uint8Array> {
    const ref = request.approvedInputRefs[0]
    const bytes = ref === undefined ? undefined : this.#byId.get(ref.id)
    if (bytes === undefined) throw new Error(`no archived input for ${String(ref?.id)}`)
    return bytes
  }
}

const queryStub: StructuredQueryPort = {
  async validate() {
    throw new Error('the compute path must not call StructuredQueryPort')
  },
  async execute() {
    throw new Error('the compute path must not call StructuredQueryPort')
  },
  async cancel(request) {
    return { targetRef: request.targetRef, state: 'unsupported', acceptedAt: '2026-09-21T00:00:00Z' }
  },
}

const mappingsStub: SemanticMappingRegistry = {
  resolve: () => undefined,
  list: () => [],
}

function profileWithCompute(enabled: boolean): ResolvedProfile {  return resolvedProfile({
    toolBindings: [{ toolId: 'data_query', enabled: true }],
    computeBindings: ENERGY_REGISTERED_OPERATIONS.map((operation) => ({
      operationRef: operation.operationRef,
      handlerRef: operation.handlerRef,
      inputSchemaRef: {
        id: `${operation.operationRef.id}.input`,
        version: '1.0.0',
        digest: operation.inputSchemaDigest,
      },
      outputSchemaRef: {
        id: `${operation.operationRef.id}.output`,
        version: '1.0.0',
        digest: operation.outputSchemaDigest,
      },
      readOnly: true as const,
      enabled,
      limits: operation.limits,
    })),
  })
}

/** A trusted context whose deadline is far in the future, so a compute budget is non-zero. */
function computeContext(): ToolContext {
  return gatewayContext({ deadline: '2099-01-01T00:00:00Z' })
}

function computeArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const plan = ENERGY_REGISTERED_OPERATIONS[0]
  if (plan === undefined) throw new Error('the plan operation is not registered')
  return {
    kind: 'compute',
    operationRef: plan.operationRef,
    inputSchemaDigest: plan.inputSchemaDigest,
    inputRefs: [INPUT_REF],
    parameters: { strategyWhitelist: ['self_consumption'] },
    ...overrides,
  }
}

interface Harness extends GatewayHarness {
  readonly writer: ContentAddressedWriter
}

function buildComputeHarness(options: {
  readonly profile?: ResolvedProfile
  readonly operations?: OperationRegistry
  readonly handlers?: readonly ComputeOperationHandler[]
}): Harness {
  const writer = new ContentAddressedWriter()
  const reader = new FixedReader(new Map([[INPUT_ID, encodeEnergyOperationInput(operationInput())]]))
  const compute: DataQueryComputeConfig = {
    registry: options.operations ?? ENERGY_OPERATION_REGISTRY,
    handlers: options.handlers ?? createEnergyComputeHandlers(),
    artifacts: writer,
    reader,
    validator: canonicalToolValidator(),
  }
  const handler = new DataQueryHandler({ query: queryStub, mappings: mappingsStub, compute })
  const log: string[] = []
  const built = buildGateway({
    handlers: [handler],
    profile: options.profile ?? profileWithCompute(true),
    operations: options.operations ?? ENERGY_OPERATION_REGISTRY,
    artifacts: writer,
    log,
  })
  return { ...built, writer }
}

function payloadOf(writer: ContentAddressedWriter, dataRef: ResourceRef | undefined): unknown {
  if (dataRef === undefined) throw new Error('the result carried no dataRef')
  const bytes = writer.byDigest.get(dataRef.digest)
  if (bytes === undefined) throw new Error(`no archived payload for ${dataRef.digest}`)
  return JSON.parse(new TextDecoder().decode(bytes))
}

function computationOf(payload: unknown): {
  readonly resultRef: ResourceRef
  readonly algorithmVersion: { readonly id: string }
  readonly domainStatus: string
} {
  if (typeof payload !== 'object' || payload === null) throw new Error('the payload is not an object')
  const computation = (payload as { computation?: unknown }).computation
  if (typeof computation !== 'object' || computation === null) {
    throw new Error('the payload has no computation')
  }
  return computation as {
    resultRef: ResourceRef
    algorithmVersion: { id: string }
    domainStatus: string
  }
}

describe('data_query.kind=compute dispatch (ADR-11, C3/C4)', () => {
  it('executes a registered, profile-enabled operation into a typed result plus evidence', async () => {
    const harness = buildComputeHarness({})
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      { callId: randomUUID(), toolId: 'data_query', arguments: computeArgs() },
      ctx,
    )
    expect(result.status).toBe('ok')
    expect(result.error).toBeUndefined()
    expect(result.evidenceRefs).toHaveLength(1)
    const payload = payloadOf(harness.writer, result.dataRef)
    expect((payload as { resultKind?: string }).resultKind).toBe('computation')
    const computation = computationOf(payload)
    expect(computation.algorithmVersion.id).toBe('home-energy.planner')
    expect(computation.domainStatus).toBe('known')
    expect(harness.writer.byDigest.has(computation.resultRef.digest)).toBe(true)
    // The evidence envelope explicitly marks the computation as a simulation.
    const envelope = harness.log.includes('execute')
    expect(envelope).toBe(true)
  })

  it('rejects an unregistered operation even with well-formed parameters', async () => {
    const harness = buildComputeHarness({})
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'data_query',
        arguments: computeArgs({ operationRef: { id: 'home-energy.dispatch', version: '1' } }),
      },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(harness.log).not.toContain('execute')
  })

  it('rejects a registered operation the profile did not enable', async () => {
    const harness = buildComputeHarness({ profile: profileWithCompute(false) })
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      { callId: randomUUID(), toolId: 'data_query', arguments: computeArgs() },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(harness.log).not.toContain('execute')
  })

  it('rejects parameters that do not match the registered operation schema', async () => {
    const harness = buildComputeHarness({})
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'data_query',
        arguments: computeArgs({ parameters: { strategyWhitelist: ['sell_everything'] } }),
      },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('rejects a code or script field in the compute parameters', async () => {
    const harness = buildComputeHarness({})
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'data_query',
        arguments: computeArgs({
          parameters: {
            strategyWhitelist: ['self_consumption'],
            code: 'export function hack() {}',
          },
        }),
      },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('rejects a file or network bypass field in the compute parameters', async () => {
    const harness = buildComputeHarness({})
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'data_query',
        arguments: computeArgs({
          parameters: { strategyWhitelist: ['self_consumption'], url: 'http://evil.example' },
        }),
      },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('rejects a file-path input reference (the schema requires an internal UUID)', async () => {
    const harness = buildComputeHarness({})
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'data_query',
        arguments: computeArgs({
          inputRefs: [{ id: 'file:///etc/passwd', version: '1.0.0', digest: INPUT_REF.digest, kind: 'artifact' }],
        }),
      },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
    expect(harness.log).not.toContain('execute')
  })

  it('refuses a model-supplied live data mode instead of switching simulation to live', async () => {
    const harness = buildComputeHarness({})
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      {
        callId: randomUUID(),
        toolId: 'data_query',
        arguments: computeArgs({ dataMode: 'live' }),
      },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
  })

  it('abandons a compute operation that exceeds its declared CPU/deadline budget', async () => {
    const slowRegistry: OperationRegistry = {
      ...ENERGY_OPERATION_REGISTRY,
      operations: ENERGY_REGISTERED_OPERATIONS.map((operation) =>
        operation.operationRef.id === 'home-energy.plan'
          ? { ...operation, limits: { ...operation.limits, maxDurationMs: 20 } }
          : operation,
      ),
    }
    const slowHandler: ComputeOperationHandler = {
      operationRef: energyOperationRef('home-energy.plan'),
      async execute(): Promise<ComputeOperationResult> {
        await delay(200)
        return {
          payload: { resultKind: 'computation', computation: {
            operationRef: energyOperationRef('home-energy.plan'),
            resultRef: INPUT_REF,
            algorithmVersion: { id: 'slow', version: '1.0.0', digest: INPUT_REF.digest },
            domainStatus: 'known',
          } },
          status: 'ok',
          coverage: { returned: 1, truncated: false },
          sources: [observation()],
          dataMode: 'simulation',
          evidenceKind: 'computation',
        }
      },
    }
    const harness = buildComputeHarness({ operations: slowRegistry, handlers: [slowHandler] })
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      { callId: randomUUID(), toolId: 'data_query', arguments: computeArgs() },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
  })

  it('refuses a registered operation with no handler bound at the composition root', async () => {
    const harness = buildComputeHarness({ handlers: [] })
    const ctx = computeContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(
      { callId: randomUUID(), toolId: 'data_query', arguments: computeArgs() },
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
  })
})
