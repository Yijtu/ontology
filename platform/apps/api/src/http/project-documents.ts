import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  isRecord,
  isResourceRef,
  isSha256Digest,
  isUuid,
} from '@ontology/contracts'
import type {
  ProjectDocumentIndexStatus,
  ProjectDocumentSearchRequest,
  ProjectDocumentSearchResult,
  RegisterProjectDocumentInput,
  ReviseProjectDocumentInput,
  SourceRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  readHeader,
  readTraceId,
  ForbiddenError,
  InvalidRequestFieldError,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const EDITOR_ROLES: readonly string[] = ['platform-admin', 'data-editor', 'operator']

/**
 * Structural view of the project document index service. The route group depends
 * only on this shape (and therefore only on `@ontology/contracts`) rather than on
 * the BM25 adapter package, so the HTTP layer stays a thin boundary.
 */
export interface ProjectDocumentService {
  importDocument(
    projectId: Uuid,
    input: RegisterProjectDocumentInput,
    ctx: ToolContext,
  ): Promise<ProjectDocumentIndexStatus>
  reviseDocument(
    projectId: Uuid,
    input: ReviseProjectDocumentInput,
    ctx: ToolContext,
  ): Promise<ProjectDocumentIndexStatus>
  buildIndex(projectId: Uuid, ctx: ToolContext): Promise<ProjectDocumentIndexStatus>
  getStatus(projectId: Uuid, ctx: ToolContext): Promise<ProjectDocumentIndexStatus>
  search(request: ProjectDocumentSearchRequest, ctx: ToolContext): Promise<ProjectDocumentSearchResult>
}

export interface ProjectDocumentRouteDependencies {
  readonly service: ProjectDocumentService
  readonly authenticate: RequestAuthenticator
}

function contextFor(auth: AuthenticatedRequest, traceId: string, resourceId: string): ToolContext {
  return createRequestToolContext({
    principal: auth.principal,
    spaceId: auth.spaceId,
    traceId,
    runId: resourceId,
  })
}

function requireEditor(auth: AuthenticatedRequest): void {
  if (!EDITOR_ROLES.some((role) => auth.principal.roles.includes(role))) {
    throw new ForbiddenError('managing a project document corpus requires an operator role')
  }
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined) throw new InvalidRequestFieldError('an Idempotency-Key header is required')
  return key
}

function parseSourceRef(value: unknown, field: string): SourceRef {
  if (
    !isRecord(value) ||
    typeof value['namespace'] !== 'string' ||
    value['namespace'].length === 0 ||
    typeof value['sourceId'] !== 'string' ||
    value['sourceId'].length === 0
  ) {
    throw new InvalidRequestFieldError(`${field} must carry a namespace and sourceId`)
  }
  return { namespace: value['namespace'], sourceId: value['sourceId'] }
}

function parseMembershipInput(body: Record<string, unknown>): RegisterProjectDocumentInput {
  const documentRef = body['documentRef']
  if (!isResourceRef(documentRef)) {
    throw new InvalidRequestFieldError('documentRef must carry a uuid id, version, sha256 digest and kind')
  }
  const parseRef = body['parseRef']
  if (!isResourceRef(parseRef)) {
    throw new InvalidRequestFieldError('parseRef must carry a uuid id, version, sha256 digest and kind')
  }
  const parseId = body['parseId']
  if (!isUuid(parseId)) throw new InvalidRequestFieldError('parseId must be a uuid')
  const documentId = body['documentId']
  let resolvedDocumentId: Uuid
  if (documentId === undefined) {
    resolvedDocumentId = globalThis.crypto.randomUUID()
  } else if (isUuid(documentId)) {
    resolvedDocumentId = documentId
  } else {
    throw new InvalidRequestFieldError('documentId must be a uuid when supplied')
  }
  const documentDigest = body['documentDigest'] ?? documentRef.digest
  if (!isSha256Digest(documentDigest)) {
    throw new InvalidRequestFieldError('documentDigest must be a sha256 digest')
  }
  const textDigest = body['textDigest'] ?? parseRef.digest
  if (!isSha256Digest(textDigest)) {
    throw new InvalidRequestFieldError('textDigest must be a sha256 digest')
  }
  const precision = body['precision'] ?? 'exact'
  if (precision !== 'exact' && precision !== 'approximate') {
    throw new InvalidRequestFieldError('precision must be exact or approximate')
  }
  const sourceRef = body['sourceRef']
  if (sourceRef !== undefined && !isRecord(sourceRef)) {
    throw new InvalidRequestFieldError('sourceRef must be an object when supplied')
  }
  const reason = body['reason']
  if (reason !== undefined && typeof reason !== 'string') {
    throw new InvalidRequestFieldError('reason must be a string when supplied')
  }
  return {
    documentId: resolvedDocumentId,
    documentRef,
    documentDigest,
    parseId,
    parseRef,
    textDigest,
    precision,
    ...(sourceRef === undefined ? {} : { sourceRef: parseSourceRef(sourceRef, 'sourceRef') }),
    ...(reason === undefined ? {} : { reason }),
    actor: 'project-document-route',
    recordedAt: new Date().toISOString(),
  }
}

