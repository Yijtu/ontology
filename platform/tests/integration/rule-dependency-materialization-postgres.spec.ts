import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, PostgresMaterializationStore } from '@ontology/adapter-control-postgres'
import { IncrementalMaterializer } from '@ontology/semantic-engine'
import type {
  MaterializationPublishedSource,
  MaterializationReadRequest,
  MaterializationReadResult,
  PublishedSemanticData,
  RuleFact,
  SupportRule,
} from '@ontology/semantic-engine'
import type { MaterializationChange, ScopeRef, ToolContext, VersionRef } from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

/**
 * Real-PostgreSQL acceptance for the three-layer acyclic rule-dependency graph, its incremental
 * materialisation and temporal read-back (issue V03-028 / #197, A.US-009.AC-03).
 *
 * The fence/CAS lifecycle, the append-only slice store, the watermark and the historical read all
 * run against the real `PostgresMaterializationStore` and migration 038. The published semantic
 * input is a test `MaterializationPublishedSource` (the documented seam for unit-style fixtures)
 * because a published rule cannot yet express a `rule_result` premise in the frozen AST; the
 * persistence, scope isolation and bitemporal behaviour under test are not mocked.
 */

const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const VALID_AT = '2026-09-21T12:00:00Z'
const LEAF_PREDICATE = 'leaf.flag'
const PROJECTION_REF: VersionRef = { id: 'projection.materialized', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}` }

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let scopeRef: ScopeRef

function versionRef(id: string): VersionRef {
  return { id, version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
}

function fact(assertionId: string, logicalAssertionId: string, recordedSeq: string, op: RuleFact['op']): RuleFact {
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

const FACTS: readonly RuleFact[] = [fact('f-1', 'la-1', '1', 'assert'), fact('f-2', 'la-2', '1', 'assert')]

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
    scopeRef,
    recordedSeq,
    recordedAt: VALIDITY.validFrom,
    kind: 'assertion_retracted',
    logicalAssertionId,
    predicate: LEAF_PREDICATE,
    validity: VALIDITY,
  }
}

function statusOf(result: MaterializationReadResult, propositionKey: string): string | undefined {
  return result.conclusions.find((conclusion) => conclusion.propositionKey === propositionKey)?.domainStatus
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'rule-dependency-materialization')
  scopeRef = scope.scopeRef
  ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-publisher', 'platform-admin'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('three-layer derived rule state against real PostgreSQL (V03-028)', () => {
  it('updates incrementally on retraction, keeps conclusions with surviving OR support and separates current from history', async () => {
    const source = new FixturePublishedSource({ facts: [...FACTS], rules: [...threeLayerRules()], entityBindings: [], historicalAsOfSupported: true })
    const store = new PostgresMaterializationStore(database)
    const materializer = new IncrementalMaterializer({ publishedSource: source, materialization: store })

    const initial = await materializer.applyChange(
      {
        changeId: randomUUID(),
        scopeRef,
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

    const request: MaterializationReadRequest = {
      scopeRef,
      projectionRef: PROJECTION_REF,
      validAt: VALID_AT,
      asOfRecordedSeq: '1',
    }
    const baseline = await materializer.read(request, ctx)
    expect(baseline.status).toBe('materialized')
    expect(statusOf(baseline, 'c.top')).toBe('known')

    // Retract one alternative of an OR premise; the survivor keeps the leaf supported and the two
    // downstream layers must not be deleted.
    source.setFacts([...FACTS, fact('f-1', 'la-1', '2', 'retract')])
    const partial = await materializer.applyChange(retractionChange('2', 'la-1'), ctx)
    expect([...partial.recomputedRuleIds].sort()).toEqual(['r.leaf', 'r.mid', 'r.top'])
    const afterPartial = await materializer.read({ ...request, asOfRecordedSeq: '2' }, ctx)
    expect(statusOf(afterPartial, 'c.leaf')).toBe('known')
    expect(statusOf(afterPartial, 'c.top')).toBe('known')

    // Retract the last alternative: the current projection becomes unknown (never false) while the
    // pre-retraction recorded version still resolves the original known result and support.
    source.setFacts([...FACTS, fact('f-1', 'la-1', '2', 'retract'), fact('f-2', 'la-2', '3', 'retract')])
    await materializer.applyChange(retractionChange('3', 'la-2'), ctx)
    const current = await materializer.read({ ...request, asOfRecordedSeq: '3' }, ctx)
    expect(statusOf(current, 'c.leaf')).toBe('unknown')
    expect(statusOf(current, 'c.top')).toBe('unknown')

    const historical = await materializer.read(request, ctx)
    expect(historical.status).toBe('materialized')
    expect(statusOf(historical, 'c.top')).toBe('known')
    expect(historical.conclusions.find((entry) => entry.propositionKey === 'c.top')?.value).toBe(true)

    // The fence is closed and the projection generation advanced, proving the update committed on
    // the real store rather than being served from a stale row.
    const state = await store.getProjectionState(scopeRef, ctx)
    expect(state?.dirty).toBe(false)
    expect(Number(state?.generation)).toBeGreaterThanOrEqual(3)
    expect(await store.listOpenFences(scopeRef, ctx)).toHaveLength(0)
  })
})
