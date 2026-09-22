import type { FastifyInstance, FastifyRequest } from 'fastify'
import { SemanticPublicationError } from '@ontology/semantic-engine'
import type { SemanticPublicationService } from '@ontology/semantic-engine'
import type {
  CandidateKind,
  PublicationCandidateRef,
  ResourceRef,
  RevisionString,
  StatementRevisionRequest,
  VersionRef,
} from '@ontology/contracts'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  isRecord,
  readHeader,
  readRevisionHeader,
  readTraceId,
  InvalidRequestFieldError,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const CANDIDATE_KINDS: readonly CandidateKind[] = ['entity', 'relation', 'rule', 'rule_unhandled']
const REVISION_KINDS = ['correction', 'retraction'] as const
const MAX_PAGE = 200

export interface PublicationRouteDependencies {
  readonly service: SemanticPublicationService
  readonly authenticate: RequestAuthenticator
}

function readIfMatch(request: FastifyRequest): RevisionString | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new SemanticPublicationError('INVALID_ARGUMENT', 'If-Match must be a decimal revision string')
  }
  return header.value
}

function requireIdempotencyKey(request: FastifyRequest): string {
  return readHeader(request, 'idempotency-key') ?? ''
}

function parseVersionRef(value: unknown, field: string): VersionRef {
  if (!isRecord(value)) {
    throw new InvalidRequestFieldError(`${field} must be a version reference object`)
  }
  const { id, version, digest } = value
  if (typeof id !== 'string' || typeof version !== 'string' || typeof digest !== 'string') {
    throw new InvalidRequestFieldError(`${field} must carry id/version/digest strings`)
  }
  return { id, version, digest }
}

function parseCandidateRefs(value: unknown): readonly PublicationCandidateRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError('approvedCandidateRefs must be a non-empty array')
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InvalidRequestFieldError(`approvedCandidateRefs[${String(index)}] must be an object`)
    }
    const candidateId = entry['candidateId']
    const kind = entry['kind']
    if (typeof candidateId !== 'string' || candidateId.length === 0) {
      throw new InvalidRequestFieldError(`approvedCandidateRefs[${String(index)}].candidateId must be a non-empty string`)
    }
    if (typeof kind !== 'string' || !(CANDIDATE_KINDS as readonly string[]).includes(kind)) {
      throw new InvalidRequestFieldError(
        `approvedCandidateRefs[${String(index)}].kind must be one of ${CANDIDATE_KINDS.join(', ')}`,
      )
    }
    return { candidateId, kind: kind as CandidateKind }
  })
}

function parseEvidenceRefs(value: unknown): readonly ResourceRef[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new InvalidRequestFieldError('evidenceRefs must be an array of resource references')
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InvalidRequestFieldError(`evidenceRefs[${String(index)}] must be an object`)
    }
    const { id, version, digest, kind } = entry
    if (
      typeof id !== 'string' ||
      typeof version !== 'string' ||
      typeof digest !== 'string' ||
      typeof kind !== 'string'
    ) {
      throw new InvalidRequestFieldError(`evidenceRefs[${String(index)}] must carry id/version/digest/kind strings`)
    }
    return { id, version, digest, kind: kind as ResourceRef['kind'] }
  })
}

function parseRevisionKind(value: unknown): StatementRevisionRequest['kind'] {
  if (typeof value === 'string' && (REVISION_KINDS as readonly string[]).includes(value)) {
    return value as StatementRevisionRequest['kind']
  }
  throw new InvalidRequestFieldError(`kind must be one of ${REVISION_KINDS.join(', ')}`)
}

