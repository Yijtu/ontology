import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { PostgresDocumentParseStore, LocalDocumentExtractionService, sha256DigestOfBytes } from '@ontology/adapter-extraction-document'
import { Bm25DocumentSearchService, Bm25IndexBuilder, PostgresKeywordIndexStore, createBm25DocumentSearchToolHandler } from '@ontology/adapter-search-bm25'
import type { DocumentParseRecord, DocumentSpanReaderPort, ReadSpanRequest, ReadSpanResponse, ScopeRef, ToolContext } from '@ontology/contracts'
import { DocumentSearchError } from '@ontology/adapter-search-bm25'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ToolHandler } from '@ontology/tool-services'

export const LOCAL_POLICY_COLLECTION = 'local-policy-library'
export const LOCAL_DOCUMENT_SOURCE = { namespace: 'local-operator-documents', sourceId: 'uploaded-policy-text' } as const
export const MAX_LOCAL_DOCUMENT_BYTES = 256 * 1024
const MAX_QUOTE_BYTES = 4096

export class LocalDocumentCollectionLimitError extends Error {
  readonly code = 'VERSION_CONFLICT'
  readonly httpStatus = 409
  constructor() {
    super('the local first-wave document profile currently indexes one controlled document; a second document requires a separate collection configuration')
    this.name = 'LocalDocumentCollectionLimitError'
  }
}

export class LocalDocumentCollectionBusyError extends Error {
  readonly code = 'VERSION_CONFLICT'
  readonly httpStatus = 409
  constructor() { super('another import is currently updating this document collection; retry after it completes'); this.name = 'LocalDocumentCollectionBusyError' }
}

export interface LocalDocumentImportResult {
  readonly documentRef: DocumentParseRecord['originalRef']
  readonly documentVersionRef: NonNullable<DocumentParseRecord['documentVersionRef']>
  readonly parseId: string
  readonly pageCount: number
  readonly chunkCount: number
  readonly completeness: DocumentParseRecord['coverage']['completeness']
  readonly collectionRef: string
  readonly indexGeneration: string
  readonly indexedDocumentCount: number
}

export interface ParsedOperatorDocument {
  readonly record: DocumentParseRecord
  readonly chunks: readonly import('@ontology/contracts').DocumentChunkRecord[]
}

