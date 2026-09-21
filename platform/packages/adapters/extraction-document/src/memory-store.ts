import { isToolContext } from '@ontology/contracts'
import type {
  DocumentChunkRecord,
  DocumentParseRecord,
  DocumentParseStore,
  RecordDocumentParseResult,
  ScopeRef,
  Semver,
  Sha256Digest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { DocumentExtractionError } from './errors'

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new DocumentExtractionError(
      'SCOPE_MISMATCH',
      'a host-minted trusted tool context is required',
    )
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new DocumentExtractionError(
      'SCOPE_MISMATCH',
      'trusted context carries inconsistent tenant scope',
    )
  }
  return { tenantId, spaceId }
}

function assertScope(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
  const trusted = scopeOf(ctx)
  if (trusted.tenantId !== scopeRef.tenantId || trusted.spaceId !== scopeRef.spaceId) {
    throw new DocumentExtractionError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
  return trusted
}

/**
 * Process-local `DocumentParseStore` for unit tests. It keeps the same scope and
 * idempotency rules as the PostgreSQL store so a unit test cannot pass with
 * behaviour the real store would reject.
 */
export class InMemoryDocumentParseStore implements DocumentParseStore {
  readonly #parses = new Map<string, DocumentParseRecord>()
  readonly #chunks = new Map<string, DocumentChunkRecord[]>()
  #closed = false

  async recordParse(
    record: DocumentParseRecord,
    chunks: readonly DocumentChunkRecord[],
    ctx: ToolContext,
  ): Promise<RecordDocumentParseResult> {
    this.#assertOpen()
    const scope = assertScope(record.scopeRef, ctx)
    const key = `${scope.tenantId}|${scope.spaceId}|${record.originalRef.digest}|${record.parserVersion}`
    if (this.#parses.has(key)) {
      return { created: false }
    }
    this.#parses.set(key, record)
    this.#chunks.set(record.parseId, [...chunks])
    return { created: true }
  }

  async findParseByDigest(
    scopeRef: ScopeRef,
    originalDigest: Sha256Digest,
    parserVersion: Semver | undefined,
    ctx: ToolContext,
  ): Promise<DocumentParseRecord | undefined> {
    this.#assertOpen()
    const scope = assertScope(scopeRef, ctx)
    let found: DocumentParseRecord | undefined
    for (const record of this.#parses.values()) {
      if (
        record.scopeRef.tenantId === scope.tenantId &&
        record.scopeRef.spaceId === scope.spaceId &&
        record.originalRef.digest === originalDigest &&
        (parserVersion === undefined || record.parserVersion === parserVersion)
      ) {
        if (found === undefined || record.createdAt > found.createdAt) {
          found = record
        }
      }
    }
    return found
  }

  async listChunks(
    scopeRef: ScopeRef,
    parseId: Uuid,
    ctx: ToolContext,
  ): Promise<DocumentChunkRecord[]> {
    this.#assertOpen()
    const scope = assertScope(scopeRef, ctx)
    const record = [...this.#parses.values()].find(
      (candidate) =>
        candidate.parseId === parseId &&
        candidate.scopeRef.tenantId === scope.tenantId &&
        candidate.scopeRef.spaceId === scope.spaceId,
    )
    if (record === undefined) return []
    return [...(this.#chunks.get(parseId) ?? [])]
  }

  async listChunksByScope(
    scopeRef: ScopeRef,
    limit: number,
    ctx: ToolContext,
  ): Promise<DocumentChunkRecord[]> {
    this.#assertOpen()
    const scope = assertScope(scopeRef, ctx)
    const out: DocumentChunkRecord[] = []
    for (const record of this.#parses.values()) {
      if (record.scopeRef.tenantId !== scope.tenantId || record.scopeRef.spaceId !== scope.spaceId) {
        continue
      }
      for (const chunk of this.#chunks.get(record.parseId) ?? []) {
        if (out.length >= limit) return out
        out.push(chunk)
      }
    }
    return out
  }

  async close(): Promise<void> {
    this.#closed = true
    this.#parses.clear()
    this.#chunks.clear()
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the parse store is closed')
    }
  }
}
