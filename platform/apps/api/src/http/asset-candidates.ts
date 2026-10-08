import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { isResourceRef, isSha256Digest, isVersionRef } from '@ontology/contracts'
import type {
  AssetCandidateState,
  DefinitionCandidateKind,
  ResourceRef,
  RevisionString,
  VersionRef,
} from '@ontology/contracts'
import type {
  DefinitionCandidateGenerationService,
  DefinitionGenerationInput,
} from '@ontology/application'
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
const KINDS: readonly DefinitionCandidateKind[] = ['object', 'attribute', 'relation']
const STATES: readonly AssetCandidateState[] = [
  'produced',
  'pending_review',
  'pending_confirmation',
  'failed',
  'rejected',
]

export interface AssetCandidateRouteDependencies {
  readonly generation: DefinitionCandidateGenerationService
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

/** Absent `If-Match` becomes `undefined` so the service answers 428; a malformed one is 400. */
function readIfMatch(request: FastifyRequest): RevisionString | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new InvalidRequestFieldError('If-Match must be a decimal revision string')
  }
  return header.value
}

function parseVersionRef(value: unknown, field: string): VersionRef {
  if (!isVersionRef(value) || Object.keys(value).some((key) => !['id', 'version', 'digest'].includes(key))) {
    throw new InvalidRequestFieldError(`${field} must carry id/version/digest strings`)
  }
  return value
}

function parseResourceRef(value: unknown, field: string): ResourceRef {
  if (!isResourceRef(value) || Object.keys(value).some((key) => !['id', 'version', 'digest', 'kind'].includes(key))) {
    throw new InvalidRequestFieldError(`${field} must carry a uuid id, version, sha256 digest and kind`)
  }
  return value
}

function parseKinds(value: unknown): readonly DefinitionCandidateKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError('kinds must be a non-empty array')
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !(KINDS as readonly string[]).includes(entry)) {
      throw new InvalidRequestFieldError(
        `kinds[${String(index)}] must be one of ${KINDS.join(', ')}`,
      )
    }
    return entry as DefinitionCandidateKind
  })
}

function parseSourceRefs(value: unknown): readonly ResourceRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new InvalidRequestFieldError('sourceRefs must be an array of resource references')
  }
  return value.map((entry, index) => parseResourceRef(entry, `sourceRefs[${String(index)}]`))
}

function readPageSize(request: FastifyRequest): number {
  const raw = readQueryInteger(request, 'pageSize') ?? readQueryInteger(request, 'limit')
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new InvalidRequestFieldError('pageSize must be a positive integer')
  }
  return Math.min(raw, MAX_PAGE_SIZE)
}

async function withRequestSignal<T>(request: FastifyRequest, reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const abort = () => { controller.abort() }
  const close = () => { if (!reply.raw.writableEnded) controller.abort() }
  request.raw.once('aborted', abort)
  reply.raw.once('close', close)
  if (request.raw.aborted) controller.abort()
  try { return await operation(controller.signal) }
  finally { request.raw.off('aborted', abort); reply.raw.off('close', close) }
}

/**
 * The definition-candidate generation surface (SPEC v0.3a §8.1).
 *
 * It reuses the shared Fastify envelope and the trusted request context: identity, scope and
 * trace id come from the server-side authenticator, never the body. Reads are available to any
 * authenticated principal in scope; generation is gated by the service on an editor role and
 * requires If-Match/CAS so a stale head never generates against the wrong draft.
 */
