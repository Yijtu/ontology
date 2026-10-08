import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { LocalStructuredIngestionService, PostgresStructuredIngestionStore, StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import {
  ControlPostgresDatabase, PostgresCandidateStore, PostgresIdentityDecisionStore,
  PostgresInstanceReviewStore, PostgresJobStore, PostgresProjectDocumentStore,
  PostgresProjectMappingStore, PostgresProjectReadinessStore, PostgresProjectRecordStore,
  PostgresProjectStore, PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import { InMemoryIndustrySchemaSource, InstanceReviewService, JobService, ProjectMappingService, ProjectService, encodeStructuredExtractionRef } from '@ontology/application'
import { createProjectFactWorkflow, createInstanceIdentityWorkflow } from '@ontology/app-api'
import {
  IdentityDecisionService, InMemoryIdentityIndexReader, PublishedSemanticSource,
  PublishedFactsReferenceProvider, OntologyLookupService, SemanticDefinitionService,
  SemanticPublicationService,
  InMemorySemanticDefinitionStore, RuleEvaluator,
  definitionVersionDigest, projectIndustrySchema, projectPublishedAttributeFacts, sha256DigestOf,
} from '@ontology/semantic-engine'
import type { EntityCandidate, ColumnMappingEntry, ResourceRef, RuleCandidate, StructuredParseOptions, ToolContext } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { seedIdentityProject } from './instance-identity-fixtures'
import { toolContext } from '../unit/component-registry-fixtures'
import { RecordingControlRepository } from '../unit/semantic-definition-fixtures'
import { relationDefinition, targetCondition } from '../unit/rule-relation-fixtures'
import { buildXlsx, numberCellXml, rowXml, sharedStringCell, worksheetOf } from '../fixtures/structured/xlsx'

vi.setConfig({ testTimeout: 120_000 })
let harness: JobDbHarness
let db: ControlPostgresDatabase
let candidates: PostgresCandidateStore
let identities: PostgresIdentityDecisionStore
let instanceStore: PostgresInstanceReviewStore
let publicationStore: PostgresSemanticPublicationStore
let projects: PostgresProjectStore
let documents: PostgresProjectDocumentStore
let records: PostgresProjectRecordStore
let mappings: PostgresProjectMappingStore
let jobs: PostgresJobStore
let structured: PostgresStructuredIngestionStore
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let objectDir = ''

beforeAll(async () => {
  harness = await startJobDatabase()
  db = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  candidates = new PostgresCandidateStore(db)
  identities = new PostgresIdentityDecisionStore(db)
  instanceStore = new PostgresInstanceReviewStore(db)
  publicationStore = new PostgresSemanticPublicationStore(db)
  projects = new PostgresProjectStore(db)
  documents = new PostgresProjectDocumentStore(db)
  records = new PostgresProjectRecordStore(db)
  mappings = new PostgresProjectMappingStore(db)
  jobs = new PostgresJobStore(db)
  structured = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  objectDir = await mkdtemp(join(tmpdir(), 'project-facts-'))
  const objects = new FileSystemObjectStore(objectDir)
  await objects.init()
  blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
}, 300_000)

afterAll(async () => {
  await structured?.close()
  await registry?.close()
  await db?.close()
  if (objectDir !== '') await rm(objectDir, { recursive: true, force: true })
  await harness?.stop()
})

async function setup(label: string, store = publicationStore, numeric = false) {
  const scope = await createJobScope(harness.adminClient, label)
  const ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'profile-editor', 'semantic-reviewer', 'semantic-publisher'])
  const projectId = randomUUID()
  const base = relationDefinition(scope.scopeRef)
  const extended = { ...base, attributes: [...base.attributes,
    { namespace: base.namespace, standardProvenance: [], kind: 'attribute' as const, id: 'reading', objectId: 'meter', valueType: 'number' as const, cardinality: { min: 1, max: 1 } },
    { namespace: base.namespace, standardProvenance: [], kind: 'attribute' as const, id: 'label', objectId: 'meter', valueType: 'string' as const, cardinality: { min: 1, max: 1 } },
  ] }
  const definition = numeric ? { ...extended, ref: { ...base.ref, digest: definitionVersionDigest(extended) } } : base
  await seedIdentityProject(harness.adminClient, scope.scopeRef, projectId, definition.ref)
  const schemas = new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema: projectIndustrySchema(definition) }])
  const originals = { read: async (request: { approvedInputRefs: readonly ResourceRef[] }, context: ToolContext) => {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('missing original')
    return blobs.readAuthorized({ scopeRef: { tenantId: context.principal.tenantId, spaceId: context.allowedResources.spaceId }, blobRef: ref }, context)
  } }
  const mapping = new ProjectMappingService({ projects, revisions: projects, mappings, records, ingestion: structured, originals, parser: new StructuredDocumentParser(), schemaSource: schemas })
  const instances = new InstanceReviewService({ store: instanceStore })
  const sourceJobs = new Map<string, string>()
  const deps = { projects, mappings, records, projectDocuments: documents, ingestion: structured, candidates, schemaSource: schemas, jobs, resolveSourceJob: async (_scope: unknown, parseId: string) => sourceJobs.get(parseId) }
  const workflow = createProjectFactWorkflow({ materialization: deps, publication: { store, identity: identities }, instanceRecords: instanceStore })
  const identity = createInstanceIdentityWorkflow({ service: instances, projects, projectDocuments: documents, candidates, identityStore: identities, schemaSource: schemas, identityMappingRef: definition.ref, index: new InMemoryIdentityIndexReader([]) })
  const projectService = new ProjectService({ projects, readiness: new PostgresProjectReadinessStore(db), jobs, catalogue: { listEntries: async () => [], findPack: async () => undefined } })
  return { scope, ctx, projectId, definition, schemas, mapping, instances, workflow, identity, sourceJobs, projectService, numeric }
}
type Fixture = Awaited<ReturnType<typeof setup>>

