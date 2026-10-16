import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { startWorkspaceHarness } from '../ui/workspace-fixtures'
import type { WorkspaceHarness } from '../ui/workspace-fixtures'
import { startCoreBrowserHost } from './core-browser-host'

/**
 * Real-browser E2E for the public ontology-workspace home (V03-011 / #180, SPEC v0.3a §9.1/§9.2).
 *
 * Creation, source bytes and draft readback use the normal Core App and owned PostgreSQL.
 * The neutral shell/readonly checks and the explicitly controlled partial background job use
 * the memory HTTP harness. Partial job counters are not presented as an approved source parse.
 */

let harness: WorkspaceHarness
let web: WebHost
let browser: Browser
let core: Awaited<ReturnType<typeof startCoreBrowserHost>>

beforeAll(async () => {
  harness = await startWorkspaceHarness()
  web = await startWebHost(harness.baseUrl)
  core = await startCoreBrowserHost()
  browser = await chromium.launch({ headless: true })
}, 300_000)

afterAll(async () => {
  const errors: unknown[] = []
  for (const close of [() => browser?.close(), () => web?.close(), () => harness?.close(), () => core?.close()]) {
    try { await close() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'workspace browser cleanup failed')
})

async function openHome(page: Page, query = ''): Promise<void> {
  await page.goto(`${web.origin}/workspace-harness.html${query}`)
  await page.waitForSelector('[data-testid="assistant-shell"]')
  await page.waitForSelector('[data-testid="ontology-workspace"]')
}

async function openCoreHome(page: Page): Promise<void> {
  await page.goto(core.origin)
  await page.getByTestId('guide-home').waitFor()
  await page.getByTestId('context-workspace-loading').waitFor({ state: 'hidden' })
  await page.getByTestId('assistant-tab-ontology').click()
  await page.waitForSelector('[data-testid="ontology-workspace"]:is([data-phase="ready"],[data-phase="empty"])')
  const disclosure = page.getByTestId('workspace-create-disclosure')
  if (await disclosure.getAttribute('open') === null) await disclosure.locator('summary').click()
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
      await openCoreHome(page)
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
      await page.getByTestId('assistant-tab-ontology').click()
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

  it('imports authentic source bytes into a new draft and keeps partial job counts distinct from publication', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openCoreHome(page)
      await page.waitForSelector('[data-testid="workspace-create-display-name"]')
      await page.fill('[data-testid="workspace-create-display-name"]', '导入测试工作区')
      await page.fill('[data-testid="workspace-create-namespace"]', 'ingest-ontology')
      await page.fill('[data-testid="workspace-create-goals"]', '导入清单')
      const readNewWorkspace = (suffix: string) => page.waitForResponse(async (response) => {
        if (response.request().method() !== 'GET' || !new URL(response.url()).pathname.endsWith(suffix) || !response.ok()) return false
        const value = await response.json() as { data?: { workspace?: { namespace?: string } } }
        return value.data?.workspace?.namespace === 'ingest-ontology'
      })
      const [createdWorkspace] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/core/workspace-bootstrap'),
        readNewWorkspace('/sources'), readNewWorkspace('/authoring-context'),
        page.click('[data-testid="workspace-create-submit"]'),
      ])
      expect(createdWorkspace.status()).toBe(201)
      const createdBody = await createdWorkspace.json() as { data: { workspace: { workspaceId: string } } }
      await page.waitForSelector(`[data-testid="workspace-detail"][data-workspace-id="${createdBody.data.workspace.workspaceId}"]`)
      expect(await page.textContent('[data-testid="workspace-detail-name"]')).toBe('导入测试工作区')
      expect(await page.textContent('[data-testid="workspace-detail-head-revision"]')).toBe('1')

      await page.getByLabel('选择原始文件', { exact: true }).setInputFiles({
        name: 'equipment.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('id,name\n1,充电器\n2,桥架\n', 'utf8'),
      })
      await page.getByLabel('资料名称', { exact: true }).fill('equipment.csv')
      const [uploaded] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'POST' &&
          new URL(response.url()).pathname === `/api/v1/core/workspaces/${createdBody.data.workspace.workspaceId}/sources`),
        page.getByRole('button', { name: '上传并读取真实资料', exact: true }).click(),
      ])
      expect(uploaded.status()).toBe(201)
      await page.waitForFunction(
        () => document.querySelector('[data-testid="workspace-detail-head-revision"]')?.textContent === '2',
      )
      expect(await page.textContent('[data-testid="workspace-detail-head-revision"]')).toBe('2')
      expect(await page.locator('[data-testid="workspace-draft"]').count()).toBe(2)
      // The source library (design §1.5/N06) publishes a second identical control; preview the
      // original bytes from the workspace-source article this flow just uploaded into.
      await page.locator('article').getByRole('button', { name: '查看真实原文与片段', exact: true }).click()
      const original = page.getByRole('dialog', { name: '原始资料预览' })
      await original.waitFor()
      expect(await original.textContent()).toContain('充电器')
      expect(await original.textContent()).toContain('桥架')
      await page.keyboard.press('Escape')
      await capture(page, 'workspace-home-source-original')

      // Parsing an approved Core source is synchronous and requires completeness. Partial
      // background work remains a separate job, with its actual processed/failed counters.
      const created = await harness.app.inject({ method: 'POST', url: '/api/v1/ingestions',
        headers: { 'idempotency-key': 'workspace-partial-browser-job' },
        payload: { kind: 'ingestion', sourceRef: 'partial-job-fixture', documentRef: 'equipment.csv', pipelineVersion: '1.0.0' } })
      expect(created.statusCode).toBe(202)
      const jobId = (created.json() as { data: { jobId: string } }).data.jobId
      await page.goto(`${web.origin}/?view=jobs`)
      await page.getByTestId('job-id-input').fill(jobId)
      await page.getByTestId('job-load').click()
      await page.waitForSelector('[data-testid="job-stages"][data-stage="received"]')
      expect(await page.getByTestId('published-count').getAttribute('data-count')).toBe('0')
      await harness.seedPartialJob(jobId)
      await page.getByTestId('job-load').click()
      await page.getByTestId('job-failure').waitFor()
      expect(await page.getByTestId('count-total').textContent()).toContain('10')
      expect(await page.getByTestId('count-processed').textContent()).toContain('7')
      expect(await page.getByTestId('count-failed').textContent()).toContain('3')
      expect(await page.getByTestId('job-failure').textContent()).toContain('部分失败')
      expect(await page.getByTestId('published-count').getAttribute('data-count')).toBe('0')

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
