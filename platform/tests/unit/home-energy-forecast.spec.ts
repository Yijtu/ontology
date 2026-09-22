import { describe, expect, it } from 'vitest'
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
  SourceRef,
  TelemetryPort,
  TelemetryReadCurrentRequest,
  TelemetryReadCurrentResponse,
  TelemetryReadSeriesRequest,
  TelemetryReadSeriesResponse,
  TimeWindow,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  DeclaredConversions,
  EnergyInputService,
  energyInputDigest,
  readForecastSeries,
  sha256DigestOf,
} from '@ontology/extension-home-energy'
import type {
  BuildEnergyInputRequest,
  EnergyMetric,
  ForecastReadSpec,
  NormalizedEnergyInput,
} from '@ontology/extension-home-energy'
import {
  HOME_ENERGY_FORECAST_MODEL_VERSION,
  HOME_ENERGY_INPUT_VERSIONS,
  HOME_ENERGY_SOURCE_A_REF,
  homeEnergyDeclaredConversions,
  sourceSnapshot,
} from '../fixtures/home-energy'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const CTX: ToolContext = createToolContext({
  principal: { tenantId: TENANT, subjectId: 'node-66-unit', roles: ['business-user'], scopes: [], authEpoch: 1 },
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
  traceId: 'trace-node-66-unit',
})

const SITE_REF: ResourceRef = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'dataset',
}

const FORECAST_TARGET: TimeWindow = {
  start: '2026-01-01T00:00:00Z',
  end: '2026-01-01T01:00:00Z',
}

const CONVERSIONS = new DeclaredConversions(homeEnergyDeclaredConversions())

const FORECAST_CAPABILITY: Capability = {
  name: 'forecast_read',
  version: '1.0.0',
  limits: { maxRows: 100_000, maxBytes: 1_048_576, maxDurationMs: 5_000 },
  consistency: 'read_time',
  cancellation: 'unsupported',
  pagination: 'none',
  supportedDataTypes: ['decimal', 'timestamp'],
}

interface ForecastRecord {
  readonly entityId: string
  readonly metric: EnergyMetric
  readonly unit: string
  readonly issuedAt: string
  readonly targetWindow: TimeWindow
  readonly method: string
  readonly assumptions: readonly string[]
  readonly modelVersion: VersionRef
  readonly points: readonly { targetTime: string; value?: string; quality: 'good' | 'missing' | 'unknown' }[]
  readonly sourceRef: SourceRef
  readonly resultDigest: string
}

/**
 * A controlled forecast backend. `honorAsOf` false models a misbehaving backend that leaks a
 * forecast issued after the requested as-of, so the normaliser's own no-leak check can be proven.
 */
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
      unit: chosen.unit,
      issuedAt: chosen.issuedAt,
      targetWindow: chosen.targetWindow,
      method: chosen.method,
      assumptions: [...chosen.assumptions],
      modelVersion: chosen.modelVersion,
      points: chosen.points.map((point) => ({
        targetTime: point.targetTime,
        ...(point.value === undefined ? {} : { value: { amount: point.value, unit: chosen.unit } }),
        quality: point.quality,
      })),
      quality: 'good',
      snapshot: sourceSnapshot(chosen.sourceRef, request.asOf, chosen.issuedAt, chosen.resultDigest),
      completeness: 'complete',
    }
  }
}

class EmptyTelemetryPort implements TelemetryPort {
  async readSeries(
    request: TelemetryReadSeriesRequest,
  ): Promise<TelemetryReadSeriesResponse> {
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

  async readCurrent(
    request: TelemetryReadCurrentRequest,
  ): Promise<TelemetryReadCurrentResponse> {
    void request
    return {
      readings: [],
      snapshot: sourceSnapshot(HOME_ENERGY_SOURCE_A_REF, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'e'),
      stale: true,
    }
  }
}

class InMemoryArtifactWriter implements ImmutableArtifactWriter {
  readonly objects = new Map<string, Uint8Array>()

