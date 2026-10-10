import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import { ControlPostgresDatabase, ControlPostgresRepository, PostgresAnswerStore, PostgresBudgetLedgerStore, PostgresEvidenceStore, PostgresProfileStore, PostgresRunStore, PostgresTableArtifactStore, PostgresTableVerificationStore, PostgresWorkflowStore } from '@ontology/adapter-control-postgres'
import { StructuredDocumentParser, deterministicUuid, sha256DigestOfBytes } from '@ontology/adapter-extraction-document'
import { CORE_TYPED_RESULT_SCHEMA_REF, coreScenarioTaskBindings, createBlobArtifactWriter, createCoreLocalComposition, createCoreTableResults, createToolGatewayComposition, loadCoreExamples } from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { AnswerPublicationService, DraftVerificationService, PublicationValidityEngine, RunPhaseDriver, TableArtifactReadService, TableHardVerificationService, answerDraftContentHash, buildTypedResultManifest, canonicalJson, defaultPublicationEvidenceValidators, inputManifestDigest, scenarioManifestHash, summarizeTypedResultEvidence, typedResultManifestContentDigest } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import { DEFAULT_VERIFICATION_POLICY, createToolContext, isRecord, sha256OfCanonical, tableArtifactContentDigest, tableManifestContentDigest, tablePageCoverageDigest } from '@ontology/contracts'
import type { AnswerDraft, DraftClaim, ImmutableArtifactWriter, ResourceRef, ScopeRef, TableArtifactPageBody, ToolContext, WorkflowInputEntry } from '@ontology/contracts'
import { DataQueryHandler } from '@ontology/tool-services'
import type { ToolHandler } from '@ontology/tool-services'
import { InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import { canonicalToolValidator, operationRegistry } from '../unit/tool-gateway-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'

/** Real read-only query/gateway, immutable bytes, RLS table pages and earned receipts.
 * The normal host/controller mount is separately exercised by the composition owner. */
let harness: JobDbHarness, db: ControlPostgresDatabase, registry: PostgresArtifactRegistry, blobs: LocalImmutableBlobStore, business: BusinessPostgresDatabase, composition: CoreLocalComposition | undefined
let objectDirectory = '', scope: ScopeRef, ctx: ToolContext
let objects: FileSystemObjectStore

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = (await createJobScope(harness.adminClient, 'table-producer')).scopeRef
  db = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 2 })
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-real-table-producer-'))
  objects = new FileSystemObjectStore(objectDirectory); await objects.init()
  blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
  const runId = randomUUID(), now = new Date().toISOString(), deadline = new Date(Date.now() + 120_000).toISOString()
  ctx = createToolContext({ principal: { tenantId: scope.tenantId, subjectId: 'table-producer-human', roles: ['operator', 'platform-admin'], scopes: ['tool:invoke'], authEpoch: 1 }, runId, resolvedProfileHash: sha256OfCanonical('bootstrap-context'), policyVersion: '1.0.0', deadline, budgetReservation: { reservationId: randomUUID(), runId, grantedAt: now, expiresAt: deadline }, allowedResources: { ...scope, resourceKinds: ['artifact', 'document', 'dataset', 'evidence'], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 1000 }, traceId: randomUUID() })
  composition = await createCoreLocalComposition({ databaseUrl: harness.appUrl, objectDirectory, scopeRef: scope, examples: loadCoreExamples({ targetScopeRef: scope }), allowLocalOperator: true })
}, 180_000)

afterAll(async () => {
  await business?.close()
  await composition?.close()
  await registry?.close()
  await db?.close()
  await harness?.stop()
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true })
})

