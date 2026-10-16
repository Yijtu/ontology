import { TOOL_IDS } from '@ontology/contracts'
import type {
  EffectiveToolSelection,
  EffectiveToolState,
  ToolAdapterType,
  ToolAssignmentSet,
  ToolConnectionAdminView,
  ToolConnectionCapability,
  ToolConnectionDescriptor,
  ToolConnectionProbeItem,
  ToolConnectionProbeReason,
  ToolConnectionProbeResult,
  ToolConnectionProbeStatus,
  ToolConnectionSelection,
  ToolConnectionSelectionEntry,
  ToolConnectionSummary,
  ToolCredentialState,
  ToolSelectionReason,
  ToolSelectionSource,
  ToolTargetScope,
} from '@ontology/contracts'
import type { WorkbenchClient } from './client'
import { isRecord, malformed } from './model-settings'

export type {
  EffectiveToolSelection,
  EffectiveToolState,
  ToolAdapterType,
  ToolAssignmentSet,
  ToolConnectionAdminView,
  ToolConnectionCapability,
  ToolConnectionDescriptor,
  ToolConnectionProbeItem,
  ToolConnectionProbeReason,
  ToolConnectionProbeResult,
  ToolConnectionProbeStatus,
  ToolConnectionSelection,
  ToolConnectionSelectionEntry,
  ToolConnectionSummary,
  ToolCredentialState,
  ToolSelectionReason,
  ToolSelectionSource,
  ToolTargetScope,
} from '@ontology/contracts'

export { TOOL_IDS }

const AI = '/api/v1/core/ai'

const ADAPTER_TYPES: readonly ToolAdapterType[] = ['native_tavily', 'http_compat']
const CREDENTIAL_STATES: readonly ToolCredentialState[] = ['present', 'missing', 'revoked']
const PROBE_STATUSES: readonly ToolConnectionProbeStatus[] = ['passed', 'failed', 'skipped']
const PROBE_REASONS: readonly ToolConnectionProbeReason[] = [
  'authentication_failed', 'timeout', 'rate_limited', 'protocol_mismatch', 'unreachable',
  'invalid_response', 'page_not_readable', 'digest_mismatch', 'not_configured',
]
const EFFECTIVE_STATES: readonly EffectiveToolState[] = ['available', 'unconfigured', 'disabled', 'blocked']
const SELECTION_SOURCES: readonly ToolSelectionSource[] = [
  'object_tool', 'object_default', 'space_tool', 'space_default', 'unconfigured',
]
const SELECTION_REASONS: readonly ToolSelectionReason[] = [
  'TOOL_NOT_CONFIGURED', 'TOOL_DISABLED', 'TOOL_CAPABILITY_MISMATCH',
  'CREDENTIAL_MISSING', 'TOOL_IN_USE', 'TOOL_BINDING_REVOKED',
]

/**
 * The AI-settings client for the tool-connection route group (design §9). A tool connection (e.g. a
 * `web_search` service) is a **different entity** from a model connection and is addressed on its own
 * route group, so a search service can never be registered as a generation model.
 *
 * Every reader parses strictly and rejects any credential-shaped field, so a read response that
 * accidentally carried a secret never reaches a component. The search and archive probe outcomes are
 * read as two separate items: "接口适配完成" is never read as "真实可用". All JSON here is non-secret
 * metadata; target ids in a path/query are untrusted and the server re-checks ownership.
 */

function rejectSecretKeys(value: Record<string, unknown>, context: string): void {
  for (const key of ['apiKey', 'credential', 'secret']) {
    if (key in value) malformed(`${context} 不应携带凭据值。`)
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) malformed(`${context} 含有无法识别的字段。`)
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
}

function isToolCapability(value: unknown): value is ToolConnectionCapability {
  return TOOL_IDS.includes(value as ToolConnectionCapability)
}

function capabilityList(value: unknown, context: string): readonly ToolConnectionCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > TOOL_IDS.length) malformed(`${context}提供的能力列表无法识别。`)
  const seen = new Set<ToolConnectionCapability>()
  for (const entry of value) {
    if (!isToolCapability(entry)) malformed(`${context}声明了未知能力。`)
    if (seen.has(entry)) malformed(`${context}的能力列表出现重复项。`)
    seen.add(entry)
  }
  return [...seen]
}

