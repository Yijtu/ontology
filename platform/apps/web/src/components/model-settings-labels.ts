import type {
  EffectiveModelState,
  ModelCapability,
  ModelConnectionTestReason,
  ModelCredentialState,
  ModelProtocol,
  ModelSelectionReason,
  ModelSelectionSource,
  ModelAdapterType,
} from '../api/model-connections'

/**
 * Human labels for the model-selection vocabulary (design §5.2/§5.3).
 *
 * Every value rendered here is a closed enum or a machine reason code. Provider text, response
 * bodies and credentials are never part of this vocabulary, so nothing untrusted can reach a
 * label. JEV is named as its own capability/adapter and never presented as a generation model.
 */
export const CAPABILITY_LABELS: Readonly<Record<ModelCapability, string>> = {
  generation: '生成',
  research: '研究',
  decision_jev: '决策 JEV',
}

export const ADAPTER_LABELS: Readonly<Record<ModelAdapterType, string>> = {
  company_generation: '公司生成适配器',
  jev: 'JEV 适配器',
}

export const PROTOCOL_LABELS: Readonly<Record<ModelProtocol, string>> = {
  openai_compatible: 'OpenAI 兼容',
  private: '私有协议',
  jev: 'JEV 协议',
}

export const CREDENTIAL_LABELS: Readonly<Record<ModelCredentialState, string>> = {
  present: '凭据已配置',
  missing: '凭据未配置',
  revoked: '凭据已撤销',
}

export const TEST_REASON_LABELS: Readonly<Record<ModelConnectionTestReason, string>> = {
  authentication_failed: '认证失败',
  timeout: '超时',
  rate_limited: '被限流',
  protocol_mismatch: '协议不匹配',
  unreachable: '无法连接',
  invalid_response: '响应无法识别',
}

export const EFFECTIVE_STATE_LABELS: Readonly<Record<EffectiveModelState, string>> = {
  available: '可用',
  unconfigured: '未配置',
  disabled: '已停用',
  blocked: '被阻断',
}

export const SELECTION_SOURCE_LABELS: Readonly<Record<ModelSelectionSource, string>> = {
  object_capability: '对象能力指定',
  object_default: '对象默认',
  space_capability: '空间能力指定',
  space_default: '空间默认',
  unconfigured: '未配置',
}

export const SELECTION_REASON_LABELS: Readonly<Record<ModelSelectionReason, string>> = {
  MODEL_NOT_CONFIGURED: '尚未配置可用模型',
  MODEL_DISABLED: '所选连接已被停用',
  MODEL_CAPABILITY_MISMATCH: '所选连接不支持该能力',
  CREDENTIAL_MISSING: '所选连接的凭据缺失或已撤销',
  MODEL_IN_USE: '连接仍被分配引用，需先解绑',
  MODEL_BINDING_REVOKED: '该执行的模型绑定已被撤销',
}
