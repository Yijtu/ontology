import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import type {
  CompletenessStatus,
  DocumentSpan,
  ResourceRef,
  RevisionString,
  ScopeRef,
  Sha256Digest,
  SourceRef,
  SpanPrecision,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { DocumentSearchError, asStoreFailure } from './errors'
import { resolveTrustedScope } from './scope'
import type {
  GenerationWriteResult,
  IndexedDocument,
  KeywordIndexGeneration,
  KeywordIndexState,
  KeywordIndexStore,
  MatchingDocumentPage,
  WriteGenerationInput,
} from './types'

export interface PostgresKeywordIndexStoreConfig {
  readonly connectionString: string
  readonly maxPoolSize?: number
  readonly statementTimeoutMs?: number
  readonly connectionTimeoutMs?: number
  readonly applicationName?: string
}

interface GenerationRow extends QueryResultRow {
  collection_ref: string
  generation: string
  index_digest: string
  index_ref: VersionRef
  doc_count: number
  avg_doc_length: number
  completeness: string
  state: string
  built_at: Date
}

interface DocumentRow extends QueryResultRow {
  chunk_id: string
  parse_id: string
  document_ref_id: string
  document_ref_version: string
  document_digest: string
  source_namespace: string | null
  source_id: string | null
  media_type: string
  chunk_text: string
  text_digest: string
  locator: unknown
  span_kind: string
  precision: string
  quote_digest: string
  ordinal: number
  doc_length: number
  recorded_at: Date
}

interface PostingRow extends QueryResultRow {
  chunk_id: string
  term: string
  term_frequency: number
}

const GENERATION_FIELDS = [
  'collection_ref',
  'generation',
  'index_digest',
  'index_ref',
  'doc_count',
  'avg_doc_length',
  'completeness',
  'state',
  'built_at',
] as const

const GENERATION_COLUMNS = GENERATION_FIELDS.join(', ')
const GENERATION_COLUMNS_QUALIFIED = GENERATION_FIELDS.map((field) => `g.${field}`).join(', ')

const DOCUMENT_COLUMNS = `chunk_id, parse_id, document_ref_id, document_ref_version,
  document_digest, source_namespace, source_id, media_type, chunk_text, text_digest,
  locator, span_kind, precision, quote_digest, ordinal, doc_length, recorded_at`

function fail(message: string, cause?: unknown): never {
  throw new DocumentSearchError(
    'SOURCE_UNAVAILABLE',
    message,
    cause === undefined ? undefined : { cause },
  )
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  return fail(`${field} has an unexpected stored value`)
}

function toGeneration(row: GenerationRow): KeywordIndexGeneration {
  return {
    collectionRef: row.collection_ref,
    generation: row.generation,
    indexDigest: row.index_digest,
    indexRef: row.index_ref,
    docCount: row.doc_count,
    avgDocLength: row.avg_doc_length,
    completeness: oneOf<CompletenessStatus>(
      row.completeness,
      ['complete', 'partial', 'truncated', 'unknown'],
      'completeness',
    ),
    state: oneOf<KeywordIndexState>(row.state, ['staged', 'active', 'superseded'], 'state'),
    builtAt: row.built_at.toISOString(),
  }
}

function toLocator(value: unknown): DocumentSpan['locator'] {
  if (typeof value !== 'object' || value === null) return fail('locator is not an object')
  const record = value as Record<string, unknown>
  const kind = oneOf(record.kind, ['page', 'offset', 'approximate_locator'] as const, 'locator.kind')
  const optionalNumber = (field: string): number | undefined => {
    const candidate = record[field]
    if (candidate === undefined || candidate === null) return undefined
    if (typeof candidate !== 'number') return fail(`locator.${field} is not a number`)
    return candidate
  }
  const normalizationMapRef = record.normalizationMapRef
  if (normalizationMapRef !== undefined && typeof normalizationMapRef !== 'string') {
    return fail('locator.normalizationMapRef is not a string')
  }
  const page = optionalNumber('page')
  const startOffset = optionalNumber('startOffset')
  const endOffset = optionalNumber('endOffset')
  return {
    kind,
    ...(page === undefined ? {} : { page }),
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset }),
    ...(normalizationMapRef === undefined ? {} : { normalizationMapRef }),
  }
}

