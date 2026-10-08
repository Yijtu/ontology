import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { LocalStructuredIngestionService, PostgresStructuredIngestionStore, StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import { ControlPostgresDatabase, PostgresCandidateStore, PostgresIdentityDecisionStore, PostgresJobStore, PostgresSemanticPublicationStore } from '@ontology/adapter-control-postgres'
import { InMemoryIndustrySchemaSource, JobService, StructuredExtractionService, validateEntity } from '@ontology/application'
import { IdentityDecisionService, PublishedSemanticSource, RuleEvaluator, SemanticPublicationService, projectIndustrySchema, projectPublishedRelationFacts, compilePublishedRuleInstances, sha256DigestOf } from '@ontology/semantic-engine'
import type { CandidateRecord, EntityCandidate, RelationCandidate, RuleCandidate } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'
import { toolContext } from '../unit/component-registry-fixtures'
import { relationCondition, relationDefinition } from '../unit/rule-relation-fixtures'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let candidateStore: PostgresCandidateStore
let identityStore: PostgresIdentityDecisionStore
let publicationStore: PostgresSemanticPublicationStore
let structuredStore: PostgresStructuredIngestionStore
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let objectDir = ''

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  candidateStore = new PostgresCandidateStore(database)
  identityStore = new PostgresIdentityDecisionStore(database)
  publicationStore = new PostgresSemanticPublicationStore(database)
  structuredStore = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  objectDir = await mkdtemp(join(tmpdir(), 'rule-relation-pipeline-'))
  const objects = new FileSystemObjectStore(objectDir)
  await objects.init()
  blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
}, 300_000)

afterAll(async () => {
  await structuredStore?.close()
  await registry?.close()
  await database?.close()
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true })
  await harness?.stop()
})

async function project(label: string) {
  const scope = await createJobScope(harness.adminClient, label)
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
  const definition = relationDefinition(scope.scopeRef)
  const schemas = new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema: projectIndustrySchema(definition) }])
  const identity = new IdentityDecisionService({ store: identityStore, candidates: candidateStore, schemaSource: schemas })
  const publisher = new SemanticPublicationService({ store: publicationStore, candidates: candidateStore, schemaSource: schemas, identity: identityStore })
  const source = new PublishedSemanticSource(publicationStore, { definition, identity: identityStore })
  return { scope, ctx, definition, schemas, identity, publisher, source }
}
type Project = Awaited<ReturnType<typeof project>>

