import { Pool } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'
import type {
  CompletenessStatus,
  ParseCoverage,
  ParseStatus,
  RecordStructuredParseResult,
  ResourceKind,
  ResourceRef,
  ScopeRef,
  Semver,
  Sha256Digest,
  SourceLocator,
  StructuredFormat,
  StructuredIngestionStore,
  StructuredParseIssue,
  StructuredParseIssueCode,
  StructuredParseRecord,
  StructuredParseStatus,
  StructuredRecordCounts,
  StructuredRecordEntry,
  StructuredRecordError,
  StructuredRecordPage,
  StructuredRecordPageRequest,
  StructuredRecordState,
  StructuredSheetInfo,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { StructuredIngestionError } from './ingest-errors'

export interface PostgresStructuredIngestionStoreConfig {
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
  format: string
  parser_id: string
  parser_version: string
  parse_status: string
  coverage: unknown
  counts: unknown
  sheets: unknown
  diagnostics: unknown
  source_namespace: string | null
  source_id: string | null
  document_version_ref: unknown
  created_at: Date
}

interface RecordRow extends QueryResultRow {
  record_id: string
  source_row_key: string
  record_index: number
  row_number: number
  state: string
  locator: unknown
  row_digest: string
  column_count: number
  error: unknown
}

const PARSE_SELECT = `SELECT parse_id, tenant_id, space_id, original_blob_ref_id,
  original_content_digest, original_media_type, original_kind, format, parser_id, parser_version,
  parse_status, coverage, counts, sheets, diagnostics, source_namespace, source_id,
  document_version_ref, created_at
  FROM agent_platform.document_structured_parses`

const RECORD_SELECT = `SELECT record_id, source_row_key, record_index, row_number, state, locator,
  row_digest, column_count, error
  FROM agent_platform.document_structured_records`

function fail(message: string): never {
  throw new StructuredIngestionError('PARSE_STORE_FAILED', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  return fail(`${field} has an unexpected stored value`)
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return fail(`${field} is not a non-negative integer`)
  }
  return value
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    return fail(`${field} is not an array of strings`)
  }
  return value as string[]
}

function toCoverage(value: unknown): ParseCoverage {
  if (!isRecord(value)) return fail('coverage is not an object')
  return {
    status: oneOf<ParseStatus>(value['status'], ['complete', 'partial'], 'coverage.status'),
    completeness: oneOf<CompletenessStatus>(
      value['completeness'],
      ['complete', 'partial', 'truncated', 'unknown'],
      'coverage.completeness',
    ),
    totalUnits: nonNegativeInteger(value['totalUnits'], 'coverage.totalUnits'),
    parsedUnits: nonNegativeInteger(value['parsedUnits'], 'coverage.parsedUnits'),
    skippedUnits: nonNegativeInteger(value['skippedUnits'], 'coverage.skippedUnits'),
    skippedReasons: stringArray(value['skippedReasons'], 'coverage.skippedReasons'),
    notes: stringArray(value['notes'], 'coverage.notes'),
  }
}

