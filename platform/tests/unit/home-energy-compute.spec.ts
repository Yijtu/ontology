import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type {
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  ComputeOperationRequest,
  ImmutableArtifactWriter,
  ResourceRef,
  ScopedArtifactReader,
  ScopedArtifactReaderRequest,
  ToolContext,
} from '@ontology/contracts'
import {
  ENERGY_OPERATION_REGISTRY,
  ENERGY_REGISTERED_OPERATIONS,
  SimulationExecutionService,
  createEnergyComputeHandlers,
  decodeEnergyOperationInput,
  decodeSimulationJobRequest,
  encodeEnergyOperationInput,
  energyOperationRef,
  encodeSimulationJobRequest,
  sha256DigestOf,
} from '@ontology/extension-home-energy'
import type {
  DeviceActionPort,
  EnergyOperationInput,
  SimulationJobPort,
} from '@ontology/extension-home-energy'
import { assertNoComputeBypass, createScopedArtifactReader } from '@ontology/tool-services'
import { planningRequest, planFor } from '../fixtures/home-energy'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '99999999-9999-4999-8999-999999999999'

function ctx(roles: readonly string[] = ['business-user']): ToolContext {
  return createToolContext({
    principal: { tenantId: TENANT, subjectId: 'node-46-unit', roles: [...roles], scopes: [], authEpoch: 1 },
    runId: RUN,
    resolvedProfileHash: `sha256:${'c'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      runId: RUN,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: TENANT,
      spaceId: SPACE,
      resourceKinds: ['artifact'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: 'trace-node-46-unit',
  })
}

function operationInput(): EnergyOperationInput {
  const request = planningRequest()
  const plan = planFor(request.snapshot.manifest.slotCount)
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
    plan,
  }
}

const ARTIFACT_REF: ResourceRef = {
  id: '12345678-1234-4123-8123-123456789abc',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'artifact',
}

describe('home-energy compute operation manifest (ADR-11)', () => {
  it('registers the three declared operations as read-only simulation operations', () => {
    expect(ENERGY_REGISTERED_OPERATIONS.map((operation) => operation.operationRef.id)).toEqual([
      'home-energy.plan',
      'home-energy.simulate',
      'home-energy.metrics',
    ])
    for (const operation of ENERGY_REGISTERED_OPERATIONS) {
      expect(operation.operationRef.version).toBe('1')
      expect(operation.readOnly).toBe(true)
      expect(operation.dataMode).toBe('simulation')
      expect(operation.inputSchema.additionalProperties).toBe(false)
      expect(operation.inputSchemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
    expect(ENERGY_OPERATION_REGISTRY.namespace).toBe('home-energy')
    expect(ENERGY_OPERATION_REGISTRY.operations).toHaveLength(3)
  })

  it('round-trips a bounded operation input bundle through canonical JSON', () => {
    const input = operationInput()
    const decoded = decodeEnergyOperationInput(encodeEnergyOperationInput(input))
    expect(decoded.kind).toBe('home-energy.operation-input')
    expect(decoded.snapshot.digest).toBe(input.snapshot.digest)
    expect(decoded.battery.deviceRef).toBe(input.battery.deviceRef)
  })

  it('rejects a file or network bypass field or value', () => {
    expect(() => assertNoComputeBypass({ url: 'http://evil.example' }, [ARTIFACT_REF])).toThrow()
    expect(() => assertNoComputeBypass({ nested: { path: '/etc/passwd' } }, [ARTIFACT_REF])).toThrow()
    expect(() => assertNoComputeBypass({ command: 'curl x' }, [ARTIFACT_REF])).toThrow()
    expect(() =>
      assertNoComputeBypass(
        { strategyWhitelist: ['self_consumption'] },
        [{ ...ARTIFACT_REF, id: 'file:///etc/passwd' }],
      ),
    ).toThrow()
    expect(() =>
      assertNoComputeBypass({ strategyWhitelist: ['self_consumption'] }, [ARTIFACT_REF]),
    ).not.toThrow()
  })

  it('binds the scoped reader to exactly the approved input refs', async () => {
    const read = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const inner: ScopedArtifactReader = { read }
    const scoped = createScopedArtifactReader(inner, [ARTIFACT_REF])
    const other: ResourceRef = { ...ARTIFACT_REF, id: 'abcdefab-1234-4123-8123-123456789abc' }
    await expect(
      scoped.read({ approvedInputRefs: [other] }, ctx()),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_ALLOWED' })
    expect(read).not.toHaveBeenCalled()
    await scoped.read({ approvedInputRefs: [ARTIFACT_REF] }, ctx())
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('simulation execution service (ADR-12, INV-10)', () => {
  function harness(): {
    readonly service: SimulationExecutionService
    readonly device: { sendCommand: ReturnType<typeof vi.fn> }
    readonly enqueued: string[]
  } {
    const enqueued: string[] = []
    const jobs: SimulationJobPort = {
      async enqueue(input) {
        enqueued.push(input.jobId)
        return { jobId: input.jobId, reused: false }
      },
    }
    const device = { sendCommand: vi.fn(async () => undefined) }
    const driver: DeviceActionPort = { sendCommand: device.sendCommand }
    const service = new SimulationExecutionService({
      jobs,
      deviceDriver: driver,
      now: () => '2026-09-21T00:00:00Z',
    })
    return { service, device, enqueued }
  }

  it('refuses a live request with CAPABILITY_NOT_CONFIGURED and never touches the driver', async () => {
    const { service, device, enqueued } = harness()
    await expect(
      service.requestExecution(
        {
          operationRef: energyOperationRef('home-energy.simulate'),
          planRef: ARTIFACT_REF,
          inputRefs: [ARTIFACT_REF],
          mode: 'live',
          runId: RUN,
          idempotencyKey: 'sim-live-0001',
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_CONFIGURED' })
    expect(device.sendCommand).not.toHaveBeenCalled()
    expect(enqueued).toHaveLength(0)
  })

  it('schedules an explicit simulation execution with zero device requests', async () => {
    const { service, device, enqueued } = harness()
    const record = await service.requestExecution(
      {
        operationRef: energyOperationRef('home-energy.simulate'),
        planRef: ARTIFACT_REF,
        inputRefs: [ARTIFACT_REF],
        mode: 'simulation',
        runId: RUN,
        idempotencyKey: 'sim-run-0001',
      },
      ctx(['data-editor']),
    )
    expect(record.mode).toBe('simulation')
    expect(record.liveSupported).toBe(false)
    expect(record.deviceRequestsSent).toBe(0)
    expect(record.phase).toBe('scheduled')
    expect(enqueued).toHaveLength(1)
    expect(device.sendCommand).not.toHaveBeenCalled()
  })

  it('round-trips the durable simulation job reference', () => {
    const request = {
      kind: 'home-energy.simulation-job' as const,
      version: '1.0.0',
      mode: 'simulation' as const,
      runId: RUN,
      operationRef: energyOperationRef('home-energy.simulate'),
      planRef: planFor(4).planRef,
      inputRefs: [ARTIFACT_REF],
    }
    const decoded = decodeSimulationJobRequest(encodeSimulationJobRequest(request))
    expect(decoded.runId).toBe(RUN)
    expect(decoded.mode).toBe('simulation')
    expect(decoded.operationRef.id).toBe('home-energy.simulate')
  })

  it('rejects a job reference that is not a simulation', () => {
    const forged = JSON.stringify({ kind: 'home-energy.simulation-job', mode: 'live', runId: randomUUID() })
    expect(() => decodeSimulationJobRequest(forged)).toThrow()
  })
})

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

class InputReader implements ScopedArtifactReader {
  readonly #bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  async read(request: ScopedArtifactReaderRequest): Promise<Uint8Array> {
    if (request.approvedInputRefs.length === 0) throw new Error('no approved input')
    return this.#bytes
  }
}

describe('registered handlers archive a deterministic result artifact', () => {
  it('produces the same content-addressed result for identical input and parameters', async () => {
    const writer = new ContentAddressedWriter()
    const reader = new InputReader(encodeEnergyOperationInput(operationInput()))
    const planHandler = createEnergyComputeHandlers().find(
      (handler) => handler.operationRef.id === 'home-energy.plan',
    )
    if (planHandler === undefined) throw new Error('the plan handler is not registered')
    const request: ComputeOperationRequest = {
      operationRef: energyOperationRef('home-energy.plan'),
      parameters: { strategyWhitelist: ['self_consumption'] },
      inputRefs: [ARTIFACT_REF],
      readInput: reader,
      artifacts: writer,
      limits: { maxRows: 96, maxBytes: 262_144, maxDurationMs: 2_000 },
      deadline: '2099-01-01T00:00:00Z',
      ctx: ctx(),
      signal: new AbortController().signal,
    }
    const first = await planHandler.execute(request)
    const second = await planHandler.execute(request)
    const firstComputation = (first.payload as { computation?: { resultRef?: ResourceRef } }).computation
    const secondComputation = (second.payload as { computation?: { resultRef?: ResourceRef } }).computation
    expect(firstComputation?.resultRef?.digest).toBeDefined()
    expect(firstComputation?.resultRef?.digest).toBe(secondComputation?.resultRef?.digest)
    expect(first.dataMode).toBe('simulation')
    expect(first.evidenceKind).toBe('computation')
  })

  it('runs simulate and metrics into typed computation results with a simulation marker', async () => {
    const handlers = createEnergyComputeHandlers()
    const parametersFor = (id: string): Readonly<Record<string, unknown>> =>
      id === 'home-energy.metrics' ? { aggregations: ['net_cost', 'reserve_min_margin_kwh'] } : {}
    for (const id of ['home-energy.simulate', 'home-energy.metrics'] as const) {
      const writer = new ContentAddressedWriter()
      const handler = handlers.find((candidate) => candidate.operationRef.id === id)
      if (handler === undefined) throw new Error(`${id} is not registered`)
      const request: ComputeOperationRequest = {
        operationRef: energyOperationRef(id),
        parameters: parametersFor(id),
        inputRefs: [ARTIFACT_REF],
        readInput: new InputReader(encodeEnergyOperationInput(operationInput())),
        artifacts: writer,
        limits: { maxRows: 96, maxBytes: 262_144, maxDurationMs: 2_000 },
        deadline: '2099-01-01T00:00:00Z',
        ctx: ctx(),
        signal: new AbortController().signal,
      }
      const result = await handler.execute(request)
      const computation = (result.payload as { computation?: { resultRef?: ResourceRef } }).computation
      expect(computation?.resultRef?.digest).toBeDefined()
      expect(writer.byDigest.has(String(computation?.resultRef?.digest))).toBe(true)
      expect(result.dataMode).toBe('simulation')
      expect(result.evidenceKind).toBe('computation')
      expect(result.status).toBe('ok')
    }
  })
})
