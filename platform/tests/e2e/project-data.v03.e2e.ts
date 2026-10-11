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
  const disclosure = page.locator('details.project-create-disclosure')
  if (!(await disclosure.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await disclosure.locator('summary').click()
  }
  await page.waitForSelector('[data-testid="project-create-title"]')
  await page.fill('[data-testid="project-create-title"]', '桥架设备项目')
  await selectPack(page, '[data-testid="project-create-pack"]', PROJECT_FIXTURE.packId, PROJECT_FIXTURE.packVersion)
  await page.waitForFunction(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="project-create-submit"]')
    return button !== null && !button.disabled && !document.querySelector('[data-testid="project-create-error-pack"]')
  })
  await page.click('[data-testid="project-create-submit"]')
  await page.waitForSelector('[data-testid="project-detail"]')
}

async function selectPack(page: Page, selector: string, packId: string, version: string): Promise<void> {
  const select = page.locator(selector)
  await page.waitForFunction(({ selector, packId, version }) => {
    const element = document.querySelector<HTMLSelectElement>(selector)
    return element !== null && [...element.options].some((option) => {
      try {
        const ref = JSON.parse(option.value) as { id?: string; version?: string }
        return ref.id === packId && ref.version === version
      } catch { return false }
    })
  }, { selector, packId, version })
  const value = await select.locator('option').evaluateAll((options, target) => {
    const option = options.find((candidate) => {
      try {
        const ref = JSON.parse((candidate as HTMLOptionElement).value) as { id?: string; version?: string }
        return ref.id === target.packId && ref.version === target.version
      } catch { return false }
    }) as HTMLOptionElement | undefined
    return option?.value
  }, { packId, version })
  if (value === undefined) throw new Error(`Published pack ${packId}@${version} is not available in the UI`)
  await select.selectOption(value)
  if (selector === '[data-testid="project-create-pack"]') {
    await page.getByText('已绑定当前部署配置，并固定所选行业包版本，可用于新建项目。', { exact: true }).waitFor()
  }
}

