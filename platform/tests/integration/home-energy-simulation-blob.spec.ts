import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  resourceKindForPurpose,
} from '@ontology/adapter-blob-local'
import type {
  ArtifactBlobRecord,
  ArtifactReferenceRecord,
  ArtifactReferenceView,
  ArtifactRegistry,
  BlobScope,
  RecordArtifactReferenceInput,
  RecordArtifactReferenceResult,
} from '@ontology/adapter-blob-local'
import { createToolContext } from '@ontology/contracts'
import type {
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  ImmutableArtifactWriter,
  ResourceRef,
  TelemetryQuality,
  ToolContext,
} from '@ontology/contracts'
import {
  DeclaredConversions,
  EnergySimulator,
  energyInputDigest,
  normalizeEnergyInput,
  publishEnergyInputSnapshot,
} from '@ontology/extension-home-energy'
import type {
  EnergyInputBundle,
  EnergyInputSnapshot,
  ForecastSeriesInput,
  ObservationSeriesInput,
  RawTelemetryPoint,
} from '@ontology/extension-home-energy'
import {
  HOME_ENERGY_FORECAST_MODEL_VERSION,
  HOME_ENERGY_INPUT_VERSIONS,
  HOME_ENERGY_SOURCE_A_REF,
  HOME_ENERGY_SOURCE_B_REF,
  LIVING_MEASUREMENT_POINT,
  SIM_BATTERY,
  SIM_TOPOLOGY,
  homeEnergyDeclaredConversions,
  planFor,
  sourceSnapshot,
  tariffFor,
} from '../fixtures/home-energy'

/**
 * LOCAL-044 integration: the pure simulator runs over a *real* LOCAL-043 snapshot.
 *
 * The snapshot is produced by the real normaliser from the LOCAL-042 synthetic observations and
 * archived through the real blob-local store on disk (content-addressed, verified on read).
 * Nothing is mocked; there is no database and no network — the simulator itself remains pure and
 * only consumes the archived snapshot manifest.
 */

const HORIZON = { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:30:00Z' } as const
const EVALUATION_CLOCK = '2026-01-01T00:30:00Z'
const PV_MEASUREMENT_POINT = 'mp-pv'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const CTX: ToolContext = createToolContext({
  principal: { tenantId: TENANT, subjectId: 'node-44-integration', roles: ['simulation-user'], scopes: [], authEpoch: 1 },
  runId: '99999999-9999-4999-8999-999999999999',
  resolvedProfileHash: `sha256:${'c'.repeat(64)}`,
  policyVersion: '0.2.0',
  deadline: '2099-01-01T00:00:00Z',
  budgetReservation: {
    reservationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    runId: '99999999-9999-4999-8999-999999999999',
    grantedAt: '2026-09-21T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
  },
  allowedResources: {
    tenantId: TENANT,
    spaceId: SPACE,
    resourceKinds: [],
    sourceRefs: [HOME_ENERGY_SOURCE_A_REF, HOME_ENERGY_SOURCE_B_REF],
    collectionRefs: [],
    domains: [],
    maxRows: 1000,
  },
  traceId: 'trace-node-44-integration',
})

const SITE_REF: ResourceRef = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'dataset',
}

function point(timestamp: string, value: number, quality: TelemetryQuality = 'good'): RawTelemetryPoint {
  return { timestamp, value, quality }
}

function livingObservation(): ObservationSeriesInput {
  return {
    measurementPointRef: LIVING_MEASUREMENT_POINT,
    metric: 'power',
    semantics: 'instantaneous',
    unit: 'kW',
    points: [point('2026-01-01T00:00:00Z', 3.5), point('2026-01-01T00:15:00Z', 4.0)],
    sourceRef: HOME_ENERGY_SOURCE_B_REF,
    sourceSnapshot: sourceSnapshot(
      HOME_ENERGY_SOURCE_B_REF,
      '2026-01-01T00:30:00Z',
      '2026-01-01T00:30:00Z',
      'b',
    ),
    mappingVersion: HOME_ENERGY_INPUT_VERSIONS.mapping,
  }
}

