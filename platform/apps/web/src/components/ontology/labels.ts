import type { RuleExpressionNode } from '@ontology/contracts'
import { conditionSummary } from './ConditionEditor'
export const sourceReasonLabels: Readonly<Record<string, string>> = {
  NOT_APPROVED: '来源尚未批准', SOURCE_RETRACTED: '来源已经撤回', SCOPE_MISMATCH: '来源不属于当前授权范围', DOCUMENT_SET_CHANGED: '工作区语料版本已经变化', PARSE_NOT_COMPLETE: '解析尚未完成', SOURCE_MISMATCH: '来源版本不匹配', DIGEST_MISMATCH: '来源内容校验不一致', MISSING_ORIGINAL: '缺少原始文件', UNSUPPORTED_MEDIA_TYPE: '暂不支持该资料格式', READ_FAILED: '原文读取失败', EMPTY_SOURCE: '原文没有可读取内容', SAMPLE_LIMIT: '已到预览样本上限', FRAGMENT_LIMIT: '已到片段上限', BYTE_LIMIT: '已到内容字节上限', TOKEN_LIMIT: '已到输入预算上限', PAGE_LIMIT: '已到分页上限', READ_BYTE_LIMIT: '已到原文读取上限', CANCELLED: '读取已经取消', INVALID_REQUEST: '读取条件不完整',
}
export const supportReasonLabels: Readonly<Record<string, string>> = { DIFFERENT_CONDITION_OR: '不同条件的或关系暂不能完整执行', RELATION_PREMISE_UNSUPPORTED: '关系前提超出当前支持范围', RULE_DEPENDENCY_CYCLE: '上游规则存在循环依赖', RULE_DEPENDENCY_DEPTH: '上游规则依赖层级过深', UNSUPPORTED_NEGATION: '不能对未观测条件作否定判断', UNSUPPORTED_QUANTIFIER: '此量词暂不支持', UNSUPPORTED_RANGE: '此范围条件暂不支持', UNRESOLVED_REFERENCE: '条件引用尚未解析', MALFORMED_EXPRESSION: '条件结构不完整', UNSUPPORTED_EXCEPTION: '此例外暂不能完整执行', NO_REGISTERED_OPERATION: '尚未选择真实注册实现', OPERATION_NOT_AUTHORIZED: '当前角色未获准使用该实现', MISSING_CAPABILITY: '当前环境缺少所需能力', CONTRACT_INCOMPATIBLE: '动作与实现的输入输出契约不一致', NOT_READ_ONLY: '此阶段只允许执行只读实现' }
export function humanClauseLabels(node: RuleExpressionNode, labels: ReadonlyMap<string, string>, path = 'condition', prefix = '主条件'): ReadonlyMap<string, string> {
  const result = new Map<string, string>([[path, `${prefix}：${conditionSummary(node, labels)}`]])
  const children = node.op === 'all' || node.op === 'any' ? node.operands.map((child, i) => ({ child, path: `${path}.operands[${i}]`, prefix: `${prefix} · 第 ${i + 1} 项` })) : node.op === 'not' ? [{ child: node.operand, path: `${path}.operand`, prefix: `${prefix} · 被否定的条件` }] : node.op === 'relation' && node.targetCondition !== undefined ? [{ child: node.targetCondition, path: `${path}.targetCondition`, prefix: `${prefix} · 关系目标条件` }] : []
  for (const child of children) for (const [key, value] of humanClauseLabels(child.child, labels, child.path, child.prefix)) result.set(key, value)
  return result
}
