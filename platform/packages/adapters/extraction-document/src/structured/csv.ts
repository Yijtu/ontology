import type {
  CsvDelimiter,
  QuoteChar,
  Sha256Digest,
  StructuredCell,
  StructuredColumn,
  StructuredParseCaps,
  StructuredParseIssue,
  StructuredParseOptions,
  StructuredRow,
  StructuredTable,
  TableCellSourceLocator,
  TableRowSourceLocator,
} from '@ontology/contracts'
import { bomLength, decodeUtf8Strict, identityNormalizationMapRef, sha256DigestOfText } from './bytes'
import { classifyLexicalCell } from './cells'
import { enforceCellBytes } from './caps'
import { StructuredParseError } from './errors'
import type { FormatParseResult } from './internal'
import { columnLabel } from './internal'

interface CsvField {
  readonly startByte: number
  readonly endByte: number
  readonly content: Uint8Array
}

interface CsvRecord {
  readonly row: number
  readonly fields: readonly CsvField[]
}

const DEFAULT_QUOTE: QuoteChar = '"'

function byteOfDelimiter(delimiter: CsvDelimiter): number {
  return delimiter.charCodeAt(0)
}

function quoteByte(quote: QuoteChar): number {
  return quote.charCodeAt(0)
}

/**
 * RFC-4180-style tokenizer that keeps the original byte range of every field.
 * Quoted fields may contain delimiters, escaped quotes and embedded newlines;
 * `recordIndex`/`row`/`column` are 1-based and `startByte`/`endByte` are
 * half-open offsets into the immutable original.
 */
function tokenizeCsv(bytes: Uint8Array, delimiter: CsvDelimiter, quote: QuoteChar): CsvRecord[] {
  const n = bytes.length
  const delim = byteOfDelimiter(delimiter)
  const q = quoteByte(quote)
  const records: CsvRecord[] = []

  let cursor = bomLength(bytes)
  let lineNumber = 1

  while (cursor < n) {
    const byte = bytes[cursor]
    if (byte === 0x0a) {
      cursor += 1
      lineNumber += 1
      continue
    }
    if (byte === 0x0d) {
      cursor += 1
      if (cursor < n && bytes[cursor] === 0x0a) cursor += 1
      lineNumber += 1
      continue
    }

    const recordRow = lineNumber
    const fields: CsvField[] = []
    let recordDone = false

    while (!recordDone) {
      const fieldStart = cursor
      const content: number[] = []
      if (bytes[cursor] === q) {
        cursor += 1
        let closed = false
        while (cursor < n) {
          const inner = bytes[cursor]
          if (inner === undefined) break
          if (inner === q) {
            if (cursor + 1 < n && bytes[cursor + 1] === q) {
              content.push(q)
              cursor += 2
              continue
            }
            cursor += 1
            closed = true
            break
          }
          if (inner === 0x0a) lineNumber += 1
          content.push(inner)
          cursor += 1
        }
        if (!closed) {
          throw new StructuredParseError('MALFORMED_CSV', `unterminated quoted field on row ${recordRow}`, {
            row: recordRow,
          })
        }
        if (cursor < n && bytes[cursor] !== delim && bytes[cursor] !== 0x0a && bytes[cursor] !== 0x0d) {
          throw new StructuredParseError(
            'MALFORMED_CSV',
            `unexpected character after a quoted field on row ${recordRow}`,
            { row: recordRow },
          )
        }
      } else {
        while (cursor < n) {
          const plain = bytes[cursor]
          if (plain === undefined) break
          if (plain === delim || plain === 0x0a || plain === 0x0d) break
          if (plain === q) {
            throw new StructuredParseError(
              'MALFORMED_CSV',
              `a quote inside an unquoted field on row ${recordRow}`,
              { row: recordRow },
            )
          }
          content.push(plain)
          cursor += 1
        }
      }
      fields.push({ startByte: fieldStart, endByte: cursor, content: Uint8Array.from(content) })

      if (cursor >= n) {
        recordDone = true
      } else if (bytes[cursor] === delim) {
        cursor += 1
      } else {
        if (bytes[cursor] === 0x0d) {
          cursor += 1
          if (cursor < n && bytes[cursor] === 0x0a) cursor += 1
        } else {
          cursor += 1
        }
        lineNumber += 1
        recordDone = true
      }
    }

    records.push({ row: recordRow, fields })
  }

  return records
}

function decodeField(field: CsvField, row: number, column: number, caps: StructuredParseCaps): string {
  let decoded: string
  try {
    decoded = decodeUtf8Strict(field.content)
  } catch (error) {
    throw new StructuredParseError('INVALID_UTF8', `row ${row} column ${column} is not valid UTF-8`, {
      row,
      cause: error,
    })
  }
  enforceCellBytes(field.content.byteLength, caps)
  return decoded
}

/** A header cell that is empty cannot name a column; naming it would be a guess. */
function assertHeaderNamed(records: readonly CsvRecord[], headerRow: number): CsvRecord {
  const header = records.find((record) => record.row === headerRow)
  if (header === undefined) {
    throw new StructuredParseError(
      'UNSUPPORTED_TABLE_LAYOUT',
      `the configured header row ${headerRow} does not exist`,
      { row: headerRow },
    )
  }
  if (header.fields.length === 0) {
    throw new StructuredParseError('EMPTY_INPUT', 'the header row has no columns', { row: headerRow })
  }
  return header
}

