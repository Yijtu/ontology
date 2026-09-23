import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PROFILE, startHarness } from '../ui/workbench-fixtures'
import type { Harness } from '../ui/workbench-fixtures'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

const profileQuery = `profileId=${PROFILE.id}&profileVersion=${PROFILE.version}`

/**
 * Real-browser E2E for the home-energy plan/comparison/simulation surface (US-021/US-022; E8).
 *
 * The built app is served by the loopback-only static host and `/api` is proxied to the real
 * Fastify server (real compute handlers + blob-local), so the page exercises the actual HTTP
 * surface and the actual responsive CSS. This suite is NOT part of `pnpm run verify`: it needs the
 * Playwright browser binaries and the web build. Run `pnpm run build:web && pnpm run test:e2e`.
 *
 * It captures screenshots and log records for the normal and abnormal paths under the gitignored
 * `tests/e2e/artifacts` directory.
 */
let harness: Harness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startHarness({ fixedPrincipal: true, energy: {} })
  if (!harness.baseUrl.startsWith('http://127.0.0.1:')) {
    throw new Error('the E2E harness must bind to loopback only')
  }
  web = await startWebHost(harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.app.close().catch(() => undefined)
})

async function buildScenario(page: import('@playwright/test').Page, backup: string, weather: string): Promise<void> {
  await page.fill('[data-testid="backup-requirement"]', backup)
  await page.selectOption('[data-testid="weather-scenario"]', weather)
  await page.click('[data-testid="build-scenario"]')
  await page.waitForSelector('[data-testid="scenario-summary"]')
}

describe('home-energy surface in a real browser', () => {
  it('labels every datum and never words a simulated benefit as an actual bill saving', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?${profileQuery}&view=energy`)
    await page.waitForSelector('[data-testid="build-scenario"]')
    expect(await page.getAttribute('.energy', 'data-viewport')).toBe('desktop')
    expect(await page.getAttribute('.energy', 'data-phase')).toBe('empty')

    await buildScenario(page, '4', 'sunny')
    await page.click('[data-testid="request-plan"]')
    await page.waitForSelector('[data-testid="plan-version"]')
    await page.waitForSelector('[data-testid="plan-verified"][data-verified="true"]')
    expect(await page.getAttribute('[data-testid="plan-mode"]', 'data-mode')).toBe('simulation')

    const modes = await page.locator('[data-testid="datum-mode"]').allTextContents()
    expect(modes).toContain('observed')
    expect(modes).toContain('forecast')
    expect(modes).toContain('simulated')

    const html = await page.content()
    expect(html).not.toContain('账单节省')
    expect(html).not.toContain('实际节省')
    expect(html).not.toContain('actual saving')
    expect(html).not.toContain('super-secret-token-DO-NOT-LEAK-3f9a')

    await capture(page, 'energy-desktop-happy-path')
    await record('energy-desktop-happy-path', [
      `origin=${web.origin}`,
      'viewport=1280x900',
      `planMode=${(await page.getAttribute('[data-testid="plan-mode"]', 'data-mode')) ?? ''}`,
      `datumModes=${modes.join(',')}`,
      `containsBillSaving=${html.includes('账单节省')}`,
    ])
    await context.close()
  })

  it('shows a new version with constraint gaps and refuses execution of an unpublished preview', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?${profileQuery}&view=energy`)
    await page.waitForSelector('[data-testid="build-scenario"]')
    await buildScenario(page, '4', 'sunny')
    await page.click('[data-testid="request-plan"]')
    await page.waitForSelector('[data-testid="plan-version"]')

    // A backup requirement above the declared capacity makes every candidate infeasible.
    await buildScenario(page, '100', 'storm')
    await page.click('[data-testid="request-plan"]')
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="plan-version"]').length === 2,
    )
    await page.waitForSelector('[data-testid="version-compare"]')
    const gapCount = await page.locator('[data-testid="constraint-gap"]').count()
    expect(gapCount).toBeGreaterThan(0)
    const sourceFields = await page.locator('[data-testid="source-change"]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-field')),
    )
    expect(sourceFields).toContain('backupRequirementKwh')
    expect(sourceFields).toContain('weatherScenario')

    expect(await page.locator('[data-testid="request-simulation-execution"]').isDisabled()).toBe(true)
    expect(await page.locator('[data-testid="request-live-execution"]').isDisabled()).toBe(true)
    expect(await page.textContent('[data-testid="execution-unavailable"]')).toContain('正式 run 发布并核验')
    expect(await page.locator('[data-testid="execution-record"]').count()).toBe(0)

    await capture(page, 'energy-desktop-version-compare-live')
    await record('energy-desktop-version-compare-live', [
      `gapCount=${gapCount}`,
      `sourceFields=${sourceFields.join(',')}`,
      'execution=blocked_until_published_run',
    ])
    await context.close()
  })

  it('renders the narrow layout and the not-configured state', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?${profileQuery}&view=energy`)
    await page.waitForSelector('[data-testid="build-scenario"]')
    expect(await page.getAttribute('.energy', 'data-viewport')).toBe('narrow')
    const columns = await page.$eval('.energy__body', (node) => getComputedStyle(node).gridTemplateColumns)
    expect(columns.trim().split(/\s+/).length).toBe(1)
    await buildScenario(page, '4', 'sunny')
    await page.click('[data-testid="request-plan"]')
    await page.waitForSelector('[data-testid="plan-version"]')
    await capture(page, 'energy-narrow')
    await record('energy-narrow', [`viewport=390x844`, `gridTemplateColumns=${columns}`])
    await context.close()

    // Abnormal path: the energy operations are not registered, so a plan request is a 409.
    const withoutOperations = await startHarness({
      fixedPrincipal: true,
      energy: { withoutOperations: true },
    })
    const host = await startWebHost(withoutOperations.baseUrl)
    const failureContext = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const failurePage = await failureContext.newPage()
    try {
      await failurePage.goto(`${host.origin}/?${profileQuery}&view=energy`)
      await failurePage.waitForSelector('[data-testid="build-scenario"]')
      await buildScenario(failurePage, '4', 'sunny')
      await failurePage.click('[data-testid="request-plan"]')
      await failurePage.waitForSelector('[data-state="not_configured"]')
      const code = await failurePage.textContent('[data-testid="state-error-code"]')
      expect(code).toContain('CAPABILITY_NOT_CONFIGURED')
      await capture(failurePage, 'energy-not-configured')
      await record('energy-not-configured', [`errorCode=${code ?? ''}`])
    } finally {
      await failureContext.close()
      await host.close()
      await withoutOperations.app.close()
    }
  })
})
