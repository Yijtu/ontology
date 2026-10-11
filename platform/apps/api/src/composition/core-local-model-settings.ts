import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { probeCompanyModel } from '@ontology/adapter-model-company'
import type { CompanyModelProtocol } from '@ontology/adapter-model-company'
import type { ScopeRef } from '@ontology/contracts'
import { envVarNameOf } from './secret-resolver'

interface StoredSettings {
  readonly revision: string
  readonly enabled: boolean
  readonly baseUrl: string
  readonly endpoint: string
  readonly protocol: CompanyModelProtocol
  readonly platformModelId: string
  readonly vendorModel: string
  readonly apiKey: string
}
export interface CoreModelSettingsView extends Omit<StoredSettings, 'apiKey'> {
  readonly hasApiKey: boolean
  readonly activeEnabled: boolean
  readonly restartRequired: boolean
}
export class LocalModelSettingsError extends Error {
  constructor(readonly code: string, readonly httpStatus: number, message: string) { super(message) }
}
const invalid = (message: string): never => { throw new LocalModelSettingsError('INVALID_ARGUMENT', 400, message) }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const allowed = new Set(['revision', 'enabled', 'baseUrl', 'endpoint', 'protocol', 'platformModelId', 'vendorModel', 'apiKey', 'clearApiKey'])
function stringField(value: unknown, field: string, limit = 1_024): string {
  if (typeof value !== 'string' || value.length > limit || /[\r\n\u0000]/u.test(value)) return invalid(`${field} 必须是有长度上限的单行文本。`)
  return value.trim()
}
function parse(value: unknown, previous: StoredSettings, requireRevision: boolean): StoredSettings {
  if (!record(value) || Object.keys(value).some((key) => !allowed.has(key))) return invalid('模型设置包含未知字段。')
  const revision = requireRevision ? stringField(value['revision'], 'revision', 32) : previous.revision
  if (!/^(0|[1-9]\d*)$/u.test(revision)) return invalid('配置修订无效，请重新读取。')
  if (typeof value['enabled'] !== 'boolean') return invalid('请选择是否启用生成模型。')
  if (value['clearApiKey'] !== undefined && typeof value['clearApiKey'] !== 'boolean') return invalid('清除密钥标记无效。')
  const baseUrl = stringField(value['baseUrl'], '服务地址')
  const endpoint = stringField(value['endpoint'], '接口路径')
  const platformModelId = stringField(value['platformModelId'], '配置标识', 80)
  const vendorModel = stringField(value['vendorModel'], '模型名称', 256)
  const protocol = value['protocol']
  if (protocol !== 'private' && protocol !== 'openai-compatible') return invalid('请选择支持的模型协议。')
  const newKey = value['apiKey'] === undefined ? '' : stringField(value['apiKey'], 'API Key', 4_096)
  if (newKey && /[^\x21-\x7e]/u.test(newKey)) return invalid('API Key 不能包含空白或控制字符。')
  if (newKey && value['clearApiKey'] === true) return invalid('不能同时填写与清除密钥。')
  const apiKey = value['clearApiKey'] === true ? '' : newKey || previous.apiKey
  if (baseUrl) {
    let url: URL
    try { url = new URL(baseUrl) } catch { return invalid('服务地址需要是 http(s) 地址。') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return invalid('服务地址只填写域名和端口；路径单独填写，地址中不能包含密钥。')
  }
  if (apiKey && !newKey && baseUrl && new URL(baseUrl).origin !== previous.baseUrl) return invalid('变更服务地址时请重新填写密钥，避免把原密钥发送给其他服务。')
  if (endpoint && (!endpoint.startsWith('/') || endpoint.startsWith('//') || /[?#\\]/u.test(endpoint))) return invalid('接口路径须以单个 / 开头，且不能包含查询参数或片段。')
  if (platformModelId && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(platformModelId)) return invalid('配置标识只能包含字母、数字、点、下划线、冒号或短横线。')
  if (value['enabled'] && (!baseUrl || !endpoint || !platformModelId || !vendorModel || !apiKey)) return invalid('启用前请填写服务地址、接口路径、配置标识、模型名称及密钥。')
  return { revision, enabled: value['enabled'], baseUrl: baseUrl ? new URL(baseUrl).origin : '', endpoint, protocol, platformModelId, vendorModel, apiKey }
}
function fromEnvironment(env: Readonly<Record<string, string | undefined>>): StoredSettings {
  let apiKey = env['CORE_COMPANY_MODEL_API_KEY'] ?? ''
  try { apiKey = env[envVarNameOf(env['CORE_COMPANY_MODEL_SECRET_REF'] ?? 'env:CORE_COMPANY_MODEL_API_KEY')] ?? '' } catch { /* The existing factory reports invalid startup secret references. */ }
  const protocol = env['CORE_COMPANY_MODEL_PROTOCOL'] === 'private' ? 'private' : 'openai-compatible'
  let baseUrl = ''
  try {
    const url = new URL(env['CORE_COMPANY_MODEL_BASE_URL'] ?? '')
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) baseUrl = url.origin
  } catch { /* Never echo an invalid credential-bearing environment URL to the browser. */ }
  const endpoint = env['CORE_COMPANY_MODEL_ENDPOINT'] ?? (protocol === 'private' ? '/v1/generate' : '/v1/chat/completions')
  return { revision: '0', enabled: env['CORE_ENABLE_MODELS'] === 'true', baseUrl, endpoint: endpoint.startsWith('/') && !endpoint.startsWith('//') && !/[?#\\\r\n]/u.test(endpoint) ? endpoint : '', protocol, platformModelId: env['CORE_COMPANY_MODEL_PLATFORM_ID'] ?? 'company-generation', vendorModel: env['CORE_COMPANY_MODEL_VENDOR_MODEL'] ?? '', apiKey }
}
function signature(value: StoredSettings): string {
  return JSON.stringify([value.enabled, value.baseUrl, value.endpoint, value.protocol, value.platformModelId, value.vendorModel, value.apiKey])
}

/** Local Core deployment settings: scoped server-only storage, applied on the next host start. */
export class CoreLocalModelSettings {
  readonly scopeRef: ScopeRef
  readonly #path: string
  readonly #original: Readonly<Record<string, string | undefined>>
  #active: StoredSettings
  #writes: Promise<unknown> = Promise.resolve()
  #testing = false
  constructor(input: { readonly objectDirectory: string; readonly scopeRef: ScopeRef; readonly environment: Readonly<Record<string, string | undefined>> }) {
    this.scopeRef = { ...input.scopeRef }
    this.#path = join(input.objectDirectory, '.core-settings', input.scopeRef.tenantId, input.scopeRef.spaceId, 'generation.json')
    this.#original = { ...input.environment }
    this.#active = fromEnvironment(input.environment)
  }
  async #read(): Promise<StoredSettings> {
    let text: string
    try {
      if ((await stat(this.#path)).size > 65_536) throw new LocalModelSettingsError('CONFIG_STORAGE_INVALID', 503, '本机模型设置超出大小上限。')
      text = await readFile(this.#path, 'utf8')
    } catch (error) {
      if (record(error) && error['code'] === 'ENOENT') return fromEnvironment(this.#original)
      throw new LocalModelSettingsError('CONFIG_STORAGE_UNAVAILABLE', 503, '本机模型设置暂不可读取。')
    }
    try {
      const value: unknown = JSON.parse(text)
      if (!record(value) || typeof value['apiKey'] !== 'string') throw new Error('invalid stored settings')
      return parse(value, { ...fromEnvironment(this.#original), apiKey: '' }, true)
    } catch { throw new LocalModelSettingsError('CONFIG_STORAGE_INVALID', 503, '本机模型设置损坏，请由本机管理员核对配置文件。') }
  }
  async loadEnvironment(): Promise<Readonly<Record<string, string | undefined>>> {
    this.#active = await this.#read()
    if (this.#active.revision === '0') return this.#original
    const settings = this.#active
    // Changing a provider must mint a distinct model component, never silently retarget a pinned run.
    const fingerprint = createHash('sha256').update(JSON.stringify([settings.baseUrl, settings.endpoint, settings.protocol, settings.platformModelId, settings.vendorModel])).digest('hex').slice(0, 16)
    return { ...this.#original, CORE_ENABLE_MODELS: String(settings.enabled), CORE_COMPANY_MODEL_BASE_URL: settings.baseUrl,
      CORE_COMPANY_MODEL_ENDPOINT: settings.endpoint, CORE_COMPANY_MODEL_PROTOCOL: settings.protocol,
      CORE_COMPANY_MODEL_PLATFORM_ID: `${settings.platformModelId}.local.${fingerprint}`, CORE_COMPANY_MODEL_VENDOR_MODEL: settings.vendorModel,
      CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY', CORE_COMPANY_MODEL_API_KEY: settings.apiKey }
  }
  #view(settings: StoredSettings): CoreModelSettingsView {
    const { apiKey, ...publicSettings } = settings
    return { ...publicSettings, hasApiKey: Boolean(apiKey), activeEnabled: this.#active.enabled, restartRequired: signature(settings) !== signature(this.#active) }
  }
  async read(): Promise<CoreModelSettingsView> { return this.#view(await this.#read()) }
  async save(body: unknown): Promise<CoreModelSettingsView> {
    const operation = this.#writes.then(async () => {
      const previous = await this.#read()
      const candidate = parse(body, previous, true)
      if (candidate.revision !== previous.revision) throw new LocalModelSettingsError('REVISION_CONFLICT', 409, '设置已被其他窗口修改，请重新读取后再保存。')
      const next = { ...candidate, revision: String(BigInt(previous.revision) + 1n) }
      const temporary = `${this.#path}.${randomUUID()}.tmp`
      try {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
        await writeFile(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
        await rename(temporary, this.#path)
      } catch { throw new LocalModelSettingsError('CONFIG_STORAGE_UNAVAILABLE', 503, '本机模型设置保存失败，请检查存储权限。') }
      finally { await unlink(temporary).catch(() => undefined) }
      return this.#view(next)
    })
    this.#writes = operation.catch(() => undefined)
    return operation
  }
  async test(body: unknown, signal?: AbortSignal): Promise<{ readonly reachable: boolean; readonly message: string }> {
    if (this.#testing) throw new LocalModelSettingsError('TEST_IN_PROGRESS', 409, '已有连接测试正在进行，请稍候。')
    this.#testing = true
    try {
      const candidate = parse(body, await this.#read(), false)
      if (!candidate.baseUrl || !candidate.endpoint || !candidate.vendorModel || !candidate.apiKey) return invalid('连接测试需要地址、路径、模型名称和密钥。')
      return await probeCompanyModel(candidate, signal === undefined ? {} : { signal })
    } finally { this.#testing = false }
  }
}