async function imported(p: Project, active: boolean) {
  const bytes = new TextEncoder().encode(JSON.stringify([{ site_id: 'same-name' }, { meter_id: 'same-name', active, power: 12 }]))
  const staged = await blobs.stage(bytes, { scopeRef: p.scope.scopeRef }, p.ctx)
  const original = await blobs.publish({ scopeRef: p.scope.scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: 'application/json', purpose: 'document' }, p.ctx)
  const parsed = await new LocalStructuredIngestionService({ blobs, store: structuredStore }).parse({ scopeRef: p.scope.scopeRef, originalRef: original.blobRef, options: {} }, p.ctx)
  const jobId = randomUUID()
  await new JobService({ store: new PostgresJobStore(database) }).createJob({ jobId, kind: 'ingestion', sourceRef: labelFor(p.scope), documentRef: original.blobRef.id, pipelineVersion: '1.0.0', idempotencyKey: `relation-import-${jobId}` }, p.ctx)
  const extraction = new StructuredExtractionService({ schemaSource: p.schemas, candidates: candidateStore, ingestion: structuredStore, originals: { read: (request) => {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('missing approved original')
    return blobs.readAuthorized({ scopeRef: p.scope.scopeRef, blobRef: ref }, p.ctx)
  } }, parser: new StructuredDocumentParser() })
  const result = await extraction.extract({ kind: 'structured_extraction', parseId: parsed.parse.parseId, parserVersion: parsed.parse.parserVersion, definitionRef: p.definition.ref, format: 'json', originalRef: original.blobRef, originalMediaType: 'application/json', options: {} }, { jobId, ledgerId: randomUUID(), pipelineVersion: '1.0.0', ctx: p.ctx, signal: new AbortController().signal })
  expect(result.candidateIds).toHaveLength(2)
  const candidates = await candidateStore.listCandidates(p.scope.scopeRef, { jobId }, p.ctx)
  const entities: EntityCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.kind !== 'entity') continue
    const issues = validateEntity(candidate, projectIndustrySchema(p.definition))
    expect(issues).toEqual([])
    const reviewed = await candidateStore.transitionCandidate(p.scope.scopeRef, candidate.candidateId, { state: 'pending_review', issues, transitionedAt: new Date().toISOString() }, p.ctx)
    if (reviewed.kind !== 'entity') throw new Error('unexpected validated candidate kind')
    entities.push(reviewed)
  }
  const entityIds = new Map<string, string>()
  for (const entity of entities) {
    expect(entity.sourceSpans[0]?.kind).toBe('structured')
    const pending = await p.identity.decide({ candidateId: entity.candidateId, kind: 'create_pending', expectedRevision: '0' }, p.ctx)
    if (pending.targetEntityId === undefined) throw new Error('missing created identity')
    await p.identity.decide({ candidateId: entity.candidateId, kind: 'match', targetEntityId: pending.targetEntityId, expectedRevision: '1', strongIdentity: { kind: 'native_id', attributeId: `${entity.objectId}_id`, value: 'same-name' } }, p.ctx)
    entityIds.set(entity.objectId, pending.targetEntityId)
  }
  return { jobId, entities, entityIds }
}
function labelFor(scope: JobTestScope) { return `relation-${scope.spaceId}` }

async function publish(p: Project, candidates: readonly CandidateRecord[], key: string) {
  for (const candidate of candidates) {
    await p.publisher.reviewCandidate({ candidateId: candidate.candidateId, decision: 'approve', reason: 'independent fixture source reviewed', expectedRevision: '0' }, p.ctx)
  }
  return p.publisher.publish({ approvedCandidateRefs: candidates.map((candidate) => ({ candidateId: candidate.candidateId, kind: candidate.kind })), schemaRef: p.definition.ref, expectedRevision: await publicationStore.latestPublicationRevision(p.scope.scopeRef, p.ctx), idempotencyKey: key }, p.ctx)
}

function additions(entities: readonly EntityCandidate[]) {
  const site = entities.find((entity) => entity.objectId === 'site')
  const meter = entities.find((entity) => entity.objectId === 'meter')
  if (site === undefined || meter === undefined) throw new Error('missing imported objects')
  const common = { jobId: site.jobId, sourceSpans: site.sourceSpans, inputVersion: site.inputVersion, recordedAt: site.recordedAt, deterministic: site.deterministic, issues: site.issues }
  const edge = (id: string): RelationCandidate => ({ ...common, candidateId: id, idempotencyKey: sha256DigestOf(id), kind: 'relation', relationId: 'meter_of', from: { objectId: 'site', candidateId: site.candidateId }, to: { objectId: 'meter', candidateId: meter.candidateId }, state: 'pending_review' })
  const rule: RuleCandidate = { ...common, candidateId: randomUUID(), idempotencyKey: sha256DigestOf('relation-rule'), kind: 'rule', ruleId: 'site_ready', objectId: 'site', expression: relationCondition, exceptions: [], severity: 'soft', impact: 'low', reviewRequirement: 'policy_eligible', conflicts: [], state: 'pending_review' }
  const otherRule: RuleCandidate = { ...rule, candidateId: randomUUID(), idempotencyKey: sha256DigestOf('inactive-rule'), ruleId: 'site_inactive', expression: { op: 'relation', relationId: 'meter_of', targetCondition: { op: 'compare', attributeId: 'active', operator: 'eq', value: false, spans: [] }, spans: [] } }
  return { site, meter, edges: [edge(randomUUID()), edge(randomUUID())], rules: [rule, otherRule] }
}

