import type { FastifyInstance, FastifyRequest } from 'fastify'
import { RunServiceError, parseCreateRunRequest } from '@ontology/application'
import type { RunService } from '@ontology/application'
import type { CreateRunResponse, RevisionString } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { formatSseFrame, SSE_HEADERS } from './sse'
import {
  authenticateRequest,
  isRecord,
  readHeader,
  readRevisionHeader,
  readTraceId,
  requireNonEmptyString,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

export type { AuthenticatedRequest, RequestAuthenticator } from './shared'

export interface RunApiOptions {
  readonly service: RunService
  /**
   * Establishes the trusted principal and the tenant/space scope. It must return `undefined`
   * for an unauthenticated request; the run surface never reads identity from the body.
   */
  readonly authenticate: RequestAuthenticator
  readonly logger?: boolean
}

export interface RunRouteDependencies {
  readonly service: RunService
  readonly authenticate: RequestAuthenticator
}

function readIfMatch(request: FastifyRequest): RevisionString | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new RunServiceError('INVALID_ARGUMENT', 'If-Match must be a decimal revision string')
  }
  return header.value
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

function readLastEventId(request: FastifyRequest): RevisionString | undefined {
  const query = isRecord(request.query) ? request.query['lastEventId'] : undefined
  const raw = readHeader(request, 'last-event-id') ?? (typeof query === 'string' ? query : undefined)
  if (raw === undefined) return undefined
  const normalized = raw.trim()
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new RunServiceError('INVALID_ARGUMENT', 'Last-Event-ID must be a decimal sequence')
  }
  return normalized
}

/**
 * The C6 HTTP surface for runs. It lives in `apps/api` (the apps layer may use an SDK); the
 * application layer never imports the framework. Each handler establishes the trusted
 * context from the server-side authentication result, then delegates to `RunService`.
 *
 * The routes are registered onto a caller-supplied Fastify instance so the workbench
 * surface shares one server, one envelope and one error boundary (see `createApiServer`).
 */
export function registerRunRoutes(app: FastifyInstance, dependencies: RunRouteDependencies): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, runId: string, hash?: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId,
      ...(hash === undefined ? {} : { resolvedProfileHash: hash }),
    })

  app.post('/api/v1/runs', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const idempotencyKey = readHeader(request, 'idempotency-key')
    if (idempotencyKey === undefined) {
      throw new RunServiceError('INVALID_ARGUMENT', 'the Idempotency-Key header is required')
    }
    const fields = parseCreateRunRequest(request.body)
    const runId = globalThis.crypto.randomUUID()
    const result = await dependencies.service.createRun(
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
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const view = await dependencies.service.getRun(runId, contextFor(auth, traceId, runId))
    reply.status(200).send({ data: view, meta: { traceId, revision: view.revision } })
    return reply
  })

  app.post<{ Params: { runId: string } }>(
    '/api/v1/runs/:runId/responses',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
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
      const view = await dependencies.service.respondToClarification(
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
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const body = request.body
    if (!isRecord(body)) {
      throw new RunServiceError('INVALID_ARGUMENT', 'the request body must be a JSON object')
    }
    const reason = requireNonEmptyString(body['reason'], 'reason')
    const expectedRevision = resolveExpectedRevision(readIfMatch(request), body['expectedRevision'])
    const view = await dependencies.service.cancelRun(
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
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
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
    const view = await dependencies.service.resumeRun(
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
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const afterSequence = readLastEventId(request)
    const events = await dependencies.service.listEvents(
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
}
