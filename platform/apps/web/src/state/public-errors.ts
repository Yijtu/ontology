import { ApiError } from '../api/errors'

/**
 * The public-UI classification of a failure (SPEC generic-assistants-core §5.3, asset-data-ui §10).
 * Public components must never render a raw 500 or an untranslated server string: every failure is
 * mapped to one family with a Chinese reason and a recovery entry (`retry` / `refresh` / `resume` /
 * `none`). A non-retryable family never offers a misleading retry button.
 *
 * The classifier is pure and framework-free so both the React panels and the tests share it.
 */
export type PublicErrorFamily =
  | 'permission'
  | 'not_found'
  | 'not_ready'
  | 'conflict'
  | 'invalid'
  | 'unsupported'
  | 'limit'
  | 'source'
  | 'model'
  | 'capability'
  | 'data'
  | 'snapshot'
  | 'budget'
  | 'verification'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'unknown'

export type PublicRecovery = 'retry' | 'refresh' | 'resume' | 'none'

export interface PublicFailure {
  readonly family: PublicErrorFamily
  readonly title: string
  readonly reason: string
  readonly recovery: PublicRecovery
  readonly retryable: boolean
  /** The stable error code; shown for the operator, never as the primary message. */
  readonly code: string
  /** The server detail, kept separate so a raw 500 body never becomes the visible reason. */
  readonly message: string
  readonly reasons: readonly string[]
  readonly missingCapabilities: readonly string[]
  readonly traceId?: string
}

interface FailureInput {
  readonly code: string
  readonly message: string
  readonly status?: number
  readonly retryable: boolean
  readonly reasons: readonly string[]
  readonly missingCapabilities: readonly string[]
  readonly traceId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Capability gaps are displayed by name only. An entry the UI cannot name is dropped rather than
 * serialised as tool JSON, so business users never have to read a raw config blob.
 */
function capabilityNames(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) names.push(entry)
    else if (isRecord(entry) && typeof entry['name'] === 'string' && entry['name'].length > 0) names.push(entry['name'])
    else if (isRecord(entry) && typeof entry['capability'] === 'string' && entry['capability'].length > 0) {
      names.push(entry['capability'])
    }
  }
  return names
}

function normalize(error: unknown): FailureInput {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      reasons: error.reasons,
      missingCapabilities: capabilityNames(error.missingCapabilities),
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
    }
  }
  if (isRecord(error)) {
    const traceId = typeof error['traceId'] === 'string' ? error['traceId'] : undefined
    const status = typeof error['status'] === 'number' ? error['status'] : undefined
    return {
      code: typeof error['code'] === 'string' ? error['code'] : 'UNKNOWN',
      message: typeof error['message'] === 'string' ? error['message'] : '请求未完成。',
      retryable: error['retryable'] === true,
      reasons: stringsOf(error['reasons']),
      missingCapabilities: capabilityNames(error['missingCapabilities']),
      ...(status === undefined ? {} : { status }),
      ...(traceId === undefined ? {} : { traceId }),
    }
  }
  if (error instanceof Error) {
    return { code: 'NETWORK_ERROR', message: error.message, retryable: true, reasons: [], missingCapabilities: [] }
  }
  return { code: 'UNKNOWN', message: '请求未完成。', retryable: false, reasons: [], missingCapabilities: [] }
}