export function parseToolTargetScope(value: unknown): ToolTargetScope {
  if (!isRecord(value)) malformed('作用域无法识别。')
  switch (value['kind']) {
    case 'space':
      onlyKeys(value, ['kind'], '空间作用域')
      return { kind: 'space' }
    case 'industry_workspace':
      if (!isUuid(value['workspaceId'])) malformed('工作区作用域缺少有效 ID。')
      onlyKeys(value, ['kind', 'workspaceId'], '工作区作用域')
      return { kind: 'industry_workspace', workspaceId: value['workspaceId'] }
    case 'project':
      if (!isUuid(value['projectId'])) malformed('项目作用域缺少有效 ID。')
      onlyKeys(value, ['kind', 'projectId'], '项目作用域')
      return { kind: 'project', projectId: value['projectId'] }
    default:
      malformed('作用域种类无法识别。')
  }
}

function parseSelection(value: unknown): ToolConnectionSelection {
  if (!isRecord(value)) malformed('工具选择无法识别。')
  switch (value['kind']) {
    case 'inherit':
    case 'disabled':
      onlyKeys(value, ['kind'], '工具选择')
      return { kind: value['kind'] }
    case 'connection':
      if (!isUuid(value['connectionId'])) malformed('工具连接引用缺少有效 ID。')
      onlyKeys(value, ['kind', 'connectionId'], '工具连接引用')
      return { kind: 'connection', connectionId: value['connectionId'] }
    default:
      malformed('工具选择的 kind 无法识别。')
  }
}

function parseProbeItem(value: unknown, context: string): ToolConnectionProbeItem {
  if (!isRecord(value)) malformed(`${context}无法识别。`)
  onlyKeys(value, ['status', 'reason', 'latencyMs'], context)
  if (!PROBE_STATUSES.includes(value['status'] as ToolConnectionProbeStatus)) malformed(`${context}状态无法识别。`)
  if (value['reason'] !== undefined && !PROBE_REASONS.includes(value['reason'] as ToolConnectionProbeReason)) {
    malformed(`${context}原因码无法识别。`)
  }
  if (value['latencyMs'] !== undefined && (!Number.isSafeInteger(value['latencyMs']) || (value['latencyMs'] as number) < 0)) {
    malformed(`${context}耗时无法识别。`)
  }
  return {
    status: value['status'] as ToolConnectionProbeStatus,
    ...(value['reason'] === undefined ? {} : { reason: value['reason'] as ToolConnectionProbeReason }),
    ...(value['latencyMs'] === undefined ? {} : { latencyMs: value['latencyMs'] as number }),
  }
}

const PROBE_KEYS = [
  'schemaVersion', 'connectionId', 'connectionRevision', 'testedAt', 'draft', 'credentialConfigured', 'search', 'archive',
] as const

export function parseToolConnectionProbeResult(value: unknown): ToolConnectionProbeResult {
  if (!isRecord(value)) malformed('工具连接测试结果无法识别。')
  rejectSecretKeys(value, '工具连接测试结果')
  onlyKeys(value, PROBE_KEYS, '工具连接测试结果')
  if (value['schemaVersion'] !== 'tool-connection-test-result@1'
    || !nonEmptyString(value['testedAt'])
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['connectionRevision'] !== undefined && !nonEmptyString(value['connectionRevision']))
    || typeof value['draft'] !== 'boolean' || typeof value['credentialConfigured'] !== 'boolean') {
    malformed('工具连接测试结果格式无法识别。')
  }
  return {
    schemaVersion: 'tool-connection-test-result@1',
    testedAt: value['testedAt'],
    draft: value['draft'],
    credentialConfigured: value['credentialConfigured'],
    search: parseProbeItem(value['search'], '搜索测试项'),
    archive: parseProbeItem(value['archive'], '归档测试项'),
    ...(value['connectionId'] === undefined ? {} : { connectionId: value['connectionId'] as string }),
    ...(value['connectionRevision'] === undefined ? {} : { connectionRevision: value['connectionRevision'] as string }),
  }
}