function toCounts(value: unknown): StructuredRecordCounts {
  if (!isRecord(value)) return fail('counts is not an object')
  return {
    total: nonNegativeInteger(value['total'], 'counts.total'),
    succeeded: nonNegativeInteger(value['succeeded'], 'counts.succeeded'),
    pending: nonNegativeInteger(value['pending'], 'counts.pending'),
    failed: nonNegativeInteger(value['failed'], 'counts.failed'),
    skipped: nonNegativeInteger(value['skipped'], 'counts.skipped'),
  }
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${field} is not a number`)
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return fail(`${field} is not a string`)
  return value
}

function normalizationRef(value: unknown): string {
  if (typeof value !== 'string') return fail('locator.normalizationMapRef is not a string')
  return value
}

function toLocator(value: unknown): SourceLocator {
  if (!isRecord(value)) return fail('locator is not an object')
  const kind = value['kind']
  if (kind === 'offset') {
    return {
      kind: 'offset',
      startOffset: nonNegativeInteger(value['startOffset'], 'locator.startOffset'),
      endOffset: nonNegativeInteger(value['endOffset'], 'locator.endOffset'),
      ...(optionalString(value['normalizationMapRef'], 'locator.normalizationMapRef') === undefined
        ? {}
        : { normalizationMapRef: normalizationRef(value['normalizationMapRef']) }),
    }
  }
  if (kind === 'page') {
    return {
      kind: 'page',
      page: nonNegativeInteger(value['page'], 'locator.page'),
      ...(optionalNumber(value['startOffset'], 'locator.startOffset') === undefined
        ? {}
        : { startOffset: optionalNumber(value['startOffset'], 'locator.startOffset') as number }),
      ...(optionalNumber(value['endOffset'], 'locator.endOffset') === undefined
        ? {}
        : { endOffset: optionalNumber(value['endOffset'], 'locator.endOffset') as number }),
      ...(optionalString(value['normalizationMapRef'], 'locator.normalizationMapRef') === undefined
        ? {}
        : { normalizationMapRef: normalizationRef(value['normalizationMapRef']) }),
    }
  }
  if (kind === 'approximate_locator') {
    const page = optionalNumber(value['page'], 'locator.page')
    const startOffset = optionalNumber(value['startOffset'], 'locator.startOffset')
    const endOffset = optionalNumber(value['endOffset'], 'locator.endOffset')
    const map = optionalString(value['normalizationMapRef'], 'locator.normalizationMapRef')
    return {
      kind: 'approximate_locator',
      ...(page === undefined ? {} : { page }),
      ...(startOffset === undefined ? {} : { startOffset }),
      ...(endOffset === undefined ? {} : { endOffset }),
      ...(map === undefined ? {} : { normalizationMapRef: map }),
    }
  }
  if (kind === 'json_pointer') {
    return {
      kind: 'json_pointer',
      pointer: optionalString(value['pointer'], 'locator.pointer') ?? fail('locator.pointer is missing'),
      startByte: nonNegativeInteger(value['startByte'], 'locator.startByte'),
      endByte: nonNegativeInteger(value['endByte'], 'locator.endByte'),
      normalizationMapRef: normalizationRef(value['normalizationMapRef']),
    }
  }
  if (kind === 'table_cell') {
    const format = oneOf(value['format'], ['csv', 'xlsx'] as const, 'locator.format')
    const sheetId = optionalString(value['sheetId'], 'locator.sheetId')
    const sheetName = optionalString(value['sheetName'], 'locator.sheetName')
    const address = optionalString(value['address'], 'locator.address')
    const startByte = optionalNumber(value['startByte'], 'locator.startByte')
    const endByte = optionalNumber(value['endByte'], 'locator.endByte')
    return {
      kind: 'table_cell',
      format,
      ...(sheetId === undefined ? {} : { sheetId }),
      ...(sheetName === undefined ? {} : { sheetName }),
      recordIndex: nonNegativeInteger(value['recordIndex'], 'locator.recordIndex'),
      row: nonNegativeInteger(value['row'], 'locator.row'),
      column: nonNegativeInteger(value['column'], 'locator.column'),
      ...(address === undefined ? {} : { address }),
      ...(startByte === undefined ? {} : { startByte }),
      ...(endByte === undefined ? {} : { endByte }),
      normalizationMapRef: normalizationRef(value['normalizationMapRef']),
    }
  }
  if (kind === 'table_row') {
    const format = oneOf(value['format'], ['csv', 'xlsx'] as const, 'locator.format')
    const sheetId = optionalString(value['sheetId'], 'locator.sheetId')
    const sheetName = optionalString(value['sheetName'], 'locator.sheetName')
    return {
      kind: 'table_row',
      format,
      ...(sheetId === undefined ? {} : { sheetId }),
      ...(sheetName === undefined ? {} : { sheetName }),
      recordIndex: nonNegativeInteger(value['recordIndex'], 'locator.recordIndex'),
      row: nonNegativeInteger(value['row'], 'locator.row'),
      columnFrom: nonNegativeInteger(value['columnFrom'], 'locator.columnFrom'),
      columnTo: nonNegativeInteger(value['columnTo'], 'locator.columnTo'),
      normalizationMapRef: normalizationRef(value['normalizationMapRef']),
    }
  }
  return fail('locator.kind is not a known locator')
}

function toSheets(value: unknown): StructuredSheetInfo[] {
  if (!Array.isArray(value)) return fail('sheets is not an array')
  return value.map((entry) => {
    if (!isRecord(entry)) return fail('a sheet record is not an object')
    return {
      sheetId: optionalString(entry['sheetId'], 'sheet.sheetId') ?? fail('sheet.sheetId is missing'),
      name: optionalString(entry['name'], 'sheet.name') ?? fail('sheet.name is missing'),
      hidden: entry['hidden'] === true,
      target: optionalString(entry['target'], 'sheet.target') ?? fail('sheet.target is missing'),
    }
  })
}

function toDiagnostics(value: unknown): StructuredParseIssue[] {
  if (!Array.isArray(value)) return fail('diagnostics is not an array')
  return value.map((entry) => {
    if (!isRecord(entry)) return fail('a diagnostic is not an object')
    const sheetName = optionalString(entry['sheetName'], 'diagnostic.sheetName')
    const row = optionalNumber(entry['row'], 'diagnostic.row')
    const pointer = optionalString(entry['pointer'], 'diagnostic.pointer')
    return {
      code: oneOf<StructuredParseIssueCode>(
        entry['code'],
        [
          'UNSUPPORTED_MEDIA_TYPE',
          'UNSUPPORTED_DOCUMENT_TYPE',
          'SCANNED_DOCUMENT',
          'UNSUPPORTED_DOCUMENT_GEOMETRY',
          'MACRO_ENABLED_WORKBOOK',
          'ENCRYPTED_WORKBOOK',
          'UNSUPPORTED_ZIP',
          'FILE_TOO_LARGE',
          'EXPANSION_TOO_LARGE',
          'TOO_MANY_ZIP_ENTRIES',
          'TOO_MANY_ROWS',
          'TOO_MANY_COLUMNS',
          'CELL_TOO_LARGE',
          'NESTING_TOO_DEEP',
          'UNSUPPORTED_MULTI_LEVEL_HEADER',
          'MERGED_CELLS',
          'UNSUPPORTED_TABLE_LAYOUT',
          'INVALID_UTF8',
          'INVALID_JSON',
          'DUPLICATE_JSON_KEY',
          'MALFORMED_CSV',
          'MALFORMED_XLSX',
          'MISSING_SHEET',
          'EMPTY_INPUT',
          'PARSE_FAILED',
        ],
        'diagnostic.code',
      ),
      severity: oneOf(entry['severity'], ['error', 'warning'] as const, 'diagnostic.severity'),
      message: optionalString(entry['message'], 'diagnostic.message') ?? fail('diagnostic.message is missing'),
      ...(sheetName === undefined ? {} : { sheetName }),
      ...(row === undefined ? {} : { row }),
      ...(pointer === undefined ? {} : { pointer }),
    }
  })
}

function toResourceRef(id: string, digest: string, kind: ResourceKind): ResourceRef {
  return { id, version: REF_VERSION, digest, kind }
}

function toParseRecord(row: ParseRow): StructuredParseRecord {
  const documentVersionRef =
    row.document_version_ref === null || !isRecord(row.document_version_ref)
      ? undefined
      : (row.document_version_ref as unknown as ResourceRef)
  return {
    parseId: row.parse_id,
    scopeRef: { tenantId: row.tenant_id, spaceId: row.space_id },
    format: oneOf<StructuredFormat>(row.format, ['text', 'json', 'csv', 'xlsx'], 'format'),
    originalMediaType: row.original_media_type,
    originalRef: toResourceRef(
      row.original_blob_ref_id,
      row.original_content_digest,
      oneOf<ResourceKind>(row.original_kind, ['document'], 'original_kind'),
    ),
    parserId: row.parser_id,
    parserVersion: row.parser_version,
    status: oneOf<StructuredParseStatus>(
      row.parse_status,
      ['complete', 'incomplete', 'rejected'],
      'parse_status',
    ),
    coverage: toCoverage(row.coverage),
    counts: toCounts(row.counts),
    sheets: toSheets(row.sheets),
    diagnostics: toDiagnostics(row.diagnostics),
    ...(row.source_namespace === null || row.source_id === null
      ? {}
      : { sourceRef: { namespace: row.source_namespace, sourceId: row.source_id } }),
    ...(documentVersionRef === undefined ? {} : { documentVersionRef }),
    createdAt: row.created_at.toISOString(),
  }
}

function toRecordError(value: unknown): StructuredRecordError | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) return fail('record error is not an object')
  const locator = value['locator']
  return {
    code: optionalString(value['code'], 'error.code') ?? fail('error.code is missing'),
    message: optionalString(value['message'], 'error.message') ?? fail('error.message is missing'),
    ...(locator === undefined || locator === null ? {} : { locator: toLocator(locator) }),
  }
}

function toRecordEntry(row: RecordRow): StructuredRecordEntry {
  const error = toRecordError(row.error)
  return {
    recordId: row.record_id,
    sourceRowKey: row.source_row_key,
    recordIndex: row.record_index,
    row: row.row_number,
    state: oneOf<StructuredRecordState>(
      row.state,
      ['parsed', 'pending', 'failed', 'skipped'],
      'record.state',
    ),
    locator: toLocator(row.locator),
    rowDigest: row.row_digest,
    columnCount: row.column_count,
    ...(error === undefined ? {} : { error }),
  }
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d+$/.test(cursor)) {
    throw new StructuredIngestionError('INVALID_REQUEST', 'the page cursor is invalid')
  }
  return Number.parseInt(cursor, 10)
}

/**
 * PostgreSQL-backed structured ingestion store (migration 059). It connects as the non-owner
 * application role, so RLS is a real second line of defence behind the explicit
 * (tenant_id, space_id) predicates, and the session scope is cleared before the connection
 * returns to the pool.
 */
export class PostgresStructuredIngestionStore implements StructuredIngestionStore {
  readonly #pool: Pool

  constructor(config: PostgresStructuredIngestionStoreConfig) {
    this.#pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxPoolSize ?? 10,
      application_name: config.applicationName ?? 'ontology-structured-ingestion-store',
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
    record: StructuredParseRecord,
    entries: readonly StructuredRecordEntry[],
    ctx: ToolContext,
  ): Promise<RecordStructuredParseResult> {
    const scope = scopeWith(record.scopeRef, ctx)
    return this.#withScope(scope, async (client) => {
      const inserted = await client.query<{ parse_id: string }>(
        `INSERT INTO agent_platform.document_structured_parses (
           tenant_id, space_id, parse_id,
           original_blob_ref_id, original_content_digest, original_media_type, original_kind,
           format, parser_id, parser_version, parse_status, coverage, counts, sheets, diagnostics,
           source_namespace, source_id, document_version_ref, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb,
                 $14::jsonb, $15::jsonb, $16, $17, $18::jsonb, $19)
         ON CONFLICT (tenant_id, space_id, original_content_digest, parser_version) DO NOTHING
         RETURNING parse_id`,
        [
          scope.tenantId,
          scope.spaceId,
          record.parseId,
          record.originalRef.id,
          record.originalRef.digest,
          record.originalMediaType,
          record.originalRef.kind,
          record.format,
          record.parserId,
          record.parserVersion,
          record.status,
          JSON.stringify(record.coverage),
          JSON.stringify(record.counts),
          JSON.stringify(record.sheets),
          JSON.stringify(record.diagnostics),
          record.sourceRef?.namespace ?? null,
          record.sourceRef?.sourceId ?? null,
          record.documentVersionRef === undefined ? null : JSON.stringify(record.documentVersionRef),
          record.createdAt,
        ],
      )
      if (inserted.rows[0] === undefined) return { created: false }
      for (const entry of entries) {
        await client.query(
          `INSERT INTO agent_platform.document_structured_records (
             tenant_id, space_id, parse_id, record_id, source_row_key, record_index, row_number,
             state, locator, row_digest, column_count, error, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13)
           ON CONFLICT (tenant_id, space_id, parse_id, source_row_key) DO NOTHING`,
          [
            scope.tenantId,
            scope.spaceId,
            record.parseId,
            entry.recordId,
            entry.sourceRowKey,
            entry.recordIndex,
            entry.row,
            entry.state,
            JSON.stringify(entry.locator),
            entry.rowDigest,
            entry.columnCount,
            entry.error === undefined ? null : JSON.stringify(entry.error),
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
  ): Promise<StructuredParseRecord | undefined> {
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

  async listRecords(
    scopeRef: ScopeRef,
    parseId: Uuid,
    page: StructuredRecordPageRequest,
    ctx: ToolContext,
  ): Promise<StructuredRecordPage> {
    const scope = scopeWith(scopeRef, ctx)
    if (!Number.isInteger(page.limit) || page.limit < 1) {
      throw new StructuredIngestionError('INVALID_REQUEST', 'limit must be a positive integer')
    }
    const after = decodeCursor(page.cursor)
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<RecordRow>(
          `${RECORD_SELECT}
            WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3 AND record_index > $4
            ORDER BY record_index
            LIMIT $5`,
          [scope.tenantId, scope.spaceId, parseId, after, page.limit + 1],
        )
        const totalResult = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM agent_platform.document_structured_records
            WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3`,
          [scope.tenantId, scope.spaceId, parseId],
        )
        const total = Number(totalResult.rows[0]?.count ?? '0')
        const hasMore = result.rows.length > page.limit
        const rows = hasMore ? result.rows.slice(0, page.limit) : result.rows
        const last = rows[rows.length - 1]
        return {
          records: rows.map(toRecordEntry),
          total,
          ...(hasMore && last !== undefined ? { nextCursor: String(last.record_index) } : {}),
        }
      },
      { readOnly: true },
    )
  }

  async countRecords(scopeRef: ScopeRef, parseId: Uuid, ctx: ToolContext): Promise<StructuredRecordCounts> {
    const scope = scopeWith(scopeRef, ctx)
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<{ state: string; count: string }>(
          `SELECT state, count(*)::text AS count FROM agent_platform.document_structured_records
            WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3
            GROUP BY state`,
          [scope.tenantId, scope.spaceId, parseId],
        )
        const counts: StructuredRecordCounts = {
          total: 0,
          succeeded: 0,
          pending: 0,
          failed: 0,
          skipped: 0,
        }
        const mutable = { ...counts }
        for (const row of result.rows) {
          const count = Number(row.count)
          mutable.total += count
          if (row.state === 'parsed') mutable.succeeded += count
          else if (row.state === 'pending') mutable.pending += count
          else if (row.state === 'failed') mutable.failed += count
          else if (row.state === 'skipped') mutable.skipped += count
        }
        return mutable
      },
      { readOnly: true },
    )
  }

  async listFailures(
    scopeRef: ScopeRef,
    parseId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<readonly StructuredRecordEntry[]> {
    const scope = scopeWith(scopeRef, ctx)
    if (!Number.isInteger(limit) || limit < 1) {
      throw new StructuredIngestionError('INVALID_REQUEST', 'limit must be a positive integer')
    }
    return this.#withScope(
      scope,
      async (client) => {
        const result = await client.query<RecordRow>(
          `${RECORD_SELECT}
            WHERE tenant_id = $1 AND space_id = $2 AND parse_id = $3 AND state = 'failed'
            ORDER BY record_index
            LIMIT $4`,
          [scope.tenantId, scope.spaceId, parseId, limit],
        )
        return result.rows.map(toRecordEntry)
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
    throw new StructuredIngestionError('SCOPE_MISMATCH', 'scope does not match the trusted principal')
  }
  if (scopeRef.spaceId !== ctx.allowedResources.spaceId) {
    throw new StructuredIngestionError('SCOPE_MISMATCH', 'space does not match the trusted principal')
  }
  return scopeRef
}
