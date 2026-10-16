import type { FastifyInstance } from 'fastify'
import {
  assertModelingBriefShape,
  CandidateSourceError,
  ModelSelectionError,
  ResearchError,
  SourceAdmissionError,
} from '@ontology/contracts'
import type {
  CandidateSourceReviewCommand,
  CandidateSourceReviewState,
  CandidateSourceRetractionStore,
  CandidateSourceStore,
  DefinitionCandidateKind,
  ModelingBrief,
  ResearchLimits,
  ResearchPreflight,
  ResearchRequest,
  SourceAdmissionCommand,
  SourceAdmissionTableOptions,
  SourceRetractionCommand,
  SourceTrustTier,
  VersionRef,
  WebSearchFreshnessHint,
} from '@ontology/contracts'
import {
  CandidateSourceReviewService,
  DEFAULT_RESEARCH_BUDGET_REF,
  DEFAULT_RESEARCH_POLICY_REF,
  WebResearchError,
  WorkspaceSourceAdmissionService,
} from '@ontology/application'
import type { ResearchWorkflowService, WebResearchService } from '@ontology/application'
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
  /** The bounded, durable research orchestration; absent when web search is not configured. */
  readonly researchWorkflow?: ResearchWorkflowService
  /** The read-only research capability preflight; reports the actual recipient, scope and blocks. */
  readonly researchPreflight?: (input: {
    readonly workspaceId: string
    readonly requestedDomains: readonly string[]
    readonly limits: ResearchLimits
    readonly policyRef: VersionRef
    readonly budgetRef: VersionRef
    readonly requesterRoles: readonly string[]
  }) => Promise<ResearchPreflight>
  /** The append-only review/retraction surface; built from `sources` when absent. */
  readonly review?: CandidateSourceReviewService
  /** The retraction store, when it is not the same object as `sources`. */
  readonly retractions?: CandidateSourceRetractionStore
  /** Present only when the deployment can admit a reviewed source into a corpus. */
  readonly admissions?: WorkspaceSourceAdmissionService
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

function readCursor(request: Parameters<RequestAuthenticator>[0]): string | undefined {
  return readQueryString(request, 'cursor')
}

function readBoundedCount(value: unknown, fallback: number, max: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new InvalidRequestFieldError(`${field} must be an integer in 1..${max}`)
  }
  return value as number
}

/** Render a store/research/admission failure as its classified HTTP status instead of a bare 500. */
function classifiedFrom(error: unknown): never {
  if (error instanceof CandidateSourceError) {
    const httpStatus = error.code === 'NOT_FOUND' ? 404
      : error.code === 'SCOPE_MISMATCH' || error.code === 'FORBIDDEN' ? 403
        : error.code === 'INVALID_SOURCE' ? 400 : 409
    throw Object.assign(new Error(error.message), { code: error.code, httpStatus })
  }
  if (error instanceof SourceAdmissionError) {
    const httpStatus = error.code === 'NOT_FOUND' ? 404
      : error.code === 'FORBIDDEN' || error.code === 'SCOPE_MISMATCH' ? 403
        : error.code === 'INVALID_REQUEST' || error.code === 'DIGEST_MISMATCH' || error.code === 'MISSING_ORIGINAL'
          || error.code === 'UNSUPPORTED_MEDIA_TYPE' || error.code === 'EMPTY_SOURCE' ? 400
          : error.code === 'STORE_FAILED' ? 500 : 409
    throw Object.assign(new Error(error.message), { code: error.code, httpStatus })
  }
  if (error instanceof WebResearchError) {
    const httpStatus = error.code === 'FORBIDDEN' ? 403 : error.code === 'INVALID_REQUEST' ? 400 : 502
    throw Object.assign(new Error(error.message), { code: error.code, httpStatus })
  }
  if (error instanceof ResearchError) {
    const httpStatus = error.code === 'NOT_FOUND' ? 404
      : error.code === 'SCOPE_MISMATCH' ? 403
        : error.code === 'INVALID_REQUEST' ? 400
          : error.code === 'STORE_FAILED' ? 500 : 409
    throw Object.assign(new Error(error.message), { code: error.code, httpStatus })
  }
  if (error instanceof ModelSelectionError) {
    throw Object.assign(new Error(error.message), { code: error.code, httpStatus: error.httpStatus })
  }
  throw error
}

