import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isRecord, isRevisionString, isUuid } from '@ontology/contracts'
import type { ToolContext } from '@ontology/contracts'
import type { createCoreSourceViewReader } from '../composition/core-source-view'
import { authenticateRequest, InvalidRequestFieldError, readTraceId } from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

export interface CoreSourceViewRouteDependencies {
  readonly reader: ReturnType<typeof createCoreSourceViewReader>
  readonly authenticate: RequestAuthenticator
  /** Existing trusted host read context; no browser-supplied refs or permissions. */
  readonly contextFor: (auth: AuthenticatedRequest, traceId: string) => ToolContext | Promise<ToolContext>
}

async function withSignal<T>(request: FastifyRequest, reply: FastifyReply, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('the source read request was aborted'))
  const closed = () => { if (!reply.raw.writableEnded) abort() }
  request.raw.once('aborted', abort)
  reply.raw.once('close', closed)
  if (request.raw.aborted) abort()
  try {
    const value = await read(controller.signal)
    controller.signal.throwIfAborted()
    return value
  } finally { request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', closed) }
}

/** Read-only leaf; normal host explicitly mounts it with real stores and authentication. */
export function registerCoreSourceViewRoutes(app: FastifyInstance, dependencies: CoreSourceViewRouteDependencies): void {
  app.get<{ Params: { answerId: string; evidenceId: string } }>('/api/v1/core/answers/:answerId/sources/:evidenceId', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    if (!isUuid(request.params.answerId) || !isUuid(request.params.evidenceId)) throw new InvalidRequestFieldError('answerId and evidenceId must be UUIDs')
    if (!isRecord(request.query) || Object.keys(request.query).length > 0) throw new InvalidRequestFieldError('answer source reads accept no history, latest or source override parameters')
    const ctx = await dependencies.contextFor(auth, traceId)
    const data = await withSignal(request, reply, (signal) => dependencies.reader.answerSource(request.params.answerId, request.params.evidenceId, ctx, signal))
    return reply.send({ data, meta: { traceId } })
  })
  app.get<{ Params: { projectId: string; recordId: string; fieldId: string } }>('/api/v1/core/projects/:projectId/instance-records/:recordId/fields/:fieldId/source', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const { projectId, recordId, fieldId } = request.params
    if (!isUuid(projectId) || !isUuid(recordId) || fieldId.length === 0 || fieldId.length > 256) throw new InvalidRequestFieldError('valid project, record and field selectors are required')
    if (!isRecord(request.query) || Object.keys(request.query).some((key) => key !== 'recordRevision') || !isRevisionString(request.query['recordRevision'])) throw new InvalidRequestFieldError('the exact current recordRevision selector is required')
    const ctx = await dependencies.contextFor(auth, traceId)
    const revision = request.query['recordRevision']
    const data = await withSignal(request, reply, (signal) => dependencies.reader.instanceFieldSource(projectId, recordId, fieldId, revision, ctx, signal))
    return reply.send({ data, meta: { traceId, revision: data.recordRevision } })
  })
}
