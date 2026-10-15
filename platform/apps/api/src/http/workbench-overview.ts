import type { FastifyInstance } from 'fastify'
import { WorkbenchOverviewError, isUuid } from '@ontology/contracts'
import type { RevisionString, WorkbenchOverviewReader, WorkbenchSubject } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  InvalidRequestFieldError,
  readQueryString,
  readTraceId,
  scopeRefFor,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const REVISION_PATTERN = /^(0|[1-9][0-9]*)$/
const REVISION_ZERO: RevisionString = '0'

export interface WorkbenchOverviewRouteDependencies {
  readonly overview: WorkbenchOverviewReader
  readonly authenticate: RequestAuthenticator
}

/** Render an overview failure as its classified HTTP status instead of a bare 500. */
function classifiedFrom(error: unknown): never {
  if (error instanceof WorkbenchOverviewError) {
    const httpStatus = error.code === 'NOT_FOUND' ? 404
      : error.code === 'SCOPE_MISMATCH' ? 403
        : error.code === 'INVALID_REQUEST' ? 400 : 500
    throw Object.assign(new Error(error.message), { code: error.code, httpStatus })
  }
  throw error
}

function requireUuid(value: string, field: string): string {
  if (!isUuid(value)) throw new InvalidRequestFieldError(`${field} must be a uuid`)
  return value
}

function optionalRevision(value: string | undefined): RevisionString {
  if (value === undefined) return REVISION_ZERO
  if (!REVISION_PATTERN.test(value)) throw new InvalidRequestFieldError('revision must be a decimal revision string')
  return value
}

/**
 * The knowledge-workbench overview surface (design §2.4): the authorized space summary, the
 * industry-workspace source/candidate/validation/publication progress and the project
 * mounted-version/readiness/task summary. Every projection is deterministic and read-only; the
 * tenant/space scope comes from the trusted principal, never the request.
 */
export function registerWorkbenchOverviewRoutes(
  app: FastifyInstance,
  dependencies: WorkbenchOverviewRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string) =>
    createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: globalThis.crypto.randomUUID() })

  app.get('/api/v1/workbench/overview', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const ctx = contextFor(auth, traceId)
    const subject: WorkbenchSubject = { kind: 'space' }
    try {
      const overview = await dependencies.overview.readOverview(scopeRefFor(auth), subject, ctx)
      reply.status(200).send({ data: overview, meta: { traceId, revision: overview.revision } })
    } catch (error) {
      classifiedFrom(error)
    }
    return reply
  })

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/overview',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const ctx = contextFor(auth, traceId)
      const workspaceId = requireUuid(request.params.workspaceId, 'workspaceId')
      const subject: WorkbenchSubject = { kind: 'industry_workspace', workspaceId, revision: optionalRevision(readQueryString(request, 'revision')) }
      try {
        const overview = await dependencies.overview.readOverview(scopeRefFor(auth), subject, ctx)
        reply.status(200).send({ data: overview, meta: { traceId, revision: overview.revision } })
      } catch (error) {
        classifiedFrom(error)
      }
      return reply
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/overview',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const ctx = contextFor(auth, traceId)
      const projectId = requireUuid(request.params.projectId, 'projectId')
      const subject: WorkbenchSubject = { kind: 'project', projectId, revision: optionalRevision(readQueryString(request, 'revision')) }
      try {
        const overview = await dependencies.overview.readOverview(scopeRefFor(auth), subject, ctx)
        reply.status(200).send({ data: overview, meta: { traceId, revision: overview.revision } })
      } catch (error) {
        classifiedFrom(error)
      }
      return reply
    },
  )
}
