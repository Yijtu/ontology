import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { IndustryWorkspace, ProfileRef, ProjectRecord, ProjectRevision, ResourceRef, RevisionString, VersionRef } from '@ontology/contracts'
import type { CoreDeploymentInfo, CoreDeploymentScenario, WorkbenchClient } from '../api/client'
import type { IndustryPackSummary } from '../api/projects'
import { createWorkbenchResultSource } from '../api/results'
import { indexedHistoryState, readHistoryIndex, resolveAppView } from '../navigation'
import { deriveProjectBinding } from '../project-binding'
import { createScenarioRegistry } from '../scenarios/composition'
import { BusinessWorkbenchPanel } from './BusinessWorkbenchPanel'
import { CandidateReviewPanel } from './CandidateReviewPanel'
import { CoreImportPanel } from './CoreImportPanel'
import { DefinitionWorkbenchPanel } from './DefinitionWorkbenchPanel'
import { EvidencePanel } from './EvidencePanel'
import { GuideHome } from './GuideHome'
import { InstanceReviewPanel } from './InstanceReviewPanel'
import { JobProgressPanel } from './JobProgressPanel'
import { OntologyWorkspacePanel } from './OntologyWorkspacePanel'
import { PackagePublicationPanel } from './PackagePublicationPanel'
import type { ProjectBinding } from './ProjectWorkspacePanel'
import { ProjectWorkspacePanel } from './ProjectWorkspacePanel'
import { PublicEmptyState } from './PublicStateNotice'
import { QueryPanel } from './QueryPanel'
import type { QueryContextField } from './QueryPanel'
import { useViewport } from './useViewport'
import { Workbench } from './Workbench'
import { Button, Drawer, Field, StateFeedback, StatusBadge } from './ui'
import { ScenarioErrorBoundary } from './ScenarioErrorBoundary'

/**
 * The operator app shell. It composes the configuration workbench (LOCAL-037), the ingestion-job,
 * candidate-review and provenance/history surfaces, and the v0.3 workbenches (ontology workspace,
 * project data, definition/rule review, instance review, package publication, business workbench)
 * behind one navigation. The plain-language guide home is the default landing. A deployment can
 * contribute scenario-specific views without editing the shared shell. The shell talks to the API
 * over HTTP only and never imports a domain extension.
 */
export type CoreAppView =
  | 'start'
  | 'ontology'
  | 'projects'
  | 'definitions'
  | 'instances'
  | 'packages'
  | 'business'
  | 'workbench'
  | 'query'
  | 'jobs'
  | 'review'
  | 'evidence'
export type AppView = CoreAppView | (string & {})

export interface AppViewContext {
  readonly workspaceId?: string
  readonly projectId?: string
  readonly profileRef: ProfileRef
  readonly workspaceRevision?: RevisionString
  readonly projectRevisionRef?: ProjectRevision['ref']
  readonly definitionRef?: VersionRef
  readonly onDirtyChange: (dirty: boolean) => void
  readonly onSelectWorkspace: (value: string | undefined) => void
  readonly onSelectProject: (value: string | undefined) => void
}

export interface AppViewContribution {
  readonly view: string
  readonly label: string
  readonly navigationGroup?: 'modeling' | 'practice' | 'assets'
  render(input: { readonly client: WorkbenchClient; readonly profileRef: ProfileRef; readonly context: AppViewContext }): ReactNode
}

export interface AppProps {
  readonly client: WorkbenchClient
  readonly profileRef: ProfileRef
  readonly deploymentScenarios?: readonly CoreDeploymentScenario[]
  readonly deploymentClassification?: string
  readonly deploymentModels?: CoreDeploymentInfo['models']
  readonly deploymentOperatorEnabled?: boolean
  readonly timeZone: string
  readonly queryContextFields?: readonly QueryContextField[]
  readonly scenarioViews?: readonly AppViewContribution[]
  readonly boundRunId?: string
  readonly initialView?: AppView
  readonly initialJobId?: string
  readonly initialCandidateId?: string
  readonly initialEvidenceId?: string
  readonly initialObjectId?: string
}

