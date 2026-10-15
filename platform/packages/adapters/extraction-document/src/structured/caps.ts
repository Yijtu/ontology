import type { StructuredParseCaps } from '@ontology/contracts'
import { DEFAULT_STRUCTURED_PARSE_CAPS } from '@ontology/contracts'
import { StructuredParseError } from './errors'

export function resolveCaps(overrides: Partial<StructuredParseCaps> | undefined): StructuredParseCaps {
  const caps = { ...DEFAULT_STRUCTURED_PARSE_CAPS, ...overrides }
  for (const [name, value] of Object.entries(caps)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new StructuredParseError('PARSE_FAILED', `${name} must be a positive integer`)
    }
  }
  return caps
}

export function enforceCellBytes(byteLength: number, caps: StructuredParseCaps): void {
  if (byteLength > caps.maxCellBytes) {
    throw new StructuredParseError(
      'CELL_TOO_LARGE',
      `a cell value of ${byteLength} bytes exceeds the ${caps.maxCellBytes}-byte cell cap`,
    )
  }
}
