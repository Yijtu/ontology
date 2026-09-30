import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  PROJECT_READINESS_KINDS,
  isResourceRef,
  isRevisionString,
  isSha256Digest,
  isVersionRef,
} from '@ontology/contracts'
import type {
  LogicalRole,
  MappingRef,
  ProjectReadinessKind,
  ProjectState,
  ResolvedProfileRef,
  ResourceRef,
  RevisionString,
  SourceObjectRef,
  VersionRef,
} from '@ontology/contracts'
import type {
  CreateProjectInput,
  MountPackVersionInput,
  ProjectService,
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

const PROJECT_STATES: readonly ProjectState[] = ['draft', 'active', 'archived']
const LOGICAL_ROLES: readonly LogicalRole[] = ['telemetry', 'catalog', 'documents']
const CREATE_FIELDS = [
  'title',
  'industryPackRef',
  'profileRef',
  'mappingRefs',
  'documentSetRef',
  'semanticPublicationRefs',
  'sourceVisibilityEpoch',
] as const
const MOUNT_FIELDS = ['industryPackRef', 'reason', 'profileRef', 'mappingRefs', 'documentSetRef'] as const
const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 250

export interface ProjectRouteDependencies {
  readonly service: ProjectService
  readonly authenticate: RequestAuthenticator
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw new InvalidRequestFieldError(`field ${key} is not accepted by this route`)
    }
  }
}

function parseVersionRef(value: unknown, field: string): VersionRef {
  if (!isVersionRef(value)) {
    throw new InvalidRequestFieldError(`${field} must carry id/version/digest strings`)
  }
  return value
}

function parseResourceRef(value: unknown, field: string): ResourceRef {
  if (!isResourceRef(value)) {
    throw new InvalidRequestFieldError(`${field} must carry a uuid id, version, sha256 digest and kind`)
  }
  return value
}

function parseResolvedProfileRef(value: unknown): ResolvedProfileRef {
  if (!isRecord(value) || typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new InvalidRequestFieldError('profileRef must carry a non-empty id')
  }
  if (typeof value['version'] !== 'string' || value['version'].length === 0) {
    throw new InvalidRequestFieldError('profileRef.version must be a non-empty string')
  }
  if (!isSha256Digest(value['snapshotHash'])) {
    throw new InvalidRequestFieldError('profileRef.snapshotHash must be a sha256 digest')
  }
  return { id: value['id'], version: value['version'], snapshotHash: value['snapshotHash'] }
}

function parseSourceObjectRef(value: unknown, field: string): SourceObjectRef {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  const sourceRef = value['sourceRef']
  const objectPath = value['objectPath']
  if (
    !isRecord(sourceRef) ||
    typeof sourceRef['namespace'] !== 'string' ||
    sourceRef['namespace'].length === 0 ||
    typeof sourceRef['sourceId'] !== 'string' ||
    sourceRef['sourceId'].length === 0
  ) {
    throw new InvalidRequestFieldError(`${field}.sourceRef must carry a namespace and sourceId`)
  }
  if (typeof objectPath !== 'string' || objectPath.length === 0) {
    throw new InvalidRequestFieldError(`${field}.objectPath must be a non-empty string`)
  }
  return {
    sourceRef: { namespace: sourceRef['namespace'], sourceId: sourceRef['sourceId'] },
    objectPath,
  }
}