function pvForecast(): ForecastSeriesInput {
  return {
    measurementPointRef: PV_MEASUREMENT_POINT,
    metric: 'power',
    unit: 'kW',
    issuedAt: '2026-01-01T00:00:00Z',
    targetInterval: HORIZON,
    method: 'fixture-persistence',
    assumptions: ['synthetic fixture'],
    modelVersion: HOME_ENERGY_FORECAST_MODEL_VERSION,
    points: [point('2026-01-01T00:00:00Z', 4.0), point('2026-01-01T00:15:00Z', 0.0)],
    sourceRef: HOME_ENERGY_SOURCE_A_REF,
    sourceSnapshot: sourceSnapshot(
      HOME_ENERGY_SOURCE_A_REF,
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
      'a',
    ),
    mappingVersion: HOME_ENERGY_INPUT_VERSIONS.mapping,
  }
}

function bundle(): EnergyInputBundle {
  return { observations: [livingObservation()], forecasts: [pvForecast()] }
}

function normalizeRequest() {
  return {
    siteRef: SITE_REF,
    evaluationClock: EVALUATION_CLOCK,
    horizon: HORIZON,
    timeZone: 'UTC',
    slotMinutes: 15,
    dataMode: 'synthetic' as const,
    measurementPoints: [LIVING_MEASUREMENT_POINT, PV_MEASUREMENT_POINT],
    coverage: [
      { measurementPointRef: LIVING_MEASUREMENT_POINT, metric: 'power' as const, coverageRef: 'load:living' },
      { measurementPointRef: PV_MEASUREMENT_POINT, metric: 'power' as const, coverageRef: 'generation:pv' },
    ],
    versions: HOME_ENERGY_INPUT_VERSIONS,
  }
}

/** Minimal in-memory registry behind the real on-disk object store; no database is used. */
class InMemoryArtifactRegistry implements ArtifactRegistry {
  readonly #blobs = new Map<string, ArtifactBlobRecord>()
  readonly #refs = new Map<string, ArtifactReferenceRecord>()

  async recordReference(
    input: RecordArtifactReferenceInput,
  ): Promise<RecordArtifactReferenceResult> {
    const refKey = `${input.scope.tenantId}:${input.scope.spaceId}:${input.blobRefId}`
    const blobKey = `${input.scope.tenantId}:${input.scope.spaceId}:${input.contentDigest}`
    const deduplicated = this.#refs.has(refKey)
    const blob = this.#blobs.get(blobKey) ?? {
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      contentDigest: input.contentDigest,
      mediaType: input.mediaType,
      byteSize: input.byteSize,
      objectKey: input.objectKey,
      lineageId: '77777777-2222-4333-8444-555555555555',
      createdAt: '2026-01-01T00:00:00Z',
    }
    this.#blobs.set(blobKey, blob)
    const reference: ArtifactReferenceRecord = {
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      blobRefId: input.blobRefId,
      contentDigest: input.contentDigest,
      purpose: input.purpose,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.tenantAuthorizedRef === undefined
        ? {}
        : { tenantAuthorizedRef: input.tenantAuthorizedRef }),
      origin: input.origin ?? {},
      createdAt: '2026-01-01T00:00:00Z',
    }
    this.#refs.set(refKey, reference)
    return {
      blobRef: {
        id: input.blobRefId,
        version: '1.0.0',
        digest: input.contentDigest,
        kind: resourceKindForPurpose(input.purpose),
      },
      lineageId: blob.lineageId,
      deduplicated,
      reference,
    }
  }

  async findReference(scope: BlobScope, blobRefId: string): Promise<ArtifactReferenceView | undefined> {
    const reference = this.#refs.get(`${scope.tenantId}:${scope.spaceId}:${blobRefId}`)
    if (reference === undefined) return undefined
    const blob = this.#blobs.get(`${scope.tenantId}:${scope.spaceId}:${reference.contentDigest}`)
    if (blob === undefined) return undefined
    return { reference, blob }
  }

  async listOrigins(
    scope: BlobScope,
    contentDigest: string,
  ): Promise<readonly ArtifactReferenceRecord[]> {
    return [...this.#refs.values()].filter(
      (reference) =>
        reference.tenantId === scope.tenantId &&
        reference.spaceId === scope.spaceId &&
        reference.contentDigest === contentDigest,
    )
  }

  async close(): Promise<void> {}
}

