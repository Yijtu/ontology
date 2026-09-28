import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileRef, ResourceRef } from '@ontology/contracts'
import type { CoreDeploymentInfo, CoreDeploymentScenario, WorkbenchClient } from '../api/client'
import { CandidateReviewPanel } from './CandidateReviewPanel'
import { CoreImportPanel } from './CoreImportPanel'
import { EvidencePanel } from './EvidencePanel'
import { JobProgressPanel } from './JobProgressPanel'
import { QueryPanel } from './QueryPanel'
import type { QueryContextField } from './QueryPanel'
import { useViewport } from './useViewport'
import { Workbench } from './Workbench'

/**
 * The operator app shell. It composes the configuration workbench (LOCAL-037) with the
 * ingestion-job, candidate-review and provenance/history surfaces. A deployment can contribute
 * scenario-specific views without editing the shared shell. The shell talks to the API over
 * HTTP only and never imports a domain extension.
 */
export type CoreAppView = 'workbench' | 'query' | 'jobs' | 'review' | 'evidence'
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
  { view: 'workbench', label: '配置工作台' },
  { view: 'query', label: '业务问答' },
  { view: 'jobs', label: '导入任务' },
  { view: 'review', label: '候选审核' },
  { view: 'evidence', label: '证据与历史' },
]
const EMPTY_DEPLOYMENT_SCENARIOS: readonly CoreDeploymentScenario[] = []

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
  initialView = 'workbench',
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
  useEffect(() => {
    setActiveProfileRef(profileRef)
    const matching = scenarioOptions.find((scenario) =>
      scenario.profileRef.id === profileRef.id && scenario.profileRef.version === profileRef.version,
    )
    setSelectedScenarioId(matching?.scenarioId ?? '')
  }, [profileRef.id, profileRef.version, scenarioOptions])
  const openSourceReference = useCallback((reference: ResourceRef) => {
    setSourceReference(reference)
    setEvidenceId(reference.kind === 'evidence' ? reference.id : undefined)
    setView('evidence')
  }, [])
  const contribution = scenarioViews.find((entry) => entry.view === view)
  const tabs = [...CORE_TABS, ...scenarioViews.map(({ view: extraView, label }) => ({ view: extraView, label }))]
  const activeScenario = scenarioOptions.find((scenario) => scenario.scenarioId === selectedScenarioId)
  const availableTasks = activeScenario?.availableTasks ?? []

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
          <span data-testid="core-deployment-classification">
            {deploymentClassification === 'public_synthetic_demo_not_an_industry_standard'
              ? '合成演示数据（非行业标准）'
              : deploymentClassification ?? '部署场景'}
          </span>
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
      {contribution?.render({ client, profileRef })}
    </div>
  )
}