async function imported(p: Fixture, format: 'csv' | 'xlsx', objectId = 'meter', raw = '12000.000000000001', options: Omit<StructuredParseOptions, 'mediaType'> = { headerRow: 1 }, extraRow = false, reading = '9007199254740993') {
  const csv = objectId === 'site' ? 'site_label\nS-1\n' : `device_label,watts,on${p.numeric ? ',reading,label' : ''}\nM-1,${raw},true${p.numeric ? `,${reading},${reading}` : ''}\n${extraRow ? 'M-2,20000,true\n' : ''}`
  const bytes = format === 'csv' ? new TextEncoder().encode(csv) : buildXlsx({ sharedStrings: ['enabled', 'kilowatts', 'code', 'true', 'M-1'], sheetXml: worksheetOf([
    rowXml(1, [sharedStringCell('A1', 0), sharedStringCell('B1', 1), sharedStringCell('C1', 2)]),
    rowXml(2, [sharedStringCell('A2', 3), numberCellXml('B2', '12.000000000000001'), sharedStringCell('C2', 4)]),
  ]) })
  const mediaType = format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const staged = await blobs.stage(bytes, { scopeRef: p.scope.scopeRef }, p.ctx)
  const original = await blobs.publish({ scopeRef: p.scope.scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType, purpose: 'document' }, p.ctx)
  const parsed = await new LocalStructuredIngestionService({ blobs, store: structured }).parse({ scopeRef: p.scope.scopeRef, originalRef: original.blobRef, options }, p.ctx)
  const jobId = randomUUID()
  await new JobService({ store: jobs }).createJob({ jobId, kind: 'ingestion', sourceRef: 'project-fact-test', documentRef: encodeStructuredExtractionRef({ kind: 'structured_extraction', parseId: parsed.parse.parseId, parserVersion: parsed.parse.parserVersion, definitionRef: p.definition.ref, format, originalRef: original.blobRef, originalMediaType: mediaType, options }), pipelineVersion: '1.0.0', idempotencyKey: `fact-job-${jobId}` }, p.ctx)
  p.sourceJobs.set(parsed.parse.parseId, jobId)
  const table = new StructuredDocumentParser().parse(bytes, { ...options, mediaType }).tables[0]
  if (table === undefined) throw new Error('no parsed table')
  const fieldIds = objectId === 'site' ? ['site_id'] : format === 'csv' ? ['meter_id', 'power', 'active', ...(p.numeric ? ['reading', 'label'] : [])] : ['active', 'power', 'meter_id']
  const entries: ColumnMappingEntry[] = table.columns.map((column, index) => ({ fieldRef: fieldIds[index] ?? '', header: column.header, headerDigest: column.headerDigest, columnIndex: column.index,
    ...(fieldIds[index] === 'power' ? { sourceUnitCode: format === 'csv' ? 'W' : 'kW', canonicalUnitCode: 'kW', ...(format === 'csv' ? { unitConversion: { fromUnitCode: 'W', toUnitCode: 'kW', numerator: '1', denominator: '1000' } } : {}) } : {}),
  }))
  const confirmation = await p.mapping.confirmMapping(p.projectId, { format, parseId: parsed.parse.parseId, originalRef: original.blobRef, originalMediaType: mediaType, options, objectId, entries }, `confirm-${jobId}`, p.ctx.principal.subjectId, p.ctx)
  const documentId = randomUUID()
  await documents.registerDocument(p.scope.scopeRef, p.projectId, { documentId, documentRef: original.blobRef, documentDigest: original.blobRef.digest, parseId: parsed.parse.parseId, parseRef: { id: parsed.parse.parseId, version: '1.0.0', digest: original.blobRef.digest, kind: 'artifact' }, textDigest: original.blobRef.digest, precision: 'exact', actor: p.ctx.principal.subjectId, recordedAt: new Date().toISOString() }, p.ctx)
  return { mapping: confirmation.mapping, parse: parsed.parse, documentId }
}
type Imported = Awaited<ReturnType<typeof imported>>

