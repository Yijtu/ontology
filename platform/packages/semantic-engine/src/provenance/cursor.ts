import { HistoryReadError } from './errors'

/**
 * Opaque, deterministic page cursor for the historical read (C6 `OpaqueCursor`).
 *
 * The payload is canonical JSON encoded as base64url. A cursor that cannot be decoded is a
 * typed `INVALID_CURSOR`, never a silent reset to the first page.
 */
export function encodeCursor(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown
  } catch (error) {
    throw new HistoryReadError('INVALID_CURSOR', 'the cursor could not be decoded', { cause: error })
  }
}
