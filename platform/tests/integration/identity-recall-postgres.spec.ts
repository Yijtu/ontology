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
import { InMemoryIndustrySchemaSource, JobService } from '@ontology/application'
import { createToolContext } from '@ontology/contracts'
import type {
  EntityCandidate,
  SourceObjectRef,
  SourceRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  EntityCandidateRecallService,
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
  dimensionFieldRefs: { source: 'source_dim', site: 'site', device_type: 'device_type' },
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
      roles: ['semantic-reviewer', 'data-editor'],
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
  await businessAdmin.end()

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
}, 300_000)

afterAll(async () => {
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
