import { isToolContext, isRecord, isStructuredParseSelection, sha256OfCanonical } from '@ontology/contracts'
import type { DocumentChunkRecord, DocumentParseRecord, DocumentParseStore, DocumentSpanReaderPort, ReadSpanRequest, ReadSpanResponse, ResourceRef, StructuredParseRecord, StructuredParseOptions, StructuredIngestionStore, StructuredTable, SourceLocator, ToolContext } from '@ontology/contracts'
import { DocumentExtractionError } from '../errors'
import { deterministicUuid, sha256DigestOfBytes, sha256DigestOfText } from '../hashing'
import { buildNormalizedTextArtifact, NORMALIZED_TEXT_MEDIA_TYPE } from '../normalized-artifact'
import { DocumentSpanReader } from '../span-reader'
import type { DocumentArtifactStore } from '../types'
import { StructuredDocumentParser, STRUCTURED_PARSER_ID, STRUCTURED_PARSER_VERSION } from './index'
import { reconcileStructuredResult } from './ingest-service'

export const STRUCTURED_PROJECTION_VERSION = '1.0.18'
const STRUCTURED_PROJECTION_ID = 'ontology.structured-document-projection'
export const STRUCTURED_PROJECTION_MAX_ROWS = 1_000
const MAX_PROJECTION_BYTES = 1_048_576
const MAX_ROW_BYTES = 8_192
export const STRUCTURED_PROJECTION_MAX_MAP_BYTES = 4 * 1_048_576

/** Projection offsets locate derived text; the original cell locators stay distinct. */
export interface StructuredProjectionOrigin {
  readonly parseId: string
  readonly originalRef: ResourceRef
  readonly precision: 'approximate'
  readonly projectionRef?: ResourceRef
  readonly headerRow?: number
  readonly headers: readonly { readonly column: number; readonly address: string; readonly headerDigest: string }[]
  readonly recordId: string
  readonly sourceRowKey: string
  readonly rowDigest: string
  readonly rowLocator: SourceLocator
  readonly cells: readonly { readonly locator: SourceLocator; readonly rawDigest: string; readonly kind: string }[]
}

export interface StructuredDocumentProjectionDependencies {
  readonly blobs: DocumentArtifactStore
  readonly parses: DocumentParseStore
  readonly ingestion: Pick<StructuredIngestionStore, 'findParseByDigest' | 'listRecords'>
  readonly now?: () => string
  /** Legacy recovery from actual scoped native/mapping pins, never a guessed default. */
  readonly resolveLegacySelection?: (parse: StructuredParseRecord, ctx: ToolContext) => Promise<Omit<StructuredParseOptions, 'mediaType'>>
}

interface ProjectionRow { readonly start: number; readonly end: number; readonly text: string; readonly origin: StructuredProjectionOrigin }

