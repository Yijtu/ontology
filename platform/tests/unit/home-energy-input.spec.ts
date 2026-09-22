import { describe, expect, it } from 'vitest'
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
  NORMALIZATION_VERSION,
  alignSlots,
  assertNonOverlappingCoverage,
  computeCumulativeIntervals,
  energyInputDigest,
  localDayWindow,
  normalizeEnergyInput,
  publishEnergyInputSnapshot,
  resolveCoverage,
  sha256DigestOf,
  sumAcrossAdditivePoints,
  utcOffsetMinutesAt,
} from '@ontology/extension-home-energy'
import type {
  EnergyInputBundle,
  ForecastSeriesInput,
  NormalizeEnergyInputRequest,
  NormalizedEnergyInput,
  ObservationSeriesInput,
  RawTelemetryPoint,
  SeriesSemantics,
} from '@ontology/extension-home-energy'
import {
  DST_TIME_ZONE,
  FALL_BACK_LOCAL_DATE,
  GARAGE_MEASUREMENT_POINT,
  HOME_ENERGY_COVERAGE,
  HOME_ENERGY_CONFLICTING_COVERAGE,
  HOME_ENERGY_INPUT_VERSIONS,
  HOME_ENERGY_SOURCE_A_REF,
  HOME_ENERGY_SOURCE_B_REF,
  LIVING_MEASUREMENT_POINT,
  SITE_MEASUREMENT_POINT,
  SPRING_FORWARD_LOCAL_DATE,
  homeEnergyDeclaredConversions,
  sourceSnapshot,
} from '../fixtures/home-energy'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const CTX: ToolContext = createToolContext({
  principal: { tenantId: TENANT, subjectId: 'node-43-unit', roles: ['business-user'], scopes: [], authEpoch: 1 },
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
    sourceRefs: [],
    collectionRefs: [],
    domains: [],
    maxRows: 1000,
  },
  traceId: 'trace-node-43-unit',
})

const SITE_REF: ResourceRef = {
  id: '11111111-2222-4333-8444-555555555555',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'dataset',
}

const CONVERSIONS = new DeclaredConversions(homeEnergyDeclaredConversions())

function point(
  timestamp: string,
  value: number | undefined,
  quality: TelemetryQuality = 'good',
): RawTelemetryPoint {
  return { timestamp, ...(value === undefined ? {} : { value }), quality }
}

function observation(options: {
  readonly measurementPointRef: string
  readonly metric: ObservationSeriesInput['metric']
  readonly semantics: SeriesSemantics
  readonly unit: string
  readonly points: readonly RawTelemetryPoint[]
  readonly source: 'a' | 'b'
  readonly resetPolicy?: ObservationSeriesInput['resetPolicy']
}): ObservationSeriesInput {
  const sourceRef = options.source === 'a' ? HOME_ENERGY_SOURCE_A_REF : HOME_ENERGY_SOURCE_B_REF
  return {
    measurementPointRef: options.measurementPointRef,
    metric: options.metric,
    semantics: options.semantics,
    unit: options.unit,
    points: options.points,
    sourceRef,
    sourceSnapshot: sourceSnapshot(sourceRef, '2026-01-01T01:00:00Z', '2026-01-01T01:00:00Z', options.source),
    mappingVersion: HOME_ENERGY_INPUT_VERSIONS.mapping,
    ...(options.resetPolicy === undefined ? {} : { resetPolicy: options.resetPolicy }),
  }
}

