import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InstanceFieldValue, InstanceRecordView } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import type { InstanceConfirmationOutcomeView } from '../api/instances'
import { ApiError } from '../api/errors'
import { StatePanel } from './StatePanel'
import { PublicStateNotice } from './PublicStateNotice'
import { classifyPublicError } from '../state/public-errors'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'
import { Button, Drawer, Field } from './ui'
import { useRequestFence } from './project/useRequestFence'
import {
  InstanceValueEditor,
  instanceValueDraft,
  normalizedInstanceValue,
} from './project/InstanceValueEditor'
import type { InstanceValueDraft } from './project/InstanceValueEditor'
import { formatLocator } from './project/VerifiedCell'
import './project/project-workbench.css'
import { readProjectSources, readProjectTasks } from '../api/project-workbench'
import type { ProjectSourceCatalogue, ProjectTaskCatalogue } from '../api/project-workbench'
import { sameSourceLocator } from '../api/source-views'
import { ProjectNotice } from './project/ProjectNotice'

export interface InstanceReviewPanelProps {
  readonly client: WorkbenchClient
  readonly projectId: string
  readonly readOnly?: boolean
  readonly initialRecordId?: string
}

function toError(error: unknown): WorkbenchError {
  if (error instanceof ApiError)
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      missingCapabilities: error.missingCapabilities,
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.reasons.length === 0 ? {} : { reasons: error.reasons }),
    }
  return {
    code: 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : '请求无法完成。',
    retryable: true,
  }
}
const phaseFor = (error: unknown): WorkbenchPhase =>
  error instanceof ApiError && error.permissionDenied ? 'permission_denied' : 'failure'
const statusLabel = (status: InstanceFieldValue['status']) =>
  status === 'pending' ? '待确认' : status === 'confirmed' ? '已确认' : '冲突'
const publicationLabel = (state: string) =>
  ({ draft: '待审核', approved: '已批准，待发布', published: '已发布' })[state] ?? state
const identityLabel = (state: string) =>
  ({ unresolved: '待裁决', matched: '已匹配', created: '已新建', split: '已拆分', conflict: '身份冲突' })[
    state
  ] ?? state
function normalizedLabel(field: InstanceFieldValue): string {
  const value = field.normalizedValue
  if (value === undefined) return '未提供'
  if (value.kind === 'quantity') return `${value.value} ${value.unitCode}`
  if (value.kind === 'reference') return `实体 ${value.entityId}`
  return value.value === null
    ? '空值'
    : typeof value.value === 'boolean'
      ? value.value
        ? '是'
        : '否'
      : String(value.value)
}
function recordLabel(record: InstanceRecordView): string {
  const name = record.fields.find(
    (field) => field.normalizedValue?.kind === 'scalar' && typeof field.normalizedValue.value === 'string',
  )
  return name?.normalizedValue?.kind === 'scalar' ? String(name.normalizedValue.value) : record.objectTypeRef
}

