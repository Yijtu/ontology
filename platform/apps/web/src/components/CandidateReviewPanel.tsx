import { useCallback, useEffect, useReducer, useState } from 'react'
import type { IdentityDecisionKind } from '@ontology/contracts'
import { ApiError, type WorkbenchClient } from '../api/client'
import type { CandidateDetailView, CandidateSummary } from '../api/review'
import { initialReviewState, reviewReducer } from '../state/review'
import type { ReviewEvent } from '../state/review'
import type { WorkbenchError } from '../state/workbench'
import { StatePanel } from './StatePanel'

/**
 * The candidate review surface. It shows each candidate against the original text it was
 * derived from, records an identity decision (match / create-pending / reject / clarify) and
 * a publication review (approve / reject), and keeps the decision/review history readable.
 *
 * A 409 is never applied silently: the conflict and the stale revision are shown explicitly
 * and the operator must refresh. A source that is missing or changed is an explicit state,
 * not an empty excerpt.
 */

export interface CandidateReviewPanelProps {
  readonly client: WorkbenchClient
  readonly initialCandidateId?: string
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
    message: error instanceof Error ? error.message : 'the request could not be completed',
  }
}

function failureEvent(error: unknown): ReviewEvent {
  if (error instanceof ApiError && error.permissionDenied) {
    return { type: 'permissionDenied', error: toError(error) }
  }
  if (error instanceof ApiError && error.code === 'CAPABILITY_NOT_CONFIGURED') {
    return { type: 'notConfigured', error: toError(error) }
  }
  return { type: 'failed', error: toError(error) }
}

function labelOf(candidate: CandidateSummary): string {
  if (candidate.objectId !== undefined) return candidate.objectId
  if (candidate.relationId !== undefined) return candidate.relationId
  if (candidate.ruleId !== undefined) return candidate.ruleId
  return candidate.candidateId.slice(0, 8)
}

const DECISION_LABEL: Readonly<Record<IdentityDecisionKind, string>> = {
  match: '匹配已有实体',
  create_pending: '新建待确认',
  clarify: '需要澄清',
  reject: '拒绝',
  split: '拆分',
}

