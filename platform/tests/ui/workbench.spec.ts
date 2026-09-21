// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProfileSpec } from '@ontology/contracts'
import { Workbench } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import {
  PROFILE,
  PROFILE_V2,
  SENTINEL_SECRET,
  sampleProfileSpec,
  startHarness,
} from './workbench-fixtures'
import type { Harness, HarnessOptions } from './workbench-fixtures'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { root: Root; container: HTMLElement }[] = []
const openHarnesses: Harness[] = []

async function renderWorkbench(client: WorkbenchClient, boundRunId?: string): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(Workbench, {
        client,
        profileRef: PROFILE,
        ...(boundRunId === undefined ? {} : { boundRunId }),
      }),
    )
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

function setInnerWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

async function harness(options?: HarnessOptions): Promise<Harness> {
  const built = await startHarness(options)
  openHarnesses.push(built)
  return built
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount()
    })
    container.remove()
  }
  for (const built of openHarnesses.splice(0)) {
    await built.app.close()
  }
})

describe('workbench UI states (real API fixture over HTTP)', () => {
  it('renders the loading state before the fixture answers', async () => {
    const pending = new Promise<Response>(() => undefined)
    const client = new WorkbenchClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: () => pending })
    const container = await renderWorkbench(client)
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull()
    expect(container.querySelector('.workbench')?.getAttribute('data-phase')).toBe('loading')
  })

  it('renders the empty state when no component is registered', async () => {
    const built = await harness({ emptyRegistry: true, seedProfile: false })
    const container = await renderWorkbench(built.client)
    await waitFor(() => container.querySelector('[data-state="empty"]') !== null, 'empty state')
  })

  it('renders a failure state when the API is unreachable', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    })
    const container = await renderWorkbench(client)
    await waitFor(() => container.querySelector('[data-state="failure"]') !== null, 'failure state')
    expect(container.querySelector('[data-testid="state-error-code"]')?.textContent).toContain('NETWORK_ERROR')
  })

  it('renders a permission-denied state for a role without profile-editor', async () => {
    const built = await harness({ roles: 'business-user', emptyRegistry: true, seedProfile: false })
    const container = await renderWorkbench(built.client)
    await waitFor(
      () => container.querySelector('[data-state="permission_denied"]') !== null,
      'permission denied state',
    )
  })

  it('renders the not-configured state with the exact capability gaps', async () => {
    const built = await harness({ withoutTelemetry: true })
    const container = await renderWorkbench(built.client)
    await waitFor(() => container.querySelector('[data-testid="preflight"]') !== null, 'profile actions')
    const button = container.querySelector('[data-testid="preflight"]')
    if (button === null) throw new Error('the preflight button is missing')
    await click(button)
    await waitFor(
      () => container.querySelector('[data-state="not_configured"]') !== null,
      'not configured state',
    )
    const gap = container.querySelector('[data-testid="capability-gap"]')
    expect(gap?.getAttribute('data-capability')).toBe('telemetry_read')
    expect(gap?.querySelector('[data-state="not_configured"]')?.textContent).toContain('未配置')
    expect(container.querySelector('[data-testid="activate"]')?.hasAttribute('disabled')).toBe(true)
  })

  it('renders the ready state with capability gaps and explicit degradations', async () => {
    const built = await harness()
    const container = await renderWorkbench(built.client)
    await waitFor(() => container.querySelector('[data-testid="preflight"]') !== null, 'profile actions')
    expect(container.querySelector('[data-testid="sources"]')?.getAttribute('data-count')).toBe('1')

    const button = container.querySelector('[data-testid="preflight"]')
    if (button === null) throw new Error('the preflight button is missing')
    await click(button)
    await waitFor(() => container.querySelector('[data-testid="preflight-status"]') !== null, 'preflight status')
    expect(container.querySelector('[data-testid="preflight-status"]')?.getAttribute('data-status')).toBe('resolved')

    const degradations = [...container.querySelectorAll('[data-testid="degradation"]')].map((node) =>
      node.querySelector('.degradations__capability')?.textContent,
    )
    expect(degradations).toContain('model:decision')
    expect(degradations).toContain('tool:web_search')
    expect(container.querySelector('[data-testid="snapshot-hash"]')?.textContent).toMatch(/sha256:[0-9a-f]{64}/)

    const activate = container.querySelector('[data-testid="activate"]')
    if (activate === null) throw new Error('the activate button is missing')
    await click(activate)
    await waitFor(() => container.querySelector('[data-testid="active-revision"]') !== null, 'active revision')
    expect(container.querySelector('[data-testid="active-revision"]')?.textContent).toContain('1')

    expect(container.querySelector('[data-testid="picker-industry"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="picker-runtime"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="picker-backend"]')).not.toBeNull()
  })

  it('never renders a resolved secret value in the HTML', async () => {
    const built = await harness()
    const container = await renderWorkbench(built.client)
    await waitFor(() => container.querySelector('[data-testid="sources"]') !== null, 'sources panel')
    expect(container.innerHTML).not.toContain(SENTINEL_SECRET)
    expect(container.querySelector('[data-testid="source-secret-ref"]')?.textContent).toBe(
      'secret://vault/telemetry',
    )
  })

  it('renders a distinct narrow layout under a narrow viewport', async () => {
    setInnerWidth(480)
    const built = await harness({ emptyRegistry: true, seedProfile: false })
    const narrow = await renderWorkbench(built.client)
    await waitFor(() => narrow.querySelector('[data-state="empty"]') !== null, 'empty state')
    expect(narrow.querySelector('.workbench')?.getAttribute('data-viewport')).toBe('narrow')

    setInnerWidth(1280)
    const desktop = await renderWorkbench(built.client)
    await waitFor(() => desktop.querySelector('[data-state="empty"]') !== null, 'empty state')
    expect(desktop.querySelector('.workbench')?.getAttribute('data-viewport')).toBe('desktop')
  })

  it('surfaces a version conflict instead of silently overwriting', async () => {
    const built = await harness()
    const container = await renderWorkbench(built.client)
    await waitFor(() => container.querySelector('[data-testid="preflight"]') !== null, 'profile actions')
    const button = container.querySelector('[data-testid="preflight"]')
    if (button === null) throw new Error('the preflight button is missing')
    await click(button)
    await waitFor(() => container.querySelector('[data-testid="activate"]') !== null, 'activate button')

    const preflight = await built.client.preflightProfile(PROFILE)
    const snapshotHash = preflight.resolvedProfile?.snapshotHash
    if (snapshotHash === undefined) throw new Error('the fixture profile did not resolve')
    // Another editor activates first, moving the active revision to 1.
    await built.client.activateProfile({ profileRef: PROFILE, snapshotHash, expectedRevision: null })

    const activate = container.querySelector('[data-testid="activate"]')
    if (activate === null) throw new Error('the activate button is missing')
    await click(activate)
    await waitFor(() => container.querySelector('[data-testid="conflict"]') !== null, 'conflict notice')
    expect(container.querySelector('[data-testid="conflict"]')?.getAttribute('data-code')).toBe('VERSION_CONFLICT')
  })

  it('keeps a run locked to its resolved manifest when the UI activates a new profile version', async () => {
    const built = await harness()
    const created = await built.app.inject({
      method: 'POST',
      url: '/api/v1/runs',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `idem-${randomUUID()}`,
        'x-test-subject': 'ui-owner',
        'x-test-roles': 'business-user',
      },
      payload: {
        profileRef: { id: PROFILE.id, version: PROFILE.version },
        question: 'lock my version',
        context: { timeZone: 'Asia/Shanghai' },
        preferences: { route: 'auto', allowWeb: false },
      },
    })
    expect(created.statusCode).toBe(202)
    const run = (created.json() as { data: { runId: string; resolvedProfileHash: string } }).data

    const container = await renderWorkbench(built.client, run.runId)
    await waitFor(() => container.querySelector('[data-testid="bound-run-hash"]') !== null, 'bound run hash')
    expect(container.querySelector('[data-testid="bound-run-hash"]')?.textContent).toBe(run.resolvedProfileHash)

    const specV2: ProfileSpec = sampleProfileSpec({
      toolBindings: [
        { toolId: 'ontology_lookup', enabled: true },
        { toolId: 'data_query', enabled: true, maxCallsPerRun: 8 },
        { toolId: 'document_search', enabled: true },
        { toolId: 'web_search', enabled: true },
      ],
    })
    await built.client.publishProfile({ profileRef: PROFILE_V2, spec: specV2, environment: 'local_dev' })
    const preflightV2 = await built.client.preflightProfile(PROFILE_V2)
    const hashV2 = preflightV2.resolvedProfile?.snapshotHash
    if (hashV2 === undefined) throw new Error('the second profile version did not resolve')
    expect(hashV2).not.toBe(run.resolvedProfileHash)

    await built.client.activateProfile({ profileRef: PROFILE_V2, snapshotHash: hashV2, expectedRevision: null })

    const after = await built.client.getRun(run.runId)
    expect(after.resolvedProfileHash).toBe(run.resolvedProfileHash)
  })
})
