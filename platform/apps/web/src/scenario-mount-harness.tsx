import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ProjectRevisionRef, UiCapabilityMetadata, VersionRef } from '@ontology/contracts'
import { AssistantShell } from './components/AssistantShell'
import type { AssistantModuleDeclarations } from './components/AssistantShell'
import type { ScenarioVerifiedResult } from './mount/contract'
import { createScenarioRegistry } from './scenarios/composition'
import {
  armNeutralRecovery,
  NEUTRAL_ALPHA_DECLARATION,
  NEUTRAL_ALPHA_MODULE,
  NEUTRAL_BETA_DECLARATION,
  neutralRecoveryControl,
} from './scenarios/synthetic/neutral-scenario-modules'
import './styles.css'

declare global {
  interface Window {
    /** Test hook: the browser E2E disarms the armed renderer before retrying. */
    __neutralScenarioRecovery?: { armed: boolean }
  }
}

/**
 * Test-only composition entry for the scenario mount contract. It is a separate Vite input so
 * the real browser E2E can mount the public shell over the two neutral scenario modules without
 * a live API or a business data chain. It registers modules through the same trusted composition
 * entry the product uses; it never loads a module from a URL.
 */

const PROJECT_REVISION: ProjectRevisionRef = {
  projectId: '11111111-1111-4111-8111-111111111111',
  revision: '7',
  digest: `sha256:${'0'.repeat(64)}`,
}

const VERIFIED_RESULT: ScenarioVerifiedResult = {
  answerId: '22222222-2222-4222-8222-222222222222',
  runId: '33333333-3333-4333-8333-333333333333',
  domainStatus: 'known',
  limitations: [],
  currentValidity: 'current',
}

const UNREGISTERED_DECLARATION: UiCapabilityMetadata = {
  moduleRef: { id: 'scene.neutral.unregistered', version: '1.0.0', digest: `sha256:${'e5'.repeat(32)}` },
  taskBindingRefs: [],
  requiredCapabilities: ['data.readonly'],
}

const ILLEGAL_DECLARATION: unknown = {
  ...NEUTRAL_BETA_DECLARATION,
  remoteUrl: 'https://example.invalid/module.js',
}

const BOTH: readonly unknown[] = [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION]

function buildInputs(scenarioCase: string): {
  readonly declarations: AssistantModuleDeclarations
  readonly grantedCapabilities: readonly string[]
  readonly allowedModuleRefs?: readonly VersionRef[]
  readonly readOnly: boolean
} {
  const allCapabilities = ['data.readonly', 'pricing.compute']
  switch (scenarioCase) {
    case 'missing-module':
      return {
        declarations: { ontology: [NEUTRAL_ALPHA_DECLARATION, UNREGISTERED_DECLARATION], business: [NEUTRAL_ALPHA_DECLARATION] },
        grantedCapabilities: allCapabilities,
        readOnly: false,
      }
    case 'missing-capability':
      return {
        declarations: { ontology: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION], business: [NEUTRAL_ALPHA_DECLARATION] },
        grantedCapabilities: ['data.readonly'],
        readOnly: false,
      }
    case 'readonly':
      return { declarations: { ontology: BOTH, business: BOTH }, grantedCapabilities: allCapabilities, readOnly: true }
    case 'forbidden':
      return {
        declarations: { ontology: BOTH, business: BOTH },
        grantedCapabilities: allCapabilities,
        allowedModuleRefs: [NEUTRAL_ALPHA_MODULE.ref],
        readOnly: false,
      }
    case 'illegal-metadata':
      return {
        declarations: { ontology: [NEUTRAL_ALPHA_DECLARATION, ILLEGAL_DECLARATION], business: [NEUTRAL_ALPHA_DECLARATION] },
        grantedCapabilities: allCapabilities,
        readOnly: false,
      }
    case 'recovery':
      armNeutralRecovery()
      return { declarations: { ontology: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION], business: BOTH }, grantedCapabilities: allCapabilities, readOnly: false }
    case 'mount':
    default:
      return { declarations: { ontology: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION], business: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION] }, grantedCapabilities: allCapabilities, readOnly: false }
  }
}

function start(): void {
  const container = document.getElementById('assistant-mount-root')
  if (container === null) return
  const registry = createScenarioRegistry()
  window.__neutralScenarioRecovery = neutralRecoveryControl
  const inputs = buildInputs(new URLSearchParams(window.location.search).get('case') ?? 'mount')
  container.setAttribute('data-case', new URLSearchParams(window.location.search).get('case') ?? 'mount')
  createRoot(container).render(
    createElement(AssistantShell, {
      registry,
      declarations: inputs.declarations,
      projectRevisionRef: PROJECT_REVISION,
      grantedCapabilities: inputs.grantedCapabilities,
      ...(inputs.allowedModuleRefs === undefined ? {} : { allowedModuleRefs: inputs.allowedModuleRefs }),
      readOnly: inputs.readOnly,
      verifiedResult: VERIFIED_RESULT,
    }),
  )
}

void start()