function readQueryString(request: FastifyRequest, name: string): string | undefined {
  const query = request.query
  if (!isRecord(query)) return undefined
  const value = query[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * The C6 publication surface: candidate review, semantic publication and statement
 * revision/retraction. It registers on the shared Fastify instance; identity and
 * tenant/space come from the server-side authentication result, never the body. The
 * `If-Match` revision is mandatory (missing → 428) and a stale revision is 409.
 */
export function registerPublicationRoutes(
  app: FastifyInstance,
  dependencies: PublicationRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: resourceId,
    })

  app.post<{ Params: { candidateId: string } }>(
    '/api/v1/candidates/:candidateId/reviews',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const candidateId = request.params.candidateId
      const body = request.body
      if (!isRecord(body)) {
        throw new SemanticPublicationError('INVALID_ARGUMENT', 'the request body must be a JSON object')
      }
      const decision = body['decision']
      if (decision !== 'approve' && decision !== 'reject') {
        throw new InvalidRequestFieldError('decision must be approve or reject')
      }
      const reason = body['reason']
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new InvalidRequestFieldError('reason must be a non-empty string')
      }
      const review = await dependencies.service.reviewCandidate(
        {
          candidateId,
          decision,
          reason,
          evidenceRefs: parseEvidenceRefs(body['evidenceRefs']),
          expectedRevision: readIfMatch(request),
        },
        contextFor(auth, traceId, candidateId),
      )
      reply.status(200).send({ data: review, meta: { traceId, revision: review.revision } })
      return reply
    },
  )

  app.get<{ Params: { candidateId: string } }>(
    '/api/v1/candidates/:candidateId/reviews',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const candidateId = request.params.candidateId
      const reviews = await dependencies.service.listReviews(
        candidateId,
        contextFor(auth, traceId, candidateId),
      )
      reply.status(200).send({ data: { reviews }, meta: { traceId } })
      return reply
    },
  )

  app.post('/api/v1/semantic-publications', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const body = request.body
    if (!isRecord(body)) {
      throw new SemanticPublicationError('INVALID_ARGUMENT', 'the request body must be a JSON object')
    }
    const publication = await dependencies.service.publish(
      {
        approvedCandidateRefs: parseCandidateRefs(body['approvedCandidateRefs']),
        schemaRef: parseVersionRef(body['schemaRef'], 'schemaRef'),
        expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request),
      },
      contextFor(auth, traceId, 'semantic-publication'),
    )
    reply.status(201).send({ data: publication, meta: { traceId, revision: publication.revision } })
    return reply
  })

  app.get('/api/v1/semantic-publications', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const rawLimit = readQueryString(request, 'limit')
    const limit = rawLimit === undefined ? MAX_PAGE : Math.min(Number(rawLimit), MAX_PAGE)
    const publications = await dependencies.service.listPublications(
      Number.isFinite(limit) && limit > 0 ? limit : MAX_PAGE,
      contextFor(auth, traceId, 'semantic-publication-list'),
    )
    reply.status(200).send({ data: { publications }, meta: { traceId } })
    return reply
  })

  app.get<{ Params: { publicationId: string } }>(
    '/api/v1/semantic-publications/:publicationId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const publicationId = request.params.publicationId
      const publication = await dependencies.service.getPublication(
        publicationId,
        contextFor(auth, traceId, publicationId),
      )
      reply.status(200).send({ data: publication, meta: { traceId, revision: publication.revision } })
      return reply
    },
  )

  app.post<{ Params: { statementId: string } }>(
    '/api/v1/statements/:statementId/revisions',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const statementId = request.params.statementId
      const body = request.body
      if (!isRecord(body)) {
        throw new SemanticPublicationError('INVALID_ARGUMENT', 'the request body must be a JSON object')
      }
      const reason = body['reason']
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new InvalidRequestFieldError('reason must be a non-empty string')
      }
      const revision = await dependencies.service.reviseStatement(
        {
          statementId,
          kind: parseRevisionKind(body['kind']),
          reason,
          ...(isRecord(body['correctedValue']) ? { correctedValue: body['correctedValue'] } : {}),
          ...(typeof body['validFrom'] === 'string' ? { validFrom: body['validFrom'] } : {}),
          ...(typeof body['validTo'] === 'string' ? { validTo: body['validTo'] } : {}),
          expectedRevision: readIfMatch(request),
          idempotencyKey: requireIdempotencyKey(request),
        },
        contextFor(auth, traceId, statementId),
      )
      reply.status(200).send({ data: revision, meta: { traceId, revision: revision.version } })
      return reply
    },
  )

  app.get<{ Params: { statementId: string } }>(
    '/api/v1/statements/:statementId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const statementId = request.params.statementId
      const statement = await dependencies.service.getStatement(
        statementId,
        contextFor(auth, traceId, statementId),
      )
      reply.status(200).send({ data: statement, meta: { traceId, revision: statement.version } })
      return reply
    },
  )

  app.get<{ Params: { statementId: string } }>(
    '/api/v1/statements/:statementId/revisions',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const statementId = request.params.statementId
      const revisions = await dependencies.service.listStatementRevisions(
        statementId,
        contextFor(auth, traceId, statementId),
      )
      reply.status(200).send({ data: { revisions }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { propositionKey: string } }>(
    '/api/v1/propositions/:propositionKey',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const propositionKey = request.params.propositionKey
      const view = await dependencies.service.getPropositionView(
        propositionKey,
        contextFor(auth, traceId, propositionKey),
      )
      reply.status(200).send({ data: view, meta: { traceId } })
      return reply
    },
  )
}
