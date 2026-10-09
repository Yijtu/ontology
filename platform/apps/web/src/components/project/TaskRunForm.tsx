import { useMemo, useState } from 'react'
import type { ProjectCanonicalObject, ProjectTaskItem } from '../../api/project-workbench'
import { Button, Field } from '../ui'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const LABEL: Readonly<Record<string, string>> = {
  objectId: '记录类型',
  object: '记录类型',
  fields: '查询字段',
  limit: '最多返回条数',
  query: '资料中的问题',
  rule: '规则条件',
  entity: '关联实体',
  startEntityId: '起始实体',
  relationIds: '关联关系',
}
type Choice = { readonly value: string; readonly label: string }
type Raw = string | readonly string[]
interface ParameterField {
  readonly path: readonly string[]
  readonly label: string
  readonly type: 'string' | 'integer' | 'number' | 'boolean' | 'array'
  readonly required: boolean
  readonly optionalParent?: readonly string[]
  readonly schema: Readonly<Record<string, unknown>>
  readonly choices?: readonly Choice[]
}
const keyOf = (path: readonly string[]) => JSON.stringify(path)
const empty = (value: Raw | undefined) =>
  value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
const decimalText = (value: string) =>
  value
    .replace(/(\.[0-9]*?)0+$/u, '$1')
    .replace(/\.$/u, '')
    .replace(/^-0$/u, '0')

/** Read-only host choices provide values; a user selects labels rather than typing authority refs. */
function choicesFor(
  task: ProjectTaskItem,
  objects: readonly ProjectCanonicalObject[],
  name: string,
  values: Readonly<Record<string, Raw>>,
): readonly Choice[] | undefined {
  const selectedObject = values[keyOf(['objectId'])] ?? values[keyOf(['object'])]
  const candidates = task.objects ?? []
  if (name === 'objectId' || name === 'object')
    return candidates.map((object) => ({ value: object.objectId, label: object.displayName }))
  if (name === 'rule')
    return (task.rules ?? [])
      .filter((rule) => !selectedObject || rule.objectId === selectedObject)
      .map((rule) => ({ value: rule.ruleId, label: rule.displayName }))
  if (name === 'entity' || name === 'startEntityId')
    return candidates
      .filter((object) => !selectedObject || object.objectId === selectedObject)
      .flatMap((object) =>
        (object.entities ?? []).map((entity) => ({
          value: entity.entityId,
          label: `${entity.displayName} · ${object.displayName}`,
        })),
      )
  if (name === 'fields')
    return (objects.find((object) => object.objectId === selectedObject)?.attributes ?? []).map((field) => ({
      value: field.attributeId,
      label: field.displayName,
    }))
  if (name === 'relationIds') {
    const selectedEntity = values[keyOf(['startEntityId'])]
    const origin = candidates.find((object) =>
      object.entities?.some((entity) => entity.entityId === selectedEntity),
    )
    return (task.relations ?? [])
      .filter((relation) => origin === undefined || relation.fromObjectId === origin.objectId)
      .map((relation) => ({ value: relation.relationId, label: relation.displayName }))
  }
  return undefined
}