/** Durable, scoped operator importer and exact span reader for the local markdown corpus. */
export class LocalDocumentCapability {
  readonly #blobs: LocalImmutableBlobStore
  readonly #parses: PostgresDocumentParseStore
  readonly #parser: LocalDocumentExtractionService
  readonly #index: PostgresKeywordIndexStore
  readonly #builder: Bm25IndexBuilder
  readonly #search: Bm25DocumentSearchService
  readonly #collectionRef: string
  readonly #sourceRef: { readonly namespace: string; readonly sourceId: string }
  readonly #lockPool: Pool
  readonly searchHandler: ToolHandler
  get parseStore(): PostgresDocumentParseStore { return this.#parses }

  constructor(options: { readonly connectionString: string; readonly blobs: LocalImmutableBlobStore; readonly collectionRef?: string; readonly sourceRef?: { readonly namespace: string; readonly sourceId: string } }) {
    this.#blobs = options.blobs
    this.#collectionRef = options.collectionRef ?? LOCAL_POLICY_COLLECTION
    this.#sourceRef = options.sourceRef ?? LOCAL_DOCUMENT_SOURCE
    this.#lockPool = new Pool({ connectionString: options.connectionString, max: 2, application_name: 'ontology-document-import-lock' })
    this.#parses = new PostgresDocumentParseStore({ connectionString: options.connectionString, maxPoolSize: 2 })
    this.#parser = new LocalDocumentExtractionService({ blobs: options.blobs, store: this.#parses })
    this.#index = new PostgresKeywordIndexStore({ connectionString: options.connectionString, maxPoolSize: 2 })
    this.#builder = new Bm25IndexBuilder({ parseStore: this.#parses, indexStore: this.#index })
    const spanReader: DocumentSpanReaderPort = { readSpan: (request, ctx) => this.#readSpan(request, ctx) }
    this.#search = new Bm25DocumentSearchService({ indexStore: this.#index, spanReader })
    this.searchHandler = createBm25DocumentSearchToolHandler({ service: this.#search })
  }

  async importMarkdown(input: { readonly title: string; readonly content: string; readonly mediaType?: 'text/markdown' | 'text/plain' }, ctx: ToolContext): Promise<LocalDocumentImportResult> {
    const title = input.title.trim()
    if (title.length === 0 || title.length > 200) throw new Error('document title must contain 1–200 characters')
    const content = input.content
    const bytes = new TextEncoder().encode(content)
    const mediaType = input.mediaType ?? 'text/markdown'
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_LOCAL_DOCUMENT_BYTES) throw new Error(`markdown must contain 1–${String(MAX_LOCAL_DOCUMENT_BYTES)} UTF-8 bytes`)
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const client = await this.#lockPool.connect()
    const lockKey = `document-index:${scope.tenantId}:${scope.spaceId}:${this.#collectionRef}`
    let acquired = false
    try {
      const result = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [lockKey])
      acquired = result.rows[0]?.locked === true
      if (!acquired) throw new LocalDocumentCollectionBusyError()
      return await this.#importLocked({ bytes, mediaType, scope }, ctx)
    } finally {
      if (!acquired) client.release()
      else {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockKey])
          client.release()
        } catch {
          // A failed unlock must not return a still-locked session to the pool.
          client.release(true)
        }
      }
    }
  }

  async #importLocked(input: { readonly bytes: Uint8Array; readonly mediaType: 'text/markdown' | 'text/plain'; readonly scope: ScopeRef }, ctx: ToolContext): Promise<LocalDocumentImportResult> {
    const { bytes, mediaType, scope } = input
    const contentDigest = sha256DigestOfBytes(bytes)
    const priorParse = await this.#parses.findParseByDigest(scope, contentDigest, '1.0.0', ctx)
    const activeIndex = await this.#index.getActiveGeneration(scope, this.#collectionRef, ctx)
    if (activeIndex !== undefined && activeIndex.docCount > 0) {
      const digests = await this.#index.listGenerationDocumentDigests(scope, this.#collectionRef, activeIndex.generation, ctx)
      if (digests.length !== 1 || digests[0] !== contentDigest) throw new LocalDocumentCollectionLimitError()
      if (priorParse?.documentVersionRef === undefined) throw new Error('the active document parse is unavailable for an idempotent import')
      const chunks = await this.#parses.listChunksBounded(scope, priorParse.parseId, 257, ctx)
      if (chunks.length > 256) throw new Error('the existing parse exceeds the supported 256-chunk limit')
      return {
        documentRef: priorParse.originalRef,
        documentVersionRef: priorParse.documentVersionRef,
        parseId: priorParse.parseId,
        pageCount: priorParse.pages.length,
        chunkCount: chunks.length,
        completeness: priorParse.coverage.completeness,
        collectionRef: this.#collectionRef,
        indexGeneration: activeIndex.generation,
        indexedDocumentCount: activeIndex.docCount,
      }
    }
    const staged = await this.#blobs.stage(bytes, { scopeRef: scope }, ctx)
    const stored = await this.#blobs.publish({ scopeRef: scope, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType, purpose: 'document' }, ctx)
    const documentVersionRef = { id: randomUUID(), version: '1.0.0', digest: contentDigest, kind: 'document' as const }
    const parsed = await this.#parser.parse({
      scopeRef: scope,
      originalRef: stored.blobRef,
      sourceRef: this.#sourceRef,
      documentVersionRef,
    }, ctx)
    if (parsed.coverage.completeness !== 'complete' || parsed.truncatedChunkIds.length > 0) throw new Error('the whole document was not parsed; incomplete documents are not indexed')
    const indexed = await this.#builder.build({ collectionRef: this.#collectionRef, parses: [parsed] }, ctx)
    await this.#builder.activate(this.#collectionRef, indexed.generation.generation, ctx)
    return {
      documentRef: parsed.originalRef,
      documentVersionRef,
      parseId: parsed.parseId,
      pageCount: parsed.pages.length,
      chunkCount: parsed.chunks.length,
      completeness: parsed.coverage.completeness,
      collectionRef: this.#collectionRef,
      indexGeneration: indexed.generation.generation,
      indexedDocumentCount: indexed.documentCount,
    }
  }

  async loadParsedDocument(parseId: string, ctx: ToolContext): Promise<ParsedOperatorDocument> {
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const record = await this.#parses.getParseById(scope, parseId, ctx)
    if (record === undefined) throw new Error('the requested parse is not visible in this tenant/space')
    if (record.coverage.status !== 'complete' || record.coverage.completeness !== 'complete' || record.offsetUnit !== 'byte') {
      throw new Error('candidate extraction requires a complete byte-offset text parse; partial/PDF parses are unsupported in this first wave')
    }
    const chunks = await this.#parses.listChunksBounded(scope, record.parseId, 257, ctx)
    if (chunks.length === 0 || chunks.length > 256 || chunks.some((chunk) => chunk.truncated || chunk.precision !== 'exact')) {
      throw new Error('candidate extraction requires 1–256 exact, non-truncated source chunks')
    }
    return { record, chunks }
  }

  async #readSpan(request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    if (request.locator.kind !== 'offset' || request.locator.startOffset === undefined || request.locator.endOffset === undefined || request.locator.endOffset < request.locator.startOffset) {
      throw new DocumentSearchError('UNSUPPORTED_QUERY', 'the local text reader only supports exact byte-offset spans')
    }
    const start = request.locator.startOffset
    const maxBytes = Math.min(request.maxBytes ?? MAX_QUOTE_BYTES, MAX_QUOTE_BYTES)
    if (request.locator.endOffset - start > maxBytes) throw new DocumentSearchError('UNSUPPORTED_QUERY', 'the requested source span exceeds the exact quote byte limit; no partial quote was returned')
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const authorized = await this.#blobs.getAuthorized({ scopeRef: scope, blobRef: request.documentRef }, ctx)
    const bytes = await this.#blobs.readAuthorized({ scopeRef: scope, blobRef: request.documentRef }, ctx)
    const end = request.locator.endOffset
    if (start < 0 || start > bytes.byteLength || request.locator.endOffset > bytes.byteLength) throw new DocumentSearchError('INVALID_ARGUMENT', 'span offsets are outside the original document')
    const quote = bytes.subarray(start, end)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(quote)
    const textDigest = sha256DigestOfBytes(quote)
    return {
      documentRef: request.documentRef,
      text,
      textDigest,
      snapshot: {
        sourceRef: this.#sourceRef,
        schemaVersion: 'operator-markdown@1.0.0',
        readAt: new Date().toISOString(),
        consistency: 'immutable',
        resultDigest: authorized.contentDigest,
      },
      ...(end < request.locator.endOffset ? { truncated: true } : {}),
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.#parses.close(), this.#index.close(), this.#lockPool.end()])
  }
}
