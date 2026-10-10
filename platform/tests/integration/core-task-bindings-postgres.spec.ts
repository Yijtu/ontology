import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import type { DataQueryOutput } from '@ontology/contracts'
import { projectQueryPublicationFixture } from './project-query-publication-fixtures'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresRunExecutionBindingStore,
  PostgresPublishedTaskBindingStore,
  PostgresProjectEvolutionStore,
  PostgresProfileStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  CORE_TYPED_RESULT_SCHEMA_REF,
  coreScenarioTaskBindings,
  createCoreApi,
  createCoreProjectQueryWorkflow,
  createProjectEvolutionWorkflow,
  createBlobArtifactWriter,
  createInstanceIdentityWorkflow,
  createCoreLocalComposition,
  loadCoreExamples,
} from '@ontology/app-api'
import type { CoreLocalComposition, CoreExampleScenario } from '@ontology/app-api'
import { canonicalJson, sha256DigestOf, ProjectService } from '@ontology/application'
import { assertProjectFactInputShape, createToolContext, isRecord } from '@ontology/contracts'
import type {
  MappingRef,
  ProjectRevisionBody,
  ProjectRevisionRef,
  ResolvedProfileRef,
  ResourceRef,
  ScopeRef,
  ToolContext,
  PackAsset,
  VersionRef,
} from '@ontology/contracts'
import { definitionVersionDigest, InMemoryIdentityIndexReader, projectIndustrySchema, validateDefinitionVersion } from '@ontology/semantic-engine'
import { seedIdentityProject } from './instance-identity-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * W06 real-database acceptance for the mounted Core task bindings.
 *
 * The default `createCoreLocalComposition` host mounts runnable task bindings per scenario. This
 * drives the structured-query task through the *normal* HTTP surface: a task-mode `POST /runs`
 * selects the mounted `structured_query` binding, the Template runtime prepares its deterministic
 * semantic plan, the shared gateway compiles and runs it against the project's official published
 * fact snapshot, the typed writer emits an `answer-draft@3`, the publication gate publishes the same
 * verified version, and the answer is read back through `/answers/{id}/result`, the revision
 * history and the verified JSON export. Nothing about the plan, evidence or answer is pre-seeded.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const APP_PASSWORD = `taskbind_${randomUUID().replaceAll('-', '')}`
const DIGEST = `sha256:${'a'.repeat(64)}`
const SCENARIO_ID = 'transport-facility-inspection'
const PROJECT_ID = randomUUID()
const DOCUMENT_SET_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'document' }
const APPROVED_INPUT_REF: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const CHANGE_REASON = 'W06 mounted task binding acceptance'
const OBJECT_ID = 'transport_facility'
const FIELDS = ['facility_id', 'inspection_due'] as const

function mappingRef(): MappingRef {
  return {
    id: 'taskbind-mapping',
    version: '1.0.0',
    digest: DIGEST,
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'taskbind', sourceId: 'records' }, objectPath: 'records' },
  }
}

function revisionBody(definitionRef: { id: string; version: string; digest: string }, industryPackRef: VersionRef, profileRef: ResolvedProfileRef): ProjectRevisionBody {
  return {
    schemaVersion: 'project-revision@1',
    projectId: PROJECT_ID,
    revision: '1',
    industryPackRef,
    definitionRef,
    mappingRefs: [mappingRef(), { ...definitionRef, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'taskbind', sourceId: 'identity' }, objectPath: 'identity_index' } }],
    profileRef,
    documentSetRef: DOCUMENT_SET_REF,
    approvedInputRef: APPROVED_INPUT_REF,
    semanticPublicationRefs: [definitionRef],
    sourceVisibilityEpoch: '1',
    changeReason: CHANGE_REASON,
  }
}

function projectRevisionRef(body: ProjectRevisionBody): ProjectRevisionRef {
  return { projectId: PROJECT_ID, revision: '1', digest: sha256DigestOf(canonicalJson(body)) }
}

let container: PostgresContainer | undefined
let admin: Client | undefined
let appUrl = ''
let businessUrl = ''
let scopeRef: ScopeRef
let objectDirectory = ''
let composition: CoreLocalComposition | undefined
let api: ReturnType<typeof createCoreApi> | undefined
let baseUrl = ''
const workerErrors: Error[] = []

function trustedContext(scope: ScopeRef): ToolContext {
  return createToolContext({
    principal: {
      tenantId: scope.tenantId,
      subjectId: 'taskbind-author',
      roles: ['platform-admin', 'operator', 'profile-editor', 'data-editor', 'semantic-reviewer', 'semantic-publisher'],
      scopes: [],
      authEpoch: 1,
    },
    runId: randomUUID(),
    resolvedProfileHash: DIGEST,
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
      resourceKinds: ['artifact', 'document', 'dataset'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1_000,
    },
    traceId: `taskbind:${randomUUID()}`,
  })
}

async function startIsolatedDatabase(): Promise<void> {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  admin = new Client({ connectionString: container.adminUrl })
  await admin.connect()
  scopeRef = { tenantId: randomUUID(), spaceId: randomUUID() }
  await admin.query('INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $2)', [scopeRef.tenantId, `taskbind-${scopeRef.tenantId.slice(0, 8)}`])
  await admin.query('INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, $3)', [scopeRef.tenantId, scopeRef.spaceId, 'Task binding'])
  const statement = await admin.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [APP_PASSWORD],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not prepare the non-owner application role')
  await admin.query(alterStatement)
  const appDatabase = new URL(container.adminUrl)
  appDatabase.username = 'ontology_app'
  appDatabase.password = APP_PASSWORD
  appUrl = appDatabase.toString()
  await admin.query('CREATE DATABASE project_query_business')
  const businessDatabase = new URL(container.adminUrl)
  businessDatabase.pathname = '/project_query_business'
  businessUrl = businessDatabase.toString()

}

async function seedProject(body: ProjectRevisionBody): Promise<void> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  await admin.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'W06 task binding project', 1, 'active', $4, $5, 'tester', $6, $6)`,
    [scopeRef.tenantId, scopeRef.spaceId, PROJECT_ID, `project-create-${PROJECT_ID}`, DIGEST, '2026-09-30T00:00:00Z'],
  )
  await admin.query(
    `INSERT INTO agent_platform.project_revisions
       (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason, idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 1, $6, $7, $8, 'tester', $9)`,
    [
      scopeRef.tenantId,
      scopeRef.spaceId,
      PROJECT_ID,
      projectRevisionRef(body).digest,
      JSON.stringify(body),
      CHANGE_REASON,
      `revision-${PROJECT_ID}`,
      DIGEST,
      '2026-09-30T00:00:00Z',
    ],
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
      throw new Error(`answer route failed with ${String(response.status)}: ${await response.text()}; causes=${causes}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`run ${runId} did not publish an answer before the deadline`)
}

