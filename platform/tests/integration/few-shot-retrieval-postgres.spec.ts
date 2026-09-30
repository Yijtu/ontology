import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runControlMigrations } from '@ontology/adapter-control-postgres'
import {
  Bm25DocumentSearchService,
  PostgresKeywordIndexStore,
  canonicalIndexDigest,
  termFrequencies,
  tokenize,
} from '@ontology/adapter-search-bm25'
import type { IndexedDocument } from '@ontology/adapter-search-bm25'
import { FewShotExampleRetriever, RunPlanner } from '@ontology/application'
import type { FewShotExampleProvider } from '@ontology/application'
import { createToolContext } from '@ontology/contracts'
import type {
  CompiledSemanticQuery,
  DocumentSpanReaderPort,
  FewShotExampleSet,
  FewShotExampleSourceResolver,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  ReadSpanResponse,
  ScopeRef,
  SemanticQueryCompilerPort,
  SemanticQueryPlan,
  ToolContext,
} from '@ontology/contracts'
import {
  HOME_ENERGY_EXAMPLE_COLLECTION_REF,
  buildHomeEnergyExampleSet,
} from '@ontology/industry-pack-home-energy'
import { MAPPING_JOIN } from '../fixtures/semantic-mapping'
import {
  VOCAB_DEFINITION_REF,
  publishedVocabularyDefinition,
  vocabularyService,
} from '../fixtures/schema-vocabulary'
import { multiHopPlanJson } from '../unit/workflow-planning-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

// Real parsing is not needed here, but the container start and migrations are slow when the
// whole run executes in parallel, so the suite gets the explicit container budget.
vi.setConfig({ testTimeout: 120_000 })

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const COLLECTION = HOME_ENERGY_EXAMPLE_COLLECTION_REF
const SET = buildHomeEnergyExampleSet()
const PV_EXAMPLE_ID = 'a0000000-0000-4000-8000-000000000002'

const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const PLANNER_VOCABULARY = vocabularyService([MAPPING_JOIN], [publishedVocabularyDefinition()])
const PLAN_SOURCES = { mappingRefs: [MAPPING_JOIN.mappingRef], definitionRefs: [VOCAB_DEFINITION_REF] }

function digestOf(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function contextFor(
  tenantId: string,
  spaceId: string,
  collectionRefs: readonly string[],
): ToolContext {
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'few-shot-integration',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId: '33333333-3333-4333-8333-333333333333',
    resolvedProfileHash: digestOf('profile'),
    policyVersion: '1.0.0',
    deadline: '2030-01-01T00:10:00Z',
    budgetReservation: {
      reservationId: '55555555-5555-4555-8555-555555555555',
      runId: '33333333-3333-4333-8333-333333333333',
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2030-01-01T00:10:00Z',
    },
    allowedResources: {
      tenantId,
      spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [...collectionRefs],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-few-shot-integration',
  })
}

const CTX_A = contextFor(TENANT_A, SPACE_A, [COLLECTION])
const CTX_B = contextFor(TENANT_B, SPACE_B, [COLLECTION])

/** One indexed document per declared example, keyed by `exampleId` (the retriever's mapping). */
function indexDocuments(set: FewShotExampleSet, builtAt: string): IndexedDocument[] {
  return set.examples.map((example, ordinal) => {
    const text = `${example.question} ${example.expectedShape.concepts.join(' ')} ${example.expectedShape.fields.join(' ')}`
    const tokens = tokenize(text)
    return {
      chunkId: randomUUID(),
      parseId: randomUUID(),
      documentRef: { id: example.exampleId, version: '1.0.0', digest: digestOf(text), kind: 'document' },
      documentDigest: digestOf(`${set.ref.id}:${example.exampleId}`),
      mediaType: 'text/plain',
      text,
      textDigest: digestOf(text),
      locator: { kind: 'offset', startOffset: 0, endOffset: text.length },
      spanKind: 'verbatim',
      precision: 'exact',
      quoteDigest: digestOf(text),
      ordinal,
      recordedAt: builtAt,
      length: tokens.length,
      termFrequencies: termFrequencies(tokens),
    }
  })
}

/** The retriever never calls `readSpan`; the search path under test is the real one. */
class UnusedSpanReader implements DocumentSpanReaderPort {
  readSpan(): Promise<ReadSpanResponse> {
    return Promise.reject(new Error('the few-shot retriever maps hits to declared examples'))
  }
}

class RecordingGeneration implements GenerationPort {
  readonly calls: GenerationRequest[] = []
  async *generate(request: GenerationRequest): AsyncIterable<GenerationEvent> {
    this.calls.push(request)
    yield {
      type: 'tool_call_delta',
      callId: '33333333-3333-4333-8333-333333333334',
      toolId: 'data_query',
      argumentsDelta: multiHopPlanJson(),
    }
    yield { type: 'completed', stopReason: 'tool_calls', candidateOnly: true }
  }
}

class DirectCompiler implements SemanticQueryCompilerPort {
  compile(plan: SemanticQueryPlan): Promise<CompiledSemanticQuery> {
    return Promise.resolve({
      plan: {
        mode: 'direct',
        statementKind: 'select',
        sql: 'SELECT 1',
        parameters: [],
        referencedObjects: [],
        readOnly: true,
      },
      mappingRef: plan.mappingVersion,
      warnings: [],
    })
  }
}

