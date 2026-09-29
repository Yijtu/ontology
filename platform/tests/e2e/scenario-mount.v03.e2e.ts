import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

/**
 * Real-browser E2E for the public dual-assistant shell and scenario mount contract
 * (V03-022 / #176, SPEC v0.3a §9.1/§9.3). The built harness page registers two neutral scenario
 * modules through the trusted composition entry; the suite proves mount/switch, the controlled
 * legal projection (illegal metadata is rejected), missing-module/missing-capability/permission
 * states and the renderer recovery path. The harness never calls the API, so no live host is
 * needed beyond the static server.
 */
declare global {
  interface Window {
    __neutralScenarioRecovery?: { armed: boolean }
  }
}

let web: WebHost
let browser: Browser

const DUMMY_API = 'http://127.0.0.1:9'

beforeAll(async () => {
  web = await startWebHost(DUMMY_API)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
})

async function gotoCase(page: Page, scenarioCase: string): Promise<void> {
  await page.goto(`${web.origin}/scenario-mount-harness.html?case=${scenarioCase}`)
  await page.waitForSelector('[data-testid="assistant-shell"]')
}

describe('scenario mount contract in a real browser', () => {
  it('mounts two neutral modules, switches modules and assistants, and keeps each draft', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await gotoCase(page, 'mount')

      expect(await page.textContent('[data-testid="assistant-entry-ontology"]')).toBe('本体生成助手')
      expect(await page.textContent('[data-testid="assistant-entry-business"]')).toBe('业务实践助手')
      expect(await page.getAttribute('[data-testid="assistant-shell"]', 'data-active-assistant')).toBe('ontology')

      // Two mounted modules, no default quotation button anywhere in the shell.
      expect(await page.locator('[data-testid="scenario-module-tab-scene.neutral.alpha"]').count()).toBe(1)
      expect(await page.locator('[data-testid="scenario-module-tab-scene.neutral.beta"]').count()).toBe(1)
      expect(await page.locator('[data-testid="default-quote"]').count()).toBe(0)
      expect(await page.getByRole('button', { name: '报价' }).count()).toBe(0)

      // Draft on alpha, switch to beta, then switch back: each draft is kept.
      await page.fill('[data-testid="neutral-parameter-input-scene.neutral.alpha"]', 'alpha-draft')
      await page.click('[data-testid="scenario-module-tab-scene.neutral.beta"]')
      await page.fill('[data-testid="neutral-parameter-input-scene.neutral.beta"]', 'beta-draft')
      await page.click('[data-testid="scenario-module-tab-scene.neutral.alpha"]')
      expect(await page.inputValue('[data-testid="neutral-parameter-input-scene.neutral.alpha"]')).toBe('alpha-draft')

      // Switch assistant: the business draft is independent.
      await page.click('[data-testid="assistant-entry-business"]')
      expect(await page.getAttribute('[data-testid="assistant-shell"]', 'data-active-assistant')).toBe('business')
      await page.fill('[data-testid="neutral-parameter-input-scene.neutral.alpha"]', 'business-draft')
      await page.click('[data-testid="assistant-entry-ontology"]')
      expect(await page.inputValue('[data-testid="neutral-parameter-input-scene.neutral.alpha"]')).toBe('alpha-draft')
      await page.click('[data-testid="assistant-entry-business"]')
      expect(await page.inputValue('[data-testid="neutral-parameter-input-scene.neutral.alpha"]')).toBe('business-draft')

      await capture(page, 'scenario-mount-happy-path')
      await record('scenario-mount-happy-path', [
        'modules=scene.neutral.alpha,scene.neutral.beta',
        'ontologyDraft=alpha-draft',
        'businessDraft=business-draft',
        'defaultQuoteButtons=0',
      ])
    } finally {
      await context.close()
    }
  })

  it('shows the missing-module fallback with the generic verified result and no quote button', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const page = await context.newPage()
    try {
      await gotoCase(page, 'missing-module')
      expect(await page.locator('[data-testid="scenario-missing-module"]').count()).toBe(1)
      expect(await page.textContent('[data-testid="scenario-missing-module-ref"]')).toContain('scene.neutral.unregistered')
      expect(await page.locator('[data-testid="generic-verified-result"]').count()).toBeGreaterThanOrEqual(1)
      expect(await page.getByRole('button', { name: '报价' }).count()).toBe(0)
      await capture(page, 'scenario-missing-module')
      await record('scenario-missing-module', ['state=missing_module', 'genericResult=visible'])
    } finally {
      await context.close()
    }
  })

  it('reports a missing capability on the module that requires it', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const page = await context.newPage()
    try {
      await gotoCase(page, 'missing-capability')
      expect(await page.locator('[data-testid="scenario-missing-capability"]').count()).toBe(1)
      const missing = await page.textContent('[data-testid="scenario-missing-capability-list"]')
      expect(missing).toContain('pricing.compute')
      expect(await page.locator('[data-testid="scenario-module-tab-scene.neutral.alpha"]').count()).toBe(1)
      await capture(page, 'scenario-missing-capability')
      await record('scenario-missing-capability', [`missing=${missing ?? ''}`])
    } finally {
      await context.close()
    }
  })

  it('hides edit and export entrypoints for a readonly principal but keeps the task entry', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const page = await context.newPage()
    try {
      await gotoCase(page, 'readonly')
      expect(await page.locator('[data-testid="scenario-readonly"]').count()).toBe(1)
      expect(await page.locator('[data-testid="scenario-parameter-scene.neutral.alpha"]').count()).toBe(0)
      expect(await page.locator('[data-testid="exporter-alpha-json"]').count()).toBe(0)
      expect(await page.locator('[data-testid="task-entry-task.neutral.alpha.run"]').count()).toBe(1)
      await capture(page, 'scenario-readonly')
      await record('scenario-readonly', ['parameterPanel=hidden', 'exporters=hidden', 'taskEntry=visible'])
    } finally {
      await context.close()
    }
  })

  it('refuses to mount a module outside the authorized set', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const page = await context.newPage()
    try {
      await gotoCase(page, 'forbidden')
      expect(await page.locator('[data-testid="scenario-forbidden"]').count()).toBe(1)
      expect(await page.locator('[data-testid="scenario-module-tab-scene.neutral.alpha"]').count()).toBe(1)
    } finally {
      await context.close()
    }
  })

  it('rejects illegal mount metadata instead of loading it', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const page = await context.newPage()
    try {
      await gotoCase(page, 'illegal-metadata')
      expect(await page.locator('[data-testid="scenario-illegal-metadata"]').count()).toBe(1)
      expect(await page.locator('[data-testid="scenario-module-tab-scene.neutral.alpha"]').count()).toBe(1)
      await capture(page, 'scenario-illegal-metadata')
      await record('scenario-illegal-metadata', ['state=illegal_metadata', 'alpha=mounted'])
    } finally {
      await context.close()
    }
  })

  it('recovers a professional renderer from a caught error and retries the same version', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const page = await context.newPage()
    try {
      await gotoCase(page, 'recovery')
      await page.click('[data-testid="scenario-module-tab-scene.neutral.beta"]')
      await page.waitForSelector('[data-testid="scenario-recovery"]')
      expect(await page.locator('[data-testid="generic-verified-result"]').count()).toBeGreaterThanOrEqual(1)
      // The renderer recovers; retry renders the same verified version instead of re-running.
      await page.evaluate(() => {
        if (window.__neutralScenarioRecovery !== undefined) window.__neutralScenarioRecovery.armed = false
      })
      await page.click('[data-testid="scenario-retry"]')
      await page.waitForSelector('[data-testid="scenario-result-scene.neutral.beta"]')
      await capture(page, 'scenario-recovery')
      await record('scenario-recovery', ['recovery=caught', 'retry=rendered'])
    } finally {
      await context.close()
    }
  })
})