async function waitForOutboxDispatch(outboxId: string): Promise<number> {
  if (admin === undefined) throw new Error('isolated PostgreSQL admin client is unavailable')
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = await admin.query<{ state: string; attempts: number; dispatched_at: Date | null }>('SELECT state,attempts,dispatched_at FROM agent_platform.job_outbox WHERE tenant_id=$1 AND space_id=$2 AND outbox_id=$3', [scopeRef.tenantId, scopeRef.spaceId, outboxId])
    if (result.rows[0]?.state === 'dispatched' && result.rows[0].dispatched_at !== null) {
      if (result.rows[0].attempts !== 1) throw new Error(`actual publication outbox ${outboxId} dispatched ${result.rows[0].attempts} times`)
      return result.rows[0].attempts
    }
    if (workerErrors.length > 0) throw new Error(`actual publication outbox failed before its fence settled: ${workerErrors.map((error) => `${error.name}: ${error.message}`).join('; ')}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`the actual publication outbox ${outboxId} did not dispatch within its fixed 15-second barrier`)
}

async function sameRevisionProvenanceDiagnostic(objectId: string): Promise<Record<string, unknown>> {
  const ctx = trustedContext(scopeRef), project = await publishedFixture.projects.getProject(scopeRef, PROJECT_ID, ctx)
  const revision = await publishedFixture.projects.getRevision(scopeRef, PROJECT_ID, projectRevisionRefValue.revision, ctx)
  const [visibility, statements] = await Promise.all([
    publishedFixture.documents.getVisibility(scopeRef, PROJECT_ID, ctx),
    publishedFixture.publications.listStatements(scopeRef, { objectId, status: 'active', limit: 100 }, ctx),
  ])
  const pins: Record<string, unknown>[] = []
  for (const statement of statements) {
    const provenanceValue = statement.value['provenance']
    const sourceSpansValue = isRecord(provenanceValue) ? provenanceValue['sourceSpans'] : undefined
    try { assertProjectFactInputShape(provenanceValue) }
    catch { pins.push({ statementId: statement.statementId, pinShape: 'invalid' }); continue }
    const sourceSpans = Array.isArray(sourceSpansValue) ? sourceSpansValue : []
    for (const pin of provenanceValue.sources) {
      const [latestRecord, pinnedRecord, mapping, membership, parse] = await Promise.all([
        publishedFixture.records.getRecord(scopeRef, PROJECT_ID, pin.recordId, ctx),
        publishedFixture.records.getRecordVersion?.(scopeRef, PROJECT_ID, pin.recordId, pin.recordRevision, ctx) ?? Promise.resolve(undefined),
        publishedFixture.mappings.getMapping(scopeRef, PROJECT_ID, pin.mappingRef.id, pin.mappingRef.version, ctx),
        publishedFixture.documents.getMembership(scopeRef, PROJECT_ID, pin.documentId, ctx),
        structuredStore?.getParse(scopeRef, pin.parseId, ctx) ?? Promise.resolve(undefined),
      ])
      const mismatches: string[] = []
      if (latestRecord === undefined) mismatches.push('record_missing')
      else {
        if (latestRecord.revision !== pin.recordRevision) mismatches.push('record_revision_mismatch')
        if (latestRecord.contentDigest !== pin.contentDigest) mismatches.push('record_content_digest_mismatch')
        if (latestRecord.sourceDigest !== pin.sourceDigest) mismatches.push('record_source_digest_mismatch')
      }
      if (pinnedRecord === undefined) mismatches.push('record_version_unavailable')
      else if (pinnedRecord.recordId !== pin.recordId || pinnedRecord.revision !== pin.recordRevision || pinnedRecord.contentDigest !== pin.contentDigest || pinnedRecord.sourceDigest !== pin.sourceDigest ||
        pinnedRecord.mappingId !== pin.mappingRef.id || pinnedRecord.mappingVersion !== pin.mappingRef.version) {
        mismatches.push('record_version_pin_mismatch')
      }
      if (mapping === undefined) mismatches.push('mapping_missing')
      else {
        if (canonicalJson(mapping.ref) !== canonicalJson(pin.mappingRef)) mismatches.push('mapping_ref_mismatch')
        if (mapping.parseId !== pin.parseId) mismatches.push('mapping_parse_mismatch')
        if (revision?.mappingRefs.some((ref) => canonicalJson(ref) === canonicalJson(pin.mappingRef)) !== true) mismatches.push('project_revision_mapping_missing')
      }
      if (membership === undefined) mismatches.push('membership_missing')
      else {
        if (membership.state !== 'active') mismatches.push('membership_not_active')
        if (membership.membershipRevision !== pin.membershipRevision) mismatches.push('membership_revision_mismatch')
        if (membership.parseId !== pin.parseId) mismatches.push('membership_parse_mismatch')
      }
      if (visibility === undefined) mismatches.push('visibility_missing')
      else if (visibility.epoch !== pin.visibilityEpoch) mismatches.push('visibility_epoch_mismatch')
      const matchingSpans = pinnedRecord === undefined ? 0 : pinnedRecord.fields.filter((field) => sourceSpans.some((span) => isRecord(span) &&
        span['kind'] === 'structured' && span['recordId'] === pin.recordId && span['parseId'] === pin.parseId &&
        span['rowDigest'] === pin.sourceDigest && canonicalJson(span['locator']) === canonicalJson(field.locator))).length
      if (!Array.isArray(sourceSpansValue)) mismatches.push('source_spans_missing')
      else if (matchingSpans !== (pinnedRecord?.fields.length ?? 0)) mismatches.push('source_span_field_mismatch')
      pins.push({
        statementId: statement.statementId,
        projectRevisionRef: pin.projectRevisionRef,
        definitionRef: pin.definitionRef,
        mappingRef: pin.mappingRef,
        recordId: pin.recordId,
        recordRevision: pin.recordRevision,
        contentDigest: pin.contentDigest,
        sourceDigest: pin.sourceDigest,
        documentId: pin.documentId,
        parseId: pin.parseId,
        membershipRevision: pin.membershipRevision,
        visibilityEpoch: pin.visibilityEpoch,
        actual: {
          projectRevisionRef: revision?.ref,
          latestRecordRevision: latestRecord?.revision,
          latestContentDigest: latestRecord?.contentDigest,
          latestSourceDigest: latestRecord?.sourceDigest,
          pinnedRecordAvailable: pinnedRecord !== undefined,
          mappingRef: mapping?.ref,
          mappingParseId: mapping?.parseId,
          parserVersion: parse?.parserVersion,
          membership: membership === undefined ? undefined : { state: membership.state, membershipRevision: membership.membershipRevision, parseId: membership.parseId },
          visibilityEpoch: visibility?.epoch,
          sourceSpanCount: sourceSpans.length,
          sourceSpanFieldMatches: matchingSpans,
        },
        mismatches,
      })
    }
  }
  return {
    objectId,
    project: project === undefined ? undefined : { projectId: PROJECT_ID, activeRevision: project.activeRevision, headRevision: project.headRevision },
    projectRevisionRef: revision?.ref,
    mappingRefs: revision?.mappingRefs.map((ref) => ({ id: ref.id, version: ref.version, digest: ref.digest })),
    visibility: visibility === undefined ? undefined : { epoch: visibility.epoch, membershipRevision: visibility.membershipRevision },
    statementCount: statements.length,
    statementRowsTruncated: statements.length >= 100,
    pins,
  }
}

async function reviewAndPublishSources(sources: readonly Awaited<ReturnType<ReturnType<typeof projectQueryPublicationFixture>['importCsv']>>[]) {
  const candidates = sources.flatMap((source) => source.entities)
  const context = trustedContext(scopeRef)
  for (const source of sources) {
    for (const candidate of source.entities) {
      const created = await publishedFixture.identity.createRecord(scopeRef, PROJECT_ID, { candidateId: candidate.candidateId, documentId: source.documentId, relations: [], idempotencyKey: `taskbind-record-${candidate.candidateId}` }, context)
      const confirmed = await publishedFixture.instanceService.confirmFields(scopeRef, PROJECT_ID, candidate.candidateId, { expectedRevision: created.record.recordRevision,
        decisions: created.record.fields.map((field) => ({ fieldId: field.fieldId, decision: 'confirm' })), idempotencyKey: `taskbind-fields-${candidate.candidateId}` }, context)
      await publishedFixture.identity.adjudicateIdentity(scopeRef, PROJECT_ID, candidate.candidateId, { expectedRevision: confirmed.record.recordRevision, kind: 'create', reason: 'human verified exact fixture query identity', idempotencyKey: `taskbind-identity-${candidate.candidateId}` }, context)
      await publishedFixture.workflow.publication.reviewCandidate({ candidateId: candidate.candidateId, expectedRevision: '0', decision: 'approve', reason: 'human reviewed exact mapped query cells' }, context)
    }
  }
  if (candidates.length === 0) throw new Error('the actual query fixture has no reviewed source candidates')
  return publishedFixture.workflow.publication.publish({ approvedCandidateRefs: candidates.map((candidate) => ({ candidateId: candidate.candidateId, kind: 'entity' as const })), schemaRef: publishedFixture.definition.ref,
    expectedRevision: await publishedFixture.publications.latestPublicationRevision(scopeRef, context), idempotencyKey: `taskbind-fixture-publish-${PROJECT_ID}` }, context)
}

let structuredBinding: { taskBindingRef: { id: string; version: string; digest: string } }
let projectRevisionRefValue: ProjectRevisionRef
let actualBaseProfileRef: ResolvedProfileRef
let actualBaseIndustryPackRef: VersionRef
let publishedFixture: ReturnType<typeof projectQueryPublicationFixture>
let queryDatabase: ControlPostgresDatabase
let queryRegistry: PostgresArtifactRegistry
let structuredStore: PostgresStructuredIngestionStore
let originalAnswer: Record<string, unknown>
let originalRunId = ''
let initialSource: Awaited<ReturnType<ReturnType<typeof projectQueryPublicationFixture>['importCsv']>>

beforeAll(async () => {
  await startIsolatedDatabase()
  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-core-task-bindings-'))
  const scenario = loadCoreExamples({ targetScopeRef: scopeRef }).scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
  if (scenario === undefined) throw new Error(`scenario ${SCENARIO_ID} was not mounted`)

  // Every required task kind is mounted for the scenario, and the compute one pins the neutral
  // registered example operation.
  const mounted = coreScenarioTaskBindings(scenario)
  const kinds = mounted.map((binding) => binding.kind)
  for (const kind of ['published_facts', 'structured_query', 'document_qa', 'rule_judgement', 'compute']) {
    expect(kinds).toContain(kind)
  }
  const structured = mounted.find((binding) => binding.kind === 'structured_query')
  if (structured === undefined) throw new Error('the composition did not mount a structured_query task binding')
  expect(structured.resultSchemaRef).toEqual(CORE_TYPED_RESULT_SCHEMA_REF)
  structuredBinding = { taskBindingRef: structured.taskBindingRef }
  const compute = mounted.find((binding) => binding.kind === 'compute')
  expect(compute?.operationRef?.id).toBe('example.compute.aggregate')

  composition = await createCoreLocalComposition({
    databaseUrl: appUrl,
    projectDataset: { connectionString: businessUrl, schema: 'business_dataset' },
    objectDirectory,
    scopeRef,
    examples: loadCoreExamples({ targetScopeRef: scopeRef }),
    allowLocalOperator: true,
    onWorkerError(error) { if (error instanceof Error) workerErrors.push(error) },
  })
  api = createCoreApi(composition.dependencies)
  const address = await api.listen({ host: '127.0.0.1', port: 0 })
  baseUrl = address.replace(/\/$/u, '')
  const preflight = await request(`/api/v1/profiles/${encodeURIComponent(scenario.profileRef.id)}/preflight`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: scenario.profileRef.version }),
  })
  if (preflight.status !== 200) throw new Error(`the actual mounted project profile did not preflight: ${await preflight.text()}`)
  const preflightData = (await jsonBody(preflight)).data as { status?: string; resolvedProfile?: { snapshotHash?: string; industryRef?: VersionRef } }
  const snapshotHash = preflightData.resolvedProfile?.snapshotHash, industryPackRef = preflightData.resolvedProfile?.industryRef
  if (preflightData.status !== 'resolved' || snapshotHash === undefined || industryPackRef === undefined) throw new Error('the actual mounted project profile has no resolved snapshot or industry pack pin')
  actualBaseProfileRef = { id: scenario.profileRef.id, version: scenario.profileRef.version, snapshotHash }
  actualBaseIndustryPackRef = industryPackRef
  const body = revisionBody(scenario.definitionRef, industryPackRef, actualBaseProfileRef)
  projectRevisionRefValue = projectRevisionRef(body)
  await seedProject(body)
  queryDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  queryRegistry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 2 })
  structuredStore = new PostgresStructuredIngestionStore({ connectionString: appUrl, maxPoolSize: 2 })
  const objects = new FileSystemObjectStore(objectDirectory)
  await objects.init()
  const blobs = new LocalImmutableBlobStore({ objectStore: objects, registry: queryRegistry })
  publishedFixture = projectQueryPublicationFixture({ db: queryDatabase, blobs, structured: structuredStore, scope: scopeRef, ctx: trustedContext(scopeRef), projectId: PROJECT_ID,
    definition: { ...scenario.definitionDraft, ref: scenario.definitionRef, publishedAt: new Date().toISOString() } })
  const source = await publishedFixture.importCsv(OBJECT_ID, 'code,network,district,due\nP-101,private-network,north,true\nP-102,private-network,south,false\n', ['facility_id', 'network_code', 'facility_district_code', 'inspection_due'])
  const district = await publishedFixture.importCsv('transport_district', 'code,network,name\nnorth,private-network,North\n', ['district_code', 'district_network_code', 'district_name'])
  initialSource = await publishedFixture.restage(source)
  const publication = await reviewAndPublishSources([initialSource, district])
  expect(await waitForOutboxDispatch(publication.outboxId)).toBe(1)
  expect(workerErrors.map((error) => ({ name: error.name, message: error.message }))).toEqual([])
  const projected = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: OBJECT_ID }) })
  if (projected.status !== 201) throw new Error(`official dataset creation failed: ${await projected.text()}`)
  projectRevisionRefValue = ((await jsonBody(projected)).data['status'] as { projectRevisionRef: ProjectRevisionRef }).projectRevisionRef

}, 240_000)

afterAll(async () => {
  await api?.close().catch(() => undefined)
  await composition?.close().catch(() => undefined)
  await structuredStore?.close()
  await queryRegistry?.close()
  await queryDatabase?.close()
  await admin?.end().catch(() => undefined)
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
  await container?.stop()
})

describe('mounted Core structured-query task binding through the normal HTTP host (real PostgreSQL)', () => {
  it('runs old active tasks during staging, then admits a real new profile/input task and verifies the new original field after CAS', async () => {
      if (admin === undefined)
          throw new Error('PG fixture unavailable')
      const ctx = trustedContext(scopeRef), projectId = randomUUID(), definition = publishedFixture.definition
      const examples = loadCoreExamples({
          targetScopeRef: scopeRef
      }), base = examples.scenarios.find((scenario) => scenario.scenarioId === SCENARIO_ID)
      if (base === undefined)
          throw new Error('base scenario missing')
      const namespace = `${definition.namespace}-evolved`
      const nextBody = {
          ...definition, namespace, definitionId: `${definition.definitionId}_evolved`, version: '1.0.0', objects: definition.objects.map((row) => ({
              ...row, namespace
          })), attributes: [...definition.attributes.map((row) => ({
                  ...row, namespace
              })), {
                  kind: 'attribute' as const, namespace, standardProvenance: definition.standardProvenance, id: 'evolution_note', objectId: OBJECT_ID, valueType: 'string' as const, cardinality: {
                      min: 0, max: 1
                  }
              }], relations: definition.relations.map((row) => ({
              ...row, namespace
          })), identityScopes: definition.identityScopes.map((row) => ({
              ...row, namespace
          })), ruleConstraints: definition.ruleConstraints.map((row) => ({
              ...row, namespace
          }))
      }
      expect(validateDefinitionVersion(nextBody)).toEqual([])
      const next = {
          ...nextBody, ref: {
              id: nextBody.definitionId, version: nextBody.version, digest: definitionVersionDigest(nextBody)
          }
      }
      const industryManifest = {
          ...base.industryManifest, namespace, definitionsRef: next.ref
      }
      const nextScenario: CoreExampleScenario = {
          ...base, scenarioId: `${SCENARIO_ID}-evolved`, namespace, label: 'Evolved transport input', profileRef: {
              id: 'transport-evolution-profile', version: '1.0.0'
          }, industryManifest, definitionDraft: nextBody, definitionRef: next.ref, industrySchema: projectIndustrySchema(next)
      }
      const extended = {
          ...examples, scenarios: [...examples.scenarios, nextScenario]
      }
      await api?.close()
      await composition?.close()
      // The normal host registers, publishes, preflights and activates the actual compatible profile.
      composition = await createCoreLocalComposition({
          databaseUrl: appUrl, projectDataset: {
              connectionString: businessUrl, schema: 'business_dataset'
          }, objectDirectory, scopeRef, examples: extended, allowLocalOperator: true, onWorkerError(error) {
              if (error instanceof Error)
                  workerErrors.push(error)
          }
      })
      api = createCoreApi(composition.dependencies)
      baseUrl = (await api.listen({
          host: '127.0.0.1', port: 0
      })).replace(/\/$/u, '')
      const profileStore = new PostgresProfileStore(queryDatabase), resolved = (await profileStore.listResolvedProfiles(nextScenario.profileRef, scopeRef, ctx))[0]
      if (resolved === undefined)
          throw new Error('the actual new profile was not resolved')
      await seedIdentityProject(admin, scopeRef, projectId, definition.ref, definition.ref, { industryPackRef: actualBaseIndustryPackRef, profileRef: actualBaseProfileRef })
      const objects = new FileSystemObjectStore(objectDirectory)
      await objects.init()
      const blobs = new LocalImmutableBlobStore({
          objectStore: objects, registry: queryRegistry
      })
      const p = projectQueryPublicationFixture({
          db: queryDatabase, blobs, structured: structuredStore, scope: scopeRef, ctx, projectId, definition, additionalDefinitions: [next]
      })
      const imported = await p.importCsv(OBJECT_ID, 'code,network,district,due,note\nP-201,private-network,north,true,checked on original source\n', ['facility_id', 'network_code', 'facility_district_code', 'inspection_due', ''])
      await new ProjectService({
          projects: p.projects, readiness: p.readiness, jobs: p.jobs, catalogue: {
              listEntries: async () => [], findPack: async () => undefined
          }
      }).appendRevision(projectId, {
          expectedRevision: '2', approvedInputRef: APPROVED_INPUT_REF, reason: 'freeze the approved old task input'
      }, `task-evolution-input-${projectId}`, ctx.principal.subjectId, ctx)
      const source = await p.restage(imported)
      const publications = await p.approveAndPublish(source)
      for (const publication of publications) await waitForOutboxDispatch(publication.outboxId)
      const backend = new PostgresProjectDatasetAdapter({
          connectionString: businessUrl, schema: 'business_dataset'
      })
      const pack: PackAsset = {
          ref: resolved.resolved.industryRef, manifest: industryManifest, testSuite: base.testSuite
      }
      const identity = createInstanceIdentityWorkflow({
          service: p.instanceService, projects: p.projects, projectDocuments: p.documents, candidates: p.candidates, identityStore: p.identities, schemaSource: p.schemas, identityMappingRef: definition.ref, index: new InMemoryIdentityIndexReader([])
      })
      const evolution = createProjectEvolutionWorkflow({
          projects: p.projects, store: new PostgresProjectEvolutionStore(queryDatabase), mappings: p.mappings, records: p.records, mappingService: p.mappingService, documents: p.documents, catalogue: {
              listEntries: async () => [], findPack: async () => pack
          }, schemas: p.schemas, jobs: p.jobs, facts: p.workflow.materialization, candidates: p.candidates, publications: p.publications, publishedSource: p.publishedSource, readiness: p.readiness, dataset: {
              writer: backend, query: backend
          }, input: {
              writer: createBlobArtifactWriter(blobs), reader: {
                  read: async (request, context) => blobs.readAuthorized({
                      scopeRef, blobRef: request.approvedInputRefs[0]!
                  }, context)
              }, instances: p.instances
          }, profiles: profileStore, instances: identity
      })
      try {
          const old = await evolution.dataset.materialize(projectId, {
              objectId: OBJECT_ID
          }, ctx)
          const start = {
              expectedRevision: '3', industryPackRef: pack.ref, profileRef: {
                  ...resolved.profileRef, snapshotHash: resolved.snapshotHash
              }, strategy: {
                  kind: 'keep_independent' as const, reason: 'human chose independent evolved ontology'
              }, remappings: [{
                      mappingRef: source.mapping.ref, documentId: source.documentId, objectId: OBJECT_ID, entries: [...source.mapping.entries, {
                              fieldRef: 'evolution_note', header: 'note', headerDigest: sha256DigestOf('note'), columnIndex: 4
                          }]
                  }], maxRecords: 1, maxAttempts: 1
          }
          await expect(evolution.service.start(projectId, {
              ...start, profileRef: {
                  ...start.profileRef, snapshotHash: DIGEST
              }
          }, `wrong-profile-${projectId}`, ctx)).rejects.toMatchObject({
              code: 'READINESS_CONFLICT'
          })
          const plan = await evolution.service.start(projectId, start, `normal-task-evolution-${projectId}`, ctx), pending = await evolution.service.rebuild(projectId, plan.plan.evolutionId, ctx)
          expect(pending.state).toBe('awaiting_review')
          await api?.close()
          await composition?.close()
          composition = await createCoreLocalComposition({
              databaseUrl: appUrl, projectDataset: {
                  connectionString: businessUrl, schema: 'business_dataset'
              }, projectEvolution: evolution.service, objectDirectory, scopeRef, examples: extended, allowLocalOperator: true, onWorkerError(error) {
                  if (error instanceof Error)
                      workerErrors.push(error)
              }
          })
          api = createCoreApi(composition.dependencies)
          baseUrl = (await api.listen({
              host: '127.0.0.1', port: 0
          })).replace(/\/$/u, '')
          const deployment = await jsonBody(await request('/api/v1/core/deployment')), profiles = deployment.data['scenarios'] as {
              scenarioId: string
              profileRef: {
                  id: string
                  version: string
              }
          }[]
          const oldProfile = profiles.find((row) => row.scenarioId === SCENARIO_ID)?.profileRef, newProfile = profiles.find((row) => row.scenarioId === nextScenario.scenarioId)?.profileRef
          const postTask = (key: string, profileRef: unknown, revision: ProjectRevisionRef, input: ResourceRef, binding: unknown, fields: readonly string[]) => request('/api/v1/runs', {
              method: 'POST', headers: {
                  'content-type': 'application/json', 'idempotency-key': key
              }, body: JSON.stringify({
                  profileRef, question: 'query the actual reviewed original source', context: {
                      timeZone: 'UTC'
                  }, preferences: {
                      route: 'template', allowWeb: false
                  }, task: {
                      mode: 'task', projectRevisionRef: revision, inputSnapshotRef: input, inputSnapshotDigest: input.digest, taskBindingRef: binding, parameters: {
                          objectId: OBJECT_ID, fields, limit: 10
                      }
                  }
              })
          })
          const admitted = await postTask(`during-evolution-${projectId}`, oldProfile, old.projectRevisionRef, APPROVED_INPUT_REF, structuredBinding.taskBindingRef, FIELDS)
          if (admitted.status !== 202)
              throw new Error(`old-active ordinary admission failed: ${await admitted.text()}`)
          const oldRunId = (await jsonBody(admitted)).data['runId']
          if (typeof oldRunId !== 'string')
              throw new Error('missing old real run')
          const oldAnswer = await waitForAnswer(oldRunId)
          expect((oldAnswer['v3Body'] as {
              assertions: {
                  subject: string
                  predicate: string
                  value: unknown
              }[]
          }).assertions.filter((a) => a.predicate === 'inspection_due').map((a) => [a.subject, a.value])).toEqual([['P-201', true]])
          for (const candidateId of pending.candidateIds) {
              const human = await p.instances.getRecord(scopeRef, projectId, candidateId, ctx)
              if (human === undefined)
                  throw new Error('pending real human instance missing')
              const confirmed = await p.instanceService.confirmFields(scopeRef, projectId, candidateId, {
                  expectedRevision: human.recordRevision, decisions: human.fields.map((field) => ({
                      fieldId: field.fieldId, decision: 'confirm'
                  })), idempotencyKey: `evolve-fields-${candidateId}`
              }, ctx)
              await identity.adjudicateIdentity(scopeRef, projectId, candidateId, {
                  expectedRevision: confirmed.record.recordRevision, kind: 'create', reason: 'human inspected the new source and identity', idempotencyKey: `evolve-identity-${candidateId}`
              }, ctx)
              await p.workflow.publication.reviewCandidate({
                  candidateId, expectedRevision: '0', decision: 'approve', reason: 'human reviewed the new original note field'
              }, ctx)
          }
          await p.workflow.publication.publish({
              approvedCandidateRefs: pending.candidateIds.map((candidateId) => ({
                  candidateId, kind: 'entity' as const
              })), schemaRef: next.ref, expectedRevision: await p.publications.latestPublicationRevision(scopeRef, ctx), idempotencyKey: `new-facts-${projectId}`
          }, ctx)
          const ready = await evolution.service.activate(projectId, plan.plan.evolutionId, [], ctx)
          if (ready.inputSnapshotRef === undefined || ready.snapshots?.[0] === undefined)
              throw new Error('real approved input and ready snapshot not built')
          const revision = await p.projects.getRevision(scopeRef, projectId, ready.plan.targetRevisionRef.revision, ctx)
          if (revision === undefined)
              throw new Error('target revision unavailable')
          expect(revision.profileRef).toEqual(start.profileRef)
          for(const candidateId of pending.candidateIds) await p.workflow.publication.reviewCandidate({candidateId,expectedRevision:await p.publications.latestReviewRevision(scopeRef,candidateId,ctx),decision:'approve',reason:'human reaffirmed unchanged approved input after CAS'},ctx)
      expect(await evolution.service.resolveApprovedInput(scopeRef, revision, ctx)).toEqual(ready.inputSnapshotRef)
          const inputBytes = await blobs.readAuthorized({
              scopeRef, blobRef: ready.inputSnapshotRef
          }, ctx), inputBody: unknown = JSON.parse(new TextDecoder().decode(inputBytes))
          expect(inputBody).toMatchObject({
              schemaVersion: 'project-input-snapshot@1', counts: {
                  total: 1, confirmed: 1, approved: 1, pending: 0, failed: 0
              }, recordPages: [{
                      rowCount: 1
                  }]
          })
          const newBinding = coreScenarioTaskBindings(nextScenario).find((row) => row.kind === 'structured_query')
          if (newBinding === undefined)
              throw new Error('actual new task binding missing')
          const refused = await postTask(`old-input-new-view-${projectId}`, newProfile, revision.ref, APPROVED_INPUT_REF, newBinding.taskBindingRef, ['facility_id', 'evolution_note'])
          expect(refused.status).toBe(409)
          const wrongProfile = await postTask(`old-profile-new-view-${projectId}`, oldProfile, revision.ref, ready.inputSnapshotRef, newBinding.taskBindingRef, ['facility_id', 'evolution_note'])
          expect(wrongProfile.status).toBe(409)
          const nextRun = await postTask(`after-evolution-${projectId}`, newProfile, revision.ref, ready.inputSnapshotRef, newBinding.taskBindingRef, ['facility_id', 'evolution_note', 'inspection_due'])
          if (nextRun.status !== 202)
              throw new Error(`new ordinary admission failed: ${await nextRun.text()}`)
          const newRunId = (await jsonBody(nextRun)).data['runId']
          if (typeof newRunId !== 'string')
              throw new Error('missing new real run')
          const answer = await waitForAnswer(newRunId)
          expect((answer['v3Body'] as {
              assertions: {
                  subject: string
                  predicate: string
                  value: unknown
              }[]
          }).assertions.filter((row) => row.predicate === 'evolution_note').map((row) => [row.subject, row.value])).toEqual([['P-201', 'checked on original source']])
          const archived = await new PostgresRunExecutionBindingStore(queryDatabase).getBindingByRun(scopeRef, newRunId, ctx)
          expect(archived?.binding.projectDatasetSnapshotRef).toEqual(ready.snapshots[0].snapshotRef)
          expect((await jsonBody(await request(`/api/v1/runs/${oldRunId}/answer`))).data['v3Body']).toEqual(oldAnswer['v3Body'])
          expect((await evolution.dataset.query({
              projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef!
          }, ctx)).rows[0]?.values['evolution_note']).toBeUndefined()
      }
      finally {
          await backend.close()
      }
  }, 180000)
  it('runs the deterministic semantic plan and publishes a read-back answer-draft@3', async () => {
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const mountedScenario = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)
    if (mountedScenario === undefined) throw new Error('the transport scenario was not exposed')

    const runResponse = await request('/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `taskbind-structured-${PROJECT_ID}` },
      body: JSON.stringify({
        profileRef: mountedScenario.profileRef,
        question: 'structured query over the materialised snapshot',
        context: { timeZone: 'UTC' },
        preferences: { route: 'template', allowWeb: false },
        task: {
          mode: 'task',
          projectRevisionRef: projectRevisionRefValue,
          inputSnapshotRef: APPROVED_INPUT_REF,
          inputSnapshotDigest: APPROVED_INPUT_REF.digest,
          taskBindingRef: structuredBinding.taskBindingRef,
          parameters: { objectId: OBJECT_ID, fields: [...FIELDS], limit: 10 },
        },
      }),
    })
    if (runResponse.status !== 202) throw new Error(`task run admission failed: ${await runResponse.text()}`)
    const runId = (await jsonBody(runResponse)).data['runId']
    if (typeof runId !== 'string') throw new Error('task run admission returned no run id')

    const answer = await waitForAnswer(runId)
    originalAnswer = answer
    originalRunId = runId
    const assertions = (answer['v3Body'] as { assertions: { subject: string; predicate: string; value: unknown }[] }).assertions
    expect(assertions.filter((assertion) => assertion.predicate === 'inspection_due').map((assertion) => [assertion.subject, assertion.value]).sort()).toEqual([['P-101', true], ['P-102', false]])
    const v3Body = answer['v3Body'] as {
      schemaVersion: string
      resultManifestRef: ResourceRef
      resultManifestDigest: string
      finalizationReceiptRef: ResourceRef
      finalizationReceiptDigest: string
      executionBindingRef: ResourceRef
      blocks: unknown[]
    }
    expect(v3Body.schemaVersion).toBe('answer-draft@3')
    const controlTables = await admin?.query<{ count: string }>("SELECT count(*)::text FROM information_schema.tables WHERE table_name IN ('project_dataset_snapshots','project_dataset_rows')")
    expect(controlTables?.rows[0]?.count).toBe('0')
    expect(v3Body.resultManifestRef.digest).toBe(v3Body.resultManifestDigest)
    expect(v3Body.finalizationReceiptRef.digest).toBe(v3Body.finalizationReceiptDigest)
    expect(v3Body.executionBindingRef.kind).toBe('plan')
    expect(v3Body.blocks.length).toBeGreaterThan(0)
    const answerId = answer['answerId']
    if (typeof answerId !== 'string') throw new Error('the published answer carried no answerId')

    const result = await request(`/api/v1/answers/${encodeURIComponent(answerId)}/result`)
    if (result.status !== 200) throw new Error(`verified result read failed: ${await result.text()}`)
    expect((await jsonBody(result)).data['answerId']).toBe(answerId)

    const history = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/history`)
    if (history.status !== 200) throw new Error(`result history failed: ${await history.text()}`)
    const historyBody = await jsonBody(history)
    expect(historyBody.data['currentAnswerId']).toBe(answerId)
    expect((historyBody.data['entries'] as unknown[]).length).toBeGreaterThanOrEqual(1)

    const exported = await request(`/api/v1/runs/${encodeURIComponent(runId)}/answer/export?format=json`)
    if (exported.status !== 200) throw new Error(`verified export failed: ${await exported.text()}`)
    const exportedBody = await jsonBody(exported)
    const versions = exportedBody.data['versions'] as { answerId: string; contentHash: string }
    expect(versions.answerId).toBe(answerId)
    expect(versions.contentHash).toBe(answer['contentHash'])
    expect(workerErrors.map((error) => ({ name: error.name, message: error.message, cause: error.cause instanceof Error ? error.cause.message : error.cause }))).toEqual([])
  }, 180_000)

  it('imports a structured source for a project and previews column mapping on the real parse', async () => {
    const bootstrapped = await request('/api/v1/core/project-bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'W06 mapping preview isolation', profileRef: { id: actualBaseProfileRef.id, version: actualBaseProfileRef.version } }) })
    if (bootstrapped.status !== 201) throw new Error(`independent preview project bootstrap failed: ${await bootstrapped.text()}`)
    const previewProject = (await jsonBody(bootstrapped)).data['project']
    if (!isRecord(previewProject) || typeof previewProject['projectId'] !== 'string') throw new Error('independent preview project bootstrap returned no project identity')
    const previewProjectId = previewProject['projectId']
    const content = JSON.stringify([
      { facility_id: 'T-01', inspection_due: true },
      { facility_id: 'T-02', inspection_due: false },
    ])
    const imported = await request(`/api/v1/projects/${previewProjectId}/structured-imports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `taskbind-import-${previewProjectId}` },
      body: JSON.stringify({ format: 'json', mediaType: 'application/json', content }),
    })
    if (imported.status !== 201) throw new Error(`structured import failed: ${await imported.text()}`)
    const importBody = await jsonBody(imported)
    const parseId = importBody.data['parseId']
    const originalRef = importBody.data['originalRef']
    if (typeof parseId !== 'string' || typeof originalRef !== 'object' || originalRef === null) {
      throw new Error('the structured import returned no parseId/originalRef')
    }
    expect(importBody.data['format']).toBe('json')
    const counts = importBody.data['counts'] as { total: number; succeeded: number }
    expect(counts.total).toBeGreaterThanOrEqual(2)

    const headerDigest = (header: string): string => sha256DigestOf(header)
    const preview = await request(`/api/v1/projects/${previewProjectId}/mappings/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'json',
        parseId,
        originalRef,
        originalMediaType: 'application/json',
        options: {},
        objectId: OBJECT_ID,
        entries: [
          { fieldRef: 'facility_id', header: 'facility_id', headerDigest: headerDigest('facility_id'), columnIndex: 0 },
          { fieldRef: 'inspection_due', header: 'inspection_due', headerDigest: headerDigest('inspection_due'), columnIndex: 1 },
        ],
      }),
    })
    if (preview.status !== 200) throw new Error(`mapping preview failed: ${await preview.text()}`)
    expect((await jsonBody(preview)).data['preview']).toBeDefined()
  }, 120_000)
  it('keeps authorized P1 history across another object and retraction rebuilds in the SAME project revision and restart', async () => {
    const ctx = trustedContext(scopeRef)
    const executions = new PostgresRunExecutionBindingStore(queryDatabase)
    const archived = await executions.getBindingByRun(scopeRef, originalRunId, ctx)
    const originalRef = archived?.binding.projectDatasetSnapshotRef
    if (archived === undefined || originalRef === undefined) throw new Error('the original execution is missing')
    const district = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: 'transport_district' }) })
    if (district.status !== 201) {
      const responseBody = await district.text()
      const provenance = await sameRevisionProvenanceDiagnostic('transport_district')
      throw new Error(`same-revision district projection failed: ${responseBody}; pinDiagnostic=${canonicalJson(provenance)}`)
    }
    expect(((await jsonBody(district)).data['status'] as { projectRevisionRef: ProjectRevisionRef }).projectRevisionRef).toEqual(projectRevisionRefValue)
    await api?.close(); await composition?.close()
    composition = await createCoreLocalComposition({ databaseUrl: appUrl, projectDataset: { connectionString: businessUrl, schema: 'business_dataset' }, objectDirectory, scopeRef, examples: loadCoreExamples({ targetScopeRef: scopeRef }), allowLocalOperator: true })
    api = createCoreApi(composition.dependencies)
    baseUrl = (await api.listen({ host: '127.0.0.1', port: 0 })).replace(/\/$/u, '')
    const backend = new PostgresProjectDatasetAdapter({ connectionString: businessUrl, schema: 'business_dataset' })
    const oldCtx = createToolContext({ ...ctx, runId: originalRunId, allowedResources: { ...ctx.allowedResources, sourceRefs: [{ namespace: 'project-dataset', sourceId: originalRef.id }] } })
    const workflow = createCoreProjectQueryWorkflow({ query: backend, publishedSource: publishedFixture.publishedSource, projects: publishedFixture.projects, readiness: publishedFixture.readiness,
      executionBindings: executions, taskBindings: new PostgresPublishedTaskBindingStore(queryDatabase), definition: async () => publishedFixture.definition })
    const replay = async () => {
      const descriptor = await workflow.resolveExecution(archived.binding, OBJECT_ID, oldCtx)
      const outcome = await workflow.handler({ toolId: 'data_query', execute: async () => { throw new Error('historical startup fallback') } }).execute({ callId: randomUUID(), toolId: 'data_query', ctx: oldCtx,
        deadline: oldCtx.deadline, traceId: oldCtx.traceId, signal: new AbortController().signal, resultLimits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 30_000 },
        arguments: { kind: 'query', mode: 'semantic', queryPlan: { mode: 'semantic', concepts: [OBJECT_ID], fields: [...FIELDS, 'record_id', 'sources_json'], links: [], filters: [], orderBy: [{ fieldRef: 'record_id', direction: 'asc' }], limit: 10, mappingVersion: workflow.mappingRef({ descriptor }) } } })
      expect((outcome.payload as DataQueryOutput).table?.rows.map((row) => [row[0], row[1]]).sort()).toEqual([['P-101', true], ['P-102', false]])
    }
    try {
      await replay()
      const revision = await publishedFixture.projects.getRevision(scopeRef, PROJECT_ID, projectRevisionRefValue.revision, ctx)
      if (revision === undefined) throw new Error('the original revision disappeared')
      await expect(workflow.resolveForCreation(scopeRef, revision, { objectId: OBJECT_ID }, ctx)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
      const withdrawn = initialSource.entities.find((candidate) => candidate.attributes.some((attribute) => attribute.attributeId === 'facility_id' && attribute.value === 'P-101'))
      if (withdrawn === undefined) throw new Error('missing original P-101 source')
      await publishedFixture.workflow.publication.reviseStatement({ statementId: withdrawn.candidateId, kind: 'retraction', expectedRevision: '1', idempotencyKey: `same-revision-withdraw-${PROJECT_ID}`, reason: 'human withdrew one official support' }, ctx)
      const rebuilt = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: OBJECT_ID }) })
      if (rebuilt.status !== 201) throw new Error(`same-revision retraction rebuild failed: ${await rebuilt.text()}`)
      const next = (await jsonBody(rebuilt)).data['status'] as { projectRevisionRef: ProjectRevisionRef; snapshotRef: ResourceRef }
      expect(next.projectRevisionRef).toEqual(projectRevisionRefValue)
      expect(next.snapshotRef).not.toEqual(originalRef)
      expect(await workflow.resolveForCreation(scopeRef, revision, { objectId: OBJECT_ID }, ctx)).toEqual(next.snapshotRef)
      const deployment = await jsonBody(await request('/api/v1/core/deployment'))
      const profileRef = (deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]).find((scenario) => scenario.scenarioId === SCENARIO_ID)?.profileRef
      const admitted = await request('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `same-revision-current-${PROJECT_ID}` }, body: JSON.stringify({
        profileRef, question: 'query the current same-revision published snapshot', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false },
        task: { mode: 'task', projectRevisionRef: projectRevisionRefValue, inputSnapshotRef: APPROVED_INPUT_REF, inputSnapshotDigest: APPROVED_INPUT_REF.digest, taskBindingRef: structuredBinding.taskBindingRef, parameters: { objectId: OBJECT_ID, fields: [...FIELDS], limit: 10 } },
      }) })
      if (admitted.status !== 202) throw new Error(`same-revision current admission failed: ${await admitted.text()}`)
      const newRunId = (await jsonBody(admitted)).data['runId']
      if (typeof newRunId !== 'string') throw new Error('the new same-revision run is missing')
      expect((await executions.getBindingByRun(scopeRef, newRunId, ctx))?.binding.projectDatasetSnapshotRef).toEqual(next.snapshotRef)
      const currentAnswer = await waitForAnswer(newRunId)
      const assertions = (currentAnswer['v3Body'] as { assertions: { subject: string; predicate: string; value: unknown }[] }).assertions
      expect(assertions.filter((assertion) => assertion.predicate === 'inspection_due').map((assertion) => [assertion.subject, assertion.value])).toEqual([['P-102', false]])

      await replay()
      const historical = await jsonBody(await request(`/api/v1/runs/${originalRunId}/answer`))
      expect(historical.data['v3Body']).toEqual(originalAnswer['v3Body'])
    } finally { await backend.close() }
  }, 180_000)

  it('changes the normal task result for new published input while the old run keeps its fixed history after restart', async () => {
    const source = await publishedFixture.importCsv(OBJECT_ID, 'code,network,district,due\nP-103,private-network,north,false\n', ['facility_id', 'network_code', 'facility_district_code', 'inspection_due'])
    await publishedFixture.approveAndPublish(source)
    const projected = await request(`/api/v1/projects/${PROJECT_ID}/dataset-snapshots`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectId: OBJECT_ID }) })
    if (projected.status !== 201) throw new Error(`new official dataset creation failed: ${await projected.text()}`)
    const currentRevision = ((await jsonBody(projected)).data['status'] as { projectRevisionRef: ProjectRevisionRef }).projectRevisionRef
    const deployment = await jsonBody(await request('/api/v1/core/deployment'))
    const scenarios = deployment.data['scenarios'] as { scenarioId: string; profileRef: { id: string; version: string } }[]
    const profile = scenarios.find((entry) => entry.scenarioId === SCENARIO_ID)?.profileRef
    const response = await request('/api/v1/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `taskbind-new-${PROJECT_ID}` }, body: JSON.stringify({
      profileRef: profile, question: 'query the new published input', context: { timeZone: 'UTC' }, preferences: { route: 'template', allowWeb: false },
      task: { mode: 'task', projectRevisionRef: currentRevision, inputSnapshotRef: APPROVED_INPUT_REF, inputSnapshotDigest: APPROVED_INPUT_REF.digest,
        taskBindingRef: structuredBinding.taskBindingRef, parameters: { objectId: OBJECT_ID, fields: [...FIELDS], limit: 10 } },
    }) })
    if (response.status !== 202) throw new Error(`new query run admission failed: ${await response.text()}`)
    const runId = (await jsonBody(response)).data['runId']
    if (typeof runId !== 'string') throw new Error('missing new run')
    const answer = await waitForAnswer(runId)
    const assertions = (answer['v3Body'] as { assertions: { subject: string; predicate: string; value: unknown }[] }).assertions
    expect(assertions.filter((assertion) => assertion.predicate === 'inspection_due').map((assertion) => [assertion.subject, assertion.value])).toEqual([['P-103', false]])
    await api?.close()
    await composition?.close()
    composition = await createCoreLocalComposition({ databaseUrl: appUrl, projectDataset: { connectionString: businessUrl, schema: 'business_dataset' }, objectDirectory, scopeRef, examples: loadCoreExamples({ targetScopeRef: scopeRef }), allowLocalOperator: true })
    api = createCoreApi(composition.dependencies)
    baseUrl = (await api.listen({ host: '127.0.0.1', port: 0 })).replace(/\/$/u, '')
    const historical = await jsonBody(await request(`/api/v1/runs/${originalRunId}/answer`))
    expect(historical.data['contentHash']).toBe(originalAnswer['contentHash'])
    expect(historical.data['v3Body']).toEqual(originalAnswer['v3Body'])
    // Resume the old tool from its actual archived binding. Its ready historical descriptor
    // must survive the new head and backend restart without resolving the current snapshot.
    const executions = new PostgresRunExecutionBindingStore(queryDatabase)
    const oldBinding = await executions.getBindingByRun(scopeRef, originalRunId, trustedContext(scopeRef))
    const oldRef = oldBinding?.binding.projectDatasetSnapshotRef
    if (oldBinding === undefined || oldRef === undefined) throw new Error('the original query snapshot was not archived')
    const oldCtx = createToolContext({ ...trustedContext(scopeRef), runId: originalRunId, allowedResources: { ...trustedContext(scopeRef).allowedResources, sourceRefs: [{ namespace: 'project-dataset', sourceId: oldRef.id }] } })
    const backend = new PostgresProjectDatasetAdapter({ connectionString: businessUrl, schema: 'business_dataset' })
    try {
      const workflow = createCoreProjectQueryWorkflow({ query: backend, publishedSource: publishedFixture.publishedSource,
        projects: publishedFixture.projects, readiness: publishedFixture.readiness, executionBindings: executions,
        taskBindings: new PostgresPublishedTaskBindingStore(queryDatabase), definition: async () => publishedFixture.definition })
      const descriptor = await workflow.resolveExecution(oldBinding.binding, OBJECT_ID, oldCtx)
      expect(descriptor.snapshotRef).toEqual(oldRef)
      const outcome = await workflow.handler({ toolId: 'data_query', execute: async () => { throw new Error('the old project query attempted startup fallback') } }).execute({
        callId: randomUUID(), toolId: 'data_query', ctx: oldCtx, deadline: oldCtx.deadline, traceId: oldCtx.traceId,
        signal: new AbortController().signal, resultLimits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 30_000 },
        arguments: { kind: 'query', mode: 'semantic', queryPlan: { mode: 'semantic', concepts: [OBJECT_ID], fields: [...FIELDS, 'record_id', 'sources_json'],
          links: [], filters: [], orderBy: [{ fieldRef: 'record_id', direction: 'asc' }], limit: 10, mappingVersion: workflow.mappingRef({ descriptor }) } },
      })
      expect((outcome.payload as DataQueryOutput).table?.rows.map((row) => [row[0], row[1]]).sort()).toEqual([['P-101', true], ['P-102', false]])
      expect((outcome.payload as DataQueryOutput).table?.rows.every((row) => String(row[3]).includes(projectRevisionRefValue.digest))).toBe(true)
      await expect(workflow.resolveForCreation(scopeRef, (await publishedFixture.projects.getRevision(scopeRef, PROJECT_ID, projectRevisionRefValue.revision, oldCtx))!, { objectId: OBJECT_ID }, oldCtx)).rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE' })
    } finally { await backend.close() }

  }, 180_000)

})