describe('Core query table producer with real PostgreSQL and original input bytes', () => {
  it('archives a genuine query as fixed pages and earns the exact full-draft receipt', async () => {
    // These are independent source inputs; no table output/expectation is used to make them.
    const csv = `record_id,amount,enabled\n${Array.from({ length: 251 }, (_, index) => `source-row-${String(index).padStart(4, '0')},9.000000000000000001,${index % 2 === 0 ? 'true' : 'false'}`).join('\n')}\n`
    const originalBytes = new TextEncoder().encode(csv), staged = await blobs.stage(originalBytes, { scopeRef: scope }, ctx)
    const original = (await blobs.publish({ scopeRef: scope, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: 'text/csv', purpose: 'document' }, ctx)).blobRef
    const parsed = new StructuredDocumentParser().parse(originalBytes, { mediaType: 'text/csv', headerRow: 1 }).tables[0]
    if (parsed === undefined) throw new Error('the original CSV did not parse')
    expect(parsed.rows).toHaveLength(251)
    expect(parsed.columns.map((column) => column.header)).toEqual(['record_id', 'amount', 'enabled'])
    await harness.adminClient.query('CREATE SCHEMA table_producer_source')
    await harness.adminClient.query('CREATE TABLE table_producer_source.readings(record_id text PRIMARY KEY, amount numeric(38,18) NOT NULL, enabled boolean NOT NULL, sources_json text NOT NULL)')
    for (const row of parsed.rows) {
      const id = row.cells[0]?.raw, amount = row.cells[1]?.raw, enabled = row.cells[2]?.raw
      if (typeof id !== 'string' || typeof amount !== 'string' || (enabled !== 'true' && enabled !== 'false')) throw new Error('an original input cell is unsupported')
      await harness.adminClient.query('INSERT INTO table_producer_source.readings VALUES($1,$2::numeric,$3::boolean,$4)', [id, amount, enabled, JSON.stringify([{ originalRef: original, locator: row.locator }])])
    }
    const password = `read_${randomUUID().replaceAll('-', '')}`
    const quoted = await harness.adminClient.query<{ statement: string }>("SELECT format('CREATE ROLE table_result_reader LOGIN PASSWORD %L', $1::text) AS statement", [password])
    await harness.adminClient.query(quoted.rows[0]!.statement)
    await harness.adminClient.query('GRANT USAGE ON SCHEMA table_producer_source TO table_result_reader')
    await harness.adminClient.query('GRANT SELECT ON table_producer_source.readings TO table_result_reader')
    const url = new URL(harness.adminUrl); url.username = 'table_result_reader'; url.password = password
    const readOnly = new Client({ connectionString: url.toString() }); await readOnly.connect()
    await expect(readOnly.query('CREATE TABLE table_producer_source.forbidden(id integer)')).rejects.toMatchObject({ code: '42501' }); await readOnly.end()
    business = new BusinessPostgresDatabase({ connectionString: url.toString(), maxPoolSize: 2 })
    const sourceRef = { namespace: 'table-original', sourceId: original.id }, objectRef = { sourceRef, objectPath: 'table_producer_source.readings' }
    const query = new PostgresQueryAdapter({ database: business, sourceRef, mappings: [{ objectRef, schema: 'table_producer_source', relation: 'readings', relationKind: 'table', columns: [{ name: 'record_id', type: 'string' }, { name: 'amount', type: 'decimal', semanticFieldRef: 'meter.energy', unit: 'kWh' }, { name: 'enabled', type: 'boolean', semanticFieldRef: 'meter.enabled' }, { name: 'sources_json', type: 'string' }] }] })
    const scenario = loadCoreExamples({ targetScopeRef: scope }).scenarios[0]
    if (scenario === undefined) throw new Error('the real host registered no scenario')
    const profiles = await new PostgresProfileStore(db).listResolvedProfiles(scenario.profileRef, scope, ctx), actualProfile = profiles[0]?.resolved
    if (actualProfile === undefined) throw new Error('the normal host did not resolve its actual registered profile')
    // Bootstrap genuinely registered/resolved the profile. Shut down its background controller
    // before this bounded service-protocol fixture takes ownership of its separate run.
    await composition?.close(); composition = undefined
    const queryCtx = createToolContext({ ...ctx, resolvedProfileHash: actualProfile.snapshotHash, allowedResources: { ...ctx.allowedResources, sourceRefs: [sourceRef] } })
    const runs = new PostgresRunStore(db), control = new ControlPostgresRepository(db), phases = new RunPhaseDriver({ store: runs, control }), workflow = new PostgresWorkflowStore(db)
    let run = (await runs.insertRun(scope, { runId: ctx.runId, ownerSubjectId: queryCtx.principal.subjectId, profileRef: scenario.profileRef, resolvedProfileHash: actualProfile.snapshotHash, runtimeRef: actualProfile.runtimeRef, question: '读取已授权原始计量表', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false }, idempotencyKey: `table-query-${ctx.runId}`, requestDigest: sha256OfCanonical({ originalRef: original, objectRef }), createdAt: new Date().toISOString() }, queryCtx)).run
    for (const state of ['preflight', 'collecting'] as const) run = await phases.transition(run.runId, run.revision, state, {}, queryCtx)
    const budget = new BudgetService({ store: new PostgresBudgetLedgerStore(db), control: new ControlPostgresRepository(db) }), ledgerId = randomUUID()
    await budget.openLedger({ ledgerId, kind: 'run', runId: ctx.runId }, queryCtx)
    const actualQuery = new DataQueryHandler({ query, mappings: new InMemorySemanticMappingRegistry([]), dataMode: 'synthetic' })
    // The direct adapter's result has driver names/types. Read its real catalogue metadata
    // for this exact selected object, as the normal project handler reads its fixed descriptor.
    // No source value or independent expectation is used to create these field/unit pins.
    const locatedQuery: ToolHandler = { toolId: 'data_query', execute: async (request) => {
      const outcome = await actualQuery.execute(request), catalogue = await query.describe({ scopeRef: scope, resourceRefs: [objectRef] }, request.ctx)
      const declared = catalogue.resources[0], payload = outcome.payload
      if (catalogue.resources.length !== 1 || declared === undefined || canonicalJson(declared.objectRef) !== canonicalJson(objectRef) || !isRecord(payload) || !isRecord(payload['table']) || !Array.isArray(payload['table']['columns'])) throw new Error('the actual query catalogue is ambiguous or unavailable')
      const columns = payload['table']['columns'].map((column: unknown) => {
        if (!isRecord(column)) throw new Error('the actual query returned an invalid column')
        const pinned = declared.columns.find((value) => value.name === column['name'] && value.type === column['type'])
        if (pinned === undefined) throw new Error('the actual query column no longer matches the catalogue')
        return pinned
      })
      return { ...outcome, payload: { ...payload, table: { ...payload['table'], columns }, coverage: outcome.coverage } }
    } }
    const gateway = createToolGatewayComposition({ database: db, blobStore: blobs, budget, validator: canonicalToolValidator(), handlers: [locatedQuery] }).forRun({ runId: ctx.runId, ledgerId, resolvedProfile: actualProfile, operations: operationRegistry() })
    const result = await gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'query', mode: 'direct', queryPlan: { mode: 'direct', statementKind: 'select', sql: 'SELECT record_id, amount, enabled, sources_json FROM table_producer_source.readings ORDER BY record_id DESC', parameters: [], referencedObjects: [objectRef], readOnly: true }, limit: 1000 } }, queryCtx)
    expect(result.error).toBeUndefined(); expect(result.coverage).toMatchObject({ returned: 251, truncated: false })
    const outputRef = result.dataRef, evidenceRef = result.evidenceRefs[0]
    if (outputRef === undefined || evidenceRef === undefined) throw new Error('the real gateway did not archive its actual output')
    const writer = createBlobArtifactWriter(blobs), pages = new PostgresTableArtifactStore(db, { writer, reader: { read: async (input, context) => { const ref = input.approvedInputRefs[0]; if (ref === undefined) throw new Error('no approved page input'); return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context) } } }), receipts = new PostgresTableVerificationStore(db), evidence = new PostgresEvidenceStore(db)
    const stableId = (digest: string) => deterministicUuid(`${scope.tenantId}|${scope.spaceId}|table-artifact:${digest}`)
    const findArtifact = async (_scope: ScopeRef, digest: string): Promise<ResourceRef | undefined> => {
      const found = await registry.findReference(scope, stableId(digest))
      if (found === undefined) return undefined
      if (found.reference.contentDigest !== digest || found.reference.purpose !== 'artifact') throw new Error('the actual stable table reference changed')
      return { id: found.reference.blobRefId, version: '1.0.0', digest: found.reference.contentDigest, kind: 'artifact' }
    }
    const stableWriter: ImmutableArtifactWriter = { putBytes: async (input, context) => {
      const digest = sha256DigestOfBytes(input.content), existing = await findArtifact(input.scopeRef, digest)
      if (existing !== undefined) {
        const metadata = await blobs.getAuthorized({ scopeRef: input.scopeRef, blobRef: existing }, context), actual = await blobs.readAuthorized({ scopeRef: input.scopeRef, blobRef: existing }, context)
        if (!metadata.integrityVerified || metadata.mediaType !== input.mediaType || actual.length !== input.content.length || actual.some((value, index) => value !== input.content[index])) throw new Error('the actual stable table bytes changed')
        return { blobRef: existing, contentDigest: digest, integrity: { algorithm: 'sha256', digest, verifiedAt: new Date().toISOString() } }
      }
      const saved = await blobs.stage(input.content, { scopeRef: input.scopeRef }, context)
      return new LocalImmutableBlobStore({ objectStore: objects, registry, idFactory: () => stableId(digest) }).publish({ scopeRef: input.scopeRef, contentDigest: saved.contentDigest, byteSize: saved.byteSize, mediaType: input.mediaType, purpose: 'artifact' }, context)
    } }
    const archive = async (body: unknown) => (await writer.putBytes({ scopeRef: scope, content: new TextEncoder().encode(canonicalJson(body)), mediaType: 'application/json' }, queryCtx)).blobRef
    const schemaBody: unknown = JSON.parse(await readFile(new URL('../../packages/contracts/schema/tools.schema.json', import.meta.url), 'utf8'))
    if (!isRecord(schemaBody)) throw new Error('the actual canonical tools schema is unavailable')
    const schemaDigest = sha256OfCanonical(schemaBody)
    const schemaArtifactId = deterministicUuid(`${scope.tenantId}|${scope.spaceId}|core-data-query-output-schema:${schemaDigest}`)
    const registeredSchema = await registry.findReference(scope, schemaArtifactId)
    if (registeredSchema === undefined || registeredSchema.reference.purpose !== 'artifact' || registeredSchema.reference.contentDigest !== schemaDigest || registeredSchema.blob.mediaType !== 'application/schema+json') throw new Error('the actual canonical tools schema was not registered with its schema media type')
    const schemaRef: ResourceRef = { id: registeredSchema.reference.blobRefId, version: '1.0.0', digest: schemaDigest, kind: 'artifact' }
    const registeredSchemaBytes = await blobs.readAuthorized({ scopeRef: scope, blobRef: schemaRef }, queryCtx)
    if (canonicalJson(JSON.parse(new TextDecoder().decode(registeredSchemaBytes))) !== canonicalJson(schemaBody)) throw new Error('the registered table schema bytes differ from the canonical schema')
    const bridge = createCoreTableResults({ artifacts: blobs, writer: stableWriter, pages, manifests: pages, receipts, evidence, findArtifact, tableOutputSchema: { ref: schemaRef, body: schemaBody }, verifier: new TableHardVerificationService({ pages, receipts, progress: receipts, artifacts: blobs, evidence }) })
    const task = coreScenarioTaskBindings(scenario).find((binding) => binding.kind === 'structured_query')
    if (task === undefined) throw new Error('the real registered structured-query task is missing')
    const executionBindingRef = await archive({ schemaVersion: 'table-query-test-input@1', runId: ctx.runId, originalRef: original, sourceRef, dataMode: 'synthetic' }), taskBindingRef = task.taskBindingRef, outputSchemaRef = CORE_TYPED_RESULT_SCHEMA_REF
    const tables = await bridge.build({ runId: ctx.runId, executionBindingRef, taskBindingRef, inputSnapshotRef: original, outputSchemaRef, resultKind: 'structured_query', evidence: [{ ref: evidenceRef, outputRef, resultDigest: outputRef.digest }] }, queryCtx)
    expect(tables[0]?.pages.map((page) => page.rowCount)).toEqual([250, 1])
    const queryEvidence = await evidence.get(scope, evidenceRef.id, queryCtx), savedPayload: unknown = JSON.parse(new TextDecoder().decode(await blobs.readAuthorized({ scopeRef: scope, blobRef: outputRef }, queryCtx)))
    if (queryEvidence === undefined || !isRecord(savedPayload)) throw new Error('the actual query archive is unavailable')
    expect(queryEvidence.envelope.dataMode).toBe('synthetic')
    const manifest = buildTypedResultManifest({ executionBindingRef, taskBindingRef, inputSnapshotRef: original, outputSchemaRef, resultKind: 'structured_query', tables, outputDigest: outputRef.digest, evidence: [summarizeTypedResultEvidence(scope, evidenceRef, queryEvidence, savedPayload, queryCtx)] }), resultManifestRef = await archive(manifest), parametersRef = await archive({})
    const finalizationReceiptRef = await archive({ schemaVersion: 'task-finalization-receipt@1', executionBindingRef, taskBindingRef, inputSnapshotRef: original, inputSnapshotDigest: original.digest, parametersRef, parametersDigest: parametersRef.digest, outputArtifactRefs: [outputRef], outputDigests: [outputRef.digest], typedResultManifestRef: resultManifestRef, typedResultManifestDigest: resultManifestRef.digest, requiredPolicyBindings: [], policyReportRefs: [] })
    run = await phases.transition(run.runId, run.revision, 'drafting', {}, queryCtx)
    const entries: WorkflowInputEntry[] = [{ entryId: randomUUID(), kind: 'evidence', label: '实际只读查询', ref: evidenceRef, addedInPhase: 'collecting', recordedAt: queryEvidence.recordedAt }]
    const inputManifest = await workflow.saveInputManifest({ manifestId: randomUUID(), runId: ctx.runId, revision: '1', entries, digest: inputManifestDigest(ctx.runId, entries) }, queryCtx)
    const runManifest = await workflow.saveRunManifest({ runId: ctx.runId, resolvedProfileRef: { ...scenario.profileRef, snapshotHash: actualProfile.snapshotHash }, runtimeRef: actualProfile.runtimeRef, budgetLedgerId: ledgerId, inputManifestId: inputManifest.manifestId, createdAt: run.createdAt }, queryCtx)
    const claim: DraftClaim = { claimId: randomUUID(), subject: 'source-row-0000', predicate: 'meter.energy', value: { value: '9.000000000000000001', unit: 'kWh' }, time: {}, kind: 'observation', references: [{ evidenceRef, resultDigest: outputRef.digest, valuePointer: '/table/rows/250/1', subjectPointer: '/table/rows/250/0', fieldRefPointer: '/table/columns/1', unitPointer: '/table/columns/1/unit' }] }
    const blocks = [{ kind: 'claim', claimId: claim.claimId }], bindings = { schemaVersion: 'answer-draft@3' as const, resultManifestRef, resultManifestDigest: typedResultManifestContentDigest(manifest), finalizationReceiptRef, finalizationReceiptDigest: finalizationReceiptRef.digest, executionBindingRef, limitations: [] }
    const draft: AnswerDraft = { ...bindings, draftId: randomUUID(), runId: ctx.runId, blocks, claims: [claim], assertions: [], evidenceManifestHash: inputManifest.digest, contentHash: answerDraftContentHash(ctx.runId, blocks, inputManifest.digest, [claim], [], bindings), producedInPhase: 'drafting', createdAt: new Date().toISOString() }
    const verified = await bridge.verify(draft, queryCtx)
    expect(verified[0]?.status).toBe('pass')
    expect(verified[0]?.report).toMatchObject({ checkedRows: 251, checkedCells: 502, expectedRows: 251, expectedCells: 502 })
    expect((await bridge.requirements(draft, queryCtx))[0]?.resultManifestDigest).not.toBe(draft.resultManifestDigest)
    run = await phases.transition(run.runId, run.revision, 'verifying', {}, queryCtx)
    const verification = await new DraftVerificationService({ evidence, artifacts: blobs, policy: { ...DEFAULT_VERIFICATION_POLICY, semanticReview: 'disabled' } }).verify({ runId: run.runId, draft, inputManifest }, queryCtx)
    expect(verification.failedChecks).toEqual([]); expect(verification.verdict).toBe('pass')
    await workflow.record({ runId: run.runId, verification }, queryCtx)
    const answers = new PostgresAnswerStore(db), publisher = new AnswerPublicationService({ runs, answers, manifests: workflow, verifications: workflow, tableVerifications: bridge.requirements, registerTables: bridge.register, validity: new PublicationValidityEngine({ evidence, artifacts: blobs, validators: defaultPublicationEvidenceValidators(), tables: receipts }) })
    // A service-protocol grant follows the actual verifier/phase state; the normal controller
    // issuer and immutable project execution admission are covered by the owner host proof.
    const grant = { grantId: randomUUID(), runId: run.runId, draftId: draft.draftId, draftHash: draft.contentHash, verificationId: verification.verificationId, evidenceManifestHash: inputManifest.digest, scenarioManifestHash: scenarioManifestHash(runManifest, inputManifest), expectedRunRevision: run.revision, issuedBy: 'workflow-controller' as const, issuedAt: new Date().toISOString() }
    const published = await publisher.publish({ grant, draft, verification }, queryCtx)
    expect((await answers.findByAnswer(published.answerId, queryCtx))?.contentHash).toBe(draft.contentHash)
    expect((await publisher.publish({ grant, draft, verification }, queryCtx)).answerId).toBe(published.answerId)
    const reader = new TableArtifactReadService({ pages, progress: pages, manifests: { resolve: async (requestedScope, answerId, tableId, context) => {
      const answer = await answers.findByAnswer(answerId, context), table = await pages.resolve(requestedScope, answerId, tableId, context)
      if (answer === undefined || answer.v3Body?.resultManifestDigest !== draft.resultManifestDigest || table?.verificationReceiptRef === undefined) return undefined
      const earned = await receipts.getReceipt(requestedScope, table.verificationReceiptRef, context)
      return earned?.receipt.draftHash === answer.contentHash ? table : undefined
    } } })
    const tableId = tables[0]?.tableId
    if (tableId === undefined) throw new Error('no actual table')
    const first = await reader.readPage({ answerId: published.answerId, tableId }, queryCtx)
    expect(first.rows).toHaveLength(250)
    if (first.cursor === undefined) throw new Error('no actual later-page cursor')
    const later = await reader.readPage({ answerId: published.answerId, tableId, cursor: first.cursor }, queryCtx)
    expect(later.rows).toHaveLength(1)
    expect(later.rows[0]).toMatchObject({ rowKey: 'source-row-0250', cells: { 'field.1': { value: '9.000000000000000001', unit: 'kWh' } } })
    const alternate = await gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'query', mode: 'direct', queryPlan: { mode: 'direct', statementKind: 'select', sql: 'SELECT record_id, amount, enabled, sources_json FROM table_producer_source.readings WHERE record_id = $1', parameters: ['source-row-0000'], referencedObjects: [objectRef], readOnly: true }, limit: 1 } }, queryCtx)
    expect(alternate.error).toBeUndefined()
    const alternateRef = alternate.evidenceRefs[0], alternateOutput = alternate.dataRef
    if (alternateRef === undefined || alternateOutput === undefined) throw new Error('the alternative actual query did not archive output')
    const table = tables[0], descriptor = table?.pages.at(-1)
    if (table === undefined || descriptor === undefined) throw new Error('the actual final page is missing')
    const savedPage = await pages.getPage(scope, descriptor.artifactRef, queryCtx)
    if (savedPage === undefined) throw new Error('the actual final page cannot be re-read')
    for (const mutation of ['value', 'unit', 'row', 'source'] as const) {
      const body: TableArtifactPageBody = { ...savedPage.body, rows: savedPage.body.rows.map((row) => mutation === 'value' ? { ...row, cells: { ...row.cells, 'field.1': { value: '10', unit: 'kWh' } } } : mutation === 'unit' ? { ...row, cells: { ...row.cells, 'field.1': { value: '9.000000000000000001', unit: 'MWh' } } } : { ...row, bindings: row.bindings.map((binding) => mutation === 'row' ? { ...binding, subjectPointer: '/table/rows/250/0' } : { ...binding, evidenceRef: alternateRef, resultDigest: alternateOutput.digest }) }) }
      const pageRef = (await stableWriter.putBytes({ scopeRef: scope, content: new TextEncoder().encode(canonicalJson(body)), mediaType: 'application/json' }, queryCtx)).blobRef
      expect(pageRef.digest).toBe(tableArtifactContentDigest(body))
      await pages.putPage(scope, pageRef, body, queryCtx)
      const changed = { ...table, pages: [...table.pages.slice(0, -1), { ...descriptor, artifactRef: pageRef, artifactDigest: pageRef.digest, pageCoverageDigest: tablePageCoverageDigest(body) }] }
      const changedRef = (await stableWriter.putBytes({ scopeRef: scope, content: new TextEncoder().encode(canonicalJson(changed)), mediaType: 'application/json' }, queryCtx)).blobRef
      expect(changedRef.digest).toBe(tableManifestContentDigest(changed))
      const changedManifest = { ...manifest, tables: [changed] }, changedOuterRef = await archive(changedManifest)
      const changedFinalization = await archive({ schemaVersion: 'task-finalization-receipt@1', executionBindingRef, taskBindingRef, inputSnapshotRef: original, inputSnapshotDigest: original.digest, parametersRef, parametersDigest: parametersRef.digest, outputArtifactRefs: [outputRef], outputDigests: [outputRef.digest], typedResultManifestRef: changedOuterRef, typedResultManifestDigest: changedOuterRef.digest, requiredPolicyBindings: [], policyReportRefs: [] })
      const changedBindings = { ...bindings, resultManifestRef: changedOuterRef, resultManifestDigest: changedOuterRef.digest, finalizationReceiptRef: changedFinalization, finalizationReceiptDigest: changedFinalization.digest }
      const changedDraft = { ...draft, ...changedBindings, contentHash: answerDraftContentHash(run.runId, blocks, inputManifest.digest, [claim], [], changedBindings) }
      await expect(bridge.verify(changedDraft, queryCtx)).rejects.toThrow(mutation === 'value' ? 'value_mismatch' : mutation === 'unit' ? 'unit_mismatch' : mutation === 'row' ? 'cross_row_binding' : 'outside this exact run finalization')
      expect(await receipts.findReceipt(scope, { resultManifestRef: changedRef, draftHash: changedDraft.contentHash, tableId }, queryCtx)).toBeUndefined()
    }
    const requirement = (await bridge.requirements(draft, queryCtx))[0]
    if (requirement === undefined) throw new Error('the actual earned requirement disappeared')
    const earned = await receipts.getReceipt(scope, requirement.receiptRef, queryCtx)
    if (earned === undefined) throw new Error('the actual earned receipt disappeared')
    const sameBodyRef = { ...earned.ref, id: '00000000-0000-4000-8000-000000000001' }
    await receipts.putReceipt(scope, sameBodyRef, earned.receipt, queryCtx)
    const selector = { resultManifestRef: requirement.resultManifestRef, draftHash: draft.contentHash, tableId }
    expect((await receipts.findReceipt(scope, selector, queryCtx))?.ref.id).toBe(sameBodyRef.id)
    const foreignScope = (await createJobScope(harness.adminClient, 'table-producer-foreign')).scopeRef
    const foreignContext = createToolContext({ ...queryCtx, principal: { ...queryCtx.principal, tenantId: foreignScope.tenantId }, allowedResources: { ...queryCtx.allowedResources, ...foreignScope } })
    expect(await receipts.findReceipt(foreignScope, selector, foreignContext)).toBeUndefined()
    expect((await bridge.requirements(draft, queryCtx))[0]?.receiptRef).toEqual(requirement.receiptRef)
    expect((await publisher.publish({ grant, draft, verification }, queryCtx)).answerId).toBe(published.answerId)
    const changedReceipt = { ...earned.receipt, checksDigest: sha256OfCanonical('wrong actual verification inventory') }
    await receipts.putReceipt(scope, { ...earned.ref, id: randomUUID(), digest: sha256OfCanonical(changedReceipt) }, changedReceipt, queryCtx)
    await expect(receipts.findReceipt(scope, selector, queryCtx)).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION' })
  }, 120_000)
})
