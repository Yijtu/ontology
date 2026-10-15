import type { InstanceFieldValue, InstanceNormalizedValue } from '@ontology/contracts'
import { Field } from '../ui'
import type { ProjectCanonicalObject } from '../../api/project-workbench'

export interface InstanceValueDraft {
  readonly kind: 'scalar' | 'quantity' | 'reference'
  readonly scalarType: 'string' | 'boolean' | 'null'
  readonly value: string
  readonly unitCode: string
}

export function instanceValueDraft(
  field: InstanceFieldValue,
  schema?: ProjectCanonicalObject['attributes'][number],
): InstanceValueDraft {
  const value = field.normalizedValue
  if (value?.kind === 'quantity')
    return {
      kind: 'quantity',
      scalarType: 'string',
      value: schema?.unit !== undefined && schema.unit !== value.unitCode ? '' : value.value,
      unitCode: schema?.unit ?? value.unitCode,
    }
  if (value?.kind === 'reference')
    return { kind: 'reference', scalarType: 'string', value: value.entityId, unitCode: '' }
  const scalar = value?.kind === 'scalar' ? value.value : field.rawValue
  if (schema?.valueType === 'quantity')
    return { kind: 'quantity', scalarType: 'string', value: '', unitCode: schema.unit ?? '' }
  if (schema?.valueType === 'reference')
    return { kind: 'reference', scalarType: 'string', value: '', unitCode: '' }
  if (schema?.valueType === 'boolean')
    return {
      kind: 'scalar',
      scalarType: 'boolean',
      value: typeof scalar === 'boolean' ? String(scalar) : '',
      unitCode: '',
    }
  if (scalar === null && schema !== undefined)
    return { kind: 'scalar', scalarType: 'string', value: '', unitCode: '' }
  return {
    kind: 'scalar',
    scalarType: scalar === null ? 'null' : typeof scalar === 'boolean' ? 'boolean' : 'string',
    value: scalar === null ? '' : String(scalar),
    unitCode: '',
  }
}

/** Preserve the server's value family; decimal and quantity values never enter Number. */
export function normalizedInstanceValue(draft: InstanceValueDraft): InstanceNormalizedValue {
  if (draft.kind === 'quantity') return { kind: 'quantity', value: draft.value, unitCode: draft.unitCode }
  if (draft.kind === 'reference') return { kind: 'reference', entityId: draft.value }
  if (draft.scalarType === 'boolean' && draft.value !== 'true' && draft.value !== 'false')
    throw new Error('请选择是或否，不能把未选择的值默认为否。')
  return {
    kind: 'scalar',
    value:
      draft.scalarType === 'null'
        ? null
        : draft.scalarType === 'boolean'
          ? draft.value === 'true'
          : draft.value,
  }
}

export function InstanceValueEditor({
  draft,
  disabled,
  onChange,
  enumValues,
  references,
  canonicalUnit,
}: {
  readonly draft: InstanceValueDraft
  readonly disabled: boolean
  readonly onChange: (value: InstanceValueDraft) => void
  readonly enumValues?: readonly string[]
  readonly references?: readonly { readonly entityId: string; readonly displayName: string }[]
  readonly canonicalUnit?: string
}) {
  return (
    <div className="project-form-grid">
      <Field
        label={draft.kind === 'reference' ? '关联的已确认实体' : '新规范值'}
        {...(draft.kind === 'quantity' ? { hint: '保留完整小数；单位由服务端校验。' } : {})}
      >
        {(attributes) =>
          draft.kind === 'reference' ? (
            <select
              {...attributes}
              data-testid="instance-field-edit-input"
              value={draft.value}
              disabled={disabled || references === undefined || references.length === 0}
              onChange={(event) => onChange({ ...draft, value: event.target.value })}
            >
              <option value="">选择已确认实体…</option>
              {references?.some((entry) => entry.entityId === draft.value) === true || !draft.value ? null : (
                <option value={draft.value}>当前保存的引用（目录未返回此实体）</option>
              )}
              {references?.map((entry) => (
                <option key={entry.entityId} value={entry.entityId}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          ) : enumValues !== undefined ? (
            <select
              {...attributes}
              data-testid="instance-field-edit-input"
              value={draft.value}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, value: event.target.value })}
            >
              <option value="">选择规范值…</option>
              {enumValues.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          ) : draft.scalarType === 'boolean' && draft.kind === 'scalar' ? (
            <select
              {...attributes}
              data-testid="instance-field-edit-input"
              value={draft.value}
              disabled={disabled}
              onChange={(event) => onChange({ ...draft, value: event.target.value })}
            >
              <option value="">请选择是或否</option>
              <option value="true">是</option>
              <option value="false">否</option>
            </select>
          ) : (
            <input
              {...attributes}
              data-testid="instance-field-edit-input"
              type="text"
              value={draft.value}
              disabled={disabled || draft.scalarType === 'null'}
              inputMode={draft.kind === 'quantity' ? 'decimal' : undefined}
              onChange={(event) => onChange({ ...draft, value: event.target.value })}
            />
          )
        }
      </Field>
      {draft.kind === 'quantity' ? (
        <Field label="规范单位">
          {(attributes) => (
            <input
              {...attributes}
              value={draft.unitCode}
              disabled={disabled}
              readOnly={canonicalUnit !== undefined}
              onChange={(event) => onChange({ ...draft, unitCode: event.target.value })}
            />
          )}
        </Field>
      ) : null}
      {draft.kind === 'reference' && (references === undefined || references.length === 0) ? (
        <p>当前没有该类型的可选已确认实体，不能填写任意标识代替。</p>
      ) : null}
      {draft.kind === 'scalar' && draft.scalarType === 'null' ? (
        <p>当前值为空；确认空值仍按空值保存。</p>
      ) : null}
    </div>
  )
}
