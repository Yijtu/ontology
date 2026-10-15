import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AssertionMaterializationChange, ScopeRef, ToolContext } from '@ontology/contracts'
import { IncrementalMaterializer, InMemoryMaterializationStore, MaterializationError } from '@ontology/semantic-engine'
import type { MaterializationPublishedSource, MaterializationTicket, PublishedSemanticData, SupportRule } from '@ontology/semantic-engine'
import { fixturesOfKind, loadFixtures } from '../fixtures/semantic/loader'
import type { FixtureAssertion, SemanticFixture } from '../fixtures/semantic/loader'
import { ruleFactsFromFixture, supportRulesFromFixture } from './rule-evaluator-fixtures'
import { toolContext } from './component-registry-fixtures'

const fixtures = loadFixtures()
function partialCorrectionFixture(): SemanticFixture {
  const value = fixturesOfKind(fixtures, 'partial_validity_correction')[0]
  if (value === undefined) throw new Error('partial-validity-correction fixture is required')
  return value
}
const fixture = partialCorrectionFixture()

class CountingSource implements MaterializationPublishedSource {
  loads = 0
  constructor(readonly data: PublishedSemanticData) {}
  async load(): Promise<PublishedSemanticData> {
    this.loads += 1
    return this.data
  }
}

function dataOf(value: SemanticFixture, complete = true): PublishedSemanticData {
  return {
    facts: ruleFactsFromFixture(value),
    rules: [...supportRulesFromFixture(value), selfConsumptionRule()],
    entityBindings: [],
    ...(complete ? {} : { complete: false, incompleteReasons: ['test snapshot incomplete'] }),
  }
}

