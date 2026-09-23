// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { App } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

describe('scenario-neutral web shell', () => {
  it('mounts a transport view and query profile without importing the energy view into App', async () => {
    const profileRef = { id: 'transport-facility-inspection', version: '1.0.0' }
    const requested: string[] = []
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: (input) => {
        requested.push(String(input))
        return Promise.resolve(new Response(JSON.stringify({ data: {
          profileRef,
          resolvedProfileHash: `sha256:${'1'.repeat(64)}`,
          webSearchEnabled: false,
          toolIds: ['data_query'],
          allowedDomains: [],
          explicitDegradations: [],
        } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () => {
        root.render(createElement(App, {
          client,
          profileRef,
          timeZone: 'UTC',
          queryContextFields: [{ name: 'district', label: '区域', kind: 'text', defaultValue: 'north' }],
          initialView: 'transport-inspection',
          scenarioViews: [{
            view: 'transport-inspection',
            label: '交通设施巡检',
            render: () => createElement('section', { 'data-testid': 'transport-inspection' }, '巡检任务'),
          }],
        }))
      })
      expect(container.querySelector('[data-testid="transport-inspection"]')?.textContent).toBe('巡检任务')
      expect(container.querySelector('[data-testid="tab-energy"]')).toBeNull()
      const queryTab = container.querySelector('[data-testid="tab-query"]')
      if (queryTab === null) throw new Error('generic query tab is missing')
      await act(async () => {
        queryTab.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.querySelector('[data-testid="scope-profile"]')?.textContent).toContain(profileRef.id)
      expect((container.querySelector('[data-testid="query-context-district"]') as HTMLInputElement | null)?.value).toBe('north')
      expect(container.querySelector('[data-testid="query-context-siteRef"]')).toBeNull()
      expect(requested.some((url) => url.includes(`profileId=${profileRef.id}`))).toBe(true)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
