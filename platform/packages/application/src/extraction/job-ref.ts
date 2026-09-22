import type { ResourceRef, VersionRef } from '@ontology/contracts'
import { ExtractionError } from './errors'
import type { ExtractionJobRef } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExtractionError('INVALID_JOB_REF', `extraction job reference field "${field}" must be a non-empty string`)
  }
  return value
}

function decodeVersionRef(value: unknown, field: string): VersionRef {
  if (!isRecord(value)) {
    throw new ExtractionError('INVALID_JOB_REF', `extraction job reference field "${field}" must be an object`)
  }
  return {
    id: requireString(value['id'], `${field}.id`),
    version: requireString(value['version'], `${field}.version`),
    digest: requireString(value['digest'], `${field}.digest`),
  }
}

function decodeResourceRef(value: unknown, field: string): ResourceRef {
  if (!isRecord(value)) {
    throw new ExtractionError('INVALID_JOB_REF', `extraction job reference field "${field}" must be an object`)
  }
  const kind = requireString(value['kind'], `${field}.kind`)
  return {
    id: requireString(value['id'], `${field}.id`),
    version: requireString(value['version'], `${field}.version`),
    digest: requireString(value['digest'], `${field}.digest`),
    kind: kind as ResourceRef['kind'],
  }
}

function decodeTruncatedIds(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new ExtractionError('INVALID_JOB_REF', 'truncatedChunkIds must be an array of chunk ids')
  }
  return value as string[]
}

/** Encode the pipeline's structured reference into the job's opaque `documentRef` string. */
export function encodeExtractionJobRef(ref: ExtractionJobRef): string {
  return JSON.stringify(ref)
}

/**
 * Decode and validate the job's `documentRef`. Every field is checked explicitly, so a
 * malformed reference fails the stage instead of producing an empty extraction.
 */
export function decodeExtractionJobRef(documentRef: string): ExtractionJobRef {
  let parsed: unknown
  try {
    parsed = JSON.parse(documentRef)
  } catch (error) {
    throw new ExtractionError('INVALID_JOB_REF', 'the extraction job reference is not valid JSON', {
      cause: error,
    })
  }
  if (!isRecord(parsed)) {
    throw new ExtractionError('INVALID_JOB_REF', 'the extraction job reference must be a JSON object')
  }
  const documentVersionRef = parsed['documentVersionRef']
  const truncatedChunkIds = decodeTruncatedIds(parsed['truncatedChunkIds'])
  return {
    parseId: requireString(parsed['parseId'], 'parseId'),
    parserVersion: requireString(parsed['parserVersion'], 'parserVersion'),
    definitionRef: decodeVersionRef(parsed['definitionRef'], 'definitionRef'),
    ...(documentVersionRef === undefined
      ? {}
      : { documentVersionRef: decodeResourceRef(documentVersionRef, 'documentVersionRef') }),
    ...(truncatedChunkIds === undefined ? {} : { truncatedChunkIds }),
  }
}