const CORE_TABS: readonly { readonly view: CoreAppView; readonly label: string }[] = [
  { view: 'start', label: '工作概览' },
  { view: 'ontology', label: '本体工作区' },
  { view: 'projects', label: '项目数据' },
  { view: 'definitions', label: '定义与规则' },
  { view: 'instances', label: '实例审核' },
  { view: 'packages', label: '行业包' },
  { view: 'business', label: '业务任务' },
  { view: 'workbench', label: '配置工作台' },
  { view: 'query', label: '业务问答' },
  { view: 'jobs', label: '导入任务' },
  { view: 'review', label: '候选审核' },
  { view: 'evidence', label: '证据与历史' },
]
const EMPTY_DEPLOYMENT_SCENARIOS: readonly CoreDeploymentScenario[] = []
const EMPTY_WORKSPACES: readonly IndustryWorkspace[] = []
const EMPTY_PROJECTS: readonly ProjectRecord[] = []
const EMPTY_PACKS: readonly IndustryPackSummary[] = []
const NAV_GROUPS = [
  { label: '本体建模', views: ['ontology', 'definitions', 'packages'] },
  { label: '项目实践', views: ['projects', 'instances', 'business', 'query'] },
  { label: '资产与历史', views: ['jobs', 'review', 'evidence'] },
] as const

type OptionsPhase = 'idle' | 'loading' | 'ready' | 'failure'

function readParam(name: string): string | undefined {
  if (typeof window === 'undefined') return undefined
  const value = new URLSearchParams(window.location.search).get(name)
  return value === null || value.length === 0 ? undefined : value
}

function writeParam(name: string, value: string | undefined): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  if (value === undefined) url.searchParams.delete(name)
  else url.searchParams.set(name, value)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function coreViewOf(view: AppView): boolean {
  return (CORE_TABS as readonly { readonly view: string }[]).some((tab) => tab.view === view)
}