export function parseCsv(
  bytes: Uint8Array,
  options: StructuredParseOptions,
  caps: StructuredParseCaps,
): FormatParseResult {
  const delimiter = options.delimiter ?? ','
  const quote = options.quote ?? DEFAULT_QUOTE
  const normalizationMapRef = identityNormalizationMapRef(bytes)
  const records = tokenizeCsv(bytes, delimiter, quote)
  if (records.length === 0) {
    throw new StructuredParseError('EMPTY_INPUT', 'the CSV contains no rows')
  }

  const headerRow = options.headerRow ?? 1
  const explicitDataStart = options.dataStartRow
  const dataStartRow = explicitDataStart ?? headerRow + 1
  if (dataStartRow <= headerRow) {
    throw new StructuredParseError(
      'UNSUPPORTED_TABLE_LAYOUT',
      'dataStartRow must be after headerRow',
      { row: headerRow },
    )
  }

  const header = assertHeaderNamed(records, headerRow)
  const headerValues = header.fields.map((field, index) =>
    decodeField(field, header.row, index + 1, caps),
  )
  if (explicitDataStart === undefined && headerValues.some((value) => value.trim().length === 0)) {
    throw new StructuredParseError(
      'UNSUPPORTED_MULTI_LEVEL_HEADER',
      'the header row has blank column names; choose the header/range explicitly instead of guessing columns',
      { row: headerRow },
    )
  }
  const columnCount = header.fields.length
  if (columnCount > caps.maxColumns) {
    throw new StructuredParseError(
      'TOO_MANY_COLUMNS',
      `the sheet has ${columnCount} columns, above the ${caps.maxColumns}-column cap`,
      { row: headerRow },
    )
  }

  const columns: StructuredColumn[] = header.fields.map((_field, index) => ({
    column: index + 1,
    index,
    header: headerValues[index] ?? '',
    headerDigest: sha256DigestOfText(headerValues[index] ?? '') as Sha256Digest,
    address: `${columnLabel(index + 1)}${header.row}`,
    hidden: false,
  }))

  const dataRecords = records.filter((record) => record.row >= dataStartRow)
  const diagnostics: StructuredParseIssue[] = []
  let status: 'complete' | 'incomplete' = 'complete'
  let skippedUnits = 0
  const skippedReasons: string[] = []
  const notes: string[] = []
  if (explicitDataStart !== undefined && dataStartRow > headerRow + 1) {
    notes.push(`rows ${headerRow + 1}-${dataStartRow - 1} were skipped between the header and data`)
  }

  let effectiveRecords = dataRecords
  if (dataRecords.length > caps.maxRows) {
    if ((options.capBreachMode ?? 'reject') === 'truncate') {
      effectiveRecords = dataRecords.slice(0, caps.maxRows)
      status = 'incomplete'
      skippedUnits = dataRecords.length - effectiveRecords.length
      skippedReasons.push(`TOO_MANY_ROWS: ${dataRecords.length} > ${caps.maxRows}`)
      diagnostics.push({
        code: 'TOO_MANY_ROWS',
        severity: 'warning',
        message: `parsed the first ${caps.maxRows} of ${dataRecords.length} data rows; result is explicitly incomplete`,
      })
    } else {
      throw new StructuredParseError(
        'TOO_MANY_ROWS',
        `the sheet has ${dataRecords.length} data rows, above the ${caps.maxRows}-row cap`,
      )
    }
  }

  const rows: StructuredRow[] = []
  effectiveRecords.forEach((record, recordOffset) => {
    if (record.fields.length > columnCount) {
      throw new StructuredParseError(
        'UNSUPPORTED_TABLE_LAYOUT',
        `row ${record.row} has ${record.fields.length} columns but the header has ${columnCount}`,
        { row: record.row },
      )
    }
    const recordIndex = recordOffset + 1
    const cells: StructuredCell[] = []
    for (let index = 0; index < columnCount; index += 1) {
      const field = record.fields[index]
      const locator: TableCellSourceLocator =
        field === undefined
          ? {
              kind: 'table_cell',
              format: 'csv',
              recordIndex,
              row: record.row,
              column: index + 1,
              address: `${columnLabel(index + 1)}${record.row}`,
              normalizationMapRef,
            }
          : {
              kind: 'table_cell',
              format: 'csv',
              recordIndex,
              row: record.row,
              column: index + 1,
              address: `${columnLabel(index + 1)}${record.row}`,
              startByte: field.startByte,
              endByte: field.endByte,
              normalizationMapRef,
            }
      const raw = field === undefined ? '' : decodeField(field, record.row, index + 1, caps)
      cells.push(classifyLexicalCell(raw, locator, caps))
    }
    const columnTo = columnCount
    const rowLocator: TableRowSourceLocator = {
      kind: 'table_row',
      format: 'csv',
      recordIndex,
      row: record.row,
      columnFrom: 1,
      columnTo,
      normalizationMapRef,
    }
    rows.push({ recordIndex, row: record.row, hidden: false, cells, locator: rowLocator })
  })

  const table: StructuredTable = {
    format: 'csv',
    headerRow,
    columnCount,
    dataRowCount: rows.length,
    columns,
    rows,
    hiddenRows: [],
    hiddenColumns: [],
    emptyRows: [],
    merges: [],
  }

  return {
    tables: [table],
    records: [],
    sheets: [],
    diagnostics,
    status,
    totalUnits: dataRecords.length,
    parsedUnits: rows.length,
    skippedUnits,
    skippedReasons,
    notes,
  }
}
