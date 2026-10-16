import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  SecretValue,
  ToolConnectionError,
  assertToolConnectionDescriptorShape,
  isRecord,
  isUuid,
} from '@ontology/contracts'
import type {
  ToolAdapterType,
  ToolConnectionCapability,
  ToolConnectionDescriptor,
  ToolConnectionSelection,
  ToolConnectionSelectionEntry,
  ToolTargetScope,
} from '@ontology/contracts'
import type {
  ToolAssignmentService,
  ToolConnectionService,
  ToolSelectionService,
} from '@ontology/application'
import { createRequestToolContext } from './context'
import { ForbiddenError, InvalidRequestFieldError, authenticateRequest, readQueryString, scopeRefFor } from './shared'
import type { AuthenticatedRequest, RequestAuthenticator } from './shared'

const TOOL_IDS: readonly ToolConnectionCapability[] = ['ontology_lookup', 'data_query', 'document_search', 'web_search']
const ADAPTER_TYPES: readonly ToolAdapterType[] = ['native_tavily', 'http_compat']

export interface ToolConnectionRouteDependencies {
  readonly connections: ToolConnectionService
  readonly assignments: ToolAssignmentService
  readonly selection: ToolSelectionService
  readonly authenticate: RequestAuthenticator
  readonly webPort: number
}

/** Loopback-only: tool credential management is a local operator action, never a remote API. */
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
    throw new ForbiddenError('工具连接设置仅允许从本机工作台访问。')
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

function adapterType(value: unknown): ToolAdapterType {
  if (!ADAPTER_TYPES.includes(value as ToolAdapterType)) {
    throw new InvalidRequestFieldError('adapterType must be native_tavily or http_compat')
  }
  return value as ToolAdapterType
}

function capabilityList(value: unknown): ToolConnectionCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TOOL_IDS.length) {
    throw new InvalidRequestFieldError('capabilities must be a non-empty array of known tools')
  }
  const result: ToolConnectionCapability[] = []
  for (const entry of value) {
    if (!TOOL_IDS.includes(entry as ToolConnectionCapability)) {
      throw new InvalidRequestFieldError(`unknown tool capability ${String(entry)}`)
    }
    if (result.includes(entry as ToolConnectionCapability)) throw new InvalidRequestFieldError('capabilities must be distinct')
    result.push(entry as ToolConnectionCapability)
  }
  return result
}

function readDescriptor(value: unknown): ToolConnectionDescriptor {
  if (!isRecord(value)) throw new InvalidRequestFieldError('the connection descriptor must be a JSON object')
  if ('apiKey' in value || 'credential' in value || 'secret' in value) {
    throw new InvalidRequestFieldError('the connection descriptor must not carry a credential; write it via the credential endpoint')
  }
  if (typeof value['enabled'] !== 'boolean') throw new InvalidRequestFieldError('enabled must be a boolean')
  const endpoint = optionalString(value['endpoint'], 'endpoint')
  const descriptor: ToolConnectionDescriptor = {
    name: stringField(value['name'], 'name', 200),
    adapterType: adapterType(value['adapterType']),
    capabilities: capabilityList(value['capabilities']),
    enabled: value['enabled'],
    ...(endpoint === undefined ? {} : { endpoint }),
  }
  assertToolConnectionDescriptorShape(descriptor)
  return descriptor
}

/** Read an API key from a body without ever echoing it. Blank means "leave unchanged". */
function readSecret(value: unknown): SecretValue | undefined {
  const apiKey = value === undefined ? undefined : stringField(value, 'apiKey', 4_096)
  if (apiKey === undefined) return undefined
  if (/[^\x21-\x7e]/u.test(apiKey)) throw new InvalidRequestFieldError('API Key 不能包含空白或控制字符。')
  return new SecretValue(apiKey)
}

