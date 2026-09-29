import type {
  StructuredParseIssue,
  StructuredRecord,
  StructuredSheetInfo,
  StructuredTable,
} from '@ontology/contracts'

/**
 * What a single-format parser returns before the dispatcher builds the public
 * result. Coverage counters are always populated so `complete` is never claimed
 * when a unit was skipped.
 */
export interface FormatParseResult {
  readonly tables: readonly StructuredTable[]
  readonly records: readonly StructuredRecord[]
  readonly sheets: readonly StructuredSheetInfo[]
  readonly diagnostics: readonly StructuredParseIssue[]
  readonly status: 'complete' | 'incomplete'
  readonly totalUnits: number
  readonly parsedUnits: number
  readonly skippedUnits: number
  readonly skippedReasons: readonly string[]
  readonly notes: readonly string[]
}

/** A1 column label for a 1-based column number (1 -> A, 27 -> AA). */
export function columnLabel(column: number): string {
  let remaining = column
  let label = ''
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    remaining = Math.floor((remaining - 1) / 26)
  }
  return label
}
