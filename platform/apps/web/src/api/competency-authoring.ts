import { isRecord, isVersionRef } from '@ontology/contracts'
import type { CompetencyObservation, CompetencyQuestion, CompetencyQuestionSetBody, CompetencyRuleExpectation, VersionRef } from '@ontology/contracts'
import type { ExecutionPreviewView, ExecutionRuleChoice } from './execution-preview'
import type { FormalAttributeView } from './semantic-authoring'

export interface HumanRuleInput { readonly bytes: Uint8Array; readonly objectId: string; readonly entityId: string; readonly fields: readonly FormalAttributeView[]; readonly observations: readonly Omit<CompetencyObservation, 'source'>[] }
const same = (a: VersionRef, b: VersionRef) => a.id === b.id && a.version === b.version && a.digest === b.digest
const csv = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
/** Values come only from the human input form; expected results never enter CSV construction. */
export function prepareHumanRuleInput(preview: ExecutionPreviewView, rule: ExecutionRuleChoice, values: Readonly<Record<string, string>>): HumanRuleInput {
  if (!preview.ruleChoices.some((row) => row.ruleId === rule.ruleId && same(row.ref, rule.ref) && row.objectId === rule.objectId)) throw new Error('请选择当前真实保存版本中的规则。')
  const identity = preview.definitions.identityScopes.find((row) => row.objectId === rule.objectId)
  if (identity === undefined || identity.identityAttributeIds.length !== 1) throw new Error('此表单只支持一个明确原文身份字段；当前定义需要其他输入方式。')
  const all = preview.definitions.attributes.filter((field) => field.objectId === rule.objectId)
  const native = all.find((field) => field.attributeId === identity.identityAttributeIds[0])
  if (native?.valueType !== 'string' || native.min !== 1 || native.max !== 1) throw new Error('当前规则缺少可从原始行确认的单值文本身份字段。')
  if (Object.keys(values).some((id) => !all.some((field) => field.attributeId === id))) throw new Error('输入包含当前对象未声明的字段。')
  const entityId = values[native.attributeId] ?? ''
  if (!entityId.trim() || entityId.length > 256) throw new Error('请填写原始行中用于区分对象的名称或编号。')
  const observations: Omit<CompetencyObservation, 'source'>[] = [], fields: FormalAttributeView[] = [], raw: string[] = []
  for (const field of all) {
    const value = values[field.attributeId] ?? ''
    const dimensionRequired = identity.scopeDimensions.includes(field.attributeId)
    if (value === '') { if (field.min > 0 || field.attributeId === native.attributeId || dimensionRequired) throw new Error('请填写所有必填原始值与身份范围字段。'); continue }
    if (field.min > 1 || !['string','enum','boolean','quantity'].includes(field.valueType)) throw new Error('当前表单支持单值文本、选项、是或否、带单位数值；其他原始类型暂需正式题集导入。')
    let observed: CompetencyObservation['value'] = value
    if (field.valueType === 'quantity') { if (field.unitCode === undefined || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) throw new Error('请完整填写十进制原值，单位使用已发布定义；不会转换成浮点数。'); observed = { amount: value, unit: field.unitCode } }
    if (field.valueType === 'boolean') { if (value !== 'true' && value !== 'false') throw new Error('请明确选择是或否。'); observed = value === 'true' }
    if (field.valueType === 'enum' && !field.enumValues?.includes(value)) throw new Error('请选择已发布定义允许的原文选项。')
    fields.push(field); raw.push(value); observations.push({ factId: `original-field-${observations.length + 1}`, entityId, objectId: rule.objectId, attributeId: field.attributeId, value: observed, recordedSeq: '1', status: 'active' })
  }
  if (fields.length > 32) throw new Error('此表单最多绑定32个实际原文字段。')
  return { objectId: rule.objectId, entityId, fields, observations, bytes: new TextEncoder().encode(`${fields.map((field) => csv(field.attributeId)).join(',')}\n${raw.map(csv).join(',')}\n`) }
}
export function buildHumanRuleQuestion(preview: ExecutionPreviewView, rule: ExecutionRuleChoice, input: HumanRuleInput, original: VersionRef,
  authored: { readonly projectAlias: string; readonly questionId: string; readonly question: string; readonly derivation: string; readonly validAt: string; readonly expected: CompetencyRuleExpectation }): CompetencyQuestion {
  if (!authored.question.trim() || !authored.derivation.trim() || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(authored.validAt) || !Number.isFinite(Date.parse(authored.validAt))) throw new Error('请填写业务问题、验证时间和独立期望的依据。')
  if (!rule.hasBusinessConclusion && authored.expected.propositionState !== 'unknown') throw new Error('此规则没有经审核的业务结论，不能把适用性当作业务结论。')
  const location = { sourceRef: { id: original.id, version: original.version, digest: original.digest }, startOffset: 0, endOffset: input.bytes.byteLength, quoteDigest: original.digest, offsetUnit: 'utf8_byte' as const }
  const policy = rule.sourceRefs.map((ref) => preview.sources.find((source) => same(source.sourceRef, ref))?.wholeSourceLocation)
  if (policy.length === 0 || policy.some((source) => source === undefined)) throw new Error('当前规则缺少服务端确认的完整原文位置，不能编写已绑定来源的问题。')
  return { questionId: authored.questionId, question: authored.question, taskKind: 'rule_judgement', definitionRef: preview.definitionRef, ruleRefs: [rule.ref], input: { dataMode: 'synthetic', scopeRef: preview.definitions.scopeRef, projectId: authored.projectAlias, validAt: authored.validAt, asOfRecordedSeq: '1', observations: input.observations.map((observation) => ({ ...observation, source: location })), relations: [], structuredSources: [{ sourceRef: location.sourceRef, objectId: rule.objectId, attributeIds: input.fields.map((field) => field.attributeId) }] }, intent: { kind: 'rule', projectId: authored.projectAlias, objectId: rule.objectId, subjectEntityId: input.entityId, ruleId: rule.ruleId }, requiredCapabilities: ['semantic_read'], requiredSources: [...policy.filter((source): source is NonNullable<typeof source> => source !== undefined), location], expected: { ...authored.expected }, goldOrigin: 'authored_oracle', derivation: authored.derivation, specRefs: ['tasks/spec-v0.3a/execution-evidence.md#EX-11'] }
}
export function humanQuestionSet(preview: ExecutionPreviewView, questions: readonly CompetencyQuestion[]): CompetencyQuestionSetBody {
  if (questions.length < 1 || questions.length > 128) throw new Error('请明确编写1至128个独立问题。')
  const refs = <T extends VersionRef>(values: readonly T[]) => [...new Map(values.map((ref) => [`${ref.id}:${ref.version}:${ref.digest}`, ref])).values()]
  return { schemaVersion: 'competency-questions@1', classification: 'synthetic_demo_not_an_industry_standard', execution: 'not_run', industryId: preview.workspace.namespace, definitionRefs: [preview.definitionRef], ruleRefs: refs(questions.flatMap((question) => question.ruleRefs)), sourceRefs: refs(questions.flatMap((question) => question.requiredSources.map((source) => source.sourceRef))), allowedCapabilities: ['semantic_read'], externalGold: { status: 'missing_resources', acceptance: 'unverified', missingResources: ['human_quote_gold'] }, questions: [...questions] }
}
export function canAppendHumanQuestion(preview: ExecutionPreviewView, body: Readonly<Record<string, unknown>>): boolean {
  return Array.isArray(body['questions']) && body['questions'].length < 128 && body['questions'].every((value: unknown) => isRecord(value) && isVersionRef(value['definitionRef']) && same(value['definitionRef'], preview.definitionRef) && Array.isArray(value['ruleRefs']) && value['ruleRefs'].every((ref: unknown) => isVersionRef(ref) && preview.ruleRefs.some((rule) => same(ref, rule))))
}
/** Appending retains every existing independent expected literal, including edits in the parent view. */
export function appendHumanQuestion(preview: ExecutionPreviewView, body: Readonly<Record<string, unknown>> | undefined, question: CompetencyQuestion): Readonly<Record<string, unknown>> {
  const fresh = humanQuestionSet(preview, [question])
  if (body === undefined) return { ...fresh }
  if (!canAppendHumanQuestion(preview, body) || !Array.isArray(body['questions']) || !Array.isArray(body['sourceRefs']) || !body['sourceRefs'].every(isVersionRef) || !Array.isArray(body['ruleRefs']) || !body['ruleRefs'].every(isVersionRef)) throw new Error('请明确开始一个当前版本的新题集，旧题集保留。')
  const refs = (values: readonly VersionRef[]) => [...new Map(values.map((ref) => [`${ref.id}:${ref.version}:${ref.digest}`, ref])).values()]
  return { ...fresh, questions: [...body['questions'], question], sourceRefs: refs([...body['sourceRefs'], ...fresh.sourceRefs]), ruleRefs: refs([...body['ruleRefs'], ...fresh.ruleRefs]) }
}
