import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ProfileRef, RunRoutePreference } from '@ontology/contracts'
import { ApiError } from '../api/errors'
import type { QueryRunView, RunEventStream, WorkbenchClient } from '../api/client'
import {
  initialQueryState,
  queryReducer,
  type QueryOutcome,
  type QueryState,
} from '../state/query'
import type { WorkbenchError } from '../state/workbench'
import { StatePanel } from './StatePanel'
import { useViewport } from './useViewport'

/**
 * The business query surface (US-019/020/021). It lets a user ask within the resolved
 * scenario scope, watch only the auditable progress and verified data, answer a
 * clarification (resuming on the same shared budget) or cancel, and it renders one of the
 * five observable outcomes. It never renders or subscribes to an unverified draft: the only
 * event names it accepts are the eight public ones (C6.1), and the answer it shows is the
 * server's published, hash-bound answer.
 */
export interface QueryPanelProps {
  readonly client: WorkbenchClient
  readonly profileRef?: ProfileRef
  /** Deep-linked run id (`?run=<id>`) so a state can be reproduced in a browser. */
  readonly initialRunId?: string
}

const DEFAULT_PROFILE: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

function toQueryError(error: unknown): WorkbenchError {
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

function failureEvent(error: unknown) {
  if (error instanceof ApiError && error.permissionDenied) {
    return { type: 'permissionDenied' as const, error: toQueryError(error) }
  }
  if (error instanceof ApiError && error.code === 'CAPABILITY_NOT_CONFIGURED') {
    return { type: 'notConfigured' as const, error: toQueryError(error) }
  }
  return { type: 'failed' as const, error: toQueryError(error) }
}

function isTerminal(state: string): boolean {
  return state === 'published' || state === 'cancelled' || state === 'failed' || state === 'blocked'
}

const OUTCOME_LABEL: Readonly<Record<QueryOutcome, string>> = {
  pending: '进行中',
  normal: '正常回答',
  limited: '有限回答',
  gap: '数据缺口',
  conflict: '证据冲突',
  tool_failure: '工具失败',
  cancelled: '已取消',
}

function BudgetPanel({ budget }: { readonly budget: QueryState['budget'] }) {
  if (budget === undefined) {
    return (
      <p className="query__budget query__budget--unknown" data-testid="query-budget" data-known="false">
        预算尚未建立（运行尚未打开共享预算账本）。
      </p>
    )
  }
  return (
    <div className="query__budget" data-testid="query-budget" data-known="true">
      <h3>共享预算（澄清恢复不重置）</h3>
      <p data-testid="budget-tool-calls">
        剩余工具调用：<strong>{budget.toolCallsRemaining}</strong>
      </p>
      <p data-testid="budget-repair-attempts">
        剩余修复次数：<strong>{budget.repairAttemptsRemaining}</strong>
      </p>
      <p data-testid="budget-parallel-limit">并发上限：{budget.parallelToolLimit}</p>
      <p data-testid="budget-deadline">截止时间：{budget.deadline}</p>
    </div>
  )
}

function ScopePanel({ state }: { readonly state: QueryState }) {
  const scope = state.scope
  if (scope === undefined) return null
  return (
    <section className="query__scope" data-testid="query-scope">
      <h3>场景允许范围</h3>
      <p data-testid="scope-profile">
        {scope.profileRef.id}@{scope.profileRef.version}
      </p>
      <p data-testid="scope-web" data-enabled={scope.webSearchEnabled}>
        Web 搜索：{scope.webSearchEnabled ? '允许' : '未启用'}
      </p>
      <ul className="query__tools" data-testid="scope-tools" data-count={scope.toolIds.length}>
        {scope.toolIds.map((toolId) => (
          <li key={toolId} data-testid="scope-tool">
            {toolId}
          </li>
        ))}
      </ul>
      <p data-testid="scope-domains" data-count={scope.allowedDomains.length}>
        允许域名：{scope.allowedDomains.length === 0 ? '无（未授权任何域名）' : scope.allowedDomains.join('、')}
      </p>
      {scope.explicitDegradations.length === 0 ? null : (
        <ul className="query__degradations" data-testid="scope-degradations">
          {scope.explicitDegradations.map((degradation) => (
            <li key={degradation.capability} data-testid="scope-degradation">
              {degradation.capability}（{degradation.reason}，回退：{degradation.fallback}）
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function OutcomePanel({ state }: { readonly state: QueryState }) {
  const outcome = state.outcome
  if (outcome === 'pending') return null
  const answer = state.answer
  return (
    <section className="query__outcome" data-testid={`outcome-${outcome}`} data-outcome={outcome}>
      <h3 data-testid="outcome-label">{OUTCOME_LABEL[outcome]}</h3>
      {outcome === 'normal' ? <p>已核验的答案已发布，未发现缺口或冲突。</p> : null}
      {outcome === 'limited' ? (
        <p>
          结果为有限回答：仅包含已通过核验的事实，其余以缺口显式标注，未核验草稿不会被当作答案。
        </p>
      ) : null}
      {outcome === 'gap' ? (
        <p>证据不足或数据过期：平台返回显式缺口，而不是编造答案。</p>
      ) : null}
      {outcome === 'conflict' ? (
        <p>证据或核验冲突：平台不发布未经验证的内容，请补充澄清或数据。</p>
      ) : null}
      {outcome === 'tool_failure' ? (
        <p>工具或平台失败：运行已失败，未生成核验答案。</p>
      ) : null}
      {outcome === 'cancelled' ? <p>运行已取消；迟到的结果不会恢复运行或发布答案。</p> : null}
      {answer === undefined ? null : (
        <ul className="query__limitations" data-testid="answer-limitations">
          {answer.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AnswerPanel({ state }: { readonly state: QueryState }) {
  const answer = state.answer
  if (state.answerState === 'in_progress') {
    return (
      <section className="query__answer" data-testid="query-answer" data-answer-state="in_progress">
        <h3>最终答案</h3>
        <p>运行尚未结束：没有可展示的最终答案。</p>
      </section>
    )
  }
  if (state.answerState === 'unavailable') {
    return (
      <section className="query__answer" data-testid="query-answer" data-answer-state="unavailable">
        <h3>最终答案</h3>
        <p data-testid="answer-unavailable">
          该运行在终态下没有已核验答案；未核验草稿不会作为答案展示。
        </p>
      </section>
    )
  }
  if (answer === undefined) {
    return (
      <section className="query__answer" data-testid="query-answer" data-answer-state="none">
        <h3>最终答案</h3>
        <p>尚无已核验答案。</p>
      </section>
    )
  }
  return (
    <section className="query__answer" data-testid="query-answer" data-answer-state="published">
      <h3>已核验答案（按内容哈希绑定）</h3>
      <dl>
        <dt>答案 ID</dt>
        <dd data-testid="answer-id">{answer.answerId}</dd>
        <dt>发布类型</dt>
        <dd data-testid="answer-kind">{answer.publicationKind}</dd>
        <dt>内容哈希</dt>
        <dd data-testid="answer-hash">{answer.contentHash}</dd>
        <dt>证据清单哈希</dt>
        <dd data-testid="answer-evidence-hash">{answer.evidenceManifestHash}</dd>
        {answer.asOf === undefined ? null : (
          <>
            <dt>历史时点</dt>
            <dd data-testid="answer-as-of">{answer.asOf}</dd>
          </>
        )}
      </dl>
      {answer.limitations.length === 0 ? null : (
        <ul className="query__limitations" data-testid="answer-limitations">
          {answer.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function QueryPanel({ client, profileRef = DEFAULT_PROFILE, initialRunId }: QueryPanelProps) {
  const viewport = useViewport()
  const [state, dispatch] = useReducer(queryReducer, undefined, initialQueryState)
  const [question, setQuestion] = useState('')
  const [siteRef, setSiteRef] = useState('')
  const [route, setRoute] = useState<RunRoutePreference>('auto')
  const [allowWeb, setAllowWeb] = useState(false)
  const [clarificationInput, setClarificationInput] = useState('')
  const streamRef = useRef<RunEventStream | undefined>(undefined)

  const closeStream = useCallback(() => {
    streamRef.current?.close()
    streamRef.current = undefined
  }, [])

  const loadAnswer = useCallback(
    async (runId: string) => {
      try {
        const result = await client.getAnswer(runId)
        dispatch({ type: 'answerLoaded', result })
      } catch (error) {
        dispatch(failureEvent(error))
      }
    },
    [client],
  )

  const refreshRun = useCallback(
    async (runId: string) => {
      try {
        const run = await client.getRun(runId)
        dispatch({ type: 'runLoaded', run })
      } catch (error) {
        dispatch(failureEvent(error))
      }
    },
    [client],
  )

  const openStream = useCallback(
    (runId: string) => {
      closeStream()
      streamRef.current = client.openRunEvents(runId, undefined, {
        onOpen: () => dispatch({ type: 'streamState', state: 'open' }),
        onError: () => dispatch({ type: 'streamState', state: 'error' }),
        onEvent: (event) => {
          dispatch({ type: 'runEvents', events: [event] })
          if (event.event === 'answer.published' || event.event === 'run.failed') {
            closeStream()
            void loadAnswer(runId)
            void refreshRun(runId)
          }
        },
      })
    },
    [client, closeStream, loadAnswer, refreshRun],
  )

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      dispatch({ type: 'scopeLoadStarted' })
      try {
        const scope = await client.getRunScope(profileRef)
        if (cancelled) return
        dispatch({ type: 'scopeLoaded', scope })
        if (initialRunId !== undefined) {
          const run = await client.getRun(initialRunId)
          if (cancelled) return
          dispatch({ type: 'runLoaded', run })
          openStream(initialRunId)
          void loadAnswer(initialRunId)
        }
      } catch (error) {
        if (!cancelled) dispatch(failureEvent(error))
      }
    }
    void load()
    return () => {
      cancelled = true
      closeStream()
    }
  }, [client, profileRef, initialRunId, openStream, loadAnswer, closeStream])

  const ask = async () => {
    if (question.trim().length === 0) {
      dispatch({ type: 'notice', message: '请输入问题后再提交。' })
      return
    }
    dispatch({ type: 'askStarted' })
    try {
      const created = await client.createRun({
        profileRef,
        question: question.trim(),
        context: {
          timeZone: DEFAULT_TIME_ZONE,
          ...(siteRef.trim().length === 0 ? {} : { siteRef: siteRef.trim() }),
        },
        preferences: { route, allowWeb: state.scope?.webSearchEnabled === true && allowWeb },
      })
      const run = await client.getRun(created.runId)
      dispatch({ type: 'runLoaded', run })
      openStream(created.runId)
      void loadAnswer(created.runId)
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const respond = async () => {
    const run = state.run
    const clarification = state.clarification
    if (run === undefined || clarification === undefined) return
    if (clarificationInput.trim().length === 0) {
      dispatch({ type: 'notice', message: '请输入澄清内容。' })
      return
    }
    dispatch({ type: 'busy' })
    try {
      await client.respondToClarification(run.runId, {
        clarificationId: clarification.clarificationId,
        typedResponse: { answer: clarificationInput.trim() },
        expectedRevision: run.revision,
      })
      setClarificationInput('')
      dispatch({ type: 'clarificationAnswered' })
      await refreshRun(run.runId)
      void loadAnswer(run.runId)
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const cancel = async () => {
    const run = state.run
    if (run === undefined) return
    dispatch({ type: 'busy' })
    try {
      await client.cancelRun(run.runId, { reason: '用户取消', expectedRevision: run.revision })
      closeStream()
      const refreshed: QueryRunView = await client.getRun(run.runId)
      dispatch({ type: 'cancelled', run: refreshed })
    } catch (error) {
      dispatch(failureEvent(error))
    }
  }

  const phase = state.phase
  const webAllowed = state.scope?.webSearchEnabled === true
  const run = state.run

  return (
    <section
      className={`query query--${viewport}`}
      data-testid="query-panel"
      data-viewport={viewport}
      data-phase={phase}
      data-outcome={state.outcome}
    >
      <header className="panel__header">
        <h2>业务问答</h2>
        <p className="panel__hint">
          在场景允许范围内提问；只展示可审计进度与已验证数据，未核验草稿不会作为答案发送。
        </p>
      </header>

      {phase === 'loading' || phase === 'not_configured' || phase === 'failure' || phase === 'permission_denied' ? (
        <StatePanel phase={phase} {...(state.error === undefined ? {} : { error: state.error })} />
      ) : null}

      {phase === 'empty' || phase === 'ready' ? (
        <>
          {phase === 'empty' ? <StatePanel phase="empty" title="尚未提问" /> : null}
          <div className="query__body">
          <ScopePanel state={state} />

          <form
            className="query__ask"
            data-testid="query-ask-form"
            onSubmit={(event) => {
              event.preventDefault()
              void ask()
            }}
          >
            <h3>提问</h3>
            <label className="query__field">
              <span>问题</span>
              <textarea
                name="question"
                data-testid="query-question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
              />
            </label>
            <label className="query__field">
              <span>站点（可选）</span>
              <input
                type="text"
                name="siteRef"
                data-testid="query-site"
                value={siteRef}
                onChange={(event) => setSiteRef(event.target.value)}
              />
            </label>
            <label className="query__field">
              <span>执行路径</span>
              <select
                name="route"
                data-testid="query-route"
                value={route}
                onChange={(event) => setRoute(event.target.value as RunRoutePreference)}
              >
                <option value="auto">auto</option>
                <option value="template">template</option>
                <option value="pi">pi</option>
              </select>
            </label>
            <label className="query__checkbox">
              <input
                type="checkbox"
                name="allowWeb"
                data-testid="query-allow-web"
                checked={webAllowed && allowWeb}
                disabled={!webAllowed}
                onChange={(event) => setAllowWeb(event.target.checked)}
              />
              <span>
                允许 Web 搜索{webAllowed ? '' : '（场景未启用，不可选择）'}
              </span>
            </label>
            <button type="submit" data-testid="query-ask" disabled={state.busy}>
              提问
            </button>
          </form>

          {run === undefined ? null : (
            <section className="query__run" data-testid="query-run" data-state={run.state}>
              <h3>运行进度</h3>
              <p data-testid="run-state">
                运行状态：<strong>{run.state}</strong>
              </p>
              <p data-testid="run-revision">修订：{run.revision}</p>

              <BudgetPanel budget={state.budget ?? run.budget} />

              <ol className="query__progress" data-testid="query-progress" data-count={state.events.length}>
                {state.events.map((entry, index) => (
                  <li key={`${entry.id}-${index}`} data-testid="progress-entry" data-event={entry.event}>
                    {entry.label}
                    {entry.detail === undefined ? '' : `（${entry.detail}）`}
                  </li>
                ))}
              </ol>

              {state.rejectedEvents.length === 0 ? null : (
                <p className="query__rejected" data-testid="query-rejected-events" role="alert">
                  已忽略非公开事件（不会作为进度或答案展示）：{state.rejectedEvents.join('、')}
                </p>
              )}

              {state.clarification === undefined ? null : (
                <div className="query__clarification" data-testid="query-clarification" data-revision={run.revision}>
                  <h4>需要澄清</h4>
                  <p data-testid="clarification-question">
                    {state.clarification.questionType}：{state.clarification.clarificationId}
                  </p>
                  <label className="query__field">
                    <span>澄清内容</span>
                    <input
                      type="text"
                      name="clarification"
                      data-testid="clarification-input"
                      value={clarificationInput}
                      onChange={(event) => setClarificationInput(event.target.value)}
                    />
                  </label>
                  <button type="button" data-testid="clarification-submit" disabled={state.busy} onClick={() => void respond()}>
                    提交澄清（If-Match {run.revision}）
                  </button>
                </div>
              )}

              <button
                type="button"
                className="query__cancel"
                data-testid="query-cancel"
                disabled={state.busy || isTerminal(run.state)}
                onClick={() => void cancel()}
              >
                取消运行（If-Match {run.revision}）
              </button>

              {state.notice === undefined ? null : (
                <p className="query__notice" data-testid="query-notice" role="status">
                  {state.notice}
                </p>
              )}

              <OutcomePanel state={state} />
              <AnswerPanel state={state} />
            </section>
          )}
          </div>
        </>
      ) : null}
    </section>
  )
}
