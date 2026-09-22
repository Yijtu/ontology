import type { FastifyInstance, FastifyRequest } from 'fastify'
import { IdentityDecisionError } from '@ontology/semantic-engine'
import type { IdentityDecisionRequest, IdentityDecisionService } from '@ontology/semantic-engine'
import type {
  CandidateKind,
  CandidateRecord,
  CandidateState,
  CandidateStore,
  IdentityDecisionKind,
  IdentityScoreEvidence,
  IdentityStrongIdentity,
  ResourceRef,
  RevisionString,
} from '@ontology/contracts'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  isRecord,
  readRevisionHeader,
  readTraceId,
  ForbiddenError,
  InvalidRequestFieldError,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const DECISION_KINDS: readonly IdentityDecisionKind[] = ['match', 'create_pending', 'clarify', 'reject', 'split']
const CANDIDATE_STATES: readonly CandidateState[] = ['produced', 'pending_review', 'failed', 'rejected']
const CANDIDATE_KINDS: readonly CandidateKind[] = ['entity', 'relation', 'rule', 'rule_unhandled']
const REVIEWER_ROLES: readonly string[] = ['semantic-reviewer', 'platform-admin']
const MAX_PAGE = 200

export interface DecisionRouteDependencies {
  readonly service: IdentityDecisionService
  readonly candidates: CandidateStore
  readonly authenticate: RequestAuthenticator
}

/** A compact candidate projection for the review queue; never the full model payload. */
export interface CandidateSummary {
  readonly candidateId: string
  readonly jobId: string
  readonly kind: CandidateKind
  readonly state: CandidateState
  readonly recordedAt: string
  readonly objectId?: string
  readonly relationId?: string
  readonly ruleId?: string
}

function summaryOf(candidate: CandidateRecord): CandidateSummary {
  return {
    candidateId: candidate.candidateId,
    jobId: candidate.jobId,
    kind: candidate.kind,
    state: candidate.state,
    recordedAt: candidate.recordedAt,
    ...(candidate.kind === 'entity' ? { objectId: candidate.objectId } : {}),
    ...(candidate.kind === 'relation' ? { relationId: candidate.relationId } : {}),
    ...(candidate.kind === 'rule' || candidate.kind === 'rule_unhandled'
      ? candidate.ruleId === undefined
        ? {}
        : { ruleId: candidate.ruleId }
      : {}),
  }
}

function parseDecisionKind(value: unknown): IdentityDecisionKind {
  if (typeof value === 'string' && (DECISION_KINDS as readonly string[]).includes(value)) {
    return value as IdentityDecisionKind
  }
  throw new InvalidRequestFieldError(
    `kind must be one of ${DECISION_KINDS.join(', ')}`,
  )
}

function parseEvidenceRefs(value: unknown): readonly ResourceRef[] | undefined {
  if (value === undefined) return undefined
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

function parseStrongIdentity(value: unknown): IdentityStrongIdentity | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value['value'] !== 'string' || value['value'].length === 0) {
    throw new InvalidRequestFieldError('strongIdentity must carry a non-empty value')
  }
  if (value['kind'] !== 'native_id' && value['kind'] !== 'confirmed_alias') {
    throw new InvalidRequestFieldError('strongIdentity.kind must be native_id or confirmed_alias')
  }
  return { kind: value['kind'], value: value['value'] }
}

function parseScoreEvidence(value: unknown): IdentityScoreEvidence | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || typeof value['score'] !== 'number' || !Number.isFinite(value['score'])) {
    throw new InvalidRequestFieldError('scoreEvidence must carry a finite numeric score')
  }
  const backendRef = value['backendRef']
  if (
    !isRecord(backendRef) ||
    typeof backendRef['id'] !== 'string' ||
    typeof backendRef['version'] !== 'string' ||
    typeof backendRef['digest'] !== 'string'
  ) {
    throw new InvalidRequestFieldError('scoreEvidence.backendRef must carry id/version/digest strings')
  }
  const modelRef = value['modelRef']
  const parsedModelRef =
    modelRef === undefined
      ? undefined
      : isRecord(modelRef) && typeof modelRef['modelId'] === 'string' && typeof modelRef['version'] === 'string'
        ? { modelId: modelRef['modelId'], version: modelRef['version'] }
        : (() => {
            throw new InvalidRequestFieldError('scoreEvidence.modelRef must carry modelId/version strings')
          })()
  return {
    score: value['score'],
    backendRef: { id: backendRef['id'], version: backendRef['version'], digest: backendRef['digest'] },
    ...(parsedModelRef === undefined ? {} : { modelRef: parsedModelRef }),
  }
}

