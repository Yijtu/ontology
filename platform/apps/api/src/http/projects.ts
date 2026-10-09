import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  PROJECT_READINESS_KINDS,
  isResourceRef,
  isRevisionString,
  isSha256Digest,
  isUuid,
  isVersionRef,
  isDefinitionRevisionStrategy,
} from '@ontology/contracts'
import type {
  BindRecordsRequest,
  CapBreachMode,
  ColumnMappingEntry,
  ColumnMappingRequest,
  CsvDelimiter,
  ExactUnitConversion,
  LogicalRole,
  MappingRef,
  ProjectReadinessKind,
  ProjectRecordFieldStatus,
  ProjectState,
  QuoteChar,
  ResolvedProfileRef,
  ResourceRef,
  RevisionString,
  SourceObjectRef,
  StructuredFormat,
  StructuredParseCaps,
  StructuredParseOptions,
  ValueMappingEntry,
  VersionRef,
} from '@ontology/contracts'
import { ProjectError } from '@ontology/application'
import type {
  CreateProjectInput,
  MountPackVersionInput,
  ProjectDataMaterializationService,
  ProjectMappingService,
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
  /** Column-mapping confirmation, unit normalisation and record binding (V03-017). */
  readonly mappings?: ProjectMappingService
  /** Approved-data materialisation and fixed-snapshot reads (V03-018). */
  readonly dataset?: ProjectDataMaterializationService
  readonly evolution?: import('@ontology/application').ProjectEvolutionService
  readonly authenticate: RequestAuthenticator
}

const DATASET_FIELDS = ['objectId', 'revision', 'allowPartial'] as const

