// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { ProjectWorkspacePanel } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { ProjectRecord } from '@ontology/contracts'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true
const projects: ProjectRecord[] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'].map((projectId, index) => ({
  projectId, title: `项目 ${index + 1}`, headRevision: '1', state: 'draft', createdBy: 'operator',
  createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
}))

describe('mounted project panel context ownership', () => {
  it('adopts an incoming topbar project selection instead of retaining the previous project', async () => {
    const client = new WorkbenchClient({ baseUrl: 'http://project-context.test', fetchImpl: (input) => {
      const path = new URL(String(input)).pathname
      const data = path === '/api/v1/projects' ? { projects } : undefined
      return Promise.resolve(new Response(JSON.stringify(data === undefined
        ? { error: { code: 'NOT_FOUND', message: 'Not part of this selection-only UI fixture' } } : { data }), {
        status: data === undefined ? 404 : 200, headers: { 'content-type': 'application/json' },
      }))
    } })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const selected: string[] = []
    try {
      await act(async () => root.render(createElement(ProjectWorkspacePanel, {
        client, packs: [], initialProjectId: projects[0]!.projectId, onSelectProject: (id) => selected.push(id),
      })))
      expect(container.querySelector('[data-testid="project-detail"]')?.getAttribute('data-project-id')).toBe(projects[0]!.projectId)
      selected.length = 0
      await act(async () => root.render(createElement(ProjectWorkspacePanel, {
        client, packs: [], initialProjectId: projects[1]!.projectId, onSelectProject: (id) => selected.push(id),
      })))
      expect(container.querySelector('[data-testid="project-detail"]')?.getAttribute('data-project-id')).toBe(projects[1]!.projectId)
      expect(selected).not.toContain(projects[0]!.projectId)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