function resolverReturning(sets: readonly FewShotExampleSet[]): FewShotExampleSourceResolver {
  return { listExampleSets: () => Promise.resolve(sets) }
}

let container: PostgresContainer | undefined
let adminClient: Client
let indexStore: PostgresKeywordIndexStore
let searchService: Bm25DocumentSearchService

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const adminUrl =
    provided !== undefined && provided.length > 0
      ? provided
      : (container = await startPostgresContainer()).adminUrl

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'few-shot-tenant-a'), ($2, 'few-shot-tenant-b') ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'few-shot-space-a'), ($3, $4, 'few-shot-space-b') ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, TENANT_B, SPACE_B],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const appUrl = `${base.protocol}//ontology_app:${encodeURIComponent(appPassword)}@${base.hostname}${port}/postgres`

  indexStore = new PostgresKeywordIndexStore({ connectionString: appUrl, maxPoolSize: 4 })
  searchService = new Bm25DocumentSearchService({
    indexStore,
    spanReader: new UnusedSpanReader(),
    now: () => new Date().toISOString(),
  })

  // Materialize the real home-energy example set as an immutable keyword-index generation.
  const builtAt = new Date().toISOString()
  const documents = indexDocuments(SET, builtAt)
  const indexDigest = canonicalIndexDigest(COLLECTION, documents)
  await indexStore.writeGeneration(
    SCOPE_A,
    {
      collectionRef: COLLECTION,
      generation: '1',
      indexDigest,
      indexRef: { id: COLLECTION, version: '1.0.0', digest: indexDigest },
      docCount: documents.length,
      avgDocLength: documents.reduce((sum, document) => sum + document.length, 0) / documents.length,
      completeness: 'complete',
      builtAt,
      documents,
    },
    CTX_A,
  )
  await indexStore.activateGeneration(SCOPE_A, COLLECTION, '1', builtAt, CTX_A)
}, 300_000)

afterAll(async () => {
  await indexStore?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('few-shot retrieval over the real BM25 index and PostgreSQL (LOCAL-076)', () => {
  it('retrieves declared, versioned examples ranked by the real keyword index', async () => {
    const retriever = new FewShotExampleRetriever({
      search: searchService,
      sources: resolverReturning([SET]),
    })
    const result = await retriever.retrieve({ query: '明天光伏发电预测如何？', topK: 4 }, CTX_A)

    expect(result.status).toBe('ok')
    expect(result.examples.length).toBeGreaterThan(0)
    expect(result.examples[0]?.exampleId).toBe(PV_EXAMPLE_ID)
    for (const retrieved of result.examples) {
      expect(retrieved.sourceRef).toEqual(SET.ref)
      expect(retrieved.indexVersion.generation).toBe('1')
      expect(retrieved.collectionRef).toBe(COLLECTION)
      expect(retrieved.question.length).toBeGreaterThan(0)
    }
    expect(result.coverage.truncated).toBe(false)
  })

  it('bounds the recall range and marks the truncation explicitly', async () => {
    const retriever = new FewShotExampleRetriever({
      search: searchService,
      sources: resolverReturning([SET]),
    })
    const result = await retriever.retrieve({ query: '电价 预测 负载 备用', topK: 1 }, CTX_A)

    expect(result.examples).toHaveLength(1)
    expect(result.status).toBe('partial')
    expect(result.coverage.truncated).toBe(true)
    expect(result.warnings.map((warning) => warning.code)).toContain('EXAMPLE_SET_TRUNCATED')
  })

  it('does not disclose another tenant example index and fabricates nothing', async () => {
    const retriever = new FewShotExampleRetriever({
      search: searchService,
      sources: resolverReturning([SET]),
    })
    const result = await retriever.retrieve({ query: '明天光伏发电预测如何？' }, CTX_B)

    expect(result.examples).toEqual([])
    expect(result.status).toBe('not_configured')
    expect(result.warnings.map((warning) => warning.code)).toContain('EXAMPLE_SET_NOT_MATERIALIZED')
  })

  it('injects the retrieved examples end-to-end into the SQL generation request as untrusted data', async () => {
    const retriever = new FewShotExampleRetriever({
      search: searchService,
      sources: resolverReturning([SET]),
    })
    const examples: FewShotExampleProvider = retriever
    const generation = new RecordingGeneration()
    const planner = new RunPlanner({
      vocabulary: PLANNER_VOCABULARY,
      compiler: new DirectCompiler(),
      generation,
      examples,
    })

    const routed = await planner.route(
      {
        runId: CTX_A.runId,
        question: '明天光伏发电预测如何？',
        context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
        preferences: { route: 'auto', allowWeb: false },
        ...PLAN_SOURCES,
      },
      CTX_A,
    )

    expect(routed.route).toBe('small_plan')
    const request = generation.calls[0]
    expect(request).toBeDefined()
    if (request === undefined) return

    // The tool catalogue, role and budget are unchanged; only a data message was added.
    expect(request.toolSchemas).toEqual(['data_query'])
    expect(request.role).toBe('sql_proposer')
    expect(request.outputLimit).toEqual({ maxTokens: 1024 })
    const injected = request.messages[3]
    expect(injected?.role).toBe('user')
    expect(injected?.content).toContain('UNTRUSTED FEW-SHOT EXAMPLES')
    expect(injected?.content).toContain(PV_EXAMPLE_ID)
    expect(injected?.content).toContain('明天光伏发电预测如何？')
  })
})
