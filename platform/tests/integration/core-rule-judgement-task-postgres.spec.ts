import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresCandidateStore,
  PostgresIdentityDecisionStore,
  PostgresJobStore,
  PostgresSemanticPublicationStore,
  PostgresSemanticDefinitionStore,
  PostgresMaterializationStore,
  PostgresProjectReadinessStore,
  PostgresProjectStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { LocalDocumentExtractionService, PostgresDocumentParseStore, PostgresStructuredIngestionStore, sha256DigestOfBytes } from '@ontology/adapter-extraction-document'
import {
  coreScenarioTaskBindings,
  createCoreApi,
  createCoreLocalComposition,
  createCoreStructuredImportWorkflow,
  createBlobArtifactWriter,
  loadCoreExamples,
} from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { canonicalJson, sha256DigestOf, InMemoryIndustrySchemaSource, JobService } from '@ontology/application'
import { IdentityDecisionService, IncrementalMaterializer, PublishedSemanticSource, SemanticDefinitionService, SemanticPublicationService, publishedRuleRef } from '@ontology/semantic-engine'
import { createToolContext, isRecord } from '@ontology/contracts'
import type {
  EntityCandidate,
  RuleCandidate,
  ParsedDocument,
  MappingRef,
  ProjectRevisionBody,
  ProjectRevisionRef,
  ResourceRef,
  ScopeRef,
  ToolContext,
  VersionRef,
  ProfileSpec,
} from '@ontology/contracts'
import { projectQueryPublicationFixture } from './project-query-publication-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * W08 real-database acceptance for a rule-judgement task run.
 *
 * The default `createCoreLocalComposition` host mounts the `rule_judgement` task binding with a
 * `published_semantics` readiness requirement. This seeds one real materialized rule instance
 * (the ordinary `IncrementalMaterializer` over a reviewed rule + premise facts + a parsed policy
 * document) and then drives a task-mode `POST /runs` through the normal HTTP surface: the
 * Template runtime prepares the fixed `ontology_lookup(intent=rules)` plan, the run-scoped
 * `MaterializedRuleDerivationEvidenceProducer` derives the `rule_derivation` evidence with the
 * specification span, the typed writer emits a rule-judgement assertion, the publication gate
 * publishes the verified @3 answer and the result is read back through `/answers/{id}/result`
 * and the provenance surface.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `corerule_${randomUUID().replaceAll('-', '')}`
const SCENARIO_ID = 'transport-facility-inspection'
const PROJECT_ID = randomUUID()
const COMPONENT_DIGEST = `sha256:${'a'.repeat(64)}`
const CHANGE_REASON = 'W08 rule judgement task acceptance'
let SUBJECT_ID = ''
const PREDICATE = 'inspection_due'
const OBJECT_ID = 'transport_facility'
const POLICY_TEXT = 'Observed facility_id=T-RULE; network_code=N-RULE; facility_district_code=north; inspection_due=true. Policy: a transport facility with a due inspection is flagged for review.'
const VALIDITY = { validFrom: '2020-01-01T00:00:00Z', validTo: '2099-01-01T00:00:00Z' }
const VALID_AT = '2026-09-30T00:00:00Z'


function mappingRef(): MappingRef {
  return {
    id: 'corerule-mapping',
    version: '1.0.0',
    digest: COMPONENT_DIGEST,
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'corerule', sourceId: 'records' }, objectPath: 'records' },
  }
}

function projectRevisionRef(body: ProjectRevisionBody): ProjectRevisionRef {
  return { projectId: PROJECT_ID, revision: '1', digest: sha256DigestOf(canonicalJson(body)) }
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
let projectRevisionRefValue: ProjectRevisionRef
let ruleRef: VersionRef
let artifactValidAt = VALID_AT
let artifactRecordedSeq = '1'
let approvedInputRef: ResourceRef
let policyDocument: ParsedDocument
type WorkerErrorObservation = {
  readonly phase: 'setup' | 'test' | 'teardown'
  readonly errorType: string
  readonly testName?: string
  readonly runId?: string
  readonly name?: string
  readonly code?: string
  readonly message?: string
  readonly keys: readonly string[]
}
const workerErrors: WorkerErrorObservation[] = []
let workerPhase: WorkerErrorObservation['phase'] = 'setup'
let workerTestName: string | undefined
let workerDiagnosticRunId: string | undefined

function workerErrorMetadata(error: unknown, phase: WorkerErrorObservation['phase'], testName?: string, runId?: string): WorkerErrorObservation {
  const readString = (key: 'name' | 'code' | 'message'): string | undefined => {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return undefined
    try {
      const value: unknown = Reflect.get(error, key)
      return typeof value === 'string' ? value.slice(0, key === 'message' ? 240 : 120) : undefined
    } catch { return undefined }
  }
  let keys: string[] = []
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
    try { keys = Object.keys(error).slice(0, 12).map((key) => key.slice(0, 80)) } catch { keys = ['<keys-unavailable>'] }
  }
  const name = readString('name'), code = readString('code')
  const message = readString('message')?.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[redacted]')
    .replace(/(password|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(POLICY_TEXT, '[redacted-policy]').replace(/\b(?:T-RULE|T-ROUTE|T-OTHER|N-RULE|route-network|north)\b/giu, '[redacted-value]')
  return {
    phase,
    errorType: typeof error,
    ...(testName === undefined ? {} : { testName: testName.slice(0, 160) }),
    ...(runId === undefined ? {} : { runId }),
    ...(name === undefined ? {} : { name }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message: message.slice(0, 160) }),
    keys,
  }
}

function workerErrorSummary(errors: readonly WorkerErrorObservation[]) {
  const groups = new Map<string, WorkerErrorObservation & { count: number }>()
  for (const error of errors) {
    const key = canonicalJson(error), existing = groups.get(key)
    if (existing === undefined) groups.set(key, { ...error, count: 1 })
    else existing.count += 1
  }
  const all = [...groups.values()], shown = all.slice(0, 8)
  return { totalCount: errors.length, groups: shown,
    unrepresentedCount: all.slice(8).reduce((total, group) => total + group.count, 0), lastSamples: errors.slice(-8) }
}
let modelServer: Server | undefined
let modelProfileRef: { id: string; version: string }
let baseProfileRef: { id: string; version: string }
let missingCapabilityProfileRef: { id: string; version: string }
let routingFixture: ReturnType<typeof projectQueryPublicationFixture>
let routingDocuments: ReturnType<typeof createCoreStructuredImportWorkflow>
let routingDatabase: ControlPostgresDatabase
let routingRegistry: PostgresArtifactRegistry
let routingStructured: PostgresStructuredIngestionStore
let routingEntityId = ''
let districtEntityId = ''
let projectRuleRef: VersionRef
let foreignEntityId = ''
let historicalRuleRunId = ''
let historicalRuleBody = ''
let proposal: unknown = { kind: 'rule_judgement', rule: 'project-inspection-policy', entity: 'T-ROUTE' }
let holdModel = false
let modelEntered = false
let releaseModel: (() => void) | undefined
const modelBodies: Record<string, unknown>[] = []

async function controlledModels(): Promise<string> {
  modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    modelBodies.push(body)
    modelEntered = true
    if (holdModel) await new Promise<void>((resolve) => { releaseModel = resolve })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const item of [
      { choices: [{ index: 0, delta: { content: JSON.stringify(proposal) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 20 } },
    ]) response.write(`data: ${JSON.stringify({ id: 'controlled-semantic-task', object: 'chat.completion.chunk', created: 1, model: 'controlled-routing-v1', ...item })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => modelServer?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((modelServer.address() as AddressInfo).port)}`
}

function trustedContext(scope: ScopeRef, roles: readonly string[]): ToolContext {
  return createToolContext({
    principal: { tenantId: scope.tenantId, subjectId: 'corerule-author', roles: [...roles], scopes: [], authEpoch: 1 },
    runId: randomUUID(),
    resolvedProfileHash: COMPONENT_DIGEST,
    policyVersion: '0.3.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId: randomUUID(),
      grantedAt: '2026-09-30T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      resourceKinds: ['artifact', 'document', 'chunk', 'evidence', 'dataset', 'plan', 'job'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1_000,
    },
    traceId: `corerule:${randomUUID()}`,
  })
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `corerule-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Rule judgement'])
  const statement = await admin.query<{ statement: string }>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [APP_PASSWORD])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const base = new URL(container.adminUrl)
  appUrl = `${base.protocol}//${encodeURIComponent('ontology_app')}:${encodeURIComponent(APP_PASSWORD)}@${base.hostname}:${base.port}/${base.pathname.replace(/^\//, '')}`
}

/** Parse the policy document through the real parser so the rule policy span resolves. */
async function parsePolicyDocument(): Promise<void> {
  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  const parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 4 })
  try {
    const blobStore = new LocalImmutableBlobStore({ objectStore, registry })
    const bytes = new TextEncoder().encode(POLICY_TEXT)
    const author = trustedContext(scopeRef, ['platform-admin', 'operator', 'data-editor'])
    const staged = await blobStore.stage(bytes, { scopeRef }, author)
    const published = await blobStore.publish({ scopeRef, contentDigest: staged.contentDigest, mediaType: 'text/plain', byteSize: staged.byteSize, purpose: 'document' }, author)
    if (published.blobRef.kind !== 'document') throw new Error('the policy original was not registered as a document')
    const documentVersionRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: published.blobRef.digest, kind: 'document' }
    const parsed = await new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore }).parse(
      { scopeRef, originalRef: published.blobRef, documentVersionRef },
      author,
    )
    policyDocument = parsed
  } finally {
    await parseStore.close().catch(() => undefined)
    await registry.close().catch(() => undefined)
  }
}

