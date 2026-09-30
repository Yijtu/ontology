import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { MappingRef, ResolvedProfileRef, ResourceRef } from '@ontology/contracts'
import { WorkbenchClient } from './api/client'
import { AssistantShell } from './components/AssistantShell'
import type { AssistantModuleDeclarations } from './components/AssistantShell'
import { PackagePublicationPanel } from './components/PackagePublicationPanel'
import type { PackageMountBinding } from './components/PackagePublicationPanel'
import { createScenarioRegistry } from './scenarios/composition'
import {
  NEUTRAL_ALPHA_DECLARATION,
  NEUTRAL_BETA_DECLARATION,
} from './scenarios/synthetic/neutral-scenario-modules'
import { webWorkspaceIdentity } from './workspace-identity'
import './styles.css'

/**
 * Test-only composition entry for the public package validation/publish/export/mount home. It is a
 * separate Vite input so the browser E2E can drive the real HTTP surface (validations, publications,
 * pack export, project create/mount) through the loopback `/api` proxy while the V03-022 shell still
 * mounts the two neutral scenario modules. The panel is a generic public home: it never names an
 * industry.
 */

const DECLARATIONS: AssistantModuleDeclarations = {
  ontology: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION],
  business: [],
}

async function buildMountBinding(): Promise<PackageMountBinding> {
  const snapshotHash = await webWorkspaceIdentity.sha256('package-publish-profile')
  const mappingDigest = await webWorkspaceIdentity.sha256('package-publish-mapping')
  const documentSetDigest = await webWorkspaceIdentity.sha256('package-publish-document-set')
  const profileRef: ResolvedProfileRef = { id: 'profile-package-publish', version: '1.0.0', snapshotHash }
  const mappingRefs: MappingRef[] = [
    {
      id: 'mapping-package-publish',
      version: '1.0.0',
      digest: mappingDigest,
      role: 'catalog',
      sourceObjectRef: {
        sourceRef: { namespace: 'package-publish', sourceId: 'mapping-package-publish' },
        objectPath: 'device',
      },
    },
  ]
  const documentSetRef: ResourceRef = {
    id: '00000000-0000-4000-8000-0000000000d1',
    version: '1.0.0',
    digest: documentSetDigest,
    kind: 'artifact',
  }
  return { profileRef, mappingRefs, documentSetRef }
}

function start(): void {
  const container = document.getElementById('package-publish-root')
  if (container === null) return
  void (async () => {
    const params = new URLSearchParams(window.location.search)
    const workspaceId = params.get('workspace') ?? ''
    const initialValidationId = params.get('validation') ?? undefined
    const readOnly = params.get('case') === 'readonly'
    container.setAttribute('data-workspace', workspaceId)
    const client = new WorkbenchClient({ baseUrl: '' })
    const registry = createScenarioRegistry()
    const mountBinding = await buildMountBinding()
    createRoot(container).render(
      createElement(AssistantShell, {
        registry,
        declarations: DECLARATIONS,
        grantedCapabilities: ['data.readonly'],
        readOnly,
        homeByAssistant: {
          ontology: createElement(PackagePublicationPanel, {
            client,
            workspaceId,
            mountBinding,
            readOnly,
            ...(initialValidationId === undefined ? {} : { initialValidationId }),
          }),
        },
      }),
    )
  })()
}

void start()
