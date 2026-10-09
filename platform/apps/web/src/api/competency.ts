import { isRecord, isVersionRef } from '@ontology/contracts'
import type { VersionRef } from '@ontology/contracts'
import { invalidWire } from './ontology'
export interface CompetencyQuestionView { readonly questionId: string; readonly question: string; readonly taskKind: string; readonly definitionRef: VersionRef; readonly expected: unknown; readonly requiredCapabilities: readonly string[] }
export interface CompetencyDeclarationView { readonly ref?: VersionRef; readonly body: Readonly<Record<string, unknown>>; readonly questions: readonly CompetencyQuestionView[] }
export function parseCompetencyDeclaration(value: unknown): CompetencyDeclarationView {
  if (!isRecord(value)) return invalidWire()
  const body = isRecord(value['body']) ? value['body'] : value
  if (body['schemaVersion'] !== 'competency-questions@1' || body['execution'] !== 'not_run' || body['classification'] !== 'synthetic_demo_not_an_industry_standard' || !Array.isArray(body['questions']) || body['questions'].length < 1 || body['questions'].length > 128) return invalidWire()
  const questions = body['questions'].map((q: unknown) => {
    if (!isRecord(q) || typeof q['questionId'] !== 'string' || typeof q['question'] !== 'string' || typeof q['taskKind'] !== 'string' || !isVersionRef(q['definitionRef']) || !Array.isArray(q['requiredCapabilities']) || !q['requiredCapabilities'].every((c): c is string => typeof c === 'string') || q['expected'] === undefined) return invalidWire()
    return { questionId: q['questionId'], question: q['question'], taskKind: q['taskKind'], definitionRef: q['definitionRef'], expected: q['expected'], requiredCapabilities: q['requiredCapabilities'] }
  })
  if (new Set(questions.map((q) => q.questionId)).size !== questions.length) return invalidWire()
  return { ...(isVersionRef(value['ref']) ? { ref: value['ref'] } : {}), body, questions }
}
export function canonicalBody(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('题集结构超过编辑深度上限。')
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v: unknown) => canonicalBody(v, depth + 1)).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalBody(value[key], depth + 1)}`).join(',')}}`
  throw new Error('题集包含不能保存的值。')
}
/** Authoring an explicitly new body preserves independent literal gold; execution never filters a saved body. */
export function selectCompetencyQuestions(declaration: CompetencyDeclarationView, selected: readonly string[]): Readonly<Record<string, unknown>> {
  const questions = declaration.body['questions']
  if (!Array.isArray(questions)) return invalidWire()
  const chosen = questions.filter((q: unknown) => isRecord(q) && typeof q['questionId'] === 'string' && selected.includes(q['questionId']))
  if (chosen.length === 0) throw new Error('新题集至少保留一个问题。')
  const unique = (values: readonly unknown[]) => [...new Map(values.map((v) => [canonicalBody(v), v])).values()]
  return { ...declaration.body, questions: chosen,
    definitionRefs: unique(chosen.flatMap((q: unknown) => isRecord(q) ? [q['definitionRef']] : [])),
    ruleRefs: unique(chosen.flatMap((q: unknown) => isRecord(q) && Array.isArray(q['ruleRefs']) ? q['ruleRefs'] : [])) }
}
export function replaceOriginalRef(value: unknown, original: VersionRef, actual: VersionRef): unknown {
  if (Array.isArray(value)) return value.map((v: unknown) => replaceOriginalRef(v, original, actual))
  if (!isRecord(value)) return value
  if (isVersionRef(value) && value.id === original.id && value.version === original.version && value.digest === original.digest) return { ...value, ...actual }
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, key === 'expected' ? v : replaceOriginalRef(v, original, actual)]))
}
export function expectationText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return String(value)
  if (!isRecord(value)) return '尚无结果'
  if (value['kind'] === 'value') return expectationText(value['value'])
  if (typeof value['amount'] === 'string') return `${value['amount']}${typeof value['unit'] === 'string' ? ` ${value['unit']}` : typeof value['currency'] === 'string' ? ` ${value['currency']}` : ''}`
  if (value['kind'] === 'rule') { const labels: Record<string, string> = { true: '成立', false: '不成立', unknown: '未知', conflict: '冲突', applicable: '适用', not_applicable: '不适用' }; return `条件${labels[String(value['conditionState'])] ?? '未知'} · ${labels[String(value['applicability'])] ?? '未知'} · 命题${labels[String(value['propositionState'])] ?? '未知'}` }
  if (Array.isArray(value['targetEntityIds'])) return `${value['targetEntityIds'].length} 个关系目标 · ${value['completeness'] === 'complete' ? '完整' : value['completeness'] === 'partial' ? '部分' : '未知'}`
  if (typeof value['value'] === 'string') return `${value['value']}${typeof value['unitCode'] === 'string' ? ` ${value['unitCode']}` : typeof value['currency'] === 'string' ? ` ${value['currency']}` : ''}`
  if (typeof value['state'] === 'string') return ({ true: '成立', false: '不成立', unknown: '未知', conflict: '冲突' }[value['state']] ?? value['state'])
  if (typeof value['reason'] === 'string') { const reasons: Record<string, string> = { cross_project: '跨项目请求应拒绝', definition_version_mismatch: '定义版本不匹配应拒绝', unit_mismatch: '单位不匹配应拒绝', unsupported_capability: '缺少能力应拒绝' }; return reasons[value['reason']] ?? value['reason'] }
  if (Array.isArray(value['rows'])) return `${value['rows'].length} 行结果`
  if (Array.isArray(value['targets'])) return `${value['targets'].length} 个关系目标`
  return Object.entries(value).filter(([, v]) => typeof v === 'string' || typeof v === 'boolean').map(([k, v]) => `${k}：${String(v)}`).join(' · ') || '查看结果明细'
}
