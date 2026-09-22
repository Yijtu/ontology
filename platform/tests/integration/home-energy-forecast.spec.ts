import { randomUUID } from 'node:crypto'
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
  BlobPurpose,
  BlobScope,
  RecordArtifactReferenceInput,
  RecordArtifactReferenceResult,
} from '@ontology/adapter-blob-local'
import { createToolContext } from '@ontology/contracts'
import type {
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  Capability,
  ForecastPort,
  ForecastReadRequest,
  ForecastReadResponse,
  ImmutableArtifactWriter,
  ResourceRef,
  Sha256Digest,
  TelemetryPort,
  TelemetryReadCurrentRequest,
  TelemetryReadCurrentResponse,
  TelemetryReadSeriesRequest,
  TelemetryReadSeriesResponse,
  TimeWindow,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import {
  DeclaredConversions,
  EnergyInputService,
  energyInputDigest,
  sha256DigestOf,
} from '@ontology/extension-home-energy'
import type { BuildEnergyInputRequest, EnergyMetric, ForecastReadSpec } from '@ontology/extension-home-energy'
import {
  HOME_ENERGY_FORECAST_MODEL_VERSION,
  HOME_ENERGY_INPUT_VERSIONS,
  HOME_ENERGY_SOURCE_A_REF,
  homeEnergyDeclaredConversions,
  sourceSnapshot,
} from '../fixtures/home-energy'

/**
 * LOCAL-066 integration acceptance.
 *
 * A controlled `ForecastPort` drives the real `EnergyInputService` and the real normaliser, and
 * the resulting input snapshot is archived through the real blob-local store (a filesystem object
 * store plus a scoped metadata registry). It proves as-of filtering, issue-time/validity-window/
 * model-version preservation and the explicit `not_configured` outcome without any real forecast
 * service or paid model call.
 */

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const TARGET: TimeWindow = { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }
const EVALUATION_CLOCK = '2026-01-01T01:00:00Z'

const SITE_REF: ResourceRef = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'dataset',
}

const FORECAST_CAPABILITY: Capability = {
  name: 'forecast_read',
  version: '1.0.0',
  limits: { maxRows: 100_000, maxBytes: 1_048_576, maxDurationMs: 5_000 },
  consistency: 'read_time',
  cancellation: 'unsupported',
  pagination: 'none',
  supportedDataTypes: ['decimal', 'timestamp'],
}

const CTX: ToolContext = createToolContext({
  principal: { tenantId: TENANT, subjectId: 'node-66-integration', roles: ['data-editor'], scopes: [], authEpoch: 1 },
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
    sourceRefs: [HOME_ENERGY_SOURCE_A_REF],
    collectionRefs: [],
    domains: [],
    maxRows: 1000,
  },
  traceId: 'trace-node-66-integration',
})

interface ForecastRecord {
  readonly entityId: string
  readonly metric: EnergyMetric
  readonly issuedAt: string
  readonly points: readonly { readonly targetTime: string; readonly value: string }[]
}

class ControlledForecastPort implements ForecastPort {
  readonly capability = FORECAST_CAPABILITY
  readonly calls: ForecastReadRequest[] = []
  readonly #records: readonly ForecastRecord[]
  readonly #honorAsOf: boolean

  constructor(records: readonly ForecastRecord[], honorAsOf = true) {
    this.#records = records
    this.#honorAsOf = honorAsOf
  }

  async readForecast(request: ForecastReadRequest, ctx: ToolContext): Promise<ForecastReadResponse> {
    void ctx
    this.calls.push(request)
    const candidates = this.#records.filter(
      (record) => record.entityId === request.entityRef.id && record.metric === request.metric,
    )
    const eligible = this.#honorAsOf
      ? candidates.filter((record) => Date.parse(record.issuedAt) <= Date.parse(request.asOf))
      : candidates
    const chosen = [...eligible].sort(
      (left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt),
    )[0]

    if (chosen === undefined) {
      return {
        entityRef: request.entityRef,
        metric: request.metric,
        unit: request.expectedUnit ?? 'kW',
        issuedAt: request.asOf,
        targetWindow: request.targetWindow,
        method: 'none',
        assumptions: [],
        modelVersion: HOME_ENERGY_FORECAST_MODEL_VERSION,
        points: [],
        quality: 'missing',
        snapshot: sourceSnapshot(HOME_ENERGY_SOURCE_A_REF, request.asOf, request.asOf, '9'),
        completeness: 'unknown',
      }
    }

