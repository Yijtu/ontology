import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  InstanceReviewError,
  isInstanceNormalizedValue,
  isUuid,
} from '@ontology/contracts'
import type {
  InstanceFieldStatus,
  InstanceNormalizedValue,
  InstancePublicationState,
  InstanceRawValue,
  RevisionString,
  ToolContext,
} from '@ontology/contracts'
import type {
  CreateInstanceRelationInput,
  FieldConfirmationDecisionInput,
  InstanceReviewService,
} from '@ontology/application'
import { createRequestToolContext } from './context'
import type { InstanceIdentityWorkflow } from '../composition/instance-identity'
import {
  authenticateRequest,
  isRecord,
  readQueryString,
  readRevisionHeader,
  readTraceId,
  ForbiddenError,
  InvalidRequestFieldError,
  CapabilityNotConfiguredError,
  readQueryInteger,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const REVIEWER_ROLES: readonly string[] = ['semantic-reviewer', 'platform-admin', 'data-editor']
const FIELD_STATUSES: readonly InstanceFieldStatus[] = ['pending', 'confirmed', 'conflict']
const PUBLICATION_STATES: readonly InstancePublicationState[] = ['draft', 'approved', 'published']
const DECISION_KINDS = ['confirm', 'conflict', 'reject'] as const
const ADJUDICATION_KINDS = ['match', 'cannot_link', 'split', 'create'] as const

export interface InstanceReviewRouteDependencies {
  readonly service: InstanceReviewService
  readonly authenticate: RequestAuthenticator
  readonly identity?: Pick<InstanceIdentityWorkflow, 'recall' | 'createRecord' | 'adjudicateIdentity' | 'validatePublication'>
  /** Host-resolved identity index source/mapping and project corpus authorization. */
  readonly identityContext?: (auth: AuthenticatedRequest, projectId: string, traceId: string) => ToolContext | Promise<ToolContext>
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || value.length < 8) {
    throw new InvalidRequestFieldError('an Idempotency-Key header (>= 8 chars) is required')
  }
  return value
}

function requireIfMatch(request: FastifyRequest): RevisionString {
  const header = readRevisionHeader(request)
  if (header.kind === 'revision') return header.value
  if (header.kind === 'absent') {
    throw new InstanceReviewError('REVISION_REQUIRED', 'this update requires an If-Match expected revision')
  }
  throw new InvalidRequestFieldError('If-Match must be a decimal revision string')
}

function assertReviewer(auth: AuthenticatedRequest): void {
  if (REVIEWER_ROLES.some((role) => auth.principal.roles.includes(role))) return
  throw new ForbiddenError('only a reviewer may confirm instance fields or adjudicate identity')
}

