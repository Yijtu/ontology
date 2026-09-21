/**
 * A classified API failure. The server always answers C6 `{error, traceId}`; this type
 * keeps the code, status and retryability so the UI can render an explicit state instead
 * of a generic "something went wrong".
 */
export interface ApiFailure {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
  readonly reasons: readonly string[]
  readonly missingCapabilities: readonly unknown[]
  readonly traceId?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly reasons: readonly string[]
  readonly missingCapabilities: readonly unknown[]
  readonly traceId: string | undefined

  constructor(status: number, failure: ApiFailure) {
    super(failure.message)
    this.name = 'ApiError'
    this.status = status
    this.code = failure.code
    this.retryable = failure.retryable
    this.reasons = failure.reasons
    this.missingCapabilities = failure.missingCapabilities
    this.traceId = failure.traceId
  }

  get permissionDenied(): boolean {
    return this.status === 403
  }

  get conflict(): boolean {
    return this.status === 409
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Parse a failure envelope defensively. A malformed body must still surface as a failure:
 * the UI never treats a non-2xx response as success just because it could not be parsed.
 */
export function toApiFailure(status: number, body: unknown): ApiFailure {
  if (!isRecord(body)) {
    return {
      code: `HTTP_${status}`,
      message: `the server answered ${status} without a failure envelope`,
      retryable: false,
      reasons: [],
      missingCapabilities: [],
    }
  }
  const error = isRecord(body['error']) ? body['error'] : {}
  const code = typeof error['code'] === 'string' ? error['code'] : `HTTP_${status}`
  const message = typeof error['message'] === 'string' ? error['message'] : `the request failed with ${status}`
  const traceId = typeof body['traceId'] === 'string' ? body['traceId'] : undefined
  return {
    code,
    message,
    retryable: error['retryable'] === true,
    reasons: stringsOf(error['reasons']),
    missingCapabilities: Array.isArray(error['missingCapabilities']) ? error['missingCapabilities'] : [],
    ...(traceId === undefined ? {} : { traceId }),
  }
}
