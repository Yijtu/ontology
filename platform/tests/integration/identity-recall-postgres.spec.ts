import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresCandidateStore,
  PostgresJobStore,
  PostgresProjectStore,
  PostgresProjectDocumentStore,
  PostgresInstanceReviewStore,
  PostgresIdentityDecisionStore,
  PostgresSemanticPublicationStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  BusinessPostgresDatabase,
  PostgresQueryAdapter,
} from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import {
  DocumentSpanReader,
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
} from '@ontology/adapter-extraction-document'
import {
  Bm25DocumentSearchService,
  Bm25IndexBuilder,
  PostgresKeywordIndexStore,
} from '@ontology/adapter-search-bm25'
import { InMemoryIndustrySchemaSource, InstanceReviewService, JobService } from '@ontology/application'
import { createApiServer, createInstanceIdentityWorkflow } from '@ontology/app-api'
import type { InstanceIdentityWorkflow } from '@ontology/app-api'
import { seedIdentityProject } from './instance-identity-fixtures'
import { createToolContext } from '@ontology/contracts'
import type {
  EntityCandidate,
  AppendInstanceRecordInput,
  InstanceRecordView,
  SourceObjectRef,
  SourceRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  EntityCandidateRecallService,
  IdentityDecisionService,
  SemanticPublicationService,
  InMemorySemanticMappingRegistry,
  StructuredIdentityIndexReader,
} from '@ontology/semantic-engine'
import type {
  IdentityIndexProfile,
  SemanticMapping,
} from '@ontology/semantic-engine'
import { buildIndustrySchema, textSpan } from '../unit/extraction-fixtures'
import { IDENTITY_DEFINITION_REF } from '../unit/identity-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

// Real containerised PostgreSQL, real blob-local and a real BM25 index are slower than
// the default budget; other integration suites run in parallel in this workspace.
vi.setConfig({ testTimeout: 120_000 })

const BUSINESS_SOURCE: SourceRef = { namespace: 'identity-test', sourceId: 'identity-index' }
const IDENTITY_OBJECT: SourceObjectRef = { sourceRef: BUSINESS_SOURCE, objectPath: 'public.identity_index' }
const IDENTITY_MAPPING_REF: VersionRef = {
  id: 'identity.index',
  version: '1.0.0',
  digest: `sha256:${'9'.repeat(64)}`,
}

const DIMENSIONS = { source: 'docs', site: 'site-a', device_type: 'charger' } as const

const IDENTITY_MAPPING: SemanticMapping = {
  mappingRef: IDENTITY_MAPPING_REF,
  dialect: 'postgres',
  objects: [
    {
      conceptId: 'identity_index',
      sourceObjectRef: IDENTITY_OBJECT,
      schema: 'public',
      relation: 'identity_index',
      relationKind: 'table',
      estimatedRows: 1000,
      fields: [
        { fieldRef: 'entity_id', column: 'entity_id', valueType: 'string' },
        { fieldRef: 'object_id', column: 'object_id', valueType: 'string' },
        { fieldRef: 'identity_scope_id', column: 'identity_scope_id', valueType: 'string' },
        { fieldRef: 'native_id', column: 'native_id', valueType: 'string' },
        { fieldRef: 'display_name', column: 'display_name', valueType: 'string' },
        { fieldRef: 'normalized_name', column: 'normalized_name', valueType: 'string' },
        { fieldRef: 'alias', column: 'alias', valueType: 'string' },
        { fieldRef: 'alias_normalized', column: 'alias_normalized', valueType: 'string' },
        { fieldRef: 'alias_confirmed', column: 'alias_confirmed', valueType: 'boolean' },
        { fieldRef: 'alias_valid_from', column: 'alias_valid_from', valueType: 'timestamp' },
        { fieldRef: 'alias_valid_to', column: 'alias_valid_to', valueType: 'timestamp' },
        { fieldRef: 'site', column: 'site', valueType: 'string' },
        { fieldRef: 'entity_type', column: 'entity_type', valueType: 'string' },
        { fieldRef: 'device_type', column: 'device_type', valueType: 'string' },
        { fieldRef: 'source_dim', column: 'source_dim', valueType: 'string' },
        { fieldRef: 'project_dim', column: 'project_dim', valueType: 'string' },
        { fieldRef: 'valid_from', column: 'valid_from', valueType: 'timestamp' },
        { fieldRef: 'valid_to', column: 'valid_to', valueType: 'timestamp' },
        { fieldRef: 'tenant_id', column: 'tenant_id', valueType: 'string' },
        { fieldRef: 'space_id', column: 'space_id', valueType: 'string' },
      ],
    },
  ],
  links: [],
}

const IDENTITY_PROFILE: IdentityIndexProfile = {
  mappingRef: IDENTITY_MAPPING_REF,
  conceptId: 'identity_index',
  fields: {
    entityId: 'entity_id',
    objectId: 'object_id',
    identityScopeId: 'identity_scope_id',
    nativeId: 'native_id',
    displayName: 'display_name',
    normalizedName: 'normalized_name',
    alias: 'alias',
    aliasNormalized: 'alias_normalized',
    aliasConfirmed: 'alias_confirmed',
    aliasValidFrom: 'alias_valid_from',
    aliasValidTo: 'alias_valid_to',
    site: 'site',
    entityType: 'entity_type',
    validFrom: 'valid_from',
    validTo: 'valid_to',
    tenantId: 'tenant_id',
    spaceId: 'space_id',
  },
  dimensionFieldRefs: { source: 'source_dim', site: 'site', device_type: 'device_type', project: 'project_dim' },
}

interface SeedRow {
  readonly entityId: string
  readonly nativeId: string | null
  readonly displayName: string
  readonly normalizedName: string
  readonly alias: string | null
  readonly aliasNormalized: string | null
  readonly aliasConfirmed: boolean
  readonly aliasValidFrom: string | null
  readonly aliasValidTo: string | null
  readonly tenantId: string
  readonly spaceId: string
  readonly site: string
  readonly deviceType: string
}

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function contextFor(
  tenantId: string,
  spaceId: string,
  collectionRefs: readonly string[],
): ToolContext {
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'identity-recall-it',
      roles: ['semantic-reviewer', 'semantic-publisher', 'data-editor'],
      scopes: [],
      authEpoch: 1,
    },
    runId: randomUUID(),
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '1.0.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId: randomUUID(),
      grantedAt: '2026-09-22T00:00:00Z',
      expiresAt: '2026-09-22T01:00:00Z',
    },
    allowedResources: {
      tenantId,
      spaceId,
      resourceKinds: ['document', 'chunk', 'artifact'],
      sourceRefs: [BUSINESS_SOURCE],
      collectionRefs: [...collectionRefs],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-identity-recall-it',
  })
}

