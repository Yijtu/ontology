import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchClient } from './api/client'
import { AssistantShell } from './components/AssistantShell'
import type { AssistantModuleDeclarations } from './components/AssistantShell'
import { OntologyWorkspacePanel } from './components/OntologyWorkspacePanel'
import { createScenarioRegistry } from './scenarios/composition'
import {
  NEUTRAL_ALPHA_DECLARATION,
  NEUTRAL_BETA_DECLARATION,
} from './scenarios/synthetic/neutral-scenario-modules'
import './styles.css'

/**
 * Test-only composition entry for the public ontology-workspace home. It is a separate Vite input
 * so the browser E2E can drive the real workspace HTTP surface (through the loopback `/api` proxy)
 * while the public shell still mounts the two neutral scenario modules. It registers modules
 * through the same trusted composition entry the product uses and never loads a module from a URL.
 */

const DECLARATIONS: AssistantModuleDeclarations = {
  ontology: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION],
  business: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION],
}

const ALL_CAPABILITIES = ['data.readonly', 'pricing.compute'] as const

function start(): void {
  const container = document.getElementById('workspace-root')
  if (container === null) return
  const params = new URLSearchParams(window.location.search)
  const scenarioCase = params.get('case') ?? 'default'
  container.setAttribute('data-case', scenarioCase)
  // Same-origin: the E2E loopback host proxies `/api` to the real Fastify server.
  const client = new WorkbenchClient({ baseUrl: '' })
  const registry = createScenarioRegistry()
  const readOnly = scenarioCase === 'readonly'
  createRoot(container).render(
    createElement(AssistantShell, {
      registry,
      declarations: DECLARATIONS,
      grantedCapabilities: [...ALL_CAPABILITIES],
      readOnly,
      homeByAssistant: {
        ontology: createElement(OntologyWorkspacePanel, { client, readOnly }),
      },
    }),
  )
}

void start()
