import { randomBytes } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  DirectSqlQueryPlan,
  StructuredQueryExecuteRequest,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { BusinessPostgresDatabase, PostgresQueryAdapter } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import {
  InMemorySemanticDefinitionStore,
  InMemorySemanticMappingRegistry,
  SemanticDefinitionService,
  SemanticSchemaVocabularyService,
  compileSemanticQuery,
  renderCompiledQuery,
  type SemanticMapping,
} from '@ontology/semantic-engine'
import {
  COMPILE_BUDGET,
  EXPECTED_COLUMNS,
  EXPECTED_ROWS,
  MAPPING_A,
  MAPPING_B,
  OBJECT_A,
  OBJECT_B,
  SOURCE_A,
  SOURCE_B,
  rowsForMappingA,
  rowsForMappingB,
  semanticPlan,
} from '../fixtures/semantic-mapping'
import {
  VOCAB_NAMESPACE,
  VOCAB_SCOPE,
  vocabularyDefinitionDraft,
} from '../fixtures/schema-vocabulary'
import { RecordingControlRepository, toolContext } from '../unit/component-registry-fixtures'
import { gatewayContext } from '../unit/tool-gateway-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * LOCAL-075 acceptance against a real PostgreSQL container.
 *
 * Two physically different tables are mapped to the same logical concepts (different
 * column names, status encodings and energy units). Executing the same semantic query
 * through each mapping yields the same normalised rows, and building the schema vocabulary
 * from each mapping against the *published* definition yields the same normalised
 * vocabulary — proving the vocabulary is mapping-driven and never hardcoded.
 */

const READ_ONLY_ROLE = `schema_vocab_reader_${String(process.pid)}_${randomBytes(3).toString('hex')}`
const ADMIN = toolContext(VOCAB_SCOPE.tenantId, VOCAB_SCOPE.spaceId, ['platform-admin'], 'schema-vocab-admin')

function connectionStringFor(base: string, user: string, password: string, database: string): string {
  const url = new URL(base)
  const port = url.port === '' ? '' : `:${url.port}`
  return `${url.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${url.hostname}${port}/${database}`
}

function executeRequest(mapping: SemanticMapping): StructuredQueryExecuteRequest {
  const compiled = compileSemanticQuery(semanticPlan(mapping), mapping, { budget: COMPILE_BUDGET })
  const rendered = renderCompiledQuery(compiled)
  const plan: DirectSqlQueryPlan = {
    mode: 'direct',
    statementKind: 'select',
    sql: rendered.sql,
    parameters: [...rendered.parameters],
    referencedObjects: [...rendered.referencedObjects],
    readOnly: true,
  }
  return {
    plan,
    limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 60_000 },
    snapshotRequest: { consistency: 'repeatable_read' },
  }
}

let container: PostgresContainer | undefined
let adminClient: Client | undefined
let businessAdmin: Client | undefined
let businessDb: BusinessPostgresDatabase | undefined
let postgresAdapter: PostgresQueryAdapter | undefined
let vocabularyService: SemanticSchemaVocabularyService | undefined
let publishedRef: VersionRef | undefined
const businessDbName = `schema_vocab_${String(process.pid)}_${randomBytes(3).toString('hex')}`

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const useContainer = provided === undefined || provided.length === 0
  if (useContainer) container = await startPostgresContainer()
  const adminUrl = useContainer ? (container?.adminUrl ?? '') : (provided ?? '')
  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()

  await adminClient.query(`CREATE DATABASE ${businessDbName}`)
  const password = `throwaway_${randomBytes(8).toString('hex')}`
  await adminClient.query(`CREATE ROLE ${READ_ONLY_ROLE} LOGIN PASSWORD '${password}'`)

  const adminBusinessUrl = connectionStringFor(adminUrl, 'postgres', new URL(adminUrl).password, businessDbName)
  businessAdmin = new Client({ connectionString: adminBusinessUrl })
  await businessAdmin.connect()
  await businessAdmin.query(`
    CREATE TABLE public.energy_readings_a (
      reading_id text PRIMARY KEY,
      meter_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      energy_wh numeric(18, 1) NOT NULL,
      quality_code integer NOT NULL
    );
    CREATE TABLE public.energy_readings_b (
      reading_id text PRIMARY KEY,
      meter_id text NOT NULL,
      recorded_at timestamptz NOT NULL,
      energy_kwh numeric(18, 4) NOT NULL,
      quality_label text NOT NULL
    );
  `)
  for (const row of rowsForMappingA()) {
    await businessAdmin.query(
      'INSERT INTO public.energy_readings_a (reading_id, meter_id, recorded_at, energy_wh, quality_code) VALUES ($1, $2, $3, $4, $5)',
      [...row],
    )
  }
  for (const row of rowsForMappingB()) {
    await businessAdmin.query(
      'INSERT INTO public.energy_readings_b (reading_id, meter_id, recorded_at, energy_kwh, quality_label) VALUES ($1, $2, $3, $4, $5)',
      [...row],
    )
  }
  await businessAdmin.query(`GRANT USAGE ON SCHEMA public TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.energy_readings_a TO ${READ_ONLY_ROLE}`)
  await businessAdmin.query(`GRANT SELECT ON public.energy_readings_b TO ${READ_ONLY_ROLE}`)

  const businessUrl = connectionStringFor(adminUrl, READ_ONLY_ROLE, password, businessDbName)
  const database = new BusinessPostgresDatabase({ connectionString: businessUrl, maxPoolSize: 4 })
  businessDb = database
  const mappings: BusinessObjectMapping[] = [
    { objectRef: OBJECT_A, schema: 'public', relation: 'energy_readings_a', relationKind: 'table' },
    { objectRef: OBJECT_B, schema: 'public', relation: 'energy_readings_b', relationKind: 'table' },
  ]
  postgresAdapter = new PostgresQueryAdapter({ database, mappings, sourceRef: SOURCE_A })

  const definitionService = new SemanticDefinitionService({
    control: new RecordingControlRepository(),
    store: new InMemorySemanticDefinitionStore(),
    now: () => '2026-09-01T00:00:00Z',
  })
  const published = await definitionService.publish(vocabularyDefinitionDraft(), ADMIN)
  publishedRef = published.ref

  vocabularyService = new SemanticSchemaVocabularyService({
    mappings: new InMemorySemanticMappingRegistry([MAPPING_A, MAPPING_B]),
    resolveDefinition: async (ref, ctx) => {
      try {
        return await definitionService.getVersion(
          {
            scopeRef: VOCAB_SCOPE,
            namespace: VOCAB_NAMESPACE,
            definitionId: ref.id,
            version: ref.version,
          },
          ctx,
        )
      } catch {
        return undefined
      }
    },
  })
}, 300_000)

