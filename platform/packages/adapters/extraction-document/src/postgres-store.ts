import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import type {
  ChunkKind,
  CompletenessStatus,
  DocumentChunkRecord,
  DocumentMediaKind,
  DocumentPageRecord,
  DocumentParseRecord,
  DocumentParseStore,
  DocumentSpan,
  OffsetUnit,
  ParseCoverage,
  ParseStatus,
  RecordDocumentParseResult,
  ResourceKind,
  ResourceRef,
  ScopeRef,
  Semver,
  Sha256Digest,
  SpanPrecision,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { DocumentExtractionError } from './errors'

export interface PostgresDocumentParseStoreConfig {
  readonly connectionString: string
  readonly maxPoolSize?: number
  readonly statementTimeoutMs?: number
  readonly connectionTimeoutMs?: number
  readonly applicationName?: string
}

const REF_VERSION = '1.0.0'

interface ParseRow extends QueryResultRow {
  parse_id: string
  tenant_id: string
  space_id: string
  original_blob_ref_id: string
  original_content_digest: string
  original_media_type: string
  original_kind: string
  media_kind: string
  parser_id: string
  parser_version: string
  offset_unit: string
  parse_status: string
  completeness: string
  coverage: unknown
  pages: unknown
  normalized_blob_ref_id: string
  normalized_content_digest: string
  normalized_media_type: string
  span_map_blob_ref_id: string
  span_map_content_digest: string
  span_map_media_type: string
  source_namespace: string | null
  source_id: string | null
  document_version_ref: unknown
  created_at: Date
}

interface ChunkRow extends QueryResultRow {
  chunk_id: string
  ordinal: number
  chunk_kind: string
  heading: string | null
  chunk_text: string
  text_digest: string
  locator: unknown
  span_kind: string
  precision: string
  quote_digest: string
  conditions: unknown
  exceptions: unknown
  caption: string | null
  table_header: string | null
  parent_chunk_id: string | null
}

const PARSE_SELECT = `SELECT parse_id, tenant_id, space_id, original_blob_ref_id,
  original_content_digest, original_media_type, original_kind, media_kind, parser_id,
  parser_version, offset_unit, parse_status, completeness, coverage, pages,
  normalized_blob_ref_id, normalized_content_digest, normalized_media_type,
  span_map_blob_ref_id, span_map_content_digest, span_map_media_type,
  source_namespace, source_id, document_version_ref, created_at
  FROM agent_platform.document_parse_runs`

const CHUNK_SELECT = `SELECT chunk_id, ordinal, chunk_kind, heading, chunk_text, text_digest,
  locator, span_kind, precision, quote_digest, conditions, exceptions, caption,
  table_header, parent_chunk_id
  FROM agent_platform.document_chunks`

function fail(message: string): never {
  throw new DocumentExtractionError('SPAN_STORE_FAILED', message)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T
  }
  return fail(`${field} has an unexpected stored value`)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return fail(`${field} is not an array of strings`)
  }
  return value as string[]
}

function toCoverage(value: unknown): ParseCoverage {
  if (typeof value !== 'object' || value === null) return fail('coverage is not an object')
  const record = value as Record<string, unknown>
  const number = (field: string): number => {
    const candidate = record[field]
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
      return fail(`coverage.${field} is not a non-negative integer`)
    }
    return candidate
  }
  return {
    status: oneOf<ParseStatus>(record.status, ['complete', 'partial'], 'coverage.status'),
    completeness: oneOf<CompletenessStatus>(
      record.completeness,
      ['complete', 'partial', 'truncated', 'unknown'],
      'coverage.completeness',
    ),
    totalUnits: number('totalUnits'),
    parsedUnits: number('parsedUnits'),
    skippedUnits: number('skippedUnits'),
    skippedReasons: stringArray(record.skippedReasons, 'coverage.skippedReasons'),
    notes: stringArray(record.notes, 'coverage.notes'),
  }
}

function toPages(value: unknown): DocumentPageRecord[] {
  if (!Array.isArray(value)) return fail('pages is not an array')
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) return fail('a page record is not an object')
    const record = entry as Record<string, unknown>
    if (typeof record.page !== 'number' || typeof record.startOffset !== 'number') {
      return fail('a page record is missing page/startOffset')
    }
    if (typeof record.endOffset !== 'number' || typeof record.approximate !== 'boolean') {
      return fail('a page record is missing endOffset/approximate')
    }
    return {
      page: record.page,
      startOffset: record.startOffset,
      endOffset: record.endOffset,
      approximate: record.approximate,
    }
  })
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

function toResourceRef(
  id: string,
  digest: string,
  kind: ResourceKind,
): ResourceRef {
  return { id, version: REF_VERSION, digest, kind }
}

