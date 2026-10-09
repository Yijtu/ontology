import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, PostgresInstanceReviewStore, PostgresJobStore, PostgresProjectDocumentStore, PostgresProjectMappingStore, PostgresProjectReadinessStore, PostgresProjectRecordStore, PostgresProjectStore } from '@ontology/adapter-control-postgres'
import { PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { DuckDbProjectDatasetAdapter } from '@ontology/adapter-data-duckdb'
import { PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import { createCoreCompetencyExecution, createCompetencyProjectPreparer, createRequestToolContext } from '@ontology/app-api'
import type { CompetencyRunReport, ScopeRef, ToolContext } from '@ontology/contracts'
import { createToolContext } from '@ontology/contracts'
import { assertProjectFactInputShape, isRecord, isResourceRef } from '@ontology/contracts'
import type { ProjectRevisionRef, ResourceRef } from '@ontology/contracts'
import { InstanceReviewService, ProjectService, competencyExecutionRequest } from '@ontology/application'
import { publishedRuleConsequenceKey, publishedRuleDependencyRef, publishedRuleRef, publishedStatementProjectId, sameUtcInstant } from '@ontology/semantic-engine'
import { competencyRunnerHarness } from './competency-runner-harness'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'

let pg: JobDbHarness, db: ControlPostgresDatabase, registry: PostgresArtifactRegistry, blobs: LocalImmutableBlobStore, parses: PostgresDocumentParseStore, structured: PostgresStructuredIngestionStore
let scope: ScopeRef, directory = '', fixtures: Awaited<ReturnType<typeof competencyRunnerHarness>>
let businessDatabase = '', businessRole = '', readRole = '', readConnection = ''
let duck: DuckDbProjectDatasetAdapter, sql: PostgresProjectDatasetAdapter
function context(): ToolContext {
  const base = createRequestToolContext({ principal: { tenantId: scope.tenantId, subjectId: 'actual-cq-reviewer', roles: ['platform-admin', 'profile-editor', 'operator', 'data-editor', 'semantic-reviewer', 'semantic-publisher'], scopes: [], authEpoch: 1 }, spaceId: scope.spaceId, traceId: randomUUID(), runId: randomUUID() })
  // This is the validation host's explicit execution deadline. HTTP source/row grants stay0.
  return createToolContext({ ...base, deadline: new Date(Date.now() + 300_000).toISOString() })
}
async function savedBody(ref: ResourceRef, ctx: ToolContext): Promise<Record<string, unknown>> {
  const bytes = await blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx)
  expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(ref.digest)
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!isRecord(body)) throw new Error('the actual saved artifact body is invalid')
  return body
}