/** Materialize one real rule instance (premise fact + specification span) into the shared DB. */
async function seedMaterializedRule(definitionRef: VersionRef): Promise<VersionRef> {
  const database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  const materialization = new PostgresMaterializationStore(database)
  const candidates = new PostgresCandidateStore(database), identityStore = new PostgresIdentityDecisionStore(database), publications = new PostgresSemanticPublicationStore(database)
  const ctx = trustedContext(scopeRef, ['platform-admin', 'operator', 'data-editor', 'semantic-publisher', 'semantic-reviewer'])
  try {
    const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (scenario === undefined) throw new Error('missing mounted actual schema')
    const definition = await new SemanticDefinitionService({ store: new PostgresSemanticDefinitionStore(database), control: new ControlPostgresRepository(database) }).publish(scenario.definitionDraft, ctx)
    expect(definition.ref).toEqual(definitionRef)
    const schemas = new InMemoryIndustrySchemaSource([{ ref: definitionRef, schema: scenario.industrySchema }])
    const identity = new IdentityDecisionService({ store: identityStore, candidates, schemaSource: schemas })
    const publisher = new SemanticPublicationService({ store: publications, candidates, schemaSource: schemas, identity: identityStore })
    const job = await new JobService({ store: new PostgresJobStore(database) }).createJob({ jobId: randomUUID(), kind: 'ingestion', sourceRef: policyDocument.originalRef.id, documentRef: policyDocument.originalRef.id,
      pipelineVersion: '1.0.0', idempotencyKey: `rule-source-${randomUUID()}` }, ctx)
    const chunk = policyDocument.chunks[0]
    if (chunk === undefined) throw new Error('missing exact parsed source span')
    const span = { parseId: policyDocument.parseId, chunkId: chunk.chunkId, locator: chunk.locator, spanKind: chunk.spanKind, precision: chunk.precision, quoteDigest: chunk.quoteDigest, textDigest: chunk.textDigest }
    const common = { jobId: job.jobId, sourceSpans: [span], inputVersion: { definitionRef, parseId: policyDocument.parseId, parserVersion: policyDocument.parserVersion, pipelineVersion: '1.0.0', documentVersionRef: policyDocument.documentVersionRef ?? policyDocument.originalRef },
      deterministic: true, state: 'pending_review' as const, issues: [], recordedAt: new Date().toISOString() }
    const entity: EntityCandidate = { ...common, candidateId: randomUUID(), kind: 'entity', objectId: OBJECT_ID, identityScopeId: 'transport_facility_identity',
      attributes: [{ attributeId: 'facility_id', value: 'T-RULE' }, { attributeId: 'network_code', value: 'N-RULE' }, { attributeId: 'facility_district_code', value: 'north' }, { attributeId: PREDICATE, value: true }], idempotencyKey: sha256DigestOf('actual rule entity') }
    const rule: RuleCandidate = { ...common, candidateId: randomUUID(), kind: 'rule', objectId: OBJECT_ID, ruleId: 'inspection-due-policy',
      expression: { op: 'compare', attributeId: PREDICATE, operator: 'eq', value: true, spans: [span] }, exceptions: [], severity: 'soft', impact: 'low', conflicts: [], reviewRequirement: 'required', idempotencyKey: sha256DigestOf('actual declared rule') }
    await candidates.insertCandidates(scopeRef, [entity, rule], ctx)
    const pending = await identity.decide({ candidateId: entity.candidateId, kind: 'create_pending', expectedRevision: '0' }, ctx)
    if (pending.targetEntityId === undefined) throw new Error('missing actual published identity')
    SUBJECT_ID = pending.targetEntityId
    await identity.decide({ candidateId: entity.candidateId, kind: 'match', targetEntityId: SUBJECT_ID, expectedRevision: '1', strongIdentity: { kind: 'native_id', attributeId: 'facility_id', value: 'T-RULE' } }, ctx)
    for (const candidate of [entity, rule]) await publisher.reviewCandidate({ candidateId: candidate.candidateId, decision: 'approve', reason: 'human reviewed exact original fields and complete declaration', expectedRevision: '0' }, ctx)
    const published = await publisher.publish({ schemaRef: definitionRef, approvedCandidateRefs: [{ kind: 'entity', candidateId: entity.candidateId }, { kind: 'rule', candidateId: rule.candidateId }], expectedRevision: '0', idempotencyKey: `actual-rule-publish-${randomUUID()}` }, ctx)
    const version = published.ruleVersions[0]
    if (version === undefined) throw new Error('missing real published rule version')
    ruleRef = publishedRuleRef(version)
    const source = new PublishedSemanticSource(publications, { definition, identity: identityStore })
    const materializer = new IncrementalMaterializer({ publishedSource: source, materialization })
    await materializer.applyChange({ changeId: randomUUID(), scopeRef, recordedSeq: '1', recordedAt: new Date().toISOString(), kind: 'assertion_published', logicalAssertionId: entity.candidateId, predicate: PREDICATE, validity: VALIDITY }, ctx)
    const slices = await materialization.readSlices(scopeRef, { validAt: new Date(Date.now() + 1_000).toISOString(), asOfRecordedSeq: '1', limit: 100 }, ctx)
    const artifact = slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? []).find((candidate) => candidate.ruleRef.id === ruleRef.id && candidate.subjectEntityId === SUBJECT_ID && candidate.applicability.state === 'applicable')
    if (artifact === undefined) throw new Error('the actual published materializer persisted no rule artifact')
    artifactValidAt = artifact.validAt ?? VALID_AT
    artifactRecordedSeq = artifact.asOfRecordedSeq ?? '1'
    return ruleRef
  } finally { await database.close() }
}