function toParseRecord(row: ParseRow): DocumentParseRecord {
  const documentVersionRef =
    row.document_version_ref === null || typeof row.document_version_ref !== 'object'
      ? undefined
      : (row.document_version_ref as ResourceRef)
  return {
    parseId: row.parse_id,
    scopeRef: { tenantId: row.tenant_id, spaceId: row.space_id },
    mediaKind: oneOf<DocumentMediaKind>(row.media_kind, ['pdf', 'text'], 'media_kind'),
    originalMediaType: row.original_media_type,
    originalRef: toResourceRef(
      row.original_blob_ref_id,
      row.original_content_digest,
      oneOf<ResourceKind>(row.original_kind, ['document'], 'original_kind'),
    ),
    normalizedMediaType: row.normalized_media_type,
    normalizedByteSize: Number(row.normalized_byte_size),
    normalizedRef: toResourceRef(row.normalized_blob_ref_id, row.normalized_content_digest, 'artifact'),
    spanMapMediaType: row.span_map_media_type,
    spanMapRef: toResourceRef(row.span_map_blob_ref_id, row.span_map_content_digest, 'artifact'),
    parserId: row.parser_id,
    parserVersion: row.parser_version,
    offsetUnit: oneOf<OffsetUnit>(row.offset_unit, ['byte', 'character'], 'offset_unit'),
    coverage: toCoverage(row.coverage),
    pages: toPages(row.pages),
    ...(row.source_namespace === null || row.source_id === null
      ? {}
      : { sourceRef: { namespace: row.source_namespace, sourceId: row.source_id } }),
    ...(documentVersionRef === undefined ? {} : { documentVersionRef }),
    createdAt: row.created_at.toISOString(),
  }
}

function toChunkRecord(row: ChunkRow): DocumentChunkRecord {
  const heading = row.heading ?? undefined
  const caption = row.caption ?? undefined
  const tableHeader = row.table_header ?? undefined
  const parentChunkId = row.parent_chunk_id ?? undefined
  return {
    chunkId: row.chunk_id,
    ordinal: row.ordinal,
    chunkKind: oneOf<ChunkKind>(
      row.chunk_kind,
      ['section', 'clause', 'table', 'paragraph', 'page'],
      'chunk_kind',
    ),
    ...(heading === undefined ? {} : { heading }),
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
    conditions: stringArray(row.conditions, 'conditions'),
    exceptions: stringArray(row.exceptions, 'exceptions'),
    ...(caption === undefined ? {} : { caption }),
    ...(tableHeader === undefined ? {} : { tableHeader }),
    ...(parentChunkId === undefined ? {} : { parentChunkId }),
  }
}

/**
 * PostgreSQL-backed parse store (migration 014). It connects as the non-owner
 * application role, so RLS is a real second line of defence behind the explicit
 * (tenant_id, space_id) predicates, and the session scope is cleared before the
 * connection returns to the pool.
 */
export class PostgresDocumentParseStore implements DocumentParseStore {
  readonly #pool: Pool

