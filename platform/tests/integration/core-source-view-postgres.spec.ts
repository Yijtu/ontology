import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, PostgresAnswerStore, PostgresCandidateStore, PostgresEvidenceStore, PostgresIdentityDecisionStore, PostgresInstanceReviewStore, PostgresJobStore, PostgresProfileStore, PostgresProjectDocumentStore, PostgresProjectMappingStore, PostgresProjectReadinessStore, PostgresProjectRecordStore, PostgresProjectStore, PostgresRunExecutionBindingStore, PostgresRunStore, PostgresSemanticPublicationStore, PostgresWorkflowStore } from '@ontology/adapter-control-postgres'
import { LocalDocumentExtractionService, LocalStructuredIngestionService, PostgresDocumentParseStore, PostgresStructuredIngestionStore, StructuredDocumentParser, StructuredDocumentProjectionService } from '@ontology/adapter-extraction-document'
import { coreScenarioTaskBindings, createCoreApi, createCoreLocalComposition, createCoreSourceViewReader, createCoreStructuredImportWorkflow, createInstanceIdentityWorkflow, createProjectFactWorkflow, loadCoreExamples, registerCoreSourceViewRoutes } from '@ontology/app-api'
import type { CoreSourceViewOptions } from '@ontology/app-api'
import { canonicalJson, InMemoryIndustrySchemaSource, InstanceReviewService, JobService, ProjectMappingService, ProjectService, encodeStructuredExtractionRef, sha256DigestOf } from '@ontology/application'
import { createToolContext } from '@ontology/contracts'
import type { ColumnMappingEntry, EntityCandidate, ProjectRevisionBody, PublishedAnswer, ResourceRef, ToolContext } from '@ontology/contracts'
import { InMemoryIdentityIndexReader, projectIndustrySchema, SupportEvidenceDependencySource } from '@ontology/semantic-engine'
import { ProvenanceReadService } from '@ontology/provenance'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { seedIdentityProject } from './instance-identity-fixtures'
import { toolContext } from '../unit/component-registry-fixtures'
import { relationDefinition } from '../unit/rule-relation-fixtures'
import { buildXlsx, rowXml, sharedStringCell, worksheetOf } from '../fixtures/structured/xlsx'

let harness: JobDbHarness
let db: ControlPostgresDatabase
let directory = ''
let registry: PostgresArtifactRegistry
let blobs: LocalImmutableBlobStore
let parses: PostgresDocumentParseStore
let ingestion: PostgresStructuredIngestionStore
let options: CoreSourceViewOptions
let projects: PostgresProjectStore
let documents: PostgresProjectDocumentStore
let mappings: PostgresProjectMappingStore
let records: PostgresProjectRecordStore
let instances: PostgresInstanceReviewStore
let candidates: PostgresCandidateStore
let identities: PostgresIdentityDecisionStore
let jobs: PostgresJobStore

beforeAll(async () => {
  harness = await startJobDatabase()
  db = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  parses = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  ingestion = new PostgresStructuredIngestionStore({ connectionString: harness.appUrl, maxPoolSize: 2 })
  directory = await mkdtemp(join(tmpdir(), 'ontology-source-view-'))
  const objectStore = new FileSystemObjectStore(directory)
  await objectStore.init()
  blobs = new LocalImmutableBlobStore({ objectStore, registry })
  projects = new PostgresProjectStore(db); documents = new PostgresProjectDocumentStore(db)
  mappings = new PostgresProjectMappingStore(db); records = new PostgresProjectRecordStore(db)
  instances = new PostgresInstanceReviewStore(db); candidates = new PostgresCandidateStore(db)
  identities = new PostgresIdentityDecisionStore(db); jobs = new PostgresJobStore(db)
  const evidence = new PostgresEvidenceStore(db)
  options = { answers: new PostgresAnswerStore(db), evidence, runs: new PostgresRunStore(db), manifests: new PostgresWorkflowStore(db), executionBindings: new PostgresRunExecutionBindingStore(db),
    blobs, parses, ingestion, projects, documents, instances, candidates, records, mappings,
    provenance: new ProvenanceReadService({ evidence, blobs, dependencies: new SupportEvidenceDependencySource({ published: new PostgresSemanticPublicationStore(db) }) }) }
}, 300_000)
afterAll(async () => {
  await ingestion?.close(); await parses?.close(); await registry?.close(); await db?.close()
  if (directory !== '') await rm(directory, { recursive: true, force: true })
  await harness?.stop()
})