    return {
      entityRef: request.entityRef,
      metric: request.metric,
      unit: request.expectedUnit ?? 'kW',
      issuedAt: chosen.issuedAt,
      targetWindow: request.targetWindow,
      method: 'persistence',
      assumptions: ['clear-sky'],
      modelVersion: HOME_ENERGY_FORECAST_MODEL_VERSION,
      points: chosen.points.map((point) => ({
        targetTime: point.targetTime,
        value: { amount: point.value, unit: request.expectedUnit ?? 'kW' },
        quality: 'good',
      })),
      quality: 'good',
      snapshot: sourceSnapshot(HOME_ENERGY_SOURCE_A_REF, request.asOf, chosen.issuedAt, 'd'),
      completeness: 'complete',
    }
  }
}

class EmptyTelemetryPort implements TelemetryPort {
  async readSeries(request: TelemetryReadSeriesRequest): Promise<TelemetryReadSeriesResponse> {
    return {
      entityRef: request.entityRef,
      metric: request.metric,
      unit: request.expectedUnit ?? 'kW',
      points: [],
      quality: 'missing',
      snapshot: sourceSnapshot(HOME_ENERGY_SOURCE_A_REF, request.window.end, request.window.end, 'e'),
      completeness: 'unknown',
    }
  }

  async readCurrent(request: TelemetryReadCurrentRequest): Promise<TelemetryReadCurrentResponse> {
    void request
    return {
      readings: [],
      snapshot: sourceSnapshot(HOME_ENERGY_SOURCE_A_REF, TARGET.end, TARGET.end, 'e'),
      stale: true,
    }
  }
}

/**
 * A minimal scoped metadata registry. It is the only test double in this file: the object store
 * and the immutable blob store are the real blob-local adapter.
 */
class InMemoryArtifactRegistry implements ArtifactRegistry {
  readonly #blobs = new Map<string, ArtifactBlobRecord>()
  readonly #references = new Map<string, ArtifactReferenceRecord>()

  #blobKey(scope: BlobScope, digest: Sha256Digest): string {
    return `${scope.tenantId}|${scope.spaceId}|${digest}`
  }

  #refKey(scope: BlobScope, blobRefId: Uuid): string {
    return `${scope.tenantId}|${scope.spaceId}|${blobRefId}`
  }

  async recordReference(input: RecordArtifactReferenceInput): Promise<RecordArtifactReferenceResult> {
    const { scope } = input
    const existing = this.#blobs.get(this.#blobKey(scope, input.contentDigest))
    const lineageId = existing?.lineageId ?? randomUUID()
    const deduplicated = existing !== undefined
    const blob: ArtifactBlobRecord = existing ?? {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      contentDigest: input.contentDigest,
      mediaType: input.mediaType,
      byteSize: input.byteSize,
      objectKey: input.objectKey,
      lineageId,
      createdAt: new Date().toISOString(),
    }
    this.#blobs.set(this.#blobKey(scope, input.contentDigest), blob)

    const reference: ArtifactReferenceRecord = {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      blobRefId: input.blobRefId,
      contentDigest: input.contentDigest,
      purpose: input.purpose,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.tenantAuthorizedRef === undefined ? {} : { tenantAuthorizedRef: input.tenantAuthorizedRef }),
      origin: input.origin ?? {},
      createdAt: new Date().toISOString(),
    }
    this.#references.set(this.#refKey(scope, input.blobRefId), reference)

    return {
      blobRef: {
        id: input.blobRefId,
        version: '1.0.0',
        digest: input.contentDigest,
        kind: resourceKindForPurpose(input.purpose),
      },
      lineageId,
      deduplicated,
      reference,
    }
  }

  async findReference(scope: BlobScope, blobRefId: Uuid): Promise<ArtifactReferenceView | undefined> {
    const reference = this.#references.get(this.#refKey(scope, blobRefId))
    if (reference === undefined) return undefined
    const blob = this.#blobs.get(this.#blobKey(scope, reference.contentDigest))
    if (blob === undefined) return undefined
    return { reference, blob }
  }

  async listOrigins(scope: BlobScope, contentDigest: Sha256Digest): Promise<readonly ArtifactReferenceRecord[]> {
    return [...this.#references.values()].filter(
      (reference) =>
        reference.tenantId === scope.tenantId &&
        reference.spaceId === scope.spaceId &&
        reference.contentDigest === contentDigest,
    )
  }

  async close(): Promise<void> {
    this.#blobs.clear()
    this.#references.clear()
  }
}

