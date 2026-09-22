import { describe, expect, it } from 'vitest'
import { ERROR_CATALOG } from '@ontology/contracts'
import {
  DocumentSearchError,
  asStoreFailure,
  isConnectionFailure,
} from '@ontology/adapter-search-bm25'

interface DriverError extends Error {
  code: string
  errno?: number
  syscall?: string
  severity?: string
}

/** A Node system error as the driver surfaces it: a string `code` plus `errno`/`syscall`. */
function systemError(code: string): DriverError {
  const error = new Error(`connect ${code}`) as DriverError
  error.code = code
  error.errno = -1
  error.syscall = 'connect'
  return error
}

/** A PostgreSQL backend error: a five-character SQLSTATE in `code`. */
function sqlStateError(code: string, message = `database error ${code}`): DriverError {
  const error = new Error(message) as DriverError
  error.code = code
  error.severity = 'FATAL'
  return error
}

const CONNECTION_SYSTEM_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
] as const

const CONNECTION_SQLSTATES = [
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
  '53300',
] as const

describe('isConnectionFailure: connection-class detection', () => {
  it.each(CONNECTION_SYSTEM_CODES)('treats the system error %s as a connection failure', (code) => {
    expect(isConnectionFailure(systemError(code))).toBe(true)
  })

  it.each(CONNECTION_SQLSTATES)('treats the SQLSTATE %s as a connection failure', (code) => {
    expect(isConnectionFailure(sqlStateError(code))).toBe(true)
  })

  it('treats pool exhaustion as a connection failure', () => {
    expect(isConnectionFailure(new Error('timeout exceeded when trying to connect'))).toBe(true)
  })

  it('treats an unexpectedly terminated connection as a connection failure', () => {
    expect(isConnectionFailure(new Error('Connection terminated unexpectedly'))).toBe(true)
  })

  it('follows the cause of a wrapper that carries no code of its own', () => {
    const wrapper = new Error('Connection terminated due to connection timeout', {
      cause: systemError('ECONNREFUSED'),
    })
    expect(isConnectionFailure(wrapper)).toBe(true)
  })

  it('does not classify a non-connection SQLSTATE as a connection failure', () => {
    // 23505 unique_violation and 22P02 invalid_text_representation are real internal
    // faults, not transient availability problems.
    expect(isConnectionFailure(sqlStateError('23505'))).toBe(false)
    expect(isConnectionFailure(sqlStateError('22P02'))).toBe(false)
  })

  it('does not classify an arbitrary error as a connection failure', () => {
    expect(isConnectionFailure(new Error('malformed stored row'))).toBe(false)
    expect(isConnectionFailure(undefined)).toBe(false)
    expect(isConnectionFailure('ECONNREFUSED')).toBe(false)
  })

  it('prefers the structured code over the message text', () => {
    // A non-connection backend error must never be misread just because its text
    // mentions a connection.
    expect(isConnectionFailure(sqlStateError('23505', 'Connection terminated unexpectedly'))).toBe(
      false,
    )
  })
})

describe('asStoreFailure: canonical mapping', () => {
  it('maps a refused connection to the retryable SOURCE_UNAVAILABLE and keeps the cause', () => {
    const original = systemError('ECONNREFUSED')
    const mapped = asStoreFailure(original)
    expect(mapped).toBeInstanceOf(DocumentSearchError)
    expect(mapped).toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    })
    expect(mapped?.cause).toBe(original)
  })

  it.each(CONNECTION_SQLSTATES)('maps SQLSTATE %s to SOURCE_UNAVAILABLE', (code) => {
    expect(asStoreFailure(sqlStateError(code))).toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      httpStatus: 503,
    })
  })

  it('reports the catalogue semantics the acceptance criteria require', () => {
    expect(ERROR_CATALOG.SOURCE_UNAVAILABLE.httpStatus).toBe(503)
    expect(ERROR_CATALOG.SOURCE_UNAVAILABLE.retryable).toBe('limited')
  })

  it('never repeats a credential or connection string in the message', () => {
    const mapped = asStoreFailure(
      systemError('ECONNREFUSED'),
    )
    expect(mapped?.message).not.toContain('postgresql://')
    expect(mapped?.message).not.toContain('password')
  })

  it('leaves a non-connection failure unclassified so the caller rethrows it unchanged', () => {
    const internal = sqlStateError('23505')
    expect(asStoreFailure(internal)).toBeUndefined()
    expect(asStoreFailure(new Error('malformed stored row'))).toBeUndefined()
  })

  it('leaves an already-canonical DocumentSearchError untouched', () => {
    for (const code of ['INDEX_NOT_FOUND', 'SNAPSHOT_UNAVAILABLE', 'SOURCE_UNAVAILABLE'] as const) {
      const classified = new DocumentSearchError(code, 'already classified')
      expect(asStoreFailure(classified)).toBeUndefined()
    }
  })
})