function fieldsFor(
  task: ProjectTaskItem,
  objects: readonly ProjectCanonicalObject[],
  values: Readonly<Record<string, Raw>>,
): { fields: readonly ParameterField[]; error?: string } {
  const fields: ParameterField[] = []
  let failure: string | undefined
  const walk = (
    schema: Readonly<Record<string, unknown>>,
    path: readonly string[],
    required: boolean,
    depth: number,
    optionalParent?: readonly string[],
  ) => {
    if (depth > 4 || fields.length >= 128) {
      failure = '参数结构超过表单可展示的范围。'
      return
    }
    if (schema['type'] === 'object') {
      if (!record(schema['properties'])) {
        failure = '参数对象缺少已声明的字段。'
        return
      }
      const requiredKeys = Array.isArray(schema['required']) ? schema['required'] : []
      for (const [name, child] of Object.entries(schema['properties'])) {
        if (['__proto__', 'prototype', 'constructor'].includes(name) || !record(child)) {
          failure = '存在无法安全展示的参数字段。'
          continue
        }
        if (path.length === 0 && task.taskKind === 'relations' && name === 'validAt') continue
        if (
          path.length === 0 &&
          task.taskKind === 'rule_judgement' &&
          !['rule', 'entity', 'object'].includes(name)
        )
          continue
        walk(
          child,
          [...path, name],
          requiredKeys.includes(name),
          depth + 1,
          path.length > 0 && !required ? path : optionalParent,
        )
      }
      return
    }
    const type = schema['type']
    if (
      (type !== 'string' &&
        type !== 'boolean' &&
        type !== 'integer' &&
        type !== 'number' &&
        type !== 'array') ||
      (type === 'array' && (!record(schema['items']) || schema['items']['type'] !== 'string'))
    ) {
      failure = '有参数尚不能由此表单表达，任务暂不可执行。'
      return
    }
    const name = path.at(-1) ?? ''
    let choices = path.length === 1 ? choicesFor(task, objects, name, values) : undefined
    if (
      choices === undefined &&
      Array.isArray(schema['enum']) &&
      schema['enum'].every((entry: unknown) => typeof entry === 'string')
    )
      choices = schema['enum'].map((entry: string) => ({ value: entry, label: entry }))
    fields.push({
      path,
      label: typeof schema['title'] === 'string' ? schema['title'] : (LABEL[name] ?? name),
      type,
      required,
      schema,
      ...(optionalParent === undefined ? {} : { optionalParent }),
      ...(choices === undefined ? {} : { choices }),
    })
  }
  const schema = task.parameterSchema
  if (schema['type'] !== 'object' || !record(schema['properties']))
    return { fields, error: '任务未提供可用的对象参数 Schema。' }
  if (task.taskKind === 'rule_judgement') {
    const readableBranch =
      Array.isArray(schema['oneOf']) &&
      schema['oneOf'].some(
        (branch: unknown) =>
          record(branch) &&
          Array.isArray(branch['required']) &&
          branch['required'].includes('rule') &&
          branch['required'].includes('entity'),
      )
    if (!readableBranch || !record(schema['properties']['rule']) || !record(schema['properties']['entity']))
      return { fields, error: '规则任务未开放可读名称参数，暂不能在此执行。' }
  } else if (schema['oneOf'] !== undefined || schema['anyOf'] !== undefined)
    return { fields, error: '任务参数有尚不能展示的分支约束。' }
  walk(schema, [], true, 0)
  if (task.taskKind === 'rule_judgement')
    for (const field of fields)
      if (field.path[0] === 'rule' || field.path[0] === 'entity')
        fields[fields.indexOf(field)] = { ...field, required: true }
  return { fields, ...(failure === undefined ? {} : { error: failure }) }
}

