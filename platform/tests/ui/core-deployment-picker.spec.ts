// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreDeploymentScenario } from '@ontology/app-web/client'
import { App } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const digest = `sha256:${'1'.repeat(64)}` as const
const sourceRef = { namespace: 'synthetic-test', sourceId: 'records' }
const scenarios: readonly CoreDeploymentScenario[] = [
  {
    scenarioId: 'transport',
    label: '交通设施巡检（合成演示）',
    profileRef: { id: 'transport-profile', version: '1.0.0' },
    environment: 'local_dev',
    namespace: 'synthetic-transport-facility',
    definitionRef: { id: 'transport-definition', version: '1.0.0', digest },
    baseProfileSpec: {
      industryRef: { id: 'transport-industry', version: '1.0.0', digest },
      mappingRefs: [{
        id: 'transport-mapping', version: '1.0.0', digest, role: 'catalog',
        sourceObjectRef: { sourceRef: { namespace: 'synthetic-test', sourceId: 'records' }, objectPath: 'records' },
      }],
      runtimeRef: { id: 'runtime-template', version: '1.0.0', digest },
      backendBindings: {},
      modelBindings: {},
      toolBindings: [],
      computeBindings: [],
      policyRef: { id: 'core-policy', version: '1.0.0', digest },
    },
    availableTasks: ['facts:inspection_due'],
    mappingRefs: [{ id: 'transport-mapping', version: '1.0.0', digest }],
    rawSourceRefs: [sourceRef],
  },
  {
    scenarioId: 'industrial',
    label: '工业资产维护（合成演示）',
    profileRef: { id: 'industrial-profile', version: '1.0.0' },
    environment: 'local_dev',
    namespace: 'synthetic-industrial-maintenance',
    definitionRef: { id: 'industrial-definition', version: '1.0.0', digest },
    availableTasks: ['facts:operating_hours'],
    mappingRefs: [{ id: 'industrial-mapping', version: '1.0.0', digest }],
    rawSourceRefs: [sourceRef],
  },
]

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = []
afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount())
    entry.container.remove()
  }
})

describe('Core deployment picker', () => {
  it('switches the shared query surface by profile and offers only the selected scenario tasks', async () => {
    const requestedProfiles: string[] = []
    const client = new WorkbenchClient({
      baseUrl: 'http://core.test',
      fetchImpl: (input) => {
        const url = new URL(String(input))
        requestedProfiles.push(url.searchParams.get('profileId') ?? '')
        const selected = scenarios.find((scenario) => scenario.profileRef.id === url.searchParams.get('profileId')) ?? scenarios[0]
        if (selected === undefined) throw new Error('test scenario missing')
        return Promise.resolve(new Response(JSON.stringify({ data: {
          profileRef: selected.profileRef,
          resolvedProfileHash: digest,
          webSearchEnabled: false,
          toolIds: ['ontology_lookup'],
          allowedDomains: [],
          explicitDegradations: [],
        } }), { status: 200, headers: { 'content-type': 'application/json' } }))
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted.push({ root, container })

    await act(async () => {
      root.render(createElement(App, {
        client,
        profileRef: scenarios[0]!.profileRef,
        timeZone: 'UTC',
        deploymentClassification: 'public_synthetic_demo_not_an_industry_standard',
        deploymentModels: { generation: false, decision: false },
        deploymentOperatorEnabled: true,
        deploymentScenarios: scenarios,
        initialView: 'query',
      }))
    })

    const taskPicker = container.querySelector('[data-testid="query-registered-task"]') as HTMLSelectElement | null
    expect(taskPicker?.querySelectorAll('option')).toHaveLength(2)
    await act(async () => {
      taskPicker!.value = 'facts:inspection_due'
      taskPicker!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect((container.querySelector('[data-testid="query-question"]') as HTMLTextAreaElement | null)?.value).toBe('facts:inspection_due')

    const scenarioPicker = container.querySelector('[data-testid="core-scenario-select"]') as HTMLSelectElement | null
    await act(async () => {
      scenarioPicker!.value = 'industrial'
      scenarioPicker!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    const discard = container.querySelector('[data-testid="shell-discard-changes"]')
    if (discard !== null) await act(async () => { discard.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(container.querySelector('[data-testid="scope-profile"]')?.textContent).toContain('industrial-profile@1.0.0')
    expect(requestedProfiles).toContain('industrial-profile')
    expect(container.querySelector('[data-testid="query-registered-task"]')?.textContent).toContain('facts:operating_hours')
    expect(container.querySelector('[data-testid="tab-energy"]')).toBeNull()
    expect(container.querySelector('[data-testid="core-deployment-classification"]')?.textContent).toBe('合成演示数据（非行业标准）')
    expect(container.querySelector('[data-testid="query-capability-note"]')?.textContent).toContain('文本生成未启用')
  })

  it('passes the mounted base profile spec into the shared Workbench publication flow', async () => {
    const componentRef = { id: 'transport-industry', version: '1.0.0', digest }
    const client = new WorkbenchClient({
      baseUrl: 'http://core.test',
      fetchImpl: (input) => {
        const path = new URL(String(input)).pathname
        const data = path.endsWith('/components') ? {
          components: [{
            manifestRef: componentRef,
            manifest: {
              kind: 'industry_pack', id: componentRef.id, version: componentRef.version, digest,
              contractRange: { min: '0.2.0', max: '1.0.0' }, provides: [], requires: [],
              entrypointRef: { kind: 'package', ref: 'synthetic-transport-facility' }, trustStatus: 'local_dev',
            },
            lifecycleState: 'active', registeredAt: '2026-09-28T00:00:00Z',
          }],
        } : { sources: [] }
        return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }))
      },
    })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted.push({ root, container })

    await act(async () => {
      root.render(createElement(App, {
        client,
        profileRef: scenarios[0]!.profileRef,
        timeZone: 'UTC',
        deploymentScenarios: scenarios,
        initialView: 'workbench',
      }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(container.querySelector('[data-testid="profile-publish"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="new-profile-version"]')).not.toBeNull()
  })
})