const SUMMARY_KEYS = [
  'connectionId', 'name', 'revision', 'adapterType', 'capabilities',
  'enabled', 'credentialState', 'probeSummary', 'updatedAt',
] as const
const ADMIN_KEYS = [...SUMMARY_KEYS, 'endpoint'] as const

export function parseToolConnectionAdminView(value: unknown, context = '工具连接'): ToolConnectionAdminView {
  if (!isRecord(value)) malformed(`${context}无法识别。`)
  rejectSecretKeys(value, context)
  onlyKeys(value, ADMIN_KEYS, context)
  if (!isUuid(value['connectionId']) || !nonEmptyString(value['name']) || !nonEmptyString(value['revision'])
    || !ADAPTER_TYPES.includes(value['adapterType'] as ToolAdapterType)
    || !nonEmptyString(value['updatedAt'])
    || typeof value['enabled'] !== 'boolean'
    || !CREDENTIAL_STATES.includes(value['credentialState'] as ToolCredentialState)) {
    malformed(`${context}格式无法识别；读取响应中的凭据不会被接受。`)
  }
  const probeSummary = value['probeSummary'] === undefined
    ? undefined
    : parseToolConnectionProbeResult(value['probeSummary'])
  return {
    connectionId: value['connectionId'],
    name: value['name'],
    revision: value['revision'],
    adapterType: value['adapterType'] as ToolAdapterType,
    capabilities: capabilityList(value['capabilities'], context),
    enabled: value['enabled'],
    credentialState: value['credentialState'] as ToolCredentialState,
    updatedAt: value['updatedAt'],
    ...(probeSummary === undefined ? {} : { probeSummary }),
    ...(value['endpoint'] === undefined
      ? {}
      : { endpoint: nonEmptyString(value['endpoint']) ? value['endpoint'] : malformed(`${context}服务端点无法识别。`) }),
  }
}

function parseConnectionSummary(value: unknown, context: string): ToolConnectionSummary {
  if (!isRecord(value)) malformed(`${context}无法识别。`)
  rejectSecretKeys(value, context)
  onlyKeys(value, SUMMARY_KEYS, context)
  const admin = parseToolConnectionAdminView({ ...value }, context)
  return {
    connectionId: admin.connectionId,
    name: admin.name,
    revision: admin.revision,
    adapterType: admin.adapterType,
    capabilities: admin.capabilities,
    enabled: admin.enabled,
    credentialState: admin.credentialState,
    updatedAt: admin.updatedAt,
    ...(admin.probeSummary === undefined ? {} : { probeSummary: admin.probeSummary }),
  }
}

function parseConnectionList(value: unknown): readonly ToolConnectionAdminView[] {
  if (!Array.isArray(value)) malformed('工具连接列表无法识别。')
  return value.map((entry) => parseToolConnectionAdminView(entry))
}

function parseToolSelections(value: unknown): readonly ToolConnectionSelectionEntry[] {
  if (!Array.isArray(value)) malformed('工具分配无法识别。')
  const seen = new Set<ToolConnectionCapability>()
  const result: ToolConnectionSelectionEntry[] = []
  for (const entry of value) {
    if (!isRecord(entry) || !isToolCapability(entry['toolId'])) malformed('工具分配项无法识别。')
    if (seen.has(entry['toolId'])) malformed('工具分配出现重复工具。')
    seen.add(entry['toolId'])
    result.push({ toolId: entry['toolId'], selection: parseSelection(entry['selection']) })
  }
  return result
}

export function parseToolAssignmentSet(value: unknown): ToolAssignmentSet {
  if (!isRecord(value)) malformed('工具分配无法识别。')
  onlyKeys(value, ['schemaVersion', 'scope', 'defaultSelection', 'toolSelections', 'revision', 'updatedAt'], '工具分配')
  if (value['schemaVersion'] !== 'tool-assignment-set@1' || !nonEmptyString(value['revision']) || !nonEmptyString(value['updatedAt'])) {
    malformed('工具分配格式无法识别。')
  }
  return {
    schemaVersion: 'tool-assignment-set@1',
    scope: parseToolTargetScope(value['scope']),
    defaultSelection: parseSelection(value['defaultSelection']),
    toolSelections: parseToolSelections(value['toolSelections']),
    revision: value['revision'],
    updatedAt: value['updatedAt'],
  }
}

