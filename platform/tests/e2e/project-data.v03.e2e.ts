import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { PROJECT_FIXTURE, startProjectHarness } from '../ui/project-fixtures'
import type { ProjectHarness } from '../ui/project-fixtures'

/**
 * Real-browser E2E for the public project / source-mapping / readiness workspace (V03-020 / #193,
 * SPEC v0.3a §3.2/§6/§8/§9). The built `project-harness.html` composition mounts the V03-022 shell
 * with the project workspace as the business home. The loopback static host proxies `/api` to a
 * real Fastify server wired to the merged ProjectService / ProjectMappingService /
 * ProjectDataMaterializationService over in-memory stores and the real structured parser, so the
 * page exercises create/continue, pack mount, source import + index, column mapping preview/confirm,
 * record binding/paging/duplicate import, and the independent semantic/query/index readiness over
 * actual HTTP.
 */

let harness: ProjectHarness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startProjectHarness()
  web = await startWebHost(harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.close().catch(() => undefined)
})

async function openWorkspace(page: Page, query = ''): Promise<void> {
  await page.goto(`${web.origin}/project-harness.html${query}`)
  await page.waitForSelector('[data-testid="assistant-shell"]')
  await page.waitForSelector('[data-testid="project-workspace"]')
}

async function createProject(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="project-create-title"]')
  await page.fill('[data-testid="project-create-title"]', '桥架设备项目')
  await page.selectOption('[data-testid="project-create-pack"]', `${PROJECT_FIXTURE.packId}@${PROJECT_FIXTURE.packVersion}`)
  await page.click('[data-testid="project-create-submit"]')
  await page.waitForSelector('[data-testid="project-detail"]')
}