async function mount(p: Fixture, sources: readonly Imported[]) {
  await p.projectService.appendRevision(p.projectId, { expectedRevision: '1', reason: 'human confirmed import mappings', mappingRefs: [...(await projects.getRevision(p.scope.scopeRef, p.projectId, '1', p.ctx))?.mappingRefs ?? [], ...sources.map((source) => source.mapping.ref)] }, `mount-${p.projectId}`, p.ctx.principal.subjectId, p.ctx)
}
async function stage(p: Fixture, source: Imported) {
  const bound = await p.mapping.bindRecords(p.projectId, { parseId: source.parse.parseId, mappingId: source.mapping.mappingId, mappingVersion: source.mapping.version }, `bind-${source.documentId}`, p.ctx.principal.subjectId, p.ctx)
  const entities = await p.workflow.materialization.stageRecords(p.projectId, { documentId: source.documentId, recordRefs: bound.records.map((record) => ({ recordId: record.recordId, revision: record.revision })), validFrom: '2026-10-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' }, p.ctx)
  const entity = entities[0]
  if (entity === undefined) throw new Error('missing mapped candidate')
  return entity
}
async function confirmed(p: Fixture, candidate: EntityCandidate, documentId: string, targetEntityId?: string) {
  const target = targetEntityId === undefined ? undefined : await identities.getEntity(p.scope.scopeRef, targetEntityId, p.ctx)
  const nativeId = candidate.attributes.find((attribute) => attribute.attributeId === 'meter_id')?.value
  const identity = target === undefined ? p.identity : createInstanceIdentityWorkflow({
    service: p.instances, projects, projectDocuments: documents, candidates, identityStore: identities,
    schemaSource: p.schemas, identityMappingRef: p.definition.ref,
    // Controlled bounded recall over real PG identity metadata; the human decision remains PG authority.
    index: new InMemoryIdentityIndexReader([{ tenantId: p.scope.tenantId, spaceId: p.scope.spaceId, entityId: target.entityId, objectId: target.objectId, identityScopeId: target.identityScopeId, displayName: 'M-1', normalizedName: 'm-1', ...(typeof nativeId === 'string' ? { nativeId } : {}), aliasConfirmed: false, dimensions: target.scopeDimensions }]),
  })
  const created = await identity.createRecord(p.scope.scopeRef, p.projectId, { candidateId: candidate.candidateId, documentId, relations: [], idempotencyKey: `instance-${candidate.candidateId}` }, p.ctx)
  expect(created.record.fields.every((field) => field.status === 'pending')).toBe(true)
  const reviewer = toolContext(p.scope.tenantId, p.scope.spaceId, ['semantic-reviewer'], 'mapped-field-reviewer')
  let record = (await p.instances.confirmFields(p.scope.scopeRef, p.projectId, candidate.candidateId, { expectedRevision: created.record.recordRevision, decisions: created.record.fields.map((field) => ({ fieldId: field.fieldId, decision: 'confirm' })), idempotencyKey: `fields-${candidate.candidateId}` }, reviewer)).record
  expect(record.fields.every((field) => field.actor === 'mapped-field-reviewer')).toBe(true)
  expect((await p.instances.listConfirmations(p.scope.scopeRef, p.projectId, candidate.candidateId, p.ctx)).every((event) => event.actor === 'mapped-field-reviewer')).toBe(true)
  if (targetEntityId === undefined) record = await identity.adjudicateIdentity(p.scope.scopeRef, p.projectId, candidate.candidateId, { expectedRevision: record.recordRevision, kind: 'create', reason: 'human verified exact row identity', idempotencyKey: `identity-${candidate.candidateId}` }, p.ctx)
  else {
    record = await identity.adjudicateIdentity(p.scope.scopeRef, p.projectId, candidate.candidateId, { expectedRevision: record.recordRevision, kind: 'match', targetEntityId, reason: 'human reviewed both source records as same device', idempotencyKey: `identity-${candidate.candidateId}` }, p.ctx)
    expect(record.identity.state).toBe('matched')
  }
  await p.workflow.publication.reviewCandidate({ candidateId: candidate.candidateId, expectedRevision: '0', decision: 'approve', reason: 'human reviewed mapped candidate and exact source' }, p.ctx)
  return record
}
async function publish(p: Fixture, selected: readonly { candidateId: string; kind: 'entity' | 'relation' | 'rule' }[], key: string = randomUUID()) {
  return p.workflow.publication.publish({ approvedCandidateRefs: selected, schemaRef: p.definition.ref, expectedRevision: await publicationStore.latestPublicationRevision(p.scope.scopeRef, p.ctx), idempotencyKey: key }, p.ctx)
}