/** Record the `published_semantics` readiness projection the rule binding requires. */
async function waitForActualPublishedSemanticsReadiness(ref: ProjectRevisionRef, targetRef: VersionRef): Promise<void> {
  const database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  try {
    const store = new PostgresProjectReadinessStore(database)
    const ctx = trustedContext(scopeRef, ['platform-admin', 'operator', 'data-editor'])
    const materialization = new PostgresMaterializationStore(database)
    const revision = await new PostgresProjectStore(database).getRevision(scopeRef, ref.projectId, ref.revision, ctx)
    if (revision?.ref.digest !== ref.digest) throw new Error('the semantic readiness producer has no exact stored project revision')
    const objects = new FileSystemObjectStore(objectDirectory)
    await objects.init()
    const blobs = new LocalImmutableBlobStore({ objectStore: objects, registry: routingRegistry })
    const source = new PublishedSemanticSource(routingFixture.publications, { definition: routingFixture.definition, identity: routingFixture.identities, projectId: PROJECT_ID, maxRecords: 1_000 })
    const endAt = Date.now() + 60_000
    let lastReceiptKey = ''
    let lastMismatch = 'normal published-semantics readiness is still pending'
    while (Date.now() < endAt) {
      const readiness = await store.getProjection(scopeRef, ref, 'published_semantics', ctx)
      const state = await materialization.getProjectionState(scopeRef, ctx)
      if (readiness?.state === 'ready' && canonicalJson(readiness.targetRef) === canonicalJson(revision.definitionRef) &&
          readiness.targetDigest === revision.definitionRef.digest && readiness.completeness === 'complete' && readiness.failedCount === 0 && readiness.receiptRef !== undefined &&
          state !== undefined && !state.dirty && state.watermark.kind === 'sequence') {
        const receiptKey = readiness.receiptRef.digest
        if (receiptKey !== lastReceiptKey) {
          try {
            const metadata = await blobs.getAuthorized({ scopeRef, blobRef: readiness.receiptRef }, ctx)
            if (!metadata.integrityVerified || !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 1 || metadata.byteSize > 1_048_576) {
              lastReceiptKey = receiptKey
              lastMismatch = 'normal readiness receipt metadata is not integrity-verified'
            }
            else {
              const bytes = await blobs.readAuthorized({ scopeRef, blobRef: readiness.receiptRef }, ctx)
              if (bytes.byteLength !== metadata.byteSize || sha256DigestOfBytes(bytes) !== readiness.receiptRef.digest) {
                lastReceiptKey = receiptKey
                lastMismatch = 'normal readiness receipt bytes differ from their immutable ref'
              }
              else {
                const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
                const captured = await source.load(scopeRef, ctx)
                const sourceDigest = sha256DigestOf(canonicalJson({ facts: captured.facts, rules: captured.rules, declarations: captured.premiseInput?.declarations ?? [] }))
                const matches = isRecord(raw) && raw['schemaVersion'] === 'project-published-semantics-readiness@1' &&
                  canonicalJson(raw['projectRevisionRef']) === canonicalJson(revision.ref) && canonicalJson(raw['definitionRef']) === canonicalJson(revision.definitionRef) &&
                  canonicalJson(raw['industryPackRef']) === canonicalJson(revision.industryPackRef) && canonicalJson(raw['sourceReadRevision']) === canonicalJson(captured.readRevision) &&
                  canonicalJson(raw['projection']) === canonicalJson(state) && raw['sourceDigest'] === sourceDigest && raw['expectedFacts'] === captured.facts.length &&
                  typeof raw['outboxId'] === 'string' && raw['outboxId'].length > 0 && captured.complete === true &&
                  readiness.expectedCount === captured.facts.length && readiness.processedCount === captured.facts.length
                if (matches) return
                lastReceiptKey = receiptKey
                lastMismatch = 'normal readiness receipt does not pin the exact project revision, source and materialization projection'
              }
            }
          } catch (error) {
            const readFenceChanged = error instanceof Error && error.name === 'IncompletePublishedReadError' &&
              (error as Error & { readonly code?: unknown }).code === 'INCOMPLETE_PUBLISHED_READ'
            lastReceiptKey = readFenceChanged ? '' : receiptKey
            lastMismatch = error instanceof Error ? `${error.name}: ${error.message}`.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[redacted]').slice(0, 240) : 'normal readiness receipt verification failed'
          }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await reportRuleArtifactSetupDiagnostic(ctx, targetRef, materialization)
    throw new Error(`normal host published-semantics readiness did not produce a verified receipt for this project revision: ${lastMismatch}`)
  } finally {
    await database.close().catch(() => undefined)
  }
}

async function seedProject(
  definitionRef: VersionRef,
  profileRef: ProjectRevisionBody['profileRef'],
  industryPackRef: ProjectRevisionBody['industryPackRef'],
): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  const objects = new FileSystemObjectStore(objectDirectory)
  await objects.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl })
  try {
    const blobs = new LocalImmutableBlobStore({ objectStore: objects, registry })
    approvedInputRef = (await createBlobArtifactWriter(blobs).putBytes({ scopeRef, content: new TextEncoder().encode(JSON.stringify({ rows: [{ id: 'R-1', amount: '10', unit: 'each' }, { id: 'R-2', amount: '2.5', unit: 'each' }] })), mediaType: 'application/json' }, trustedContext(scopeRef, ['platform-admin', 'operator', 'data-editor']))).blobRef
  } finally { await registry.close() }
  const body: ProjectRevisionBody = {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef,
    definitionRef,
    mappingRefs: [mappingRef(), { ...definitionRef, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'corerule', sourceId: 'identity' }, objectPath: 'identity_index' } }],
    profileRef,
    documentSetRef: { id: randomUUID(), version: '1.0.0', digest: COMPONENT_DIGEST, kind: 'document' },
    approvedInputRef,
    semanticPublicationRefs: [definitionRef],
    sourceVisibilityEpoch: '1',
    changeReason: CHANGE_REASON,
  }
  projectRevisionRefValue = projectRevisionRef(body)
  await admin.query(
    `INSERT INTO agent_platform.projects (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'W08 rule judgement project', 1, 'active', $4, $5, 'tester', $6, $6)`,
    [scopeRef.tenantId, scopeRef.spaceId, PROJECT_ID, `project-create-${PROJECT_ID}`, COMPONENT_DIGEST, '2026-09-30T00:00:00Z'],
  )
  await admin.query(
    `INSERT INTO agent_platform.project_revisions (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason, idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 1, $6, $7, $8, 'tester', $9)`,
    [scopeRef.tenantId, scopeRef.spaceId, PROJECT_ID, projectRevisionRefValue.digest, JSON.stringify(body), CHANGE_REASON, `revision-${PROJECT_ID}`, COMPONENT_DIGEST, '2026-09-30T00:00:00Z'],
  )
}

function request(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(30_000) })
}

async function jsonBody(response: Response): Promise<{ data: Record<string, unknown> }> {
  return await response.json() as { data: Record<string, unknown> }
}

