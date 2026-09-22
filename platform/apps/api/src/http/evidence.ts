import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ProvenanceReadService } from '@ontology/provenance'
import type { DependencyTraversalRequest, EvidenceDependencyDirection } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  InvalidRequestFieldError,
  readQueryInteger,
  readQueryString,
  readTraceId,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

/**
 * The read methods the evidence surface needs. The real `ProvenanceReadService` satisfies it;
 * declaring the surface as the picked public methods lets the composition pass the concrete
 * service and a UI test pass a controlled double without re-implementing the class.
 */
export type EvidenceReadSurface = Pick<
  ProvenanceReadService,
  'getEvidence' | 'getDependencies' | 'exportEvidence'
>

export interface EvidenceRouteDependencies {
  readonly service: EvidenceReadSurface
  readonly authenticate: RequestAuthenticator
}

function readDirection(request: FastifyRequest): EvidenceDependencyDirection {
  const raw = readQueryString(request, 'direction')
  if (raw === undefined) return 'outbound'
  if (raw === 'inbound' || raw === 'outbound') return raw
  throw new InvalidRequestFieldError('direction must be inbound or outbound')
}

/**
 * The C6 evidence surface: on-demand provenance, a bounded dependency traversal and a
 * controlled export. It registers on the shared Fastify instance, derives identity and
 * tenant/space from the server-side authentication result (never the URL or body) and lets
 * the shared error boundary render the classified 403/404/409 codes.
 */
export function registerEvidenceRoutes(
  app: FastifyInstance,
  dependencies: EvidenceRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: resourceId,
    })

  app.get<{ Params: { evidenceId: string } }>(
    '/api/v1/evidence/:evidenceId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const evidenceId = request.params.evidenceId
      const asOf = readQueryString(request, 'asOf')
      const validAt = readQueryString(request, 'validAt')
      const view = await dependencies.service.getEvidence(
        evidenceId,
        { ...(asOf === undefined ? {} : { asOf }), ...(validAt === undefined ? {} : { validAt }) },
        contextFor(auth, traceId, evidenceId),
      )
      reply.status(200).send({ data: view, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { evidenceId: string } }>(
    '/api/v1/evidence/:evidenceId/dependencies',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const evidenceId = request.params.evidenceId
      const cursor = readQueryString(request, 'cursor')
      const depth = readQueryInteger(request, 'depth')
      const limit = readQueryInteger(request, 'limit')
      const traversal: DependencyTraversalRequest = {
        direction: readDirection(request),
        depth: depth ?? 1,
        ...(cursor === undefined ? {} : { cursor }),
        ...(limit === undefined ? {} : { limit }),
      }
      const graph = await dependencies.service.getDependencies(
        evidenceId,
        traversal,
        contextFor(auth, traceId, evidenceId),
      )
      reply.status(200).send({ data: graph, meta: { traceId, nextCursor: graph.coverage.cursor } })
      return reply
    },
  )

  app.get<{ Params: { evidenceId: string } }>(
    '/api/v1/evidence/:evidenceId/export',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const evidenceId = request.params.evidenceId
      const asOf = readQueryString(request, 'asOf')
      const validAt = readQueryString(request, 'validAt')
      const bundle = await dependencies.service.exportEvidence(
        evidenceId,
        { ...(asOf === undefined ? {} : { asOf }), ...(validAt === undefined ? {} : { validAt }) },
        contextFor(auth, traceId, evidenceId),
      )
      reply.status(200).send({ data: bundle, meta: { traceId } })
      return reply
    },
  )
}
