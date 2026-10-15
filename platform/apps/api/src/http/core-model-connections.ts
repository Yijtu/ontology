import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  MODEL_CAPABILITIES,
  ModelSelectionError,
  SecretValue,
  assertModelConnectionDescriptorShape,
  isRecord,
  isUuid,
} from '@ontology/contracts'
import type {
  ModelCapability,
  ModelConnectionDescriptor,
  ModelConnectionSelection,
  ModelCapabilitySelection,
  ModelTargetScope,
} from '@ontology/contracts'
import type {
  ExecutionModelBindingService,
  ModelAssignmentService,
  ModelConnectionService,
  ModelSelectionService,
} from '@ontology/application'
import { createRequestToolContext } from './context'
import { ForbiddenError, InvalidRequestFieldError, authenticateRequest, readQueryString, scopeRefFor } from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

export interface ModelConnectionRouteDependencies {
  readonly connections: ModelConnectionService
  readonly assignments: ModelAssignmentService
  readonly selection: ModelSelectionService
  readonly bindings?: ExecutionModelBindingService
  readonly authenticate: RequestAuthenticator
  readonly webPort: number
}

/** Loopback-only: model credential management is a local operator action, never a remote API. */
function assertLocalHost(request: FastifyRequest, webPort: number): void {
  const host = request.headers.host ?? ''
  const origin = request.headers.origin
  let hostname = ''
  let hostOrigin = ''
  try {
    const url = new URL(`http://${host}`)
    if (!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) {
      hostname = url.hostname
      hostOrigin = url.origin
    }
  } catch { /* invalid hosts are rejected below */ }
  const origins = new Set([hostOrigin, `http://127.0.0.1:${String(webPort)}`, `http://localhost:${String(webPort)}`])
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || (origin !== undefined && !origins.has(origin))) {
    throw new ForbiddenError('模型连接设置仅允许从本机工作台访问。')
  }
}

function apiContext(auth: AuthenticatedRequest, request: FastifyRequest) {
  return createRequestToolContext({
    principal: auth.principal,
    spaceId: auth.spaceId,
    traceId: request.id,
    runId: globalThis.crypto.randomUUID(),
  })
}

function stringField(value: unknown, field: string, max = 1_024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n\u0000]/u.test(value)) {
    throw new InvalidRequestFieldError(`${field} must be a non-empty single-line string`)
  }
  return value.trim()
}

function optionalString(value: unknown, field: string, max = 1_024): string | undefined {
  if (value === undefined || value === null) return undefined
  return stringField(value, field, max)
}

function capabilityList(value: unknown): ModelCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MODEL_CAPABILITIES.length) {
    throw new InvalidRequestFieldError('capabilities must be a non-empty array of known capabilities')
  }
  const result: ModelCapability[] = []
  for (const entry of value) {
    if (!MODEL_CAPABILITIES.includes(entry as ModelCapability)) {
      throw new InvalidRequestFieldError(`unknown model capability ${String(entry)}`)
    }
    if (result.includes(entry as ModelCapability)) throw new InvalidRequestFieldError('capabilities must be distinct')
    result.push(entry as ModelCapability)
  }
  return result
}

function readDescriptor(value: unknown): ModelConnectionDescriptor {
  if (!isRecord(value)) throw new InvalidRequestFieldError('the connection descriptor must be a JSON object')
  if ('apiKey' in value || 'credential' in value || 'secret' in value) {
    throw new InvalidRequestFieldError('the connection descriptor must not carry a credential; write it via the credential endpoint')
  }
  if (typeof value['enabled'] !== 'boolean') throw new InvalidRequestFieldError('enabled must be a boolean')
  const baseUrl = optionalString(value['baseUrl'], 'baseUrl')
  const endpoint = optionalString(value['endpoint'], 'endpoint')
  const descriptor: ModelConnectionDescriptor = {
    name: stringField(value['name'], 'name', 200),
    adapterType: value['adapterType'] as ModelConnectionDescriptor['adapterType'],
    protocol: value['protocol'] as ModelConnectionDescriptor['protocol'],
    capabilities: capabilityList(value['capabilities']),
    enabled: value['enabled'],
    platformModelId: stringField(value['platformModelId'], 'platformModelId', 80),
    providerModelName: stringField(value['providerModelName'], 'providerModelName', 256),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(endpoint === undefined ? {} : { endpoint }),
  }
  assertModelConnectionDescriptorShape(descriptor)
  return descriptor
}

