import { SourceGroundingError, assertGroundingDocumentSet, isToolContext } from '@ontology/contracts'
import type { DocumentParseStore, GroundingDocumentSet, GroundingDocumentSetReaderPort,
  GroundingSourceApproval, ResourceRef, ScopeRef, SourceGroundingBudgetPort,
  SourceGroundingChunkStore, SourceGroundingPage, SourceGroundingReaderPort,
  StructuredIngestionStore, ToolContext } from '@ontology/contracts'
import { sha256DigestOfBytes } from './hashing'
import { DocumentSpanReader } from './span-reader'
import { mediaKindOf } from './extract'
import { StructuredDocumentParser } from './structured'
import { reconcileStructuredResult } from './structured/ingest-service'
import type { DocumentArtifactStore } from './types'

export const GROUNDING_DOCUMENT_SET_MEDIA_TYPE = 'application/vnd.ontology.grounding-document-set+json'

function assertScope(scope: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx) || scope.tenantId !== ctx.principal.tenantId
    || scope.tenantId !== ctx.allowedResources.tenantId || scope.spaceId !== ctx.allowedResources.spaceId) {
    throw new SourceGroundingError('SCOPE_MISMATCH', 'source read requires the trusted scope')
  }
}
function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

async function readBlob(blobs: DocumentArtifactStore, scope: ScopeRef, ref: ResourceRef,
  ctx: ToolContext, budget: SourceGroundingBudgetPort, maxBytes = 20 * 1024 * 1024): Promise<Uint8Array> {
  assertScope(scope, ctx)
  budget.check()
  let metadata: Awaited<ReturnType<DocumentArtifactStore['getAuthorized']>>
  try { metadata = await blobs.getAuthorized({ scopeRef: scope, blobRef: ref }, ctx) }
  catch (cause) { throw new SourceGroundingError('MISSING_ORIGINAL', 'the authorized original is unavailable', { cause }) }
  budget.check()
  if (!sameRef(metadata.blobRef, ref) || metadata.contentDigest !== ref.digest) {
    throw new SourceGroundingError('SOURCE_MISMATCH', 'artifact metadata does not match the pinned reference')
  }
  if (metadata.byteSize > maxBytes) throw new SourceGroundingError('READ_BYTE_LIMIT', 'the artifact exceeds the source read cap')
  budget.chargeRead(metadata.byteSize)
  let bytes: Uint8Array
  try { bytes = await blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, ctx) }
  catch (cause) { throw new SourceGroundingError('MISSING_ORIGINAL', 'the authorized original is unavailable', { cause }) }
  budget.check()
  if (bytes.byteLength !== metadata.byteSize || sha256DigestOfBytes(bytes) !== ref.digest) {
    throw new SourceGroundingError('DIGEST_MISMATCH', 'artifact bytes do not match their pinned digest')
  }
  return bytes
}

export class ArtifactGroundingDocumentSetReader implements GroundingDocumentSetReaderPort {
  constructor(readonly blobs: DocumentArtifactStore) {}
  async read(scope: ScopeRef, ref: ResourceRef, ctx: ToolContext, budget: SourceGroundingBudgetPort): Promise<GroundingDocumentSet> {
    assertScope(scope, ctx)
    budget.check()
    if (ref.kind !== 'artifact') {
      throw new SourceGroundingError('SOURCE_MISMATCH', 'an approved document set must be a host-published artifact')
    }
    const metadata = await this.blobs.getAuthorized({ scopeRef: scope, blobRef: ref }, ctx)
    if (metadata.mediaType !== GROUNDING_DOCUMENT_SET_MEDIA_TYPE) {
      throw new SourceGroundingError('UNSUPPORTED_MEDIA_TYPE', 'the workspace document set has no approved grounding manifest')
    }
    const bytes = await readBlob(this.blobs, scope, ref, ctx, budget, 256 * 1024)
    let manifest: unknown
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch (cause) { throw new SourceGroundingError('INVALID_REQUEST', 'document set manifest is not valid JSON', { cause }) }
    assertGroundingDocumentSet(manifest)
    if (manifest.scopeRef.tenantId !== scope.tenantId || manifest.scopeRef.spaceId !== scope.spaceId) {
      throw new SourceGroundingError('SCOPE_MISMATCH', 'approved manifest scope does not match the trusted context')
    }
    return manifest
  }
}