const NOT_READY = new Set([
  'DATASET_NOT_READY',
  'INDEX_NOT_READY',
  'SEMANTIC_NOT_READY',
  'MATERIALIZATION_MISMATCH',
  'INDEX_CORPUS_STALE',
  'READINESS_NOT_BUILT',
])
const CONFLICT = new Set([
  'VERSION_CONFLICT',
  'REVISION_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'CANDIDATE_REVISION_STALE',
  'UNCONFIRMED_INPUT',
  'DATA_CONFLICT',
  'DATA_STALE',
  'STALE_REVISION',
  'PUBLICATION_BLOCKED',
  'IDENTITY_CONFLICT',
])
const INVALID = new Set(['INVALID_ARGUMENT', 'INVALID_SCHEMA', 'SCHEMA_MISMATCH', 'INVALID_REVISION'])
const UNSUPPORTED = new Set([
  'UNSUPPORTED_MEDIA_TYPE',
  'UNSUPPORTED_TABLE_LAYOUT',
  'RULE_UNSUPPORTED',
  'ACTION_UNBOUND',
  'UNSUPPORTED_DEFINITION_RULE',
  'SUPPORT_VALIDATION_BLOCKED',
  'ACTION_NOT_EXECUTABLE',
])
const LIMIT = new Set(['LIMIT_EXCEEDED', 'PARSE_INCOMPLETE', 'RESULT_TOO_LARGE', 'TABLE_UNVERIFIED'])
const SOURCE = new Set(['SOURCE_LOCATOR_INVALID', 'SOURCE_DIGEST_MISMATCH', 'SOURCE_UNAVAILABLE', 'SOURCE_NOT_FOUND'])
const MODEL = new Set(['MODEL_NOT_CONFIGURED', 'MODEL_UNAVAILABLE'])
const CAPABILITY = new Set([
  'CAPABILITY_NOT_CONFIGURED',
  'PROFILE_INCOMPATIBLE',
  'PROFILE_NOT_RESOLVED',
  'MODULE_NOT_REGISTERED',
  'DEPENDENCY_NOT_MET',
])
const DATA = new Set(['INSUFFICIENT_DATA', 'DATASET_UNAVAILABLE'])
const BUDGET = new Set(['BUDGET_EXHAUSTED', 'NO_PROGRESS', 'DEADLINE_EXCEEDED', 'RUN_CANCELLED', 'CANCELLED'])
const VERIFICATION = new Set(['VERIFICATION_FAILED', 'DRAFT_UNVERIFIED'])
const SNAPSHOT = new Set(['SNAPSHOT_UNAVAILABLE', 'CHECKPOINT_INCOMPATIBLE'])
const RATE = new Set(['RATE_LIMITED'])

const NOT_READY_LABELS: Readonly<Record<string, string>> = {
  DATASET_NOT_READY: '查询数据',
  INDEX_NOT_READY: '文档索引',
  SEMANTIC_NOT_READY: '语义发布',
  MATERIALIZATION_MISMATCH: '数据物化',
  INDEX_CORPUS_STALE: '文档索引语料',
  READINESS_NOT_BUILT: '项目就绪投影',
}

type FamilyText = { readonly title: string; readonly reason: string }

const FAMILY_TEXT: Readonly<Record<PublicErrorFamily, FamilyText>> = {
  permission: {
    title: '权限不足',
    reason: '当前账号没有执行该操作的权限。页面与草稿已保留，请联系管理员授予相应角色。',
  },
  not_found: {
    title: '资源不存在',
    reason: '该资源不存在或不在当前授权范围内。页面与草稿已保留，且不会泄露其他范围的数据。',
  },
  not_ready: {
    title: '数据尚未就绪',
    reason: '所需的数据、文档索引或语义投影尚未就绪。可稍后重试，或等待后台作业完成。',
  },
  conflict: {
    title: '版本冲突',
    reason: '当前修订已被其他操作更新。请先刷新回读差异，再基于最新修订重新确认，页面与草稿已保留。',
  },
  invalid: {
    title: '输入或格式不正确',
    reason: '请修正标记的字段、单位或格式后重新提交；该错误不会因重试而消失。',
  },
  unsupported: {
    title: '暂不支持该能力或格式',
    reason: '当前部署不支持该格式或规则。请改用受支持的模板，或由维护者绑定已注册能力。',
  },
  limit: {
    title: '超出上限',
    reason: '结果或资料超出配置上限。请拆分资料或缩小范围；截断与不完整不会作为完整结果发布。',
  },
  source: {
    title: '来源不可用',
    reason: '原始来源无法读取或校验不一致。页面与草稿已保留，仅在来源恢复后才可重试。',
  },
  model: {
    title: '模型未配置或不可用',
    reason: '所需的生成或决策模型未配置或暂时不可用。确定性 JSON／表格步骤仍可使用，配置项由维护者处理。',
  },
  capability: {
    title: '缺少所需能力',
    reason: '当前部署缺少所需能力或 Schema。业务用户无需处理工具 JSON 或数据库配置，请由维护者补齐后重试。',
  },
  data: {
    title: '数据不足或存在冲突',
    reason: '当前数据不足或存在冲突。请补充缺项或裁决冲突后再继续，页面与草稿已保留。',
  },
  snapshot: {
    title: '快照或检查点不兼容',
    reason: '当前快照或检查点不可用。已保留历史与恢复范围，请另行新建运行继续。',
  },
  budget: {
    title: '预算或时限已用尽',
    reason: '本次运行已用尽预算或时限，并保留了已覆盖与缺口。可新建运行继续，不会无限补查。',
  },
  verification: {
    title: '核验未通过',
    reason: '结果未通过硬性核验。请修复草稿后重试（仅限原预算），不会以未经核验的内容作为正式结果。',
  },
  rate_limited: {
    title: '请求过于频繁',
    reason: '服务在共享截止时间内有界限流。请稍后退避重试，页面与草稿已保留。',
  },
  server: {
    title: '服务暂时不可用',
    reason: '服务端发生故障，页面与草稿已保留。可稍后重试，不会显示原始错误内容。',
  },
  network: {
    title: '网络请求失败',
    reason: '无法连接到服务，页面与草稿已保留。请检查网络后重试。',
  },
  unknown: {
    title: '操作失败',
    reason: '操作未完成，页面与草稿已保留。可重试或刷新回读最新状态。',
  },
}

