// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { IndustryWorkspace } from '@ontology/contracts'
import {
  OntologyWorkspacePanel,
  boundaryOf,
  EMPTY_CREATE_FIELDS,
  isValidNamespace,
  namespaceFromName,
  validateCreateFields,
} from '@ontology/app-web'
import type { WorkspaceIdentity } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const DIGEST = `sha256:${'a'.repeat(64)}`

const identity: WorkspaceIdentity = {
  newId: () => WORKSPACE_ID,
  sha256: () => Promise.resolve(DIGEST),
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('ontology workspace create validation', () => {
  it('requires only the name and namespace, and treats goals as optional', () => {
    const empty = validateCreateFields(EMPTY_CREATE_FIELDS)
    expect(empty['displayName']).toContain('名称')
    expect(empty['namespace']).toContain('命名空间')
    expect(empty['goals']).toBeUndefined()

    const filled = validateCreateFields({
      ...EMPTY_CREATE_FIELDS,
      displayName: '  桥架  ',
      namespace: 'bridge',
    })
    expect(Object.keys(filled)).toHaveLength(0)
    expect(validateCreateFields({ ...EMPTY_CREATE_FIELDS, displayName: '桥架', namespace: 'bridge', goals: '' })).toEqual({})
    expect(validateCreateFields({ ...EMPTY_CREATE_FIELDS, displayName: '桥架', namespace: 'Bridge' })['namespace']).toBeDefined()
    expect(validateCreateFields({ ...EMPTY_CREATE_FIELDS, displayName: '桥架', namespace: 'bridge_ontology' })['namespace']).toBeDefined()
    expect(boundaryOf({ ...EMPTY_CREATE_FIELDS, goals: ' A \nB', included: 'C', excluded: '' })).toEqual({
      goals: ['A', 'B'],
      included: ['C'],
      excluded: [],
      applicability: {},
    })
  })

  it('derives a legal namespace slug from the workspace name', () => {
    expect(namespaceFromName('Bridge Ontology')).toBe('bridge-ontology')
    expect(namespaceFromName('  Bridge  Ontology  ')).toBe('bridge-ontology')
    expect(namespaceFromName('桥架本体工作区')).toBe('ws')
    expect(namespaceFromName('')).toBe('ws')
    expect(namespaceFromName('123 Bridge')).toBe('ws-123-bridge')
    expect(namespaceFromName('Bridge--Ontology!!')).toBe('bridge-ontology')
    expect(namespaceFromName('b'.repeat(80))).toHaveLength(64)
    expect(isValidNamespace(namespaceFromName('Bridge Ontology'))).toBe(true)
    expect(isValidNamespace('Bridge')).toBe(false)
  })
})

describe('ontology workspace panel', () => {
  it('shows the empty state when no workspace is visible', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: (input) => {
        if (String(input).includes('/industry-workspaces')) {
          return Promise.resolve(jsonResponse({ data: { workspaces: [] } }))
        }
        return Promise.resolve(jsonResponse({ data: {} }, 404))
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(OntologyWorkspacePanel, { client, identity }))
      })
      expect(container.querySelector('[data-testid="workspace-empty"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('creates a workspace through the real client and lists the draft revision', async () => {
    const created: IndustryWorkspace = {
      workspaceId: WORKSPACE_ID,
      namespace: 'bridge',
      displayName: '桥架本体工作区',
      boundary: { goals: ['目标A'], included: [], excluded: [], applicability: { region: 'CN' } },
      headRevision: '1',
      state: 'draft',
    }
    const draft = {
      workspaceId: WORKSPACE_ID,
      revision: '1',
      digest: DIGEST,
      documentSetRef: { id: WORKSPACE_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' },
      candidateRefs: [],
    }
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.includes('/drafts')) {
          return Promise.resolve(jsonResponse({ data: { drafts: [draft] } }))
        }
        if (url.includes('/industry-workspaces') && method === 'GET') {
          return Promise.resolve(jsonResponse({ data: { workspaces: [] } }))
        }
        if (url.endsWith('/core/workspace-bootstrap') && method === 'POST') {
          const body = isRecord(init?.body) ? init.body : JSON.parse(String(init?.body)) as unknown
          if (!isRecord(body) || typeof body['displayName'] !== 'string') {
            return Promise.resolve(jsonResponse({ error: { code: 'INVALID_ARGUMENT', message: 'bad' } }, 400))
          }
          expect(body).not.toHaveProperty('documentSetRef')
          expect(body).not.toHaveProperty('profileRef')
          return Promise.resolve(jsonResponse({ data: { workspace: created, draftRef: {
            workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST,
          }, draft, created: true } }))
        }
        return Promise.resolve(jsonResponse({ data: {} }, 404))
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(OntologyWorkspacePanel, { client, identity }))
      })
      const nameInput = container.querySelector<HTMLInputElement>('[data-testid="workspace-create-display-name"]')
      const namespaceInput = container.querySelector<HTMLInputElement>('[data-testid="workspace-create-namespace"]')
      const goalsInput = container.querySelector<HTMLTextAreaElement>('[data-testid="workspace-create-goals"]')
      if (nameInput === null || namespaceInput === null || goalsInput === null) {
        throw new Error('the create form is missing a required field')
      }
      await act(async () => {
        setInputValue(nameInput, '桥架本体工作区')
        setInputValue(namespaceInput, 'bridge')
        setInputValue(goalsInput, '目标A')
      })
      await act(async () => {
        container.querySelector<HTMLFormElement>('[data-testid="workspace-create-form"]')?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(container.querySelector('[data-testid="workspace-detail-name"]')?.textContent).toBe('桥架本体工作区')
      expect(container.querySelector('[data-testid="workspace-detail-head-revision"]')?.textContent).toBe('1')
      expect(container.querySelectorAll('[data-testid="workspace-draft"]')).toHaveLength(1)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('creates with only the name, auto-deriving the namespace and keeping more settings collapsed', async () => {
    const created: IndustryWorkspace = {
      workspaceId: WORKSPACE_ID,
      namespace: 'bridge-ontology',
      displayName: 'Bridge Ontology',
      boundary: { goals: [], included: [], excluded: [], applicability: {} },
      headRevision: '1',
      state: 'draft',
    }
    const draft = {
      workspaceId: WORKSPACE_ID,
      revision: '1',
      digest: DIGEST,
      documentSetRef: { id: WORKSPACE_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' },
      candidateRefs: [],
    }
    let postedBody: Record<string, unknown> | undefined
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url.includes('/drafts')) return Promise.resolve(jsonResponse({ data: { drafts: [draft] } }))
        if (url.includes('/industry-workspaces') && method === 'GET') {
          return Promise.resolve(jsonResponse({ data: { workspaces: [] } }))
        }
        if (url.endsWith('/core/workspace-bootstrap') && method === 'POST') {
          const parsed = isRecord(init?.body) ? init.body : JSON.parse(String(init?.body)) as unknown
          if (isRecord(parsed)) postedBody = parsed
          return Promise.resolve(jsonResponse({ data: { workspace: created, draftRef: {
            workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST,
          }, draft, created: true } }))
        }
        return Promise.resolve(jsonResponse({ data: {} }, 404))
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(OntologyWorkspacePanel, { client, identity }))
      })
      const more = container.querySelector<HTMLDetailsElement>('[data-testid="workspace-create-more"]')
      expect(more?.open).toBe(false)
      const nameInput = container.querySelector<HTMLInputElement>('[data-testid="workspace-create-display-name"]')
      if (nameInput === null) throw new Error('the create form is missing the name field')
      await act(async () => {
        setInputValue(nameInput, 'Bridge Ontology')
      })
      expect(container.querySelector<HTMLInputElement>('[data-testid="workspace-create-namespace"]')?.value).toBe('bridge-ontology')
      await act(async () => {
        container.querySelector<HTMLFormElement>('[data-testid="workspace-create-form"]')?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(postedBody?.['namespace']).toBe('bridge-ontology')
      expect(postedBody?.['boundary']).toEqual({ goals: [], included: [], excluded: [], applicability: {} })
      expect(container.querySelector('[data-testid="workspace-detail-name"]')?.textContent).toBe('Bridge Ontology')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('reveals more settings when the namespace is cleared so the error stays visible', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: (input) => {
        if (String(input).includes('/industry-workspaces')) {
          return Promise.resolve(jsonResponse({ data: { workspaces: [] } }))
        }
        return Promise.resolve(jsonResponse({ data: {} }, 404))
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(OntologyWorkspacePanel, { client, identity }))
      })
      const nameInput = container.querySelector<HTMLInputElement>('[data-testid="workspace-create-display-name"]')
      const namespaceInput = container.querySelector<HTMLInputElement>('[data-testid="workspace-create-namespace"]')
      if (nameInput === null || namespaceInput === null) throw new Error('the create form is missing a field')
      await act(async () => {
        setInputValue(nameInput, 'Bridge Ontology')
      })
      await act(async () => {
        setInputValue(namespaceInput, '')
      })
      await act(async () => {
        container.querySelector<HTMLFormElement>('[data-testid="workspace-create-form"]')?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        )
      })
      expect(container.querySelector('[data-testid="workspace-create-error-namespace"]')).not.toBeNull()
      expect(container.querySelector<HTMLDetailsElement>('[data-testid="workspace-create-more"]')?.open).toBe(true)
      expect(container.querySelector('[data-testid="workspace-list-item"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
