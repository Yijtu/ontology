import type {
  CapBreachMode,
  CsvDelimiter,
  QuoteChar,
  ResourceRef,
  Semver,
  StructuredFormat,
  StructuredParseCaps,
  StructuredParseOptions,
  VersionRef,
} from '@ontology/contracts'
import { tryParseSemver } from '@ontology/contracts'
import { JobStageFailure } from './errors'

/**
 * The structured ingestion reference an ingestion job carries in its opaque `documentRef`
 * while it is at the `received` stage. It pins the immutable original, the parser version, the
 * published definition and the caller's explicit format selection (delimiter/quote/sheet/
 * header/range/cap mode). Every field is validated on decode, because the reference crosses
 * the wire and is never trusted as a type assertion.
 */
export interface StructuredIngestionRef {
  readonly kind: 'structured_ingestion'
  readonly originalRef: ResourceRef
  readonly parserVersion: Semver
  readonly definitionRef: VersionRef
  readonly format: StructuredFormat
  readonly options: StructuredSelectionOptions
  readonly documentVersionRef?: ResourceRef
}

/**
 * The reference the structured `received → parsed` stage writes back: the durable parse id the
 * downstream extraction stage (and a later project mapping) resolves. `kind` keeps a text/PDF
 * `ExtractionJobRef` from being confused with a structured parse.
 */
export interface StructuredExtractionRef {
  readonly kind: 'structured_extraction'
  readonly parseId: string
  readonly parserVersion: Semver
  readonly definitionRef: VersionRef
  readonly format: StructuredFormat
  readonly documentVersionRef?: ResourceRef
}

/** The explicit selection a caller can pin; the media type comes from the stored original. */
export type StructuredSelectionOptions = Omit<StructuredParseOptions, 'mediaType'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JobStageFailure(
      'INVALID_ARGUMENT',
      `structured ingestion reference field "${field}" must be a non-empty string`,
      false,
    )
  }
  return value
}

function requireVersionRef(value: unknown, field: string): VersionRef {
  if (!isRecord(value)) {
    throw new JobStageFailure('INVALID_ARGUMENT', `structured ingestion reference field "${field}" must be an object`, false)
  }
  return {
    id: requireString(value['id'], `${field}.id`),
    version: requireString(value['version'], `${field}.version`),
    digest: requireString(value['digest'], `${field}.digest`),
  }
}

function requireResourceRef(value: unknown, field: string): ResourceRef {
  if (!isRecord(value)) {
    throw new JobStageFailure('INVALID_ARGUMENT', `structured ingestion reference field "${field}" must be an object`, false)
  }
  const kind = requireString(value['kind'], `${field}.kind`)
  return {
    id: requireString(value['id'], `${field}.id`),
    version: requireString(value['version'], `${field}.version`),
    digest: requireString(value['digest'], `${field}.digest`),
    kind: kind as ResourceRef['kind'],
  }
}

function isStructuredFormat(value: unknown): value is StructuredFormat {
  return value === 'text' || value === 'json' || value === 'csv' || value === 'xlsx'
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new JobStageFailure('INVALID_ARGUMENT', `structured selection field "${field}" must be a positive integer`, false)
  }
  return value
}

function decodeCaps(value: unknown): Partial<StructuredParseCaps> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'structured selection field "caps" must be an object', false)
  }
  const cap = (field: keyof StructuredParseCaps): number | undefined => {
    const candidate = value[field]
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
      throw new JobStageFailure('INVALID_ARGUMENT', `structured caps field "${field}" must be a non-negative integer`, false)
    }
    return candidate
  }
  const maxFileBytes = cap('maxFileBytes')
  const maxExpandedBytes = cap('maxExpandedBytes')
  const maxZipEntries = cap('maxZipEntries')
  const maxRows = cap('maxRows')
  const maxColumns = cap('maxColumns')
  const maxCellBytes = cap('maxCellBytes')
  const maxDepth = cap('maxDepth')
  return {
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
    ...(maxExpandedBytes === undefined ? {} : { maxExpandedBytes }),
    ...(maxZipEntries === undefined ? {} : { maxZipEntries }),
    ...(maxRows === undefined ? {} : { maxRows }),
    ...(maxColumns === undefined ? {} : { maxColumns }),
    ...(maxCellBytes === undefined ? {} : { maxCellBytes }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
  }
}

function decodeDelimiter(value: unknown): CsvDelimiter | undefined {
  if (value === undefined) return undefined
  if (value === ',' || value === ';' || value === '\t' || value === '|') return value
  throw new JobStageFailure('INVALID_ARGUMENT', 'structured selection delimiter is not supported', false)
}

