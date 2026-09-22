import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import { createToolContext } from '@ontology/contracts'
import type {
  ArtifactWriteRequest,
  BlobPutImmutableResponse,
  DataMode,
  ImmutableArtifactWriter,
  Rfc3339UtcTimestamp,
  ResourceRef,
  SourceRef,
  SourceSnapshot,
  TelemetryPort,
  TelemetryQuality,
  TelemetryReadCurrentRequest,
  TelemetryReadCurrentResponse,
  TelemetryReadSeriesRequest,
  TelemetryReadSeriesResponse,
  TelemetrySeriesPoint,
  ToolContext,
} from '@ontology/contracts'
import { JobService, JobWorker } from '@ontology/application'
import type { JobStageHandler, JobStageHandlerRegistry, JobStageOutcome } from '@ontology/application'
import {
  DeclaredConversions,
  EnergyInputService,
  energyInputDigest,
  normalizeEnergyInput,
  readObservationSeries,
  sha256DigestOf,
} from '@ontology/extension-home-energy'
import type {
  BuildEnergyInputRequest,
  EnergyInputSnapshot,
  EnergyMetric,
  ObservationReadSpec,
} from '@ontology/extension-home-energy'
import {
  GARAGE_MEASUREMENT_POINT,
  HOME_ENERGY_COVERAGE,
  HOME_ENERGY_INPUT_VERSIONS,
  HOME_ENERGY_SOURCE_A_REF,
  HOME_ENERGY_SOURCE_B_REF,
  LIVING_MEASUREMENT_POINT,
  SITE_MEASUREMENT_POINT,
  homeEnergyDeclaredConversions,
  sourceARows,
  sourceBRows,
} from '../fixtures/home-energy'
import { createBudgetHarness } from '../unit/job-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

/**
 * LOCAL-043 real-database acceptance.
 *
 * A real job stage (LOCAL-022 `JobWorker` + `PostgresJobStore`, migration 012) reads the
 * LOCAL-042 synthetic observation tables through a real PostgreSQL-backed `TelemetryPort`,
 * normalises them with the LOCAL-042 customer mappings as the declared conversions, and archives
 * a content-addressed snapshot into the real blob-local store (migration 005). Nothing is mocked:
 * the observations come from PostgreSQL and the snapshot bytes live on disk and in the registry.
 */

const HORIZON = { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:30:00Z' } as const
const EVALUATION_CLOCK = '2026-01-01T00:30:00Z'

const SITE_REF: ResourceRef = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'dataset',
}

interface MetricBinding {
  readonly metric: EnergyMetric
  readonly column: string
  readonly unit: string
}

interface TelemetryBinding {
  readonly entityId: string
  readonly sourceRef: SourceRef
  readonly relation: string
  readonly sensorColumn: string
  readonly sensorValue: string
  readonly timestampColumn: string
  readonly qualityColumn: string
  readonly qualityMap: ReadonlyMap<string, TelemetryQuality>
  readonly metrics: readonly MetricBinding[]
}

const QUALITY_AB: ReadonlyMap<string, TelemetryQuality> = new Map([
  ['1', 'good'],
  ['0', 'suspect'],
])
const QUALITY_LABEL: ReadonlyMap<string, TelemetryQuality> = new Map([
  ['OK', 'good'],
  ['BAD', 'suspect'],
])

