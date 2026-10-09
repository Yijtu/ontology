import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ColumnMappingEntry,
  DefinitionRevisionStrategyKind,
  ImportMappingVersion,
  ProjectEvolutionRecord,
  ProjectEvolutionRemap,
  ProjectRecord,
  ProjectRevision,
} from '@ontology/contracts'
import type { WorkbenchClient } from '../../api/client'
import type { IndustryPackSummary } from '../../api/projects'
import type { ProjectSourceCatalogue } from '../../api/project-workbench'
import {
  operateProjectEvolution,
  readEvolutionTarget,
  readProjectEvolution,
  startProjectEvolution,
} from '../../api/project-evolution'
import type { EvolutionTargetView } from '../../api/project-evolution'
import { Button, Field } from '../ui'
import { JobProgressPanel } from '../JobProgressPanel'
import { ProjectNotice } from './ProjectNotice'
import { useRequestFence } from './useRequestFence'

const STATE = {
  queued: '等待重抽取',
  running: '正在重抽取',
  awaiting_review: '等待人工审核',
  needs_human: '需要人工处理',
  ready: '新版本已激活',
  failed: '处理失败',
  cancelled: '已取消',
}
const HANDLING = {
  reextract_review: '从原文件重抽取并重新审核',
  human_relation: '人工核对真实关系',
  retire: '停止沿用旧声明',
}
const STRATEGY = {
  new_version: '演进为新版本',
  keep_independent: '保留为独立定义',
  retire_previous: '明确停用原定义',
}
const same = (
  left: { readonly id: string; readonly version: string; readonly digest: string },
  right: { readonly id: string; readonly version: string; readonly digest: string },
) => left.id === right.id && left.version === right.version && left.digest === right.digest
interface FieldEdit {
  readonly column: string
  readonly sourceUnit: string
  readonly numerator: string
  readonly denominator: string
}

