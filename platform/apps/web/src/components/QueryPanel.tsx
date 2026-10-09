import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProfileRef, ResourceRef, RunRoutePreference } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import { type QueryOutcome, type QueryState } from '../state/query'
import { useRunSession } from './project/useRunSession'
import './project/project-workbench.css'
import { Button, Drawer } from './ui'
import { FixedAnswerSource } from './project/FixedAnswerSource'
import type { AnswerSourceLoader } from '../api/source-views'
import { ProjectContextPicker, useProjectContext } from './project/ProjectContextPicker'
import { readProjectTasks } from '../api/project-workbench'
import type { ProjectTaskCatalogue } from '../api/project-workbench'
import { useRequestFence } from './project/useRequestFence'
import { ProjectNotice } from './project/ProjectNotice'
import { runStatusLabel } from '../state/project-labels'
import { StatePanel } from './StatePanel'
import { useViewport } from './useViewport'
import { PublishedAnswerBody } from './PublishedAnswerBody'
import type { CoreDeploymentInfo } from '../api/client'

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
  readonly profileRef: ProfileRef
  readonly timeZone: string
  /** Deployment-owned safe task IDs offered as shortcuts; arbitrary queries remain possible. */
  readonly availableTasks?: readonly string[]
  readonly modelCapabilities?: CoreDeploymentInfo['models']
  /** Deployment-owned context fields; the shared query view has no industry fields. */
  readonly contextFields?: readonly QueryContextField[]
  /** Deep-linked run id (`?run=<id>`) so a state can be reproduced in a browser. */
  readonly initialRunId?: string
  readonly readOnly?: boolean
  readonly projectId?: string
  readonly onSelectProject?: (projectId: string | undefined) => void
  /** Opens a source reference through the host's existing evidence/history surface. */
  readonly onEvidenceReference?: (ref: ResourceRef) => void
}

export type QueryContextField =
  | {
      readonly name: string
      readonly label: string
      readonly kind: 'text'
      readonly required?: boolean
      readonly defaultValue?: string
    }
  | {
      readonly name: string
      readonly label: string
      readonly kind: 'number'
      readonly required?: boolean
      readonly defaultValue?: number
      readonly minimum?: number
      readonly maximum?: number
    }
  | {
      readonly name: string
      readonly label: string
      readonly kind: 'decimal'
      readonly required?: boolean
      readonly defaultValue?: string
    }
  | {
      readonly name: string
      readonly label: string
      readonly kind: 'enum'
      readonly required?: boolean
      readonly defaultValue?: string
      readonly options: readonly string[]
    }

const EMPTY_CONTEXT_FIELDS: readonly QueryContextField[] = []

function initialContext(fields: readonly QueryContextField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.name, String(field.defaultValue ?? '')]))
}

function contextFromFields(
  fields: readonly QueryContextField[],
  values: Readonly<Record<string, string>>,
): { readonly context: Record<string, string | number>; readonly error?: string } {
  const context: Record<string, string | number> = {}
  for (const field of fields) {
    const raw = (values[field.name] ?? '').trim()
    if (raw.length === 0) {
      if (field.required) return { context, error: `请填写${field.label}。` }
      continue
    }
    if (field.kind === 'number') {
      const number = Number(raw)
      if (
        !Number.isFinite(number) ||
        (field.minimum !== undefined && number < field.minimum) ||
        (field.maximum !== undefined && number > field.maximum)
      ) {
        return { context, error: `${field.label}超出允许范围。` }
      }
      context[field.name] = number
    } else if (field.kind === 'decimal') {
      if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw))
        return { context, error: `${field.label}需要完整的小数字符串。` }
      context[field.name] = raw
    } else if (field.kind === 'enum') {
      if (!field.options.includes(raw)) return { context, error: `${field.label}不是已注册选项。` }
      context[field.name] = raw
    } else {
      context[field.name] = raw
    }
  }
  return { context }
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
    <details className="query__budget project-audit" data-testid="query-budget" data-known="true">
      <summary>共享预算与截止时间</summary>
      <h3>共享预算（澄清恢复不重置）</h3>
      <p data-testid="budget-tool-calls">
        剩余工具调用：<strong>{budget.toolCallsRemaining}</strong>
      </p>
      <p data-testid="budget-repair-attempts">
        剩余修复次数：<strong>{budget.repairAttemptsRemaining}</strong>
      </p>
      <p data-testid="budget-parallel-limit">并发上限：{budget.parallelToolLimit}</p>
      <p data-testid="budget-deadline">截止时间：{budget.deadline}</p>
    </details>
  )
}