function request(overrides: Partial<NormalizeEnergyInputRequest> = {}): NormalizeEnergyInputRequest {
  return {
    siteRef: SITE_REF,
    evaluationClock: '2026-01-01T01:00:00Z',
    horizon: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' },
    timeZone: 'UTC',
    slotMinutes: 15,
    dataMode: 'synthetic',
    measurementPoints: [SITE_MEASUREMENT_POINT],
    coverage: [{ measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', coverageRef: 'load:site' }],
    versions: HOME_ENERGY_INPUT_VERSIONS,
    ...overrides,
  }
}

function normalize(
  bundle: EnergyInputBundle,
  overrides: Partial<NormalizeEnergyInputRequest> = {},
): NormalizedEnergyInput {
  return normalizeEnergyInput(request(overrides), bundle, { conversions: CONVERSIONS })
}

describe('DST / slot alignment (E-03, explicit 23h/25h days)', () => {
  it('handles a spring-forward local day as 23 hours / 92 slots', () => {
    const day = localDayWindow(SPRING_FORWARD_LOCAL_DATE, DST_TIME_ZONE, 15)
    expect(day.alignment.horizonHours).toBe(23)
    expect(day.alignment.slotCount).toBe(92)
    expect(day.alignment.offsetChanges).toEqual([{ atSlotIndex: 8, fromMinutes: 60, toMinutes: 120 }])
    expect(day.horizon.start).toBe('2026-03-28T23:00:00.000Z')
    expect(day.horizon.end).toBe('2026-03-29T22:00:00.000Z')
  })

  it('handles a fall-back local day as 25 hours / 100 slots', () => {
    const day = localDayWindow(FALL_BACK_LOCAL_DATE, DST_TIME_ZONE, 15)
    expect(day.alignment.horizonHours).toBe(25)
    expect(day.alignment.slotCount).toBe(100)
    expect(day.alignment.offsetChanges).toEqual([{ atSlotIndex: 12, fromMinutes: 120, toMinutes: 60 }])
  })

  it('resolves the UTC offset at an instant instead of assuming a fixed offset', () => {
    expect(utcOffsetMinutesAt(Date.parse('2026-03-29T00:30:00Z'), DST_TIME_ZONE)).toBe(60)
    expect(utcOffsetMinutesAt(Date.parse('2026-03-29T01:30:00Z'), DST_TIME_ZONE)).toBe(120)
  })

  it('refuses a horizon that is not a whole number of slots', () => {
    expect(() =>
      alignSlots({ start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:20:00Z' }, 'UTC', 15),
    ).toThrowError(expect.objectContaining({ code: 'MISALIGNED_HORIZON' }))
  })

  it('refuses an unknown IANA time zone', () => {
    expect(() => localDayWindow('2026-03-29', 'Mars/Olympus', 15)).toThrowError(
      expect.objectContaining({ code: 'INVALID_TIME_ZONE' }),
    )
  })
})

describe('unit alignment through declared conversions (E-01)', () => {
  it('normalises W and kW to the same canonical kW', () => {
    const pointsA = [
      point('2026-01-01T00:00:00Z', 3500),
      point('2026-01-01T00:15:00Z', 4000),
      point('2026-01-01T00:30:00Z', 2500),
      point('2026-01-01T00:45:00Z', 3000),
    ]
    const pointsB = [
      point('2026-01-01T00:00:00Z', 3.5),
      point('2026-01-01T00:15:00Z', 4.0),
      point('2026-01-01T00:30:00Z', 2.5),
      point('2026-01-01T00:45:00Z', 3.0),
    ]
    const inputA = normalize({
      observations: [
        observation({ measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', semantics: 'instantaneous', unit: 'W', points: pointsA, source: 'a' }),
      ],
      forecasts: [],
    })
    const inputB = normalize({
      observations: [
        observation({ measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', semantics: 'instantaneous', unit: 'kW', points: pointsB, source: 'b' }),
      ],
      forecasts: [],
    })
    const seriesA = inputA.series[0]
    const seriesB = inputB.series[0]
    expect(seriesA?.unit).toBe('kW')
    expect(seriesA?.timeZone).toBe('UTC')
    expect(seriesA?.slotMinutes).toBe(15)
    expect(seriesA?.samplingType).toBe('observed')
    expect(seriesA?.points.map((entry) => entry.value)).toEqual([3.5, 4, 2.5, 3])
    expect(seriesB?.points.map((entry) => entry.value)).toEqual(seriesA?.points.map((entry) => entry.value))
    expect(seriesA?.points).toHaveLength(4)
  })

  it('refuses an undeclared source unit instead of guessing a factor', () => {
    expect(() =>
      normalize({
        observations: [
          observation({ measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', semantics: 'instantaneous', unit: 'MW', points: [point('2026-01-01T00:00:00Z', 0.0035)], source: 'a' }),
        ],
        forecasts: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'UNDECLARED_CONVERSION' }))
  })
})

describe('cumulative meter resets and missing samples (E-03)', () => {
  it('marks a backwards register as reset and never emits a negative or zero amount', () => {
    const input = normalize({
      observations: [
        observation({
          measurementPointRef: SITE_MEASUREMENT_POINT,
          metric: 'energy',
          semantics: 'cumulative',
          unit: 'kWh',
          points: [
            point('2026-01-01T00:00:00Z', 100),
            point('2026-01-01T00:15:00Z', 110),
            point('2026-01-01T00:30:00Z', 5),
            point('2026-01-01T00:45:00Z', 15),
          ],
          source: 'b',
        }),
      ],
      forecasts: [],
    })
    const points = input.series[0]?.points ?? []
    expect(points.map((entry) => entry.status)).toEqual(['unknown', 'ok', 'reset', 'ok'])
    expect(points[0]?.value).toBeUndefined()
    expect(points[1]?.value).toBe(10)
    expect(points[2]?.value).toBeUndefined()
    expect(points[2]?.value).not.toBe(0)
    expect(points[3]?.value).toBe(10)
  })

  it('supports an explicit count_since_reset policy without inventing a negative amount', () => {
    const input = normalize({
      observations: [
        observation({
          measurementPointRef: SITE_MEASUREMENT_POINT,
          metric: 'energy',
          semantics: 'cumulative',
          unit: 'kWh',
          points: [
            point('2026-01-01T00:00:00Z', 100),
            point('2026-01-01T00:15:00Z', 110),
            point('2026-01-01T00:30:00Z', 5),
          ],
          source: 'b',
          resetPolicy: 'count_since_reset',
        }),
      ],
      forecasts: [],
    })
    const reset = input.series[0]?.points[2]
    expect(reset?.status).toBe('reset')
    expect(reset?.value).toBe(5)
  })

  it('keeps missing and unknown samples unknown, never zero', () => {
    const input = normalize({
      observations: [
        observation({
          measurementPointRef: SITE_MEASUREMENT_POINT,
          metric: 'power',
          semantics: 'instantaneous',
          unit: 'kW',
          points: [
            point('2026-01-01T00:00:00Z', 3.5),
            point('2026-01-01T00:15:00Z', undefined, 'missing'),
            point('2026-01-01T00:30:00Z', 2.5, 'unknown'),
            point('2026-01-01T00:45:00Z', 3.0),
          ],
          source: 'b',
        }),
      ],
      forecasts: [],
    })
    const points = input.series[0]?.points ?? []
    expect(points.map((entry) => entry.status)).toEqual(['ok', 'missing', 'unknown', 'ok'])
    expect(points[1]?.value).toBeUndefined()
    expect(points[2]?.value).toBeUndefined()
    expect(points[1]?.quality).toBe('missing')
    expect(points[2]?.quality).toBe('unknown')
  })

  it('breaks the cumulative baseline across a gap so the gap is not attributed to one slot', () => {
    const result = computeCumulativeIntervals(
      [{ value: 100, quality: 'good' }, undefined, { value: 140, quality: 'good' }],
      [
        { startUtc: '2026-01-01T00:00:00Z', endUtc: '2026-01-01T00:15:00Z' },
        { startUtc: '2026-01-01T00:15:00Z', endUtc: '2026-01-01T00:30:00Z' },
        { startUtc: '2026-01-01T00:30:00Z', endUtc: '2026-01-01T00:45:00Z' },
      ],
      'mark_unknown',
    )
    expect(result.intervals.map((entry) => entry.status)).toEqual(['unknown', 'missing', 'missing'])
    expect(result.intervals[2]?.value).toBeUndefined()
    expect(result.missingCount).toBe(3)
  })
})

describe('measurement-point coverage avoids double counting (E-02)', () => {
  it('keeps only the parent additive and marks sub-circuits redundant', () => {
    const plan = resolveCoverage(HOME_ENERGY_COVERAGE, [
      SITE_MEASUREMENT_POINT,
      LIVING_MEASUREMENT_POINT,
      GARAGE_MEASUREMENT_POINT,
    ])
    expect(plan.conflicts).toEqual([])
    expect(plan.additive).toEqual([SITE_MEASUREMENT_POINT])
    expect(plan.redundant).toEqual([
      { measurementPointRef: GARAGE_MEASUREMENT_POINT, coveredBy: SITE_MEASUREMENT_POINT, reason: 'covered_by_parent' },
      { measurementPointRef: LIVING_MEASUREMENT_POINT, coveredBy: SITE_MEASUREMENT_POINT, reason: 'covered_by_parent' },
    ])
  })

  it('sums only the additive parent, so a fixture that would double count does not', () => {
    const input = normalize(
      {
        observations: [
          observation({ measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', semantics: 'instantaneous', unit: 'kW', points: [point('2026-01-01T00:00:00Z', 5.0)], source: 'b' }),
          observation({ measurementPointRef: LIVING_MEASUREMENT_POINT, metric: 'power', semantics: 'instantaneous', unit: 'kW', points: [point('2026-01-01T00:00:00Z', 3.0)], source: 'b' }),
          observation({ measurementPointRef: GARAGE_MEASUREMENT_POINT, metric: 'power', semantics: 'instantaneous', unit: 'kW', points: [point('2026-01-01T00:00:00Z', 2.0)], source: 'b' }),
        ],
        forecasts: [],
      },
      {
        measurementPoints: [SITE_MEASUREMENT_POINT, LIVING_MEASUREMENT_POINT, GARAGE_MEASUREMENT_POINT],
        coverage: HOME_ENERGY_COVERAGE,
      },
    )
    const summed = sumAcrossAdditivePoints(input, 'power', 'observed')
    expect(summed.contributors).toEqual([SITE_MEASUREMENT_POINT])
    expect(summed.perSlot[0]).toBe(5.0)
    // A naive sum would be 10 kW.
    expect(summed.perSlot[0]).not.toBe(10.0)
  })

  it('refuses two measurement points that claim the same coverage', () => {
    const plan = resolveCoverage(HOME_ENERGY_CONFLICTING_COVERAGE, ['mp-a', 'mp-b'])
    expect(plan.conflicts).toEqual([{ coverageRef: 'load:shared', measurementPointRefs: ['mp-a', 'mp-b'] }])
    expect(() => assertNonOverlappingCoverage(plan)).toThrowError(
      expect.objectContaining({ code: 'COVERAGE_CONFLICT' }),
    )
  })
})

describe('SOC conversion only through declared mappings (E-04)', () => {
  it('normalises a declared percentage SOC to a canonical ratio', () => {
    const input = normalize({
      observations: [
        observation({
          measurementPointRef: 'mp-battery',
          metric: 'state_of_charge',
          semantics: 'instantaneous',
          unit: '%',
          points: [point('2026-01-01T00:00:00Z', 50), point('2026-01-01T00:15:00Z', 62.5)],
          source: 'b',
        }),
      ],
      forecasts: [],
    })
    const series = input.series[0]
    expect(series?.unit).toBe('ratio')
    expect(series?.points.map((entry) => entry.value)).toEqual([0.5, 0.625, undefined, undefined])
  })

  it('refuses an undeclared SOC unit', () => {
    expect(() =>
      normalize({
        observations: [
          observation({ measurementPointRef: 'mp-battery', metric: 'state_of_charge', semantics: 'instantaneous', unit: 'counts', points: [point('2026-01-01T00:00:00Z', 5000)], source: 'b' }),
        ],
        forecasts: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'UNDECLARED_SOC_MAPPING' }))
  })

  it('converts SOC to energy only through the declared device mapping', () => {
    expect(CONVERSIONS.socToEnergy('battery-1', 0.5)).toBe(5)
    expect(() => CONVERSIONS.socToEnergy('battery-2', 0.5)).toThrowError(
      expect.objectContaining({ code: 'UNDECLARED_SOC_MAPPING' }),
    )
  })
})

describe('issue time, validity window, versions and no future leakage (E-09)', () => {
  const forecast = (issuedAt: string, targetInterval: { start: string; end: string }): ForecastSeriesInput => ({
    measurementPointRef: SITE_MEASUREMENT_POINT,
    metric: 'power',
    unit: 'kW',
    issuedAt,
    targetInterval,
    method: 'persistence',
    assumptions: ['clear-sky'],
    points: [point(targetInterval.start, 4.0)],
    sourceRef: HOME_ENERGY_SOURCE_A_REF,
    sourceSnapshot: sourceSnapshot(HOME_ENERGY_SOURCE_A_REF, '2026-01-01T00:00:00Z', issuedAt, 'd'),
    mappingVersion: HOME_ENERGY_INPUT_VERSIONS.mapping,
  })

  it('keeps an as-of forecast and drops one issued after the evaluation clock', () => {
    const input = normalize(
      {
        observations: [],
        forecasts: [
          forecast('2026-01-01T00:00:00Z', { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }),
          forecast('2026-01-02T00:00:00Z', { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }),
        ],
      },
      { evaluationClock: '2026-01-01T03:00:00Z', measurementPoints: [], coverage: [] },
    )
    const forecasts = input.series.filter((entry) => entry.samplingType === 'forecast')
    expect(forecasts).toHaveLength(1)
    expect(forecasts[0]?.issuedAt).toBe('2026-01-01T00:00:00Z')
    expect(forecasts[0]?.validityWindow).toEqual({
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T01:00:00Z',
    })
    expect(forecasts[0]?.method).toBe('persistence')
    expect(forecasts[0]?.assumptions).toEqual(['clear-sky'])
    expect(input.missingInputs).toEqual([
      { measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', purpose: 'forecast', reason: 'issued_after_evaluation_clock' },
    ])
  })

  it('preserves the declared spec/price/user-constraint versions in the snapshot manifest', async () => {
    const input = normalize({ observations: [], forecasts: [] })
    const writer = new InMemoryArtifactWriter()
    const snapshot = await publishEnergyInputSnapshot(input, { artifacts: writer }, CTX)
    expect(snapshot.manifest.versions).toEqual(HOME_ENERGY_INPUT_VERSIONS)
    expect(snapshot.manifest.versions.deviceSpec.id).toBe('home-energy.device-spec.battery-1')
    expect(snapshot.manifest.normalizationVersion).toBe(NORMALIZATION_VERSION)
  })
})

describe('deterministic content-addressed snapshot', () => {
  it('reproduces the same digest for identical inputs', () => {
    const bundle: EnergyInputBundle = {
      observations: [
        observation({ measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', semantics: 'instantaneous', unit: 'kW', points: [point('2026-01-01T00:00:00Z', 3.5)], source: 'b' }),
      ],
      forecasts: [],
    }
    const first = normalize(bundle)
    const second = normalize(bundle)
    expect(energyInputDigest(first)).toBe(energyInputDigest(second))
    expect(energyInputDigest(first)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('publishes the manifest content-addressed and detects a digest mismatch', async () => {
    const input = normalize({ observations: [], forecasts: [] })
    const writer = new InMemoryArtifactWriter()
    const snapshot = await publishEnergyInputSnapshot(input, { artifacts: writer }, CTX)
    expect(snapshot.digest).toBe(energyInputDigest(input))
    expect(writer.objects.has(snapshot.digest)).toBe(true)

    const faulty = new WrongDigestWriter()
    await expect(publishEnergyInputSnapshot(input, { artifacts: faulty }, CTX)).rejects.toThrowError(
      expect.objectContaining({ code: 'SNAPSHOT_DIGEST_MISMATCH' }),
    )
  })

  it('keeps the trusted scope on the write request', async () => {
    const writer = new RecordingWriter()
    const input = normalize({ observations: [], forecasts: [] })
    await publishEnergyInputSnapshot(input, { artifacts: writer }, CTX)
    expect(writer.scopeRef).toEqual({ tenantId: TENANT, spaceId: SPACE })
  })
})

class InMemoryArtifactWriter implements ImmutableArtifactWriter {
  readonly objects = new Map<string, Uint8Array>()

  async putBytes(request: ArtifactWriteRequest, ctx: ToolContext): Promise<BlobPutImmutableResponse> {
    void ctx
    const digest = sha256DigestOf(request.content)
    const deduplicated = this.objects.has(digest)
    this.objects.set(digest, request.content)
    return {
      blobRef: { id: '00000000-0000-4000-8000-000000000001', version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest },
      deduplicated,
    }
  }
}

class WrongDigestWriter implements ImmutableArtifactWriter {
  async putBytes(): Promise<BlobPutImmutableResponse> {
    const digest = `sha256:${'0'.repeat(64)}`
    return {
      blobRef: { id: '00000000-0000-4000-8000-000000000002', version: '1.0.0', digest, kind: 'artifact' },
      contentDigest: digest,
      integrity: { algorithm: 'sha256', digest },
    }
  }
}

class RecordingWriter extends InMemoryArtifactWriter {
  scopeRef: ArtifactWriteRequest['scopeRef'] | undefined

  override async putBytes(
    request: ArtifactWriteRequest,
    ctx: ToolContext,
  ): Promise<BlobPutImmutableResponse> {
    this.scopeRef = request.scopeRef
    return super.putBytes(request, ctx)
  }
}

describe('missing inputs are reported, not defaulted', () => {
  it('reports a declared measurement point that was never read', () => {
    const input = normalize({ observations: [], forecasts: [] })
    expect(input.missingInputs).toEqual([
      { measurementPointRef: SITE_MEASUREMENT_POINT, metric: 'power', purpose: 'observation', reason: 'not_read' },
    ])
  })
})
