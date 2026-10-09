import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { LocalDocumentExtractionService, PostgresDocumentParseStore } from '@ontology/adapter-extraction-document'
import {
  coreScenarioTaskBindings,
  createCoreApi,
  createCoreLocalComposition,
  createCoreStructuredImportWorkflow,
  loadCoreExamples,
} from '@ontology/app-api'
import type { CoreLocalComposition } from '@ontology/app-api'
import { canonicalJson, sha256DigestOf, InMemoryIndustrySchemaSource, JobService } from '@ontology/application'
import { IdentityDecisionService, IncrementalMaterializer, PublishedSemanticSource, SemanticDefinitionService, SemanticPublicationService, publishedRuleRef } from '@ontology/semantic-engine'
import { createToolContext } from '@ontology/contracts'
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
} from '@ontology/contracts'
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
const workerErrors: Error[] = []

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
async function seedPublishedSemanticsReadiness(ref: ProjectRevisionRef, targetRef: VersionRef): Promise<void> {
  const database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  try {
    const store = new PostgresProjectReadinessStore(database)
    await store.upsertProjection(
      scopeRef,
      {
        projectRevisionRef: ref,
        kind: 'published_semantics',
        targetRef: { id: targetRef.id, version: targetRef.version, digest: targetRef.digest, kind: 'artifact' },
        state: 'ready',
        completeness: 'complete',
        expectedCount: 1,
        processedCount: 1,
        failedCount: 0,
        targetDigest: targetRef.digest,
        fenceRevision: '1',
        idempotencyKey: `published-semantics-${PROJECT_ID}`,
        requestDigest: COMPONENT_DIGEST,
        actor: 'tester',
        recordedAt: '2026-09-30T00:00:00Z',
      },
      trustedContext(scopeRef, ['platform-admin', 'operator']),
    )
  } finally {
    await database.close().catch(() => undefined)
  }
}

async function seedProject(definitionRef: VersionRef): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  approvedInputRef = { id: randomUUID(), version: '1.0.0', digest: COMPONENT_DIGEST, kind: 'artifact' }
  const body: ProjectRevisionBody = {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef: { id: 'corerule-pack', version: '1.0.0', digest: COMPONENT_DIGEST },
    definitionRef,
    mappingRefs: [mappingRef()],
    profileRef: { id: 'corerule-profile', version: '1.0.0', snapshotHash: COMPONENT_DIGEST },
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
      const causes = workerErrors.map((error) => error.stack ?? error.message).join('\n')
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

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-rule-judgement-'))
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error(`scenario ${SCENARIO_ID} was not mounted`)
  await parsePolicyDocument()
  await seedProject(scenario.definitionRef)
  const usedRuleRef = await seedMaterializedRule(scenario.definitionRef)
  await seedPublishedSemanticsReadiness(projectRevisionRefValue, usedRuleRef)

  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    projectStructuredImports: createCoreStructuredImportWorkflow,
    onWorkerError(error) { if (error instanceof Error) workerErrors.push(error) },
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
}, 300_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await admin?.end().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
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
    expect(provenanceData.supportResolution?.state).toBe('resolved')
    expect((provenanceData.specification?.spans ?? []).length).toBeGreaterThanOrEqual(1)

    const answerId = answer['answerId']
    if (typeof answerId !== 'string') throw new Error('the published answer carried no answerId')
    const result = await request(`/api/v1/answers/${encodeURIComponent(answerId)}/result`)
    if (result.status !== 200) throw new Error(`verified result read failed: ${await result.text()}`)
    expect((await jsonBody(result)).data['answerId']).toBe(answerId)
  }, 180_000)
})