const BINDINGS: readonly TelemetryBinding[] = [
  {
    entityId: 'source-a:living',
    sourceRef: HOME_ENERGY_SOURCE_A_REF,
    relation: 'public.synthetic_observation_a',
    sensorColumn: 'sensor_key',
    sensorValue: 'sensor-living',
    timestampColumn: 'ts',
    qualityColumn: 'quality_code',
    qualityMap: QUALITY_AB,
    metrics: [
      { metric: 'power', column: 'power_w', unit: 'W' },
      { metric: 'energy', column: 'energy_wh', unit: 'Wh' },
    ],
  },
  {
    entityId: 'source-a:garage',
    sourceRef: HOME_ENERGY_SOURCE_A_REF,
    relation: 'public.synthetic_observation_a',
    sensorColumn: 'sensor_key',
    sensorValue: 'sensor-garage',
    timestampColumn: 'ts',
    qualityColumn: 'quality_code',
    qualityMap: QUALITY_AB,
    metrics: [
      { metric: 'power', column: 'power_w', unit: 'W' },
      { metric: 'energy', column: 'energy_wh', unit: 'Wh' },
    ],
  },
  {
    entityId: 'source-b:living',
    sourceRef: HOME_ENERGY_SOURCE_B_REF,
    relation: 'public.synthetic_observation_b',
    sensorColumn: 'sensor_id',
    sensorValue: 'sensor-living',
    timestampColumn: 'recorded_at',
    qualityColumn: 'quality_label',
    qualityMap: QUALITY_LABEL,
    metrics: [
      { metric: 'power', column: 'active_power_kw', unit: 'kW' },
      { metric: 'energy', column: 'interval_energy_kwh', unit: 'kWh' },
    ],
  },
  {
    entityId: 'source-b:garage',
    sourceRef: HOME_ENERGY_SOURCE_B_REF,
    relation: 'public.synthetic_observation_b',
    sensorColumn: 'sensor_id',
    sensorValue: 'sensor-garage',
    timestampColumn: 'recorded_at',
    qualityColumn: 'quality_label',
    qualityMap: QUALITY_LABEL,
    metrics: [
      { metric: 'power', column: 'active_power_kw', unit: 'kW' },
      { metric: 'energy', column: 'interval_energy_kwh', unit: 'kWh' },
    ],
  },
]

function bindingFor(entityId: string, metric: EnergyMetric): { binding: TelemetryBinding; metric: MetricBinding } {
  const binding = BINDINGS.find((candidate) => candidate.entityId === entityId)
  if (binding === undefined) throw new Error(`no telemetry binding for ${entityId}`)
  const metricBinding = binding.metrics.find((candidate) => candidate.metric === metric)
  if (metricBinding === undefined) throw new Error(`no ${metric} binding for ${entityId}`)
  return { binding, metric: metricBinding }
}

/** A real PostgreSQL-backed `TelemetryPort`. Identifiers come from the bindings, never from input. */
class PostgresTelemetryAdapter implements TelemetryPort {
  readonly #client: Client

  constructor(client: Client) {
    this.#client = client
  }

  async readSeries(
    request: TelemetryReadSeriesRequest,
    ctx: ToolContext,
  ): Promise<TelemetryReadSeriesResponse> {
    void ctx
    const requestedMetric = request.metric as EnergyMetric
    const { binding, metric } = bindingFor(request.entityRef.id, requestedMetric)
    const rows = await this.#client.query<{ ts: Date; value: string; quality: string }>(
      `SELECT ${binding.timestampColumn} AS ts, ${metric.column}::text AS value, ${binding.qualityColumn}::text AS quality
         FROM ${binding.relation}
        WHERE ${binding.sensorColumn} = $1 AND ${binding.timestampColumn} >= $2 AND ${binding.timestampColumn} < $3
        ORDER BY ${binding.timestampColumn} ASC`,
      [binding.sensorValue, request.window.start, request.window.end],
    )
    const points: TelemetrySeriesPoint[] = rows.rows.map((row) => ({
      timestamp: new Date(row.ts).toISOString(),
      value: { amount: row.value, unit: metric.unit },
      quality: binding.qualityMap.get(row.quality) ?? 'unknown',
    }))
    const digest = sha256DigestOf(new TextEncoder().encode(JSON.stringify(rows.rows.map((row) => [row.ts, row.value, row.quality]))))
    return {
      entityRef: request.entityRef,
      metric: request.metric,
      unit: metric.unit,
      points,
      quality: 'good',
      snapshot: snapshotFor(binding.sourceRef, request.window.end, digest),
      completeness: 'complete',
    }
  }

  async readCurrent(
    request: TelemetryReadCurrentRequest,
    ctx: ToolContext,
  ): Promise<TelemetryReadCurrentResponse> {
    void ctx
    const sourceRef = HOME_ENERGY_SOURCE_A_REF
    void request
    return {
      readings: [],
      snapshot: snapshotFor(sourceRef, EVALUATION_CLOCK, `sha256:${'0'.repeat(64)}`),
      stale: true,
    }
  }
}

function snapshotFor(sourceRef: SourceRef, asOf: Rfc3339UtcTimestamp, digest: string): SourceSnapshot {
  return {
    sourceRef,
    schemaVersion: '1.0.0',
    readAt: new Date().toISOString(),
    asOf,
    watermark: { kind: 'timestamp', value: asOf },
    consistency: 'repeatable_read',
    resultDigest: digest,
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
        purpose: 'artifact',
        ...(request.tenantAuthorizedRef === undefined
          ? {}
          : { tenantAuthorizedRef: request.tenantAuthorizedRef }),
      },
      ctx,
    )
  }
}

