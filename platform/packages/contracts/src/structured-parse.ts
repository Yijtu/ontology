import type { DecimalString, Sha256Digest } from './generated/contracts'
import type { ParseCoverage } from './document-parse'

/**
 * Bounded structured parsing contracts (SPEC v0.3 A §5, A.US-002/P.US-003/P.US-013).
 *
 * The committed ingestion formats are UTF-8 text, JSON, CSV and XLSX. Every parsed
 * value keeps a `SourceLocator` that resolves back to the immutable original:
 * a JSON Pointer plus byte range, a table cell (sheet/row/column/A1 plus the CSV
 * byte range), or a whole table row. Raw lexical values are preserved verbatim so
 * a quantity never loses precision by passing through a JavaScript `Number`.
 *
 * These shapes are additive to the historical `DocumentSpan` locator (page/offset/
 * approximate_locator); the old locators stay readable and are part of the union.
 */

/** Media the structured parser understands. */
export type StructuredFormat = 'text' | 'json' | 'csv' | 'xlsx'

/**
 * Historical document locators (SPEC D3.2). Kept so a structured parse of text
 * reuses the byte-offset addressing the existing span reader already understands.
 */
export type ExistingSourceLocator =
  | {
      readonly kind: 'offset'
      readonly startOffset: number
      readonly endOffset: number
      readonly normalizationMapRef?: string
    }
  | {
      readonly kind: 'page'
      readonly page: number
      readonly startOffset?: number
      readonly endOffset?: number
      readonly normalizationMapRef?: string
    }
  | {
      readonly kind: 'approximate_locator'
      readonly page?: number
      readonly startOffset?: number
      readonly endOffset?: number
      readonly normalizationMapRef?: string
    }

/** A JSON value located by a JSON Pointer and the half-open original byte range. */
export interface JsonPointerSourceLocator {
  readonly kind: 'json_pointer'
  readonly pointer: string
  readonly startByte: number
  readonly endByte: number
  readonly normalizationMapRef: string
}

/**
 * One table cell. `row`/`column`/`recordIndex` are 1-based; `sheetId` is the
 * parser-stable id (never a local path); `address` is the A1 address for XLSX.
 * `startByte`/`endByte` are only present for CSV, whose cells live in the bytes.
 */
export interface TableCellSourceLocator {
  readonly kind: 'table_cell'
  readonly format: 'csv' | 'xlsx'
  readonly sheetId?: string
  readonly sheetName?: string
  readonly recordIndex: number
  readonly row: number
  readonly column: number
  readonly address?: string
  readonly startByte?: number
  readonly endByte?: number
  readonly normalizationMapRef: string
}

/** A whole table row spanning `columnFrom`..`columnTo` (1-based, inclusive). */
export interface TableRowSourceLocator {
  readonly kind: 'table_row'
  readonly format: 'csv' | 'xlsx'
  readonly sheetId?: string
  readonly sheetName?: string
  readonly recordIndex: number
  readonly row: number
  readonly columnFrom: number
  readonly columnTo: number
  readonly normalizationMapRef: string
}

export type SourceLocator =
  | ExistingSourceLocator
  | JsonPointerSourceLocator
  | TableCellSourceLocator
  | TableRowSourceLocator

/** The lexical class of a parsed cell. `empty` is missing, never a zero. */
export type StructuredCellKind =
  | 'empty'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'error'
  | 'formula'

interface StructuredCellBase {
  readonly raw: string
  readonly locator: SourceLocator
}

/** An absent value. Its raw is the empty string and it is never coerced to 0. */
export interface EmptyCell extends StructuredCellBase {
  readonly kind: 'empty'
  readonly raw: ''
}

export interface TextCell extends StructuredCellBase {
  readonly kind: 'text'
}

/**
 * An exact numeric value. `raw` is the original lexical token verbatim (e.g.
 * `0.10`, not `0.1`); `decimal` is present only when the token already matches
 * the canonical `DecimalString` grammar, so no rounding or exponent rewriting is
 * ever inferred at the parsing boundary.
 */
export interface NumberCell extends StructuredCellBase {
  readonly kind: 'number'
  readonly decimal?: DecimalString
}

export interface BooleanCell extends StructuredCellBase {
  readonly kind: 'boolean'
  readonly value: boolean
}

/** A date-typed source token, kept lexical and never auto-rendered. */
export interface DateCell extends StructuredCellBase {
  readonly kind: 'date'
}

/** A spreadsheet error cell (`#REF!`, ...); preserved, never called a value. */
export interface ErrorCell extends StructuredCellBase {
  readonly kind: 'error'
}

/**
 * A formula cell. There is no first-phase evaluator: the formula text and the
 * cached value are both preserved and the cached value never silently becomes a
 * confirmed input.
 */
export interface FormulaCell extends StructuredCellBase {
  readonly kind: 'formula'
  readonly formula: string
  readonly cachedRaw?: string
  readonly cachedKind?: Exclude<StructuredCellKind, 'formula'>
  readonly decimal?: DecimalString
}

export type StructuredCell =
  | EmptyCell
  | TextCell
  | NumberCell
  | BooleanCell
  | DateCell
  | ErrorCell
  | FormulaCell

/** A resolved column: position, header text and the header digest to map against. */
export interface StructuredColumn {
  /** 1-based column number in the original sheet (CSV column index too). */
  readonly column: number
  /** 0-based column position in the record. */
  readonly index: number
  readonly header: string
  readonly headerDigest: Sha256Digest
  readonly address: string
  readonly hidden: boolean
}

export interface StructuredRow {
  /** 1-based data record index (header rows excluded). */
  readonly recordIndex: number
  /** 1-based original row number, stable across re-imports. */
  readonly row: number
  readonly hidden: boolean
  readonly cells: readonly StructuredCell[]
  readonly locator: TableRowSourceLocator
}

