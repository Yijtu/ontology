import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Principal, RevisionString, ScopeRef } from '@ontology/contracts'
import { failureBody, isClassifiedError } from './errors'

/**
 * The trusted identity one HTTP request is attributed to. It is produced by the
 * server-side authenticator and never read from the request body (INV-07, SPEC §3).
 */
export interface AuthenticatedRequest {
  readonly principal: Principal
  readonly spaceId: string
}

export type RequestAuthenticator = (request: FastifyRequest) => AuthenticatedRequest | undefined

const REVISION_PATTERN = /^(0|[1-9]\d*)$/

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readHeader(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function readTraceId(request: FastifyRequest): string {
  return readHeader(request, 'x-trace-id') ?? request.id
}

export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty string`)
  }
  return value
}

/**
 * A route-level validation failure. It is classified so `installErrorHandler` renders the
 * C6 envelope; the concrete services keep their own richer codes for domain failures.
 */
export class InvalidRequestFieldError extends Error {
  readonly code = 'INVALID_ARGUMENT'
  readonly httpStatus = 400

  constructor(message: string) {
    super(message)
    this.name = 'InvalidRequestFieldError'
  }
}

/**
 * A route-level authorisation failure. Read-only projections (for example the component
 * list) have no service method that performs the role check, so the route enforces it and
 * renders the same C6 403 shape as the services.
 */
export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN'
  readonly httpStatus = 403

  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export type RevisionHeader =
  | { readonly kind: 'absent' }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'revision'; readonly value: RevisionString }
  | { readonly kind: 'invalid'; readonly raw: string }

/**
 * Parse an `If-Match` header without deciding what an invalid value means. `*` is the
 * HTTP "any current representation" wildcard, which the profile surface reads as "no
 * active profile is expected yet" (first activation); a route that cannot express that
 * treats it as invalid.
 */
export function readRevisionHeader(request: FastifyRequest): RevisionHeader {
  const raw = readHeader(request, 'if-match')
  if (raw === undefined) return { kind: 'absent' }
  const trimmed = raw.trim()
  if (trimmed === '*') return { kind: 'wildcard' }
  const normalized = trimmed.replace(/^W\//, '').replace(/^"|"$/g, '').trim()
  if (!REVISION_PATTERN.test(normalized)) return { kind: 'invalid', raw }
  return { kind: 'revision', value: normalized }
}

/** The tenant/space scope is derived from the trusted principal, never from the body. */
export function scopeRefFor(auth: AuthenticatedRequest): ScopeRef {
  return { tenantId: auth.principal.tenantId, spaceId: auth.spaceId }
}

/**
 * Resolve the trusted principal or answer 401. Returning `undefined` means the caller
 * must stop handling the request (`reply` has already been sent).
 */
export function authenticateRequest(
  authenticate: RequestAuthenticator,
  request: FastifyRequest,
  reply: FastifyReply,
): AuthenticatedRequest | undefined {
  const auth = authenticate(request)
  if (auth === undefined) {
    reply.status(401).send({
      error: { code: 'UNAUTHENTICATED', message: 'authentication is required', retryable: false },
      traceId: readTraceId(request),
    })
    return undefined
  }
  return auth
}

/**
 * The single C6 error boundary for every route group on the server. A classified service
 * error keeps its own code/status; anything else becomes a 500 that never echoes an
 * internal message. This is what makes "a failure is never an empty success" hold at the
 * HTTP edge.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const traceId = readTraceId(request)
    if (isClassifiedError(error)) {
      reply.status(error.httpStatus).send(failureBody(error, traceId))
      return
    }
    const statusCode = error.statusCode ?? 500
    if (statusCode >= 500) {
      reply.status(statusCode).send({
        error: { code: 'INTERNAL_ERROR', message: 'the request could not be completed', retryable: false },
        traceId,
      })
      return
    }
    reply.status(statusCode).send({
      error: { code: 'INVALID_ARGUMENT', message: error.message, retryable: false },
      traceId,
    })
  })
}