async function assertWithdrawalArchives(results: readonly { readonly questionId: string; readonly artifactRefs: readonly ResourceRef[] }[], ctx: ToolContext): Promise<void> {
  for (const id of ['industrial-one-withdrawal', 'industrial-last-withdrawal', 'industrial-historical']) {
    const result = results.find((row) => row.questionId === id), inputRef = result?.artifactRefs[0]
    const question = fixtures.sets.flatMap((row) => row.body.questions).find((row) => row.questionId === id)
    if (inputRef === undefined || question === undefined) throw new Error('real withdrawal execution archive missing')
    const input = await savedBody(inputRef, ctx)
    const withdrawals = Array.isArray(input['withdrawals']) ? input['withdrawals'] : []
    const rowFor = async (attributeId: string) => {
      const declared = question.input.observations.find((row) => row.status === 'active' && row.entityId === 'A-01' && row.attributeId === attributeId)
      const binding = withdrawals.find((row: unknown) => isRecord(row) && row['logicalFactId'] === declared?.factId)
      if (declared === undefined || !isRecord(binding) || typeof binding['actualStatementId'] !== 'string') throw new Error('the exact logical support has no real row binding')
      const statement = await fixtures.publications.getStatement(scope, binding['actualStatementId'], ctx)
      if (statement === undefined) throw new Error('real published support row missing')
      expect(statement.objectId).toBe('asset')
      expect(statement.value['attributes']).toEqual(expect.arrayContaining([expect.objectContaining({ attributeId: 'asset_code', value: 'A-01' }), expect.objectContaining({ attributeId })]))
      const provenance = statement.value['provenance']
      assertProjectFactInputShape(provenance)
      expect(provenance.sources).toHaveLength(1)
      const pin = provenance.sources[0]
      if (pin === undefined) throw new Error('actual statement has no authoritative project source pin')
      const mapping = await new PostgresProjectMappingStore(db).getMapping(scope, pin.projectRevisionRef.projectId, pin.mappingRef.id, pin.mappingRef.version, ctx)
      const record = await new PostgresProjectRecordStore(db).getRecord(scope, pin.projectRevisionRef.projectId, pin.recordId, ctx)
      if (mapping === undefined || record === undefined) throw new Error('actual published source mapping/record unavailable')
      expect(mapping.ref).toEqual(pin.mappingRef)
      expect(mapping.originalRef.id).toBe(declared.source.sourceRef.id)
      expect(mapping.originalRef.version).toBe(declared.source.sourceRef.version)
      expect(mapping.originalRef.digest).toBe(declared.source.sourceRef.digest)
      expect(record.revision).toBe(pin.recordRevision)
      expect(record.contentDigest).toBe(pin.contentDigest)
      expect(record.sourceDigest).toBe(pin.sourceDigest)
      expect(statement.sourceRefs.some((ref) => ref.id === pin.recordId && ref.digest === pin.sourceDigest)).toBe(true)
      return { statement, declared }
    }
    const hours = await rowFor('hours'), alarm = await rowFor('alarm')
    expect(hours.statement.statementId).not.toBe(alarm.statement.statementId)
    expect(hours.declared.source.sourceRef.id).not.toBe(alarm.declared.source.sourceRef.id)
    expect(hours.statement.subjectEntityId).toBe(alarm.statement.subjectEntityId)
    expect(hours.statement.status).toBe('retracted')
    expect(alarm.statement.status).toBe(id === 'industrial-one-withdrawal' ? 'active' : 'retracted')
    const points = Array.isArray(input['recordedPoints']) ? input['recordedPoints'] : []
    for (const logical of ['1', ...(id === 'industrial-one-withdrawal' ? ['2'] : ['2', '3'])]) {
      const point = points.find((row: unknown) => isRecord(row) && row['logical'] === logical)
      if (!isRecord(point) || !isResourceRef(point['captureRef'])) throw new Error('actual old event capture missing')
      const capture = await savedBody(point['captureRef'], ctx), data = capture['data']
      if (!isRecord(data) || !Array.isArray(data['facts'])) throw new Error('actual old official facts missing')
      expect(capture['recordedPoint']).toBe(point['actual'])
      const facts = data['facts']
      const fact = (statementId: string, attributeId: string) => facts.find((row: unknown) => isRecord(row) && row['sourceStatementId'] === statementId && row['attributeId'] === attributeId)
      expect(fact(hours.statement.statementId, 'hours')).toMatchObject({ subject: hours.statement.subjectEntityId, op: logical === '1' ? 'assert' : 'retract' })
      expect(fact(alarm.statement.statementId, 'alarm')).toMatchObject({ subject: alarm.statement.subjectEntityId, op: logical === '3' ? 'retract' : 'assert' })
    }
    if (id === 'industrial-historical') expect(input['selectedRecordedPoint']).toBe(points.find((row: unknown) => isRecord(row) && row['logical'] === '1')?.['actual'])
  }
}