function ScopePanel({ state }: { readonly state: QueryState }) {
  const scope = state.scope
  if (scope === undefined) return null
  return (
    <details className="query__scope project-audit" data-testid="query-scope">
      <summary>允许范围与已启用工具</summary>
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
        允许域名：
        {scope.allowedDomains.length === 0 ? '无（未授权任何域名）' : scope.allowedDomains.join('、')}
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
    </details>
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
        <p>结果为有限回答：仅包含已通过核验的事实，其余以缺口显式标注，未核验草稿不会被当作答案。</p>
      ) : null}
      {outcome === 'gap' ? <p>证据不足或数据过期：平台返回显式缺口，而不是编造答案。</p> : null}
      {outcome === 'conflict' ? <p>证据或核验冲突：平台不发布未经验证的内容，请补充澄清或数据。</p> : null}
      {outcome === 'tool_failure' ? <p>工具或平台失败：运行已失败，未生成核验答案。</p> : null}
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

function AnswerPanel({
  state,
  onEvidenceReference,
  loadSource,
}: {
  readonly state: QueryState
  readonly onEvidenceReference?: (ref: ResourceRef) => void
  readonly loadSource: AnswerSourceLoader
}) {
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
        <p data-testid="answer-unavailable">该运行在终态下没有已核验答案；未核验草稿不会作为答案展示。</p>
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
  const semanticReviewText =
    answer.semanticReview?.status === 'completed'
      ? '语义核验已完成。'
      : answer.semanticReview?.status === 'not_run'
        ? `语义核验未运行（${answer.semanticReview.reason}）；答案仅表示硬核验通过的内容。`
        : '该答案没有记录语义核验状态；不能推断语义核验已经完成。'
  return (
    <section className="query__answer" data-testid="query-answer" data-answer-state="published">
      <PublishedAnswerBody
        answer={answer}
        loadSource={loadSource}
        {...(onEvidenceReference === undefined ? {} : { onEvidenceReference })}
      />
      <p data-testid="answer-semantic-review" data-state={answer.semanticReview?.status ?? 'unknown'}>
        {semanticReviewText}
      </p>
      <details className="query__answer-audit" data-testid="answer-audit">
        <summary>答案审计信息</summary>
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
      </details>
    </section>
  )
}

