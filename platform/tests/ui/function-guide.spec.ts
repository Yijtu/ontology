// @vitest-environment jsdom
import { act, createElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FunctionGuide } from '../../apps/web/src/components/FunctionGuide'
import { GuideHome } from '../../apps/web/src/components/GuideHome'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

describe('plain-language core feature guides', () => {
  let root: ReturnType<typeof createRoot> | undefined
  let container: HTMLElement | undefined

  afterEach(async () => {
    if (root !== undefined) await act(async () => root?.unmount())
    root = undefined
    container?.remove()
    container = undefined
    document.body.innerHTML = ''
  })

  async function render(element: ReactNode): Promise<HTMLElement> {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(element))
    return container
  }

  it('explains all core views without repeating their page headings', async () => {
    const views = ['start', 'ontology', 'projects', 'definitions', 'instances', 'packages', 'business', 'workbench', 'query', 'jobs', 'review', 'evidence', 'models']
    for (const view of views) {
      const page = await render(createElement(FunctionGuide, { view }))
      const guide = page.querySelector<HTMLElement>('[data-testid="function-guide"]')
      expect(guide?.getAttribute('data-view')).toBe(view)
      expect(guide?.querySelector('h3')?.textContent).toBe('本页说明')
      expect(guide?.textContent).toContain('用途')
      expect(guide?.textContent).toContain('开始前')
      expect(guide?.textContent).toContain('完成后')
      expect(guide?.querySelector('details ol li')).not.toBeNull()
      await act(async () => root?.unmount())
      root = undefined
      page.remove()
      container = undefined
    }
  })

  it('routes from registered business tasks to query and model settings', async () => {
    const onNavigate = vi.fn()
    const onConfigureModel = vi.fn()
    const page = await render(createElement(FunctionGuide, { view: 'business', onNavigate, onConfigureModel }))
    const navigation = page.querySelector<HTMLButtonElement>('.function-guide__actions button')
    const configure = page.querySelector<HTMLButtonElement>('[data-testid="function-guide-configure-model"]')
    if (navigation === null || configure === null) throw new Error('query guide actions are missing')
    expect(navigation.textContent).toBe('打开业务问答')
    expect(configure.textContent).toBe('生成模型设置')
    await act(async () => navigation.click())
    await act(async () => configure.click())
    expect(onNavigate).toHaveBeenCalledWith('query')
    expect(onConfigureModel).toHaveBeenCalledTimes(1)
  })

  it('shows a home-page entry to business questions and optional model setup', async () => {
    const onNavigate = vi.fn()
    const onConfigureModel = vi.fn()
    const page = await render(createElement(GuideHome, {
      scenarioLabel: '当前场景', classificationLabel: '业务数据', operatorEnabled: true,
      onNavigate, onConfigureModel,
    }))
    const query = [...page.querySelectorAll('button')].find((button) => button.textContent === '开始业务问答')
    const models = [...page.querySelectorAll('button')].find((button) => button.textContent === '生成模型设置')
    if (query === undefined || models === undefined) throw new Error('the guide-home query/model entry is missing')
    await act(async () => query.click())
    await act(async () => models.click())
    expect(onNavigate).toHaveBeenCalledWith('query')
    expect(onConfigureModel).toHaveBeenCalledTimes(1)
  })
})
