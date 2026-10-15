import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchClient } from './api/client'
import { AssistantShell } from './components/AssistantShell'
import type { AssistantModuleDeclarations } from './components/AssistantShell'
import { InstanceReviewPanel } from './components/InstanceReviewPanel'
import { createScenarioRegistry } from './scenarios/composition'
import {
  NEUTRAL_ALPHA_DECLARATION,
  NEUTRAL_BETA_DECLARATION,
} from './scenarios/synthetic/neutral-scenario-modules'
import './styles.css'

/**
 * Test-only composition entry for the public instance review surface. It is a separate Vite
 * input so the browser E2E can drive the real instance review HTTP surface through the loopback
 * `/api` proxy while the shell still mounts the two neutral scenario modules. The panel is a
 * generic public home: it never names an industry.
 */

const DECLARATIONS: AssistantModuleDeclarations = {
  ontology: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION],
  business: [],
}

function start(): void {
  const container = document.getElementById('instance-review-root')
  if (container === null) return
  const params = new URLSearchParams(window.location.search)
  const projectId = params.get('project') ?? ''
  container.setAttribute('data-project', projectId)
  const client = new WorkbenchClient({ baseUrl: '' })
  const registry = createScenarioRegistry()
  createRoot(container).render(
    createElement(AssistantShell, {
      registry,
      declarations: DECLARATIONS,
      grantedCapabilities: ['data.readonly'],
      homeByAssistant: {
        ontology: createElement(InstanceReviewPanel, { client, projectId }),
      },
    }),
  )
}

void start()