async function waitForAnswer(runId: string): Promise<Record<string, unknown>> {
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const response = await request(`/api/v1/runs/${runId}/answer`)
    if (response.status === 200) return (await jsonBody(response)).data
    if (response.status !== 202) {
      const causes = JSON.stringify(workerErrorSummary(workerErrors))
      const eventsResponse = await request(`/api/v1/runs/${encodeURIComponent(runId)}/events`)
      const events = eventsResponse.ok ? await eventsResponse.text() : `<events ${String(eventsResponse.status)}>`
      throw new Error(`answer route failed with ${String(response.status)}: ${await response.text()}; causes=${causes}; events=${events}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish an answer before the deadline`)
}

async function ruleBindingRef() {
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error('the transport scenario was not mounted')
  const binding = coreScenarioTaskBindings(scenario).find((entry) => entry.kind === 'rule_judgement')
  if (binding === undefined) throw new Error('the composition did not mount a rule_judgement task binding')
  return binding.taskBindingRef
}

async function reportRuleArtifactSetupDiagnostic(ctx: ToolContext, targetRef: VersionRef, materialization: PostgresMaterializationStore): Promise<void> {
  const project = await routingFixture.projects.getProject(scopeRef, PROJECT_ID, ctx)
  const selectedRevision = project?.activeRevision ?? project?.headRevision
  const currentRevision = selectedRevision === undefined ? undefined : await routingFixture.projects.getRevision(scopeRef, PROJECT_ID, selectedRevision, ctx)
  const directSource = new PublishedSemanticSource(routingFixture.publications, { definition: routingFixture.definition, identity: routingFixture.identities, projectId: PROJECT_ID, maxRecords: 1_000 })
  let direct: Awaited<ReturnType<typeof directSource.load>> | undefined
  let directReadError: { readonly name: string; readonly code?: string; readonly message: string } | undefined
  try { direct = await directSource.load(scopeRef, ctx) } catch (error) {
    const failure: Error & { readonly code?: unknown } = error instanceof Error ? error as Error & { readonly code?: unknown } : new Error(String(error))
    directReadError = { name: failure.name, ...(typeof failure.code === 'string' ? { code: failure.code } : {}), message: failure.message
      .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[redacted]')
      .replace(/(password|api[_-]?key)\s*[=:]\s*[^\s,;]+/giu, '$1=[redacted]').slice(0, 240) }
  }
  const state = await materialization.getProjectionState(scopeRef, ctx)
  const slices = state?.watermark.kind === 'sequence'
    ? await materialization.readSlices(scopeRef, { validAt: new Date().toISOString(), asOfRecordedSeq: state.watermark.value, limit: 1_000 }, ctx)
    : []
  const declarations = direct?.premiseInput?.declarations.filter((row) => canonicalJson(publishedRuleRef(row)) === canonicalJson(targetRef)).slice(0, 4) ?? []
  const compiledInstances = (direct?.rules ?? []).flatMap((row) => row.publishedInstance !== undefined && canonicalJson(row.publishedInstance.ruleRef) === canonicalJson(targetRef)
    ? [{ projectId: row.publishedInstance.projectId, objectId: row.publishedInstance.objectId, subjectEntityId: row.publishedInstance.subjectEntityId, instanceKey: row.publishedInstance.instanceKey }]
    : []).slice(0, 8)
  const subjectRows = direct?.premiseInput?.subjects.filter((row) => row.projectId === PROJECT_ID && row.objectId === OBJECT_ID) ?? []
  const statement = direct?.premiseInput?.attributeStatements.find((row) => row.subjectEntityId === routingEntityId && row.objectId === OBJECT_ID)
  const candidate = statement === undefined ? undefined : await routingFixture.candidates.getCandidate(scopeRef, statement.sourceCandidateId, ctx)
  const binding = direct?.identityBindings?.find((row) => row.candidateId === statement?.sourceCandidateId)
  const premiseFacts = (direct?.facts ?? []).filter((row) => row.projectId === PROJECT_ID && row.subject === routingEntityId && row.objectId === OBJECT_ID && row.attributeId === PREDICATE)
    .slice(0, 8).map((row) => ({ assertionId: row.assertionId, sourceStatementId: row.sourceStatementId, subject: row.subject, objectId: row.objectId, attributeId: row.attributeId, op: row.op, value: row.value }))
  const sourcePin = candidate?.inputVersion.projectFact?.sources[0]
  const artifacts = slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? [])
    .filter((artifact) => artifact.projectId === PROJECT_ID && canonicalJson(artifact.ruleRef) === canonicalJson(targetRef))
    .slice(0, 8).map((artifact) => ({ subjectEntityId: artifact.subjectEntityId, objectId: artifact.objectId, applicability: artifact.applicability.state,
      conditionState: artifact.applicability.conditionState, validAt: artifact.validAt, asOfRecordedSeq: artifact.asOfRecordedSeq }))
  const outbox = admin === undefined ? [] : (await admin.query<{ outbox_id: string; topic: string; state: string; attempts: number; available_at: Date | string }>(
    `SELECT outbox_id, topic, state, attempts, available_at FROM agent_platform.job_outbox
      WHERE tenant_id = $1 AND space_id = $2 AND state = 'pending' ORDER BY created_at ASC LIMIT 8`, [scopeRef.tenantId, scopeRef.spaceId],
  )).rows.map((row) => ({ outboxId: row.outbox_id, topic: row.topic, state: row.state, attempts: row.attempts,
    availableAt: row.available_at instanceof Date ? row.available_at.toISOString() : row.available_at }))
  console.error('[rule-artifact-setup-diagnostic]', JSON.stringify({
    project: project === undefined ? undefined : { projectId: PROJECT_ID, state: project.state, headRevision: project.headRevision, activeRevision: project.activeRevision,
      selectedRevision: currentRevision?.ref, definitionRef: currentRevision?.definitionRef, profileRef: currentRevision?.profileRef, industryPackRef: currentRevision?.industryPackRef },
    source: { complete: direct?.complete, readRevision: direct?.readRevision, issueCodes: direct?.issues?.slice(0, 8).map((issue) => issue.code), directReadError,
      ruleIssues: direct?.ruleIssues?.slice(0, 8).map((issue) => ({ code: issue.code, ruleId: issue.ruleId, subjectEntityId: issue.subjectEntityId })),
      declarationRefs: declarations.map((row) => publishedRuleRef(row)), compiledInstances,
      subjectCount: subjectRows.length, containsRoutingSubject: subjectRows.some((row) => row.subjectEntityId === routingEntityId),
      routingEntityBinding: binding === undefined ? undefined : { candidateId: binding.candidateId,
        openAssertions: binding.openAssertions.map((row) => ({ entityId: row.entityId, objectId: row.objectId })), cannotLinkEntityIds: binding.cannotLinkEntityIds.slice(0, 8) },
      routingDueFacts: premiseFacts },
    candidateSourcePin: sourcePin === undefined ? undefined : { projectRevisionRef: sourcePin.projectRevisionRef, mappingRef: sourcePin.mappingRef,
      recordId: sourcePin.recordId, recordRevision: sourcePin.recordRevision, contentDigest: sourcePin.contentDigest, sourceDigest: sourcePin.sourceDigest,
      parseId: sourcePin.parseId, membershipRevision: sourcePin.membershipRevision, visibilityEpoch: sourcePin.visibilityEpoch },
    projection: state === undefined ? undefined : { dirty: state.dirty, generation: state.generation, watermark: state.watermark }, artifacts, outbox,
    workerErrors: workerErrorSummary(workerErrors),
  }))
}

beforeEach(() => {
  workerTestName = expect.getState().currentTestName
  workerDiagnosticRunId = undefined
})

