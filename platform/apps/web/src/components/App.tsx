import { useState } from 'react'
import type { ProfileRef } from '@ontology/contracts'
import type { WorkbenchClient } from '../api/client'
import { CandidateReviewPanel } from './CandidateReviewPanel'
import { JobProgressPanel } from './JobProgressPanel'
import { QueryPanel } from './QueryPanel'
import { useViewport } from './useViewport'
import { Workbench } from './Workbench'

/**
 * The operator app shell. It composes the configuration workbench (LOCAL-037) with the
 * ingestion-job and candidate-review surfaces this slice adds, and deep-links each surface
 * (`?view=jobs&job=<id>`, `?view=review&candidate=<id>`) so a state can be reproduced in a
 * browser without navigating by hand. It talks to the API over HTTP only.
 */
export type AppView = 'workbench' | 'query' | 'jobs' | 'review'

export interface AppProps {
  readonly client: WorkbenchClient
  readonly profileRef?: ProfileRef
  readonly boundRunId?: string
  readonly initialView?: AppView
  readonly initialJobId?: string
  readonly initialCandidateId?: string
}

const TABS: readonly { readonly view: AppView; readonly label: string }[] = [
  { view: 'workbench', label: '配置工作台' },
  { view: 'query', label: '业务问答' },
  { view: 'jobs', label: '导入任务' },
  { view: 'review', label: '候选审核' },
]

export function App({
  client,
  profileRef,
  boundRunId,
  initialView = 'workbench',
  initialJobId,
  initialCandidateId,
}: AppProps) {
  const viewport = useViewport()
  const [view, setView] = useState<AppView>(initialView)

  return (
    <div className="app" data-viewport={viewport} data-view={view}>
      <nav className="app__tabs" aria-label="主导航">
        {TABS.map((tab) => (
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
        <Workbench client={client} {...(profileRef === undefined ? {} : { profileRef })} {...(boundRunId === undefined ? {} : { boundRunId })} />
      ) : null}
      {view === 'query' ? (
        <QueryPanel
          client={client}
          {...(profileRef === undefined ? {} : { profileRef })}
          {...(boundRunId === undefined ? {} : { initialRunId: boundRunId })}
        />
      ) : null}
      {view === 'jobs' ? <JobProgressPanel client={client} {...(initialJobId === undefined ? {} : { initialJobId })} /> : null}
      {view === 'review' ? (
        <CandidateReviewPanel client={client} {...(initialCandidateId === undefined ? {} : { initialCandidateId })} />
      ) : null}
    </div>
  )
}