export function CandidateReviewPanel({ client, initialCandidateId }: CandidateReviewPanelProps) {
  const [state, dispatch] = useReducer(reviewReducer, undefined, initialReviewState)
  const [targetEntity, setTargetEntity] = useState('')
  const [justification, setJustification] = useState('')
  const [reviewReason, setReviewReason] = useState('已对照原文核实')
  const [revisionReason, setRevisionReason] = useState('更正已发布语义资产')

  const loadList = useCallback(async () => {
    dispatch({ type: 'loadStarted' })
    try {
      const candidates = await client.listCandidates()
      dispatch({ type: 'loaded', candidates })
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }, [client])

  const select = useCallback(
    async (candidateId: string) => {
      dispatch({ type: 'busy' })
      try {
        const [candidate, decisions, reviews] = await Promise.all([
          client.getCandidate(candidateId),
          client.listCandidateDecisions(candidateId),
          client.listCandidateReviews(candidateId),
        ])
        dispatch({ type: 'candidateLoaded', candidate, decisions, reviews })
        const latestTarget = [...decisions].reverse().find((entry) => entry.targetEntityId !== undefined)
        setTargetEntity(latestTarget?.targetEntityId ?? '')
        // A candidate that was never published has no statement; that is not an error.
        try {
          const statement = await client.getStatement(candidateId).catch((error: unknown) => {
            if (error instanceof ApiError && error.status === 404) return undefined
            throw error
          })
          const revisions = statement === undefined ? [] : await client.listStatementRevisions(candidateId)
          dispatch({ type: 'statementLoaded', statement, revisions })
        } catch (error) {
          dispatch({ type: 'statementFailed', error: toError(error) })
        }
      } catch (error) {
        dispatch(failureEvent(error))
      }
    },
    [client],
  )

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (initialCandidateId !== undefined) void select(initialCandidateId)
  }, [initialCandidateId, select])

  const openSource = async () => {
    const candidate = state.selected
    if (candidate === undefined) return
    dispatch({ type: 'busy' })
    try {
      const source = await client.getCandidateSource(candidate.candidateId)
      dispatch({ type: 'sourceLoaded', source })
    } catch (error) {
      dispatch({ type: 'sourceFailed', error: toError(error) })
    }
  }

  const decide = async (kind: IdentityDecisionKind) => {
    const candidate = state.selected
    if (candidate === undefined) return
    dispatch({ type: 'busy' })
    try {
      await client.decideCandidate(candidate.candidateId, {
        kind,
        expectedRevision: candidate.decisionRevision,
        ...(kind === 'match' && targetEntity.trim().length > 0 ? { targetEntityId: targetEntity.trim() } : {}),
        ...(justification.trim().length > 0 ? { justification: justification.trim() } : {}),
      })
      const [refreshed, decisions] = await Promise.all([
        client.getCandidate(candidate.candidateId),
        client.listCandidateDecisions(candidate.candidateId),
      ])
      dispatch({ type: 'decided', candidate: refreshed, decisions })
      // A `create_pending` mints the entity a following `match` targets; prefill it so the
      // reviewer does not have to copy the id by hand.
      const latestTarget = [...decisions].reverse().find((entry) => entry.targetEntityId !== undefined)
      if (latestTarget?.targetEntityId !== undefined) setTargetEntity(latestTarget.targetEntityId)
    } catch (error) {
      if (error instanceof ApiError && error.conflict) {
        dispatch({ type: 'conflict', error: toError(error) })
        return
      }
      dispatch(failureEvent(error))
    }
  }

  const review = async (decision: 'approve' | 'reject') => {
    const candidate = state.selected
    if (candidate === undefined) return
    const head = state.reviews[state.reviews.length - 1]?.revision ?? '0'
    dispatch({ type: 'busy' })
    try {
      await client.reviewCandidate(candidate.candidateId, {
        decision,
        reason: reviewReason.trim().length === 0 ? '已对照原文核实' : reviewReason.trim(),
        expectedRevision: head,
      })
      const reviews = await client.listCandidateReviews(candidate.candidateId)
      dispatch({ type: 'reviewed', reviews })
    } catch (error) {
      if (error instanceof ApiError && error.conflict) {
        dispatch({ type: 'conflict', error: toError(error) })
        return
      }
      dispatch(failureEvent(error))
    }
  }

  const publish = async () => {
    const candidate = state.selected
    if (candidate === undefined) return
    dispatch({ type: 'busy' })
    try {
      const publications = await client.listPublications()
      const head = publications[publications.length - 1]?.revision ?? '0'
      const publication = await client.publishSemantics({
        approvedCandidateRefs: [{ candidateId: candidate.candidateId, kind: candidate.kind }],
        schemaRef: candidate.inputVersion.definitionRef,
        expectedRevision: head,
      })
      dispatch({
        type: 'published',
        notice: `已发布语义资产（publication ${publication.publicationId}，修订 ${publication.revision}）`,
      })
      const statement = await client.getStatement(candidate.candidateId)
      const revisions = await client.listStatementRevisions(candidate.candidateId)
      dispatch({ type: 'statementLoaded', statement, revisions })
    } catch (error) {
      if (error instanceof ApiError && error.conflict) {
        dispatch({ type: 'conflict', error: toError(error) })
        return
      }
      dispatch(failureEvent(error))
    }
  }

  const revise = async (kind: 'correction' | 'retraction') => {
    const candidate = state.selected
    const statement = state.statement
    if (candidate === undefined || statement === undefined) return
    dispatch({ type: 'busy' })
    try {
      await client.reviseStatement(candidate.candidateId, {
        kind,
        reason: revisionReason.trim().length === 0 ? '更正已发布语义资产' : revisionReason.trim(),
        expectedRevision: statement.version,
      })
      const refreshed = await client.getStatement(candidate.candidateId)
      const revisions = await client.listStatementRevisions(candidate.candidateId)
      dispatch({
        type: 'revised',
        statement: refreshed,
        revisions,
        notice: `已${kind === 'retraction' ? '撤回' : '更正'}，当前版本 ${refreshed.version}；历史依据仍可查看。`,
      })
    } catch (error) {
      if (error instanceof ApiError && error.conflict) {
        dispatch({ type: 'conflict', error: toError(error) })
        return
      }
      dispatch(failureEvent(error))
    }
  }

  const latestReview = state.reviews[state.reviews.length - 1]
  const approved = latestReview?.decision === 'approve'

  return (
    <section className="review" data-testid="candidate-panel" data-phase={state.phase}>
      <header className="panel__header">
        <h2>候选审核</h2>
        <p className="panel__hint">
          候选可对照原文匹配 / 新建待确认 / 拒绝 / 澄清 / 批准。冲突与并发版本变化显式展示，不静默覆盖。
        </p>
      </header>

      {state.phase === 'loading' || state.phase === 'empty' || state.phase === 'not_configured' || state.phase === 'failure' || state.phase === 'permission_denied' ? (
        <StatePanel phase={state.phase} {...(state.error === undefined ? {} : { error: state.error })} />
      ) : null}

      {state.phase === 'ready' ? (
        <div className="review__body">
          <aside className="review__queue" data-testid="candidate-list" data-count={state.candidates.length}>
            <h3>候选队列（{state.candidates.length}）</h3>
            <ul>
              {state.candidates.map((candidate) => (
                <li key={candidate.candidateId}>
                  <button
                    type="button"
                    data-testid="candidate-item"
                    data-kind={candidate.kind}
                    data-state={candidate.state}
                    data-selected={candidate.candidateId === state.selected?.candidateId}
                    disabled={state.busy}
                    onClick={() => void select(candidate.candidateId)}
                  >
                    {candidate.kind} · {labelOf(candidate)} · {candidate.state}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          {state.selected === undefined ? (
            <p className="review__prompt" data-testid="candidate-select-prompt">
              从左侧选择一个候选开始审核。
            </p>
          ) : (
            <div className="review__detail" data-testid="candidate-detail" data-kind={state.selected.kind}>
              <h3 data-testid="candidate-id">{state.selected.candidateId}</h3>
              <p data-testid="candidate-state">
                状态：{state.selected.state} · 裁决修订：{state.selected.decisionRevision}
              </p>

              <CandidateValue candidate={state.selected} />

              <div className="review__source">
                <button type="button" data-testid="open-source" disabled={state.busy} onClick={() => void openSource()}>
                  打开原文对照
                </button>

                {state.sourceError === undefined ? null : (
                  <p className="review__source-error" data-testid="source-error" data-code={state.sourceError.code} role="alert">
                    原文不可用（{state.sourceError.code}）：{state.sourceError.message}
                  </p>
                )}

                {state.source === undefined ? null : state.source.missingSource ? (
                  <p className="review__missing-source" data-testid="missing-source" role="alert">
                    该候选缺少来源定位，不能作为证据发布。
                  </p>
                ) : (
                  <ol className="review__spans" data-testid="source-spans">
                    {state.source.spans.map((span) => (
                      <li key={span.chunkId} data-testid="source-span" data-status={span.status}>
                        {span.status === 'resolved' ? (
                          <>
                            <blockquote className="review__quote">{span.text}</blockquote>
                            <p className="review__locator" data-testid="span-locator">
                              定位：{span.locator.kind}
                              {span.locator.page === undefined ? '' : ` · 第 ${span.locator.page} 页`}
                              {` · ${span.precision}`}
                              {span.truncated ? ' · 已截断' : ''}
                            </p>
                          </>
                        ) : (
                          <span data-testid="span-problem">
                            来源{span.status === 'missing' ? '缺失' : '不一致'}：{span.reason}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div className="review__decisions">
                <h4>身份裁决</h4>
                <label className="review__field">
                  <span>目标实体 ID（匹配用）</span>
                  <input
                    type="text"
                    data-testid="target-entity"
                    value={targetEntity}
                    onChange={(event) => setTargetEntity(event.target.value)}
                  />
                </label>
                <label className="review__field">
                  <span>裁决依据</span>
                  <input
                    type="text"
                    data-testid="justification"
                    value={justification}
                    onChange={(event) => setJustification(event.target.value)}
                  />
                </label>
                <div className="review__buttons">
                  {(['match', 'create_pending', 'clarify', 'reject'] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      data-testid={`decision-${kind}`}
                      disabled={state.busy}
                      onClick={() => void decide(kind)}
                    >
                      {DECISION_LABEL[kind]}
                    </button>
                  ))}
                </div>

                <ol className="review__history" data-testid="decision-history" data-count={state.decisions.length}>
                  {state.decisions.map((decision) => (
                    <li key={decision.decisionId} data-testid="decision-record" data-kind={decision.kind}>
                      修订 {decision.revision} · {DECISION_LABEL[decision.kind]}
                      {decision.targetEntityId === undefined ? '' : ` · ${decision.targetEntityId}`}
                      {` · ${decision.recordedAt}`}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="review__reviews">
                <h4>发布审核</h4>
                <label className="review__field">
                  <span>审核理由</span>
                  <input
                    type="text"
                    data-testid="review-reason"
                    value={reviewReason}
                    onChange={(event) => setReviewReason(event.target.value)}
                  />
                </label>
                <div className="review__buttons">
                  <button type="button" data-testid="review-approve" disabled={state.busy} onClick={() => void review('approve')}>
                    批准
                  </button>
                  <button type="button" data-testid="review-reject" disabled={state.busy} onClick={() => void review('reject')}>
                    拒绝
                  </button>
                  <button
                    type="button"
                    data-testid="publish"
                    disabled={state.busy || !approved}
                    onClick={() => void publish()}
                  >
                    发布已批准候选
                  </button>
                </div>
                <p data-testid="review-head" data-approved={approved}>
                  当前审核：{latestReview === undefined ? '尚无' : `${latestReview.decision}（修订 ${latestReview.revision}）`}
                </p>

                <ol className="review__history" data-testid="review-history" data-count={state.reviews.length}>
                  {state.reviews.map((entry) => (
                    <li key={entry.reviewId} data-testid="review-record" data-decision={entry.decision}>
                      修订 {entry.revision} · {entry.decision} · {entry.reason} · {entry.recordedAt}
                    </li>
                  ))}
                </ol>
              </div>

              <div className="review__statement">
                <h4>已发布语义资产与修订历史</h4>
                {state.statement === undefined ? (
                  <p data-testid="statement-none">尚未发布为语义资产。</p>
                ) : (
                  <p
                    data-testid="statement-current"
                    data-status={state.statement.status}
                    data-version={state.statement.version}
                  >
                    命题 {state.statement.propositionKey.slice(0, 12)}… · 状态 {state.statement.status} · 版本{' '}
                    {state.statement.version}
                  </p>
                )}
                <label className="review__field">
                  <span>修订理由</span>
                  <input
                    type="text"
                    data-testid="revision-reason"
                    value={revisionReason}
                    onChange={(event) => setRevisionReason(event.target.value)}
                  />
                </label>
                <div className="review__buttons">
                  <button
                    type="button"
                    data-testid="revise-correction"
                    disabled={state.busy || state.statement === undefined}
                    onClick={() => void revise('correction')}
                  >
                    更正
                  </button>
                  <button
                    type="button"
                    data-testid="revise-retraction"
                    disabled={state.busy || state.statement === undefined || state.statement.status === 'retracted'}
                    onClick={() => void revise('retraction')}
                  >
                    撤回
                  </button>
                </div>
                <ol className="review__history" data-testid="revision-history" data-count={state.revisions.length}>
                  {state.revisions.map((revision) => (
                    <li key={revision.revisionId} data-testid="revision-record" data-kind={revision.kind}>
                      版本 {revision.version} · {revision.kind} · {revision.reason}
                      {revision.supersedesVersion === undefined ? '' : `（取代 ${revision.supersedesVersion}）`}
                    </li>
                  ))}
                </ol>
                {state.statementError === undefined ? null : (
                  <p className="review__source-error" data-testid="statement-error" role="alert">
                    语义资产不可读（{state.statementError.code}）：{state.statementError.message}
                  </p>
                )}
              </div>

              {state.conflict === undefined ? null : (
                <p className="review__conflict" data-testid="review-conflict" data-code={state.conflict.code} role="alert">
                  并发版本变化（{state.conflict.code}）：{state.conflict.message}。请刷新后重新决策，不会覆盖他人改动。
                </p>
              )}

              {state.notice === undefined ? null : (
                <p className="review__notice" data-testid="review-notice" role="status">
                  {state.notice}
                </p>
              )}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

function CandidateValue({ candidate }: { readonly candidate: CandidateDetailView }) {
  switch (candidate.kind) {
    case 'entity':
      return (
        <ul className="review__attributes" data-testid="candidate-attributes">
          {candidate.attributes.map((attribute) => (
            <li key={attribute.attributeId} data-testid="candidate-attribute">
              {attribute.attributeId} = {String(attribute.value)}
              {attribute.unitCode === undefined ? '' : ` ${attribute.unitCode}`}
            </li>
          ))}
        </ul>
      )
    case 'relation':
      return (
        <p data-testid="candidate-relation">
          {candidate.relationId}: {candidate.from.objectId} → {candidate.to.objectId}
        </p>
      )
    case 'rule':
      return (
        <div data-testid="candidate-rule" data-conflicts={candidate.conflicts.length}>
          <p>
            规则 {candidate.ruleId}（{candidate.severity}）
          </p>
          {candidate.conflicts.length === 0 ? null : (
            <p className="review__conflict" data-testid="candidate-rule-conflict">
              规则冲突：{candidate.conflicts.map((conflict) => conflict.reason).join('；')}
            </p>
          )}
        </div>
      )
    case 'rule_unhandled':
      return (
        <p data-testid="candidate-rule-unhandled">
          未支持表达（{candidate.reason}）：{candidate.detail}
        </p>
      )
  }
}