let harness: JobDbHarness
let scope: JobTestScope
let otherScope: JobTestScope
let ctx: ToolContext
let businessDb: BusinessPostgresDatabase
let adapter: PostgresQueryAdapter
let parseStore: PostgresDocumentParseStore
let indexStore: PostgresKeywordIndexStore
let candidateStore: PostgresCandidateStore
let controlDatabase: ControlPostgresDatabase
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let parseService: LocalDocumentExtractionService
let searchService: Bm25DocumentSearchService
let recall: EntityCandidateRecallService
let mention: EntityCandidate
let collection = ''
let businessWriter: Client
let workflow: InstanceIdentityWorkflow
let workflowApp: ReturnType<typeof createApiServer>
let workflowCandidate: EntityCandidate
let projectDocuments: PostgresProjectDocumentStore
let identityStore: PostgresIdentityDecisionStore
let publicationService: SemanticPublicationService
const workflowProject = randomUUID()
const foreignProject = randomUUID()
let workflowDocument = ''
let workflowOtherDocument = ''
let workflowRecord: InstanceRecordView
const WORKFLOW_REF: VersionRef = { ...IDENTITY_DEFINITION_REF, id: 'workflow.devices' }


const SEED_ROWS: readonly SeedRow[] = [
  { entityId: 'E-A', nativeId: 'DEV-1', displayName: 'Charger Alpha', normalizedName: 'charger alpha', alias: null, aliasNormalized: null, aliasConfirmed: false, aliasValidFrom: null, aliasValidTo: null, tenantId: '', spaceId: '', site: 'site-a', deviceType: 'charger' },
  { entityId: 'E-B', nativeId: 'DEV-2', displayName: 'Shared Charger', normalizedName: 'shared charger', alias: null, aliasNormalized: null, aliasConfirmed: false, aliasValidFrom: null, aliasValidTo: null, tenantId: '', spaceId: '', site: 'site-a', deviceType: 'charger' },
  { entityId: 'E-SITE', nativeId: 'DEV-3', displayName: 'Shared Charger', normalizedName: 'shared charger', alias: null, aliasNormalized: null, aliasConfirmed: false, aliasValidFrom: null, aliasValidTo: null, tenantId: '', spaceId: '', site: 'site-b', deviceType: 'charger' },
  { entityId: 'E-TYPE', nativeId: 'DEV-4', displayName: 'Shared Charger', normalizedName: 'shared charger', alias: null, aliasNormalized: null, aliasConfirmed: false, aliasValidFrom: null, aliasValidTo: null, tenantId: '', spaceId: '', site: 'site-a', deviceType: 'inverter' },
  { entityId: 'E-ALIAS', nativeId: null, displayName: 'Charger A', normalizedName: 'charger a', alias: 'Charger Alias', aliasNormalized: 'charger alias', aliasConfirmed: true, aliasValidFrom: '2020-01-01T00:00:00Z', aliasValidTo: '9999-12-31T00:00:00Z', tenantId: '', spaceId: '', site: 'site-a', deviceType: 'charger' },
  { entityId: 'E-HIST', nativeId: null, displayName: 'Charger Historical', normalizedName: 'charger historical', alias: 'Old Charger', aliasNormalized: 'old charger', aliasConfirmed: true, aliasValidFrom: '2019-01-01T00:00:00Z', aliasValidTo: '2020-01-01T00:00:00Z', tenantId: '', spaceId: '', site: 'site-a', deviceType: 'charger' },
  { entityId: 'E-TRUNC-1', nativeId: null, displayName: 'Truncated Name', normalizedName: 'truncated name', alias: null, aliasNormalized: null, aliasConfirmed: false, aliasValidFrom: null, aliasValidTo: null, tenantId: '', spaceId: '', site: 'site-a', deviceType: 'charger' },
  { entityId: 'E-TRUNC-2', nativeId: null, displayName: 'Truncated Name', normalizedName: 'truncated name', alias: null, aliasNormalized: null, aliasConfirmed: false, aliasValidFrom: null, aliasValidTo: null, tenantId: '', spaceId: '', site: 'site-a', deviceType: 'charger' },
]