function toDocument(row: DocumentRow, termFrequencies: ReadonlyMap<string, number>): IndexedDocument {
  const documentRef: ResourceRef = {
    id: row.document_ref_id,
    version: row.document_ref_version,
    digest: row.document_digest,
    kind: 'document',
  }
  const sourceRef: SourceRef | undefined =
    row.source_namespace === null || row.source_id === null
      ? undefined
      : { namespace: row.source_namespace, sourceId: row.source_id }
  return {
    chunkId: row.chunk_id,
    parseId: row.parse_id,
    documentRef,
    documentDigest: row.document_digest,
    ...(sourceRef === undefined ? {} : { sourceRef }),
    mediaType: row.media_type,
    text: row.chunk_text,
    textDigest: row.text_digest,
    locator: toLocator(row.locator),
    spanKind: oneOf<DocumentSpan['spanKind']>(
      row.span_kind,
      ['verbatim', 'normalized', 'approximate'],
      'span_kind',
    ),
    precision: oneOf<SpanPrecision>(row.precision, ['exact', 'approximate'], 'precision'),
    quoteDigest: row.quote_digest,
    ordinal: row.ordinal,
    recordedAt: row.recorded_at.toISOString(),
    length: row.doc_length,
    termFrequencies,
  }
}

/**
 * PostgreSQL-backed versioned keyword index (migration 020). It connects as the
 * non-owner application role, so RLS is a real second line of defence behind the
 * explicit `(tenant_id, space_id)` predicates, and the session scope is cleared
 * before the connection returns to the pool. A generation write is one
 * transaction, so a crash mid-build can never leave a half-built generation.
 */
export class PostgresKeywordIndexStore implements KeywordIndexStore {
  readonly #pool: Pool

