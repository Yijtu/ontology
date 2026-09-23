import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import { CandidateReviewPanel } from './CandidateReviewPanel'
import { EvidencePanel } from './EvidencePanel'
import { JobProgressPanel } from './JobProgressPanel'
import { QueryPanel } from './QueryPanel'
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
  readonly timeZone: string
  readonly scenarioViews?: readonly AppViewContribution[]
  readonly boundRunId?: string
  readonly initialView?: AppView
  readonly availableViews?: readonly AppView[]
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

export function App({
  client,
  profileRef,
  timeZone,
  scenarioViews = [],
  boundRunId,
  initialView = 'workbench',
  availableViews,
  initialJobId,
  initialCandidateId,
  initialEvidenceId,
  initialObjectId,
}: AppProps) {
  const viewport = useViewport()
  const [view, setView] = useState<AppView>(initialView)
  const contribution = scenarioViews.find((entry) => entry.view === view)
  const tabs = [...CORE_TABS, ...scenarioViews.map(({ view: extraView, label }) => ({ view: extraView, label }))]

  return (
    <div className="app" data-viewport={viewport} data-view={view}>
      <nav className="app__tabs" aria-label="主导航">
        {tabs.filter((tab) => availableViews === undefined || availableViews.includes(tab.view)).map((tab) => (
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
        <Workbench client={client} profileRef={profileRef} {...(boundRunId === undefined ? {} : { boundRunId })} />
      ) : null}
      {view === 'query' ? (
        <QueryPanel
          client={client}
          profileRef={profileRef}
          timeZone={timeZone}
          {...(boundRunId === undefined ? {} : { initialRunId: boundRunId })}
        />
      ) : null}
      {view === 'jobs' ? <JobProgressPanel client={client} {...(initialJobId === undefined ? {} : { initialJobId })} /> : null}
      {view === 'review' ? (
        <CandidateReviewPanel client={client} {...(initialCandidateId === undefined ? {} : { initialCandidateId })} />
      ) : null}
      {view === 'evidence' ? (
        <EvidencePanel
          client={client}
          {...(initialEvidenceId === undefined ? {} : { initialEvidenceId })}
          {...(initialObjectId === undefined ? {} : { initialObjectId })}
        />
      ) : null}
      {contribution?.render({ client, profileRef })}
    </div>
  )
}
