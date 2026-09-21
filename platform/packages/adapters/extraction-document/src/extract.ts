import { getDocumentProxy } from 'unpdf'
import type { DocumentMediaKind, DocumentPageRecord, Sha256Digest, ToolContext } from '@ontology/contracts'
import { DocumentExtractionError } from './errors'
import type { ExtractedText, OcrTextProvider, StructuralLine } from './types'

/**
 * Media detection. Only formats we can really parse are accepted: an unknown
 * media type is refused instead of being treated as plain text.
 */
export function mediaKindOf(mediaType: string): DocumentMediaKind | undefined {
  const normalized = (mediaType.split(';')[0] ?? '').trim().toLowerCase()
  if (normalized === 'application/pdf') return 'pdf'
  if (normalized === 'text/plain' || normalized === 'text/markdown' || normalized === 'text/x-markdown') {
    return 'text'
  }
  return undefined
}

export interface ExtractOptions {
  readonly mediaType: string
  readonly originalDigest: Sha256Digest
  readonly ocr: OcrTextProvider | undefined
  readonly maxPages: number | undefined
  readonly ctx: ToolContext
}

export async function extractDocument(
  bytes: Uint8Array,
  options: ExtractOptions,
): Promise<ExtractedText> {
  const mediaKind = mediaKindOf(options.mediaType)
  if (mediaKind === undefined) {
    throw new DocumentExtractionError(
      'UNSUPPORTED_MEDIA_TYPE',
      `no parser is registered for media type ${options.mediaType}`,
    )
  }
  return mediaKind === 'pdf' ? extractPdf(bytes, options) : extractPlainText(bytes)
}

/* ------------------------------------------------------------------ plain text */