afterAll(async () => {
  await businessDb?.close().catch(() => undefined)
  await businessAdmin?.end().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('schema vocabulary against a real PostgreSQL container', () => {
  it('maps two physical schemas to one normalised vocabulary', async () => {
    const adapter = postgresAdapter
    const service = vocabularyService
    const definitionRef = publishedRef
    if (adapter === undefined || service === undefined || definitionRef === undefined) {
      throw new Error('the PostgreSQL harness or vocabulary service was not initialised')
    }
    const ctx: ToolContext = gatewayContext({ sourceRefs: [SOURCE_A, SOURCE_B], deadline: '2099-01-01T00:00:00Z' })
    const question = 'energy status per meter'

    const resultA = await adapter.execute(executeRequest(MAPPING_A), ctx)
    const resultB = await adapter.execute(executeRequest(MAPPING_B), ctx)
    expect(resultA.columns).toEqual(EXPECTED_COLUMNS)
    expect(resultA.rows).toEqual(EXPECTED_ROWS)
    expect(resultB.rows).toEqual(resultA.rows)

    const build = (mapping: SemanticMapping) =>
      service.build(
        {
          question,
          mappingRefs: [mapping.mappingRef],
          definitionRefs: [definitionRef],
          maxConcepts: 8,
          maxFields: 32,
        },
        ADMIN,
      )

    const vocabularyA = await build(MAPPING_A)
    const vocabularyB = await build(MAPPING_B)

    expect(vocabularyA.gaps).toEqual([])
    expect(vocabularyB.gaps).toEqual([])
    expect(vocabularyB.concepts).toEqual(vocabularyA.concepts)
    expect(vocabularyB.links).toEqual(vocabularyA.links)
    expect(vocabularyB.vocabularyRef.digest).toBe(vocabularyA.vocabularyRef.digest)
    // Each vocabulary still records the physical mapping version it was derived from.
    expect(vocabularyB.sources).not.toEqual(vocabularyA.sources)

    const serialized = JSON.stringify(vocabularyA)
    for (const physical of ['energy_wh', 'quality_code', 'energy_readings_a', '"public"']) {
      expect(serialized).not.toContain(physical)
    }
  }, 120_000)

  it('never resolves an unpublished definition into the vocabulary', async () => {
    const service = vocabularyService
    if (service === undefined) throw new Error('the vocabulary service was not initialised')

    const vocabulary = await service.build(
      {
        question: 'energy status per meter',
        mappingRefs: [MAPPING_A.mappingRef],
        definitionRefs: [{ id: 'home-energy.core', version: '9.9.9', digest: `sha256:${'f'.repeat(64)}` }],
        maxConcepts: 8,
        maxFields: 32,
      },
      ADMIN,
    )

    expect(vocabulary.concepts).toEqual([])
    expect(vocabulary.gaps.map((gap) => gap.code)).toEqual(['NO_PUBLISHED_DEFINITION'])
  })

  it('normalises rows through the real adapter before the vocabulary is even built', async () => {
    const adapter = postgresAdapter
    if (adapter === undefined) throw new Error('the PostgreSQL adapter was not initialised')
    const ctx: ToolContext = gatewayContext({ sourceRefs: [SOURCE_A, SOURCE_B], deadline: '2099-01-01T00:00:00Z' })

    const result = await adapter.execute(executeRequest(MAPPING_B), ctx)
    const rows = result.rows as readonly unknown[][]
    expect(rows).toEqual(EXPECTED_ROWS)
    expect(result.columns.map((column) => column.name)).toEqual(EXPECTED_COLUMNS.map((column) => column.name))
  }, 60_000)
})
