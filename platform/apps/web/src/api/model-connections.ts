import {
  MODEL_CAPABILITIES,
  MODEL_PROTOCOLS,
  modelAdapterSupportsCapability,
} from '@ontology/contracts'
import type {
  EffectiveModelSelection,
  ModelAdapterType,
  ModelAssignmentSet,
  ModelCapability,
  ModelCapabilitySelection,
  ModelConnectionAdminView,
  ModelConnectionDescriptor,
  ModelConnectionSelection,
  ModelConnectionSummary,
  ModelConnectionTestResult,
  ModelCredentialState,
  ModelProtocol,
  ModelSelectionReason,
  ModelSelectionSource,
  ModelTargetScope,
} from '@ontology/contracts'
import type { WorkbenchClient } from './client'
import { isRecord, malformed } from './model-settings'

export type {
  EffectiveModelSelection,
  EffectiveModelState,
  ModelAdapterType,
  ModelAssignmentSet,
  ModelCapability,
  ModelCapabilitySelection,
  ModelConnectionAdminView,
  ModelConnectionDescriptor,
  ModelConnectionSelection,
  ModelConnectionSummary,
  ModelConnectionTestReason,
  ModelConnectionTestResult,
  ModelConnectionTestStatus,
  ModelCredentialState,
  ModelProtocol,
  ModelSelectionReason,
  ModelSelectionSource,
  ModelTargetScope,
} from '@ontology/contracts'

export { MODEL_CAPABILITIES, MODEL_PROTOCOLS, modelAdapterSupportsCapability }

const AI = '/api/v1/core/ai'

const ADAPTER_TYPES: readonly ModelAdapterType[] = ['company_generation', 'jev']
const CREDENTIAL_STATES: readonly ModelCredentialState[] = ['present', 'missing', 'revoked']
const TEST_STATUSES = ['passed', 'failed'] as const
const TEST_REASONS = [
  'authentication_failed', 'timeout', 'rate_limited', 'protocol_mismatch', 'unreachable', 'invalid_response',
] as const
const EFFECTIVE_STATES = ['available', 'unconfigured', 'disabled', 'blocked'] as const
const SELECTION_SOURCES: readonly ModelSelectionSource[] = [
  'object_capability', 'object_default', 'space_capability', 'space_default', 'unconfigured',
]
const SELECTION_REASONS: readonly ModelSelectionReason[] = [
  'MODEL_NOT_CONFIGURED', 'MODEL_DISABLED', 'MODEL_CAPABILITY_MISMATCH',
  'CREDENTIAL_MISSING', 'MODEL_IN_USE', 'MODEL_BINDING_REVOKED',
]