export function parseEffectiveToolSelection(value: unknown): EffectiveToolSelection {
  if (!isRecord(value)) malformed('生效工具无法识别。')
  rejectSecretKeys(value, '生效工具')
  onlyKeys(value, ['schemaVersion', 'scope', 'toolId', 'selection', 'resolvedFrom', 'state', 'connectionId', 'connectionSummary', 'assignmentRevision', 'blockedReason', 'resolvedAt'], '生效工具')
  if (value['schemaVersion'] !== 'effective-tool-selection@1' || !isToolCapability(value['toolId'])
    || !SELECTION_SOURCES.includes(value['resolvedFrom'] as ToolSelectionSource)
    || !EFFECTIVE_STATES.includes(value['state'] as EffectiveToolState)
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['assignmentRevision'] !== undefined && !nonEmptyString(value['assignmentRevision']))
    || (value['blockedReason'] !== undefined && !SELECTION_REASONS.includes(value['blockedReason'] as ToolSelectionReason))
    || !nonEmptyString(value['resolvedAt'])) {
    malformed('生效工具格式无法识别。')
  }
  const state = value['state'] as EffectiveToolState
  if (state === 'available' && value['connectionId'] === undefined) malformed('可用工具必须指向一个连接。')
  const connectionSummary = value['connectionSummary'] === undefined
    ? undefined
    : parseConnectionSummary(value['connectionSummary'], '生效工具连接摘要')
  return {
    schemaVersion: 'effective-tool-selection@1',
    scope: parseToolTargetScope(value['scope']),
    toolId: value['toolId'],
    selection: parseSelection(value['selection']),
    resolvedFrom: value['resolvedFrom'] as ToolSelectionSource,
    state,
    resolvedAt: value['resolvedAt'],
    ...(value['connectionId'] === undefined ? {} : { connectionId: value['connectionId'] as string }),
    ...(connectionSummary === undefined ? {} : { connectionSummary }),
    ...(value['assignmentRevision'] === undefined ? {} : { assignmentRevision: value['assignmentRevision'] as string }),
    ...(value['blockedReason'] === undefined ? {} : { blockedReason: value['blockedReason'] as ToolSelectionReason }),
  }
}

function scopeQuery(scope: ToolTargetScope): string {
  switch (scope.kind) {
    case 'space':
      return 'space'
    case 'industry_workspace':
      return `workspace:${scope.workspaceId}`
    case 'project':
      return `project:${scope.projectId}`
  }
}

function signalOption(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

export interface ToolConnectionListFilter {
  readonly capability?: ToolConnectionCapability
  readonly enabled?: boolean
}

export async function readToolConnections(
  client: Pick<WorkbenchClient, 'requestJson'>,
  filter: ToolConnectionListFilter = {},
  signal?: AbortSignal,
): Promise<readonly ToolConnectionAdminView[]> {
  const query = new URLSearchParams()
  if (filter.capability !== undefined) query.set('capability', filter.capability)
  if (filter.enabled !== undefined) query.set('enabled', String(filter.enabled))
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  const value = await client.requestJson<unknown>('GET', `${AI}/tool-connections${suffix}`, signalOption(signal))
  return parseConnectionList(value)
}

export async function readToolConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  connectionId: string,
  signal?: AbortSignal,
): Promise<ToolConnectionAdminView> {
  const value = await client.requestJson<unknown>('GET', `${AI}/tool-connections/${encodeURIComponent(connectionId)}`, signalOption(signal))
  return parseToolConnectionAdminView(value)
}

export async function createToolConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: { readonly descriptor: ToolConnectionDescriptor; readonly apiKey?: string; readonly idempotencyKey: string },
  signal?: AbortSignal,
): Promise<ToolConnectionAdminView> {
  const value = await client.requestJson<unknown>('POST', `${AI}/tool-connections`, {
    body: { descriptor: input.descriptor, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }), idempotencyKey: input.idempotencyKey },
    ...signalOption(signal),
  })
  return parseToolConnectionAdminView(value)
}

