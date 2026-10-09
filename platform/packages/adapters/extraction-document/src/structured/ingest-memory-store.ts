import { isToolContext, isStructuredParseSelection } from '@ontology/contracts'
import type {
  RecordStructuredParseResult,
  ScopeRef,
  Semver,
  Sha256Digest,
  StructuredIngestionStore,
  StructuredParseRecord,
  StructuredRecordCounts,
  StructuredRecordEntry,
  StructuredRecordPage,
  StructuredRecordPageRequest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { StructuredIngestionError } from './ingest-errors'

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new StructuredIngestionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new StructuredIngestionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertScope(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
  const trusted = scopeOf(ctx)
  if (trusted.tenantId !== scopeRef.tenantId || trusted.spaceId !== scopeRef.spaceId) {
    throw new StructuredIngestionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
  return trusted
}

/** Decode the opaque numeric keyset cursor; a non-numeric cursor is refused, never restarted. */
function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0
  if (!/^\d+$/.test(cursor)) {
    throw new StructuredIngestionError('INVALID_REQUEST', 'the page cursor is invalid')
  }
  return Number.parseInt(cursor, 10)
}

/**
 * Process-local `StructuredIngestionStore` for unit tests. It keeps the same scope, idempotency
 * and cursor rules as the PostgreSQL store so a unit test cannot pass with behaviour the real
 * store would reject.
 */
export class InMemoryStructuredIngestionStore implements StructuredIngestionStore {
  readonly #parses = new Map<string, StructuredParseRecord>()
  readonly #records = new Map<string, StructuredRecordEntry[]>()
  #closed = false

  async recordParse(
    record: StructuredParseRecord,
    entries: readonly StructuredRecordEntry[],
    ctx: ToolContext,
  ): Promise<RecordStructuredParseResult> {
    this.#assertOpen()
    const scope = assertScope(record.scopeRef, ctx)
    if (record.parseOptions !== undefined && !isStructuredParseSelection(record.parseOptions)) throw new StructuredIngestionError('INVALID_REQUEST', 'stored native selection must match the strict supported contract')
    const key = `${scope.tenantId}|${scope.spaceId}|${record.originalRef.digest}|${record.parserVersion}`
    if (this.#parses.has(key)) return { created: false }
    this.#parses.set(key, record)
    this.#records.set(record.parseId, [...entries])
    return { created: true }
  }

  async getParse(scopeRef: ScopeRef, parseId: Uuid, ctx: ToolContext): Promise<StructuredParseRecord | undefined> {
    this.#assertOpen()
    const scope = assertScope(scopeRef, ctx)
    return [...this.#parses.values()].find((record) => record.parseId === parseId && record.scopeRef.tenantId === scope.tenantId && record.scopeRef.spaceId === scope.spaceId)
  }

  async findParseByDigest(
    scopeRef: ScopeRef,
    originalDigest: Sha256Digest,
    parserVersion: Semver | undefined,
    ctx: ToolContext,
  ): Promise<StructuredParseRecord | undefined> {
    this.#assertOpen()
    const scope = assertScope(scopeRef, ctx)
    let found: StructuredParseRecord | undefined
    for (const record of this.#parses.values()) {
      if (
        record.scopeRef.tenantId === scope.tenantId &&
        record.scopeRef.spaceId === scope.spaceId &&
        record.originalRef.digest === originalDigest &&
        (parserVersion === undefined || record.parserVersion === parserVersion)
      ) {
        if (found === undefined || record.createdAt > found.createdAt) found = record
      }
    }
    return found
  }

  async listRecords(
    scopeRef: ScopeRef,
    parseId: Uuid,
    page: StructuredRecordPageRequest,
    ctx: ToolContext,
  ): Promise<StructuredRecordPage> {
    this.#assertOpen()
    const scope = assertScope(scopeRef, ctx)
    if (!Number.isInteger(page.limit) || page.limit < 1) {
      throw new StructuredIngestionError('INVALID_REQUEST', 'limit must be a positive integer')
    }
    const record = this.#recordFor(scope, parseId)
    if (record === undefined) return { records: [], total: 0 }
    const after = decodeCursor(page.cursor)
    const all = [...(this.#records.get(parseId) ?? [])].sort((left, right) => left.recordIndex - right.recordIndex)
    const remaining = all.filter((entry) => entry.recordIndex > after)
    const slice = remaining.slice(0, page.limit)
    const nextCursor = remaining.length > page.limit ? String(slice[slice.length - 1]?.recordIndex ?? after) : undefined
    return {
      records: slice,
      total: all.length,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  }

  async countRecords(scopeRef: ScopeRef, parseId: Uuid, ctx: ToolContext): Promise<StructuredRecordCounts> {
    this.#assertOpen()
    const scope = assertScope(scopeRef, ctx)
    if (this.#recordFor(scope, parseId) === undefined) {
      return { total: 0, succeeded: 0, pending: 0, failed: 0, skipped: 0 }
    }
    return countOf(this.#records.get(parseId) ?? [])
  }

  async listFailures(
    scopeRef: ScopeRef,
    parseId: Uuid,
    limit: number,
    ctx: ToolContext,
  ): Promise<readonly StructuredRecordEntry[]> {
    this.#assertOpen()
    assertScope(scopeRef, ctx)
    if (!Number.isInteger(limit) || limit < 1) {
      throw new StructuredIngestionError('INVALID_REQUEST', 'limit must be a positive integer')
    }
    const all = [...(this.#records.get(parseId) ?? [])]
      .filter((entry) => entry.state === 'failed')
      .sort((left, right) => left.recordIndex - right.recordIndex)
    return all.slice(0, limit)
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#parses.clear()
    this.#records.clear()
  }

  #recordFor(scope: ScopeRef, parseId: Uuid): StructuredParseRecord | undefined {
    return [...this.#parses.values()].find(
      (candidate) =>
        candidate.parseId === parseId &&
        candidate.scopeRef.tenantId === scope.tenantId &&
        candidate.scopeRef.spaceId === scope.spaceId,
    )
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new StructuredIngestionError('PARSE_STORE_FAILED', 'the structured ingest store is closed')
    }
  }
}

/** Counts over the materialized rows; truncation pending is additionally carried by the header. */
function countOf(entries: readonly StructuredRecordEntry[]): StructuredRecordCounts {
  let succeeded = 0
  let pending = 0
  let failed = 0
  let skipped = 0
  for (const entry of entries) {
    if (entry.state === 'parsed') succeeded += 1
    else if (entry.state === 'pending') pending += 1
    else if (entry.state === 'failed') failed += 1
    else skipped += 1
  }
  return { total: entries.length, succeeded, pending, failed, skipped }
}
