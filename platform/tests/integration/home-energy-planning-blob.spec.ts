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
  DEFAULT_SIMULATION_TOLERANCE,
  DeclaredConversions,
  EnergyPlanner,
  EnergySimulator,
  canonicalJson,
  energyInputDigest,
  normalizeEnergyInput,
  publishEnergyInputSnapshot,
} from '@ontology/extension-home-energy'
import type {
  EnergyInputBundle,
  EnergyInputSnapshot,
  EnergyPlanRequest,
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
  sourceSnapshot,
  varyingTariff,
} from '../fixtures/home-energy'

/**
 * LOCAL-045 integration: the pure planner runs over a *real* LOCAL-043 snapshot built from the
 * LOCAL-042 synthetic fixtures and archived through the real blob-local store on disk.
 *
 * The snapshot is produced by the real normaliser from the synthetic observations and forecast,
 * content-addressed and verified on read. Nothing is mocked and no database or network is used;
 * the planner itself remains pure and only consumes the archived snapshot manifest.
 */

const HORIZON = { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:30:00Z' } as const
const EVALUATION_CLOCK = '2026-01-01T00:30:00Z'
const PV_MEASUREMENT_POINT = 'mp-pv'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const CTX: ToolContext = createToolContext({
  principal: {
    tenantId: TENANT,
    subjectId: 'node-45-integration',
    roles: ['simulation-user'],
    scopes: [],
    authEpoch: 1,
  },
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
  traceId: 'trace-node-45-integration',
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
    sourceSnapshot: sourceSnapshot(HOME_ENERGY_SOURCE_B_REF, '2026-01-01T00:30:00Z', '2026-01-01T00:30:00Z', 'b'),
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
    sourceSnapshot: sourceSnapshot(HOME_ENERGY_SOURCE_A_REF, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'a'),
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
  objectDir = await mkdtemp(join(tmpdir(), 'home-energy-planning-blob-'))
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

function planRequestFor(snapshot: EnergyInputSnapshot): EnergyPlanRequest {
  return {
    snapshot,
    executionMode: 'simulation',
    topology: SIM_TOPOLOGY,
    battery: SIM_BATTERY,
    grid: { connectionRef: 'grid-1' },
    load: [{ measurementPointRef: LIVING_MEASUREMENT_POINT, samplingType: 'observed' }],
    pv: [{ measurementPointRef: PV_MEASUREMENT_POINT, samplingType: 'forecast' }],
    tariff: varyingTariff([0.2, 1.0]),
    reserves: [],
    tolerance: DEFAULT_SIMULATION_TOLERANCE,
    assumptions: ['synthetic fixture scenario'],
  }
}

describe('planner over a real LOCAL-043 snapshot archived in blob-local', () => {
  it('archives the snapshot, then plans deterministically over it end to end', async () => {
    const store = blobStore
    if (store === undefined) throw new Error('blob store was not initialised')

    const conversions = new DeclaredConversions(homeEnergyDeclaredConversions())
    const normalized = normalizeEnergyInput(normalizeRequest(), bundle(), { conversions })
    const snapshot = await publishEnergyInputSnapshot(
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

    const planner = new EnergyPlanner(new EnergySimulator())
    const request = planRequestFor(snapshot)
    const first = planner.plan(request)
    const second = planner.plan(request)

    // End-to-end determinism: identical candidates, simulations, selection and result digest.
    expect(canonicalJson(first)).toBe(canonicalJson(second))
    expect(first.resultDigest).toBe(second.resultDigest)
    expect(first.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/)

    // Every candidate and the baseline ran over the real archived snapshot.
    expect(first.status).toBe('feasible')
    expect(first.inputManifestHash).toBe(snapshot.digest)
    expect(first.baseline?.simulation.inputManifestHash).toBe(snapshot.digest)
    expect(first.candidates.length).toBeGreaterThan(0)
    for (const candidate of first.candidates) {
      expect(candidate.simulation.inputManifestHash).toBe(snapshot.digest)
      expect(candidate.simulation.executionMode).toBe('simulation')
      expect(candidate.simulation.samplingMarkers).toHaveLength(2)
    }
    expect(first.selection.selectedPlanRef).toBeDefined()
    expect(first.optimality).toBe('best_of_tested_candidates')
  })
})