const MARKDOWN_HEADING = /^(#{1,6})\s+(\S.*)$/
const UPPERCASE_HEADING = /^[A-Z][A-Z0-9 .,&'()/-]{2,79}$/

function plainHeadingLevel(text: string): number | undefined {
  const markdown = MARKDOWN_HEADING.exec(text)
  if (markdown !== null) {
    const hashes = markdown[1]
    return hashes === undefined ? 1 : hashes.length
  }
  if (UPPERCASE_HEADING.test(text) && /[A-Z]/.test(text)) return 1
  return undefined
}

/**
 * Plain text keeps the original bytes verbatim as the normalized text, so a
 * byte-offset span round-trips to the exact source bytes. Line endings are not
 * rewritten; only the line separator itself is excluded from the line range.
 */
function extractPlainText(bytes: Uint8Array): ExtractedText {
  const normalizedText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const encoder = new TextEncoder()
  const lines: StructuralLine[] = []
  let byteCursor = 0
  for (const rawLine of normalizedText.split('\n')) {
    const startOffset = byteCursor
    const endOffset = startOffset + encoder.encode(rawLine).length
    byteCursor = endOffset + 1
    const level = rawLine.trim().length === 0 ? undefined : plainHeadingLevel(rawLine.trim())
    lines.push({
      text: rawLine,
      page: 1,
      startOffset,
      endOffset,
      ...(level === undefined ? {} : { headingLevel: level }),
    })
  }
  const pages: DocumentPageRecord[] = [
    { page: 1, startOffset: 0, endOffset: bytes.length, approximate: false },
  ]
  return {
    mediaKind: 'text',
    offsetUnit: 'byte',
    normalizedText,
    lines,
    pages,
    coverage: {
      status: 'complete',
      completeness: 'complete',
      totalUnits: 1,
      parsedUnits: 1,
      skippedUnits: 0,
      skippedReasons: [],
      notes: ['plain text is parsed with identity normalization; spans are byte offsets into the original'],
    },
    notes: [],
  }
}

/* ------------------------------------------------------------------------- PDF */

interface TextRow {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly fontSize: number | undefined
}

interface PageLine {
  readonly text: string
  readonly fontSize: number | undefined
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted[Math.floor(sorted.length / 2)]
  return middle === undefined ? 0 : middle
}

function groupRowsIntoLines(rows: readonly TextRow[]): PageLine[] {
  const lines: PageLine[] = []
  let index = 0
  while (index < rows.length) {
    const first = rows[index]
    if (first === undefined) break
    const y = first.y
    const parts: string[] = []
    const fontSize = first.fontSize
    let cursor = index
    while (cursor < rows.length) {
      const row = rows[cursor]
      if (row === undefined || Math.abs(row.y - y) > 1.5) break
      parts.push(row.text.trim())
      cursor += 1
    }
    lines.push({ text: parts.join(' '), fontSize })
    index = cursor
  }
  return lines
}

async function extractPdf(bytes: Uint8Array, options: ExtractOptions): Promise<ExtractedText> {
  let pdf
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
  } catch (error) {
    throw new DocumentExtractionError('DOCUMENT_PARSE_FAILED', 'the PDF could not be opened', {
      cause: error,
    })
  }

  const totalPages = pdf.numPages
  const pageLimit = options.maxPages === undefined ? totalPages : Math.min(options.maxPages, totalPages)
  const skippedReasons: string[] = []
  const notes: string[] = []
  const fontSizes: number[] = []
  const pageLines: { page: number; lines: PageLine[]; approximate: boolean }[] = []
  let parsedPages = 0
  let skippedPages = 0

  try {
    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      if (pageNumber > pageLimit) {
        skippedPages += 1
        skippedReasons.push(`page ${pageNumber}: beyond the ${pageLimit}-page parse budget`)
        continue
      }
      try {
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        const rows: TextRow[] = []
        for (const item of content.items) {
          if (!('str' in item) || typeof item.str !== 'string' || item.str.trim().length === 0) {
            continue
          }
          const transform = item.transform
          const scaleX = transform[2]
          const scaleY = transform[3]
          rows.push({
            text: item.str,
            x: transform[4] ?? 0,
            y: transform[5] ?? 0,
            fontSize:
              scaleX === undefined || scaleY === undefined ? undefined : Math.hypot(scaleX, scaleY),
          })
        }
        rows.sort((left, right) => right.y - left.y || left.x - right.x)

        if (rows.length > 0) {
          const lines = groupRowsIntoLines(rows)
          for (const line of lines) {
            if (line.fontSize !== undefined && line.fontSize > 0) fontSizes.push(line.fontSize)
          }
          parsedPages += 1
          pageLines.push({ page: pageNumber, lines, approximate: false })
          continue
        }

        // No text layer. Only an injected OCR provider can recover text, and the
        // result is marked approximate; otherwise the page is explicitly skipped.
        if (options.ocr === undefined) {
          skippedPages += 1
          skippedReasons.push(`page ${pageNumber}: no text layer and no OCR provider configured`)
          continue
        }
        const recognized = await options.ocr.recognize(
          { page: pageNumber, originalDigest: options.originalDigest, mediaType: options.mediaType },
          options.ctx,
        )
        parsedPages += 1
        notes.push(
          `page ${pageNumber}: text recovered by OCR provider ${recognized.providerId}; locations are approximate`,
        )
        const ocrLines: PageLine[] = recognized.text
          .split('\n')
          .filter((line) => line.trim().length > 0)
          .map((line) => ({ text: line, fontSize: undefined }))
        pageLines.push({ page: pageNumber, lines: ocrLines, approximate: true })
      } catch (error) {
        skippedPages += 1
        const message = error instanceof Error ? error.message : String(error)
        skippedReasons.push(`page ${pageNumber}: ${message}`)
      }
    }
  } finally {
    // The bundled PDF.js build exposes cleanup() but not the loading task, so the
    // document's page resources are released here.
    await pdf.cleanup().catch(() => undefined)
  }

  if (parsedPages === 0) {
    throw new DocumentExtractionError(
      'DOCUMENT_PARSE_FAILED',
      `no page of the PDF could be parsed (${skippedReasons.join('; ') || 'empty document'})`,
    )
  }

  const bodyFontSize = median(fontSizes)
  const headingThreshold = bodyFontSize * 1.2

  const lines: StructuralLine[] = []
  const pages: DocumentPageRecord[] = []
  const normalizedParts: string[] = []
  let charCursor = 0
  for (const page of pageLines) {
    const pageStart = charCursor
    for (const line of page.lines) {
      const startOffset = charCursor
      const endOffset = startOffset + line.text.length
      charCursor = endOffset + 1
      const isHeading =
        line.fontSize !== undefined && line.fontSize > 0 && line.fontSize >= headingThreshold
      lines.push({
        text: line.text,
        page: page.page,
        startOffset,
        endOffset,
        ...(isHeading ? { headingLevel: 1 } : {}),
        ...(line.fontSize === undefined ? {} : { fontSize: line.fontSize }),
      })
      normalizedParts.push(line.text)
    }
    pages.push({
      page: page.page,
      startOffset: pageStart,
      endOffset: charCursor > pageStart ? charCursor - 1 : pageStart,
      approximate: page.approximate,
    })
  }

  const skipped = skippedPages
  const status = skipped === 0 ? 'complete' : 'partial'
  const completeness =
    skipped === 0 ? 'complete' : pageLimit < totalPages ? 'truncated' : 'partial'

  return {
    mediaKind: 'pdf',
    offsetUnit: 'character',
    normalizedText: normalizedParts.join('\n'),
    lines,
    pages,
    coverage: {
      status,
      completeness,
      totalUnits: totalPages,
      parsedUnits: parsedPages,
      skippedUnits: skipped,
      skippedReasons,
      notes,
    },
    notes,
  }
}
