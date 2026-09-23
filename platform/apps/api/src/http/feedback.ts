import type { FastifyInstance } from 'fastify'
import type { FeedbackView, RecordFeedbackInput } from '@ontology/application'
import type { FeedbackKind, ToolContext } from '@ontology/contracts'
import { FEEDBACK_KINDS, isFeedbackKind } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  InvalidRequestFieldError,
  isRecord,
  readHeader,
  readQueryString,
  readTraceId,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

/**
 * The narrow feedback surface the routes need. `FeedbackService` satisfies it structurally: it
 * records append-only feedback and reads it back by run or by answer.
 */
export interface FeedbackWriter {
  recordFeedback(input: RecordFeedbackInput, ctx: ToolContext): Promise<FeedbackView>
  listByRun(runId: string, ctx: ToolContext): Promise<readonly FeedbackView[]>
  listByAnswer(runId: string, answerId: string, ctx: ToolContext): Promise<readonly FeedbackView[]>
}

export interface FeedbackRouteDependencies {
  readonly writer: FeedbackWriter
  readonly authenticate: RequestAuthenticator
}

const MAX_COMMENT_LENGTH = 4000
const MIN_RATING = 1
const MAX_RATING = 5

function readOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty string`)
  }
  return value
}

function readOptionalRating(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_RATING ||
    value > MAX_RATING
  ) {
    throw new InvalidRequestFieldError(
      `rating must be an integer between ${MIN_RATING} and ${MAX_RATING}`,
    )
  }
  return value
}

function readOptionalComment(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestFieldError('comment must be a non-empty string')
  }
  if (value.length > MAX_COMMENT_LENGTH) {
    throw new InvalidRequestFieldError(`comment must be at most ${MAX_COMMENT_LENGTH} characters`)
  }
  return value
}

function readKind(value: unknown): FeedbackKind {
  if (!isFeedbackKind(value)) {
    throw new InvalidRequestFieldError(`kind must be one of ${FEEDBACK_KINDS.join(', ')}`)
  }
  return value
}

/**
 * The feedback surface (US-022, FR-30; SPEC D2/D7.4, INV-09):
 *
 *  - `POST /api/v1/runs/{runId}/feedback` records append-only feedback (Idempotency-Key
 *    required);
 *  - `GET /api/v1/runs/{runId}/feedback` reads it back by run, optionally filtered by
 *    `answerId`.
 *
 * Identity and tenant/space come from the server-side authentication result, never the body. The
 * routes only ever call the feedback writer: they cannot publish an answer or change a run.
 */
export function registerFeedbackRoutes(
  app: FastifyInstance,
  dependencies: FeedbackRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, runId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId,
    })

  app.post<{ Params: { runId: string } }>(
    '/api/v1/runs/:runId/feedback',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const runId = request.params.runId
      const idempotencyKey = readHeader(request, 'idempotency-key')
      if (idempotencyKey === undefined) {
        throw new InvalidRequestFieldError('the Idempotency-Key header is required')
      }
      const body = request.body
      if (!isRecord(body)) {
        throw new InvalidRequestFieldError('the request body must be a JSON object')
      }
      const answerId = readOptionalString(body['answerId'], 'answerId')
      const rating = readOptionalRating(body['rating'])
      const comment = readOptionalComment(body['comment'])
      const feedback = await dependencies.writer.recordFeedback(
        {
          feedbackId: globalThis.crypto.randomUUID(),
          runId,
          kind: readKind(body['kind']),
          ...(answerId === undefined ? {} : { answerId }),
          ...(rating === undefined ? {} : { rating }),
          ...(comment === undefined ? {} : { comment }),
          idempotencyKey,
        },
        contextFor(auth, traceId, runId),
      )
      reply.status(201).send({ data: { feedback }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { runId: string } }>(
    '/api/v1/runs/:runId/feedback',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const runId = request.params.runId
      const answerId = readQueryString(request, 'answerId')
      const ctx = contextFor(auth, traceId, runId)
      const feedback =
        answerId === undefined
          ? await dependencies.writer.listByRun(runId, ctx)
          : await dependencies.writer.listByAnswer(runId, answerId, ctx)
      reply.status(200).send({ data: { feedback }, meta: { traceId } })
      return reply
    },
  )
}