async function evaluate(p: Project) {
  const data = await p.source.load(p.scope.scopeRef, p.ctx)
  expect(data.ruleIssues).toEqual([])
  const result = new RuleEvaluator().evaluate({ scopeRef: p.scope.scopeRef, definitionRef: p.definition.ref, facts: data.facts, rules: data.rules, request: { scopeRef: p.scope.scopeRef, projectionRef: p.definition.ref, validAt: new Date().toISOString() } })
  return { data, result, ready: result.applicabilities.find((item) => item.ruleId === 'site_ready'), inactive: result.applicabilities.find((item) => item.ruleId === 'site_inactive') }
}

describe('real structured import → review → publish → compile → relation evaluate (#253)', () => {
  it('uses exact project identities and rule-specific target filters, retains independent support and published history', async () => {
    const p = await project('relation-a')
    const initial = await imported(p, true)
    const a = additions(initial.entities)
    await candidateStore.insertCandidates(p.scope.scopeRef, [...a.edges, ...a.rules], p.ctx)
    const publication = await publish(p, [...initial.entities, ...a.edges, ...a.rules], 'relation-a-first')
    const first = await evaluate(p)
    expect(first.ready?.conditionState).toBe('true')
    expect(first.inactive?.conditionState).toBe('false')
    expect(first.ready?.sourceStatementIds).toEqual(expect.arrayContaining([a.edges[0]?.candidateId, a.edges[1]?.candidateId, a.meter.candidateId]))
    expect(first.data.facts.filter((fact) => fact.relation !== undefined)).toHaveLength(2)

    const other = await project('relation-b')
    const importedOther = await imported(other, false)
    const b = additions(importedOther.entities)
    await candidateStore.insertCandidates(other.scope.scopeRef, [...b.edges, ...b.rules], other.ctx)
    await publish(other, [...importedOther.entities, ...b.edges, ...b.rules], 'relation-b-first')
    const otherResult = await evaluate(other)
    expect(otherResult.ready?.conditionState).toBe('false')
    expect(otherResult.inactive?.conditionState).toBe('true')
    expect(otherResult.ready?.subjectEntityId).not.toBe(first.ready?.subjectEntityId)
    expect(otherResult.ready?.sourceStatementIds).not.toContain(a.meter.candidateId)
    expect((await evaluate(p)).ready?.conditionState).toBe('true')

    const firstEdge = a.edges[0]
    const secondEdge = a.edges[1]
    if (firstEdge === undefined || secondEdge === undefined) throw new Error('missing edge fixtures')
    await p.publisher.reviseStatement({ statementId: firstEdge.candidateId, kind: 'retraction', reason: 'first source withdrawn', expectedRevision: '1', idempotencyKey: 'relation-edge-one-withdraw' }, p.ctx)
    expect((await evaluate(p)).ready?.conditionState).toBe('true')
    await p.publisher.reviseStatement({ statementId: a.meter.candidateId, kind: 'retraction', reason: 'target observation withdrawn', expectedRevision: '1', idempotencyKey: 'relation-target-withdraw' }, p.ctx)
    expect((await evaluate(p)).ready?.conditionState).toBe('unknown')
    const retained = await p.publisher.getPublication(publication.publicationId, p.ctx)
    expect(retained.statements.find((statement) => statement.statementId === a.meter.candidateId)).toMatchObject({ version: '1', status: 'active', value: { attributes: expect.arrayContaining([expect.objectContaining({ attributeId: 'active', value: true })]) } })
    expect((await p.publisher.listStatementRevisions(a.meter.candidateId, p.ctx))).toHaveLength(1)
    const historical = new RuleEvaluator().evaluate({ scopeRef: p.scope.scopeRef, definitionRef: p.definition.ref, facts: first.data.facts, rules: first.data.rules, request: { scopeRef: p.scope.scopeRef, projectionRef: p.definition.ref } })
    expect(historical.applicabilities.find((item) => item.ruleId === 'site_ready')?.conditionState).toBe('true')
    await p.publisher.reviseStatement({ statementId: secondEdge.candidateId, kind: 'retraction', reason: 'remaining edge withdrawn', expectedRevision: '1', idempotencyKey: 'relation-edge-two-withdraw' }, p.ctx)
    expect((await evaluate(p)).ready?.conditionState).toBe('unknown')
  }, 120_000)

  it('keeps absent edges unknown and unresolved endpoint bindings unusable after a real identity withdrawal', async () => {
    const p = await project('relation-unresolved')
    const initial = await imported(p, true)
    const a = additions(initial.entities)
    await candidateStore.insertCandidates(p.scope.scopeRef, a.rules, p.ctx)
    await publish(p, [...initial.entities, ...a.rules], 'relation-no-edge')
    const missing = await evaluate(p)
    expect(missing.ready?.conditionState).toBe('unknown')
    // Independent fixture oracle attests this exact imported read has no meter_of edge.
    // Pagination alone never supplies this proof to the production source.
    const validAt = new Date().toISOString()
    const publishedRules = await publicationStore.listRuleVersions(p.scope.scopeRef, { limit: 100 }, p.ctx)
    const closed = compilePublishedRuleInstances(publishedRules, missing.data.facts, {
      scopeRef: p.scope.scopeRef, definitionRef: p.definition.ref, definition: p.definition,
      subjects: [{ objectId: 'site', subjectEntityId: initial.entityIds.get('site') ?? '' }],
      relationCompleteness: [{ scopeRef: p.scope.scopeRef, definitionRef: p.definition.ref, subjectEntityId: initial.entityIds.get('site') ?? '', relationId: 'meter_of', validAt, asOfRecordedSeq: '1' }],
    })
    expect(closed.issues).toEqual([])
    const closedResult = new RuleEvaluator().evaluate({ scopeRef: p.scope.scopeRef, definitionRef: p.definition.ref, facts: missing.data.facts, rules: closed.instances.map((instance) => instance.supportRule), request: { scopeRef: p.scope.scopeRef, projectionRef: p.definition.ref, validAt, asOfRecordedSeq: '1' } })
    expect(closedResult.applicabilities.find((item) => item.ruleId === 'site_ready')?.conditionState).toBe('false')
    await candidateStore.insertCandidates(p.scope.scopeRef, a.edges, p.ctx)
    await publish(p, a.edges, 'relation-edges-added')
    expect((await evaluate(p)).ready?.conditionState).toBe('true')
    const meterEntityId = initial.entityIds.get('meter')
    if (meterEntityId === undefined) throw new Error('missing target identity')
    await p.identity.decide({ candidateId: a.meter.candidateId, kind: 'split', targetEntityId: meterEntityId, separatedCandidateIds: [a.meter.candidateId], expectedRevision: '2', justification: 'target source identity withdrawn' }, p.ctx)
    const statements = await publicationStore.listStatements(p.scope.scopeRef, { limit: 100 }, p.ctx)
    const bindings = await identityStore.readPublishedBindings(p.scope.scopeRef, [a.site.candidateId, a.meter.candidateId], p.ctx)
    const projected = projectPublishedRelationFacts(statements, { definition: p.definition, bindings: bindings.bindings })
    expect(projected.facts).toHaveLength(2)
    expect(projected.facts.every((fact) => fact.relation?.endpointResolved === false)).toBe(true)
    expect(projected.issues.every((issue) => issue.code === 'RELATION_ENDPOINT_UNRESOLVED')).toBe(true)
    const { data, result } = await evaluate(p)
    expect(data.complete).toBe(false)
    expect(result.applicabilities.find((item) => item.ruleId === 'site_ready')?.conditionState).toBe('unknown')
  }, 120_000)
})
