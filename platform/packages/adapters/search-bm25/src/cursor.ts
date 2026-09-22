import type { RevisionString, Sha256Digest } from '@ontology/contracts'
import { DocumentSearchError } from './errors'

/**
 * Opaque pagination cursor (C3: "cursor"). It is not meant to be parsed by a
 * client, but the adapter encodes it as base64url JSON so a test can prove the
 * important property: the cursor pins the exact index generation of every
 * authorized collection, so paging through one result set is stable even if a
 * rebuild activates a newer generation in between.
 */
export interface SearchCursorCollection {
  readonly collectionRef: string
  readonly generation: RevisionString
}

export interface SearchCursor {
  readonly version: 1
  readonly queryDigest: Sha256Digest
  readonly collections: readonly SearchCursorCollection[]
  readonly offset: number
}

export function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function decodeCursor(value: string): SearchCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch (error) {
    throw new DocumentSearchError('INVALID_REQUEST', 'the cursor is not a valid opaque cursor', {
      cause: error,
    })
  }
  if (!isRecord(parsed)) {
    throw new DocumentSearchError('INVALID_REQUEST', 'the cursor is not a valid opaque cursor')
  }
  if (parsed.version !== 1 || typeof parsed.queryDigest !== 'string') {
    throw new DocumentSearchError('INVALID_REQUEST', 'the cursor version or digest is invalid')
  }
  if (!Number.isInteger(parsed.offset) || (parsed.offset as number) < 0) {
    throw new DocumentSearchError('INVALID_REQUEST', 'the cursor offset is invalid')
  }
  const rawCollections = parsed.collections
  if (!Array.isArray(rawCollections) || rawCollections.length === 0) {
    throw new DocumentSearchError('INVALID_REQUEST', 'the cursor does not name any collection')
  }
  const collections: SearchCursorCollection[] = rawCollections.map((entry) => {
    if (!isRecord(entry) || typeof entry.collectionRef !== 'string' || typeof entry.generation !== 'string') {
      throw new DocumentSearchError('INVALID_REQUEST', 'a cursor collection entry is invalid')
    }
    return { collectionRef: entry.collectionRef, generation: entry.generation }
  })
  return {
    version: 1,
    queryDigest: parsed.queryDigest,
    collections,
    offset: parsed.offset as number,
  }
}
