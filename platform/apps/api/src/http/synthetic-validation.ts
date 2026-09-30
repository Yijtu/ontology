import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  isResourceRef,
  isSyntheticCaseKind,
  isVersionRef,
  SyntheticValidationError,
} from '@ontology/contracts'
import type {
  ActionCapabilityBindingInput,
  GenerateSyntheticExampleSetInput,
  ResourceRef,
  ReviseSyntheticExampleSetInput,
  RunIndustryValidationInput,
  SyntheticCase,
  SyntheticCaseField,
  SyntheticCaseKind,
  SyntheticExpectation,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type { IndustryValidationService, SyntheticExampleService } from '@ontology/application'
import { createRequestToolContext } from './context'
import {
  authenticateRequest,
  isRecord,
  readHeader,
  readQueryInteger,
  readRevisionHeader,
  readTraceId,
  ForbiddenError,
  InvalidRequestFieldError,
} from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 250
const TARGET_DATA_MODES = ['synthetic', 'observed', 'live'] as const
const EXPECTATION_ORIGINS = ['expert_confirmed', 'authored_oracle', 'generated', 'implementation_output'] as const

export interface SyntheticValidationRouteDependencies {
  readonly exampleService: SyntheticExampleService
  readonly validationService: IndustryValidationService
  readonly authenticate: RequestAuthenticator
  /**
   * Trusted deployment binding context for action capability re-binding. It is never read from
   * the request body or a model response.
   */
  readonly bindingContext?: (ctx: ToolContext) => ActionCapabilityBindingInput
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = readHeader(request, 'idempotency-key')
  if (key === undefined || key.length < 8) {
    throw new InvalidRequestFieldError('an Idempotency-Key header (>= 8 chars) is required')
  }
  return key
}

function readIfMatch(request: FastifyRequest): string | undefined {
  const header = readRevisionHeader(request)
  if (header.kind === 'absent') return undefined
  if (header.kind !== 'revision') {
    throw new InvalidRequestFieldError('If-Match must be a decimal revision string')
  }
  return header.value
}

function readNonEmpty(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty string`)
  }
  return value
}

function parseVersionRef(value: unknown, field: string): VersionRef {
  if (!isVersionRef(value)) {
    throw new InvalidRequestFieldError(`${field} must carry an id, version and sha256 digest`)
  }
  return value
}

function parseResourceRef(value: unknown, field: string): ResourceRef {
  if (!isResourceRef(value)) {
    throw new InvalidRequestFieldError(`${field} must carry a uuid id, version, sha256 digest and kind`)
  }
  return value
}

function parseCaseField(value: unknown, index: number): SyntheticCaseField {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`cases[${String(index)}].fields entries must be objects`)
  const raw = value['value']
  if (raw !== null && typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
    throw new InvalidRequestFieldError(`cases[${String(index)}] field value must be a scalar or null`)
  }
  if (value['unitCode'] !== undefined && typeof value['unitCode'] !== 'string') {
    throw new InvalidRequestFieldError(`cases[${String(index)}] unitCode must be a string`)
  }
  return {
    fieldId: readNonEmpty(value, 'fieldId'),
    value: raw,
    ...(value['unitCode'] === undefined ? {} : { unitCode: value['unitCode'] }),
  }
}

function parseCase(value: unknown, index: number): SyntheticCase {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`cases[${String(index)}] must be an object`)
  const caseKind = value['caseKind']
  if (typeof caseKind !== 'string' || !isSyntheticCaseKind(caseKind)) {
    throw new InvalidRequestFieldError(`cases[${String(index)}].caseKind is not a known synthetic case kind`)
  }
  const fields = value['fields']
  if (!Array.isArray(fields)) throw new InvalidRequestFieldError(`cases[${String(index)}].fields must be an array`)
  return {
    caseId: readNonEmpty(value, 'caseId'),
    caseKind,
    objectTypeRef: readNonEmpty(value, 'objectTypeRef'),
    ...(typeof value['displayName'] === 'string' ? { displayName: value['displayName'] } : {}),
    ...(typeof value['alternateObjectTypeRef'] === 'string'
      ? { alternateObjectTypeRef: value['alternateObjectTypeRef'] }
      : {}),
    fields: fields.map((field, fieldIndex) => parseCaseField(field, fieldIndex)),
    ...(typeof value['note'] === 'string' ? { note: value['note'] } : {}),
  }
}

function parseCases(value: unknown): SyntheticCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError('cases must be a non-empty array')
  }
  return value.map((entry, index) => parseCase(entry, index))
}

function parseCaseKinds(value: unknown): SyntheticCaseKind[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError('caseKinds must be a non-empty array')
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || !isSyntheticCaseKind(entry)) {
      throw new InvalidRequestFieldError(`caseKinds[${String(index)}] is not a known synthetic case kind`)
    }
    return entry
  })
}

function parseExpectation(value: unknown, index: number): SyntheticExpectation {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`expectations[${String(index)}] must be an object`)
  const origin = value['origin']
  if (typeof origin !== 'string' || !(EXPECTATION_ORIGINS as readonly string[]).includes(origin)) {
    throw new InvalidRequestFieldError(`expectations[${String(index)}].origin is not a known provenance`)
  }
  const base = {
    expectationId: readNonEmpty(value, 'expectationId'),
    caseId: readNonEmpty(value, 'caseId'),
    origin: origin as SyntheticExpectation['origin'],
    reason: readNonEmpty(value, 'reason'),
    confirmedBy: readNonEmpty(value, 'confirmedBy'),
    confirmedAt: readNonEmpty(value, 'confirmedAt'),
  }
  if (value['kind'] === 'rule') {
    const expected = value['expected']
    if (expected !== 'true' && expected !== 'false' && expected !== 'unknown' && expected !== 'conflict') {
      throw new InvalidRequestFieldError(`expectations[${String(index)}].expected must be a four-state condition`)
    }
    return { ...base, kind: 'rule', ruleId: readNonEmpty(value, 'ruleId'), expected }
  }
  if (value['kind'] === 'action') {
    const expected = value['expected']
    if (expected !== 'executable' && expected !== 'blocked') {
      throw new InvalidRequestFieldError(`expectations[${String(index)}].expected must be executable or blocked`)
    }
    return { ...base, kind: 'action', actionId: readNonEmpty(value, 'actionId'), expected }
  }
  throw new InvalidRequestFieldError(`expectations[${String(index)}].kind must be rule or action`)
}

function parseExpectations(value: unknown): SyntheticExpectation[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InvalidRequestFieldError('expectations must be a non-empty array')
  }
  return value.map((entry, index) => parseExpectation(entry, index))
}

function readPageSize(request: FastifyRequest): number {
  const raw = readQueryInteger(request, 'pageSize') ?? readQueryInteger(request, 'limit')
  if (raw === undefined) return DEFAULT_PAGE_SIZE
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new InvalidRequestFieldError('pageSize must be a positive integer')
  }
  return Math.min(raw, MAX_PAGE_SIZE)
}

function editor(auth: AuthenticatedRequest): void {
  if (auth.principal.roles.includes('profile-editor') || auth.principal.roles.includes('platform-admin')) return
  throw new ForbiddenError('only a profile-editor or platform-admin may manage synthetic validation')
}

/**
 * The synthetic sandbox and industry validation surface (SPEC v0.3a §3.4/§8.1, V03-014 / #186).
 *
 * It creates isolation-marked synthetic example sets, runs the validation service over a draft,
 * and exposes the publication gate. The promotion route is a hard backend refusal: a synthetic
 * sample can never become an observed/live fact, in any scope. Identity, scope and trace id
 * come from the server-side authenticator, never the body.
 */
export function registerSyntheticValidationRoutes(
  app: FastifyInstance,
  dependencies: SyntheticValidationRouteDependencies,
): void {
  const contextFor = (auth: AuthenticatedRequest, traceId: string, resourceId: string): ToolContext =>
    createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: resourceId })
  const scopeFor = (auth: AuthenticatedRequest) => ({ tenantId: auth.principal.tenantId, spaceId: auth.spaceId })

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/synthetic-example-sets',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      editor(auth)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const input: GenerateSyntheticExampleSetInput = {
        caseKinds: parseCaseKinds(body['caseKinds']),
        cases: parseCases(body['cases']),
        expectations: parseExpectations(body['expectations']),
        ...(body['targetDraftRef'] === undefined
          ? {}
          : { targetDraftRef: parseVersionRef(body['targetDraftRef'], 'targetDraftRef') }),
        ...(body['targetDefinitionRef'] === undefined
          ? {}
          : { targetDefinitionRef: parseVersionRef(body['targetDefinitionRef'], 'targetDefinitionRef') }),
        ...(body['generationPolicyRef'] === undefined
          ? {}
          : { generationPolicyRef: parseVersionRef(body['generationPolicyRef'], 'generationPolicyRef') }),
        ...(body['generationCallRef'] === undefined
          ? {}
          : { generationCallRef: parseResourceRef(body['generationCallRef'], 'generationCallRef') }),
        expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const workspaceId = request.params.workspaceId
      const set = await dependencies.exampleService.generate(
        workspaceId,
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(201).send({ data: { exampleSet: set }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/synthetic-example-sets',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const workspaceId = request.params.workspaceId
      const sets = await dependencies.exampleService.list(
        workspaceId,
        readPageSize(request),
        contextFor(auth, traceId, workspaceId),
      )
      reply.status(200).send({ data: { exampleSets: sets }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string; exampleSetId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/synthetic-example-sets/:exampleSetId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { workspaceId, exampleSetId } = request.params
      const set = await dependencies.exampleService.get(
        workspaceId,
        exampleSetId,
        contextFor(auth, traceId, exampleSetId),
      )
      if (set === undefined) {
        throw new SyntheticValidationError('EXAMPLE_SET_NOT_FOUND', `example set ${exampleSetId} is not visible`)
      }
      reply.status(200).send({ data: { exampleSet: set }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; exampleSetId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/synthetic-example-sets/:exampleSetId/revisions',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      editor(auth)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const { workspaceId, exampleSetId } = request.params
      const input: ReviseSyntheticExampleSetInput = {
        exampleSetId,
        cases: parseCases(body['cases']),
        expectations: parseExpectations(body['expectations']),
        reason: readNonEmpty(body, 'reason'),
        expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const set = await dependencies.exampleService.revise(
        workspaceId,
        input,
        auth.principal.subjectId,
        contextFor(auth, traceId, exampleSetId),
      )
      reply.status(201).send({ data: { exampleSet: set }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/validations',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      editor(auth)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const workspaceId = request.params.workspaceId
      const ctx = contextFor(auth, traceId, workspaceId)
      const bindingContext = dependencies.bindingContext?.(ctx)
      const input: RunIndustryValidationInput = {
        exampleSetId: readNonEmpty(body, 'exampleSetId'),
        ...(body['draftRef'] === undefined ? {} : { draftRef: parseVersionRef(body['draftRef'], 'draftRef') }),
        ...(body['definitionRef'] === undefined
          ? {}
          : { definitionRef: parseVersionRef(body['definitionRef'], 'definitionRef') }),
        ...(body['validationPolicyRef'] === undefined
          ? {}
          : { validationPolicyRef: parseVersionRef(body['validationPolicyRef'], 'validationPolicyRef') }),
        ...(bindingContext === undefined ? {} : { actionBindingContext: bindingContext }),
        expectedRevision: readIfMatch(request),
        idempotencyKey: requireIdempotencyKey(request),
      }
      const report = await dependencies.validationService.validate(
        workspaceId,
        input,
        auth.principal.subjectId,
        ctx,
      )
      reply.status(201).send({ data: { validation: report }, meta: { traceId } })
      return reply
    },
  )

  app.get<{ Params: { workspaceId: string; validationId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/validations/:validationId',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      const { workspaceId, validationId } = request.params
      const report = await dependencies.validationService.getReport(
        workspaceId,
        validationId,
        contextFor(auth, traceId, validationId),
      )
      if (report === undefined) {
        throw new SyntheticValidationError('VALIDATION_NOT_FOUND', `validation ${validationId} is not visible`)
      }
      reply.status(200).send({ data: { validation: report }, meta: { traceId } })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; validationId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/validations/:validationId/publication-gate',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      editor(auth)
      const { workspaceId, validationId } = request.params
      const report = await dependencies.validationService.getReport(
        workspaceId,
        validationId,
        contextFor(auth, traceId, validationId),
      )
      if (report === undefined) {
        throw new SyntheticValidationError('VALIDATION_NOT_FOUND', `validation ${validationId} is not visible`)
      }
      if (!report.publishable) {
        reply.status(409).send({
          data: {
            publishable: false,
            gate: report.gate,
            semanticPublished: report.semanticPublished,
            deploymentExecutable: report.deploymentExecutable,
          },
          meta: { traceId },
        })
        return reply
      }
      reply.status(200).send({
        data: {
          publishable: true,
          gate: report.gate,
          semanticPublished: report.semanticPublished,
          deploymentExecutable: report.deploymentExecutable,
        },
        meta: { traceId },
      })
      return reply
    },
  )

  app.post<{ Params: { workspaceId: string; exampleSetId: string } }>(
    '/api/v1/industry-workspaces/:workspaceId/synthetic-example-sets/:exampleSetId/promotions',
    async (request, reply) => {
      const traceId = readTraceId(request)
      const auth = authenticateRequest(dependencies.authenticate, request, reply)
      if (auth === undefined) return reply
      editor(auth)
      const body = request.body
      if (!isRecord(body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
      const targetDataMode = body['targetDataMode']
      if (
        typeof targetDataMode !== 'string' ||
        !(TARGET_DATA_MODES as readonly string[]).includes(targetDataMode)
      ) {
        throw new InvalidRequestFieldError('targetDataMode must be synthetic, observed or live')
      }
      const { workspaceId, exampleSetId } = request.params
      const ctx = contextFor(auth, traceId, exampleSetId)
      const targetSpaceId = body['targetSpaceId']
      const set = await dependencies.exampleService.get(workspaceId, exampleSetId, ctx)
      if (set === undefined) {
        throw new SyntheticValidationError('EXAMPLE_SET_NOT_FOUND', `example set ${exampleSetId} is not visible`)
      }
      // A synthetic sample can only ever be used for validation inside its own space; promoting
      // it to observed/live (or another scope) is refused here, in the backend.
      dependencies.validationService.assertSyntheticTarget(
        set,
        targetDataMode as 'synthetic' | 'observed' | 'live',
        { tenantId: scopeFor(auth).tenantId, spaceId: typeof targetSpaceId === 'string' ? targetSpaceId : scopeFor(auth).spaceId },
        ctx,
      )
      reply.status(200).send({ data: { promoted: false, reason: 'a synthetic sample stays a sandbox asset' }, meta: { traceId } })
      return reply
    },
  )
}
