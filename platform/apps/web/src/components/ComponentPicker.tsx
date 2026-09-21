import type { ComponentVersionRecord, VersionRef } from '@ontology/contracts'

export interface CompositionSelection {
  readonly industry?: VersionRef
  readonly runtime?: VersionRef
  readonly backend?: VersionRef
}

export interface ComponentPickerProps {
  readonly components: readonly ComponentVersionRecord[]
  readonly selection: CompositionSelection
  readonly onChange: (selection: CompositionSelection) => void
}

const BACKEND_KINDS: readonly string[] = ['data_backend', 'document_backend', 'blob_backend']

function refValue(ref: VersionRef | undefined): string {
  return ref === undefined ? '' : `${ref.id}@${ref.version}`
}

function findRef(
  components: readonly ComponentVersionRecord[],
  kinds: readonly string[],
  value: string,
): VersionRef | undefined {
  const match = components.find(
    (component) => kinds.includes(component.manifest.kind) && refValue(component.manifestRef) === value,
  )
  return match?.manifestRef
}

interface PickerProps {
  readonly label: string
  readonly testId: string
  readonly components: readonly ComponentVersionRecord[]
  readonly kinds: readonly string[]
  readonly selected: VersionRef | undefined
  readonly onSelect: (ref: VersionRef | undefined) => void
}

function Picker({ label, testId, components, kinds, selected, onSelect }: PickerProps) {
  const options = components.filter((component) => kinds.includes(component.manifest.kind))
  return (
    <label className="picker">
      <span className="picker__label">{label}</span>
      <select
        data-testid={testId}
        value={refValue(selected)}
        disabled={options.length === 0}
        onChange={(event) => onSelect(findRef(components, kinds, event.target.value))}
      >
        <option value="">未选择</option>
        {options.map((component) => (
          <option
            key={`${component.manifest.kind}:${component.manifestRef.id}@${component.manifestRef.version}`}
            value={refValue(component.manifestRef)}
          >
            {component.manifestRef.id}@{component.manifestRef.version}（{component.manifest.kind}）
          </option>
        ))}
      </select>
      {options.length === 0 ? <span className="picker__empty">无已注册项</span> : null}
    </label>
  )
}

/**
 * Pick from the registered industry pack, runtime and data backends. The picker only
 * offers components the registry actually reports; there is no free-form entry, so a
 * deployment cannot reference an unregistered component.
 */
export function ComponentPicker({ components, selection, onChange }: ComponentPickerProps) {
  return (
    <section className="component-picker" data-testid="component-picker">
      <h3>组件选择</h3>
      <div className="component-picker__fields">
        <Picker
          label="行业包"
          testId="picker-industry"
          components={components}
          kinds={['industry_pack']}
          selected={selection.industry}
          onSelect={(industry) => onChange({ ...selection, ...(industry === undefined ? {} : { industry }) })}
        />
        <Picker
          label="Runtime"
          testId="picker-runtime"
          components={components}
          kinds={['runtime']}
          selected={selection.runtime}
          onSelect={(runtime) => onChange({ ...selection, ...(runtime === undefined ? {} : { runtime }) })}
        />
        <Picker
          label="数据后端"
          testId="picker-backend"
          components={components}
          kinds={BACKEND_KINDS}
          selected={selection.backend}
          onSelect={(backend) => onChange({ ...selection, ...(backend === undefined ? {} : { backend }) })}
        />
      </div>
    </section>
  )
}
