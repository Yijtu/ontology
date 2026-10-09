import { isRecord } from '@ontology/contracts'
import type { AssetCandidateVersion, RuleExpressionNode } from '@ontology/contracts'
import { Button, Field } from '../ui'

export function conditionSummary(value: unknown, labels: ReadonlyMap<string, string> = new Map()): string {
  if (!isRecord(value)) return '条件格式无法确认'
  const label = (id: unknown) => typeof id === 'string' ? labels.get(id) ?? id : '未选择'
  if (value['op'] === 'compare') {
    const operators: Record<string, string> = { eq: '等于', ne: '不等于', gt: '大于', gte: '大于或等于', lt: '小于', lte: '小于或等于' }
    return `${label(value['attributeId'])} ${operators[String(value['operator'])] ?? '未知比较'} ${String(value['value'])}${typeof value['unitCode'] === 'string' ? ` ${value['unitCode']}` : ''}`
  }
  if (value['op'] === 'range') return `${label(value['attributeId'])} 在 ${String(value['min'] ?? '无下限')} 至 ${String(value['max'] ?? '无上限')}${typeof value['unitCode'] === 'string' ? ` ${value['unitCode']}` : ''}`
  if ((value['op'] === 'all' || value['op'] === 'any') && Array.isArray(value['operands'])) return `（${value['operands'].map((v: unknown) => conditionSummary(v, labels)).join(value['op'] === 'all' ? '，并且 ' : '，或者 ')}）`
  if (value['op'] === 'not') return `不满足：${conditionSummary(value['operand'], labels)}`
  if (value['op'] === 'relation') return `存在一跳「${label(value['relationId'])}」关系${value['targetCondition'] === undefined ? '' : `，目标满足 ${conditionSummary(value['targetCondition'], labels)}`}`
  return '保留的不支持条件，请查看高级详情'
}
export function clausePaths(value: RuleExpressionNode, path = 'condition'): readonly string[] {
  const children = value.op === 'all' || value.op === 'any' ? value.operands.flatMap((node, i) => clausePaths(node, `${path}.operands[${i}]`))
    : value.op === 'not' ? clausePaths(value.operand, `${path}.operand`)
    : value.op === 'relation' && value.targetCondition !== undefined ? clausePaths(value.targetCondition, `${path}.targetCondition`) : []
  return [path, ...children]
}
export function ConditionEditor({ value, onChange, definitions, objectId, disabled = false, depth = 0, relationAllowed = true }: {
  readonly value: RuleExpressionNode; readonly onChange: (value: RuleExpressionNode) => void
  readonly definitions: readonly AssetCandidateVersion[]; readonly objectId: string; readonly disabled?: boolean; readonly depth?: number; readonly relationAllowed?: boolean
}) {
  const attrs = definitions.filter((candidate) => candidate.payload.kind === 'attribute' && candidate.payload.objectLogicalId === objectId)
  const relations = definitions.filter((candidate) => candidate.payload.kind === 'relation' && candidate.payload.fromObjectLogicalId === objectId)
  const base = (): RuleExpressionNode => ({ op: 'compare', attributeId: attrs[0]?.logicalId ?? '', operator: 'eq', value: '', spans: [] })
  const changeKind = (kind: string) => {
    if (kind === 'compare') onChange(base())
    else if (kind === 'all' || kind === 'any') onChange({ op: kind, operands: [base(), base()], spans: [] })
    else if (kind === 'not') onChange({ op: 'not', operand: base(), spans: [] })
    else if (kind === 'range') onChange({ op: 'range', attributeId: attrs[0]?.logicalId ?? '', spans: [] })
    else if (kind === 'relation' && relationAllowed) onChange({ op: 'relation', relationId: relations[0]?.logicalId ?? '', spans: [] })
  }
  const currentAttribute = value.op === 'compare' || value.op === 'range' ? attrs.find((c) => c.logicalId === value.attributeId) : undefined
  const boolean = currentAttribute?.payload.kind === 'attribute' && currentAttribute.payload.valueType === 'boolean'
  const numeric = currentAttribute?.payload.kind === 'attribute' && ['number', 'quantity'].includes(currentAttribute.payload.valueType)
  const decimalInvalid = value.op === 'compare' && numeric && (typeof value.value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.value))
  const selectedRelation = value.op === 'relation' ? relations.find((r) => r.logicalId === value.relationId) : undefined
  const targetObjectId = selectedRelation?.payload.kind === 'relation' ? selectedRelation.payload.toObjectLogicalId : ''
  return <fieldset className="ontology-condition" disabled={disabled}><legend>条件{depth > 0 ? ` · 第 ${depth + 1} 层` : ''}</legend>
    <Field label="条件组合">{(a) => <select {...a} value={value.op} onChange={(e) => changeKind(e.target.value)}>
      <option value="compare">属性比较</option><option value="range">范围</option>
      <option value="all" disabled={depth >= 7}>全部满足（并且）</option><option value="any" disabled={depth >= 7}>任一满足（或者）</option>
      <option value="not" disabled={depth >= 7}>否定已观测值</option><option value="relation" disabled={!relationAllowed || relations.length === 0}>一跳关系</option>
    </select>}</Field>
    {value.op === 'compare' || value.op === 'range' ? <Field label="属性">{(a) => <select {...a} value={value.attributeId} onChange={(e) => {
      const attr = attrs.find((c) => c.logicalId === e.target.value)
      const { unitCode, ...base } = value; void unitCode
      const nextUnit = attr?.payload.kind === 'attribute' ? attr.payload.unitCode : undefined
      const nextBoolean = attr?.payload.kind === 'attribute' && attr.payload.valueType === 'boolean'
      onChange({ ...base, attributeId: e.target.value, ...(nextUnit === undefined ? {} : { unitCode: nextUnit }), ...(value.op === 'compare' ? { value: nextBoolean ? typeof value.value === 'boolean' ? value.value : '' : typeof value.value === 'boolean' ? '' : value.value } : {}) })
    }}><option value="">选择当前对象的属性</option>{attrs.map((attr) => <option key={attr.candidateId} value={attr.logicalId}>{attr.payload.displayName}</option>)}</select>}</Field> : null}
    {value.op === 'compare' ? <div className="ontology-form-grid"><Field label="比较方式">{(a) => <select {...a} value={value.operator} onChange={(e) => {
      const op = e.target.value
      if (op === 'eq' || op === 'ne' || op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') onChange({ ...value, operator: op })
    }}><option value="eq">等于</option><option value="ne">不等于</option><option value="gt">大于</option><option value="gte">大于或等于</option><option value="lt">小于</option><option value="lte">小于或等于</option></select>}</Field>
      <Field label="比较值" {...(numeric ? { hint: '十进制原文保存，不转换成浮点数。' } : {})} {...(decimalInvalid ? { error: '请输入完整的十进制字符串。' } : boolean && typeof value.value !== 'boolean' ? { error: '请选择明确的是或否。' } : {})}>{(a) => boolean ? <select {...a} value={typeof value.value === 'boolean' ? String(value.value) : ''} onChange={(e) => onChange({ ...value, value: e.target.value === '' ? '' : e.target.value === 'true' })}><option value="">请选择是或否</option><option value="true">是</option><option value="false">否</option></select> : <input {...a} inputMode={numeric ? 'decimal' : 'text'} value={String(value.value)} onChange={(e) => onChange({ ...value, value: e.target.value })} />}</Field>
      <Field label="单位">{(a) => <input {...a} value={value.unitCode ?? ''} onChange={(e) => { const next = { ...value }; if (e.target.value === '') delete next.unitCode; else next.unitCode = e.target.value; onChange(next) }} />}</Field></div> : null}
    {value.op === 'range' ? <div><p className="ontology-hint">范围边界当前只编辑安全整数；小数范围请用两个精确字符串比较组成“并且”。原有范围完整保留。</p><div className="ontology-form-grid">{(['min', 'max'] as const).map((key) => <Field key={key} label={key === 'min' ? '下限' : '上限'}>{(a) => <input {...a} inputMode="numeric" value={value[key] ?? ''} onChange={(e) => {
      const raw = e.target.value
      if (/^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) onChange({ ...value, [key]: Number(raw) })
      else if (raw === '') { const next = { ...value }; delete next[key]; onChange(next) }
    }} />}</Field>)}</div></div> : null}
    {value.op === 'all' || value.op === 'any' ? <div>{value.operands.map((operand, i) => <div key={i}><ConditionEditor value={operand} onChange={(node) => onChange({ ...value, operands: value.operands.map((v, j) => j === i ? node : v) })} definitions={definitions} objectId={objectId} disabled={disabled} depth={depth + 1} relationAllowed={relationAllowed} /><Button disabled={value.operands.length <= 1} onClick={() => onChange({ ...value, operands: value.operands.filter((_v, j) => j !== i) })}>移除此条件</Button></div>)}<Button disabled={value.operands.length >= 16 || depth >= 7} onClick={() => onChange({ ...value, operands: [...value.operands, base()] })}>添加条件</Button></div> : null}
    {value.op === 'not' ? <ConditionEditor value={value.operand} onChange={(operand) => onChange({ ...value, operand })} definitions={definitions} objectId={objectId} disabled={disabled} depth={depth + 1} relationAllowed={false} /> : null}
    {value.op === 'relation' ? <div><Field label="关系">{(a) => <select {...a} value={value.relationId} onChange={(e) => onChange({ ...value, relationId: e.target.value })}><option value="">选择已声明关系</option>{relations.map((r) => <option key={r.candidateId} value={r.logicalId}>{r.payload.displayName}</option>)}</select>}</Field>{value.targetCondition === undefined ? <Button onClick={() => onChange({ ...value, targetCondition: { op: 'compare', attributeId: '', operator: 'eq', value: '', spans: [] } })}>添加目标对象条件</Button> : <ConditionEditor value={value.targetCondition} onChange={(targetCondition) => onChange({ ...value, targetCondition })} definitions={definitions} objectId={targetObjectId} disabled={disabled} depth={depth + 1} relationAllowed={false} />}</div> : null}
  </fieldset>
}
