import { beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import { ERROR_CATALOG, ERROR_CODES, type ErrorCode } from '@ontology/contracts'
import { createAjv, expectInvalid, expectValid, readSchemaData, validator } from './helpers'

const RUN = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const ATTEMPT = '8f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const TS = '2026-09-21T00:00:00Z'
const DIGEST = `sha256:${'a'.repeat(64)}`

let ajv: Ajv2020
const v = (defName: string): ValidateFunction => validator(ajv, 'errors.schema.json', defName)
const http = (defName: string): ValidateFunction => validator(ajv, 'http.schema.json', defName)
const data = (defName: string): ValidateFunction => validator(ajv, 'data.schema.json', defName)

beforeAll(() => {
  ajv = createAjv()
})

describe('the C6.2 error catalogue', () => {
  it('is complete and self-consistent', () => {
    const validate = v('ErrorCatalog')
    const canonical = readSchemaData('error-catalog.json').catalog
    expectValid(validate, canonical, 'canonical error catalogue')

    // The catalogue grew by INDEX_NOT_FOUND for the document_search index state
    // (LOCAL-063); every code still has exactly one descriptor.
    expect(ERROR_CODES).toHaveLength(25)
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(ERROR_CATALOG).sort())
    for (const [code, descriptor] of Object.entries(ERROR_CATALOG)) {
      expect(descriptor.code, `descriptor code for ${code}`).toBe(code)
      expect(descriptor.httpStatus).toBeGreaterThanOrEqual(400)
      expect(descriptor.behavior.length).toBeGreaterThan(0)
    }
  })

  it('matches the canonical error-catalog.json data file', () => {
    const canonical = readSchemaData('error-catalog.json').catalog as Record<string, unknown>
    expect(ERROR_CATALOG).toEqual(canonical)
  })

  it('rejects an unknown code and an incomplete catalogue', () => {
    const validate = v('ErrorCatalog')
    expectInvalid(
      validate,
      { ...(readSchemaData('error-catalog.json').catalog as Record<string, unknown>), TEAPOT: {} },
      'unknown code',
    )
    const incomplete = { ...(readSchemaData('error-catalog.json').catalog as Record<string, unknown>) }
    delete incomplete.RATE_LIMITED
    expectInvalid(validate, incomplete, 'catalogue missing a required code')
  })

  it('encodes the retryability table, not just the codes', () => {
    expect(ERROR_CATALOG.SOURCE_UNAVAILABLE).toMatchObject({
      httpStatus: 503,
      retryable: 'limited',
      maxRetries: 2,
    })
    expect(ERROR_CATALOG.RATE_LIMITED).toMatchObject({
      httpStatus: 429,
      retryable: 'limited',
      respectsRetryAfter: true,
    })
    expect(ERROR_CATALOG.DEADLINE_EXCEEDED).toMatchObject({
      httpStatus: 504,
      retryable: 'depends_on_effect',
      recordsRemoteStateUnknown: true,
    })
    expect(ERROR_CATALOG.INTERNAL_ERROR.retryable).toBe('depends_on_idempotency')
    expect(ERROR_CATALOG.EVIDENCE_PERSIST_FAILED.retryable).toBe('depends_on_idempotency')
    expect(ERROR_CATALOG.VERSION_CONFLICT).toMatchObject({ httpStatus: 409, retryable: 'never' })
    expect(ERROR_CATALOG.VERIFICATION_FAILED.retryable).toBe('within_repair_budget')
    expect(ERROR_CATALOG.RESULT_TOO_LARGE).toMatchObject({ httpStatus: 413, retryable: 'not_mechanical' })
    // A missing index is a state conflict, not a transient failure, so it is never
    // mechanically retried — unlike the store failure mapped onto SOURCE_UNAVAILABLE.
    expect(ERROR_CATALOG.INDEX_NOT_FOUND).toMatchObject({ httpStatus: 409, retryable: 'never' })
    expect(ERROR_CATALOG.SOURCE_UNAVAILABLE).toMatchObject({ httpStatus: 503, retryable: 'limited' })
  })

  it('keeps every code in the ErrorCode union', () => {
    const codes: readonly ErrorCode[] = ERROR_CODES
    expect(codes).toContain('INVALID_SCHEMA')
    expect(codes).toContain('UNSUPPORTED_QUERY')
    expect(codes).toContain('INDEX_NOT_FOUND')
    expect(codes).not.toContain('CANCELLED' as ErrorCode)
  })
})