/**
 * The AI-settings client for `/api/v1/core/ai` (design §5.3, A-R09/A-R10/A-R11).
 *
 * Every reader parses strictly and rejects any credential-shaped field, so a read response that
 * accidentally carried a secret never reaches a component. All JSON here is non-secret metadata:
 * a target id in a query string is untrusted and the server re-checks its ownership, so the UI
 * never turns a foreign id into an existence signal.
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

function isCapability(value: unknown): value is ModelCapability {
  return MODEL_CAPABILITIES.includes(value as ModelCapability)
}

function cheapCapabilities(value: unknown): readonly ModelCapability[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MODEL_CAPABILITIES.length) {
    malformed('模型连接的能力列表无法识别。')
  }
  const seen = new Set<ModelCapability>()
  for (const entry of value) {
    if (!isCapability(entry)) malformed('模型连接声明了未知能力。')
    if (seen.has(entry)) malformed('模型连接的能力列表出现重复项。')
    seen.add(entry)
  }
  return [...seen]
}

function parseTargetScope(value: unknown): ModelTargetScope {
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

function parseSelection(value: unknown): ModelConnectionSelection {
  if (!isRecord(value)) malformed('模型选择无法识别。')
  switch (value['kind']) {
    case 'inherit':
    case 'disabled':
      onlyKeys(value, ['kind'], '模型选择')
      return { kind: value['kind'] }
    case 'connection':
      if (!isUuid(value['connectionId'])) malformed('模型连接引用缺少有效 ID。')
      onlyKeys(value, ['kind', 'connectionId'], '模型连接引用')
      return { kind: 'connection', connectionId: value['connectionId'] }
    default:
      malformed('模型选择的 kind 无法识别。')
  }
}

function parseTestSummary(value: unknown, revision: string): ModelConnectionAdminView['testSummary'] {
  if (!isRecord(value)) malformed('连接测试摘要无法识别。')
  onlyKeys(value, ['revision', 'status', 'testedAt', 'reason'], '连接测试摘要')
  if (!nonEmptyString(value['revision']) || !TEST_STATUSES.includes(value['status'] as (typeof TEST_STATUSES)[number])
    || !nonEmptyString(value['testedAt'])) {
    malformed('连接测试摘要格式无法识别。')
  }
  if (value['reason'] !== undefined && !TEST_REASONS.includes(value['reason'] as (typeof TEST_REASONS)[number])) {
    malformed('连接测试原因码无法识别。')
  }
  if (value['revision'] !== revision) return undefined
  return {
    revision: value['revision'],
    status: value['status'] as (typeof TEST_STATUSES)[number],
    testedAt: value['testedAt'],
    ...(value['reason'] === undefined ? {} : { reason: value['reason'] as (typeof TEST_REASONS)[number] }),
  }
}

const SUMMARY_KEYS = [
  'connectionId', 'name', 'revision', 'adapterType', 'protocol', 'capabilities',
  'enabled', 'credentialState', 'testSummary', 'updatedAt',
] as const
const ADMIN_KEYS = [...SUMMARY_KEYS, 'baseUrl', 'endpoint', 'platformModelId', 'providerModelName'] as const

export function parseConnectionAdminView(value: unknown, context = '模型连接'): ModelConnectionAdminView {
  if (!isRecord(value)) malformed(`${context}无法识别。`)
  rejectSecretKeys(value, context)
  onlyKeys(value, ADMIN_KEYS, context)
  if (!isUuid(value['connectionId']) || !nonEmptyString(value['name']) || !nonEmptyString(value['revision'])
    || !ADAPTER_TYPES.includes(value['adapterType'] as ModelAdapterType)
    || !MODEL_PROTOCOLS.includes(value['protocol'] as ModelProtocol)
    || typeof value['enabled'] !== 'boolean'
    || !CREDENTIAL_STATES.includes(value['credentialState'] as ModelCredentialState)
    || !nonEmptyString(value['updatedAt'])
    || !nonEmptyString(value['platformModelId']) || !nonEmptyString(value['providerModelName'])) {
    malformed(`${context}格式无法识别；读取响应中的凭据不会被接受。`)
  }
  const capabilities = cheapCapabilities(value['capabilities'])
  const testSummary = value['testSummary'] === undefined ? undefined : parseTestSummary(value['testSummary'], value['revision'])
  return {
    connectionId: value['connectionId'],
    name: value['name'],
    revision: value['revision'],
    adapterType: value['adapterType'] as ModelAdapterType,
    protocol: value['protocol'] as ModelProtocol,
    capabilities,
    enabled: value['enabled'],
    credentialState: value['credentialState'] as ModelCredentialState,
    ...(testSummary === undefined ? {} : { testSummary }),
    updatedAt: value['updatedAt'],
    platformModelId: value['platformModelId'],
    providerModelName: value['providerModelName'],
    ...(value['baseUrl'] === undefined ? {} : { baseUrl: nonEmptyString(value['baseUrl']) ? value['baseUrl'] : malformed(`${context}地址无法识别。`) }),
    ...(value['endpoint'] === undefined ? {} : { endpoint: nonEmptyString(value['endpoint']) ? value['endpoint'] : malformed(`${context}端点无法识别。`) }),
  }
}

function parseConnectionList(value: unknown): readonly ModelConnectionAdminView[] {
  if (!Array.isArray(value)) malformed('模型连接列表无法识别。')
  return value.map((entry) => parseConnectionAdminView(entry))
}

export function parseModelConnectionTestResult(value: unknown): ModelConnectionTestResult {
  if (!isRecord(value)) malformed('连接测试结果无法识别。')
  rejectSecretKeys(value, '连接测试结果')
  onlyKeys(value, ['schemaVersion', 'connectionId', 'connectionRevision', 'status', 'testedAt', 'reason', 'latencyMs', 'draft', 'credentialConfigured'], '连接测试结果')
  if (value['schemaVersion'] !== 'model-connection-test-result@1'
    || !TEST_STATUSES.includes(value['status'] as (typeof TEST_STATUSES)[number])
    || !nonEmptyString(value['testedAt'])
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['connectionRevision'] !== undefined && !nonEmptyString(value['connectionRevision']))
    || (value['reason'] !== undefined && !TEST_REASONS.includes(value['reason'] as (typeof TEST_REASONS)[number]))
    || (value['latencyMs'] !== undefined && (!Number.isSafeInteger(value['latencyMs']) || (value['latencyMs'] as number) < 0))
    || typeof value['draft'] !== 'boolean' || typeof value['credentialConfigured'] !== 'boolean') {
    malformed('连接测试结果格式无法识别。')
  }
  return {
    schemaVersion: 'model-connection-test-result@1',
    status: value['status'] as (typeof TEST_STATUSES)[number],
    testedAt: value['testedAt'],
    draft: value['draft'],
    credentialConfigured: value['credentialConfigured'],
    ...(value['connectionId'] === undefined ? {} : { connectionId: value['connectionId'] }),
    ...(value['connectionRevision'] === undefined ? {} : { connectionRevision: value['connectionRevision'] }),
    ...(value['reason'] === undefined ? {} : { reason: value['reason'] as (typeof TEST_REASONS)[number] }),
    ...(value['latencyMs'] === undefined ? {} : { latencyMs: value['latencyMs'] as number }),
  }
}

function parseConnectionSummary(value: unknown, context: string): ModelConnectionSummary | undefined {
  if (!isRecord(value)) malformed(`${context}无法识别。`)
  rejectSecretKeys(value, context)
  onlyKeys(value, SUMMARY_KEYS, context)
  const admin = parseConnectionAdminView({ ...value, platformModelId: 'x', providerModelName: 'x' }, context)
  return {
    connectionId: admin.connectionId,
    name: admin.name,
    revision: admin.revision,
    adapterType: admin.adapterType,
    protocol: admin.protocol,
    capabilities: admin.capabilities,
    enabled: admin.enabled,
    credentialState: admin.credentialState,
    ...(admin.testSummary === undefined ? {} : { testSummary: admin.testSummary }),
    updatedAt: admin.updatedAt,
  }
}

function parseCapabilitySelections(value: unknown): readonly ModelCapabilitySelection[] {
  if (!Array.isArray(value)) malformed('能力分配无法识别。')
  const seen = new Set<ModelCapability>()
  const result: ModelCapabilitySelection[] = []
  for (const entry of value) {
    if (!isRecord(entry) || !isCapability(entry['capability'])) malformed('能力分配项无法识别。')
    if (seen.has(entry['capability'])) malformed('能力分配出现重复能力。')
    seen.add(entry['capability'])
    result.push({ capability: entry['capability'], selection: parseSelection(entry['selection']) })
  }
  return result
}

export function parseModelAssignmentSet(value: unknown): ModelAssignmentSet {
  if (!isRecord(value)) malformed('模型分配无法识别。')
  onlyKeys(value, ['schemaVersion', 'scope', 'defaultSelection', 'capabilitySelections', 'revision', 'updatedAt'], '模型分配')
  if (value['schemaVersion'] !== 'model-assignment-set@1' || !nonEmptyString(value['revision']) || !nonEmptyString(value['updatedAt'])) {
    malformed('模型分配格式无法识别。')
  }
  return {
    schemaVersion: 'model-assignment-set@1',
    scope: parseTargetScope(value['scope']),
    defaultSelection: parseSelection(value['defaultSelection']),
    capabilitySelections: parseCapabilitySelections(value['capabilitySelections']),
    revision: value['revision'],
    updatedAt: value['updatedAt'],
  }
}

export function parseEffectiveModelSelection(value: unknown): EffectiveModelSelection {
  if (!isRecord(value)) malformed('生效模型无法识别。')
  rejectSecretKeys(value, '生效模型')
  onlyKeys(value, ['schemaVersion', 'scope', 'capability', 'selection', 'resolvedFrom', 'state', 'connectionId', 'connectionSummary', 'assignmentRevision', 'blockedReason', 'resolvedAt'], '生效模型')
  if (value['schemaVersion'] !== 'effective-model-selection@1' || !isCapability(value['capability'])
    || !SELECTION_SOURCES.includes(value['resolvedFrom'] as ModelSelectionSource)
    || !EFFECTIVE_STATES.includes(value['state'] as (typeof EFFECTIVE_STATES)[number])
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['assignmentRevision'] !== undefined && !nonEmptyString(value['assignmentRevision']))
    || (value['blockedReason'] !== undefined && !SELECTION_REASONS.includes(value['blockedReason'] as ModelSelectionReason))
    || !nonEmptyString(value['resolvedAt'])) {
    malformed('生效模型格式无法识别。')
  }
  const state = value['state'] as (typeof EFFECTIVE_STATES)[number]
  if (state === 'available' && value['connectionId'] === undefined) malformed('可用模型必须指向一个连接。')
  const connectionSummary = value['connectionSummary'] === undefined ? undefined : parseConnectionSummary(value['connectionSummary'], '生效模型连接摘要')
  return {
    schemaVersion: 'effective-model-selection@1',
    scope: parseTargetScope(value['scope']),
    capability: value['capability'],
    selection: parseSelection(value['selection']),
    resolvedFrom: value['resolvedFrom'] as ModelSelectionSource,
    state,
    resolvedAt: value['resolvedAt'],
    ...(value['connectionId'] === undefined ? {} : { connectionId: value['connectionId'] }),
    ...(connectionSummary === undefined ? {} : { connectionSummary }),
    ...(value['assignmentRevision'] === undefined ? {} : { assignmentRevision: value['assignmentRevision'] }),
    ...(value['blockedReason'] === undefined ? {} : { blockedReason: value['blockedReason'] as ModelSelectionReason }),
  }
}

function scopeQuery(scope: ModelTargetScope): string {
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

export interface ModelConnectionListFilter {
  readonly capability?: ModelCapability
  readonly enabled?: boolean
}

export async function readModelConnections(
  client: Pick<WorkbenchClient, 'requestJson'>,
  filter: ModelConnectionListFilter = {},
  signal?: AbortSignal,
): Promise<readonly ModelConnectionAdminView[]> {
  const query = new URLSearchParams()
  if (filter.capability !== undefined) query.set('capability', filter.capability)
  if (filter.enabled !== undefined) query.set('enabled', String(filter.enabled))
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  const value = await client.requestJson<unknown>('GET', `${AI}/model-connections${suffix}`, signalOption(signal))
  return parseConnectionList(value)
}

export async function readModelConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  connectionId: string,
  signal?: AbortSignal,
): Promise<ModelConnectionAdminView> {
  const value = await client.requestJson<unknown>('GET', `${AI}/model-connections/${encodeURIComponent(connectionId)}`, signalOption(signal))
  return parseConnectionAdminView(value)
}

export async function createModelConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: { readonly descriptor: ModelConnectionDescriptor; readonly apiKey?: string; readonly idempotencyKey: string },
  signal?: AbortSignal,
): Promise<ModelConnectionAdminView> {
  const value = await client.requestJson<unknown>('POST', `${AI}/model-connections`, {
    body: { descriptor: input.descriptor, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }), idempotencyKey: input.idempotencyKey },
    ...signalOption(signal),
  })
  return parseConnectionAdminView(value)
}

export async function updateModelConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  connectionId: string,
  input: {
    readonly descriptor: ModelConnectionDescriptor
    readonly expectedRevision: string
    readonly apiKey?: string
    readonly clearCredential?: boolean
    readonly idempotencyKey: string
  },
  signal?: AbortSignal,
): Promise<ModelConnectionAdminView> {
  const value = await client.requestJson<unknown>('PUT', `${AI}/model-connections/${encodeURIComponent(connectionId)}`, {
    body: {
      descriptor: input.descriptor,
      expectedRevision: input.expectedRevision,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.clearCredential === true ? { clearCredential: true } : {}),
      idempotencyKey: input.idempotencyKey,
    },
    ...signalOption(signal),
  })
  return parseConnectionAdminView(value)
}

export async function copyModelConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  sourceConnectionId: string,
  input: { readonly name: string; readonly idempotencyKey: string },
  signal?: AbortSignal,
): Promise<ModelConnectionAdminView> {
  const value = await client.requestJson<unknown>('POST', `${AI}/model-connections/${encodeURIComponent(sourceConnectionId)}/copy`, {
    body: { name: input.name, idempotencyKey: input.idempotencyKey },
    ...signalOption(signal),
  })
  return parseConnectionAdminView(value)
}

export async function deleteModelConnection(
  client: Pick<WorkbenchClient, 'requestVoid'>,
  connectionId: string,
  signal?: AbortSignal,
): Promise<void> {
  await client.requestVoid('DELETE', `${AI}/model-connections/${encodeURIComponent(connectionId)}`, signalOption(signal))
}

/** Probe a stored connection; the deployment resolves its credential and never echoes it. */
export async function testStoredConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  connectionId: string,
  signal?: AbortSignal,
): Promise<ModelConnectionTestResult> {
  const value = await client.requestJson<unknown>('POST', `${AI}/model-connections/${encodeURIComponent(connectionId)}/test`, signalOption(signal))
  return parseModelConnectionTestResult(value)
}

