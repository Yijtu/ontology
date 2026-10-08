import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PublishedRuleVersion, RuleDependencyReference, RuleExpressionNode, ScopeRef, VersionRef } from '@ontology/contracts'
import { MaterializationDependencyIndex, RuleEvaluator, compilePublishedRuleInstances, publishedRuleDependencyRef, publishedRuleRef } from '@ontology/semantic-engine'
import type { RuleFact } from '@ontology/semantic-engine'

const scopeRef: ScopeRef = { tenantId: '11111111-2222-4333-8444-555555555555', spaceId: '99999999-8888-4777-8666-555555555555' }
const definitionRef: VersionRef = { id: 'synthetic-chain', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const projectId = '11111111-1111-4111-8111-111111111111'
const compare = (attributeId: string, value: string | boolean = true): RuleExpressionNode => ({ op: 'compare', attributeId, operator: 'eq', value, spans: [] })
function rule(ruleId: string, input: string, output: string, upstream: readonly PublishedRuleVersion[] = [], overrides: Partial<PublishedRuleVersion> = {}): PublishedRuleVersion {
  return { ruleId, ruleVersionId: randomUUID(), sourceCandidateId: randomUUID(), publicationId: randomUUID(), version: '1', objectId: 'asset', severity: 'soft', impact: 'low', expression: compare(input), exceptions: [], conclusion: { predicate: output, value: true }, recordedAt: '2026-09-21T00:00:00Z',
    ...(upstream.length === 0 ? {} : { ruleDependencies: upstream.map((item) => item.ruleId), dependencyRefs: upstream.map((item) => publishedRuleDependencyRef(item, scopeRef, definitionRef)) }), ...overrides }
}
function fact(subject: string, predicate: string, value = true, overrides: Partial<RuleFact> = {}): RuleFact {
  const id = randomUUID()
  return { assertionId: id, logicalAssertionId: id, recordedSeq: '1', op: 'assert', subject, objectId: 'asset', predicate, value, schemaRef: definitionRef, sourceRef: { namespace: 'synthetic', sourceId: id }, sourceStatementId: id,
    validity: { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }, ...overrides }
}
function evaluate(rules: readonly PublishedRuleVersion[], facts: readonly RuleFact[], project?: string) {
  const compilation = compilePublishedRuleInstances(rules, facts, { scopeRef, definitionRef, subjects: ['A-01', 'A-02'].map((subjectEntityId) => ({ objectId: 'asset', subjectEntityId, ...(project === undefined ? {} : { projectId: project }) })), ...(project === undefined ? {} : { projectId: project }) })
  const supportRules = [...compilation.instances.map((instance) => instance.supportRule), ...compilation.dependencyRules]
  const result = new RuleEvaluator().evaluate({ scopeRef, definitionRef, request: { scopeRef, projectionRef: definitionRef, validAt: '2026-09-21T12:00:00Z' }, facts, rules: supportRules })
  return { compilation, supportRules, result, state: (id: string, entity = 'A-01') => result.applicabilities.find((item) => item.ruleId === id && item.subjectEntityId === entity)?.state }
}

describe('fixed published rule dependency compilation (#262)', () => {
  it('compiles a real published three-layer declaration by subject, never by its object label', () => {
    const leaf = rule('service', 'hours_due', 'stage_one'), mid = rule('second', 'stage_one', 'stage_two', [leaf]), top = rule('third', 'stage_two', 'ready', [mid])
    const output = evaluate([top, mid, leaf], [fact('A-01', 'hours_due'), fact('asset', 'hours_due')])
    expect(output.compilation.issues).toEqual([])
    expect(output.state('third')).toBe('applicable')
    expect(output.state('third', 'A-02')).toBe('unknown')
    const final = output.result.applicabilities.find((item) => item.ruleId === 'third' && item.subjectEntityId === 'A-01')
    expect(final?.factRefs).toHaveLength(1)
    expect(final?.dependencyRefs?.[0]?.ruleRef).toEqual(publishedRuleRef(mid))
    expect(output.result.supports.nodes.some((node) => node.kind === 'fact' && node.upstreamConclusionNodeId?.startsWith('conclusion:rule-consequence:'))).toBe(true)
  })

  it('retains independent upstream producers and propagates unknown, exception and conflict', () => {
    const service = rule('service', 'hours_due', 'stage_one', [], { exceptions: [{ exceptionId: 'exempt', condition: compare('exempt'), spans: [] }] })
    const alarm = rule('alarm', 'alarm', 'stage_one'), mid = rule('second', 'stage_one', 'stage_two', [service, alarm]), top = rule('third', 'stage_two', 'ready', [mid])
    const rules = [service, alarm, mid, top]
    expect(evaluate(rules, [fact('A-01', 'hours_due'), fact('A-01', 'exempt', false), fact('A-01', 'alarm')]).state('third')).toBe('applicable')
    expect(evaluate(rules, [fact('A-01', 'hours_due'), fact('A-01', 'exempt'), fact('A-01', 'alarm')]).state('third')).toBe('applicable')
    expect(evaluate(rules, [fact('A-01', 'hours_due'), fact('A-01', 'exempt')]).state('third')).toBe('unknown')
    const conflicted = evaluate(rules, [fact('A-01', 'hours_due'), fact('A-01', 'hours_due', false), fact('A-01', 'exempt', false)])
    expect(conflicted.state('third')).toBe('conflict')
    expect(conflicted.result.applicabilities.find((item) => item.ruleId === 'third' && item.subjectEntityId === 'A-01')?.factRefs.length).toBeGreaterThanOrEqual(2)
  })

  it('cannot promote a boolean through a string ne operand', () => {
    const leaf = rule('service', 'hours_due', 'stage_one'), mid = rule('second', 'stage_one', 'ready', [leaf], { expression: { op: 'compare', attributeId: 'stage_one', operator: 'ne', value: 'true', spans: [] } })
    expect(evaluate([leaf, mid], [fact('A-01', 'hours_due')]).state('second')).toBe('unknown')
  })

  it('does not use an expired upstream version as same-entity support', () => {
    const leaf = rule('service', 'hours_due', 'stage_one', [], { validTo: '2026-09-21T12:00:00Z' }), mid = rule('second', 'stage_one', 'ready', [leaf])
    const output = evaluate([leaf, mid], [fact('A-01', 'hours_due')])
    expect(output.state('service')).toBe('not_applicable')
    expect(output.state('second')).toBe('unknown')
    expect(output.result.conclusions.filter((item) => item.predicate === 'stage_one').every((item) => item.value !== false)).toBe(true)
  })

  it('fails closed on missing dependency pins and foreign object, definition or project pins', () => {
    const leaf = rule('service', 'hours_due', 'stage_one'), ref = publishedRuleDependencyRef(leaf, scopeRef, definitionRef)
    const variants: readonly (RuleDependencyReference | undefined)[] = [undefined, { ...ref, objectId: 'workshop' }, { ...ref, definitionRef: { ...definitionRef, version: '2.0.0' } }, { ...ref, scopeRef: { ...scopeRef, spaceId: randomUUID() } }, { ...ref, projectId }]
    for (const pin of variants) {
      const mid = rule('second', 'stage_one', 'ready', [leaf], { dependencyRefs: pin === undefined ? [] : [pin] })
      const output = evaluate([leaf, mid], [fact('A-01', 'hours_due')])
      expect(output.compilation.issues).toHaveLength(1)
      expect(output.state('second')).toBeUndefined()
    }
    const scoped = rule('service', 'hours_due', 'stage_one', [], { projectId })
    const mid = rule('second', 'stage_one', 'ready', [scoped], { projectId })
    expect(evaluate([scoped, mid], [fact('A-01', 'hours_due', true, { projectId: randomUUID() })], projectId).state('second')).toBe('unknown')
    expect(evaluate([scoped, mid], [fact('A-01', 'hours_due', true, { projectId })], projectId).state('second')).toBe('applicable')
  })

  it('makes replacement dependencies unknown and indexes the disappeared pin for invalidation', () => {
    const leaf = rule('service', 'hours_due', 'stage_one'), mid = rule('second', 'stage_one', 'ready', [leaf])
    const facts = [fact('A-01', 'hours_due')], baseline = evaluate([leaf, mid], facts)
    const replacement = { ...leaf, ruleVersionId: randomUUID(), version: '2' }
    const changed = evaluate([replacement, mid], facts)
    expect(changed.state('second')).toBe('unknown')
    expect(changed.compilation.issues.map((issue) => issue.code)).toEqual(['UNRESOLVED_DEPENDENCY'])
    const index = MaterializationDependencyIndex.build({ rules: changed.supportRules, facts })
    const affected = index.affectedRuleIds({ kind: 'rule_changed', ruleId: 'service', propositionKey: 'asset', changeId: randomUUID(), scopeRef, recordedSeq: '2', recordedAt: '2026-09-21T00:00:00Z' })
    expect(affected).toEqual(expect.arrayContaining(changed.supportRules.filter((item) => item.publishedInstance?.ruleId === 'second').map((item) => item.ruleId)))
    expect(baseline.state('second')).toBe('applicable')
  })

  it('reports CYCLE_DETECTED and depth overflow while retaining an unrelated finite subset', () => {
    const a = rule('a', 'b_value', 'a_value'), b = rule('b', 'a_value', 'b_value', [a])
    const cycleA = { ...a, ruleDependencies: ['b'], dependencyRefs: [publishedRuleDependencyRef(b, scopeRef, definitionRef)] }
    const independent = rule('independent', 'hours_due', 'ready')
    const cyclic = evaluate([cycleA, b, independent], [fact('A-01', 'hours_due')])
    expect(cyclic.compilation.issues.map((item) => item.code)).toEqual(['CYCLE_DETECTED', 'CYCLE_DETECTED'])
    expect(cyclic.state('independent')).toBe('applicable')
    const chain: PublishedRuleVersion[] = [rule('depth0', 'hours_due', 'd0')]
    for (let i = 1; i <= 4; i += 1) { const upstream = chain.at(-1); if (upstream === undefined) throw new Error('missing authored depth node'); chain.push(rule(`depth${String(i)}`, `d${String(i - 1)}`, `d${String(i)}`, [upstream])) }
    expect(evaluate(chain, [fact('A-01', 'hours_due')]).compilation.issues.map((item) => item.code)).toEqual(['DEPENDENCY_DEPTH_EXCEEDED'])
  })
})
