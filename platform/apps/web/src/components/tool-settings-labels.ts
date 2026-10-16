import type {
  EffectiveToolState,
  ToolAdapterType,
  ToolConnectionCapability,
  ToolConnectionProbeReason,
  ToolConnectionProbeStatus,
  ToolCredentialState,
  ToolSelectionReason,
  ToolSelectionSource,
} from '../api/tool-connections'

/**
 * Human labels for the tool-connection vocabulary (design §9).
 *
 * Every value rendered here is a closed enum or a machine reason code. Provider text, response
 * bodies and credentials are never part of this vocabulary, so nothing untrusted can reach a label.
 * A search service is named as a tool connection, never as a generation model.
 */
export const TOOL_CAPABILITY_LABELS: Readonly<Record<ToolConnectionCapability, string>> = {
  ontology_lookup: '本体查询',
  data_query: '数据查询',
  document_search: '文档检索',
  web_search: '公共网页搜索',
}

export const TOOL_ADAPTER_LABELS: Readonly<Record<ToolAdapterType, string>> = {
  native_tavily: '原生 Tavily 搜索',
  http_compat: '兼容 HTTP 网关',
}

export const TOOL_CREDENTIAL_LABELS: Readonly<Record<ToolCredentialState, string>> = {
  present: '凭据已配置',
  missing: '凭据未配置',
  revoked: '凭据已撤销',
}

export const TOOL_PROBE_STATUS_LABELS: Readonly<Record<ToolConnectionProbeStatus, string>> = {
  passed: '通过',
  failed: '未通过',
  skipped: '已跳过',
}

export const TOOL_PROBE_REASON_LABELS: Readonly<Record<ToolConnectionProbeReason, string>> = {
  authentication_failed: '认证失败',
  timeout: '超时',
  rate_limited: '被限流',
  protocol_mismatch: '协议不匹配',
  unreachable: '无法连接',
  invalid_response: '响应无法识别',
  page_not_readable: '页面不可读',
  digest_mismatch: '内容校验不一致',
  not_configured: '未配置',
}

export const TOOL_EFFECTIVE_STATE_LABELS: Readonly<Record<EffectiveToolState, string>> = {
  available: '可用',
  unconfigured: '未配置',
  disabled: '已停用',
  blocked: '被阻断',
}

export const TOOL_SELECTION_SOURCE_LABELS: Readonly<Record<ToolSelectionSource, string>> = {
  object_tool: '对象工具指定',
  object_default: '对象默认',
  space_tool: '空间工具指定',
  space_default: '空间默认',
  unconfigured: '未配置',
}

export const TOOL_SELECTION_REASON_LABELS: Readonly<Record<ToolSelectionReason, string>> = {
  TOOL_NOT_CONFIGURED: '尚未配置公共搜索服务',
  TOOL_DISABLED: '所选搜索连接已被停用',
  TOOL_CAPABILITY_MISMATCH: '所选连接不提供网页搜索能力',
  CREDENTIAL_MISSING: '所选搜索连接的凭据缺失或已撤销',
  TOOL_IN_USE: '搜索连接仍被分配引用，需先解绑',
  TOOL_BINDING_REVOKED: '该执行的搜索绑定已被撤销',
}