/** Probe an unsaved draft; the draft credential is staged server-side, used and then discarded. */
export async function testDraftConnection(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: { readonly descriptor: ModelConnectionDescriptor; readonly apiKey?: string },
  signal?: AbortSignal,
): Promise<ModelConnectionTestResult> {
  const value = await client.requestJson<unknown>('POST', `${AI}/model-connection-tests`, {
    body: { descriptor: input.descriptor, ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }) },
    ...signalOption(signal),
  })
  return parseModelConnectionTestResult(value)
}

export async function readModelAssignments(
  client: Pick<WorkbenchClient, 'requestJson'>,
  scope: ModelTargetScope,
  signal?: AbortSignal,
): Promise<ModelAssignmentSet | undefined> {
  const value = await client.requestJson<unknown>('GET', `${AI}/model-assignments?scope=${encodeURIComponent(scopeQuery(scope))}`, signalOption(signal))
  if (value === null) return undefined
  return parseModelAssignmentSet(value)
}

export interface ModelAssignmentWrite {
  readonly scope: ModelTargetScope
  readonly defaultSelection: ModelConnectionSelection
  readonly capabilitySelections: readonly ModelCapabilitySelection[]
  readonly expectedRevision?: string
}

export async function saveModelAssignments(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: ModelAssignmentWrite,
  signal?: AbortSignal,
): Promise<ModelAssignmentSet> {
  const value = await client.requestJson<unknown>('PUT', `${AI}/model-assignments`, {
    body: {
      scope: input.scope,
      defaultSelection: input.defaultSelection,
      capabilitySelections: input.capabilitySelections,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    },
    ...signalOption(signal),
  })
  return parseModelAssignmentSet(value)
}