afterEach(() => {
  workerTestName = undefined
  workerDiagnosticRunId = undefined
})

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-rule-judgement-'))
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error(`scenario ${SCENARIO_ID} was not mounted`)
  await parsePolicyDocument()

  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    projectStructuredImports: (options) => { routingDocuments = createCoreStructuredImportWorkflow(options); return routingDocuments },
    modelsEnabled: true,
    modelEnvironment: {
      CORE_ENABLE_MODELS: 'true', CORE_COMPANY_MODEL_BASE_URL: await controlledModels(),
      CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY', CORE_COMPANY_MODEL_API_KEY: 'controlled-semantic-secret',
      CORE_COMPANY_MODEL_PLATFORM_ID: 'core-company-semantic-router', CORE_COMPANY_MODEL_VENDOR_MODEL: 'controlled-routing-v1',
      CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible', CORE_COMPANY_MODEL_ENDPOINT: '/v1/chat/completions',
    },
    onWorkerError(error) {
      const observation = workerErrorMetadata(error, workerPhase, workerTestName, workerDiagnosticRunId)
      workerErrors.push(observation)
      process.stderr.write(`[core-worker-error-observed] ${JSON.stringify(observation)}\n`)
    },
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
  const ctx = trustedContext(scopeRef, ['platform-admin', 'operator', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
  const actualDeployment = (await jsonBody(await request('/api/v1/core/deployment'))).data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string }; baseProfileSpec: ProfileSpec }[]
  const actualMounted = actualDeployment.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (actualMounted === undefined) throw new Error('the actual Core scenario profile is missing')
  const preflight = await request(`/api/v1/profiles/${encodeURIComponent(actualMounted.profileRef.id)}/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: actualMounted.profileRef.version }) })
  if (preflight.status !== 200) throw new Error('the actual Core scenario profile did not pass preflight')
  const preflightData = (await jsonBody(preflight)).data
  const snapshotHash = (preflightData['resolvedProfile'] as { readonly snapshotHash?: unknown } | undefined)?.snapshotHash
  if (preflightData['status'] !== 'resolved' || typeof snapshotHash !== 'string') throw new Error('the actual Core scenario profile has no resolved immutable snapshot hash')
  await seedProject(scenario.definitionRef, { ...actualMounted.profileRef, snapshotHash }, actualMounted.baseProfileSpec.industryRef)
  await seedMaterializedRule(scenario.definitionRef)
  routingDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  routingRegistry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 2 })
  routingStructured = new PostgresStructuredIngestionStore({ connectionString: appUrl, maxPoolSize: 2 })
  const objects = new FileSystemObjectStore(objectDirectory)
  await objects.init()
  const blobs = new LocalImmutableBlobStore({ objectStore: objects, registry: routingRegistry })
  const definition = await new SemanticDefinitionService({ store: new PostgresSemanticDefinitionStore(routingDatabase), control: new ControlPostgresRepository(routingDatabase) }).getVersion({ scopeRef, namespace: scenario.namespace, definitionId: scenario.definitionRef.id, version: scenario.definitionRef.version }, ctx)
  routingFixture = projectQueryPublicationFixture({ db: routingDatabase, blobs, structured: routingStructured, scope: scopeRef, ctx, projectId: PROJECT_ID, definition,
    projectDocument: (parse, context) => routingDocuments.projection.project(parse, context) })
  const first = await routingFixture.importCsv(OBJECT_ID, 'code,network,district,due\nT-ROUTE,route-network,north,true\nT-OTHER,route-network,north,false\n', ['facility_id', 'network_code', 'facility_district_code', 'inspection_due'])
  const district = await routingFixture.importCsv('transport_district', 'code,network,name\nnorth,route-network,North\n', ['district_code', 'district_network_code', 'district_name'])
  const policyParses = new PostgresDocumentParseStore({ connectionString: appUrl })
  try {
    const storedParse = await policyParses.getParse(scopeRef, policyDocument.parseId, ctx)
    if (storedParse === undefined) throw new Error('the actual policy parse is missing')
    await routingFixture.documents.registerDocument(scopeRef, PROJECT_ID, { documentId: randomUUID(), documentRef: policyDocument.originalRef, documentDigest: policyDocument.originalRef.digest, parseId: policyDocument.parseId,
      parseRef: storedParse.spanMapRef, textDigest: storedParse.spanMapRef.digest, precision: 'exact', actor: ctx.principal.subjectId, recordedAt: new Date().toISOString() }, ctx)
  } finally { await policyParses.close() }
  const project = await routingFixture.projects.getProject(scopeRef, PROJECT_ID, ctx)
  if (project === undefined) throw new Error('the real routing source project is missing')
  await routingFixture.projectService.appendRevision(PROJECT_ID, { expectedRevision: project.headRevision, reason: 'pin actual authorized indexed source corpus',
    documentSetRef: await routingDocuments.documentSet(PROJECT_ID, ctx) }, `routing-corpus-${randomUUID()}`, ctx.principal.subjectId, ctx)
  const source = await routingFixture.restage(first)
  const districtSource = await routingFixture.restage(district)
  await routingFixture.approveAndPublish(source)
  await routingFixture.approveAndPublish(districtSource)
  const entity = source.entities[0], target = districtSource.entities[0]
  if (entity === undefined || target === undefined) throw new Error('real mapped endpoints are missing')
  routingEntityId = (await routingFixture.instances.getRecord(scopeRef, PROJECT_ID, entity.candidateId, ctx))?.identity.matchedEntityId ?? ''
  districtEntityId = (await routingFixture.instances.getRecord(scopeRef, PROJECT_ID, target.candidateId, ctx))?.identity.matchedEntityId ?? ''
  const relation = await routingFixture.workflow.materialization.stageRelation(PROJECT_ID, { relationId: 'facility_located_in_district', fromCandidateId: entity.candidateId, toCandidateId: target.candidateId }, ctx)
  await routingFixture.workflow.publication.reviewCandidate({ candidateId: relation.candidateId, expectedRevision: '0', decision: 'approve', reason: 'human reviewed actual mapped relation endpoints and original rows' }, ctx)
  await routingFixture.workflow.publication.publish({ approvedCandidateRefs: [relation], schemaRef: definition.ref, expectedRevision: await routingFixture.publications.latestPublicationRevision(scopeRef, ctx), idempotencyKey: 'actual-routing-relation' }, ctx)
  // The independent policy declaration is authored from POLICY_TEXT and the real parsed span.
  const policyChunk = policyDocument.chunks[0]
  if (policyChunk === undefined) throw new Error('policy has no actual text span')
  const span = { parseId: policyDocument.parseId, chunkId: policyChunk.chunkId, locator: policyChunk.locator, spanKind: policyChunk.spanKind, precision: policyChunk.precision, quoteDigest: policyChunk.quoteDigest, textDigest: policyChunk.textDigest }
  const job = await new JobService({ store: new PostgresJobStore(routingDatabase) }).createJob({ jobId: randomUUID(), kind: 'ingestion', sourceRef: policyDocument.originalRef.id, documentRef: policyDocument.originalRef.id, pipelineVersion: '1.0.0', idempotencyKey: 'actual-routing-policy-source' }, ctx)
  const candidate: RuleCandidate = { candidateId: randomUUID(), jobId: job.jobId, kind: 'rule', projectId: PROJECT_ID, ruleId: 'project-inspection-policy', objectId: OBJECT_ID,
    expression: { op: 'compare', attributeId: 'inspection_due', operator: 'eq', value: true, spans: [span] }, exceptions: [], severity: 'soft', impact: 'low', reviewRequirement: 'required', conflicts: [],
    deterministic: true, state: 'pending_review', issues: [], sourceSpans: [span], inputVersion: { definitionRef: definition.ref, parseId: policyDocument.parseId, parserVersion: policyDocument.parserVersion, pipelineVersion: '1.0.0', documentVersionRef: policyDocument.documentVersionRef ?? policyDocument.originalRef }, idempotencyKey: sha256DigestOf('actual routing policy'), recordedAt: new Date().toISOString() }
  await routingFixture.candidates.insertCandidates(scopeRef, [candidate], ctx)
  const publisher = new SemanticPublicationService({ store: routingFixture.publications, candidates: routingFixture.candidates, schemaSource: routingFixture.schemas, identity: routingFixture.identities, projects: new PostgresProjectStore(routingDatabase) })
  await publisher.reviewCandidate({ candidateId: candidate.candidateId, decision: 'approve', reason: 'human verified exact policy text', expectedRevision: '0' }, ctx)
  const publication = await publisher.publish({ approvedCandidateRefs: [candidate], schemaRef: definition.ref, expectedRevision: await routingFixture.publications.latestPublicationRevision(scopeRef, ctx), idempotencyKey: 'actual-routing-rule' }, ctx)
  if (publication.ruleVersions[0] === undefined) throw new Error('actual tagged rule was not published')
  projectRuleRef = publishedRuleRef(publication.ruleVersions[0])
  const indexed = await request(`/api/v1/projects/${PROJECT_ID}/document-index`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'keyword' }) })
  if (indexed.status !== 202) throw new Error(`actual policy index failed: ${await indexed.text()}`)
  const projected = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: OBJECT_ID }) })
  if (projected.status !== 201) throw new Error(`real mapped dataset failed: ${await projected.text()}`)
  projectRevisionRefValue = ((await jsonBody(projected)).data['status'] as { projectRevisionRef: ProjectRevisionRef }).projectRevisionRef
  await waitForActualPublishedSemanticsReadiness(projectRevisionRefValue, projectRuleRef)
  const deployment = (await jsonBody(await request('/api/v1/core/deployment'))).data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string }; baseProfileSpec: ProfileSpec }[]
  const mounted = deployment.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (mounted === undefined) throw new Error('missing real deployment profile')
  baseProfileRef = mounted.profileRef
  modelProfileRef = { id: mounted.profileRef.id, version: '1.0.1' }
  const components = (await jsonBody(await request('/api/v1/components'))).data['components'] as { manifest: { kind: string }; manifestRef: VersionRef }[]
  const generation = components.find((entry) => entry.manifest.kind === 'generation')
  if (generation === undefined) throw new Error('configured router model is missing')
  const modelSpec: ProfileSpec = { ...mounted.baseProfileSpec, modelBindings: { generation: { role: 'generation', modelRef: generation.manifestRef, fallbackPolicy: 'clarify', enabled: true } }, toolBindings: mounted.baseProfileSpec.toolBindings.map((binding) => ({ ...binding, enabled: true })) }
  const publishProfile = await request('/api/v1/profiles', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'semantic-routing-profile' }, body: JSON.stringify({ profileRef: modelProfileRef, environment: 'local_dev', spec: modelSpec }) })
  expect(publishProfile.status).toBe(201)
  expect((await request(`/api/v1/profiles/${encodeURIComponent(modelProfileRef.id)}/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: modelProfileRef.version }) })).status).toBe(200)
  missingCapabilityProfileRef = { id: modelProfileRef.id, version: '1.0.2' }
  expect((await request('/api/v1/profiles', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'semantic-routing-disabled-tool-profile' }, body: JSON.stringify({ profileRef: missingCapabilityProfileRef, environment: 'local_dev', spec: { ...modelSpec, toolBindings: modelSpec.toolBindings.map((binding) => binding.toolId === 'ontology_lookup' ? { ...binding, enabled: false } : binding) } }) })).status).toBe(201)
  expect((await request(`/api/v1/profiles/${encodeURIComponent(missingCapabilityProfileRef.id)}/preflight`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: missingCapabilityProfileRef.version }) })).status).toBe(200)
  if (admin === undefined) throw new Error('missing actual project database')
  const foreignId = randomUUID()
  const current = await routingFixture.projects.getRevision(scopeRef, PROJECT_ID, projectRevisionRefValue.revision, ctx)
  if (current === undefined) throw new Error('missing fixed source project')
  const foreignBody: ProjectRevisionBody = { schemaVersion: 'project-revision@1', projectId: foreignId, revision: '1', industryPackRef: current.industryPackRef, definitionRef: current.definitionRef,
    mappingRefs: [{ ...definition.ref, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'corerule', sourceId: 'identity' }, objectPath: 'identity_index' } }], profileRef: current.profileRef, documentSetRef: { id: randomUUID(), version: '1.0.0', digest: COMPONENT_DIGEST, kind: 'document' }, approvedInputRef, semanticPublicationRefs: [], sourceVisibilityEpoch: '0', changeReason: 'independent foreign-project routing input' }
  await admin.query(`INSERT INTO agent_platform.projects (tenant_id,space_id,project_id,title,head_revision,state,create_idempotency_key,create_request_digest,created_by,created_at,updated_at) VALUES ($1,$2,$3,'Foreign routing input',1,'active',$4,$5,'human',now(),now())`, [scopeRef.tenantId, scopeRef.spaceId, foreignId, `foreign-${foreignId}`, sha256DigestOf(canonicalJson(foreignBody))])
  await admin.query(`INSERT INTO agent_platform.project_revisions (tenant_id,space_id,project_id,revision,digest,body,source_visibility_epoch,change_reason,idempotency_key,request_digest,actor,recorded_at) VALUES ($1,$2,$3,1,$4,$5::jsonb,0,$6,$7,$4,'human',now())`, [scopeRef.tenantId, scopeRef.spaceId, foreignId, sha256DigestOf(canonicalJson(foreignBody)), JSON.stringify(foreignBody), foreignBody.changeReason, `foreign-revision-${foreignId}`])
  const foreign = projectQueryPublicationFixture({ db: routingDatabase, blobs, structured: routingStructured, scope: scopeRef, ctx, projectId: foreignId, definition })
  const foreignSource = await foreign.importCsv(OBJECT_ID, 'code,network,district,due\nT-ROUTE,foreign-network,south,false\n', ['facility_id', 'network_code', 'facility_district_code', 'inspection_due'])
  await foreign.approveAndPublish(foreignSource)
  const foreignCandidate = foreignSource.entities[0]
  if (foreignCandidate === undefined) throw new Error('actual foreign original row is missing')
  foreignEntityId = (await foreign.instances.getRecord(scopeRef, foreignId, foreignCandidate.candidateId, ctx))?.identity.matchedEntityId ?? ''
  expect(foreignEntityId).not.toBe(routingEntityId)
  const materialization = new PostgresMaterializationStore(routingDatabase)
  const endAt = Date.now() + 60_000
  while (Date.now() < endAt) {
    const state = await materialization.getProjectionState(scopeRef, ctx)
    if (state !== undefined && !state.dirty && state.watermark.kind === 'sequence') {
      const slices = await materialization.readSlices(scopeRef, { validAt: new Date().toISOString(), asOfRecordedSeq: state.watermark.value, limit: 1000 }, ctx)
      const actual = slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? []).filter((artifact) => artifact.projectId === PROJECT_ID && artifact.ruleRef.id === projectRuleRef.id && artifact.subjectEntityId === routingEntityId && artifact.applicability.state === 'applicable')
        .sort((a, b) => BigInt(a.asOfRecordedSeq ?? '0') > BigInt(b.asOfRecordedSeq ?? '0') ? -1 : 1)[0]
      if (actual?.validAt !== undefined && actual.asOfRecordedSeq !== undefined) {
        ruleRef = projectRuleRef; SUBJECT_ID = routingEntityId; artifactValidAt = actual.validAt; artifactRecordedSeq = actual.asOfRecordedSeq
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (SUBJECT_ID !== routingEntityId) {
    await reportRuleArtifactSetupDiagnostic(ctx, projectRuleRef, materialization)
  }
  expect(SUBJECT_ID).toBe(routingEntityId)
  workerPhase = 'test'
}, 300_000)