export function InstanceReviewPanel({
  client,
  projectId,
  readOnly = false,
  initialRecordId,
}: InstanceReviewPanelProps) {
  const [records, setRecords] = useState<readonly InstanceRecordView[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(initialRecordId)
  const listScope = useMemo(() => ({ client, projectId }), [client, projectId])
  const detailScope = useMemo(() => ({ listScope, selectedId }), [listScope, selectedId])
  const [listOwner, setListOwner] = useState<unknown>()
  const [detailOwner, setDetailOwner] = useState<unknown>()
  const [loadedRecord, setRecord] = useState<InstanceRecordView>()
  const record =
    detailOwner === detailScope &&
    loadedRecord?.projectId === projectId &&
    loadedRecord.recordId === selectedId
      ? loadedRecord
      : undefined
  const visibleRecords =
    listOwner === listScope ? records.filter((entry) => entry.projectId === projectId) : []
  const [phase, setPhase] = useState<WorkbenchPhase>('loading')
  const [error, setError] = useState<WorkbenchError>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<WorkbenchError>()
  const [outcome, setOutcome] = useState<InstanceConfirmationOutcomeView>()
  const [editingField, setEditingField] = useState<string>()
  const [editDraft, setEditDraft] = useState<InstanceValueDraft>()
  const [editReason, setEditReason] = useState('')
  const [identityReason, setIdentityReason] = useState('')
  const [sourceField, setSourceField] = useState<InstanceFieldValue>()
  const [filter, setFilter] = useState('all')
  const listRequest = useRequestFence(listScope)
  const detailRequest = useRequestFence(detailScope)
  const [sourceCatalogue, setSourceCatalogue] = useState<ProjectSourceCatalogue>()
  const [taskCatalogue, setTaskCatalogue] = useState<ProjectTaskCatalogue>()
  const [metadataOwner, setMetadataOwner] = useState<unknown>()
  const [metadataError, setMetadataError] = useState<unknown>()
  const currentSources = metadataOwner === listScope ? sourceCatalogue : undefined
  const currentTasks =
    metadataOwner === listScope && taskCatalogue?.revision.ref.digest === currentSources?.revision.ref.digest
      ? taskCatalogue
      : undefined
  const schemaFor = (fieldId: string) =>
    currentSources?.objects
      .find((object) => object.objectId === record?.objectTypeRef)
      ?.attributes.find((field) => field.attributeId === fieldId)
  const editingSchema = editingField === undefined ? undefined : schemaFor(editingField)
  const referenceChoices =
    editingSchema?.referencesObjectId === undefined
      ? undefined
      : currentTasks?.tasks
          .flatMap((task) => task.objects ?? [])
          .find((object) => object.objectId === editingSchema.referencesObjectId)?.entities
  const draftValid =
    editDraft !== undefined &&
    (editDraft.kind === 'quantity'
      ? /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(editDraft.value) && editDraft.unitCode.length > 0
      : editDraft.kind === 'reference'
        ? referenceChoices?.some((entry) => entry.entityId === editDraft.value) === true
        : editDraft.scalarType === 'boolean'
          ? editDraft.value === 'true' || editDraft.value === 'false'
          : editingSchema?.enumValues === undefined || editingSchema.enumValues.includes(editDraft.value))
  const sourceCells =
    sourceField === undefined
      ? []
      : (currentSources?.sources
          .filter(
            (source) =>
              source.parseId === sourceField.source.parseId &&
              source.originalRef.id === sourceField.source.documentRef.id &&
              source.originalRef.version === sourceField.source.documentRef.version &&
              source.originalRef.digest === sourceField.source.documentRef.digest &&
              (record?.identity.binding === undefined ||
                record.identity.binding.documentId === source.documentId),
          )
          .flatMap((source) => source.tables ?? [])
          .flatMap((table) => table.rows)
          .flatMap((row) => row.cells)
          .filter((cell) => sameSourceLocator(cell.locator, sourceField.source.locator)) ?? [])

  const loadList = useCallback(async () => {
    const request = listRequest('list')
    setPhase('loading')
    setError(undefined)
    try {
      const list = await client.listInstanceRecords(projectId)
      if (!request.current()) return
      setRecords(list)
      setListOwner(listScope)
      setSelectedId((previous) =>
        previous !== undefined &&
        (previous === initialRecordId || list.some((entry) => entry.recordId === previous))
          ? previous
          : (initialRecordId ?? list[0]?.recordId),
      )
      setPhase(list.length === 0 ? 'empty' : 'ready')
    } catch (caught) {
      if (request.current()) {
        setError(toError(caught))
        setPhase(phaseFor(caught))
      }
    }
  }, [client, projectId, listRequest, listScope, initialRecordId])

  useEffect(() => {
    setRecords([])
    setSelectedId(initialRecordId)
    setFilter('all')
    void loadList()
  }, [loadList, initialRecordId])
  useEffect(() => {
    const request = listRequest('metadata')
    setSourceCatalogue(undefined)
    setTaskCatalogue(undefined)
    setMetadataError(undefined)
    void Promise.allSettled([
      readProjectSources(client, projectId, request.signal),
      readProjectTasks(client, projectId, request.signal),
    ]).then(([sources, tasks]) => {
      if (!request.current()) return
      setMetadataOwner(listScope)
      if (sources.status === 'fulfilled') setSourceCatalogue(sources.value)
      else setMetadataError(sources.reason)
      if (tasks.status === 'fulfilled') setTaskCatalogue(tasks.value)
      else if (sources.status === 'fulfilled') setMetadataError(tasks.reason)
    })
  }, [client, projectId, listRequest, listScope])
  const reloadSelected = useCallback(async () => {
    if (selectedId === undefined) return
    const request = detailRequest('detail')
    setFailure(undefined)
    setSourceField(undefined)
    try {
      const loaded = await client.getInstanceRecord(projectId, selectedId)
      if (!request.current()) return
      if (loaded.projectId !== projectId || loaded.recordId !== selectedId)
        throw new Error('审核记录与当前项目不一致。')
      setRecord(loaded)
      setDetailOwner(detailScope)
      setRecords((previous) =>
        previous.some((entry) => entry.recordId === loaded.recordId)
          ? previous.map((entry) => (entry.recordId === loaded.recordId ? loaded : entry))
          : [...previous, loaded],
      )
    } catch (caught) {
      if (request.current()) setFailure(toError(caught))
    }
  }, [client, projectId, selectedId, detailRequest, detailScope])
  useEffect(() => {
    setRecord(undefined)
    setEditingField(undefined)
    setEditDraft(undefined)
    setEditReason('')
    setIdentityReason('')
    setSourceField(undefined)
    setFailure(undefined)
    setOutcome(undefined)
    setBusy(false)
    void reloadSelected()
  }, [reloadSelected])

  const apply = async (action: () => Promise<InstanceRecordView>, after?: () => void) => {
    if (busy || record === undefined) return
    const request = detailRequest('mutation')
    setBusy(true)
    setFailure(undefined)
    setOutcome(undefined)
    try {
      const updated = await action()
      if (!request.current()) return
      if (updated.projectId !== projectId || updated.recordId !== selectedId)
        throw new Error('返回的审核记录范围不一致。')
      setRecord(updated)
      setDetailOwner(detailScope)
      setSourceField(undefined)
      setRecords((previous) =>
        previous.map((entry) => (entry.recordId === updated.recordId ? updated : entry)),
      )
      after?.()
    } catch (caught) {
      if (request.current()) setFailure(toError(caught))
    } finally {
      if (request.current()) setBusy(false)
    }
  }
  const confirmField = (fieldId: string, decision: 'confirm' | 'conflict' | 'reject') => {
    if (record === undefined) return
    let actualOutcome: InstanceConfirmationOutcomeView | undefined
    void apply(
      async () => {
        const result = await client.confirmInstanceFields(projectId, record.recordId, {
          expectedRevision: record.recordRevision,
          decisions: [{ fieldId, decision }],
        })
        actualOutcome = result
        return result.record
      },
      () => setOutcome(actualOutcome),
    )
  }
  const submitEdit = (field: InstanceFieldValue) => {
    if (record === undefined || editDraft === undefined || !draftValid || editReason.trim().length === 0)
      return
    void apply(
      () =>
        client.editInstanceField(projectId, record.recordId, {
          expectedRevision: record.recordRevision,
          fieldId: field.fieldId,
          normalizedValue: normalizedInstanceValue(editDraft),
          reason: editReason.trim(),
        }),
      () => {
        setEditingField(undefined)
        setEditDraft(undefined)
        setEditReason('')
      },
    )
  }
  const adjudicate = (kind: 'match' | 'cannot_link' | 'split' | 'create', targetEntityId?: string) => {
    if (record === undefined || identityReason.trim().length === 0) return
    void apply(() =>
      client.adjudicateInstanceIdentity(projectId, record.recordId, {
        expectedRevision: record.recordRevision,
        kind,
        ...(targetEntityId === undefined ? {} : { targetEntityId }),
        reason: identityReason.trim(),
      }),
    )
  }
  const queue = visibleRecords.filter(
    (entry) =>
      filter === 'all' ||
      (filter === 'pending' && entry.fields.some((field) => field.status === 'pending')) ||
      (filter === 'conflict' && entry.fields.some((field) => field.status === 'conflict')),
  )

  return (
    <section
      className="instance-review project-page"
      data-testid="instance-review"
      data-phase={phase}
      data-project-id={projectId}
    >
      <header className="project-page__head">
        <div>
          <h2>核对项目记录</h2>
          <p>逐项对照原始值与来源，确认字段和身份，再批准、发布当前修订。</p>
        </div>
        {readOnly ? <span className="project-state">只读</span> : null}
      </header>
      {metadataError === undefined ? null : <ProjectNotice error={metadataError} />}
      {phase === 'loading' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel
          phase={phase}
          {...(error === undefined ? {} : { error })}
          {...(phase === 'loading' ? { title: '正在加载实例记录…' } : {})}
          {...(phase === 'failure' ? { onRecover: () => void loadList() } : {})}
        />
      ) : null}
      {phase === 'empty' ? (
        <p data-testid="instance-review-empty">当前可信范围暂无实例记录。请先导入、映射并绑定原始资料。</p>
      ) : null}
      {phase === 'ready' ? (
        <div className="project-two-column">
          <aside className="project-queue" data-testid="instance-record-list">
            <div className="project-queue__toolbar">
              <strong>记录队列 · {visibleRecords.length}</strong>
              <Field label="筛选记录">
                {(attributes) => (
                  <select {...attributes} value={filter} onChange={(event) => setFilter(event.target.value)}>
                    <option value="all">全部记录</option>
                    <option value="pending">有待确认字段</option>
                    <option value="conflict">有冲突字段</option>
                  </select>
                )}
              </Field>
            </div>
            <ul className="project-queue__items">
              {queue.map((entry) => (
                <li key={entry.recordId}>
                  <button
                    className="project-queue__item"
                    type="button"
                    data-testid="instance-record-item"
                    data-record-id={entry.recordId}
                    data-selected={entry.recordId === selectedId}
                    aria-pressed={entry.recordId === selectedId}
                    onClick={() => setSelectedId(entry.recordId)}
                  >
                    <strong>{recordLabel(entry)}</strong>
                    <small>
                      {entry.objectTypeRef} · 修订 {entry.recordRevision}
                    </small>
                    <small>
                      {publicationLabel(entry.publicationState)} ·{' '}
                      {entry.fields.filter((field) => field.status === 'pending').length} 项待确认
                    </small>
                  </button>
                </li>
              ))}
            </ul>
            {queue.length === 0 ? <p className="project-canvas__body">没有符合筛选条件的记录。</p> : null}
          </aside>
          <div className="project-canvas">
            {record === undefined ? (
              <p className="project-canvas__body" role="status">
                {selectedId === undefined ? '请选择一条记录。' : '正在读取当前记录…'}
              </p>
            ) : (
              <div
                className="project-canvas__body instance-review__detail"
                data-testid="instance-detail"
                data-record-id={record.recordId}
              >
                <header className="project-section__head">
                  <div>
                    <h3>{recordLabel(record)}</h3>
                    <span
                      className={`project-state project-state--${record.publicationState}`}
                      data-testid="instance-detail-publication"
                    >
                      {publicationLabel(record.publicationState)}
                    </span>
                  </div>
                  <span data-testid="instance-detail-revision">修订 {record.recordRevision}</span>
                </header>
                <section className="project-section" data-testid="instance-fields">
                  <h4>关键字段</h4>
                  <div className="project-table" tabIndex={0} role="region" aria-label="记录字段与原始来源">
                    <table>
                      <thead>
                        <tr>
                          <th>字段</th>
                          <th>原始值</th>
                          <th>规范值</th>
                          <th>来源</th>
                          <th>状态</th>
                          {readOnly ? null : <th>核对</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {record.fields.map((field) => (
                          <tr
                            key={field.fieldId}
                            data-testid="instance-field-row"
                            data-field-id={field.fieldId}
                          >
                            <td data-testid="instance-field-id">{field.fieldId}</td>
                            <td data-testid="instance-field-raw">
                              {field.rawValue === null ? '空值' : String(field.rawValue)}
                            </td>
                            <td data-testid="instance-field-normalized">{normalizedLabel(field)}</td>
                            <td data-testid="instance-field-source">
                              <button
                                className="project-source-button"
                                type="button"
                                onClick={() => setSourceField(field)}
                              >
                                {formatLocator(field.source.locator)} ↗
                              </button>
                            </td>
                            <td data-testid="instance-field-status" data-status={field.status}>
                              <span className={`project-state project-state--${field.status}`}>
                                {statusLabel(field.status)}
                              </span>
                            </td>
                            {readOnly ? null : (
                              <td>
                                <div className="project-cell-actions">
                                  <Button
                                    data-testid="instance-field-confirm"
                                    disabled={busy}
                                    onClick={() => confirmField(field.fieldId, 'confirm')}
                                  >
                                    确认
                                  </Button>
                                  <Button
                                    variant="quiet"
                                    data-testid="instance-field-edit-start"
                                    disabled={busy}
                                    onClick={() => {
                                      setEditingField(field.fieldId)
                                      setEditDraft(instanceValueDraft(field, schemaFor(field.fieldId)))
                                      setEditReason('')
                                    }}
                                  >
                                    修改
                                  </Button>
                                  <details>
                                    <summary>其他处理</summary>
                                    <Button
                                      data-testid="instance-field-conflict"
                                      disabled={busy}
                                      onClick={() => confirmField(field.fieldId, 'conflict')}
                                    >
                                      标记冲突
                                    </Button>
                                    <Button
                                      data-testid="instance-field-reject"
                                      disabled={busy}
                                      onClick={() => confirmField(field.fieldId, 'reject')}
                                    >
                                      拒绝
                                    </Button>
                                  </details>
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {editingField === undefined || editDraft === undefined || readOnly ? null : (
                    <form
                      className="project-section"
                      data-testid="instance-field-edit-form"
                      data-field-id={editingField}
                      onSubmit={(event) => {
                        event.preventDefault()
                        const field = record.fields.find((entry) => entry.fieldId === editingField)
                        if (field !== undefined) submitEdit(field)
                      }}
                    >
                      <h4>修改 {editingField}</h4>
                      <InstanceValueEditor
                        draft={editDraft}
                        disabled={busy}
                        onChange={setEditDraft}
                        {...(editingSchema?.enumValues === undefined
                          ? {}
                          : { enumValues: editingSchema.enumValues })}
                        {...(referenceChoices === undefined ? {} : { references: referenceChoices })}
                        {...(editingSchema?.unit === undefined ? {} : { canonicalUnit: editingSchema.unit })}
                      />
                      <Field label="修改原因" hint="说明修正依据，保存后仍需确认。">
                        {(attributes) => (
                          <input
                            {...attributes}
                            data-testid="instance-field-edit-reason"
                            value={editReason}
                            disabled={busy}
                            onChange={(event) => setEditReason(event.target.value)}
                          />
                        )}
                      </Field>
                      <div className="project-actions">
                        <Button
                          type="submit"
                          variant="primary"
                          data-testid="instance-field-edit-submit"
                          disabled={busy || !draftValid || editReason.trim().length === 0}
                        >
                          保存修改
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => {
                            setEditingField(undefined)
                            setEditDraft(undefined)
                          }}
                        >
                          取消修改
                        </Button>
                      </div>
                    </form>
                  )}
                </section>
                <section className="project-section" data-testid="instance-identity">
                  <h4>确认记录身份</h4>
                  <p data-testid="instance-identity-state">{identityLabel(record.identity.state)}</p>
                  <p data-testid="instance-identity-confidence">匹配状态：{record.identity.confidence}</p>
                  {record.identity.sameNameDifferentMeaning ? (
                    <p className="project-notice" data-testid="instance-identity-same-name" data-flag="true">
                      同名异物：是。以下同名记录可能代表不同实体，请核对类型与上下文。
                    </p>
                  ) : (
                    <p data-testid="instance-identity-same-name" data-flag="false">
                      同名异物：否
                    </p>
                  )}
                  {!readOnly ? (
                    <Field label="身份裁决依据" hint="选择已有实体、新建或拆分前，请填写理由。">
                      {(attributes) => (
                        <input
                          {...attributes}
                          data-testid="instance-identity-reason"
                          value={identityReason}
                          disabled={busy}
                          onChange={(event) => setIdentityReason(event.target.value)}
                        />
                      )}
                    </Field>
                  ) : null}
                  <ul className="project-identity-list" data-testid="instance-identity-candidates">
                    {record.identity.candidates.map((candidate) => (
                      <li
                        key={candidate.entityId}
                        data-testid="instance-identity-candidate"
                        data-entity-id={candidate.entityId}
                      >
                        <div>
                          <strong data-testid="instance-identity-candidate-name">
                            {candidate.displayName}
                          </strong>
                          <small data-testid="instance-identity-candidate-object">
                            {candidate.objectId} ·{' '}
                            {candidate.strategy === 'native_id'
                              ? '原始标识一致'
                              : candidate.strategy === 'alias'
                                ? '别名匹配'
                                : candidate.strategy === 'context'
                                  ? '上下文匹配'
                                  : '相似候选'}
                          </small>
                        </div>
                        {readOnly ? null : (
                          <div className="project-actions">
                            <Button
                              data-testid="instance-identity-match"
                              disabled={busy || !identityReason.trim()}
                              onClick={() => adjudicate('match', candidate.entityId)}
                            >
                              确认为同一实体
                            </Button>
                            <Button
                              variant="quiet"
                              data-testid="instance-identity-cannot-link"
                              disabled={busy || !identityReason.trim()}
                              onClick={() => adjudicate('cannot_link', candidate.entityId)}
                            >
                              不是同一实体
                            </Button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  {record.identity.candidates.length === 0 ? <p>服务端未返回可匹配的已有实体。</p> : null}
                  {readOnly ? null : (
                    <div className="project-actions">
                      <Button
                        data-testid="instance-identity-create"
                        disabled={busy || !identityReason.trim()}
                        onClick={() => adjudicate('create')}
                      >
                        新建实体
                      </Button>
                      <Button
                        data-testid="instance-identity-split"
                        disabled={
                          busy || !identityReason.trim() || record.identity.matchedEntityId === undefined
                        }
                        onClick={() => adjudicate('split', record.identity.matchedEntityId)}
                      >
                        从当前实体拆分
                      </Button>
                    </div>
                  )}
                </section>
                <section className="project-section" data-testid="instance-relations">
                  <h4>关联记录</h4>
                  {record.relations.length === 0 ? (
                    <p data-testid="instance-relations-empty">暂无关系端点。</p>
                  ) : (
                    <ul>
                      {record.relations.map((relation) => (
                        <li
                          key={relation.relationId}
                          data-testid="instance-relation-row"
                          data-endpoint-state={relation.endpointState}
                        >
                          {relation.relationTypeRef} → {relation.toRecordId ?? '待确认端点'}{' '}
                          <span data-testid="instance-relation-endpoint">{relation.endpointState}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                {readOnly ? null : (
                  <div className="project-actions">
                    <Button
                      data-testid="instance-approve"
                      disabled={busy || record.publicationState !== 'draft'}
                      onClick={() =>
                        void apply(() =>
                          client.approveInstanceRecord(projectId, record.recordId, {
                            expectedRevision: record.recordRevision,
                          }),
                        )
                      }
                    >
                      批准当前修订
                    </Button>
                    <Button
                      variant="primary"
                      data-testid="instance-publish"
                      disabled={busy || record.publicationState !== 'approved'}
                      onClick={() =>
                        void apply(() =>
                          client.publishInstanceRecord(projectId, record.recordId, {
                            expectedRevision: record.recordRevision,
                          }),
                        )
                      }
                    >
                      发布已批准修订
                    </Button>
                    <p>只有发布后的修订可进入业务数据。</p>
                  </div>
                )}
                {outcome === undefined ? null : (
                  <p
                    data-testid="instance-confirmation-outcome"
                    data-accepted={outcome.accepted.length}
                    data-skipped={outcome.skipped.length}
                  >
                    确认 {outcome.accepted.length} 项；跳过 {outcome.skipped.length} 项。
                  </p>
                )}
                <details className="project-audit">
                  <summary>版本与追溯信息</summary>
                  <dl>
                    <dt>记录类型</dt>
                    <dd data-testid="instance-detail-object-type">{record.objectTypeRef}</dd>
                    <dt>记录标识</dt>
                    <dd>
                      <code>{record.recordId}</code>
                    </dd>
                    <dt>已发布修订</dt>
                    <dd data-testid="instance-detail-published-revision">
                      {record.publishedRevision ?? '尚未发布'}
                    </dd>
                  </dl>
                </details>
              </div>
            )}
          </div>
        </div>
      ) : null}
      {failure === undefined ? null : (
        <PublicStateNotice
          testId="instance-action-failure"
          failure={classifyPublicError(failure)}
          onRecover={() => {
            void loadList()
            void reloadSelected()
          }}
        />
      )}
      <Drawer
        open={sourceField !== undefined && record !== undefined}
        title="字段来源"
        onClose={() => setSourceField(undefined)}
      >
        {sourceField === undefined ? null : (
          <div className="project-source-reader">
            <span className="project-state">已保存的抽取来源</span>
            <h3>{sourceField.fieldId}</h3>
            <p>{formatLocator(sourceField.source.locator)}</p>
            <blockquote>{sourceField.rawValue === null ? '空值' : String(sourceField.rawValue)}</blockquote>
            <p>以上为该记录保存的字段值。</p>
            {sourceCells.length === 1 && sourceCells[0] !== undefined ? (
              <>
                <h3>原文件中的实际单元格</h3>
                <p>{formatLocator(sourceCells[0].locator)}</p>
                <blockquote>{sourceCells[0].raw === null ? '空值' : String(sourceCells[0].raw)}</blockquote>
              </>
            ) : (
              <p>当前有界原始预览未唯一返回这个单元格。已保存的定位仍保留，不能声称已重读该位置的原文。</p>
            )}
            <details className="project-audit">
              <summary>定位与版本</summary>
              <dl>
                <dt>文件版本</dt>
                <dd>
                  <code>
                    {sourceField.source.documentRef.id}@{sourceField.source.documentRef.version}
                  </code>
                </dd>
                <dt>文件摘要</dt>
                <dd>
                  <code>{sourceField.source.documentRef.digest}</code>
                </dd>
                <dt>解析</dt>
                <dd>
                  <code>{sourceField.source.parseId}</code>
                </dd>
                <dt>原始定位</dt>
                <dd>
                  <code>{JSON.stringify(sourceField.source.locator)}</code>
                </dd>
              </dl>
            </details>
          </div>
        )}
      </Drawer>
    </section>
  )
}
