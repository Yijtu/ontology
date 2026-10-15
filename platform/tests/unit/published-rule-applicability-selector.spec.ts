import { describe, expect, it } from 'vitest'
import type { PublishedPackRuleVersion, ScopeRef, VersionRef } from '@ontology/contracts'
import { compilePublishedRuleInstances, publishedRuleApplicabilityKey } from '@ontology/semantic-engine'

const scopeRef: ScopeRef = { tenantId: '11111111-2222-4333-8444-555555555555', spaceId: '99999999-8888-4777-8666-555555555555' }
const definitionRef: VersionRef = { id: 'maintenance-schema', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const projectId = '11111111-1111-4111-8111-111111111111'
const rule: PublishedPackRuleVersion = {
  ruleId: 'maintenance', ruleVersionId: '22222222-2222-4222-8222-222222222222', sourceCandidateId: '22222222-2222-4222-8222-222222222222',
  version: '3', objectId: 'machine', projectId, severity: 'soft', impact: 'low', recordedAt: '2026-10-09T00:00:00Z',
  expression: { op: 'compare', attributeId: 'hours', operator: 'gte', value: '8', unitCode: 'h', spans: [] }, exceptions: [],
  publishedPackRef: { id: 'maintenance-policy', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` },
  ruleRef: { id: '22222222-2222-4222-8222-222222222222', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}` },
}

describe('published applicability selection', () => {
  it('selects the exact compiler applicability without requiring a business conclusion', () => {
    const compiled = compilePublishedRuleInstances([rule], [], { scopeRef, definitionRef, projectId, subjects: [{ objectId: 'machine', subjectEntityId: 'M-1', projectId }] })
    expect(compiled.issues).toEqual([])
    expect(compiled.instances).toHaveLength(1)
    const identity = { ...scopeRef, definitionRef, ruleRef: rule.ruleRef, objectId: 'machine', subjectEntityId: 'M-1', projectId }
    const selected = publishedRuleApplicabilityKey(identity)
    expect(compiled.instances[0]?.supportRule.conclusion).toEqual({ propositionKey: selected, predicate: 'rule.applicability', value: true })
    expect(compiled.dependencyRules).toEqual([])
    for (const other of [
      { ...identity, tenantId: '33333333-3333-4333-8333-333333333333' },
      { ...identity, spaceId: '33333333-3333-4333-8333-333333333333' },
      { ...identity, projectId: '33333333-3333-4333-8333-333333333333' },
      { ...identity, subjectEntityId: 'M-2' },
      { ...identity, objectId: 'workshop' },
      { ...identity, definitionRef: { ...definitionRef, version: '2.0.0' } },
      { ...identity, ruleRef: { ...rule.ruleRef, digest: `sha256:${'d'.repeat(64)}` } },
    ]) expect(publishedRuleApplicabilityKey(other)).not.toBe(selected)
  })
})