class BlobArtifactWriter implements ImmutableArtifactWriter {
  readonly #store: LocalImmutableBlobStore

  constructor(store: LocalImmutableBlobStore) {
    this.#store = store
  }

  async putBytes(request: ArtifactWriteRequest, ctx: ToolContext): Promise<BlobPutImmutableResponse> {
    const staged = await this.#store.stage(request.content, { scopeRef: request.scopeRef }, ctx)
    return this.#store.publish(
      {
        scopeRef: request.scopeRef,
        contentDigest: staged.contentDigest,
        mediaType: request.mediaType,
        byteSize: staged.byteSize,
        purpose: 'artifact' satisfies BlobPurpose,
        ...(request.tenantAuthorizedRef === undefined ? {} : { tenantAuthorizedRef: request.tenantAuthorizedRef }),
      },
      ctx,
    )
  }
}

function forecastSpec(): ForecastReadSpec {
  return {
    measurementPointRef: 'mp-site',
    entityRef: { id: 'source-a:load', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'source' },
    metric: 'power',
    targetWindow: TARGET,
    mappingVersion: HOME_ENERGY_INPUT_VERSIONS.mapping,
    expectedUnit: 'kW',
  }
}

function request(forecastRequests: readonly ForecastReadSpec[]): BuildEnergyInputRequest {
  return {
    siteRef: SITE_REF,
    evaluationClock: EVALUATION_CLOCK,
    horizon: TARGET,
    timeZone: 'Europe/Berlin',
    slotMinutes: 15,
    dataMode: 'forecast',
    measurementPoints: [],
    coverage: [],
    versions: HOME_ENERGY_INPUT_VERSIONS,
    observationRequests: [],
    forecastRequests,
  }
}

