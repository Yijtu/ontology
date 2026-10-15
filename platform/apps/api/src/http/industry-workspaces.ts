import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  assertIndustryWorkspaceBoundaryShape,
  isResourceRef,
  isUuid,
  isVersionRef,
} from '@ontology/contracts'
import type {
  AssetDraftCandidateRef,
  IndustryWorkspaceBoundary,
  IndustryWorkspaceState,
  ResourceRef,
  RevisionString,
  VersionRef,
} from '@ontology/contracts'
import type {
  CreateIndustryWorkspaceInput,
  DraftOperationInput,
  EditIndustryWorkspaceInput,
  IndustryWorkspaceService,
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

const WORKSPACE_STATES: readonly IndustryWorkspaceState[] = ['draft', 'review', 'published', 'archived']
const PATCH_FIELDS = ['displayName', 'boundary', 'reason'] as const
const DRAFT_OPERATION_FIELDS = [
  'operation',
  'reason',
  'displayName',
  'boundary',
  'documentSetRef',
  'candidateRefs',
  'basePackRef',
  'syntheticExampleSetRef',
  'validationRef',
] as const
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 250

export interface IndustryWorkspaceRouteDependencies {
  readonly service: IndustryWorkspaceService
  readonly authenticate: RequestAuthenticator
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new InvalidRequestFieldError(`field ${key} is not accepted by this route`)
    }
  }
}

function parseBoundary(value: unknown): IndustryWorkspaceBoundary {
  try {
    assertIndustryWorkspaceBoundaryShape(value)
  } catch {
    throw new InvalidRequestFieldError(
      'boundary must carry goals/included/excluded string arrays and an applicability object',
    )
  }
  // The JSON Schema is `additionalProperties: false`; the hand-written guard is lenient about
  // unknown keys, so reject them here to keep the stored and returned shape schema-valid.
  if (!isRecord(value)) throw new InvalidRequestFieldError('boundary must be a JSON object')
  rejectUnknownFields(value, ['goals', 'included', 'excluded', 'applicability'])
  const applicability = value['applicability']
  if (isRecord(applicability)) {
    rejectUnknownFields(applicability, ['region', 'validFrom', 'validTo'])
  }
  return value
}

function parseResourceRef(value: unknown, field: string): ResourceRef {
  if (!isResourceRef(value)) {
    throw new InvalidRequestFieldError(`${field} must carry a uuid id, version, sha256 digest and kind`)
  }
  return value
}

function parseVersionRef(value: unknown, field: string): VersionRef {
  if (!isVersionRef(value)) {
    throw new InvalidRequestFieldError(`${field} must carry id/version/digest strings`)
  }
  return value
}

function parseCandidateRefs(value: unknown, field: string): readonly AssetDraftCandidateRef[] {
  if (!Array.isArray(value)) {
    throw new InvalidRequestFieldError(`${field} must be an array of candidate references`)
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new InvalidRequestFieldError(`${field}[${String(index)}] must be an object`)
    }
    const { logicalId, candidateId, digest } = entry
    if (
      typeof logicalId !== 'string' ||
      logicalId.length === 0 ||
      !isUuid(candidateId) ||
      typeof digest !== 'string'
    ) {
      throw new InvalidRequestFieldError(
        `${field}[${String(index)}] must carry logicalId, a uuid candidateId and a digest`,
      )
    }
    return { logicalId, candidateId, digest }
  })
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

function readPageSize(request: FastifyRequest): number | undefined {
  const raw = readQueryInteger(request, 'pageSize') ?? readQueryInteger(request, 'limit')
  if (raw === undefined) return undefined
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new InvalidRequestFieldError('pageSize must be a positive integer')
  }
  return Math.min(raw, MAX_PAGE_SIZE)
}

/**
 * The industry-workspace management surface (SPEC v0.3a §8.1).
 *
 * It reuses the shared Fastify envelope and the trusted request context: identity, scope and
 * trace id come from the server-side authenticator, never the body. Reads are available to any
 * authenticated principal in scope; every write is gated by the service on an existing editor
 * role and uses If-Match/CAS. There is deliberately no route that sets the published state, so
 * a model or an ordinary project user cannot publish a definition through this surface.
 */
