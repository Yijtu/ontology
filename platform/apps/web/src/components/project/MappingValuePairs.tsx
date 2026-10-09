import { Button, Field } from '../ui'

export function MappingValuePairs({
  pairs,
  values,
  disabled,
  onChange,
}: {
  readonly pairs: readonly { readonly from: string; readonly to: string }[]
  readonly values: readonly string[]
  readonly disabled: boolean
  readonly onChange: (pairs: readonly { readonly from: string; readonly to: string }[]) => void
}) {
  return (
    <details className="project-value-mapping">
      <summary>原始编码对应（可选）</summary>
      {pairs.map((pair, index) => (
        <div className="project-form-grid" key={index}>
          <Field label="原始值">
            {(attributes) => (
              <input
                {...attributes}
                value={pair.from}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    pairs.map((entry, position) =>
                      position === index ? { ...entry, from: event.target.value } : entry,
                    ),
                  )
                }
              />
            )}
          </Field>
          <Field label="规范值">
            {(attributes) => (
              <select
                {...attributes}
                value={pair.to}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    pairs.map((entry, position) =>
                      position === index ? { ...entry, to: event.target.value } : entry,
                    ),
                  )
                }
              >
                <option value="">选择规范值…</option>
                {values.map((value) => (
                  <option key={value} value={value}>
                    {value === 'true' ? '是' : value === 'false' ? '否' : value}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button
            variant="quiet"
            disabled={disabled}
            onClick={() => onChange(pairs.filter((_, position) => position !== index))}
          >
            移除此对应
          </Button>
        </div>
      ))}
      <Button
        variant="quiet"
        disabled={disabled || values.length === 0 || pairs.length >= 100}
        onClick={() => onChange([...pairs, { from: '', to: '' }])}
      >
        添加原始编码对应
      </Button>
      {values.length === 0 ? <p>当前定义未提供可选规范值，不能猜测编码对应。</p> : null}
    </details>
  )
}
