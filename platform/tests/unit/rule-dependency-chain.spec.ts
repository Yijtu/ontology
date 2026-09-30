import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MAX_RULE_DEPENDENCY_DEPTH } from '@ontology/contracts'
import type { MaterializationChange, ScopeRef, VersionRef } from '@ontology/contracts'
import {
  IncrementalMaterializer,
  InMemoryMaterializationStore,
  RuleEvaluationError,
  RuleEvaluator,
} from '@ontology/semantic-engine'
import type {
  MaterializationPublishedSource,
  MaterializationReadResult,
  PublishedSemanticData,
  RuleEvaluationInput,
  RuleFact,
  SupportRule,
} from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

/**
 * Independent acceptance samples for the three-layer acyclic rule-dependency graph, its
 * incremental materialisation and temporal read-back (issue V03-028 / #197; SPEC v0.3a
 * execution-evidence EX-4.1/EX-4.2). Expectations come from the frozen bound (at most three
 * dependency edges), the OR alternative-support semantics and the append-only projection, not
 * from the implementation.
 */

const SCOPE: ScopeRef = {
  tenantId: '11111111-2222-4333-8444-555555555555',
  spaceId: '99999999-8888-4777-8666-555555555555',
}

const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const VALID_AT = '2026-09-21T12:00:00Z'
const LEAF_PREDICATE = 'leaf.flag'
const PROJECTION_REF: VersionRef = { id: 'projection.semantic', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }

function versionRef(id: string): VersionRef {
  return { id, version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
}

function fact(
  assertionId: string,
  logicalAssertionId: string,
  recordedSeq: string,
  op: RuleFact['op'],
): RuleFact {
  return {
    assertionId,
    logicalAssertionId,
    recordedSeq,
    op,
    subject: 'entity.leaf',
    predicate: LEAF_PREDICATE,
    ...(op === 'retract' ? {} : { value: true }),
    validity: VALIDITY,
    sourceRef: { namespace: 'test', sourceId: assertionId },
  }
}

const FACTS: readonly RuleFact[] = [
  fact('f-1', 'la-1', '1', 'assert'),
  fact('f-2', 'la-2', '1', 'assert'),
]

/** Layer 1: the only rule that reads facts; its OR group has two independent alternatives. */
function leafRule(): SupportRule {
  return {
    ruleRef: versionRef('r.leaf'),
    ruleId: 'r.leaf',
    premiseGroups: [
      {
        groupId: 'r.leaf:g',
        filter: { fieldRef: LEAF_PREDICATE, op: 'eq', values: [true] },
        alternatives: [
          { alternativeId: 'r.leaf:a1', assertionId: 'f-1' },
          { alternativeId: 'r.leaf:a2', assertionId: 'f-2' },
        ],
      },
    ],
    conclusion: { propositionKey: 'c.leaf', predicate: 'c.leaf', value: true },
  }
}

/** A layer N>1 rule that consumes one upstream rule's derived conclusion. */
function derivedRule(ruleId: string, upstreamPropositionKey: string, conclusionKey: string): SupportRule {
  return {
    ruleRef: versionRef(ruleId),
    ruleId,
    premiseGroups: [
      {
        groupId: `${ruleId}:g`,
        filter: { fieldRef: LEAF_PREDICATE, op: 'eq', values: [true] },
        alternatives: [{ alternativeId: `${ruleId}:a`, propositionKey: upstreamPropositionKey }],
      },
    ],
    conclusion: { propositionKey: conclusionKey, predicate: conclusionKey, value: true },
  }
}

function threeLayerRules(): readonly SupportRule[] {
  return [leafRule(), derivedRule('r.mid', 'c.leaf', 'c.mid'), derivedRule('r.top', 'c.mid', 'c.top')]
}

function evaluateInput(rules: readonly SupportRule[], facts: readonly RuleFact[]): RuleEvaluationInput {
  return {
    scopeRef: SCOPE,
    request: { scopeRef: SCOPE, projectionRef: PROJECTION_REF },
    facts,
    rules,
  }
}

function expectRuleError(run: () => unknown, code: string): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(RuleEvaluationError)
    if (error instanceof RuleEvaluationError) expect(error.code).toBe(code)
    return
  }
  throw new Error(`expected RuleEvaluationError(${code})`)
}

function readStatus(result: MaterializationReadResult, propositionKey: string): string | undefined {
  return result.conclusions.find((conclusion) => conclusion.propositionKey === propositionKey)?.domainStatus
}

function conclusionValue(result: MaterializationReadResult, propositionKey: string): unknown {
  return result.conclusions.find((conclusion) => conclusion.propositionKey === propositionKey)?.value
}

