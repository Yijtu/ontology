import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Ajv2020 from 'ajv/dist/2020.js'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { DuckDbProjectDatasetAdapter } from '@ontology/adapter-data-duckdb'
import { ControlPostgresDatabase, PostgresAnswerStore, PostgresAssetCandidateStore, PostgresAssetWorkspaceStore, PostgresCandidateStore, PostgresComputeInvocationStore, PostgresComputeOutputBindingsStore, PostgresComputeResultArtifactStore, PostgresEvidenceStore, PostgresIdentityDecisionStore, PostgresInstanceReviewStore, PostgresJobStore, PostgresProfileStore, PostgresProjectDocumentStore, PostgresProjectMappingStore, PostgresProjectReadinessStore, PostgresProjectRecordStore, PostgresProjectStore, PostgresPublishedTaskBindingStore, PostgresRunExecutionBindingStore, PostgresRunStore, PostgresSemanticPublicationStore, PostgresTaskInputSnapshotStore, PostgresWorkflowStore } from '@ontology/adapter-control-postgres'
import { LocalDocumentExtractionService, LocalStructuredIngestionService, PostgresDocumentParseStore, PostgresStructuredIngestionStore, StructuredDocumentParser, StructuredDocumentProjectionService } from '@ontology/adapter-extraction-document'
import { coreScenarioTaskBindings, createBlobArtifactWriter, createCoreApi, createCoreApprovedInput, createCoreAuthoring, createCoreLocalComposition, createCoreProjectComputeInput, createCoreSourceViewReader, createCoreStructuredImportWorkflow, createInstanceIdentityWorkflow, createProjectFactWorkflow, createRequestNativeSourceReader, loadCoreExamples, readSavedInputSources } from '@ontology/app-api'
import type { CoreSourceViewOptions } from '@ontology/app-api'
import { canonicalJson, CompositeReviewableCandidateReader, InMemoryIndustrySchemaSource, InstanceReviewService, JobService, ProjectDataMaterializationService, ProjectMappingService, ProjectService, encodeStructuredExtractionRef, sha256DigestOf } from '@ontology/application'
import { createExampleComputeHandlers, exampleOperationRegistry, exampleRegisteredOperation, RegisteredComputeExecutionService, registeredOperationDigest } from '@ontology/tool-services'
import { PROJECT_DATASET_SOURCE_ORIGIN_DIGEST_VERSION, createToolContext, isRecord, isResourceRef } from '@ontology/contracts'
import type { ColumnMappingEntry, EntityCandidate, ProjectRevisionBody, PublishedAnswer, ResourceRef, RunExecutionBinding, ToolContext } from '@ontology/contracts'
import { definitionVersionDigest, InMemoryIdentityIndexReader, PublishedProjectDatasetSource, projectIndustrySchema, SupportEvidenceDependencySource } from '@ontology/semantic-engine'
import { ProvenanceReadService } from '@ontology/provenance'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { seedIdentityProject } from './instance-identity-fixtures'
import { toolContext } from '../unit/component-registry-fixtures'
import { relationDefinition } from '../unit/rule-relation-fixtures'
import { buildXlsx, rowXml, sharedStringCell, worksheetOf } from '../fixtures/structured/xlsx'
import { exampleComputeArtifact } from '../helpers/example-compute-artifact'

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
        if (format === 'csv') {
          expect((await fetch(`${base}${path}?tableId=partial`, { signal: AbortSignal.timeout(30_000) })).status).toBe(400)
          expect((await fetch(`${base}${path}?history=true`, { signal: AbortSignal.timeout(30_000) })).status).toBe(400)
          const invalidCell = await fetch(`${base}${path}?tableId=unknown&rowKey=opaque&columnRef=unknown`, { signal: AbortSignal.timeout(30_000) })
          expect(invalidCell.ok).toBe(false)
        }
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