function parametersFor(
  fields: readonly ParameterField[],
  values: Readonly<Record<string, Raw>>,
): { parameters: Readonly<Record<string, unknown>>; error?: string } {
  const leaves: { path: readonly string[]; value: unknown }[] = []
  for (const field of fields) {
    const raw = values[keyOf(field.path)]
    if (empty(raw)) {
      const groupActive =
        field.optionalParent === undefined ||
        fields.some(
          (entry) =>
            field.optionalParent?.every((part, index) => entry.path[index] === part) === true &&
            !empty(values[keyOf(entry.path)]),
        )
      if (field.required && groupActive) return { parameters: {}, error: `请填写${field.label}。` }
      continue
    }
    let value: unknown = raw
    if (field.choices !== undefined) {
      const selected = Array.isArray(raw) ? raw : [raw]
      if (selected.some((item) => !field.choices?.some((choice) => choice.value === item)))
        return { parameters: {}, error: `${field.label}的选项已变化，请重新选择。` }
    }
    if (field.type === 'array') {
      if (!Array.isArray(raw)) return { parameters: {}, error: `${field.label}需要选择一个或多个值。` }
      const maximum = typeof field.schema['maxItems'] === 'number' ? field.schema['maxItems'] : 32
      const minimum =
        typeof field.schema['minItems'] === 'number' ? field.schema['minItems'] : field.required ? 1 : 0
      if (raw.length > maximum || raw.length < minimum)
        return { parameters: {}, error: `${field.label}需选择 ${minimum}–${maximum} 项。` }
      value = [...raw]
    } else if (typeof raw !== 'string') return { parameters: {}, error: `${field.label}格式无法识别。` }
    else if (field.type === 'boolean') {
      if (raw !== 'true' && raw !== 'false') return { parameters: {}, error: `${field.label}请选择是或否。` }
      value = raw === 'true'
    } else if (field.type === 'integer' || field.type === 'number') {
      const number = Number(raw)
      if (
        !Number.isFinite(number) ||
        (field.type === 'integer' && !Number.isSafeInteger(number)) ||
        (typeof field.schema['minimum'] === 'number' && number < field.schema['minimum']) ||
        (typeof field.schema['maximum'] === 'number' && number > field.schema['maximum'])
      )
        return { parameters: {}, error: `${field.label}超出允许的数值范围。` }
      value = number
      if (
        !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw) ||
        decimalText(raw) !== decimalText(String(number))
      )
        return { parameters: {}, error: `${field.label}不能无损表示为该参数要求的 JSON 数值。` }
    }
    // Schema string values (including exact decimals) remain the original strings.
    leaves.push({ path: field.path, value })
  }
  const assemble = (prefix: readonly string[]): Readonly<Record<string, unknown>> =>
    Object.fromEntries(
      [
        ...new Set(
          leaves
            .filter(
              (leaf) =>
                leaf.path.length > prefix.length && prefix.every((part, index) => leaf.path[index] === part),
            )
            .map((leaf) => leaf.path[prefix.length]),
        ),
      ]
        .filter((name): name is string => name !== undefined)
        .map((name) => {
          const path = [...prefix, name]
          const leaf = leaves.find(
            (entry) =>
              entry.path.length === path.length && entry.path.every((part, index) => part === path[index]),
          )
          return [name, leaf === undefined ? assemble(path) : leaf.value]
        }),
    )
  return { parameters: assemble([]) }
}