async function insertSeedRows(client: Client, tenantId: string, spaceId: string, prefix: string): Promise<void> {
  for (const row of SEED_ROWS) {
    await client.query(
      `INSERT INTO public.identity_index (
         tenant_id, space_id, entity_id, object_id, identity_scope_id, native_id,
         display_name, normalized_name, alias, alias_normalized, alias_confirmed,
         alias_valid_from, alias_valid_to, site, entity_type, device_type, source_dim,
         valid_from, valid_to
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        tenantId,
        spaceId,
        `${prefix}${row.entityId}`,
        'device',
        'device_identity',
        row.nativeId,
        row.displayName,
        row.normalizedName,
        row.alias,
        row.aliasNormalized,
        row.aliasConfirmed,
        row.aliasValidFrom,
        row.aliasValidTo,
        row.site,
        'device',
        row.deviceType,
        'docs',
        '2018-01-01T00:00:00Z',
        '9999-12-31T00:00:00Z',
      ],
    )
  }
}

function textDocument(): Uint8Array {
  return new TextEncoder().encode(
    [
      'SERVICE TERMS',
      '1.1 The shared charger is monitored by the operator.',
      '1.2 The shared charger warranty covers five years.',
    ].join('\n'),
  )
}

async function publishAndParse(ctxValue: ToolContext): Promise<Awaited<ReturnType<LocalDocumentExtractionService['parse']>>> {
  const bytes = textDocument()
  const staged = await blobStore.stage(bytes, { scopeRef: scope.scopeRef }, ctxValue)
  const published = await blobStore.publish(
    {
      scopeRef: scope.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    ctxValue,
  )
  return parseService.parse({ scopeRef: scope.scopeRef, originalRef: published.blobRef }, ctxValue)
}

beforeAll(async () => {
  harness = await startJobDatabase()
  await runControlMigrations({ connectionString: harness.adminUrl, migrationsDir: MIGRATIONS_DIR })
  scope = await createJobScope(harness.adminClient, 'identity-recall')
  collection = `manuals/identity-${scope.spaceId.slice(0, 8)}`
  ctx = contextFor(scope.tenantId, scope.spaceId, [collection])

  // A dedicated business database reached through an independent read-only role.
  const businessDbName = `identity_business_${String(process.pid)}_${randomBytes(3).toString('hex')}`
  const readerRole = `identity_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`
  await harness.adminClient.query(`CREATE DATABASE ${businessDbName}`)
  const readerPassword = `throwaway_${randomBytes(8).toString('hex')}`
  await harness.adminClient.query(`CREATE ROLE ${readerRole} LOGIN PASSWORD '${readerPassword}'`)
  const businessAdminUrl = connectionStringFor(
    harness.adminUrl,
    'postgres',
    new URL(harness.adminUrl).password,
    businessDbName,
  )
  const businessAdmin = new Client({ connectionString: businessAdminUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE TABLE public.identity_index (
      tenant_id text NOT NULL,
      space_id text NOT NULL,
      entity_id text NOT NULL,
      object_id text NOT NULL,
      identity_scope_id text NOT NULL,
      native_id text,
      display_name text NOT NULL,
      normalized_name text NOT NULL,
      alias text,
      alias_normalized text,
      alias_confirmed boolean NOT NULL DEFAULT false,
      alias_valid_from timestamptz,
      alias_valid_to timestamptz,
      site text,
      entity_type text NOT NULL,
      device_type text NOT NULL,
      source_dim text NOT NULL,
      project_dim text NOT NULL DEFAULT 'legacy',
      valid_from timestamptz NOT NULL,
      valid_to timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, space_id, entity_id)
    )
  `)
  await insertSeedRows(businessAdmin, scope.tenantId, scope.spaceId, '')
  // A same-name entity in a different tenant/space must never leak into this recall.
  otherScope = await createJobScope(harness.adminClient, 'identity-recall-other')
  await insertSeedRows(businessAdmin, otherScope.tenantId, otherScope.spaceId, 'OTHER-')
  await businessAdmin.query(`GRANT USAGE ON SCHEMA public TO ${readerRole}`)
  await businessAdmin.query(`GRANT SELECT ON public.identity_index TO ${readerRole}`)
  await businessAdmin.query('UPDATE public.identity_index SET project_dim=$1 WHERE tenant_id=$2', [workflowProject, scope.tenantId])
  businessWriter = businessAdmin

  businessDb = new BusinessPostgresDatabase({
    connectionString: connectionStringFor(harness.adminUrl, readerRole, readerPassword, businessDbName),
    maxPoolSize: 4,
  })
  const businessMappings: BusinessObjectMapping[] = [
    { objectRef: IDENTITY_OBJECT, schema: 'public', relation: 'identity_index', relationKind: 'table' },
  ]
  adapter = new PostgresQueryAdapter({ database: businessDb, mappings: businessMappings, sourceRef: BUSINESS_SOURCE })

  // Real control stores: parse, keyword index and extraction candidates.
  objectDir = await mkdtemp(join(tmpdir(), 'identity-recall-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  parseStore = new PostgresDocumentParseStore({ connectionString: harness.appUrl, maxPoolSize: 4 })
  indexStore = new PostgresKeywordIndexStore({ connectionString: harness.appUrl, maxPoolSize: 4 })
  controlDatabase = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  candidateStore = new PostgresCandidateStore(controlDatabase)
  const jobService = new JobService({ store: new PostgresJobStore(controlDatabase), newId: () => randomUUID() })
  parseService = new LocalDocumentExtractionService({
    blobs: blobStore,
    store: parseStore,
    now: () => '2026-09-22T00:00:00Z',
  })
  const spanReader = new DocumentSpanReader({ blobs: blobStore, store: parseStore, now: () => '2026-09-22T00:00:01Z' })
  searchService = new Bm25DocumentSearchService({ indexStore, spanReader, now: () => '2026-09-22T00:00:02Z' })

  const parsed = await publishAndParse(ctx)
  const builder = new Bm25IndexBuilder({ parseStore, indexStore, now: () => '2026-09-22T00:00:03Z' })
  const built = await builder.build({ collectionRef: collection, parses: [parsed] }, ctx)
  await builder.activate(collection, built.generation.generation, ctx)

  const chunk = parsed.chunks[0]
  if (chunk === undefined) throw new Error('the parsed document produced no chunks')
  const jobId = randomUUID()
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'identity-recall-source',
      documentRef: parsed.parseId,
      pipelineVersion: '1.0.0',
      idempotencyKey: `identity-recall-${jobId.slice(0, 8)}`,
    },
    ctx,
  )
  mention = {
    kind: 'entity',
    candidateId: randomUUID(),
    jobId,
    objectId: 'device',
    identityScopeId: 'device_identity',
    attributes: [{ attributeId: 'device_name', value: 'Shared Charger' }],
    sourceSpans: [
      {
        parseId: parsed.parseId,
        chunkId: chunk.chunkId,
        locator: chunk.locator,
        spanKind: chunk.spanKind,
        precision: chunk.precision,
        quoteDigest: chunk.quoteDigest,
        textDigest: chunk.textDigest,
      },
    ],
    deterministic: false,
    state: 'pending_review',
    issues: [],
    inputVersion: {
      definitionRef: IDENTITY_DEFINITION_REF,
      parseId: parsed.parseId,
      parserVersion: parsed.parserVersion,
      pipelineVersion: '1.0.0',
    },
    idempotencyKey: `sha256:${'b'.repeat(64)}`,
    recordedAt: '2026-09-22T00:00:04Z',
  }
  await candidateStore.insertCandidates(scope.scopeRef, [mention], ctx)

  const reader = new StructuredIdentityIndexReader({
    query: adapter,
    catalog: adapter,
    mappings: new InMemorySemanticMappingRegistry([IDENTITY_MAPPING]),
    profile: IDENTITY_PROFILE,
    compileBudget: { maxRows: 1000, maxBytes: 1_048_576, maxJoinFanout: 1000 },
    now: () => '2026-09-22T00:00:05Z',
  })
  recall = new EntityCandidateRecallService({
    schemaSource: new InMemoryIndustrySchemaSource([
      { ref: IDENTITY_DEFINITION_REF, schema: buildIndustrySchema(IDENTITY_DEFINITION_REF) },
    ]),
    index: reader,
    documents: searchService,
  })

  const schema = buildIndustrySchema(WORKFLOW_REF)
  const workflowSchema = {
    ...schema,
    objects: schema.objects.map((object) => object.objectId !== 'device' ? object : {
      ...object,
      attributes: [...object.attributes, ...Object.keys(DIMENSIONS).map((attributeId) => ({ attributeId, valueType: 'string' as const, minCardinality: 1, maxCardinality: 1, identityKey: false }))],
    }),
  }
  const schemaSource = new InMemoryIndustrySchemaSource([{ ref: WORKFLOW_REF, schema: workflowSchema }])
  const projects = new PostgresProjectStore(controlDatabase)
  projectDocuments = new PostgresProjectDocumentStore(controlDatabase)
  identityStore = new PostgresIdentityDecisionStore(controlDatabase)
  const instanceService = new InstanceReviewService({ store: new PostgresInstanceReviewStore(controlDatabase) })
  publicationService = new SemanticPublicationService({ store: new PostgresSemanticPublicationStore(controlDatabase), candidates: candidateStore, identity: identityStore, schemaSource })
  await seedIdentityProject(harness.adminClient, scope.scopeRef, workflowProject, WORKFLOW_REF, IDENTITY_MAPPING_REF)
  await seedIdentityProject(harness.adminClient, scope.scopeRef, foreignProject, WORKFLOW_REF, IDENTITY_MAPPING_REF)
  workflowDocument = randomUUID()
  workflowOtherDocument = randomUUID()
  for (const [projectId, documentId] of [[workflowProject, workflowDocument], [foreignProject, workflowOtherDocument]] as const) {
    await projectDocuments.registerDocument(scope.scopeRef, projectId, {
      documentId, documentRef: parsed.originalRef, documentDigest: parsed.originalRef.digest,
      parseId: parsed.parseId, parseRef: parsed.spanMapRef, textDigest: parsed.normalizedRef.digest,
      precision: 'exact', actor: 'fixture', recordedAt: new Date().toISOString(),
    }, ctx)
  }
  workflowCandidate = {
    ...mention, candidateId: randomUUID(),
    attributes: [
      { attributeId: 'device_native_id', value: 'DEV-2' }, { attributeId: 'device_name', value: 'Shared Charger' },
      { attributeId: 'device_kind', value: 'charger' },
      ...Object.entries(DIMENSIONS).map(([attributeId, value]) => ({ attributeId, value })),
    ],
    inputVersion: { ...mention.inputVersion, definitionRef: WORKFLOW_REF, documentVersionRef: parsed.originalRef },
    idempotencyKey: `sha256:${'1'.repeat(64)}`,
  }
  const origin = { ...workflowCandidate, candidateId: randomUUID(), idempotencyKey: `sha256:${'2'.repeat(64)}` }
  await candidateStore.insertCandidates(scope.scopeRef, [workflowCandidate, origin], ctx)
  let ids = 0
  const decisions = new IdentityDecisionService({ candidates: candidateStore, store: identityStore, schemaSource, newId: () => ++ids === 2 ? 'E-B' : randomUUID() })
  await decisions.decide({ projectId: workflowProject, candidateId: origin.candidateId, kind: 'create_pending', expectedRevision: '0' }, ctx)
  await decisions.decide({ projectId: workflowProject, candidateId: origin.candidateId, kind: 'match', targetEntityId: 'E-B', expectedRevision: '1', justification: 'reviewed real index anchor' }, ctx)
  workflow = createInstanceIdentityWorkflow({ identityMappingRef: IDENTITY_MAPPING_REF, service: instanceService, projects, projectDocuments, candidates: candidateStore, identityStore, schemaSource, index: reader })
  workflowApp = createApiServer({
    authenticate: (request) => {
      const selected = request.headers['x-test-other'] === 'true' ? otherScope : scope
      return { principal: { ...ctx.principal, tenantId: selected.tenantId }, spaceId: selected.spaceId }
    },
    instanceReviews: { service: instanceService, identity: workflow, identityContext: (auth) => contextFor(auth.principal.tenantId, auth.spaceId, []) },
  })

}, 300_000)

