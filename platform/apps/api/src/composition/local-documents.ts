import { randomUUID } from 'node:crypto'
import { PostgresDocumentParseStore, LocalDocumentExtractionService, sha256DigestOfBytes } from '@ontology/adapter-extraction-document'
import { Bm25DocumentSearchService, Bm25IndexBuilder, PostgresKeywordIndexStore, createBm25DocumentSearchToolHandler } from '@ontology/adapter-search-bm25'
import type { DocumentParseRecord, DocumentSpanReaderPort, ReadSpanRequest, ReadSpanResponse, ScopeRef, ToolContext } from '@ontology/contracts'
import { DocumentSearchError } from '@ontology/adapter-search-bm25'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ToolHandler } from '@ontology/tool-services'
import type { ImmutableArtifactWriter } from '@ontology/contracts'

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

/** Durable, scoped operator importer and exact span reader for the local markdown corpus. */
export class LocalDocumentCapability {
  readonly #blobs: LocalImmutableBlobStore
  readonly #artifacts: ImmutableArtifactWriter
  readonly #parses: PostgresDocumentParseStore
  readonly #parser: LocalDocumentExtractionService
  readonly #index: PostgresKeywordIndexStore
  readonly #builder: Bm25IndexBuilder
  readonly #search: Bm25DocumentSearchService
  readonly searchHandler: ToolHandler

  constructor(options: { readonly connectionString: string; readonly blobs: LocalImmutableBlobStore; readonly artifacts: ImmutableArtifactWriter }) {
    this.#blobs = options.blobs
    this.#artifacts = options.artifacts
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
    const priorParse = await this.#parses.findParseByDigest(scope, sha256DigestOfBytes(bytes), '1.0.0', ctx)
    const activeIndex = await this.#index.getActiveGeneration(scope, LOCAL_POLICY_COLLECTION, ctx)
    if (activeIndex !== undefined && activeIndex.docCount > 0 && priorParse === undefined) {
      throw new LocalDocumentCollectionLimitError()
    }
    const stored = await this.#artifacts.putBytes({ scopeRef: scope, content: bytes, mediaType }, ctx)
    const documentVersionRef = { id: randomUUID(), version: '1.0.0', digest: sha256DigestOfBytes(bytes), kind: 'document' as const }
    const parsed = await this.#parser.parse({
      scopeRef: scope,
      originalRef: stored.blobRef,
      sourceRef: LOCAL_DOCUMENT_SOURCE,
      documentVersionRef,
    }, ctx)
    if (parsed.coverage.completeness !== 'complete' || parsed.truncatedChunkIds.length > 0) throw new Error('the whole document was not parsed; incomplete documents are not indexed')
    const indexed = await this.#builder.build({ collectionRef: LOCAL_POLICY_COLLECTION, parses: [parsed] }, ctx)
    await this.#builder.activate(LOCAL_POLICY_COLLECTION, indexed.generation.generation, ctx)
    return {
      documentRef: parsed.originalRef,
      documentVersionRef,
      parseId: parsed.parseId,
      pageCount: parsed.pages.length,
      chunkCount: parsed.chunks.length,
      completeness: parsed.coverage.completeness,
      collectionRef: LOCAL_POLICY_COLLECTION,
      indexGeneration: indexed.generation.generation,
      indexedDocumentCount: indexed.documentCount,
    }
  }

  async #readSpan(request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    if (request.locator.kind !== 'offset' || request.locator.startOffset === undefined || request.locator.endOffset === undefined || request.locator.endOffset < request.locator.startOffset) {
      throw new DocumentSearchError('UNSUPPORTED_QUERY', 'the local text reader only supports exact byte-offset spans')
    }
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const authorized = await this.#blobs.getAuthorized({ scopeRef: scope, blobRef: request.documentRef }, ctx)
    const bytes = await this.#blobs.readAuthorized({ scopeRef: scope, blobRef: request.documentRef }, ctx)
    const start = request.locator.startOffset
    const end = Math.min(request.locator.endOffset, start + Math.min(request.maxBytes ?? MAX_QUOTE_BYTES, MAX_QUOTE_BYTES))
    if (start < 0 || start > bytes.byteLength || request.locator.endOffset > bytes.byteLength) throw new DocumentSearchError('INVALID_ARGUMENT', 'span offsets are outside the original document')
    const quote = bytes.subarray(start, end)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(quote)
    const textDigest = sha256DigestOfBytes(quote)
    return {
      documentRef: request.documentRef,
      text,
      textDigest,
      snapshot: {
        sourceRef: LOCAL_DOCUMENT_SOURCE,
        schemaVersion: 'operator-markdown@1.0.0',
        readAt: new Date().toISOString(),
        consistency: 'immutable',
        resultDigest: authorized.contentDigest,
      },
      ...(end < request.locator.endOffset ? { truncated: true } : {}),
    }
  }

  async close(): Promise<void> {
    await Promise.all([this.#parses.close(), this.#index.close()])
  }
}
