// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ComponentVersionRecord,
  DeploymentEnvironment,
  ProfileRef,
  ProfileSpec,
  VersionRef,
} from '@ontology/contracts'
import { Workbench } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type {
  ActivateProfileRequest,
  ComponentFilter,
  PublishProfileRequest,
} from '@ontology/app-web/client'
import { ALL_ROLES, PROFILE, PROFILE_V2, registeredComponents, sampleProfileSpec, startHarness } from './workbench-fixtures'
import type { Harness } from './workbench-fixtures'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

type RecordedProfileCall =
  | { readonly operation: 'publish'; readonly request: PublishProfileRequest }
  | { readonly operation: 'preflight'; readonly profileRef: ProfileRef }
  | { readonly operation: 'activate'; readonly request: ActivateProfileRequest }

class RecordingWorkbenchClient extends WorkbenchClient {
  readonly calls: RecordedProfileCall[] = []
  readonly extraComponents: readonly ComponentVersionRecord[]
  rejectPublish = false
  afterPreflight?: (profileRef: ProfileRef) => Promise<void>

  constructor(baseUrl: string, extraComponents: readonly ComponentVersionRecord[] = []) {
    super({
      baseUrl,
      fetchImpl: (input, init) => fetch(input, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          'x-test-subject': 'ui-owner',
          'x-test-roles': ALL_ROLES,
          'x-test-scope': 'a',
        },
      }),
    })
    this.extraComponents = extraComponents
  }

  override async listComponents(filter?: ComponentFilter): Promise<ComponentVersionRecord[]> {
    return [...await super.listComponents(filter), ...this.extraComponents]
  }

  override publishProfile(request: PublishProfileRequest) {
    this.calls.push({ operation: 'publish', request })
    if (this.rejectPublish) return Promise.reject(new Error('controlled publish failure'))
    return super.publishProfile(request)
  }

  override async preflightProfile(profileRef: ProfileRef) {
    this.calls.push({ operation: 'preflight', profileRef })
    const result = await super.preflightProfile(profileRef)
    await this.afterPreflight?.(profileRef)
    return result
  }

  override activateProfile(request: ActivateProfileRequest) {
    this.calls.push({ operation: 'activate', request })
    return super.activateProfile(request)
  }
}

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = []
const harnesses: Harness[] = []

async function renderWorkbench(
  client: WorkbenchClient,
  props: {
    readonly baseProfileSpec?: ProfileSpec
    readonly environment?: DeploymentEnvironment
    readonly onProfileActivated?: (profileRef: ProfileRef) => void
  } = {},
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Workbench, { client, profileRef: PROFILE, ...props }))
  })
  mounted.push({ root, container })
  return container
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  if (!check()) throw new Error(`timed out waiting for ${label}`)
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function changeValue(element: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype
    const setValue = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setValue === undefined) throw new Error('the control has no value setter')
    setValue.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }))
    if (element instanceof HTMLInputElement) element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function input(container: HTMLElement, testId: string): HTMLInputElement {
  const element = container.querySelector(`[data-testid="${testId}"]`)
  if (!(element instanceof HTMLInputElement)) throw new Error(`missing input ${testId}`)
  return element
}

