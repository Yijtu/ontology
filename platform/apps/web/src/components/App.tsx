import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { IndustryWorkspace, ProfileRef, ProjectRecord, ResourceRef } from '@ontology/contracts'
import type { CoreDeploymentInfo, CoreDeploymentScenario, WorkbenchClient } from '../api/client'
import type { IndustryPackSummary } from '../api/projects'
import { createWorkbenchResultSource } from '../api/results'
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

export interface AppViewContribution {
  readonly view: string
  readonly label: string
  render(input: { readonly client: WorkbenchClient; readonly profileRef: ProfileRef }): ReactNode
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
  { view: 'start', label: '开始' },
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
const CONTEXT_VIEWS: readonly AppView[] = ['definitions', 'instances', 'packages']

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
  window.history.replaceState(null, '', `${url.pathname}${url.search}`)
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
  const [selectedScenarioId, setSelectedScenarioId] = useState(() => scenarioOptions.find((scenario) =>
    scenario.profileRef.id === profileRef.id && scenario.profileRef.version === profileRef.version,
  )?.scenarioId ?? '')
  const [evidenceId, setEvidenceId] = useState(initialEvidenceId)
  const [sourceReference, setSourceReference] = useState<ResourceRef | undefined>()
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(() => readParam('workspace'))
  const [projectId, setProjectId] = useState<string | undefined>(() => readParam('project'))
  const [workspaces, setWorkspaces] = useState<readonly IndustryWorkspace[]>(EMPTY_WORKSPACES)
  const [projects, setProjects] = useState<readonly ProjectRecord[]>(EMPTY_PROJECTS)
  const [workspacePhase, setWorkspacePhase] = useState<OptionsPhase>('idle')
  const [projectPhase, setProjectPhase] = useState<OptionsPhase>('idle')
  const [projectBinding, setProjectBinding] = useState<ProjectBinding | undefined>(undefined)
  const [packs, setPacks] = useState<readonly IndustryPackSummary[]>(EMPTY_PACKS)

  useEffect(() => {
    setActiveProfileRef(profileRef)
    const matching = scenarioOptions.find((scenario) =>
      scenario.profileRef.id === profileRef.id && scenario.profileRef.version === profileRef.version,
    )
    setSelectedScenarioId(matching?.scenarioId ?? '')
  }, [profileRef.id, profileRef.version, scenarioOptions])