export async function updateToolConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  connectionId: string,
  input: {
    readonly descriptor: ToolConnectionDescriptor
    readonly expectedRevision: string
    readonly apiKey?: string
    readonly clearCredential?: boolean
    readonly idempotencyKey: string
  },
  signal?: AbortSignal,
): Promise<ToolConnectionAdminView> {
  const value = await client.requestJson<unknown>('PUT', `${AI}/tool-connections/${encodeURIComponent(connectionId)}`, {
    body: {
      descriptor: input.descriptor,
      expectedRevision: input.expectedRevision,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.clearCredential === true ? { clearCredential: true } : {}),
      idempotencyKey: input.idempotencyKey,
    },
    ...signalOption(signal),
  })
  return parseToolConnectionAdminView(value)
}

export async function copyToolConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  sourceConnectionId: string,
  input: { readonly name: string; readonly idempotencyKey: string },
  signal?: AbortSignal,
): Promise<ToolConnectionAdminView> {
  const value = await client.requestJson<unknown>('POST', `${AI}/tool-connections/${encodeURIComponent(sourceConnectionId)}/copy`, {
    body: { name: input.name, idempotencyKey: input.idempotencyKey },
    ...signalOption(signal),
  })
  return parseToolConnectionAdminView(value)
}

export async function deleteToolConnection(
  client: Pick<WorkbenchClient, 'requestVoid'>,
  connectionId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.requestVoid('DELETE', `${AI}/tool-connections/${encodeURIComponent(connectionId)}`, signalOption(signal))
}

/** Probe a stored connection; search and archive outcomes are reported separately, never echoed. */
export async function testStoredToolConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  connectionId: string,
  signal?: AbortSignal,
): Promise<ToolConnectionProbeResult> {
  const value = await client.requestJson<unknown>('POST', `${AI}/tool-connections/${encodeURIComponent(connectionId)}/test`, signalOption(signal))
  return parseToolConnectionProbeResult(value)
}

/** Probe an unsaved draft; the draft credential is staged server-side, used and then discarded. */
export async function testDraftToolConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: { readonly descriptor: ToolConnectionDescriptor; readonly apiKey?: string },
  signal?: AbortSignal,
): Promise<ToolConnectionProbeResult> {
  const value = await client.requestJson<unknown>('POST', `${AI}/tool-connection-tests`, {
    body: { descriptor: input.descriptor, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }) },
    ...signalOption(signal),
  })
  return parseToolConnectionProbeResult(value)
}

export async function readToolAssignments(
  client: Pick<WorkbenchClient, 'requestJson'>,
  scope: ToolTargetScope,
  signal?: AbortSignal,
): Promise<ToolAssignmentSet | undefined> {
  const value = await client.requestJson<unknown>('GET', `${AI}/tool-assignments?scope=${encodeURIComponent(scopeQuery(scope))}`, signalOption(signal))
  if (value === null) return undefined
  return parseToolAssignmentSet(value)
}

export interface ToolAssignmentWrite {
  readonly scope: ToolTargetScope
  readonly defaultSelection: ToolConnectionSelection
  readonly toolSelections: readonly ToolConnectionSelectionEntry[]
  readonly expectedRevision?: string
}

export async function saveToolAssignments(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: ToolAssignmentWrite,
  signal?: AbortSignal,
): Promise<ToolAssignmentSet> {
  const value = await client.requestJson<unknown>('PUT', `${AI}/tool-assignments`, {
    body: {
      scope: input.scope,
      defaultSelection: input.defaultSelection,
      toolSelections: input.toolSelections,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    },
    ...signalOption(signal),
  })
  return parseToolAssignmentSet(value)
}

export async function readEffectiveTools(
  client: Pick<WorkbenchClient, 'requestJson'>,
  scope: ToolTargetScope,
  toolIds: readonly ToolConnectionCapability[] = TOOL_IDS,
  signal?: AbortSignal,
): Promise<readonly EffectiveToolSelection[]> {
  const query = new URLSearchParams({ scope: scopeQuery(scope), tools: toolIds.join(',') })
  const value = await client.requestJson<unknown>('GET', `${AI}/effective-tools?${query.toString()}`, signalOption(signal))
  if (!Array.isArray(value)) malformed('生效工具列表无法识别。')
  return value.map((entry) => parseEffectiveToolSelection(entry))
}