async function fieldFixture(format: 'csv' | 'xlsx', rowCount = 12, variant: 'query' | 'compute' = 'query', allRecords = false, signal?: AbortSignal) {
  const started = Date.now()
  const trace = (phase: string, records?: number) => { if (allRecords) console.info('actual1001 fixture', JSON.stringify({ phase, records, elapsedMs: Date.now() - started })) }
  const check = () => signal?.throwIfAborted()
  trace('start'); check()
  const scope = await createJobScope(harness.adminClient, `field-${format}`)
  const ctx = freshContext(scope.tenantId, scope.spaceId, ['platform-admin', 'semantic-reviewer', 'data-editor'])
  const projectId = randomUUID()
  const baseDefinition = relationDefinition(scope.scopeRef)
  const computeObject = baseDefinition.objects.find((object) => object.id === 'meter')!
  const identityAttribute = baseDefinition.attributes.find((attribute) => attribute.id === 'meter_id')!
  const computeAttribute = { kind: 'attribute' as const, namespace: baseDefinition.namespace, objectId: 'meter', cardinality: { min: 1, max: 1 }, standardProvenance: [] }
  const computeDefinition = { ...baseDefinition, objects: [computeObject], attributes: [identityAttribute, { ...computeAttribute, id: 'amount', valueType: 'number' as const }, { ...computeAttribute, id: 'unit_code', valueType: 'string' as const }], identityScopes: baseDefinition.identityScopes.filter((identity) => identity.objectId === 'meter'), relations: [] }
  const definition = variant === 'query' ? baseDefinition : { ...computeDefinition, ref: { ...computeDefinition.ref, digest: definitionVersionDigest(computeDefinition) } }
  await seedIdentityProject(harness.adminClient, scope.scopeRef, projectId, definition.ref)
  const schemas = new InMemoryIndustrySchemaSource([{ ref: definition.ref, schema: projectIndustrySchema(definition) }])
  const optionsSelection = format === 'csv' ? { headerRow: 2, dataStartRow: 3 } : { sheetName: 'Chosen', headerRow: 2, dataStartRow: 3 }
  const labels = Array.from({ length: rowCount }, (_, index) => `M-${index + 1}`)
  const bytes = variant === 'compute' ? new TextEncoder().encode(`synthetic counts\ndevice_label,amount,unit\n${labels.map((label, index) => `${label},${index % 2 === 0 ? '2.5' : '1.25'},each`).join('\n')}\n`) : format === 'csv' ? new TextEncoder().encode(`synthetic readings\ndevice_label,watts,on\n${labels.map((label) => `${label},12000.000000000001,true`).join('\n')}\n`) : buildXlsx({ sheetName: 'Chosen', sharedStrings: ['synthetic readings', 'device_label', 'watts', 'on', '12000.000000000001', 'true', ...labels], sheetXml: worksheetOf([rowXml(1, [sharedStringCell('A1', 0)]), rowXml(2, [sharedStringCell('A2', 1), sharedStringCell('B2', 2), sharedStringCell('C2', 3)]), ...labels.map((_, index) => rowXml(index + 3, [sharedStringCell(`A${index + 3}`, index + 6), sharedStringCell(`B${index + 3}`, 4), sharedStringCell(`C${index + 3}`, 5)]))]) })
  const mediaType = format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const staged = await blobs.stage(bytes, { scopeRef: scope.scopeRef }, ctx)
  const original = await blobs.publish({ scopeRef: scope.scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType, purpose: 'document' }, ctx)
  const parsed = await new LocalStructuredIngestionService({ blobs, store: ingestion }).parse({ scopeRef: scope.scopeRef, originalRef: original.blobRef, options: optionsSelection }, ctx)
  trace('native-parsed'); check()
  const projection = await new StructuredDocumentProjectionService({ blobs, parses, ingestion }).project(parsed.parse, ctx)
  const originals = { read: async (request: { approvedInputRefs: readonly ResourceRef[] }, context: ToolContext) => {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('missing actual approved original')
    return blobs.readAuthorized({ scopeRef: scope.scopeRef, blobRef: ref }, context)
  } }
  const mapping = new ProjectMappingService({ projects, revisions: projects, mappings, records, ingestion, originals, parser: new StructuredDocumentParser(), schemaSource: schemas })
  const table = new StructuredDocumentParser().parse(bytes, { ...optionsSelection, mediaType }).tables[0]
  if (table === undefined) throw new Error('actual native table missing')
  const fieldIds = variant === 'compute' ? ['meter_id', 'amount', 'unit_code'] : ['meter_id', 'power', 'active']
  const entries: ColumnMappingEntry[] = table.columns.map((column, index) => ({ fieldRef: fieldIds[index] ?? '', header: column.header, headerDigest: column.headerDigest, columnIndex: index, ...(index === 1 && variant === 'query' ? { sourceUnitCode: 'W', canonicalUnitCode: 'kW', unitConversion: { fromUnitCode: 'W', toUnitCode: 'kW', numerator: '1', denominator: '1000' } } : {}) }))
  const confirmed = await mapping.confirmMapping(projectId, { format, parseId: parsed.parse.parseId, originalRef: original.blobRef, originalMediaType: mediaType, options: optionsSelection, objectId: 'meter', entries }, randomUUID(), ctx.principal.subjectId, ctx)
  const documentId = randomUUID()
  await documents.registerDocument(scope.scopeRef, projectId, { documentId, documentRef: original.blobRef, documentDigest: original.blobRef.digest, parseId: parsed.parse.parseId, parseRef: projection.spanMapRef, textDigest: projection.normalizedRef.digest, precision: 'approximate', actor: ctx.principal.subjectId, recordedAt: new Date().toISOString() }, ctx)
  const projectService = new ProjectService({ projects, readiness: new PostgresProjectReadinessStore(db), jobs, catalogue: { listEntries: async () => [], findPack: async () => undefined } })
  const members = await documents.listDocuments(scope.scopeRef, projectId, { state: 'active', limit: 200 }, ctx)
  const documentSetRef = (await createBlobArtifactWriter(blobs).putBytes({ scopeRef: scope.scopeRef, mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson({ schemaVersion: 'project-document-set@1', projectId, members: members.memberships.map((member) => ({ documentId: member.documentId, documentRef: member.documentRef, parseId: member.parseId, parseRef: member.parseRef, membershipRevision: member.membershipRevision, precision: member.precision })) })) }, ctx)).blobRef
  await projectService.appendRevision(projectId, { expectedRevision: '1', reason: 'human confirmed native field mapping', documentSetRef, mappingRefs: [...(await projects.getRevision(scope.scopeRef, projectId, '1', ctx))?.mappingRefs ?? [], confirmed.mapping.ref] }, randomUUID(), ctx.principal.subjectId, ctx)
  const job = await new JobService({ store: jobs }).createJob({ jobId: randomUUID(), kind: 'ingestion', sourceRef: 'actual-field-source', documentRef: encodeStructuredExtractionRef({ kind: 'structured_extraction', parseId: parsed.parse.parseId, parserVersion: parsed.parse.parserVersion, definitionRef: definition.ref, format, originalRef: original.blobRef, originalMediaType: mediaType, options: optionsSelection }), pipelineVersion: '1.0.0', idempotencyKey: randomUUID() }, ctx)
  const service = new InstanceReviewService({ store: instances })
  const workflow = createProjectFactWorkflow({ materialization: { projects, mappings, records, projectDocuments: documents, ingestion, candidates, schemaSource: schemas, jobs, resolveSourceJob: async () => job.jobId }, publication: { store: new PostgresSemanticPublicationStore(db), identity: identities }, instanceRecords: instances })
  const bound = await mapping.bindRecords(projectId, { parseId: parsed.parse.parseId, mappingId: confirmed.mapping.mappingId, mappingVersion: confirmed.mapping.version }, randomUUID(), ctx.principal.subjectId, ctx)
  trace('mapped-bound', bound.records.length); check()
  const selectedRecords = allRecords ? bound.records : bound.records.filter((record) => record.fields[0]?.locator.kind === 'table_cell' && record.fields[0].locator.row >= rowCount - 9)
  const stagedFacts: EntityCandidate[] = []
  for (let offset = 0; offset < selectedRecords.length; offset += 200) { check(); stagedFacts.push(...await workflow.materialization.stageRecords(projectId, { documentId, recordRefs: selectedRecords.slice(offset, offset + 200).map((record) => ({ recordId: record.recordId, revision: record.revision })) }, ctx)); trace('staged', stagedFacts.length) }
  const candidate = stagedFacts.find((entry) => entry.sourceSpans.some((span) => span.kind === 'structured' && span.locator.kind === 'table_cell' && span.locator.row === rowCount + 2))
  if (candidate === undefined) throw new Error('actual mapped candidate missing')
  const identity = createInstanceIdentityWorkflow({ service, projects, projectDocuments: documents, candidates, identityStore: identities, schemaSource: schemas, identityMappingRef: definition.ref, index: new InMemoryIdentityIndexReader([]) })
  const created = await identity.createRecord(scope.scopeRef, projectId, { candidateId: candidate.candidateId, documentId, relations: [], idempotencyKey: randomUUID() }, ctx)
  return { scope, ctx, projectId, documentId, candidate, record: created.record, originalRef: original.blobRef, service, identity, workflow, stagedFacts, schemas, definition }
}