beforeAll(async () => {
  pg = await startJobDatabase()
  scope = (await createJobScope(pg.adminClient, 'actual-competency-runner')).scopeRef
  db = new ControlPostgresDatabase({ connectionString: pg.appUrl, maxPoolSize: 6 })
  registry = new PostgresArtifactRegistry({ connectionString: pg.appUrl, maxPoolSize: 3 })
  parses = new PostgresDocumentParseStore({ connectionString: pg.appUrl, maxPoolSize: 2 })
  structured = new PostgresStructuredIngestionStore({ connectionString: pg.appUrl, maxPoolSize: 2 })
  directory = await mkdtemp(join(tmpdir(), 'actual-cq-runner-'))
  const objects = new FileSystemObjectStore(directory); await objects.init()
  blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
  fixtures = await competencyRunnerHarness({ db, blobs, registry, parses, structured, scope, ctx: context() })
  duck = new DuckDbProjectDatasetAdapter({ instancePath: join(directory, 'query.duckdb') })
  const suffix = randomUUID().replaceAll('-', ''), password = randomUUID().replaceAll('-', '')
  businessDatabase = `cq_business_${suffix}`; businessRole = `cq_query_${suffix}`
  readRole = `cq_read_${suffix}`
  await pg.adminClient.query(`CREATE ROLE ${businessRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`)
  const readPassword = randomUUID().replaceAll('-', '')
  await pg.adminClient.query(`CREATE ROLE ${readRole} LOGIN PASSWORD '${readPassword}' NOSUPERUSER NOBYPASSRLS`)
  await pg.adminClient.query(`ALTER ROLE ${readRole} SET default_transaction_read_only = on`)
  await pg.adminClient.query(`CREATE DATABASE ${businessDatabase} OWNER ${businessRole}`)
  const businessUrl = new URL(pg.adminUrl)
  businessUrl.username = businessRole; businessUrl.password = password; businessUrl.pathname = `/${businessDatabase}`
  const setup = new Client({ connectionString: businessUrl.toString() }); await setup.connect()
  try {
    await setup.query('CREATE SCHEMA competency_business')
    await setup.query(`GRANT USAGE ON SCHEMA competency_business TO ${readRole}`)
    await setup.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA competency_business GRANT SELECT ON TABLES TO ${readRole}`)
  } finally { await setup.end() }
  const readUrl = new URL(businessUrl)
  readUrl.username = readRole; readUrl.password = readPassword; readConnection = readUrl.toString()
  sql = new PostgresProjectDatasetAdapter({ connectionString: businessUrl.toString(), readOnlyConnectionString: readConnection, schema: 'competency_business' })
}, 120_000)

afterAll(async () => {
  await duck?.close(); await sql?.close(); await structured?.close(); await parses?.close(); await registry?.close(); await db?.close()
  if (businessDatabase !== '' && /^cq_business_[0-9a-f]{32}$/u.test(businessDatabase)) await pg.adminClient.query(`DROP DATABASE ${businessDatabase}`)
  if (businessRole !== '' && /^cq_query_[0-9a-f]{32}$/u.test(businessRole)) await pg.adminClient.query(`DROP ROLE ${businessRole}`)
  if (readRole !== '' && /^cq_read_[0-9a-f]{32}$/u.test(readRole)) await pg.adminClient.query(`DROP ROLE ${readRole}`)
  await pg?.stop()
  if (directory !== '') {
    const own = resolve(directory)
    if (!own.startsWith(resolve(tmpdir(), 'actual-cq-runner-'))) throw new Error('refusing cleanup outside own fixture directory')
    await rm(own, { recursive: true, force: true })
  }
})

describe('all canonical independent competency golds through real originals and stored services', () => {
  for (const backend of ['duckdb', 'postgres'] as const) it(`${backend}: replays exact hours and independent alarm ROW withdrawals with immutable old official points`, async () => {
    const ctx = context(), signal = new AbortController().signal, results: { questionId: string; artifactRefs: readonly ResourceRef[] }[] = []
    const set = fixtures.sets.find((row) => row.body.industryId === 'industrial-synthetic')
    if (set === undefined) throw new Error('actual approved industrial declaration missing')
    const query = backend === 'duckdb' ? duck : sql
    const execution = createCoreCompetencyExecution({ prepare: createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query, producerComponentRef: fixtures.producerComponentRef,
      binding: async (request) => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(query) }), sources: fixtures.questionWorkflow.sources, artifacts: fixtures.writer,
      reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
    for (const id of ['industrial-one-withdrawal', 'industrial-last-withdrawal', 'industrial-historical']) {
      const question = set.body.questions.find((row) => row.questionId === id)
      if (question === undefined) throw new Error('independent withdrawal question missing')
      const result = await execution.execute(competencyExecutionRequest(set.ref, question), ctx, signal)
      expect(result.status).toBe('executed')
      if (result.status !== 'executed') throw new Error(result.reason)
      expect(result.actual).toEqual(question.expected)
      expect(result.sources).toHaveLength(question.requiredSources.length)
      results.push({ questionId: id, artifactRefs: result.artifactRefs })
    }
    await assertWithdrawalArchives(results, ctx)
  }, 120_000)
  it('binds a healthy cross-project refusal and rejects a real head advance during its artifact write', async () => {
    const ctx = context(), set = fixtures.sets.find((row) => row.body.industryId === 'transport-synthetic')
    const question = set?.body.questions.find((row) => row.questionId === 'transport-project-denial')
    if (set === undefined || question === undefined) throw new Error('actual approved cross-project declaration missing')
    const request = competencyExecutionRequest(set.ref, question), signal = new AbortController().signal
    const execute = (store: LocalImmutableBlobStore) => createCoreCompetencyExecution({ prepare: createCompetencyProjectPreparer({ database: db, blobs: store, parses, structured, query: duck, producerComponentRef: fixtures.producerComponentRef,
      binding: async () => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(duck) }), sources: fixtures.questionWorkflow.sources, artifacts: fixtures.writer,
      reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
    const healthy = await execute(blobs).execute(request, ctx, signal)
    expect(healthy.status).toBe('executed')
    if (healthy.status === 'executed') { expect(healthy.actual).toEqual(question.expected); expect(healthy.sources).toHaveLength(question.requiredSources.length) }
    const projects = new PostgresProjectStore(db)
    const service = new ProjectService({ projects, readiness: new PostgresProjectReadinessStore(db), jobs: new PostgresJobStore(db), catalogue: { listEntries: async () => [], findPack: async () => undefined } })
    let digest: string | undefined, prior: ProjectRevisionRef | undefined, archived: ResourceRef | undefined, changed = false
    class ActualDelayedRefusalStore extends LocalImmutableBlobStore {
      override async stage(...args: Parameters<LocalImmutableBlobStore['stage']>): ReturnType<LocalImmutableBlobStore['stage']> {
        const result = await super.stage(...args)
        let body: unknown
        try { body = JSON.parse(new TextDecoder().decode(args[0])) } catch { return result }
        if (isRecord(body) && body['schemaVersion'] === 'competency-admission-refusal@1' && body['kind'] === 'cross_project') digest = result.contentDigest
        return result
      }
      override async publish(...args: Parameters<LocalImmutableBlobStore['publish']>): ReturnType<LocalImmutableBlobStore['publish']> {
        const result = await super.publish(...args)
        if (!changed && args[0].contentDigest === digest) {
          archived = result.blobRef
          const body = await savedBody(result.blobRef, args[1]), fixed = body['fixedProjectRevisionRef']
          if (!isRecord(fixed) || typeof fixed['projectId'] !== 'string') throw new Error('actual cross-project artifact lost its project pin')
          const head = await projects.getProject(scope, fixed['projectId'], args[1])
          const revision = head === undefined ? undefined : await projects.getRevision(scope, head.projectId, head.headRevision, args[1])
          if (head === undefined || revision === undefined) throw new Error('actual refusal project disappeared before the write fence')
          expect(fixed).toEqual(revision.ref); prior = revision.ref; changed = true
          await service.appendRevision(head.projectId, { expectedRevision: head.headRevision, reason: 'synthetic human appended a real project revision during refusal artifact I/O' }, `refusal-race-${randomUUID()}`, args[1].principal.subjectId, args[1])
        }
        return result
      }
    }
    const objects = new FileSystemObjectStore(directory); await objects.init()
    const delayed = new ActualDelayedRefusalStore({ objectStore: objects, registry })
    await expect(execute(delayed).execute(request, ctx, signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    expect(changed).toBe(true)
    if (prior === undefined || archived === undefined) throw new Error('actual delayed refusal proof was not recorded')
    expect((await savedBody(archived, ctx))['fixedProjectRevisionRef']).toEqual(prior)
    expect(BigInt((await projects.getProject(scope, prior.projectId, ctx))?.headRevision ?? '0')).toBeGreaterThan(BigInt(prior.revision))
  }, 60_000)
  it('refuses current-only navigation when the real edge is published after the selected event point', async () => {
    const ctx = context(), set = fixtures.sets.find((row) => row.body.industryId === 'transport-synthetic')
    const original = set?.body.questions.find((row) => row.questionId === 'transport-relation')
    if (set === undefined || original === undefined) throw new Error('actual relation source declaration missing')
    // Fault-inject the internal event binding; gold never enters preparation.
    const question = structuredClone(original)
    question.input.relations = question.input.relations.map((row) => ({ ...row, recordedSeq: '3' }))
    const request = competencyExecutionRequest(set.ref, question)
    const projects = new PostgresProjectStore(db), before = new Set((await projects.listProjects(scope, { limit: 200 }, ctx)).map((row) => row.projectId))
    const result = await createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query: duck, producerComponentRef: fixtures.producerComponentRef,
      binding: async () => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(duck) })(request, ctx, new AbortController().signal)
    expect(result).toEqual({ status: 'not_yet_executable', reason: 'the existing relation navigator cannot read an earlier actual recorded point' })
    const created = (await projects.listProjects(scope, { limit: 200 }, ctx)).filter((row) => !before.has(row.projectId))
    expect(created).toHaveLength(1)
    const project = created[0]
    if (project === undefined) throw new Error('actual later-edge sandbox missing')
    const statements = (await fixtures.publications.listStatements(scope, { status: 'active', limit: 1000 }, ctx)).filter((row) => publishedStatementProjectId(row) === project.projectId)
    const edges = statements.filter((row) => row.kind === 'relation')
    expect(edges).toHaveLength(1); expect(edges[0]?.relationId).toBe('located_in')
    const edge = edges[0], entity = statements.find((row) => row.kind === 'entity')
    if (edge === undefined || entity === undefined) throw new Error('actual edge/entity event bodies missing')
    const edgeEvent = await fixtures.publications.getPublication(scope, edge.publicationId, ctx), entityEvent = await fixtures.publications.getPublication(scope, entity.publicationId, ctx)
    if (edgeEvent === undefined || entityEvent === undefined) throw new Error('actual stored publication events missing')
    expect(BigInt(edgeEvent.revision)).toBeGreaterThan(BigInt(entityEvent.revision))
  }, 60_000)
  for (const industry of ['transport', 'industrial'] as const) {
    it(`${industry}: validates a genuinely reviewed current-compatible CQ body and publication gate`, async () => {
      const ctx = context(), signal = new AbortController().signal
      const target = await fixtures.targetFor(industry, ctx, signal)
      const prepare = createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query: duck, producerComponentRef: fixtures.producerComponentRef,
        binding: async (request) => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(duck), target: fixtures.targetReader })
      const execution = createCoreCompetencyExecution({ prepare, sources: fixtures.questionWorkflow.sources, artifacts: fixtures.writer,
        reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
      const report = await target.validation(execution).validate(target.target.workspaceId, { exampleSetId: target.examples.exampleSetId, competencyQuestionRef: target.compatible.ref, definitionRef: target.actual.definition.ref, expectedRevision: target.target.revision, idempotencyKey: `cq-current-${randomUUID()}`, signal }, ctx.principal.subjectId, ctx)
      expect(report.semanticPublished.blockers).toEqual([])
      expect(report.deploymentExecutable.blockers).toEqual([])
      expect(report.competency?.passed).toBe(true)
      expect(report.competency?.results).toHaveLength(industry === 'transport' ? 13 : 11)
      const published = await target.publication.publish(target.target.workspaceId, { packId: `cq-${industry}-${randomUUID()}`, version: '1.0.0', validationId: report.validationId, expectedRevision: target.target.revision, idempotencyKey: `cq-publish-${randomUUID()}`, requireDeploymentExecutable: true }, ctx.principal.subjectId, ctx)
      expect(published.validationRef.id).toBe(report.validationId)
    }, 300_000)
  }
  it('industrial: blocks the entire unchanged heterogeneous original against a current V1 target', async () => {
    const ctx = context(), signal = new AbortController().signal, target = await fixtures.targetFor('industrial', ctx, signal)
    const prepare = createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query: duck, producerComponentRef: fixtures.producerComponentRef,
      binding: async (request) => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(duck), target: fixtures.targetReader })
    const execution = createCoreCompetencyExecution({ prepare, sources: fixtures.questionWorkflow.sources, artifacts: fixtures.writer,
      reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
    const blocked = await target.validation(execution).validate(target.target.workspaceId, { exampleSetId: target.examples.exampleSetId, competencyQuestionRef: target.original.ref, definitionRef: target.actual.definition.ref, expectedRevision: target.target.revision, idempotencyKey: `cq-heterogeneous-${randomUUID()}`, signal }, ctx.principal.subjectId, ctx)
    expect(blocked.competency?.results).toHaveLength(12)
    expect(blocked.competency?.results.filter((row) => row.status !== 'passed').map((row) => ({ questionId: row.questionId, status: row.status }))).toEqual([{ questionId: 'industrial-version-two', status: 'not_yet_executable' }])
    expect(blocked.deploymentExecutable.blockers.some((row) => row.code === 'CQ_NOT_EXECUTABLE')).toBe(true)
    await expect(target.publication.publish(target.target.workspaceId, { packId: `cq-blocked-${randomUUID()}`, version: '1.0.0', validationId: blocked.validationId, expectedRevision: target.target.revision, idempotencyKey: `cq-blocked-publish-${randomUUID()}`, requireDeploymentExecutable: true }, ctx.principal.subjectId, ctx)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
  }, 300_000)
  it('rejects correctly hashed forged entity and event bindings from a genuine prepared case', async () => {
    const ctx = context(), set = fixtures.sets[0], question = set?.body.questions[0]
    if (set === undefined || question === undefined) throw new Error('actual approved declaration missing')
    const request = competencyExecutionRequest(set.ref, question), signal = new AbortController().signal
    const prepared = await createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query: duck, producerComponentRef: fixtures.producerComponentRef,
      binding: async () => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(duck) })(request, ctx, signal)
    if (prepared.status !== 'prepared') throw new Error('genuine preparation unavailable')
    const raw = await blobs.readAuthorized({ scopeRef: scope, blobRef: prepared.input.executionInputRef }, ctx)
    for (const kind of ['entity', 'event', 'selected'] as const) {
      const body: unknown = JSON.parse(new TextDecoder().decode(raw))
      if (!isRecord(body)) throw new Error('actual input archive is invalid')
      if (kind === 'entity') body['entityBindings'] = [['forged-business-owner', randomUUID()]]
      else if (kind === 'event') body['recordedPoints'] = [{ logical: request.input.asOfRecordedSeq, actual: String(BigInt(prepared.input.recordedPoint) + 1n) }]
      else body['selectedRecordedPoint'] = String(BigInt(prepared.input.recordedPoint) + 1n)
      const forged = (await fixtures.writer.putBytes({ scopeRef: scope, mediaType: 'application/json', content: new TextEncoder().encode(JSON.stringify(body)) }, ctx)).blobRef
      expect(forged.digest).not.toBe(prepared.input.executionInputRef.digest)
      const execution = createCoreCompetencyExecution({ prepare: async () => ({ ...prepared, input: { ...prepared.input, executionInputRef: forged } }), sources: fixtures.questionWorkflow.sources, artifacts: fixtures.writer,
        reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
      await expect(execution.execute(request, ctx, signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    }
  }, 60_000)
  it('refuses a real source withdrawal after source I/O and before the completed result', async () => {
    const ctx = context(), set = fixtures.sets[0], question = set?.body.questions[0]
    if (set === undefined || question === undefined) throw new Error('actual approved declaration missing')
    const request = competencyExecutionRequest(set.ref, question), signal = new AbortController().signal
    const prepared = await createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query: duck, producerComponentRef: fixtures.producerComponentRef,
      binding: async () => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(duck) })(request, ctx, signal)
    if (prepared.status !== 'prepared') throw new Error('genuine preparation unavailable')
    const documents = new PostgresProjectDocumentStore(db), projectId = prepared.input.project.ref.projectId
    let withdrawn: string | undefined
    const execution = createCoreCompetencyExecution({ prepare: async () => prepared, sources: { readSource: async (scope, ref, context, signal) => {
      const bytes = await fixtures.questionWorkflow.sources.readSource(scope, ref, context, signal)
      if (withdrawn === undefined) {
        const page = await documents.listDocuments(scope, projectId, { state: 'active', limit: 200 }, context)
        const member = page.memberships.find((row) => row.documentRef.id === ref.id)
        if (member === undefined) throw new Error('the consumed source has no actual current project membership')
        await documents.reviseDocument(scope, projectId, { documentId: member.documentId, op: 'retract', reason: 'synthetic human withdrew this real original during source I/O', actor: context.principal.subjectId, recordedAt: new Date().toISOString() }, context)
        withdrawn = member.documentId
      }
      return bytes
    } }, artifacts: fixtures.writer, reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
    await expect(execution.execute(request, ctx, signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    expect(withdrawn).toBeDefined()
    if (withdrawn !== undefined) expect((await documents.getMembership(scope, projectId, withdrawn, ctx))?.state).toBe('retracted')
  }, 60_000)
  it('refuses a real late human field rejection while retaining the older published statement', async () => {
    const ctx = context(), set = fixtures.sets[0], question = set?.body.questions[0]
    if (set === undefined || question === undefined) throw new Error('actual approved declaration missing')
    const request = competencyExecutionRequest(set.ref, question), signal = new AbortController().signal
    const prepared = await createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query: duck, producerComponentRef: fixtures.producerComponentRef,
      binding: async () => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(duck) })(request, ctx, signal)
    if (prepared.status !== 'prepared') throw new Error('genuine preparation unavailable')
    const projectId = prepared.input.project.ref.projectId, instances = new PostgresInstanceReviewStore(db)
    const records = await instances.listRecords(scope, projectId, { limit: 200 }, ctx)
    const record = records.find((row) => row.fields.some((field) => field.fieldId === 'length'))
    if (record === undefined) throw new Error('actual confirmed published quantity instance missing')
    const statements = await fixtures.publications.listStatements(scope, { sourceCandidateId: record.recordId, limit: 2 }, ctx)
    expect(statements).toHaveLength(1); expect(statements[0]?.status).toBe('active')
    let changed = false
    const execution = createCoreCompetencyExecution({ prepare: async () => prepared, sources: { readSource: async (scope, ref, context, signal) => {
      const bytes = await fixtures.questionWorkflow.sources.readSource(scope, ref, context, signal)
      if (!changed) {
        const rejected = await new InstanceReviewService({ store: instances }).confirmFields(scope, projectId, record.recordId, { expectedRevision: record.recordRevision, decisions: [{ fieldId: 'length', decision: 'reject', reason: 'synthetic human withdrew this exact field confirmation during source I/O' }], idempotencyKey: `late-field-${randomUUID()}` }, context)
        expect(rejected.record.recordRevision).not.toBe(record.recordRevision)
        expect(rejected.record.fields.find((field) => field.fieldId === 'length')?.status).toBe('pending')
        changed = true
      }
      return bytes
    } }, artifacts: fixtures.writer, reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
    await expect(execution.execute(request, ctx, signal)).rejects.toMatchObject({ code: 'DIGEST_MISMATCH' })
    expect(changed).toBe(true)
    if (statements[0] !== undefined) expect(await fixtures.publications.getStatement(scope, statements[0].statementId, ctx)).toEqual(statements[0])
  }, 60_000)
  it('binds the actual saved rule artifact to its exact entity and recorded point', async () => {
    const ctx = context(), set = fixtures.sets.find((row) => row.body.industryId.includes('transport'))
    const question = set?.body.questions.find((row) => row.questionId === 'transport-inspection')
    if (set === undefined || question === undefined) throw new Error('actual approved inspection declaration missing')
    const request = competencyExecutionRequest(set.ref, question)
    const prepared = await createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query: duck, producerComponentRef: fixtures.producerComponentRef,
      binding: async () => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(duck) })(request, ctx, new AbortController().signal)
    if (prepared.status !== 'prepared' || prepared.input.rules === undefined || request.intent.kind !== 'rule') throw new Error(`actual rule preparation failed: ${JSON.stringify(prepared)}`)
    const input = prepared.input, rules = prepared.input.rules, intent = request.intent
    const members = await new PostgresProjectDocumentStore(db).listDocuments(scope, input.project.ref.projectId, { state: 'active', limit: 200 }, ctx)
    let policies = 0
    for (const member of members.memberships) {
      const parse = await parses.getParse(scope, member.parseId, ctx)
      if (parse === undefined) throw new Error('actual corpus membership has no stored native projection/parse')
      expect(member.parseRef).toEqual(parse.spanMapRef)
      expect(member.textDigest).toBe(parse.normalizedRef.digest)
      const text = await blobs.readAuthorized({ scopeRef: scope, blobRef: parse.normalizedRef }, ctx)
      expect(`sha256:${createHash('sha256').update(text).digest('hex')}`).toBe(member.textDigest)
      if (parse.originalMediaType === 'text/plain') { policies += 1; expect(member.textDigest).not.toBe(parse.spanMapRef.digest) }
    }
    expect(policies).toBeGreaterThan(0)
    const entity = input.entities.get(`${request.intent.objectId}\u0000${request.intent.subjectEntityId}`)
    const rule = rules.versions.find((row) => row.published.ruleId === intent.ruleId)?.published
    if (entity === undefined || rule === undefined) throw new Error('actual rule/identity pin missing')
    const key = publishedRuleConsequenceKey(publishedRuleDependencyRef(rule, scope, input.definition.ref), entity)
    const read = await rules.materializer.read({ scopeRef: scope, projectionRef: rules.projectionRef, validAt: request.input.validAt, asOfRecordedSeq: rules.recordedPoint, propositionKeys: [key] }, ctx)
    const expectedRef = publishedRuleRef(rule)
    const artifact = read.ruleArtifacts?.find((row) => row.ruleRef.id === expectedRef.id && row.ruleRef.version === expectedRef.version && row.ruleRef.digest === expectedRef.digest && row.subjectEntityId === entity && row.objectId === intent.objectId)
    process.stdout.write(`[actual-rule-pins] ${JSON.stringify({ status: read.status, wantedValidAt: request.input.validAt, wantedSeq: rules.recordedPoint, artifact: artifact === undefined ? null : { ruleRef: artifact.ruleRef, objectId: artifact.objectId, entity: artifact.subjectEntityId, validAt: artifact.validAt, seq: artifact.asOfRecordedSeq } })}\n`)
    expect(read.status).toBe('materialized'); expect(artifact).toBeDefined()
    expect(sameUtcInstant(artifact?.validAt ?? '', request.input.validAt)).toBe(true)
    expect(artifact?.asOfRecordedSeq).toBe(rules.recordedPoint)
    const execution = createCoreCompetencyExecution({ prepare: async () => prepared, sources: fixtures.questionWorkflow.sources, artifacts: fixtures.writer,
      reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
    const result = await execution.execute(request, ctx, new AbortController().signal)
    expect(result.status).toBe('executed')
    if (result.status === 'executed') expect(result.actual).toEqual(question.expected)
  }, 60_000)
  for (const backend of ['duckdb', 'postgres'] as const) {
    it(`${backend}: executes all25 unchanged authored golds across both industries`, async () => {
      const ctx = context(), query = backend === 'duckdb' ? duck : sql
      expect(ctx.allowedResources.maxRows).toBe(0)
      expect(ctx.allowedResources.sourceRefs).toEqual([])
      const prepare = createCompetencyProjectPreparer({ database: db, blobs, parses, structured, query, producerComponentRef: fixtures.producerComponentRef,
        binding: async (request) => fixtures.bindings.get(`${request.definitionRef.id}@${request.definitionRef.version}`), compute: fixtures.computeFor(query) })
      const actualExecution = createCoreCompetencyExecution({ prepare, sources: fixtures.questionWorkflow.sources, artifacts: fixtures.writer,
        reader: { read: async (request, context) => { const ref = request.approvedInputRefs[0]; if (ref === undefined) throw new Error('missing actual artifact'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } })
      const execution: typeof actualExecution = { execute: async (request, context, signal) => {
        const result = await actualExecution.execute(request, context, signal)
        process.stdout.write(`[cq-${backend}] ${request.questionId}: ${result.status}${result.status === 'not_yet_executable' ? ` (${result.reason})` : ''}\n`)
        return result
      } }
      const reports: CompetencyRunReport[] = []
      for (const set of fixtures.sets) reports.push(await fixtures.runner(execution).run(set.ref, ctx, new AbortController().signal))
      const results = reports.flatMap((report) => report.results)
      expect(results).toHaveLength(25)
      expect(results.filter((result) => result.status !== 'passed').map((result) => ({ id: result.questionId, status: result.status, reason: result.reason, actual: result.actual }))).toEqual([])
      expect(reports.every((report) => report.passed)).toBe(true)
      expect(results.every((result) => result.sourceCoverage.complete && result.artifactRefs.length > 0)).toBe(true)
      await assertWithdrawalArchives(results, ctx)
      if (backend === 'postgres') {
        const reader = new Client({ connectionString: readConnection }); await reader.connect()
        try {
          const role = await reader.query<{ current_user: string; read_only: string }>("SELECT current_user, current_setting('transaction_read_only') AS read_only")
          expect(role.rows[0]).toEqual({ current_user: readRole, read_only: 'on' })
          await expect(reader.query('CREATE TABLE competency_business.forbidden_write (id int)')).rejects.toMatchObject({ code: '25006' })
        } finally { await reader.end() }
      }
    }, 300_000)
  }
})
