import { describe, expect, it } from 'vitest'
import { fixtureSetDigest, loadFixtures } from '../fixtures/semantic/loader'
import { evaluateGoldSet, fixturesForGoldSet, groupGoldSet, splitForFixture } from './gold-set'
import { buildCallCounts, buildDegradation, buildGoldSetCoverage, evaluateTarget, REQUIRED_REPORT_FIELDS } from './report'
import { formatRate, rate, rateValue, summarizeLatencies } from './metrics'

const fixtures = loadFixtures()
const goldSet = groupGoldSet(fixtures)
const quality = evaluateGoldSet(fixtures)

describe('LOCAL-050 development / held-out source grouping', () => {
  it('splits the whole gold corpus into two disjoint fixture groups', () => {
    const development = new Set(goldSet.development.fixtureIds)
    const heldOut = new Set(goldSet.heldOut.fixtureIds)
    expect(development.size + heldOut.size).toBe(goldSet.totalFixtures)
    expect(goldSet.totalFixtures).toBe(fixtures.length)
    for (const id of development) expect(heldOut.has(id)).toBe(false)
  })

  it('reports the source identities of each group and any namespace shared by both', () => {
    expect(goldSet.development.sources.length).toBeGreaterThan(0)
    expect(goldSet.heldOut.sources.length).toBeGreaterThan(0)
    for (const source of [...goldSet.development.sources, ...goldSet.heldOut.sources]) {
      expect(source.namespace.length).toBeGreaterThan(0)
      expect(source.sourceId.length).toBeGreaterThan(0)
    }
    // The corpus legitimately reuses the `ha-anker` namespace across scenarios; the overlap is
    // reported instead of being silently dropped.
    for (const shared of goldSet.sharedSources) {
      expect(goldSet.development.sources.some((s) => s.sourceId === shared.sourceId)).toBe(true)
      expect(goldSet.heldOut.sources.some((s) => s.sourceId === shared.sourceId)).toBe(true)
    }
  })

  it('assigns a fixture to exactly one split deterministically', () => {
    for (const fixture of fixtures) {
      const split = splitForFixture(fixture.fixtureId)
      const listed = split === 'development' ? goldSet.development : goldSet.heldOut
      expect(listed.fixtureIds).toContain(fixture.fixtureId)
    }
    expect(groupGoldSet(fixtures).development.fixtureIds).toEqual(goldSet.development.fixtureIds)
  })
})

describe('LOCAL-050 correctness denominator', () => {
  it('evaluates the real rule evaluator over every gold conclusion with an explicit denominator', () => {
    const expectedConclusions = fixtures.reduce(
      (total, fixture) =>
        total + fixture.expected.views.reduce((count, view) => count + view.conclusions.length, 0),
      0,
    )
    expect(quality.cases).toHaveLength(expectedConclusions)
    // The evaluator is only held to the rule-bearing fixtures; the assertion-only projection
    // expectations are reported separately with their own denominator, never dropped.
    expect(quality.overall.denominator + quality.notRuleEvaluable.numerator).toBe(
      expectedConclusions,
    )
    expect(quality.notRuleEvaluable.denominator).toBe(expectedConclusions)
    expect(quality.bySplit.development.denominator + quality.bySplit.held_out.denominator).toBe(
      quality.overall.denominator,
    )
    // A denominator without its numerator is not reportable: both are present.
    expect(quality.overall.numerator).toBeLessThanOrEqual(quality.overall.denominator)
    expect(quality.fixturesEvaluated).toBe(fixtures.length)
  })

  it('is correct on the whole corpus, and the held-out group is scored on its own population', () => {
    expect(quality.overall.numerator).toBe(quality.overall.denominator)
    expect(quality.bySplit.held_out.denominator).toBeGreaterThan(0)
    expect(quality.bySplit.held_out.numerator).toBe(quality.bySplit.held_out.denominator)
    expect(formatRate(quality.overall)).toContain(`/${String(quality.overall.denominator)}`)
  })

  it('keeps the held-out fixtures out of the development group', () => {
    const { development, heldOut } = fixturesForGoldSet(goldSet, fixtures)
    expect(development.length).toBe(goldSet.development.fixtureIds.length)
    expect(heldOut.length).toBe(goldSet.heldOut.fixtureIds.length)
    const developmentIds = new Set(development.map((fixture) => fixture.fixtureId))
    for (const fixture of heldOut) expect(developmentIds.has(fixture.fixtureId)).toBe(false)
  })
})

