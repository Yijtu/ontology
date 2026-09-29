import { useCallback, useEffect, useState } from 'react'
import type {
  InstanceFieldValue,
  InstanceNormalizedValue,
  InstanceRecordView,
} from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import type { InstanceConfirmationOutcomeView } from '../api/instances'
import { ApiError } from '../api/errors'
import { StatePanel } from './StatePanel'
import type { WorkbenchError, WorkbenchPhase } from '../state/workbench'

/**
 * The public instance review surface (V03-013 / #182, SPEC v0.3a §9.1/§9.2, A.US-004,
 * P.US-008/010/014). A reviewer reads one instance record with its key fields — raw value,
 * normalized value, unit, source and pending/confirmed/conflict status — edits a field,
 * confirms or rejects a batch, adjudicates the entity identity (match / cannot-link / split /
 * create) and then approves and publishes a revision that an ordinary read reads back.
 *
 * The panel is generic: it never names an industry and mounts no professional view. It talks
 * to the API over HTTP only and disables (with a reason) every action the server would reject.
 */

export interface InstanceReviewPanelProps {
  readonly client: WorkbenchClient
  readonly projectId: string
  readonly readOnly?: boolean
}

function toError(error: unknown): WorkbenchError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.reasons.length === 0 ? {} : { reasons: error.reasons }),
    }
  }
  return {
    code: 'NETWORK_ERROR',
    message: error instanceof Error ? error.message : '请求无法完成。',
  }
}

function phaseFor(error: unknown): WorkbenchPhase {
  if (error instanceof ApiError && error.permissionDenied) return 'permission_denied'
  return 'failure'
}

function normalizedLabel(value: InstanceNormalizedValue | undefined): string {
  if (value === undefined) return '—'
  switch (value.kind) {
    case 'scalar':
      return value.value === null ? '(空)' : String(value.value)
    case 'quantity':
      return `${value.value} ${value.unitCode}`
    case 'reference':
      return `→ ${value.entityId}`
  }
}

function rawLabel(field: InstanceFieldValue): string {
  return field.rawValue === null ? '(空)' : String(field.rawValue)
}

function statusLabel(status: InstanceFieldValue['status']): string {
  return status === 'pending' ? '待确认' : status === 'confirmed' ? '已确认' : '冲突'
}

