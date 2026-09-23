import { describe, expect, it } from 'vitest'
import type { ControlReadProjectionRequest, ScopeRef, SemanticFilter, VersionRef } from '@ontology/contracts'
import {
  RuleEvaluationError,
  RuleEvaluator,
  qualifiedPropositionKey,
  supportRuleFromPublishedRule,
} from '@ontology/semantic-engine'
import type {
  RuleEvaluationErrorCode,
  RuleEvaluationInput,
  RuleFact,
  RulePremiseGroup,
  SupportRule,
} from '@ontology/semantic-engine'
import { fixturesOfKind, loadFixtures } from '../fixtures/semantic/loader'
import type { SemanticFixture } from '../fixtures/semantic/loader'
import { ruleInputFromFixture } from './rule-evaluator-fixtures'

const evaluator = new RuleEvaluator()
const fixtures = loadFixtures()

const SCOPE: ScopeRef = {
  tenantId: '11111111-2222-4333-8444-555555555555',
  spaceId: '99999999-8888-4777-8666-555555555555',
}

const OTHER_SCOPE: ScopeRef = {
  tenantId: '22222222-3333-4444-8555-666666666666',
  spaceId: '88888888-9999-4777-8666-555555555555',
}

function fixtureOf(kind: SemanticFixture['scenarioKind']): SemanticFixture {
  const fixture = fixturesOfKind(fixtures, kind)[0]
  if (fixture === undefined) throw new Error(`no fixture of kind ${kind}`)
  return fixture
}

function dottedTokens(text: string): string[] {
  return text.match(/[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+/gi) ?? []
}

function versionRef(id: string): VersionRef {
  return { id, version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
}

function expectRuleError(run: () => unknown, code: RuleEvaluationErrorCode): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(RuleEvaluationError)
    if (error instanceof RuleEvaluationError) expect(error.code).toBe(code)
    return
  }
  throw new Error(`expected RuleEvaluationError(${code})`)
}

function baseInput(overrides: Partial<RuleEvaluationInput> = {}): RuleEvaluationInput {
  return {
    scopeRef: SCOPE,
    request: { scopeRef: SCOPE, projectionRef: versionRef('projection.semantic') },
    facts: [],
    rules: [],
    ...overrides,
  }
}