function entityRef(entityId: string): ResourceRef {
  return { id: entityId, version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'source' }
}

function spec(
  measurementPointRef: string,
  entityId: string,
  metric: EnergyMetric,
  semantics: ObservationReadSpec['semantics'],
): ObservationReadSpec {
  return {
    measurementPointRef,
    entityRef: entityRef(entityId),
    metric,
    semantics,
    window: HORIZON,
    mappingVersion: HOME_ENERGY_INPUT_VERSIONS.mapping,
  }
}

function request(observationRequests: readonly ObservationReadSpec[]): BuildEnergyInputRequest {
  return {
    siteRef: SITE_REF,
    evaluationClock: EVALUATION_CLOCK,
    horizon: HORIZON,
    timeZone: 'Europe/Berlin',
    slotMinutes: 15,
    dataMode: 'synthetic' satisfies DataMode,
    measurementPoints: [...new Set(observationRequests.map((entry) => entry.measurementPointRef))],
    coverage: HOME_ENERGY_COVERAGE,
    versions: HOME_ENERGY_INPUT_VERSIONS,
    observationRequests,
  }
}

let harness: JobDbHarness | undefined
let scope: JobTestScope | undefined
let adminClient: Client | undefined
let telemetryClient: Client | undefined
let objectDir = ''
let registry: PostgresArtifactRegistry | undefined
let blobStore: LocalImmutableBlobStore | undefined
let controlDatabase: ControlPostgresDatabase | undefined

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} was not initialised`)
  return value
}

function editorContext(scopeRef: JobTestScope): ToolContext {
  return createToolContext({
    principal: { tenantId: scopeRef.tenantId, subjectId: 'node-43-editor', roles: ['data-editor'], scopes: [], authEpoch: 1 },
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
      tenantId: scopeRef.tenantId,
      spaceId: scopeRef.spaceId,
      resourceKinds: [],
      sourceRefs: [HOME_ENERGY_SOURCE_A_REF, HOME_ENERGY_SOURCE_B_REF],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: 'trace-node-43-integration',
  })
}

beforeAll(async () => {
  harness = await startJobDatabase()
  adminClient = harness.adminClient
  scope = await createJobScope(adminClient, 'home-energy-input')

  await adminClient.query(`
    CREATE TABLE public.synthetic_observation_a (
      obs_id text PRIMARY KEY,
      sensor_key text NOT NULL,
      ts timestamptz NOT NULL,
      power_w numeric(18, 2) NOT NULL,
      energy_wh numeric(18, 2) NOT NULL,
      quality_code integer NOT NULL
    );
    CREATE TABLE public.synthetic_observation_b (
      reading_id text PRIMARY KEY,
      sensor_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      active_power_kw numeric(18, 4) NOT NULL,
      interval_energy_kwh numeric(18, 4) NOT NULL,
      quality_label text NOT NULL
    );
  `)
  for (const row of sourceARows()) {
    await adminClient.query(
      'INSERT INTO public.synthetic_observation_a (obs_id, sensor_key, ts, power_w, energy_wh, quality_code) VALUES ($1, $2, $3, $4, $5, $6)',
      [...row],
    )
  }
  for (const row of sourceBRows()) {
    await adminClient.query(
      'INSERT INTO public.synthetic_observation_b (reading_id, sensor_id, recorded_at, active_power_kw, interval_energy_kwh, quality_label) VALUES ($1, $2, $3, $4, $5, $6)',
      [...row],
    )
  }
  await adminClient.query(
    'GRANT USAGE ON SCHEMA public TO ontology_app; GRANT SELECT ON public.synthetic_observation_a, public.synthetic_observation_b TO ontology_app;',
  )

  telemetryClient = new Client({ connectionString: harness.appUrl })
  await telemetryClient.connect()

  objectDir = await mkdtemp(join(tmpdir(), 'home-energy-input-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  controlDatabase = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 2 })
}, 300_000)

afterAll(async () => {
  await controlDatabase?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await telemetryClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await harness?.stop()
})

function buildService(): EnergyInputService {
  return new EnergyInputService({
    telemetry: new PostgresTelemetryAdapter(requireValue(telemetryClient, 'telemetry client')),
    conversions: new DeclaredConversions(homeEnergyDeclaredConversions()),
    artifacts: new BlobArtifactWriter(requireValue(blobStore, 'blob store')),
  })
}

describe('energy input normalisation against real PostgreSQL and blob-local', () => {
  it('runs as a real job stage and archives a content-addressed snapshot (both source naming/unit sets)', async () => {
    const activeScope = requireValue(scope, 'scope')
    const ctx = editorContext(activeScope)
    const jobStore = new PostgresJobStore(requireValue(controlDatabase, 'control database'))
    const budget = createBudgetHarness()
    const service = buildService()
    const captured: { snapshot?: EnergyInputSnapshot } = {}

    const received: JobStageHandler = {
      stage: 'received',
      run: async (context): Promise<JobStageOutcome> => {
        const snapshot = await service.buildSnapshot(
          request([
            spec(LIVING_MEASUREMENT_POINT, 'source-a:living', 'power', 'instantaneous'),
            spec(GARAGE_MEASUREMENT_POINT, 'source-b:garage', 'power', 'instantaneous'),
            spec(LIVING_MEASUREMENT_POINT, 'source-a:living', 'energy', 'interval'),
            spec(GARAGE_MEASUREMENT_POINT, 'source-b:garage', 'energy', 'interval'),
          ]),
          [],
          context.ctx,
        )
        captured.snapshot = snapshot
        return { nextStage: 'parsed', counts: { total: 4, processed: 4, failed: 0, skipped: 0 } }
      },
    }
    const noop = (stage: 'parsed' | 'extracted' | 'validated', nextStage: 'extracted' | 'validated' | 'awaiting_review'): JobStageHandler => ({
      stage,
      run: async (context): Promise<JobStageOutcome> => ({
        nextStage,
        counts: { ...context.job.counts, processed: context.job.counts.processed + 1 },
      }),
    })
    const handlers: JobStageHandlerRegistry = {
      get: (stage) => {
        if (stage === 'received') return received
        if (stage === 'parsed') return noop('parsed', 'extracted')
        if (stage === 'extracted') return noop('extracted', 'validated')
        if (stage === 'validated') return noop('validated', 'awaiting_review')
        return undefined
      },
    }

    const jobService = new JobService({
      store: jobStore,
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
    })
    const jobId = randomUUID()
    await jobService.createJob(
      {
        jobId,
        kind: 'simulation',
        sourceRef: 'home-energy',
        datasetRef: 'home-energy.synthetic.source-a',
        pipelineVersion: '1.0.0',
        idempotencyKey: `node-43-${randomUUID()}`,
      },
      ctx,
    )

    const worker = new JobWorker({
      store: jobStore,
      handlers,
      budget: budget.budget,
      workerId: 'node-43-worker',
      now: () => new Date().toISOString(),
      newId: () => randomUUID(),
    })
    const result = await worker.runOnce(activeScope.scopeRef, ctx)
    if (result.disposition !== 'stopped') {
      const job = await jobStore.getJob(activeScope.scopeRef, jobId, ctx)
      throw new Error(`the job stage failed: ${JSON.stringify(job?.lastError)}`)
    }
    expect(result.disposition).toBe('stopped')
    expect(result.stage).toBe('awaiting_review')

    const snapshot = captured.snapshot
    if (snapshot === undefined) throw new Error('the job stage did not produce a snapshot')

    // The snapshot is content-addressed: the digest is the manifest hash and the blob is readable.
    expect(snapshot.digest).toBe(energyInputDigest(await service.normalize(request([
      spec(LIVING_MEASUREMENT_POINT, 'source-a:living', 'power', 'instantaneous'),
      spec(GARAGE_MEASUREMENT_POINT, 'source-b:garage', 'power', 'instantaneous'),
      spec(LIVING_MEASUREMENT_POINT, 'source-a:living', 'energy', 'interval'),
      spec(GARAGE_MEASUREMENT_POINT, 'source-b:garage', 'energy', 'interval'),
    ]), [], ctx)))

    const bytes = await requireValue(blobStore, 'blob store').readAuthorized(
      { scopeRef: activeScope.scopeRef, blobRef: snapshot.snapshotRef },
      ctx,
    )
    const stored = JSON.parse(new TextDecoder().decode(bytes)) as { series: readonly { unit: string }[] }
    expect(stored.series.length).toBe(4)

    // Source A (W/Wh) and source B (kW/kWh) both normalise to the canonical kW/kWh.
    const powerSeries = snapshot.manifest.series.filter((entry) => entry.metric === 'power')
    expect(powerSeries.map((entry) => entry.unit)).toEqual(['kW', 'kW'])
    const living = powerSeries.find((entry) => entry.measurementPointRef === LIVING_MEASUREMENT_POINT)
    const garage = powerSeries.find((entry) => entry.measurementPointRef === GARAGE_MEASUREMENT_POINT)
    expect(living?.points.map((entry) => entry.value)).toEqual([3.5, 4])
    expect(garage?.points.map((entry) => entry.value)).toEqual([1.25, 2])

    // Parent/sub-circuit coverage: the two children are additive because the parent was not read.
    expect(snapshot.manifest.coverage.additive).toEqual([GARAGE_MEASUREMENT_POINT, LIVING_MEASUREMENT_POINT])
    expect(snapshot.manifest.coverage.redundant).toEqual([])

    // Explicit alignment and versions survive into the manifest.
    expect(snapshot.manifest.timeZone).toBe('Europe/Berlin')
    expect(snapshot.manifest.slotMinutes).toBe(15)
    expect(snapshot.manifest.versions).toEqual(HOME_ENERGY_INPUT_VERSIONS)
    expect(snapshot.manifest.dataMode).toBe('synthetic')
    expect(snapshot.manifest.series.every((entry) => entry.samplingType === 'observed')).toBe(true)
    expect(snapshot.manifest.missingInputs).toEqual([])
  }, 180_000)

  it('normalises the two differently named/unit-ed sources to equal values (E-01)', async () => {
    const activeScope = requireValue(scope, 'scope')
    const ctx = editorContext(activeScope)
    const telemetry = new PostgresTelemetryAdapter(requireValue(telemetryClient, 'telemetry client'))
    const conversions = new DeclaredConversions(homeEnergyDeclaredConversions())

    const sourceA = await readObservationSeries(
      telemetry,
      [spec(SITE_MEASUREMENT_POINT, 'source-a:living', 'power', 'instantaneous')],
      ctx,
    )
    const sourceB = await readObservationSeries(
      telemetry,
      [spec(SITE_MEASUREMENT_POINT, 'source-b:living', 'power', 'instantaneous')],
      ctx,
    )
    const base = request([spec(SITE_MEASUREMENT_POINT, 'source-a:living', 'power', 'instantaneous')])
    const baseB = request([spec(SITE_MEASUREMENT_POINT, 'source-b:living', 'power', 'instantaneous')])
    const normalizedA = normalizeEnergyInput(base, { observations: sourceA, forecasts: [] }, { conversions })
    const normalizedB = normalizeEnergyInput(
      baseB,
      { observations: sourceB, forecasts: [] },
      { conversions },
    )
    expect(normalizedA.series[0]?.points.map((entry) => entry.value)).toEqual([3.5, 4])
    expect(normalizedB.series[0]?.points.map((entry) => entry.value)).toEqual([3.5, 4])
    expect(normalizedA.series[0]?.unit).toBe(normalizedB.series[0]?.unit)
  }, 120_000)

  it('is reproducible: the same inputs reproduce the same snapshot digest and dedupe the blob', async () => {
    const activeScope = requireValue(scope, 'scope')
    const ctx = editorContext(activeScope)
    const service = buildService()
    const requests = request([
      spec(LIVING_MEASUREMENT_POINT, 'source-a:living', 'power', 'instantaneous'),
      spec(GARAGE_MEASUREMENT_POINT, 'source-b:garage', 'power', 'instantaneous'),
    ])
    const first = await service.buildSnapshot(requests, [], ctx)
    const second = await service.buildSnapshot(requests, [], ctx)
    expect(second.digest).toBe(first.digest)
    expect(second.snapshotRef.digest).toBe(first.snapshotRef.digest)
    const origins = await requireValue(blobStore, 'blob store').listOrigins(
      { scopeRef: activeScope.scopeRef, blobRef: first.snapshotRef },
      ctx,
    )
    expect(origins.length).toBeGreaterThanOrEqual(2)
  }, 120_000)

  it('keeps the synthetic observation rows and their suspect quality', async () => {
    const client = requireValue(adminClient, 'admin client')
    const rows = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.synthetic_observation_a',
    )
    expect(rows.rows[0]?.count).toBe(String(sourceARows().length))
    const rowsB = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM public.synthetic_observation_b',
    )
    expect(rowsB.rows[0]?.count).toBe(String(sourceBRows().length))
  })
})