export function InstanceReviewPanel({ client, projectId, readOnly = false }: InstanceReviewPanelProps) {
  const [records, setRecords] = useState<readonly InstanceRecordView[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [record, setRecord] = useState<InstanceRecordView | undefined>(undefined)
  const [phase, setPhase] = useState<WorkbenchPhase>('loading')
  const [error, setError] = useState<WorkbenchError | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<WorkbenchError | undefined>(undefined)
  const [outcome, setOutcome] = useState<InstanceConfirmationOutcomeView | undefined>(undefined)
  const [editingField, setEditingField] = useState<string | undefined>(undefined)
  const [editValue, setEditValue] = useState('')
  const [editReason, setEditReason] = useState('')
  const [identityReason, setIdentityReason] = useState('')

  const selected = records.find((entry) => entry.recordId === selectedId)

  const loadList = useCallback(async (): Promise<void> => {
    setPhase('loading')
    try {
      const list = await client.listInstanceRecords(projectId)
      setRecords(list)
      setSelectedId((previous) =>
        previous !== undefined && list.some((entry) => entry.recordId === previous)
          ? previous
          : list[0]?.recordId,
      )
      setPhase(list.length === 0 ? 'empty' : 'ready')
    } catch (caught) {
      setError(toError(caught))
      setPhase(phaseFor(caught))
    }
  }, [client, projectId])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (selectedId === undefined) {
      setRecord(undefined)
      return
    }
    void client
      .getInstanceRecord(projectId, selectedId)
      .then((loaded) => setRecord(loaded))
      .catch((caught: unknown) => setError(toError(caught)))
  }, [client, projectId, selectedId])

  const apply = useCallback(
    async (action: () => Promise<InstanceRecordView>): Promise<void> => {
      setBusy(true)
      setFailure(undefined)
      setOutcome(undefined)
      try {
        const updated = await action()
        setRecord(updated)
        setRecords((previous) =>
          previous.map((entry) => (entry.recordId === updated.recordId ? updated : entry)),
        )
      } catch (caught) {
        setFailure(toError(caught))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const confirmField = (fieldId: string, decision: 'confirm' | 'conflict' | 'reject'): void => {
    if (record === undefined) return
    setBusy(true)
    setFailure(undefined)
    setOutcome(undefined)
    void client
      .confirmInstanceFields(projectId, record.recordId, {
        expectedRevision: record.recordRevision,
        decisions: [{ fieldId, decision }],
      })
      .then((result) => {
        setRecord(result.record)
        setOutcome(result)
        setRecords((previous) =>
          previous.map((entry) => (entry.recordId === result.record.recordId ? result.record : entry)),
        )
      })
      .catch((caught: unknown) => setFailure(toError(caught)))
      .finally(() => setBusy(false))
  }

  const submitEdit = (field: InstanceFieldValue): void => {
    if (record === undefined) return
    setBusy(true)
    setFailure(undefined)
    void client
      .editInstanceField(projectId, record.recordId, {
        expectedRevision: record.recordRevision,
        fieldId: field.fieldId,
        normalizedValue: { kind: 'scalar', value: editValue },
        reason: editReason.trim().length === 0 ? '人工修正字段值' : editReason.trim(),
      })
      .then((updated) => {
        setRecord(updated)
        setRecords((previous) => previous.map((entry) => (entry.recordId === updated.recordId ? updated : entry)))
        setEditingField(undefined)
        setEditValue('')
        setEditReason('')
      })
      .catch((caught: unknown) => setFailure(toError(caught)))
      .finally(() => setBusy(false))
  }

  const adjudicate = (kind: 'match' | 'cannot_link' | 'split' | 'create', targetEntityId?: string): void => {
    if (record === undefined) return
    void apply(() =>
      client.adjudicateInstanceIdentity(projectId, record.recordId, {
        expectedRevision: record.recordRevision,
        kind,
        ...(targetEntityId === undefined ? {} : { targetEntityId }),
        reason: identityReason.trim().length === 0 ? `identity ${kind}` : identityReason.trim(),
      }),
    )
  }

  return (
    <section className="instance-review" data-testid="instance-review" data-phase={phase} data-project-id={projectId}>
      <header className="panel__header">
        <h2>实例身份与关键字段确认</h2>
        <p className="panel__hint">对照来源核验原始值、规范值与确认状态；裁决实例身份；批准与发布是两步操作，发布后可回读。</p>
      </header>

      {phase === 'loading' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel
          phase={phase}
          {...(error === undefined ? {} : { error })}
          {...(phase === 'loading' ? { title: '正在加载实例记录…' } : {})}
        />
      ) : null}

      {phase === 'empty' ? <p data-testid="instance-review-empty">当前可信范围暂无实例记录。</p> : null}

      {phase === 'ready' ? (
        <div className="instance-review__list" data-testid="instance-record-list">
          <h3>实例记录</h3>
          <ul>
            {records.map((entry) => (
              <li key={entry.recordId}>
                <button
                  type="button"
                  data-testid="instance-record-item"
                  data-record-id={entry.recordId}
                  data-selected={entry.recordId === selectedId}
                  aria-pressed={entry.recordId === selectedId}
                  onClick={() => setSelectedId(entry.recordId)}
                >
                  {entry.objectTypeRef} · 修订 {entry.recordRevision} · {entry.publicationState}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {record === undefined || selected === undefined ? null : (
        <div
          className="instance-review__detail"
          data-testid="instance-detail"
          data-record-id={record.recordId}
        >
          <dl>
            <dt>记录类型</dt>
            <dd data-testid="instance-detail-object-type">{record.objectTypeRef}</dd>
            <dt>记录修订</dt>
            <dd data-testid="instance-detail-revision">{record.recordRevision}</dd>
            <dt>发布状态</dt>
            <dd data-testid="instance-detail-publication">{record.publicationState}</dd>
            <dt>已发布修订</dt>
            <dd data-testid="instance-detail-published-revision">{record.publishedRevision ?? '—'}</dd>
          </dl>

          <section className="instance-review__identity" data-testid="instance-identity">
            <h4>身份裁决</h4>
            <p data-testid="instance-identity-state">状态：{record.identity.state}</p>
            <p data-testid="instance-identity-confidence">置信：{record.identity.confidence}</p>
            <p data-testid="instance-identity-same-name" data-flag={record.identity.sameNameDifferentMeaning}>
              同名异物：{record.identity.sameNameDifferentMeaning ? '是' : '否'}
            </p>
            <ul data-testid="instance-identity-candidates">
              {record.identity.candidates.map((candidate) => (
                <li key={candidate.entityId} data-testid="instance-identity-candidate" data-entity-id={candidate.entityId}>
                  <span data-testid="instance-identity-candidate-name">{candidate.displayName}</span>
                  <span data-testid="instance-identity-candidate-object">（{candidate.objectId} · {candidate.strategy}）</span>
                  {readOnly ? null : (
                    <>
                      <button
                        type="button"
                        data-testid="instance-identity-match"
                        disabled={busy}
                        onClick={() => adjudicate('match', candidate.entityId)}
                      >
                        匹配
                      </button>
                      <button
                        type="button"
                        data-testid="instance-identity-cannot-link"
                        disabled={busy}
                        onClick={() => adjudicate('cannot_link', candidate.entityId)}
                      >
                        不可链接
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {readOnly ? null : (
              <div className="instance-review__identity-actions">
                <label>
                  理由
                  <input
                    type="text"
                    data-testid="instance-identity-reason"
                    value={identityReason}
                    disabled={busy}
                    onChange={(event) => setIdentityReason(event.target.value)}
                  />
                </label>
                <button type="button" data-testid="instance-identity-create" disabled={busy} onClick={() => adjudicate('create')}>
                  新建实体
                </button>
                <button
                  type="button"
                  data-testid="instance-identity-split"
                  disabled={busy || record.identity.matchedEntityId === undefined}
                  onClick={() => adjudicate('split', record.identity.matchedEntityId)}
                >
                  拆分
                </button>
              </div>
            )}
          </section>

          <section className="instance-review__fields" data-testid="instance-fields">
            <h4>关键字段</h4>
            <table>
              <thead>
                <tr>
                  <th>字段</th>
                  <th>原始值</th>
                  <th>规范值</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {record.fields.map((field) => (
                  <tr key={field.fieldId} data-testid="instance-field-row" data-field-id={field.fieldId}>
                    <td data-testid="instance-field-id">{field.fieldId}</td>
                    <td data-testid="instance-field-raw">{rawLabel(field)}</td>
                    <td data-testid="instance-field-normalized">{normalizedLabel(field.normalizedValue)}</td>
                    <td data-testid="instance-field-source">
                      {field.source.documentRef.id}／{field.source.locator.kind}
                    </td>
                    <td data-testid="instance-field-status" data-status={field.status}>
                      {statusLabel(field.status)}
                    </td>
                    <td>
                      {readOnly ? null : (
                        <>
                          <button
                            type="button"
                            data-testid="instance-field-confirm"
                            disabled={busy}
                            onClick={() => confirmField(field.fieldId, 'confirm')}
                          >
                            确认
                          </button>
                          <button
                            type="button"
                            data-testid="instance-field-conflict"
                            disabled={busy}
                            onClick={() => confirmField(field.fieldId, 'conflict')}
                          >
                            冲突
                          </button>
                          <button
                            type="button"
                            data-testid="instance-field-reject"
                            disabled={busy}
                            onClick={() => confirmField(field.fieldId, 'reject')}
                          >
                            拒绝
                          </button>
                          <button
                            type="button"
                            data-testid="instance-field-edit-start"
                            disabled={busy}
                            onClick={() => {
                              setEditingField(field.fieldId)
                              setEditValue('')
                              setEditReason('')
                            }}
                          >
                            修改
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {editingField === undefined || readOnly ? null : (
              <form
                className="instance-review__edit"
                data-testid="instance-field-edit-form"
                data-field-id={editingField}
                onSubmit={(event) => {
                  event.preventDefault()
                  const field = record.fields.find((entry) => entry.fieldId === editingField)
                  if (field !== undefined && !busy) submitEdit(field)
                }}
              >
                <label>
                  新规范值
                  <input
                    type="text"
                    data-testid="instance-field-edit-input"
                    value={editValue}
                    disabled={busy}
                    onChange={(event) => setEditValue(event.target.value)}
                  />
                </label>
                <label>
                  修改原因
                  <input
                    type="text"
                    data-testid="instance-field-edit-reason"
                    value={editReason}
                    disabled={busy}
                    onChange={(event) => setEditReason(event.target.value)}
                  />
                </label>
                <button type="submit" data-testid="instance-field-edit-submit" disabled={busy}>
                  保存修改
                </button>
              </form>
            )}
          </section>

          <section className="instance-review__relations" data-testid="instance-relations">
            <h4>关系端点</h4>
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
                    {relation.relationTypeRef} → {relation.toRecordId ?? '（待确认）'}
                    <span data-testid="instance-relation-endpoint">{relation.endpointState}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {readOnly ? null : (
            <div className="instance-review__actions">
              <button
                type="button"
                data-testid="instance-approve"
                disabled={busy || record.publicationState !== 'draft'}
                onClick={() => void apply(() => client.approveInstanceRecord(projectId, record.recordId, { expectedRevision: record.recordRevision }))}
              >
                批准
              </button>
              <button
                type="button"
                data-testid="instance-publish"
                disabled={busy || record.publicationState !== 'approved'}
                onClick={() => void apply(() => client.publishInstanceRecord(projectId, record.recordId, { expectedRevision: record.recordRevision }))}
              >
                发布
              </button>
            </div>
          )}

          {outcome === undefined ? null : (
            <p data-testid="instance-confirmation-outcome" data-accepted={outcome.accepted.length} data-skipped={outcome.skipped.length}>
              确认 {outcome.accepted.length} 项；跳过 {outcome.skipped.length} 项。
            </p>
          )}

          {failure === undefined ? null : (
            <p role="alert" data-testid="instance-action-failure" data-code={failure.code}>
              {failure.code}: {failure.message}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