export interface ModelChangePreview {
  readonly scope: ModelTargetScope
  readonly before: readonly EffectiveModelSelection[]
  readonly proposed: {
    readonly defaultSelection: ModelConnectionSelection
    readonly capabilitySelections: readonly ModelCapabilitySelection[]
  }
}

export async function previewModelChange(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: Omit<ModelAssignmentWrite, 'expectedRevision'>,
  signal?: AbortSignal,
): Promise<ModelChangePreview> {
  const value = await client.requestJson<unknown>('POST', `${AI}/model-change-previews`, {
    body: { scope: input.scope, defaultSelection: input.defaultSelection, capabilitySelections: input.capabilitySelections },
    ...signalOption(signal),
  })
  if (!isRecord(value)) malformed('模型变更预览无法识别。')
  onlyKeys(value, ['scope', 'before', 'proposed'], '模型变更预览')
  const before = value['before']
  const proposed = value['proposed']
  if (!Array.isArray(before) || !isRecord(proposed)) malformed('模型变更预览无法识别。')
  return {
    scope: parseTargetScope(value['scope']),
    before: before.map((entry) => parseEffectiveModelSelection(entry)),
    proposed: {
      defaultSelection: parseSelection(proposed['defaultSelection']),
      capabilitySelections: parseCapabilitySelections(proposed['capabilitySelections']),
    },
  }
}

export async function readEffectiveModels(
  client: Pick<WorkbenchClient, 'requestJson'>,
  scope: ModelTargetScope,
  capabilities: readonly ModelCapability[] = MODEL_CAPABILITIES,
  signal?: AbortSignal,
): Promise<readonly EffectiveModelSelection[]> {
  const query = new URLSearchParams({ scope: scopeQuery(scope), capabilities: capabilities.join(',') })
  const value = await client.requestJson<unknown>('GET', `${AI}/effective-models?${query.toString()}`, signalOption(signal))
  if (!Array.isArray(value)) malformed('生效模型列表无法识别。')
  return value.map((entry) => parseEffectiveModelSelection(entry))
}