  constructor(config: PostgresKeywordIndexStoreConfig) {
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 10,
      application_name: config.applicationName ?? 'ontology-keyword-index-store',
      ...(config.statementTimeoutMs === undefined
        ? {}
        : { statement_timeout: config.statementTimeoutMs }),
      ...(config.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMillis: config.connectionTimeoutMs }),
    })
    // A pooled connection that dies while idle has no caller to report to:
    // `pg-pool` discards it and re-emits the error on the pool, and an unhandled
    // `error` event would crash the process. The next operation opens a fresh
    // connection and, if the database is still unreachable, fails with the
    // classified `SOURCE_UNAVAILABLE` from `#withScope`.
    this.#pool.on('error', () => undefined)
  }

  async #withScope<T>(
    scope: ScopeRef,
    run: (client: PoolClient) => Promise<T>,
    options?: { readonly readOnly?: boolean },
  ): Promise<T> {
    let client: PoolClient
    try {
      client = await this.#pool.connect()
    } catch (error) {
      // Pool exhaustion or a refused initial connection: classify so the tool path
      // sees the canonical retryable `SOURCE_UNAVAILABLE`, not an opaque driver error.
      throw asStoreFailure(error) ?? error
    }
    try {
      await client.query(options?.readOnly === true ? 'BEGIN READ ONLY' : 'BEGIN')
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.space_id', $2, true)",
        [scope.tenantId, scope.spaceId],
      )
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // keep the original failure; a broken connection is discarded below
      }
      // A dropped connection becomes `SOURCE_UNAVAILABLE`; a `DocumentSearchError`
      // or a genuine internal fault is rethrown unchanged.
      throw asStoreFailure(error) ?? error
    } finally {
      let reset = true
      try {
        await client.query(
          "SELECT set_config('app.tenant_id', '', false), set_config('app.space_id', '', false)",
        )
      } catch {
        reset = false
      }
      client.release(!reset)
    }
  }

  async #findByDigest(
    client: PoolClient,
    collectionRef: string,
    indexDigest: Sha256Digest,
  ): Promise<KeywordIndexGeneration | undefined> {
    const result = await client.query<GenerationRow>(
      `SELECT ${GENERATION_COLUMNS} FROM agent_platform.keyword_index_generations
        WHERE collection_ref = $1 AND index_digest = $2`,
      [collectionRef, indexDigest],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : toGeneration(row)
  }

  async writeGeneration(
    scopeRef: ScopeRef,
    input: WriteGenerationInput,
    ctx: ToolContext,
  ): Promise<GenerationWriteResult> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    return this.#withScope(scope, async (client) => {
      const existing = await this.#findByDigest(client, input.collectionRef, input.indexDigest)
      if (existing !== undefined) return { generation: existing, created: false }

      const inserted = await client.query<GenerationRow>(
        `INSERT INTO agent_platform.keyword_index_generations (
           tenant_id, space_id, collection_ref, generation, index_digest, index_ref,
           doc_count, avg_doc_length, completeness, state, built_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'staged', $10)
         ON CONFLICT (tenant_id, space_id, collection_ref, index_digest) DO NOTHING
         RETURNING ${GENERATION_COLUMNS}`,
        [
          scope.tenantId,
          scope.spaceId,
          input.collectionRef,
          input.generation,
          input.indexDigest,
          JSON.stringify(input.indexRef),
          input.docCount,
          input.avgDocLength,
          input.completeness,
          input.builtAt,
        ],
      )
      const insertedRow = inserted.rows[0]
      if (insertedRow === undefined) {
        const concurrent = await this.#findByDigest(client, input.collectionRef, input.indexDigest)
        if (concurrent === undefined) {
          fail('a concurrent generation insert could not be read back')
        }
        return { generation: concurrent, created: false }
      }

      for (const document of input.documents) {
        await client.query(
          `INSERT INTO agent_platform.keyword_index_documents (
             tenant_id, space_id, collection_ref, generation, chunk_id, parse_id,
             document_ref_id, document_ref_version, document_digest, source_namespace, source_id,
             media_type, chunk_text, text_digest, locator, span_kind, precision, quote_digest,
             ordinal, doc_length, recorded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
                   $16, $17, $18, $19, $20, $21)`,
          [
            scope.tenantId,
            scope.spaceId,
            input.collectionRef,
            input.generation,
            document.chunkId,
            document.parseId,
            document.documentRef.id,
            document.documentRef.version,
            document.documentDigest,
            document.sourceRef?.namespace ?? null,
            document.sourceRef?.sourceId ?? null,
            document.mediaType,
            document.text,
            document.textDigest,
            JSON.stringify(document.locator),
            document.spanKind,
            document.precision,
            document.quoteDigest,
            document.ordinal,
            document.length,
            document.recordedAt,
          ],
        )
        for (const [term, termFrequency] of document.termFrequencies) {
          await client.query(
            `INSERT INTO agent_platform.keyword_index_postings (
               tenant_id, space_id, collection_ref, generation, term, chunk_id, term_frequency)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              scope.tenantId,
              scope.spaceId,
              input.collectionRef,
              input.generation,
              term,
              document.chunkId,
              termFrequency,
            ],
          )
        }
      }
      return { generation: toGeneration(insertedRow), created: true }
    })
  }

  async getGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<GenerationRow>(
          `SELECT ${GENERATION_COLUMNS} FROM agent_platform.keyword_index_generations
            WHERE collection_ref = $1 AND generation = $2`,
          [collectionRef, generation],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toGeneration(row)
      },
      { readOnly: true },
    )
  }

  async findGenerationByDigest(
    scopeRef: ScopeRef,
    collectionRef: string,
    indexDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    return this.#withScope(
      scope,
      (client) => this.#findByDigest(client, collectionRef, indexDigest),
      { readOnly: true },
    )
  }

  async getActiveGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<GenerationRow>(
          `SELECT ${GENERATION_COLUMNS_QUALIFIED}
             FROM agent_platform.keyword_index_active a
             JOIN agent_platform.keyword_index_generations g
               ON g.tenant_id = a.tenant_id AND g.space_id = a.space_id
              AND g.collection_ref = a.collection_ref AND g.generation = a.generation
            WHERE a.collection_ref = $1`,
          [collectionRef],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toGeneration(row)
      },
      { readOnly: true },
    )
  }

  async reserveGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    ctx: ToolContext,
  ): Promise<RevisionString> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    return this.#withScope(scope, async (client) => {
      const result = await client.query<{ counter: string }>(
        `INSERT INTO agent_platform.keyword_index_generation_counters (
           tenant_id, space_id, collection_ref, counter)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (tenant_id, space_id, collection_ref)
         DO UPDATE SET counter = agent_platform.keyword_index_generation_counters.counter + 1,
                       updated_at = now()
         RETURNING counter::text AS counter`,
        [scope.tenantId, scope.spaceId, collectionRef],
      )
      const row = result.rows[0]
      if (row === undefined) {
        fail('a keyword index generation counter could not be reserved')
      }
      return row.counter
    })
  }

  async activateGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    activatedAt: string,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    return this.#withScope(scope, async (client) => {
      const target = await client.query<GenerationRow>(
        `SELECT ${GENERATION_COLUMNS} FROM agent_platform.keyword_index_generations
          WHERE collection_ref = $1 AND generation = $2
          FOR UPDATE`,
        [collectionRef, generation],
      )
      const row = target.rows[0]
      if (row === undefined) {
        throw new DocumentSearchError(
          'SNAPSHOT_UNAVAILABLE',
          `generation ${generation} of ${collectionRef} does not exist`,
        )
      }
      await client.query(
        `UPDATE agent_platform.keyword_index_generations
            SET state = 'superseded'
          WHERE collection_ref = $1 AND generation <> $2 AND state = 'active'`,
        [collectionRef, generation],
      )
      await client.query(
        `UPDATE agent_platform.keyword_index_generations
            SET state = 'active'
          WHERE collection_ref = $1 AND generation = $2`,
        [collectionRef, generation],
      )
      await client.query(
        `INSERT INTO agent_platform.keyword_index_active (
           tenant_id, space_id, collection_ref, generation, activated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, space_id, collection_ref)
         DO UPDATE SET generation = EXCLUDED.generation, activated_at = EXCLUDED.activated_at`,
        [scope.tenantId, scope.spaceId, collectionRef, generation, activatedAt],
      )
      return toGeneration({ ...row, state: 'active' })
    })
  }

  async listGenerations(
    scopeRef: ScopeRef,
    collectionRef: string,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration[]> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<GenerationRow>(
          `SELECT ${GENERATION_COLUMNS} FROM agent_platform.keyword_index_generations
            WHERE collection_ref = $1
            ORDER BY generation::bigint`,
          [collectionRef],
        )
        return result.rows.map(toGeneration)
      },
      { readOnly: true },
    )
  }

  async listMatchingDocuments(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    terms: readonly string[],
    limit: number,
    ctx: ToolContext,
  ): Promise<MatchingDocumentPage> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    if (terms.length === 0) return { documents: [], truncated: false }
    return this.#withScope(
      scope,
      async (client) => {
        const matching = await client.query<{ chunk_id: string }>(
          `SELECT DISTINCT chunk_id
             FROM agent_platform.keyword_index_postings
            WHERE collection_ref = $1 AND generation = $2 AND term = ANY($3::text[])
            ORDER BY chunk_id
            LIMIT $4`,
          [collectionRef, generation, [...terms], limit + 1],
        )
        const truncated = matching.rows.length > limit
        const chunkIds = matching.rows.slice(0, limit).map((row) => row.chunk_id)
        if (chunkIds.length === 0) return { documents: [], truncated: false }

        const documents = await client.query<DocumentRow>(
          `SELECT ${DOCUMENT_COLUMNS} FROM agent_platform.keyword_index_documents
            WHERE collection_ref = $1 AND generation = $2 AND chunk_id = ANY($3::uuid[])`,
          [collectionRef, generation, chunkIds],
        )
        const postings = await client.query<PostingRow>(
          `SELECT chunk_id, term, term_frequency
             FROM agent_platform.keyword_index_postings
            WHERE collection_ref = $1 AND generation = $2
              AND chunk_id = ANY($3::uuid[]) AND term = ANY($4::text[])`,
          [collectionRef, generation, chunkIds, [...terms]],
        )
        const frequenciesByChunk = new Map<string, Map<string, number>>()
        for (const posting of postings.rows) {
          const bucket = frequenciesByChunk.get(posting.chunk_id) ?? new Map<string, number>()
          bucket.set(posting.term, posting.term_frequency)
          frequenciesByChunk.set(posting.chunk_id, bucket)
        }
        const mapped = documents.rows.map((row) =>
          toDocument(row, frequenciesByChunk.get(row.chunk_id) ?? new Map()),
        )
        mapped.sort((left, right) => (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0))
        return { documents: mapped, truncated }
      },
      { readOnly: true },
    )
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}