function selfConsumptionRule(): SupportRule {
  return {
    ruleRef: { id: 'rule.self-consumption', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` },
    ruleId: 'rule.self-consumption',
    premiseGroups: [{
      groupId: 'g-mode',
      filter: { fieldRef: 'inverter.mode', op: 'eq', values: ['self_consumption', 'reserve_first'] },
      alternatives: [
        { alternativeId: 'alt-mode', assertionId: 'assert-inverter-mode' },
        { alternativeId: 'alt-corrected-mode', assertionId: 'correct-inverter-mode' },
      ],
    }],
    conclusion: { propositionKey: 'inverter.self_consumption', value: true },
  }
}

function makeChange(assertion: FixtureAssertion, scopeRef: ScopeRef = fixture.scopeRef): AssertionMaterializationChange {
  return {
    changeId: randomUUID(), scopeRef, recordedSeq: assertion.recordedSeq,
    recordedAt: assertion.validity.validFrom,
    kind: assertion.op === 'correct' ? 'assertion_corrected' : assertion.op === 'retract' ? 'assertion_retracted' : 'assertion_published',
    logicalAssertionId: assertion.logicalAssertionId, predicate: assertion.predicate, validity: assertion.validity,
  }
}

function harness(complete = true) {
  const store = new InMemoryMaterializationStore()
  const source = new CountingSource(dataOf(fixture, complete))
  const materializer = new IncrementalMaterializer({ publishedSource: source, materialization: store })
  const ctx = toolContext(fixture.scopeRef.tenantId, fixture.scopeRef.spaceId, ['platform-admin'])
  return { store, source, materializer, ctx }
}

async function ticketsOf(materializer: IncrementalMaterializer, ctx: ToolContext): Promise<MaterializationTicket[]> {
  return ticketsForAssertions(materializer, ctx, fixture.assertions)
}

async function ticketsForAssertions(
  materializer: IncrementalMaterializer,
  ctx: ToolContext,
  input: readonly FixtureAssertion[],
): Promise<MaterializationTicket[]> {
  const assertions = [...input].sort((left, right) => Number(left.recordedSeq) - Number(right.recordedSeq))
  const tickets: MaterializationTicket[] = []
  for (const assertion of assertions) tickets.push(await materializer.beginChange(makeChange(assertion), ctx))
  return tickets
}

describe('bounded materialization batches', () => {
  it('loads one snapshot, preserves each event recorded time, and commits slices and fences in one generation', async () => {
    const { store, source, materializer, ctx } = harness()
    const tickets = await ticketsOf(materializer, ctx)
    source.loads = 0

    const result = await materializer.advanceBatch(tickets, ctx)

    expect(source.loads).toBe(1)
    expect(result.generation).toBe('1')
    expect(result.appendedSlices).toBeGreaterThan(0)
    const slices = await store.readSlices(fixture.scopeRef, {}, ctx)
    const historical = slices.filter((slice) => slice.propositionKey === 'inverter.self_consumption')
    expect(historical.map((slice) => slice.recordedSeq)).toEqual(expect.arrayContaining(['1', '2']))
    expect(historical.filter((slice) => slice.recordedSeq === '1').every((slice) => slice.generation === '1')).toBe(true)
    expect(historical.filter((slice) => slice.recordedSeq === '2').every((slice) => slice.generation === '1')).toBe(true)
    expect(historical.some((slice) => slice.recordedSeq === '1' && slice.value === true)).toBe(true)
    expect(historical.map((slice) => ({ recordedSeq: slice.recordedSeq, domainStatus: slice.domainStatus, value: slice.value }))).toEqual([
      { recordedSeq: '1', domainStatus: 'known', value: true },
      { recordedSeq: '2', domainStatus: 'known', value: false },
    ])
    expect((await store.getProjectionState(fixture.scopeRef, ctx))?.watermark).toEqual({ kind: 'sequence', value: '2' })
    expect(await store.listOpenFences(fixture.scopeRef, ctx)).toEqual([])

    source.loads = 0
    const replay = await materializer.advanceBatch(tickets, ctx)
    expect(source.loads).toBe(0)
    expect(replay.generation).toBe('1')
    expect(replay.appendedSlices).toBe(0)
    expect(await store.readSlices(fixture.scopeRef, {}, ctx)).toEqual(slices)
    expect(await store.listOpenFences(fixture.scopeRef, ctx)).toEqual([])
  })

  it('leaves the entire batch fenced when the newly loaded source is incomplete', async () => {
    const { store, materializer, ctx } = harness(false)
    const tickets = await ticketsOf(materializer, ctx)
    await expect(materializer.advanceBatch(tickets, ctx)).rejects.toBeInstanceOf(MaterializationError)
    expect(await store.getProjectionState(fixture.scopeRef, ctx)).toMatchObject({ generation: '0', dirty: true })
    expect(await store.readSlices(fixture.scopeRef, {}, ctx)).toEqual([])
    expect(await store.listOpenFences(fixture.scopeRef, ctx)).toHaveLength(2)
  })

  it('rejects empty, cross-scope, duplicate, reversed, and over-eight ticket batches', async () => {
    const { materializer, ctx } = harness()
    const assertions = Array.from({ length: 9 }, (_, index) => ({
      ...fixture.assertions[index % fixture.assertions.length]!,
      recordedSeq: String(index + 1),
    }))
    const tickets = await ticketsForAssertions(materializer, ctx, assertions)
    const foreignScope = { ...fixture.scopeRef, spaceId: randomUUID() }
    const foreign = { ...tickets[0]!, change: { ...tickets[0]!.change, scopeRef: foreignScope } }
    const duplicateFence = { ...tickets[1]!, fenceId: tickets[0]!.fenceId }
    const duplicateChange = { ...tickets[1]!, change: { ...tickets[1]!.change, changeId: tickets[0]!.change.changeId } }

    await expect(materializer.advanceBatch([], ctx)).rejects.toBeInstanceOf(MaterializationError)
    await expect(materializer.advanceBatch([foreign], ctx)).rejects.toBeInstanceOf(MaterializationError)
    await expect(materializer.advanceBatch([tickets[0]!, duplicateFence], ctx)).rejects.toBeInstanceOf(MaterializationError)
    await expect(materializer.advanceBatch([tickets[0]!, duplicateChange], ctx)).rejects.toBeInstanceOf(MaterializationError)
    await expect(materializer.advanceBatch(tickets.slice(0, 2).reverse(), ctx)).rejects.toBeInstanceOf(MaterializationError)
    expect(new Set(tickets.map((ticket) => ticket.fenceId)).size).toBe(9)
    expect(new Set(tickets.map((ticket) => ticket.change.changeId)).size).toBe(9)
    await expect(materializer.advanceBatch(tickets, ctx)).rejects.toBeInstanceOf(MaterializationError)
  })

  it('does not discard older open batches when a later sequence batch advances first', async () => {
    const { store, source, materializer, ctx } = harness()
    const earlyAssertions = fixture.assertions.map((assertion) => ({ ...assertion }))
    const lateAssertions = fixture.assertions.map((assertion) => ({ ...assertion, recordedSeq: String(Number(assertion.recordedSeq) + 2) }))
    const early = await ticketsForAssertions(materializer, ctx, earlyAssertions)
    const later = await ticketsForAssertions(materializer, ctx, lateAssertions)
    source.loads = 0

    const lateResult = await materializer.advanceBatch(later, ctx)
    expect(lateResult.generation).toBe('1')
    expect((await store.getProjectionState(fixture.scopeRef, ctx))?.watermark).toEqual({ kind: 'sequence', value: '4' })
    expect(await store.listOpenFences(fixture.scopeRef, ctx)).toHaveLength(2)

    source.loads = 0
    const earlyResult = await materializer.advanceBatch(early, ctx)
    expect(source.loads).toBe(1)
    expect(earlyResult.generation).toBe('2')
    expect((await store.getProjectionState(fixture.scopeRef, ctx))?.watermark).toEqual({ kind: 'sequence', value: '4' })
    expect(await store.listOpenFences(fixture.scopeRef, ctx)).toEqual([])
    const slices = await store.readSlices(fixture.scopeRef, {}, ctx)
    const oldHistory = slices.filter((slice) => slice.propositionKey === 'inverter.self_consumption' && ['1', '2'].includes(slice.recordedSeq))
    expect(oldHistory.map((slice) => ({ recordedSeq: slice.recordedSeq, value: slice.value }))).toEqual([
      { recordedSeq: '1', value: true },
      { recordedSeq: '2', value: false },
    ])

    source.loads = 0
    const replay = await materializer.advanceBatch(early, ctx)
    expect(source.loads).toBe(0)
    expect(replay.generation).toBe('2')
    expect(replay.appendedSlices).toBe(0)
    expect(await store.readSlices(fixture.scopeRef, {}, ctx)).toEqual(slices)
  })

  it('does not partially commit when one additional fence is absent from the in-memory projection', async () => {
    const { store, ctx } = harness()
    const primary = randomUUID(), missing = randomUUID()
    await store.openFence(fixture.scopeRef, { fenceId: primary, reason: 'batch primary', propositionKeys: ['inverter.mode'], openedAt: fixture.assertions[0]!.validity.validFrom }, ctx)
    const beforeState = await store.getProjectionState(fixture.scopeRef, ctx)
    const beforeFences = await store.listOpenFences(fixture.scopeRef, ctx)

    await expect(store.commitProjection(fixture.scopeRef, {
      fenceId: primary, additionalFenceIds: [missing], expectedGeneration: '0', recordedSeq: '2',
      watermark: { kind: 'sequence', value: '2' }, slices: [], committedAt: fixture.assertions[1]!.validity.validFrom,
    }, ctx)).rejects.toThrow()

    expect(await store.getProjectionState(fixture.scopeRef, ctx)).toEqual(beforeState)
    expect(await store.listOpenFences(fixture.scopeRef, ctx)).toEqual(beforeFences)
    expect(await store.readSlices(fixture.scopeRef, {}, ctx)).toEqual([])
  })
})