describe('confirmed structured records → official facts (real PostgreSQL)', () => {
  it('requires stored project authority for tagged rules and rejects a project revision race at commit', async () => {
    class MovingProjectStore extends PostgresSemanticPublicationStore {
      beforeCommit: (() => Promise<void>) | undefined
      override async publish(...args: Parameters<PostgresSemanticPublicationStore['publish']>) {
        await this.beforeCommit?.()
        return super.publish(...args)
      }
    }
    const moving = new MovingProjectStore(db)
    const p = await setup('tagged-rule-project-race', moving)
    const a = await imported(p, 'csv'); await mount(p, [a]); const c = await stage(p, a); await confirmed(p, c, a.documentId)
    const rule: RuleCandidate = { candidateId: randomUUID(), kind: 'rule', ruleId: 'scoped-rule', objectId: 'meter', projectId: p.projectId, jobId: c.jobId,
      sourceSpans: c.sourceSpans, deterministic: true, state: 'pending_review', issues: [], inputVersion: { definitionRef: c.inputVersion.definitionRef, parseId: c.inputVersion.parseId, parserVersion: c.inputVersion.parserVersion, pipelineVersion: c.inputVersion.pipelineVersion },
      expression: { op: 'compare', attributeId: 'active', operator: 'eq', value: true, spans: [] }, exceptions: [], conflicts: [], severity: 'soft', impact: 'low', reviewRequirement: 'required', idempotencyKey: sha256DigestOf({ projectId: p.projectId, source: c.candidateId, rule: 'scoped-rule' }), recordedAt: new Date().toISOString() }
    await candidates.insertCandidates(p.scope.scopeRef, [rule], p.ctx)
    await p.workflow.publication.reviewCandidate({ candidateId: rule.candidateId, decision: 'approve', expectedRevision: '0', reason: 'human approved the exact tagged rule source and project' }, p.ctx)
    const request = { schemaRef: p.definition.ref, approvedCandidateRefs: [{ kind: 'rule' as const, candidateId: rule.candidateId }], expectedRevision: '0', idempotencyKey: `tag-rule-${randomUUID()}` }
    const unqualified = new SemanticPublicationService({ store: moving, candidates, schemaSource: p.schemas, identity: identities })
    await expect(unqualified.publish(request, p.ctx)).rejects.toMatchObject({ code: 'CANDIDATE_NOT_APPROVED' })
    moving.beforeCommit = async () => { await p.projectService.appendRevision(p.projectId, { expectedRevision: '2', reason: 'human changed the project while rule publication was prepared' }, `project-race-${randomUUID()}`, p.ctx.principal.subjectId, p.ctx) }
    await expect(p.workflow.publication.publish(request, p.ctx)).rejects.toMatchObject({ code: 'IDENTITY_CONSTRAINT_BLOCKED' })
    expect(await publicationStore.listRuleVersions(p.scope.scopeRef, {}, p.ctx)).toEqual([])
    expect(await publicationStore.latestPublicationRevision(p.scope.scopeRef, p.ctx)).toBe('0')
  }, 120_000)

  it('publishes CSV/XLSX equivalent decimals with distinct cells, reads official lookup/rules and retains alternate support', async () => {
    const p = await setup('fact-equivalent')
    const a = await imported(p, 'csv')
    const b = await imported(p, 'xlsx')
    const s = await imported(p, 'csv', 'site')
    await mount(p, [a, b, s])
    const ca = await stage(p, a), cb = await stage(p, b), cs = await stage(p, s)
    expect(ca.attributes.find((field) => field.attributeId === 'power')?.value).toBe('12.000000000000001')
    expect(cb.attributes.find((field) => field.attributeId === 'power')?.value).toBe('12.000000000000001')
    const ar = await confirmed(p, ca, a.documentId)
    await confirmed(p, cb, b.documentId, ar.identity.matchedEntityId)
    await confirmed(p, cs, s.documentId)
    expect(ar.fields.find((field) => field.fieldId === 'power')?.source.locator).toMatchObject({ kind: 'table_cell', row: 2, column: 2 })
    const relation = await p.workflow.materialization.stageRelation(p.projectId, { relationId: 'meter_of', fromCandidateId: cs.candidateId, toCandidateId: ca.candidateId }, p.ctx)
    const otherProjectId = randomUUID()
    await seedIdentityProject(harness.adminClient, p.scope.scopeRef, otherProjectId, p.definition.ref)
    await expect(p.workflow.materialization.stageRelation(otherProjectId, { relationId: 'meter_of', fromCandidateId: cs.candidateId, toCandidateId: ca.candidateId }, p.ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await p.workflow.publication.reviewCandidate({ candidateId: relation.candidateId, decision: 'approve', expectedRevision: '0', reason: 'human confirmed these source endpoints' }, p.ctx)
    const rule: RuleCandidate = {
      candidateId: randomUUID(), kind: 'rule', ruleId: 'meter-ready', objectId: 'meter', projectId: p.projectId,
      jobId: ca.jobId, sourceSpans: ca.sourceSpans, deterministic: true, state: 'pending_review', issues: [],
      inputVersion: { definitionRef: ca.inputVersion.definitionRef, parseId: ca.inputVersion.parseId, parserVersion: ca.inputVersion.parserVersion, pipelineVersion: ca.inputVersion.pipelineVersion },
      expression: targetCondition, exceptions: [], conflicts: [], severity: 'soft', impact: 'low', reviewRequirement: 'required',
      idempotencyKey: sha256DigestOf({ projectId: p.projectId, expression: targetCondition }), recordedAt: new Date().toISOString(),
    }
    await candidates.insertCandidates(p.scope.scopeRef, [rule], p.ctx)
    await p.workflow.publication.reviewCandidate({ candidateId: rule.candidateId, expectedRevision: '0', decision: 'approve', reason: 'human reviewed deterministic rule against pinned definition' }, p.ctx)
    expect(await publicationStore.listStatements(p.scope.scopeRef, {}, p.ctx)).toEqual([])
    const key = 'equivalent-official-publication'
    const pub = await publish(p, [ca, cb, cs, relation, rule], key)
    expect(pub.ruleProjectPins).toEqual([expect.objectContaining({ candidateId: rule.candidateId, candidateDigest: rule.idempotencyKey, projectRevisionRef: expect.objectContaining({ projectId: p.projectId, revision: '2' }) })])
    expect((await candidates.getCandidate(p.scope.scopeRef, rule.candidateId, p.ctx))).toMatchObject({ projectId: p.projectId })
    expect((await publicationStore.listRuleVersions(p.scope.scopeRef, {}, p.ctx))[0]?.projectId).toBe(p.projectId)
    const replay = await publish(p, [ca, cb, cs, relation, rule], key)
    expect(replay.publicationId).toBe(pub.publicationId)
    const sa = pub.statements.find((statement) => statement.statementId === ca.candidateId), sb = pub.statements.find((statement) => statement.statementId === cb.candidateId)
    expect(sa?.propositionKey).toBe(sb?.propositionKey)
    expect(sa?.sourceRefs).not.toEqual(sb?.sourceRefs)
    expect(sa?.value['provenance']).toMatchObject({ sources: [{ sourceDigest: ca.sourceSpans[0]?.kind === 'structured' ? ca.sourceSpans[0].rowDigest : '' }], sourceSpans: expect.arrayContaining([expect.objectContaining({ locator: expect.objectContaining({ column: 2 }) })]) })
    expect(sa).toMatchObject({ validFrom: '2026-10-01T00:00:00Z', validTo: '2027-01-01T00:00:00Z' })
    const source = new PublishedSemanticSource(publicationStore, { definition: p.definition, identity: identities, projectId: p.projectId })
    const data = await source.load(p.scope.scopeRef, p.ctx)
    expect(await p.workflow.publication.listRuleVersions({}, p.ctx)).toHaveLength(1)
    const result = new RuleEvaluator().evaluate({ scopeRef: p.scope.scopeRef, definitionRef: p.definition.ref, facts: data.facts, rules: data.rules, request: { scopeRef: p.scope.scopeRef, projectionRef: p.definition.ref, validAt: '2026-10-08T00:00:00Z' } })
    expect(result.applicabilities.find((item) => item.ruleId === 'meter-ready')?.conditionState).toBe('true')
    const lookup = new OntologyLookupService({ definitions: new SemanticDefinitionService({ store: new InMemorySemanticDefinitionStore(), control: new RecordingControlRepository() }), facts: new PublishedFactsReferenceProvider({ source, namespace: p.definition.namespace, definitionRef: p.definition.ref }) })
    const page = await lookup.lookup({ scopeRef: p.scope.scopeRef, intent: 'facts', concepts: [{ namespace: p.definition.namespace, conceptId: 'power', definitionVersion: '1.0.0' }] }, p.ctx)
    expect(page.output.items).toHaveLength(2)
    expect(page.output.items.every((item) => item.kind === 'fact')).toBe(true)
    if (sa === undefined) throw new Error('missing statement')
    await p.workflow.publication.reviseStatement({ statementId: sa.statementId, kind: 'retraction', expectedRevision: '1', idempotencyKey: 'withdraw-first-mapped-source', reason: 'first physical source withdrawn' }, p.ctx)
    expect((await p.workflow.publication.getPropositionView(sa.propositionKey, p.ctx)).status).toBe('supported')
    expect((await p.workflow.publication.getPublication(pub.publicationId, p.ctx)).statements[0]?.status).toBe('active')
    const outbox = await harness.adminClient.query<{ count: string }>(`SELECT count(*)::text FROM agent_platform.job_outbox WHERE tenant_id=$1 AND topic='semantic.publication.published'`, [p.scope.tenantId])
    expect(outbox.rows[0]?.count).toBe('1')
  })

  it('requires human field confirmation and current identity, and refuses cross tenant/project and overbound selections', async () => {
    const p = await setup('fact-blockers'), a = await imported(p, 'csv')
    await mount(p, [a]); const c = await stage(p, a)
    await p.workflow.publication.reviewCandidate({ candidateId: c.candidateId, expectedRevision: '0', decision: 'approve', reason: 'source reviewed' }, p.ctx)
    await expect(publish(p, [c])).rejects.toMatchObject({ code: 'CANDIDATE_NOT_APPROVED' })
    const other = await setup('fact-other')
    await expect(other.workflow.materialization.stageRecords(other.projectId, { documentId: a.documentId, recordRefs: [{ recordId: c.candidateId, revision: '1' }] }, other.ctx)).rejects.toMatchObject({ code: 'SOURCE_UNREADABLE' })
    await expect(p.workflow.materialization.stageRecords(p.projectId, { documentId: a.documentId, recordRefs: Array.from({ length: 201 }, () => ({ recordId: randomUUID(), revision: '1' })) }, p.ctx)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(await candidates.getCandidate(other.scope.scopeRef, c.candidateId, other.ctx)).toBeUndefined()
    expect(await publicationStore.listStatements(p.scope.scopeRef, {}, p.ctx)).toEqual([])
  })

  it('fails closed at commit when a source is withdrawn after the service read', async () => {
    const p = await setup('fact-fence'), a = await imported(p, 'csv')
    await mount(p, [a]); const c = await stage(p, a); await confirmed(p, c, a.documentId)
    const originalGet = instanceStore.getRecord.bind(instanceStore)
    let withdrawn = false
    vi.spyOn(instanceStore, 'getRecord').mockImplementation(async (...args) => {
      const result = await originalGet(...args)
      if (!withdrawn) {
        withdrawn = true
        await documents.reviseDocument(p.scope.scopeRef, p.projectId, { documentId: a.documentId, op: 'retract', reason: 'race withdrawal', actor: p.ctx.principal.subjectId, recordedAt: new Date().toISOString() }, p.ctx)
      }
      return result
    })
    try { await expect(publish(p, [c])).rejects.toMatchObject({ code: 'PROJECT_FENCE_STALE' }) } finally { vi.restoreAllMocks() }
    expect(await publicationStore.listStatements(p.scope.scopeRef, {}, p.ctx)).toEqual([])
  })

  it('rolls back facts/publication/outbox together and retries without duplicate truth', async () => {
    let fail = true
    const faulty = new PostgresSemanticPublicationStore(db, { faultInjection: { beforeCommit: () => { if (fail) throw new Error('transaction test failure') } } })
    const p = await setup('fact-rollback', faulty), a = await imported(p, 'csv')
    await mount(p, [a]); const c = await stage(p, a); await confirmed(p, c, a.documentId)
    await expect(publish(p, [c], 'mapped-atomic-retry')).rejects.toThrow('transaction test failure')
    expect(await faulty.listStatements(p.scope.scopeRef, {}, p.ctx)).toEqual([])
    expect(await faulty.latestPublicationRevision(p.scope.scopeRef, p.ctx)).toBe('0')
    fail = false
    const published = await publish(p, [c], 'mapped-atomic-retry')
    expect(published.statements).toHaveLength(1)
    expect((await publish(p, [c], 'mapped-atomic-retry')).publicationId).toBe(published.publicationId)
  })

  it('keeps incomplete parses, unpinned mappings and unresolved field values out of candidate review', async () => {
    const p = await setup('fact-incomplete')
    const partial = await imported(p, 'csv', 'meter', '12000', { headerRow: 1, caps: { maxRows: 1 }, capBreachMode: 'truncate' }, true)
    const invalid = await imported(p, 'csv', 'meter', 'unparsed')
    expect(partial.parse.status).toBe('incomplete')
    await expect(stage(p, invalid)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await mount(p, [partial, invalid])
    await expect(stage(p, partial)).rejects.toMatchObject({ code: 'SOURCE_UNREADABLE' })
    expect(await candidates.listCandidates(p.scope.scopeRef, {}, p.ctx)).toEqual([])
    const fresh = await setup('fact-unpinned'), a = await imported(fresh, 'csv')
    await expect(stage(fresh, a)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('refuses a previously approved candidate after a mapping factor creates a new record revision', async () => {
    const p = await setup('fact-factor'), a = await imported(p, 'csv')
    await mount(p, [a]); const c = await stage(p, a); await confirmed(p, c, a.documentId)
    const mapping = a.mapping
    const changed = await p.mapping.confirmMapping(p.projectId, { ...mapping, mappingId: mapping.mappingId, entries: mapping.entries.map((entry) => entry.fieldRef !== 'power' ? entry : { ...entry, unitConversion: { fromUnitCode: 'W', toUnitCode: 'kW', numerator: '1', denominator: '2000' } }) }, `factor-${mapping.mappingId}`, p.ctx.principal.subjectId, p.ctx)
    const rebound = await p.mapping.bindRecords(p.projectId, { parseId: mapping.parseId, mappingId: mapping.mappingId, mappingVersion: changed.mapping.version }, `rebind-${mapping.mappingId}`, p.ctx.principal.subjectId, p.ctx)
    expect(rebound.records[0]?.revision).toBe('2')
    await expect(publish(p, [c])).rejects.toMatchObject({ code: 'IDENTITY_CONSTRAINT_BLOCKED' })
    expect(await publicationStore.listStatements(p.scope.scopeRef, {}, p.ctx)).toEqual([])
  })

  it('refuses field/review and identity changes between the service read and transaction commit', async () => {
    for (const change of ['field', 'review', 'identity', 'project'] as const) {
      const p = await setup(`fact-race-${change}`), a = await imported(p, 'csv')
      await mount(p, [a]); const c = await stage(p, a); const record = await confirmed(p, c, a.documentId)
      const originalGet = instanceStore.getRecord.bind(instanceStore)
      let changed = false
      vi.spyOn(instanceStore, 'getRecord').mockImplementation(async (...args) => {
        const result = await originalGet(...args)
        if (!changed) {
          changed = true
          if (change === 'field') await p.instances.editField(p.scope.scopeRef, p.projectId, c.candidateId, { expectedRevision: record.recordRevision, fieldId: 'power', normalizedValue: { kind: 'quantity', value: '999', unitCode: 'kW' }, reason: 'human correction', idempotencyKey: `edit-${c.candidateId}` }, p.ctx)
          if (change === 'review') await p.workflow.publication.reviewCandidate({ candidateId: c.candidateId, expectedRevision: '1', decision: 'reject', reason: 'human withdrew approval' }, p.ctx)
          if (change === 'identity') {
            const source = c.inputVersion.projectFact?.sources[0]
            if (source === undefined || record.identity.matchedEntityId === undefined) throw new Error('missing identity pin')
            const decision = new IdentityDecisionService({ store: identities, candidates, schemaSource: p.schemas })
            await decision.decide({ candidateId: c.candidateId, kind: 'split', projectId: p.projectId, projectFence: source, targetEntityId: record.identity.matchedEntityId, expectedRevision: '2', justification: 'human reversed identity' }, p.ctx)
            await decision.decide({ candidateId: c.candidateId, kind: 'reject', projectId: p.projectId, projectFence: source, targetEntityId: record.identity.matchedEntityId, expectedRevision: '3', justification: 'hard negative identity link' }, p.ctx)
          }
          if (change === 'project') await p.projectService.appendRevision(p.projectId, { expectedRevision: '2', reason: 'project pin changed', sourceVisibilityEpoch: '99' }, `project-switch-${p.projectId}`, p.ctx.principal.subjectId, p.ctx)
        }
        return result
      })
      try { await expect(publish(p, [c])).rejects.toBeDefined() } finally { vi.restoreAllMocks() }
      expect(await publicationStore.listStatements(p.scope.scopeRef, {}, p.ctx)).toEqual([])
    }
  })

  it('refuses direct-store attempts to omit source fences or replace reviewed business values/provenance', async () => {
    for (const alteration of ['fences', 'value', 'provenance'] as const) {
      const p = await setup(`fact-direct-${alteration}`), a = await imported(p, 'csv')
      await mount(p, [a]); const c = await stage(p, a); await confirmed(p, c, a.documentId)
      const originalPublish = publicationStore.publish.bind(publicationStore)
      vi.spyOn(publicationStore, 'publish').mockImplementation(async (scope, input, ctx) => originalPublish(scope, {
        ...input,
        ...(alteration === 'fences' ? { projectFactFences: [] } : {}),
        publication: {
          ...input.publication,
          statements: input.publication.statements.map((statement) => ({ ...statement, value: {
            ...statement.value,
            ...(alteration === 'value' ? { attributes: [{ attributeId: 'power', value: '999', decimal: '999', unitCode: 'kW' }] } : {}),
            ...(alteration === 'provenance' ? { provenance: { sources: [], sourceSpans: [] } } : {}),
          } })),
        },
      }, ctx))
      try { await expect(publish(p, [c])).rejects.toMatchObject({ code: 'IDENTITY_CONSTRAINT_BLOCKED' }) } finally { vi.restoreAllMocks() }
      expect(await publicationStore.listStatements(p.scope.scopeRef, {}, p.ctx)).toEqual([])
      expect(await publicationStore.latestPublicationRevision(p.scope.scopeRef, p.ctx)).toBe('0')
    }
  })

  it('keeps the mapped parser revision usable after the same bytes receive a newer parse', async () => {
    const p = await setup('fact-parser-pin'), a = await imported(p, 'csv')
    await mount(p, [a])
    const newer = await new LocalStructuredIngestionService({ blobs, store: structured }).parse({ scopeRef: p.scope.scopeRef, originalRef: a.mapping.originalRef, options: a.mapping.options, parserVersion: '2.0.0' }, p.ctx)
    expect(newer.parse.parseId).not.toBe(a.parse.parseId)
    expect((await structured.findParseByDigest(p.scope.scopeRef, a.mapping.originalRef.digest, undefined, p.ctx))?.parseId).toBe(newer.parse.parseId)
    const candidate = await stage(p, a)
    expect(candidate.inputVersion.parseId).toBe(a.parse.parseId)
    expect(candidate.inputVersion.parserVersion).toBe(a.parse.parserVersion)
    await confirmed(p, candidate, a.documentId)
    expect((await publish(p, [candidate])).statements).toHaveLength(1)
  })

  it('reads schema-declared exact unitless numbers into ordered rules without guessing numeric-looking strings', async () => {
    for (const [amount, operator, boundary, expected] of [
      ['9007199254740993', 'gt', '9007199254740992', 'true'],
      ['-0.10000000000000001', 'lt', '-0.1', 'true'],
      ['0.10000000000000001', 'gte', '0.10000000000000002', 'false'],
    ] as const) {
      const p = await setup(`fact-number-${operator}`, publicationStore, true)
      const a = await imported(p, 'csv', 'meter', '12000', { headerRow: 1 }, false, amount)
      await mount(p, [a]); const c = await stage(p, a); await confirmed(p, c, a.documentId)
      const rule: RuleCandidate = {
        candidateId: randomUUID(), kind: 'rule', ruleId: 'number-boundary', objectId: 'meter', jobId: c.jobId, projectId: p.projectId,
        sourceSpans: c.sourceSpans, deterministic: true, state: 'pending_review', issues: [],
        inputVersion: { definitionRef: c.inputVersion.definitionRef, parseId: c.inputVersion.parseId, parserVersion: c.inputVersion.parserVersion, pipelineVersion: c.inputVersion.pipelineVersion },
        expression: { op: 'compare', attributeId: 'reading', operator, value: boundary, spans: [] }, conclusion: { predicate: 'reading', value: { kind: 'scalar_decimal', amount } }, exceptions: [], conflicts: [], severity: 'soft', impact: 'low', reviewRequirement: 'required',
        idempotencyKey: sha256DigestOf({ projectId: p.projectId, amount, operator, boundary }), recordedAt: new Date().toISOString(),
      }
      await candidates.insertCandidates(p.scope.scopeRef, [rule], p.ctx)
      await p.workflow.publication.reviewCandidate({ candidateId: rule.candidateId, expectedRevision: '0', decision: 'approve', reason: 'human verified exact numeric boundary rule' }, p.ctx)
      const pub = await publish(p, [c, rule])
      expect(pub.ruleProjectPins?.[0]?.projectRevisionRef.projectId).toBe(p.projectId)
      expect((await p.workflow.publication.listRuleVersions({}, p.ctx))[0]?.conclusion).toEqual({ predicate: 'reading', value: { kind: 'scalar_decimal', amount } })
      const source = new PublishedSemanticSource(publicationStore, { definition: p.definition, identity: identities, projectId: p.projectId })
      const data = await source.load(p.scope.scopeRef, p.ctx)
      expect(data.facts.find((fact) => fact.predicate === 'reading')?.value).toEqual({ kind: 'scalar_decimal', amount })
      expect(data.facts.find((fact) => fact.predicate === 'label')?.value).toBe(amount)
      expect(data.facts.find((fact) => fact.predicate === 'active')?.value).toBe(true)
      const result = new RuleEvaluator().evaluate({ scopeRef: p.scope.scopeRef, definitionRef: p.definition.ref, facts: data.facts, rules: data.rules, request: { scopeRef: p.scope.scopeRef, projectionRef: p.definition.ref, validAt: '2026-10-08T00:00:00Z' } })
      expect(result.applicabilities.find((item) => item.ruleId === 'number-boundary')?.conditionState).toBe(expected)
      if (expected === 'true') expect(result.conclusions.find((item) => item.predicate === 'reading')?.value).toEqual({ kind: 'scalar_decimal', amount })
      const wrongDefinition = { ...p.definition, attributes: p.definition.attributes.map((field) => field.id === 'reading' ? { ...field, valueType: 'string' as const } : field) }
      const wrong = projectPublishedAttributeFacts(pub.statements, { scopeRef: p.scope.scopeRef, schemaRef: p.definition.ref, definition: wrongDefinition })
      expect(wrong.facts.find((fact) => fact.predicate === 'reading')?.value).toBeUndefined()
      expect(wrong.issues.some((issue) => issue.attributeId === 'reading' && issue.code === 'INVALID_VALUE')).toBe(true)
      const crossScope = projectPublishedAttributeFacts(pub.statements, { scopeRef: { tenantId: randomUUID(), spaceId: randomUUID() }, schemaRef: p.definition.ref, definition: p.definition })
      expect(crossScope.facts.find((fact) => fact.predicate === 'reading')?.value).toBeUndefined()
      const missing = projectPublishedAttributeFacts(pub.statements, { schemaRef: p.definition.ref })
      expect(missing.facts.find((fact) => fact.predicate === 'reading')?.value).toBeUndefined()
      for (const value of [true, 'not-a-number']) {
        const confused = projectPublishedAttributeFacts(pub.statements.map((statement) => ({ ...statement, value: { ...statement.value, attributes: c.attributes.map((attribute) => attribute.attributeId === 'reading' ? { ...attribute, value } : attribute) } })), { scopeRef: p.scope.scopeRef, schemaRef: p.definition.ref, definition: p.definition })
        expect(confused.facts.find((fact) => fact.predicate === 'reading')?.value).toBeUndefined()
        expect(confused.issues.some((issue) => issue.attributeId === 'reading' && issue.code === 'INVALID_VALUE')).toBe(true)
      }
      for (const value of [
        { kind: 'wrong_tag', amount: '1' }, { kind: 'wrong_tag', amount: '1', unit: 'kW' }, { kind: 'scalar_decimal', amount: true },
        { kind: 'scalar_decimal', amount: '1e5' }, { kind: 'scalar_decimal', amount: '9'.repeat(65) },
        { kind: 'scalar_decimal', amount: '1', extra: true }, { kind: 'scalar_decimal', amount: '1', unit: 'kW' },
      ]) {
        await expect(harness.adminClient.query(`UPDATE agent_platform.published_rule_versions SET conclusion=$1::jsonb WHERE tenant_id=$2::uuid AND rule_version_id=$3::uuid`, [JSON.stringify({ predicate: 'reading', value }), p.scope.tenantId, rule.candidateId])).rejects.toMatchObject({ code: '23514' })
      }
      for (const conclusion of [{ value: { kind: 'scalar_decimal', amount: '1' } }, { predicate: 'reading' }]) {
        await expect(harness.adminClient.query(`UPDATE agent_platform.published_rule_versions SET conclusion=$1::jsonb WHERE tenant_id=$2::uuid AND rule_version_id=$3::uuid`, [JSON.stringify(conclusion), p.scope.tenantId, rule.candidateId])).rejects.toMatchObject({ code: '23514' })
      }
      // Roll back low-level legacy-shape probes; the actual reviewed consequence is retained.
      await harness.adminClient.query('BEGIN')
      try {
        for (const conclusion of [null, { predicate: 'legacy', value: true }, { predicate: 'legacy', value: 'text' }, { predicate: 'legacy', value: { amount: '12.5', unit: 'kW' } }]) {
          await harness.adminClient.query(`UPDATE agent_platform.published_rule_versions SET conclusion=$1::jsonb WHERE tenant_id=$2::uuid AND rule_version_id=$3::uuid`, [conclusion === null ? null : JSON.stringify(conclusion), p.scope.tenantId, rule.candidateId])
          const result = await harness.adminClient.query<{ conclusion: unknown }>(`SELECT conclusion FROM agent_platform.published_rule_versions WHERE tenant_id=$1::uuid AND rule_version_id=$2::uuid`, [p.scope.tenantId, rule.candidateId])
          expect(result.rows[0]?.conclusion).toEqual(conclusion)
        }
      } finally { await harness.adminClient.query('ROLLBACK') }
      expect((await p.workflow.publication.listRuleVersions({}, p.ctx))[0]?.conclusion).toEqual({ predicate: 'reading', value: { kind: 'scalar_decimal', amount } })
    }
  })
})
