import { isToolContext } from '@ontology/contracts'
import type {
  DocumentParseStore,
  DocumentParseRecord,
  DocumentSpanReaderPort,
  ReadSpanRequest,
  ReadSpanResponse,
  ScopeRef,
  SourceSnapshot,
  ToolContext,
} from '@ontology/contracts'
import { DocumentExtractionError } from './errors'
import { sha256DigestOfText } from './hashing'
import { parseNormalizedTextArtifact } from './normalized-artifact'
import type { DocumentArtifactStore } from './types'

export interface DocumentSpanReaderDependencies {
  readonly blobs: DocumentArtifactStore
  readonly store: DocumentParseStore
  readonly now?: () => string
}

function trustedScope(ctx: ToolContext): ScopeRef {
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

/**
 * Reads the exact source text for a span (SPEC D3.2). A byte-offset span on
 * plain text slices the immutable original, so the returned text is byte-exact.
 * A page/approximate span slices the normalized artifact at the recorded
 * character offsets; the span itself (not this response) carries whether the
 * location is approximate. Truncation is always reported.
 */
export class DocumentSpanReader implements DocumentSpanReaderPort {
  readonly #blobs: DocumentArtifactStore
  readonly #store: DocumentParseStore
  readonly #now: () => string

  constructor(dependencies: DocumentSpanReaderDependencies) {
    this.#blobs = dependencies.blobs
    this.#store = dependencies.store
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async readSpan(request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    const scope = trustedScope(ctx)
    if (request.documentRef.id.length === 0) {
      throw new DocumentExtractionError('INVALID_REQUEST', 'documentRef.id must be a non-empty id')
    }
    const record = await this.#store.findParseByDigest(
      scope,
      request.documentRef.digest,
      undefined,
      ctx,
    )
    if (record === undefined) {
      throw new DocumentExtractionError(
        'DOCUMENT_NOT_PARSED',
        `no parse of ${request.documentRef.digest} is visible in this scope`,
      )
    }

    return this.#read(record, request, ctx)
  }

  /** Read a pinned parse instead of silently resolving a newer parser revision. */
  async readParsedSpan(record: DocumentParseRecord, request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    const scope = trustedScope(ctx)
    if (record.scopeRef.tenantId !== scope.tenantId || record.scopeRef.spaceId !== scope.spaceId
      || record.originalRef.id !== request.documentRef.id
      || record.originalRef.version !== request.documentRef.version
      || record.originalRef.digest !== request.documentRef.digest) {
      throw new DocumentExtractionError('SCOPE_MISMATCH', 'the pinned parse does not match the authorized original')
    }

    return this.#read(record, request, ctx)
  }

  async #read(record: DocumentParseRecord, request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    const scope = trustedScope(ctx)

    const locator = request.locator
    let text: string
    let sourceDigest = request.documentRef.digest

    if (locator.normalizationMapRef !== undefined && locator.normalizationMapRef !== record.spanMapRef.digest) {
      // The span points at a different normalization map than the one this parse
      // produced; returning text from the wrong map would be silently wrong.
      throw new DocumentExtractionError(
        'SPAN_OUT_OF_RANGE',
        'the span normalization map does not belong to the resolved parse',
      )
    }

    if (locator.kind === 'offset') {
      if (record.offsetUnit !== 'byte') {
        throw new DocumentExtractionError(
          'INVALID_REQUEST',
          'an offset locator is only valid for a byte-addressed (plain text) parse',
        )
      }
      const start = locator.startOffset
      const end = locator.endOffset
      if (start === undefined || end === undefined) {
        throw new DocumentExtractionError(
          'INVALID_REQUEST',
          'an offset locator requires startOffset and endOffset',
        )
      }
      const bytes = await this.#blobs.readAuthorized(
        { scopeRef: scope, blobRef: request.documentRef },
        ctx,
      )
      if (start < 0 || end > bytes.byteLength || end < start) {
        throw new DocumentExtractionError(
          'SPAN_OUT_OF_RANGE',
          `span [${start}, ${end}) is outside the ${bytes.byteLength}-byte original`,
        )
      }
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, end))
    } else {
      if (record.offsetUnit !== 'character') {
        throw new DocumentExtractionError(
          'INVALID_REQUEST',
          'a page or approximate locator is only valid for a character-addressed parse',
        )
      }
      const normalizedBytes = await this.#blobs.readAuthorized(
        { scopeRef: scope, blobRef: record.normalizedRef },
        ctx,
      )
      const normalized = parseNormalizedTextArtifact(normalizedBytes).text
      let start = locator.startOffset
      let end = locator.endOffset
      if (start === undefined || end === undefined) {
        const page = record.pages.find((candidate) => candidate.page === locator.page)
        if (page === undefined) {
          throw new DocumentExtractionError(
            'SPAN_OUT_OF_RANGE',
            `page ${String(locator.page)} was not parsed for this document`,
          )
        }
        start = page.startOffset
        end = page.endOffset
      }
      if (start < 0 || end > normalized.length || end < start) {
        throw new DocumentExtractionError(
          'SPAN_OUT_OF_RANGE',
          `span [${start}, ${end}) is outside the ${normalized.length}-character normalized text`,
        )
      }
      text = normalized.slice(start, end)
      sourceDigest = record.normalizedRef.digest
    }

    let truncated = false
    const maxBytes = request.maxBytes
    if (maxBytes !== undefined) {
      const encoded = new TextEncoder().encode(text)
      if (encoded.byteLength > maxBytes) {
        text = new TextDecoder('utf-8', { fatal: false }).decode(encoded.subarray(0, maxBytes))
        truncated = true
      }
    }

    const snapshot: SourceSnapshot = {
      sourceRef:
        record.sourceRef ?? { namespace: 'ontology.document', sourceId: record.originalRef.id },
      schemaVersion: '1.0.0',
      readAt: this.#now(),
      consistency: 'immutable',
      resultDigest: sourceDigest,
    }
    return {
      documentRef: request.documentRef,
      text,
      textDigest: sha256DigestOfText(text),
      snapshot,
      ...(truncated ? { truncated: true } : {}),
    }
  }
}
