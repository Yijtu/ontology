import type { FastifyInstance } from 'fastify'
import type {
  PublishedAnswer,
  ResultHistoryView,
  RevisionString,
  RunState,
  TableArtifactReadErrorCode,
  TablePageReadRequest,
  TablePageReadView,
  ToolContext,
  VerifiedResultExport,
} from '@ontology/contracts'
import { isTableArtifactReadError } from '@ontology/contracts'
import type { VerifiedResultView } from '@ontology/application'
import { createRequestToolContext } from './context'
import { authenticateRequest, readQueryString, readTraceId } from './shared'
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

/** The verified typed-result projection surface (satisfied by `VerifiedResultReadService`). */
export interface AnswerResultReader {
  getResult(answerId: string, ctx: ToolContext): Promise<VerifiedResultView>
}

/** The fixed-revision paginated table reader (satisfied by `TableArtifactReadService`). */
export interface AnswerTableReader {
  readPage(request: TablePageReadRequest, ctx: ToolContext): Promise<TablePageReadView>
}

/** The structured JSON export surface (satisfied by `VerifiedResultExportService`). */
export interface AnswerExportReader {
  exportByRun(runId: string, ctx: ToolContext): Promise<VerifiedResultExport>
}

/** The result revision history surface (satisfied by `ResultHistoryService`). */
export interface AnswerHistoryReader {
  getHistory(runId: string, ctx: ToolContext): Promise<ResultHistoryView>
}

export interface AnswerRouteDependencies {
  readonly reader?: AnswerReader
  readonly result?: AnswerResultReader
  readonly tables?: AnswerTableReader
  readonly exporter?: AnswerExportReader
  readonly history?: AnswerHistoryReader
  readonly authenticate: RequestAuthenticator
}

/**
 * A caller requested an export format this deployment does not serve. JSON is the only format
 * this node provides; a professional XLSX template is registered by the scenario (B's node), so
 * an unsupported format is refused explicitly rather than silently returning JSON.
 */
class ExportFormatUnsupportedError extends Error {
  readonly code = 'EXPORT_FORMAT_UNSUPPORTED'
  readonly httpStatus = 422

  constructor(format: string) {
    super(`export format ${format} is not supported; only json is provided by the core surface`)
    this.name = 'ExportFormatUnsupportedError'
  }
}

const TERMINAL_WITHOUT_ANSWER: ReadonlySet<RunState> = new Set<RunState>([
  'cancelled',
  'failed',
  'blocked',
])

/**
 * A classified HTTP failure for the table read surface. `TableArtifactReadError` carries the
 * domain code but no HTTP status, so the route maps each code onto the shared failure envelope
 * without leaking whether a table exists outside the caller's scope.
 */
class TableReadHttpError extends Error {
  readonly code: TableArtifactReadErrorCode
  readonly httpStatus: number

  constructor(code: TableArtifactReadErrorCode, message: string) {
    super(message)
    this.name = 'TableReadHttpError'
    this.code = code
    this.httpStatus = httpStatusForTableError(code)
  }
}

function httpStatusForTableError(code: TableArtifactReadErrorCode): number {
  switch (code) {
    case 'SCOPE_MISMATCH':
      return 403
    case 'TABLE_NOT_FOUND':
    case 'PAGE_NOT_FOUND':
      return 404
    case 'TABLE_REVISION_CHANGED':
    case 'CURSOR_REPLAY':
    case 'CURSOR_BACKWARD':
    case 'CURSOR_GAP':
      return 409
    case 'TABLE_UNVERIFIED':
    case 'PAGE_DIGEST_MISMATCH':
    case 'PAGE_ROW_ORDER_VIOLATION':
      return 422
    case 'CURSOR_INVALID':
    case 'INVALID_ARGUMENT':
      return 400
    default:
      return 400
  }
}

/**
 * The C6 answer surface (`GET /runs/{id}/answer`). It returns the verified answer, or a 202
 * while the run is still in progress, or an explicit 404 when the run reached a terminal
 * state without a verified answer. It never returns an unverified draft.
 *
 * It also wires the two typed-result read routes the browser workbench uses
 * (`GET /answers/{answerId}/result`, `GET /answers/{answerId}/tables/{tableId}`) over the
 * application read services. Both derive identity, tenant/space and the trace id from the
 * server-side authentication result and render the shared `/api/v1` envelope and error mapping.
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

  const reader = dependencies.reader
  if (reader !== undefined) {
    app.get<{ Params: { runId: string } }>(
      '/api/v1/runs/:runId/answer',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const runId = request.params.runId
        const ctx = contextFor(auth, traceId, runId)
        const run = await reader.getRun(runId, ctx)
        const answer = await reader.getAnswer(runId, ctx)
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

  const resultReader = dependencies.result
  if (resultReader !== undefined) {
    app.get<{ Params: { answerId: string } }>(
      '/api/v1/answers/:answerId/result',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const answerId = request.params.answerId
        const view = await resultReader.getResult(answerId, contextFor(auth, traceId, answerId))
        reply.status(200).send({ data: view, meta: { traceId } })
        return reply
      },
    )
  }

  const tableReader = dependencies.tables
  if (tableReader !== undefined) {
    app.get<{ Params: { answerId: string; tableId: string }; Querystring: { cursor?: string } }>(
      '/api/v1/answers/:answerId/tables/:tableId',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const answerId = request.params.answerId
        const tableId = request.params.tableId
        const cursor = readQueryString(request, 'cursor')
        try {
          const page = await tableReader.readPage(
            { answerId, tableId, ...(cursor === undefined ? {} : { cursor }) },
            contextFor(auth, traceId, answerId),
          )
          reply.status(200).send({ data: page, meta: { traceId } })
          return reply
        } catch (error) {
          if (isTableArtifactReadError(error)) {
            throw new TableReadHttpError(error.code, error.message)
          }
          throw error
        }
      },
    )
  }

  const exporter = dependencies.exporter
  if (exporter !== undefined) {
    app.get<{ Params: { runId: string }; Querystring: { format?: string } }>(
      '/api/v1/runs/:runId/answer/export',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const runId = request.params.runId
        const format = readQueryString(request, 'format') ?? 'json'
        if (format !== 'json') throw new ExportFormatUnsupportedError(format)
        const exported = await exporter.exportByRun(runId, contextFor(auth, traceId, runId))
        reply
          .header('content-type', 'application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="verified-result-${runId}.json"`)
          .status(200)
          .send({ data: exported, meta: { traceId } })
        return reply
      },
    )
  }

  const history = dependencies.history
  if (history !== undefined) {
    app.get<{ Params: { runId: string } }>(
      '/api/v1/runs/:runId/answer/history',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const runId = request.params.runId
        const view = await history.getHistory(runId, contextFor(auth, traceId, runId))
        reply.status(200).send({ data: view, meta: { traceId } })
        return reply
      },
    )
  }
}
