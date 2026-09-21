import Fastify from 'fastify'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { RunServiceError, parseCreateRunRequest } from '@ontology/application'
import type { RunService } from '@ontology/application'
import type { CreateRunResponse, Principal, RevisionString } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { failureBody } from './errors'
import { SSE_HEADERS, formatSseFrame } from './sse'

export interface AuthenticatedRequest {
  readonly principal: Principal
  readonly spaceId: string
}

export type RequestAuthenticator = (request: FastifyRequest) => AuthenticatedRequest | undefined

export interface RunApiOptions {
  readonly service: RunService
  /**
   * Establishes the trusted principal and the tenant/space scope. It must return `undefined`
   * for an unauthenticated request; the run surface never reads identity from the body.
   */
  readonly authenticate: RequestAuthenticator
  readonly logger?: boolean
}

const REVISION_PATTERN = /^(0|[1-9]\d*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readTraceId(request: FastifyRequest): string {
  const header = readHeader(request, 'x-trace-id')
  return header ?? request.id
}

function readIfMatch(request: FastifyRequest): RevisionString | undefined {
  const raw = readHeader(request, 'if-match')
  if (raw === undefined) return undefined
  const normalized = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '').trim()
  if (!REVISION_PATTERN.test(normalized)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'If-Match must be a decimal revision string')
  }
  return normalized
}

function resolveExpectedRevision(
  headerRevision: RevisionString | undefined,
  bodyRevision: unknown,
): RevisionString | undefined {
  if (headerRevision === undefined) return undefined
  if (typeof bodyRevision === 'string' && bodyRevision.length > 0 && bodyRevision !== headerRevision) {
    throw new RunServiceError(
      'INVALID_ARGUMENT',
      'the body expectedRevision does not match the If-Match header',
    )
  }
  return headerRevision
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RunServiceError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

function readLastEventId(request: FastifyRequest): RevisionString | undefined {
  const query = isRecord(request.query) ? request.query['lastEventId'] : undefined
  const raw = readHeader(request, 'last-event-id') ?? (typeof query === 'string' ? query : undefined)
  if (raw === undefined) return undefined
  const normalized = raw.trim()
  if (!REVISION_PATTERN.test(normalized)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'Last-Event-ID must be a decimal sequence')
  }
  return normalized
}

/**
 * The C6 HTTP surface for runs. It lives in `apps/api` (the apps layer may use an SDK); the
 * application layer never imports the framework. Each handler establishes the trusted
 * context from the server-side authentication result, then delegates to `RunService`.
 */
export function createRunApi(options: RunApiOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false })

  const authenticate = (
    request: FastifyRequest,
    reply: FastifyReply,
  ): AuthenticatedRequest | undefined => {
    const auth = options.authenticate(request)
    if (auth === undefined) {
      reply.status(401).send({
        error: { code: 'UNAUTHENTICATED', message: 'authentication is required', retryable: false },
        traceId: readTraceId(request),
      })
      return undefined
    }
    return auth
  }

  const contextFor = (auth: AuthenticatedRequest, traceId: string, runId: string, hash?: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId,
      ...(hash === undefined ? {} : { resolvedProfileHash: hash }),
    })

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const traceId = readTraceId(request)
    if (error instanceof RunServiceError) {
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

  app.post('/api/v1/runs', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticate(request, reply)
    if (auth === undefined) return reply
    const idempotencyKey = readHeader(request, 'idempotency-key')
    if (idempotencyKey === undefined) {
      throw new RunServiceError('INVALID_ARGUMENT', 'the Idempotency-Key header is required')
    }
    const fields = parseCreateRunRequest(request.body)
    const runId = globalThis.crypto.randomUUID()
    const result = await options.service.createRun(
      { runId, ...fields, idempotencyKey },
      contextFor(auth, traceId, runId),
    )
    const data: CreateRunResponse = {
      runId: result.runId,
      state: result.state,
      eventsUrl: `/api/v1/runs/${result.runId}/events`,
      resolvedProfileHash: result.resolvedProfileHash,
    }
    reply.status(202).send({ data, meta: { traceId, revision: result.revision } })
    return reply
  })

  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticate(request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const view = await options.service.getRun(runId, contextFor(auth, traceId, runId))
    reply.status(200).send({ data: view, meta: { traceId, revision: view.revision } })
    return reply
  })

  app.post<{ Params: { runId: string } }>(
    '/api/v1/runs/:runId/responses',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticate(request, reply)
      if (auth === undefined) return reply
      const runId = request.params.runId
      const body = request.body
      if (!isRecord(body)) {
        throw new RunServiceError('INVALID_ARGUMENT', 'the request body must be a JSON object')
      }
      const clarificationId = requireNonEmptyString(body['clarificationId'], 'clarificationId')
      const typedResponse = body['typedResponse']
      if (!isRecord(typedResponse)) {
        throw new RunServiceError('INVALID_ARGUMENT', 'typedResponse must be a JSON object')
      }
      const expectedRevision = resolveExpectedRevision(readIfMatch(request), body['expectedRevision'])
      const view = await options.service.respondToClarification(
        { runId, clarificationId, typedResponse, expectedRevision },
        contextFor(auth, traceId, runId),
      )
      reply.status(200).send({
        data: { runId: view.runId, state: 'continued', revision: view.revision },
        meta: { traceId, revision: view.revision },
      })
      return reply
    },
  )

  app.post<{ Params: { runId: string } }>('/api/v1/runs/:runId/cancel', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticate(request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const body = request.body
    if (!isRecord(body)) {
      throw new RunServiceError('INVALID_ARGUMENT', 'the request body must be a JSON object')
    }
    const reason = requireNonEmptyString(body['reason'], 'reason')
    const expectedRevision = resolveExpectedRevision(readIfMatch(request), body['expectedRevision'])
    const view = await options.service.cancelRun(
      { runId, reason, expectedRevision },
      contextFor(auth, traceId, runId),
    )
    reply.status(200).send({
      data: { runId: view.runId, state: view.state, revision: view.revision },
      meta: { traceId, revision: view.revision },
    })
    return reply
  })

  app.post<{ Params: { runId: string } }>('/api/v1/runs/:runId/resume', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticate(request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const body = request.body
    if (!isRecord(body)) {
      throw new RunServiceError('INVALID_ARGUMENT', 'the request body must be a JSON object')
    }
    const checkpointId = requireNonEmptyString(body['checkpointId'], 'checkpointId')
    const runtimeKind = requireNonEmptyString(body['runtimeKind'], 'runtimeKind')
    const runtimeVersion = requireNonEmptyString(body['runtimeVersion'], 'runtimeVersion')
    const stateDigest = requireNonEmptyString(body['stateDigest'], 'stateDigest')
    const expectedRevision = resolveExpectedRevision(readIfMatch(request), body['expectedRevision'])
    const view = await options.service.resumeRun(
      { runId, checkpointId, runtimeKind, runtimeVersion, stateDigest, expectedRevision },
      contextFor(auth, traceId, runId),
    )
    reply.status(200).send({
      data: { runId: view.runId, state: view.state, revision: view.revision },
      meta: { traceId, revision: view.revision },
    })
    return reply
  })

  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/events', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticate(request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const afterSequence = readLastEventId(request)
    const events = await options.service.listEvents(
      runId,
      afterSequence,
      contextFor(auth, traceId, runId),
    )
    reply.hijack()
    reply.raw.writeHead(200, SSE_HEADERS)
    for (const event of events) {
      reply.raw.write(formatSseFrame(event))
    }
    reply.raw.end()
    return reply
  })

  return app
}