/** A parsed sheet (CSV produces one; XLSX one for the selected sheet). */
export interface StructuredTable {
  readonly format: 'csv' | 'xlsx'
  readonly sheetId?: string
  readonly sheetName?: string
  readonly headerRow?: number
  readonly columnCount: number
  readonly dataRowCount: number
  readonly columns: readonly StructuredColumn[]
  readonly rows: readonly StructuredRow[]
  readonly hiddenRows: readonly number[]
  readonly hiddenColumns: readonly number[]
  /** Declared rows inside the data range that carry no cell value at all. */
  readonly emptyRows: readonly number[]
  readonly merges: readonly string[]
}

/** A JSON / text record: its record key plus the flattened leaf cells. */
export interface StructuredRecord {
  readonly recordIndex: number
  /** Stable within the parse, e.g. `/records/0` or `line:3`. */
  readonly recordRef: string
  readonly locator: SourceLocator
  readonly cells: readonly StructuredCell[]
}

/** Sheet selection metadata so a caller can choose a sheet without guessing. */
export interface StructuredSheetInfo {
  readonly sheetId: string
  readonly name: string
  readonly hidden: boolean
  readonly target: string
}

/** Why a parse is incomplete or rejected. Nothing is swallowed silently. */
export type StructuredParseIssueCode =
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'SCANNED_DOCUMENT'
  | 'UNSUPPORTED_DOCUMENT_GEOMETRY'
  | 'MACRO_ENABLED_WORKBOOK'
  | 'ENCRYPTED_WORKBOOK'
  | 'UNSUPPORTED_ZIP'
  | 'FILE_TOO_LARGE'
  | 'EXPANSION_TOO_LARGE'
  | 'TOO_MANY_ZIP_ENTRIES'
  | 'TOO_MANY_ROWS'
  | 'TOO_MANY_COLUMNS'
  | 'CELL_TOO_LARGE'
  | 'NESTING_TOO_DEEP'
  | 'UNSUPPORTED_MULTI_LEVEL_HEADER'
  | 'MERGED_CELLS'
  | 'UNSUPPORTED_TABLE_LAYOUT'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'DUPLICATE_JSON_KEY'
  | 'MALFORMED_CSV'
  | 'MALFORMED_XLSX'
  | 'MISSING_SHEET'
  | 'EMPTY_INPUT'
  | 'PARSE_FAILED'

export interface StructuredParseIssue {
  readonly code: StructuredParseIssueCode
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly sheetName?: string
  readonly row?: number
  readonly pointer?: string
}

/**
 * `complete` parsed every unit; `incomplete` returns explicit partial data for a
 * caller-chosen truncation; `rejected` produced no trustworthy table at all
 * (unsupported structure, hard cap, encoding or archive error).
 */
export type StructuredParseStatus = 'complete' | 'incomplete' | 'rejected'

export interface StructuredParseResult {
  readonly format: StructuredFormat
  readonly status: StructuredParseStatus
  readonly coverage: ParseCoverage
  readonly tables: readonly StructuredTable[]
  readonly records: readonly StructuredRecord[]
  readonly sheets: readonly StructuredSheetInfo[]
  readonly diagnostics: readonly StructuredParseIssue[]
}

/**
 * Versioned parser policy limits (SPEC v0.3 A §5.1). A breach is explicit: it
 * rejects (or, when the caller explicitly asks to truncate, returns
 * `incomplete`) and can never be reported as `complete`.
 */
export interface StructuredParseCaps {
  /** Default single upload 20 MiB. */
  readonly maxFileBytes: number
  /** XLSX ZIP expansion ceiling 100 MiB. */
  readonly maxExpandedBytes: number
  /** XLSX ZIP entry ceiling 10,000. */
  readonly maxZipEntries: number
  /** Data rows per selected sheet / JSON records: 10,000. */
  readonly maxRows: number
  /** Columns per sheet / leaf cells per record: 128. */
  readonly maxColumns: number
  /** Cell text ceiling: 64 KiB. */
  readonly maxCellBytes: number
  /** JSON nesting ceiling. */
  readonly maxDepth: number
}

export const DEFAULT_STRUCTURED_PARSE_CAPS: StructuredParseCaps = {
  maxFileBytes: 20 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024,
  maxZipEntries: 10_000,
  maxRows: 10_000,
  maxColumns: 128,
  maxCellBytes: 64 * 1024,
  maxDepth: 32,
}

export type StructuredEncoding = 'utf-8'

export type CsvDelimiter = ',' | ';' | '\t' | '|'

export type QuoteChar = '"' | "'"

/** How a row/column cap breach behaves. Default `reject`; never silent. */
export type CapBreachMode = 'reject' | 'truncate'

export interface StructuredParseOptions {
  readonly mediaType: string
  readonly caps?: Partial<StructuredParseCaps>
  /** Only UTF-8 is a committed encoding; any other declaration is rejected. */
  readonly encoding?: StructuredEncoding
  readonly delimiter?: CsvDelimiter
  readonly quote?: QuoteChar
  /** 1-based header row; absent means the caller has not chosen one yet. */
  readonly headerRow?: number
  /** 1-based first data row; defaults to headerRow + 1. */
  readonly dataStartRow?: number
  readonly sheetId?: string
  readonly sheetName?: string
  readonly capBreachMode?: CapBreachMode
}

/**
 * Bounded structured parsing port. Parsers are pure over bytes so a caller can
 * unit-test a format against fixed samples without a blob backend; the original
 * is never mutated.
 */
export interface StructuredDocumentParserPort {
  parse(bytes: Uint8Array, options: StructuredParseOptions): StructuredParseResult
}

