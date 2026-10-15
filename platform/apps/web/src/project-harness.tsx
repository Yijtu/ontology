import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { ResourceKind, ResourceRef, VersionRef } from '@ontology/contracts'
import { WorkbenchClient } from './api/client'
import { AssistantShell } from './components/AssistantShell'
import type { AssistantModuleDeclarations } from './components/AssistantShell'
import { ProjectWorkspacePanel } from './components/ProjectWorkspacePanel'
import type { ProjectBinding, ProjectSourceCandidate } from './components/ProjectWorkspacePanel'
import type { IndustryPackSummary } from './api/projects'
import { createScenarioRegistry } from './scenarios/composition'
import {
  NEUTRAL_ALPHA_DECLARATION,
  NEUTRAL_BETA_DECLARATION,
} from './scenarios/synthetic/neutral-scenario-modules'
import { webWorkspaceIdentity } from './workspace-identity'
import './styles.css'

/**
 * Test-only composition entry for the public business-project workspace. It is a separate Vite
 * input so the browser E2E can drive the real project HTTP surface through the loopback `/api`
 * proxy while the public shell mounts the two neutral scenario modules. The parsed source
 * candidate mirrors the parse the test server seeded (the upstream upload+parse seam is not part
 * of this node); its digests are computed in the browser with the same SHA-256 the server uses.
 */

const DECLARATIONS: AssistantModuleDeclarations = {
  ontology: [],
  business: [NEUTRAL_ALPHA_DECLARATION, NEUTRAL_BETA_DECLARATION],
}

const PROJECT_FIXTURE = {
  csv: 'name,capacity_kwh,status\n桥架A,12.5,active\n桥架B,3,retired\n桥架C,8.25,active\n桥架D,7.5,active\n',
  parseId: 'aaaaaaaa-0000-4000-8000-000000000001',
  documentId: 'aaaaaaaa-0000-4000-8000-000000000002',
  originalId: 'aaaaaaaa-0000-4000-8000-000000000003',
  parseRefId: 'aaaaaaaa-0000-4000-8000-000000000004',
  packId: 'demo.bridge-pack',
  packVersion: '1.0.0',
  packV2Version: '1.1.0',
} as const

const HEADERS = ['name', 'capacity_kwh', 'status'] as const

function resourceRef(id: string, digest: string, kind: ResourceKind): ResourceRef {
  return { id, version: '1.0.0', digest, kind }
}

async function buildCandidate(csvDigest: string, parseDigest: string): Promise<ProjectSourceCandidate> {
  const columns = await Promise.all(
    HEADERS.map(async (header, columnIndex) => ({
      columnIndex,
      header,
      headerDigest: await webWorkspaceIdentity.sha256(header),
    })),
  )
  return {
    sourceId: 'source-1',
    label: '设备台账.csv',
    format: 'csv',
    mediaType: 'text/csv',
    documentId: PROJECT_FIXTURE.documentId,
    documentRef: resourceRef(PROJECT_FIXTURE.originalId, csvDigest, 'document'),
    parseRef: resourceRef(PROJECT_FIXTURE.parseRefId, parseDigest, 'artifact'),
    parseId: PROJECT_FIXTURE.parseId,
    objects: [
      {
        objectId: 'device',
        label: '设备',
        fields: [
          { fieldRef: 'name', label: '名称', valueType: 'string', required: true },
          { fieldRef: 'capacity', label: '容量', valueType: 'quantity', unitCode: 'kWh', required: false },
          { fieldRef: 'status', label: '状态', valueType: 'enum', required: false },
        ],
        columns,
      },
    ],
  }
}

async function buildBinding(): Promise<ProjectBinding> {
  const snapshotHash = await webWorkspaceIdentity.sha256('project-binding-profile')
  const mappingDigest = await webWorkspaceIdentity.sha256('project-binding-mapping')
  const documentSetDigest = await webWorkspaceIdentity.sha256('project-binding-document-set')
  return {
    profileRef: { id: 'profile-project-workspace', version: '1.0.0', snapshotHash },
    mappingRefs: [
      {
        id: 'mapping-project-workspace',
        version: '1.0.0',
        digest: mappingDigest,
        role: 'catalog',
        sourceObjectRef: { sourceRef: { namespace: 'project-import', sourceId: 'mapping-project-workspace' }, objectPath: 'device' },
      },
    ],
    documentSetRef: { id: PROJECT_FIXTURE.documentId, version: '1.0.0', digest: documentSetDigest, kind: 'artifact' },
  }
}

function packs(): readonly IndustryPackSummary[] {
  const v1: VersionRef = { id: PROJECT_FIXTURE.packId, version: PROJECT_FIXTURE.packVersion, digest: `sha256:${'a'.repeat(64)}` }
  const v2: VersionRef = { id: PROJECT_FIXTURE.packId, version: PROJECT_FIXTURE.packV2Version, digest: `sha256:${'2'.repeat(64)}` }
  return [
    { kind: 'registered_pack', namespace: PROJECT_FIXTURE.packId, displayName: '桥架行业包', packRef: v1, maturity: 'stable', maturityLabel: 'validated', usable: true },
    { kind: 'registered_pack', namespace: PROJECT_FIXTURE.packId, displayName: '桥架行业包', packRef: v2, maturity: 'stable', maturityLabel: 'validated', usable: true },
  ]
}

function App({ candidate, binding }: { readonly candidate: ProjectSourceCandidate; readonly binding: ProjectBinding }) {
  const params = new URLSearchParams(window.location.search)
  const readOnly = params.get('case') === 'readonly'
  const initialProjectId = params.get('project') ?? undefined
  const client = new WorkbenchClient({ baseUrl: '' })
  const registry = createScenarioRegistry()
  return createElement(AssistantShell, {
    registry,
    declarations: DECLARATIONS,
    grantedCapabilities: ['data.readonly'],
    readOnly,
    initialAssistant: 'business',
    homeByAssistant: {
      business: createElement(ProjectWorkspacePanel, {
        client,
        projectBinding: binding,
        packs: packs(),
        sources: [candidate],
        readOnly,
        ...(initialProjectId === undefined ? {} : { initialProjectId }),
      }),
    },
  })
}

function start(): void {
  const container = document.getElementById('project-root')
  if (container === null) return
  void (async () => {
    const csvDigest = await webWorkspaceIdentity.sha256(PROJECT_FIXTURE.csv)
    const parseDigest = await webWorkspaceIdentity.sha256('project-parse-artifact')
    const candidate = await buildCandidate(csvDigest, parseDigest)
    const binding = await buildBinding()
    createRoot(container).render(createElement(App, { candidate, binding }))
  })()
}

void start()
