import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isRecord, isUuid } from '@ontology/contracts'
import type {
  ParseCoverage,
  ResourceRef,
  ScopeRef,
  SourceRef,
  StructuredFormat,
  StructuredParseStatus,
  StructuredRecordCounts,
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
const FORMATS: readonly StructuredFormat[] = ['text', 'json', 'csv', 'xlsx']
const MAX_IMPORTED_BYTES = 20 * 1024 * 1024

/**
 * The project structured-parse import surface (SPEC v0.3a §5/§8.1, V03-005/V03-006).
 *
 * A project can import a structured source (text/JSON/CSV/XLSX) through the *real* parser: the
 * HTTP layer publishes the bytes as an immutable original and hands them to the injected
 * `LocalStructuredIngestionService`, which runs the pure structured parser and persists the
 * reconciled rows. The returned `parseId`/`originalRef`/`originalMediaType`/`format` are exactly
 * what the column-mapping route (`POST /projects/:id/mappings/preview`) re-reads, so a client
 * can map columns and bind records on the real parse — not on a startup fixture.
 *
 * Identity, scope and trace id come from the server-side authenticator; a client can only
 * import into a project visible in its own scope, and the import requires an operator role and
 * an Idempotency-Key.
 */
export interface ProjectStructuredImportInput {
  readonly format: StructuredFormat
  readonly mediaType: string
  readonly content: Uint8Array
  readonly sourceRef?: SourceRef
}

export interface ProjectStructuredImportResult {
  readonly parseId: Uuid
  readonly originalRef: ResourceRef
  readonly originalMediaType: string
  readonly format: StructuredFormat
  readonly status: StructuredParseStatus
  readonly counts: StructuredRecordCounts
  readonly coverage: ParseCoverage
  readonly reused: boolean
  /** Host-built document membership and immutable corpus, separate from fact approval. */
  readonly documentId?: Uuid
  readonly documentSetRef?: ResourceRef
  readonly documentIndexState?: string
}

export interface ProjectStructuredImportService {
  importStructuredSource(
    projectId: Uuid,
    input: ProjectStructuredImportInput,
    ctx: ToolContext,
  ): Promise<ProjectStructuredImportResult>
}

export interface ProjectImportRouteDependencies {
  readonly service: ProjectStructuredImportService
  readonly scopeRef: ScopeRef
  readonly authenticate: RequestAuthenticator
}

function requireEditor(auth: AuthenticatedRequest): void {
  if (!EDITOR_ROLES.some((role) => auth.principal.roles.includes(role))) {
    throw new ForbiddenError('importing a project structured source requires an operator role')
  }
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined) throw new InvalidRequestFieldError('an Idempotency-Key header is required')
  return key
}

function readFormat(value: unknown): StructuredFormat {
  if (typeof value === 'string' && (FORMATS as readonly string[]).includes(value)) {
    return value as StructuredFormat
  }
  throw new InvalidRequestFieldError(`format must be one of ${FORMATS.join(', ')}`)
}

function readSourceRef(value: unknown): SourceRef | undefined {
  if (value === undefined) return undefined
  if (
    !isRecord(value) ||
    typeof value['namespace'] !== 'string' ||
    value['namespace'].length === 0 ||
    typeof value['sourceId'] !== 'string' ||
    value['sourceId'].length === 0
  ) {
    throw new InvalidRequestFieldError('sourceRef must carry a namespace and sourceId')
  }
  return { namespace: value['namespace'], sourceId: value['sourceId'] }
}

function decodeContent(value: unknown, encoding: unknown): Uint8Array {
  if (typeof value !== 'string') throw new InvalidRequestFieldError('content must be a string')
  const normalised = encoding === undefined ? 'utf-8' : encoding
  if (normalised !== 'utf-8' && normalised !== 'base64') {
    throw new InvalidRequestFieldError('contentEncoding must be utf-8 or base64')
  }
  const bytes = normalised === 'base64'
    ? new Uint8Array(Buffer.from(value, 'base64'))
    : new TextEncoder().encode(value)
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORTED_BYTES) {
    throw new InvalidRequestFieldError(`content must be between 1 byte and ${String(MAX_IMPORTED_BYTES)} bytes`)
  }
  return bytes
}

/** Register the project structured-parse import route on the shared API host. */
export function registerProjectImportRoute(
  app: FastifyInstance,
  dependencies: ProjectImportRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string) =>
    createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId,
      runId: resourceId,
    })

  app.post<{ Params: { projectId: string } }>(
    '/api/v1/projects/:projectId/structured-imports',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      requireEditor(auth)
      const idempotencyKey = requireIdempotencyKey(request)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const projectId = request.params.projectId
      if (!isUuid(projectId)) throw new InvalidRequestFieldError('projectId must be a uuid')
      const format = readFormat(body['format'])
      const mediaType = body['mediaType']
      if (typeof mediaType !== 'string' || mediaType.trim().length === 0) {
        throw new InvalidRequestFieldError('mediaType must be a non-empty string')
      }
      const content = decodeContent(body['content'], body['contentEncoding'])
      const sourceRef = readSourceRef(body['sourceRef'])
      const result = await dependencies.service.importStructuredSource(
        projectId,
        {
          format,
          mediaType: mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? mediaType,
          content,
          ...(sourceRef === undefined ? {} : { sourceRef }),
        },
        contextFor(auth, traceId, projectId),
      )
      reply.status(201).send({
        data: {
          parseId: result.parseId,
          originalRef: result.originalRef,
          originalMediaType: result.originalMediaType,
          format: result.format,
          status: result.status,
          counts: result.counts,
          coverage: result.coverage,
          reused: result.reused,
          ...(result.documentId === undefined ? {} : { documentId: result.documentId }),
          ...(result.documentSetRef === undefined ? {} : { documentSetRef: result.documentSetRef }),
          ...(result.documentIndexState === undefined ? {} : { documentIndexState: result.documentIndexState }),
        },
        meta: { traceId, idempotencyKey },
      })
      return reply
    },
  )
}
