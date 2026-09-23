import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { createRequestToolContext } from './context'
import { authenticateRequest, ForbiddenError, InvalidRequestFieldError, isRecord, readHeader, readTraceId } from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'
import type { LocalCandidateLifecycle } from '../composition/local-candidate-lifecycle'
import type { LocalDocumentCapability } from '../composition/local-documents'
import type { LocalOperatorSqlProfile } from '../composition/registered-operator-sql'

const EDITOR_ROLES = ['data-editor', 'platform-admin'] as const
const REVIEWER_ROLES = ['semantic-reviewer', 'platform-admin'] as const

export function registerLocalCandidateRoutes(app: FastifyInstance, dependencies: {
  readonly authenticate: RequestAuthenticator
  readonly lifecycle: LocalCandidateLifecycle
  readonly documents: LocalDocumentCapability
  readonly sql: LocalOperatorSqlProfile
  readonly tenantId: string
  readonly spaceId: string
}): void {
  app.get('/api/v1/operator/sql-source', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    requireRole(auth, EDITOR_ROLES)
    const mappingRef = dependencies.sql.resolvedProfile.mappingRefs.find((entry) => entry.id === dependencies.sql.identityIndexProfile.mappingRef.id)
    reply.status(200).send({ data: {
      status: 'ready', profileRef: dependencies.sql.profileRef, sourceRef: dependencies.sql.sourceRef,
      objectRef: dependencies.sql.objectRef, mappingRef, readOnly: true,
      definitionRef: dependencies.sql.resolvedProfile.industryRef,
      limits: { maxRows: dependencies.sql.maxRows, maxConcurrency: 2, queryTimeoutMs: 10_000 },
      credentials: 'server-configured; never returned by this endpoint',
    }, meta: { traceId } })
    return reply
  })

  app.post<{ Params: { parseId: string } }>('/api/v1/operator/documents/:parseId/extract-candidates', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    requireRole(auth, EDITOR_ROLES)
    if (request.body !== undefined && (!isRecord(request.body) || Object.keys(request.body).length > 0)) throw new InvalidRequestFieldError('candidate extraction does not accept model, schema, or source overrides')
    const idempotencyKey = readHeader(request, 'idempotency-key')
    if (idempotencyKey === undefined) throw new InvalidRequestFieldError('Idempotency-Key is required')
    const ctx = contextFor(auth, traceId, randomUUID(), dependencies)
    const result = await dependencies.lifecycle.ingestion.extract(request.params.parseId, idempotencyKey, ctx)
    reply.status(202).send({ data: result, meta: { traceId, revision: '0' } })
    return reply
  })

  app.post<{ Params: { candidateId: string } }>('/api/v1/candidates/:candidateId/identity-recall', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    requireRole(auth, REVIEWER_ROLES)
    if (request.body !== undefined && (!isRecord(request.body) || Object.keys(request.body).length !== 0)) throw new InvalidRequestFieldError('identity recall inputs are derived from the stored candidate; request overrides are not accepted')
    const scope: ScopeRef = { tenantId: auth.principal.tenantId, spaceId: auth.spaceId }
    const ctx = contextFor(auth, traceId, request.params.candidateId, dependencies)
    const candidate = await dependencies.lifecycle.candidates.getCandidate(scope, request.params.candidateId, ctx)
    if (candidate === undefined || candidate.kind !== 'entity') throw new InvalidRequestFieldError('identity recall requires a visible entity candidate')
    if (candidate.sourceSpans.length !== 1) throw new InvalidRequestFieldError('identity recall requires exactly one source-bound entity mention')
    const source = candidate.sourceSpans[0]
    if (source === undefined) throw new InvalidRequestFieldError('the candidate has no source span')
    const document = await dependencies.documents.loadParsedDocument(source.parseId, ctx)
    const chunk = document.chunks.find((entry) => entry.chunkId === source.chunkId)
    if (chunk === undefined || chunk.textDigest !== source.textDigest || chunk.truncated || chunk.precision !== 'exact') {
      throw new InvalidRequestFieldError('candidate source span is missing, changed, or incomplete')
    }
    const attributes = new Map(candidate.attributes.map((attribute) => [attribute.attributeId, attribute.value]))
    const observedText = attributes.get('facility_name') ?? attributes.get('facility_key')
    const district = attributes.get('district')
    if (typeof observedText !== 'string' || typeof district !== 'string') throw new InvalidRequestFieldError('candidate is missing its declared name or district identity dimension')
    const result = await dependencies.lifecycle.recall.recall({
      definitionRef: candidate.inputVersion.definitionRef,
      candidate,
      observedText,
      scopeDimensionValues: { district },
      limit: 20,
      allowSimilarity: false,
    }, ctx)
    const queryDigest = sha256DigestOf(JSON.stringify({ candidateId: candidate.candidateId, definitionRef: candidate.inputVersion.definitionRef, observedText, district, limit: 20, allowSimilarity: false }))
    const audit = await dependencies.lifecycle.recallAudits.record({
      auditId: randomUUID(), scopeRef: scope, candidateId: candidate.candidateId,
      definitionRef: candidate.inputVersion.definitionRef, queryDigest, result, recordedAt: new Date().toISOString(),
    }, ctx)
    reply.status(200).send({ data: { auditId: audit.auditId, queryDigest: audit.queryDigest, resultDigest: audit.resultDigest, result: audit.result, decisionOptions: ['match', 'create_pending', 'clarify', 'reject'], similarity: { configured: false, reason: 'NOT_CONFIGURED' } }, meta: { traceId } })
    return reply
  })

  app.get<{ Params: { auditId: string } }>('/api/v1/candidate-identity-recalls/:auditId', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    requireRole(auth, REVIEWER_ROLES)
    const ctx = contextFor(auth, traceId, request.params.auditId, dependencies)
    const audit = await dependencies.lifecycle.recallAudits.get(request.params.auditId, ctx)
    if (audit === undefined) throw new InvalidRequestFieldError('identity recall audit is not visible in this tenant/space')
    reply.status(200).send({ data: audit, meta: { traceId } })
    return reply
  })
}

function requireRole(auth: AuthenticatedRequest, roles: readonly string[]): void {
  if (roles.some((role) => auth.principal.roles.includes(role))) return
  throw new ForbiddenError(`this candidate operation requires ${roles.join(' or ')}`)
}

function contextFor(auth: AuthenticatedRequest, traceId: string, runId: string, dependencies: { readonly tenantId: string; readonly spaceId: string }): ToolContext {
  return createRequestToolContext({
    principal: auth.principal, spaceId: dependencies.spaceId, traceId, runId,
    allowedResourceKinds: ['artifact', 'dataset', 'document', 'evidence'],
    allowedSourceRefs: auth.allowedSourceRefs ?? [], allowedCollectionRefs: auth.allowedCollectionRefs ?? [], maxRows: 100,
  })
}
