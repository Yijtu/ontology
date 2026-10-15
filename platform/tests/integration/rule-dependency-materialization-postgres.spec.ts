import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, PostgresMaterializationStore } from '@ontology/adapter-control-postgres'
import { IncrementalMaterializer, RuleEvaluator, publishedRuleDependencyRef } from '@ontology/semantic-engine'
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
import { publishedRuleChainHarness } from './published-rule-chain-harness'
import { INDUSTRIAL_RULES } from '../fixtures/competency-questions/assets'
import { PostgresProjectStore, PostgresProjectReadinessStore, PostgresJobStore } from '@ontology/adapter-control-postgres'
import { ProjectService, canonicalJson, sha256DigestOf } from '@ontology/application'

/**
 * Real-PostgreSQL acceptance for the three-layer acyclic rule-dependency graph, its incremental
 * materialisation and temporal read-back (issue V03-028 / #197, A.US-009.AC-03).
 *
 * The fence/CAS lifecycle, the append-only slice store, the watermark and the historical read all
 * run against the real `PostgresMaterializationStore` and migrations 038/080. The direct-rule
 * fixture remains a store regression. The #262 acceptance below uses original source parses,
 * actual candidates, ledger review, enablement, publication, compilation and evaluation.
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

describe('actual published pack rule chain (#262)', () => {
  it('reads the actual current frozen project rules from the active revision while a different staging head exists', async () => {
      const s = await createJobScope(harness.adminClient, 'evolution-active-pack-rules'), context = toolContext(s.tenantId, s.spaceId, ['platform-admin', 'profile-editor', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
      const p = await publishedRuleChainHarness(database, harness.appUrl, s, context), projectId = randomUUID()
      try {
          const projectService = new ProjectService({
              projects: new PostgresProjectStore(database), readiness: new PostgresProjectReadinessStore(database), jobs: new PostgresJobStore(database), catalogue: {
                  listEntries: async () => [], findPack: async () => p.asset.packAsset
              }
          })
          const created = await projectService.createProject({
              title: 'old active rule version', industryPackRef: p.asset.packRef, profileRef: {
                  id: 'reader-fixture', version: '1.0.0', snapshotHash: p.asset.packRef.digest
              }, documentSetRef: {
                  id: randomUUID(), version: '1.0.0', digest: p.asset.packRef.digest, kind: 'artifact'
              }, mappingRefs: [{
                      ...p.definition.ref, role: 'catalog', sourceObjectRef: {
                          sourceRef: {
                              namespace: 'rule-reader', sourceId: 'identity'
                          }, objectPath: 'identity'
                      }
                  }]
          }, `active-rules-${projectId}`, context.principal.subjectId, context)
          const actualProjectId = created.project.projectId
          const firstBody = {
              schemaVersion: 'project-revision@1', projectId: actualProjectId, revision: '1', industryPackRef: p.asset.packRef, definitionRef: p.definition.ref, mappingRefs: created.revision.mappingRefs, profileRef: created.revision.profileRef, documentSetRef: created.revision.documentSetRef, semanticPublicationRefs: [], sourceVisibilityEpoch: '0', changeReason: 'created'
          }
          const firstDigest = created.revision.ref.digest
          const stagedBody = {
              ...firstBody, revision: '2', definitionRef: {
                  ...p.definition.ref, version: '2.0.0', digest: `sha256:${'f'.repeat(64)}`
              }, changeReason: 'different staging selector fixture'
          }
          await harness.adminClient.query(`INSERT INTO agent_platform.project_revisions(tenant_id,space_id,project_id,revision,digest,body,source_visibility_epoch,change_reason,idempotency_key,request_digest,actor,recorded_at) VALUES($1,$2,$3,2,$4,$5::jsonb,0,$6,$7,$4,'fixture',now())`, [s.tenantId, s.spaceId, actualProjectId, sha256DigestOf(canonicalJson(stagedBody)), JSON.stringify(stagedBody), stagedBody.changeReason, randomUUID()])
          await harness.adminClient.query('UPDATE agent_platform.projects SET head_revision=2,active_revision=1 WHERE tenant_id=$1 AND space_id=$2 AND project_id=$3', [s.tenantId, s.spaceId, actualProjectId])
          const current = await p.packReader.read(s.scopeRef, {
              ...p.request, projectId: actualProjectId
          }, context)
          expect(current.map((rule) => rule.ruleId).sort()).toEqual(['layer-three', 'layer-two', 'service'])
          expect(current.every((rule) => rule.projectId === actualProjectId && rule.publishedPackRef.digest === p.asset.packRef.digest)).toBe(true)
          expect(await p.packReader.read(s.scopeRef, {
              ...p.request, projectId: actualProjectId, readMode: 'published_snapshot', projectRevisionRef: {
                  projectId: actualProjectId, revision: '1', digest: firstDigest
              }
          }, context)).toEqual(current)
          await expect(p.packReader.read(s.scopeRef, {
              ...p.request, projectId: actualProjectId, definitionRef: stagedBody.definitionRef
          }, context)).rejects.toMatchObject({
              code: 'VALIDATION_BLOCKED'
          })
      }
      finally {
          await p.close()
      }
  }, 180000)
  it('persists extracted dependency pins through migration 080 and evaluates the stored three-layer chain', async () => {
    const s = await createJobScope(harness.adminClient, 'extracted-published-chain')
    const context = toolContext(s.tenantId, s.spaceId, ['platform-admin', 'profile-editor', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
    const p = await publishedRuleChainHarness(database, harness.appUrl, s, context)
    try {
      const first = await p.importSupport('A-01', 120)
      const leaf = await p.publishExtractedRule(INDUSTRIAL_RULES[0])
      const mid = await p.publishExtractedRule(INDUSTRIAL_RULES[1], [publishedRuleDependencyRef(leaf, s.scopeRef, p.definition.ref)])
      const top = await p.publishExtractedRule(INDUSTRIAL_RULES[2], [publishedRuleDependencyRef(mid, s.scopeRef, p.definition.ref)])
      const reread = await p.publication.listRuleVersions(s.scopeRef, { sourceCandidateId: top.sourceCandidateId }, context)
      expect(reread[0]?.ruleDependencies).toEqual(['extracted-layer-two'])
      expect(reread[0]?.dependencyRefs).toEqual(top.dependencyRefs)
      const data = await p.source.load(s.scopeRef, context)
      expect(data.ruleIssues).toEqual([])
      const result = new RuleEvaluator().evaluate({ scopeRef: s.scopeRef, definitionRef: p.definition.ref, facts: data.facts, rules: data.rules, request: { scopeRef: s.scopeRef, projectionRef: PROJECTION_REF, validAt: new Date(Date.now() + 1_000).toISOString() } })
      expect(result.applicabilities.find((row) => row.ruleId === 'extracted-layer-three' && row.subjectEntityId === first.entityId)?.state).toBe('applicable')
    } finally { await p.close() }
  }, 180_000)

  it('rejects a real rule approval revocation at the publication commit fence', async () => {
    const s = await createJobScope(harness.adminClient, 'rule-publication-race')
    const context = toolContext(s.tenantId, s.spaceId, ['platform-admin', 'profile-editor', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
    await expect(publishedRuleChainHarness(database, harness.appUrl, s, context, async (input, reviews) => {
      const pin = input.ruleReviewPins?.[0]; if (pin === undefined) throw new Error('missing actual rule review pin')
      await reviews.appendReview(s.scopeRef, { expectedRevision: pin.reviewRevision, draft: { candidateId: pin.candidateId, reviewId: randomUUID(), decision: 'reject', contentDigest: pin.contentDigest, reason: 'human approval revoked after publication preparation', evidenceRefs: [], actor: context.principal.subjectId, recordedAt: new Date().toISOString() } }, context)
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const counts = await harness.adminClient.query<{ packs: string; definitions: string; publication_events: string }>(`SELECT
      (SELECT count(*) FROM agent_platform.published_pack_assets WHERE tenant_id=$1 AND space_id=$2)::text AS packs,
      (SELECT count(*) FROM agent_platform.semantic_definition_versions WHERE tenant_id=$1 AND space_id=$2)::text AS definitions,
      (SELECT count(*) FROM agent_platform.job_outbox WHERE tenant_id=$1 AND space_id=$2 AND topic='asset.pack.published')::text AS publication_events`, [s.tenantId, s.spaceId])
    expect(counts.rows[0]).toEqual({ packs: '0', definitions: '0', publication_events: '0' })
  }, 180_000)

  it('produces three layers from reviewed enabled published declarations, keeps alternative sources and recorded history', async () => {
    const projectScope = await createJobScope(harness.adminClient, 'published-chain')
    const context = toolContext(projectScope.tenantId, projectScope.spaceId, ['platform-admin', 'profile-editor', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
    const p = await publishedRuleChainHarness(database, harness.appUrl, projectScope, context)
    try {
      const first = await p.importSupport('A-01', 120), second = await p.importSupport('A-01', 120, false, first.entityId)
      const other = await p.importSupport('A-02', 30)
      const validAt = new Date(Date.now() + 1_000).toISOString()
      const validity = { validFrom: new Date(Date.now() - 60_000).toISOString(), validTo: new Date(Date.now() + 60_000).toISOString() }
      const published = await p.source.load(projectScope.scopeRef, context)
      expect(published.ruleIssues).toEqual([])
      const actual = new RuleEvaluator().evaluate({ scopeRef: projectScope.scopeRef, definitionRef: p.definition.ref, facts: published.facts, rules: published.rules, request: { scopeRef: projectScope.scopeRef, projectionRef: PROJECTION_REF, validAt } })
      const top = actual.applicabilities.find((row) => row.ruleId === 'layer-three' && row.subjectEntityId === first.entityId)
      expect(top).toMatchObject({ conditionState: p.goldExpected.conditionState, state: p.goldExpected.applicability, positiveSupport: true, publishedPackRef: p.asset.packRef })
      expect(top?.sourceStatementIds).toEqual(expect.arrayContaining([first.candidate.candidateId, second.candidate.candidateId]))
      expect(top?.sourceStatementIds).not.toContain(other.candidate.candidateId)
      expect(actual.applicabilities.find((row) => row.ruleId === 'layer-three' && row.subjectEntityId === other.entityId)?.state).toBe('unknown')
      expect(actual.supports.nodes.some((node) => node.kind === 'fact' && node.upstreamConclusionNodeId?.startsWith('conclusion:rule-consequence:'))).toBe(true)
      expect(p.asset.ruleDeclarations).toHaveLength(3)
      const materializer = new IncrementalMaterializer({ publishedSource: p.source, materialization: new PostgresMaterializationStore(database) })
      const change = (seq: string, id: string): MaterializationChange => ({ changeId: randomUUID(), scopeRef: projectScope.scopeRef, recordedSeq: seq, recordedAt: new Date().toISOString(), kind: seq === '1' ? 'assertion_published' : 'assertion_retracted', logicalAssertionId: id, predicate: 'hours', subjectEntityId: first.entityId, validity })
      await materializer.applyChange(change('1', first.candidate.candidateId), context)
      const ready = published.rules.find((row) => row.publishedInstance?.ruleId === 'layer-three' && row.publishedInstance.subjectEntityId === first.entityId && row.conclusion.propositionKey.startsWith('business-conclusion:'))?.conclusion.propositionKey
      if (ready === undefined) throw new Error('missing actual business output')
      const request = { scopeRef: projectScope.scopeRef, projectionRef: PROJECTION_REF, validAt, asOfRecordedSeq: '1', propositionKeys: [ready] }
      expect(statusOf(await materializer.read(request, context), ready)).toBe('known')
      await p.publisher.reviseStatement({ statementId: first.candidate.candidateId, kind: 'retraction', reason: 'first independent source withdrawn', expectedRevision: '1', idempotencyKey: `withdraw-${randomUUID()}` }, context)
      const surviving = await p.source.load(projectScope.scopeRef, context)
      const remaining = new RuleEvaluator().evaluate({ scopeRef: projectScope.scopeRef, definitionRef: p.definition.ref, facts: surviving.facts, rules: surviving.rules, request: { scopeRef: projectScope.scopeRef, projectionRef: PROJECTION_REF, validAt } })
      expect(remaining.applicabilities.find((row) => row.ruleId === 'layer-three' && row.subjectEntityId === first.entityId)?.state).toBe('applicable')
      await materializer.applyChange(change('2', first.candidate.candidateId), context)
      const retained = await materializer.read({ ...request, asOfRecordedSeq: '2' }, context)
      expect(statusOf(retained, ready), JSON.stringify(retained.conclusions)).toBe('known')
      await p.publisher.reviseStatement({ statementId: second.candidate.candidateId, kind: 'retraction', reason: 'last independent source withdrawn', expectedRevision: '1', idempotencyKey: `withdraw-${randomUUID()}` }, context)
      await materializer.applyChange(change('3', second.candidate.candidateId), context)
      expect(statusOf(await materializer.read({ ...request, asOfRecordedSeq: '3' }, context), ready)).toBe('unknown')
      expect(statusOf(await materializer.read(request, context), ready)).toBe('known')
      expect((await p.packReader.read(projectScope.scopeRef, p.request, context)).map((rule) => rule.ruleId).sort()).toEqual(['layer-three', 'layer-two', 'service'])
    } finally { await p.close() }
  }, 180_000)

  it('keeps published P1 after an unreviewed V2 proposal, blocks explicit P1 revocation and preserves frozen evidence', async () => {
    const projectScope = await createJobScope(harness.adminClient, 'published-chain-version')
    const context = toolContext(projectScope.tenantId, projectScope.spaceId, ['platform-admin', 'profile-editor', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
    const p = await publishedRuleChainHarness(database, harness.appUrl, projectScope, context)
    try {
      const first = await p.importSupport('A-01', 120)
      const service = p.saved.get('service'); if (service === undefined || service.payload.conclusion === undefined) throw new Error('missing reviewed service rule')
      await p.rules.editRuleCandidate(p.asset.workspaceId, { candidateId: service.candidateId, expectedRevision: '2', reason: 'unreviewed future proposal', idempotencyKey: `edit-${randomUUID()}`, displayName: 'future service', businessMeaning: 'future service', suggestedReason: 'proposal', ruleId: 'service', applicability: service.payload.applicability,
        condition: { op: 'range', attributeId: 'hours', min: 999, unitCode: 'h', spans: service.payload.condition.spans }, exceptions: service.payload.exceptions, conclusion: service.payload.conclusion, ruleDependencies: [], sourceRefs: service.sourceRefs, sourceSpans: service.sourceSpans }, context.principal.subjectId, context)
      await p.approve(service.candidateId, '1')
      const data = await p.source.load(projectScope.scopeRef, context)
      const result = new RuleEvaluator().evaluate({ scopeRef: projectScope.scopeRef, definitionRef: p.definition.ref, facts: data.facts, rules: data.rules, request: { scopeRef: projectScope.scopeRef, projectionRef: PROJECTION_REF, validAt: new Date(Date.now() + 1_000).toISOString() } })
      expect(result.applicabilities.find((row) => row.ruleId === 'layer-three' && row.subjectEntityId === first.entityId)?.state).toBe('applicable')
      const blocker = new Client({ connectionString: harness.adminUrl }), writer = new Client({ connectionString: harness.adminUrl })
      await blocker.connect(); await writer.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM agent_platform.industry_workspaces WHERE tenant_id=$1 AND space_id=$2 AND workspace_id=$3 FOR UPDATE', [projectScope.tenantId, projectScope.spaceId, p.asset.workspaceId])
        await writer.query("SET lock_timeout = '100ms'")
        await expect(writer.query(`INSERT INTO agent_platform.semantic_candidate_reviews
          (tenant_id,space_id,review_id,candidate_id,revision,decision,reason,evidence_refs,recorded_at,actor,content_digest)
          VALUES ($1,$2,$3,$4,3,'reject','explicit publication race','[]'::jsonb,now(),'reviewer',$5)`,
        [projectScope.tenantId, projectScope.spaceId, randomUUID(), service.candidateId, service.contentDigest])).rejects.toMatchObject({ code: '55P03' })
      } finally { await blocker.query('ROLLBACK'); await blocker.end(); await writer.end() }
      await p.publication.appendReview(projectScope.scopeRef, { expectedRevision: '2', draft: { candidateId: service.candidateId, reviewId: randomUUID(), decision: 'reject', contentDigest: service.contentDigest, reason: 'explicitly revoke published P1 content', evidenceRefs: [], actor: context.principal.subjectId, recordedAt: new Date().toISOString() } }, context)
      expect((await p.source.load(projectScope.scopeRef, context)).complete).toBe(false)
      const historical = await p.packReader.read(projectScope.scopeRef, { ...p.request, readMode: 'published_snapshot' }, context)
      expect(historical.find((row) => row.ruleId === 'service')?.expression).toEqual(service.payload.condition)
      expect(historical.every((row) => row.publishedPackRef.digest === p.asset.packRef.digest)).toBe(true)
      await p.instances.insertCandidates(projectScope.scopeRef, [{ ...first.candidate, candidateId: service.candidateId, idempotencyKey: `sha256:${'f'.repeat(64)}` }], context)
      await expect(p.reader.readCandidate(projectScope.scopeRef, service.candidateId, context)).rejects.toMatchObject({ code: 'AMBIGUOUS_CANDIDATE' })
      await expect(p.publisher.reviewCandidate({ candidateId: service.candidateId, decision: 'approve', reason: 'must not select a colliding review domain', expectedRevision: '3' }, context)).rejects.toMatchObject({ code: 'CANDIDATE_DOMAIN_UNPUBLISHABLE' })
      expect(await p.publication.latestReviewRevision(projectScope.scopeRef, service.candidateId, context)).toBe('3')
    } finally { await p.close() }
  }, 180_000)
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
