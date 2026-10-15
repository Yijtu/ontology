import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { startWorkspaceHarness } from '../ui/workspace-fixtures'
import type { WorkspaceHarness } from '../ui/workspace-fixtures'

/**
 * Real-browser E2E for the unified default web entry (V03). The built default `index.html` app is
 * served by the loopback static host and proxies `/api` to a real Fastify server. It asserts the
 * guide home is the default landing, every v0.3 workbench is reachable as a real nav tab, the
 * workspace/project context bar appears on the id-dependent tabs, and an absent id degrades to an
 * explicit guidance state instead of an empty panel.
 */

let harness: WorkspaceHarness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startWorkspaceHarness()
  web = await startWebHost(harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.close().catch(() => undefined)
})

async function openApp(page: Page): Promise<void> {
  // The legacy fixture has no `/api/v1/core/deployment`; the static host binds the test profile,
  // so the default app boots through the explicit-profile path (no deployment scenarios).
  await page.goto(`${web.origin}/`)
  await page.waitForSelector('[data-testid="guide-home"]')
}

describe('unified default web entry in a real browser', () => {
  it('shows the guide home by default with the v0.3 workbench tabs', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
    const page = await context.newPage()
    try {
      await openApp(page)
      expect(await page.textContent('[data-testid="guide-mode"]')).toContain('只读')
      expect(await page.locator('[data-testid="guide-disclaimer"]').count()).toBe(0)

      for (const view of ['start', 'ontology', 'projects', 'definitions', 'instances', 'packages', 'business', 'workbench', 'query', 'jobs', 'review', 'evidence']) {
        expect(await page.locator(`[data-testid="tab-${view}"]`).count()).toBe(1)
      }
      expect(await page.textContent('[data-testid="tab-ontology"]')).toBe('本体工作区')
      expect(await page.locator('[data-testid="guide-path-step"]').count()).toBe(6)
      expect(await page.getByText('本体建模', { exact: true }).count()).toBeGreaterThan(0)

      await capture(page, 'v03-unified-entry-guide')
      await record('v03-unified-entry-guide', ['defaultView=start', 'v03Tabs=ontology,projects,definitions,instances,packages,business'])
    } finally {
      await context.close()
    }
  })

  it('opens the ontology workspace workbench from the new tab', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
    const page = await context.newPage()
    try {
      await openApp(page)
      await page.click('[data-testid="tab-ontology"]')
      await page.waitForSelector('[data-testid="ontology-workspace"]')
      expect(await page.getAttribute('[data-testid="ontology-workspace"]', 'data-phase')).not.toBeNull()
      await capture(page, 'v03-unified-entry-ontology')
      await record('v03-unified-entry-ontology', ['view=ontology', 'ontologyWorkspace=visible'])
    } finally {
      await context.close()
    }
  })

  it('shows the context bar and a guidance state when a required workspace id is absent', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
    const page = await context.newPage()
    try {
      await openApp(page)
      await page.click('[data-testid="tab-definitions"]')
      await page.waitForSelector('[data-testid="context-bar"]')
      expect(await page.locator('[data-testid="context-workspace-select"]').count()).toBe(1)
      expect(await page.locator('[data-testid="context-project-select"]').count()).toBe(1)
      // No workspace selected -> guidance, never an empty definition panel.
      await page.waitForSelector('[data-testid="workspace-required"]')
      expect(await page.locator('[data-testid="definition-workbench"]').count()).toBe(0)

      // Selecting a workspace from the context bar reflects the id in the URL and reveals the panel.
      const created = await harness.client.createIndustryWorkspace({
        namespace: 'unified-e2e',
        displayName: '统一入口工作区',
        boundary: { goals: ['unified entry'], included: [], excluded: [], applicability: {} },
        documentSetRef: { id: randomUUID(), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' },
      })
      const workspaceId = created.workspace.workspaceId
      await page.reload()
      await page.waitForSelector('[data-testid="workspace-required"]')
      await page.waitForSelector('[data-testid="context-workspace-select"]')
      await page.selectOption('[data-testid="context-workspace-select"]', workspaceId)
      await page.waitForSelector('[data-testid="definition-workbench"]')
      expect(new URL(page.url()).searchParams.get('workspace')).toBe(workspaceId)
      await capture(page, 'v03-unified-entry-context-bar')
      await record('v03-unified-entry-context-bar', ['contextBar=visible', 'workspaceRequiredGuidance=shown', 'workspaceSelect=wired'])
    } finally {
      await context.close()
    }
  })
})