function readIfMatch(request: FastifyRequest): RevisionString | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new IdentityDecisionError('INVALID_ARGUMENT', 'If-Match must be a decimal revision string')
  }
  return header.value
}

function assertReviewer(auth: AuthenticatedRequest): void {
  if (REVIEWER_ROLES.some((role) => auth.principal.roles.includes(role))) return
  throw new ForbiddenError('only a semantic-reviewer may review identity candidates')
}

function readQueryString(request: FastifyRequest, name: string): string | undefined {
  const query = request.query
  if (!isRecord(query)) return undefined
  const value = query[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readQueryLimit(request: FastifyRequest): number {
  const raw = readQueryString(request, 'limit')
  if (raw === undefined) return MAX_PAGE
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new InvalidRequestFieldError('limit must be a positive integer')
  }
  return Math.min(Number(raw), MAX_PAGE)
}

/**
 * The C6 candidate review surface: `GET /candidates` and
 * `POST /candidates/{id}/decision`. It registers on the shared Fastify instance; identity
 * and tenant/space come from the server-side authentication result, never the body. The
 * `If-Match` revision is mandatory (missing → 428) and a stale revision is 409.
 */
export function registerDecisionRoutes(app: FastifyInstance, dependencies: DecisionRouteDependencies): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, candidateId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: candidateId,
    })

  app.get('/api/v1/candidates', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    assertReviewer(auth)
    const jobId = readQueryString(request, 'jobId')
    const state = readQueryString(request, 'state')
    if (state !== undefined && !(CANDIDATE_STATES as readonly string[]).includes(state)) {
      throw new InvalidRequestFieldError(`state must be one of ${CANDIDATE_STATES.join(', ')}`)
    }
    const kind = readQueryString(request, 'kind')
    if (kind !== undefined && !(CANDIDATE_KINDS as readonly string[]).includes(kind)) {
      throw new InvalidRequestFieldError(`kind must be one of ${CANDIDATE_KINDS.join(', ')}`)
    }
    const records = await dependencies.candidates.listCandidates(
      { tenantId: auth.principal.tenantId, spaceId: auth.spaceId },
      {
        ...(jobId === undefined ? {} : { jobId }),
        ...(state === undefined ? {} : { state: state as CandidateState }),
        ...(kind === undefined ? {} : { kind: kind as CandidateKind }),
        limit: readQueryLimit(request),
      },
      contextFor(auth, traceId, jobId ?? 'candidate-review'),
    )
    reply.status(200).send({ data: { candidates: records.map(summaryOf) }, meta: { traceId } })
    return reply
  })

  app.post<{ Params: { candidateId: string } }>(
    '/api/v1/candidates/:candidateId/decision',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const candidateId = request.params.candidateId
      const body = request.body
      if (!isRecord(body)) {
        throw new IdentityDecisionError('INVALID_ARGUMENT', 'the request body must be a JSON object')
      }
      const evidenceRefs = parseEvidenceRefs(body['evidenceRefs'])
      const strongIdentity = parseStrongIdentity(body['strongIdentity'])
      const scoreEvidence = parseScoreEvidence(body['scoreEvidence'])
      const separatedCandidateIds = Array.isArray(body['separatedCandidateIds'])
        ? body['separatedCandidateIds'].filter((value): value is string => typeof value === 'string')
        : undefined
      const decisionRequest: IdentityDecisionRequest = {
        candidateId,
        kind: parseDecisionKind(body['kind']),
        expectedRevision: readIfMatch(request),
        ...(typeof body['targetEntityId'] === 'string' ? { targetEntityId: body['targetEntityId'] } : {}),
        ...(separatedCandidateIds === undefined ? {} : { separatedCandidateIds }),
        ...(evidenceRefs === undefined ? {} : { evidenceRefs }),
        ...(typeof body['justification'] === 'string' ? { justification: body['justification'] } : {}),
        ...(strongIdentity === undefined ? {} : { strongIdentity }),
        ...(scoreEvidence === undefined ? {} : { scoreEvidence }),
        ...(typeof body['validFrom'] === 'string' ? { validFrom: body['validFrom'] } : {}),
        ...(typeof body['validTo'] === 'string' ? { validTo: body['validTo'] } : {}),
      }
      const view = await dependencies.service.decide(decisionRequest, contextFor(auth, traceId, candidateId))
      reply.status(200).send({ data: view, meta: { traceId, revision: view.revision } })
      return reply
    },
  )
}