function scopeOf(ctx: ToolContext) {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new DocumentExtractionError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function tableText(table: StructuredTable, cells: readonly { readonly raw: string }[]): string {
  // This is a labelled projection, never a purported verbatim quote of the CSV/ZIP bytes.
  return JSON.stringify({ headers: table.columns.map((column) => column.header), cells: cells.map((cell) => cell.raw) })
}

function derive(bytes: Uint8Array, parse: StructuredParseRecord, selection: Omit<StructuredParseOptions, 'mediaType'>) {
  const result = new StructuredDocumentParser().parse(bytes, { ...selection, mediaType: parse.originalMediaType })
  if (result.status === 'rejected' || result.format !== parse.format || sha256OfCanonical(result.coverage) !== sha256OfCanonical(parse.coverage)) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the stored structured parse cannot be reproduced from the original selection')
  const entries = reconcileStructuredResult(result, parse.scopeRef, parse.originalRef.digest).entries
  const byLocator = new Map(entries.map((entry) => [sha256OfCanonical(entry.locator), entry]))
  const rows: ProjectionRow[] = []
  let text = ''
  let projectedBytes = 0
  // Reserve room for the small schema/source/coverage envelope as well as row origins.
  let mappedBytes = 16_384
  let skipped = 0
  const append = (rowText: string, origin: StructuredProjectionOrigin): void => {
    const byteSize = new TextEncoder().encode(rowText + '\n').byteLength
    const start = text.length
    const end = start + rowText.length
    const originBytes = new TextEncoder().encode(JSON.stringify({ start, end, origin })).byteLength + 1
    if (rows.length >= STRUCTURED_PROJECTION_MAX_ROWS || byteSize > MAX_ROW_BYTES || projectedBytes + byteSize > MAX_PROJECTION_BYTES || mappedBytes + originBytes > STRUCTURED_PROJECTION_MAX_MAP_BYTES) { skipped += 1; return }
    text += rowText + '\n'
    projectedBytes += byteSize
    mappedBytes += originBytes
    rows.push({ start, end, text: rowText, origin })
  }
  for (const table of result.tables) {
    for (const row of table.rows) {
      const rowText = tableText(table, row.cells)
      const entry = byLocator.get(sha256OfCanonical(row.locator))
      if (entry === undefined) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the projected row has no reconciled original source')
      append(rowText, {
        parseId: parse.parseId, originalRef: parse.originalRef, precision: 'approximate',
        ...(table.headerRow === undefined ? {} : { headerRow: table.headerRow }),
        headers: table.columns.map((column) => ({ column: column.column, address: column.address, headerDigest: column.headerDigest })),
        recordId: entry.recordId, sourceRowKey: entry.sourceRowKey, rowDigest: entry.rowDigest, rowLocator: row.locator,
        cells: row.cells.map((cell) => ({ locator: cell.locator, rawDigest: sha256DigestOfText(cell.raw), kind: cell.kind })),
      })
    }
  }
  for (const record of result.records) {
    const rowText = JSON.stringify({ record: record.recordRef, cells: record.cells.map((cell) => cell.raw) })
    const entry = byLocator.get(sha256OfCanonical(record.locator))
    if (entry === undefined) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the projected JSON record has no reconciled source')
    append(rowText, { parseId: parse.parseId, originalRef: parse.originalRef, precision: 'approximate', headers: [],
      recordId: entry.recordId, sourceRowKey: entry.sourceRowKey, rowDigest: entry.rowDigest, rowLocator: record.locator,
      cells: record.cells.map((cell) => ({ locator: cell.locator, rawDigest: sha256DigestOfText(cell.raw), kind: cell.kind })) })
  }
  const coverage = { ...parse.coverage, status: skipped === 0 ? parse.coverage.status : 'partial' as const,
    completeness: skipped === 0 ? parse.coverage.completeness : 'truncated' as const,
    parsedUnits: rows.length, skippedUnits: parse.coverage.skippedUnits + skipped,
    skippedReasons: [...parse.coverage.skippedReasons, ...(skipped === 0 ? [] : ['structured text projection row/byte limits'])] }
  const map = new TextEncoder().encode(JSON.stringify({ schemaVersion: 'structured-document-projection@1',
    structuredParseId: parse.parseId, parserVersion: parse.parserVersion, originalRef: parse.originalRef, selection,
    coverage, rows: rows.map(({ start, end, origin }) => ({ start, end, origin })) }))
  return { text, rows, coverage, map }
}

/** Persists bounded table/JSON projections in the existing document parse/chunk store. */
export class StructuredDocumentProjectionService {
  constructor(readonly dependencies: StructuredDocumentProjectionDependencies) {}

  async project(parse: StructuredParseRecord, ctx: ToolContext): Promise<DocumentParseRecord> {
    const scope = scopeOf(ctx)
    if (scope.tenantId !== parse.scopeRef.tenantId || scope.spaceId !== parse.scopeRef.spaceId || parse.format === 'text') throw new DocumentExtractionError('INVALID_REQUEST', 'a scoped table/JSON parse is required')
    if (parse.parserId !== STRUCTURED_PARSER_ID || parse.parserVersion !== STRUCTURED_PARSER_VERSION) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the structured projection supports only its pinned native parser version')
    const stored = await this.dependencies.ingestion.findParseByDigest(scope, parse.originalRef.digest, parse.parserVersion, ctx)
    if (stored === undefined || sha256OfCanonical(stored) !== sha256OfCanonical(parse)) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the projection requires the actual stored structured parse')
    const bytes = await this.originalBytes(parse.originalRef, ctx)
    const existing = await this.dependencies.parses.findParseByDigest(scope, parse.originalRef.digest, STRUCTURED_PROJECTION_VERSION, ctx)
    if (existing !== undefined) {
      if (existing.parseId !== parse.parseId) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the stored projection does not retain the actual original structured parse identity')
      return existing
    }
    const selection = parse.parseOptions ?? await this.dependencies.resolveLegacySelection?.(parse, ctx)
    if (!isStructuredParseSelection(selection)) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the legacy parse requires its actual authoritative native selection')
    const projection = derive(bytes, parse, selection)
    const unresolved = new Map(projection.rows.map((row) => [row.origin.recordId, row.origin]))
    let cursor: string | undefined
    let scanned = 0
    const seenCursors = new Set<string>()
    do {
      const page = await this.dependencies.ingestion.listRecords(scope, parse.parseId, { limit: 200, ...(cursor === undefined ? {} : { cursor }) }, ctx)
      scanned += page.records.length
      if (scanned > 10_000 || page.total !== parse.coverage.parsedUnits) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the persisted structured source exceeds the finite selection or coverage')
      for (const row of page.records) {
        const origin = unresolved.get(row.recordId)
        if (origin === undefined) continue
        if (row.rowDigest !== origin.rowDigest || row.sourceRowKey !== origin.sourceRowKey || sha256OfCanonical(row.locator) !== sha256OfCanonical(origin.rowLocator)) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the original projection differs from the actual persisted structured row')
        unresolved.delete(row.recordId)
      }
      cursor = page.nextCursor
      if (cursor !== undefined && seenCursors.has(cursor)) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the structured source page cursor did not advance')
      if (cursor !== undefined) seenCursors.add(cursor)
    } while (cursor !== undefined && unresolved.size > 0)
    if (unresolved.size > 0) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the projection source rows do not belong to the actual stored parse selection')
    const normalized = buildNormalizedTextArtifact('character', projection.text)
    const publish = async (bytes: Uint8Array, mediaType: string) => {
      const staged = await this.dependencies.blobs.stage(bytes, { scopeRef: scope }, ctx)
      return this.dependencies.blobs.publish({ scopeRef: scope, contentDigest: staged.contentDigest, mediaType, byteSize: staged.byteSize, purpose: 'artifact' }, ctx)
    }
    const normalizedRef = (await publish(normalized, NORMALIZED_TEXT_MEDIA_TYPE)).blobRef
    const spanMapRef = (await publish(projection.map, 'application/vnd.ontology.structured-document-map+json')).blobRef
    // Memberships and mapped facts pin the original structured parse. The separate
    // document store holds its bounded text projection under that same source ID.
    const parseId = parse.parseId
    const chunks: DocumentChunkRecord[] = projection.rows.map((row, ordinal) => ({
      chunkId: deterministicUuid(`${parseId}|${ordinal}`), ordinal, chunkKind: parse.format === 'json' ? 'paragraph' : 'table', text: row.text,
      textDigest: sha256DigestOfText(row.text), quoteDigest: sha256DigestOfText(row.text),
      locator: { kind: 'approximate_locator', startOffset: row.start, endOffset: row.end, normalizationMapRef: spanMapRef.digest },
      spanKind: 'approximate', precision: 'approximate', conditions: [], exceptions: [],
      ...(projection.coverage.completeness === 'complete' ? {} : { truncated: true }),
    }))
    const record: DocumentParseRecord = { parseId, scopeRef: scope, mediaKind: 'text', originalMediaType: parse.originalMediaType,
      originalRef: parse.originalRef, normalizedMediaType: NORMALIZED_TEXT_MEDIA_TYPE, normalizedByteSize: normalized.byteLength,
      normalizedRef, spanMapMediaType: 'application/vnd.ontology.structured-document-map+json', spanMapRef,
      parserId: STRUCTURED_PROJECTION_ID, parserVersion: STRUCTURED_PROJECTION_VERSION, offsetUnit: 'character',
      coverage: projection.coverage, pages: [], ...(parse.sourceRef === undefined ? {} : { sourceRef: parse.sourceRef }),
      documentVersionRef: parse.documentVersionRef ?? parse.originalRef, createdAt: this.dependencies.now?.() ?? new Date().toISOString() }
    const saved = await this.dependencies.parses.recordParse(record, chunks, ctx)
    if (!saved.created) {
      const winner = await this.dependencies.parses.getParse(scope, parseId, ctx)
      if (winner === undefined) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the winning immutable projection is unavailable')
      return winner
    }
    return record
  }

  async originalBytes(ref: ResourceRef, ctx: ToolContext): Promise<Uint8Array> {
    const request = { scopeRef: scopeOf(ctx), blobRef: ref }
    const metadata = await this.dependencies.blobs.getAuthorized(request, ctx)
    if (!metadata.integrityVerified || metadata.byteSize > 20 * 1024 * 1024) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the authorized structured original exceeds the parser bound or failed integrity')
    const bytes = await this.dependencies.blobs.readAuthorized(request, ctx)
    if (bytes.byteLength !== metadata.byteSize || sha256DigestOfBytes(bytes) !== ref.digest) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the structured original bytes do not match the immutable reference')
    return bytes
  }
}

/** Reads projection text only after re-verifying its genuine original row/cell origins. */
export class StructuredDocumentSpanReader implements DocumentSpanReaderPort {
  readonly #text: DocumentSpanReader
  readonly #projection: StructuredDocumentProjectionService
  constructor(readonly dependencies: StructuredDocumentProjectionDependencies) {
    this.#text = new DocumentSpanReader({ blobs: dependencies.blobs, store: dependencies.parses, ...(dependencies.now === undefined ? {} : { now: dependencies.now }) })
    this.#projection = new StructuredDocumentProjectionService(dependencies)
  }
  async readOrigin(request: ReadSpanRequest, ctx: ToolContext): Promise<StructuredProjectionOrigin | undefined> {
    const scope = scopeOf(ctx)
    const record = await this.dependencies.parses.findParseByDigest(scope, request.documentRef.digest, STRUCTURED_PROJECTION_VERSION, ctx)
    if (record === undefined || record.parserId !== STRUCTURED_PROJECTION_ID || request.locator.normalizationMapRef !== record.spanMapRef.digest) return undefined
    const parse = await this.dependencies.ingestion.findParseByDigest(scope, request.documentRef.digest, STRUCTURED_PARSER_VERSION, ctx)
    if (parse === undefined || sha256OfCanonical(parse.originalRef) !== sha256OfCanonical(request.documentRef)) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the projection has no matching authorized original structured parse')
    const mapMetadata = await this.dependencies.blobs.getAuthorized({ scopeRef: scope, blobRef: record.spanMapRef }, ctx)
    if (!mapMetadata.integrityVerified || mapMetadata.byteSize > STRUCTURED_PROJECTION_MAX_MAP_BYTES) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the source map exceeds its finite artifact bound or failed integrity')
    const savedMap = await this.dependencies.blobs.readAuthorized({ scopeRef: scope, blobRef: record.spanMapRef }, ctx)
    const map: unknown = JSON.parse(new TextDecoder().decode(savedMap))
    if (!isRecord(map) || map['schemaVersion'] !== 'structured-document-projection@1' || map['structuredParseId'] !== parse.parseId || !isStructuredParseSelection(map['selection'])
      || (parse.parseOptions !== undefined && sha256OfCanonical(parse.parseOptions) !== sha256OfCanonical(map['selection']))) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the source map does not pin the actual native selection')
    const projection = derive(await this.#projection.originalBytes(request.documentRef, ctx), parse, map['selection'])
    if (sha256DigestOfBytes(savedMap) !== record.spanMapRef.digest || sha256DigestOfBytes(projection.map) !== record.spanMapRef.digest) throw new DocumentExtractionError('SPAN_STORE_FAILED', 'the original source does not reproduce the pinned projection map')
    const row = projection.rows.find((candidate) => candidate.start === request.locator.startOffset && candidate.end === request.locator.endOffset)
    if (row === undefined || request.locator.kind !== 'approximate_locator') throw new DocumentExtractionError('SPAN_OUT_OF_RANGE', 'the locator does not name a complete projected source row')
    return { ...row.origin, projectionRef: record.normalizedRef }
  }
  async readSpan(request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    const origin = await this.readOrigin(request, ctx)
    if (origin === undefined) return this.#text.readSpan(request, ctx)
    const record = await this.dependencies.parses.findParseByDigest(scopeOf(ctx), request.documentRef.digest, STRUCTURED_PROJECTION_VERSION, ctx)
    if (record === undefined) throw new DocumentExtractionError('DOCUMENT_NOT_PARSED', 'the pinned projection is unavailable')
    return this.#text.readParsedSpan(record, request, ctx)
  }
  async readParsedSpan(record: DocumentParseRecord, request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    if (record.parserId === STRUCTURED_PROJECTION_ID && record.parserVersion === STRUCTURED_PROJECTION_VERSION) await this.readOrigin(request, ctx)
    return this.#text.readParsedSpan(record, request, ctx)
  }
}