function readNonEmpty(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty string`)
  }
  return value
}

function parseRawValue(value: unknown): InstanceRawValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  throw new InvalidRequestFieldError('rawValue must be a string, boolean or null')
}

function parseNormalizedValue(value: unknown): InstanceNormalizedValue | undefined {
  if (value === undefined) return undefined
  if (!isInstanceNormalizedValue(value)) {
    throw new InvalidRequestFieldError('normalizedValue must be a scalar/quantity/reference object')
  }
  return value
}

function parseRelations(value: unknown): CreateInstanceRelationInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new InvalidRequestFieldError('relations must be an array')
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InvalidRequestFieldError(`relations[${String(index)}] must be an object`)
    }
    const toRecordId = entry['toRecordId']
    if (toRecordId !== undefined && !isUuid(toRecordId)) {
      throw new InvalidRequestFieldError(`relations[${String(index)}].toRecordId must be a uuid`)
    }
    return {
      relationId: readNonEmpty(entry, 'relationId'),
      relationTypeRef: readNonEmpty(entry, 'relationTypeRef'),
      ...(toRecordId === undefined ? {} : { toRecordId }),
    }
  })
}

function parseDecisions(value: unknown): FieldConfirmationDecisionInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError('decisions must be a non-empty array')
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InvalidRequestFieldError(`decisions[${String(index)}] must be an object`)
    }
    const decision = entry['decision']
    if (typeof decision !== 'string' || !(DECISION_KINDS as readonly string[]).includes(decision)) {
      throw new InvalidRequestFieldError(`decisions[${String(index)}].decision must be one of ${DECISION_KINDS.join(', ')}`)
    }
    const reason = entry['reason']
    if (reason !== undefined && typeof reason !== 'string') {
      throw new InvalidRequestFieldError(`decisions[${String(index)}].reason must be a string`)
    }
    return {
      fieldId: readNonEmpty(entry, 'fieldId'),
      decision: decision as FieldConfirmationDecisionInput['decision'],
      ...(reason === undefined ? {} : { reason }),
    }
  })
}

/**
 * The public instance review surface (SPEC v0.3a §3.3/§3.4/§8.1, A.US-004, P.US-008/010/014).
 * It exposes the key-field confirmation and identity adjudication a reviewer needs, alongside
 * the existing extraction-candidate decision routes. Identity, scope and trace id come from the
 * server-side authenticator, never the body; every write requires If-Match and a replayed
 * Idempotency-Key, and `approve` and `publish` are deliberately separate routes.
 */
export function registerInstanceReviewRoutes(
  app: FastifyInstance,
  dependencies: InstanceReviewRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: resourceId })
  const scopeFor = (auth: AuthenticatedRequest) => ({ tenantId: auth.principal.tenantId, spaceId: auth.spaceId })
  const identityContextFor = (auth: AuthenticatedRequest, projectId: string, traceId: string) =>
    dependencies.identityContext?.(auth, projectId, traceId) ?? contextFor(auth, traceId, projectId)
  const requireIdentity = () => {
    if (dependencies.identity === undefined) throw new CapabilityNotConfiguredError('instance identity recall is not configured')
    return dependencies.identity
  }

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/identity-recall',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const candidateId = readQueryString(request, 'candidateId')
      const documentId = readQueryString(request, 'documentId')
      if (!isUuid(candidateId) || !isUuid(documentId)) throw new InvalidRequestFieldError('candidateId and documentId must be UUIDs')
      const projectId = request.params.projectId
      const recall = await requireIdentity().recall(scopeFor(auth), projectId, candidateId, documentId, await identityContextFor(auth, projectId, traceId), readQueryInteger(request, 'limit'))
      reply.status(200).send({ data: { recall }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/instance-records',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const projectId = request.params.projectId
      const status = readQueryString(request, 'status')
      if (status !== undefined && !(FIELD_STATUSES as readonly string[]).includes(status)) {
        throw new InvalidRequestFieldError(`status must be one of ${FIELD_STATUSES.join(', ')}`)
      }
      const publicationState = readQueryString(request, 'publicationState')
      if (
        publicationState !== undefined &&
        !(PUBLICATION_STATES as readonly string[]).includes(publicationState)
      ) {
        throw new InvalidRequestFieldError(`publicationState must be one of ${PUBLICATION_STATES.join(', ')}`)
      }
      const records = await dependencies.service.listRecords(
        scopeFor(auth),
        projectId,
        {
          ...(status === undefined ? {} : { status: status as InstanceFieldStatus }),
          ...(publicationState === undefined
            ? {}
            : { publicationState: publicationState as InstancePublicationState }),
        },
        contextFor(auth, traceId, projectId),
      )
      reply.status(200).send({ data: { records }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { projectId: string; recordId: string } }>(
    '/api/v1/projects/:projectId/instance-records/:recordId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { projectId, recordId } = request.params
      const record = await dependencies.service.getRecord(
        scopeFor(auth),
        projectId,
        recordId,
        contextFor(auth, traceId, recordId),
      )
      reply.status(200).send({ data: { record }, meta: { traceId, revision: record.recordRevision } })
      return reply
    },
  )

  app.get<{ Params: { projectId: string; recordId: string } }>(
    '/api/v1/projects/:projectId/instance-records/:recordId/confirmations',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { projectId, recordId } = request.params
      const confirmations = await dependencies.service.listConfirmations(
        scopeFor(auth),
        projectId,
        recordId,
        contextFor(auth, traceId, recordId),
      )
      reply.status(200).send({ data: { confirmations }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/instance-records',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const projectId = request.params.projectId
      if (body['identityCandidates'] !== undefined) {
        throw new InvalidRequestFieldError('identityCandidates are server recalled; submit stored candidateId and documentId')
      }
      const candidateId = readNonEmpty(body, 'candidateId')
      const documentId = readNonEmpty(body, 'documentId')
      if (!isUuid(candidateId) || !isUuid(documentId)) throw new InvalidRequestFieldError('candidateId and documentId must be UUIDs')
      const outcome = await requireIdentity().createRecord(
        scopeFor(auth), projectId,
        { candidateId, documentId, relations: parseRelations(body['relations']), idempotencyKey: requireIdempotencyKey(request) },
        await identityContextFor(auth, projectId, traceId),
      )
      const { record } = outcome
      reply.status(201).send({ data: outcome, meta: { traceId, revision: record.recordRevision } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string; recordId: string } }>(
    '/api/v1/projects/:projectId/instance-records/:recordId/field-edits',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      assertReviewer(auth)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const { projectId, recordId } = request.params
      const normalized = parseNormalizedValue(body['normalizedValue'])
      const record = await dependencies.service.editField(
        scopeFor(auth),
        projectId,
        recordId,
        {
          expectedRevision: requireIfMatch(request),
          fieldId: readNonEmpty(body, 'fieldId'),
          ...(body['rawValue'] === undefined ? {} : { rawValue: parseRawValue(body['rawValue']) }),
          ...(normalized === undefined ? {} : { normalizedValue: normalized }),
          reason: readNonEmpty(body, 'reason'),
          idempotencyKey: requireIdempotencyKey(request),
        },
        contextFor(auth, traceId, recordId),
      )
      reply.status(200).send({ data: { record }, meta: { traceId, revision: record.recordRevision } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string; recordId: string } }>(
    '/api/v1/projects/:projectId/instance-records/:recordId/field-confirmations',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      assertReviewer(auth)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const { projectId, recordId } = request.params
      const outcome = await dependencies.service.confirmFields(
        scopeFor(auth),
        projectId,
        recordId,
        {
          expectedRevision: requireIfMatch(request),
          decisions: parseDecisions(body['decisions']),
          idempotencyKey: requireIdempotencyKey(request),
        },
        contextFor(auth, traceId, recordId),
      )
      reply.status(200).send({ data: outcome, meta: { traceId, revision: outcome.record.recordRevision } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string; recordId: string } }>(
    '/api/v1/projects/:projectId/instance-records/:recordId/identity-decisions',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      assertReviewer(auth)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const kind = body['kind']
      if (typeof kind !== 'string' || !(ADJUDICATION_KINDS as readonly string[]).includes(kind)) {
        throw new InvalidRequestFieldError(`kind must be one of ${ADJUDICATION_KINDS.join(', ')}`)
      }
      const { projectId, recordId } = request.params
      const targetEntityId = body['targetEntityId']
      if (targetEntityId !== undefined && typeof targetEntityId !== 'string') {
        throw new InvalidRequestFieldError('targetEntityId must be a string')
      }
      const record = await requireIdentity().adjudicateIdentity(
        scopeFor(auth),
        projectId,
        recordId,
        {
          expectedRevision: requireIfMatch(request),
          kind: kind as 'match' | 'cannot_link' | 'split' | 'create',
          ...(targetEntityId === undefined ? {} : { targetEntityId }),
          reason: readNonEmpty(body, 'reason'),
          idempotencyKey: requireIdempotencyKey(request),
        },
        await identityContextFor(auth, projectId, traceId),
      )
      reply.status(200).send({ data: { record }, meta: { traceId, revision: record.recordRevision } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string; recordId: string } }>(
    '/api/v1/projects/:projectId/instance-records/:recordId/approve',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      assertReviewer(auth)
      const { projectId, recordId } = request.params
      await requireIdentity().validatePublication(scopeFor(auth), projectId, recordId, await identityContextFor(auth, projectId, traceId))
      const record = await dependencies.service.approve(
        scopeFor(auth),
        projectId,
        recordId,
        { expectedRevision: requireIfMatch(request), idempotencyKey: requireIdempotencyKey(request) },
        contextFor(auth, traceId, recordId),
      )
      reply.status(200).send({ data: { record }, meta: { traceId, revision: record.recordRevision } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string; recordId: string } }>(
    '/api/v1/projects/:projectId/instance-records/:recordId/publish',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      assertReviewer(auth)
      const { projectId, recordId } = request.params
      await requireIdentity().validatePublication(scopeFor(auth), projectId, recordId, await identityContextFor(auth, projectId, traceId))
      const record = await dependencies.service.publish(
        scopeFor(auth),
        projectId,
        recordId,
        { expectedRevision: requireIfMatch(request), idempotencyKey: requireIdempotencyKey(request) },
        contextFor(auth, traceId, recordId),
      )
      reply.status(200).send({ data: { record }, meta: { traceId, revision: record.recordRevision } })
      return reply
    },
  )
}