const signal = () => new AbortController().signal
function freshContext(tenantId: string, spaceId: string, roles: readonly string[]): ToolContext {
  const base = toolContext(tenantId, spaceId, roles)
  const now = new Date()
  const deadline = new Date(now.getTime() + 120_000).toISOString()
  return createToolContext({ ...base, deadline, budgetReservation: { ...base.budgetReservation, grantedAt: now.toISOString(), expiresAt: deadline } })
}

describe('actual saved-answer source views (PostgreSQL, original bytes, normal worker and BM25)', () => {
  it('reads real CSV/XLSX cells and text from a normally published fixed answer, refuses foreign/unbound/tampered reads, preserves archived source after withdrawal', async () => {
    const scope = await createJobScope(harness.adminClient, 'source-qa')
    const ctx = freshContext(scope.tenantId, scope.spaceId, ['platform-admin', 'operator', 'data-editor'])
    const composition = await createCoreLocalComposition({ databaseUrl: harness.appUrl, objectDirectory: directory, scopeRef: scope.scopeRef, examples: loadCoreExamples({ targetScopeRef: scope.scopeRef }), allowLocalOperator: true, projectStructuredImports: createCoreStructuredImportWorkflow })
    const api = createCoreApi(composition.dependencies)
    const reader = createCoreSourceViewReader(options)
    registerCoreSourceViewRoutes(api, { reader, authenticate: () => ({ principal: ctx.principal, spaceId: scope.spaceId }), contextFor: () => ctx })
    try {
      const base = await api.listen({ host: '127.0.0.1', port: 0 })
      const request = async (path: string, body?: object) => {
        const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) })
        const payload = await response.json() as { data: Record<string, unknown> }
        if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(payload)}`)
        return payload.data
      }
      const scenario = loadCoreExamples({ targetScopeRef: scope.scopeRef }).scenarios.find((entry) => entry.scenarioId === 'transport-facility-inspection')
      if (scenario === undefined) throw new Error('actual scenario unavailable')
      const deployment = await request('/api/v1/core/deployment')
      const mounted = (deployment['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]).find((entry) => entry.scenarioId === scenario.scenarioId)
      const binding = coreScenarioTaskBindings(scenario).find((entry) => entry.kind === 'document_qa')
      if (mounted === undefined || binding === undefined) throw new Error('actual host task/profile unavailable')
      const profiles = new PostgresProfileStore(db)
      const active = await profiles.getActiveProfile(mounted.profileRef.id, scope.scopeRef, ctx)
      const resolved = active === undefined ? undefined : await profiles.findResolvedProfile(active.profileRef, active.snapshotHash, scope.scopeRef, ctx)
      if (active === undefined || resolved === undefined) throw new Error('actual host profile unresolved')
      for (const format of ['csv', 'xlsx', 'text'] as const) {
        const projectId = randomUUID()
        await harness.adminClient.query(`INSERT INTO agent_platform.projects (tenant_id,space_id,project_id,title,head_revision,state,create_idempotency_key,create_request_digest,created_by,created_at,updated_at) VALUES ($1,$2,$3,'source QA',1,'active',$4,$5,'author',now(),now())`, [scope.tenantId, scope.spaceId, projectId, randomUUID(), sha256DigestOf(projectId)])
        const content = format === 'xlsx' ? buildXlsx({ sheetName: 'Readings', sharedStrings: ['device', 'reading', 'pump', '9007199254740993.000000000001'], sheetXml: worksheetOf([rowXml(1, [sharedStringCell('A1', 0), sharedStringCell('B1', 1)]), rowXml(2, [sharedStringCell('A2', 2), sharedStringCell('B2', 3)])]) }) : new TextEncoder().encode(format === 'csv' ? 'device,reading\npump,9007199254740993.000000000001\n' : 'Manual: pump serial is P-001. The pump warranty lasts five years.')
        const imported = await request(`/api/v1/projects/${projectId}/structured-imports`, { format, mediaType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : format === 'csv' ? 'text/csv' : 'text/plain', contentEncoding: 'base64', content: Buffer.from(content).toString('base64') })
        const originalRef = imported['originalRef'] as ResourceRef
        const body: ProjectRevisionBody = { schemaVersion: 'project-revision@1', projectId, revision: '1', industryPackRef: resolved.resolved.industryRef, definitionRef: scenario.definitionRef,
          mappingRefs: scenario.physicalMappings.flatMap((loaded) => loaded.mapping.objects[0] === undefined ? [] : [{ ...loaded.ref, role: 'catalog' as const, sourceObjectRef: loaded.mapping.objects[0].sourceObjectRef }]),
          profileRef: { ...active.profileRef, snapshotHash: active.snapshotHash }, documentSetRef: imported['documentSetRef'] as ResourceRef, approvedInputRef: originalRef, semanticPublicationRefs: [scenario.definitionRef], sourceVisibilityEpoch: '1', changeReason: 'actual imported source corpus' }
        const revisionRef = { projectId, revision: '1', digest: sha256DigestOf(canonicalJson(body)) }
        await harness.adminClient.query(`INSERT INTO agent_platform.project_revisions (tenant_id,space_id,project_id,revision,digest,body,source_visibility_epoch,change_reason,idempotency_key,request_digest,actor,recorded_at) VALUES ($1,$2,$3,1,$4,$5::jsonb,1,$6,$7,$4,'author',now())`, [scope.tenantId, scope.spaceId, projectId, revisionRef.digest, JSON.stringify(body), body.changeReason, randomUUID()])
        expect((await request(`/api/v1/projects/${projectId}/document-index`, {}))['status']).toMatchObject({ state: 'ready' })
        const admitted = await request('/api/v1/runs', { profileRef: mounted.profileRef, question: 'read the pump source', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false }, task: { mode: 'task', projectRevisionRef: revisionRef, inputSnapshotRef: originalRef, inputSnapshotDigest: originalRef.digest, taskBindingRef: binding.taskBindingRef, parameters: { query: 'pump', limit: 5 } } })
        const runId = String(admitted['runId'])
        let answer: PublishedAnswer | undefined
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const response = await fetch(`${base}/api/v1/runs/${runId}/answer`, { signal: AbortSignal.timeout(30_000) })
          if (response.status === 200) { answer = (await response.json() as { data: PublishedAnswer }).data; break }
          if (response.status !== 202) throw new Error(`actual QA failed: ${response.status} ${await response.text()}`)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        if (answer?.v3Body === undefined) throw new Error('normal worker did not publish a typed answer')
        const evidenceRef = answer.v3Body.assertions[0]?.references[0]?.evidenceRef
        if (evidenceRef === undefined) throw new Error('normal answer has no cited evidence')
        const path = `/api/v1/core/answers/${answer.answerId}/sources/${evidenceRef.id}`
        const source = await request(path)
        expect(source['answerRef']).toEqual({ id: answer.answerId, version: '1.0.0', digest: answer.contentHash })
        expect(source).toMatchObject({ answerId: answer.answerId, evidenceId: evidenceRef.id, evidenceRef, originalRef, readability: 're_readable', precision: format === 'text' ? 'exact' : 'approximate' })
        if (format === 'text') expect(source['text']).toContain('pump warranty lasts five years')
        else {
          expect(answer.v3Body.limitations).toContain('approximate_document_source')
          expect(source['family']).toBe('structured_qa')
          expect(source['cells']).toEqual(expect.arrayContaining([expect.objectContaining({ raw: '9007199254740993.000000000001', locator: expect.objectContaining({ kind: 'table_cell', row: 2, column: 2, address: 'B2' }) })]))
        }
        expect((await fetch(`${base}${path}?history=true`)).status).toBe(400)
        await expect(reader.answerSource(answer.answerId, randomUUID(), ctx, signal())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
        await expect(reader.answerSource(randomUUID(), evidenceRef.id, ctx, signal())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
        await expect(reader.answerSource(answer.answerId, evidenceRef.id, freshContext(scope.tenantId, scope.spaceId, ['data-editor']), signal())).rejects.toMatchObject({ code: 'FORBIDDEN' })
        const foreign = await createJobScope(harness.adminClient, 'source-foreign')
        await expect(reader.answerSource(answer.answerId, evidenceRef.id, freshContext(foreign.tenantId, foreign.spaceId, ['platform-admin']), signal())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
        const saved = await options.answers.findByAnswer(answer.answerId, ctx)
        const cited = await options.evidence.get(scope.scopeRef, evidenceRef.id, ctx)
        if (cited === undefined) throw new Error('actual cited envelope unavailable')
        const { integrity: previousIntegrity, ...previousEnvelope } = cited.envelope
        const unboundBody = { ...previousEnvelope, evidenceId: randomUUID() }
        const unbound = await new PostgresEvidenceStore(db).record(scope.scopeRef, { ...unboundBody, integrity: { ...previousIntegrity, digest: sha256DigestOf(canonicalJson(unboundBody)) } }, ctx)
        expect(unbound.envelope.producedBy.runId).toBe(runId)
        await expect(reader.answerSource(answer.answerId, unbound.evidenceRef.id, ctx, signal())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
        const originalBody = saved?.v3Body
        if (originalBody === undefined) throw new Error('stored answer body missing')
        await harness.adminClient.query('UPDATE agent_platform.answer_publications SET body=$2::jsonb WHERE answer_id=$1', [answer.answerId, JSON.stringify({ ...originalBody, blocks: ['tampered body'] })])
        await expect(reader.answerSource(answer.answerId, evidenceRef.id, ctx, signal())).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
        await harness.adminClient.query('UPDATE agent_platform.answer_publications SET body=$2::jsonb WHERE answer_id=$1', [answer.answerId, JSON.stringify(originalBody)])
        await harness.adminClient.query('UPDATE agent_platform.project_revisions SET body=$2::jsonb WHERE project_id=$1 AND revision=1', [projectId, JSON.stringify({ ...body, changeReason: 'forged immutable project body' })])
        await expect(reader.answerSource(answer.answerId, evidenceRef.id, ctx, signal())).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
        await harness.adminClient.query('UPDATE agent_platform.project_revisions SET body=$2::jsonb WHERE project_id=$1 AND revision=1', [projectId, JSON.stringify(body)])
        if (format === 'csv') {
          let enter: () => void = () => undefined
          let release: () => void = () => undefined
          let finish: () => void = () => undefined
          const entered = new Promise<void>((resolve) => { enter = resolve })
          const barrier = new Promise<void>((resolve) => { release = resolve })
          const finished = new Promise<void>((resolve) => { finish = resolve })
          let serverSignal: AbortSignal | undefined
          let lateSuccess = false
          const actualReader = reader.answerSource.bind(reader)
          vi.spyOn(reader, 'answerSource').mockImplementationOnce(async (...args) => {
            serverSignal = args[3]
            try { const value = await actualReader(...args); lateSuccess = true; return value }
            finally { finish() }
          })
          const actualRead = blobs.readAuthorized.bind(blobs)
          vi.spyOn(blobs, 'readAuthorized').mockImplementationOnce(async (...args) => {
            const bytes = await actualRead(...args)
            enter(); await barrier
            return bytes
          })
          const cancellation = new AbortController()
          const pending = fetch(`${base}${path}`, { signal: cancellation.signal })
          const refusal = expect(pending).rejects.toThrow()
          await entered
          cancellation.abort()
          await refusal
          await vi.waitFor(() => expect(serverSignal?.aborted).toBe(true), { timeout: 5_000 })
          release(); await finished
          expect(lateSuccess).toBe(false)
          vi.restoreAllMocks()
        }
        await request(`/api/v1/projects/${projectId}/document-memberships/${String(imported['documentId'])}/revisions`, { op: 'retract', reason: 'human withdrew original source' })
        expect(await request(path)).toMatchObject({ readability: 'archived_snapshot_only', originalRef })
        const cancellation = new AbortController()
        cancellation.abort(new Error('cancel source read'))
        await expect(reader.answerSource(answer.answerId, evidenceRef.id, ctx, cancellation.signal)).rejects.toThrow('cancel source read')
      }
    } finally { await api.close(); await composition.close() }
  }, 120_000)
})

async function fieldFixture(format: 'csv' | 'xlsx') {
  const scope = await createJobScope(harness.adminClient, `field-${format}`)
  const ctx = freshContext(scope.tenantId, scope.spaceId, ['platform-admin', 'semantic-reviewer', 'data-editor'])
  const projectId = randomUUID()
  const definition = relationDefinition(scope.scopeRef)
  await seedIdentityProject(harness.adminClient, scope.scopeRef, projectId, definition.ref)
  const schemas = new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema: projectIndustrySchema(definition) }])
  const optionsSelection = format === 'csv' ? { headerRow: 2, dataStartRow: 3 } : { sheetName: 'Chosen', headerRow: 2, dataStartRow: 3 }
  const labels = Array.from({ length: 12 }, (_, index) => `M-${index + 1}`)
  const bytes = format === 'csv' ? new TextEncoder().encode(`synthetic readings\ndevice_label,watts,on\n${labels.map((label) => `${label},12000.000000000001,true`).join('\n')}\n`) : buildXlsx({ sheetName: 'Chosen', sharedStrings: ['synthetic readings', 'device_label', 'watts', 'on', '12000.000000000001', 'true', ...labels], sheetXml: worksheetOf([rowXml(1, [sharedStringCell('A1', 0)]), rowXml(2, [sharedStringCell('A2', 1), sharedStringCell('B2', 2), sharedStringCell('C2', 3)]), ...labels.map((_, index) => rowXml(index + 3, [sharedStringCell(`A${index + 3}`, index + 6), sharedStringCell(`B${index + 3}`, 4), sharedStringCell(`C${index + 3}`, 5)]))]) })
  const mediaType = format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const staged = await blobs.stage(bytes, { scopeRef: scope.scopeRef }, ctx)
  const original = await blobs.publish({ scopeRef: scope.scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType, purpose: 'document' }, ctx)
  const parsed = await new LocalStructuredIngestionService({ blobs, store: ingestion }).parse({ scopeRef: scope.scopeRef, originalRef: original.blobRef, options: optionsSelection }, ctx)
  const projection = await new StructuredDocumentProjectionService({ blobs, parses, ingestion }).project(parsed.parse, ctx)
  const originals = { read: async (request: { approvedInputRefs: readonly ResourceRef[] }, context: ToolContext) => {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('missing actual approved original')
    return blobs.readAuthorized({ scopeRef: scope.scopeRef, blobRef: ref }, context)
  } }
  const mapping = new ProjectMappingService({ projects, revisions: projects, mappings, records, ingestion, originals, parser: new StructuredDocumentParser(), schemaSource: schemas })
  const table = new StructuredDocumentParser().parse(bytes, { ...optionsSelection, mediaType }).tables[0]
  if (table === undefined) throw new Error('actual native table missing')
  const fieldIds = ['meter_id', 'power', 'active']
  const entries: ColumnMappingEntry[] = table.columns.map((column, index) => ({ fieldRef: fieldIds[index] ?? '', header: column.header, headerDigest: column.headerDigest, columnIndex: index, ...(index === 1 ? { sourceUnitCode: 'W', canonicalUnitCode: 'kW', unitConversion: { fromUnitCode: 'W', toUnitCode: 'kW', numerator: '1', denominator: '1000' } } : {}) }))
  const confirmed = await mapping.confirmMapping(projectId, { format, parseId: parsed.parse.parseId, originalRef: original.blobRef, originalMediaType: mediaType, options: optionsSelection, objectId: 'meter', entries }, randomUUID(), ctx.principal.subjectId, ctx)
  const documentId = randomUUID()
  await documents.registerDocument(scope.scopeRef, projectId, { documentId, documentRef: original.blobRef, documentDigest: original.blobRef.digest, parseId: parsed.parse.parseId, parseRef: projection.spanMapRef, textDigest: projection.normalizedRef.digest, precision: 'approximate', actor: ctx.principal.subjectId, recordedAt: new Date().toISOString() }, ctx)
  const projectService = new ProjectService({ projects, readiness: new PostgresProjectReadinessStore(db), jobs, catalogue: { listEntries: async () => [], findPack: async () => undefined } })
  await projectService.appendRevision(projectId, { expectedRevision: '1', reason: 'human confirmed native field mapping', mappingRefs: [...(await projects.getRevision(scope.scopeRef, projectId, '1', ctx))?.mappingRefs ?? [], confirmed.mapping.ref] }, randomUUID(), ctx.principal.subjectId, ctx)
  const job = await new JobService({ store: jobs }).createJob({ jobId: randomUUID(), kind: 'ingestion', sourceRef: 'actual-field-source', documentRef: encodeStructuredExtractionRef({ kind: 'structured_extraction', parseId: parsed.parse.parseId, parserVersion: parsed.parse.parserVersion, definitionRef: definition.ref, format, originalRef: original.blobRef, originalMediaType: mediaType, options: optionsSelection }), pipelineVersion: '1.0.0', idempotencyKey: randomUUID() }, ctx)
  const service = new InstanceReviewService({ store: instances })
  const workflow = createProjectFactWorkflow({ materialization: { projects, mappings, records, projectDocuments: documents, ingestion, candidates, schemaSource: schemas, jobs, resolveSourceJob: async () => job.jobId }, publication: { store: new PostgresSemanticPublicationStore(db), identity: identities }, instanceRecords: instances })
  const bound = await mapping.bindRecords(projectId, { parseId: parsed.parse.parseId, mappingId: confirmed.mapping.mappingId, mappingVersion: confirmed.mapping.version }, randomUUID(), ctx.principal.subjectId, ctx)
  const stagedFacts = await workflow.materialization.stageRecords(projectId, { documentId, recordRefs: bound.records.map((record) => ({ recordId: record.recordId, revision: record.revision })) }, ctx)
  const candidate = stagedFacts.find((entry) => entry.sourceSpans.some((span) => span.kind === 'structured' && span.locator.kind === 'table_cell' && span.locator.row === 14))
  if (candidate === undefined) throw new Error('actual mapped candidate missing')
  const identity = createInstanceIdentityWorkflow({ service, projects, projectDocuments: documents, candidates, identityStore: identities, schemaSource: schemas, identityMappingRef: definition.ref, index: new InMemoryIdentityIndexReader([]) })
  const created = await identity.createRecord(scope.scopeRef, projectId, { candidateId: candidate.candidateId, documentId, relations: [], idempotencyKey: randomUUID() }, ctx)
  return { scope, ctx, projectId, documentId, candidate, record: created.record, originalRef: original.blobRef, service }
}

describe('current instance field original source (real mapping, native parser, candidate, identity record)', () => {
  it('requires the actual PDF original bytes even when its nonidentity normalized page stays readable, and gates oversize before any body read', async () => {
    const scope = await createJobScope(harness.adminClient, 'pdf-field-origin')
    const ctx = freshContext(scope.tenantId, scope.spaceId, ['platform-admin', 'data-editor', 'semantic-reviewer'])
    const definition = relationDefinition(scope.scopeRef)
    const projectId = randomUUID()
    await seedIdentityProject(harness.adminClient, scope.scopeRef, projectId, definition.ref)
    await new ProjectService({ projects, readiness: new PostgresProjectReadinessStore(db), jobs, catalogue: { listEntries: async () => [], findPack: async () => undefined } }).appendRevision(projectId, { expectedRevision: '1', reason: 'actual original document source configuration' }, randomUUID(), ctx.principal.subjectId, ctx)
    const originalBytes = new Uint8Array(await readFile(new URL('../fixtures/documents/service-terms.pdf', import.meta.url)))
    const staged = await blobs.stage(originalBytes, { scopeRef: scope.scopeRef }, ctx)
    const original = await blobs.publish({ scopeRef: scope.scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: 'application/pdf', purpose: 'document' }, ctx)
    const parsed = await new LocalDocumentExtractionService({ blobs, store: parses }).parse({ scopeRef: scope.scopeRef, originalRef: original.blobRef }, ctx)
    expect(parsed.offsetUnit).toBe('character')
    expect(parsed.normalizedRef.digest).not.toBe(parsed.originalRef.digest)
    const chunk = parsed.chunks.find((chunk) => chunk.locator.kind === 'page')
    if (chunk === undefined) throw new Error('the real PDF has no normalized page locator')
    const documentId = randomUUID()
    await documents.registerDocument(scope.scopeRef, projectId, { documentId, documentRef: parsed.originalRef, documentDigest: parsed.originalRef.digest, parseId: parsed.parseId, parseRef: parsed.spanMapRef, textDigest: parsed.normalizedRef.digest, precision: chunk.precision, actor: ctx.principal.subjectId, recordedAt: new Date().toISOString() }, ctx)
    const job = await new JobService({ store: jobs }).createJob({ jobId: randomUUID(), kind: 'ingestion', sourceRef: original.blobRef.id, documentRef: original.blobRef.id, pipelineVersion: '1.0.0', idempotencyKey: randomUUID() }, ctx)
    const attributes = [{ attributeId: 'site_id', value: chunk.text, raw: chunk.text }]
    const sourceSpans = [{ parseId: parsed.parseId, chunkId: chunk.chunkId, locator: chunk.locator, spanKind: chunk.spanKind, precision: chunk.precision, textDigest: chunk.textDigest, quoteDigest: chunk.quoteDigest }]
    const inputVersion = { definitionRef: definition.ref, parseId: parsed.parseId, parserVersion: parsed.parserVersion, pipelineVersion: '1.0.0', documentVersionRef: parsed.originalRef }
    const candidate: EntityCandidate = { candidateId: randomUUID(), jobId: job.jobId, kind: 'entity', objectId: 'site', attributes, sourceSpans, inputVersion, deterministic: true, state: 'pending_review', issues: [], idempotencyKey: sha256DigestOf(canonicalJson({ jobId: job.jobId, attributes, sourceSpans, inputVersion })), recordedAt: new Date().toISOString() }
    await candidates.insertCandidates(scope.scopeRef, [candidate], ctx)
    const schemaSource = new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema: projectIndustrySchema(definition) }])
    const identity = createInstanceIdentityWorkflow({ service: new InstanceReviewService({ store: instances }), projects, projectDocuments: documents, candidates, identityStore: identities, schemaSource, identityMappingRef: definition.ref, index: new InMemoryIdentityIndexReader([]) })
    const created = await identity.createRecord(scope.scopeRef, projectId, { candidateId: candidate.candidateId, documentId, relations: [], idempotencyKey: randomUUID() }, ctx)
    const reader = createCoreSourceViewReader(options)
    const read = () => reader.instanceFieldSource(projectId, created.record.recordId, 'site_id', created.record.recordRevision, ctx, signal())
    expect(await read()).toMatchObject({ readability: 're_readable', originalRef: original.blobRef, text: chunk.text })
    const normalized = await blobs.readAuthorized({ scopeRef: scope.scopeRef, blobRef: parsed.normalizedRef }, ctx)
    const objects = new FileSystemObjectStore(directory)
    await objects.remove(original.contentDigest)
    expect(await blobs.readAuthorized({ scopeRef: scope.scopeRef, blobRef: parsed.normalizedRef }, ctx)).toEqual(normalized)
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
    await objects.publish(original.contentDigest, originalBytes)
    const corrupted = originalBytes.slice(); corrupted[0] = 0
    await objects.publish(original.contentDigest, corrupted)
    expect(await blobs.readAuthorized({ scopeRef: scope.scopeRef, blobRef: parsed.normalizedRef }, ctx)).toEqual(normalized)
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
    await objects.publish(original.contentDigest, originalBytes)
    const metadata = blobs.getAuthorizedMetadata.bind(blobs)
    vi.spyOn(blobs, 'getAuthorizedMetadata').mockImplementationOnce(async (...args) => ({ ...await metadata(...args), byteSize: 8 * 1_048_576 + 1 }))
    const body = vi.spyOn(blobs, 'readAuthorized')
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
    expect(body).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    expect(await read()).toMatchObject({ readability: 're_readable', text: chunk.text })
  }, 120_000)
  it.each(['csv', 'xlsx'] as const)('reads %s chosen/header2 row14 beyond preview and rejects wrong revision/cell/current-source and async source/cancellation races', async (format) => {
    const p = await fieldFixture(format)
    const reader = createCoreSourceViewReader(options)
    const read = () => reader.instanceFieldSource(p.projectId, p.record.recordId, 'power', p.record.recordRevision, p.ctx, signal())
    const actual = await read()
    expect(actual).toMatchObject({ precision: 'exact', readability: 're_readable', originalRef: p.originalRef, recordRevision: p.record.recordRevision, parseId: p.candidate.inputVersion.parseId, locator: { kind: 'table_cell', format, row: 14, column: 2, address: 'B14' }, cells: [{ raw: '12000.000000000001', locator: { kind: 'table_cell', row: 14, column: 2 } }] })
    await expect(reader.instanceFieldSource(p.projectId, p.record.recordId, 'power', '999', p.ctx, signal())).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(reader.instanceFieldSource(p.projectId, p.record.recordId, 'invented', p.record.recordRevision, p.ctx, signal())).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' })
    const foreign = await createJobScope(harness.adminClient, 'field-foreign')
    await expect(reader.instanceFieldSource(p.projectId, p.record.recordId, 'power', p.record.recordRevision, freshContext(foreign.tenantId, foreign.spaceId, ['platform-admin']), signal())).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
    await expect(reader.instanceFieldSource(p.projectId, p.record.recordId, 'power', p.record.recordRevision, freshContext(p.scope.tenantId, p.scope.spaceId, ['unscoped-user']), signal())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const get = instances.getRecord.bind(instances)
    vi.spyOn(instances, 'getRecord').mockImplementationOnce(async (...args) => {
      const record = await get(...args)
      if (record === undefined) throw new Error('actual record missing')
      return { ...record, fields: record.fields.map((field) => field.fieldId !== 'power' || field.source.locator.kind !== 'table_cell' ? field : { ...field, source: { ...field.source, locator: { ...field.source.locator, column: 3 } } }) }
    })
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
    vi.restoreAllMocks()
    const nativeRead = blobs.readAuthorized.bind(blobs)
    vi.spyOn(blobs, 'readAuthorized').mockImplementationOnce(async (...args) => {
      const bytes = await nativeRead(...args)
      const changed = bytes.slice()
      changed[0] = changed[0] === 65 ? 66 : 65
      return changed
    })
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
    vi.restoreAllMocks()
    const cancellation = new AbortController()
    vi.spyOn(blobs, 'readAuthorized').mockImplementationOnce(async (...args) => {
      const bytes = await nativeRead(...args)
      cancellation.abort(new Error('cancelled during actual original read'))
      return bytes
    })
    await expect(reader.instanceFieldSource(p.projectId, p.record.recordId, 'power', p.record.recordRevision, p.ctx, cancellation.signal)).rejects.toThrow('cancelled during actual original read')
    vi.restoreAllMocks()
    let edited = p.record
    vi.spyOn(blobs, 'readAuthorized').mockImplementationOnce(async (...args) => {
      const bytes = await nativeRead(...args)
      edited = await p.service.editField(p.scope.scopeRef, p.projectId, p.record.recordId, { expectedRevision: p.record.recordRevision, fieldId: 'power', normalizedValue: { kind: 'quantity', value: '12.000000000000001', unitCode: 'kW' }, reason: 'human reviewed corrected field during source read', idempotencyKey: randomUUID() }, p.ctx)
      return bytes
    })
    await expect(read()).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    vi.restoreAllMocks()
    p.record = edited
    expect((await read()).cells?.[0]?.raw).toBe('12000.000000000001')
    vi.spyOn(blobs, 'readAuthorized').mockImplementationOnce(async (...args) => {
      const bytes = await nativeRead(...args)
      await documents.reviseDocument(p.scope.scopeRef, p.projectId, { documentId: p.documentId, op: 'retract', reason: 'withdraw during source read', actor: p.ctx.principal.subjectId, recordedAt: new Date().toISOString() }, p.ctx)
      return bytes
    })
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
    vi.restoreAllMocks()
    await expect(read()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
  }, 120_000)
})