afterAll(async () => {
  await workflowApp?.close().catch(() => undefined)
  await businessWriter?.end().catch(() => undefined)
  await businessDb?.close().catch(() => undefined)
  await indexStore?.close().catch(() => undefined)
  await parseStore?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await harness?.stop()
})

describe('entity candidate recall against real PostgreSQL, BM25 and the extraction store', () => {
  it('recalls a real candidate from the seeded identity index and round-trips the stored mention', async () => {
    const stored = await candidateStore.getCandidate(scope.scopeRef, mention.candidateId, ctx)
    expect(textSpan(stored?.sourceSpans[0])?.chunkId).toBe(textSpan(mention.sourceSpans[0])?.chunkId)

    const result = await recall.recall(
      {
        definitionRef: IDENTITY_DEFINITION_REF,
        candidate: mention,
        observedText: 'Shared Charger',
        scopeDimensionValues: { ...DIMENSIONS },
        contextCollections: [collection],
      },
      ctx,
    )

    expect(result.outcome).toBe('candidates')
    expect(result.candidates.map((candidate) => candidate.entityId)).toEqual(['E-B'])
    expect(result.candidates[0]?.strategy).toBe('context')
    // The identity index snapshot and the real BM25 snapshot are both attached.
    expect(result.sourceSnapshots.length).toBeGreaterThanOrEqual(2)
    expect(result.documentContext.performed).toBe(true)
    expect(result.documentContext.spans).toBeGreaterThan(0)
  })

  it('prefers a stable native identifier and a confirmed alias over same-name matches', async () => {
    const strong = await recall.recall(
      {
        definitionRef: IDENTITY_DEFINITION_REF,
        candidate: { ...mention, nativeId: 'DEV-1' },
        observedText: 'Shared Charger',
        scopeDimensionValues: { ...DIMENSIONS },
      },
      ctx,
    )
    expect(strong.candidates.map((candidate) => candidate.entityId)).toEqual(['E-A'])
    expect(strong.candidates[0]?.stableId).toBe(true)

    const alias = await recall.recall(
      {
        definitionRef: IDENTITY_DEFINITION_REF,
        candidate: mention,
        observedText: 'Charger Alias',
        scopeDimensionValues: { ...DIMENSIONS },
      },
      ctx,
    )
    expect(alias.candidates.map((candidate) => candidate.entityId)).toEqual(['E-ALIAS'])
    expect(alias.candidates[0]?.strategy).toBe('confirmed_alias')
    expect(alias.candidates[0]?.aliasConfirmed).toBe(true)
  })

  it('honours a historical alias only inside its valid interval', async () => {
    const inside = await recall.recall(
      {
        definitionRef: IDENTITY_DEFINITION_REF,
        candidate: mention,
        observedText: 'Old Charger',
        scopeDimensionValues: { ...DIMENSIONS },
        validAt: '2019-06-01T00:00:00Z',
      },
      ctx,
    )
    expect(inside.candidates.map((candidate) => candidate.entityId)).toEqual(['E-HIST'])
    expect(inside.candidates[0]?.aliasValidTo).toContain('2020-01-01T00:00:00')

    const outside = await recall.recall(
      {
        definitionRef: IDENTITY_DEFINITION_REF,
        candidate: mention,
        observedText: 'Old Charger',
        scopeDimensionValues: { ...DIMENSIONS },
        validAt: '2021-01-01T00:00:00Z',
      },
      ctx,
    )
    expect(outside.outcome).toBe('undecided')
    expect(outside.candidates).toHaveLength(0)
    expect(outside.coverage.boundedRecall).toBe(true)
  })

  it('never mixes same-name entities across tenant, site or type', async () => {
    const result = await recall.recall(
      {
        definitionRef: IDENTITY_DEFINITION_REF,
        candidate: mention,
        observedText: 'Shared Charger',
        scopeDimensionValues: { ...DIMENSIONS },
      },
      ctx,
    )
    const ids = result.candidates.map((candidate) => candidate.entityId)
    expect(ids).toEqual(['E-B'])
    expect(ids).not.toContain('E-SITE')
    expect(ids).not.toContain('E-TYPE')
    expect(ids.every((id) => !id.startsWith('OTHER-'))).toBe(true)

    // A different tenant/space recalls only its own same-name entity.
    const otherCtx = contextFor(otherScope.tenantId, otherScope.spaceId, [])
    const otherResult = await recall.recall(
      {
        definitionRef: IDENTITY_DEFINITION_REF,
        candidate: mention,
        observedText: 'Shared Charger',
        scopeDimensionValues: { ...DIMENSIONS },
      },
      otherCtx,
    )
    expect(otherResult.candidates.map((candidate) => candidate.entityId)).toEqual(['OTHER-E-B'])
  })

  it('reports a truncated bounded recall and an unavailable similarity path explicitly', async () => {
    const result = await recall.recall(
      {
        definitionRef: IDENTITY_DEFINITION_REF,
        candidate: mention,
        observedText: 'Truncated Name',
        scopeDimensionValues: { ...DIMENSIONS },
        limit: 1,
      },
      ctx,
    )
    expect(result.candidates).toHaveLength(1)
    expect(result.truncation.truncated).toBe(true)
    expect(result.coverage.truncated).toBe(true)
    expect(result.coverage.boundedRecall).toBe(true)
    expect(result.similarity.available).toBe(false)
    expect(result.similarity.reason).toBe('NOT_CONFIGURED')
  })
})

