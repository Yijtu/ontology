// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ProjectRecord, ProjectRevision } from '@ontology/contracts'
import { ProjectWorkspacePanel } from '@ontology/app-web'
import type { ProjectBinding, ProjectSourceCandidate } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const DIGEST = `sha256:${'a'.repeat(64)}`
const PROJECT_ID = '44444444-4444-4444-8444-444444444444'
const PARSE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const PROJECT: ProjectRecord = {
  projectId: PROJECT_ID,
  title: '桥架项目',
  headRevision: '1',
  state: 'draft',
  createdBy: 'tester',
  createdAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
}

const REVISION: ProjectRevision = {
  ref: { projectId: PROJECT_ID, revision: '1', digest: DIGEST },
  industryPackRef: { id: 'demo.bridge-pack', version: '1.0.0', digest: DIGEST },
  definitionRef: { id: 'demo.bridge-pack-definition', version: '1.0.0', digest: DIGEST },
  mappingRefs: [
    {
      id: 'mapping-1',
      version: '1.0.0',
      digest: DIGEST,
      role: 'catalog',
      sourceObjectRef: { sourceRef: { namespace: 'project-import', sourceId: 'mapping-1' }, objectPath: 'device' },
    },
  ],
  profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: DIGEST },
  documentSetRef: { id: PROJECT_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' },
  semanticPublicationRefs: [],
  sourceVisibilityEpoch: '1',
  changeReason: 'project created',
}

const BINDING: ProjectBinding = {
  profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: DIGEST },
  mappingRefs: REVISION.mappingRefs,
  documentSetRef: REVISION.documentSetRef,
}

const SOURCE: ProjectSourceCandidate = {
  sourceId: 'source-1',
  label: '设备台账.csv',
  format: 'csv',
  mediaType: 'text/csv',
  documentRef: { id: 'bbbbbbbb-0000-4000-8000-000000000001', version: '1.0.0', digest: DIGEST, kind: 'document' },
  parseRef: { id: 'bbbbbbbb-0000-4000-8000-000000000002', version: '1.0.0', digest: DIGEST, kind: 'artifact' },
  parseId: PARSE_ID,
  objects: [
    {
      objectId: 'device',
      label: '设备',
      fields: [
        { fieldRef: 'name', label: '名称', valueType: 'string', required: true },
        { fieldRef: 'capacity', label: '容量', valueType: 'quantity', unitCode: 'kWh', required: false },
      ],
      columns: [
        { columnIndex: 0, header: 'name', headerDigest: DIGEST },
        { columnIndex: 1, header: 'capacity_kwh', headerDigest: DIGEST },
      ],
    },
  ],
}

const PACKS = [
  {
    kind: 'registered_pack',
    namespace: 'demo.bridge-pack',
    displayName: '桥架行业包',
    packRef: { id: 'demo.bridge-pack', version: '1.0.0', digest: DIGEST },
    maturity: 'stable',
    maturityLabel: 'validated',
    usable: true,
  },
] as const

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface MockOptions {
  readonly empty?: boolean
  readonly readinessConfirmable?: boolean
}

function clientForFixture(options: MockOptions = {}): WorkbenchClient {
  let created = options.empty !== true
  return new WorkbenchClient({
    baseUrl: 'http://api.test',
    fetchImpl: (input, init) => {
      const url = new URL(String(input), 'http://api.test')
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.pathname
      if (method === 'GET' && path === '/api/v1/projects') {
        return Promise.resolve(jsonResponse({ data: { projects: created ? [PROJECT] : [] } }))
      }
      if (method === 'POST' && path === '/api/v1/projects') {
        created = true
        return Promise.resolve(jsonResponse({ data: { project: PROJECT, revision: REVISION, created: true } }, 201))
      }
      if (method === 'GET' && path.endsWith('/revisions')) {
        return Promise.resolve(jsonResponse({ data: { revisions: [REVISION] } }))
      }
      if (method === 'GET' && path.endsWith('/readiness')) {
        return Promise.resolve(
          jsonResponse({
            data: {
              projectRevisionRef: REVISION.ref,
              projections: [],
              requiredReadiness: ['published_semantics', 'dataset', 'document_index'],
              ready: false,
              blockers: [
                { code: 'READINESS_NOT_BUILT', message: 'dataset readiness has not been built', retryable: true, readinessKind: 'dataset' },
              ],
            },
          }),
        )
      }
      if (method === 'GET' && path.endsWith('/mappings')) {
        return Promise.resolve(jsonResponse({ data: { mappings: [] } }))
      }
      if (method === 'GET' && path.endsWith('/document-index')) {
        return Promise.resolve(
          jsonResponse({
            data: {
              status: {
                projectId: PROJECT_ID,
                collectionRef: `project:${PROJECT_ID}`,
                state: 'pending',
                visibilityEpoch: '1',
                membershipRevision: '0',
                documentCount: 0,
                sourceDocumentCount: 0,
                completeness: 'unknown',
                retryable: true,
              },
            },
          }),
        )
      }
      if (method === 'POST' && path.endsWith('/mappings/preview')) {
        return Promise.resolve(
          jsonResponse({
            data: {
              preview: {
                projectId: PROJECT_ID,
                definitionRef: REVISION.definitionRef,
                objectId: 'device',
                format: 'csv',
                parseId: PARSE_ID,
                columns: [],
                unmappedColumns: [],
                issues: [
                  { code: 'MISSING_COLUMN', severity: 'error', message: 'required attribute name has no column correspondence', fieldRef: 'name' },
                ],
                rowCount: 0,
                confirmable: options.readinessConfirmable === true,
              },
            },
          }),
        )
      }
      return Promise.resolve(jsonResponse({ data: {} }, 404))
    },
  })
}