function parseMappingRefs(value: unknown, field: string): MappingRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty mapping array`)
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new InvalidRequestFieldError(`${field}[${String(index)}] must be an object`)
    const { id, version, digest, role } = entry
    if (typeof id !== 'string' || id.length === 0) {
      throw new InvalidRequestFieldError(`${field}[${String(index)}].id must be a non-empty string`)
    }
    if (typeof version !== 'string' || version.length === 0) {
      throw new InvalidRequestFieldError(`${field}[${String(index)}].version must be a non-empty string`)
    }
    if (!isSha256Digest(digest)) {
      throw new InvalidRequestFieldError(`${field}[${String(index)}].digest must be a sha256 digest`)
    }
    if (typeof role !== 'string' || !(LOGICAL_ROLES as readonly string[]).includes(role)) {
      throw new InvalidRequestFieldError(`${field}[${String(index)}].role must be one of ${LOGICAL_ROLES.join(', ')}`)
    }
    return {
      id,
      version,
      digest,
      role: role as LogicalRole,
      sourceObjectRef: parseSourceObjectRef(entry['sourceObjectRef'], `${field}[${String(index)}].sourceObjectRef`),
    }
  })
}

function parseVersionRefArray(value: unknown, field: string): VersionRef[] {
  if (!Array.isArray(value)) throw new InvalidRequestFieldError(`${field} must be an array`)
  return value.map((entry, index) => parseVersionRef(entry, `${field}[${String(index)}]`))
}

function parseRequiredReadiness(request: FastifyRequest): readonly ProjectReadinessKind[] | undefined {
  const raw = readQueryString(request, 'required') ?? readQueryString(request, 'requiredReadiness')
  if (raw === undefined) return undefined
  const kinds = raw.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  for (const kind of kinds) {
    if (!PROJECT_READINESS_KINDS.includes(kind as ProjectReadinessKind)) {
      throw new InvalidRequestFieldError(`required readiness must be a subset of ${PROJECT_READINESS_KINDS.join(', ')}`)
    }
  }
  return kinds as ProjectReadinessKind[]
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined) throw new InvalidRequestFieldError('an Idempotency-Key header is required')
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
 * The customer-project, version-mounting and readiness surface (SPEC v0.3a §3.2/§6/§8.1).
 *
 * Identity, scope and trace id come from the server-side authenticator, never the body. Reads
 * list the immutable revisions and their readiness projections; every write requires
 * If-Match/CAS and an Idempotency-Key. A project can only mount an exact published pack version,
 * and a revision whose required projection is not `ready` is reported with explicit blockers
 * rather than being presented as queryable.
 */
export function registerProjectRoutes(
  app: FastifyInstance,
  dependencies: ProjectRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: resourceId,
    })

  app.post('/api/v1/projects', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const body = request.body
    if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    rejectUnknownFields(body, CREATE_FIELDS)
    const title = body['title']
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new InvalidRequestFieldError('title must be a non-empty string')
    }
    const epoch = body['sourceVisibilityEpoch']
    if (epoch !== undefined && !isRevisionString(epoch)) {
      throw new InvalidRequestFieldError('sourceVisibilityEpoch must be a decimal revision string')
    }
    const input: CreateProjectInput = {
      title,
      industryPackRef: parseVersionRef(body['industryPackRef'], 'industryPackRef'),
      profileRef: parseResolvedProfileRef(body['profileRef']),
      mappingRefs: parseMappingRefs(body['mappingRefs'], 'mappingRefs'),
      documentSetRef: parseResourceRef(body['documentSetRef'], 'documentSetRef'),
      ...(body['semanticPublicationRefs'] === undefined
        ? {}
        : { semanticPublicationRefs: parseVersionRefArray(body['semanticPublicationRefs'], 'semanticPublicationRefs') }),
      ...(typeof epoch === 'string' ? { sourceVisibilityEpoch: epoch } : {}),
    }
    const result = await dependencies.service.createProject(
      input,
      requireIdempotencyKey(request),
      auth.principal.subjectId,
      contextFor(auth, traceId, 'project-create'),
    )
    reply.status(201).send({
      data: { project: result.project, revision: result.revision, created: result.created },
      meta: { traceId, revision: result.project.headRevision },
    })
    return reply
  })

  app.get('/api/v1/projects', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(dependencies.authenticate, request, reply)
    if (auth === undefined) return reply
    const state = readQueryString(request, 'state')
    if (state !== undefined && !(PROJECT_STATES as readonly string[]).includes(state)) {
      throw new InvalidRequestFieldError(`state must be one of ${PROJECT_STATES.join(', ')}`)
    }
    const pageSize = readPageSize(request)
    const projects = await dependencies.service.listProjects(
      {
        ...(state === undefined ? {} : { state: state as ProjectState }),
        limit: pageSize ?? DEFAULT_PAGE_SIZE,
      },
      contextFor(auth, traceId, 'project-list'),
    )
    reply.status(200).send({ data: { projects }, meta: { traceId } })
    return reply
  })

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const projectId = request.params.projectId
      const project = await dependencies.service.getProject(
        projectId,
        contextFor(auth, traceId, projectId),
      )
      reply.status(200).send({
        data: { project },
        meta: { traceId, revision: project.headRevision },
      })
      return reply
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/revisions',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const projectId = request.params.projectId
      const revisions = await dependencies.service.listRevisions(
        projectId,
        contextFor(auth, traceId, projectId),
      )
      reply.status(200).send({ data: { revisions }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { projectId: string; revision: string } }>(
    '/api/v1/projects/:projectId/revisions/:revision',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { projectId, revision } = request.params
      const view = await dependencies.service.getRevisionView(
        projectId,
        revision,
        contextFor(auth, traceId, projectId),
      )
      reply.status(200).send({
        data: {
          revision: view.revision,
          readiness: view.readiness,
          historical: view.historical,
        },
        meta: { traceId, revision: view.revision.ref.revision },
      })
      return reply
    },
  )

  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/pack-mounts',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      rejectUnknownFields(body, MOUNT_FIELDS)
      const reason = body['reason']
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new InvalidRequestFieldError('reason must be a non-empty string')
      }
      const projectId = request.params.projectId
      const input: MountPackVersionInput = {
        expectedRevision: readIfMatch(request),
        industryPackRef: parseVersionRef(body['industryPackRef'], 'industryPackRef'),
        reason,
        ...(body['profileRef'] === undefined ? {} : { profileRef: parseResolvedProfileRef(body['profileRef']) }),
        ...(body['mappingRefs'] === undefined
          ? {}
          : { mappingRefs: parseMappingRefs(body['mappingRefs'], 'mappingRefs') }),
        ...(body['documentSetRef'] === undefined
          ? {}
          : { documentSetRef: parseResourceRef(body['documentSetRef'], 'documentSetRef') }),
      }
      const result = await dependencies.service.mountPackVersion(
        projectId,
        input,
        requireIdempotencyKey(request),
        auth.principal.subjectId,
        contextFor(auth, traceId, projectId),
      )
      reply.status(200).send({
        data: {
          project: result.project,
          revision: result.revision,
          previousRevision: result.previousRevision,
          changes: result.changes,
          readinessInvalidated: result.readinessInvalidated,
          created: result.created,
        },
        meta: { traceId, revision: result.project.headRevision },
      })
      return reply
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/readiness',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const projectId = request.params.projectId
      const revision = readQueryString(request, 'revision')
      const view = await dependencies.service.getReadiness(
        projectId,
        revision,
        parseRequiredReadiness(request),
        contextFor(auth, traceId, projectId),
      )
      reply.status(200).send({
        data: {
          projectRevisionRef: view.projectRevisionRef,
          projections: view.projections,
          requiredReadiness: view.requiredReadiness,
          ready: view.ready,
          blockers: view.blockers,
        },
        meta: { traceId, revision: view.projectRevisionRef.revision },
      })
      return reply
    },
  )
}
