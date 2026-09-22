import { ProvenanceReadError } from './errors'

/**
 * Opaque, deterministic cursors for the bounded read surfaces.
 *
 * The payload is a canonical JSON object encoded as base64url. It is opaque to the caller (C6
 * `OpaqueCursor`) but stable across requests, so paging a historical read never silently skips
 * or repeats a record. A cursor that cannot be decoded is a typed `INVALID_CURSOR`, never a
 * silent reset to the first page.
 */
export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): unknown {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
    return JSON.parse(decoded) as unknown
  } catch (error) {
    throw new ProvenanceReadError('INVALID_CURSOR', 'the cursor could not be decoded', {
      cause: error,
    })
  }
}
