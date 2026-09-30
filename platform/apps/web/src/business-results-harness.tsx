import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchClient } from './api/client'
import { createWorkbenchResultSource } from './api/results'
import { BusinessWorkbenchPanel } from './components/BusinessWorkbenchPanel'
import { createScenarioRegistry } from './scenarios/composition'
import {
  NEUTRAL_ALPHA_DECLARATION,
  NEUTRAL_BETA_DECLARATION,
} from './scenarios/synthetic/neutral-scenario-modules'
import './styles.css'

/**
 * Test-only composition entry for the public business workbench (V03-040 / #212). It is a
 * separate Vite input so the real browser E2E can drive the run/answer/table/evidence HTTP
 * surface while the public workbench mounts the two neutral scenario modules through the same
 * trusted registry the product uses. It never imports a server package and never branches on an
 * industry name.
 */

const PROFILE = { id: 'home-energy-demo', version: '1.0.0' }

const DECLARATIONS = {
  ontology: [],
  business: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION],
}

function start(): void {
  const container = document.getElementById('business-results-root')
  if (container === null) return
  const params = new URLSearchParams(window.location.search)
  const readOnly = params.get('case') === 'readonly'
  const client = new WorkbenchClient({ baseUrl: '' })
  createRoot(container).render(
    createElement(BusinessWorkbenchPanel, {
      client,
      registry: createScenarioRegistry(),
      profileRef: PROFILE,
      timeZone: 'Asia/Shanghai',
      declarations: DECLARATIONS,
      grantedCapabilities: ['data.readonly', 'pricing.compute'],
      readOnly,
      availableTasks: [],
      resultSource: createWorkbenchResultSource(client),
    }),
  )
}

void start()
