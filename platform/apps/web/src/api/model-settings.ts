import type { WorkbenchClient } from './client'
import { ApiError } from './errors'

const PATH = '/api/v1/core/model-settings'

export type ModelProtocol = 'private' | 'openai-compatible'

export interface ModelSettingsView {
  readonly revision: string
  readonly enabled: boolean
  readonly baseUrl: string
  readonly endpoint: string
  readonly protocol: ModelProtocol
  readonly platformModelId: string
  readonly vendorModel: string
  readonly hasApiKey: boolean
  readonly activeEnabled: boolean
  readonly restartRequired: boolean
}

export interface ModelSettingsDraft {
  readonly enabled: boolean
  readonly baseUrl: string
  readonly endpoint: string
  readonly protocol: ModelProtocol
  readonly platformModelId: string
  readonly vendorModel: string
}

export interface SaveModelSettingsRequest extends ModelSettingsDraft {
  readonly revision: string
  readonly apiKey?: string
  readonly clearApiKey?: boolean
}

export interface TestModelSettingsRequest extends ModelSettingsDraft {
  readonly apiKey?: string
  readonly clearApiKey?: boolean
}

export interface ModelSettingsConnectionTest {
  readonly reachable: boolean
  /** Sanitized, user-facing server text. Never render untrusted provider bodies as this field. */
  readonly message: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(message: string): never {
  throw new ApiError(502, {
    code: 'MALFORMED_RESPONSE',
    message,
    retryable: false,
    reasons: [],
    missingCapabilities: [],
  })
}

const VIEW_KEYS = new Set([
  'revision', 'enabled', 'baseUrl', 'endpoint', 'protocol', 'platformModelId', 'vendorModel',
  'hasApiKey', 'activeEnabled', 'restartRequired',
])

export function isModelSettingsView(value: unknown): value is ModelSettingsView {
  if (!isRecord(value) || Object.keys(value).some((key) => !VIEW_KEYS.has(key))) return false
  return typeof value['revision'] === 'string' && value['revision'].length > 0 &&
    typeof value['enabled'] === 'boolean' &&
    typeof value['baseUrl'] === 'string' &&
    typeof value['endpoint'] === 'string' &&
    (value['protocol'] === 'private' || value['protocol'] === 'openai-compatible') &&
    typeof value['platformModelId'] === 'string' &&
    typeof value['vendorModel'] === 'string' &&
    typeof value['hasApiKey'] === 'boolean' &&
    typeof value['activeEnabled'] === 'boolean' &&
    typeof value['restartRequired'] === 'boolean'
}

function parseView(value: unknown): ModelSettingsView {
  if (!isModelSettingsView(value)) malformed('Core 返回的模型配置格式无法识别；密钥不会从读取响应中接受。')
  return value
}

export async function readModelSettings(
  client: Pick<WorkbenchClient, 'requestJson'>,
  signal?: AbortSignal,
): Promise<ModelSettingsView> {
  const value = await client.requestJson<unknown>('GET', PATH, signal === undefined ? {} : { signal })
  return parseView(value)
}

export async function saveModelSettings(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: SaveModelSettingsRequest,
  signal?: AbortSignal,
): Promise<ModelSettingsView> {
  const value = await client.requestJson<unknown>('PUT', PATH, {
    body: input,
    ...(signal === undefined ? {} : { signal }),
  })
  return parseView(value)
}

export async function testModelSettings(
  client: Pick<WorkbenchClient, 'requestJson'>,
  input: TestModelSettingsRequest,
  signal?: AbortSignal,
): Promise<ModelSettingsConnectionTest> {
  const value = await client.requestJson<unknown>('POST', `${PATH}/test`, {
    body: input,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!isRecord(value) || typeof value['reachable'] !== 'boolean' || typeof value['message'] !== 'string' ||
    Object.keys(value).some((key) => key !== 'reachable' && key !== 'message')) {
    malformed('Core 返回的连接测试格式无法识别。')
  }
  return { reachable: value['reachable'], message: value['message'] }
}
