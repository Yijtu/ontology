import type { FastifyInstance } from 'fastify'
import { assertModelingBriefShape, CandidateSourceError } from '@ontology/contracts'
import type {
  CandidateSourceReviewState,
  CandidateSourceStore,
  SourceTrustTier,
} from '@ontology/contracts'
import { WebResearchError } from '@ontology/application'
import type { WebResearchService } from '@ontology/application'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  ForbiddenError,
  isRecord,
  readHeader,
  readQueryInteger,
  readQueryString,
  readRevisionHeader,
  readTraceId,
  InvalidRequestFieldError,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const REVIEW_STATES: readonly CandidateSourceReviewState[] = ['proposed', 'approved', 'rejected']
const TRUST_TIERS: readonly SourceTrustTier[] = ['customer_authoritative', 'public_standard', 'agent_researched', 'synthetic']
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 250
const REVIEW_ROLES: readonly string[] = ['profile-editor', 'platform-admin']

export interface CandidateSourceRouteDependencies {
  /** The candidate-source review store. */
  readonly sources: CandidateSourceStore
  /** Present only when a web search provider is configured for this deployment. */
  readonly research?: WebResearchService
  readonly authenticate: RequestAuthenticator
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new InvalidRequestFieldError(`field ${key} is not accepted by this route`)
  }
}

function requireIdempotencyKey(request: Parameters<RequestAuthenticator>[0]): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined) throw new InvalidRequestFieldError('an Idempotency-Key header is required')
  return key
}

function readPageSize(request: Parameters<RequestAuthenticator>[0]): number {
  const raw = readQueryInteger(request, 'pageSize') ?? readQueryInteger(request, 'limit')
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(raw) || raw <= 0) throw new InvalidRequestFieldError('pageSize must be a positive integer')
  return Math.min(raw, MAX_PAGE_SIZE)
}

/** Render a store/research failure as its classified HTTP status instead of a bare 500. */
function classifiedFrom(error: unknown): never {
  if (error instanceof CandidateSourceError) {
    const httpStatus = error.code === 'NOT_FOUND' ? 404 : error.code === 'SCOPE_MISMATCH' ? 403 : error.code === 'INVALID_SOURCE' ? 400 : 409
    throw Object.assign(new Error(error.message), { code: error.code, httpStatus })
  }
  if (error instanceof WebResearchError) {
    const httpStatus = error.code === 'FORBIDDEN' ? 403 : error.code === 'INVALID_REQUEST' ? 400 : 502
    throw Object.assign(new Error(error.message), { code: error.code, httpStatus })
  }
  throw error
}

/**
 * The candidate-source research and review surface (design §5).
 *
 * Reads list the workspace's proposed sources with their provenance tier and review state; a
 * review promotes (`public_standard`), approves or rejects one source and is a compare-and-swap on
 * the revision the reviewer read (If-Match). Research runs only for a `researcher` role, only
 * inside the brief's approved domains, and only produces `agent_researched` proposals.
 */
export function registerCandidateSourceRoutes(
  app: FastifyInstance,
  dependencies: CandidateSourceRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string, domains: readonly string[]) =>
    createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: resourceId, allowedDomains: domains })

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/sources',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const reviewState = readQueryString(request, 'reviewState')
      if (reviewState !== undefined && !(REVIEW_STATES as readonly string[]).includes(reviewState)) {
        throw new InvalidRequestFieldError(`reviewState must be one of ${REVIEW_STATES.join(', ')}`)
      }
      const trustTier = readQueryString(request, 'trustTier')
      if (trustTier !== undefined && !(TRUST_TIERS as readonly string[]).includes(trustTier)) {
        throw new InvalidRequestFieldError(`trustTier must be one of ${TRUST_TIERS.join(', ')}`)
      }
      const workspaceId = request.params.workspaceId
      const sources = await dependencies.sources.listSources(
        { tenantId: auth.principal.tenantId, spaceId: auth.spaceId },
        workspaceId,
        {
          ...(reviewState === undefined ? {} : { reviewState: reviewState as CandidateSourceReviewState }),
          ...(trustTier === undefined ? {} : { trustTier: trustTier as SourceTrustTier }),
          limit: readPageSize(request),
        },
        contextFor(auth, traceId, workspaceId, []),
      )
      reply.status(200).send({ data: { sources }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; sourceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/sources/:sourceId/reviews',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      if (!auth.principal.roles.some((role) => REVIEW_ROLES.includes(role))) {
        throw new ForbiddenError('a source review requires an editor or platform-admin role')
      }
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['reviewState', 'trustTier'])
      if (typeof body['reviewState'] !== 'string' || !(REVIEW_STATES as readonly string[]).includes(body['reviewState'])) {
        throw new InvalidRequestFieldError(`reviewState must be one of ${REVIEW_STATES.join(', ')}`)
      }
      if (body['trustTier'] !== undefined && (typeof body['trustTier'] !== 'string' || !(TRUST_TIERS as readonly string[]).includes(body['trustTier']))) {
        throw new InvalidRequestFieldError(`trustTier must be one of ${TRUST_TIERS.join(', ')}`)
      }
      const header = readRevisionHeader(request)
      if (header.kind !== 'revision') throw new InvalidRequestFieldError('If-Match must be the source revision being reviewed')
      const workspaceId = request.params.workspaceId
      const source = await dependencies.sources.reviewSource(
        { tenantId: auth.principal.tenantId, spaceId: auth.spaceId },
        {
          sourceId: request.params.sourceId,
          reviewState: body['reviewState'] as CandidateSourceReviewState,
          ...(body['trustTier'] === undefined ? {} : { trustTier: body['trustTier'] as SourceTrustTier }),
          reviewedBy: auth.principal.subjectId,
          expectedRevision: header.value,
          idempotencyKey: requireIdempotencyKey(request),
        },
        contextFor(auth, traceId, workspaceId, []),
      ).catch((error: unknown) => classifiedFrom(error))
      reply.status(201).send({ data: { source }, meta: { traceId, revision: source.revision } })
      return reply
    },
  )

  if (dependencies.research !== undefined) {
    const research = dependencies.research
    app.post<{ Params: { workspaceId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/research',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        rejectUnknownFields(body, ['goal', 'allowedResearchDomains', 'freshnessHint', 'targetKinds', 'mustCover', 'candidateLimit'])
        const workspaceId = request.params.workspaceId
        const brief = {
          schemaVersion: 'modeling-brief@1' as const,
          workspaceId,
          goal: body['goal'],
          allowedResearchDomains: body['allowedResearchDomains'],
          ...(body['freshnessHint'] === undefined ? {} : { freshnessHint: body['freshnessHint'] }),
          targetKinds: body['targetKinds'],
          ...(body['mustCover'] === undefined ? {} : { mustCover: body['mustCover'] }),
          ...(body['candidateLimit'] === undefined ? {} : { candidateLimit: body['candidateLimit'] }),
        }
        try {
          assertModelingBriefShape(brief)
        } catch (error) {
          throw new InvalidRequestFieldError(error instanceof Error ? error.message : 'the modeling brief is invalid')
        }
        const ctx = contextFor(auth, traceId, workspaceId, brief.allowedResearchDomains as readonly string[])
        const result = await research.research({
          brief,
          retrievedAt: new Date().toISOString(),
          deadline: ctx.deadline,
          idempotencyKey: requireIdempotencyKey(request),
        }, ctx).catch((error: unknown) => classifiedFrom(error))
        reply.status(201).send({ data: { sources: result.sources, skippedWithoutSnapshot: result.skippedWithoutSnapshot }, meta: { traceId } })
        return reply
      },
    )
  }
}
