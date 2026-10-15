import { useEffect, useRef, useState } from 'react'
import { isRecord, isVersionRef } from '@ontology/contracts'
import type { CompetencyQuestion, CompetencyRuleExpectation } from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import type { ExecutionPreviewView } from '../../api/execution-preview'
import { buildHumanRuleQuestion, prepareHumanRuleInput } from '../../api/competency-authoring'
import { formalAttributeLabel } from '../../api/semantic-authoring'
import { invalidWire } from '../../api/ontology'
import { classifyPublicError } from '../../state/public-errors'
import type { PublicFailure } from '../../state/public-errors'
import { webWorkspaceIdentity } from '../../workspace-identity'
import { PublicStateNotice } from '../PublicStateNotice'
import { Button, Field } from '../ui'

export function CompetencyRuleAuthoringForm({ client, preview, disabled, questionCount, onQuestion, onBusy }: { readonly client: WorkbenchClient; readonly preview: ExecutionPreviewView; readonly disabled: boolean; readonly questionCount: number; readonly onQuestion: (question: CompetencyQuestion) => void; readonly onBusy: (busy: boolean) => void }) {
  const [ruleId, setRuleId] = useState(''), [values, setValues] = useState<Readonly<Record<string, string>>>({})
  const [question, setQuestion] = useState(''), [derivation, setDerivation] = useState(''), [validAt, setValidAt] = useState(() => new Date().toISOString().slice(0, 16))
  const [condition, setCondition] = useState<CompetencyRuleExpectation['conditionState'] | ''>(''), [applicability, setApplicability] = useState<CompetencyRuleExpectation['applicability'] | ''>(''), [proposition, setProposition] = useState<CompetencyRuleExpectation['propositionState'] | ''>('')
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<PublicFailure>(), [notice, setNotice] = useState('')
  const epoch = useRef(0), controller = useRef<AbortController | undefined>(undefined), aliases = useRef(new Map<string, string>())
  const contextKey = `${preview.workspace.workspaceId}:${preview.templateBindingRef.id}:${preview.templateBindingRef.digest}`
  const currentContext = useRef(contextKey); currentContext.current = contextKey
  const ruleDrafts = useRef(new Map<string, { readonly values: Readonly<Record<string, string>>; readonly question: string; readonly derivation: string; readonly validAt: string; readonly condition: typeof condition; readonly applicability: typeof applicability; readonly proposition: typeof proposition }>())
  const chooseRule = (nextId: string) => {
    if (ruleId) ruleDrafts.current.set(`${contextKey}:${ruleId}`, { values, question, derivation, validAt, condition, applicability, proposition })
    const saved = ruleDrafts.current.get(`${contextKey}:${nextId}`)
    setRuleId(nextId); setValues(saved?.values ?? {}); setQuestion(saved?.question ?? ''); setDerivation(saved?.derivation ?? ''); setValidAt(saved?.validAt ?? new Date().toISOString().slice(0, 16)); setCondition(saved?.condition ?? ''); setApplicability(saved?.applicability ?? ''); setProposition(saved?.proposition ?? '')
  }
  useEffect(() => { epoch.current++; controller.current?.abort(); setBusy(false); onBusy(false); setRuleId(''); setValues({}); setQuestion(''); setDerivation(''); setCondition(''); setApplicability(''); setProposition(''); setFailure(undefined); setNotice(''); return () => { epoch.current++; controller.current?.abort(); onBusy(false) } }, [contextKey, onBusy])
  const rule = preview.ruleChoices.find((row) => row.ruleId === ruleId), fields = preview.definitions.attributes.filter((field) => field.objectId === rule?.objectId)
  const object = preview.definitions.objects.find((row) => row.objectId === rule?.objectId)
  let issue = ''
  try { if (rule !== undefined) prepareHumanRuleInput(preview, rule, values) } catch (error) { issue = error instanceof Error ? error.message : '请核对输入。' }
  const policyReady = rule !== undefined && rule.sourceRefs.length > 0 && rule.sourceRefs.every((ref) => preview.sources.some((source) => source.sourceRef.id === ref.id && source.sourceRef.version === ref.version && source.sourceRef.digest === ref.digest && source.wholeSourceLocation !== undefined))
  const add = async () => {
    if (disabled || busy || rule === undefined || !policyReady || condition === '' || applicability === '' || rule.hasBusinessConclusion && proposition === '' || !question.trim() || !derivation.trim() || issue) return
    const token = epoch.current, owner = contextKey, abort = new AbortController(); controller.current = abort; setBusy(true); onBusy(true); setFailure(undefined); setNotice('')
    try {
      const input = prepareHumanRuleInput(preview, rule, values)
      if (input.bytes.byteLength > 8_388_608) throw new Error('合成原文超过8 MiB。')
      const response = await client.requestBytes('POST', '/api/v1/competency-question-sources', input.bytes, { mediaType: 'text/csv', signal: abort.signal })
      if (abort.signal.aborted || token !== epoch.current || currentContext.current !== owner) return
      if (!isRecord(response) || !isVersionRef(response['sourceRef'])) return invalidWire()
      const original = response['sourceRef'], actualDigest = await webWorkspaceIdentity.sha256(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes))
      if (abort.signal.aborted || token !== epoch.current || currentContext.current !== owner) return
      if (actualDigest !== original.digest) return invalidWire()
      const alias = aliases.current.get(owner) ?? webWorkspaceIdentity.newId(); aliases.current.set(owner, alias)
      const expected: CompetencyRuleExpectation = { kind: 'rule', conditionState: condition, applicability, propositionState: rule.hasBusinessConclusion ? proposition || 'unknown' : 'unknown' }
      const value = buildHumanRuleQuestion(preview, rule, input, original, { projectAlias: alias, questionId: `human-rule-${webWorkspaceIdentity.newId()}`, question, derivation, validAt: `${validAt.length === 16 ? `${validAt}:00` : validAt}Z`, expected })
      onQuestion(value); setNotice('合成原始行已真实存档，问题已加入待保存题集；输入和期望没有互相推导。题集仍需保存并单独人工批准。')
    } catch (error) { if (token === epoch.current && currentContext.current === owner) { if (abort.signal.aborted) setNotice('已停止等待；原文写入结果需要重新核对，输入仍保留。'); else setFailure(classifyPublicError(error)) } }
    finally { if (token === epoch.current && currentContext.current === owner) { setBusy(false); onBusy(false) } }
  }
  const locked = disabled || busy
  return <section className="ontology-cq-author"><h4>从当前真实规则编写新问题</h4><p>选择业务规则，独立填写合成原始行和期望。表单会上传真实CSV，再编写一个当前版本题集；不会创建客户业务事实或自动批准。</p>
    <Field label="要验证的业务规则">{(a) => <select {...a} disabled={locked} value={ruleId} onChange={(event) => chooseRule(event.target.value)}><option value="">选择已审核并保存的规则</option>{preview.ruleChoices.map((choice) => <option key={choice.ruleId} value={choice.ruleId}>{choice.displayName}</option>)}</select>}</Field>
    {preview.ruleChoices.length === 0 ? <p>当前执行支持没有可选业务规则。现有正式题集仍可导入；不会把其他定义冒充规则。</p> : null}
    {rule === undefined ? null : <><p>输入对象：{object?.displayName ?? '未提供名称'}。身份在当前合成项目内由服务端从原始行确认。</p><div className="ontology-form-grid">{fields.map((field, index) => {
      const supported = ['string','enum','boolean','quantity'].includes(field.valueType) && field.min <= 1
      const name = formalAttributeLabel(field, preview.termLabels), label = name === '未提供名称' ? `属性${index + 1}（未提供名称）` : name
      return <Field key={field.attributeId} label={`${label}${field.min > 0 ? '（必填）' : '（可留空）'}`} hint={!supported ? '此合成输入表单暂不支持该类型；正式题集由服务端判定。' : field.unitCode === undefined ? '按原始含义填写，不自动生成值。' : `单位：${field.unitCode}；完整保留十进制字符串。`}>{(a) => field.valueType === 'boolean' ? <select {...a} disabled={locked || !supported} value={values[field.attributeId] ?? ''} onChange={(event) => setValues((old) => ({ ...old, [field.attributeId]: event.target.value }))}><option value="">尚未填写</option><option value="true">是</option><option value="false">否</option></select> : field.valueType === 'enum' ? <select {...a} disabled={locked || !supported} value={values[field.attributeId] ?? ''} onChange={(event) => setValues((old) => ({ ...old, [field.attributeId]: event.target.value }))}><option value="">尚未填写</option>{field.enumValues?.map((value) => <option key={value} value={value}>{value}</option>)}</select> : <input {...a} disabled={locked || !supported} inputMode={field.valueType === 'quantity' ? 'decimal' : 'text'} value={values[field.attributeId] ?? ''} onChange={(event) => setValues((old) => ({ ...old, [field.attributeId]: event.target.value }))} />}</Field>
    })}</div><Field label="业务问题">{(a) => <textarea {...a} disabled={locked} value={question} onChange={(event) => setQuestion(event.target.value)} />}</Field><Field label="验证时间（UTC）">{(a) => <input {...a} type="datetime-local" step="1" disabled={locked} value={validAt} onChange={(event) => setValidAt(event.target.value)} />}</Field>
      <fieldset disabled={locked}><legend>独立填写期望结果</legend><div className="ontology-form-grid"><Field label="期望条件">{(a) => <select {...a} value={condition} onChange={(event) => { const value = event.target.value; if (value === '' || value === 'true' || value === 'false' || value === 'unknown' || value === 'conflict') setCondition(value) }}><option value="">请选择</option><option value="true">成立</option><option value="false">不成立</option><option value="unknown">未知</option><option value="conflict">冲突</option></select>}</Field><Field label="期望适用性">{(a) => <select {...a} value={applicability} onChange={(event) => { const value = event.target.value; if (value === '' || value === 'applicable' || value === 'not_applicable' || value === 'unknown' || value === 'conflict') setApplicability(value) }}><option value="">请选择</option><option value="applicable">适用</option><option value="not_applicable">不适用</option><option value="unknown">未知</option><option value="conflict">冲突</option></select>}</Field>{rule.hasBusinessConclusion ? <Field label="期望业务结论">{(a) => <select {...a} value={proposition} onChange={(event) => { const value = event.target.value; if (value === '' || value === 'true' || value === 'false' || value === 'unknown' || value === 'conflict') setProposition(value) }}><option value="">请选择</option><option value="true">成立</option><option value="false">不成立</option><option value="unknown">未知</option><option value="conflict">冲突</option></select>}</Field> : <p>当前规则没有经审核的业务结论。业务结论保留“未知”，适用性不替代业务结论。</p>}</div><Field label="独立期望的依据">{(a) => <textarea {...a} value={derivation} onChange={(event) => setDerivation(event.target.value)} />}</Field></fieldset>
      {issue ? <p role="status" className="ontology-hint">{issue}</p> : null}{!policyReady ? <p role="status">规则原文位置尚不可确认，当前不能编写已绑定来源的问题。</p> : null}<Button variant="primary" disabled={locked || !!issue || !policyReady || !question.trim() || !derivation.trim() || !validAt || condition === '' || applicability === '' || rule.hasBusinessConclusion && proposition === '' || questionCount >= 128} onClick={() => void add()}>上传原始行并加入新题集</Button>
    </>}{failure === undefined ? null : <PublicStateNotice failure={failure} />}{notice ? <p role="status">{notice}</p> : null}{busy ? <Button onClick={() => controller.current?.abort()}>停止等待（保留输入）</Button> : null}{questionCount > 0 ? <p>{questionCount} 个问题在当前待保存题集中，请在下方核对独立期望。</p> : null}
    <p className="ontology-hint">普通表单当前支持单对象、CSV首行表头的规则问题。XLSX、其他表头、关系行、数值或时间类型不会被悄悄转换；可保留正式声明并查看服务端阻断。</p>
  </section>
}
