import { useState } from 'react'
import type { IndustryWorkspace, ProjectRecord } from '@ontology/contracts'
import type { AppView } from './App'
import { Button, DataTable, Drawer, Field, Panel, StateFeedback, StatusBadge } from './ui'
import './FunctionGuide.css'

export interface GuideStep { readonly key: string; readonly label: string; readonly view: AppView; readonly description: string }
export interface GuideCard { readonly key: string; readonly label: string; readonly view: AppView; readonly description: string }

/** The three source entries of the knowledge workbench (design §1.1/§1.3). */
export type SourceEntry = 'research' | 'upload' | 'structured'

export interface GuideHomeProps {
  readonly scenarioLabel: string
  readonly classificationLabel: string
  readonly operatorEnabled: boolean
  readonly onNavigate: (view: AppView) => void
  readonly workspaces?: readonly IndustryWorkspace[]
  readonly projects?: readonly ProjectRecord[]
  readonly workspacePhase?: 'idle' | 'loading' | 'ready' | 'failure'
  readonly projectPhase?: 'idle' | 'loading' | 'ready' | 'failure'
  readonly onRetry?: () => void
  readonly onSelectWorkspace?: (value: string | undefined) => void
  readonly onSelectProject?: (value: string | undefined) => void
  readonly onConfigureModel?: () => void
  readonly selectedWorkspaceId?: string
  readonly selectedProjectId?: string
  readonly onCreateWorkspace?: (goal: string) => void
  readonly onCreateProject?: () => void
  /** Opens the shared structured file-mapping intake (project data step) from the source entry. */
  readonly onStructuredIntake?: () => void
}

const PATH_STEPS: readonly GuideStep[] = [
  { key: 'import', label: '资料导入', view: 'jobs', description: '保留原文与解析状态' },
  { key: 'review', label: '定义审核', view: 'definitions', description: '确认对象、属性与规则' },
  { key: 'publish', label: '行业包发布', view: 'packages', description: '校验并固定语义版本' },
  { key: 'project', label: '项目数据', view: 'projects', description: '导入与字段映射' },
  { key: 'identity', label: '记录确认', view: 'instances', description: '处理字段与身份冲突' },
  { key: 'ask', label: '业务实践', view: 'business', description: '执行任务并核对依据' },
]
const STATE_LABELS = { draft: '草稿', review: '待审核', published: '已发布', active: '使用中', archived: '已归档' } as const

const STAGES: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'sources', label: '来源准备' },
  { key: 'assets', label: '资产审核' },
  { key: 'validation', label: '验证发布' },
  { key: 'project', label: '项目准备' },
  { key: 'tasks', label: '带依据问答' },
]

interface TodoItem { readonly id: string; readonly label: string; readonly action: string; readonly description: string; readonly run: () => void }