  async putBytes(request: ArtifactWriteRequest, ctx: ToolContext): Promise<BlobPutImmutableResponse> {
    void ctx
    const digest = sha256DigestOf(request.content)
    this.objects.set(digest, request.content)
    return {
      blobRef: { id: '00000000-0000-4000-8000-000000000001', version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest },
    }
  }
}

function forecastRecord(overrides: Partial<ForecastRecord> = {}): ForecastRecord {
  return {
    entityId: 'source-a:load',
    metric: 'power',
    unit: 'kW',
    issuedAt: '2026-01-01T00:00:00Z',
    targetWindow: FORECAST_TARGET,
    method: 'persistence',
    assumptions: ['clear-sky'],
    modelVersion: HOME_ENERGY_FORECAST_MODEL_VERSION,
    points: [
      { targetTime: '2026-01-01T00:00:00Z', value: '4.0', quality: 'good' },
      { targetTime: '2026-01-01T00:15:00Z', value: '5.0', quality: 'good' },
    ],
    sourceRef: HOME_ENERGY_SOURCE_A_REF,
    resultDigest: `sha256:${'d'.repeat(64)}`,
    ...overrides,
  }
}

function forecastSpec(): ForecastReadSpec {
  return {
    measurementPointRef: 'mp-site',
    entityRef: { id: 'source-a:load', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'source' },
    metric: 'power',
    targetWindow: FORECAST_TARGET,
    mappingVersion: HOME_ENERGY_INPUT_VERSIONS.mapping,
    expectedUnit: 'kW',
  }
}

function request(overrides: Partial<BuildEnergyInputRequest> = {}): BuildEnergyInputRequest {
  return {
    siteRef: SITE_REF,
    evaluationClock: '2026-01-01T01:00:00Z',
    horizon: FORECAST_TARGET,
    timeZone: 'UTC',
    slotMinutes: 15,
    dataMode: 'forecast',
    measurementPoints: [],
    coverage: [],
    versions: HOME_ENERGY_INPUT_VERSIONS,
    observationRequests: [],
    forecastRequests: [],
    ...overrides,
  }
}

function service(forecast?: ForecastPort): EnergyInputService {
  return new EnergyInputService({
    telemetry: new EmptyTelemetryPort(),
    conversions: CONVERSIONS,
    artifacts: new InMemoryArtifactWriter(),
    ...(forecast === undefined ? {} : { forecast }),
  })
}

describe('forecast reading through ForecastPort (E1, E-09)', () => {
  it('maps a port response into a forecast series, preserving version and validity semantics', async () => {
    const port = new ControlledForecastPort([forecastRecord()])
    const series = await readForecastSeries(port, [forecastSpec()], '2026-01-01T01:00:00Z', CTX)

    expect(series).toHaveLength(1)
    const forecast = series[0]
    expect(forecast?.metric).toBe('power')
    expect(forecast?.unit).toBe('kW')
    expect(forecast?.issuedAt).toBe('2026-01-01T00:00:00Z')
    expect(forecast?.targetInterval).toEqual(FORECAST_TARGET)
    expect(forecast?.method).toBe('persistence')
    expect(forecast?.assumptions).toEqual(['clear-sky'])
    expect(forecast?.modelVersion).toEqual(HOME_ENERGY_FORECAST_MODEL_VERSION)
    expect(forecast?.sourceSnapshot.consistency).toBe('repeatable_read')
    expect(forecast?.sourceSnapshot.asOf).toBe('2026-01-01T00:00:00Z')
    expect(forecast?.points.map((point) => point.value)).toEqual([4, 5])
  })

  it('passes the evaluation clock as the as-of bound to the port', async () => {
    const port = new ControlledForecastPort([forecastRecord()])
    await readForecastSeries(port, [forecastSpec()], '2026-01-01T01:00:00Z', CTX)
    expect(port.calls).toHaveLength(1)
    expect(port.calls[0]?.asOf).toBe('2026-01-01T01:00:00Z')
    expect(port.calls[0]?.targetWindow).toEqual(FORECAST_TARGET)
  })

  it('normalises an as-of forecast through the service and preserves issue time and version', async () => {
    const port = new ControlledForecastPort([forecastRecord()])
    const input = await service(port).normalize(
      request({ forecastRequests: [forecastSpec()] }),
      CTX,
    )

    expect(input.forecastOutcome).toBe('ok')
    const forecasts = input.series.filter((entry) => entry.samplingType === 'forecast')
    expect(forecasts).toHaveLength(1)
    expect(forecasts[0]?.issuedAt).toBe('2026-01-01T00:00:00Z')
    expect(forecasts[0]?.validityWindow).toEqual(FORECAST_TARGET)
    expect(forecasts[0]?.modelVersion).toEqual(HOME_ENERGY_FORECAST_MODEL_VERSION)
    expect(forecasts[0]?.points.map((point) => point.value)).toEqual([4, 5, undefined, undefined])
    expect(input.missingInputs).toEqual([])
  })

  it('drops a forecast issued after the evaluation clock even when the port leaks it', async () => {
    const port = new ControlledForecastPort(
      [
        forecastRecord({ issuedAt: '2026-01-01T00:00:00Z' }),
        forecastRecord({ issuedAt: '2026-01-02T00:00:00Z', resultDigest: `sha256:${'f'.repeat(64)}` }),
      ],
      false,
    )
    const input = await service(port).normalize(
      request({ forecastRequests: [forecastSpec()] }),
      CTX,
    )

    // The leaky backend returned the later forecast; the normaliser refused to leak the future.
    expect(port.calls).toHaveLength(1)
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

  it('honours the as-of bound at the port: a forecast issued after as-of is not returned', async () => {
    const port = new ControlledForecastPort([
      forecastRecord({ issuedAt: '2026-01-01T00:00:00Z' }),
      forecastRecord({ issuedAt: '2026-01-02T00:00:00Z' }),
    ])
    const input = await service(port).normalize(
      request({ evaluationClock: '2026-01-01T01:00:00Z', forecastRequests: [forecastSpec()] }),
      CTX,
    )
    const forecasts = input.series.filter((entry) => entry.samplingType === 'forecast')
    expect(forecasts.map((entry) => entry.issuedAt)).toEqual(['2026-01-01T00:00:00Z'])
  })
})

describe('not_configured is explicit, never a fabricated forecast (E1)', () => {
  it('reports not_configured when a forecast is requested but no backend exists', async () => {
    const input = await service().normalize(
      request({ forecastRequests: [forecastSpec()] }),
      CTX,
    )

    expect(input.forecastOutcome).toBe('not_configured')
    expect(input.series.filter((entry) => entry.samplingType === 'forecast')).toEqual([])
    expect(input.missingInputs).toEqual([
      {
        measurementPointRef: 'mp-site',
        metric: 'power',
        purpose: 'forecast',
        reason: 'forecast_not_configured',
      },
    ])
  })

  it('does not report not_configured when no forecast was requested', async () => {
    const input = await service().normalize(request({ forecastRequests: [] }), CTX)
    expect(input.forecastOutcome).toBe('ok')
    expect(input.missingInputs).toEqual([])
  })

  it('distinguishes a configured-but-empty backend from not_configured', async () => {
    const port = new ControlledForecastPort([])
    const input = await service(port).normalize(
      request({ forecastRequests: [forecastSpec()] }),
      CTX,
    )
    expect(input.forecastOutcome).toBe('ok')
    expect(input.series.filter((entry) => entry.samplingType === 'forecast')).toHaveLength(1)
    expect(input.missingInputs).toEqual([
      { measurementPointRef: 'mp-site', metric: 'power', purpose: 'forecast', reason: 'no_samples' },
    ])
  })
})

describe('deterministic forecast snapshots', () => {
  it('reproduces the same digest for identical forecast inputs', async () => {
    const build = async (): Promise<NormalizedEnergyInput> =>
      service(new ControlledForecastPort([forecastRecord()])).normalize(
        request({ forecastRequests: [forecastSpec()] }),
        CTX,
      )
    const first = await build()
    const second = await build()
    expect(energyInputDigest(first)).toBe(energyInputDigest(second))
  })

  it('produces a different digest for not_configured than for a real forecast', async () => {
    const configured = await service(new ControlledForecastPort([forecastRecord()])).normalize(
      request({ forecastRequests: [forecastSpec()] }),
      CTX,
    )
    const missing = await service().normalize(request({ forecastRequests: [forecastSpec()] }), CTX)
    expect(energyInputDigest(configured)).not.toBe(energyInputDigest(missing))
  })
})
