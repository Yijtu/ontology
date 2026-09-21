import { createRoot } from 'react-dom/client'
import { WorkbenchClient } from './api/client'
import { Workbench } from './components/Workbench'
import './styles.css'

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? ''
const client = new WorkbenchClient({ baseUrl })

// `?run=<id>` deep-links to a run so the workbench can show the manifest that run locked.
const boundRunId = new URLSearchParams(window.location.search).get('run') ?? undefined

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <Workbench client={client} {...(boundRunId === undefined ? {} : { boundRunId })} />,
  )
}
