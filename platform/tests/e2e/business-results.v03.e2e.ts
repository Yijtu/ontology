import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { startBusinessResultsHarness } from '../ui/business-results-fixtures'
import type { BusinessResultsHarness } from '../ui/business-results-fixtures'

/**
 * Real-browser E2E for the public business workbench, typed results and provenance (V03-040 /
 * #212, SPEC v0.3a asset-data-ui §9 / execution-evidence §EX-7.1/§EX-9). The built
 * `business-results-harness.html` composition mounts the workbench over the two neutral scenario
 * modules through the trusted registry, and the loopback static host proxies `/api` to a real
 * Fastify server wired to the merged run/answer/evidence services plus the real
 * `TableArtifactReadService`. The page lists only mounted+authorised tasks, requires an explicit
 * parameter-change confirmation, runs a task, and renders 正文/结果表/依据 for the same verified
 * version with real table paging and an unverified table refused by the server.
 */

let harness: BusinessResultsHarness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startBusinessResultsHarness({ fixedPrincipal: true })
  web = await startWebHost(harness.harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.harness.app.close().catch(() => undefined)
})

async function openWorkbench(page: Page, query = ''): Promise<void> {
  await page.goto(`${web.origin}/business-results-harness.html${query}`)
  await page.waitForSelector('[data-testid="business-workbench"]')
}

describe('business workbench, typed results and provenance in a real browser', () => {
  it('lists mounted tasks, confirms a parameter change, runs a task and renders the verified result views', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    try {
      await openWorkbench(page)

      // Only the mounted+authorised neutral tasks are offered; there is no default quotation.
      expect(await page.locator('[data-testid="task-entry"]').count()).toBe(2)
      expect(await page.locator('[data-testid="default-quote"]').count()).toBe(0)

      // A parameter change shows a concrete diff and is only applied after an explicit confirm.
      await page.click('[data-testid="task-entry"]')
      expect(await page.inputValue('[data-testid="business-question"]')).toContain('中性任务')
      await page.fill('[data-testid="business-parameter"]', '42')
      await page.click('[data-testid="business-parameter-preview"]')
      await page.waitForSelector('[data-testid="business-parameter-diff"]')
      expect(await page.textContent('[data-testid="diff-proposed"]')).toContain('42')
      await page.click('[data-testid="business-parameter-confirm"]')
      await page.waitForSelector('[data-testid="business-parameter-confirmed"]')

      // Run the task; the fixture seeds the verified @3 answer for the created run.
      await page.click('[data-testid="business-run"]')
      await page.waitForSelector('[data-testid="business-run-panel"]')
      await page.waitForSelector('[data-testid="result-workbench"]')
      expect(await page.textContent('[data-testid="result-publication-kind"]')).toContain('已核验')

      // 正文: the verified narrative body renders from its result-bound claims.
      expect(await page.locator('[data-testid="published-answer-body"]').count()).toBe(1)

      // 结果表: a formal table is paged from one fixed verified revision.
      await page.click('[data-testid="result-tab-tables"]')
      await page.waitForSelector('[data-testid="result-table-row"]')
      expect(await page.locator('[data-testid="result-table-row"]').count()).toBe(2)
      expect(await page.getAttribute('[data-testid="result-table"]', 'data-page')).toBe('0')
      await page.click('[data-testid="result-cell-evidence"]')
      await page.waitForSelector('[data-testid="result-evidence"]')
      expect(await page.getAttribute('[data-testid="result-evidence"]', 'data-readability')).toBe('current')

      await page.click('[data-testid="result-tab-tables"]')
      await page.click('[data-testid="result-table-next"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="result-table"]')?.getAttribute('data-page') === '1',
      )
      await page.click('[data-testid="result-cell-evidence"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="result-evidence"]')?.getAttribute('data-readability') === 'missing',
      )

      await capture(page, 'business-results-workbench')
      await record('business-results-workbench', [
        'tasks=2(mounted+authorised)',
        'parameterChange=confirmed',
        'publication=verified',
        'table=page0->page1',
        'provenance=current->missing',
      ])
    } finally {
      await context.close()
    }
  })

  it('refuses a table that has no full-table verification receipt at the server', async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    const page = await context.newPage()
    try {
      await openWorkbench(page)
      const status = await page.evaluate(async ({ answerId, tableId }) => {
        const response = await fetch(`/api/v1/answers/${answerId}/tables/${tableId}`)
        const body = (await response.json()) as { error?: { code?: string } }
        return { status: response.status, code: body.error?.code }
      }, { answerId: harness.answerId, tableId: harness.unverifiedTableId })
      expect(status.status).toBe(422)
      expect(status.code).toBe('TABLE_UNVERIFIED')
      await capture(page, 'business-results-unverified-refused')
      await record('business-results-unverified-refused', ['unverifiedTable=422 TABLE_UNVERIFIED'])
    } finally {
      await context.close()
    }
  })

  it('hides every task and run action for a readonly principal', async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    const page = await context.newPage()
    try {
      await openWorkbench(page, '?case=readonly')
      const firstTask = page.locator('[data-testid="task-entry"]').first()
      expect(await firstTask.isDisabled()).toBe(true)
      expect(await page.locator('[data-testid="business-run"]').isDisabled()).toBe(true)
      expect(await page.locator('[data-testid="default-quote"]').count()).toBe(0)
    } finally {
      await context.close()
    }
  })
})
