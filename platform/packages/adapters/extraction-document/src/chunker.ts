import type {
  DocumentChunkRecord,
  DocumentPageRecord,
  NonEmptyString,
  OffsetUnit,
  Sha256Digest,
  Uuid,
} from '@ontology/contracts'
import { deterministicUuid, sha256DigestOfText } from './hashing'
import type { DraftChunk, StructuralLine } from './types'

/**
 * Structure-aware chunking (SPEC D4.1).
 *
 * The unit of a chunk is a *block*, not a line: a clause absorbs the lines that
 * qualify it (conditions, exceptions, wrapped body text) so a qualifier is never
 * split from the clause it governs, and a table absorbs its caption and header
 * row. The chunk text is the exact source range, so a span read back from the
 * original still matches.
 */

const CLAUSE = /^(\d+(?:\.\d+)*)[.)、:：]?\s+\S/
const TABLE_CAPTION = /^(table|表)\s*\d*\s*[:：.\-]?\s*/i
const CONDITION = /^(if|when|unless|provided\s+that|where)\b/i
const CONDITION_LABELLED = /^(condition|条件|前提)\s*[:：]/i
const EXCEPTION = /^(except|however|notwithstanding|but)\b/i
const EXCEPTION_LABELLED = /^(exception|例外)\s*[:：]/i

export function isConditionLine(text: string): boolean {
  const trimmed = text.trim()
  return CONDITION.test(trimmed) || CONDITION_LABELLED.test(trimmed) || trimmed.startsWith('当')
}

export function isExceptionLine(text: string): boolean {
  const trimmed = text.trim()
  return (
    EXCEPTION.test(trimmed) ||
    EXCEPTION_LABELLED.test(trimmed) ||
    trimmed.startsWith('但') ||
    trimmed.startsWith('除非')
  )
}

/** A row-like line: pipe-separated columns, aligned columns or a tab. */
export function isTableRow(text: string): boolean {
  if (text.includes('\t')) return true
  const columns = text.split('|').filter((segment) => segment.trim().length > 0)
  if (columns.length >= 2) return true
  return /\S {2,}\S/.test(text)
}

function isHeading(line: StructuralLine): boolean {
  return line.headingLevel !== undefined
}

function isClause(line: StructuralLine): boolean {
  return CLAUSE.test(line.text.trim())
}

function isBlank(line: StructuralLine): boolean {
  return line.text.trim().length === 0
}

export interface ChunkOptions {
  readonly offsetUnit: OffsetUnit
  /** Pages whose text came from OCR: every chunk on them is approximate. */
  readonly approximatePages: ReadonlySet<number>
}

