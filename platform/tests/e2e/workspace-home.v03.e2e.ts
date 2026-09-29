import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { startWorkspaceHarness } from '../ui/workspace-fixtures'
import type { WorkspaceHarness } from '../ui/workspace-fixtures'

/**
 * Real-browser E2E for the public ontology-workspace home (V03-011 / #180, SPEC v0.3a §9.1/§9.2).
 *
 * The built `workspace-harness.html` composition mounts the V03-022 shell with the workspace home
 * injected for the ontology assistant. The loopback static host proxies `/api` to a real Fastify
 * server over in-memory stores, so the page exercises create, refresh readback, the source
 * ingestion job and the draft append over actual HTTP.
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

async function openHome(page: Page, query = ''): Promise<void> {
  await page.goto(`${web.origin}/workspace-harness.html${query}`)
  await page.waitForSelector('[data-testid="assistant-shell"]')
  await page.waitForSelector('[data-testid="ontology-workspace"]')
}

describe('ontology workspace home in a real browser', () => {
  it('shows the two public assistant entries, no default quotation, and an empty workspace state', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openHome(page)
      expect(await page.textContent('[data-testid="assistant-entry-ontology"]')).toBe('本体生成助手')
      expect(await page.textContent('[data-testid="assistant-entry-business"]')).toBe('业务实践助手')
      expect(await page.locator('[data-testid="default-quote"]').count()).toBe(0)
      expect(await page.getByRole('button', { name: '报价' }).count()).toBe(0)
      await page.waitForSelector('[data-testid="workspace-empty"]')
      await capture(page, 'workspace-home-empty')
      await record('workspace-home-empty', ['assistants=ontology,business', 'defaultQuoteButtons=0', 'state=empty'])
    } finally {
      await context.close()
    }
  })

  it('creates a workspace, reports missing required fields, and reads it back after refresh', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openHome(page)
      await page.waitForSelector('[data-testid="workspace-empty"]')

      // Missing required fields are localised and do not create a workspace.
      await page.click('[data-testid="workspace-create-submit"]')
      await page.waitForSelector('[data-testid="workspace-create-error-displayName"]')
      expect(await page.textContent('[data-testid="workspace-create-error-namespace"]')).toContain('命名空间')
      expect(await page.textContent('[data-testid="workspace-create-error-goals"]')).toContain('业务目标')
      expect(await page.locator('[data-testid="workspace-list-item"]').count()).toBe(0)

      await page.fill('[data-testid="workspace-create-display-name"]', '桥架本体工作区')
      await page.fill('[data-testid="workspace-create-namespace"]', 'bridge-ontology')
      await page.fill('[data-testid="workspace-create-goals"]', '建模桥架设备\n支持维护查询')
      await page.fill('[data-testid="workspace-create-region"]', 'CN')
      await page.click('[data-testid="workspace-create-submit"]')
      await page.waitForSelector('[data-testid="workspace-list-item"]')
      expect(await page.textContent('[data-testid="workspace-detail-name"]')).toBe('桥架本体工作区')
      expect(await page.textContent('[data-testid="workspace-detail-goals"]')).toContain('建模桥架设备')
      const workspaceId = await page.getAttribute('[data-testid="workspace-detail"]', 'data-workspace-id')
      expect(workspaceId).not.toBeNull()

      // Ordinary refresh reads the same workspace back from the server.
      await page.reload()
      await page.waitForSelector('[data-testid="workspace-list-item"]')
      expect(await page.textContent('[data-testid="workspace-detail-name"]')).toBe('桥架本体工作区')
      expect(await page.textContent('[data-testid="workspace-detail-head-revision"]')).toBe('1')
      expect(await page.locator('[data-testid="workspace-draft"][data-revision="1"]').count()).toBe(1)

      await capture(page, 'workspace-home-create')
      await record('workspace-home-create', [
        `workspaceId=${workspaceId ?? ''}`,
        'revisionAfterCreate=1',
        'readbackAfterRefresh=ok',
      ])
    } finally {
      await context.close()
    }
  })

  it('imports a source, shows a partly-failed parse as partial, and registers a new draft revision', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openHome(page)
      await page.waitForSelector('[data-testid="workspace-create-display-name"]')
      await page.fill('[data-testid="workspace-create-display-name"]', '导入测试工作区')
      await page.fill('[data-testid="workspace-create-namespace"]', 'ingest-ontology')
      await page.fill('[data-testid="workspace-create-goals"]', '导入清单')
      await page.click('[data-testid="workspace-create-submit"]')
      await page.waitForSelector('[data-testid="workspace-detail"]')
      expect(await page.textContent('[data-testid="workspace-detail-head-revision"]')).toBe('1')

      await page.setInputFiles('[data-testid="source-file-input"]', {
        name: 'equipment.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('id,name\n1,充电器\n2,桥架\n', 'utf8'),
      })
      await page.click('[data-testid="source-submit"]')
      await page.waitForSelector('[data-testid="workspace-source-row"]')
      // The import also registers the source set as a new immutable draft revision before it is
      // done; wait for the head to advance so the row's refresh button is enabled again.
      await page.waitForFunction(
        () => document.querySelector('[data-testid="workspace-detail-head-revision"]')?.textContent === '2',
      )
      const row = page.locator('[data-testid="workspace-source-row"]')
      expect(await row.locator('[data-testid="source-file"]').textContent()).toBe('equipment.csv')
      expect(await row.locator('[data-testid="source-revision"]').textContent()).toBe('1')
      expect(await row.locator('[data-testid="source-type"]').textContent()).toBe('CSV')
      expect(await row.locator('[data-testid="source-stage"]').getAttribute('data-stage')).toBe('received')
      // A freshly received job is not a success.
      expect(await row.locator('[data-testid="source-outcome"]').getAttribute('data-kind')).toBe('processing')

      // The server records a partly-failed parse; refreshing shows the explicit partial state.
      const jobId = await row.getAttribute('data-job-id')
      if (jobId === null) throw new Error('the source row carries no job id')
      await harness.seedPartialJob(jobId)
      await row.locator('[data-testid="source-refresh"]').click()
      await page.waitForSelector('[data-testid="source-outcome"][data-kind="partial"]')
      expect(await row.locator('[data-testid="source-processed"]').textContent()).toBe('7/10')
      expect(await row.locator('[data-testid="source-failed"]').textContent()).toBe('3')
      expect(await row.locator('[data-testid="source-outcome"]').textContent()).toContain('部分解析')
      expect(await row.locator('[data-testid="source-outcome"]').textContent()).not.toContain('全部成功')

      // Registering the source set appended a new immutable draft revision.
      expect(await page.textContent('[data-testid="workspace-detail-head-revision"]')).toBe('2')
      expect(await page.locator('[data-testid="workspace-draft"]').count()).toBe(2)

      await capture(page, 'workspace-home-source-partial')
      await record('workspace-home-source-partial', [
        `jobId=${jobId}`,
        'stage=failed',
        'processed=7/10',
        'failed=3',
        'outcome=partial',
        'headRevisionAfterImport=2',
      ])
    } finally {
      await context.close()
    }
  })

  it('hides the create form for a readonly principal but keeps the workspace entry', async () => {
    const context = await browser.newContext({ viewport: { width: 1024, height: 800 } })
    const page = await context.newPage()
    try {
      await openHome(page, '?case=readonly')
      expect(await page.locator('[data-testid="workspace-create-form"]').count()).toBe(0)
      expect(await page.locator('[data-testid="assistant-entry-ontology"]').count()).toBe(1)
      await capture(page, 'workspace-home-readonly')
      await record('workspace-home-readonly', ['createForm=hidden', 'assistantEntry=visible'])
    } finally {
      await context.close()
    }
  })
})