afterAll(async () => {
  workerPhase = 'teardown'
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  releaseModel?.()
  await new Promise<void>((resolve) => modelServer === undefined ? resolve() : modelServer.close(() => resolve()))
  await routingStructured?.close()
  await routingRegistry?.close()
  await routingDatabase?.close()
  await admin?.end().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
  if (workerErrors.length > 0) process.stderr.write(`[core-worker-error-summary] ${JSON.stringify(workerErrorSummary(workerErrors))}\n`)
})

async function routeQuestion(question: string, options: { profile?: { id: string; version: string }; project?: ProjectRevisionRef } = {}): Promise<Response> {
  return request('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `semantic-route-${randomUUID()}` }, body: JSON.stringify({ profileRef: options.profile ?? modelProfileRef, question, context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false }, task: { mode: 'question', projectRevisionRef: options.project ?? projectRevisionRefValue, inputSnapshotRef: approvedInputRef, inputSnapshotDigest: approvedInputRef.digest } }) })
}

async function waitState(runId: string, states: readonly string[]): Promise<Record<string, unknown>> {
  const stop = Date.now() + 60_000
  while (Date.now() < stop) {
    const response = await request(`/api/v1/runs/${runId}`)
    const state = (await jsonBody(response)).data
    if (typeof state['state'] === 'string' && states.includes(state['state'])) return state
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`semantic route did not reach ${states.join(', ')}`)
}

async function waitFailedJournal(runId: string, code: string): Promise<{ readonly state: Record<string, unknown>; readonly events: string }> {
  const stop = Date.now() + 60_000
  while (Date.now() < stop) {
    const state = (await jsonBody(await request(`/api/v1/runs/${runId}`))).data
    if (state['state'] === 'published') throw new Error('a refused task published an answer')
    if (state['state'] === 'failed') {
      const events = await request(`/api/v1/runs/${runId}/events`).then((response) => response.text())
      // The existing controller commits the state CAS before its append-only public journal.
      // Wait for both real records within the same bound, not for a guessed delay.
      if (events.includes(code)) return { state, events }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`the actual failed task journal never recorded ${code}`)
}

describe('controlled semantic task selection through the ordinary listening HTTP host (#265)', () => {
  it('resolves readable policy/entity names to actual scoped rule refs and verifies original mapped premises at answer@3', async () => {
    proposal = { kind: 'rule_judgement', rule: 'project-inspection-policy', entity: 'T-ROUTE' }
    const response = await routeQuestion('Is T-ROUTE due for inspection under project-inspection-policy?')
    expect(response.status).toBe(202)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('missing semantic run')
    const answer = await waitForAnswer(runId)
    historicalRuleRunId = runId
    historicalRuleBody = JSON.stringify(answer['v3Body'])
    const body = answer['v3Body'] as { schemaVersion: string; assertions: { kind: string; value?: string; subject: string; ruleRef?: VersionRef; premiseRefs?: ResourceRef[] }[] }
    expect(body.schemaVersion).toBe('answer-draft@3')
    const rule = body.assertions.find((entry) => entry.kind === 'rule_judgement')
    expect(rule?.value).toBe('true')
    expect(rule?.subject).toBe(routingEntityId)
    expect(rule?.ruleRef).toEqual(projectRuleRef)
    expect(rule?.premiseRefs?.length).toBeGreaterThan(0)
    const model = JSON.stringify(modelBodies.at(-1))
    expect(model).toContain('project-inspection-policy')
    expect(model).toContain('T-ROUTE')
    expect(model).not.toContain(projectRuleRef.digest)
    expect(model).not.toContain(routingEntityId)
    expect(model).not.toContain('foreign-network')
  }, 180_000)

  it('runs relations through actual published mapped endpoints and a verified @3 relation assertion', async () => {
    proposal = { kind: 'relations', entity: 'T-ROUTE', relations: ['facility_located_in_district'] }
    const response = await routeQuestion('Which district contains T-ROUTE?')
    expect(response.status).toBe(202)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('missing relation run')
    const answer = await waitForAnswer(runId)
    const body = answer['v3Body'] as { schemaVersion: string; assertions: { kind: string; subject: string; value: { type: string; from: ResourceRef; to: ResourceRef }; statementId?: string }[] }
    expect(body.schemaVersion).toBe('answer-draft@3')
    const relation = body.assertions.find((entry) => entry.kind === 'relation_ref')
    expect(relation?.subject).toBe(routingEntityId)
    expect(relation?.value.type).toBe('facility_located_in_district')
    expect(relation?.value.to.id).toBe(districtEntityId)
    expect(relation?.statementId).toBeDefined()
  }, 180_000)

  it('routes structured query, document QA and only a registered compute operation through the actual task handlers', async () => {
    for (const item of [
      { intent: { kind: 'structured_query', object: 'transport_facility', fields: ['facility_id', 'inspection_due'] }, question: 'List the project facility IDs and inspection status', expected: 'T-ROUTE' },
      { intent: { kind: 'document_qa', query: 'flagged review', limit: 5 }, question: 'What does the project inspection policy say about review?', expected: 'flagged for review' },
      { intent: { kind: 'compute', operation: 'core.task.compute', parameters: {} }, question: 'Aggregate the approved rows with the registered operation', expected: '12.5' },
    ]) {
      proposal = item.intent
      const response = await routeQuestion(item.question)
      expect(response.status).toBe(202)
      const runId = (await jsonBody(response)).data['runId']
      if (typeof runId !== 'string') throw new Error('missing routed run')
      const answer = await waitForAnswer(runId)
      expect((answer['v3Body'] as { schemaVersion: string }).schemaVersion).toBe('answer-draft@3')
      expect(JSON.stringify(answer['v3Body'])).toContain(item.expected)
    }
    const catalog = (await jsonBody(await request('/api/v1/core/deployment'))).data
    expect(JSON.stringify(catalog)).not.toContain('eval')
  }, 180_000)

  it('clarifies unresolved readable selectors and rejects fabricated authority or unregistered compute', async () => {
    proposal = { kind: 'rule_judgement', rule: 'project-inspection-policy', entity: 'not a project entity' }
    const response = await routeQuestion('Check an unspecified facility')
    expect(response.status).toBe(202)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('missing clarification run')
    const state = await waitState(runId, ['awaiting_input', 'failed'])
    expect(state['state']).toBe('awaiting_input')
    expect(state['pendingClarificationId']).toBeDefined()
    proposal = { kind: 'rule_judgement', rule: 'project-inspection-policy', entity: 'T-ROUTE' }
    const resumed = await request(`/api/v1/runs/${runId}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': String(state['revision']) }, body: JSON.stringify({ clarificationId: state['pendingClarificationId'], typedResponse: { entity: 'T-ROUTE' } }) })
    expect(resumed.status).toBe(200)
    expect(JSON.stringify((await waitForAnswer(runId))['v3Body'])).toContain(projectRuleRef.digest)
    for (const invalid of [
      { kind: 'rule_judgement', rule: 'project-inspection-policy', entity: 'T-ROUTE', ruleRef: projectRuleRef },
      { kind: 'compute', operation: 'run-any-function', parameters: {} },
    ]) {
      proposal = invalid
      const rejected = await routeQuestion('Try an unavailable task')
      expect(rejected.status).toBe(202)
      const rejectedId = (await jsonBody(rejected)).data['runId']
      if (typeof rejectedId !== 'string') throw new Error('missing rejected run')
      expect((await waitState(rejectedId, ['failed', 'awaiting_input', 'published']))['state']).toBe('failed')
      expect((await request(`/api/v1/runs/${rejectedId}/answer`)).status).not.toBe(200)
    }
  }, 180_000)

  it('retains a typed missing-capability failure and refuses a foreign entity sharing the same readable identifier', async () => {
    proposal = { kind: 'rule_judgement', rule: 'project-inspection-policy', entity: 'T-ROUTE' }
    const missing = await routeQuestion('Try the disabled rule capability', { profile: missingCapabilityProfileRef })
    expect(missing.status).toBe(202)
    const missingId = (await jsonBody(missing)).data['runId']
    if (typeof missingId !== 'string') throw new Error('missing disabled-capability run')
    const failure = await waitFailedJournal(missingId, 'CAPABILITY_NOT_CONFIGURED')
    expect(failure.state['state']).toBe('failed')
    expect(failure.state['cancelReason']).toBe('CAPABILITY_NOT_CONFIGURED')
    const events = failure.events
    expect(events).toContain('CAPABILITY_NOT_CONFIGURED')
    expect(events).not.toContain('controlled-semantic-secret')
    const rejected = await request('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `foreign-entity-${randomUUID()}` }, body: JSON.stringify({ profileRef: baseProfileRef, question: 'Check the selected entity', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false }, task: { mode: 'task', projectRevisionRef: projectRevisionRefValue, inputSnapshotRef: approvedInputRef, inputSnapshotDigest: approvedInputRef.digest, taskBindingRef: await ruleBindingRef(), parameters: { ruleRef: projectRuleRef, objectId: OBJECT_ID, subjectEntityId: foreignEntityId, validAt: artifactValidAt, asOfRecordedSeq: artifactRecordedSeq } } }) })
    expect(rejected.status).toBe(202)
    const rejectedId = (await jsonBody(rejected)).data['runId']
    if (typeof rejectedId !== 'string') throw new Error('missing foreign-entity run')
    const foreignFailure = await waitFailedJournal(rejectedId, 'FORBIDDEN')
    expect(foreignFailure.state['state']).toBe('failed')
    expect(foreignFailure.events).toContain('FORBIDDEN')
    const unsupported = await request('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `unsupported-axis-${randomUUID()}` }, body: JSON.stringify({ profileRef: baseProfileRef, question: 'Render the business proposition', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false }, task: { mode: 'task', projectRevisionRef: projectRevisionRefValue, inputSnapshotRef: approvedInputRef, inputSnapshotDigest: approvedInputRef.digest, taskBindingRef: await ruleBindingRef(), parameters: { ruleRef: projectRuleRef, objectId: OBJECT_ID, subjectEntityId: routingEntityId, validAt: artifactValidAt, asOfRecordedSeq: artifactRecordedSeq, judgementAxis: 'business_proposition' } } }) })
    expect(unsupported.status).toBe(202)
    const unsupportedId = (await jsonBody(unsupported)).data['runId']
    if (typeof unsupportedId !== 'string') throw new Error('missing unsupported-axis run')
    const unsupportedFailure = await waitFailedJournal(unsupportedId, 'UNSUPPORTED_QUERY')
    expect(unsupportedFailure.state['state']).toBe('failed')
    expect(unsupportedFailure.events).toContain('UNSUPPORTED_QUERY')
  }, 180_000)

  it('rejects a foreign project revision before any model call and keeps model-off explicit forms usable', async () => {
    const calls = modelBodies.length
    const foreign = await routeQuestion('Check a foreign project', { project: { ...projectRevisionRefValue, projectId: randomUUID() } })
    expect(foreign.status).toBe(404)
    expect(modelBodies).toHaveLength(calls)
    const unbound = await routeQuestion('Route without enabled model', { profile: baseProfileRef })
    expect(unbound.status).toBe(409)
    expect(modelBodies).toHaveLength(calls)
    const binding = await ruleBindingRef()
    const explicit = await request('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `explicit-readable-${randomUUID()}` }, body: JSON.stringify({ profileRef: baseProfileRef, question: 'Check selected inspection policy', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false }, task: { mode: 'task', projectRevisionRef: projectRevisionRefValue, inputSnapshotRef: approvedInputRef, inputSnapshotDigest: approvedInputRef.digest, taskBindingRef: binding, parameters: { rule: 'project-inspection-policy', entity: 'T-ROUTE' } } }) })
    expect(explicit.status).toBe(202)
    const runId = (await jsonBody(explicit)).data['runId']
    if (typeof runId !== 'string') throw new Error('missing explicit readable task')
    expect(JSON.stringify((await waitForAnswer(runId))['v3Body'])).toContain(projectRuleRef.digest)
    expect(modelBodies).toHaveLength(calls)
  }, 180_000)

  it('does not save or execute a late model proposal after real HTTP cancellation', async () => {
    holdModel = true; modelEntered = false
    proposal = { kind: 'relations', entity: 'T-ROUTE', relations: ['facility_located_in_district'] }
    const created = await routeQuestion('Cancel this relation lookup')
    expect(created.status).toBe(202)
    const runId = (await jsonBody(created)).data['runId']
    if (typeof runId !== 'string') throw new Error('missing cancel run')
    workerDiagnosticRunId = runId
    const endAt = Date.now() + 30_000
    while (!modelEntered && Date.now() < endAt) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(modelEntered).toBe(true)
    const state = (await jsonBody(await request(`/api/v1/runs/${runId}`))).data
    const cancelled = await request(`/api/v1/runs/${runId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': String(state['revision']) }, body: JSON.stringify({ reason: 'operator cancelled while routing' }) })
    expect(cancelled.status).toBe(200)
    holdModel = false; releaseModel?.()
    const terminal = await waitState(runId, ['cancelled', 'failed', 'published'])
    expect(terminal['state']).toBe('cancelled')
    if (admin === undefined) throw new Error('missing real archive reader')
    const receipts = await admin.query('SELECT receipt_id FROM agent_platform.core_plan_receipts WHERE run_id=$1', [runId])
    expect(receipts.rows).toHaveLength(0)
    const dispatch = await admin.query<{ state: string; revision: string; failure_code: string | null }>(
      'SELECT state, revision::text AS revision, failure_code FROM agent_platform.workflow_dispatches WHERE run_id=$1 ORDER BY created_at ASC', [runId],
    )
    process.stderr.write(`[cancel-run-terminal-diagnostic] ${JSON.stringify({ testName: expect.getState().currentTestName,
      runTerminalState: terminal['state'], dispatchRows: dispatch.rowCount,
      dispatch: dispatch.rows.slice(0, 4).map((row) => ({ state: row.state, revision: row.revision, failureCode: row.failure_code })) })}\n`)
    expect((await request(`/api/v1/runs/${runId}/answer`)).status).not.toBe(200)
  }, 180_000)
})

describe('rule-judgement task run through the normal HTTP host (real PostgreSQL)', () => {
  it('derives the rule conclusion and publishes a read-back answer-draft@3 with provenance', async () => {
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (mountedScenario === undefined) throw new Error('the transport scenario was not exposed')

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `corerule-task-${PROJECT_ID}` },
      body: JSON.stringify({
        profileRef: mountedScenario.profileRef,
        question: 'is a due inspection flagged for this facility',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
        task: {
          mode: 'task',
          projectRevisionRef: projectRevisionRefValue,
          inputSnapshotRef: approvedInputRef,
          inputSnapshotDigest: approvedInputRef.digest,
          taskBindingRef: await ruleBindingRef(),
          parameters: {
            ruleRef,
            objectId: OBJECT_ID,
            subjectEntityId: SUBJECT_ID,
            validAt: artifactValidAt,
            asOfRecordedSeq: artifactRecordedSeq,
          },
        },
      }),
    })
    if (runResponse.status !== 202) throw new Error(`rule task admission failed: ${await runResponse.text()}`)
    const runId = (await jsonBody(runResponse)).data['runId']
    if (typeof runId !== 'string') throw new Error('rule task admission returned no run id')

    const answer = await waitForAnswer(runId)
    type RuleAssertionBody = {
      kind: string
      value?: string
      ruleRef?: VersionRef
      subject?: string
      predicate?: string
      premiseRefs?: ResourceRef[]
      references?: { evidenceRef?: { id: string; kind: string } }[]
    }
    const v3Body = answer['v3Body'] as { schemaVersion: string; assertions?: RuleAssertionBody[] }
    expect(v3Body.schemaVersion).toBe('answer-draft@3')
    const rules = (v3Body.assertions ?? []).filter((entry) => entry.kind === 'rule_judgement')
    expect(rules.length).toBeGreaterThanOrEqual(1)
    expect(rules[0]?.value).toBe('true')
    expect(rules[0]?.premiseRefs?.length).toBeGreaterThan(0)
    expect(rules[0]?.subject).toBe(SUBJECT_ID)
    expect(typeof rules[0]?.predicate).toBe('string')
    if (rules[0]?.ruleRef === undefined) throw new Error('the rule assertion carried no rule ref')
    expect(rules[0].ruleRef.id).toBe(ruleRef.id)

    // The published rule evidence resolves to a real rule derivation with the premise facts and
    // the reviewed specification span on the provenance surface.
    const evidenceRef = rules[0].references?.[0]?.evidenceRef
    if (evidenceRef === undefined) throw new Error('the rule assertion bound no evidence reference')
    const provenance = await request(`/api/v1/evidence/${encodeURIComponent(evidenceRef.id)}`)
    if (provenance.status !== 200) throw new Error(`provenance read failed: ${await provenance.text()}`)
    const provenanceData = (await jsonBody(provenance)).data as {
      kind: string
      supportResolution?: { state?: string }
      specification?: { spans?: unknown[]; coverage?: { complete?: boolean } }
    }
    expect(provenanceData.kind).toBe('rule_derivation')
    expect(provenanceData.supportResolution?.state, JSON.stringify(provenanceData)).toBe('resolved')
    expect((provenanceData.specification?.spans ?? []).length).toBeGreaterThanOrEqual(1)

    const answerId = answer['answerId']
    if (typeof answerId !== 'string') throw new Error('the published answer carried no answerId')
    const result = await request(`/api/v1/answers/${encodeURIComponent(answerId)}/result`)
    if (result.status !== 200) throw new Error(`verified result read failed: ${await result.text()}`)
    expect((await jsonBody(result)).data['answerId']).toBe(answerId)
  }, 180_000)
})

describe('actual readable identity ambiguity and archived result retention (#265)', () => {
  it('clarifies two confirmed same-name identities in different declared scopes after an actual project input revision', async () => {
    const ctx = trustedContext(scopeRef, ['platform-admin', 'operator', 'data-editor', 'semantic-reviewer', 'semantic-publisher'])
    const duplicate = await routingFixture.importCsv(OBJECT_ID, 'code,network,district,due\nT-ROUTE,other-route-network,north,false\n', ['facility_id', 'network_code', 'facility_district_code', 'inspection_due'])
    await routingFixture.approveAndPublish(duplicate)
    const project = await routingFixture.projects.getProject(scopeRef, PROJECT_ID, ctx)
    const revision = project === undefined ? undefined : await routingFixture.projects.getRevision(scopeRef, PROJECT_ID, project.activeRevision ?? project.headRevision, ctx)
    if (revision === undefined) throw new Error('the new actual project revision is missing')
    projectRevisionRefValue = revision.ref
    await waitForActualPublishedSemanticsReadiness(revision.ref, projectRuleRef)
    proposal = { kind: 'rule_judgement', rule: 'project-inspection-policy', entity: 'T-ROUTE' }
    const response = await routeQuestion('Which T-ROUTE should the inspection policy apply to?')
    expect(response.status).toBe(202)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('missing actual ambiguity run')
    const state = await waitState(runId, ['awaiting_input', 'failed', 'published'])
    expect(state['state']).toBe('awaiting_input')
    const model = JSON.stringify(modelBodies.at(-1))
    expect(model).toContain('T-ROUTE / network_code=route-network')
    expect(model).toContain('T-ROUTE / network_code=other-route-network')
    expect((await request(`/api/v1/runs/${runId}/answer`)).status).toBe(202)
    expect(JSON.stringify((await jsonBody(await request(`/api/v1/runs/${historicalRuleRunId}/answer`))).data['v3Body'])).toBe(historicalRuleBody)
  }, 180_000)
})
