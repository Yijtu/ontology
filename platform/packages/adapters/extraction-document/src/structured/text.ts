import type {
  StructuredCell,
  StructuredParseCaps,
  StructuredParseIssue,
  StructuredParseOptions,
  StructuredRecord,
} from '@ontology/contracts'
import { bomLength, decodeUtf8Strict, identityNormalizationMapRef } from './bytes'
import { classifyLexicalCell } from './cells'
import { enforceCellBytes } from './caps'
import { StructuredParseError } from './errors'
import type { FormatParseResult } from './internal'

/**
 * UTF-8 text keeps the original line bytes and records half-open byte offsets, so
 * every record round-trips to the exact source. Invalid UTF-8 is refused rather
 * than replaced.
 */
export function parseText(
  bytes: Uint8Array,
  options: StructuredParseOptions,
  caps: StructuredParseCaps,
): FormatParseResult {
  const normalizationMapRef = identityNormalizationMapRef(bytes)
  const start = bomLength(bytes)
  if (bytes.length - start === 0) {
    throw new StructuredParseError('EMPTY_INPUT', 'the text input is empty')
  }

  interface Line {
    readonly row: number
    readonly startByte: number
    readonly endByte: number
  }
  const lines: Line[] = []
  let cursor = start
  let row = 1
  while (cursor < bytes.length) {
    const lineStart = cursor
    let lineEnd = cursor
    while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a && bytes[lineEnd] !== 0x0d) {
      lineEnd += 1
    }
    let terminator = lineEnd
    if (terminator < bytes.length) {
      if (bytes[terminator] === 0x0d && bytes[terminator + 1] === 0x0a) terminator += 2
      else terminator += 1
    }
    lines.push({ row, startByte: lineStart, endByte: lineEnd })
    if (terminator >= bytes.length) break
    cursor = terminator
    row += 1
  }

  const diagnostics: StructuredParseIssue[] = []
  let status: 'complete' | 'incomplete' = 'complete'
  let skippedUnits = 0
  const skippedReasons: string[] = []
  let effectiveLines = lines
  if (lines.length > caps.maxRows) {
    if ((options.capBreachMode ?? 'reject') === 'truncate') {
      effectiveLines = lines.slice(0, caps.maxRows)
      status = 'incomplete'
      skippedUnits = lines.length - effectiveLines.length
      skippedReasons.push(`TOO_MANY_ROWS: ${lines.length} > ${caps.maxRows}`)
      diagnostics.push({
        code: 'TOO_MANY_ROWS',
        severity: 'warning',
        message: `parsed the first ${caps.maxRows} of ${lines.length} text lines; result is explicitly incomplete`,
      })
    } else {
      throw new StructuredParseError(
        'TOO_MANY_ROWS',
        `the text has ${lines.length} lines, above the ${caps.maxRows}-line cap`,
      )
    }
  }

  const records: StructuredRecord[] = effectiveLines.map((line) => {
    const slice = bytes.subarray(line.startByte, line.endByte)
    let raw: string
    try {
      raw = decodeUtf8Strict(slice)
    } catch (error) {
      throw new StructuredParseError('INVALID_UTF8', `line ${line.row} is not valid UTF-8`, {
        row: line.row,
        cause: error,
      })
    }
    enforceCellBytes(slice.byteLength, caps)
    const locator = {
      kind: 'offset' as const,
      startOffset: line.startByte,
      endOffset: line.endByte,
      normalizationMapRef,
    }
    const cells: readonly StructuredCell[] =
      raw.length === 0
        ? [classifyLexicalCell('', locator, caps)]
        : [classifyLexicalCell(raw, locator, caps)]
    return { recordIndex: line.row, recordRef: `line:${line.row}`, locator, cells }
  })

  return {
    tables: [],
    records,
    sheets: [],
    diagnostics,
    status,
    totalUnits: lines.length,
    parsedUnits: records.length,
    skippedUnits,
    skippedReasons,
    notes: [],
  }
}