export function ProjectEvolutionPanel({
  client,
  project,
  revision,
  packs,
  mappings,
  catalogue,
  readOnly,
  initialEvolutionId,
  onEvolution,
  onChanged,
  onReview,
}: {
  readonly client: WorkbenchClient
  readonly project: ProjectRecord
  readonly revision?: ProjectRevision
  readonly packs: readonly IndustryPackSummary[]
  readonly mappings: readonly ImportMappingVersion[]
  readonly catalogue?: ProjectSourceCatalogue
  readonly readOnly: boolean
  readonly initialEvolutionId?: string
  readonly onEvolution?: (evolutionId: string) => void
  readonly onChanged: () => void
  readonly onReview: (recordId?: string) => void
}) {
  const [choice, setChoice] = useState('')
  const [strategy, setStrategy] = useState<DefinitionRevisionStrategyKind>('new_version')
  const [reason, setReason] = useState('')
  const [target, setTarget] = useState<EvolutionTargetView>()
  const [objects, setObjects] = useState<Readonly<Record<string, string>>>({})
  const [edits, setEdits] = useState<Readonly<Record<string, FieldEdit>>>({})
  const [confirmed, setConfirmed] = useState(false)
  const [loadedRecord, setRecord] = useState<ProjectEvolutionRecord>()
  const [recordOwner, setRecordOwner] = useState<unknown>()
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [maxRecords, setMaxRecords] = useState('2000')
  const [maxAttempts, setMaxAttempts] = useState('1')
  const [jobId, setJobId] = useState<string>()
  const [reviewOffset, setReviewOffset] = useState(0)
  const callback = useRef(onEvolution)
  callback.current = onEvolution
  const notified = useRef<string | undefined>(undefined)
  const requestKeys = useRef(new Map<string, string>())
  const scope = useMemo(() => ({ client, projectId: project.projectId }), [client, project.projectId])
  const record = recordOwner === scope ? loadedRecord : undefined
  const begin = useRequestFence(scope)
  const targetScope = useMemo(() => ({ scope, choice }), [scope, choice])
  const beginTarget = useRequestFence(targetScope)
  const selectedPack = packs.find(
    (pack) =>
      pack.packRef !== undefined &&
      `${pack.packRef.id}:${pack.packRef.version}:${pack.packRef.digest}` === choice,
  )?.packRef
  const mounted =
    revision === undefined
      ? []
      : mappings.filter((mapping) => revision.mappingRefs.some((ref) => same(ref, mapping.ref)))
  const availableSources = mounted.map((mapping) => ({
    mapping,
    sources:
      catalogue?.sources.filter(
        (source) => source.parseId === mapping.parseId && same(source.originalRef, mapping.originalRef),
      ) ?? [],
  }))
  const remappings: ProjectEvolutionRemap[] = []
  let remapError: string | undefined
  if (mounted.length > 10) remapError = '当前项目超过演进接口的 10 份原始映射上限，不能启动。'
  if (mounted.length === 0) remapError = '当前没有已确认的原始映射。请先完成原始资料映射与记录审核发布。'
  for (const { mapping, sources } of availableSources) {
    const source = sources.length === 1 ? sources[0] : undefined
    const objectId =
      objects[mapping.mappingId] ??
      (target?.objects.some((object) => object.objectId === mapping.objectId) ? mapping.objectId : '')
    const object = target?.objects.find((entry) => entry.objectId === objectId)
    const tables =
      source?.tables?.filter(
        (table) =>
          (mapping.sheetId === undefined || table.sheetId === mapping.sheetId) &&
          (mapping.sheetName === undefined || table.sheetName === mapping.sheetName),
      ) ?? []
    if (source === undefined || tables.length !== 1 || tables[0] === undefined || object === undefined) {
      remapError = '每个当前映射都需要唯一的原文件、实际工作表与目标记录类型。'
      continue
    }
    const columns = tables[0].columns
    const entries: ColumnMappingEntry[] = []
    for (const field of object.attributes) {
      const prior =
        objectId === mapping.objectId
          ? mapping.entries.find((entry) => entry.fieldRef === field.attributeId)
          : undefined
      const edit = edits[`${mapping.mappingId}:${field.attributeId}`]
      const columnIndex = edit?.column ?? (prior === undefined ? '' : String(prior.columnIndex))
      const column = columns.find((entry) => String(entry.columnIndex) === columnIndex)
      if (column === undefined) {
        if (field.required)
          remapError = `请为 ${object.displayName} 的必填字段 ${field.displayName} 选择实际来源列。`
        continue
      }
      const sourceUnit = edit?.sourceUnit ?? prior?.sourceUnitCode
      const numerator =
        edit?.numerator ??
        (prior?.unitConversion !== undefined && prior.unitConversion.toUnitCode === field.unit
          ? prior.unitConversion.numerator
          : undefined)
      const denominator =
        edit?.denominator ??
        (prior?.unitConversion !== undefined && prior.unitConversion.toUnitCode === field.unit
          ? prior.unitConversion.denominator
          : undefined)
      entries.push({
        fieldRef: field.attributeId,
        columnIndex: column.columnIndex,
        header: column.header,
        headerDigest: column.headerDigest,
        ...(prior?.pointer === undefined ? {} : { pointer: prior.pointer }),
        ...(prior?.valueMapping === undefined ? {} : { valueMapping: prior.valueMapping }),
        ...(field.unit === undefined ? {} : { canonicalUnitCode: field.unit }),
        ...(sourceUnit === undefined || sourceUnit === '' ? {} : { sourceUnitCode: sourceUnit }),
        ...(field.unit === undefined || sourceUnit === undefined || !numerator || !denominator
          ? {}
          : { unitConversion: { fromUnitCode: sourceUnit, toUnitCode: field.unit, numerator, denominator } }),
      })
    }
    remappings.push({ mappingRef: mapping.ref, documentId: source.documentId, objectId, entries })
  }
  const retain = (input: string) => {
    const prior = requestKeys.current.get(input)
    if (prior !== undefined) return prior
    const key = client.newRequestKey()
    requestKeys.current.set(input, key)
    return key
  }
  const accept = useCallback(
    (actual: ProjectEvolutionRecord) => {
      setRecord(actual)
      setRecordOwner(scope)
      if (notified.current !== actual.plan.evolutionId) {
        notified.current = actual.plan.evolutionId
        callback.current?.(actual.plan.evolutionId)
      }
    },
    [scope],
  )
  const refresh = useCallback(
    async (id: string) => {
      const request = begin('read')
      try {
        const actual = await readProjectEvolution(client, project.projectId, id, request.signal)
        if (request.current()) {
          accept(actual)
          setError(undefined)
        }
      } catch (caught) {
        if (request.current()) setError(caught)
      }
    },
    [client, project.projectId, begin, accept],
  )
  useEffect(() => {
    setChoice('')
    setTarget(undefined)
    setRecord(undefined)
    setError(undefined)
    setBusy(false)
    setObjects({})
    setEdits({})
    setConfirmed(false)
    setReviewOffset(0)
    notified.current = undefined
    requestKeys.current.clear()
  }, [scope])
  useEffect(() => {
    if (initialEvolutionId !== undefined) void refresh(initialEvolutionId)
  }, [initialEvolutionId, refresh])
  useEffect(() => {
    if (
      catalogue?.project.projectId === project.projectId &&
      catalogue.activeEvolution !== undefined &&
      (record === undefined ||
        (record.plan.evolutionId === catalogue.activeEvolution.plan.evolutionId &&
          BigInt(catalogue.activeEvolution.revision) >= BigInt(record.revision)))
    )
      accept(catalogue.activeEvolution)
  }, [catalogue, record, project.projectId, accept])
  useEffect(() => {
    setTarget(undefined)
    setError(undefined)
    setConfirmed(false)
    setObjects({})
    setEdits({})
    if (selectedPack === undefined) return
    const request = beginTarget('target')
    void readEvolutionTarget(client, selectedPack, request.signal)
      .then((actual) => {
        if (request.current()) setTarget(actual)
      })
      .catch((caught: unknown) => {
        if (request.current()) setError(caught)
      })
  }, [client, selectedPack, beginTarget])
  const start = async () => {
    if (
      readOnly ||
      busy ||
      !confirmed ||
      revision === undefined ||
      selectedPack === undefined ||
      target === undefined ||
      remapError !== undefined ||
      !reason.trim()
    )
      return
    const rowBudget = Number(maxRecords),
      attempts = Number(maxAttempts)
    if (
      !Number.isSafeInteger(rowBudget) ||
      rowBudget < 1 ||
      rowBudget > 20_000 ||
      !Number.isSafeInteger(attempts) ||
      attempts < 1 ||
      attempts > 3
    ) {
      setError(new Error('处理上限需为 1–20000 行，尝试上限需为 1–3 次。'))
      return
    }
    const body = {
      industryPackRef: selectedPack,
      strategy: {
        kind: strategy,
        reason: reason.trim(),
        ...(strategy === 'retire_previous' ? { supersedesRef: revision.definitionRef } : {}),
      },
      remappings,
      maxRecords: rowBudget,
      maxAttempts: attempts,
    }
    const request = begin('write')
    setBusy(true)
    setError(undefined)
    try {
      const actual = await startProjectEvolution(
        client,
        project.projectId,
        project.headRevision,
        body,
        retain(JSON.stringify({ revision: project.headRevision, body })),
        request.signal,
      )
      if (request.current()) {
        accept(actual)
        onChanged()
      }
    } catch (caught) {
      if (request.current()) setError(caught)
    } finally {
      if (request.current()) setBusy(false)
    }
  }
  const operate = async (operation: 'activate' | 'cancel' | 'retry') => {
    if (record === undefined || readOnly || busy) return
    const request = begin('write')
    setBusy(true)
    setError(undefined)
    try {
      const actual = await operateProjectEvolution(
        client,
        project.projectId,
        record.plan.evolutionId,
        operation,
        [],
        request.signal,
      )
      if (request.current()) {
        accept(actual)
        onChanged()
      }
    } catch (caught) {
      if (request.current()) setError(caught)
    } finally {
      if (request.current()) setBusy(false)
    }
  }
  const review = async () => {
    if (record === undefined || readOnly || busy) return
    const request = begin('review')
    setBusy(true)
    setError(undefined)
    try {
      const existing = await client.listInstanceRecords(project.projectId)
      if (!request.current()) return
      let firstRecordId: string | undefined
      for (const id of record.candidateIds.slice(reviewOffset, reviewOffset + 200)) {
        const candidate = await client.getCandidate(id)
        if (!request.current()) return
        const pin = candidate.inputVersion.projectFact?.sources[0]
        if (
          candidate.kind !== 'entity' ||
          pin === undefined ||
          pin.projectRevisionRef.projectId !== project.projectId ||
          pin.projectRevisionRef.digest !== record.plan.targetRevisionRef.digest ||
          !record.plan.sources.some((source) => source.documentId === pin.documentId)
        )
          throw new Error('重抽取候选缺少当前演进计划的实际来源绑定。')
        const prior = existing.filter(
          (entry) =>
            entry.identity.binding?.candidateId === candidate.candidateId &&
            entry.identity.binding.documentId === pin.documentId,
        )
        if (prior.length > 1) throw new Error('候选对应多个审核记录，无法唯一确定。')
        const actual =
          prior[0] ??
          (await client.createInstanceRecord(
            project.projectId,
            { candidateId: candidate.candidateId, documentId: pin.documentId },
            retain(`review:${candidate.candidateId}:${pin.documentId}`),
          ))
        if (!request.current()) return
        firstRecordId ??= actual.recordId
      }
      onReview(firstRecordId)
    } catch (caught) {
      if (request.current()) setError(caught)
    } finally {
      if (request.current()) setBusy(false)
    }
  }
  const changeField = (mapping: ImportMappingVersion, fieldId: string, patch: Partial<FieldEdit>) => {
    setConfirmed(false)
    const prior = mapping.entries.find((entry) => entry.fieldRef === fieldId)
    const key = `${mapping.mappingId}:${fieldId}`
    setEdits((previous) => ({
      ...previous,
      [key]: {
        column: prior === undefined ? '' : String(prior.columnIndex),
        sourceUnit: prior?.sourceUnitCode ?? '',
        numerator: prior?.unitConversion?.numerator ?? '',
        denominator: prior?.unitConversion?.denominator ?? '',
        ...previous[key],
        ...patch,
      },
    }))
  }
  const live = record !== undefined && !['ready', 'cancelled', 'failed'].includes(record.state)
  const diff = target?.versionDiff
  const exactDiff =
    diff !== undefined &&
    revision !== undefined &&
    diff.fromPackRef !== undefined &&
    same(diff.fromPackRef, revision.industryPackRef) &&
    selectedPack !== undefined &&
    same(diff.toPackRef, selectedPack)
  return (
    <section className="project-section" data-testid="project-evolution">
      <h4>版本演进与原始资料重抽取</h4>
      <p className="project-source-note">
        新版本先进入待审核流程。人工确认完整原始资料与关系后，才切换活动版本；旧答案继续按原版本回读。
      </p>
      {record === undefined ? null : (
        <div className="project-evolution-plan">
          <h4>{STATE[record.state]}</h4>
          <p>
            修订 {record.plan.previousRevisionRef.revision} → {record.plan.targetRevisionRef.revision} ·{' '}
            {STRATEGY[record.plan.strategy.kind]}
          </p>
          <p>
            原始资料 {record.plan.sources.length} 份 · 待核对记录{' '}
            {record.plan.sources.reduce((sum, source) => sum + source.expectedRecords, 0)} 条 · 已尝试{' '}
            {record.attempts}/{record.plan.maxAttempts} 次
          </p>
          <ul>
            {record.plan.impacts.map((impact, index) => (
              <li key={index}>
                {impact.logicalId} · {HANDLING[impact.handling]}
              </li>
            ))}
          </ul>
          {record.error === undefined ? null : (
            <details className="project-audit">
              <summary>处理失败详情</summary>
              <p>{record.error}</p>
            </details>
          )}
          <div className="project-actions">
            <Button onClick={() => void refresh(record.plan.evolutionId)} disabled={busy}>
              刷新计划
            </Button>
            {readOnly ? null : (
              <>
                <Button onClick={() => void review()} disabled={busy || record.candidateIds.length === 0}>
                  核对本批 {Math.min(200, record.candidateIds.length - reviewOffset)} 条重抽取记录
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void operate('activate')}
                  disabled={
                    busy ||
                    record.state !== 'awaiting_review' ||
                    record.plan.impacts.some((impact) => impact.handling === 'human_relation')
                  }
                >
                  激活已完成审核的版本
                </Button>
                <Button
                  onClick={() => void operate('retry')}
                  disabled={busy || record.state !== 'failed' || record.attempts >= record.plan.maxAttempts}
                >
                  在原边界内重试
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void operate('cancel')}
                  disabled={busy || record.state === 'ready' || record.state === 'cancelled'}
                >
                  取消本次演进
                </Button>
              </>
            )}
          </div>
          {record.plan.impacts.some((impact) => impact.handling === 'human_relation') ? (
            <p className="project-notice">
              关系声明发生变化，需要实际审核并发布的目标关系候选。当前界面没有可核对的已发布关系选择，激活保持阻断。
            </p>
          ) : null}
          <div className="project-actions">
            <span>
              当前候选批次：{Math.floor(reviewOffset / 200) + 1}/
              {Math.max(1, Math.ceil(record.candidateIds.length / 200))}
            </span>
            <Button
              disabled={reviewOffset === 0 || busy}
              onClick={() => setReviewOffset((offset) => Math.max(0, offset - 200))}
            >
              上一批
            </Button>
            <Button
              disabled={reviewOffset + 200 >= record.candidateIds.length || busy}
              onClick={() => setReviewOffset((offset) => offset + 200)}
            >
              下一批
            </Button>
          </div>
          <details className="project-audit">
            <summary>实际任务、原始版本与处理边界</summary>
            <p>
              <code>{record.plan.evolutionId}</code>
            </p>
            <p>
              已处理 {record.recordOperations}/{record.plan.maxRecordOperations} 次记录操作 · {record.batches}
              /{record.plan.maxBatches} 批
            </p>
            <Button onClick={() => setJobId(record.plan.jobId)}>查看演进任务</Button>
            {record.plan.sources.map((source) => (
              <p key={source.sourceJobId}>
                {source.objectId} · 原始 {source.rawRecordCount} 行{' '}
                <Button variant="quiet" onClick={() => setJobId(source.sourceJobId)}>
                  查看来源任务
                </Button>
              </p>
            ))}
            {jobId === undefined ? null : (
              <JobProgressPanel key={jobId} client={client} initialJobId={jobId} />
            )}
          </details>
        </div>
      )}
      {readOnly || live ? null : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void start()
          }}
        >
          <div className="project-form-grid">
            <Field label="目标已发布版本">
              {(attributes) => (
                <select
                  {...attributes}
                  data-testid="evolution-pack"
                  value={choice}
                  disabled={busy}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  <option value="">选择目标版本…</option>
                  {packs
                    .filter((pack) => pack.usable && pack.packRef !== undefined)
                    .map((pack) => (
                      <option
                        key={`${pack.packRef?.id}:${pack.packRef?.version}:${pack.packRef?.digest}`}
                        value={`${pack.packRef?.id}:${pack.packRef?.version}:${pack.packRef?.digest}`}
                      >
                        {pack.displayName} · {pack.packRef?.version}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Field label="演进方式">
              {(attributes) => (
                <select
                  {...attributes}
                  value={strategy}
                  onChange={(event) => {
                    const value = event.target.value
                    if (
                      value === 'new_version' ||
                      value === 'keep_independent' ||
                      value === 'retire_previous'
                    ) {
                      setStrategy(value)
                      setConfirmed(false)
                    }
                  }}
                >
                  <option value="new_version">演进为新版本</option>
                  <option value="keep_independent">保留为独立定义</option>
                  <option value="retire_previous">明确停用原定义</option>
                </select>
              )}
            </Field>
            <Field label="演进原因">
              {(attributes) => (
                <input
                  {...attributes}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value)
                    setConfirmed(false)
                  }}
                />
              )}
            </Field>
          </div>
          {target === undefined ? null : (
            <>
              <h4>声明变化与重新审核要求</h4>
              {exactDiff ? (
                <ul>
                  {diff?.changes.map((change, index) => (
                    <li key={index}>
                      {change.message}
                      {change.breaking ? ' · 需要重新审核' : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  导出未提供与当前项目版本直接对应的差异。创建待审演进后，可查看服务端实际影响计划；此处没有项目行数影响的预演结果。
                </p>
              )}
              {availableSources.map(({ mapping, sources }) => {
                const source = sources.length === 1 ? sources[0] : undefined
                const objectId =
                  objects[mapping.mappingId] ??
                  (target.objects.some((object) => object.objectId === mapping.objectId)
                    ? mapping.objectId
                    : '')
                const object = target.objects.find((entry) => entry.objectId === objectId)
                const tables =
                  source?.tables?.filter(
                    (table) =>
                      (mapping.sheetId === undefined || table.sheetId === mapping.sheetId) &&
                      (mapping.sheetName === undefined || table.sheetName === mapping.sheetName),
                  ) ?? []
                const columns = tables.length === 1 ? (tables[0]?.columns ?? []) : []
                return (
                  <fieldset key={`${mapping.mappingId}:${mapping.version}`} className="project-remap">
                    <legend>
                      {source?.name ?? '已确认原始资料'} · {mapping.objectId}
                    </legend>
                    <Field label="新版本中的记录类型">
                      {(attributes) => (
                        <select
                          {...attributes}
                          value={objectId}
                          onChange={(event) => {
                            setObjects((previous) => ({
                              ...previous,
                              [mapping.mappingId]: event.target.value,
                            }))
                            setConfirmed(false)
                          }}
                        >
                          <option value="">选择记录类型…</option>
                          {target.objects.map((entry) => (
                            <option key={entry.objectId} value={entry.objectId}>
                              {entry.displayName}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                    {object?.attributes.map((field) => {
                      const prior =
                        objectId === mapping.objectId
                          ? mapping.entries.find((entry) => entry.fieldRef === field.attributeId)
                          : undefined
                      const edit = edits[`${mapping.mappingId}:${field.attributeId}`]
                      return (
                        <div key={field.attributeId} className="project-form-grid">
                          <Field label={`${field.displayName}${field.required ? ' *' : ''}`}>
                            {(attributes) => (
                              <select
                                {...attributes}
                                value={edit?.column ?? (prior === undefined ? '' : String(prior.columnIndex))}
                                onChange={(event) =>
                                  changeField(mapping, field.attributeId, { column: event.target.value })
                                }
                              >
                                <option value="">不映射</option>
                                {columns.map((column) => (
                                  <option key={column.columnIndex} value={String(column.columnIndex)}>
                                    {column.header}
                                  </option>
                                ))}
                              </select>
                            )}
                          </Field>
                          {field.unit === undefined ? null : (
                            <>
                              <Field label={`来源单位（目标 ${field.unit}）`}>
                                {(attributes) => (
                                  <input
                                    {...attributes}
                                    value={edit?.sourceUnit ?? prior?.sourceUnitCode ?? ''}
                                    onChange={(event) =>
                                      changeField(mapping, field.attributeId, {
                                        sourceUnit: event.target.value,
                                      })
                                    }
                                  />
                                )}
                              </Field>
                              <Field label="精确换算分子（可选）">
                                {(attributes) => (
                                  <input
                                    {...attributes}
                                    inputMode="decimal"
                                    value={
                                      edit?.numerator ??
                                      (prior?.unitConversion !== undefined &&
                                      prior.unitConversion.toUnitCode === field.unit
                                        ? prior.unitConversion.numerator
                                        : '')
                                    }
                                    onChange={(event) =>
                                      changeField(mapping, field.attributeId, {
                                        numerator: event.target.value,
                                      })
                                    }
                                  />
                                )}
                              </Field>
                              <Field label="精确换算分母（可选）">
                                {(attributes) => (
                                  <input
                                    {...attributes}
                                    inputMode="decimal"
                                    value={
                                      edit?.denominator ??
                                      (prior?.unitConversion !== undefined &&
                                      prior.unitConversion.toUnitCode === field.unit
                                        ? prior.unitConversion.denominator
                                        : '')
                                    }
                                    onChange={(event) =>
                                      changeField(mapping, field.attributeId, {
                                        denominator: event.target.value,
                                      })
                                    }
                                  />
                                )}
                              </Field>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </fieldset>
                )
              })}
              <details className="project-audit">
                <summary>处理边界</summary>
                <Field label="完整原始资料处理行数上限">
                  {(attributes) => (
                    <input
                      {...attributes}
                      inputMode="numeric"
                      value={maxRecords}
                      onChange={(event) => {
                        setMaxRecords(event.target.value)
                        setConfirmed(false)
                      }}
                    />
                  )}
                </Field>
                <Field label="最大尝试次数">
                  {(attributes) => (
                    <select
                      {...attributes}
                      value={maxAttempts}
                      onChange={(event) => {
                        setMaxAttempts(event.target.value)
                        setConfirmed(false)
                      }}
                    >
                      <option value="1">1 次</option>
                      <option value="2">2 次</option>
                      <option value="3">3 次</option>
                    </select>
                  )}
                </Field>
              </details>
              <label className="project-confirmation">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                我已核对原始列对应和重新审核要求，以待审核方式创建演进。
              </label>
            </>
          )}
          {remapError === undefined ? null : <p className="project-source-note">{remapError}</p>}
          <div className="project-actions">
            <Button
              data-testid="evolution-start"
              type="submit"
              variant="primary"
              disabled={
                busy ||
                !confirmed ||
                !reason.trim() ||
                target === undefined ||
                remapError !== undefined ||
                revision === undefined
              }
            >
              创建待审核演进
            </Button>
          </div>
        </form>
      )}
      {error === undefined ? null : (
        <ProjectNotice
          error={error}
          onRecover={() => {
            if (record !== undefined) void refresh(record.plan.evolutionId)
            else onChanged()
          }}
        />
      )}
    </section>
  )
}
