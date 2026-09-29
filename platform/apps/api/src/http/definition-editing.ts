import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  isDefinitionCandidatePayload,
  isDefinitionRevisionStrategy,
  isUuid,
} from '@ontology/contracts'
import type {
  DefinitionCandidatePayload,
  DefinitionRevisionStrategy,
  EditDefinitionCandidateInput,
  KeepDefinitionsSeparateInput,
  MergeDefinitionCandidatesInput,
  RejectDefinitionCandidateInput,
  RevisionString,
  SaveUnsupportedRuleInput,
  SplitDefinitionCandidateInput,
} from '@ontology/contracts'
import type { DefinitionCandidateEditingService } from '@ontology/application'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  isRecord,
  readHeader,
  readQueryInteger,
  readQueryString,
  readRevisionHeader,
  readTraceId,
  InvalidRequestFieldError,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 250

export interface DefinitionEditingRouteDependencies {
  readonly service: DefinitionCandidateEditingService
  readonly authenticate: RequestAuthenticator
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new InvalidRequestFieldError(`field ${key} is not accepted by this route`)
    }
  }
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined) {
    throw new InvalidRequestFieldError('an Idempotency-Key header is required')
  }
  return key
}

function readIfMatch(request: FastifyRequest): RevisionString | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new InvalidRequestFieldError('If-Match must be a decimal revision string')
  }
  return header.value
}

function readNonEmpty(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty string`)
  }
  return value
}

function parsePayload(value: unknown, field: string): DefinitionCandidatePayload {
  if (!isDefinitionCandidatePayload(value)) {
    throw new InvalidRequestFieldError(`${field} must be an object/attribute/relation candidate payload`)
  }
  return value
}

function parsePayloadArray(value: unknown, field: string): readonly DefinitionCandidatePayload[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty array`)
  }
  return value.map((entry, index) => parsePayload(entry, `${field}[${String(index)}]`))
}

function parseCandidateIds(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty array`)
  }
  return value.map((entry, index) => {
    if (!isUuid(entry)) {
      throw new InvalidRequestFieldError(`${field}[${String(index)}] must be a uuid`)
    }
    return entry
  })
}

function parseStrategy(value: unknown): DefinitionRevisionStrategy | undefined {
  if (value === undefined) return undefined
  if (!isDefinitionRevisionStrategy(value)) {
    throw new InvalidRequestFieldError('strategy must carry kind new_version|keep_independent|retire_previous and a reason')
  }
  return value
}

function readPageSize(request: FastifyRequest): number {
  const raw = readQueryInteger(request, 'pageSize') ?? readQueryInteger(request, 'limit')
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new InvalidRequestFieldError('pageSize must be a positive integer')
  }
  return Math.min(raw, MAX_PAGE_SIZE)
}

/**
 * Definition editing, disambiguation and compatibility validation (SPEC v0.3a §8.1, issue
 * V03-009 / #183). Editing a candidate always appends a new revision; a merge/split shows the
 * affected definitions; validation blocks a duplicate identifier, a dangling endpoint, a wrong
 * unit or an illegal type/cardinality. Identity, scope and trace id come from the trusted
 * authenticator, never the body, and every write uses If-Match/CAS and an Idempotency-Key.
 */
export function registerDefinitionEditingRoutes(
  app: FastifyInstance,
  dependencies: DefinitionEditingRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: resourceId })

  app.post<{ Params: { workspaceId: string; candidateId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/candidates/:candidateId/edits',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { workspaceId, candidateId } = request.params
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['payload', 'reason'])
      const input: EditDefinitionCandidateInput = {
        candidateId,
        expectedRevision: readIfMatch(request),
        payload: parsePayload(body['payload'], 'payload'),
        reason: readNonEmpty(body, 'reason'),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const result = await dependencies.service.edit(
        workspaceId,
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: result, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/candidate-merges',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['candidateIds', 'mergedPayload', 'reason'])
      const input: MergeDefinitionCandidatesInput = {
        candidateIds: parseCandidateIds(body['candidateIds'], 'candidateIds'),
        mergedPayload: parsePayload(body['mergedPayload'], 'mergedPayload'),
        reason: readNonEmpty(body, 'reason'),
        expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const result = await dependencies.service.merge(
        workspaceId,
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: result, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; candidateId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/candidates/:candidateId/splits',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { workspaceId, candidateId } = request.params
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['parts', 'reason'])
      const input: SplitDefinitionCandidateInput = {
        candidateId,
        parts: parsePayloadArray(body['parts'], 'parts'),
        reason: readNonEmpty(body, 'reason'),
        expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const result = await dependencies.service.split(
        workspaceId,
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: result, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/candidate-decisions/keep-separate',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['candidateIds', 'reason'])
      const input: KeepDefinitionsSeparateInput = {
        candidateIds: parseCandidateIds(body['candidateIds'], 'candidateIds'),
        reason: readNonEmpty(body, 'reason'),
        expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const result = await dependencies.service.keepSeparate(
        workspaceId,
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: result, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; candidateId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/candidates/:candidateId/rejections',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { workspaceId, candidateId } = request.params
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['reason'])
      const input: RejectDefinitionCandidateInput = {
        candidateId,
        reason: readNonEmpty(body, 'reason'),
        expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const result = await dependencies.service.reject(
        workspaceId,
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: result, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/definition-validations',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['revision', 'strategy'])
      const strategy = parseStrategy(body['strategy'])
      const report = await dependencies.service.validateForPublication(
        {
          workspaceId,
          revision: readNonEmpty(body, 'revision'),
          ...(strategy === undefined ? {} : { strategy }),
        },
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { report }, meta: { traceId, revision: report.revision } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/definition-compatibility',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const revision = readQueryString(request, 'revision')
      if (revision === undefined) {
        throw new InvalidRequestFieldError('a revision query parameter is required')
      }
      const report = await dependencies.service.compatibility(
        workspaceId,
        revision,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { report }, meta: { traceId, revision } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/unsupported-rules',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['ruleId', 'reason', 'rawForm', 'sourceCandidateId'])
      const sourceCandidateId = body['sourceCandidateId']
      if (sourceCandidateId !== undefined && !isUuid(sourceCandidateId)) {
        throw new InvalidRequestFieldError('sourceCandidateId must be a uuid')
      }
      const input: SaveUnsupportedRuleInput = {
        workspaceId,
        ruleId: readNonEmpty(body, 'ruleId'),
        reason: readNonEmpty(body, 'reason'),
        rawForm: body['rawForm'],
        ...(sourceCandidateId === undefined ? {} : { sourceCandidateId }),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const rule = await dependencies.service.recordUnsupportedRule(
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(201).send({ data: { rule }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/unsupported-rules',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const rules = await dependencies.service.listUnsupportedRules(
        workspaceId,
        readPageSize(request),
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { rules }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/definition-adjudications',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const adjudications = await dependencies.service.listAdjudications(
        workspaceId,
        readPageSize(request),
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { adjudications }, meta: { traceId } })
      return reply
    },
  )
}