async function humanFixture(p: Awaited<ReturnType<typeof fieldFixture>>, parallel = 1, signal?: AbortSignal) {
  const started = Date.now()
  const trace = (phase: string, records?: number) => { if (p.stagedFacts.length > 200) console.info('actual1001 fixture', JSON.stringify({ phase, records, elapsedMs: Date.now() - started })) }
  const check = () => signal?.throwIfAborted()
  trace('human-start', p.stagedFacts.length)
  const publications = new PostgresSemanticPublicationStore(db)
  const backend = new DuckDbProjectDatasetAdapter()
  const human: unknown[] = []
  try {
      const approve = async (candidate: EntityCandidate) => {
        check()
        const requestCtx = parallel > 1 ? freshContext(p.scope.tenantId, p.scope.spaceId, p.ctx.principal.roles) : p.ctx
        const created = candidate.candidateId === p.candidate.candidateId ? { record: p.record } : await p.identity.createRecord(p.scope.scopeRef, p.projectId, { candidateId: candidate.candidateId, documentId: p.documentId, relations: [], idempotencyKey: randomUUID() }, requestCtx)
        check()
        const confirmed = await p.service.confirmFields(p.scope.scopeRef, p.projectId, candidate.candidateId, { expectedRevision: created.record.recordRevision, decisions: created.record.fields.map((field) => ({ fieldId: field.fieldId, decision: 'confirm' })), idempotencyKey: randomUUID() }, requestCtx)
        check()
        const instance = await p.identity.adjudicateIdentity(p.scope.scopeRef, p.projectId, candidate.candidateId, { expectedRevision: confirmed.record.recordRevision, kind: 'create', reason: 'human checked the genuine imported identifier and fields', idempotencyKey: randomUUID() }, requestCtx)
        check()
        const review = await p.workflow.publication.reviewCandidate({ candidateId: candidate.candidateId, expectedRevision: '0', decision: 'approve', reason: 'human checked actual mapped fields and cell origins' }, requestCtx)
        check()
        human.push({ candidateId: candidate.candidateId, candidateDigest: candidate.idempotencyKey, instance, events: await instances.listConfirmations(p.scope.scopeRef, p.projectId, candidate.candidateId, requestCtx), review })
        if (human.length % 50 === 0 || human.length === p.stagedFacts.length) trace('human-approved', human.length)
      }
      let next = 0
      const workers = await Promise.allSettled(Array.from({ length: parallel }, async () => { while (next < p.stagedFacts.length) { check(); const candidate = p.stagedFacts[next++]; if (candidate !== undefined) await approve(candidate) } }))
      const failure = workers.find((worker) => worker.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      check()
      p.ctx = freshContext(p.scope.tenantId, p.scope.spaceId, p.ctx.principal.roles)
      for (let offset = 0; offset < p.stagedFacts.length; offset += 200) { check(); trace('publication-start', offset); await p.workflow.publication.publish({ approvedCandidateRefs: p.stagedFacts.slice(offset, offset + 200).map((candidate) => ({ candidateId: candidate.candidateId, kind: 'entity' as const })), schemaRef: p.definition.ref, expectedRevision: await publications.latestPublicationRevision(p.scope.scopeRef, p.ctx), idempotencyKey: randomUUID() }, p.ctx); trace('published', Math.min(offset + 200, p.stagedFacts.length)) }
      const revision = await projects.getRevision(p.scope.scopeRef, p.projectId, '2', p.ctx)
      if (revision === undefined) throw new Error('actual mapped project revision unavailable')
      const publishedSource = new PublishedProjectDatasetSource({ publications, identity: identities, records, mappings, projectDocuments: documents, definition: async () => p.definition })
      check(); trace('official-read-start')
      const official = await publishedSource.read(p.scope.scopeRef, revision, 'meter', p.ctx)
      check(); trace('official-read', official.rows.length)
      expect(official.rows).toHaveLength(p.stagedFacts.length)
      const materialization = new ProjectDataMaterializationService({ projects, publishedSource, readiness: new PostgresProjectReadinessStore(db), schemaSource: p.schemas, writer: backend, query: backend })
      trace('dataset-start'); check()
      const status = await materialization.materialize(p.projectId, { objectId: 'meter' }, p.ctx)
      if (status.snapshotRef === undefined) throw new Error('actual activated dataset snapshot unavailable')
      check(); trace('dataset-ready')
      const snapshotRef = status.snapshotRef
      expect(human).toHaveLength(p.stagedFacts.length)
      return { ...p, publications, backend, revision, official, snapshotRef, publishedSource }
  } catch (error) { backend.close(); throw error }
}

async function captureFixture(p: Awaited<ReturnType<typeof humanFixture>>) {
  p.ctx = freshContext(p.scope.tenantId, p.scope.spaceId, p.ctx.principal.roles)
  const { publications, backend, revision, publishedSource } = p
  const started = Date.now()
  const trace = (phase: string) => { if (p.stagedFacts.length > 200) console.info('actual1001 capture', JSON.stringify({ phase, elapsedMs: Date.now() - started })) }
  try {
      const writer = createBlobArtifactWriter(blobs)
      const write = async (body: unknown) => (await writer.putBytes({ scopeRef: p.scope.scopeRef, content: new TextEncoder().encode(canonicalJson(body)), mediaType: 'application/json' }, p.ctx)).blobRef
      const operations = exampleOperationRegistry(exampleComputeArtifact)
      const authoring = createCoreAuthoring({ blobs, objectStore: new FileSystemObjectStore(directory), registry, workspaces: new PostgresAssetWorkspaceStore(db), jobs, parses, structured: ingestion, operations, models: { generationEnabled: false, decisionEnabled: false }, terminology: { getTerminology: async () => undefined } })
      const captured = createCoreApprovedInput({ projects, documents, records, instances, candidates, reviews: publications, reviewable: new CompositeReviewableCandidateReader({ definition: new PostgresAssetCandidateStore(db), instance: candidates }), schemas: p.schemas, source: publishedSource, authoring, reader: { read: async (request, ctx) => blobs.readAuthorized({ scopeRef: p.scope.scopeRef, blobRef: request.approvedInputRefs[0]! }, ctx) } })
      trace('resolve-start')
      const inputRef = await captured.resolve(p.scope.scopeRef, revision, p.ctx)
      trace('resolve-ready')
      expect(await captured.validateCaptured(p.scope.scopeRef, revision, inputRef, p.ctx)).toEqual(inputRef)
      trace('validate-ready')
      const controller = new AbortController()
      const check = () => controller.signal.throwIfAborted()
      const readBytes = async (ref: ResourceRef, cap: number) => {
        const metadata = await blobs.getAuthorizedMetadata({ scopeRef: p.scope.scopeRef, blobRef: ref }, p.ctx)
        expect(metadata.byteSize).toBeLessThanOrEqual(cap)
        const bytes = await blobs.readAuthorized({ scopeRef: p.scope.scopeRef, blobRef: ref }, p.ctx)
        expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(ref.digest)
        return bytes
      }
      const readJson = async (ref: ResourceRef, cap: number): Promise<unknown> => JSON.parse(new TextDecoder().decode(await readBytes(ref, cap)))
      const declaredTasks = coreScenarioTaskBindings({ ...loadCoreExamples({ targetScopeRef: p.scope.scopeRef }).scenarios[0]!, definitionRef: p.definition.ref })
      return { ...p, writer, write, operations, authoring, captured, inputRef, declaredTasks, controller, check, readBytes, readJson }
  } catch (error) { backend.close(); throw error }
}

async function approvedFixture(p: Awaited<ReturnType<typeof fieldFixture>>) { return captureFixture(await humanFixture(p)) }

describe('current instance field original source (real mapping, native parser, candidate, identity record)', () => {
  it('replays actual approved high-precision query inputs from a 1001-row original after rejection and withdrawal, with bounded coverage and native request caching', async () => {
    const p = await approvedFixture(await fieldFixture('csv', 1001))
    const { publications, backend, revision, official, inputRef, snapshotRef, write, controller, check, readBytes, readJson } = p
    try {
      const inputBody = JSON.parse(new TextDecoder().decode(await blobs.readAuthorized({ scopeRef: p.scope.scopeRef, blobRef: inputRef }, p.ctx))) as { counts: unknown }
      expect(inputBody.counts).toMatchObject({ total: 1001, approved: 12, excluded: 989 })
      const currentTail = await instances.getRecord(p.scope.scopeRef, p.projectId, p.candidate.candidateId, p.ctx)
      if (currentTail === undefined) throw new Error('actual native tail instance unavailable')
      expect(await createCoreSourceViewReader(options).instanceFieldSource(p.projectId, currentTail.recordId, 'power', currentTail.recordRevision, p.ctx, signal())).toMatchObject({ cells: [{ raw: '12000.000000000001', locator: { row: 1003, column: 2, address: 'B1003' } }] })
      const scenario = loadCoreExamples({ targetScopeRef: p.scope.scopeRef }).scenarios[0]!
      const declaredTasks = coreScenarioTaskBindings({ ...scenario, definitionRef: p.definition.ref })
      const task = declaredTasks.find((binding) => binding.kind === 'structured_query')
      if (task === undefined) throw new Error('actual declared query binding unavailable')
      const runId = randomUUID()
      const binding: RunExecutionBinding = { schemaVersion: 'run-execution-binding@1', runId, request: { mode: 'task', projectRevisionRef: revision.ref, inputSnapshotRef: inputRef, inputSnapshotDigest: inputRef.digest, taskBindingRef: task.taskBindingRef, parameters: {} }, allowedTaskBindingRefs: [task.taskBindingRef], projectDatasetSnapshotRef: snapshotRef, resolvedProfileRef: revision.profileRef, runtimeRef: await write({ schemaVersion: 'source-leaf-test-runtime@1' }), inputManifestDigestAtCreation: inputRef.digest, effectiveLimitsRef: task.resultSchemaRef, effectiveTime: { validAt: new Date().toISOString(), asOfRecordedSeq: official.factRecordedPoint.semantic } }
      const bindingRef = await write(binding)
      await new PostgresRunExecutionBindingStore(db).archiveBinding(p.scope.scopeRef, runId, bindingRef, binding, p.ctx)
      const archived = await options.executionBindings.getBindingByRun(p.scope.scopeRef, runId, p.ctx)
      if (archived === undefined) throw new Error('actual immutable run binding unavailable')
      const descriptor = await backend.describeSnapshot(p.scope.scopeRef, snapshotRef, p.ctx)
      if (descriptor === undefined) throw new Error('actual activated query descriptor unavailable')
      const columns = [{ name: 'power', semanticFieldRef: 'power', unit: 'kW' }, { name: 'record_id' }, { name: 'sources_json' }]
      const rows = official.rows.map((row) => [row.values['power']!.value, row.recordId, canonicalJson(row.sources)])
      const payload = { table: { columns, rows } }
      const read = async (savedPayload = payload, savedBinding = archived.binding) => readSavedInputSources({ ports: { datasets: backend, publications }, candidates, mappings, parses, confirmations: instances, scope: p.scope.scopeRef, ctx: p.ctx, archived: { ...archived, binding: savedBinding }, revision, payload: savedPayload, native: createRequestNativeSourceReader({ scope: p.scope.scopeRef, ctx: p.ctx, signal: controller.signal, ingestion, readBytes, check }), readJson, readBytes, check })
      const nativeRead = vi.spyOn(ingestion, 'findParseByDigest')
      expect(await read()).toMatchObject({ sourceCoverage: { mode: 'query_result_sample', requested: 10, verified: 10, displayed: 10, knownTotal: 12, truncated: true, coverage: 'partial' }, fragments: expect.arrayContaining([expect.objectContaining({ originalRef: p.originalRef, cells: [expect.objectContaining({ raw: '12000.000000000001' })] })]) })
      expect(nativeRead).toHaveBeenCalledTimes(1)
      vi.restoreAllMocks()
      const compactRows = official.rows.map((row) => [row.values['power']!.value, row.recordId, canonicalJson({ schemaVersion: PROJECT_DATASET_SOURCE_ORIGIN_DIGEST_VERSION, recordId: row.recordId, sourcesDigest: sha256DigestOf(canonicalJson(row.sources)) })])
      const compactPayload = { table: { columns, rows: compactRows } }
      expect(await read(compactPayload)).toMatchObject({ sourceCoverage: { mode: 'query_result_sample', verified: 10, knownTotal: 12, coverage: 'partial' } })
      const token = (row: readonly unknown[]) => JSON.parse(String(row[2])) as Record<string, unknown>
      const wrongDigestRows = compactRows.map((row, index) => index === 0 ? [row[0]!, row[1]!, canonicalJson({ ...token(row), sourcesDigest: sha256DigestOf('different full source array') })] : row)
      await expect(read({ table: { columns, rows: wrongDigestRows } })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      const wrongRecordRows = compactRows.map((row, index) => index === 0 ? [row[0]!, row[1]!, canonicalJson({ ...token(row), recordId: randomUUID() })] : row)
      await expect(read({ table: { columns, rows: wrongRecordRows } })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      const wrongVersionRows = compactRows.map((row, index) => index === 0 ? [row[0]!, row[1]!, canonicalJson({ ...token(row), schemaVersion: 'project-dataset-source-origins@99' })] : row)
      await expect(read({ table: { columns, rows: wrongVersionRows } })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      const foreignSnapshot = { ...snapshotRef, id: randomUUID() }
      await expect(read(compactPayload, { ...archived.binding, projectDatasetSnapshotRef: foreignSnapshot })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      await expect(read({ table: { columns, rows: rows.map((row, index) => index === 0 ? ['12.000000000000002', ...row.slice(1)] : row) } })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      await expect(read({ table: { columns: columns.map((column, index) => index === 0 ? { ...column, unit: 'W' } : column), rows } })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      const wrongSources = official.rows[0]!.sources.map((source, index) => index === 0 && source.locator.kind === 'table_cell' ? { ...source, locator: { ...source.locator, column: 99, address: 'CU3' } } : source)
      await expect(read({ table: { columns, rows: rows.map((row, index) => index === 0 ? [row[0]!, row[1]!, canonicalJson(wrongSources)] : row) } })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      for (const candidate of p.stagedFacts) await p.workflow.publication.reviewCandidate({ candidateId: candidate.candidateId, expectedRevision: '1', decision: 'reject', reason: 'later review does not erase an already authorized old answer' }, p.ctx)
      await documents.reviseDocument(p.scope.scopeRef, p.projectId, { documentId: p.documentId, op: 'retract', reason: 'later original withdrawal', actor: p.ctx.principal.subjectId, recordedAt: new Date().toISOString() }, p.ctx)
      expect((await read()).sourceCoverage).toMatchObject({ verified: 10, knownTotal: 12 })
      const objects = new FileSystemObjectStore(directory)
      const original = await blobs.readAuthorized({ scopeRef: p.scope.scopeRef, blobRef: p.originalRef }, p.ctx)
      const tampered = original.slice(); tampered[0] = 0
      await objects.publish(p.originalRef.digest, tampered)
      await expect(read()).rejects.toThrow()
      await objects.publish(p.originalRef.digest, original)
      controller.abort(new Error('cancelled fixed original-source traversal'))
      await expect(read()).rejects.toThrow('cancelled fixed original-source traversal')
    } finally { backend.close(); vi.restoreAllMocks() }
  }, 120_000)
  it('replays actual compatible registered compute inputs and rejects wrong column, scope, metadata and late mutation without losing historical originals', async () => {
    const p = await approvedFixture(await fieldFixture('csv', 2, 'compute'))
    const { publications, backend, revision, official, inputRef, write, writer, operations, authoring, captured, declaredTasks, controller, check, readBytes, readJson } = p
    try {
      const computeTask = declaredTasks.find((entry) => entry.kind === 'compute')
      if (computeTask === undefined) throw new Error('actual declared compute binding unavailable')
      const taskStore = new PostgresPublishedTaskBindingStore(db), snapshots = new PostgresTaskInputSnapshotStore(db)
      await taskStore.putBinding(p.scope.scopeRef, computeTask, p.ctx)
      const ajv = new Ajv2020({ strict: true, allErrors: true })
      const validate = (schema: Readonly<Record<string, unknown>>, value: unknown) => { const fn = ajv.compile(schema); const valid = fn(value); return { valid, issues: (fn.errors ?? []).map((error) => ({ pointer: error.instancePath, reason: error.message ?? 'invalid' })) } }
      const computeInput = createCoreProjectComputeInput({ blobs, authoring, snapshots, schemas: p.schemas, operations, validator: { validate: (schema, value) => { const result = validate(schema, value); return { valid: result.valid, issues: result.issues.map((issue) => `${issue.pointer}: ${issue.reason}`) } } }, validateBase: (scope, selected, ctx, signal) => captured.validateCaptured(scope, selected, inputRef, ctx, signal) })
      const derivedRef = await computeInput(p.scope.scopeRef, revision, inputRef, computeTask, { objectId: 'meter', idField: 'meter_id', amountField: 'amount', unitField: 'unit_code' }, p.ctx, controller.signal)
      const operation = exampleRegisteredOperation(exampleComputeArtifact)
      const computeResults = new PostgresComputeResultArtifactStore(db), computeBindings = new PostgresComputeOutputBindingsStore(db), computeInvocations = new PostgresComputeInvocationStore(db)
      const parametersRef = await write({})
      const compute = new RegisteredComputeExecutionService({ operations, handlers: createExampleComputeHandlers(exampleComputeArtifact), artifacts: writer, reader: { read: async (request, ctx) => blobs.readAuthorized({ scopeRef: p.scope.scopeRef, blobRef: request.approvedInputRefs[0]! }, ctx) }, validator: { validateInline: validate, validateRef: (ref, value) => { const fn = ajv.getSchema(ref); if (fn === undefined) throw new Error('actual schema unavailable'); return { valid: fn(value) === true, issues: (fn.errors ?? []).map((error) => ({ pointer: error.instancePath, reason: error.message ?? 'invalid' })) } } }, invocations: computeInvocations, resultArtifacts: computeResults, outputBindings: computeBindings })
      const executed = await compute.execute({ taskBindingRef: computeTask.taskBindingRef, operationRef: operation.operationRef, registeredOperationDigest: registeredOperationDigest(operation), inputSnapshotRef: derivedRef, inputSnapshotDigest: derivedRef.digest, parameters: {}, parametersRef, parametersDigest: parametersRef.digest, inputRefs: [derivedRef], requiredInputRefs: [derivedRef], signal: controller.signal, deadline: p.ctx.deadline }, p.ctx)
      expect(executed.invocation.state).toBe('completed')
      const output = await readJson(executed.artifact.outputArtifactRef, 1_048_576)
      if (typeof output !== 'object' || output === null || !('metrics' in output) || executed.invocation.resultRef === undefined) throw new Error('actual registered computation output missing')
      const computePayload = { computation: { resultRef: executed.artifact.outputArtifactRef, operationRef: operation.operationRef, algorithmVersion: executed.artifact.algorithmVersion, metrics: output.metrics } }
      const computeRunId = randomUUID()
      const computeBinding: RunExecutionBinding = { schemaVersion: 'run-execution-binding@1', runId: computeRunId, request: { mode: 'task', projectRevisionRef: revision.ref, taskBindingRef: computeTask.taskBindingRef, parameters: {}, inputSnapshotRef: derivedRef, inputSnapshotDigest: derivedRef.digest }, allowedTaskBindingRefs: [computeTask.taskBindingRef], resolvedProfileRef: revision.profileRef, runtimeRef: await write({ schemaVersion: 'source-leaf-test-runtime@1' }), inputManifestDigestAtCreation: derivedRef.digest, effectiveLimitsRef: computeTask.resultSchemaRef, effectiveTime: { validAt: new Date().toISOString(), asOfRecordedSeq: official.factRecordedPoint.semantic } }
      const computeBindingRef = await write(computeBinding)
      await new PostgresRunExecutionBindingStore(db).archiveBinding(p.scope.scopeRef, computeRunId, computeBindingRef, computeBinding, p.ctx)
      const computeArchived = await options.executionBindings.getBindingByRun(p.scope.scopeRef, computeRunId, p.ctx)
      if (computeArchived === undefined) throw new Error('actual fixed compute binding unavailable')
      const readCompute = (overrides: Partial<Parameters<typeof readSavedInputSources>[0]> = {}) => readSavedInputSources({ ports: { datasets: backend, publications, computeInvocations, computeResults, computeBindings, tasks: taskStore, taskInputs: snapshots }, candidates, mappings, parses, confirmations: instances, scope: p.scope.scopeRef, ctx: p.ctx, archived: computeArchived, revision, payload: computePayload, native: createRequestNativeSourceReader({ scope: p.scope.scopeRef, ctx: p.ctx, signal: controller.signal, ingestion, readBytes, check }), readJson, readBytes, check, ...overrides })
      expect(await readCompute()).toMatchObject({ sourceCoverage: { mode: 'compute_input_sample', requested: 2, verified: 2, displayed: 2, knownTotal: 2, truncated: false }, inputArtifacts: [{ ref: derivedRef }], fragments: expect.arrayContaining([expect.objectContaining({ originalRef: p.originalRef, cells: expect.arrayContaining([expect.objectContaining({ raw: '2.5' })]) })]) })
      const foreign = await createJobScope(harness.adminClient, 'fixed-input-foreign')
      await expect(readCompute({ scope: foreign.scopeRef, ctx: freshContext(foreign.tenantId, foreign.spaceId, ['platform-admin']) })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      const firstMetric = executed.bindings.fields.find((field) => field.unit !== undefined)
      if (firstMetric === undefined || !isRecord(output.metrics) || !isRecord(output.metrics[firstMetric.rowKey])) throw new Error('actual quantity binding unavailable')
      const metric = output.metrics[firstMetric.rowKey]
      if (!isRecord(metric) || typeof metric['amount'] !== 'string') throw new Error('actual quantity metric unavailable')
      const metricPointer = `/computation${firstMetric.valuePointer}`
      // The source primitive must reject a wrong column even when row, saved output
      // amount and unit are genuine. The normal caller separately earns table bindings.
      await expect(readCompute({ cell: { selector: { tableId: 'source-leaf-selected-compute', rowKey: firstMetric.rowKey, columnRef: 'different-column' }, binding: { rowKey: firstMetric.rowKey, columnRef: 'different-column', evidenceRef: computeArchived.ref, resultDigest: executed.artifact.outputDigest, valuePointer: `${metricPointer}/amount`, unitPointer: `${metricPointer}/unit`, subjectPointer: '/computation/operationRef/id' }, column: { columnRef: 'different-column', semanticPredicate: 'different-column', valueType: 'quantity', schemaPointer: '/properties/metrics' }, subject: operation.operationRef.id, value: metric['amount'] } })).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      const metadata = await snapshots.getSnapshot(p.scope.scopeRef, derivedRef, p.ctx)
      if (metadata === undefined) throw new Error('actual producer derived-input metadata unavailable')
      const replaceMetadata = (body: unknown) => harness.adminClient.query('UPDATE agent_platform.task_input_snapshots SET body=$4::jsonb WHERE tenant_id=$1 AND space_id=$2 AND snapshot_id=$3', [p.scope.tenantId, p.scope.spaceId, derivedRef.id, JSON.stringify(body)])
      await replaceMetadata({ ...metadata.body, projectId: randomUUID() })
      await expect(readCompute()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      await replaceMetadata(metadata.body)
      const actualRead = blobs.readAuthorized.bind(blobs)
      let changedDuringOriginal = false
      vi.spyOn(blobs, 'readAuthorized').mockImplementation(async (...args) => {
        const bytes = await actualRead(...args)
        if (!changedDuringOriginal && args[0].blobRef.id === p.originalRef.id) { changedDuringOriginal = true; await replaceMetadata({ ...metadata.body, dependencies: metadata.body.dependencies.slice(0, -1) }) }
        return bytes
      })
      await expect(readCompute()).rejects.toMatchObject({ code: 'SOURCE_UNVERIFIABLE' })
      expect(changedDuringOriginal).toBe(true)
      vi.restoreAllMocks()
      await replaceMetadata(metadata.body)
      for (const candidate of p.stagedFacts) await p.workflow.publication.reviewCandidate({ candidateId: candidate.candidateId, expectedRevision: '1', decision: 'reject', reason: 'later review does not erase actual previously authorized computation input' }, p.ctx)
      await documents.reviseDocument(p.scope.scopeRef, p.projectId, { documentId: p.documentId, op: 'retract', reason: 'later original withdrawal', actor: p.ctx.principal.subjectId, recordedAt: new Date().toISOString() }, p.ctx)
      expect((await readCompute()).sourceCoverage).toMatchObject({ verified: 2, knownTotal: 2 })
      const objects = new FileSystemObjectStore(directory)
      const original = await blobs.readAuthorized({ scopeRef: p.scope.scopeRef, blobRef: p.originalRef }, p.ctx)
      const tampered = original.slice(); tampered[0] = 0
      await objects.publish(p.originalRef.digest, tampered)
      await expect(readCompute()).rejects.toThrow()
      await objects.publish(p.originalRef.digest, original)
      controller.abort(new Error('cancelled fixed original-source traversal'))
      await expect(readCompute()).rejects.toThrow('cancelled fixed original-source traversal')
    } finally { backend.close(); vi.restoreAllMocks() }
  }, 120_000)
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


describe('fully approved paged native input capture (actual human services and PostgreSQL)', () => {
  let prepared: Awaited<ReturnType<typeof humanFixture>> | undefined
  beforeAll(async () => {
    // Individual human actions are fixture preparation, not one task execution.
    // Keep the existing harness setup bound and each source request's 120s budget.
    const controller = new AbortController()
    const stop = setTimeout(() => controller.abort(new Error('the actual1001 fixture reached its unchanged setup bound')), 295_000)
    try { prepared = await humanFixture(await fieldFixture('csv', 1001, 'query', true, controller.signal), 4, controller.signal) }
    finally { clearTimeout(stop) }
  }, 300_000)
  afterAll(() => prepared?.backend.close())
  it('captures and reuses all 1001 approved rows in real bounded pages and replays a record after the first 1000 without a latest or ordinal fallback', async () => {
    if (prepared === undefined) throw new Error('actual approved fixture unavailable')
    const p = await captureFixture(prepared)
    const body = await p.readJson(p.inputRef, 8 * 1_048_576)
    if (!isRecord(body) || !isRecord(body['counts']) || !Array.isArray(body['recordPages']) || !isResourceRef(body['confirmationManifestRef'])) throw new Error('actual approved archive unavailable')
    expect(body['counts']).toMatchObject({ total: 1001, approved: 1001, confirmed: 1001, excluded: 0, pending: 0, failed: 0 })
    const manifest = await p.readJson(body['confirmationManifestRef'], 8 * 1_048_576)
    if (!isRecord(manifest) || !Array.isArray(manifest['physicalPages']) || !Array.isArray(manifest['confirmationPages'])) throw new Error('actual paged human capture unavailable')
    expect(manifest).toMatchObject({ normalArchiveVersion: 'paged@1', projectRevisionRef: p.revision.ref, recordPages: body['recordPages'] })
    expect(body['recordPages']).toHaveLength(11)
    expect(manifest['physicalPages']).toHaveLength(11)
    expect(manifest['confirmationPages']).toHaveLength(11)
    let maxPageBytes = 0
    for (const ref of [...manifest['physicalPages'], ...manifest['confirmationPages'], ...body['recordPages'].map((pin: unknown) => { if (!isRecord(pin)) throw new Error('actual page pin malformed'); return pin['ref'] })]) {
      if (!isResourceRef(ref)) throw new Error('actual page ref malformed')
      const metadata = await blobs.getAuthorizedMetadata({ scopeRef: p.scope.scopeRef, blobRef: ref }, p.ctx)
      expect(metadata.byteSize).toBeLessThanOrEqual(8 * 1_048_576)
      maxPageBytes = Math.max(maxPageBytes, metadata.byteSize)
    }
    expect(await p.captured.resolve(p.scope.scopeRef, p.revision, p.ctx)).toEqual(p.inputRef)
    let cursor: string | undefined, pageCount = 0, total = 0
    let tail = p.official.rows[0]
    do {
      const page = await p.backend.querySnapshot(p.scope.scopeRef, { snapshotRef: p.snapshotRef, objectId: 'meter', limit: 250, ...(cursor === undefined ? {} : { cursor }) }, p.ctx)
      total += page.rows.length; pageCount += 1; tail = page.rows.at(-1)
      cursor = page.coverage.cursor
    } while (cursor !== undefined)
    expect(total).toBe(1001)
    expect(pageCount).toBe(5)
    if (tail === undefined) throw new Error('actual after-page record unavailable')
    const wanted = tail.sources.find((source) => source.fieldId === 'power')
    if (wanted?.factSource === undefined) throw new Error('actual after-page original source unavailable')
    const task = p.declaredTasks.find((entry) => entry.kind === 'structured_query')
    if (task === undefined) throw new Error('actual query binding unavailable')
    const runId = randomUUID()
    const binding: RunExecutionBinding = { schemaVersion: 'run-execution-binding@1', runId, request: { mode: 'task', projectRevisionRef: p.revision.ref, inputSnapshotRef: p.inputRef, inputSnapshotDigest: p.inputRef.digest, taskBindingRef: task.taskBindingRef, parameters: {} }, allowedTaskBindingRefs: [task.taskBindingRef], projectDatasetSnapshotRef: p.snapshotRef, resolvedProfileRef: p.revision.profileRef, runtimeRef: await p.write({ schemaVersion: 'source-leaf-test-runtime@1' }), inputManifestDigestAtCreation: p.inputRef.digest, effectiveLimitsRef: task.resultSchemaRef, effectiveTime: { validAt: new Date().toISOString(), asOfRecordedSeq: p.official.factRecordedPoint.semantic } }
    const bindingRef = await p.write(binding)
    await new PostgresRunExecutionBindingStore(db).archiveBinding(p.scope.scopeRef, runId, bindingRef, binding, p.ctx)
    const archived = await options.executionBindings.getBindingByRun(p.scope.scopeRef, runId, p.ctx)
    if (archived === undefined) throw new Error('actual fixed after-page binding unavailable')
    const payload = { table: { columns: [{ name: 'power', semanticFieldRef: 'power', unit: 'kW' }, { name: 'record_id' }, { name: 'sources_json' }], rows: [[tail.values['power']!.value, tail.recordId, canonicalJson(tail.sources)]] } }
    const read = () => readSavedInputSources({ ports: { datasets: p.backend, publications: p.publications }, candidates, mappings, parses, confirmations: instances, scope: p.scope.scopeRef, ctx: p.ctx, archived, revision: p.revision, payload, native: createRequestNativeSourceReader({ scope: p.scope.scopeRef, ctx: p.ctx, signal: p.controller.signal, ingestion, readBytes: p.readBytes, check: p.check }), readJson: p.readJson, readBytes: p.readBytes, check: p.check })
    expect(await read()).toMatchObject({ sourceCoverage: { requested: 1, verified: 1, displayed: 1, knownTotal: 1, truncated: false, coverage: 'complete' }, fragments: [{ originalRef: p.originalRef, cells: [{ raw: '12000.000000000001', locator: wanted.locator }] }] })
    const targetId = wanted.factSource.entityCandidateId
    await p.workflow.publication.reviewCandidate({ candidateId: targetId, expectedRevision: '1', decision: 'approve', reason: 'human reaffirmed exactly the same content with a new audit reason' }, p.ctx)
    expect(await p.captured.resolve(p.scope.scopeRef, p.revision, p.ctx)).toEqual(p.inputRef)
    await p.workflow.publication.reviewCandidate({ candidateId: targetId, expectedRevision: '2', decision: 'reject', reason: 'later rejection retains the already captured old approval act' }, p.ctx)
    await documents.reviseDocument(p.scope.scopeRef, p.projectId, { documentId: p.documentId, op: 'retract', reason: 'later withdrawal retains authorized archived originals', actor: p.ctx.principal.subjectId, recordedAt: new Date().toISOString() }, p.ctx)
    expect((await read()).sourceCoverage).toMatchObject({ verified: 1, displayed: 1 })
    const lastPage = body['recordPages'].at(-1)
    if (!isRecord(lastPage) || !isResourceRef(lastPage['ref'])) throw new Error('actual last approved page unavailable')
    const bytes = await p.readBytes(lastPage['ref'], 8 * 1_048_576), corrupted = bytes.slice()
    corrupted[0] = 0
    const objects = new FileSystemObjectStore(directory)
    await objects.publish(lastPage['ref'].digest, corrupted)
    await expect(read()).rejects.toThrow()
    await objects.publish(lastPage['ref'].digest, bytes)
    console.info('actual approved input pages', JSON.stringify({ approved: 1001, recordPages: 11, physicalPages: 11, humanPages: 11, maxPageBytes }))
  }, 120_000)
})
