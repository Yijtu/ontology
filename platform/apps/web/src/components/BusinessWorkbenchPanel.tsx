import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ProfileRef, PublishedAnswer, ResourceRef, VersionRef } from '@ontology/contracts'
import { ApiError } from '../api/errors'
import type { QueryRunView, RunEventStream, WorkbenchClient } from '../api/client'
import type { ResultSource } from '../api/results'
import type { AssistantModuleDeclarations } from './AssistantShell'
import type { ScenarioMount } from '../mount/registry'
import { ScenarioModuleRegistry } from '../mount/registry'
import { initialQueryState, queryReducer } from '../state/query'
import type { QueryOutcome } from '../state/query'
import type { WorkbenchError } from '../state/workbench'
import { classifyPublicError } from '../state/public-errors'
import { PublicStateNotice } from './PublicStateNotice'
import { ResultWorkbenchPanel } from './ResultWorkbenchPanel'

/**
 * The public business workbench (SPEC v0.3a asset-data-ui §9.1/§9.2, execution-evidence §EX-2,
 * issue V03-040 / #212). It lists the tasks that are actually mounted AND authorized (the registry
 * mount decision, never an industry-name branch), lets a user run a plain-NL or registered task,
 * and requires an explicit confirmation of a parameter change before the run is submitted. The
 * progress/clarification/cancel states reuse the same reducer and shared budget as the query
 * surface, and on publication the typed-result workbench renders 正文/结果表/依据 for the same
 * verified version.
 */

export interface BusinessViewTask {
  readonly key: string
  readonly label: string
  readonly taskBindingRef: VersionRef
  readonly moduleId: string
}

export interface BusinessUnavailableTask {
  readonly moduleRef: string
  readonly reason: string
}

export interface ParameterChangePreview {
  readonly field: string
  readonly previous: string
  readonly proposed: string
  readonly reason: string
}

export interface BusinessWorkbenchPanelProps {
  readonly client: WorkbenchClient
  readonly registry: ScenarioModuleRegistry
  readonly profileRef: ProfileRef
  readonly timeZone: string
  readonly declarations?: AssistantModuleDeclarations
  readonly grantedCapabilities: readonly string[]
  readonly allowedModuleRefs?: readonly VersionRef[]
  readonly readOnly?: boolean
  readonly availableTasks?: readonly string[]
  readonly resultSource?: ResultSource
  /** Deep-linked run id (`?run=<id>`) so a clarification/published state can be reproduced. */
  readonly initialRunId?: string
  readonly modelCapabilities?: { readonly generation: boolean; readonly decision: boolean }
  readonly onOpenSource?: (ref: ResourceRef) => void
}

const EMPTY_DECLARATIONS: AssistantModuleDeclarations = { ontology: [], business: [] }

function toWorkbenchError(error: unknown): WorkbenchError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      missingCapabilities: error.missingCapabilities,
      ...(error.traceId === undefined ? {} : { traceId: error.traceId }),
      ...(error.reasons.length === 0 ? {} : { reasons: error.reasons }),
    }
  }
  return { code: 'NETWORK_ERROR', message: error instanceof Error ? error.message : '请求失败', retryable: true }
}

const OUTCOME_LABELS: Readonly<Record<QueryOutcome, string>> = {
  pending: '进行中',
  normal: '正常回答',
  limited: '有限回答',
  gap: '数据缺口',
  conflict: '证据冲突',
  tool_failure: '工具失败',
  cancelled: '已取消',
}

function isTerminal(state: string): boolean {
  return state === 'published' || state === 'cancelled' || state === 'failed' || state === 'blocked'
}

function moduleRefKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}`
}

function TaskList({
  tasks,
  unavailable,
  readOnly,
  selectedKey,
  onSelect,
}: {
  readonly tasks: readonly BusinessViewTask[]
  readonly unavailable: readonly BusinessUnavailableTask[]
  readonly readOnly: boolean
  readonly selectedKey: string | undefined
  readonly onSelect: (task: BusinessViewTask) => void
}) {
  return (
    <section className="business-workbench__tasks" data-testid="business-task-list" data-count={tasks.length}>
      <h3>可用任务（已挂载且已授权）</h3>
      {tasks.length === 0 ? (
        <p data-testid="business-task-empty">当前没有已挂载且已授权的任务。</p>
      ) : (
        <ul>
          {tasks.map((task) => (
            <li key={task.key}>
              <button
                type="button"
                data-testid="task-entry"
                data-task-id={task.taskBindingRef.id}
                data-active={selectedKey === task.key}
                disabled={readOnly}
                onClick={() => onSelect(task)}
              >
                {task.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {unavailable.length === 0 ? null : (
        <ul className="business-workbench__unavailable" data-testid="business-task-unavailable">
          {unavailable.map((entry) => (
            <li key={entry.moduleRef} data-testid="task-unavailable">
              {entry.moduleRef}：{entry.reason}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function BusinessWorkbenchPanel({
  client,
  registry,
  profileRef,
  timeZone,
  declarations = EMPTY_DECLARATIONS,
  grantedCapabilities,
  allowedModuleRefs,
  readOnly = false,
  availableTasks = [],
  resultSource,
  initialRunId,
  modelCapabilities,
  onOpenSource,
}: BusinessWorkbenchPanelProps) {
  const [state, dispatch] = useReducer(queryReducer, undefined, initialQueryState)
  const [question, setQuestion] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  const [parameterValue, setParameterValue] = useState('')
  const [confirmedValue, setConfirmedValue] = useState<string | undefined>()
  const [pendingChange, setPendingChange] = useState<ParameterChangePreview | undefined>()
  const [clarificationInput, setClarificationInput] = useState('')
  const streamRef = useRef<RunEventStream | undefined>(undefined)

  const { tasks, unavailable } = useMemo(() => {
    const context = {
      grantedCapabilities,
      ...(allowedModuleRefs === undefined ? {} : { allowedModuleRefs }),
      readOnly,
    }
    const mounts = declarations.business.map((declaration) => registry.mount(declaration, context))
    const resolvedTasks: BusinessViewTask[] = []
    const failures: BusinessUnavailableTask[] = []
    for (const mount of mounts) {
      if (mount.kind !== 'mounted') {
        failures.push({ moduleRef: mountFailureRef(mount), reason: mountFailureReason(mount) })
        continue
      }
      for (const entry of mount.view.taskEntries) {
        resolvedTasks.push({
          key: `${moduleRefKey(mount.module.ref)}::${entry.taskBindingRef.id}`,
          label: entry.label,
          taskBindingRef: entry.taskBindingRef,
          moduleId: mount.module.ref.id,
        })
      }
    }
    return { tasks: resolvedTasks, unavailable: failures }
  }, [registry, declarations, grantedCapabilities, allowedModuleRefs, readOnly])

  const closeStream = useCallback(() => {
    streamRef.current?.close()
    streamRef.current = undefined
  }, [])

  const loadAnswer = useCallback(
    async (runId: string) => {
      try {
        dispatch({ type: 'answerLoaded', result: await client.getAnswer(runId) })
      } catch (error) {
        dispatch({ type: 'failed', error: toWorkbenchError(error) })
      }
    },
    [client],
  )

  const refreshRun = useCallback(
    async (runId: string) => {
      try {
        dispatch({ type: 'runLoaded', run: await client.getRun(runId) })
      } catch (error) {
        dispatch({ type: 'failed', error: toWorkbenchError(error) })
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

  const reloadScope = useCallback(async () => {
    dispatch({ type: 'scopeLoadStarted' })
    try {
      dispatch({ type: 'scopeLoaded', scope: await client.getRunScope(profileRef) })
    } catch (error) {
      dispatch({ type: 'failed', error: toWorkbenchError(error) })
    }
  }, [client, profileRef])

  useEffect(() => {
    void reloadScope()
    return () => {
      closeStream()
    }
  }, [reloadScope, closeStream])

  useEffect(() => {
    if (initialRunId === undefined) return
    let cancelled = false
    void (async () => {
      try {
        const view = await client.getRun(initialRunId)
        if (cancelled) return
        dispatch({ type: 'runLoaded', run: view })
        openStream(initialRunId)
        void loadAnswer(initialRunId)
      } catch (error) {
        if (!cancelled) dispatch({ type: 'failed', error: toWorkbenchError(error) })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, initialRunId, openStream, loadAnswer])

  const selectTask = (task: BusinessViewTask) => {
    setSelectedKey(task.key)
    setQuestion(task.label)
    setPendingChange(undefined)
    setConfirmedValue(undefined)
    setParameterValue('')
  }

  const previewChange = () => {
    setPendingChange({
      field: selectedKey === undefined ? '参数' : `${selectedKey}.parameter`,
      previous: confirmedValue ?? parameterValue,
      proposed: parameterValue,
      reason: '用户修改任务参数',
    })
  }

  const confirmChange = () => {
    if (pendingChange === undefined) return
    setConfirmedValue(pendingChange.proposed)
    setPendingChange(undefined)
  }

  const ask = async () => {
    if (question.trim().length === 0) {
      dispatch({ type: 'notice', message: '请输入问题或选择一个任务。' })
      return
    }
    dispatch({ type: 'askStarted' })
    try {
      const created = await client.createRun({
        profileRef,
        question: question.trim(),
        context: { timeZone },
        preferences: { route: 'auto', allowWeb: false },
      })
      dispatch({ type: 'runLoaded', run: await client.getRun(created.runId) })
      openStream(created.runId)
      void loadAnswer(created.runId)
    } catch (error) {
      const apiError = error instanceof ApiError ? error : undefined
      if (apiError?.permissionDenied === true) {
        dispatch({ type: 'permissionDenied', error: toWorkbenchError(error) })
      } else if (apiError?.code === 'CAPABILITY_NOT_CONFIGURED') {
        dispatch({ type: 'notConfigured', error: toWorkbenchError(error) })
      } else {
        dispatch({ type: 'failed', error: toWorkbenchError(error) })
      }
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
      dispatch({ type: 'failed', error: toWorkbenchError(error) })
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
      dispatch({ type: 'failed', error: toWorkbenchError(error) })
    }
  }

  const run = state.run
  const answer: PublishedAnswer | undefined = state.answer
  const parameterDirty = selectedKey !== undefined && parameterValue !== (confirmedValue ?? '')

  return (
    <section
      className="business-workbench"
      data-testid="business-workbench"
      data-phase={state.phase}
      data-outcome={state.outcome}
    >
      <header className="panel__header">
        <h2>业务工作台</h2>
        <p className="panel__hint">
          仅列出已挂载且已授权的任务；普通问题与快捷任务调用同一任务注册表。
          生成与解释不会新增未经核验的主体、数值、关系或规则结论。
        </p>
      </header>

      <TaskList
        tasks={tasks}
        unavailable={unavailable}
        readOnly={readOnly}
        selectedKey={selectedKey}
        onSelect={selectTask}
      />

      <form
        className="business-workbench__ask"
        data-testid="business-ask-form"
        onSubmit={(event) => {
          event.preventDefault()
          void ask()
        }}
      >
        <label className="business-workbench__field">
          <span>问题或任务</span>
          <textarea
            name="question"
            data-testid="business-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>

        {availableTasks.length === 0 ? null : (
          <label className="business-workbench__field">
            <span>已注册读取任务</span>
            <select
              name="registeredTask"
              data-testid="business-registered-task"
              value={availableTasks.includes(question) ? question : ''}
              onChange={(event) => setQuestion(event.target.value)}
            >
              <option value="">选择任务</option>
              {availableTasks.map((task) => (
                <option key={task} value={task}>{task}</option>
              ))}
            </select>
          </label>
        )}

        <label className="business-workbench__field">
          <span>参数</span>
          <input
            type="text"
            name="parameter"
            data-testid="business-parameter"
            value={parameterValue}
            disabled={readOnly}
            onChange={(event) => {
              setParameterValue(event.target.value)
              setConfirmedValue(undefined)
            }}
          />
        </label>
        <button type="button" data-testid="business-parameter-preview" disabled={readOnly || !parameterDirty} onClick={previewChange}>
          预览参数变更
        </button>

        {pendingChange === undefined ? null : (
          <div className="business-workbench__diff" data-testid="business-parameter-diff" role="alert">
            <h4>参数变更确认</h4>
            <p data-testid="diff-field">字段：{pendingChange.field}</p>
            <p data-testid="diff-previous">原值：{pendingChange.previous === '' ? '（空）' : pendingChange.previous}</p>
            <p data-testid="diff-proposed">新值：{pendingChange.proposed === '' ? '（空）' : pendingChange.proposed}</p>
            <p data-testid="diff-reason">作用记录：{pendingChange.reason}</p>
            <button type="button" data-testid="business-parameter-confirm" onClick={confirmChange}>
              确认变更
            </button>
            <button type="button" data-testid="business-parameter-cancel" onClick={() => setPendingChange(undefined)}>
              取消
            </button>
          </div>
        )}
        {confirmedValue === undefined ? null : (
          <p data-testid="business-parameter-confirmed" role="status">
            参数已确认：{confirmedValue === '' ? '（空）' : confirmedValue}
          </p>
        )}

        <button type="submit" data-testid="business-run" disabled={state.busy || readOnly}>
          运行
        </button>
      </form>

      {modelCapabilities === undefined ? null : (
        <p data-testid="business-model-note">
          Company生成{modelCapabilities.generation ? '已配置' : '未启用'}；JEV决策{modelCapabilities.decision ? '已配置' : '未启用'}。
        </p>
      )}

      {state.phase === 'loading' ? (
        <p data-testid="business-state" data-phase={state.phase} role="status">
          正在加载可用任务…
        </p>
      ) : null}
      {state.error !== undefined && (state.phase === 'failure' || state.phase === 'not_configured' || state.phase === 'permission_denied') ? (
        <PublicStateNotice
          testId="business-state"
          failure={classifyPublicError(state.error)}
          {...(state.phase === 'failure' ? { onRecover: () => void reloadScope() } : {})}
        />
      ) : null}

      {run === undefined ? null : (
        <section className="business-workbench__run" data-testid="business-run-panel" data-state={run.state}>
          <p data-testid="business-run-state">
            运行状态：<strong>{run.state}</strong>（修订 {run.revision}）
          </p>
          <ol data-testid="business-progress" data-count={state.events.length}>
            {state.events.map((entry, index) => (
              <li key={`${entry.id}-${index}`} data-testid="business-progress-entry" data-event={entry.event}>
                {entry.label}
              </li>
            ))}
          </ol>
          {state.rejectedEvents.length === 0 ? null : (
            <p data-testid="business-rejected-events" role="alert">
              已忽略非公开事件：{state.rejectedEvents.join('、')}
            </p>
          )}
          {state.notice === undefined ? null : (
            <p data-testid="business-notice" role="status">
              {state.notice}
            </p>
          )}
          {state.clarification === undefined ? null : (
            <div className="business-workbench__clarification" data-testid="business-clarification">
              <h4>需要澄清</h4>
              <p data-testid="business-clarification-question">{state.clarification.questionType}：{state.clarification.clarificationId}</p>
              <input
                type="text"
                name="clarification"
                data-testid="business-clarification-input"
                value={clarificationInput}
                onChange={(event) => setClarificationInput(event.target.value)}
              />
              <button type="button" data-testid="business-clarification-submit" disabled={state.busy} onClick={() => void respond()}>
                提交澄清（If-Match {run.revision}）
              </button>
            </div>
          )}
          <button
            type="button"
            data-testid="business-cancel"
            disabled={state.busy || isTerminal(run.state)}
            onClick={() => void cancel()}
          >
            取消运行
          </button>
          <p data-testid="business-outcome" data-outcome={state.outcome}>
            结果：{OUTCOME_LABELS[state.outcome]}
          </p>
        </section>
      )}

      {answer === undefined || resultSource === undefined || run === undefined ? null : (
        <ResultWorkbenchPanel
          source={resultSource}
          runId={run.runId}
          {...(onOpenSource === undefined ? {} : { onOpenEvidence: onOpenSource })}
        />
      )}
    </section>
  )
}

function mountFailureRef(mount: ScenarioMount): string {
  switch (mount.kind) {
    case 'illegal_metadata':
      return 'illegal-metadata'
    case 'missing_module':
    case 'missing_capability':
    case 'forbidden':
      return moduleRefKey(mount.moduleRef)
    case 'mounted':
      return ''
  }
}

function mountFailureReason(mount: ScenarioMount): string {
  switch (mount.kind) {
    case 'illegal_metadata':
      return '挂载声明非法'
    case 'missing_module':
      return '专业视图未注册'
    case 'missing_capability':
      return `缺少能力：${mount.missing.join('、')}`
    case 'forbidden':
      return '无权挂载该场景'
    case 'mounted':
      return ''
  }
}
