import { useEffect, useMemo, useState } from 'react'
import type { ProfileRef, PublishedAnswer, ResourceRef, VersionRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import type { ResultSource } from '../api/results'
import type { AssistantModuleDeclarations } from './AssistantShell'
import type { ScenarioMount } from '../mount/registry'
import { ScenarioModuleRegistry } from '../mount/registry'
import type { QueryOutcome } from '../state/query'
import { useRunSession } from './project/useRunSession'
import './project/project-workbench.css'
import { classifyPublicError } from '../state/public-errors'
import { PublicStateNotice } from './PublicStateNotice'
import { ResultWorkbenchPanel } from './ResultWorkbenchPanel'
import { ProjectContextPicker, useProjectContext } from './project/ProjectContextPicker'
import { readProjectTasks } from '../api/project-workbench'
import type { ProjectTaskCatalogue } from '../api/project-workbench'
import { TaskRunForm } from './project/TaskRunForm'
import { useRequestFence } from './project/useRequestFence'
import { ProjectNotice } from './project/ProjectNotice'
import { Button } from './ui'
import { runStatusLabel } from '../state/project-labels'

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
  readonly projectId?: string
  readonly onSelectProject?: (projectId: string | undefined) => void
}

const EMPTY_DECLARATIONS: AssistantModuleDeclarations = { ontology: [], business: [] }

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
      <h3>当前场景入口</h3>
      {tasks.length === 0 ? (
        <p data-testid="business-task-empty">当前场景没有额外的快捷入口。</p>
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
  projectId,
  onSelectProject,
}: BusinessWorkbenchPanelProps) {
  const projectContext = useProjectContext(client, projectId)
  const selectedProjectId = projectContext.selectedId
  const [taskCatalogue, setTaskCatalogue] = useState<ProjectTaskCatalogue>()
  const [catalogueError, setCatalogueError] = useState<unknown>()
  const [catalogueOwner, setCatalogueOwner] = useState<unknown>()
  const [selectedTaskKey, setSelectedTaskKey] = useState<string>()
  const catalogueScope = useMemo(() => ({ client, selectedProjectId }), [client, selectedProjectId])
  const begin = useRequestFence(catalogueScope)
  const actualCatalogue =
    catalogueOwner === catalogueScope && taskCatalogue?.project.projectId === selectedProjectId
      ? taskCatalogue
      : undefined
  const executionProfile = actualCatalogue?.revision.profileRef ?? profileRef
  const session = useRunSession(client, executionProfile, initialRunId, selectedProjectId ?? '')
  const { state, dispatch } = session
  const [question, setQuestion] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | undefined>()
  const [clarificationInput, setClarificationInput] = useState('')
  useEffect(() => {
    setQuestion('')
    setSelectedKey(undefined)
    setSelectedTaskKey(undefined)
    setClarificationInput('')
  }, [profileRef.id, profileRef.version, selectedProjectId])
  useEffect(() => {
    setTaskCatalogue(undefined)
    setCatalogueError(undefined)
    setSelectedTaskKey(undefined)
    if (selectedProjectId === undefined) return
    const request = begin('catalogues')
    void readProjectTasks(client, selectedProjectId, request.signal)
      .then((tasks) => {
        if (request.current()) {
          setTaskCatalogue(tasks)
          setCatalogueOwner(catalogueScope)
        }
      })
      .catch((caught: unknown) => {
        if (request.current()) setCatalogueError(caught)
      })
  }, [client, selectedProjectId, begin, catalogueScope])
  const selectedTask = actualCatalogue?.tasks.find(
    (task) =>
      `${task.bindingRef.id}:${task.bindingRef.version}:${task.bindingRef.digest}` === selectedTaskKey,
  )
  const activeObjects =
    selectedTask?.objects?.flatMap((object) =>
      object.attributes === undefined
        ? []
        : [{ objectId: object.objectId, displayName: object.displayName, attributes: object.attributes }],
    ) ?? []

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

  const selectTask = (task: BusinessViewTask) => {
    setSelectedKey(task.key)
    setQuestion(task.label)
  }

  const ask = async () => {
    if (question.trim().length === 0) {
      dispatch({ type: 'notice', message: '请输入问题或选择一个任务。' })
      return
    }
    if (readOnly || (selectedProjectId !== undefined && actualCatalogue === undefined)) return
    await session.create({
      profileRef: { id: executionProfile.id, version: executionProfile.version },
      question: question.trim(),
      context: { timeZone },
      preferences: { route: 'auto', allowWeb: false },
      ...(selectedProjectId === undefined ? {} : { projectId: selectedProjectId }),
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

  const run = state.run
  const answer: PublishedAnswer | undefined = state.answer

  return (
    <section
      className="business-workbench project-page"
      data-testid="business-workbench"
      data-phase={state.phase}
      data-outcome={state.outcome}
    >
      <header className="project-page__head">
        <div>
          <h2>业务工作台</h2>
          <p className="panel__hint">
            选择当前项目与可用任务，或直接描述问题。结果会附上可以核对的原始来源。
          </p>
        </div>
        {readOnly ? <span className="project-state">只读</span> : null}
      </header>

      <div className="project-task-layout">
        <div className="project-canvas">
          <div className="project-canvas__body">
            <ProjectContextPicker
              context={projectContext}
              onSelect={(id) => {
                projectContext.select(id)
                onSelectProject?.(id)
              }}
            />
            {catalogueError === undefined ? null : <ProjectNotice error={catalogueError} />}
            {selectedProjectId === undefined ? (
              <TaskList
                tasks={tasks}
                unavailable={unavailable}
                readOnly={readOnly}
                selectedKey={selectedKey}
                onSelect={selectTask}
              />
            ) : (
              <section data-testid="business-task-list">
                <h3>当前项目可用任务</h3>
                {actualCatalogue === undefined ? (
                  <p role="status">
                    {catalogueError === undefined ? '正在读取实际任务与就绪状态…' : '任务目录当前不可用。'}
                  </p>
                ) : (
                  <ul className="project-task-list">
                    {actualCatalogue.tasks.map((task) => {
                      const key = `${task.bindingRef.id}:${task.bindingRef.version}:${task.bindingRef.digest}`
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            data-testid="task-entry"
                            data-task-id={task.bindingRef.id}
                            aria-pressed={key === selectedTaskKey}
                            disabled={readOnly || !task.available}
                            onClick={() => setSelectedTaskKey(key)}
                          >
                            <strong>{task.displayName}</strong>
                            <small>
                              {task.available ? '已就绪' : task.unavailableReasons.join('；') || '尚未就绪'}
                            </small>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>
            )}

            {selectedTask === undefined ? (
              <>
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
                      disabled={readOnly}
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
                          <option key={task} value={task}>
                            {task}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <button
                    type="submit"
                    data-testid="business-run"
                    disabled={
                      state.busy ||
                      readOnly ||
                      (selectedProjectId !== undefined && actualCatalogue === undefined)
                    }
                  >
                    运行
                  </button>
                </form>
              </>
            ) : (
              <>
                <Button variant="quiet" onClick={() => setSelectedTaskKey(undefined)}>
                  返回普通问题
                </Button>
                <TaskRunForm
                  key={`${selectedProjectId}:${actualCatalogue?.revision.ref.digest}:${selectedTaskKey}`}
                  task={selectedTask}
                  objects={activeObjects}
                  disabled={state.busy || readOnly}
                  onRun={async (parameters, inputSelection) => {
                    if (selectedProjectId === undefined || !selectedTask.available) return
                    await session.create({
                      profileRef: { id: executionProfile.id, version: executionProfile.version },
                      projectId: selectedProjectId,
                      question: selectedTask.displayName,
                      context: { timeZone },
                      preferences: { route: 'auto', allowWeb: false },
                      task: { bindingRef: selectedTask.bindingRef, arguments: parameters },
                      ...(inputSelection === undefined ? {} : { inputSelection }),
                    })
                  }}
                />
              </>
            )}

            {modelCapabilities === undefined ? null : (
              <p data-testid="business-model-note">
                文本生成{modelCapabilities.generation ? '已配置' : '未启用'}；智能判断
                {modelCapabilities.decision ? '已配置' : '未启用'}。
              </p>
            )}
          </div>
        </div>
        <div className="project-canvas">
          <div className="project-canvas__body">
            {state.phase === 'loading' ? (
              <p data-testid="business-state" data-phase={state.phase} role="status">
                正在加载可用任务…
              </p>
            ) : null}
            {state.error !== undefined &&
            (state.phase === 'failure' ||
              state.phase === 'not_configured' ||
              state.phase === 'permission_denied') ? (
              <PublicStateNotice
                testId="business-state"
                failure={classifyPublicError(state.error)}
                {...(state.phase === 'failure'
                  ? { onRecover: () => void session.recover(), recoverLabel: '核对当前运行状态' }
                  : {})}
              />
            ) : null}

            {run === undefined ? null : (
              <section
                className="business-workbench__run"
                data-testid="business-run-panel"
                data-state={run.state}
              >
                {initialRunId === run.runId ? <p className="project-source-note">正在查看已有运行；结果按当时的输入与版本保存。新查询使用当前选择的项目。</p> : null}
                <p data-testid="business-run-state">
                  <strong>{runStatusLabel(run.state)}</strong>
                </p>
                <details className="project-audit">
                  <summary>运行版本</summary>
                  <code>{run.runId}</code>
                  <p>修订 {run.revision}</p>
                  <p>{run.state}</p>
                </details>
                <ol data-testid="business-progress" data-count={state.events.length}>
                  {state.events.map((entry, index) => (
                    <li
                      key={`${entry.id}-${index}`}
                      data-testid="business-progress-entry"
                      data-event={entry.event}
                    >
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
                    <p data-testid="business-clarification-question">
                      请补充对象、条件或范围，以继续本次查询。
                    </p>
                    <details className="project-audit">
                      <summary>补充请求标识</summary>
                      <code>{state.clarification.clarificationId}</code>
                      <p>{state.clarification.questionType}</p>
                    </details>
                    <input
                      type="text"
                      name="clarification"
                      data-testid="business-clarification-input"
                      value={clarificationInput}
                      onChange={(event) => setClarificationInput(event.target.value)}
                    />
                    <button
                      type="button"
                      data-testid="business-clarification-submit"
                      disabled={state.busy}
                      onClick={() => void respond()}
                    >
                      补充说明并继续
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
                resolveLabel={(id, kind) =>
                  run.profileRef.id !== executionProfile.id ||
                  run.profileRef.version !== executionProfile.version
                    ? undefined
                    : kind === 'subject'
                      ? actualCatalogue?.tasks
                          .flatMap((task) => task.objects ?? [])
                          .flatMap((object) => object.entities ?? [])
                          .find((entity) => entity.entityId === id)?.displayName
                      : actualCatalogue?.tasks
                          .flatMap((task) => task.objects ?? [])
                          .flatMap((object) => object.attributes ?? [])
                          .find((field) => field.attributeId === id)?.displayName
                }
              />
            )}
            {run === undefined && state.error === undefined ? (
              <div className="project-source-reader">
                <h3>从一个业务问题开始</h3>
                <p>选择当前可用任务或输入问题。运行完成后，这里显示核验结论、结果表与逐项来源。</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
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
