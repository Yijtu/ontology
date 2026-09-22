import type { FastifyInstance } from 'fastify'
import type { HistoryReadService } from '@ontology/semantic-engine'
import type { ObjectHistoryQuery } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { authenticateRequest, readQueryInteger, readQueryString, readTraceId } from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

/**
 * The read methods the history surface needs. The real `HistoryReadService` satisfies it;
 * declaring the surface as the picked public methods lets the composition pass the concrete
 * service and a UI test pass a controlled double without re-implementing the class.
 */
export type HistoryReadSurface = Pick<HistoryReadService, 'getObjectHistory'>

export interface HistoryRouteDependencies {
  readonly service: HistoryReadSurface
  readonly authenticate: RequestAuthenticator
}

/**
 * The C6 history surface: immutable assertion versions for one object, replayed at a
 * `recordedAt` system version or a `validAt` business instant. It registers on the shared
 * Fastify instance and derives tenant/space from the server-side authentication result.
 */
export function registerHistoryRoutes(
  app: FastifyInstance,
  dependencies: HistoryRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: resourceId,
    })

  app.get<{ Params: { objectId: string } }>(
    '/api/v1/objects/:objectId/history',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const objectId = request.params.objectId
      const recordedAt = readQueryString(request, 'recordedAt')
      const validAt = readQueryString(request, 'validAt')
      const cursor = readQueryString(request, 'cursor')
      const limit = readQueryInteger(request, 'limit')
      const query: ObjectHistoryQuery = {
        ...(recordedAt === undefined ? {} : { recordedAt }),
        ...(validAt === undefined ? {} : { validAt }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }
      const history = await dependencies.service.getObjectHistory(
        objectId,
        query,
        contextFor(auth, traceId, objectId),
      )
      reply.status(200).send({ data: history, meta: { traceId, nextCursor: history.coverage.cursor } })
      return reply
    },
  )
}