export function chunkLines(
  lines: readonly StructuralLine[],
  options: ChunkOptions,
): DraftChunk[] {
  const chunks: DraftChunk[] = []
  let currentHeading: string | undefined
  let currentSectionOrdinal: number | undefined
  let index = 0

  const push = (chunk: DraftChunk): void => {
    chunks.push(chunk)
  }

  const hasTableRowsAhead = (from: number): boolean => {
    for (let cursor = from + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]
      if (candidate === undefined) return false
      if (isBlank(candidate)) return false
      if (isTableRow(candidate.text)) return true
      return false
    }
    return false
  }

  while (index < lines.length) {
    const line = lines[index]
    if (line === undefined) break
    if (isBlank(line)) {
      index += 1
      continue
    }

    if (isHeading(line)) {
      currentHeading = line.text.trim()
      currentSectionOrdinal = chunks.length
      push({
        chunkKind: 'section',
        heading: line.text.trim(),
        text: line.text,
        page: line.page,
        startOffset: line.startOffset,
        endOffset: line.endOffset,
        precision: options.approximatePages.has(line.page) ? 'approximate' : 'exact',
        conditions: [],
        exceptions: [],
      })
      index += 1
      continue
    }

    if (TABLE_CAPTION.test(line.text.trim()) && hasTableRowsAhead(index)) {
      const rows: StructuralLine[] = []
      let cursor = index + 1
      while (cursor < lines.length) {
        const row = lines[cursor]
        if (row === undefined || isBlank(row) || !isTableRow(row.text)) break
        rows.push(row)
        cursor += 1
      }
      const last = rows[rows.length - 1] ?? line
      const header = rows[0]
      push({
        chunkKind: 'table',
        ...(currentHeading === undefined ? {} : { heading: currentHeading }),
        text: [line.text, ...rows.map((row) => row.text)].join('\n'),
        page: line.page,
        startOffset: line.startOffset,
        endOffset: last.endOffset,
        precision: options.approximatePages.has(line.page) ? 'approximate' : 'exact',
        conditions: [],
        exceptions: [],
        caption: line.text.trim(),
        ...(header === undefined ? {} : { tableHeader: header.text.trim() }),
        ...(currentSectionOrdinal === undefined ? {} : { parentOrdinal: currentSectionOrdinal }),
      })
      index = cursor
      continue
    }

    if (isClause(line)) {
      const block: StructuralLine[] = [line]
      let cursor = index + 1
      while (cursor < lines.length) {
        const next = lines[cursor]
        if (next === undefined || isBlank(next)) break
        if (isHeading(next) || isClause(next)) break
        if (TABLE_CAPTION.test(next.text.trim()) && hasTableRowsAhead(cursor)) break
        block.push(next)
        cursor += 1
      }
      const last = block[block.length - 1] ?? line
      const conditions: string[] = []
      const exceptions: string[] = []
      for (const blockLine of block) {
        const text = blockLine.text.trim()
        if (isConditionLine(text)) conditions.push(text)
        else if (isExceptionLine(text)) exceptions.push(text)
      }
      push({
        chunkKind: 'clause',
        ...(currentHeading === undefined ? {} : { heading: currentHeading }),
        text: block.map((blockLine) => blockLine.text).join('\n'),
        page: line.page,
        startOffset: line.startOffset,
        endOffset: last.endOffset,
        precision: options.approximatePages.has(line.page) ? 'approximate' : 'exact',
        conditions,
        exceptions,
        ...(currentSectionOrdinal === undefined ? {} : { parentOrdinal: currentSectionOrdinal }),
      })
      index = cursor
      continue
    }

    const block: StructuralLine[] = [line]
    let cursor = index + 1
    while (cursor < lines.length) {
      const next = lines[cursor]
      if (next === undefined || isBlank(next)) break
      if (isHeading(next) || isClause(next)) break
      if (TABLE_CAPTION.test(next.text.trim()) && hasTableRowsAhead(cursor)) break
      block.push(next)
      cursor += 1
    }
    const last = block[block.length - 1] ?? line
    push({
      chunkKind: 'paragraph',
      ...(currentHeading === undefined ? {} : { heading: currentHeading }),
      text: block.map((blockLine) => blockLine.text).join('\n'),
      page: line.page,
      startOffset: line.startOffset,
      endOffset: last.endOffset,
      precision: options.approximatePages.has(line.page) ? 'approximate' : 'exact',
      conditions: [],
      exceptions: [],
      ...(currentSectionOrdinal === undefined ? {} : { parentOrdinal: currentSectionOrdinal }),
    })
    index = cursor
  }

  return chunks
}

export interface BuildChunkContext {
  readonly parseId: Uuid
  readonly offsetUnit: OffsetUnit
  /**
   * The span-map artifact's content digest. It is the normalization map's
   * content-addressed locator, so a span points at the map without the map
   * having to contain its own digest.
   */
  readonly normalizationMapRef?: NonEmptyString
}

