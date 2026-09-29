import type {
  BooleanCell,
  DateCell,
  EmptyCell,
  ErrorCell,
  FormulaCell,
  NumberCell,
  SourceLocator,
  StructuredCell,
  StructuredParseCaps,
  TextCell,
} from '@ontology/contracts'
import { canonicalDecimal } from './bytes'
import { enforceCellBytes } from './caps'

export function emptyCell(locator: SourceLocator): EmptyCell {
  return { kind: 'empty', raw: '', locator }
}

export function textCell(raw: string, locator: SourceLocator): TextCell {
  return { kind: 'text', raw, locator }
}

export function numberCell(raw: string, locator: SourceLocator): NumberCell {
  const decimal = canonicalDecimal(raw)
  return decimal === undefined
    ? { kind: 'number', raw, locator }
    : { kind: 'number', raw, decimal, locator }
}

export function booleanCell(value: boolean, raw: string, locator: SourceLocator): BooleanCell {
  return { kind: 'boolean', value, raw, locator }
}

export function dateCell(raw: string, locator: SourceLocator): DateCell {
  return { kind: 'date', raw, locator }
}

export function errorCell(raw: string, locator: SourceLocator): ErrorCell {
  return { kind: 'error', raw, locator }
}

export function formulaCell(
  formula: string,
  cachedRaw: string | undefined,
  locator: SourceLocator,
): FormulaCell {
  const cachedKind =
    cachedRaw === undefined || cachedRaw.length === 0
      ? undefined
      : ((): FormulaCell['cachedKind'] => {
          if (cachedRaw === 'TRUE' || cachedRaw === 'FALSE') return 'boolean'
          if (canonicalDecimal(cachedRaw) !== undefined) return 'number'
          return 'text'
        })()
  const decimal = cachedRaw === undefined ? undefined : canonicalDecimal(cachedRaw)
  return {
    kind: 'formula',
    raw: cachedRaw ?? '',
    formula,
    ...(cachedRaw === undefined ? {} : { cachedRaw }),
    ...(cachedKind === undefined ? {} : { cachedKind }),
    ...(decimal === undefined ? {} : { decimal }),
    locator,
  }
}

const NUMERIC_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

/**
 * Lexical classification for CSV (which has no declared cell types). A numeric
 * token is marked `number` with its raw lexical value preserved; `decimal` is
 * only attached when the token is already canonical, so exactness survives and
 * no column mapping is guessed.
 */
export function classifyLexicalCell(
  raw: string,
  locator: SourceLocator,
  caps: StructuredParseCaps,
): StructuredCell {
  if (raw.length === 0) return emptyCell(locator)
  enforceCellBytes(new TextEncoder().encode(raw).byteLength, caps)
  if (NUMERIC_TOKEN.test(raw)) return numberCell(raw, locator)
  if (raw === 'true' || raw === 'TRUE') return booleanCell(true, raw, locator)
  if (raw === 'false' || raw === 'FALSE') return booleanCell(false, raw, locator)
  return textCell(raw, locator)
}
