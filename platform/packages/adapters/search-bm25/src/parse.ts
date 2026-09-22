import type { DocumentSearchRequest, SearchFilters, SourceRef } from '@ontology/contracts'
import { DocumentSearchError } from './errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DocumentSearchError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new DocumentSearchError('INVALID_ARGUMENT', `${field} must be an array`)
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${field}[${String(index)}]`))
}

function parseSourceRefs(value: unknown): SourceRef[] {
  if (!Array.isArray(value)) {
    throw new DocumentSearchError('INVALID_ARGUMENT', 'filters.sourceRefs must be an array')
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new DocumentSearchError('INVALID_ARGUMENT', `filters.sourceRefs[${String(index)}] is invalid`)
    }
    return {
      namespace: requireNonEmptyString(entry.namespace, `filters.sourceRefs[${String(index)}].namespace`),
      sourceId: requireNonEmptyString(entry.sourceId, `filters.sourceRefs[${String(index)}].sourceId`),
    }
  })
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return requireNonEmptyString(value, field)
}

function parseFilters(value: unknown): SearchFilters {
  if (!isRecord(value)) {
    throw new DocumentSearchError('INVALID_ARGUMENT', 'filters must be an object')
  }
  const sourceRefs = value.sourceRefs === undefined ? undefined : parseSourceRefs(value.sourceRefs)
  const languages = value.languages === undefined ? undefined : stringArray(value.languages, 'filters.languages')
  const mediaTypes =
    value.mediaTypes === undefined ? undefined : stringArray(value.mediaTypes, 'filters.mediaTypes')
  const recordedAfter = optionalTimestamp(value.recordedAfter, 'filters.recordedAfter')
  const recordedBefore = optionalTimestamp(value.recordedBefore, 'filters.recordedBefore')
  const validAt = optionalTimestamp(value.validAt, 'filters.validAt')
  return {
    ...(sourceRefs === undefined ? {} : { sourceRefs }),
    ...(recordedAfter === undefined ? {} : { recordedAfter }),
    ...(recordedBefore === undefined ? {} : { recordedBefore }),
    ...(validAt === undefined ? {} : { validAt }),
    ...(languages === undefined ? {} : { languages }),
    ...(mediaTypes === undefined ? {} : { mediaTypes }),
  }
}

/**
 * Validate the untrusted `document_search` tool arguments and narrow them to a
 * typed `DocumentSearchRequest`. The gateway already validated the JSON Schema;
 * this parser is the adapter's own boundary check so the handler never trusts a
 * value it has not inspected, and it never fills in a guessed default.
 */
export function parseDocumentSearchRequest(value: unknown): DocumentSearchRequest {
  if (!isRecord(value)) {
    throw new DocumentSearchError('INVALID_ARGUMENT', 'document_search arguments must be a JSON object')
  }
  const query = requireNonEmptyString(value.query, 'query')
  const allowedCollectionRefs = stringArray(value.allowedCollectionRefs, 'allowedCollectionRefs')
  if (allowedCollectionRefs.length === 0) {
    throw new DocumentSearchError('INVALID_ARGUMENT', 'allowedCollectionRefs must not be empty')
  }
  const mode = value.mode
  if (mode !== 'keyword' && mode !== 'vector' && mode !== 'hybrid') {
    throw new DocumentSearchError('INVALID_ARGUMENT', 'mode must be keyword, vector or hybrid')
  }
  const filters = value.filters === undefined ? undefined : parseFilters(value.filters)
  let cursor: string | undefined
  if (value.cursor !== undefined) {
    cursor = requireNonEmptyString(value.cursor, 'cursor')
  }
  let limit: number | undefined
  if (value.limit !== undefined) {
    if (
      typeof value.limit !== 'number' ||
      !Number.isInteger(value.limit) ||
      value.limit < 1 ||
      value.limit > 1000
    ) {
      throw new DocumentSearchError('INVALID_ARGUMENT', 'limit must be an integer between 1 and 1000')
    }
    limit = value.limit
  }
  return {
    query,
    allowedCollectionRefs,
    mode,
    ...(filters === undefined ? {} : { filters }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  }
}
