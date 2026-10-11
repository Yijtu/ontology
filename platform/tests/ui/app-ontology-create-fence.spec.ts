// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { AssetDraftVersion, IndustryWorkspace } from '@ontology/contracts'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true
const workspaceA: IndustryWorkspace = {
  workspaceId: '11111111-1111-4111-8111-111111111111', namespace: 'existing', displayName: '现有工作区',
  boundary: { goals: ['继续现有工作'], included: [], excluded: [], applicability: {} }, headRevision: '1', state: 'draft',
}
const workspaceB: IndustryWorkspace = {
  workspaceId: '22222222-2222-4222-8222-222222222222', namespace: 'created', displayName: '延迟创建工作区',
  boundary: { goals: ['独立目标'], included: [], excluded: [], applicability: {} }, headRevision: '1', state: 'draft',
}

afterEach(() => { vi.restoreAllMocks(); window.history.replaceState(null, '', '/') })

describe('main App late workspace-create acknowledgement', () => {
  it('does not adopt a server acknowledgement after the operator discards and leaves the creating panel', async () => {
    window.history.replaceState(null, '', `/?view=ontology&workspace=${workspaceA.workspaceId}`)
    const client = new WorkbenchClient({ baseUrl: 'http://ontology-create.test', fetchImpl: (input) => {
      const path = new URL(String(input)).pathname
      const data = path === '/api/v1/industry-workspaces' ? { workspaces: [workspaceA] }
        : path === '/api/v1/projects' ? { projects: [] }
          : path.endsWith('/drafts') ? { drafts: [] } : undefined
      return Promise.resolve(new Response(JSON.stringify(data === undefined ? { error: { code: 'NOT_FOUND', message: 'Not part of this UI regression' } } : { data }), {
        status: data === undefined ? 404 : 200, headers: { 'content-type': 'application/json' },
      }))
    } })
    let resolveCreate: ((value: { readonly workspace: IndustryWorkspace; readonly draft: AssetDraftVersion }) => void) | undefined
    const delayedCreate = new Promise<{ readonly workspace: IndustryWorkspace; readonly draft: AssetDraftVersion }>((resolve) => { resolveCreate = resolve })
    const create = vi.spyOn(client, 'bootstrapIndustryWorkspace').mockReturnValue(delayedCreate)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(App, { client, profileRef: { id: 'create-profile', version: '1.0.0' }, timeZone: 'UTC', initialView: 'ontology', deploymentOperatorEnabled: true })))
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      const fill = (selector: string, value: string): void => {
        const control = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
        if (control === null) throw new Error(`Missing input ${selector}`)
        const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value)
        control.dispatchEvent(new Event('input', { bubbles: true }))
        control.dispatchEvent(new Event('change', { bubbles: true }))
      }
      await act(async () => {
        fill('[data-testid="workspace-create-display-name"]', workspaceB.displayName)
        fill('[data-testid="workspace-create-namespace"]', workspaceB.namespace)
        fill('[data-testid="workspace-create-goals"]', '独立目标')
        container.querySelector<HTMLFormElement>('[data-testid="workspace-create-form"]')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
      const queryTab = container.querySelector<HTMLButtonElement>('[data-testid="tab-query"]')
      if (queryTab === null) throw new Error('Query navigation is missing')
      await act(async () => queryTab.click())
      expect(container.querySelector('dialog')?.textContent).toContain('离开当前工作内容？')
      const discard = container.querySelector<HTMLButtonElement>('[data-testid="shell-discard-changes"]')
      if (discard === null) throw new Error('Discard action is missing')
      await act(async () => discard.click())
      expect(new URL(window.location.href).searchParams.get('view')).toBe('query')
      expect(new URL(window.location.href).searchParams.get('workspace')).toBe(workspaceA.workspaceId)

      const draft: AssetDraftVersion = {
        workspaceId: workspaceB.workspaceId, revision: '1', digest: `sha256:${'a'.repeat(64)}`,
        documentSetRef: { id: '33333333-3333-4333-8333-333333333333', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' },
        candidateRefs: [],
      }
      const completeCreate = resolveCreate
      if (completeCreate === undefined) throw new Error('Pending validated-client response was not captured')
      await act(async () => completeCreate({ workspace: workspaceB, draft }))
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      expect(new URL(window.location.href).searchParams.get('view')).toBe('query')
      expect(new URL(window.location.href).searchParams.get('workspace')).toBe(workspaceA.workspaceId)
      expect(container.querySelector<HTMLSelectElement>('[data-testid="context-workspace-select"]')?.value).toBe(workspaceA.workspaceId)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
