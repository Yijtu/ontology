import type { StructuredParseIssueCode, StructuredParseResult } from '@ontology/contracts'

/**
 * A hard parse failure. It is never swallowed into an empty table: `parse`
 * converts it into an explicit `rejected` result with the same code.
 */
export class StructuredParseError extends Error {
  readonly code: StructuredParseIssueCode
  readonly row?: number
  readonly sheetName?: string
  readonly pointer?: string

  constructor(
    code: StructuredParseIssueCode,
    message: string,
    context?: { row?: number; sheetName?: string; pointer?: string; cause?: unknown },
  ) {
    super(message, context?.cause === undefined ? undefined : { cause: context.cause })
    this.name = 'StructuredParseError'
    this.code = code
    if (context?.row !== undefined) this.row = context.row
    if (context?.sheetName !== undefined) this.sheetName = context.sheetName
    if (context?.pointer !== undefined) this.pointer = context.pointer
  }
}

export function rejected(
  format: StructuredParseResult['format'],
  error: StructuredParseError,
  notes: readonly string[] = [],
): StructuredParseResult {
  return {
    format,
    status: 'rejected',
    coverage: {
      status: 'failed',
      completeness: 'unknown',
      totalUnits: 0,
      parsedUnits: 0,
      skippedUnits: 0,
      skippedReasons: [error.code],
      notes,
    },
    tables: [],
    records: [],
    sheets: [],
    diagnostics: [
      {
        code: error.code,
        severity: 'error',
        message: error.message,
        ...(error.row === undefined ? {} : { row: error.row }),
        ...(error.sheetName === undefined ? {} : { sheetName: error.sheetName }),
        ...(error.pointer === undefined ? {} : { pointer: error.pointer }),
      },
    ],
  }
}