function readSelection(value: unknown, field: string): ToolConnectionSelection {
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

function readToolSelections(value: unknown): ToolConnectionSelectionEntry[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new InvalidRequestFieldError('toolSelections must be an array')
  const result: ToolConnectionSelectionEntry[] = []
  for (const entry of value) {
    if (!isRecord(entry) || !TOOL_IDS.includes(entry['toolId'] as ToolConnectionCapability)) {
      throw new InvalidRequestFieldError('each tool selection must name a known tool')
    }
    result.push({
      toolId: entry['toolId'] as ToolConnectionCapability,
      selection: readSelection(entry['selection'], 'selection'),
    })
  }
  return result
}

function readScope(value: unknown): ToolTargetScope {
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

function readScopeQuery(request: FastifyRequest): ToolTargetScope {
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
 * `/api/v1/core/ai` tool route group (design §9).
 *
 * All target ids in the path/query are untrusted: the tenant/space come from authentication and the
 * target ownership is re-checked by the services through the trusted directory. Credential values
 * are read from the body, immediately wrapped in the non-serializable `SecretValue` and handed to
 * the custodian; they are never returned, echoed or logged. A tool connection is a different entity
 * from a model connection and is addressed on its own route group.
 */
export function registerToolConnectionRoutes(app: FastifyInstance, input: ToolConnectionRouteDependencies): void {
  const requireAuth = (request: FastifyRequest, reply: import('fastify').FastifyReply): AuthenticatedRequest | undefined => {
    assertLocalHost(request, input.webPort)
    return authenticateRequest(input.authenticate, request, reply)
  }

  app.get('/api/v1/core/ai/tool-connections', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const capability = readQueryString(request, 'capability')
    const enabledRaw = readQueryString(request, 'enabled')
    const limitRaw = readQueryString(request, 'limit')
    const filter: { enabled?: boolean; capability?: ToolConnectionCapability; limit?: number } = {}
    if (enabledRaw === 'true') filter.enabled = true
    else if (enabledRaw === 'false') filter.enabled = false
    if (capability !== undefined) {
      if (!TOOL_IDS.includes(capability as ToolConnectionCapability)) throw new InvalidRequestFieldError('unknown capability filter')
      filter.capability = capability as ToolConnectionCapability
    }
    if (limitRaw !== undefined) filter.limit = Number(limitRaw)
    return { data: await input.connections.list(filter, apiContext(auth, request)) }
  })

  app.post('/api/v1/core/ai/tool-connections', { bodyLimit: 32_768 }, async (request, reply) => {
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

  app.get<{ Params: { id: string } }>('/api/v1/core/ai/tool-connections/:id', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const value = await input.connections.get(request.params.id, apiContext(auth, request))
    if (value === undefined) throw new ToolConnectionError('NOT_FOUND', 'the connection is not visible in this scope')
    return { data: value }
  })

  app.put<{ Params: { id: string } }>('/api/v1/core/ai/tool-connections/:id', { bodyLimit: 32_768 }, async (request, reply) => {
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

  app.delete<{ Params: { id: string } }>('/api/v1/core/ai/tool-connections/:id', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    await input.connections.remove(request.params.id, apiContext(auth, request))
    return reply.status(204).send()
  })

  app.post<{ Params: { id: string } }>('/api/v1/core/ai/tool-connections/:id/copy', { bodyLimit: 8_192 }, async (request, reply) => {
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

  app.put<{ Params: { id: string } }>('/api/v1/core/ai/tool-connections/:id/credential', { bodyLimit: 16_384 }, async (request, reply) => {
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

  app.post<{ Params: { id: string } }>('/api/v1/core/ai/tool-connections/:id/test', { bodyLimit: 8_192 }, async (request, reply) => {
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

  app.post('/api/v1/core/ai/tool-connection-tests', { bodyLimit: 32_768 }, async (request, reply) => {
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

  app.get('/api/v1/core/ai/tool-assignments', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const scope = readScopeQuery(request)
    const data = await input.assignments.get(scope, apiContext(auth, request))
    return { data: data ?? null }
  })

  app.put('/api/v1/core/ai/tool-assignments', { bodyLimit: 32_768 }, async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const write = {
      scope: readScope(request.body['scope']),
      defaultSelection: readSelection(request.body['defaultSelection'], 'defaultSelection'),
      toolSelections: readToolSelections(request.body['toolSelections']),
      ...(typeof request.body['expectedRevision'] === 'string' ? { expectedRevision: request.body['expectedRevision'] } : {}),
    }
    const data = await input.assignments.put(write, apiContext(auth, request))
    return { data }
  })

  app.get('/api/v1/core/ai/effective-tools', async (request, reply) => {
    const auth = requireAuth(request, reply)
    if (auth === undefined) return reply
    const scope = readScopeQuery(request)
    const toolsRaw = readQueryString(request, 'tools')
    const toolIds = toolsRaw === undefined
      ? [...TOOL_IDS]
      : toolsRaw.split(',').map((entry) => {
        if (!TOOL_IDS.includes(entry as ToolConnectionCapability)) throw new InvalidRequestFieldError('unknown tool filter')
        return entry as ToolConnectionCapability
      })
    const ctx = apiContext(auth, request)
    return { data: await input.selection.resolveAll(scopeRefFor(auth), { scope, toolIds }, ctx) }
  })
}