/** Upload/draft seam: a host approval flow publishes this ref, then appends it to the draft.
 * This function does not approve uploads or change the workspace head by itself. */
export async function publishGroundingDocumentSet(blobs: DocumentArtifactStore,
  manifest: GroundingDocumentSet, ctx: ToolContext): Promise<ResourceRef> {
  assertGroundingDocumentSet(manifest)
  assertScope(manifest.scopeRef, ctx)
  const bytes = new TextEncoder().encode(JSON.stringify(manifest))
  if (bytes.byteLength > 256 * 1024) throw new SourceGroundingError('READ_BYTE_LIMIT', 'document set manifest exceeds 256 KiB')
  const staged = await blobs.stage(bytes, { scopeRef: manifest.scopeRef }, ctx)
  const published = await blobs.publish({ scopeRef: manifest.scopeRef, ...staged,
    mediaType: GROUNDING_DOCUMENT_SET_MEDIA_TYPE, purpose: 'artifact' }, ctx)
  return published.blobRef
}

export interface ParsedSourceGroundingDependencies {
  readonly blobs: DocumentArtifactStore
  readonly documents: DocumentParseStore & SourceGroundingChunkStore
  readonly tables: StructuredIngestionStore
}

export class ParsedSourceGroundingReader implements SourceGroundingReaderPort {
  constructor(readonly dependencies: ParsedSourceGroundingDependencies) {}
  async readPage(scope: ScopeRef, source: GroundingSourceApproval,
    page: { readonly limit: number; readonly cursor?: string }, ctx: ToolContext,
    budget: SourceGroundingBudgetPort): Promise<SourceGroundingPage> {
    assertScope(scope, ctx)
    budget.check()
    if (source.state !== 'approved') throw new SourceGroundingError('SOURCE_RETRACTED', 'source is retracted')
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 64) {
      throw new SourceGroundingError('INVALID_REQUEST', 'source page limit must be within 1..64')
    }
    if (source.kind === 'table') return this.#table(scope, source, page, ctx, budget)
    const parse = await this.dependencies.documents.getParse(scope, source.parseId, ctx)
    budget.check()
    if (parse === undefined || parse.coverage.status !== 'complete' || parse.coverage.completeness !== 'complete') {
      throw new SourceGroundingError('PARSE_NOT_COMPLETE', 'source has no complete pinned parse')
    }
    if (parse.parserVersion !== source.parserVersion || !sameRef(parse.originalRef, source.sourceRef)) {
      throw new SourceGroundingError('SOURCE_MISMATCH', 'parse does not match the approved source/version')
    }
    if (mediaKindOf(parse.originalMediaType) !== parse.mediaKind) {
      throw new SourceGroundingError('UNSUPPORTED_MEDIA_TYPE', 'only text and PDF document chunks are supported')
    }
    const chunks = await this.dependencies.documents.listChunkPage(scope, parse.parseId, page, ctx)
    budget.check()
    // The original must remain authorized even for PDF/OCR, whose quoted text is normalized.
    const original = await readBlob(this.dependencies.blobs, scope, source.sourceRef, ctx, budget)
    const cache = new Map<string, Uint8Array>([[source.sourceRef.id, original]])
    const blobs: DocumentArtifactStore = {
      stage: this.dependencies.blobs.stage.bind(this.dependencies.blobs),
      publish: this.dependencies.blobs.publish.bind(this.dependencies.blobs),
      getAuthorized: this.dependencies.blobs.getAuthorized.bind(this.dependencies.blobs),
      readAuthorized: async (request) => {
        const cached = cache.get(request.blobRef.id)
        if (cached !== undefined) return cached
        const bytes = await readBlob(this.dependencies.blobs, scope, request.blobRef, ctx, budget)
        cache.set(request.blobRef.id, bytes)
        return bytes
      },
    }
    const reader = new DocumentSpanReader({ blobs, store: this.dependencies.documents })
    const contents: SourceGroundingPage['contents'][number][] = []
    for (const chunk of chunks.chunks) {
      budget.check()
      const read = await reader.readParsedSpan(parse, { documentRef: source.sourceRef, locator: chunk.locator }, ctx)
      budget.check()
      if (read.textDigest !== chunk.quoteDigest || chunk.textDigest !== chunk.quoteDigest || read.text !== chunk.text) {
        throw new SourceGroundingError('DIGEST_MISMATCH', 'chunk quote does not round-trip to its pinned original locator')
      }
      contents.push({ kind: 'text', text: read.text, sourceSpan: { kind: 'text', parseId: parse.parseId,
        chunkId: chunk.chunkId, locator: chunk.locator, spanKind: chunk.spanKind, precision: chunk.precision,
        quoteDigest: chunk.quoteDigest, textDigest: chunk.textDigest } })
    }
    return { contents, reasons: [], ...(chunks.nextCursor === undefined ? {} : { nextCursor: chunks.nextCursor }) }
  }

  async #table(scope: ScopeRef, source: GroundingSourceApproval,
    page: { readonly limit: number; readonly cursor?: string }, ctx: ToolContext,
    budget: SourceGroundingBudgetPort): Promise<SourceGroundingPage> {
    const parse = await this.dependencies.tables.findParseByDigest(scope, source.sourceRef.digest, source.parserVersion, ctx)
    budget.check()
    if (parse === undefined || parse.status !== 'complete' || parse.coverage.status !== 'complete'
      || parse.coverage.completeness !== 'complete' || parse.counts.pending > 0 || parse.counts.failed > 0 || parse.counts.skipped > 0) {
      throw new SourceGroundingError('PARSE_NOT_COMPLETE', 'table has no complete pinned parse')
    }
    if (parse.parseId !== source.parseId || !sameRef(parse.originalRef, source.sourceRef)) {
      throw new SourceGroundingError('SOURCE_MISMATCH', 'table parse does not match the approved source/version')
    }
    if (parse.format !== 'csv' && parse.format !== 'xlsx') {
      throw new SourceGroundingError('UNSUPPORTED_MEDIA_TYPE', 'only CSV and XLSX table context is supported')
    }
    const bytes = await readBlob(this.dependencies.blobs, scope, source.sourceRef, ctx, budget)
    const result = new StructuredDocumentParser().parse(bytes, { ...source.tableOptions, mediaType: parse.originalMediaType })
    budget.check()
    if (result.status !== 'complete' || result.tables.length !== 1) {
      throw new SourceGroundingError('PARSE_NOT_COMPLETE', 'approved table selection cannot be reproduced completely')
    }
    const table = result.tables[0]
    if (table === undefined || table.headerRow === undefined) {
      throw new SourceGroundingError('INVALID_REQUEST', 'approved table context requires a selected header row')
    }
    const reconciled = reconcileStructuredResult(result, scope, source.sourceRef.digest)
    const persisted = await this.dependencies.tables.listRecords(scope, source.parseId, page, ctx)
    budget.check()
    if (persisted.total !== reconciled.entries.length || parse.counts.total !== result.coverage.totalUnits) {
      throw new SourceGroundingError('DIGEST_MISMATCH', 'table row coverage no longer matches the approved parse')
    }
    const rows = persisted.records.map((entry) => {
      const actual = reconciled.entries.find((candidate) => candidate.recordId === entry.recordId)
      const row = table.rows.find((candidate) => candidate.recordIndex === entry.recordIndex)
      if (actual === undefined || row === undefined || actual.rowDigest !== entry.rowDigest
        || actual.sourceRowKey !== entry.sourceRowKey || JSON.stringify(actual.locator) !== JSON.stringify(entry.locator)) {
        throw new SourceGroundingError('DIGEST_MISMATCH', 'table row does not round-trip to its original locator/digest')
      }
      return { cells: row.cells, sourceSpan: { kind: 'structured' as const, parseId: parse.parseId,
        recordId: entry.recordId, sourceRowKey: entry.sourceRowKey, locator: entry.locator, rowDigest: entry.rowDigest } }
    })
    return { contents: [{ kind: 'table', format: table.format, columns: table.columns, headerRow: table.headerRow,
      ...(table.sheetId === undefined ? {} : { sheetId: table.sheetId }),
      ...(table.sheetName === undefined ? {} : { sheetName: table.sheetName }), rows }], reasons: [],
      ...(persisted.nextCursor === undefined ? {} : { nextCursor: persisted.nextCursor }) }
  }
}