function button(container: HTMLElement, testId: string): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="${testId}"]`)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`missing button ${testId}`)
  return element
}

function selectedComponent(
  kind: ComponentVersionRecord['manifest']['kind'],
  id: string,
  version: string,
  capability: string | readonly string[],
): ComponentVersionRecord {
  const template = registeredComponents().find((component) => component.manifest.kind === kind)
  if (template === undefined) throw new Error(`missing fixture component kind ${kind}`)
  const templateCapability = template.manifest.provides[0]
  if (templateCapability === undefined) throw new Error(`component ${id} has no capability fixture`)
  const manifestRef: VersionRef = { id, version, digest: `sha256:${'f'.repeat(64)}` }
  const capabilities = typeof capability === 'string' ? [capability] : capability
  return {
    ...template,
    manifestRef,
    manifest: {
      ...template.manifest,
      id,
      version,
      digest: manifestRef.digest,
      provides: capabilities.map((name) => ({ ...templateCapability, name })),
    },
  }
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  for (const built of harnesses.splice(0)) await built.app.close()
})

async function buildHarness(): Promise<{ readonly built: Harness; readonly client: RecordingWorkbenchClient }> {
  const built = await startHarness()
  harnesses.push(built)
  return { built, client: new RecordingWorkbenchClient(built.baseUrl) }
}

describe('Workbench profile version publication', () => {
  it('publishes, preflights and activates one new ref in order, then notifies the owner', async () => {
    const { built, client } = await buildHarness()
    const baseSpec = sampleProfileSpec()
    const originalSpec = structuredClone(baseSpec)
    const activated: ProfileRef[] = []
    const container = await renderWorkbench(client, {
      baseProfileSpec: baseSpec,
      environment: 'ci',
      onProfileActivated: (profileRef) => activated.push(profileRef),
    })
    await waitFor(() => container.querySelector('[data-testid="publish-profile"]') !== null, 'publish action')
    await changeValue(input(container, 'new-profile-version'), PROFILE_V2.version)
    await click(button(container, 'publish-profile'))
    await waitFor(
      () => container.querySelector('[data-testid="publication-feedback"]')?.getAttribute('data-kind') === 'success',
      'successful activation',
    )

    const profileCalls = client.calls
    expect(profileCalls.map((call) => call.operation)).toEqual(['publish', 'preflight', 'activate'])
    const publish = profileCalls[0]
    const preflight = profileCalls[1]
    const activate = profileCalls[2]
    if (publish?.operation !== 'publish' || preflight?.operation !== 'preflight' || activate?.operation !== 'activate') {
      throw new Error('the publication call sequence is incomplete')
    }
    expect(publish.request.profileRef).toEqual(PROFILE_V2)
    expect(publish.request.environment).toBe('ci')
    expect(preflight.profileRef).toEqual(PROFILE_V2)
    expect(activate.request.profileRef).toEqual(PROFILE_V2)
    expect(activate.request.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(activate.request.expectedRevision).toBeNull()
    expect(container.querySelector('[data-testid="profile-ref"]')?.textContent).toBe('home-energy-demo@1.1.0')
    expect(activated).toEqual([PROFILE_V2])
    expect(baseSpec).toEqual(originalSpec)
    expect(await built.client.preflightProfile(PROFILE_V2)).toMatchObject({ status: 'resolved' })
  })

  it('uses the selected backend’s unique logical role and matching mapping without mutating the base', async () => {
    const built = await startHarness({ withoutTelemetry: true })
    harnesses.push(built)
    const telemetryAdapter = selectedComponent('data_backend', 'telemetry-adapter-v2', '2.0.0', 'telemetry_read')
    const clientWithBackend = new RecordingWorkbenchClient(built.baseUrl, [telemetryAdapter])
    const baseSpec = sampleProfileSpec()
    const originalSpec = structuredClone(baseSpec)
    const container = await renderWorkbench(clientWithBackend, { baseProfileSpec: baseSpec })
    await waitFor(() => container.querySelector('[data-testid="picker-backend"]') !== null, 'component picker')
    const backendPicker = container.querySelector('[data-testid="picker-backend"]')
    if (!(backendPicker instanceof HTMLSelectElement)) throw new Error('missing backend picker')
    await changeValue(backendPicker, 'telemetry-adapter-v2@2.0.0')
    await changeValue(input(container, 'new-profile-version'), PROFILE_V2.version)
    await click(button(container, 'publish-profile'))
    await waitFor(
      () => container.querySelector('[data-testid="publication-feedback"]') !== null,
      'publication result',
    )

    const publish = clientWithBackend.calls.find((call) => call.operation === 'publish')
    expect(publish?.operation).toBe('publish')
    if (publish?.operation !== 'publish') throw new Error('profile was not published')
    expect(publish.request.spec.backendBindings.telemetry?.adapterRef).toEqual(telemetryAdapter.manifestRef)
    expect(publish.request.spec.backendBindings.telemetry?.mappingRef).toBe('home-energy.mapping.telemetry')
    expect(publish.request.spec.mappingRefs).toEqual(originalSpec.mappingRefs)
    expect(baseSpec).toEqual(originalSpec)
    expect(clientWithBackend.calls.map((call) => call.operation)).toEqual(['publish', 'preflight'])
    expect(container.querySelector('[data-testid="pending-profile"]')?.getAttribute('data-profile-ref'))
      .toBe('home-energy-demo@1.1.0')
    expect(container.querySelector('[data-testid="activate"]')?.hasAttribute('disabled')).toBe(true)
    expect(container.textContent).toContain('能力缺口')
  })

  it('blocks a selected industry with no matching base semantics instead of publishing the old spec', async () => {
    const { built } = await buildHarness()
    const otherIndustry = selectedComponent('industry_pack', 'transport-government', '1.0.0', 'industry.semantics')
    const client = new RecordingWorkbenchClient(built.baseUrl, [otherIndustry])
    const baseSpec = sampleProfileSpec()
    const originalSpec = structuredClone(baseSpec)
    const container = await renderWorkbench(client, { baseProfileSpec: baseSpec })
    await waitFor(() => container.querySelector('[data-testid="picker-industry"]') !== null, 'industry picker')
    const industryPicker = container.querySelector('[data-testid="picker-industry"]')
    if (!(industryPicker instanceof HTMLSelectElement)) throw new Error('missing industry picker')
    await changeValue(industryPicker, 'transport-government@1.0.0')
    await changeValue(input(container, 'new-profile-version'), PROFILE_V2.version)
    await click(button(container, 'publish-profile'))

    expect(container.querySelector('[data-testid="publication-feedback"]')?.getAttribute('data-kind')).toBe('error')
    expect(container.querySelector('[data-testid="publication-feedback"]')?.textContent).toContain('没有对应的场景映射配置')
    expect(client.calls).toEqual([])
    expect(container.querySelector('[data-testid="profile-ref"]')?.textContent).toBe('home-energy-demo@1.0.0')
    expect(container.querySelector('[data-testid="pending-profile"]')?.getAttribute('data-profile-ref'))
      .toBe('home-energy-demo@1.1.0')
    expect(baseSpec).toEqual(originalSpec)
  })

  it('blocks a backend that advertises multiple logical roles instead of guessing one mapping', async () => {
    const built = await startHarness()
    harnesses.push(built)
    const ambiguousBackend = selectedComponent(
      'data_backend',
      'ambiguous-backend',
      '2.0.0',
      ['structured_query', 'telemetry_read'],
    )
    const client = new RecordingWorkbenchClient(built.baseUrl, [ambiguousBackend])
    const container = await renderWorkbench(client, { baseProfileSpec: sampleProfileSpec() })
    await waitFor(() => container.querySelector('[data-testid="picker-backend"]') !== null, 'backend picker')
    const backendPicker = container.querySelector('[data-testid="picker-backend"]')
    if (!(backendPicker instanceof HTMLSelectElement)) throw new Error('missing backend picker')
    await changeValue(backendPicker, 'ambiguous-backend@2.0.0')
    await changeValue(input(container, 'new-profile-version'), PROFILE_V2.version)
    await click(button(container, 'publish-profile'))

    expect(container.querySelector('[data-testid="publication-feedback"]')?.getAttribute('data-kind')).toBe('error')
    expect(container.querySelector('[data-testid="publication-feedback"]')?.textContent)
      .toContain('不能唯一映射到当前场景的逻辑角色')
    expect(client.calls).toEqual([])
    expect(container.querySelector('[data-testid="profile-ref"]')?.textContent).toBe('home-energy-demo@1.0.0')
  })

  it('keeps the requested version pending when publish fails and does not preflight or activate it', async () => {
    const { built } = await buildHarness()
    const client = new RecordingWorkbenchClient(built.baseUrl)
    client.rejectPublish = true
    const activated: ProfileRef[] = []
    const container = await renderWorkbench(client, {
      baseProfileSpec: sampleProfileSpec(),
      onProfileActivated: (profileRef) => activated.push(profileRef),
    })
    await waitFor(() => container.querySelector('[data-testid="publish-profile"]') !== null, 'publish action')
    await changeValue(input(container, 'new-profile-version'), PROFILE_V2.version)
    await click(button(container, 'publish-profile'))
    await waitFor(() => container.querySelector('[data-testid="publication-feedback"]') !== null, 'publish error')

    expect(client.calls.map((call) => call.operation)).toEqual(['publish'])
    expect(container.querySelector('[data-testid="pending-profile"]')?.getAttribute('data-profile-ref'))
      .toBe('home-energy-demo@1.1.0')
    expect(container.querySelector('[data-testid="profile-ref"]')?.textContent).toBe('home-energy-demo@1.0.0')
    expect(container.querySelector('[data-testid="publication-feedback"]')?.textContent)
      .toContain('controlled publish failure')
    expect(activated).toEqual([])
  })

  it('retains the published version as pending on If-Match conflict without calling the activation callback', async () => {
    const { built, client } = await buildHarness()
    client.afterPreflight = async (ref) => {
      if (ref.version !== PROFILE_V2.version) return
      const current = await built.client.preflightProfile(PROFILE)
      const snapshotHash = current.resolvedProfile?.snapshotHash
      if (snapshotHash === undefined) throw new Error('the base profile did not resolve')
      await built.client.activateProfile({ profileRef: PROFILE, snapshotHash, expectedRevision: null })
    }
    const activated: ProfileRef[] = []
    const container = await renderWorkbench(client, {
      baseProfileSpec: sampleProfileSpec(),
      onProfileActivated: (profileRef) => activated.push(profileRef),
    })
    await waitFor(() => container.querySelector('[data-testid="publish-profile"]') !== null, 'publish action')
    await changeValue(input(container, 'new-profile-version'), PROFILE_V2.version)
    await click(button(container, 'publish-profile'))
    await waitFor(() => container.querySelector('[data-testid="conflict"]') !== null, 'If-Match conflict')

    const activate = client.calls.at(-1)
    expect(activate?.operation).toBe('activate')
    if (activate?.operation !== 'activate') throw new Error('new profile activation was not attempted')
    expect(activate.request.profileRef).toEqual(PROFILE_V2)
    expect(container.querySelector('[data-testid="pending-profile"]')?.getAttribute('data-profile-ref'))
      .toBe('home-energy-demo@1.1.0')
    expect(container.querySelector('[data-testid="profile-ref"]')?.textContent).toBe('home-energy-demo@1.1.0')
    expect(container.querySelector('[data-testid="publication-feedback"]')?.getAttribute('data-kind')).toBe('error')
    expect(activated).toEqual([])
  })

  it('keeps the legacy read-only preflight flow when no base specification is supplied', async () => {
    const { built, client } = await buildHarness()
    const container = await renderWorkbench(client)
    await waitFor(() => container.querySelector('[data-testid="preflight"]') !== null, 'preflight action')
    expect(container.querySelector('[data-testid="profile-publish"]')).toBeNull()
    await click(button(container, 'preflight'))
    await waitFor(() => container.querySelector('[data-testid="preflight-status"]') !== null, 'preflight result')
    expect(client.calls.map((call) => call.operation)).toEqual(['preflight'])
    expect(client.calls[0]).toMatchObject({ operation: 'preflight', profileRef: PROFILE })
    expect(await built.client.preflightProfile(PROFILE)).toMatchObject({ status: 'resolved' })
  })
})
