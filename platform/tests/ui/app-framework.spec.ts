// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { App, Drawer, Field } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true
const mounted: { cleanup: () => Promise<void> }[] = []
afterEach(async () => { for (const entry of mounted.splice(0)) await entry.cleanup(); window.history.replaceState(null, '', '/') })

function client(): WorkbenchClient {
  return new WorkbenchClient({ baseUrl: 'http://framework.test', fetchImpl: (input) => {
    const path = new URL(String(input)).pathname
    const data = path.endsWith('projects') ? { projects: ['one', 'two'].map((id) => ({ projectId: id, title: `项目 ${id}`, headRevision: '1', state: 'draft', createdBy: 'operator', createdAt: '2026-10-08', updatedAt: '2026-10-08' })) } : { workspaces: [] }
    return Promise.resolve(new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } }))
  } })
}

async function mount(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(node))
  mounted.push({ cleanup: async () => { await act(async () => root.unmount()); container.remove() } })
  return container
}

async function click(element: Element | null): Promise<void> {
  if (element === null) throw new Error('missing test control')
  await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('application framework contracts', () => {
  it('does not mix project-bound page state, and requires an explicit dirty discard', async () => {
    window.history.replaceState(null, '', '/?project=one&run=old-run')
    const container = await mount(createElement(App, { client: client(), profileRef: { id: 'configured', version: '1.0.0' }, timeZone: 'UTC', initialView: 'contributed',
      scenarioViews: [{ view: 'contributed', label: '注册任务', render: ({ context }) => createElement('div', null,
        createElement('p', { 'data-testid': 'binding' }, context.projectId),
        createElement('select', { 'data-testid': 'draft', defaultValue: '' }, createElement('option', { value: '' }, '待选择'), createElement('option', { value: 'changed' }, '已编辑')),
      ) }] }))
    const draft = container.querySelector<HTMLSelectElement>('[data-testid="draft"]')!
    await act(async () => { draft.value = 'changed'; draft.dispatchEvent(new Event('change', { bubbles: true })) })
    const project = container.querySelector<HTMLSelectElement>('[data-testid="context-project-select"]')!
    await act(async () => { project.value = 'two'; project.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('[data-testid="binding"]')?.textContent).toBe('one')
    await click([...container.querySelectorAll('button')].find((button) => button.textContent === '继续编辑') ?? null)
    expect(draft.value).toBe('changed')
    await act(async () => { project.value = 'two'; project.dispatchEvent(new Event('change', { bubbles: true })) })
    await click(container.querySelector('[data-testid="shell-discard-changes"]'))
    expect(container.querySelector('[data-testid="binding"]')?.textContent).toBe('two')
    expect(container.querySelector<HTMLSelectElement>('[data-testid="draft"]')?.value).toBe('')
    expect(new URL(window.location.href).searchParams.has('run')).toBe(false)
    expect(new URL(window.location.href).searchParams.get('project')).toBe('two')
  })

  it('keeps navigation and browser history synchronized', async () => {
    const container = await mount(createElement(App, { client: client(), profileRef: { id: 'configured', version: '1.0.0' }, timeZone: 'UTC' }))
    await click(container.querySelector('[data-testid="tab-definitions"]'))
    expect(new URL(window.location.href).searchParams.get('view')).toBe('definitions')
    expect(container.querySelector('[data-testid="workspace-required"]')).not.toBeNull()
    window.history.replaceState(null, '', '/?view=instances&project=two')
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(container.querySelector('.app')?.getAttribute('data-view')).toBe('instances')
    expect(container.querySelector<HTMLSelectElement>('[data-testid="context-project-select"]')?.value).toBe('two')
  })

  it('labels fields with their help text and traps drawer keyboard focus', async () => {
    const container = await mount(createElement('div', null,
      createElement(Field, { label: '项目名称', hint: '便于识别项目', children: (attributes) => createElement('input', attributes) }),
      createElement(Drawer, { open: true, title: '来源', onClose: () => undefined, children: createElement('button', null, '查看原文') }),
    ))
    const input = container.querySelector('input')!
    expect(container.querySelector('label')?.htmlFor).toBe(input.id)
    expect(document.getElementById(input.getAttribute('aria-describedby') ?? '')?.textContent).toBe('便于识别项目')
    const buttons = container.querySelectorAll<HTMLButtonElement>('dialog button')
    buttons[buttons.length - 1]?.focus()
    await act(async () => buttons[buttons.length - 1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })))
    expect(document.activeElement).toBe(buttons[0])
  })
})