describe('error envelopes', () => {
  it('accepts a failure envelope and rejects leaked secrets', () => {
    const validate = v('FailureEnvelope')
    const failure = {
      error: {
        code: 'RESULT_TOO_LARGE',
        message: 'result exceeded the declared byte limit',
        retryable: false,
        traceId: 'trace-0001',
        fieldErrors: [{ pointer: '/kind', reason: 'unsupported for this source' }],
      },
      traceId: 'trace-0001',
    }
    expectValid(validate, failure, 'failure envelope')
    expectInvalid(
      validate,
      { ...failure, error: { ...failure.error, secretValue: 'sk-live-123' } },
      'secret in error payload',
    )
    expectInvalid(
      validate,
      { error: { ...failure.error, code: 'NOPE' }, traceId: 'trace-0001' },
      'unknown error code',
    )
  })

  it('requires a trace id on both success and failure envelopes', () => {
    const failure = v('FailureEnvelope')
    expectInvalid(failure, { error: { code: 'INTERNAL_ERROR', message: 'x', retryable: false } }, 'missing trace id')

    const success = http('SuccessEnvelope')
    expectValid(success, { data: { runId: RUN }, meta: { traceId: 'trace-0001' } }, 'success envelope')
    expectInvalid(success, { data: { runId: RUN }, meta: {} }, 'missing trace id in meta')
  })

  it('uses a decimal string for large revisions', () => {
    const validate = http('SuccessEnvelope')
    expectValid(
      validate,
      { data: {}, meta: { traceId: 'trace-0001', revision: '9007199254740993' } },
      'revision as a decimal string',
    )
    expectInvalid(
      validate,
      { data: {}, meta: { traceId: 'trace-0001', revision: 9007199254740993 } },
      'revision as a JSON number',
    )
  })
})

describe('cancellation and abandoned late results', () => {
  it('records a best-effort cancellation with quarantined late attempts', () => {
    const validate = v('CancellationRecord')
    const record = {
      runId: RUN,
      state: 'cancelled',
      reason: 'user requested',
      requestedAt: TS,
      requestedBy: 'user:42',
      settledAt: TS,
      abandonedAttempts: [
        {
          attemptId: ATTEMPT,
          callId: RUN,
          toolId: 'web_search',
          abandonedAt: TS,
          lateResultPolicy: 'quarantined',
          reason: 'remote backend does not support cancel',
        },
      ],
    }
    expectValid(validate, record, 'cancellation record')
    expectInvalid(validate, { ...record, state: 'aborted' }, 'unknown cancellation state')
    expectInvalid(
      validate,
      {
        ...record,
        abandonedAttempts: [{ ...record.abandonedAttempts[0], lateResultPolicy: 'published' }],
      },
      'a late result cannot be published',
    )
  })

  it('marks attempts as settled or abandoned and supports usage_unknown', () => {
    const validate = v('ToolAttemptRecord')
    const base = {
      attemptId: ATTEMPT,
      callId: RUN,
      toolId: 'data_query',
      state: 'abandoned',
      disposition: 'abandoned',
      reservedAt: TS,
      resultDigest: DIGEST,
    }
    expectValid(validate, base, 'abandoned attempt')
    expectValid(validate, { ...base, state: 'usage_unknown' }, 'usage_unknown attempt')
    expectInvalid(validate, { ...base, disposition: 'forgotten' }, 'unknown disposition')
    expectInvalid(validate, { ...base, state: 'cancelled' }, 'unknown attempt state')
  })

  it('reports cancel support honestly instead of claiming the remote stopped', () => {
    const validate = data('CancelResponse')
    for (const state of ['cancelling', 'cancelled', 'unsupported', 'already_terminal']) {
      expectValid(validate, { targetRef: RUN, state, acceptedAt: TS }, `cancel state ${state}`)
    }
    expectInvalid(validate, { targetRef: RUN, state: 'terminated', acceptedAt: TS }, 'overclaimed state')
  })
})
