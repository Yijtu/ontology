import { describe, expect, it } from 'vitest'
import type { SemanticQueryPlan } from '@ontology/contracts'
import {
  compileSemanticQuery,
  isSemanticMappingError,
  renderCompiledQuery,
  type CompilationBudget,
  type SemanticMapping,
} from '@ontology/semantic-engine'
import {
  COMPILE_BUDGET,
  MAPPING_A,
  MAPPING_B,
  MAPPING_C,
  MAPPING_CROSS_SOURCE,
  MAPPING_JOIN,
  MAPPING_JOIN_MISSING_KEY,
  METER_CONCEPT,
  READING_CONCEPT,
  semanticPlan,
} from '../fixtures/semantic-mapping'

function errorCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (isSemanticMappingError(error)) return error.code
    throw error
  }
  throw new Error('expected the compiler to refuse the plan')
}

function withFilters(plan: SemanticQueryPlan, filters: SemanticQueryPlan['filters']): SemanticQueryPlan {
  return { ...plan, filters }
}

describe('semantic query compilation', () => {
  it('compiles the same concept query against two different mappings and tags the actual version', () => {
    const planA = semanticPlan(MAPPING_A)
    const planB = semanticPlan(MAPPING_B)
    const compiledA = compileSemanticQuery(planA, MAPPING_A, { budget: COMPILE_BUDGET })
    const compiledB = compileSemanticQuery(planB, MAPPING_B, { budget: COMPILE_BUDGET })

    // Same canonical output shape: the same field ids, in the same order.
    expect(compiledA.projections.map((projection) => projection.fieldRef)).toEqual([
      'meter_id',
      'recorded_at',
      'energy_kwh',
      'status',
    ])
    expect(compiledB.projections.map((projection) => projection.fieldRef)).toEqual(
      compiledA.projections.map((projection) => projection.fieldRef),
    )

    // The two mappings really are different physical mappings, each tagged with its own version.
    expect(compiledA.mappingRef).toEqual(MAPPING_A.mappingRef)
    expect(compiledB.mappingRef).toEqual(MAPPING_B.mappingRef)
    expect(compiledA.mappingRef.digest).not.toBe(compiledB.mappingRef.digest)

    const renderedA = renderCompiledQuery(compiledA)
    const renderedB = renderCompiledQuery(compiledB)
    expect(renderedA.sql).toContain('"public"."energy_readings_a"')
    expect(renderedA.sql).toContain('"energy_wh"')
    expect(renderedB.sql).toContain('"public"."energy_readings_b"')
    expect(renderedB.sql).toContain('"quality_label"')
    // Values are bound, and the encodings differ per mapping.
    expect(renderedA.parameters).toEqual([1, 'good', 0, 'suspect', 'unknown', 10, 1])
    expect(renderedB.parameters).toEqual(['OK', 'good', 'BAD', 'suspect', 'unknown', 10, 'OK'])
  })

  it('refuses a crafted concept id instead of letting it become an identifier', () => {
    const plan = { ...semanticPlan(MAPPING_A), concepts: ['energy_reading; DROP TABLE x'] }
    expect(errorCode(() => compileSemanticQuery(plan, MAPPING_A, { budget: COMPILE_BUDGET }))).toBe(
      'UNMAPPED_CONCEPT',
    )
  })

  it('refuses a crafted field id instead of letting it become an identifier', () => {
    const plan = { ...semanticPlan(MAPPING_A), fields: ['meter_id" = "x'] }
    expect(errorCode(() => compileSemanticQuery(plan, MAPPING_A, { budget: COMPILE_BUDGET }))).toBe(
      'UNMAPPED_FIELD',
    )
  })

  it('binds a filter value and never concatenates it into the SQL text', () => {
    const injection = "m1' OR '1'='1"
    const plan = withFilters(semanticPlan(MAPPING_A), [{ fieldRef: 'meter_id', op: 'eq', values: [injection] }])
    const rendered = renderCompiledQuery(compileSemanticQuery(plan, MAPPING_A, { budget: COMPILE_BUDGET }))
    expect(rendered.sql).not.toContain(injection)
    expect(rendered.sql).not.toContain("OR '1'='1")
    expect(rendered.parameters).toContain(injection)
  })

  it('refuses a filter value that is not a canonical value of an encoded field', () => {
    const plan = withFilters(semanticPlan(MAPPING_A), [{ fieldRef: 'status', op: 'eq', values: ['excellent'] }])
    expect(errorCode(() => compileSemanticQuery(plan, MAPPING_A, { budget: COMPILE_BUDGET }))).toBe(
      'INVALID_FILTER_VALUE',
    )
  })

  it('refuses a cross-source join whose declared fanout exceeds the budget', () => {
    const plan: SemanticQueryPlan = {
      ...semanticPlan(MAPPING_CROSS_SOURCE),
      concepts: [READING_CONCEPT, METER_CONCEPT],
      fields: ['meter_id'],
      filters: [],
      orderBy: [],
      links: ['reading_meter'],
    }
    expect(
      errorCode(() => compileSemanticQuery(plan, MAPPING_CROSS_SOURCE, { budget: COMPILE_BUDGET })),
    ).toBe('BUDGET_EXCEEDED')
  })

  it('refuses an in-budget cross-source join because one backend cannot preserve its scope', () => {
    const relaxed: CompilationBudget = { ...COMPILE_BUDGET, maxJoinFanout: 1_000_000 }
    const plan: SemanticQueryPlan = {
      ...semanticPlan(MAPPING_CROSS_SOURCE),
      concepts: [READING_CONCEPT, METER_CONCEPT],
      fields: ['meter_id'],
      filters: [],
      orderBy: [],
      links: ['reading_meter'],
    }
    expect(errorCode(() => compileSemanticQuery(plan, MAPPING_CROSS_SOURCE, { budget: relaxed }))).toBe(
      'CROSS_SOURCE_JOIN_REFUSED',
    )
  })

  it('refuses a join whose declared keys do not exist in the endpoint mappings', () => {
    const plan: SemanticQueryPlan = {
      ...semanticPlan(MAPPING_JOIN_MISSING_KEY),
      concepts: [READING_CONCEPT, METER_CONCEPT],
      fields: ['meter_id'],
      filters: [],
      orderBy: [],
      links: ['reading_meter'],
    }
    expect(
      errorCode(() => compileSemanticQuery(plan, MAPPING_JOIN_MISSING_KEY, { budget: COMPILE_BUDGET })),
    ).toBe('RELATION_KEY_REQUIRED')
  })

  it('refuses several concepts with no declared relation', () => {
    const plan: SemanticQueryPlan = {
      ...semanticPlan(MAPPING_JOIN),
      concepts: [READING_CONCEPT, METER_CONCEPT],
      fields: ['meter_id'],
      filters: [],
      orderBy: [],
      links: [],
    }
    expect(errorCode(() => compileSemanticQuery(plan, MAPPING_JOIN, { budget: COMPILE_BUDGET }))).toBe(
      'JOIN_RELATION_REQUIRED',
    )
  })

  it('compiles a same-source join with its explicit keys into a real JOIN', () => {
    const plan: SemanticQueryPlan = {
      ...semanticPlan(MAPPING_JOIN),
      concepts: [READING_CONCEPT, METER_CONCEPT],
      fields: ['meter_id', 'meter_name'],
      filters: [],
      orderBy: [{ fieldRef: 'meter_id', direction: 'asc' }],
      links: ['reading_meter'],
    }
    const rendered = renderCompiledQuery(compileSemanticQuery(plan, MAPPING_JOIN, { budget: COMPILE_BUDGET }))
    expect(rendered.sql).toContain('JOIN "public"."meters_a" AS "t1"')
    expect(rendered.sql).toContain('"t0"."meter_id" = "t1"."meter_id"')
  })

  it('refuses a plan whose limit exceeds the row budget', () => {
    const plan = { ...semanticPlan(MAPPING_A), limit: 5000 }
    expect(errorCode(() => compileSemanticQuery(plan, MAPPING_A, { budget: COMPILE_BUDGET }))).toBe(
      'BUDGET_EXCEEDED',
    )
  })

  it('refuses a plan whose projected transfer exceeds the byte budget', () => {
    const plan = { ...semanticPlan(MAPPING_A), limit: 1000 }
    const tight: CompilationBudget = { ...COMPILE_BUDGET, maxBytes: 256, estimatedBytesPerRow: 64 }
    expect(errorCode(() => compileSemanticQuery(plan, MAPPING_A, { budget: tight }))).toBe('BUDGET_EXCEEDED')
  })

  it('requires a mapped time field for a time window', () => {
    const plan: SemanticQueryPlan = {
      ...semanticPlan(MAPPING_A),
      time: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
    }
    const withoutTimeField: SemanticMapping = {
      ...MAPPING_A,
      objects: MAPPING_A.objects.map((object) => ({
        conceptId: object.conceptId,
        sourceObjectRef: object.sourceObjectRef,
        schema: object.schema,
        relation: object.relation,
        relationKind: object.relationKind,
        estimatedRows: object.estimatedRows,
        fields: object.fields,
      })),
      mappingRef: MAPPING_A.mappingRef,
    }
    expect(
      errorCode(() => compileSemanticQuery(plan, withoutTimeField, { budget: COMPILE_BUDGET })),
    ).toBe('TIME_FIELD_UNMAPPED')
  })

  it('renders dialect-specific placeholders and table references', () => {
    const postgres = renderCompiledQuery(
      compileSemanticQuery(semanticPlan(MAPPING_B), MAPPING_B, { budget: COMPILE_BUDGET }),
    )
    const duckdb = renderCompiledQuery(
      compileSemanticQuery(semanticPlan(MAPPING_C), MAPPING_C, { budget: COMPILE_BUDGET }),
    )
    expect(postgres.sql).toContain('$1')
    expect(postgres.sql).toContain('"public"."energy_readings_b"')
    expect(duckdb.sql).toContain('?')
    expect(duckdb.sql).toContain('"energy_readings_c"')
    expect(duckdb.sql).not.toContain('"main"')
  })

  it('is a deterministic pure function that needs no planner or model', () => {
    const plan = semanticPlan(MAPPING_A)
    const first = compileSemanticQuery(plan, MAPPING_A, { budget: COMPILE_BUDGET })
    const second = compileSemanticQuery(plan, MAPPING_A, { budget: COMPILE_BUDGET })
    expect(second).toEqual(first)
    // The only injected dependency is the budget; there is no port for a model or planner.
    expect(compileSemanticQuery.length).toBe(3)
  })

  it('rejects a plan pinned to a different mapping version', () => {
    const plan: SemanticQueryPlan = { ...semanticPlan(MAPPING_A), mappingVersion: MAPPING_B.mappingRef }
    expect(errorCode(() => compileSemanticQuery(plan, MAPPING_A, { budget: COMPILE_BUDGET }))).toBe(
      'MAPPING_VERSION_MISMATCH',
    )
  })
})