/** Read an API key from a body without ever echoing it. Blank means "leave unchanged". */
function readSecret(value: unknown): SecretValue | undefined {
  const apiKey = value === undefined ? undefined : stringField(value, 'apiKey', 4_096)
  if (apiKey === undefined) return undefined
  if (/[^\x21-\x7e]/u.test(apiKey)) throw new InvalidRequestFieldError('API Key 不能包含空白或控制字符。')
  return new SecretValue(apiKey)
}

function readSelection(value: unknown, field: string): ModelConnectionSelection {
  if (!isRecord(value)) throw new InvalidRequestFieldError(`${field} must be an object`)
  switch (value['kind']) {
    case 'inherit':
    case 'disabled':
      return { kind: value['kind'] }
    case 'connection':
      if (!isUuid(value['connectionId'])) throw new InvalidRequestFieldError(`${field}.connectionId must be a uuid`)
      return { kind: 'connection', connectionId: value['connectionId'] }
    default:
      throw new InvalidRequestFieldError(`${field}.kind must be inherit, disabled or connection`)
  }
}

function readCapabilitySelections(value: unknown): ModelCapabilitySelection[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new InvalidRequestFieldError('capabilitySelections must be an array')
  const result: ModelCapabilitySelection[] = []
  for (const entry of value) {
    if (!isRecord(entry) || !MODEL_CAPABILITIES.includes(entry['capability'] as ModelCapability)) {
      throw new InvalidRequestFieldError('each capability selection must name a known capability')
    }
    result.push({
      capability: entry['capability'] as ModelCapability,
      selection: readSelection(entry['selection'], 'selection'),
    })
  }
  return result
}

function readScope(value: unknown): ModelTargetScope {
  if (!isRecord(value)) throw new InvalidRequestFieldError('scope must be an object')
  switch (value['kind']) {
    case 'space':
      return { kind: 'space' }
    case 'industry_workspace':
      if (!isUuid(value['workspaceId'])) throw new InvalidRequestFieldError('scope.workspaceId must be a uuid')
      return { kind: 'industry_workspace', workspaceId: value['workspaceId'] }
    case 'project':
      if (!isUuid(value['projectId'])) throw new InvalidRequestFieldError('scope.projectId must be a uuid')
      return { kind: 'project', projectId: value['projectId'] }
    default:
      throw new InvalidRequestFieldError('scope.kind must be space, industry_workspace or project')
  }
}

function readScopeQuery(request: FastifyRequest): ModelTargetScope {
  const raw = readQueryString(request, 'scope') ?? 'space'
  if (raw === 'space') return { kind: 'space' }
  const [kind, id] = raw.split(':')
  if (kind === 'workspace' && id !== undefined && isUuid(id)) return { kind: 'industry_workspace', workspaceId: id }
  if (kind === 'project' && id !== undefined && isUuid(id)) return { kind: 'project', projectId: id }
  throw new InvalidRequestFieldError('scope must be "space", "workspace:<uuid>" or "project:<uuid>"')
}

function idempotencyKeyOf(request: FastifyRequest, body: Record<string, unknown>): string {
  const header = request.headers['idempotency-key']
  const raw = Array.isArray(header) ? header[0] : header
  const key = typeof raw === 'string' && raw.length > 0 ? raw : body['idempotencyKey']
  if (typeof key !== 'string') throw new InvalidRequestFieldError('an Idempotency-Key header or body idempotencyKey is required')
  return key
}

/**
 * `/api/v1/core/ai` route group (design §5.3, A-R09/A-R10/A-R11).
 *
 * All target ids in the path/query are untrusted: the tenant/space come from authentication and
 * the target ownership is re-checked by the services through the trusted directory. Credential
 * values are read from the body, immediately wrapped in the non-serializable `SecretValue` and
 * handed to the custodian; they are never returned, echoed or logged.
 */