async function render(panel: ReturnType<typeof createElement>): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(panel)
  })
  await act(async () => {
    await Promise.resolve()
  })
  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('project workspace panel', () => {
  it('shows an empty state and localises required-field failures without creating anything', async () => {
    const client = clientForFixture({ empty: true })
    const { container, root } = await render(
      createElement(ProjectWorkspacePanel, { client, projectBinding: BINDING, packs: PACKS, sources: [SOURCE] }),
    )
    try {
      expect(container.querySelector('[data-testid="project-empty"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="default-quote"]')).toBeNull()

      const form = container.querySelector('[data-testid="project-create"]') as HTMLFormElement
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await Promise.resolve()
      })
      expect(container.querySelector('[data-testid="project-create-error-title"]')?.textContent).toContain('项目名称')
      expect(container.querySelector('[data-testid="project-create-error-pack"]')?.textContent).toContain('行业包')
      expect(container.querySelector('[data-testid="project-create-failure"]')?.getAttribute('data-code')).toBe('INVALID_ARGUMENT')
      expect(container.querySelector('[data-testid="project-list-item"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('creates a project and shows the independent semantic/query/index readiness projections', async () => {
    const client = clientForFixture({ empty: true })
    const { container, root } = await render(
      createElement(ProjectWorkspacePanel, { client, projectBinding: BINDING, packs: PACKS, sources: [SOURCE] }),
    )
    try {
      const title = container.querySelector('[data-testid="project-create-title"]') as HTMLInputElement
      const pack = container.querySelector('[data-testid="project-create-pack"]') as HTMLSelectElement
      await act(async () => {
        setInputValue(title, '桥架项目')
        setSelectValue(pack, 'demo.bridge-pack@1.0.0')
      })
      await act(async () => {
        const form = container.querySelector('[data-testid="project-create"]') as HTMLFormElement
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        await Promise.resolve()
      })
      await flush()
      expect(container.querySelector('[data-testid="project-detail-head-revision"]')?.textContent).toBe('1')
      const rows = container.querySelectorAll('[data-testid="readiness-row"]')
      expect(rows.length).toBe(3)
      expect(container.querySelector('[data-testid="readiness-state-published_semantics"]')?.textContent).toBe('未构建')
      expect(container.querySelector('[data-testid="readiness-state-dataset"]')?.textContent).toBe('未构建')
      expect(container.querySelector('[data-testid="readiness-state-document_index"]')?.textContent).toBe('未构建')
      expect(container.querySelector('[data-testid="readiness-blocker"]')?.getAttribute('data-code')).toBe('READINESS_NOT_BUILT')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('locates a mapping blocker in the preview and does not present it as confirmable', async () => {
    const client = clientForFixture()
    const { container, root } = await render(
      createElement(ProjectWorkspacePanel, { client, projectBinding: BINDING, packs: PACKS, sources: [SOURCE] }),
    )
    try {
      const source = container.querySelector('[data-testid="mapping-source"]') as HTMLSelectElement
      const object = container.querySelector('[data-testid="mapping-object"]') as HTMLSelectElement
      await act(async () => {
        source.value = 'source-1'
        source.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await act(async () => {
        object.value = 'device'
        object.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await act(async () => {
        ;(container.querySelector('[data-testid="mapping-preview-button"]') as HTMLButtonElement).click()
        await Promise.resolve()
      })
      const issue = container.querySelector('[data-testid="mapping-issue"]')
      expect(issue?.getAttribute('data-code')).toBe('MISSING_COLUMN')
      expect(container.querySelector('[data-testid="mapping-preview"]')?.getAttribute('data-confirmable')).toBe('false')
      expect(container.querySelector('[data-testid="mapping-preview-confirmable"]')?.textContent).toContain('不可确认')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('hides create and mapping actions for a readonly principal but keeps the project list', async () => {
    const client = clientForFixture()
    const { container, root } = await render(
      createElement(ProjectWorkspacePanel, { client, projectBinding: BINDING, packs: PACKS, sources: [SOURCE], readOnly: true }),
    )
    try {
      expect(container.querySelector('[data-testid="project-create"]')).toBeNull()
      expect(container.querySelector('[data-testid="mapping-confirm-button"]')).toBeNull()
      expect(container.querySelector('[data-testid="dataset-materialize"]')).toBeNull()
      expect(container.querySelector('[data-testid="project-list-item"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