export function GuideHome({
  scenarioLabel, classificationLabel, operatorEnabled, onNavigate, workspaces = [], projects = [],
  workspacePhase = 'ready', projectPhase = 'ready', onRetry, onSelectWorkspace, onSelectProject, onConfigureModel,
  selectedWorkspaceId, selectedProjectId, onCreateWorkspace, onCreateProject, onStructuredIntake,
}: GuideHomeProps) {
  const [goal, setGoal] = useState('')
  const [sourceChoice, setSourceChoice] = useState<SourceEntry | undefined>(undefined)
  const synthetic = classificationLabel.includes('合成')
  const loading = workspacePhase === 'loading' || workspacePhase === 'idle' || projectPhase === 'loading' || projectPhase === 'idle'
  const failure = workspacePhase === 'failure' || projectPhase === 'failure'
  const selectedWorkspace = workspaces.find((entry) => entry.workspaceId === selectedWorkspaceId)
  const selectedProject = projects.find((entry) => entry.projectId === selectedProjectId)

  const firstWorkspace = workspaces[0]
  const firstProject = projects[0]
  const currentWork = selectedWorkspace !== undefined
    ? { kind: '行业工作区', name: selectedWorkspace.displayName, open: () => onNavigate('ontology') }
    : selectedProject !== undefined
      ? { kind: '项目', name: selectedProject.title, open: () => onNavigate('projects') }
      : firstWorkspace !== undefined
        ? { kind: '行业工作区', name: firstWorkspace.displayName, open: () => { onSelectWorkspace?.(firstWorkspace.workspaceId); onNavigate('ontology') } }
        : firstProject !== undefined
          ? { kind: '项目', name: firstProject.title, open: () => { onSelectProject?.(firstProject.projectId); onNavigate('projects') } }
          : undefined

  const todos: TodoItem[] = []
  const reviewWorkspaces = workspaces.filter((workspace) => workspace.state === 'review')
  const reviewWorkspace = reviewWorkspaces[0]
  if (reviewWorkspace !== undefined) todos.push({
    id: 'workspace-review', label: `${reviewWorkspaces.length} 个行业工作区处于待审核状态`, action: '审核工作区',
    description: '确认对象、属性、关系与规则是否符合原始资料。',
    run: () => { onSelectWorkspace?.(reviewWorkspace.workspaceId); onNavigate('definitions') },
  })
  const draftWorkspaces = workspaces.filter((workspace) => workspace.state === 'draft')
  const draftWorkspace = draftWorkspaces[0]
  if (draftWorkspace !== undefined) todos.push({
    id: 'workspace-draft', label: `${draftWorkspaces.length} 个行业工作区草稿待推进`, action: '继续工作',
    description: '补充来源、生成候选并推进到可审核状态。',
    run: () => { onSelectWorkspace?.(draftWorkspace.workspaceId); onNavigate('ontology') },
  })
  const draftProjects = projects.filter((project) => project.state === 'draft')
  const draftProject = draftProjects[0]
  if (draftProject !== undefined) todos.push({
    id: 'project-draft', label: `${draftProjects.length} 个项目待确认数据`, action: '处理记录',
    description: '确认字段、单位、身份与关系端点后发布事实。',
    run: () => { onSelectProject?.(draftProject.projectId); onNavigate('instances') },
  })

  const currentStage = projects.length > 0 ? 3
    : workspaces.some((workspace) => workspace.state === 'published' || workspace.latestPublishedPackRef !== undefined) ? 2
      : workspaces.length > 0 ? 1 : 0
  const stageDetail: Readonly<Record<string, string>> = {
    sources: workspaces.length === 0 ? '尚未建立行业工作区' : `${workspaces.length} 个行业工作区`,
    project: projects.length === 0 ? '尚未建立项目' : `${projects.length} 个项目`,
  }

  const recent: readonly { readonly kind: string; readonly id: string; readonly name: string; readonly state: keyof typeof STATE_LABELS; readonly open: () => void }[] = [
    ...workspaces.map((workspace) => ({ kind: '行业工作区', id: workspace.workspaceId, name: workspace.displayName, state: workspace.state, open: () => { onSelectWorkspace?.(workspace.workspaceId); onNavigate('ontology') } })),
    ...projects.map((project) => ({ kind: '项目', id: project.projectId, name: project.title, state: project.state, open: () => { onSelectProject?.(project.projectId); onNavigate('projects') } })),
  ].slice(0, 6)

  const requestSource = (entry: SourceEntry): void => {
    if (!operatorEnabled) return
    if (entry === 'structured') { (onStructuredIntake ?? (() => onNavigate('projects')))(); return }
    if (selectedWorkspace !== undefined) { onNavigate('jobs'); return }
    if (firstWorkspace !== undefined) { onSelectWorkspace?.(firstWorkspace.workspaceId); onNavigate('jobs'); return }
    setSourceChoice(entry)
  }

  return <section className="app__guide" data-testid="guide-home">
    <header className="app__guide-header"><div><p className="ui-eyebrow">工作概览</p><h1>Ontology 知识工作台</h1>
      <p className="app__guide-hint">把某个业务领域从料源整理成可审核的行业资产，再用固定版本开展带依据的业务问答。</p></div>
      <div className="guide-home-actions">
        <Button variant="primary" onClick={() => onNavigate('query')}>开始业务问答</Button>
        {operatorEnabled ? <Button variant="quiet" onClick={() => onNavigate('ontology')}>创建或管理工作区</Button> : <StatusBadge tone="warning">当前为只读访问</StatusBadge>}
        {operatorEnabled && onConfigureModel !== undefined ? <Button variant="quiet" onClick={onConfigureModel}>生成模型设置</Button> : null}
      </div>
    </header>

    <dl className="app__guide-context" data-testid="guide-context"><div><dt>当前场景</dt><dd data-testid="guide-scenario">{scenarioLabel}</dd></div>
      <div><dt>数据分类</dt><dd data-testid="guide-classification">{classificationLabel}</dd></div><div><dt>运行模式</dt><dd data-testid="guide-mode">{operatorEnabled ? '本地操作员模式' : '只读业务模式'}</dd></div></dl>
    {synthetic ? <p className="app__guide-disclaimer" data-testid="guide-disclaimer" role="note">当前场景使用合成演示数据，结果仅用于演示与验证。</p> : null}

    <section className="app__guide-current" data-testid="guide-current-work" aria-label="当前工作">
      {currentWork === undefined ? <p className="app__guide-current-empty">还没有进行中的工作。在下方输入业务目标，或从已有行业包创建项目。</p>
        : <><p><span className="app__guide-current-label">当前工作</span> <strong>{currentWork.name}</strong> <span className="app__guide-current-kind">{currentWork.kind}</span></p>
          <Button variant="quiet" data-testid="guide-continue-work" onClick={currentWork.open}>继续工作 →</Button></>}
    </section>

    <section className="app__guide-start" data-testid="guide-goal-prompt" aria-labelledby="guide-start-title">
      <h2 id="guide-start-title">希望整理哪个领域，或解决什么问题？</h2>
      <p className="app__guide-hint" data-testid="guide-goal-hint">这个目标会直接成为该工作区建模助手的任务；进入工作区后无需再次填写研究表单，只需确认一次范围与额度。</p>
      <Field label="业务目标" hint="例如“整理设备维护规则及其依据”。新建行业工作区的第一步只需要名称和业务目标。">
        {(attributes) => <textarea {...attributes} data-testid="guide-goal-input" rows={2} value={goal} placeholder="输入领域或问题" onChange={(event) => setGoal(event.target.value)} />}
      </Field>
      <div className="ui-actions">
        <Button variant="primary" data-testid="guide-create-workspace" disabled={!operatorEnabled} onClick={() => onCreateWorkspace?.(goal)}>创建行业工作区</Button>
        <Button variant="secondary" data-testid="guide-create-project" disabled={!operatorEnabled} onClick={() => onCreateProject?.()}>使用已有行业包创建项目</Button>
      </div>
    </section>

    <section className="app__guide-sources" aria-labelledby="guide-sources-title">
      <h2 id="guide-sources-title">知识从哪里来？</h2>
      <div className="guide-source-grid">
        <button type="button" className="guide-source" data-testid="source-entry-research" disabled={!operatorEnabled} onClick={() => requestSource('research')}>
          <span>AI 搜寻公共资料</span><small>调研后由你确认来源类别</small></button>
        <button type="button" className="guide-source" data-testid="source-entry-upload" disabled={!operatorEnabled} onClick={() => requestSource('upload')}>
          <span>上传或粘贴资料</span><small>UTF-8 文本、JSON、CSV、XLSX</small></button>
        <button type="button" className="guide-source" data-testid="source-entry-structured" disabled={!operatorEnabled} onClick={() => requestSource('structured')}>
          <span>接入结构化数据</span><small>首期支持文件映射快照</small></button>
      </div>
      {operatorEnabled ? null : <p className="app__guide-hint">当前为只读访问，输入资料与管理来源需要操作员权限。</p>}
    </section>

    <div className="app__guide-grid">
      <Panel title="现在需要你处理" description="待办来自当前授权空间已读取的真实状态；不显示无法解释的比例。">
        {failure ? <StateFeedback tone="error" title="工作内容读取失败" description="暂时无法读取工作区与项目列表。" action={<Button onClick={onRetry}>重试</Button>} />
          : loading ? <StateFeedback tone="loading" title="正在读取工作内容" description="读取当前授权空间的工作区与项目。" />
            : todos.length === 0 ? <StateFeedback title="暂无待处理事项" description="当前没有处于审核或草稿状态的工作区与项目。" />
              : <ul className="app__guide-todos" data-testid="guide-todos">{todos.map((todo) =>
                <li key={todo.id}><div><strong>{todo.label}</strong><p>{todo.description}</p></div><Button variant="quiet" onClick={todo.run}>{todo.action} →</Button></li>)}</ul>}
      </Panel>
      <Panel title="工作进度" description="阶段状态由已读取的数据推断，不显示无法解释的百分比。">
        <ol className="app__guide-stages" data-testid="guide-progress">
          {STAGES.map((stage, index) => <li key={stage.key} data-stage={stage.key} data-state={index < currentStage ? 'done' : index === currentStage ? 'current' : 'todo'}>
            <span className="app__step-number" aria-hidden="true">{index < currentStage ? '✓' : index + 1}</span>
            <div><strong>{stage.label}</strong>{stageDetail[stage.key] === undefined ? null : <small>{stageDetail[stage.key]}</small>}</div></li>)}
        </ol>
      </Panel>
    </div>

    <Panel title="最近工作" description="当前授权空间中的行业工作区与项目。" className="app__guide-recent">
      {failure ? <StateFeedback tone="error" title="最近工作读取失败" description="暂时无法读取列表，可以重新读取。" action={<Button onClick={onRetry}>重试</Button>} />
        : loading ? <StateFeedback tone="loading" title="正在读取最近工作" description="读取当前授权空间的工作区与项目。" />
          : recent.length === 0 ? <StateFeedback title="还没有任何工作" description={operatorEnabled ? '创建行业工作区，或使用已有行业包创建项目。' : '当前授权空间没有可读取的工作区或项目。'} />
            : <DataTable caption="最近工作"><thead><tr><th scope="col">名称</th><th scope="col">类型</th><th scope="col">状态</th><th scope="col">操作</th></tr></thead>
              <tbody>{recent.map((entry) => <tr key={`${entry.kind}:${entry.id}`}><td><strong>{entry.name}</strong></td><td>{entry.kind}</td>
                <td><StatusBadge tone={entry.state === 'published' || entry.state === 'active' ? 'success' : 'neutral'}>{STATE_LABELS[entry.state]}</StatusBadge></td>
                <td><Button variant="quiet" onClick={entry.open}>打开 →</Button></td></tr>)}</tbody></DataTable>}
    </Panel>

    <Panel title="工作路径" description="行业工作台与项目工作台可以分别推进；已发布的行业包是二者的连接点。" className="app__guide-path">
      <ol>{PATH_STEPS.map((step, index) => <li key={step.key} data-testid="guide-path-step" data-step={step.key}><span className="app__step-number" aria-hidden="true">{index + 1}</span><div>
        <Button variant="quiet" onClick={() => onNavigate(step.view)}>{step.label}</Button><p>{step.description}</p></div></li>)}</ol>
    </Panel>
    <div className="app__guide-footer"><span>所有列表来自当前 API 的授权空间。</span><Button variant="quiet" onClick={() => onNavigate('evidence')}>查看证据与历史 →</Button></div>

    <Drawer open={sourceChoice !== undefined} title="为这份资料选择用途" placement="center" onClose={() => setSourceChoice(undefined)}>
      <p>还没有选中工作对象。同一份资料按用途分流，两种用途各自独立审核与授权。</p>
      <div className="ui-actions">
        <Button variant="primary" onClick={() => { setSourceChoice(undefined); onCreateWorkspace?.(goal) }}>作为行业依据（进入行业工作台）</Button>
        <Button onClick={() => { setSourceChoice(undefined); onNavigate('projects') }}>作为项目记录（进入项目工作台）</Button>
      </div>
    </Drawer>
  </section>
}