describe('LOCAL-050 report fields and honest misses', () => {
  it('exposes every field SPEC §9 requires', () => {
    expect(REQUIRED_REPORT_FIELDS).toEqual([
      'dataScale',
      'hardware',
      'cacheState',
      'quality',
      'verification',
      'callCounts',
      'degradation',
      'latencies',
      'resourceUsage',
      'failureBoundaries',
      'targets',
    ])
  })

  it('records a simulated target miss as a miss with its bottleneck, not as a pass', () => {
    const missed = evaluateTarget({
      name: 'local-tool-query-p95',
      description: 'local tool query P95',
      metric: 'p95',
      target: 2000,
      unit: 'ms',
      measured: 3500,
      samples: 12,
      bottleneck: 'unindexed scan of the synthetic telemetry table',
    })
    expect(missed.met).toBe(false)
    expect(missed.bottleneck).toBe('unindexed scan of the synthetic telemetry table')
    expect(missed.measured).toBe(3500)
  })

  it('refuses to record a miss without a bottleneck and marks an unmeasured target as a miss', () => {
    expect(() =>
      evaluateTarget({
        name: 'control-api-p95',
        description: 'control API P95',
        metric: 'p95',
        target: 500,
        unit: 'ms',
        measured: 900,
        samples: 5,
        bottleneck: undefined,
      }),
    ).toThrow(/without a recorded bottleneck/)

    const unmeasured = evaluateTarget({
      name: 'simulation-p95',
      description: 'simulation P95',
      metric: 'p95',
      target: 2000,
      unit: 'ms',
      measured: undefined,
      samples: 0,
      bottleneck: 'the simulation fixture was not run in this process',
    })
    expect(unmeasured.met).toBe(false)
  })

  it('keeps the source and adapter coverage when a target is missed', () => {
    const coverage = buildGoldSetCoverage(
      goldSet,
      fixtureSetDigest(fixtures),
      ['adapter-control-postgres', 'adapter-transport-mcp', 'adapter-data-duckdb'],
    )
    expect(coverage.sources.length).toBeGreaterThan(0)
    expect(coverage.adapters).toContain('adapter-control-postgres')
    // A miss never removes a source or an adapter from the report.
    expect(coverage.adapters).toHaveLength(3)
    expect(coverage.sources.length).toBeGreaterThanOrEqual(goldSet.totalSources)
  })

  it('carries call-count and degradation denominators', () => {
    const calls = buildCallCounts([
      { tool: 'data_query', calls: 6 },
      { tool: 'ontology_lookup', calls: 3 },
      { tool: 'document_search', calls: 1 },
    ])
    expect(calls.attempted).toBe(10)
    expect(calls.shares.find((entry) => entry.tool === 'data_query')?.share).toEqual({
      numerator: 6,
      denominator: 10,
    })

    const degradation = buildDegradation(
      [
        { reason: 'budget_exhausted', count: 2 },
        { reason: 'source_unavailable', count: 1 },
      ],
      12,
    )
    expect(degradation.degraded).toEqual({ numerator: 3, denominator: 12 })
    expect(rateValue(degradation.degraded)).toBeCloseTo(0.25)
  })

  it('summarises latencies with the sample count attached', () => {
    const summary = summarizeLatencies([10, 20, 30, 40, 100])
    expect(summary.samples).toBe(5)
    expect(summary.p50Ms).toBe(30)
    expect(summary.p95Ms).toBe(100)
    expect(summary.maxMs).toBe(100)
  })

  it('rejects an impossible rate instead of reporting it', () => {
    expect(() => rate(3, 2)).toThrow(/invalid rate/)
  })
})