function fact(overrides: Partial<RuleFact> & { readonly assertionId: string }): RuleFact {
  return {
    logicalAssertionId: overrides.assertionId,
    recordedSeq: '1',
    op: 'assert',
    subject: 'site.home-1',
    predicate: 'p',
    validity: { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' },
    sourceRef: { namespace: 'ha-anker', sourceId: overrides.assertionId },
    ...overrides,
  }
}

describe('LOCAL-048 fixture corpus', () => {
  for (const fixture of fixtures) {
    describe(`${fixture.fixtureId} (${fixture.scenarioKind})`, () => {
      for (const view of fixture.expected.views) {
        it(`view ${view.viewId}`, () => {
          const result = evaluator.evaluate(ruleInputFromFixture(fixture, view.request))

          if (fixture.rules.length > 0) {
            expect(result.conclusions).toHaveLength(view.conclusions.length)
            for (const expected of view.conclusions) {
              const produced = result.conclusions.find(
                (conclusion) => conclusion.propositionKey === expected.propositionKey,
              )
              expect(produced, `missing conclusion ${expected.propositionKey}`).toBeDefined()
              if (produced === undefined) continue
              expect(produced.domainStatus).toBe(expected.domainStatus)
              if (expected.value !== undefined) expect(produced.value).toEqual(expected.value)
              if (expected.satisfiedBy !== undefined) {
                const normalize = (entries: readonly { groupId: string; alternativeIds: readonly string[] }[]) =>
                  entries
                    .map((entry) => ({ groupId: entry.groupId, alternativeIds: [...entry.alternativeIds].sort() }))
                    .sort((left, right) => left.groupId.localeCompare(right.groupId))
                expect(normalize(produced.satisfiedBy)).toEqual(normalize(expected.satisfiedBy))
              }
              // Unknown and conflict must never carry a `true` value.
              if (expected.domainStatus === 'unknown' || expected.domainStatus === 'conflict') {
                expect(produced.value).toBeUndefined()
              }
            }

            const expectedConflicts = view.conflicts ?? []
            expect(result.conflicts).toHaveLength(expectedConflicts.length)
            for (const expectedConflict of expectedConflicts) {
              const produced = result.conflicts.find(
                (conflict) => conflict.propositionKey === expectedConflict.propositionKey,
              )
              expect(produced, `missing conflict ${expectedConflict.propositionKey}`).toBeDefined()
              if (produced === undefined) continue
              expect([...produced.assertionIds].sort()).toEqual([...expectedConflict.assertionIds].sort())
            }
          }

          for (const expectedGap of view.gaps ?? []) {
            const tokens = dottedTokens(expectedGap)
            const covered = tokens.some((token) => result.gaps.some((gap) => gap.includes(token)))
            expect(covered, `no produced gap covers "${expectedGap}"`).toBe(true)
          }
        })
      }
    })
  }
})

describe('support semantics', () => {
  it('requires every AND premise group of one derivation', () => {
    const fixture = fixtureOf('and_prerequisites')
    const view = fixture.expected.views[0]
    if (view === undefined) throw new Error('fixture has no view')
    const result = evaluator.evaluate(ruleInputFromFixture(fixture, view.request))
    const conclusion = result.conclusions.find((entry) => entry.propositionKey === 'site.reserve_ready')
    expect(conclusion?.domainStatus).toBe('known')
    expect(conclusion?.value).toBe(true)
    expect(conclusion?.satisfiedBy).toEqual([
      { groupId: 'g-grid', alternativeIds: ['alt-grid'] },
      { groupId: 'g-soc', alternativeIds: ['alt-soc'] },
    ])
  })

  it('keeps a conclusion while an OR alternative support survives a retraction', () => {
    const fixture = fixtureOf('or_alternative_support')
    const before = fixture.expected.views.find((view) => view.viewId === 'before-retraction')
    const after = fixture.expected.views.find((view) => view.viewId === 'current')
    if (before === undefined || after === undefined) throw new Error('fixture is missing a view')

    const beforeResult = evaluator.evaluate(ruleInputFromFixture(fixture, before.request))
    expect(beforeResult.conclusions[0]?.satisfiedBy).toEqual([
      { groupId: 'g-battery', alternativeIds: ['alt-meter', 'alt-nameplate'] },
    ])

    const afterResult = evaluator.evaluate(ruleInputFromFixture(fixture, after.request))
    const conclusion = afterResult.conclusions[0]
    expect(conclusion?.domainStatus).toBe('known')
    expect(conclusion?.value).toBe(true)
    expect(conclusion?.satisfiedBy).toEqual([{ groupId: 'g-battery', alternativeIds: ['alt-meter'] }])
  })

  it('withdraws the conclusion as unknown, never false, after the last support is retracted', () => {
    const fixture = fixtureOf('last_support_retraction')
    const after = fixture.expected.views.find((view) => view.viewId === 'current')
    if (after === undefined) throw new Error('fixture is missing the current view')
    const result = evaluator.evaluate(ruleInputFromFixture(fixture, after.request))
    const conclusion = result.conclusions[0]
    expect(conclusion?.domainStatus).toBe('unknown')
    expect(conclusion?.value).toBeUndefined()
    expect(conclusion?.value).not.toBe(true)
    expect(result.gaps.length).toBeGreaterThan(0)
  })

  it('never coerces unknown or conflict to true', () => {
    const fixture = fixtureOf('unknown_conflict')
    const view = fixture.expected.views[0]
    if (view === undefined) throw new Error('fixture has no view')
    const result = evaluator.evaluate(ruleInputFromFixture(fixture, view.request))

    const capacity = result.conclusions.find(
      (entry) => entry.propositionKey === 'device.installed_capacity_positive',
    )
    expect(capacity?.domainStatus).toBe('unknown')
    expect(capacity?.value).not.toBe(true)

    const firmware = result.conclusions.find((entry) => entry.propositionKey === 'device.firmware_channel')
    expect(firmware?.domainStatus).toBe('conflict')
    expect(firmware?.value).not.toBe(true)

    const conflict = result.conflicts.find((entry) => entry.propositionKey === 'device.firmware_channel')
    expect(conflict?.assertionIds).toEqual(['assert-firmware-beta', 'assert-firmware-stable'])
  })

  it('applies exact inclusive/exclusive numeric boundaries and keeps negative decimals', () => {
    const fixture = fixtureOf('numeric_boundary')
    const current = fixture.expected.views.find((view) => view.isCurrent)
    if (current === undefined) throw new Error('fixture has no current view')
    const result = evaluator.evaluate(ruleInputFromFixture(fixture, current.request))
    const byKey = new Map(result.conclusions.map((entry) => [entry.propositionKey, entry]))

    expect(byKey.get('battery.at_or_above_floor')?.domainStatus).toBe('known')
    expect(byKey.get('battery.at_or_above_floor')?.value).toBe(true)
    // gt is exclusive at the boundary: a determinate false, not unknown.
    expect(byKey.get('battery.above_floor')?.domainStatus).toBe('known')
    expect(byKey.get('battery.above_floor')?.value).toBe(false)
    expect(byKey.get('tariff.negative_price')?.domainStatus).toBe('known')
    expect(byKey.get('tariff.negative_price')?.value).toBe(true)

    const halfOpen = fixture.expected.views.find((view) => view.viewId === 'half-open-upper-bound')
    if (halfOpen === undefined) throw new Error('fixture is missing the half-open view')
    const halfOpenResult = evaluator.evaluate(ruleInputFromFixture(fixture, halfOpen.request))
    const halfOpenByKey = new Map(halfOpenResult.conclusions.map((entry) => [entry.propositionKey, entry]))
    expect(halfOpenByKey.get('battery.at_or_above_floor')?.domainStatus).toBe('unknown')
    expect(halfOpenByKey.get('battery.at_or_above_floor')?.value).toBeUndefined()
  })
})

describe('bitemporal fact resolution through rules', () => {
  function withExtraRule(fixture: SemanticFixture, rule: SupportRule): RuleEvaluationInput {
    const base = ruleInputFromFixture(fixture, fixture.expected.views[0]?.request ?? {
      scopeRef: fixture.scopeRef,
      projectionRef: versionRef('projection.semantic'),
    })
    return { ...base, rules: [...base.rules, rule] }
  }

  function viewRequest(fixture: SemanticFixture, asOfRecordedSeq: string, validAt: string): ControlReadProjectionRequest {
    return { scopeRef: fixture.scopeRef, projectionRef: versionRef('projection.semantic'), asOfRecordedSeq, validAt }
  }

  it('honours a partial-validity correction without erasing the other intervals', () => {
    const fixture = fixtureOf('partial_validity_correction')
    const rule: SupportRule = {
      ruleRef: versionRef('rule.self-consumption'),
      ruleId: 'rule.self-consumption',
      premiseGroups: [
        {
          groupId: 'g-mode',
          filter: { fieldRef: 'inverter.mode', op: 'eq', values: ['self_consumption'] },
          alternatives: [{ alternativeId: 'alt-mode', assertionId: 'assert-inverter-mode' }],
        },
      ],
      conclusion: { propositionKey: 'inverter.self_consumption', value: true },
    }
    const evaluateAt = (asOfRecordedSeq: string, validAt: string) => {
      const input = withExtraRule(fixture, rule)
      return evaluator.evaluate({ ...input, request: viewRequest(fixture, asOfRecordedSeq, validAt) })
    }
    expect(evaluateAt('2', '2026-09-21T06:00:00Z').conclusions[0]?.value).toBe(true)
    expect(evaluateAt('2', '2026-09-21T15:00:00Z').conclusions[0]?.value).toBe(false)
    expect(evaluateAt('2', '2026-09-21T20:00:00Z').conclusions[0]?.value).toBe(true)
    expect(evaluateAt('1', '2026-09-21T15:00:00Z').conclusions[0]?.value).toBe(true)
  })

  it('selects the view with asOfRecordedSeq plus validAt and hides later aliases and tombstones', () => {
    const fixture = fixtureOf('history_view')
    const tariffRule: SupportRule = {
      ruleRef: versionRef('rule.tariff-flat'),
      ruleId: 'rule.tariff-flat',
      premiseGroups: [
        {
          groupId: 'g-plan',
          filter: { fieldRef: 'tariff.plan', op: 'eq', values: ['flat'] },
          alternatives: [{ alternativeId: 'alt-plan', assertionId: 'assert-tariff-flat' }],
        },
      ],
      conclusion: { propositionKey: 'tariff.is_flat', value: true },
    }
    const aliasRule: SupportRule = {
      ruleRef: versionRef('rule.alias-present'),
      ruleId: 'rule.alias-present',
      premiseGroups: [
        {
          groupId: 'g-alias',
          filter: { fieldRef: 'device.alias', op: 'is_not_null', values: [] },
          alternatives: [{ alternativeId: 'alt-alias', assertionId: 'assert-alias-battery' }],
        },
      ],
      conclusion: { propositionKey: 'device.alias_present', value: true },
    }
    const evaluateAt = (asOfRecordedSeq: string, validAt: string) => {
      const base = ruleInputFromFixture(fixture, viewRequest(fixture, asOfRecordedSeq, validAt))
      const result = evaluator.evaluate({ ...base, rules: [tariffRule, aliasRule] })
      return new Map(result.conclusions.map((entry) => [entry.propositionKey, entry]))
    }

    const old = evaluateAt('1', '2026-09-26T00:00:00Z')
    expect(old.get('tariff.is_flat')?.value).toBe(true)
    expect(old.get('device.alias_present')?.domainStatus).toBe('unknown')

    const mid = evaluateAt('3', '2026-10-05T00:00:00Z')
    expect(mid.get('tariff.is_flat')?.value).toBe(false)
    expect(mid.get('device.alias_present')?.value).toBe(true)

    const current = evaluateAt('4', '2026-10-05T00:00:00Z')
    expect(current.get('tariff.is_flat')?.value).toBe(false)
    expect(current.get('device.alias_present')?.domainStatus).toBe('unknown')

    const after = evaluateAt('4', '2026-10-15T00:00:00Z')
    expect(after.get('tariff.is_flat')?.value).toBe(true)
    expect(after.get('device.alias_present')?.domainStatus).toBe('unknown')
  })
})

describe('cycle and negation rejection', () => {
  function rule(
    ruleId: string,
    alternative: { alternativeId: string; assertionId?: string; propositionKey?: string },
    propositionKey: string,
  ): SupportRule {
    return {
      ruleRef: versionRef(ruleId),
      ruleId,
      premiseGroups: [
        {
          groupId: `${ruleId}-group`,
          filter: { fieldRef: 'p', op: 'eq', values: [true] },
          alternatives: [alternative],
        },
      ],
      conclusion: { propositionKey, value: true },
    }
  }

  it('rejects a rule dependency cycle instead of letting a rule support itself', () => {
    const rules = [
      rule('rule.a', { alternativeId: 'a', propositionKey: 'prop.b' }, 'prop.a'),
      rule('rule.b', { alternativeId: 'b', propositionKey: 'prop.a' }, 'prop.b'),
    ]
    expectRuleError(() => evaluator.evaluate(baseInput({ rules })), 'CYCLE_DETECTED')
  })

  it('rejects a self-supporting rule', () => {
    const rules = [rule('rule.self', { alternativeId: 's', propositionKey: 'prop.self' }, 'prop.self')]
    expectRuleError(() => evaluator.evaluate(baseInput({ rules })), 'CYCLE_DETECTED')
  })

  it('rejects an unsupported negation group and an is_null filter', () => {
    const negative: SupportRule = {
      ruleRef: versionRef('rule.negative'),
      ruleId: 'rule.negative',
      premiseGroups: [
        {
          groupId: 'g',
          filter: { fieldRef: 'p', op: 'eq', values: [true] },
          alternatives: [{ alternativeId: 'a', assertionId: 'assert-a' }],
          polarity: 'negative',
        },
      ],
      conclusion: { propositionKey: 'prop', value: true },
    }
    expectRuleError(() => evaluator.evaluate(baseInput({ rules: [negative] })), 'UNSUPPORTED_NEGATION')

    const isNull: SupportRule = {
      ruleRef: versionRef('rule.is-null'),
      ruleId: 'rule.is-null',
      premiseGroups: [
        {
          groupId: 'g',
          filter: { fieldRef: 'p', op: 'is_null', values: [] },
          alternatives: [{ alternativeId: 'a', assertionId: 'assert-a' }],
        },
      ],
      conclusion: { propositionKey: 'prop', value: true },
    }
    expectRuleError(() => evaluator.evaluate(baseInput({ rules: [isNull] })), 'UNSUPPORTED_NEGATION')
  })

  it('rejects an explicit negation in a published rule AST', () => {
    const expression = {
      op: 'not' as const,
      operand: { op: 'compare' as const, attributeId: 'device_name', operator: 'eq' as const, value: 'x', spans: [] },
      spans: [],
    }
    const published = {
      ruleVersionId: '00000000-0000-4000-8000-000000000001',
      ruleId: 'rule.not',
      version: '1',
      objectId: 'device',
      severity: 'soft' as const,
      impact: 'low' as const,
      expression,
      exceptions: [],
      recordedAt: '2026-09-21T00:00:00Z',
      sourceCandidateId: '00000000-0000-4000-8000-000000000002',
      publicationId: '00000000-0000-4000-8000-000000000003',
    }
    expectRuleError(() => supportRuleFromPublishedRule(published, []), 'UNSUPPORTED_NEGATION')
  })

  it('rejects attached exceptions instead of silently weakening a published rule', () => {
    const published = {
      ruleVersionId: '00000000-0000-4000-8000-000000000001',
      ruleId: 'rule.with-exception',
      version: '1',
      objectId: 'battery',
      severity: 'hard' as const,
      impact: 'high' as const,
      expression: { op: 'compare' as const, attributeId: 'enabled', operator: 'eq' as const, value: true, spans: [] },
      exceptions: [{
        exceptionId: 'maintenance',
        condition: { op: 'compare' as const, attributeId: 'maintenance', operator: 'eq' as const, value: true, spans: [] },
        spans: [],
      }],
      recordedAt: '2026-09-21T00:00:00Z',
      sourceCandidateId: '00000000-0000-4000-8000-000000000002',
      publicationId: '00000000-0000-4000-8000-000000000003',
    }
    expectRuleError(() => supportRuleFromPublishedRule(published, []), 'UNSUPPORTED_NEGATION')
  })

  it('rejects premises drawn from two separate entities rather than combining them as one', () => {
    const facts = [
      fact({ assertionId: 'enabled-A', subject: 'battery-A', predicate: 'enabled', value: true }),
      fact({ assertionId: 'islanding-B', subject: 'battery-B', predicate: 'islanding', value: true }),
    ]
    const published = {
      ruleVersionId: '00000000-0000-4000-8000-000000000001',
      ruleId: 'rule.cross-entity',
      version: '1',
      objectId: 'battery',
      severity: 'hard' as const,
      impact: 'high' as const,
      expression: {
        op: 'all' as const,
        operands: [
          { op: 'compare' as const, attributeId: 'enabled', operator: 'eq' as const, value: true, spans: [] },
          { op: 'compare' as const, attributeId: 'islanding', operator: 'eq' as const, value: true, spans: [] },
        ],
        spans: [],
      },
      exceptions: [],
      recordedAt: '2026-09-21T00:00:00Z',
      sourceCandidateId: '00000000-0000-4000-8000-000000000002',
      publicationId: '00000000-0000-4000-8000-000000000003',
    }
    expectRuleError(() => supportRuleFromPublishedRule(published, facts), 'UNSUPPORTED_FILTER')
  })

  it('does not let a withdrawn fact for another subject block a single active subject', () => {
    const published = {
      ruleVersionId: '00000000-0000-4000-8000-000000000001',
      ruleId: 'rule.single-active',
      version: '1',
      objectId: 'battery',
      severity: 'soft' as const,
      impact: 'low' as const,
      expression: { op: 'compare' as const, attributeId: 'enabled', operator: 'eq' as const, value: true, spans: [] },
      exceptions: [],
      recordedAt: '2026-09-21T00:00:00Z',
      sourceCandidateId: '00000000-0000-4000-8000-000000000002',
      publicationId: '00000000-0000-4000-8000-000000000003',
    }
    const facts = [
      fact({ assertionId: 'enabled-A', subject: 'battery-A', predicate: 'enabled', value: true }),
      fact({ assertionId: 'enabled-B', subject: 'battery-B', predicate: 'enabled', value: true, op: 'retract' }),
    ]
    expect(supportRuleFromPublishedRule(published, facts).premiseGroups).toHaveLength(1)
  })
})

describe('proposition key qualifiers', () => {
  const base = {
    predicate: 'battery.soc_pct',
    subject: 'site.home-1.battery',
    unitCode: 'pct',
    validFrom: '2026-09-21T00:00:00Z',
    validTo: '2026-09-22T00:00:00Z',
    scopeRef: SCOPE,
  }

  it('treats otherwise-identical propositions differing in unit, time or scope as distinct', () => {
    const canonical = qualifiedPropositionKey(base)
    expect(canonical).toBe(qualifiedPropositionKey({ ...base }))
    expect(canonical).not.toBe(qualifiedPropositionKey({ ...base, unitCode: 'kWh' }))
    expect(canonical).not.toBe(qualifiedPropositionKey({ ...base, validFrom: '2026-09-20T00:00:00Z' }))
    expect(canonical).not.toBe(qualifiedPropositionKey({ ...base, scopeRef: OTHER_SCOPE }))
    expect(canonical).not.toBe(qualifiedPropositionKey({ ...base, subject: 'site.home-2.battery' }))
  })

  it('does not report a conflict for facts that differ only in a qualifier', () => {
    const sameTime = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
    const pctFact = fact({
      assertionId: 'a-pct',
      predicate: 'battery.soc_pct',
      value: { amount: '1', unit: 'pct' },
      validity: sameTime,
    })
    const kwhFact = fact({
      assertionId: 'a-kwh',
      predicate: 'battery.soc_pct',
      value: { amount: '1', unit: 'kWh' },
      validity: sameTime,
    })
    expect(evaluator.evaluate(baseInput({ facts: [pctFact, kwhFact] })).conflicts).toHaveLength(0)

    const secondPct = fact({
      assertionId: 'a-pct-2',
      predicate: 'battery.soc_pct',
      value: { amount: '2', unit: 'pct' },
      validity: sameTime,
    })
    const conflicts = evaluator.evaluate(baseInput({ facts: [pctFact, secondPct] })).conflicts
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.assertionIds).toEqual(['a-pct', 'a-pct-2'])
  })
})