describe('three-layer acyclic rule dependencies (V03-028)', () => {
  const evaluator = new RuleEvaluator()

  it('bounds the executable dependency graph at three edges', () => {
    expect(MAX_RULE_DEPENDENCY_DEPTH).toBe(3)
  })

  it('evaluates a three-layer chain from a fact leaf to the bottom conclusion', () => {
    const result = evaluator.evaluate(evaluateInput(threeLayerRules(), FACTS))
    expect(result.conclusions.find((entry) => entry.propositionKey === 'c.leaf')?.value).toBe(true)
    expect(result.conclusions.find((entry) => entry.propositionKey === 'c.mid')?.value).toBe(true)
    expect(result.conclusions.find((entry) => entry.propositionKey === 'c.top')?.value).toBe(true)
    // The support graph keeps one leaf, one group and one rule node per layer: a compact DAG,
    // never an enumerated Cartesian product of the two OR alternatives.
    expect(result.supports.nodes.some((node) => node.kind === 'conclusion' && node.propositionKey === 'c.top')).toBe(true)
  })

  it('rejects a dependency chain deeper than the three-layer bound instead of truncating it', () => {
    const fourLayers = [
      ...threeLayerRules(),
      derivedRule('r.extra', 'c.top', 'c.extra'),
      derivedRule('r.over', 'c.extra', 'c.over'),
    ]
    expectRuleError(() => evaluator.evaluate(evaluateInput(fourLayers, FACTS)), 'DEPENDENCY_DEPTH_EXCEEDED')
  })

  it('still rejects a dependency cycle', () => {
    const cyclic = [derivedRule('r.a', 'c.b', 'c.a'), derivedRule('r.b', 'c.a', 'c.b')]
    expectRuleError(() => evaluator.evaluate(evaluateInput(cyclic, [])), 'CYCLE_DETECTED')
  })
})

class FixturePublishedSource implements MaterializationPublishedSource {
  #data: PublishedSemanticData
  constructor(data: PublishedSemanticData) {
    this.#data = data
  }
  setFacts(facts: readonly RuleFact[]): void {
    this.#data = { ...this.#data, facts }
  }
  async load(): Promise<PublishedSemanticData> {
    return this.#data
  }
}

function retractionChange(recordedSeq: string, logicalAssertionId: string): MaterializationChange {
  return {
    changeId: randomUUID(),
    scopeRef: SCOPE,
    recordedSeq,
    recordedAt: VALIDITY.validFrom,
    kind: 'assertion_retracted',
    logicalAssertionId,
    predicate: LEAF_PREDICATE,
    validity: VALIDITY,
  }
}

describe('incremental materialisation and temporal read-back of derived rule state (V03-028)', () => {
  it('keeps a three-layer conclusion while an OR alternative survives and updates incrementally afterwards', async () => {
    const source = new FixturePublishedSource({ facts: [...FACTS], rules: [...threeLayerRules()], entityBindings: [] })
    const store = new InMemoryMaterializationStore()
    const materializer = new IncrementalMaterializer({ publishedSource: source, materialization: store })
    const ctx = toolContext(SCOPE.tenantId, SCOPE.spaceId, ['platform-admin'])

    // Publish the initial fact leaf. The dependency index closes the change downstream, so all
    // three layers are recomputed in one pass, not the whole library.
    const initial = await materializer.applyChange(
      {
        changeId: randomUUID(),
        scopeRef: SCOPE,
        recordedSeq: '1',
        recordedAt: VALIDITY.validFrom,
        kind: 'assertion_published',
        logicalAssertionId: 'la-1',
        predicate: LEAF_PREDICATE,
        validity: VALIDITY,
      },
      ctx,
    )
    expect([...initial.recomputedRuleIds].sort()).toEqual(['r.leaf', 'r.mid', 'r.top'])

    const request = { scopeRef: SCOPE, projectionRef: PROJECTION_REF, validAt: VALID_AT, asOfRecordedSeq: '1' }
    const baseline = await materializer.read(request, ctx)
    expect(baseline.status).toBe('materialized')
    expect(readStatus(baseline, 'c.leaf')).toBe('known')
    expect(readStatus(baseline, 'c.top')).toBe('known')

    // Retract one of the two OR alternatives. The remaining alternative still supports the leaf,
    // so neither the upstream conclusion nor the two downstream layers may be deleted.
    source.setFacts([...FACTS, fact('f-1', 'la-1', '2', 'retract')])
    const partial = await materializer.applyChange(retractionChange('2', 'la-1'), ctx)
    expect([...partial.recomputedRuleIds].sort()).toEqual(['r.leaf', 'r.mid', 'r.top'])
    const afterPartial = await materializer.read({ ...request, asOfRecordedSeq: '2' }, ctx)
    expect(afterPartial.status).toBe('materialized')
    expect(readStatus(afterPartial, 'c.leaf')).toBe('known')
    expect(readStatus(afterPartial, 'c.mid')).toBe('known')
    expect(readStatus(afterPartial, 'c.top')).toBe('known')

    // Retract the last alternative. Missing support stays unknown, never false, and that unknown
    // propagates through the derived layers instead of collapsing to a negation.
    source.setFacts([
      ...FACTS,
      fact('f-1', 'la-1', '2', 'retract'),
      fact('f-2', 'la-2', '3', 'retract'),
    ])
    await materializer.applyChange(retractionChange('3', 'la-2'), ctx)
    const afterAll = await materializer.read({ ...request, asOfRecordedSeq: '3' }, ctx)
    expect(afterAll.status).toBe('materialized')
    for (const propositionKey of ['c.leaf', 'c.mid', 'c.top']) {
      expect(readStatus(afterAll, propositionKey), propositionKey).toBe('unknown')
      expect(conclusionValue(afterAll, propositionKey), propositionKey).toBeUndefined()
    }

    // The current projection advanced, but history was not erased: the pre-retraction recorded
    // version still resolves the original known result and the original support.
    const historical = await materializer.read(request, ctx)
    expect(historical.status).toBe('materialized')
    expect(readStatus(historical, 'c.leaf')).toBe('known')
    expect(readStatus(historical, 'c.top')).toBe('known')
    expect(conclusionValue(historical, 'c.top')).toBe(true)

    // The two views stay distinct: the historical result is not the current one re-keyed.
    expect(readStatus(afterAll, 'c.top')).toBe('unknown')
    expect(readStatus(historical, 'c.top')).toBe('known')
  })
})