  const activeScenario = scenarioOptions.find((scenario) => scenario.scenarioId === selectedScenarioId)
  const availableTasks = activeScenario?.availableTasks ?? []
  const readOnly = deploymentOperatorEnabled !== true
  const showContextBar = CONTEXT_VIEWS.includes(view)

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
    if (!showContextBar) return undefined
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
  }, [showContextBar, client])

  useEffect(() => {
    if (!showContextBar) return undefined
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
  }, [showContextBar, client])

  useEffect(() => {
    if (view !== 'projects') return undefined
    let cancelled = false
    setProjectBinding(undefined)
    if (activeScenario === undefined) return undefined
    void (async () => {
      const binding = await deriveProjectBinding(client, activeScenario)
      if (!cancelled) setProjectBinding(binding)
    })()
    return () => {
      cancelled = true
    }
  }, [view, client, activeScenario])

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
    setSourceReference(reference)
    setEvidenceId(reference.kind === 'evidence' ? reference.id : undefined)
    setView('evidence')
  }, [])

  const selectWorkspace = useCallback((value: string | undefined) => {
    setWorkspaceId(value)
    writeParam('workspace', value)
  }, [])

  const selectProject = useCallback((value: string | undefined) => {
    setProjectId(value)
    writeParam('project', value)
  }, [])

  const contribution = scenarioViews.find((entry) => entry.view === view)
  const tabs = [...CORE_TABS, ...scenarioViews.map(({ view: extraView, label }) => ({ view: extraView, label }))]
  const contributionView = !coreViewOf(view) && contribution !== undefined
  const classificationLabel =
    deploymentClassification === 'public_synthetic_demo_not_an_industry_standard'
      ? '合成演示数据（非行业标准）'
      : deploymentClassification ?? '部署场景'

  return (
    <div className="app" data-viewport={viewport} data-view={view}>
      {scenarioOptions.length === 0 ? null : (
        <section className="app__deployment" data-testid="core-deployment-picker">
          <label>
            场景
            <select
              data-testid="core-scenario-select"
              value={selectedScenarioId}
              onChange={(event) => {
                const scenario = scenarioOptions.find((entry) => entry.scenarioId === event.target.value)
                if (scenario !== undefined) {
                  setSelectedScenarioId(scenario.scenarioId)
                  setActiveProfileRef(scenario.profileRef)
                }
              }}
            >
              {scenarioOptions.map((scenario) => (
                <option key={scenario.scenarioId} value={scenario.scenarioId}>{scenario.label}</option>
              ))}
            </select>
          </label>
          <span data-testid="core-deployment-classification">{classificationLabel}</span>
          <span data-testid="core-deployment-mode">
            {deploymentOperatorEnabled === true ? '本地操作员模式' : '只读业务模式'}
          </span>
        </section>
      )}
      <nav className="app__tabs" aria-label="主导航">
        {tabs.map((tab) => (
          <button
            key={tab.view}
            type="button"
            className="app__tab"
            data-testid={`tab-${tab.view}`}
            data-active={tab.view === view}
            aria-current={tab.view === view ? 'page' : undefined}
            onClick={() => setView(tab.view)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {showContextBar ? (
        <section className="app__context" data-testid="context-bar" aria-label="工作区与项目上下文">
          <label>
            工作区
            <select
              data-testid="context-workspace-select"
              value={workspaceId ?? ''}
              onChange={(event) => selectWorkspace(event.target.value === '' ? undefined : event.target.value)}
            >
              <option value="">请选择…</option>
              {workspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>
                  {workspace.displayName}（{workspace.namespace}）
                </option>
              ))}
            </select>
          </label>
          <label>
            项目
            <select
              data-testid="context-project-select"
              value={projectId ?? ''}
              onChange={(event) => selectProject(event.target.value === '' ? undefined : event.target.value)}
            >
              <option value="">请选择…</option>
              {projects.map((project) => (
                <option key={project.projectId} value={project.projectId}>
                  {project.title}（{project.state}）
                </option>
              ))}
            </select>
          </label>
          {workspacePhase === 'loading' ? <span data-testid="context-workspace-loading">正在加载工作区…</span> : null}
          {workspacePhase === 'failure' ? (
            <span data-testid="context-workspace-failure">工作区列表暂不可用，请稍后重试或直接输入工作区标识。</span>
          ) : null}
          {projectPhase === 'loading' ? <span data-testid="context-project-loading">正在加载项目…</span> : null}
          {projectPhase === 'failure' ? (
            <span data-testid="context-project-failure">项目列表暂不可用，请稍后重试或直接输入项目标识。</span>
          ) : null}
        </section>
      ) : null}

      {view === 'start' ? (
        <GuideHome
          scenarioLabel={activeScenario?.label ?? `${activeProfileRef.id}@${activeProfileRef.version}`}
          classificationLabel={classificationLabel}
          operatorEnabled={deploymentOperatorEnabled === true}
          onNavigate={setView}
        />
      ) : null}
      {view === 'workbench' ? (
        <Workbench
          key={activeScenario?.scenarioId ?? `${activeProfileRef.id}@${activeProfileRef.version}`}
          client={client}
          profileRef={activeProfileRef}
          {...(activeScenario?.baseProfileSpec === undefined ? {} : { baseProfileSpec: activeScenario.baseProfileSpec })}
          {...(activeScenario === undefined ? {} : { environment: activeScenario.environment })}
          onProfileActivated={setActiveProfileRef}
          {...(boundRunId === undefined ? {} : { boundRunId })}
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
          {...(boundRunId === undefined ? {} : { initialRunId: boundRunId })}
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
        <CandidateReviewPanel client={client} {...(initialCandidateId === undefined ? {} : { initialCandidateId })} />
      ) : null}
      {view === 'evidence' ? (
        <EvidencePanel
          client={client}
          {...(evidenceId === undefined ? {} : { initialEvidenceId: evidenceId })}
          {...(sourceReference === undefined ? {} : { initialReference: sourceReference })}
          {...(initialObjectId === undefined ? {} : { initialObjectId })}
        />
      ) : null}

      {view === 'ontology' ? <OntologyWorkspacePanel client={client} readOnly={readOnly} /> : null}

      {view === 'projects' ? (
        activeScenario === undefined || projectBinding === undefined ? (
          <PublicEmptyState
            testId="project-binding-unavailable"
            title="项目数据暂不可用"
            requirement="一个可用的部署场景，以及该场景已解析的配置快照与物理映射。"
            nextStep="先在上方场景下拉中选择一个已绑定配置的场景；若仍不可用，请确认该部署已发布行业包。"
          />
        ) : (
          <ProjectWorkspacePanel client={client} projectBinding={projectBinding} packs={packs} readOnly={readOnly} />
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
          {...(boundRunId === undefined ? {} : { initialRunId: boundRunId })}
        />
      ) : null}

      {contributionView ? contribution?.render({ client, profileRef }) : null}
    </div>
  )
}