export function registerAssetCandidateRoutes(
  app: FastifyInstance,
  dependencies: AssetCandidateRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: resourceId,
    })

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/generations',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const body = request.body
      if (!isRecord(body)) {
        throw new InvalidRequestFieldError('the request body must be a JSON object')
      }
      rejectUnknownFields(body, ['kinds', 'generationPolicyRef', 'documentSetRef', 'sourceRefs', 'candidateLimit', 'competencyQuestionRef'])
      if (body['candidateLimit'] !== undefined && (!Number.isSafeInteger(body['candidateLimit']) || Number(body['candidateLimit']) < 1 || Number(body['candidateLimit']) > 500)) throw new InvalidRequestFieldError('candidateLimit must be within 1..500')
      const input: DefinitionGenerationInput = {
        workspaceId,
        expectedRevision: readIfMatch(request),
        kinds: parseKinds(body['kinds']),
        generationPolicyRef: parseVersionRef(body['generationPolicyRef'], 'generationPolicyRef'),
        ...(body['documentSetRef'] === undefined
          ? {}
          : { documentSetRef: parseResourceRef(body['documentSetRef'], 'documentSetRef') }),
        sourceRefs: parseSourceRefs(body['sourceRefs']),
        ...(body['candidateLimit'] === undefined ? {} : { candidateLimit: Number(body['candidateLimit']) }),
        ...(body['competencyQuestionRef'] === undefined ? {} : { competencyQuestionRef: parseVersionRef(body['competencyQuestionRef'], 'competencyQuestionRef') }),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const result = await withRequestSignal(request, reply, (signal) => dependencies.generation.generate(
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId), signal,
      ))
      reply.status(201).send({
        data: { batch: result.batch, candidates: result.candidates, created: result.created },
        meta: { traceId, revision: result.batch.inputDraftRef.revision },
      })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string } }>('/api/v1/industry-workspaces/:workspaceId/source-grounding', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    rejectUnknownFields(body, ['sourceRefs'])
    const sourceRefs = parseSourceRefs(body['sourceRefs'])
    const expectedRevision = readIfMatch(request)
    const result = await withRequestSignal(request, reply, (signal) => dependencies.generation.readSources({ workspaceId: request.params.workspaceId,
      sourceRefs, ...(expectedRevision === undefined ? {} : { expectedRevision }) }, contextFor(auth, traceId, request.params.workspaceId), signal))
    reply.status(200).send({ data: result, meta: { traceId, revision: result.workspaceRevision } })
    return reply
  })

  app.post<{ Params: { workspaceId: string; candidateId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/candidates/:candidateId/source-confirmations',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['contentDigest', 'sourceRef', 'fragmentIndex', 'reason'])
      if (!isSha256Digest(body['contentDigest']) || !Number.isSafeInteger(body['fragmentIndex'])
        || Number(body['fragmentIndex']) < 0 || Number(body['fragmentIndex']) > 63 || typeof body['reason'] !== 'string') {
        throw new InvalidRequestFieldError('confirmation requires contentDigest, fragmentIndex within 0..63 and reason')
      }
      const contentDigest = body['contentDigest']
      const reason = body['reason']
      const result = await withRequestSignal(request, reply, (signal) => dependencies.generation.confirmSource({ workspaceId: request.params.workspaceId,
        candidateId: request.params.candidateId, contentDigest, sourceRef: parseResourceRef(body['sourceRef'], 'sourceRef'),
        fragmentIndex: Number(body['fragmentIndex']), reason, expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request) }, auth.principal.subjectId, contextFor(auth, traceId, request.params.workspaceId), signal))
      reply.status(201).send({ data: result, meta: { traceId, revision: result.batch.inputDraftRef.revision } })
      return reply
    })

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/candidates',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const kind = readQueryString(request, 'kind')
      if (kind !== undefined && !(KINDS as readonly string[]).includes(kind)) {
        throw new InvalidRequestFieldError(`kind must be one of ${KINDS.join(', ')}`)
      }
      const state = readQueryString(request, 'state')
      if (state !== undefined && !(STATES as readonly string[]).includes(state)) {
        throw new InvalidRequestFieldError(`state must be one of ${STATES.join(', ')}`)
      }
      const candidates = await dependencies.generation.listCandidates(
        workspaceId,
        {
          ...(kind === undefined ? {} : { kind: kind as DefinitionCandidateKind }),
          ...(state === undefined ? {} : { state: state as AssetCandidateState }),
          limit: readPageSize(request),
        },
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { candidates }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/generations',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const batches = await dependencies.generation.listBatches(
        workspaceId,
        readPageSize(request),
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { batches }, meta: { traceId } })
      return reply
    },
  )
}