let objectDir = ''
let blobStore: LocalImmutableBlobStore | undefined
let registry: InMemoryArtifactRegistry | undefined

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not initialised`)
  return value
}

function buildService(forecast?: ForecastPort): EnergyInputService {
  return new EnergyInputService({
    telemetry: new EmptyTelemetryPort(),
    conversions: new DeclaredConversions(homeEnergyDeclaredConversions()),
    artifacts: new BlobArtifactWriter(requireValue(blobStore, 'blob store')),
    ...(forecast === undefined ? {} : { forecast }),
  })
}

beforeAll(async () => {
  objectDir = await mkdtemp(join(tmpdir(), 'home-energy-forecast-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new InMemoryArtifactRegistry()
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
})

afterAll(async () => {
  await registry?.close().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe('forecast input through ForecastPort end-to-end with real blob-local', () => {
  it('archives a content-addressed snapshot preserving issue time, window and model version', async () => {
    const port = new ControlledForecastPort([
      {
        entityId: 'source-a:load',
        metric: 'power',
        issuedAt: '2026-01-01T00:00:00Z',
        points: [
          { targetTime: '2026-01-01T00:00:00Z', value: '4.0' },
          { targetTime: '2026-01-01T00:15:00Z', value: '5.0' },
        ],
      },
    ])
    const service = buildService(port)
    const snapshot = await service.buildSnapshot(request([forecastSpec()]), CTX)

    expect(port.calls[0]?.asOf).toBe(EVALUATION_CLOCK)
    expect(snapshot.digest).toBe(energyInputDigest(await service.normalize(request([forecastSpec()]), CTX)))

    const bytes = await requireValue(blobStore, 'blob store').readAuthorized(
      { scopeRef: { tenantId: TENANT, spaceId: SPACE }, blobRef: snapshot.snapshotRef },
      CTX,
    )
    const stored = JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly series: readonly {
        readonly samplingType: string
        readonly issuedAt?: string
        readonly validityWindow?: TimeWindow
        readonly modelVersion?: VersionRef
        readonly points: readonly { readonly value?: number }[]
      }[]
      readonly missingInputs: readonly unknown[]
    }

    const forecasts = stored.series.filter((entry) => entry.samplingType === 'forecast')
    expect(forecasts).toHaveLength(1)
    expect(forecasts[0]?.issuedAt).toBe('2026-01-01T00:00:00Z')
    expect(forecasts[0]?.validityWindow).toEqual(TARGET)
    expect(forecasts[0]?.modelVersion).toEqual(HOME_ENERGY_FORECAST_MODEL_VERSION)
    expect(forecasts[0]?.points.map((point) => point.value)).toEqual([4, 5, undefined, undefined])
    expect(stored.missingInputs).toEqual([])
    expect(snapshot.manifest.sourceWatermarks[0]?.sourceRef).toEqual(HOME_ENERGY_SOURCE_A_REF)
  })

  it('drops a forecast issued after the evaluation clock even when the backend leaks it', async () => {
    const port = new ControlledForecastPort(
      [
        { entityId: 'source-a:load', metric: 'power', issuedAt: '2026-01-01T00:00:00Z', points: [{ targetTime: TARGET.start, value: '4.0' }] },
        { entityId: 'source-a:load', metric: 'power', issuedAt: '2026-01-02T00:00:00Z', points: [{ targetTime: TARGET.start, value: '9.0' }] },
      ],
      false,
    )
    const input = await buildService(port).normalize(request([forecastSpec()]), CTX)
    expect(input.series.filter((entry) => entry.samplingType === 'forecast')).toEqual([])
    expect(input.missingInputs).toEqual([
      {
        measurementPointRef: 'mp-site',
        metric: 'power',
        purpose: 'forecast',
        reason: 'issued_after_evaluation_clock',
      },
    ])
  })

  it('reports not_configured and archives it without inventing a forecast', async () => {
    const service = buildService()
    const snapshot = await service.buildSnapshot(request([forecastSpec()]), CTX)

    expect(snapshot.manifest.missingInputs).toEqual([
      {
        measurementPointRef: 'mp-site',
        metric: 'power',
        purpose: 'forecast',
        reason: 'forecast_not_configured',
      },
    ])
    expect(snapshot.manifest.series).toEqual([])

    const bytes = await requireValue(blobStore, 'blob store').readAuthorized(
      { scopeRef: { tenantId: TENANT, spaceId: SPACE }, blobRef: snapshot.snapshotRef },
      CTX,
    )
    const stored = JSON.parse(new TextDecoder().decode(bytes)) as {
      readonly series: readonly unknown[]
      readonly missingInputs: readonly { readonly reason: string }[]
    }
    expect(stored.series).toEqual([])
    expect(stored.missingInputs.map((entry) => entry.reason)).toEqual(['forecast_not_configured'])
  })

  it('is reproducible: identical forecast inputs reproduce the same digest and dedupe the blob', async () => {
    const records = [
      { entityId: 'source-a:load', metric: 'power' as const, issuedAt: '2026-01-01T00:00:00Z', points: [{ targetTime: TARGET.start, value: '4.0' }] },
    ]
    const service = buildService(new ControlledForecastPort(records))
    const first = await service.buildSnapshot(request([forecastSpec()]), CTX)
    const second = await service.buildSnapshot(request([forecastSpec()]), CTX)
    expect(second.digest).toBe(first.digest)
    const origins = await requireValue(blobStore, 'blob store').listOrigins(
      { scopeRef: { tenantId: TENANT, spaceId: SPACE }, blobRef: first.snapshotRef },
      CTX,
    )
    expect(origins.length).toBeGreaterThanOrEqual(2)
  })

  it('verifies the archived bytes hash to the snapshot digest', async () => {
    const port = new ControlledForecastPort([
      { entityId: 'source-a:load', metric: 'power', issuedAt: '2026-01-01T00:00:00Z', points: [{ targetTime: TARGET.start, value: '4.0' }] },
    ])
    const snapshot = await buildService(port).buildSnapshot(request([forecastSpec()]), CTX)
    const bytes = await requireValue(blobStore, 'blob store').readAuthorized(
      { scopeRef: { tenantId: TENANT, spaceId: SPACE }, blobRef: snapshot.snapshotRef },
      CTX,
    )
    expect(sha256DigestOf(bytes)).toBe(snapshot.digest)
    expect(snapshot.snapshotRef.digest).toBe(snapshot.digest)
  })
})
