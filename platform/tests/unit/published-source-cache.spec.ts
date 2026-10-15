import { randomUUID } from 'node:crypto'
import { createToolContext } from '@ontology/contracts'
import type { IdentityPublishedBindingSnapshot, PublishedRuleVersion, PublishedStatement, PublishedRuleDeclarationReader, ScopeRef, ToolContext, VersionRef } from '@ontology/contracts'
import { IndustryAssetPublicationError } from '@ontology/contracts'
import { PublishedSemanticSource } from '@ontology/semantic-engine'
import type { PublishedSemanticReadView } from '@ontology/semantic-engine'
import { describe, expect, it } from 'vitest'
import { toolContext } from './component-registry-fixtures'

const scope: ScopeRef = { tenantId: '11111111-2222-4333-8444-555555555555', spaceId: '99999999-8888-4777-8666-555555555555' }
const otherScope: ScopeRef = { tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb', spaceId: 'cccccccc-cccc-4ccc-8ccc-dddddddddddd' }
const schemaRef: VersionRef = { id: 'schema.facility', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const packRef: VersionRef = { id: 'pack.facility', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }

function sourceStatement(subject: string, due: boolean, marker = 'unchanged', extra: Readonly<Record<string, unknown>> = {}): PublishedStatement {
  const statementId = randomUUID(), sourceCandidateId = randomUUID()
  return {
    statementId, propositionKey: `${statementId}.attributes`, kind: 'entity', objectId: 'facility',
    subjectEntityId: subject, predicate: 'facility',
    value: { attributes: [{ attributeId: 'inspection_due', value: due }], marker, ...extra },
    recordedAt: '2026-10-10T00:00:00Z', sourceCandidateId, sourceRefs: [], publicationId: randomUUID(), version: '1', status: 'active',
  }
}

class MutableReadView implements PublishedSemanticReadView {
  revision = '1'
  statements: readonly PublishedStatement[]
  latestReadCalls = 0
  readonly statementCalls: string[] = []
  readonly publicationCalls: string[] = []
  readonly ruleCalls: string[] = []

  constructor(rows: readonly PublishedStatement[]) { this.statements = rows }
  async latestReadRevision(_scope: ScopeRef, _ctx: ToolContext): Promise<string> { void _scope; void _ctx; this.latestReadCalls += 1; return this.revision }
  async getPublication(_scope: ScopeRef, id: string, _ctx: ToolContext): Promise<{ readonly schemaRef: VersionRef } | undefined> {
    void _scope; void _ctx
    this.publicationCalls.push(id)
    return this.statements.some((row) => row.publicationId === id) ? { schemaRef } : undefined
  }
  async listStatements(_scope: ScopeRef, filter: { readonly afterStatementId?: string; readonly limit?: number }, _ctx: ToolContext): Promise<PublishedStatement[]> {
    void _scope; void _ctx
    this.statementCalls.push(this.revision)
    return this.statements.filter((row) => filter.afterStatementId === undefined || row.statementId > filter.afterStatementId)
      .sort((left, right) => left.statementId.localeCompare(right.statementId)).slice(0, filter.limit ?? 1_000)
  }
  async listRuleVersions(_scope: ScopeRef, filter: { readonly afterRule?: { readonly ruleId: string; readonly version: string }; readonly limit?: number }, _ctx: ToolContext): Promise<PublishedRuleVersion[]> {
    void _scope; void _ctx
    this.ruleCalls.push(this.revision)
    void filter
    return []
  }
}

class MutableIdentity {
  revision = '1'
  complete = true
  latestReadCalls = 0
  readonly entityByCandidate = new Map<string, string>()
  readonly bindingCalls: string[] = []

  async latestReadRevision(_scope: ScopeRef, _ctx: ToolContext): Promise<string> { void _scope; void _ctx; this.latestReadCalls += 1; return this.revision }
  async readPublishedBindings(_scope: ScopeRef, candidateIds: readonly string[], _ctx: ToolContext): Promise<IdentityPublishedBindingSnapshot> {
    void _scope; void _ctx
    this.bindingCalls.push(this.revision)
    return {
      readRevision: this.revision,
      complete: this.complete,
      bindings: candidateIds.map((candidateId) => {
        const entityId = this.entityByCandidate.get(candidateId)
        return { candidateId, openAssertions: entityId === undefined ? [] : [{
          assertionId: randomUUID(), candidateId, entityId, objectId: 'facility', identityScopeId: 'facility_identity', decisionId: randomUUID(),
          validFrom: '2026-10-10T00:00:00Z', recordedAt: '2026-10-10T00:00:00Z',
        }], cannotLinkEntityIds: [] }
      }),
    }
  }
}

function contextWithSource(ctx: ToolContext, sourceId: string): ToolContext {
  return createToolContext({
    principal: ctx.principal, runId: ctx.runId, resolvedProfileHash: ctx.resolvedProfileHash, policyVersion: ctx.policyVersion,
    deadline: ctx.deadline, budgetReservation: ctx.budgetReservation,
    allowedResources: { ...ctx.allowedResources, sourceRefs: [{ namespace: 'cache-test', sourceId }] }, traceId: ctx.traceId,
  })
}

function makeSource(input: {
  readonly view: MutableReadView
  readonly identity?: MutableIdentity
  readonly cacheStableReads?: boolean
  readonly publishedRules?: { readonly reader: PublishedRuleDeclarationReader; readonly request: { readonly packRef: VersionRef; readonly definitionRef: VersionRef } }
}) {
  return new PublishedSemanticSource(input.view, {
    ...(input.identity === undefined ? {} : { identity: input.identity }),
    definitionRef: schemaRef,
    ...(input.cacheStableReads === undefined ? {} : { cacheStableReads: input.cacheStableReads }),
    ...(input.publishedRules === undefined ? {} : { publishedRules: input.publishedRules }),
  })
}

describe('PublishedSemanticSource stable snapshot cache', () => {
  it('reuses one complete snapshot for the same source points but still rereads both authorization heads', async () => {
    const row = sourceStatement('facility:cache-a', true), view = new MutableReadView([row]), identity = new MutableIdentity()
    identity.entityByCandidate.set(row.sourceCandidateId, row.subjectEntityId!)
    const source = makeSource({ view, identity, cacheStableReads: true })
    const first = await source.load(scope, toolContext(scope.tenantId, scope.spaceId, ['platform-admin']))
    const statementCalls = view.statementCalls.length, bindingCalls = identity.bindingCalls.length
    const second = await source.load(scope, toolContext(scope.tenantId, scope.spaceId, ['platform-admin']))

    expect(first.complete).toBe(true)
    expect(second.facts).toEqual(first.facts)
    expect(view.statementCalls).toHaveLength(statementCalls)
    expect(identity.bindingCalls).toHaveLength(bindingCalls)
    expect(view.latestReadCalls).toBe(4)
    expect(identity.latestReadCalls).toBe(4)
    expect(view.publicationCalls).toHaveLength(1)
    expect(view.ruleCalls).toHaveLength(1)
  })

  it('invalidates on semantic or identity read-head movement', async () => {
    const firstRow = sourceStatement('facility:semantic-v1', true), secondRow = sourceStatement('facility:semantic-v2', false)
    const view = new MutableReadView([firstRow]), identity = new MutableIdentity()
    identity.entityByCandidate.set(firstRow.sourceCandidateId, firstRow.subjectEntityId!)
    identity.entityByCandidate.set(secondRow.sourceCandidateId, secondRow.subjectEntityId!)
    const source = makeSource({ view, identity, cacheStableReads: true }), ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])

    const first = await source.load(scope, ctx)
    view.revision = '2'; view.statements = [secondRow]
    const afterSemantic = await source.load(scope, ctx)
    identity.revision = '2'; identity.entityByCandidate.set(secondRow.sourceCandidateId, 'facility:identity-v2')
    const afterIdentity = await source.load(scope, ctx)

    expect(first.facts[0]?.subject).toBe('facility:semantic-v1')
    expect(afterSemantic.facts[0]?.subject).toBe('facility:semantic-v2')
    expect(afterIdentity.facts).toEqual([])
    expect(afterIdentity.complete).toBe(false)
    expect(afterIdentity.issues?.some((issue) => issue.code === 'PUBLISHED_IDENTITY_UNCONFIRMED')).toBe(true)
    identity.revision = '3'; identity.entityByCandidate.set(secondRow.sourceCandidateId, secondRow.subjectEntityId!)
    const restored = await source.load(scope, ctx)
    expect(restored.facts[0]?.subject).toBe('facility:semantic-v2')
    expect(restored.complete).toBe(true)
    expect(view.statementCalls).toHaveLength(4)
    expect(identity.bindingCalls).toHaveLength(4)
  })

  it('does not reuse across scope or allowed-resource changes', async () => {
    const row = sourceStatement('facility:scope-a', true), view = new MutableReadView([row]), identity = new MutableIdentity()
    identity.entityByCandidate.set(row.sourceCandidateId, row.subjectEntityId!)
    const source = makeSource({ view, identity, cacheStableReads: true })
    const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
    await source.load(scope, ctx)
    await source.load(otherScope, toolContext(otherScope.tenantId, otherScope.spaceId, ['platform-admin']))
    await source.load(scope, contextWithSource(ctx, 'different-authorized-source'))

    expect(view.statementCalls).toHaveLength(3)
    expect(identity.bindingCalls).toHaveLength(3)
  })

  it('freshly checks pack declaration authority and falls back to the incomplete source when it is withdrawn', async () => {
    const row = sourceStatement('facility:pack-a', true), view = new MutableReadView([row]), identity = new MutableIdentity()
    identity.entityByCandidate.set(row.sourceCandidateId, row.subjectEntityId!)
    let available = true
    let authorityReads = 0
    const reader: PublishedRuleDeclarationReader = { read: async () => {
      authorityReads += 1
      if (!available) throw new IndustryAssetPublicationError('DRAFT_NOT_FOUND', 'the pinned pack declaration is unavailable')
      return []
    } }
    const source = makeSource({ view, identity, cacheStableReads: true, publishedRules: { reader, request: { packRef, definitionRef: schemaRef } } })
    const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])

    expect((await source.load(scope, ctx)).complete).toBe(true)
    available = false
    const withdrawn = await source.load(scope, ctx)

    expect(withdrawn.complete).toBe(false)
    expect(withdrawn.issues?.some((issue) => issue.code === 'PUBLISHED_RULE_DECLARATION_UNAVAILABLE')).toBe(true)
    expect(authorityReads).toBe(3)
    expect(view.statementCalls).toHaveLength(2)
  })

  it('rejects a cache hit if a source head changes during fresh declaration authorization', async () => {
    const firstRow = sourceStatement('facility:before-race', true), secondRow = sourceStatement('facility:after-race', false)
    const view = new MutableReadView([firstRow]), identity = new MutableIdentity()
    identity.entityByCandidate.set(firstRow.sourceCandidateId, firstRow.subjectEntityId!)
    identity.entityByCandidate.set(secondRow.sourceCandidateId, secondRow.subjectEntityId!)
    let authorityReads = 0
    const reader: PublishedRuleDeclarationReader = { read: async () => {
      authorityReads += 1
      if (authorityReads === 2) { view.revision = '2'; view.statements = [secondRow] }
      return []
    } }
    const source = makeSource({ view, identity, cacheStableReads: true, publishedRules: { reader, request: { packRef, definitionRef: schemaRef } } })
    const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
    await source.load(scope, ctx)
    const afterRace = await source.load(scope, ctx)

    expect(afterRace.readRevision?.semantic).toBe('2')
    expect(afterRace.facts[0]?.subject).toBe('facility:after-race')
    expect(view.statementCalls).toHaveLength(2)
    expect(authorityReads).toBe(3)
  })

  it('returns structured clones so a caller cannot mutate the cached snapshot', async () => {
    const row = sourceStatement('facility:clone', true), view = new MutableReadView([row]), identity = new MutableIdentity()
    identity.entityByCandidate.set(row.sourceCandidateId, row.subjectEntityId!)
    const source = makeSource({ view, identity, cacheStableReads: true }), ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
    const first = await source.load(scope, ctx), firstStatement = first.premiseInput?.attributeStatements[0]
    if (firstStatement === undefined) throw new Error('the published source snapshot has no actual statement')
    expect(Reflect.set(firstStatement.value, 'marker', 'caller mutation')).toBe(true)
    const second = await source.load(scope, ctx)

    expect(second.premiseInput?.attributeStatements[0]?.value['marker']).toBe('unchanged')
    expect(view.statementCalls).toHaveLength(1)
  })

  it('never caches incomplete or snapshots exceeding the UTF-8 byte bound', async () => {
    const row = sourceStatement('facility:incomplete', true), view = new MutableReadView([row]), identity = new MutableIdentity()
    identity.entityByCandidate.set(row.sourceCandidateId, row.subjectEntityId!)
    identity.complete = false
    const source = makeSource({ view, identity, cacheStableReads: true }), ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
    expect((await source.load(scope, ctx)).complete).toBe(false)
    identity.complete = true
    expect((await source.load(scope, ctx)).complete).toBe(true)
    expect(view.statementCalls).toHaveLength(2)

    const largeRow = sourceStatement('facility:oversize', true, 'oversize', { large: 'x'.repeat(8 * 1024 * 1024 + 1) })
    const largeView = new MutableReadView([largeRow]), largeIdentity = new MutableIdentity()
    largeIdentity.entityByCandidate.set(largeRow.sourceCandidateId, largeRow.subjectEntityId!)
    const bounded = makeSource({ view: largeView, identity: largeIdentity, cacheStableReads: true })
    expect((await bounded.load(scope, ctx)).complete).toBe(true)
    await bounded.load(scope, ctx)
    expect(largeView.statementCalls).toHaveLength(2)
  })

  it('leaves the cache disabled by default', async () => {
    const row = sourceStatement('facility:default-off', true), view = new MutableReadView([row]), identity = new MutableIdentity()
    identity.entityByCandidate.set(row.sourceCandidateId, row.subjectEntityId!)
    const source = makeSource({ view, identity }), ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
    await source.load(scope, ctx)
    await source.load(scope, ctx)
    expect(view.statementCalls).toHaveLength(2)
  })
})