/**
 * Build the pinned `ResearchRequest` from the flat research-run body. The two counts and the
 * deadline are bounded here; the policy/budget refs are host-mounted constants, so a caller can
 * never widen the budget or move the deadline policy by editing the body. Shared by the async run
 * entry point and the continuation entry point so both pin a run identically.
 */
function readResearchRequest(workspaceId: string, body: Record<string, unknown>, idempotencyKey: string): ResearchRequest {
  rejectUnknownFields(body, ['goal', 'allowedResearchDomains', 'freshnessHint', 'targetKinds', 'mustCover', 'sourceLimit', 'candidateLimit', 'deadline'])
  const sourceLimit = readBoundedCount(body['sourceLimit'], 10, 200, 'sourceLimit')
  const candidateLimit = readBoundedCount(body['candidateLimit'], sourceLimit, 500, 'candidateLimit')
  const deadline = typeof body['deadline'] === 'string' ? body['deadline'] : new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const briefUnknown: unknown = {
    schemaVersion: 'modeling-brief@1',
    workspaceId,
    goal: body['goal'],
    allowedResearchDomains: body['allowedResearchDomains'],
    ...(body['freshnessHint'] === undefined ? {} : { freshnessHint: body['freshnessHint'] as WebSearchFreshnessHint }),
    targetKinds: body['targetKinds'] as readonly DefinitionCandidateKind[],
    ...(body['mustCover'] === undefined ? {} : { mustCover: body['mustCover'] }),
    sourceLimit,
    candidateLimit,
  }
  try {
    assertModelingBriefShape(briefUnknown)
  } catch (error) {
    throw new InvalidRequestFieldError(error instanceof Error ? error.message : 'the modeling brief is invalid')
  }
  const brief: ModelingBrief = briefUnknown
  return {
    schemaVersion: 'research-request@1',
    workspaceId,
    brief,
    limits: { sourceLimit, candidateLimit, deadline },
    allowedDomains: brief.allowedResearchDomains,
    policyRef: DEFAULT_RESEARCH_POLICY_REF,
    budgetRef: DEFAULT_RESEARCH_BUDGET_REF,
    idempotencyKey,
  }
}

/**
 * A stable, classifiable "the research capability is not configured" refusal. The run entry exists
 * even without a search provider, so it answers 409 with a named reason instead of 404.
 */
function capabilityNotConfigured(message: string): never {
  throw Object.assign(new Error(message), { code: 'CAPABILITY_NOT_CONFIGURED', httpStatus: 409 })
}

/**
 * The candidate-source research, review, admission and retraction surface (design §2.2/§2.4).
 *
 * A review promotes/approves/rejects one source, appends an auditable event and is a compare-and-swap
 * on the revision the reviewer read (If-Match); an admission fixes the reviewed revision, builds a
 * new immutable workspace document set and appends the draft under one control transaction; a
 * retraction appends an event and a fence while the original snapshot and history stay readable.
 * Research runs only for a `researcher` role, only inside the brief's approved domains, and only
 * produces `agent_researched` proposals.
 */