describe('project, mapping and readiness public workspace in a real browser', () => {
  it('creates a project, shows the independent readiness projections and a located blocker', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    try {
      await openWorkspace(page)
      expect(await page.textContent('[data-testid="assistant-entry-ontology"]')).toBe('本体生成助手')
      expect(await page.textContent('[data-testid="assistant-entry-business"]')).toBe('业务实践助手')
      expect(await page.locator('[data-testid="default-quote"]').count()).toBe(0)

      await createProject(page)
      expect(await page.textContent('[data-testid="project-detail-title"]')).toBe('桥架设备项目')
      expect(await page.textContent('[data-testid="project-detail-head-revision"]')).toBe('1')

      expect(await page.locator('[data-testid="readiness-row"]').count()).toBe(3)
      for (const kind of ['published_semantics', 'dataset', 'document_index']) {
        expect(await page.textContent(`[data-testid="readiness-state-${kind}"]`)).toBe('未构建')
      }
      expect(await page.getAttribute('[data-testid="readiness-blocker"]', 'data-code')).toBe('READINESS_NOT_BUILT')

      // Ordinary refresh reads the same project back from the server.
      await page.reload()
      await page.waitForSelector('[data-testid="project-detail"]')
      expect(await page.textContent('[data-testid="project-detail-title"]')).toBe('桥架设备项目')

      await capture(page, 'project-workspace-created')
      await record('project-workspace-created', [
        'project=桥架设备项目',
        'headRevision=1',
        'readiness=published_semantics:missing,dataset:missing,document_index:missing',
      ])
    } finally {
      await context.close()
    }
  })

  it('imports a source, builds the document index, confirms a mapping, binds records and pages', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1200 } })
    const page = await context.newPage()
    try {
      await openWorkspace(page)
      await createProject(page)

      // Source import + document index: stale until the index build completes.
      await page.click('[data-testid="source-import-source-1"]')
      await page.waitForSelector('[data-testid="source-imported-source-1"]')
      expect(await page.textContent('[data-testid="document-index-state"]')).toContain('stale')
      await page.click('[data-testid="document-index-build"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="document-index"]')?.getAttribute('data-state') === 'ready',
      )
      expect(await page.textContent('[data-testid="document-index-state"]')).toContain('ready')

      // Column mapping: explicit field-to-column selection, canonical-vs-raw preview, confirm.
      await page.selectOption('[data-testid="mapping-source"]', 'source-1')
      await page.selectOption('[data-testid="mapping-object"]', 'device')
      await page.selectOption('[data-testid="mapping-column-name"]', '0')
      await page.selectOption('[data-testid="mapping-column-capacity"]', '1')
      await page.selectOption('[data-testid="mapping-column-status"]', '2')
      await page.click('[data-testid="mapping-preview-button"]')
      await page.waitForSelector('[data-testid="mapping-preview"]')
      expect(await page.textContent('[data-testid="mapping-preview-confirmable"]')).toContain('可确认')
      expect(await page.textContent('[data-testid="mapping-preview-rows"]')).toContain('4')
      const capacity = page.locator('[data-testid="mapping-preview-capacity"]')
      expect(await capacity.getAttribute('data-normalization')).toBe('identity')
      expect(await capacity.locator('td:nth-child(2)').textContent()).toBe('12.5')
      expect(await capacity.locator('td:nth-child(3)').textContent()).toBe('12.5')

      await page.click('[data-testid="mapping-confirm-button"]')
      await page.waitForSelector('[data-testid="mapping-confirmed"]')

      // Bind the confirmed mapping's parsed rows: four records, two per page.
      await page.click('[data-testid="record-bind"]')
      await page.waitForSelector('[data-testid="record-row"]')
      expect(await page.textContent('[data-testid="record-total"]')).toContain('4')
      expect(await page.locator('[data-testid="record-row"]').count()).toBe(2)
      await page.click('[data-testid="record-next"]')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="record-row"]').length === 2 &&
          document.querySelector('[data-testid="record-next"]') === null,
      )

      // A repeated import must not duplicate records.
      await page.click('[data-testid="record-bind"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="bind-notice"]')?.textContent?.includes('重复导入') === true,
      )
      expect(await page.textContent('[data-testid="record-total"]')).toContain('4')

      // Materialise the dataset; only then does the dataset projection become ready.
      await page.fill('[data-testid="dataset-object"]', 'device')
      await page.click('[data-testid="dataset-materialize"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="dataset-status"]')?.getAttribute('data-state') === 'ready',
      )
      await page.waitForFunction(
        () => document.querySelector('[data-testid="readiness-state-dataset"]')?.textContent === 'ready',
      )
      // Semantic and document-index readiness stay independent of the dataset.
      expect(await page.textContent('[data-testid="readiness-state-published_semantics"]')).toBe('未构建')

      await capture(page, 'project-workspace-records')
      await record('project-workspace-records', [
        'documentIndex=ready',
        'mapping=confirmed',
        'records=4',
        'dataset=ready',
        'duplicateImport=no-new-records',
      ])
    } finally {
      await context.close()
    }
  })

  it('mounts a newer pack version as a new revision and shows the localised change impact', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openWorkspace(page)
      await createProject(page)
      await page.selectOption('[data-testid="project-mount-pack"]', `${PROJECT_FIXTURE.packId}@${PROJECT_FIXTURE.packV2Version}`)
      await page.fill('[data-testid="project-mount-reason"]', '切换行业包版本')
      await page.click('[data-testid="project-mount-submit"]')
      await page.waitForSelector('[data-testid="project-mount-result"], [data-testid="project-action-error"]')
      if (await page.locator('[data-testid="project-mount-result"]').count() === 0) {
        throw new Error(`mount failed: ${await page.textContent('[data-testid="project-action-error"]') ?? 'unknown'}`)
      }
      expect(await page.textContent('[data-testid="project-detail-head-revision"]')).toBe('2')
      const result = await page.textContent('[data-testid="project-mount-result"]')
      expect(result).toContain('修订 2')
      expect(result).toContain('语义发布')
    } finally {
      await context.close()
    }
  })

  it('refuses a cross-scope project read and keeps the page after a failed action', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openWorkspace(page)
      await createProject(page)

      // A project id outside the trusted scope is not disclosed (404), and the page stays.
      const status = await page.evaluate(async () => {
        const response = await fetch('/api/v1/projects/99999999-9999-4999-8999-999999999999')
        return response.status
      })
      expect(status).toBe(404)
      expect(await page.locator('[data-testid="project-detail"]').count()).toBe(1)

      // A failed dataset materialisation is localised and does not wipe the page.
      await page.fill('[data-testid="dataset-object"]', 'unknown-object')
      await page.click('[data-testid="dataset-materialize"]')
      await page.waitForSelector('[data-testid="project-action-error"]')
      expect(await page.getAttribute('[data-testid="project-action-error"]', 'data-code')).toBe('INVALID_ARGUMENT')
      expect(await page.locator('[data-testid="project-detail"]').count()).toBe(1)

      await capture(page, 'project-workspace-error-preserved')
      await record('project-workspace-error-preserved', ['crossScope=404', 'failedAction=INVALID_ARGUMENT', 'page=preserved'])
    } finally {
      await context.close()
    }
  })

  it('hides every create/mapping action for a readonly principal but keeps the project list', async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    const page = await context.newPage()
    try {
      await openWorkspace(page, '?case=readonly')
      expect(await page.locator('[data-testid="project-create"]').count()).toBe(0)
      expect(await page.locator('[data-testid="project-detail"]').count()).toBe(1)
      expect(await page.locator('[data-testid="mapping-confirm-button"]').count()).toBe(0)
      expect(await page.locator('[data-testid="dataset-materialize"]').count()).toBe(0)
    } finally {
      await context.close()
    }
  })
})