export function registerModelConnectionRoutes(app: FastifyInstance, input: ModelConnectionRouteDependencies): void {
  const requireAuth = (request: FastifyRequest, reply: import('fastify').FastifyReply): AuthenticatedRequest | undefined => {
    assertLocalHost(request, input.webPort)
    return authenticateRequest(input.authenticate, request, reply)
  }

  app.get('/api/v1/core/ai/model-connections', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const body = isRecord(request.body) ? request.body : {}
    const capability = readQueryString(request, 'capability')
    const enabledRaw = readQueryString(request, 'enabled')
    const limitRaw = readQueryString(request, 'limit')
    const filter: { enabled?: boolean; capability?: ModelCapability; limit?: number } = {}
    if (enabledRaw === 'true') filter.enabled = true
    else if (enabledRaw === 'false') filter.enabled = false
    if (capability !== undefined) {
      if (!MODEL_CAPABILITIES.includes(capability as ModelCapability)) throw new InvalidRequestFieldError('unknown capability filter')
      filter.capability = capability as ModelCapability
    }
    if (limitRaw !== undefined) filter.limit = Number(limitRaw)
    void body
    return { data: await input.connections.list(filter, apiContext(auth, request)) }
  })

  app.post('/api/v1/core/ai/model-connections', { bodyLimit: 32_768 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const descriptor = readDescriptor(request.body['descriptor'])
    const credential = readSecret(request.body['apiKey'])
    const data = await input.connections.create({
      descriptor,
      idempotencyKey: idempotencyKeyOf(request, request.body),
      ...(credential === undefined ? {} : { credential }),
    }, apiContext(auth, request))
    return reply.status(201).send({ data })
  })

  app.get<{ Params: { id: string } }>('/api/v1/core/ai/model-connections/:id', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const value = await input.connections.get(request.params.id, apiContext(auth, request))
    if (value === undefined) throw new ModelSelectionError('NOT_FOUND', 'the connection is not visible in this scope')
    return { data: value }
  })

  app.put<{ Params: { id: string } }>('/api/v1/core/ai/model-connections/:id', { bodyLimit: 32_768 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const descriptor = readDescriptor(request.body['descriptor'])
    const credential = readSecret(request.body['apiKey'])
    if (typeof request.body['expectedRevision'] !== 'string') throw new InvalidRequestFieldError('expectedRevision is required')
    const data = await input.connections.update({
      connectionId: request.params.id,
      descriptor,
      expectedRevision: request.body['expectedRevision'],
      idempotencyKey: idempotencyKeyOf(request, request.body),
      ...(credential === undefined ? {} : { credential }),
      ...(request.body['clearCredential'] === true ? { clearCredential: true } : {}),
    }, apiContext(auth, request))
    return { data }
  })

  app.delete<{ Params: { id: string } }>('/api/v1/core/ai/model-connections/:id', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    await input.connections.remove(request.params.id, apiContext(auth, request))
    return reply.status(204).send()
  })

  app.post<{ Params: { id: string } }>('/api/v1/core/ai/model-connections/:id/copy', { bodyLimit: 8_192 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const data = await input.connections.copy({
      sourceConnectionId: request.params.id,
      name: stringField(request.body['name'], 'name', 200),
      idempotencyKey: idempotencyKeyOf(request, request.body),
    }, apiContext(auth, request))
    return reply.status(201).send({ data })
  })

  app.put<{ Params: { id: string } }>('/api/v1/core/ai/model-connections/:id/credential', { bodyLimit: 16_384 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const action = request.body['action']
    const ctx = apiContext(auth, request)
    if (action === 'clear') {
      return { data: await input.connections.setCredential({ connectionId: request.params.id, action: 'clear' }, ctx) }
    }
    if (action === 'set') {
      const secret = readSecret(request.body['apiKey'])
      if (secret === undefined) throw new InvalidRequestFieldError('apiKey is required to set a credential')
      return { data: await input.connections.setCredential({ connectionId: request.params.id, action: 'set', secret }, ctx) }
    }
    throw new InvalidRequestFieldError('action must be set or clear')
  })

  app.post<{ Params: { id: string } }>('/api/v1/core/ai/model-connections/:id/test', { bodyLimit: 8_192 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    request.raw.once('aborted', abort)
    reply.raw.once('close', abort)
    try {
      return { data: await input.connections.testStored(request.params.id, apiContext(auth, request), controller.signal) }
    } finally {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', abort)
    }
  })

  app.post('/api/v1/core/ai/model-connection-tests', { bodyLimit: 32_768 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const credential = readSecret(request.body['apiKey'])
    const controller = new AbortController()
    const abort = () => { if (!reply.raw.writableEnded) controller.abort() }
    request.raw.once('aborted', abort)
    reply.raw.once('close', abort)
    try {
      return {
        data: await input.connections.testDraft({
          descriptor: readDescriptor(request.body['descriptor']),
          ...(credential === undefined ? {} : { credential }),
          signal: controller.signal,
        }, apiContext(auth, request)),
      }
    } finally {
      request.raw.removeListener('aborted', abort)
      reply.raw.removeListener('close', abort)
    }
  })

  app.get('/api/v1/core/ai/model-options', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const capabilityRaw = readQueryString(request, 'capability')
    let capability: ModelCapability | undefined
    if (capabilityRaw !== undefined) {
      if (!MODEL_CAPABILITIES.includes(capabilityRaw as ModelCapability)) throw new InvalidRequestFieldError('unknown capability filter')
      capability = capabilityRaw as ModelCapability
    }
    const options = await input.connections.list({
      enabled: true,
      ...(capability === undefined ? {} : { capability }),
    }, apiContext(auth, request))
    return { data: options }
  })

  app.get('/api/v1/core/ai/model-assignments', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const scope = readScopeQuery(request)
    const ctx = apiContext(auth, request)
    const data = await input.assignments.get(scope, ctx)
    return { data: data ?? null }
  })

  app.put('/api/v1/core/ai/model-assignments', { bodyLimit: 32_768 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const scope = readScope(request.body['scope'])
    const write = {
      scope,
      defaultSelection: readSelection(request.body['defaultSelection'], 'defaultSelection'),
      capabilitySelections: readCapabilitySelections(request.body['capabilitySelections']),
      ...(typeof request.body['expectedRevision'] === 'string' ? { expectedRevision: request.body['expectedRevision'] } : {}),
    }
    const data = await input.assignments.put(write, apiContext(auth, request))
    return { data }
  })

  app.get('/api/v1/core/ai/effective-models', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const scope = readScopeQuery(request)
    const capabilitiesRaw = readQueryString(request, 'capabilities')
    const capabilities = capabilitiesRaw === undefined
      ? [...MODEL_CAPABILITIES]
      : capabilitiesRaw.split(',').map((entry) => {
        if (!MODEL_CAPABILITIES.includes(entry as ModelCapability)) throw new InvalidRequestFieldError('unknown capability filter')
        return entry as ModelCapability
      })
    const ctx = apiContext(auth, request)
    return { data: await input.selection.resolveAll(scopeRefFor(auth), { scope, capabilities }, ctx) }
  })

  app.post('/api/v1/core/ai/model-change-previews', { bodyLimit: 32_768 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const scope = readScope(request.body['scope'])
    const write = {
      scope,
      defaultSelection: readSelection(request.body['defaultSelection'], 'defaultSelection'),
      capabilitySelections: readCapabilitySelections(request.body['capabilitySelections']),
    }
    const ctx = apiContext(auth, request)
    await input.assignments.validate(write, ctx)
    const before = await input.selection.resolveAll(scopeRefFor(auth), { scope, capabilities: [...MODEL_CAPABILITIES] }, ctx)
    return { data: { scope, before, proposed: { defaultSelection: write.defaultSelection, capabilitySelections: write.capabilitySelections } } }
  })
}
