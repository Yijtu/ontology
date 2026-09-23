// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { EnergyPlanPanel, energyReducer, initialEnergyState } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import { SENTINEL_SECRET, startHarness } from './workbench-fixtures'
import type { Harness, HarnessOptions } from './workbench-fixtures'

/**
 * jsdom tests for the home-energy plan/comparison/simulation surface (US-021/US-022; E8).
 *
 * They drive the real Fastify routes over the real compute handlers and blob-local, and assert
 * the labels the acceptance requires: every datum carries unit/source/time/mode; a simulated
 * benefit is never worded as an actual bill saving; changing the backup requirement or the
 * weather scenario produces a new version with constraint gaps and source changes; only a
 * digest-verified result is rendered; simulation and live are never conflated; the five states
 * and the narrow viewport are reachable.
 */

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { root: Root; container: HTMLElement }[] = []
const openHarnesses: Harness[] = []

async function renderEnergy(client: WorkbenchClient): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(EnergyPlanPanel, { client, profileRef: { id: 'home-energy-demo-wide', version: '1.0.0' } }))
  })
  mounted.push({ root, container })
  return container
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  if (!(await check())) throw new Error(`timed out waiting for ${label}`)
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function setControlValue(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  setter?.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function setInnerWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

async function harness(options?: HarnessOptions): Promise<Harness> {
  const built = await startHarness({ energy: {}, ...options })
  openHarnesses.push(built)
  return built
}

async function scenarioDigest(container: HTMLElement): Promise<string | undefined> {
  return container.querySelector('[data-testid="scenario-input-digest"]')?.textContent ?? undefined
}

async function buildScenario(container: HTMLElement): Promise<void> {
  const before = await scenarioDigest(container)
  const button = container.querySelector('[data-testid="build-scenario"]')
  if (button === null) throw new Error('the build-scenario control is missing')
  await click(button)
  await waitFor(async () => {
    const now = await scenarioDigest(container)
    return now !== undefined && now !== before
  }, 'a freshly built scenario')
}

async function requestPlan(container: HTMLElement): Promise<void> {
  const before = container.querySelectorAll('[data-testid="plan-version"]').length
  const button = container.querySelector('[data-testid="request-plan"]')
  if (button === null) throw new Error('the request-plan control is missing')
  await click(button)
  await waitFor(() => container.querySelectorAll('[data-testid="plan-version"]').length > before, 'a new plan version')
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

describe('home-energy plan and simulation surface', () => {
  it('labels every datum and never words a simulated benefit as an actual bill saving', async () => {
    const built = await harness()
    const container = await renderEnergy(built.client)
    expect(container.querySelector('[data-state="empty"]')).not.toBeNull()

    await buildScenario(container)
    await requestPlan(container)

    const modes = [...container.querySelectorAll('[data-testid="datum-mode"]')].map((node) => node.textContent)
    expect(modes).toContain('observed')
    expect(modes).toContain('forecast')
    expect(modes).toContain('simulated')
    expect(container.querySelector('[data-testid="scenario-mode"]')?.getAttribute('data-mode')).toBe('synthetic')

    for (const datum of container.querySelectorAll('[data-testid="datum"]')) {
      expect(datum.querySelector('[data-testid="datum-unit"]')?.textContent ?? '').not.toBe('')
      expect(datum.querySelector('[data-testid="datum-source"]')?.textContent ?? '').not.toBe('')
      expect(datum.querySelector('[data-testid="datum-time"]')?.textContent ?? '').not.toBe('')
      expect(datum.querySelector('[data-testid="datum-mode"]')?.textContent ?? '').not.toBe('')
    }

    expect(container.querySelector('[data-testid="plan-mode"]')?.getAttribute('data-mode')).toBe('simulation')
    expect(container.querySelector('[data-testid="plan-verified"]')?.getAttribute('data-verified')).toBe('true')

    // A simulated benefit is a `simulated_saving` datum whose wording explicitly denies that it is
    // an actual bill; the surface never claims an actual/账单 saving.
    for (const saving of container.querySelectorAll('[data-testid="simulated-saving"], [data-testid="saving-claim"]')) {
      expect(saving.getAttribute('data-kind')).toBe('simulated_saving')
      expect(saving.textContent ?? '').toContain('非实际账单')
    }
    const html = container.innerHTML
    expect(html).not.toContain('账单节省')
    expect(html).not.toContain('实际节省')
    expect(html).not.toContain('actual saving')
    expect(html).not.toContain(SENTINEL_SECRET)
  })

  it('produces a new version with constraint gaps and source changes when backup/weather change', async () => {
    const built = await harness()
    const container = await renderEnergy(built.client)
    await buildScenario(container)
    await requestPlan(container)

    const firstVersionId = container.querySelector('[data-testid="plan-version"]')?.getAttribute('data-version-id')
    expect(firstVersionId).toBeTruthy()

    // A backup requirement above the declared capacity makes every candidate infeasible.
    const backup = container.querySelector('[data-testid="backup-requirement"]')
    if (!(backup instanceof HTMLInputElement)) throw new Error('the backup control is not an input')
    setControlValue(backup, '100')
    await buildScenario(container)
    await requestPlan(container)
    await waitFor(() => container.querySelectorAll('[data-testid="plan-version"]').length === 2, 'two plan versions')

    const versionIds = [...container.querySelectorAll('[data-testid="plan-version"]')].map((node) =>
      node.getAttribute('data-version-id'),
    )
    expect(new Set(versionIds).size).toBe(2)

    const compare = container.querySelector('[data-testid="version-compare"]')
    expect(compare).not.toBeNull()
    expect(container.querySelectorAll('[data-testid="constraint-gap"]').length).toBeGreaterThan(0)
    const backupChange = [...container.querySelectorAll('[data-testid="source-change"]')].map((node) =>
      node.getAttribute('data-field'),
    )
    expect(backupChange).toContain('backupRequirementKwh')

    // Changing the weather scenario changes the PV forecast source and the input digest.
    const weather = container.querySelector('[data-testid="weather-scenario"]')
    if (!(weather instanceof HTMLSelectElement)) throw new Error('the weather control is not a select')
    setControlValue(weather, 'storm')
    await buildScenario(container)
    await requestPlan(container)
    await waitFor(() => container.querySelectorAll('[data-testid="plan-version"]').length === 3, 'three plan versions')
    const weatherChange = [...container.querySelectorAll('[data-testid="source-change"]')].map((node) =>
      node.getAttribute('data-field'),
    )
    expect(weatherChange).toContain('weatherScenario')
  })

  it('keeps simulation and live distinct and sends no device request', async () => {
    const built = await harness()
    const container = await renderEnergy(built.client)
    await buildScenario(container)
    await requestPlan(container)

    const simulate = container.querySelector('[data-testid="request-simulation-execution"]')
    if (simulate === null) throw new Error('the simulation execution control is missing')
    await click(simulate)
    await waitFor(() => container.querySelector('[data-testid="execution-record"]') !== null, 'execution record')
    expect(container.querySelector('[data-testid="execution-record"]')?.getAttribute('data-mode')).toBe('simulation')
    expect(container.querySelector('[data-testid="execution-device-requests"]')?.textContent).toContain('0')
    expect(container.querySelector('[data-testid="execution-live-supported"]')?.textContent).toContain('false')

    const live = container.querySelector('[data-testid="request-live-execution"]')
    if (live === null) throw new Error('the live execution control is missing')
    await click(live)
    await waitFor(() => container.querySelector('[data-testid="live-unavailable"]') !== null, 'live unavailable')
    const unavailable = container.querySelector('[data-testid="live-unavailable"]')
    expect(unavailable?.getAttribute('data-code')).toBe('CAPABILITY_NOT_CONFIGURED')
    // The live attempt did not replace the simulation record with an execution.
    expect(container.querySelector('[data-testid="execution-record"]')?.getAttribute('data-mode')).toBe('simulation')
    expect(built.energy?.deviceRequests).toEqual([])
  })

  it('renders the not-configured state when the energy operations are not registered', async () => {
    const built = await harness({ energy: { withoutOperations: true } })
    const container = await renderEnergy(built.client)
    await buildScenario(container)
    const plan = container.querySelector('[data-testid="request-plan"]')
    if (plan === null) throw new Error('the request-plan control is missing')
    await click(plan)
    await waitFor(() => container.querySelector('[data-state="not_configured"]') !== null, 'not configured state')
    expect(container.querySelector('[data-testid="state-error-code"]')?.textContent).toContain(
      'CAPABILITY_NOT_CONFIGURED',
    )
  })

  it('renders the permission-denied state for a reader-only principal', async () => {
    const built = await harness({ roles: 'scoped-reader', seedProfile: false, withoutTelemetry: true })
    const container = await renderEnergy(built.client)
    const build = container.querySelector('[data-testid="build-scenario"]')
    if (build === null) throw new Error('the build-scenario control is missing')
    await click(build)
    await waitFor(() => container.querySelector('[data-state="permission_denied"]') !== null, 'permission denied state')
    expect(container.querySelector('[data-testid="state-error-code"]')?.textContent).toContain('FORBIDDEN')
  })

  it('renders the failure state when the API is unreachable, and the narrow viewport', async () => {
    setInnerWidth(390)
    const offline = new WorkbenchClient({
      baseUrl: '',
      fetchImpl: () => Promise.reject(new Error('offline')),
    })
    const container = await renderEnergy(offline)
    expect(container.querySelector('[data-viewport]')?.getAttribute('data-viewport')).toBe('narrow')
    const build = container.querySelector('[data-testid="build-scenario"]')
    if (build === null) throw new Error('the build-scenario control is missing')
    await click(build)
    await waitFor(() => container.querySelector('[data-state="failure"]') !== null, 'failure state')
    setInnerWidth(1024)
  })

  it('treats a busy request before any scenario as the loading state', () => {
    const loading = energyReducer(initialEnergyState(), { type: 'busy' })
    expect(loading.phase).toBe('loading')
    expect(loading.busy).toBe(true)
  })
})
