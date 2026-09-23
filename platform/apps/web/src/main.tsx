import { createRoot } from 'react-dom/client'
import { WorkbenchClient } from './api/client'
import { App } from './components/App'
import type { AppView } from './components/App'
import './styles.css'

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? ''
const client = new WorkbenchClient({ baseUrl })

const params = new URLSearchParams(window.location.search)

// `?run=<id>` deep-links to a run so the workbench can show the manifest that run locked.
const boundRunId = params.get('run') ?? undefined
const rawView = params.get('view')
const initialView: AppView = rawView === 'workbench' || rawView === 'jobs' || rawView === 'review' || rawView === 'evidence' || rawView === 'energy' || rawView === 'query'
  ? rawView
  : 'query'
const jobId = params.get('job') ?? undefined
const candidateId = params.get('candidate') ?? undefined
// `?evidence=<id>&object=<id>` deep-links the provenance/history surface for browser repro.
const evidenceId = params.get('evidence') ?? undefined
const objectId = params.get('object') ?? undefined

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <App
      client={client}
      initialView={initialView}
      {...(rawView === 'workbench' || rawView === 'jobs' || rawView === 'review' || rawView === 'evidence' || rawView === 'energy' ? {} : { availableViews: ['query'] as const })}
      {...(boundRunId === undefined ? {} : { boundRunId })}
      {...(jobId === undefined ? {} : { initialJobId: jobId })}
      {...(candidateId === undefined ? {} : { initialCandidateId: candidateId })}
      {...(evidenceId === undefined ? {} : { initialEvidenceId: evidenceId })}
      {...(objectId === undefined ? {} : { initialObjectId: objectId })}
    />,
  )
}
