import type { FastifyInstance, FastifyRequest } from 'fastify'
import { JobServiceError, parseCreateJobRequest, parseRetryJobRequest } from '@ontology/application'
import type { JobService } from '@ontology/application'
import type { CreateJobResponse, RetryJobResponse, RevisionString } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  isRecord,
  readHeader,
  readRevisionHeader,
  readTraceId,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

export interface JobApiOptions {
  readonly service: JobService
  readonly authenticate: RequestAuthenticator
  readonly logger?: boolean
}

export interface JobRouteDependencies {
  readonly service: JobService
  readonly authenticate: RequestAuthenticator
}

function readIfMatch(request: FastifyRequest): RevisionString | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new JobServiceError('INVALID_ARGUMENT', 'If-Match must be a decimal revision string')
  }
  return header.value
}

function resolveExpectedRevision(
  headerRevision: RevisionString | undefined,
  bodyRevision: unknown,
): RevisionString | undefined {
  if (headerRevision === undefined) return undefined
  if (typeof bodyRevision === 'string' && bodyRevision.length > 0 && bodyRevision !== headerRevision) {
    throw new JobServiceError(
      'INVALID_ARGUMENT',
      'the body expectedRevision does not match the If-Match header',
    )
  }
  return headerRevision
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined) {
    throw new JobServiceError('INVALID_ARGUMENT', 'the Idempotency-Key header is required')
  }
  return key
}

/**
 * The C6 job surface: `POST /ingestions`, `GET /jobs/{id}` and `POST /jobs/{id}/retry`. It
 * registers on the shared Fastify instance (there is no second HTTP server); the application
 * layer never imports the framework. Identity, tenant/space and permissions come from the
 * server-side authentication result, never from the request body.
 */
export function registerJobRoutes(app: FastifyInstance, dependencies: JobRouteDependencies): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, jobId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: jobId,
    })

  app.post('/api/v1/ingestions', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const idempotencyKey = requireIdempotencyKey(request)
    const fields = parseCreateJobRequest(request.body)
    const jobId = globalThis.crypto.randomUUID()
    const result = await dependencies.service.createJob(
      { jobId, ...fields, idempotencyKey },
      contextFor(auth, traceId, jobId),
    )
    const data: CreateJobResponse = {
      jobId: result.jobId,
      stage: result.stage,
      jobUrl: `/api/v1/jobs/${result.jobId}`,
    }
    reply.status(202).send({ data, meta: { traceId, revision: result.revision } })
    return reply
  })

  app.get<{ Params: { jobId: string } }>('/api/v1/jobs/:jobId', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const jobId = request.params.jobId
    const view = await dependencies.service.getJob(jobId, contextFor(auth, traceId, jobId))
    reply.status(200).send({ data: view, meta: { traceId, revision: view.revision } })
    return reply
  })

  app.post<{ Params: { jobId: string } }>(
    '/api/v1/jobs/:jobId/retry',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const jobId = request.params.jobId
      const idempotencyKey = requireIdempotencyKey(request)
      const body = request.body
      if (!isRecord(body)) {
        throw new JobServiceError('INVALID_ARGUMENT', 'the request body must be a JSON object')
      }
      const fields = parseRetryJobRequest(body)
      const expectedRevision = resolveExpectedRevision(readIfMatch(request), body['expectedRevision'])
      const view = await dependencies.service.retryJob(
        { jobId, failedStage: fields.failedStage, idempotencyKey, expectedRevision },
        contextFor(auth, traceId, jobId),
      )
      const data: RetryJobResponse = {
        jobId: view.jobId,
        stage: view.stage,
        attemptCount: view.attemptCount,
      }
      reply.status(200).send({ data, meta: { traceId, revision: view.revision } })
      return reply
    },
  )
}
