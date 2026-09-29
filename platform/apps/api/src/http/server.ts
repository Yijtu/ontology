import type { FastifyInstance, FastifyRequest } from 'fastify'
import { RunServiceError, parseCreateRunRequest } from '@ontology/application'
import type { RunService } from '@ontology/application'
import type { CreateRunContext, CreateRunResponse, ProfileRef, RevisionString, ScopeRef, ToolContext } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { formatSseFrame, SSE_HEADERS } from './sse'
import type { RunProgressReader } from './run-progress'
import {
  authenticateRequest,
  CapabilityNotConfiguredError,
  isRecord,
  readHeader,
  readQueryString,
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
  /**
   * Optional sanitised progress projection (shared budget + resolved scenario scope). When
   * absent the run surface still works; the business UI then shows no budget/scope instead
   * of inventing one.
   */
  readonly progress?: RunProgressReader
  /** Durable controller dispatch; a 202 is sent only after this write succeeds. */
  readonly dispatch?: RunDispatchHooks
  /** Optional host-owned route/task match. It runs before a durable run is created. */
  readonly validateSubmission?: (input: {
    readonly profileRef: ProfileRef
    readonly question: string
    readonly context: CreateRunContext
    readonly scopeRef: ScopeRef
  }, ctx: ToolContext) => Promise<void>
  /** Explicit compatibility mode for tests/legacy records-only hosts. */
  readonly submissionMode?: 'durable' | 'records-only'
  readonly logger?: boolean
}

export interface RunDispatchHooks {
  enqueue(runId: string, logicalActionId: string, ctx: ToolContext): Promise<unknown>
  cancelRun(runId: string, ctx: ToolContext): Promise<void>
}

export interface RunRouteDependencies {
  readonly service: RunService
  readonly authenticate: RequestAuthenticator
  readonly progress?: RunProgressReader
  readonly dispatch?: RunDispatchHooks
  readonly validateSubmission?: RunApiOptions['validateSubmission']
  readonly submissionMode?: 'durable' | 'records-only'
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
      ...(auth.allowedDomains === undefined ? {} : { allowedDomains: auth.allowedDomains }),
    })

  app.post('/api/v1/runs', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const idempotencyKey = readHeader(request, 'idempotency-key')
    if (idempotencyKey === undefined) {
      throw new RunServiceError('INVALID_ARGUMENT', 'the Idempotency-Key header is required')
    }
    if (dependencies.dispatch === undefined && dependencies.submissionMode !== 'records-only') {
      throw new CapabilityNotConfiguredError('durable workflow dispatch is required to accept a run')
    }
    const fields = parseCreateRunRequest(request.body)
    const runId = globalThis.crypto.randomUUID()
    await dependencies.validateSubmission?.(
      {
        profileRef: fields.profileRef,
        question: fields.question,
        context: fields.context,
        scopeRef: { tenantId: auth.principal.tenantId, spaceId: auth.spaceId },
      },
      contextFor(auth, traceId, runId),
    )
    const result = await dependencies.service.createRun(
      { runId, ...fields, idempotencyKey },
      contextFor(auth, traceId, runId),
    )
    await dependencies.dispatch?.enqueue(
      result.runId,
      'initial-drive',
      contextFor(auth, traceId, result.runId, result.resolvedProfileHash),
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

  // The resolved scenario scope for a profile, so the ask form offers only the enabled
  // tools and never a capability the profile disables. Registered before the parametric
  // route; the static segment wins in the router regardless of order.
  app.get('/api/v1/runs/scope', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const progress = dependencies.progress
    if (progress === undefined) {
      throw new CapabilityNotConfiguredError('the run scope projection is not configured')
    }
    const profileId = requireNonEmptyString(readQueryString(request, 'profileId'), 'profileId')
    const version = requireNonEmptyString(readQueryString(request, 'version'), 'version')
    const ctx = contextFor(auth, traceId, profileId)
    const scope = await progress.scopeForProfile({ id: profileId, version }, ctx)
    reply.status(200).send({ data: scope, meta: { traceId } })
    return reply
  })

  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const view = await dependencies.service.getRun(runId, contextFor(auth, traceId, runId))
    const progress =
      dependencies.progress === undefined
        ? {}
        : await dependencies.progress.progressForRun(
            {
              runId: view.runId,
              profileRef: view.profileRef,
              resolvedProfileHash: view.resolvedProfileHash,
            },
            contextFor(auth, traceId, runId, view.resolvedProfileHash),
          )
    reply
      .status(200)
      .send({ data: { ...view, ...progress }, meta: { traceId, revision: view.revision } })
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
      if (dependencies.dispatch === undefined && dependencies.submissionMode !== 'records-only') {
        throw new CapabilityNotConfiguredError('durable workflow dispatch is required to accept a clarification response')
      }
      const expectedRevision = resolveExpectedRevision(readIfMatch(request), body['expectedRevision'])
      const view = await dependencies.service.respondToClarification(
        { runId, clarificationId, typedResponse, expectedRevision },
        contextFor(auth, traceId, runId),
      )
      await dependencies.dispatch?.enqueue(
        runId,
        `clarification-response:${clarificationId}:${view.revision}`,
        contextFor(auth, traceId, runId, view.resolvedProfileHash),
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
    if (dependencies.submissionMode !== 'records-only' && (dependencies.dispatch === undefined || dependencies.dispatch.cancelRun === undefined)) {
      throw new CapabilityNotConfiguredError('durable dispatch cancellation is required for a product run host')
    }
    const expectedRevision = resolveExpectedRevision(readIfMatch(request), body['expectedRevision'])
    const view = await dependencies.service.cancelRun(
      { runId, reason, expectedRevision },
      contextFor(auth, traceId, runId),
    )
    await dependencies.dispatch?.cancelRun(runId, contextFor(auth, traceId, runId, view.resolvedProfileHash))
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
    if (dependencies.dispatch === undefined && dependencies.submissionMode !== 'records-only') {
      throw new CapabilityNotConfiguredError('durable workflow dispatch is required to accept a resumed run')
    }
    const expectedRevision = resolveExpectedRevision(readIfMatch(request), body['expectedRevision'])
    const view = await dependencies.service.resumeRun(
      { runId, checkpointId, runtimeKind, runtimeVersion, stateDigest, expectedRevision },
      contextFor(auth, traceId, runId),
    )
    await dependencies.dispatch?.enqueue(
      runId,
      `resume:${checkpointId}:${view.revision}`,
      contextFor(auth, traceId, runId, view.resolvedProfileHash),
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