async function openProjectArea(page: Page, label: string): Promise<void> {
  await page.locator('.project-flow').getByRole('button', { name: label, exact: true }).click()
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
      await openProjectArea(page, '导入资料')

      // Select the harness's actual parsed CSV source, then register its membership through the
      // real public document endpoint before building the index.
      const source = page.locator('[data-testid="source-candidate"][data-source-id="source-1"]')
      await source.getByRole('button', { name: '确认这份资料的映射', exact: true }).click()
      const projectId = await page.getAttribute('[data-testid="project-detail"]', 'data-project-id')
      expect(projectId).toBeDefined()
      const membership = await harness.client.importProjectDocumentMembership(projectId as string, {
        documentId: PROJECT_FIXTURE.documentId,
        documentRef: harness.documentRef,
        parseRef: harness.parseRef,
        parseId: harness.parseId,
        reason: '注册已解析 CSV 的项目资料成员关系',
      })
      expect(membership.state).toBe('stale')

      await page.reload()
      await page.locator(`[data-testid="project-list-item"][data-project-id="${projectId}"]`).click()
      await page.waitForSelector('[data-testid="project-detail"]')
      await openProjectArea(page, '导入资料')
      await page.waitForFunction(() => document.querySelector('[data-testid="document-index"]')?.getAttribute('data-state') === 'stale')
      expect(await page.textContent('[data-testid="document-index-state"]')).toContain('需要更新')
      await page.click('[data-testid="document-index-build"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="document-index"]')?.getAttribute('data-state') === 'ready',
      )
      expect(await page.textContent('[data-testid="document-index-state"]')).toContain('已就绪')

      // Column mapping: explicit field-to-column selection, canonical-vs-raw preview, confirm.
      await page.locator('[data-testid="source-candidate"][data-source-id="source-1"]')
        .getByRole('button', { name: '确认这份资料的映射', exact: true }).click()
      await openProjectArea(page, '确认映射')
      const sourceValue = await page.locator('[data-testid="mapping-source"] option').evaluateAll((options) =>
        (options.find((option) => (option as HTMLOptionElement).value.length > 0) as HTMLOptionElement | undefined)?.value,
      )
      expect(sourceValue).toBeDefined()
      await page.selectOption('[data-testid="mapping-source"]', sourceValue as string)
      await page.selectOption('[data-testid="mapping-object"]', 'device')
      await page.selectOption('[data-testid="mapping-column-name"]', '0')
      await page.selectOption('[data-testid="mapping-column-capacity"]', '1')
      await page.selectOption('[data-testid="mapping-column-status"]', '2')
      await page.getByLabel('容量来源单位', { exact: true }).fill('kWh')
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

      // Bind from the mapping step; inspect the created records in the project records area.
      await page.click('[data-testid="record-bind"]')
      await page.waitForSelector('[data-testid="bind-notice"]')
      await openProjectArea(page, '项目记录')
      await page.waitForSelector('[data-testid="record-row"]')
      expect(await page.textContent('[data-testid="record-total"]')).toContain('4')
      expect(await page.locator('[data-testid="record-row"]').count()).toBe(4)
      expect(await page.locator('[data-testid="record-next"]').count()).toBe(0)
      const firstPage = await harness.client.listProjectRecords(projectId as string, { limit: 2 })
      expect(firstPage.records).toHaveLength(2)
      expect(firstPage.nextCursor).toBeDefined()
      if (firstPage.nextCursor === undefined) throw new Error('the first two-record page must carry its continuation cursor')
      const secondPage = await harness.client.listProjectRecords(projectId as string, {
        limit: 2,
        cursor: firstPage.nextCursor,
      })
      expect(secondPage.records).toHaveLength(2)
      expect(secondPage.records.some((record) => firstPage.records.some((entry) => entry.recordId === record.recordId))).toBe(false)

      // A repeated import must not duplicate records.
      await openProjectArea(page, '确认映射')
      await page.click('[data-testid="record-bind"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="bind-notice"]')?.textContent?.includes('重复导入') === true,
      )
      await openProjectArea(page, '项目记录')
      expect(await page.textContent('[data-testid="record-total"]')).toContain('4')

      // Materialise the dataset; only then does the dataset projection become ready.
      await page.selectOption('[data-testid="dataset-object"]', 'device')
      await page.click('[data-testid="dataset-materialize"]')
      await page.waitForFunction(
        () => document.querySelector('[data-testid="dataset-status"]')?.getAttribute('data-state') === 'ready',
      )
      await page.waitForFunction(
        () => document.querySelector('[data-testid="readiness-state-dataset"]')?.textContent === '已就绪',
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
      await openProjectArea(page, '版本演进')
      const targets = page.locator('[data-testid="evolution-pack"]')
      const targetValue = await targets.locator('option').evaluateAll((options) =>
        (options.find((option) => (option as HTMLOptionElement).textContent?.includes('1.1.0')) as HTMLOptionElement | undefined)?.value,
      )
      expect(targetValue).toBeDefined()
      const projectId = await page.getAttribute('[data-testid="project-detail"]', 'data-project-id')
      expect(projectId).toBeDefined()
      const revisions = await harness.client.listProjectRevisions(projectId as string)
      const revisionOne = revisions.find((revision) => revision.ref.revision === '1')
      expect(revisionOne).toBeDefined()
      const selected = targetValue as string
      const digestBoundary = selected.indexOf(':sha256:')
      const [packId, packVersion] = selected.slice(0, digestBoundary).split(':')
      const industryPackRef = { id: packId ?? '', version: packVersion ?? '', digest: selected.slice(digestBoundary + 1) }
      const body = {
        industryPackRef,
        reason: '切换行业包版本',
        profileRef: revisionOne?.profileRef,
        mappingRefs: revisionOne?.mappingRefs,
        documentSetRef: revisionOne?.documentSetRef,
      }
      const mounted = await page.evaluate(async ({ projectId, body }) => {
        const response = await fetch(`/api/v1/projects/${projectId}/pack-mounts`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'if-match': '1', 'idempotency-key': 'e2e-pack-mount-v2' },
          body: JSON.stringify(body),
        })
        const result = await response.json() as { data?: { project?: { headRevision?: string }; revision?: { ref?: { revision?: string }; industryPackRef?: { version?: string } } }; error?: { code?: string } }
        return { status: response.status, result }
      }, { projectId, body })
      expect(mounted.status).toBe(200)
      expect(mounted.result.data?.project?.headRevision).toBe('2')
      expect(mounted.result.data?.revision?.ref?.revision).toBe('2')
      expect(mounted.result.data?.revision?.industryPackRef?.version).toBe(PROJECT_FIXTURE.packV2Version)

      // Refresh the page so the visible project version comes from the server read-back.
      await page.reload()
      await page.locator(`[data-testid="project-list-item"][data-project-id="${projectId}"]`).click()
      await page.waitForSelector('[data-testid="project-detail"]')
      expect(await page.textContent('[data-testid="project-detail-head-revision"]')).toBe('2')
      expect(await page.textContent('[data-testid="project-detail-revision-count"]')).toBe('2')
      await openProjectArea(page, '版本演进')
      await page.locator('.project-history-list').getByRole('button', { name: /修订 2/ }).click()
      await page.getByText('行业包版本 1.1.0', { exact: false }).waitFor()
      expect(await page.locator('.project-history-list').textContent()).toContain('切换行业包版本')
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

      // Invalid object IDs cannot be selected from the visible catalogue; exercise the same real
      // HTTP action with a malformed domain value, then confirm the workspace remains mounted.
      await openProjectArea(page, '项目记录')
      const projectId = await page.getAttribute('[data-testid="project-detail"]', 'data-project-id')
      const invalidDataset = await page.evaluate(async (id) => {
        const response = await fetch(`/api/v1/projects/${id}/dataset-snapshots`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'e2e-invalid-dataset-object' },
          body: JSON.stringify({ objectId: 'unknown-object' }),
        })
        const body = await response.json() as { error?: { code?: string } }
        return { status: response.status, code: body.error?.code }
      }, projectId)
      expect(invalidDataset.status).toBe(400)
      expect(invalidDataset.code).toBe('INVALID_ARGUMENT')
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
      await page.locator('[data-testid="project-list-item"]').first().click()
      await page.waitForSelector('[data-testid="project-detail"]')
      expect(await page.locator('[data-testid="project-create"]').count()).toBe(0)
      expect(await page.locator('[data-testid="project-detail"]').count()).toBe(1)
      expect(await page.locator('[data-testid="mapping-confirm-button"]').count()).toBe(0)
      expect(await page.locator('[data-testid="dataset-materialize"]').count()).toBe(0)
    } finally {
      await context.close()
    }
  })
})