const MAPPING_FORMATS: readonly StructuredFormat[] = ['text', 'json', 'csv', 'xlsx']
const DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|']
const QUOTES: readonly QuoteChar[] = ['"', "'"]
const CAP_BREACH_MODES: readonly CapBreachMode[] = ['reject', 'truncate']
const RECORD_STATUSES: readonly ProjectRecordFieldStatus[] = ['confirmed', 'pending', 'conflict']

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

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty string`)
  }
  return value
}

function optionalToken<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new InvalidRequestFieldError(`${field} must be one of ${allowed.join(', ')}`)
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InvalidRequestFieldError(`${field} must be a positive integer`)
  }
  return value
}

function parseCaps(value: unknown): Partial<StructuredParseCaps> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new InvalidRequestFieldError('options.caps must be an object')
  const read = (key: keyof StructuredParseCaps): number | undefined => {
    const candidate = value[key]
    if (candidate === undefined) return undefined
    if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate < 0) {
      throw new InvalidRequestFieldError(`options.caps.${key} must be a non-negative integer`)
    }
    return candidate
  }
  const caps: Partial<StructuredParseCaps> = {
    ...(read('maxFileBytes') === undefined ? {} : { maxFileBytes: read('maxFileBytes') as number }),
    ...(read('maxExpandedBytes') === undefined ? {} : { maxExpandedBytes: read('maxExpandedBytes') as number }),
    ...(read('maxZipEntries') === undefined ? {} : { maxZipEntries: read('maxZipEntries') as number }),
    ...(read('maxRows') === undefined ? {} : { maxRows: read('maxRows') as number }),
    ...(read('maxColumns') === undefined ? {} : { maxColumns: read('maxColumns') as number }),
    ...(read('maxCellBytes') === undefined ? {} : { maxCellBytes: read('maxCellBytes') as number }),
    ...(read('maxDepth') === undefined ? {} : { maxDepth: read('maxDepth') as number }),
  }
  return caps
}

function parseStructuredOptions(value: unknown): Omit<StructuredParseOptions, 'mediaType'> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new InvalidRequestFieldError('options must be an object')
  const encoding = value['encoding']
  if (encoding !== undefined && encoding !== 'utf-8') {
    throw new InvalidRequestFieldError('options.encoding must be utf-8')
  }
  const delimiter = optionalToken(value['delimiter'], DELIMITERS, 'options.delimiter')
  const quote = optionalToken(value['quote'], QUOTES, 'options.quote')
  const capBreachMode = optionalToken(value['capBreachMode'], CAP_BREACH_MODES, 'options.capBreachMode')
  const headerRow = optionalPositiveInteger(value['headerRow'], 'options.headerRow')
  const dataStartRow = optionalPositiveInteger(value['dataStartRow'], 'options.dataStartRow')
  const caps = parseCaps(value['caps'])
  return {
    ...(encoding === undefined ? {} : { encoding }),
    ...(delimiter === undefined ? {} : { delimiter }),
    ...(quote === undefined ? {} : { quote }),
    ...(headerRow === undefined ? {} : { headerRow }),
    ...(dataStartRow === undefined ? {} : { dataStartRow }),
    ...(capBreachMode === undefined ? {} : { capBreachMode }),
    ...(caps === undefined ? {} : { caps }),
  }
}

function parseUnitConversion(value: unknown, field: string): ExactUnitConversion {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  return {
    fromUnitCode: requireStringField(value['fromUnitCode'], `${field}.fromUnitCode`),
    toUnitCode: requireStringField(value['toUnitCode'], `${field}.toUnitCode`),
    numerator: requireStringField(value['numerator'], `${field}.numerator`),
    denominator: requireStringField(value['denominator'], `${field}.denominator`),
  }
}

function parseValueMapping(value: unknown, field: string): ValueMappingEntry[] {
  if (!Array.isArray(value)) throw new InvalidRequestFieldError(`${field} must be an array`)
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new InvalidRequestFieldError(`${field}[${String(index)}] must be an object`)
    return {
      from: requireStringField(entry['from'], `${field}[${String(index)}].from`),
      to: requireStringField(entry['to'], `${field}[${String(index)}].to`),
    }
  })
}

function parseMappingEntry(value: unknown, field: string): ColumnMappingEntry {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  const columnIndex = value['columnIndex']
  if (typeof columnIndex !== 'number' || !Number.isInteger(columnIndex) || columnIndex < 0) {
    throw new InvalidRequestFieldError(`${field}.columnIndex must be a non-negative integer`)
  }
  const pointer = value['pointer']
  if (pointer !== undefined && typeof pointer !== 'string') {
    throw new InvalidRequestFieldError(`${field}.pointer must be a string`)
  }
  const sourceUnitCode = value['sourceUnitCode']
  if (sourceUnitCode !== undefined) requireStringField(sourceUnitCode, `${field}.sourceUnitCode`)
  const canonicalUnitCode = value['canonicalUnitCode']
  if (canonicalUnitCode !== undefined) requireStringField(canonicalUnitCode, `${field}.canonicalUnitCode`)
  const unitConversion = value['unitConversion'] === undefined
    ? undefined
    : parseUnitConversion(value['unitConversion'], `${field}.unitConversion`)
  const valueMapping = value['valueMapping'] === undefined
    ? undefined
    : parseValueMapping(value['valueMapping'], `${field}.valueMapping`)
  const headerDigest = value['headerDigest']
  if (!isSha256Digest(headerDigest)) throw new InvalidRequestFieldError(`${field}.headerDigest must be a sha256 digest`)
  return {
    fieldRef: requireStringField(value['fieldRef'], `${field}.fieldRef`),
    header: requireStringField(value['header'], `${field}.header`),
    headerDigest,
    columnIndex,
    ...(pointer === undefined ? {} : { pointer }),
    ...(sourceUnitCode === undefined ? {} : { sourceUnitCode: sourceUnitCode as string }),
    ...(canonicalUnitCode === undefined ? {} : { canonicalUnitCode: canonicalUnitCode as string }),
    ...(unitConversion === undefined ? {} : { unitConversion }),
    ...(valueMapping === undefined ? {} : { valueMapping }),
  }
}

const MAPPING_REQUEST_FIELDS = [
  'definitionRef',
  'format',
  'parseId',
  'originalRef',
  'originalMediaType',
  'options',
  'objectId',
  'sheetId',
  'sheetName',
  'entries',
  'mappingId',
] as const

function parseColumnMappingRequest(body: Record<string, unknown>): ColumnMappingRequest {
  rejectUnknownFields(body, MAPPING_REQUEST_FIELDS)
  const parseId = body['parseId']
  if (!isUuid(parseId)) throw new InvalidRequestFieldError('parseId must be a uuid')
  const mappingId = body['mappingId']
  if (mappingId !== undefined && !isUuid(mappingId)) throw new InvalidRequestFieldError('mappingId must be a uuid')
  const sheetId = body['sheetId']
  if (sheetId !== undefined) requireStringField(sheetId, 'sheetId')
  const sheetName = body['sheetName']
  if (sheetName !== undefined) requireStringField(sheetName, 'sheetName')
  const entries = body['entries']
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new InvalidRequestFieldError('entries must be a non-empty array')
  }
  return {
    ...(body['definitionRef'] === undefined ? {} : { definitionRef: parseVersionRef(body['definitionRef'], 'definitionRef') }),
    format: (() => {
      const format = body['format']
      if (typeof format === 'string' && (MAPPING_FORMATS as readonly string[]).includes(format)) return format as StructuredFormat
      throw new InvalidRequestFieldError('format must be text, json, csv or xlsx')
    })(),
    parseId,
    originalRef: parseResourceRef(body['originalRef'], 'originalRef'),
    originalMediaType: requireStringField(body['originalMediaType'], 'originalMediaType'),
    options: parseStructuredOptions(body['options']),
    objectId: requireStringField(body['objectId'], 'objectId'),
    ...(sheetId === undefined ? {} : { sheetId: sheetId as string }),
    ...(sheetName === undefined ? {} : { sheetName: sheetName as string }),
    entries: entries.map((entry, index) => parseMappingEntry(entry, `entries[${String(index)}]`)),
    ...(mappingId === undefined ? {} : { mappingId }),
  }
}

const BIND_REQUEST_FIELDS = ['parseId', 'mappingId', 'mappingVersion'] as const

function parseBindRecordsRequest(body: Record<string, unknown>): BindRecordsRequest {
  rejectUnknownFields(body, BIND_REQUEST_FIELDS)
  const parseId = body['parseId']
  if (!isUuid(parseId)) throw new InvalidRequestFieldError('parseId must be a uuid')
  const mappingId = body['mappingId']
  if (!isUuid(mappingId)) throw new InvalidRequestFieldError('mappingId must be a uuid')
  return {
    parseId,
    mappingId,
    mappingVersion: requireStringField(body['mappingVersion'], 'mappingVersion'),
  }
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

  if (dependencies.evolution !== undefined) {
      const evolution = dependencies.evolution
      for (const path of ['/api/v1/projects/:projectId/evolutions','/api/v1/projects/:projectId/evolve']) app.post<{
          Params: {
              projectId: string
          }
      }>(path, async (request, reply) => {
          const auth = authenticateRequest(dependencies.authenticate, request, reply)
          if (auth === undefined)
              return reply
          const body = request.body
          if (!isRecord(body))
              throw new InvalidRequestFieldError('an evolution body is required')
          rejectUnknownFields(body, ['industryPackRef', 'strategy', 'remappings', 'maxRecords', 'maxAttempts','profileRef'])
          if (!isDefinitionRevisionStrategy(body['strategy']) || !Array.isArray(body['remappings']))
              throw new InvalidRequestFieldError('explicit strategy and original remappings are required')
          const remappings = body['remappings'].map((entry: unknown) => {
              if (!isRecord(entry) || !isUuid(entry['documentId']) || typeof entry['objectId'] !== 'string' || !Array.isArray(entry['entries']))
                  throw new InvalidRequestFieldError('a remapping must name its stored mapping/document, object and entries')
              rejectUnknownFields(entry, ['mappingRef', 'documentId', 'objectId', 'entries'])
              return { mappingRef: parseMappingRefs([entry['mappingRef']], 'mappingRef')[0]!, documentId: entry['documentId'], objectId: entry['objectId'], entries: entry['entries'].map((value, index) => parseMappingEntry(value, `entries[${index}]`)) }
          })
          const traceId = readTraceId(request)
          const result = await evolution.start(request.params.projectId, { expectedRevision: readIfMatch(request), industryPackRef: parseVersionRef(body['industryPackRef'], 'industryPackRef'), strategy: body['strategy'], remappings, maxRecords: optionalPositiveInteger(body['maxRecords'], 'maxRecords') ?? 2000, maxAttempts: optionalPositiveInteger(body['maxAttempts'], 'maxAttempts') ?? 1,...(body['profileRef']===undefined?{}:{profileRef:parseResolvedProfileRef(body['profileRef'])}) }, requireIdempotencyKey(request), contextFor(auth, traceId, request.params.projectId))
          return reply.status(202).send({ data: { evolution: result }, meta: { traceId, revision: result.revision } })
      })
      app.get<{
          Params: {
              projectId: string
              evolutionId: string
          }
      }>('/api/v1/projects/:projectId/evolutions/:evolutionId', async (request, reply) => { const auth = authenticateRequest(dependencies.authenticate, request, reply); if (auth === undefined)
          return reply; const traceId = readTraceId(request); const result = await evolution.get(request.params.projectId, request.params.evolutionId, contextFor(auth, traceId, request.params.projectId)); return reply.send({ data: { evolution: result }, meta: { traceId, revision: result.revision } }); })
      for (const operation of ['activate', 'cancel', 'retry'] as const)
          app.post<{
              Params: {
                  projectId: string
                  evolutionId: string
              }
          }>(`/api/v1/projects/:projectId/evolutions/:evolutionId/${operation}`, async (request, reply) => {
              const auth = authenticateRequest(dependencies.authenticate, request, reply)
              if (auth === undefined)
                  return reply
              const traceId = readTraceId(request), ctx = contextFor(auth, traceId, request.params.projectId)
              const body = request.body ?? {}
              if (!isRecord(body))
                  throw new InvalidRequestFieldError('the operation body must be an object')
              rejectUnknownFields(body, operation === 'activate' ? ['relationCandidateIds'] : [])
              const ids = body['relationCandidateIds'] ?? []
              if (!Array.isArray(ids) || !ids.every(isUuid))
                  throw new InvalidRequestFieldError('relationCandidateIds must be stored candidate UUIDs')
              const result = operation === 'activate' ? await evolution.activate(request.params.projectId, request.params.evolutionId, ids, ctx) : await evolution[operation](request.params.projectId, request.params.evolutionId, ctx)
              return reply.send({ data: { evolution: result }, meta: { traceId, revision: result.revision } })
          })
  }

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
          active: view.active,
          staging: view.staging,
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

  const mappings = dependencies.mappings
  if (mappings !== undefined) {
    app.post<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/mappings/preview',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        const projectId = request.params.projectId
        const preview = await mappings.previewMapping(
          projectId,
          parseColumnMappingRequest(body),
          contextFor(auth, traceId, projectId),
        )
        reply.status(200).send({ data: { preview }, meta: { traceId } })
        return reply
      },
    )

    app.post<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/mappings',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        const projectId = request.params.projectId
        const result = await mappings.confirmMapping(
          projectId,
          parseColumnMappingRequest(body),
          requireIdempotencyKey(request),
          auth.principal.subjectId,
          contextFor(auth, traceId, projectId),
        )
        reply.status(result.created ? 201 : 200).send({
          data: { mapping: result.mapping, preview: result.preview, created: result.created },
          meta: { traceId },
        })
        return reply
      },
    )

    app.get<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/mappings',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const projectId = request.params.projectId
        const list = await mappings.listMappings(projectId, contextFor(auth, traceId, projectId))
        reply.status(200).send({ data: { mappings: list }, meta: { traceId } })
        return reply
      },
    )

    app.get<{ Params: { projectId: string; mappingId: string; version: string } }>(
      '/api/v1/projects/:projectId/mappings/:mappingId/versions/:version',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const { projectId, mappingId, version } = request.params
        const mapping = await mappings.getMapping(
          projectId,
          mappingId,
          version,
          contextFor(auth, traceId, projectId),
        )
        if (mapping === undefined) {
          throw new ProjectError('MAPPING_NOT_FOUND', `mapping ${mappingId}@${version} is not visible for this project`)
        }
        reply.status(200).send({ data: { mapping }, meta: { traceId } })
        return reply
      },
    )

    app.post<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/records',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        const projectId = request.params.projectId
        const result = await mappings.bindRecords(
          projectId,
          parseBindRecordsRequest(body),
          requireIdempotencyKey(request),
          auth.principal.subjectId,
          contextFor(auth, traceId, projectId),
        )
        reply.status(result.created ? 201 : 200).send({
          data: { records: result.records, counts: result.counts, created: result.created },
          meta: { traceId },
        })
        return reply
      },
    )

    app.get<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/records',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const projectId = request.params.projectId
        const objectId = readQueryString(request, 'objectId')
        const status = readQueryString(request, 'status')
        if (status !== undefined && !(RECORD_STATUSES as readonly string[]).includes(status)) {
          throw new InvalidRequestFieldError(`status must be one of ${RECORD_STATUSES.join(', ')}`)
        }
        const cursor = readQueryString(request, 'cursor')
        const page = await mappings.listRecords(
          projectId,
          {
            ...(objectId === undefined ? {} : { objectId }),
            ...(status === undefined ? {} : { status: status as ProjectRecordFieldStatus }),
            ...(readPageSize(request) === undefined ? {} : { limit: readPageSize(request) as number }),
            ...(cursor === undefined ? {} : { cursor }),
          },
          contextFor(auth, traceId, projectId),
        )
        reply.status(200).send({
          data: { records: page.records, total: page.total, nextCursor: page.nextCursor ?? null },
          meta: { traceId },
        })
        return reply
      },
    )
  }

  const dataset = dependencies.dataset
  if (dataset !== undefined) {
    app.post<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/dataset-snapshots',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const body = request.body
        if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
        rejectUnknownFields(body, DATASET_FIELDS)
        const objectId = body['objectId']
        if (typeof objectId !== 'string' || objectId.trim().length === 0) {
          throw new InvalidRequestFieldError('objectId must be a non-empty string')
        }
        const revision = body['revision']
        if (revision !== undefined && !isRevisionString(revision)) {
          throw new InvalidRequestFieldError('revision must be a decimal revision string')
        }
        const allowPartial = body['allowPartial']
        if (allowPartial !== undefined && typeof allowPartial !== 'boolean') {
          throw new InvalidRequestFieldError('allowPartial must be a boolean')
        }
        const projectId = request.params.projectId
        const status = await dataset.materialize(
          projectId,
          {
            objectId,
            ...(typeof revision === 'string' ? { revision } : {}),
            ...(allowPartial === true ? { allowPartial: true } : {}),
          },
          contextFor(auth, traceId, projectId),
        )
        reply.status(201).send({
          data: { status },
          meta: { traceId, revision: status.projectRevisionRef.revision },
        })
        return reply
      },
    )

    app.get<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/dataset',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const projectId = request.params.projectId
        const revision = readQueryString(request, 'revision')
        if (revision !== undefined && !isRevisionString(revision)) {
          throw new InvalidRequestFieldError('revision must be a decimal revision string')
        }
        const objectId = readQueryString(request, 'objectId')
        const cursor = readQueryString(request, 'cursor')
        const limit = readPageSize(request)
        const result = await dataset.queryActive(
          {
            projectId,
            ...(revision === undefined ? {} : { revision }),
            ...(objectId === undefined ? {} : { objectId }),
            ...(limit === undefined ? {} : { limit }),
            ...(cursor === undefined ? {} : { cursor }),
          },
          contextFor(auth, traceId, projectId),
        )
        reply.status(200).send({
          data: {
            snapshotRef: result.snapshotRef,
            columns: result.columns,
            rows: result.rows,
            coverage: result.coverage,
          },
          meta: { traceId },
        })
        return reply
      },
    )

    app.get<{ Params: { projectId: string } }>(
      '/api/v1/projects/:projectId/dataset/status',
      async (request, reply) => {
        const traceId = readTraceId(request)
        const auth = authenticateRequest(dependencies.authenticate, request, reply)
        if (auth === undefined) return reply
        const projectId = request.params.projectId
        const objectId = readQueryString(request, 'objectId') ?? ''
        const status = await dataset.getStatus(projectId, objectId, contextFor(auth, traceId, projectId))
        reply.status(200).send({ data: { status }, meta: { traceId } })
        return reply
      },
    )
  }
}
