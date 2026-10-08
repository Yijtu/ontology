import type { IndustryWorkspace, ProjectRecord } from '@ontology/contracts'
import type { AppView } from './App'
import { Button, DataTable, Panel, StateFeedback, StatusBadge } from './ui'

export interface GuideStep { readonly key: string; readonly label: string; readonly view: AppView; readonly description: string }
export interface GuideCard { readonly key: string; readonly label: string; readonly view: AppView; readonly description: string }
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

export function GuideHome({ scenarioLabel, classificationLabel, operatorEnabled, onNavigate, workspaces = [], projects = [],
  workspacePhase = 'ready', projectPhase = 'ready', onRetry, onSelectWorkspace, onSelectProject }: GuideHomeProps) {
  const synthetic = classificationLabel.includes('合成')
  return <section className="app__guide" data-testid="guide-home">
    <header className="app__guide-header"><div><p className="ui-eyebrow">工作概览</p><h1>把资料变成可追溯的业务知识</h1>
      <p className="app__guide-hint">先确认语义，再整理项目数据。在固定版本上开展业务实践，沿来源复核每个结果。</p></div>
      {operatorEnabled ? <Button variant="primary" onClick={() => onNavigate('ontology')}>创建或管理工作区</Button> : <StatusBadge tone="warning">当前为只读访问</StatusBadge>}
    </header>
    <dl className="app__guide-context" data-testid="guide-context"><div><dt>当前场景</dt><dd data-testid="guide-scenario">{scenarioLabel}</dd></div>
      <div><dt>数据分类</dt><dd data-testid="guide-classification">{classificationLabel}</dd></div><div><dt>运行模式</dt><dd data-testid="guide-mode">{operatorEnabled ? '本地操作员模式' : '只读业务模式'}</dd></div></dl>
    {synthetic ? <p className="app__guide-disclaimer" data-testid="guide-disclaimer" role="note">当前场景使用合成演示数据，结果仅用于演示与验证。</p> : null}
    <div className="app__guide-grid">
      <Panel title="本体建模" description="管理业务边界、定义审核与发布版本。" actions={<Button variant="quiet" onClick={() => onNavigate('ontology')}>全部工作区 →</Button>}>
        {workspacePhase === 'loading' || workspacePhase === 'idle' ? <StateFeedback tone="loading" title="正在读取工作区" description="读取当前授权空间的工作内容。" /> : workspacePhase === 'failure' ?
          <StateFeedback tone="error" title="工作区读取失败" description="暂时无法读取列表，可以重新读取。" action={<Button onClick={onRetry}>重试</Button>} /> : workspaces.length === 0 ?
          <StateFeedback title="从一个清晰的业务边界开始" description={operatorEnabled ? '创建本体工作区，添加资料并确认定义与规则。' : '当前授权空间没有可读取的工作区。'} action={<Button onClick={() => onNavigate('ontology')}>进入本体工作区</Button>} /> :
          <DataTable caption="当前本体工作区"><thead><tr><th scope="col">工作区</th><th scope="col">状态</th><th scope="col">下一步</th></tr></thead><tbody>{workspaces.slice(0, 5).map((workspace) =>
            <tr key={workspace.workspaceId}><td><strong>{workspace.displayName}</strong><small>草稿修订 {workspace.headRevision}</small></td><td><StatusBadge>{STATE_LABELS[workspace.state]}</StatusBadge></td><td><Button variant="quiet" onClick={() => { onSelectWorkspace?.(workspace.workspaceId); onNavigate('definitions') }}>审核定义 →</Button></td></tr>)}</tbody></DataTable>}
      </Panel>
      <Panel title="项目实践" description="将已确认的数据用于任务，保留结论与来源。" actions={<Button variant="quiet" onClick={() => onNavigate('projects')}>全部项目 →</Button>}>
        {projectPhase === 'loading' || projectPhase === 'idle' ? <StateFeedback tone="loading" title="正在读取项目" description="读取当前授权空间的项目。" /> : projectPhase === 'failure' ?
          <StateFeedback tone="error" title="项目读取失败" description="暂时无法读取列表，可以重新读取。" action={<Button onClick={onRetry}>重试</Button>} /> : projects.length === 0 ?
          <StateFeedback title="还没有项目数据" description="选择已发布的行业包，创建项目并导入业务资料。" action={<Button onClick={() => onNavigate('projects')}>进入项目数据</Button>} /> :
          <DataTable caption="当前项目"><thead><tr><th scope="col">项目</th><th scope="col">状态</th><th scope="col">下一步</th></tr></thead><tbody>{projects.slice(0, 5).map((project) =>
            <tr key={project.projectId}><td><strong>{project.title}</strong><small>项目修订 {project.headRevision}</small></td><td><StatusBadge tone={project.state === 'active' ? 'success' : 'neutral'}>{STATE_LABELS[project.state]}</StatusBadge></td><td><Button variant="quiet" onClick={() => { onSelectProject?.(project.projectId); onNavigate('projects') }}>查看数据 →</Button></td></tr>)}</tbody></DataTable>}
      </Panel>
    </div>
    <Panel title="工作路径" description="本体建模与项目实践可以分别推进；发布版本是二者的连接点。" className="app__guide-path">
      <ol>{PATH_STEPS.map((step, index) => <li key={step.key} data-testid="guide-path-step" data-step={step.key}><span className="app__step-number" aria-hidden="true">{index + 1}</span><div>
        <Button variant="quiet" onClick={() => onNavigate(step.view)}>{step.label}</Button><p>{step.description}</p></div></li>)}</ol>
    </Panel>
    <div className="app__guide-footer"><span>所有列表来自当前 API 的授权空间。</span><Button variant="quiet" onClick={() => onNavigate('evidence')}>查看证据与历史 →</Button></div>
  </section>
}