function decodeQuote(value: unknown): QuoteChar | undefined {
  if (value === undefined) return undefined
  if (value === '"' || value === "'") return value
  throw new JobStageFailure('INVALID_ARGUMENT', 'structured selection quote is not supported', false)
}

function decodeCapBreachMode(value: unknown): CapBreachMode | undefined {
  if (value === undefined) return undefined
  if (value === 'reject' || value === 'truncate') return value
  throw new JobStageFailure('INVALID_ARGUMENT', 'structured selection capBreachMode is not supported', false)
}

function decodeSelection(value: unknown): StructuredSelectionOptions {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'structured selection options must be an object', false)
  }
  const delimiter = decodeDelimiter(value['delimiter'])
  const quote = decodeQuote(value['quote'])
  const capBreachMode = decodeCapBreachMode(value['capBreachMode'])
  const headerRow = optionalPositiveInteger(value['headerRow'], 'headerRow')
  const dataStartRow = optionalPositiveInteger(value['dataStartRow'], 'dataStartRow')
  const sheetId = value['sheetId']
  if (sheetId !== undefined && typeof sheetId !== 'string') {
    throw new JobStageFailure('INVALID_ARGUMENT', 'structured selection sheetId must be a string', false)
  }
  const sheetName = value['sheetName']
  if (sheetName !== undefined && typeof sheetName !== 'string') {
    throw new JobStageFailure('INVALID_ARGUMENT', 'structured selection sheetName must be a string', false)
  }
  const encoding = value['encoding']
  if (encoding !== undefined && encoding !== 'utf-8') {
    throw new JobStageFailure('INVALID_ARGUMENT', 'structured selection encoding must be utf-8', false)
  }
  const caps = decodeCaps(value['caps'])
  return {
    ...(encoding === undefined ? {} : { encoding }),
    ...(delimiter === undefined ? {} : { delimiter }),
    ...(quote === undefined ? {} : { quote }),
    ...(headerRow === undefined ? {} : { headerRow }),
    ...(dataStartRow === undefined ? {} : { dataStartRow }),
    ...(sheetId === undefined ? {} : { sheetId }),
    ...(sheetName === undefined ? {} : { sheetName }),
    ...(capBreachMode === undefined ? {} : { capBreachMode }),
    ...(caps === undefined ? {} : { caps }),
  }
}

/** Encode the structured ingestion reference into the job's opaque `documentRef` string. */
export function encodeStructuredIngestionRef(ref: StructuredIngestionRef): string {
  return JSON.stringify(ref)
}

/** Encode the durable structured extraction reference the parsed stage writes. */
export function encodeStructuredExtractionRef(ref: StructuredExtractionRef): string {
  return JSON.stringify(ref)
}

/**
 * Cheap, total guard used by the worker dispatcher: it must never throw, so a malformed
 * reference falls through to the text handler that produces the classified decode failure.
 */
export function isStructuredIngestionRef(documentRef: string | undefined): boolean {
  if (documentRef === undefined) return false
  try {
    const parsed: unknown = JSON.parse(documentRef)
    return isRecord(parsed) && parsed['kind'] === 'structured_ingestion'
  } catch {
    return false
  }
}

/** Decode and validate the job's structured `documentRef` at the `received` stage. */
export function decodeStructuredIngestionRef(documentRef: string): StructuredIngestionRef {
  let parsed: unknown
  try {
    parsed = JSON.parse(documentRef)
  } catch (error) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'the structured ingestion reference is not valid JSON', false, {
      cause: error,
    })
  }
  if (!isRecord(parsed)) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'the structured ingestion reference must be a JSON object', false)
  }
  if (parsed['kind'] !== 'structured_ingestion') {
    throw new JobStageFailure('INVALID_ARGUMENT', 'the structured ingestion reference kind must be structured_ingestion', false)
  }
  const format = parsed['format']
  if (!isStructuredFormat(format)) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'structured ingestion format must be text, json, csv or xlsx', false)
  }
  const parserVersion = requireString(parsed['parserVersion'], 'parserVersion')
  if (tryParseSemver(parserVersion) === undefined) {
    throw new JobStageFailure('INVALID_ARGUMENT', 'structured ingestion parserVersion must be a semver string', false)
  }
  const documentVersionRef = parsed['documentVersionRef']
  return {
    kind: 'structured_ingestion',
    originalRef: requireResourceRef(parsed['originalRef'], 'originalRef'),
    parserVersion,
    definitionRef: requireVersionRef(parsed['definitionRef'], 'definitionRef'),
    format,
    options: decodeSelection(parsed['options']),
    ...(documentVersionRef === undefined
      ? {}
      : { documentVersionRef: requireResourceRef(documentVersionRef, 'documentVersionRef') }),
  }
}