export function buildChunkRecords(
  drafts: readonly DraftChunk[],
  context: BuildChunkContext,
): DocumentChunkRecord[] {
  const parentIds = new Map<number, Uuid>()
  const records: DocumentChunkRecord[] = []
  drafts.forEach((draft, ordinal) => {
    const textDigest: Sha256Digest = sha256DigestOfText(draft.text)
    const chunkId = deterministicUuid(`${context.parseId}|${ordinal}|${textDigest}`)
    const locator =
      context.offsetUnit === 'byte'
        ? { kind: 'offset' as const, startOffset: draft.startOffset, endOffset: draft.endOffset }
        : {
            kind: draft.precision === 'approximate' ? ('approximate_locator' as const) : ('page' as const),
            page: draft.page,
            startOffset: draft.startOffset,
            endOffset: draft.endOffset,
            ...(context.normalizationMapRef === undefined
              ? {}
              : { normalizationMapRef: context.normalizationMapRef }),
          }
    const parentId =
      draft.parentOrdinal === undefined ? undefined : parentIds.get(draft.parentOrdinal)
    const record: DocumentChunkRecord = {
      chunkId,
      ordinal,
      chunkKind: draft.chunkKind,
      ...(draft.heading === undefined ? {} : { heading: draft.heading }),
      text: draft.text,
      textDigest,
      locator,
      spanKind: draft.precision === 'approximate' ? 'approximate' : context.offsetUnit === 'byte' ? 'verbatim' : 'normalized',
      precision: draft.precision,
      quoteDigest: textDigest,
      conditions: draft.conditions,
      exceptions: draft.exceptions,
      ...(draft.caption === undefined ? {} : { caption: draft.caption }),
      ...(draft.tableHeader === undefined ? {} : { tableHeader: draft.tableHeader }),
      ...(parentId === undefined ? {} : { parentChunkId: parentId }),
    }
    if (draft.chunkKind === 'section') {
      parentIds.set(ordinal, chunkId)
    }
    records.push(record)
  })
  return records
}

/** The page a chunk was captured from; a byte-offset document has the single page 1. */
function chunkPageOf(chunk: DocumentChunkRecord): number {
  const locator = chunk.locator
  return typeof locator.page === 'number' ? locator.page : 1
}

/**
 * The ids of the chunks whose capture is genuinely incomplete (SPEC D4.1/D4.3, INV-06).
 *
 * A page the parser skipped (a corrupt stream, a page beyond the parse budget, an image-only
 * page without OCR) leaves a *gap* in the captured text. The last chunk captured before that gap
 * and the first captured after it may be missing continuation text, so they are marked
 * truncated rather than being treated as complete evidence. A document whose every page was
 * captured yields an empty list, so a caller can never mistake "no known gap" for "incomplete".
 */
export function truncatedChunkIdsOf(
  chunks: readonly DocumentChunkRecord[],
  pages: readonly DocumentPageRecord[],
  totalUnits: number,
): Uuid[] {
  if (chunks.length === 0) return []
  const captured = new Set(pages.map((page) => page.page))
  const headBoundary = new Set<number>()
  const tailBoundary = new Set<number>()
  for (const page of captured) {
    if (page > 1 && !captured.has(page - 1)) headBoundary.add(page)
    if (page < totalUnits && !captured.has(page + 1)) tailBoundary.add(page)
  }
  if (headBoundary.size === 0 && tailBoundary.size === 0) return []

  const firstOfPage = new Map<number, Uuid>()
  const lastOfPage = new Map<number, Uuid>()
  for (const chunk of chunks) {
    const page = chunkPageOf(chunk)
    if (!firstOfPage.has(page)) firstOfPage.set(page, chunk.chunkId)
    lastOfPage.set(page, chunk.chunkId)
  }

  const truncated = new Set<Uuid>()
  for (const page of headBoundary) {
    const chunkId = firstOfPage.get(page)
    if (chunkId !== undefined) truncated.add(chunkId)
  }
  for (const page of tailBoundary) {
    const chunkId = lastOfPage.get(page)
    if (chunkId !== undefined) truncated.add(chunkId)
  }
  return chunks.map((chunk) => chunk.chunkId).filter((chunkId) => truncated.has(chunkId))
}