export function App({
  client,
  profileRef,
  deploymentScenarios,
  deploymentClassification,
  deploymentModels,
  deploymentOperatorEnabled,
  timeZone,
  queryContextFields,
  scenarioViews = [],
  boundRunId,
  initialView = 'start',
  initialJobId,
  initialCandidateId,
  initialEvidenceId,
  initialObjectId,
}: AppProps) {
  const scenarioOptions = deploymentScenarios ?? EMPTY_DEPLOYMENT_SCENARIOS
  const viewport = useViewport()
  const [view, setView] = useState<AppView>(initialView)
  const [activeJobId, setActiveJobId] = useState(initialJobId)
  const [activeProfileRef, setActiveProfileRef] = useState(profileRef)
  const [selectedScenarioId, setSelectedScenarioId] = useState(() => (scenarioOptions.find((scenario) =>
    scenario.profileRef.id === profileRef.id && scenario.profileRef.version === profileRef.version,
  ) ?? scenarioOptions.find((scenario) => scenario.scenarioId === readParam('scenarioId')))?.scenarioId ?? '')
  const [candidateId, setCandidateId] = useState(initialCandidateId)
  const [objectId, setObjectId] = useState(initialObjectId)
  const [evidenceId, setEvidenceId] = useState(initialEvidenceId)
  const [sourceReference, setSourceReference] = useState<ResourceRef | undefined>()
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(() => readParam('workspace'))
  const [projectId, setProjectId] = useState<string | undefined>(() => readParam('project'))
  const [workspaces, setWorkspaces] = useState<readonly IndustryWorkspace[]>(EMPTY_WORKSPACES)
  const [projects, setProjects] = useState<readonly ProjectRecord[]>(EMPTY_PROJECTS)
  const [workspacePhase, setWorkspacePhase] = useState<OptionsPhase>('idle')
  const [projectPhase, setProjectPhase] = useState<OptionsPhase>('idle')
  const [projectBinding, setProjectBinding] = useState<ProjectBinding | undefined>(undefined)
  const [projectRevision, setProjectRevision] = useState<ProjectRevision | undefined>()
  const [scopeEpoch, setScopeEpoch] = useState(0)
  const [activeRunId, setActiveRunId] = useState(boundRunId)
  const [contextReload, setContextReload] = useState(0)
  const [bindingPhase, setBindingPhase] = useState<OptionsPhase>('idle')
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<{ readonly run: () => void } | undefined>()
  const [menuOpen, setMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const historyIndex = useRef(typeof window === 'undefined' ? 0 : readHistoryIndex(window.history.state) ?? 0)
  const restoringTraversal = useRef<{ readonly targetIndex: number } | undefined>(undefined)
  const acceptedTraversal = useRef<number | undefined>(undefined)
  const [packs, setPacks] = useState<readonly IndustryPackSummary[]>(EMPTY_PACKS)

  useEffect(() => {
    setActiveProfileRef(profileRef)
    const matching = scenarioOptions.find((scenario) =>
      scenario.profileRef.id === profileRef.id && scenario.profileRef.version === profileRef.version,
    ) ?? scenarioOptions.find((scenario) => scenario.scenarioId === readParam('scenarioId'))
    setSelectedScenarioId(matching?.scenarioId ?? '')
  }, [profileRef.id, profileRef.version, scenarioOptions])

  const activeScenario = scenarioOptions.find((scenario) => scenario.scenarioId === selectedScenarioId)
  const availableTasks = activeScenario?.availableTasks ?? []
  const readOnly = deploymentOperatorEnabled !== true
  const scopeKey = `${activeProfileRef.id}@${activeProfileRef.version}:${workspaceId ?? ''}:${projectId ?? ''}:${scopeEpoch}`
  const scopeBound = !['start', 'ontology', 'workbench'].includes(view)
  const contentKey = scopeBound ? `${view}:${scopeKey}` : `${view}:${activeProfileRef.id}@${activeProfileRef.version}`
  const selectedWorkspace = workspaces.find((entry) => entry.workspaceId === workspaceId)
  const selectedProject = projects.find((entry) => entry.projectId === projectId)
  const currentProjectRevision = projectRevision !== undefined && projectRevision.ref.projectId === projectId && projectRevision.ref.revision === selectedProject?.headRevision ? projectRevision : undefined
  const bindingStale = projectBinding !== undefined && (projectBinding.profileRef.id !== activeScenario?.profileRef.id || projectBinding.profileRef.version !== activeScenario?.profileRef.version)

  const guard = useCallback((run: () => void) => {
    if (dirty) setPending({ run })
    else run()
  }, [dirty])
  const clearScopeReferences = useCallback(() => {
    setScopeEpoch((epoch) => epoch + 1)
    setActiveRunId(undefined)
    setActiveJobId(undefined)
    setEvidenceId(undefined)
    setCandidateId(undefined)
    setObjectId(undefined)
    setSourceReference(undefined)
    for (const param of ['run', 'job', 'candidate', 'evidence', 'object']) writeParam(param, undefined)
  }, [])
  const navigate = useCallback((next: AppView, before?: () => void) => {
    if (next === view && before === undefined) { setMenuOpen(false); return }
    guard(() => {
      before?.()
      setView(next)
      setMenuOpen(false)
      const url = new URL(window.location.href)
      url.searchParams.set('view', next)
      historyIndex.current += 1
      window.history.pushState(indexedHistoryState(historyIndex.current), '', `${url.pathname}${url.search}${url.hash}`)

      setContextReload((count) => count + 1)
    })
  }, [guard, view])

  useEffect(() => { mainRef.current?.focus({ preventScroll: true }) }, [view])
  useLayoutEffect(() => {
    if (!dirty) return undefined
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', preventUnload)
    return () => window.removeEventListener('beforeunload', preventUnload)
  }, [dirty])
  // The URL and listeners must be ready in the same commit as the visible shell. A passive
  // effect can otherwise miss a fast native traversal immediately after a document reload.
  useLayoutEffect(() => {
    window.history.replaceState(indexedHistoryState(historyIndex.current), '', window.location.href)
  }, [])
  useLayoutEffect(() => {
    const pop = (event: PopStateEvent) => {
      const target = new URL(window.location.href)
      const targetIndex = readHistoryIndex(event.state)
      const restoration = restoringTraversal.current
      if (restoration !== undefined) {
        if (targetIndex === historyIndex.current) {
          restoringTraversal.current = undefined
          // Offer the decision only after the browser is back on the edited entry. Cancelling
          // then leaves both entry and index untouched; accepting replays the original traversal.
          setPending({ run: () => {
            acceptedTraversal.current = restoration.targetIndex
            window.history.go(restoration.targetIndex - historyIndex.current)
          } })
        } else if (targetIndex !== undefined) window.history.go(historyIndex.current - targetIndex)
        return
      }
      const accepted = targetIndex !== undefined && acceptedTraversal.current === targetIndex
      acceptedTraversal.current = undefined
      if (dirty && !accepted && targetIndex !== undefined && targetIndex !== historyIndex.current) {
        restoringTraversal.current = { targetIndex }
        window.history.go(historyIndex.current - targetIndex)
        return
      }
      const apply = () => {
        const next = resolveAppView(target.searchParams, scenarioViews)
        if (targetIndex !== undefined) historyIndex.current = targetIndex
        clearScopeReferences()
        setView(next)
        setWorkspaceId(target.searchParams.get('workspace') ?? undefined)
        setProjectId(target.searchParams.get('project') ?? undefined)
        setActiveRunId(target.searchParams.get('run') ?? undefined)
        setActiveJobId(target.searchParams.get('job') ?? undefined)
        setEvidenceId(target.searchParams.get('evidence') ?? undefined)
        setCandidateId(target.searchParams.get('candidate') ?? undefined)
        setObjectId(target.searchParams.get('object') ?? undefined)
        const scenario = scenarioOptions.find((entry) => entry.scenarioId === target.searchParams.get('scenarioId')) ?? scenarioOptions.find((entry) => entry.profileRef.id === profileRef.id && entry.profileRef.version === profileRef.version)
        if (scenario !== undefined) { setSelectedScenarioId(scenario.scenarioId); setActiveProfileRef(scenario.profileRef) }
        const linkedProfileId = target.searchParams.get('profileId')
        const linkedProfileVersion = target.searchParams.get('profileVersion')
        if (linkedProfileId && linkedProfileVersion) setActiveProfileRef({ id: linkedProfileId, version: linkedProfileVersion })
        window.history.replaceState(indexedHistoryState(historyIndex.current), '', target.href)

      }
      if (accepted || !dirty) apply()
      else guard(apply)
    }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [dirty, guard, scenarioViews, scenarioOptions, clearScopeReferences, profileRef.id, profileRef.version])

  useEffect(() => {
    setProjectRevision(undefined)
    if (selectedProject === undefined) return undefined
    let cancelled = false
    client.getProjectRevisionView(selectedProject.projectId, selectedProject.headRevision)
      .then((result) => { if (!cancelled) setProjectRevision(result.revision) })
      .catch(() => { if (!cancelled) setProjectRevision(undefined) })
    return () => { cancelled = true }
  }, [client, selectedProject])

  const registry = useMemo(() => createScenarioRegistry(), [])
  const resultSource = useMemo(() => createWorkbenchResultSource(client), [client])
  const grantedCapabilities = useMemo(() => {
    const capabilities: string[] = ['data.readonly']
    if (deploymentOperatorEnabled === true) capabilities.push('data.write', 'semantic.write', 'scenario.mount')
    if (deploymentModels?.generation === true) capabilities.push('model.generation')
    if (deploymentModels?.decision === true) capabilities.push('model.decision')
    return capabilities
  }, [deploymentOperatorEnabled, deploymentModels?.generation, deploymentModels?.decision])

  useEffect(() => {
    let cancelled = false
    setWorkspacePhase('loading')
    client.listIndustryWorkspaces()
      .then((list) => {
        if (cancelled) return
        setWorkspaces(list)
        setWorkspacePhase('ready')
      })
      .catch(() => {
        if (cancelled) return
        setWorkspaces(EMPTY_WORKSPACES)
        setWorkspacePhase('failure')
      })
    return () => {
      cancelled = true
    }
  }, [client, contextReload])

  useEffect(() => {
    let cancelled = false
    setProjectPhase('loading')
    client.listProjects()
      .then((list) => {
        if (cancelled) return
        setProjects(list)
        setProjectPhase('ready')
      })
      .catch(() => {
        if (cancelled) return
        setProjects(EMPTY_PROJECTS)
        setProjectPhase('failure')
      })
    return () => {
      cancelled = true
    }
  }, [client, contextReload])

  useEffect(() => {
    if (view !== 'projects') return undefined
    let cancelled = false
    setProjectBinding(undefined)
    setBindingPhase('loading')
    if (activeScenario === undefined) { setBindingPhase('ready'); return undefined }
    void (async () => {
      try {
        const binding = await deriveProjectBinding(client, activeScenario)
        if (!cancelled) { setProjectBinding(binding); setBindingPhase('ready') }
      } catch { if (!cancelled) setBindingPhase('failure') }
    })()
    return () => {
      cancelled = true
    }
  }, [view, client, activeScenario, contextReload])

  useEffect(() => {
    if (view !== 'projects') return undefined
    let cancelled = false
    client.listIndustryPacks()
      .then((list) => {
        if (!cancelled) setPacks(list)
      })
      .catch(() => {
        if (!cancelled) setPacks(EMPTY_PACKS)
      })
    return () => {
      cancelled = true
    }
  }, [view, client])

  const openSourceReference = useCallback((reference: ResourceRef) => {
    navigate('evidence', () => {
      setSourceReference(reference)
      const id = reference.kind === 'evidence' ? reference.id : undefined
      setEvidenceId(id)
      writeParam('evidence', id)
    })
  }, [navigate])

  const activateProfile = useCallback((ref: ProfileRef) => {
    clearScopeReferences()
    setDirty(false)
    setActiveProfileRef(ref)
    writeParam('profileId', ref.id)
    writeParam('profileVersion', ref.version)
    if (activeScenario !== undefined) writeParam('scenarioId', activeScenario.scenarioId)

  }, [activeScenario, clearScopeReferences])

  const selectWorkspace = useCallback((value: string | undefined) => {
    if (value === workspaceId) return
    const apply = () => { clearScopeReferences(); setWorkspaceId(value); writeParam('workspace', value) }
    if (scopeBound) guard(apply)
    else apply()
  }, [workspaceId, scopeBound, guard, clearScopeReferences])

  const selectProject = useCallback((value: string | undefined) => {
    if (value === projectId) return
    const apply = () => { clearScopeReferences(); setProjectId(value); writeParam('project', value) }
    if (scopeBound) guard(apply)
    else apply()
  }, [projectId, scopeBound, guard, clearScopeReferences])

  const contribution = scenarioViews.find((entry) => entry.view === view)
  const tabs = [...CORE_TABS, ...scenarioViews.map(({ view: extraView, label }) => ({ view: extraView, label }))]
  const contributionView = !coreViewOf(view) && contribution !== undefined
  const classificationLabel =
    deploymentClassification === 'public_synthetic_demo_not_an_industry_standard'
      ? '合成演示数据（非行业标准）'
      : deploymentClassification ?? '部署场景'

  const pageContext: AppViewContext = {
    profileRef: activeProfileRef,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(selectedWorkspace === undefined ? {} : { workspaceRevision: selectedWorkspace.headRevision }),
    ...(currentProjectRevision === undefined ? {} : { projectRevisionRef: currentProjectRevision.ref, definitionRef: currentProjectRevision.definitionRef }),
    ...(currentProjectRevision === undefined && activeScenario !== undefined ? { definitionRef: activeScenario.definitionRef } : {}),
    onDirtyChange: setDirty,
    onSelectWorkspace: selectWorkspace,
    onSelectProject: selectProject,
  }

  const viewLabel = tabs.find((tab) => tab.view === view)?.label ?? '工作台'
  const navButton = (tab: { readonly view: string; readonly label: string }) => (
    <button key={tab.view} type="button" className="app__nav-item" data-testid={`tab-${tab.view}`}
      data-active={tab.view === view} aria-current={tab.view === view ? 'page' : undefined} onClick={() => navigate(tab.view)}>
      <span>{tab.label}</span><span aria-hidden="true">{tab.view === view ? '›' : ''}</span>
    </button>
  )
  const navigation = <nav aria-label="主导航" className="app__navigation">
    {CORE_TABS.filter((tab) => tab.view === 'start').map(navButton)}
    {NAV_GROUPS.map((group) => <section key={group.label} className="app__nav-group" aria-label={group.label}>
      <h2>{group.label}</h2>{CORE_TABS.filter((tab) => group.views.some((entry) => entry === tab.view)).map(navButton)}
      {scenarioViews.filter((entry) => (entry.navigationGroup ?? 'practice') === (group.label === '本体建模' ? 'modeling' : group.label === '项目实践' ? 'practice' : 'assets')).map(navButton)}
    </section>)}
    <details className="app__advanced" open={view === 'workbench'}><summary>高级设置</summary>{CORE_TABS.filter((tab) => tab.view === 'workbench').map(navButton)}<p>模型、工具、配置与原始定义</p></details>
  </nav>
  const contextFields = <>
    {scenarioOptions.length === 0 ? null : <div data-testid="core-deployment-picker"><Field label="部署场景">{(attributes) => <select {...attributes} data-testid="core-scenario-select" value={selectedScenarioId}
      onChange={(event) => {
        const scenario = scenarioOptions.find((entry) => entry.scenarioId === event.target.value)
        if (scenario !== undefined && scenario.scenarioId !== selectedScenarioId) guard(() => {
          clearScopeReferences(); setSelectedScenarioId(scenario.scenarioId); setActiveProfileRef(scenario.profileRef)
          setProjectId(undefined); setWorkspaceId(undefined)
          writeParam('scenarioId', scenario.scenarioId); writeParam('project', undefined); writeParam('workspace', undefined)
          // Explicit-profile links must reload into the scenario the user selected.
          if (readParam('profileId') !== undefined) { writeParam('profileId', scenario.profileRef.id); writeParam('profileVersion', scenario.profileRef.version) }

        })
      }}>{scenarioOptions.map((scenario) => <option key={scenario.scenarioId} value={scenario.scenarioId}>{scenario.label}</option>)}</select>}</Field></div>}
    <Field label="本体工作区">{(attributes) => <select {...attributes} data-testid="context-workspace-select" value={workspaceId ?? ''}
      onChange={(event) => selectWorkspace(event.target.value || undefined)}>
      <option value="">选择工作区</option>{workspaceId !== undefined && selectedWorkspace === undefined ? <option value={workspaceId}>链接中的工作区（待读取）</option> : null}
      {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.displayName}</option>)}
    </select>}</Field>
    <Field label="当前项目">{(attributes) => <select {...attributes} data-testid="context-project-select" value={projectId ?? ''}
      onChange={(event) => selectProject(event.target.value || undefined)}>
      <option value="">选择项目</option>{projectId !== undefined && selectedProject === undefined ? <option value={projectId}>链接中的项目（待读取）</option> : null}
      {projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.title}</option>)}
    </select>}</Field>
    <div className="app__version"><span>当前版本</span><strong>{selectedProject === undefined ? `配置 ${activeProfileRef.version}` : `项目修订 ${selectedProject.headRevision}`}</strong>
      {currentProjectRevision === undefined ? null : <small>本体版本 {currentProjectRevision.definitionRef.version}</small>}
      {selectedWorkspace === undefined ? null : <small>本体草稿 {selectedWorkspace.headRevision}</small>}</div>
  </>

  return (
    <div className="app" data-viewport={viewport} data-view={view}>
      <a className="app__skip" href="#workspace-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus() }}>跳到工作内容</a>
      <aside className="app__sidebar"><div className="app__brand"><span aria-hidden="true">◈</span><div><strong>本体工作台</strong><small>语义 · 数据 · 实践</small></div></div>{viewport === 'narrow' ? null : navigation}
        <div className="app__sidebar-foot">{readOnly ? '只读访问' : '操作员工作空间'}<small>以已审核版本开展工作</small></div></aside>
      <div className="app__workspace">
        <header className="app__topbar">
          <Button variant="quiet" className="app__menu-button" onClick={() => setMenuOpen(true)} aria-label="打开主导航" aria-expanded={menuOpen}>☰ 导航</Button>
          <div className="app__breadcrumb">工作空间 <span aria-hidden="true">/</span> <strong>{viewLabel}</strong></div>
          <div className="app__topbar-actions"><StatusBadge tone={readOnly ? 'warning' : 'neutral'}><span data-testid="core-deployment-mode">{readOnly ? '只读业务模式' : '本地操作员模式'}</span></StatusBadge>
            <Button variant="quiet" onClick={() => setContextOpen(true)}>查看上下文</Button></div>
        </header>
        <section className="app__context" data-testid="context-bar" aria-label="工作区与项目上下文">{contextFields}</section>
        <div className="app__context-status" aria-live="polite">
          <span data-testid="core-deployment-classification">{classificationLabel}</span>
          {workspacePhase === 'loading' ? <span data-testid="context-workspace-loading">正在加载工作区…</span> : null}
          {projectPhase === 'loading' ? <span data-testid="context-project-loading">正在加载项目…</span> : null}
          {workspacePhase === 'failure' ? <span data-testid="context-workspace-failure">工作区列表暂不可用。</span> : null}
          {projectPhase === 'failure' ? <span data-testid="context-project-failure">项目列表暂不可用。</span> : null}
          {workspacePhase === 'failure' || projectPhase === 'failure' ? <Button variant="quiet" onClick={() => setContextReload((count) => count + 1)}>重新读取上下文</Button> : null}
        </div>
        <main id="workspace-content" ref={mainRef} tabIndex={-1} className="app__content" aria-label={viewLabel}
          onChangeCapture={(event) => {
            const target = event.target
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) setDirty(true)
          }}>
          <ScenarioErrorBoundary resetKey={`${view}:${scopeKey}`} renderFallback={(retry) => <StateFeedback tone="error" title="工作内容暂不可用" description="本页未能正常显示。当前上下文仍保留，可以重试或切换到其他工作页面。" action={<Button onClick={retry}>重试显示</Button>} />}>
          <div key={contentKey}>
      {view === 'start' ? (
        <GuideHome
          scenarioLabel={activeScenario?.label ?? '当前部署'}
          classificationLabel={classificationLabel}
          operatorEnabled={deploymentOperatorEnabled === true}
          onNavigate={navigate}
          workspaces={workspaces}
          projects={projects}
          workspacePhase={workspacePhase}
          projectPhase={projectPhase}
          onRetry={() => setContextReload((count) => count + 1)}
          onSelectWorkspace={selectWorkspace}
          onSelectProject={selectProject}
        />
      ) : null}
      {view === 'workbench' ? (
        <Workbench
          key={activeScenario?.scenarioId ?? `${activeProfileRef.id}@${activeProfileRef.version}`}
          client={client}
          profileRef={activeProfileRef}
          {...(activeScenario?.baseProfileSpec === undefined ? {} : { baseProfileSpec: activeScenario.baseProfileSpec })}
          {...(activeScenario === undefined ? {} : { environment: activeScenario.environment })}
          onProfileActivated={activateProfile}
          {...(activeRunId === undefined ? {} : { boundRunId: activeRunId })}
        />
      ) : null}
      {view === 'query' ? (
        <QueryPanel
          client={client}
          key={`${activeProfileRef.id}@${activeProfileRef.version}`}
          profileRef={activeProfileRef}
          timeZone={timeZone}
          availableTasks={availableTasks}
          {...(deploymentModels === undefined ? {} : { modelCapabilities: deploymentModels })}
          onEvidenceReference={openSourceReference}
          {...(queryContextFields === undefined ? {} : { contextFields: queryContextFields })}
          {...(activeRunId === undefined ? {} : { initialRunId: activeRunId })}
        />
      ) : null}
      {view === 'jobs' ? (
        <>
          <CoreImportPanel
            key={activeScenario?.scenarioId ?? 'no-selected-core-scenario'}
            client={client}
            scenarios={scenarioOptions}
            operatorEnabled={deploymentOperatorEnabled === true}
            generationEnabled={deploymentModels?.generation === true}
            {...(activeScenario === undefined ? {} : { initialScenarioId: activeScenario.scenarioId })}
            onImported={setActiveJobId}
          />
          <JobProgressPanel
            key={activeJobId ?? 'no-job-selected'}
            client={client}
            {...(activeJobId === undefined ? {} : { initialJobId: activeJobId })}
          />
        </>
      ) : null}
      {view === 'review' ? (
        <CandidateReviewPanel client={client} {...(candidateId === undefined ? {} : { initialCandidateId: candidateId })} />
      ) : null}
      {view === 'evidence' ? (
        <EvidencePanel
          client={client}
          {...(evidenceId === undefined ? {} : { initialEvidenceId: evidenceId })}
          {...(sourceReference === undefined ? {} : { initialReference: sourceReference })}
          {...(objectId === undefined ? {} : { initialObjectId: objectId })}
        />
      ) : null}

      {view === 'ontology' ? <OntologyWorkspacePanel client={client} readOnly={readOnly} /> : null}

      {view === 'projects' ? (
        bindingPhase === 'loading' || bindingStale ? <StateFeedback tone="loading" title="正在准备项目工作台" description="读取当前场景的配置与映射。" /> : bindingPhase === 'failure' ? <StateFeedback tone="error" title="项目工作台准备失败" description="当前配置未能读取，请重试。" action={<Button onClick={() => setContextReload((count) => count + 1)}>重试</Button>} /> : activeScenario === undefined || projectBinding === undefined ? (
          <PublicEmptyState
            testId="project-binding-unavailable"
            title="项目数据暂不可用"
            requirement="一个可用的部署场景，以及该场景已解析的配置快照与物理映射。"
            nextStep="先在上方场景下拉中选择一个已绑定配置的场景；若仍不可用，请确认该部署已发布行业包。"
          />
        ) : (
          <ProjectWorkspacePanel client={client} projectBinding={projectBinding} packs={packs} readOnly={readOnly} {...(projectId === undefined ? {} : { initialProjectId: projectId })} />
        )
      ) : null}

      {view === 'definitions' ? (
        workspaceId === undefined ? (
          <PublicEmptyState
            testId="workspace-required"
            title="先选择工作区"
            requirement="一个已创建的本体工作区。"
            nextStep="在上方工作区下拉中选择，或先到“本体工作区”创建。"
          />
        ) : (
          <DefinitionWorkbenchPanel client={client} workspaceId={workspaceId} readOnly={readOnly} />
        )
      ) : null}

      {view === 'instances' ? (
        projectId === undefined ? (
          <PublicEmptyState
            testId="project-required"
            title="先选择项目"
            requirement="一个已创建的客户项目。"
            nextStep="在上方项目下拉中选择，或先到“项目数据”创建。"
          />
        ) : (
          <InstanceReviewPanel client={client} projectId={projectId} readOnly={readOnly} />
        )
      ) : null}

      {view === 'packages' ? (
        workspaceId === undefined ? (
          <PublicEmptyState
            testId="workspace-required"
            title="先选择工作区"
            requirement="一个已创建的本体工作区。"
            nextStep="在上方工作区下拉中选择，或先到“本体工作区”创建。"
          />
        ) : (
          <PackagePublicationPanel client={client} workspaceId={workspaceId} readOnly={readOnly} />
        )
      ) : null}

      {view === 'business' ? (
        <BusinessWorkbenchPanel
          client={client}
          registry={registry}
          profileRef={activeProfileRef}
          timeZone={timeZone}
          grantedCapabilities={grantedCapabilities}
          readOnly={readOnly}
          availableTasks={availableTasks}
          resultSource={resultSource}
          {...(deploymentModels === undefined ? {} : { modelCapabilities: deploymentModels })}
          onOpenSource={openSourceReference}
          {...(activeRunId === undefined ? {} : { initialRunId: activeRunId })}
        />
      ) : null}

      {contributionView ? contribution?.render({ client, profileRef: activeProfileRef, context: pageContext }) : null}
          </div>
          </ScenarioErrorBoundary>
        </main>
      </div>
      <Drawer open={menuOpen} title="主导航" onClose={() => setMenuOpen(false)}>{navigation}</Drawer>
      <Drawer open={contextOpen} title="当前工作上下文" onClose={() => setContextOpen(false)}>
        <dl className="app__context-details"><div><dt>部署场景</dt><dd>{activeScenario?.label ?? '当前部署'}</dd></div><div><dt>数据分类</dt><dd>{classificationLabel}</dd></div><div><dt>模型能力</dt><dd>{deploymentModels?.generation === true ? '生成可用' : '生成模型关闭'} · {deploymentModels?.decision === true ? '概率决策可用' : '概率决策关闭'}</dd></div></dl>
        <details><summary>高级：绑定标识</summary><p className="ui-code">{activeProfileRef.id}@{activeProfileRef.version}</p></details>
      </Drawer>
      <Drawer open={pending !== undefined} title="离开当前工作内容？" placement="center" onClose={() => setPending(undefined)}>
        <p>当前页面有已修改的输入或审核选择。继续会清除本页未保存的内容；已保存的数据仍保留。</p>
        <div className="ui-actions"><Button variant="primary" onClick={() => setPending(undefined)}>继续编辑</Button><Button data-testid="shell-discard-changes" onClick={() => { const run = pending?.run; setPending(undefined); setDirty(false); run?.() }}>放弃修改并继续</Button></div>
      </Drawer>
    </div>
  )
}