export function TaskRunForm({
  task,
  objects,
  disabled,
  onRun,
}: {
  readonly task: ProjectTaskItem
  readonly objects: readonly ProjectCanonicalObject[]
  readonly disabled: boolean
  readonly onRun: (parameters: Readonly<Record<string, unknown>>) => Promise<void>
}) {
  const [values, setValues] = useState<Readonly<Record<string, Raw>>>({})
  const [confirmedValues, setConfirmedValues] = useState<Readonly<Record<string, Raw>>>({})
  const [confirmedSignature, setConfirmedSignature] = useState('{}')
  const [previewSignature, setPreviewSignature] = useState<string>()
  const projection = useMemo(() => fieldsFor(task, objects, values), [task, objects, values])
  const parsed = useMemo(() => parametersFor(projection.fields, values), [projection.fields, values])
  const signature = JSON.stringify(parsed.parameters)
  const valid = projection.error === undefined && parsed.error === undefined
  const changed = signature !== confirmedSignature
  const display = (field: ParameterField, raw: Raw | undefined) =>
    empty(raw)
      ? '未提供'
      : Array.isArray(raw)
        ? raw
            .map((value) => field.choices?.find((choice) => choice.value === value)?.label ?? value)
            .join('、')
        : (field.choices?.find((choice) => choice.value === raw)?.label ??
          (field.type === 'boolean' ? (raw === 'true' ? '是' : '否') : raw))
  const change = (field: ParameterField, value: Raw) => {
    setPreviewSignature(undefined)
    setValues((previous) => ({ ...previous, [keyOf(field.path)]: value }))
  }
  return (
    <form
      data-testid="task-schema-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (valid && !changed && task.available && !disabled) void onRun(parsed.parameters)
      }}
    >
      <h3>{task.displayName}</h3>
      <p className="project-source-note">只填写业务参数。项目修订、数据快照与规则版本由服务端固定。</p>
      {task.unavailableReasons.length === 0 ? null : (
        <div className="project-notice" role="alert">
          {task.unavailableReasons.map((reason, index) => (
            <p key={index}>{reason}</p>
          ))}
        </div>
      )}
      {projection.fields.map((field) => (
        <Field
          key={keyOf(field.path)}
          label={`${field.label}${field.required ? ' *' : ''}`}
          {...(typeof field.schema['description'] === 'string' ? { hint: field.schema['description'] } : {})}
        >
          {(attributes) => {
            const raw = values[keyOf(field.path)]
            if (field.choices !== undefined)
              return (
                <select
                  {...attributes}
                  multiple={field.type === 'array'}
                  data-testid={`task-parameter-${field.path.join('.')}`}
                  value={raw ?? (field.type === 'array' ? [] : '')}
                  disabled={disabled || !task.available}
                  onChange={(event) =>
                    change(
                      field,
                      field.type === 'array'
                        ? Array.from(event.target.selectedOptions, (option) => option.value)
                        : event.target.value,
                    )
                  }
                >
                  {field.type === 'array' ? null : <option value="">请选择…</option>}
                  {field.choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              )
            if (field.type === 'boolean')
              return (
                <select
                  {...attributes}
                  data-testid={`task-parameter-${field.path.join('.')}`}
                  value={raw ?? ''}
                  disabled={disabled || !task.available}
                  onChange={(event) => change(field, event.target.value)}
                >
                  <option value="">未指定</option>
                  <option value="true">是</option>
                  <option value="false">否</option>
                </select>
              )
            if (field.type === 'array')
              return (
                <textarea
                  {...attributes}
                  data-testid={`task-parameter-${field.path.join('.')}`}
                  value={Array.isArray(raw) ? raw.join('\n') : ''}
                  disabled={disabled || !task.available}
                  placeholder="每行一个值"
                  onChange={(event) =>
                    change(field, event.target.value === '' ? [] : event.target.value.split('\n'))
                  }
                />
              )
            return (
              <input
                {...attributes}
                data-testid={`task-parameter-${field.path.join('.')}`}
                type="text"
                inputMode={
                  field.type === 'integer' ? 'numeric' : field.type === 'number' ? 'decimal' : undefined
                }
                value={typeof raw === 'string' ? raw : ''}
                disabled={disabled || !task.available}
                onChange={(event) => change(field, event.target.value)}
              />
            )
          }}
        </Field>
      ))}
      {projection.fields.length > 0 ? null : <p>此任务无需额外参数。</p>}
      {(projection.error ?? parsed.error) ? (
        <p className="project-source-note" role="status">
          {projection.error ?? parsed.error}
        </p>
      ) : null}
      {previewSignature !== signature ? null : (
        <div className="project-notice" data-testid="task-parameter-diff">
          <h4>确认参数变更</h4>
          {projection.fields
            .filter(
              (field) =>
                JSON.stringify(values[keyOf(field.path)]) !==
                JSON.stringify(confirmedValues[keyOf(field.path)]),
            )
            .map((field) => (
              <p key={keyOf(field.path)}>
                {field.label}：{display(field, confirmedValues[keyOf(field.path)])} →{' '}
                {display(field, values[keyOf(field.path)])}
              </p>
            ))}
          <Button
            data-testid="task-parameter-confirm"
            disabled={disabled || !valid}
            onClick={() => {
              if (previewSignature === signature) {
                setConfirmedValues({ ...values })
                setConfirmedSignature(signature)
                setPreviewSignature(undefined)
              }
            }}
          >
            确认这些参数
          </Button>
          <Button variant="quiet" onClick={() => setPreviewSignature(undefined)}>
            返回修改
          </Button>
        </div>
      )}
      <div className="project-actions">
        {changed ? (
          <Button
            data-testid="task-parameter-preview"
            disabled={disabled || !valid || !task.available}
            onClick={() => setPreviewSignature(signature)}
          >
            预览参数变更
          </Button>
        ) : null}
        <Button
          data-testid="task-run"
          type="submit"
          variant="primary"
          disabled={disabled || !valid || changed || !task.available}
        >
          运行当前任务
        </Button>
      </div>
      <details className="project-audit">
        <summary>任务版本与参数契约</summary>
        <p>
          <code>
            {task.bindingRef.id}@{task.bindingRef.version}
          </code>
        </p>
        <p>
          <code>{task.bindingRef.digest}</code>
        </p>
        <pre>{JSON.stringify(task.parameterSchema, null, 2)}</pre>
      </details>
    </form>
  )
}
