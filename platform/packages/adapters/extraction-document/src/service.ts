import { isToolContext } from '@ontology/contracts'
import type {
  DocumentChunkRecord,
  DocumentParseRecord,
  DocumentParseRequest,
  DocumentParserPort,
  DocumentParseStore,
  ParsedDocument,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'
import { buildChunkRecords, chunkLines, truncatedChunkIdsOf } from './chunker'
import { DocumentExtractionError } from './errors'
import { extractDocument } from './extract'
import { deterministicUuid, sha256DigestOfBytes } from './hashing'
import { NORMALIZED_TEXT_MEDIA_TYPE, buildNormalizedTextArtifact } from './normalized-artifact'
import type { DocumentArtifactStore, OcrTextProvider } from './types'

export const DOCUMENT_PARSER_ID = 'ontology.document-parser'
export const DEFAULT_PARSER_VERSION = '1.0.0'
export const SPAN_MAP_MEDIA_TYPE = 'application/json'

export interface LocalDocumentExtractionDependencies {
  readonly blobs: DocumentArtifactStore
  readonly store: DocumentParseStore
  /** Absent means OCR is unavailable: an image-only page is skipped, not faked. */
  readonly ocr?: OcrTextProvider
  readonly now?: () => string
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
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
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new DocumentExtractionError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
  return { tenantId, spaceId }
}

/**
 * The span-map artifact: the durable mapping from the original document to the
 * normalized text and the chunk spans. It is content-addressed and does not
 * contain its own digest, so chunks can point at it without a hash cycle.
 */
function buildSpanMapArtifact(input: {
  readonly parserVersion: string
  readonly mediaKind: DocumentParseRecord['mediaKind']
  readonly offsetUnit: DocumentParseRecord['offsetUnit']
  readonly original: { readonly id: string; readonly digest: Sha256Digest; readonly mediaType: string }
  readonly normalized: { readonly digest: Sha256Digest; readonly byteSize: number }
  readonly coverage: DocumentParseRecord['coverage']
  readonly pages: DocumentParseRecord['pages']
  readonly spans: readonly {
    readonly ordinal: number
    readonly chunkKind: string
    readonly locatorKind: string
    readonly page?: number
    readonly startOffset?: number
    readonly endOffset?: number
    readonly precision: string
    readonly textDigest: Sha256Digest
  }[]
}): Uint8Array {
  const artifact = {
    schemaVersion: '1.0.0',
    parserId: DOCUMENT_PARSER_ID,
    parserVersion: input.parserVersion,
    mediaKind: input.mediaKind,
    offsetUnit: input.offsetUnit,
    original: input.original,
    normalized: input.normalized,
    coverage: input.coverage,
    pages: input.pages,
    spans: input.spans,
  }
  return new TextEncoder().encode(JSON.stringify(artifact))
}

/**
 * Parse + persist (SPEC D3.2/D4.1). The original is read-only and never
 * rewritten; the normalized text and the span map are separate derived
 * artifacts. A duplicate upload of identical bytes reuses the same parse run and
 * the same blob lineage, scoped to the tenant so cross-tenant existence is not
 * disclosed.
 */
export class LocalDocumentExtractionService implements DocumentParserPort {
  readonly #blobs: DocumentArtifactStore
  readonly #store: DocumentParseStore
  readonly #ocr: OcrTextProvider | undefined
  readonly #now: () => string

  constructor(dependencies: LocalDocumentExtractionDependencies) {
    this.#blobs = dependencies.blobs
    this.#store = dependencies.store
    this.#ocr = dependencies.ocr
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async parse(request: DocumentParseRequest, ctx: ToolContext): Promise<ParsedDocument> {
    const scope = resolveScope(request.scopeRef, ctx)
    validateRequest(request)

    // Only a parse produced by the requested parser version is reusable; a
    // different version is a new logical parse, not a silent substitution.
    const parserVersion = request.parserVersion ?? DEFAULT_PARSER_VERSION
    const existing = await this.#store.findParseByDigest(
      scope,
      request.originalRef.digest,
      parserVersion,
      ctx,
    )
    if (existing !== undefined) {
      const chunks = await this.#store.listChunks(scope, existing.parseId, ctx)
      return this.#withTruncation(existing, chunks, true)
    }

    const authorized = await this.#blobs.getAuthorized(
      { scopeRef: scope, blobRef: request.originalRef },
      ctx,
    )
    const bytes = await this.#blobs.readAuthorized(
      { scopeRef: scope, blobRef: request.originalRef },
      ctx,
    )

    const extracted = await extractDocument(bytes, {
      mediaType: authorized.mediaType,
      originalDigest: authorized.contentDigest,
      ocr: this.#ocr,
      maxPages: request.maxPages,
      ctx,
    })

    const approximatePages = new Set(
      extracted.pages.filter((page) => page.approximate).map((page) => page.page),
    )
    const drafts = chunkLines(extracted.lines, {
      offsetUnit: extracted.offsetUnit,
      approximatePages,
    })

    const parseId = deterministicUuid(
      [scope.tenantId, scope.spaceId, authorized.contentDigest, parserVersion].join('|'),
    )
    const normalizedBytes = buildNormalizedTextArtifact(extracted.offsetUnit, extracted.normalizedText)
    const normalizedDigest = sha256DigestOfBytes(normalizedBytes)
    const normalizedMediaType = NORMALIZED_TEXT_MEDIA_TYPE

    const spanMapBytes = buildSpanMapArtifact({
      parserVersion,
      mediaKind: extracted.mediaKind,
      offsetUnit: extracted.offsetUnit,
      original: {
        id: authorized.blobRef.id,
        digest: authorized.contentDigest,
        mediaType: authorized.mediaType,
      },
      normalized: { digest: normalizedDigest, byteSize: normalizedBytes.byteLength },
      coverage: extracted.coverage,
      pages: extracted.pages,
      spans: drafts.map((draft, ordinal) => ({
        ordinal,
        chunkKind: draft.chunkKind,
        locatorKind:
          extracted.offsetUnit === 'byte'
            ? 'offset'
            : draft.precision === 'approximate'
              ? 'approximate_locator'
              : 'page',
        page: draft.page,
        startOffset: draft.startOffset,
        endOffset: draft.endOffset,
        precision: draft.precision,
        textDigest: sha256DigestOfBytes(new TextEncoder().encode(draft.text)),
      })),
    })
    const spanMapDigest = sha256DigestOfBytes(spanMapBytes)

    const chunks = buildChunkRecords(drafts, {
      parseId,
      offsetUnit: extracted.offsetUnit,
      ...(extracted.offsetUnit === 'character' ? { normalizationMapRef: spanMapDigest } : {}),
    })

    const normalizedRef = await this.#publishArtifact(
      normalizedBytes,
      normalizedDigest,
      normalizedMediaType,
      {
        kind: 'normalized_text',
        originalDigest: authorized.contentDigest,
        parserVersion,
        offsetUnit: extracted.offsetUnit,
      },
      scope,
      ctx,
    )
    const spanMapRef = await this.#publishArtifact(
      spanMapBytes,
      spanMapDigest,
      SPAN_MAP_MEDIA_TYPE,
      {
        kind: 'span_map',
        originalDigest: authorized.contentDigest,
        parserVersion,
      },
      scope,
      ctx,
    )

    const record: DocumentParseRecord = {
      parseId,
      scopeRef: scope,
      mediaKind: extracted.mediaKind,
      originalMediaType: authorized.mediaType,
      originalRef: authorized.blobRef,
      normalizedMediaType,
      normalizedByteSize: normalizedBytes.byteLength,
      normalizedRef,
      spanMapMediaType: SPAN_MAP_MEDIA_TYPE,
      spanMapRef,
      parserId: DOCUMENT_PARSER_ID,
      parserVersion,
      offsetUnit: extracted.offsetUnit,
      coverage: extracted.coverage,
      pages: extracted.pages,
      ...(request.sourceRef === undefined ? {} : { sourceRef: request.sourceRef }),
      ...(request.documentVersionRef === undefined
        ? {}
        : { documentVersionRef: request.documentVersionRef }),
      createdAt: this.#now(),
    }

    const recorded = await this.#store.recordParse(record, chunks, ctx)
    if (!recorded.created) {
      // A concurrent identical parse won the insert; reuse the winner so the
      // caller never sees two logical parses of the same bytes.
      const winner = await this.#store.findParseByDigest(
        scope,
        authorized.contentDigest,
        parserVersion,
        ctx,
      )
      if (winner === undefined) {
        throw new DocumentExtractionError(
          'SPAN_STORE_FAILED',
          'a concurrent parse was recorded but cannot be read back',
        )
      }
      const winnerChunks = await this.#store.listChunks(scope, winner.parseId, ctx)
      return this.#withTruncation(winner, winnerChunks, true)
    }
    return this.#withTruncation(record, chunks, false)
  }

  /**
   * Attach the truncation lineage derived from the parser's real coverage: the ids of chunks
   * adjacent to a skipped page/stream, plus the per-chunk `truncated` flag. The derivation is
   * pure (chunks + captured pages + total units), so it is identical for a fresh parse and a
   * reused one and never has to be persisted as a second source of truth.
   */
  #withTruncation(
    record: DocumentParseRecord,
    chunks: readonly DocumentChunkRecord[],
    reused: boolean,
  ): ParsedDocument {
    const truncatedChunkIds = truncatedChunkIdsOf(chunks, record.pages, record.coverage.totalUnits)
    const truncated = new Set(truncatedChunkIds)
    const marked = chunks.map((chunk) =>
      truncated.has(chunk.chunkId) ? { ...chunk, truncated: true } : chunk,
    )
    return { ...record, chunks: marked, truncatedChunkIds, reused }
  }

  async #publishArtifact(
    bytes: Uint8Array,
    expectedDigest: Sha256Digest,
    mediaType: string,
    origin: Readonly<Record<string, unknown>>,
    scope: ScopeRef,
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    const staged = await this.#blobs.stage(bytes, { scopeRef: scope }, ctx)
    if (staged.contentDigest !== expectedDigest) {
      throw new DocumentExtractionError(
        'SPAN_STORE_FAILED',
        `the staged artifact digest ${staged.contentDigest} does not match the computed digest ${expectedDigest}`,
      )
    }
    const published = await this.#blobs.publish(
      {
        scopeRef: scope,
        contentDigest: staged.contentDigest,
        mediaType,
        byteSize: staged.byteSize,
        purpose: 'artifact',
        origin,
      },
      ctx,
    )
    return published.blobRef
  }
}

function validateRequest(request: DocumentParseRequest): void {
  if (request.originalRef.id.length === 0) {
    throw new DocumentExtractionError('INVALID_REQUEST', 'originalRef.id must be a non-empty id')
  }
  if (!SHA256_DIGEST.test(request.originalRef.digest)) {
    throw new DocumentExtractionError(
      'INVALID_REQUEST',
      'originalRef.digest must be a sha256 digest of the form sha256:<64 lowercase hex>',
    )
  }
  if (request.maxPages !== undefined && (!Number.isInteger(request.maxPages) || request.maxPages < 1)) {
    throw new DocumentExtractionError('INVALID_REQUEST', 'maxPages must be a positive integer')
  }
}
