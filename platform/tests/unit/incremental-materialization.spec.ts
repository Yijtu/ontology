import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  AssertionMaterializationChange,
  MaterializationChange,
  ScopeRef,
  SemanticFilter,
  ToolContext,
  ValidityInterval,
  VersionRef,
} from '@ontology/contracts'
import {
  IncrementalMaterializer,
  InMemoryMaterializationStore,
  MaterializationDependencyIndex,
} from '@ontology/semantic-engine'
import type {
  MaterializationPublishedSource,
  MaterializationReadRequest,
  MaterializationReadResult,
  PublishedSemanticData,
  RuleFact,
  SupportRule,
} from '@ontology/semantic-engine'
import { fixturesOfKind, loadFixtures } from '../fixtures/semantic/loader'
import type { FixtureAssertion, FixtureViewExpectation, SemanticFixture } from '../fixtures/semantic/loader'
import { ruleFactsFromFixture, supportRulesFromFixture } from './rule-evaluator-fixtures'
import { toolContext } from './component-registry-fixtures'

const fixtures = loadFixtures()
const DAY: ValidityInterval = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }

function versionRef(id: string): VersionRef {
  return { id, version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
}

function fixtureOf(kind: SemanticFixture['scenarioKind']): SemanticFixture {
  const fixture = fixturesOfKind(fixtures, kind)[0]
  if (fixture === undefined) throw new Error(`no fixture of kind ${kind}`)
  return fixture
}

class FixturePublishedSource implements MaterializationPublishedSource {
  readonly #data: PublishedSemanticData
  constructor(data: PublishedSemanticData) {
    this.#data = data
  }
  async load(): Promise<PublishedSemanticData> {
    return this.#data
  }
}

function dataOf(fixture: SemanticFixture, extraRules: readonly SupportRule[] = []): PublishedSemanticData {
  return {
    facts: ruleFactsFromFixture(fixture),
    rules: [...supportRulesFromFixture(fixture), ...extraRules],
    entityBindings: [],
  }
}

function harness(data: PublishedSemanticData, options: {
  readonly maxFanout?: number
  readonly faultInjection?: { readonly beforeCommit?: () => void }
} = {}): {
  readonly store: InMemoryMaterializationStore
  readonly materializer: IncrementalMaterializer
} {
  const store = new InMemoryMaterializationStore()
  const materializer = new IncrementalMaterializer({
    publishedSource: new FixturePublishedSource(data),
    materialization: store,
    ...(options.maxFanout === undefined ? {} : { maxFanout: options.maxFanout }),
    ...(options.faultInjection === undefined ? {} : { faultInjection: options.faultInjection }),
  })
  return { store, materializer }
}

function assertionChange(
  fixture: SemanticFixture,
  assertion: FixtureAssertion,
): AssertionMaterializationChange {
  const kind =
    assertion.op === 'correct'
      ? 'assertion_corrected'
      : assertion.op === 'retract'
        ? 'assertion_retracted'
        : 'assertion_published'
  return {
    changeId: randomUUID(),
    scopeRef: fixture.scopeRef,
    recordedSeq: assertion.recordedSeq,
    recordedAt: assertion.validity.validFrom,
    kind,
    logicalAssertionId: assertion.logicalAssertionId,
    predicate: assertion.predicate,
    validity: assertion.validity,
  }
}

async function applyFixtureOperations(
  materializer: IncrementalMaterializer,
  fixture: SemanticFixture,
  ctx: ToolContext,
): Promise<void> {
  for (const operation of fixture.operations) {
    if (
      operation.kind !== 'publish_assertion' &&
      operation.kind !== 'correct_assertion' &&
      operation.kind !== 'retract_assertion'
    ) {
      continue
    }
    const assertion = fixture.assertions.find((entry) => entry.assertionId === operation.assertionId)
    if (assertion === undefined) continue
    await materializer.applyChange(assertionChange(fixture, assertion), ctx)
  }
}

function readRequestOf(fixture: SemanticFixture, view: FixtureViewExpectation): MaterializationReadRequest {
  return {
    scopeRef: fixture.scopeRef,
    projectionRef: view.request.projectionRef,
    ...(view.request.asOfRecordedSeq === undefined ? {} : { asOfRecordedSeq: view.request.asOfRecordedSeq }),
    ...(view.request.validAt === undefined ? {} : { validAt: view.request.validAt }),
  }
}

function expectConclusions(
  result: MaterializationReadResult,
  expected: readonly { readonly propositionKey: string; readonly domainStatus: string; readonly value?: unknown }[],
): void {
  expect(result.conclusions).toHaveLength(expected.length)
  for (const entry of expected) {
    const produced = result.conclusions.find((conclusion) => conclusion.propositionKey === entry.propositionKey)
    expect(produced, `missing conclusion ${entry.propositionKey}`).toBeDefined()
    if (produced === undefined) continue
    expect(produced.domainStatus).toBe(entry.domainStatus)
    if (entry.value !== undefined) expect(produced.value).toEqual(entry.value)
    if (entry.domainStatus === 'unknown' || entry.domainStatus === 'conflict') {
      expect(produced.value).toBeUndefined()
    }
  }
}

function ctxOf(fixture: SemanticFixture): ToolContext {
  return toolContext(fixture.scopeRef.tenantId, fixture.scopeRef.spaceId, ['platform-admin'])
}

function valueAt(result: MaterializationReadResult, propositionKey: string): unknown {
  return result.conclusions.find((conclusion) => conclusion.propositionKey === propositionKey)?.value
}

function statusAt(result: MaterializationReadResult, propositionKey: string): string | undefined {
  return result.conclusions.find((conclusion) => conclusion.propositionKey === propositionKey)?.domainStatus
}

// ---------------------------------------------------------------------------------------------
// LOCAL-048 fixtures: materialised projection matches the independent gold views.
// ---------------------------------------------------------------------------------------------

describe('LOCAL-048 fixtures materialised against the gold views', () => {
  for (const kind of ['and_prerequisites', 'or_alternative_support', 'last_support_retraction'] as const) {
    it(`materialises ${kind} and agrees with every expected view`, async () => {
      const fixture = fixtureOf(kind)
      const ctx = ctxOf(fixture)
      const { materializer } = harness(dataOf(fixture))
      await applyFixtureOperations(materializer, fixture, ctx)

      for (const view of fixture.expected.views) {
        const request = readRequestOf(fixture, view)
        const materialised = await materializer.read(request, ctx)
        expect(materialised.blockedPropositionKeys).toEqual([])
        expectConclusions(materialised, view.conclusions)

        const onDemand = await materializer.readOnDemand(request, ctx)
        expect(onDemand.conclusions).toEqual(materialised.conclusions)
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------
// Bitemporal independence + partial-interval correction.
// ---------------------------------------------------------------------------------------------

function selfConsumptionRule(): SupportRule {
  return {
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
}

describe('bitemporal projection: partial-interval correction', () => {
  it('keeps valid time and recorded_seq independent and never overwrites another interval', async () => {
    const fixture = fixtureOf('partial_validity_correction')
    const ctx = ctxOf(fixture)
    const { materializer, store } = harness(dataOf(fixture, [selfConsumptionRule()]))
    await applyFixtureOperations(materializer, fixture, ctx)

    const read = (asOfRecordedSeq: string, validAt: string): Promise<MaterializationReadResult> =>
      materializer.read(
        { scopeRef: fixture.scopeRef, projectionRef: versionRef('projection.semantic'), asOfRecordedSeq, validAt },
        ctx,
      )

    // The correction covers [12:00,18:00): inside it the corrected value holds; outside it the
    // original value still holds.
    expect(valueAt(await read('2', '2026-09-21T06:00:00Z'), 'inverter.self_consumption')).toBe(true)
    expect(valueAt(await read('2', '2026-09-21T15:00:00Z'), 'inverter.self_consumption')).toBe(false)
    expect(valueAt(await read('2', '2026-09-21T20:00:00Z'), 'inverter.self_consumption')).toBe(true)
    // A recorded version before the correction never sees it.
    expect(valueAt(await read('1', '2026-09-21T15:00:00Z'), 'inverter.self_consumption')).toBe(true)

    // The correction appended a slice for its own interval only; the original slice is untouched.
    const slices = await store.readSlices(fixture.scopeRef, {}, ctx)
    const original = slices.find((slice) => slice.recordedSeq === '1')
    const correction = slices.find((slice) => slice.recordedSeq === '2')
    expect(original?.validity).toEqual({ validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' })
    expect(correction?.validity).toEqual({ validFrom: '2026-09-21T12:00:00Z', validTo: '2026-09-21T18:00:00Z' })
    expect(correction?.value).toBe(false)
    // No slice was written for the untouched [18:00,24:00) interval at the correction version.
    expect(slices.some((slice) => slice.recordedSeq === '2' && slice.validity.validFrom === '2026-09-21T18:00:00Z')).toBe(false)
  })
})

function tariffRule(): SupportRule {
  return {
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
}

function aliasRule(): SupportRule {
  return {
    ruleRef: versionRef('rule.alias-present'),
    ruleId: 'rule.alias-present',
    premiseGroups: [
      {
        groupId: 'g-alias',
        filter: { fieldRef: 'device.alias', op: 'is_not_null', values: [] } satisfies SemanticFilter,
        alternatives: [{ alternativeId: 'alt-alias', assertionId: 'assert-alias-battery' }],
      },
    ],
    conclusion: { propositionKey: 'device.alias_present', value: true },
  }
}

describe('bitemporal projection: recorded version visibility', () => {
  it('hides later aliases and applies a correction only inside its interval', async () => {
    const fixture = fixtureOf('history_view')
    const ctx = ctxOf(fixture)
    const { materializer } = harness(dataOf(fixture, [tariffRule(), aliasRule()]))
    await applyFixtureOperations(materializer, fixture, ctx)

    const read = async (asOfRecordedSeq: string, validAt: string): Promise<MaterializationReadResult> => {
      const request: MaterializationReadRequest = {
        scopeRef: fixture.scopeRef,
        projectionRef: versionRef('projection.semantic'),
        asOfRecordedSeq,
        validAt,
      }
      const materialised = await materializer.read(request, ctx)
      const onDemand = await materializer.readOnDemand(request, ctx)
      expect(onDemand.conclusions).toEqual(materialised.conclusions)
      return materialised
    }

    const old = await read('1', '2026-09-26T00:00:00Z')
    expect(valueAt(old, 'tariff.is_flat')).toBe(true)
    expect(statusAt(old, 'device.alias_present')).toBe('unknown')

    const mid = await read('3', '2026-10-05T00:00:00Z')
    expect(valueAt(mid, 'tariff.is_flat')).toBe(false)
    expect(valueAt(mid, 'device.alias_present')).toBe(true)

    const current = await read('4', '2026-10-05T00:00:00Z')
    expect(valueAt(current, 'tariff.is_flat')).toBe(false)
    expect(statusAt(current, 'device.alias_present')).toBe('unknown')

    const after = await read('4', '2026-10-15T00:00:00Z')
    expect(valueAt(after, 'tariff.is_flat')).toBe(true)
    expect(statusAt(after, 'device.alias_present')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------------------------
// Last-support-removal retraction (INV-06).
// ---------------------------------------------------------------------------------------------

describe('last support removal', () => {
  it('keeps a conclusion while an alternative support survives, then retracts it', async () => {
    const fixture = fixtureOf('or_alternative_support')
    const ctx = ctxOf(fixture)
    const { materializer } = harness(dataOf(fixture))

    const meter = fixture.assertions.find((entry) => entry.assertionId === 'assert-battery-meter')
    const nameplate = fixture.assertions.find((entry) => entry.assertionId === 'assert-battery-nameplate')
    const retract = fixture.assertions.find((entry) => entry.assertionId === 'retract-battery-nameplate')
    if (meter === undefined || nameplate === undefined || retract === undefined) {
      throw new Error('or_alternative_support fixture is missing an assertion')
    }
    await materializer.applyChange(assertionChange(fixture, meter), ctx)
    await materializer.applyChange(assertionChange(fixture, nameplate), ctx)

    const before = await materializer.read(
      { scopeRef: fixture.scopeRef, projectionRef: versionRef('projection.semantic'), asOfRecordedSeq: '2', validAt: '2026-09-21T12:00:00Z' },
      ctx,
    )
    expect(valueAt(before, 'device.battery_present')).toBe(true)
    expect(before.conclusions[0]?.satisfiedBy).toEqual([
      { groupId: 'g-battery', alternativeIds: ['alt-meter', 'alt-nameplate'] },
    ])

    await materializer.applyChange(assertionChange(fixture, retract), ctx)
    const after = await materializer.read(
      { scopeRef: fixture.scopeRef, projectionRef: versionRef('projection.semantic'), asOfRecordedSeq: '3', validAt: '2026-09-21T12:00:00Z' },
      ctx,
    )
    expect(valueAt(after, 'device.battery_present')).toBe(true)
    expect(after.conclusions[0]?.satisfiedBy).toEqual([
      { groupId: 'g-battery', alternativeIds: ['alt-meter'] },
    ])
  })

  it('retracts the conclusion as unknown only after the last support is withdrawn', async () => {
    const fixture = fixtureOf('last_support_retraction')
    const ctx = ctxOf(fixture)
    const { materializer } = harness(dataOf(fixture))
    await applyFixtureOperations(materializer, fixture, ctx)

    const before = await materializer.read(
      { scopeRef: fixture.scopeRef, projectionRef: versionRef('projection.semantic'), asOfRecordedSeq: '1', validAt: '2026-09-21T12:00:00Z' },
      ctx,
    )
    expect(valueAt(before, 'site.islanding_ready')).toBe(true)

    const after = await materializer.read(
      { scopeRef: fixture.scopeRef, projectionRef: versionRef('projection.semantic'), asOfRecordedSeq: '2', validAt: '2026-09-21T12:00:00Z' },
      ctx,
    )
    const conclusion = after.conclusions.find((entry) => entry.propositionKey === 'site.islanding_ready')
    expect(conclusion?.domainStatus).toBe('unknown')
    expect(conclusion?.value).toBeUndefined()
    expect(conclusion?.value).not.toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// Fence before advance: no stale read while a recomputation is in flight.
// ---------------------------------------------------------------------------------------------

describe('invalidation fence', () => {
  it('blocks reads until the asynchronous advance completes, even after a fault', async () => {
    const fixture = fixtureOf('or_alternative_support')
    const ctx = ctxOf(fixture)
    let faultEnabled = false
    const { materializer } = harness(dataOf(fixture), {
      faultInjection: {
        beforeCommit: () => {
          if (faultEnabled) throw new Error('injected materialisation fault')
        },
      },
    })

    const meter = fixture.assertions.find((entry) => entry.assertionId === 'assert-battery-meter')
    const nameplate = fixture.assertions.find((entry) => entry.assertionId === 'assert-battery-nameplate')
    const retract = fixture.assertions.find((entry) => entry.assertionId === 'retract-battery-nameplate')
    if (meter === undefined || nameplate === undefined || retract === undefined) {
      throw new Error('or_alternative_support fixture is missing an assertion')
    }
    await materializer.applyChange(assertionChange(fixture, meter), ctx)
    await materializer.applyChange(assertionChange(fixture, nameplate), ctx)

    const currentRequest: MaterializationReadRequest = {
      scopeRef: fixture.scopeRef,
      projectionRef: versionRef('projection.semantic'),
      asOfRecordedSeq: '3',
      validAt: '2026-09-21T12:00:00Z',
    }

    const ticket = await materializer.beginChange(assertionChange(fixture, retract), ctx)

    const fenced = await materializer.read(currentRequest, ctx)
    expect(fenced.status).toBe('fenced')
    expect(fenced.conclusions).toHaveLength(0)
    expect(fenced.blockedPropositionKeys).toContain('device.battery_present')

    // A fault during the advance leaves the fence open: the read must still not return the
    // out-of-date "two alternatives" conclusion.
    faultEnabled = true
    await expect(materializer.advance(ticket, ctx)).rejects.toThrow('injected materialisation fault')
    const stillFenced = await materializer.read(currentRequest, ctx)
    expect(stillFenced.status).toBe('fenced')
    expect(stillFenced.conclusions).toHaveLength(0)

    faultEnabled = false
    await materializer.advance(ticket, ctx)
    const after = await materializer.read(currentRequest, ctx)
    expect(after.status).toBe('materialized')
    expect(valueAt(after, 'device.battery_present')).toBe(true)
    expect(after.conclusions[0]?.satisfiedBy).toEqual([
      { groupId: 'g-battery', alternativeIds: ['alt-meter'] },
    ])
  })
})

// ---------------------------------------------------------------------------------------------
// Large fan-out: conservatively dirty instead of silently stale.
// ---------------------------------------------------------------------------------------------

function fact(
  assertionId: string,
  logicalAssertionId: string,
  predicate: string,
  value: RuleFact['value'],
): RuleFact {
  return {
    assertionId,
    logicalAssertionId,
    recordedSeq: '1',
    op: 'assert',
    subject: `subject.${predicate}`,
    predicate,
    ...(value === undefined ? {} : { value }),
    validity: DAY,
    sourceRef: { namespace: 'test', sourceId: assertionId },
  }
}

function singlePremiseRule(
  ruleId: string,
  predicate: string,
  propositionKey: string,
  assertionId = 'f-a',
): SupportRule {
  return {
    ruleRef: versionRef(ruleId),
    ruleId,
    premiseGroups: [
      {
        groupId: `${ruleId}:g`,
        filter: { fieldRef: predicate, op: 'eq', values: [true] },
        alternatives: [{ alternativeId: `${ruleId}:a`, assertionId }],
      },
    ],
    conclusion: { propositionKey, predicate: propositionKey, value: true },
  }
}

describe('large fan-out', () => {
  it('marks the scope dirty and refuses to serve a stale conclusion', async () => {
    const scopeRef: ScopeRef = {
      tenantId: '11111111-2222-4333-8444-555555555555',
      spaceId: '99999999-8888-4777-8666-555555555555',
    }
    const ctx = toolContext(scopeRef.tenantId, scopeRef.spaceId, ['platform-admin'])
    const data: PublishedSemanticData = {
      facts: [fact('f-a', 'la-a', 'p.a', true)],
      rules: [
        singlePremiseRule('r-1', 'p.a', 'c.one'),
        singlePremiseRule('r-2', 'p.a', 'c.two'),
        singlePremiseRule('r-3', 'p.a', 'c.three'),
      ],
      entityBindings: [],
    }
    const { materializer } = harness(data, { maxFanout: 2 })

    const change: MaterializationChange = {
      changeId: randomUUID(),
      scopeRef,
      recordedSeq: '2',
      recordedAt: '2026-09-21T01:00:00Z',
      kind: 'assertion_published',
      logicalAssertionId: 'la-a',
      predicate: 'p.a',
      validity: DAY,
    }
    const ticket = await materializer.beginChange(change, ctx)
    expect(ticket.deferred).toBe(true)
    expect(ticket.affectedRuleIds).toHaveLength(3)

    const request: MaterializationReadRequest = {
      scopeRef,
      projectionRef: versionRef('projection.materialized'),
      asOfRecordedSeq: '2',
      validAt: '2026-09-21T12:00:00Z',
    }
    const dirty = await materializer.read(request, ctx)
    expect(dirty.status).toBe('dirty')
    expect(dirty.conclusions).toHaveLength(0)

    const advanced = await materializer.advance(ticket, ctx)
    expect(advanced.deferred).toBe(true)
    expect([...advanced.recomputedPropositionKeys].sort()).toEqual(['c.one', 'c.three', 'c.two'])

    const after = await materializer.read(request, ctx)
    expect(after.status).toBe('materialized')
    expect(after.conclusions.map((entry) => entry.propositionKey).sort()).toEqual([
      'c.one',
      'c.three',
      'c.two',
    ])
  })
})

// ---------------------------------------------------------------------------------------------
// Every trigger class resolves to exactly the affected rules.
// ---------------------------------------------------------------------------------------------

describe('change-driven affected evaluation', () => {
  const scopeRef: ScopeRef = {
    tenantId: '11111111-2222-4333-8444-555555555555',
    spaceId: '99999999-8888-4777-8666-555555555555',
  }
  const facts: RuleFact[] = [
    fact('f-a', 'la-a', 'p.a', true),
    fact('f-b', 'la-b', 'p.b', true),
    fact('f-z', 'la-z', 'p.z', true),
  ]
  const rules: SupportRule[] = [
    singlePremiseRule('r-a', 'p.a', 'c.a', 'f-a'),
    singlePremiseRule('r-b', 'p.b', 'c.b', 'f-b'),
    singlePremiseRule('r-z', 'p.z', 'c.z', 'f-z'),
    // r-down references r-a's derived conclusion, so it is downstream of a change on p.a.
    {
      ruleRef: versionRef('r-down'),
      ruleId: 'r-down',
      premiseGroups: [
        {
          groupId: 'r-down:g',
          filter: { fieldRef: 'c.a', op: 'eq', values: [true] },
          alternatives: [{ alternativeId: 'r-down:a', propositionKey: 'c.a' }],
        },
      ],
      conclusion: { propositionKey: 'c.down', predicate: 'c.down', value: true },
    },
  ]
  const index = MaterializationDependencyIndex.build({
    facts,
    rules,
    entityBindings: [{ entityId: 'entity-a', logicalAssertionId: 'la-a' }],
  })

  const changeBase = { scopeRef, recordedAt: '2026-09-21T01:00:00Z' } as const

  it('routes each trigger class to the affected rules and never to an unrelated rule', () => {
    const cases: readonly { readonly label: string; readonly value: MaterializationChange; readonly expected: readonly string[] }[] = [
      {
        label: 'new assertion',
        value: {
          ...changeBase,
          changeId: randomUUID(),
          kind: 'assertion_published',
          recordedSeq: '2',
          logicalAssertionId: 'la-a',
          predicate: 'p.a',
          validity: DAY,
        },
        expected: ['r-a', 'r-down'],
      },
      {
        label: 'revision',
        value: {
          ...changeBase,
          changeId: randomUUID(),
          kind: 'assertion_corrected',
          recordedSeq: '2',
          logicalAssertionId: 'la-b',
          predicate: 'p.b',
          validity: DAY,
        },
        expected: ['r-b'],
      },
      {
        label: 'retraction',
        value: {
          ...changeBase,
          changeId: randomUUID(),
          kind: 'assertion_retracted',
          recordedSeq: '2',
          logicalAssertionId: 'la-z',
          predicate: 'p.z',
          validity: DAY,
        },
        expected: ['r-z'],
      },
      {
        label: 'rule change',
        value: {
          ...changeBase,
          changeId: randomUUID(),
          kind: 'rule_changed',
          recordedSeq: '2',
          ruleId: 'r-a',
          propositionKey: 'c.a',
        },
        expected: ['r-a', 'r-down'],
      },
      {
        label: 'identity change',
        value: {
          ...changeBase,
          changeId: randomUUID(),
          kind: 'identity_changed',
          recordedSeq: '2',
          entityId: 'entity-a',
          separatedCandidateIds: [],
          reason: 'split',
        },
        expected: ['r-a', 'r-down'],
      },
      {
        label: 'natural expiry',
        value: {
          ...changeBase,
          changeId: randomUUID(),
          kind: 'validity_expired',
          recordedSeq: '2',
          logicalAssertionId: 'la-b',
          predicate: 'p.b',
          validAt: '2026-09-22T00:00:00Z',
        },
        expected: ['r-b'],
      },
    ]
    for (const testCase of cases) {
      const affected = index.affectedRuleIds(testCase.value)
      // The exact set proves the change routes to the affected rules and to no unrelated rule.
      expect(affected, `${testCase.label} affected set`).toEqual(testCase.expected)
    }
  })

  it('adds prerequisites to the evaluation set but keeps it smaller than the library', () => {
    const evaluation = index.evaluationRuleIds(['r-down'])
    expect(evaluation).toEqual(['r-a', 'r-down'])
    expect(evaluation).not.toContain('r-z')
  })

  it('recomputes only the affected rules when a change is applied', async () => {
    const ctx = toolContext(scopeRef.tenantId, scopeRef.spaceId, ['platform-admin'])
    const { materializer } = harness({ facts, rules, entityBindings: [] })
    const result = await materializer.applyChange(
      {
        ...changeBase,
        changeId: randomUUID(),
        kind: 'assertion_published',
        recordedSeq: '2',
        logicalAssertionId: 'la-b',
        predicate: 'p.b',
        validity: DAY,
      },
      ctx,
    )
    expect(result.recomputedRuleIds).toEqual(['r-b'])
    expect(result.recomputedPropositionKeys).toEqual(['c.b'])
  })
})

// ---------------------------------------------------------------------------------------------
// Determinism and on-demand/materialised agreement.
// ---------------------------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical projections for identical inputs and matches on-demand evaluation', async () => {
    const fixture = fixtureOf('and_prerequisites')
    const ctx = ctxOf(fixture)
    const first = harness(dataOf(fixture))
    const second = harness(dataOf(fixture))
    await applyFixtureOperations(first.materializer, fixture, ctx)
    await applyFixtureOperations(second.materializer, fixture, ctx)

    const request: MaterializationReadRequest = {
      scopeRef: fixture.scopeRef,
      projectionRef: versionRef('projection.semantic'),
      asOfRecordedSeq: '2',
      validAt: '2026-09-21T12:00:00Z',
    }
    const firstRead = await first.materializer.read(request, ctx)
    const secondRead = await second.materializer.read(request, ctx)
    expect(firstRead.conclusions).toEqual(secondRead.conclusions)

    const onDemand = await first.materializer.readOnDemand(request, ctx)
    expect(onDemand.conclusions).toEqual(firstRead.conclusions)
  })
})