export function registerIndustryWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: IndustryWorkspaceRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: resourceId,
    })

  app.post('/api/v1/industry-workspaces', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const body = request.body
    if (!isRecord(body)) {
      throw new InvalidRequestFieldError('the request body must be a JSON object')
    }
    rejectUnknownFields(body, ['namespace', 'displayName', 'boundary', 'documentSetRef'])
    const namespace = body['namespace']
    const displayName = body['displayName']
    if (typeof namespace !== 'string' || namespace.trim().length === 0) {
      throw new InvalidRequestFieldError('namespace must be a non-empty string')
    }
    if (typeof displayName !== 'string' || displayName.trim().length === 0) {
      throw new InvalidRequestFieldError('displayName must be a non-empty string')
    }
    const input: CreateIndustryWorkspaceInput = {
      namespace,
      displayName,
      boundary: parseBoundary(body['boundary']),
      documentSetRef: parseResourceRef(body['documentSetRef'], 'documentSetRef'),
    }
    const result = await dependencies.service.createWorkspace(
      input,
      requireIdempotencyKey(request),
      auth.principal.subjectId,
      contextFor(auth, traceId, 'industry-workspace-create'),
    )
    reply.status(201).send({
      data: {
        workspace: result.workspace,
        draftRef: {
          workspaceId: result.draft.workspaceId,
          revision: result.draft.revision,
          digest: result.draft.digest,
        },
        draft: result.draft,
        created: result.created,
      },
      meta: { traceId, revision: result.workspace.headRevision },
    })
    return reply
  })

  app.get('/api/v1/industry-workspaces', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const state = readQueryString(request, 'state')
    if (state !== undefined && !(WORKSPACE_STATES as readonly string[]).includes(state)) {
      throw new InvalidRequestFieldError(`state must be one of ${WORKSPACE_STATES.join(', ')}`)
    }
    const pageSize = readPageSize(request)
    const workspaces = await dependencies.service.listWorkspaces(
      {
        ...(state === undefined ? {} : { state: state as IndustryWorkspaceState }),
        limit: pageSize ?? DEFAULT_PAGE_SIZE,
      },
      contextFor(auth, traceId, 'industry-workspace-list'),
    )
    reply.status(200).send({ data: { workspaces }, meta: { traceId } })
    return reply
  })

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const workspace = await dependencies.service.getWorkspace(
        workspaceId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({
        data: { workspace },
        meta: { traceId, revision: workspace.headRevision },
      })
      return reply
    },
  )

  app.patch<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const body = request.body
      if (!isRecord(body)) {
        throw new InvalidRequestFieldError('the request body must be a JSON object')
      }
      rejectUnknownFields(body, PATCH_FIELDS)
      const reason = body['reason']
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new InvalidRequestFieldError('reason must be a non-empty string')
      }
      const displayName = body['displayName']
      if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length === 0)) {
        throw new InvalidRequestFieldError('displayName must be a non-empty string')
      }
      const input: EditIndustryWorkspaceInput = {
        expectedRevision: readIfMatch(request),
        reason,
        ...(typeof displayName === 'string' ? { displayName } : {}),
        ...(body['boundary'] === undefined ? {} : { boundary: parseBoundary(body['boundary']) }),
      }
      const result = await dependencies.service.editWorkspace(
        workspaceId,
        input,
        requireIdempotencyKey(request),
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({
        data: {
          workspace: result.workspace,
          draftRef: {
            workspaceId: result.draft.workspaceId,
            revision: result.draft.revision,
            digest: result.draft.digest,
          },
          changes: result.changes,
          created: result.created,
        },
        meta: { traceId, revision: result.workspace.headRevision },
      })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/drafts',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const drafts = await dependencies.service.listDrafts(
        workspaceId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { drafts }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string; revision: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/drafts/:revision',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const revision = request.params.revision
      const draft = await dependencies.service.getDraft(
        workspaceId,
        revision,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { draft }, meta: { traceId, revision: draft.revision } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/draft-operations',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const body = request.body
      if (!isRecord(body)) {
        throw new InvalidRequestFieldError('the request body must be a JSON object')
      }
      rejectUnknownFields(body, DRAFT_OPERATION_FIELDS)
      if (body['operation'] !== 'edit') {
        throw new InvalidRequestFieldError("operation must be 'edit'")
      }
      const reason = body['reason']
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new InvalidRequestFieldError('reason must be a non-empty string')
      }
      const displayName = body['displayName']
      if (displayName !== undefined && (typeof displayName !== 'string' || displayName.trim().length === 0)) {
        throw new InvalidRequestFieldError('displayName must be a non-empty string')
      }
      const input: DraftOperationInput = {
        operation: 'edit',
        expectedRevision: readIfMatch(request),
        reason,
        ...(typeof displayName === 'string' ? { displayName } : {}),
        ...(body['boundary'] === undefined ? {} : { boundary: parseBoundary(body['boundary']) }),
        ...(body['documentSetRef'] === undefined
          ? {}
          : { documentSetRef: parseResourceRef(body['documentSetRef'], 'documentSetRef') }),
        ...(body['candidateRefs'] === undefined
          ? {}
          : { candidateRefs: parseCandidateRefs(body['candidateRefs'], 'candidateRefs') }),
        ...(body['basePackRef'] === undefined
          ? {}
          : { basePackRef: parseVersionRef(body['basePackRef'], 'basePackRef') }),
        ...(body['syntheticExampleSetRef'] === undefined
          ? {}
          : {
              syntheticExampleSetRef: parseResourceRef(
                body['syntheticExampleSetRef'],
                'syntheticExampleSetRef',
              ),
            }),
        ...(body['validationRef'] === undefined
          ? {}
          : { validationRef: parseResourceRef(body['validationRef'], 'validationRef') }),
      }
      const result = await dependencies.service.draftOperation(
        workspaceId,
        input,
        requireIdempotencyKey(request),
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({
        data: {
          workspace: result.workspace,
          draftRef: {
            workspaceId: result.draft.workspaceId,
            revision: result.draft.revision,
            digest: result.draft.digest,
          },
          changes: result.changes,
          created: result.created,
        },
        meta: { traceId, revision: result.workspace.headRevision },
      })
      return reply
    },
  )
}