function familyOf(code: string, status: number | undefined, retryable: boolean): PublicErrorFamily {
  if (status === 401 || status === 403) return 'permission'
  if (status === 404) return 'not_found'
  if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN' || code === 'PERMISSION_DENIED') return 'permission'
  if (code === 'NOT_FOUND') return 'not_found'
  if (NOT_READY.has(code)) return 'not_ready'
  if (CONFLICT.has(code)) return 'conflict'
  if (INVALID.has(code)) return 'invalid'
  if (UNSUPPORTED.has(code)) return 'unsupported'
  if (LIMIT.has(code)) return 'limit'
  if (SOURCE.has(code)) return 'source'
  if (MODEL.has(code)) return 'model'
  if (CAPABILITY.has(code)) return 'capability'
  if (DATA.has(code)) return 'data'
  if (SNAPSHOT.has(code)) return 'snapshot'
  if (BUDGET.has(code)) return 'budget'
  if (VERIFICATION.has(code)) return 'verification'
  if (RATE.has(code)) return 'rate_limited'
  if (status !== undefined && status >= 500) return 'server'
  if (code === 'MALFORMED_RESPONSE' || code === 'MALFORMED_ENVELOPE' || code === 'HTTP_500') return 'server'
  if (code === 'NETWORK_ERROR' || code === 'FETCH_ERROR') return 'network'
  if (retryable) return 'server'
  return 'unknown'
}

function recoveryOf(family: PublicErrorFamily, retryable: boolean): PublicRecovery {
  switch (family) {
    case 'server':
    case 'network':
    case 'rate_limited':
      return 'retry'
    case 'not_ready':
    case 'source':
    case 'model':
      return retryable ? 'retry' : 'none'
    case 'conflict':
      return 'refresh'
    case 'verification':
    case 'snapshot':
      return 'resume'
    default:
      return 'none'
  }
}

function reasonOf(family: PublicErrorFamily, input: FailureInput): string {
  const base = FAMILY_TEXT[family].reason
  if (family === 'capability' && input.missingCapabilities.length > 0) {
    return `当前部署缺少所需能力：${input.missingCapabilities.join('、')}。${base}`
  }
  if (family === 'not_ready') {
    const label = NOT_READY_LABELS[input.code.toUpperCase()]
    if (label !== undefined) return `${label}尚未就绪。${base}`
  }
  return base
}

/** Classify any thrown value into a public, Chinese-reasoned failure state. */
export function classifyPublicError(error: unknown): PublicFailure {
  const input = normalize(error)
  const code = input.code.toUpperCase()
  const family = familyOf(code, input.status, input.retryable)
  const recovery = recoveryOf(family, input.retryable)
  return {
    family,
    title: FAMILY_TEXT[family].title,
    reason: reasonOf(family, input),
    recovery,
    retryable: recovery === 'retry',
    code: input.code,
    message: input.message,
    reasons: input.reasons,
    missingCapabilities: input.missingCapabilities,
    ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
  }
}

export function publicRecoveryLabel(recovery: PublicRecovery): string {
  switch (recovery) {
    case 'retry':
      return '重试'
    case 'refresh':
      return '刷新回读'
    case 'resume':
      return '继续处理'
    case 'none':
      return ''
  }
}
