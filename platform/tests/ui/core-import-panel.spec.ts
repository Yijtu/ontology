// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreDeploymentScenario, CoreImportRequest } from '@ontology/app-web/client'
import { CoreImportPanel } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const digest = `sha256:${'b'.repeat(64)}`
const scenarios: readonly CoreDeploymentScenario[] = [{
  scenarioId: 'transport-profile-slot',
  sourceScenarioId: 'industrial-maintenance',
  label: '工业资产维护（合成演示）',
  profileRef: { id: 'industrial-profile', version: '1.0.0' },
  environment: 'local_dev',
  namespace: 'synthetic-industrial-maintenance',
  definitionRef: { id: 'industrial-definition', version: '1.0.0', digest },
  availableTasks: ['facts:operating_hours'],
  mappingRefs: [{ id: 'industrial-mapping', version: '1.0.0', digest }],
  rawSourceRefs: [
    { namespace: 'synthetic-industrial-demo', sourceId: 'asset-hours-canonical' },
    { namespace: 'synthetic-industrial-demo', sourceId: 'asset-minutes-layout' },
  ],
}]

class ImportClient extends WorkbenchClient {
  request: CoreImportRequest | undefined
  override async createCoreImport(request: CoreImportRequest) {
    this.request = request
    return {
      jobId: 'f4d6cbbe-7890-4cc8-a36f-33a9a5992487',
      stage: 'received',
      scenarioId: request.scenarioId,
      sourceRef: { namespace: 'synthetic-industrial-demo', sourceId: request.sourceId },
    }
  }
}

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = []
afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount())
    entry.container.remove()
  }
})

describe('Core raw import form', () => {
  it('submits content only against a source declared for the selected scenario', async () => {
    const client = new ImportClient({ baseUrl: 'http://core.test' })
    let importedJobId = ''
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted.push({ root, container })

    await act(async () => {
      root.render(createElement(CoreImportPanel, {
        client,
        scenarios,
        initialScenarioId: 'transport-profile-slot',
        operatorEnabled: true,
        onImported: (jobId: string) => { importedJobId = jobId },
      }))
    })
    const sourcePicker = container.querySelector('[data-testid="core-import-source"]') as HTMLSelectElement | null
    const content = container.querySelector('[data-testid="core-import-content"]') as HTMLTextAreaElement | null
    const form = container.querySelector('[data-testid="core-import-panel"] form')
    if (sourcePicker === null || content === null || form === null) throw new Error('import form was not mounted')

    await act(async () => {
      sourcePicker.value = 'asset-minutes-layout'
      sourcePicker.dispatchEvent(new Event('change', { bubbles: true }))
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      if (setValue === undefined) throw new Error('textarea value setter is unavailable')
      setValue.call(content, '{"asset_id":"I-04","operating_minutes":6000}')
      content.dispatchEvent(new Event('input', { bubbles: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(client.request).toEqual({
      scenarioId: 'industrial-maintenance',
      sourceId: 'asset-minutes-layout',
      content: '{"asset_id":"I-04","operating_minutes":6000}',
    })
    expect(importedJobId).toBe('f4d6cbbe-7890-4cc8-a36f-33a9a5992487')
    expect(container.querySelector('[data-testid="core-import-notice"]')?.textContent).toContain('已创建解析任务')
  })
})
