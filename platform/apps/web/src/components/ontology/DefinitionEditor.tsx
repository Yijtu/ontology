import { isDefinitionCandidatePayload } from '@ontology/contracts'
import type { AssetCandidateVersion, DefinitionCandidatePayload } from '@ontology/contracts'
import { Button, Field } from '../ui'

export function DefinitionEditor({ value, onChange, candidates, disabled, onSave, reason, onReason }: {
  readonly value: DefinitionCandidatePayload; readonly onChange: (value: DefinitionCandidatePayload) => void
  readonly candidates: readonly AssetCandidateVersion[]; readonly disabled: boolean
  readonly onSave: () => void; readonly reason: string; readonly onReason: (reason: string) => void
}) {
  const objects = candidates.filter((c) => c.kind === 'object')
  const attrs = candidates.filter((c) => c.payload.kind === 'attribute' && c.payload.objectLogicalId === value.logicalId)
  const card = (key: 'minCardinality' | 'maxCardinality', raw: string) => {
    if (value.kind === 'object') return
    if (raw === 'unbounded' && key === 'maxCardinality') onChange({ ...value, maxCardinality: 'unbounded' })
    else if (/^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))) onChange({ ...value, [key]: Number(raw) })
  }
  const validity = isDefinitionCandidatePayload(value)
  const selector = (label: string, selected: string, set: (id: string) => void) => <Field label={label}>{(a) => <select {...a} value={selected} onChange={(e) => set(e.target.value)}><option value="">请选择对象</option>{objects.map((c) => <option key={c.candidateId} value={c.logicalId}>{c.payload.displayName}</option>)}</select>}</Field>
  return <form onSubmit={(e) => { e.preventDefault(); if (validity && reason.trim()) onSave() }}><fieldset disabled={disabled} className="ontology-fields"><legend>编辑定义</legend>
    <div className="ontology-form-grid"><Field label="业务名称">{(a) => <input {...a} required value={value.displayName} onChange={(e) => onChange({ ...value, displayName: e.target.value })} />}</Field><Field label="业务含义">{(a) => <textarea {...a} required value={value.businessMeaning} onChange={(e) => onChange({ ...value, businessMeaning: e.target.value })} />}</Field></div>
    <Field label="提出依据">{(a) => <textarea {...a} value={value.suggestedReason} onChange={(e) => onChange({ ...value, suggestedReason: e.target.value })} />}</Field>
    {value.kind === 'object' ? <><Field label="区分同类对象的身份属性" hint="只使用当前对象已声明的属性；不要求填写实体编号。">{(a) => <div id={a.id} className="ontology-checks">{attrs.length === 0 ? <p>尚无当前对象的属性，请先确认属性定义。</p> : attrs.map((attr) => <label key={attr.candidateId}><input type="checkbox" checked={value.identityAttributeIds.includes(attr.logicalId)} onChange={(e) => onChange({ ...value, identityAttributeIds: e.target.checked ? [...value.identityAttributeIds, attr.logicalId] : value.identityAttributeIds.filter((id) => id !== attr.logicalId) })} />{attr.payload.displayName}</label>)}</div>}</Field>
      <fieldset><legend>身份有效范围</legend><label><input type="checkbox" checked={value.identityScopeDimensions?.includes('project') === true} onChange={(e) => onChange({ ...value, identityScopeDimensions: e.target.checked ? [...(value.identityScopeDimensions ?? []).filter((d) => d !== 'project'), 'project'] : (value.identityScopeDimensions ?? []).filter((d) => d !== 'project') })} />限于当前项目（项目身份由服务端绑定）</label>
      <p className="ontology-hint">修改身份范围属于破坏性变更，必须重新确认来源、审核并选择版本策略。</p>{attrs.filter((attr) => attr.payload.kind === 'attribute' && attr.payload.valueType === 'string' && attr.payload.minCardinality === 1 && attr.payload.maxCardinality === 1).map((attr) => <label key={attr.candidateId}><input type="checkbox" checked={value.identityScopeDimensions?.includes(attr.logicalId) === true} onChange={(e) => onChange({ ...value, identityScopeDimensions: e.target.checked ? [...(value.identityScopeDimensions ?? []), attr.logicalId] : (value.identityScopeDimensions ?? []).filter((d) => d !== attr.logicalId) })} />按“{attr.payload.displayName}”区分</label>)}</fieldset></> : null}
    {value.kind === 'attribute' ? <><div className="ontology-form-grid">{selector('所属对象', value.objectLogicalId, (objectLogicalId) => onChange({ ...value, objectLogicalId }))}<Field label="值的类型">{(a) => <select {...a} value={value.valueType} onChange={(e) => {
      const type = e.target.value
      if (type === 'string' || type === 'number' || type === 'boolean' || type === 'timestamp' || type === 'enum' || type === 'quantity' || type === 'reference') onChange({ ...value, valueType: type })
    }}><option value="string">文本</option><option value="number">数值</option><option value="boolean">是／否</option><option value="timestamp">时间</option><option value="enum">选项</option><option value="quantity">带单位数值</option><option value="reference">对象引用</option></select>}</Field>
      <Field label="单位">{(a) => <input {...a} value={value.unitCode ?? ''} onChange={(e) => { const next = { ...value }; if (e.target.value === '') delete next.unitCode; else next.unitCode = e.target.value; onChange(next) }} />}</Field><Field label="量纲">{(a) => <input {...a} value={value.dimension ?? ''} onChange={(e) => { const next = { ...value }; if (e.target.value === '') delete next.dimension; else next.dimension = e.target.value; onChange(next) }} />}</Field></div>
      {value.valueType === 'enum' ? <Field label="允许的选项" hint="每行一个，原文保留。">{(a) => <textarea {...a} value={value.enumValues?.join('\n') ?? ''} onChange={(e) => onChange({ ...value, enumValues: e.target.value.split('\n').filter((v) => v !== '') })} />}</Field> : null}
      {value.valueType === 'reference' ? selector('引用的对象', value.referencesObjectLogicalId ?? '', (referencesObjectLogicalId) => onChange({ ...value, referencesObjectLogicalId })) : null}</> : null}
    {value.kind === 'relation' ? <div className="ontology-form-grid">{selector('关系起点', value.fromObjectLogicalId, (fromObjectLogicalId) => onChange({ ...value, fromObjectLogicalId }))}{selector('关系终点', value.toObjectLogicalId, (toObjectLogicalId) => onChange({ ...value, toObjectLogicalId }))}</div> : null}
    {value.kind !== 'object' ? <div className="ontology-form-grid"><Field label="最少值数量">{(a) => <input {...a} type="number" min="0" step="1" value={value.minCardinality} onChange={(e) => card('minCardinality', e.target.value)} />}</Field><Field label="最多值数量" hint="填写整数或 unbounded（不限）。">{(a) => <input {...a} value={value.maxCardinality} onChange={(e) => card('maxCardinality', e.target.value)} />}</Field></div> : null}
    <Field label="本次修改原因">{(a) => <textarea {...a} required value={reason} onChange={(e) => onReason(e.target.value)} />}</Field>
    <p className="ontology-hint">保存会生成新的候选版本。确认真实来源后，请单独提交人工审核。</p>
    {!validity ? <p role="alert">表单尚未满足定义契约，请检查字段、基数与身份声明。</p> : null}<Button type="submit" variant="primary" disabled={disabled || !validity || !reason.trim()}>保存为新候选</Button>
  </fieldset></form>
}
