import { createHash } from 'node:crypto'
import { RuleEvaluator } from '@ontology/semantic-engine'
import type { SemanticFixture } from '../fixtures/semantic/loader'
import { loadFixtures } from '../fixtures/semantic/loader'
import { ruleInputFromFixture } from '../unit/rule-evaluator-fixtures'
import type { Rate } from './metrics'
import { rate } from './metrics'

/**
 * Development / held-out source grouping over the LOCAL-048 gold corpus (V6).
 *
 * The corpus is split at fixture granularity: a fixture is the atomic gold source (one
 * scenario with its own evidence and gold views), so no fixture's sources straddle the two
 * sets. The split is a stable hash of the fixture id, so the same corpus always produces the
 * same groups and the same denominators. Every source namespace/sourceId referenced by a
 * fixture is reported with its group, and any namespace that legitimately appears in both
 * groups is reported as `sharedSources` rather than hidden.
 */
export type GoldSplit = 'development' | 'held_out'

export interface GoldSource {
  readonly namespace: string
  readonly sourceId: string
}

export interface GoldGroup {
  readonly split: GoldSplit
  readonly fixtureIds: readonly string[]
  readonly sources: readonly GoldSource[]
  readonly conclusionCount: number
}

export interface GoldSet {
  readonly development: GoldGroup
  readonly heldOut: GoldGroup
  readonly sharedSources: readonly GoldSource[]
  readonly totalFixtures: number
  readonly totalSources: number
}

export function sourceIdentity(source: GoldSource): string {
  return `${source.namespace}/${source.sourceId}`
}

function sourcesOf(fixture: SemanticFixture): GoldSource[] {
  const seen = new Map<string, GoldSource>()
  for (const assertion of fixture.assertions) {
    const source = { namespace: assertion.sourceRef.namespace, sourceId: assertion.sourceRef.sourceId }
    seen.set(sourceIdentity(source), source)
  }
  return [...seen.values()].sort((left, right) =>
    sourceIdentity(left) < sourceIdentity(right) ? -1 : 1,
  )
}

export function splitForFixture(fixtureId: string): GoldSplit {
  const digest = createHash('sha256').update(fixtureId).digest()
  const first = digest[0] ?? 0
  return first % 2 === 0 ? 'development' : 'held_out'
}

function groupFor(split: GoldSplit, fixtures: readonly SemanticFixture[]): GoldGroup {
  const selected = fixtures.filter((fixture) => splitForFixture(fixture.fixtureId) === split)
  const sourceMap = new Map<string, GoldSource>()
  for (const fixture of selected) {
    for (const source of sourcesOf(fixture)) sourceMap.set(sourceIdentity(source), source)
  }
  const conclusionCount = selected.reduce(
    (total, fixture) =>
      total + fixture.expected.views.reduce((count, view) => count + view.conclusions.length, 0),
    0,
  )
  return {
    split,
    fixtureIds: selected.map((fixture) => fixture.fixtureId).sort(),
    sources: [...sourceMap.values()].sort((left, right) =>
      sourceIdentity(left) < sourceIdentity(right) ? -1 : 1,
    ),
    conclusionCount,
  }
}

export function groupGoldSet(fixtures: readonly SemanticFixture[]): GoldSet {
  const development = groupFor('development', fixtures)
  const heldOut = groupFor('held_out', fixtures)
  const developmentIds = new Set(development.sources.map(sourceIdentity))
  const sharedSources = heldOut.sources.filter((source) => developmentIds.has(sourceIdentity(source)))
  const allSources = new Map<string, GoldSource>()
  for (const fixture of fixtures) {
    for (const source of sourcesOf(fixture)) allSources.set(sourceIdentity(source), source)
  }
  return {
    development,
    heldOut,
    sharedSources,
    totalFixtures: fixtures.length,
    totalSources: allSources.size,
  }
}

export function defaultGoldSet(): GoldSet {
  return groupGoldSet(loadFixtures())
}

