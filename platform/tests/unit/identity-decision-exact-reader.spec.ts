import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryIdentityDecisionStore } from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

describe('exact immutable identity decision reader', () => {
  it('indexes a scoped immutable decision and rejects duplicate ids without advancing another head', async () => {
    const scope = { tenantId: randomUUID(), spaceId: randomUUID() }, ctx = toolContext(scope.tenantId, scope.spaceId, ['semantic-reviewer'])
    const store = new InMemoryIdentityDecisionStore(), candidateId = randomUUID(), decisionId = randomUUID()
    const draft = { candidateId, decisionId, kind: 'reject' as const, objectId: 'machine', identityScopeId: 'machine_identity', evidenceRefs: [], recordedAt: '2026-10-09T00:00:00Z', actor: 'human-reviewer' }
    const saved = await store.appendDecision(scope, { expectedRevision: '0', draft }, ctx)
    expect(await store.getDecisionById(scope, decisionId, ctx)).toEqual(saved)
    expect(await store.getDecisionById(scope, randomUUID(), ctx)).toBeUndefined()
    const read = await store.getDecisionById(scope, decisionId, ctx)
    if (read === undefined) throw new Error('actual indexed decision missing')
    Object.assign(read, { actor: 'untrusted reader mutation' })
    expect(await store.getDecisionById(scope, decisionId, ctx)).toEqual(saved)
    const foreign = { tenantId: randomUUID(), spaceId: randomUUID() }, foreignCtx = toolContext(foreign.tenantId, foreign.spaceId, ['semantic-reviewer'])
    expect(await store.getDecisionById(foreign, decisionId, foreignCtx)).toBeUndefined()
    await expect(store.getDecisionById(foreign, decisionId, ctx)).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
    const another = randomUUID()
    await expect(store.appendDecision(scope, { expectedRevision: '0', draft: { ...draft, candidateId: another } }, ctx)).rejects.toMatchObject({ code: 'DECISION_STORE_FAILED' })
    expect(await store.latestRevision(scope, another, ctx)).toBe('0')
    expect(await store.latestReadRevision(scope, ctx)).toBe('1')
    expect(await store.getDecisionById(scope, decisionId, ctx)).toEqual(saved)
  })
})
