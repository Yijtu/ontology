// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { IndustryWorkspace } from '@ontology/contracts'
import {
  OntologyWorkspacePanel,
  boundaryOf,
  EMPTY_CREATE_FIELDS,
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
  it('localises each missing required field and accepts a filled boundary', () => {
    const empty = validateCreateFields(EMPTY_CREATE_FIELDS)
    expect(empty['displayName']).toContain('名称')
    expect(empty['namespace']).toContain('命名空间')
    expect(empty['goals']).toContain('业务目标')

    const filled = validateCreateFields({
      ...EMPTY_CREATE_FIELDS,
      displayName: '  桥架  ',
      namespace: 'bridge',
      goals: '\n 目标A \n\n 目标B\n',
    })
    expect(Object.keys(filled)).toHaveLength(0)
    expect(boundaryOf({ ...EMPTY_CREATE_FIELDS, goals: ' A \nB', included: 'C', excluded: '' })).toEqual({
      goals: ['A', 'B'],
      included: ['C'],
      excluded: [],
      applicability: {},
    })
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
        if (url.endsWith('/industry-workspaces') && method === 'POST') {
          const body = isRecord(init?.body) ? init.body : JSON.parse(String(init?.body)) as unknown
          if (!isRecord(body) || typeof body['displayName'] !== 'string') {
            return Promise.resolve(jsonResponse({ error: { code: 'INVALID_ARGUMENT', message: 'bad' } }, 400))
          }
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
})

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