function parseRevisionInput(
  body: Record<string, unknown>,
  documentId: Uuid,
): ReviseProjectDocumentInput {
  const op = body['op']
  if (op !== 'retract' && op !== 'replace') {
    throw new InvalidRequestFieldError('op must be retract or replace')
  }
  const reason = body['reason']
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new InvalidRequestFieldError('reason must be a non-empty string')
  }
  const base = { documentId, reason, actor: 'project-document-route', recordedAt: new Date().toISOString() }
  if (op === 'retract') return { ...base, op }
  const replacement = body['replacement']
  if (!isRecord(replacement)) throw new InvalidRequestFieldError('replace requires a replacement object')
  const replacementDocumentRef = replacement['documentRef']
  const replacementParseRef = replacement['parseRef']
  const replacementParseId = replacement['parseId']
  if (!isResourceRef(replacementDocumentRef) || !isResourceRef(replacementParseRef) || !isUuid(replacementParseId)) {
    throw new InvalidRequestFieldError('replacement must carry documentRef, parseRef and parseId')
  }
  return {
    ...base,
    op,
    replacement: {
      documentId: isUuid(replacement['documentId']) ? replacement['documentId'] : globalThis.crypto.randomUUID(),
      documentRef: replacementDocumentRef,
      documentDigest: isSha256Digest(replacement['documentDigest']) ? replacement['documentDigest'] : replacementDocumentRef.digest,
      parseId: replacementParseId,
      parseRef: replacementParseRef,
      textDigest: isSha256Digest(replacement['textDigest']) ? replacement['textDigest'] : replacementParseRef.digest,
      precision: replacement['precision'] === 'approximate' ? 'approximate' : 'exact',
    },
  }
}

/**
 * The project document corpus and search surface (SPEC v0.3a §7/§8.1). Identity,
 * scope and trace id come from the server-side authenticator; a client can only
 * address a project's own corpus. Import/revision/build require an operator role;
 * status and search are available to any authenticated principal in the scope.
 */
export function registerProjectDocumentRoutes(
  app: FastifyInstance,
  dependencies: ProjectDocumentRouteDependencies,
): void {
  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/document-memberships',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      requireEditor(auth)
      requireIdempotencyKey(request)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const projectId = request.params.projectId
      const input = parseMembershipInput(body)
      const status = await dependencies.service.importDocument(projectId, input, contextFor(auth, traceId, projectId))
      reply.status(201).send({ data: { status }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string; documentId: string } }>(
    '/api/v1/projects/:projectId/document-memberships/:documentId/revisions',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      requireEditor(auth)
      requireIdempotencyKey(request)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const { projectId, documentId } = request.params
      if (!isUuid(documentId)) throw new InvalidRequestFieldError('documentId must be a uuid')
      const input = parseRevisionInput(body, documentId)
      const status = await dependencies.service.reviseDocument(projectId, input, contextFor(auth, traceId, projectId))
      reply.status(200).send({ data: { status }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/document-index',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      requireEditor(auth)
      const projectId = request.params.projectId
      const status = await dependencies.service.buildIndex(projectId, contextFor(auth, traceId, projectId))
      reply.status(202).send({ data: { status }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/document-index',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const projectId = request.params.projectId
      const status = await dependencies.service.getStatus(projectId, contextFor(auth, traceId, projectId))
      reply.status(200).send({ data: { status }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/document-search',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const query = body['query']
      if (typeof query !== 'string' || query.trim().length === 0) {
        throw new InvalidRequestFieldError('query must be a non-empty string')
      }
      const limitRaw = body['limit']
      if (limitRaw !== undefined && (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1)) {
        throw new InvalidRequestFieldError('limit must be a positive integer when supplied')
      }
      const projectId = request.params.projectId
      const result = await dependencies.service.search(
        {
          projectId,
          query,
          ...(limitRaw === undefined ? {} : { limit: limitRaw }),
        },
        contextFor(auth, traceId, projectId),
      )
      reply.status(200).send({ data: { result }, meta: { traceId } })
      return reply
    },
  )
}