  constructor(config: PostgresDocumentParseStoreConfig) {
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 10,
      application_name: config.applicationName ?? 'ontology-document-parse-store',
      ...(config.statementTimeoutMs === undefined
        ? {}
        : { statement_timeout: config.statementTimeoutMs }),
      ...(config.connectionTimeoutMs === undefined
        ? {}
        : { connectionTimeoutMillis: config.connectionTimeoutMs }),
    })
  }

  async #withScope<T>(
    scope: ScopeRef,
    run: (client: PoolClient) => Promise<T>,
    options?: { readonly readOnly?: boolean },
  ): Promise<T> {
    const client = await this.#pool.connect()
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
      throw error
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

  async recordParse(
    record: DocumentParseRecord,
    chunks: readonly DocumentChunkRecord[],
    ctx: ToolContext,
  ): Promise<RecordDocumentParseResult> {
    const scope = scopeWith(record.scopeRef, ctx)
    return this.#withScope(scope, async (client) => {
      const inserted = await client.query<{ parse_id: string }>(
        `INSERT INTO agent_platform.document_parse_runs (
           tenant_id, space_id, parse_id,
           original_blob_ref_id, original_content_digest, original_media_type, original_kind,
           media_kind, parser_id, parser_version, offset_unit, parse_status, completeness,
           coverage, pages,
           normalized_blob_ref_id, normalized_content_digest, normalized_media_type,
           normalized_byte_size,
           span_map_blob_ref_id, span_map_content_digest, span_map_media_type,
           source_namespace, source_id, document_version_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                 $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::jsonb, $26)
         ON CONFLICT (tenant_id, space_id, original_content_digest, parser_version)
         DO NOTHING
         RETURNING parse_id`,
        [
          scope.tenantId,
          scope.spaceId,
          record.parseId,
          record.originalRef.id,
          record.originalRef.digest,
          record.originalMediaType,
          record.originalRef.kind,
          record.mediaKind,
          record.parserId,
          record.parserVersion,
          record.offsetUnit,
          record.coverage.status,
          record.coverage.completeness,
          JSON.stringify(record.coverage),
          JSON.stringify(record.pages),
          record.normalizedRef.id,
          record.normalizedRef.digest,
          record.normalizedMediaType,
          record.normalizedByteSize,
          record.spanMapRef.id,
          record.spanMapRef.digest,
          record.spanMapMediaType,
          record.sourceRef?.namespace ?? null,
          record.sourceRef?.sourceId ?? null,
          record.documentVersionRef === undefined
            ? null
            : JSON.stringify(record.documentVersionRef),
          record.createdAt,
        ],
      )
      if (inserted.rows[0] === undefined) {
        return { created: false }
      }
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO agent_platform.document_chunks (
             tenant_id, space_id, parse_id, chunk_id, ordinal, chunk_kind, heading, chunk_text,
             text_digest, locator, span_kind, precision, quote_digest, conditions, exceptions,
             caption, table_header, parent_chunk_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14::jsonb,
                   $15::jsonb, $16, $17, $18, $19)
           ON CONFLICT (tenant_id, space_id, parse_id, chunk_id) DO NOTHING`,
          [
            scope.tenantId,
            scope.spaceId,
            record.parseId,
            chunk.chunkId,
            chunk.ordinal,
            chunk.chunkKind,
            chunk.heading ?? null,
            chunk.text,
            chunk.textDigest,
            JSON.stringify(chunk.locator),
            chunk.spanKind,
            chunk.precision,
            chunk.quoteDigest,
            JSON.stringify(chunk.conditions),
            JSON.stringify(chunk.exceptions),
            chunk.caption ?? null,
            chunk.tableHeader ?? null,
            chunk.parentChunkId ?? null,
            record.createdAt,
          ],
        )
      }
      return { created: true }
    })
  }

  async findParseByDigest(
    scopeRef: ScopeRef,
    originalDigest: Sha256Digest,
    parserVersion: Semver | undefined,
    ctx: ToolContext,
  ): Promise<DocumentParseRecord | undefined> {
    const scope = scopeWith(scopeRef, ctx)
    return this.#withScope(
      scope,
      async (client) => {
        const versionFilter = parserVersion === undefined ? '' : ' AND parser_version = $4'
        const parameters =
          parserVersion === undefined
            ? [scope.tenantId, scope.spaceId, originalDigest]
            : [scope.tenantId, scope.spaceId, originalDigest, parserVersion]
        const result = await client.query<ParseRow>(
          `${PARSE_SELECT}
            WHERE tenant_id = $1 AND space_id = $2 AND original_content_digest = $3${versionFilter}
            ORDER BY created_at DESC, parser_version DESC
            LIMIT 1`,
          parameters,
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toParseRecord(row)
      },
      { readOnly: true },
    )
  }

  async getParse(
    scopeRef: ScopeRef,
    parseId: Uuid,
    ctx: ToolContext,
  ): Promise<DocumentParseRecord | undefined> {
    const scope = scopeWith(scopeRef, ctx)
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<ParseRow>(
          `${PARSE_SELECT}
            WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3`,
          [scope.tenantId, scope.spaceId, parseId],
        )
        const row = result.rows[0]
        return row === undefined ? undefined : toParseRecord(row)
      },
      { readOnly: true },
    )
  }

  async listChunks(
    scopeRef: ScopeRef,
    parseId: Uuid,
    ctx: ToolContext,
  ): Promise<DocumentChunkRecord[]> {
    const scope = scopeWith(scopeRef, ctx)
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<ChunkRow>(
          `${CHUNK_SELECT}
            WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3
            ORDER BY ordinal`,
          [scope.tenantId, scope.spaceId, parseId],
        )
        return result.rows.map(toChunkRecord)
      },
      { readOnly: true },
    )
  }

  async listChunksByScope(
    scopeRef: ScopeRef,
    limit: number,
    ctx: ToolContext,
  ): Promise<DocumentChunkRecord[]> {
    const scope = scopeWith(scopeRef, ctx)
    if (!Number.isInteger(limit) || limit < 1) {
      throw new DocumentExtractionError('INVALID_REQUEST', 'limit must be a positive integer')
    }
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<ChunkRow>(
          `${CHUNK_SELECT}
            WHERE tenant_id = $1 AND space_id = $2
            ORDER BY parse_id, ordinal
            LIMIT $3`,
          [scope.tenantId, scope.spaceId, limit],
        )
        return result.rows.map(toChunkRecord)
      },
      { readOnly: true },
    )
  }

  async close(): Promise<void> {
    await this.#pool.end()
  }
}

function scopeWith(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
  if (scopeRef.tenantId !== ctx.principal.tenantId) {
    throw new DocumentExtractionError('SCOPE_MISMATCH', 'scope does not match the trusted principal')
  }
  if (scopeRef.spaceId !== ctx.allowedResources.spaceId) {
    throw new DocumentExtractionError('SCOPE_MISMATCH', 'space does not match the trusted principal')
  }
  return scopeRef
}