export interface ConclusionCase {
  readonly fixtureId: string
  readonly split: GoldSplit
  readonly viewId: string
  readonly propositionKey: string
  readonly expectedStatus: string
  readonly expectedValue: string | undefined
  readonly producedStatus: string | undefined
  readonly producedValue: string | undefined
  /** True when the fixture has a rule, so the rule evaluator is the component under test. */
  readonly evaluable: boolean
  readonly correct: boolean
}

export interface QualityRun {
  readonly cases: readonly ConclusionCase[]
  /** Correct rule conclusions / rule-evaluable conclusions. */
  readonly overall: Rate
  readonly bySplit: Readonly<Record<GoldSplit, Rate>>
  readonly fixturesEvaluated: number
  /**
   * Expected conclusions in assertion-only fixtures. Those scenarios exercise bitemporal
   * projection (LOCAL-033), not the rule evaluator, so they are counted separately with their
   * own denominator instead of being silently dropped or scored against the wrong component.
   */
  readonly notRuleEvaluable: Rate
}

function valueKey(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value)
}

/**
 * Run the real `RuleEvaluator` (LOCAL-032) over every gold view and count correctness against
 * the gold conclusion. The evaluator is the real service; the gold values come from the
 * fixture corpus, never from the evaluator. The denominator is every expected conclusion, and
 * the per-split denominators are kept separate so a held-out miss cannot be hidden by a large
 * development set.
 */
export function evaluateGoldSet(fixtures: readonly SemanticFixture[]): QualityRun {
  const evaluator = new RuleEvaluator()
  const cases: ConclusionCase[] = []
  const counts: Record<GoldSplit, { total: number; correct: number }> = {
    development: { total: 0, correct: 0 },
    held_out: { total: 0, correct: 0 },
  }
  let fixturesEvaluated = 0
  let notEvaluable = 0

  for (const fixture of fixtures) {
    const split = splitForFixture(fixture.fixtureId)
    fixturesEvaluated += 1
    const evaluable = fixture.rules.length > 0
    for (const view of fixture.expected.views) {
      const result = evaluator.evaluate(ruleInputFromFixture(fixture, view.request))
      for (const expected of view.conclusions) {
        const produced = result.conclusions.find(
          (conclusion) => conclusion.propositionKey === expected.propositionKey,
        )
        const expectedValue = valueKey(expected.value)
        const producedValue = valueKey(produced?.value)
        const correct =
          evaluable &&
          produced !== undefined &&
          produced.domainStatus === expected.domainStatus &&
          (expected.value === undefined || producedValue === expectedValue)
        if (evaluable) {
          counts[split].total += 1
          if (correct) counts[split].correct += 1
        } else {
          notEvaluable += 1
        }
        cases.push({
          fixtureId: fixture.fixtureId,
          split,
          viewId: view.viewId,
          propositionKey: expected.propositionKey,
          expectedStatus: expected.domainStatus,
          expectedValue,
          producedStatus: produced?.domainStatus,
          producedValue,
          evaluable,
          correct,
        })
      }
    }
  }

  const overallTotal = counts.development.total + counts.held_out.total
  const overallCorrect = counts.development.correct + counts.held_out.correct
  return {
    cases,
    overall: rate(overallCorrect, overallTotal),
    bySplit: {
      development: rate(counts.development.correct, counts.development.total),
      held_out: rate(counts.held_out.correct, counts.held_out.total),
    },
    fixturesEvaluated,
    notRuleEvaluable: rate(notEvaluable, cases.length),
  }
}

export function fixturesForGoldSet(goldSet: GoldSet, fixtures: readonly SemanticFixture[]): {
  readonly development: readonly SemanticFixture[]
  readonly heldOut: readonly SemanticFixture[]
} {
  const development = new Set(goldSet.development.fixtureIds)
  return {
    development: fixtures.filter((fixture) => development.has(fixture.fixtureId)),
    heldOut: fixtures.filter((fixture) => !development.has(fixture.fixtureId)),
  }
}
