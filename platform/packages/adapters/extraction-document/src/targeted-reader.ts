import { isToolContext } from '@ontology/contracts'
import type {
  DocumentParseRecord,
  DocumentParseStore,
  DocumentSpan,
  DocumentTargetedReadItem,
  DocumentTargetedReadReason,
  DocumentTargetedReadRequest,
  DocumentTargetedReadResult,
  DocumentTargetedReaderPort,
  DocumentTargetedSelection,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { DocumentTargetedReadError } from '@ontology/contracts'
import { DocumentExtractionError } from './errors'
import { sha256DigestOfText } from './hashing'
import { DocumentSpanReader } from './span-reader'
import type { DocumentArtifactStore } from './types'

/**
 * Whether a document's parse is served by a ready keyword/vector index. The reader must not treat
 * "not indexed" as "no content": when the index is not built it reads the archived parse directly
 * and reports `not_indexed_readable` (design §6).
 */
export interface DocumentIndexPresencePort {
  isIndexed(scopeRef: ScopeRef, parseId: Uuid, ctx: ToolContext): Promise<boolean>
}

export interface DocumentTargetedReaderDependencies {
  readonly blobs: DocumentArtifactStore
  readonly store: DocumentParseStore
  /** Absent means "no index is wired": every readable parse is a direct archive read. */
  readonly index?: DocumentIndexPresencePort
  readonly spanReader?: DocumentSpanReader
  readonly now?: () => string
}

interface CursorPosition {
  readonly selectionIndex: number
  readonly offset: number
}

const MAX_SELECTIONS = 16

function trustedScope(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new DocumentTargetedReadError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function parseCursor(cursor: string | undefined): CursorPosition {
  if (cursor === undefined) return { selectionIndex: 0, offset: 0 }
  const match = /^(\d+):(\d+)$/.exec(cursor)
  if (match === null) throw new DocumentTargetedReadError('INVALID_REQUEST', 'invalid targeted-read cursor')
  const selectionIndex = Number(match[1])
  const offset = Number(match[2])
  if (!Number.isSafeInteger(selectionIndex) || !Number.isSafeInteger(offset) || selectionIndex < 0 || offset < 0) {
    throw new DocumentTargetedReadError('INVALID_REQUEST', 'invalid targeted-read cursor')
  }
  return { selectionIndex, offset }
}

function reasonForExtractionError(error: DocumentExtractionError): DocumentTargetedReadReason {
  switch (error.code) {
    case 'DOCUMENT_NOT_PARSED':
    case 'SPAN_STORE_FAILED':
      return 'parse_not_ready'
    case 'SCOPE_MISMATCH':
      return 'not_authorized'
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'ORIGINAL_UNREADABLE':
      return 'unsupported_media_type'
    default:
      return 'empty'
  }
}

/**
 * The `document_search` versioned targeted reader (design §6).
 *
 * It resolves each already-authorized selection to its exact parse, returns the span text through
 * the existing `DocumentSpanReader` (byte-exact for plain text, normalized for PDFs), and binds
 * every item to its document version/locator/quote digest/parser version. It distinguishes whether
 * the parse was served by a ready index or read directly from the archive, so an un-indexed
 * archived fragment is still readable. Truncation is always explicit; a whole document is never
 * returned.
 */
export class DocumentTargetedReader implements DocumentTargetedReaderPort {
  readonly #blobs: DocumentArtifactStore
  readonly #store: DocumentParseStore
  readonly #index: DocumentIndexPresencePort | undefined
  readonly #spanReader: DocumentSpanReader
  readonly #now: () => string

  constructor(dependencies: DocumentTargetedReaderDependencies) {
    this.#blobs = dependencies.blobs
    this.#store = dependencies.store
    this.#index = dependencies.index
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#spanReader =
      dependencies.spanReader ?? new DocumentSpanReader({ blobs: dependencies.blobs, store: dependencies.store, now: this.#now })
  }

  async read(request: DocumentTargetedReadRequest, ctx: ToolContext): Promise<DocumentTargetedReadResult> {
    const scope = trustedScope(ctx)
    if (request.selections.length === 0 || request.selections.length > MAX_SELECTIONS) {
      throw new DocumentTargetedReadError('INVALID_REQUEST', 'a targeted read requires 1..16 selections')
    }
    const start = parseCursor(request.cursor)
    const items: DocumentTargetedReadItem[] = []
    let consumedBytes = 0
    let nextCursor: string | undefined
    let stoppedForBudget = false

    for (let index = start.selectionIndex; index < request.selections.length; index += 1) {
      if (items.length >= request.limit || consumedBytes >= request.maxBytes) {
        nextCursor = `${String(index)}:0`
        stoppedForBudget = true
        break
      }
      const selection = request.selections[index]
      if (selection === undefined) continue
      const itemOffset = index === start.selectionIndex ? start.offset : 0
      const remaining = request.maxBytes - consumedBytes
      const outcome = await this.#readSelection(scope, selection, itemOffset, remaining, ctx)
      items.push(outcome.item)
      consumedBytes += new TextEncoder().encode(outcome.item.text).byteLength
      if (outcome.item.truncated) {
        nextCursor = `${String(index)}:${String(outcome.continuedOffset)}`
        stoppedForBudget = true
        break
      }
    }

    return {
      schemaVersion: 'document-targeted-read-result@1',
      items,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      truncated: stoppedForBudget,
      usage: { bytes: consumedBytes, documents: new Set(items.map((item) => item.documentRef.id)).size },
    }
  }

  async #readSelection(
    scope: ScopeRef,
    selection: DocumentTargetedSelection,
    offset: number,
    maxBytes: number,
    ctx: ToolContext,
  ): Promise<{ readonly item: DocumentTargetedReadItem; readonly continuedOffset: number }> {
    const documentRef = selection.documentRef
    let record: DocumentParseRecord | undefined
    try {
      record = selection.parseId === undefined
        ? await this.#store.findParseByDigest(scope, documentRef.digest, undefined, ctx)
        : await this.#store.getParse(scope, selection.parseId, ctx)
    } catch (cause) {
      throw new DocumentTargetedReadError('READ_FAILED', 'the parse store could not be read', { cause })
    }
    if (record === undefined) {
      return {
        item: {
          documentRef,
          locator: selection.locator ?? { kind: 'offset' },
          parserVersion: '1.0.0',
          quoteDigest: sha256DigestOfText(''),
          textDigest: sha256DigestOfText(''),
          text: '',
          truncated: false,
          indexState: 'unavailable',
          unavailableReason: 'not_authorized',
        },
        continuedOffset: 0,
      }
    }

    const locator = selection.locator ?? await this.#startLocator(record, offset, maxBytes, ctx)
    let fullText: string
    try {
      const read = await this.#spanReader.readParsedSpan(record, { documentRef: record.originalRef, locator }, ctx)
      fullText = read.text
    } catch (error) {
      if (!(error instanceof DocumentExtractionError)) throw error
      return {
        item: {
          documentRef,
          locator,
          parserVersion: record.parserVersion,
          quoteDigest: sha256DigestOfText(''),
          textDigest: sha256DigestOfText(''),
          text: '',
          truncated: false,
          indexState: await this.#indexState(scope, record, ctx),
          unavailableReason: reasonForExtractionError(error),
        },
        continuedOffset: 0,
      }
    }

    const sliced = offset > 0 ? fullText.slice(offset) : fullText
    const encoded = new TextEncoder().encode(sliced)
    const quoteDigest = sha256DigestOfText(sliced)
    if (maxBytes <= 0) {
      return {
        item: {
          documentRef,
          locator,
          parserVersion: record.parserVersion,
          quoteDigest,
          textDigest: sha256DigestOfText(''),
          text: '',
          truncated: true,
          indexState: await this.#indexState(scope, record, ctx),
        },
        continuedOffset: offset,
      }
    }
    if (encoded.byteLength > maxBytes) {
      const preview = new TextDecoder('utf-8', { fatal: false }).decode(encoded.subarray(0, maxBytes))
      return {
        item: {
          documentRef,
          locator,
          parserVersion: record.parserVersion,
          quoteDigest,
          textDigest: sha256DigestOfText(preview),
          text: preview,
          truncated: true,
          indexState: await this.#indexState(scope, record, ctx),
        },
        continuedOffset: offset + preview.length,
      }
    }
    return {
      item: {
        documentRef,
        locator,
        parserVersion: record.parserVersion,
        quoteDigest,
        textDigest: quoteDigest,
        text: sliced,
        truncated: false,
        indexState: await this.#indexState(scope, record, ctx),
      },
      continuedOffset: offset + sliced.length,
    }
  }

  /** Read from the start (or the cursor offset) when the selection names no in-document span. */
  async #startLocator(
    record: DocumentParseRecord,
    offset: number,
    maxBytes: number,
    ctx: ToolContext,
  ): Promise<DocumentSpan['locator']> {
    // Read one byte/chunk past the cap so "there is more content" is detectable, then byte-truncate
    // below; a window that ends at the document end is `truncated: false`.
    const window = Math.max(maxBytes, 0) + 1
    if (record.offsetUnit === 'byte') {
      const metadata = await this.#blobs.getAuthorized({ scopeRef: record.scopeRef, blobRef: record.originalRef }, ctx)
      const start = Math.min(offset, metadata.byteSize)
      return { kind: 'offset', startOffset: start, endOffset: Math.min(metadata.byteSize, start + window) }
    }
    const start = Math.min(offset, record.normalizedByteSize)
    return { kind: 'approximate_locator', startOffset: start, endOffset: Math.min(record.normalizedByteSize, start + window) }
  }

  async #indexState(
    scope: ScopeRef,
    record: DocumentParseRecord,
    ctx: ToolContext,
  ): Promise<DocumentTargetedReadItem['indexState']> {
    if (this.#index === undefined) return 'not_indexed_readable'
    return (await this.#index.isIndexed(scope, record.parseId, ctx)) ? 'indexed' : 'not_indexed_readable'
  }
}