export function QueryPanel({
  client,
  profileRef,
  timeZone,
  availableTasks = [],
  modelCapabilities,
  contextFields = EMPTY_CONTEXT_FIELDS,
  initialRunId,
  onEvidenceReference,
  readOnly = false,
  projectId,
  onSelectProject,
}: QueryPanelProps) {
  const viewport = useViewport()
  const projectContext = useProjectContext(client, projectId)
  const [catalogue, setCatalogue] = useState<ProjectTaskCatalogue>()
  const [catalogueError, setCatalogueError] = useState<unknown>()
  const [catalogueOwner, setCatalogueOwner] = useState<unknown>()
  const projectScope = useMemo(
    () => ({ client, id: projectContext.selectedId }),
    [client, projectContext.selectedId],
  )
  const begin = useRequestFence(projectScope)
  const actualCatalogue =
    catalogueOwner === projectScope && catalogue?.project.projectId === projectContext.selectedId
      ? catalogue
      : undefined
  const executionProfile = actualCatalogue?.revision.profileRef ?? profileRef
  const session = useRunSession(client, executionProfile, initialRunId, projectContext.selectedId ?? '')
  const { state, dispatch } = session
  const [question, setQuestion] = useState('')
  const [contextValues, setContextValues] = useState<Record<string, string>>(() =>
    initialContext(contextFields),
  )
  const [route, setRoute] = useState<RunRoutePreference>('auto')
  const [allowWeb, setAllowWeb] = useState(false)
  const [clarificationInput, setClarificationInput] = useState('')
  const [selectedSource, setSelectedSource] = useState<ResourceRef>()
  const loadSource = useCallback<AnswerSourceLoader>(
    (answer, reference, signal) => client.getAnswerSource(answer, reference, signal),
    [client],
  )
  useEffect(() => {
    setCatalogue(undefined)
    setCatalogueError(undefined)
    if (projectContext.selectedId === undefined) return
    const request = begin('tasks')
    void readProjectTasks(client, projectContext.selectedId, request.signal)
      .then((actual) => {
        if (request.current()) {
          setCatalogue(actual)
          setCatalogueOwner(projectScope)
        }
      })
      .catch((caught: unknown) => {
        if (request.current()) setCatalogueError(caught)
      })
  }, [client, projectContext.selectedId, begin, projectScope])
  useEffect(() => {
    setQuestion('')
    setClarificationInput('')
    setSelectedSource(undefined)
    setContextValues(initialContext(contextFields))
  }, [profileRef.id, profileRef.version, projectContext.selectedId, contextFields])

  const ask = async () => {
    if (readOnly) return
    if (projectContext.selectedId !== undefined && actualCatalogue === undefined) {
      dispatch({ type: 'notice', message: '当前项目的任务目录尚未就绪。' })
      return
    }
    if (question.trim().length === 0) {
      dispatch({ type: 'notice', message: '请输入问题后再提交。' })
      return
    }
    const parsed = contextFromFields(contextFields, contextValues)
    if (parsed.error !== undefined) {
      dispatch({ type: 'notice', message: parsed.error })
      return
    }
    await session.create({
      profileRef: { id: executionProfile.id, version: executionProfile.version },
      question: question.trim(),
      context: { timeZone, ...parsed.context },
      preferences: { route, allowWeb: state.scope?.webSearchEnabled === true && allowWeb },
      ...(projectContext.selectedId === undefined ? {} : { projectId: projectContext.selectedId }),
    })
  }
  const respond = async () => {
    if (!clarificationInput.trim()) {
      dispatch({ type: 'notice', message: '请输入澄清内容。' })
      return
    }
    if (await session.respond({ answer: clarificationInput.trim() })) setClarificationInput('')
  }
  const cancel = session.cancel

  const phase = state.phase
  const webAllowed = state.scope?.webSearchEnabled === true
  const run = state.run

  return (
    <section
      className={`query query--${viewport} project-page`}
      data-testid="query-panel"
      data-viewport={viewport}
      data-phase={phase}
      data-outcome={state.outcome}
    >
      <header className="project-page__head">
        <div>
          <h2>业务问答</h2>
          <p className="panel__hint">
            在场景允许范围内提问；只展示可审计进度与已验证数据，未核验草稿不会作为答案发送。
          </p>
          {availableTasks.length === 0 ? null : (
            <p className="panel__hint" data-testid="query-capability-note">
              当前提供 {availableTasks.length} 项已注册任务。问题将按本场景的实际能力处理。
              {modelCapabilities === undefined
                ? '模型配置状态未知。'
                : `文本生成${modelCapabilities.generation ? '已配置' : '未启用'}；智能路由${modelCapabilities.decision ? '已配置' : '未启用'}。`}
            </p>
          )}
        </div>
        {readOnly ? <span className="project-state">只读</span> : null}
      </header>

      {phase === 'loading' ||
      phase === 'not_configured' ||
      phase === 'failure' ||
      phase === 'permission_denied' ? (
        <StatePanel
          phase={phase}
          {...(state.error === undefined ? {} : { error: state.error })}
          {...(phase === 'failure'
            ? { onRecover: () => void session.recover(), recoverLabel: '核对当前运行状态' }
            : {})}
        />
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
              <ProjectContextPicker
                context={projectContext}
                onSelect={(id) => {
                  projectContext.select(id)
                  onSelectProject?.(id)
                }}
              />
              {catalogueError === undefined ? null : <ProjectNotice error={catalogueError} />}
              {actualCatalogue === undefined ? null : (
                <p className="project-source-note">
                  可查询：
                  {actualCatalogue.tasks
                    .filter((task) => task.available)
                    .map((task) => task.displayName)
                    .join('、') || '当前项目尚无就绪的任务'}
                </p>
              )}
              {availableTasks.length === 0 ? null : (
                <details className="project-audit">
                  <summary>已注册快捷读取格式</summary>
                  <label className="query__field">
                    <span>已注册读取任务</span>
                    <select
                      name="registeredTask"
                      data-testid="query-registered-task"
                      value={availableTasks.includes(question) ? question : ''}
                      onChange={(event) => setQuestion(event.target.value)}
                    >
                      <option value="">选择一个任务以填入问题</option>
                      {availableTasks.map((task) => (
                        <option key={task} value={task}>
                          {task}
                        </option>
                      ))}
                    </select>
                  </label>
                </details>
              )}
              <label className="query__field">
                <span>问题</span>
                <textarea
                  name="question"
                  data-testid="query-question"
                  value={question}
                  placeholder="描述要核对的对象、条件或原始资料问题"
                  disabled={readOnly}
                  onChange={(event) => setQuestion(event.target.value)}
                />
              </label>
              {contextFields.map((field) => (
                <label className="query__field" key={field.name}>
                  <span>
                    {field.label}
                    {field.required ? ' *' : ''}
                  </span>
                  {field.kind === 'enum' ? (
                    <select
                      name={field.name}
                      data-testid={`query-context-${field.name}`}
                      value={contextValues[field.name] ?? ''}
                      onChange={(event) =>
                        setContextValues((current) => ({ ...current, [field.name]: event.target.value }))
                      }
                    >
                      {!field.required ? <option value="">未指定</option> : null}
                      {field.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={field.kind === 'number' ? 'number' : 'text'}
                      name={field.name}
                      data-testid={`query-context-${field.name}`}
                      value={contextValues[field.name] ?? ''}
                      {...(field.kind === 'number' && field.minimum !== undefined
                        ? { min: field.minimum }
                        : {})}
                      {...(field.kind === 'number' && field.maximum !== undefined
                        ? { max: field.maximum }
                        : {})}
                      onChange={(event) =>
                        setContextValues((current) => ({ ...current, [field.name]: event.target.value }))
                      }
                    />
                  )}
                </label>
              ))}
              <details className="project-audit">
                <summary>执行选项</summary>
                <label className="query__field">
                  <span>执行路径</span>
                  <select
                    name="route"
                    data-testid="query-route"
                    value={route}
                    onChange={(event) => setRoute(event.target.value as RunRoutePreference)}
                  >
                    <option value="auto">自动选择</option>
                    <option value="template">已注册任务路径</option>
                    <option value="pi">规划运行时</option>
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
                  <span>允许 Web 搜索{webAllowed ? '' : '（场景未启用，不可选择）'}</span>
                </label>
              </details>
              <button
                type="submit"
                data-testid="query-ask"
                disabled={
                  state.busy ||
                  readOnly ||
                  (projectContext.selectedId !== undefined && actualCatalogue === undefined)
                }
              >
                {state.busy ? '正在提交…' : '开始查询'}
              </button>
            </form>

            {run === undefined ? null : (
              <section className="query__run" data-testid="query-run" data-state={run.state}>
                {initialRunId === run.runId ? (
                  <p className="project-source-note">
                    正在查看已有运行；结果按当时的输入与版本保存。新查询使用当前选择的项目。
                  </p>
                ) : null}
                <h3>运行进度</h3>
                <p data-testid="run-state">
                  运行状态：<strong>{runStatusLabel(run.state)}</strong>
                </p>
                <details className="project-audit">
                  <summary>运行版本</summary>
                  <p data-testid="run-revision">修订：{run.revision}</p>
                  <code>{run.runId}</code>
                  <p>{run.state}</p>
                </details>

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
                  <div
                    className="query__clarification"
                    data-testid="query-clarification"
                    data-revision={run.revision}
                  >
                    <h4>需要澄清</h4>
                    <p data-testid="clarification-question">请补充对象、条件或范围，以继续本次查询。</p>
                    <details className="project-audit">
                      <summary>补充请求标识</summary>
                      <code>{state.clarification.clarificationId}</code>
                      <p>{state.clarification.questionType}</p>
                    </details>
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
                    <button
                      type="button"
                      data-testid="clarification-submit"
                      disabled={state.busy}
                      onClick={() => void respond()}
                    >
                      提交澄清并继续
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
                  取消运行
                </button>

                {state.notice === undefined ? null : (
                  <p className="query__notice" data-testid="query-notice" role="status">
                    {state.notice}
                  </p>
                )}

                <OutcomePanel state={state} />
                <AnswerPanel state={state} onEvidenceReference={setSelectedSource} loadSource={loadSource} />
              </section>
            )}
          </div>
        </>
      ) : null}
      <Drawer
        open={selectedSource !== undefined && state.answer !== undefined}
        title="答案来源"
        onClose={() => setSelectedSource(undefined)}
      >
        {selectedSource === undefined || state.answer === undefined ? null : (
          <>
            <FixedAnswerSource answer={state.answer} reference={selectedSource} loadSource={loadSource} />
            {onEvidenceReference === undefined ? null : (
              <Button variant="quiet" onClick={() => onEvidenceReference(selectedSource)}>
                查看完整来源页面
              </Button>
            )}
          </>
        )}
      </Drawer>
    </section>
  )
}
