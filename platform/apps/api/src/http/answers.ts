import type { FastifyInstance } from 'fastify'
import type { PublishedAnswer, RevisionString, RunState, ToolContext } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { authenticateRequest, readTraceId } from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

/**
 * The narrow read surface the answer route needs. `WorkflowController` satisfies it
 * structurally: it owns the run phase and is the only reader of the published answer.
 */
export interface AnswerReader {
  getRun(
    runId: string,
    ctx: ToolContext,
  ): Promise<{ readonly state: RunState; readonly revision: RevisionString }>
  getAnswer(runId: string, ctx: ToolContext): Promise<PublishedAnswer | undefined>
}

export interface AnswerRouteDependencies {
  readonly reader: AnswerReader
  readonly authenticate: RequestAuthenticator
}

const TERMINAL_WITHOUT_ANSWER: ReadonlySet<RunState> = new Set<RunState>([
  'cancelled',
  'failed',
  'blocked',
])

/**
 * The C6 answer surface (`GET /runs/{id}/answer`). It returns the verified answer, or a 202
 * while the run is still in progress, or an explicit 404 when the run reached a terminal
 * state without a verified answer. It never returns an unverified draft.
 */
export function registerAnswerRoutes(
  app: FastifyInstance,
  dependencies: AnswerRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, runId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId,
    })

  app.get<{ Params: { runId: string } }>(
    '/api/v1/runs/:runId/answer',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const runId = request.params.runId
      const ctx = contextFor(auth, traceId, runId)
      const run = await dependencies.reader.getRun(runId, ctx)
      const answer = await dependencies.reader.getAnswer(runId, ctx)
      if (answer !== undefined) {
        reply.status(200).send({ data: answer, meta: { traceId, revision: run.revision } })
        return reply
      }
      if (TERMINAL_WITHOUT_ANSWER.has(run.state)) {
        reply.status(404).send({
          error: {
            code: 'ANSWER_NOT_AVAILABLE',
            message: `run ${runId} reached ${run.state} without a verified answer`,
            retryable: false,
          },
          traceId,
        })
        return reply
      }
      reply.status(202).send({
        data: { runId, state: run.state },
        meta: { traceId, revision: run.revision },
      })
      return reply
    },
  )
}
