import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchClient } from './api/client'
import { AssistantShell } from './components/AssistantShell'
import type { AssistantModuleDeclarations } from './components/AssistantShell'
import { DefinitionWorkbenchPanel } from './components/DefinitionWorkbenchPanel'
import { createScenarioRegistry } from './scenarios/composition'
import {
  NEUTRAL_ALPHA_DECLARATION,
  NEUTRAL_BETA_DECLARATION,
} from './scenarios/synthetic/neutral-scenario-modules'
import './styles.css'

/**
 * Test-only composition entry for the public definition / rule / action review workbench. It is a
 * separate Vite input so the browser E2E can drive the real HTTP surface through the loopback
 * `/api` proxy while the V03-022 shell still mounts the two neutral scenario modules. The panel is
 * a generic public home: it never names an industry.
 */

const DECLARATIONS: AssistantModuleDeclarations = {
  ontology: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION],
  business: [],
}

function start(): void {
  const container = document.getElementById('definition-workbench-root')
  if (container === null) return
  const params = new URLSearchParams(window.location.search)
  const workspaceId = params.get('workspace') ?? ''
  container.setAttribute('data-workspace', workspaceId)
  const readOnly = params.get('case') === 'readonly'
  const client = new WorkbenchClient({ baseUrl: '' })
  const registry = createScenarioRegistry()
  createRoot(container).render(
    createElement(AssistantShell, {
      registry,
      declarations: DECLARATIONS,
      grantedCapabilities: ['data.readonly'],
      readOnly,
      homeByAssistant: {
        ontology: createElement(DefinitionWorkbenchPanel, { client, workspaceId, readOnly }),
      },
    }),
  )
}

void start()