class BlobArtifactWriter implements ImmutableArtifactWriter {
  readonly #store: LocalImmutableBlobStore

  constructor(store: LocalImmutableBlobStore) {
    this.#store = store
  }

  async putBytes(
    request: ArtifactWriteRequest,
    ctx: ToolContext,
  ): Promise<BlobPutImmutableResponse> {
    const staged = await this.#store.stage(request.content, { scopeRef: request.scopeRef }, ctx)
    return this.#store.publish(
      {
        scopeRef: request.scopeRef,
        contentDigest: staged.contentDigest,
        mediaType: request.mediaType,
        byteSize: staged.byteSize,
        purpose: 'artifact',
        ...(request.tenantAuthorizedRef === undefined
          ? {}
          : { tenantAuthorizedRef: request.tenantAuthorizedRef }),
      },
      ctx,
    )
  }
}

let objectDir = ''
let blobStore: LocalImmutableBlobStore | undefined

beforeAll(async () => {
  objectDir = await mkdtemp(join(tmpdir(), 'home-energy-simulation-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  blobStore = new LocalImmutableBlobStore({
    objectStore,
    registry: new InMemoryArtifactRegistry(),
  })
})

afterAll(async () => {
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('simulator over a real LOCAL-043 snapshot archived in blob-local', () => {
  it('archives the normalised snapshot, then simulates it deterministically and feasibly', async () => {
    const store = blobStore
    if (store === undefined) throw new Error('blob store was not initialised')

    const conversions = new DeclaredConversions(homeEnergyDeclaredConversions())
    const normalized = normalizeEnergyInput(normalizeRequest(), bundle(), { conversions })
    const snapshot: EnergyInputSnapshot = await publishEnergyInputSnapshot(
      normalized,
      { artifacts: new BlobArtifactWriter(store) },
      CTX,
    )

    // The archived snapshot is content-addressed and readable from disk.
    expect(snapshot.digest).toBe(energyInputDigest(normalized))
    const bytes = await store.readAuthorized(
      { scopeRef: { tenantId: TENANT, spaceId: SPACE }, blobRef: snapshot.snapshotRef },
      CTX,
    )
    const stored = JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly series: readonly unknown[]
    }
    expect(stored.series).toHaveLength(2)

    // Run the pure simulator over the real snapshot manifest.
    const simulator = new EnergySimulator()
    const request = {
      snapshot,
      executionMode: 'simulation' as const,
      topology: SIM_TOPOLOGY,
      battery: SIM_BATTERY,
      grid: { connectionRef: 'grid-1' },
      load: [{ measurementPointRef: LIVING_MEASUREMENT_POINT, samplingType: 'observed' as const }],
      pv: [{ measurementPointRef: PV_MEASUREMENT_POINT, samplingType: 'forecast' as const }],
      tariff: tariffFor(2, 1.0, 0.4),
      reserves: [],
      plan: planFor(2),
      tolerance: {
        version: '1.0.0',
        energyBalanceKwh: 1e-9,
        capacityKwh: 1e-9,
        powerKw: 1e-9,
        efficiency: 1e-9,
        cost: 1e-9,
        reportingDecimals: 9,
      },
      assumptions: ['synthetic fixture scenario'],
    }

    const first = simulator.simulate(request)
    const second = simulator.simulate(request)

    expect(first.status).toBe('feasible')
    expect(first.intervals).toHaveLength(2)
    expect(first.inputManifestHash).toBe(snapshot.digest)
    expect(first.evidenceRefs[0]).toEqual(snapshot.snapshotRef)
    // Slot0: PV 4 kW serves load 3.5 kW and exports 0.5 kW. Slot1: grid imports 4 kW.
    expect(first.intervals[0]?.gridExportKw).toBeCloseTo(0.5, 9)
    expect(first.intervals[1]?.gridImportKw).toBeCloseTo(4, 9)
    for (const interval of first.intervals) {
      expect(Math.abs(interval.energyBalanceResidualKwh)).toBeLessThanOrEqual(1e-9)
    }
    // Determinism: the same snapshot yields the same result digest.
    expect(first.resultDigest).toBe(second.resultDigest)
  })
})
