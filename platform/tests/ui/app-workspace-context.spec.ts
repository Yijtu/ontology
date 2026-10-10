// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { IndustryWorkspace } from '@ontology/contracts'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true
const workspaceA = '11111111-1111-4111-8111-111111111111'
const workspaceB = '22222222-2222-4222-8222-222222222222'
const workspaces: readonly IndustryWorkspace[] = [workspaceA, workspaceB].map((workspaceId, index) => ({
  workspaceId, namespace: `context-${index}`, displayName: `工作区 ${index + 1}`,
  boundary: { goals: ['检查上下文同步'], included: [], excluded: [], applicability: {} },
  headRevision: '1', state: 'draft',
}))

afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, '', '/') })

describe('main App workspace selection ownership', () => {
  it('adopts topbar workspace B while ontology stays mounted, without writing stale A back', async () => {
    window.history.replaceState(null, '', `/?view=ontology&workspace=${workspaceA}`)
    const historyWrites: string[] = []
    const replace = window.history.replaceState.bind(window.history)
    vi.spyOn(window.history, 'replaceState').mockImplementation((data: unknown, unused: string, url?: string | URL | null) => {
      const workspace = new URL(String(url ?? window.location.href), window.location.href).searchParams.get('workspace')
      if (workspace !== null && historyWrites.at(-1) !== workspace) historyWrites.push(workspace)
      // Bound a broken feedback loop so this regression fails instead of hanging the worker.
      if (historyWrites.length > 8) throw new Error('Workspace selection repeatedly wrote stale context into browser history')
      replace(data, unused, url)
    })
    const client = new WorkbenchClient({ baseUrl: 'http://context.test', fetchImpl: (input) => {
      const path = new URL(String(input)).pathname
      const data = path === '/api/v1/industry-workspaces' ? { workspaces }
        : path === '/api/v1/projects' ? { projects: [] }
          : path.endsWith('/drafts') ? { drafts: [] } : undefined
      return Promise.resolve(new Response(JSON.stringify(data === undefined ? { error: { code: 'NOT_FOUND', message: 'Not part of this UI contract fixture' } } : { data }), {
        status: data === undefined ? 404 : 200, headers: { 'content-type': 'application/json' },
      }))
    } })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(App, { client, profileRef: { id: 'context-profile', version: '1.0.0' }, timeZone: 'UTC', initialView: 'ontology', deploymentOperatorEnabled: true })))
      expect(container.querySelector('[data-testid="workspace-detail"]')?.getAttribute('data-workspace-id')).toBe(workspaceA)
      const picker = container.querySelector<HTMLSelectElement>('[data-testid="context-workspace-select"]')
      if (picker === null) throw new Error('Actual App workspace picker missing')
      await act(async () => { picker.value = workspaceB; picker.dispatchEvent(new Event('change', { bubbles: true })) })
      await act(async () => { await Promise.resolve() })
      expect(container.querySelector<HTMLSelectElement>('[data-testid="context-workspace-select"]')?.value).toBe(workspaceB)
      expect(container.querySelector('[data-testid="workspace-detail"]')?.getAttribute('data-workspace-id')).toBe(workspaceB)
      expect(new URL(window.location.href).searchParams.get('workspace')).toBe(workspaceB)
      expect(historyWrites).toEqual([workspaceA, workspaceB])
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