export function registerCandidateSourceRoutes(
  app: FastifyInstance,
  dependencies: CandidateSourceRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string, domains: readonly string[]) =>
    createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: resourceId, allowedDomains: domains })
  const review = dependencies.review ?? new CandidateSourceReviewService({
    sources: dependencies.sources,
    ...(dependencies.retractions === undefined ? {} : { retractions: dependencies.retractions }),
  })

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
      const cursor = readCursor(request)
      const scope = { tenantId: auth.principal.tenantId, spaceId: auth.spaceId }
      const ctx = contextFor(auth, traceId, workspaceId, [])
      const filter = {
        ...(reviewState === undefined ? {} : { reviewState: reviewState as CandidateSourceReviewState }),
        ...(trustTier === undefined ? {} : { trustTier: trustTier as SourceTrustTier }),
      }
      if (dependencies.sources.listSourcesPage !== undefined) {
        const result = await dependencies.sources.listSourcesPage(scope, workspaceId,
          { limit: readPageSize(request), ...(cursor === undefined ? {} : { cursor }), filter }, ctx)
        reply.status(200).send({ data: { sources: result.sources }, meta: { traceId, complete: result.complete, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) } })
        return reply
      }
      const sources = await dependencies.sources.listSources(scope, workspaceId, { ...filter, limit: readPageSize(request) }, ctx)
      reply.status(200).send({ data: { sources }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string; sourceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/sources/:sourceId/reviews',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const reviewCursor = readCursor(request)
      const page = { limit: readPageSize(request), ...(reviewCursor === undefined ? {} : { cursor: reviewCursor }) }
      const result = await review.listReviewEvents(workspaceId, request.params.sourceId, page,
        contextFor(auth, traceId, workspaceId, [])).catch((error: unknown) => classifiedFrom(error))
      reply.status(200).send({ data: { events: result.events }, meta: { traceId, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) } })
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
      rejectUnknownFields(body, ['reviewState', 'trustTier', 'reason', 'basisRefs'])
      if (typeof body['reviewState'] !== 'string' || !(REVIEW_STATES as readonly string[]).includes(body['reviewState'])) {
        throw new InvalidRequestFieldError(`reviewState must be one of ${REVIEW_STATES.join(', ')}`)
      }
      if (body['trustTier'] !== undefined && (typeof body['trustTier'] !== 'string' || !(TRUST_TIERS as readonly string[]).includes(body['trustTier']))) {
        throw new InvalidRequestFieldError(`trustTier must be one of ${TRUST_TIERS.join(', ')}`)
      }
      if (typeof body['reason'] !== 'string' || body['reason'].length === 0) {
        throw new InvalidRequestFieldError('a review reason is required')
      }
      if (body['basisRefs'] !== undefined && !Array.isArray(body['basisRefs'])) {
        throw new InvalidRequestFieldError('basisRefs must be an array of resource references')
      }
      const header = readRevisionHeader(request)
      if (header.kind !== 'revision') throw new InvalidRequestFieldError('If-Match must be the source revision being reviewed')
      const workspaceId = request.params.workspaceId
      const command: CandidateSourceReviewCommand = {
        schemaVersion: 'candidate-source-review@1',
        sourceId: request.params.sourceId,
        workspaceId,
        reviewState: body['reviewState'] as CandidateSourceReviewState,
        ...(body['trustTier'] === undefined ? {} : { trustTier: body['trustTier'] as SourceTrustTier }),
        reviewedBy: auth.principal.subjectId,
        reason: body['reason'],
        expectedRevision: header.value,
        basisRefs: (body['basisRefs'] ?? []) as CandidateSourceReviewCommand['basisRefs'],
        idempotencyKey: requireIdempotencyKey(request),
      }
      const receipt = await review.review(command, contextFor(auth, traceId, workspaceId, []))
        .catch((error: unknown) => classifiedFrom(error))
      const source = await dependencies.sources.getSource(
        { tenantId: auth.principal.tenantId, spaceId: auth.spaceId }, request.params.sourceId,
        contextFor(auth, traceId, workspaceId, []),
      )
      reply.status(receipt.replayed ? 200 : 201).send({ data: { source, receipt }, meta: { traceId, revision: receipt.revision } })
      return reply
    },
  )

  if (dependencies.admissions !== undefined) {
    const admissions = dependencies.admissions
    app.post<{ Params: { workspaceId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/source-admissions',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        if (!auth.principal.roles.some((role) => REVIEW_ROLES.includes(role))) {
          throw new ForbiddenError('admitting a source requires an editor or platform-admin role')
        }
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        rejectUnknownFields(body, ['sourceId', 'expectedSourceRevision', 'expectedWorkspaceRevision', 'parseOptions'])
        if (typeof body['sourceId'] !== 'string') throw new InvalidRequestFieldError('sourceId is required')
        if (typeof body['expectedSourceRevision'] !== 'string' || typeof body['expectedWorkspaceRevision'] !== 'string') {
          throw new InvalidRequestFieldError('expectedSourceRevision and expectedWorkspaceRevision are required')
        }
        const workspaceId = request.params.workspaceId
        const command: SourceAdmissionCommand = {
          schemaVersion: 'source-admission-command@1',
          workspaceId,
          sourceId: body['sourceId'],
          expectedSourceRevision: body['expectedSourceRevision'],
          expectedWorkspaceRevision: body['expectedWorkspaceRevision'],
          ...(body['parseOptions'] === undefined ? {} : { parseOptions: body['parseOptions'] as SourceAdmissionTableOptions }),
          idempotencyKey: requireIdempotencyKey(request),
        }
        const receipt = await admissions.admit(command, contextFor(auth, traceId, workspaceId, []))
          .catch((error: unknown) => classifiedFrom(error))
        reply.status(receipt.replayed ? 200 : 201).send({ data: { admission: receipt }, meta: { traceId } })
        return reply
      },
    )

    app.get<{ Params: { workspaceId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/source-admissions',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const workspaceId = request.params.workspaceId
        const admissionCursor = readCursor(request)
        const page = { limit: readPageSize(request), ...(admissionCursor === undefined ? {} : { cursor: admissionCursor }) }
        const result = await admissions.listAdmissions(workspaceId, page, contextFor(auth, traceId, workspaceId, []))
          .catch((error: unknown) => classifiedFrom(error))
        reply.status(200).send({ data: { admissions: result.admissions }, meta: { traceId, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) } })
        return reply
      },
    )
  }

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/source-retractions',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      if (!auth.principal.roles.some((role) => REVIEW_ROLES.includes(role))) {
        throw new ForbiddenError('retracting a source requires an editor or platform-admin role')
      }
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, ['sourceId', 'reason'])
      if (typeof body['sourceId'] !== 'string') throw new InvalidRequestFieldError('sourceId is required')
      if (typeof body['reason'] !== 'string' || body['reason'].length === 0) {
        throw new InvalidRequestFieldError('a retraction reason is required')
      }
      const header = readRevisionHeader(request)
      if (header.kind !== 'revision') throw new InvalidRequestFieldError('If-Match must be the source revision being retracted')
      const workspaceId = request.params.workspaceId
      const command: SourceRetractionCommand = {
        schemaVersion: 'source-retraction-command@1',
        workspaceId,
        sourceId: body['sourceId'],
        expectedRevision: header.value,
        reason: body['reason'],
        idempotencyKey: requireIdempotencyKey(request),
      }
      const receipt = await review.retract(command, contextFor(auth, traceId, workspaceId, []))
        .catch((error: unknown) => classifiedFrom(error))
      reply.status(receipt.replayed ? 200 : 201).send({ data: { retraction: receipt }, meta: { traceId } })
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

  // The async research-run entry exists even when no search provider is configured, so a caller
  // always learns *why* it cannot run instead of a misleading 404 (design §10).
  {
    const workflow = dependencies.researchWorkflow
    const requireWorkflow = (): ResearchWorkflowService => {
      if (workflow === undefined) {
        capabilityNotConfigured('公共搜索/研究编排未配置，无法创建或读取研究任务。')
      }
      return workflow
    }
    // The async entry point: it pins the brief/policy/budget, creates the durable research job and
    // returns 202 with the run. The existing synchronous `POST .../research` above keeps its 201.
    app.post<{ Params: { workspaceId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/research-runs',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const active = requireWorkflow()
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        const workspaceId = request.params.workspaceId
        const researchRequest = readResearchRequest(workspaceId, body, requireIdempotencyKey(request))
        const execution = await active.start(researchRequest, contextFor(auth, traceId, workspaceId, researchRequest.allowedDomains))
          .catch((error: unknown) => classifiedFrom(error))
        reply.status(202).send({ data: { researchId: execution.researchId, jobId: execution.jobId, execution }, meta: { traceId } })
        return reply
      },
    )

    app.get<{ Params: { workspaceId: string; researchId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/research-runs/:researchId',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const active = requireWorkflow()
        const workspaceId = request.params.workspaceId
        const view = await active.get(request.params.researchId, contextFor(auth, traceId, workspaceId, []))
          .catch((error: unknown) => classifiedFrom(error))
        reply.status(200).send({ data: view, meta: { traceId } })
        return reply
      },
    )

    app.post<{ Params: { workspaceId: string; researchId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/research-runs/:researchId/cancel',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const active = requireWorkflow()
        const workspaceId = request.params.workspaceId
        const execution = await active.cancel(request.params.researchId, contextFor(auth, traceId, workspaceId, []))
          .catch((error: unknown) => classifiedFrom(error))
        reply.status(200).send({ data: { execution }, meta: { traceId } })
        return reply
      },
    )

    // Resume only a non-terminal run, reusing its original binding and budget (design §3/§10). A
    // terminal run is refused with 409; the caller appends a continuation instead.
    app.post<{ Params: { workspaceId: string; researchId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/research-runs/:researchId/resume',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const active = requireWorkflow()
        const workspaceId = request.params.workspaceId
        const execution = await active.resume(request.params.researchId, contextFor(auth, traceId, workspaceId, []))
          .catch((error: unknown) => classifiedFrom(error))
        reply.status(200).send({ data: { execution }, meta: { traceId } })
        return reply
      },
    )

    // Append research grounded in an already-ended run: a new execution with a new authorization and
    // budget, linked to the previous products (design §3/§10). It reuses the same pinned-body shape
    // as the initial run so the two entries cannot drift.
    app.post<{ Params: { workspaceId: string; researchId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/research-runs/:researchId/continuations',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const active = requireWorkflow()
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        const workspaceId = request.params.workspaceId
        const researchRequest = readResearchRequest(workspaceId, body, requireIdempotencyKey(request))
        const execution = await active.continuations(request.params.researchId, researchRequest, contextFor(auth, traceId, workspaceId, researchRequest.allowedDomains))
          .catch((error: unknown) => classifiedFrom(error))
        reply.status(202).send({ data: { researchId: execution.researchId, jobId: execution.jobId, execution }, meta: { traceId } })
        return reply
      },
    )
  }

  if (dependencies.researchPreflight !== undefined) {
    const preflight = dependencies.researchPreflight
    app.post<{ Params: { workspaceId: string } }>(
      '/api/v1/industry-workspaces/:workspaceId/research-preflights',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        rejectUnknownFields(body, ['allowedResearchDomains', 'sourceLimit', 'candidateLimit', 'deadline'])
        const workspaceId = request.params.workspaceId
        const requestedDomains = Array.isArray(body['allowedResearchDomains'])
          ? body['allowedResearchDomains'].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          : []
        const sourceLimit = readBoundedCount(body['sourceLimit'], 10, 200, 'sourceLimit')
        const candidateLimit = readBoundedCount(body['candidateLimit'], sourceLimit, 500, 'candidateLimit')
        const deadline = typeof body['deadline'] === 'string' ? body['deadline'] : new Date(Date.now() + 10 * 60 * 1000).toISOString()
        const result = await preflight({
          workspaceId,
          requestedDomains,
          limits: { sourceLimit, candidateLimit, deadline },
          policyRef: DEFAULT_RESEARCH_POLICY_REF,
          budgetRef: DEFAULT_RESEARCH_BUDGET_REF,
          requesterRoles: auth.principal.roles,
        }).catch((error: unknown) => classifiedFrom(error))
        reply.status(200).send({ data: { preflight: result }, meta: { traceId } })
        return reply
      },
    )
  }
}