describe('production instance recall → human binding → semantic publication', () => {
  const headers = { 'content-type': 'application/json', 'idempotency-key': 'workflow-create-001' }

  it('refuses client candidate universes and unconfigured recall instead of manufacturing success', async () => {
    const spoofed = await workflowApp.inject({ method: 'POST', url: `/api/v1/projects/${workflowProject}/instance-records`, headers,
      payload: { candidateId: workflowCandidate.candidateId, documentId: workflowDocument, identityCandidates: [{ entityId: 'foreign' }] } })
    expect(spoofed.statusCode).toBe(400)
    const unconfigured = createApiServer({ authenticate: () => ({ principal: ctx.principal, spaceId: scope.spaceId }), instanceReviews: { service: new InstanceReviewService({ store: new PostgresInstanceReviewStore(controlDatabase) }) } })
    try {
      const response = await unconfigured.inject({ method: 'POST', url: `/api/v1/projects/${workflowProject}/instance-records`, headers, payload: { candidateId: workflowCandidate.candidateId, documentId: workflowDocument } })
      expect(response.statusCode).toBe(409)
      expect(response.json()).toMatchObject({ error: { code: 'CAPABILITY_NOT_CONFIGURED' } })
    } finally { await unconfigured.close() }
  })

  it('loads the real stored candidate/pins, returns evidence and never auto-approves an exact native id', async () => {
    const created = await workflowApp.inject({ method: 'POST', url: `/api/v1/projects/${workflowProject}/instance-records`, headers,
      payload: { candidateId: workflowCandidate.candidateId, documentId: workflowDocument, objectTypeRef: 'spoofed', sourceRef: { id: 'spoofed' } } })
    expect(created.statusCode, created.body).toBe(201)
    workflowRecord = (created.json() as { data: { record: InstanceRecordView } }).data.record
    expect(workflowRecord.identity.binding).toMatchObject({ candidateId: workflowCandidate.candidateId, projectRevisionRef: { projectId: workflowProject, revision: '1' }, definitionRef: WORKFLOW_REF })
    expect(workflowRecord.objectTypeRef).toBe('device')
    expect(workflowRecord.identity.state).toBe('unresolved')
    expect(workflowRecord.identity.confidence).toBe('exact')
    expect(workflowRecord.publicationState).toBe('draft')
    expect(workflowRecord.fields.every((field) => field.status === 'pending')).toBe(true)
    expect(created.json()).toMatchObject({ data: { recall: { candidates: [{ entityId: 'E-B', rank: 1, strategy: 'strong_identifier' }], similarity: { available: false, reason: 'NOT_CONFIGURED' } } } })
    expect(workflowRecord.identity.candidates[0]?.evidenceRefs?.length).toBeGreaterThan(0)
  })

  it('keeps the same native id isolated across tenant, project and identity domain, and exposes zero/truncated results', async () => {
    const other = await workflowApp.inject({ method: 'GET', url: `/api/v1/projects/${workflowProject}/identity-recall?candidateId=${workflowCandidate.candidateId}&documentId=${workflowDocument}`, headers: { 'x-test-other': 'true' } })
    expect(other.statusCode).toBe(404)
    const foreign = await workflow.recall(scope.scopeRef, foreignProject, workflowCandidate.candidateId, workflowOtherDocument, ctx)
    expect(foreign.outcome).toBe('undecided')
    expect(foreign.reason).toBe('NO_CANDIDATE')
    expect(foreign.candidates).toEqual([])
    const collision = { ...workflowCandidate, candidateId: randomUUID(), idempotencyKey: `sha256:${'3'.repeat(64)}`, identityScopeId: 'meter_identity' }
    await candidateStore.insertCandidates(scope.scopeRef, [collision], ctx)
    await expect(workflow.recall(scope.scopeRef, workflowProject, collision.candidateId, workflowDocument, ctx)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    const meter = { ...workflowCandidate, candidateId: randomUUID(), idempotencyKey: `sha256:${'4'.repeat(64)}`, objectId: 'meter', identityScopeId: 'meter_identity',
      attributes: [{ attributeId: 'meter_native_id', value: 'DEV-2' }, { attributeId: 'source', value: 'docs' }, { attributeId: 'site', value: 'site-a' }] }
    await candidateStore.insertCandidates(scope.scopeRef, [meter], ctx)
    await businessWriter.query(`INSERT INTO public.identity_index SELECT tenant_id,space_id,'E-METER','meter','meter_identity',native_id,display_name,normalized_name,alias,alias_normalized,alias_confirmed,alias_valid_from,alias_valid_to,site,'meter',device_type,source_dim,project_dim,valid_from,valid_to FROM public.identity_index WHERE entity_id='E-B' AND tenant_id=$1`, [scope.tenantId])
    const meterRecall = await workflow.recall(scope.scopeRef, workflowProject, meter.candidateId, workflowDocument, ctx)
    expect(meterRecall.candidates.map((candidate) => candidate.entityId)).toEqual(['E-METER'])
    expect(meterRecall.identityScopeId).toBe('meter_identity')
    // Even an inconsistent index row cannot move a project-scoped semantic entity elsewhere.
    await businessWriter.query('UPDATE public.identity_index SET project_dim=$1 WHERE entity_id=$2 AND tenant_id=$3', [foreignProject, 'E-B', scope.tenantId])
    try {
      const foreignRow = await workflow.createRecord(scope.scopeRef, foreignProject, { candidateId: workflowCandidate.candidateId, documentId: workflowOtherDocument, idempotencyKey: 'foreign-record-001', relations: [] }, ctx)
      expect(foreignRow.recall.candidates.map((candidate) => candidate.entityId)).toEqual(['E-B'])
      await expect(workflow.adjudicateIdentity(scope.scopeRef, foreignProject, foreignRow.record.recordId, { expectedRevision: '1', kind: 'match', targetEntityId: 'E-B', reason: 'same native id', idempotencyKey: 'foreign-match-001' }, ctx)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    } finally {
      await businessWriter.query('UPDATE public.identity_index SET project_dim=$1 WHERE entity_id=$2 AND tenant_id=$3', [workflowProject, 'E-B', scope.tenantId])
    }
    const duplicate = await businessWriter.query(`INSERT INTO public.identity_index SELECT tenant_id,space_id,'E-DUP',object_id,identity_scope_id,native_id,display_name,normalized_name,alias,alias_normalized,alias_confirmed,alias_valid_from,alias_valid_to,site,entity_type,device_type,source_dim,project_dim,valid_from,valid_to FROM public.identity_index WHERE entity_id='E-B' AND tenant_id=$1`, [scope.tenantId])
    expect(duplicate.rowCount).toBe(1)
    const truncated = await workflow.recall(scope.scopeRef, workflowProject, workflowCandidate.candidateId, workflowDocument, ctx, 1)
    expect(truncated.truncation).toMatchObject({ truncated: true, limit: 1 })
    expect(truncated.candidates).toHaveLength(1)
    await businessWriter.query('DELETE FROM public.identity_index WHERE entity_id=$1', ['E-DUP'])
  })

  it('refuses invalid/stale selections, records a human binding once, and keeps a split from publishing', async () => {
    const base = `/api/v1/projects/${workflowProject}/instance-records/${workflowRecord.recordId}`
    const invalid = await workflowApp.inject({ method: 'POST', url: `${base}/identity-decisions`, headers: { ...headers, 'if-match': '1' }, payload: { kind: 'match', targetEntityId: 'OTHER-E-B', reason: 'human selection' } })
    expect(invalid.statusCode).toBe(409)
    const stale = await workflowApp.inject({ method: 'POST', url: `${base}/identity-decisions`, headers: { ...headers, 'if-match': '0' }, payload: { kind: 'match', targetEntityId: 'E-B', reason: 'human selection' } })
    expect(stale.statusCode).toBe(409)
    const request = { method: 'POST' as const, url: `${base}/identity-decisions`, headers: { ...headers, 'idempotency-key': 'human-bind-001', 'if-match': '1' }, payload: { kind: 'match', targetEntityId: 'E-B', reason: 'reviewed the exact source and identity' } }
    const matched = await workflowApp.inject(request)
    expect(matched.statusCode, matched.body).toBe(200)
    workflowRecord = (matched.json() as { data: { record: InstanceRecordView } }).data.record
    const replay = await workflowApp.inject(request)
    expect(replay.statusCode).toBe(200)
    expect((replay.json() as { data: { record: InstanceRecordView } }).data.record.recordRevision).toBe(workflowRecord.recordRevision)
    expect(await identityStore.latestRevision(scope.scopeRef, workflowCandidate.candidateId, ctx)).toBe('1')
    expect(await identityStore.listAssertions(scope.scopeRef, { candidateId: workflowCandidate.candidateId, openOnly: true }, ctx)).toHaveLength(1)
    await workflow.validatePublication(scope.scopeRef, workflowProject, workflowRecord.recordId, ctx)
  })

  it('refuses approval/publication when a semantic split commits after prevalidation but before the instance revision', async () => {
    const records = new PostgresInstanceReviewStore(controlDatabase)
    const service = new InstanceReviewService({ store: records })
    const confirmed = await service.confirmFields(scope.scopeRef, workflowProject, workflowRecord.recordId, {
      expectedRevision: workflowRecord.recordRevision,
      decisions: workflowRecord.fields.map((field) => ({ fieldId: field.fieldId, decision: 'confirm' })),
      idempotencyKey: 'binding-race-fields',
    }, ctx)
    workflowRecord = confirmed.record
    const binding = workflowRecord.identity.binding
    if (binding === undefined) throw new Error('expected the trusted instance binding')
    const projectFence = { projectRevisionRef: binding.projectRevisionRef, definitionRef: binding.definitionRef, documentId: binding.documentId, parseId: workflowCandidate.inputVersion.parseId, membershipRevision: binding.membershipRevision, visibilityEpoch: binding.visibilityEpoch }
    const authority = new IdentityDecisionService({ store: identityStore, candidates: candidateStore, schemaSource: new InMemoryIndustrySchemaSource([{ ref: WORKFLOW_REF, schema: buildIndustrySchema(WORKFLOW_REF) }]) })
    const decide = async (kind: 'match' | 'split') => authority.decide({
      candidateId: workflowCandidate.candidateId, projectId: workflowProject, projectFence, kind, targetEntityId: 'E-B',
      expectedRevision: await identityStore.latestRevision(scope.scopeRef, workflowCandidate.candidateId, ctx),
      justification: `reviewer ${kind} for binding race proof`,
    }, ctx)

    await workflow.validatePublication(scope.scopeRef, workflowProject, workflowRecord.recordId, ctx)
    await decide('split')
    await expect(service.approve(scope.scopeRef, workflowProject, workflowRecord.recordId, { expectedRevision: workflowRecord.recordRevision, idempotencyKey: 'binding-race-approve-refused' }, ctx)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    expect(await records.getRecord(scope.scopeRef, workflowProject, workflowRecord.recordId, ctx)).toMatchObject({ recordRevision: workflowRecord.recordRevision, publicationState: 'draft' })

    await decide('match')
    await workflow.validatePublication(scope.scopeRef, workflowProject, workflowRecord.recordId, ctx)
    workflowRecord = await service.approve(scope.scopeRef, workflowProject, workflowRecord.recordId, { expectedRevision: workflowRecord.recordRevision, idempotencyKey: 'binding-race-approve-current' }, ctx)
    await workflow.validatePublication(scope.scopeRef, workflowProject, workflowRecord.recordId, ctx)
    await decide('split')
    await expect(service.publish(scope.scopeRef, workflowProject, workflowRecord.recordId, { expectedRevision: workflowRecord.recordRevision, idempotencyKey: 'binding-race-publish-refused' }, ctx)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    const retained = await records.getRecord(scope.scopeRef, workflowProject, workflowRecord.recordId, ctx)
    expect(retained).toMatchObject({ recordRevision: workflowRecord.recordRevision, publicationState: 'approved' })
    expect(retained?.publishedRevision).toBeUndefined()
    await decide('match')
  })

  it('publishes the stored candidate under its human binding, reads official facts, and retracts without erasing history', async () => {
    await publicationService.reviewCandidate({ candidateId: workflowCandidate.candidateId, decision: 'approve', expectedRevision: '0', reason: 'reviewed stored fields' }, ctx)
    const publication = await publicationService.publish({ schemaRef: WORKFLOW_REF, approvedCandidateRefs: [{ candidateId: workflowCandidate.candidateId, kind: 'entity' }], expectedRevision: '0', idempotencyKey: 'workflow-publish-001' }, ctx)
    expect(publication.statements.length).toBeGreaterThan(0)
    const official = await publicationService.listStatements({ sourceCandidateId: workflowCandidate.candidateId }, ctx)
    expect(official.length).toBe(publication.statements.length)
    expect(official.every((statement) => statement.sourceCandidateId === workflowCandidate.candidateId)).toBe(true)
    for (const statement of official) await publicationService.reviseStatement({ statementId: statement.statementId, kind: 'retraction', expectedRevision: statement.version, idempotencyKey: `retract-${statement.statementId}`, reason: 'source withdrawn after human review' }, ctx)
    expect(await publicationService.listStatements({ sourceCandidateId: workflowCandidate.candidateId }, ctx)).toEqual([])
    const historical = await publicationService.listStatements({ sourceCandidateId: workflowCandidate.candidateId, status: 'retracted' }, ctx)
    expect(historical).toHaveLength(official.length)
    const split = await workflow.adjudicateIdentity(scope.scopeRef, workflowProject, workflowRecord.recordId, { expectedRevision: workflowRecord.recordRevision, kind: 'split', targetEntityId: 'E-B', reason: 'reviewer reversed identity', idempotencyKey: 'human-split-001' }, ctx)
    expect(split.identity.state).toBe('split')
    expect(split.publicationState).toBe('draft')
    await expect(workflow.validatePublication(scope.scopeRef, workflowProject, split.recordId, ctx)).rejects.toMatchObject({ code: 'PUBLICATION_BLOCKED' })
  })

  it('refuses an old definition pin and a withdrawn source fixed point', async () => {
    const old = { ...workflowCandidate, candidateId: randomUUID(), idempotencyKey: `sha256:${'5'.repeat(64)}`, inputVersion: { ...workflowCandidate.inputVersion, definitionRef: { ...WORKFLOW_REF, version: '0.9.0' } } }
    await candidateStore.insertCandidates(scope.scopeRef, [old], ctx)
    await expect(workflow.recall(scope.scopeRef, workflowProject, old.candidateId, workflowDocument, ctx)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    await harness.adminClient.query(`UPDATE agent_platform.projects SET head_revision=2 WHERE project_id=$1`, [workflowProject])
    await expect(workflow.validateRecord(scope.scopeRef, workflowProject, workflowRecord.recordId, ctx)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    await harness.adminClient.query(`UPDATE agent_platform.projects SET head_revision=1 WHERE project_id=$1`, [workflowProject])
    const pending = { ...workflowCandidate, candidateId: randomUUID(), idempotencyKey: `sha256:${'6'.repeat(64)}` }
    await candidateStore.insertCandidates(scope.scopeRef, [pending], ctx)
    const binding = workflowRecord.identity.binding
    if (binding === undefined) throw new Error('workflow record has no binding')
    const staleFence = { projectRevisionRef: binding.projectRevisionRef, definitionRef: binding.definitionRef, documentId: binding.documentId, parseId: pending.inputVersion.parseId, membershipRevision: binding.membershipRevision, visibilityEpoch: binding.visibilityEpoch }
    const before = await identityStore.listEntities(scope.scopeRef, { limit: 100 }, ctx)
    await projectDocuments.reviseDocument(scope.scopeRef, workflowProject, { documentId: workflowDocument, op: 'retract', reason: 'source withdrawn', actor: 'reviewer', recordedAt: new Date().toISOString() }, ctx)
    await expect(workflow.recall(scope.scopeRef, workflowProject, workflowCandidate.candidateId, workflowDocument, ctx)).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' })
    const decision = new IdentityDecisionService({ store: identityStore, candidates: candidateStore, schemaSource: new InMemoryIndustrySchemaSource([{ ref: WORKFLOW_REF, schema: buildIndustrySchema(WORKFLOW_REF) }]) })
    await expect(decision.decide({ projectId: workflowProject, projectFence: staleFence, candidateId: pending.candidateId, kind: 'create_pending', expectedRevision: '0', justification: 'read this source before it was withdrawn' }, ctx)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await identityStore.latestRevision(scope.scopeRef, pending.candidateId, ctx)).toBe('0')
    expect(await identityStore.listEntities(scope.scopeRef, { limit: 100 }, ctx)).toHaveLength(before.length)
  })


  it('atomically refuses a decision racing a project evolution or a real document withdrawal', async () => {
    const projectId = randomUUID()
    await seedIdentityProject(harness.adminClient, scope.scopeRef, projectId, WORKFLOW_REF, IDENTITY_MAPPING_REF)
    const original = await projectDocuments.getMembership(scope.scopeRef, workflowProject, workflowDocument, ctx)
    if (original === undefined) throw new Error('expected the historical source membership')
    const documentId = randomUUID()
    const registered = await projectDocuments.registerDocument(scope.scopeRef, projectId, {
      documentId, documentRef: original.documentRef, documentDigest: original.documentDigest, parseId: original.parseId,
      parseRef: original.parseRef, textDigest: original.textDigest, precision: 'exact', actor: 'fixture', recordedAt: new Date().toISOString(),
    }, ctx)
    const revision = await new PostgresProjectStore(controlDatabase).getRevision(scope.scopeRef, projectId, '1', ctx)
    if (revision === undefined) throw new Error('expected the pinned project revision')
    const fence = { projectRevisionRef: revision.ref, definitionRef: WORKFLOW_REF, documentId, parseId: original.parseId, membershipRevision: registered.membership.membershipRevision, visibilityEpoch: registered.visibility.epoch }
    const candidates = ['7', '8'].map((digit) => ({ ...workflowCandidate, candidateId: randomUUID(), idempotencyKey: `sha256:${digit.repeat(64)}` }))
    await candidateStore.insertCandidates(scope.scopeRef, candidates, ctx)
    const records = new PostgresInstanceReviewStore(controlDatabase)
    const recordId = randomUUID()
    const recordInput: AppendInstanceRecordInput = {
      recordId, expectedRevision: '0', objectTypeRef: 'device', identityCandidates: [], identityState: 'unresolved', identityConfidence: 'none',
      identityBinding: { candidateId: candidates[0]?.candidateId ?? '', documentId, projectRevisionRef: revision.ref, definitionRef: WORKFLOW_REF, membershipRevision: fence.membershipRevision, visibilityEpoch: fence.visibilityEpoch, identityScopeId: 'device_identity' },
      sameNameDifferentMeaning: false, cannotLinkEntityIds: [], adjudications: [], fields: workflowRecord.fields, relations: [],
      publicationState: 'draft', sourceRef: original.documentRef, actor: 'fixture', recordedAt: new Date().toISOString(), idempotencyKey: 'concurrent-record-001',
    }
    await records.appendRecordRevision(scope.scopeRef, projectId, recordInput, ctx)
    const decisions = new IdentityDecisionService({ store: identityStore, candidates: candidateStore, schemaSource: new InMemoryIndustrySchemaSource([{ ref: WORKFLOW_REF, schema: buildIndustrySchema(WORKFLOW_REF) }]) })
    const blocker = new Client({ connectionString: harness.adminUrl })
    await blocker.connect()
    const waitForLock = async (queryPart: string) => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const waiting = await harness.adminClient.query<{ count: string }>(`SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1`, [`%${queryPart}%`])
        if (Number(waiting.rows[0]?.count) > 0) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`expected an actual database lock wait for ${queryPart}`)
    }
    const attempt = (candidateId: string) => decisions.decide({ projectId, projectFence: fence, candidateId, kind: 'create_pending', expectedRevision: '0', justification: 'reviewed source before concurrent change' }, ctx).then(() => ({ code: 'UNEXPECTED_SUCCESS' }), (error: unknown) => error)
    const attemptPublication = (key: string) => records.appendRecordRevision(scope.scopeRef, projectId, { ...recordInput, expectedRevision: '1', publicationState: 'published', publishedRevision: '2', idempotencyKey: key }, ctx).then(() => ({ code: 'UNEXPECTED_SUCCESS' }), (error: unknown) => error)
    try {
      await blocker.query('BEGIN')
      await blocker.query('UPDATE agent_platform.projects SET head_revision=2 WHERE project_id=$1 AND tenant_id=$2', [projectId, scope.tenantId])
      const evolution = attempt(candidates[0]?.candidateId ?? '')
      await waitForLock('SELECT head_revision')
      const evolvedPublication = attemptPublication('concurrent-evolution-publish')
      await waitForLock('SELECT project_id FROM agent_platform.projects')
      await blocker.query('COMMIT')
      expect(await evolution).toMatchObject({ code: 'VERSION_CONFLICT' })
      expect(await evolvedPublication).toMatchObject({ code: 'IDENTITY_CONFLICT' })
      await blocker.query('UPDATE agent_platform.projects SET head_revision=1 WHERE project_id=$1 AND tenant_id=$2', [projectId, scope.tenantId])

      await blocker.query('BEGIN')
      await blocker.query('SELECT project_id FROM agent_platform.project_visibility WHERE project_id=$1 AND tenant_id=$2 FOR UPDATE', [projectId, scope.tenantId])
      const withdrawal = projectDocuments.reviseDocument(scope.scopeRef, projectId, { documentId, op: 'retract', reason: 'concurrent withdrawal', actor: 'reviewer', recordedAt: new Date().toISOString() }, ctx)
      await waitForLock('UPDATE agent_platform.project_visibility')
      const sourceChange = attempt(candidates[1]?.candidateId ?? '')
      await waitForLock('FROM agent_platform.project_document_memberships')
      const withdrawnPublication = attemptPublication('concurrent-source-publish')
      await waitForLock('SELECT project_id FROM agent_platform.projects')
      await blocker.query('COMMIT')
      expect((await withdrawal).membership.state).toBe('retracted')
      expect(await sourceChange).toMatchObject({ code: 'VERSION_CONFLICT' })
      expect(await withdrawnPublication).toMatchObject({ code: 'IDENTITY_CONFLICT' })
      expect(await records.getRecord(scope.scopeRef, projectId, recordId, ctx)).toMatchObject({ recordRevision: '1', publicationState: 'draft' })
      for (const candidate of candidates) {
        expect(await identityStore.latestRevision(scope.scopeRef, candidate.candidateId, ctx)).toBe('0')
        expect(await identityStore.listAssertions(scope.scopeRef, { candidateId: candidate.candidateId }, ctx)).toEqual([])
      }
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined)
      await blocker.end()
    }
  })
})