describe('compact support DAG and determinism', () => {
  it('keeps the support graph linear while the full combination space explodes', () => {
    const groups = 20
    const alternativesPerGroup = 20
    const facts: RuleFact[] = []
    const premiseGroups: RulePremiseGroup[] = []
    for (let group = 0; group < groups; group += 1) {
      const alternatives = []
      for (let alternative = 0; alternative < alternativesPerGroup; alternative += 1) {
        const assertionId = `assert-${String(group)}-${String(alternative)}`
        facts.push(
          fact({
            assertionId,
            logicalAssertionId: `la-${String(group)}-${String(alternative)}`,
            predicate: `p.${String(group)}`,
            value: true,
          }),
        )
        alternatives.push({ alternativeId: `alt-${String(group)}-${String(alternative)}`, assertionId })
      }
      premiseGroups.push({
        groupId: `g-${String(group)}`,
        filter: { fieldRef: `p.${String(group)}`, op: 'eq', values: [true] } satisfies SemanticFilter,
        alternatives,
      })
    }
    const rule: SupportRule = {
      ruleRef: versionRef('rule.big'),
      ruleId: 'rule.big',
      premiseGroups,
      conclusion: { propositionKey: 'big.conclusion', value: true },
    }

    const result = evaluator.evaluate(baseInput({ facts, rules: [rule] }))
    expect(result.conclusions[0]?.domainStatus).toBe('known')
    expect(result.conclusions[0]?.value).toBe(true)

    const combinations = alternativesPerGroup ** groups
    expect(combinations).toBeGreaterThan(10 ** 20)
    // One shared node per fact, group, rule and conclusion — never one per combination.
    expect(result.supports.nodes.length).toBeLessThanOrEqual(groups * (alternativesPerGroup + 1) + 4)
    expect(result.supports.nodes.length).toBeLessThan(1_000)
  })

  it('is deterministic and carries definition, rule and fact version references', () => {
    const fixture = fixtureOf('and_prerequisites')
    const view = fixture.expected.views[0]
    if (view === undefined) throw new Error('fixture has no view')
    const input = ruleInputFromFixture(fixture, view.request)
    const first = evaluator.evaluate(input)
    const second = evaluator.evaluate(input)
    expect(first).toEqual(second)
    expect(first.inputDigest).toBe(second.inputDigest)

    const conclusion = first.conclusions[0]
    expect(conclusion?.ruleRefs).toEqual([fixture.rules[0]?.ruleRef])
    expect(conclusion?.factRefs).toHaveLength(2)

    // Reordering the input does not change the result or the digest.
    const reordered = evaluator.evaluate({
      ...input,
      facts: [...input.facts].reverse(),
      rules: [...input.rules].reverse(),
    })
    expect(reordered.conclusions).toEqual(first.conclusions)
    expect(reordered.inputDigest).toBe(first.inputDigest)
  })
})
