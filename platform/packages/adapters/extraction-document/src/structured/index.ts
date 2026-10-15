import type {
  StructuredDocumentParserPort,
  StructuredFormat,
  StructuredParseCaps,
  StructuredParseOptions,
  StructuredParseResult,
} from '@ontology/contracts'
import { resolveCaps } from './caps'
import { parseCsv } from './csv'
import { StructuredParseError, rejected } from './errors'
import { parseJson } from './json'
import { structuredFormatOf } from './media'
import { parseText } from './text'
import { parseXlsx } from './xlsx'
import type { FormatParseResult } from './internal'

export const STRUCTURED_PARSER_ID = 'ontology.structured-parser'
export const STRUCTURED_PARSER_VERSION = '1.0.0'

function dispatch(
  format: StructuredFormat,
  bytes: Uint8Array,
  options: StructuredParseOptions,
  caps: StructuredParseCaps,
): FormatParseResult {
  switch (format) {
    case 'text':
      return parseText(bytes, options, caps)
    case 'json':
      return parseJson(bytes, options, caps)
    case 'csv':
      return parseCsv(bytes, options, caps)
    case 'xlsx':
      return parseXlsx(bytes, options, caps)
  }
}

function toResult(format: StructuredFormat, parsed: FormatParseResult): StructuredParseResult {
  const complete = parsed.status === 'complete'
  return {
    format,
    status: parsed.status,
    coverage: {
      status: complete ? 'complete' : 'partial',
      completeness: complete ? 'complete' : 'truncated',
      totalUnits: parsed.totalUnits,
      parsedUnits: parsed.parsedUnits,
      skippedUnits: parsed.skippedUnits,
      skippedReasons: [...parsed.skippedReasons],
      notes: [...parsed.notes],
    },
    tables: parsed.tables,
    records: parsed.records,
    sheets: parsed.sheets,
    diagnostics: parsed.diagnostics,
  }
}

/**
 * Bounded, standalone structured parser (SPEC v0.3 A §5). Every format returns a
 * locator to the original; a cap breach or unsupported structure is an explicit
 * `rejected`/`incomplete` result, never a silently truncated `complete` one.
 */
export class StructuredDocumentParser implements StructuredDocumentParserPort {
  parse(bytes: Uint8Array, options: StructuredParseOptions): StructuredParseResult {
    let format: StructuredFormat
    try {
      format = structuredFormatOf(options.mediaType)
    } catch (error) {
      if (error instanceof StructuredParseError) return rejected('text', error)
      throw error
    }

    let caps: StructuredParseCaps
    try {
      caps = resolveCaps(options.caps)
    } catch (error) {
      if (error instanceof StructuredParseError) return rejected(format, error)
      throw error
    }

    if (bytes.byteLength === 0) {
      return rejected(format, new StructuredParseError('EMPTY_INPUT', 'the input is empty'))
    }
    if (bytes.byteLength > caps.maxFileBytes) {
      return rejected(
        format,
        new StructuredParseError(
          'FILE_TOO_LARGE',
          `the input is ${bytes.byteLength} bytes, above the ${caps.maxFileBytes}-byte file cap`,
        ),
      )
    }

    try {
      return toResult(format, dispatch(format, bytes, options, caps))
    } catch (error) {
      if (error instanceof StructuredParseError) return rejected(format, error)
      const message = error instanceof Error ? error.message : String(error)
      return rejected(format, new StructuredParseError('PARSE_FAILED', message, { cause: error }))
    }
  }
}
