import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { PROJECT_FIXTURE, startProjectHarness } from '../ui/project-fixtures'
import type { ProjectHarness } from '../ui/project-fixtures'
import { startBusinessResultsHarness } from '../ui/business-results-fixtures'
import type { BusinessResultsHarness } from '../ui/business-results-fixtures'

/**
 * Real-browser E2E for the public assistant permission / not-ready / error-recovery states
 * (V03-042 / #216, SPEC generic-assistants-core §5.3, asset-data-ui §9.2/§10). The suites reuse the
 * merged project and business harnesses (real Fastify + real application services) and intercept
 * a single API call in the browser to inject a controlled §5.3 envelope. They prove that a raw 500
 * never blanks the page or leaks the body, that the user's draft survives, that not-ready and
 * permission states are worded in Chinese, and that a recovery entry is present only when the
 * family is retryable.
 */

let project: ProjectHarness
let projectWeb: WebHost
let business: BusinessResultsHarness
let businessWeb: WebHost
let browser: Browser

beforeAll(async () => {
  project = await startProjectHarness()
  projectWeb = await startWebHost(project.baseUrl)
  business = await startBusinessResultsHarness({ fixedPrincipal: true })
  businessWeb = await startWebHost(business.harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 180_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await projectWeb?.close().catch(() => undefined)
  await project?.close().catch(() => undefined)
  await businessWeb?.close().catch(() => undefined)
  await business?.harness.app.close().catch(() => undefined)
})

function failureBody(code: string, message: string, options: { readonly retryable?: boolean; readonly reasons?: readonly string[] } = {}): string {
  return JSON.stringify({
    error: {
      code,
      message,
      retryable: options.retryable === true,
      reasons: options.reasons ?? [],
      missingCapabilities: [],
    },
    traceId: 'e2e-public-ui-states',
  })
}

async function openProjectWorkspace(page: Page, query = ''): Promise<void> {
  await page.goto(`${projectWeb.origin}/project-harness.html${query}`)
  await page.waitForSelector('[data-testid="assistant-shell"]')
  await page.waitForSelector('[data-testid="project-workspace"]')
}

async function createProject(page: Page, title: string): Promise<void> {
  await page.waitForSelector('[data-testid="project-create-title"]')
  await page.fill('[data-testid="project-create-title"]', title)
  await page.selectOption('[data-testid="project-create-pack"]', `${PROJECT_FIXTURE.packId}@${PROJECT_FIXTURE.packVersion}`)
  await page.click('[data-testid="project-create-submit"]')
  await page.waitForSelector('[data-testid="project-detail"]')
}

describe('public assistant error, not-ready and permission states in a real browser', () => {
  it('writes the required materials and the next step in the empty state', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openProjectWorkspace(page)
      await page.waitForSelector('[data-testid="project-empty"]')
      expect(await page.getAttribute('[data-testid="project-empty"]', 'data-state')).toBe('empty')
      expect(await page.textContent('[data-testid="public-empty-requirement"]')).toContain('行业包')
      expect(await page.textContent('[data-testid="public-empty-next"]')).toContain('项目')
      await capture(page, 'public-states-empty')
      await record('public-states-empty', ['empty=requirement+next-step'])
    } finally {
      await context.close()
    }
  })

  it('keeps the page and draft, shows a Chinese reason and a retry after a 500, and never the raw body', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    try {
      await openProjectWorkspace(page)
      await createProject(page, '先建一个项目')
      expect(await page.locator('[data-testid="project-detail"]').count()).toBe(1)

      const secret = 'raw-stack-DB_PASSWORD_do-not-leak'
      let failCreate = true
      await context.route(/\/api\/v1\/projects$/, async (route) => {
        if (route.request().method() === 'POST' && failCreate) {
          await route.fulfill({ status: 500, contentType: 'application/json', body: failureBody('INTERNAL_ERROR', secret, { retryable: true }) })
          return
        }
        await route.continue()
      })

      await page.fill('[data-testid="project-create-title"]', '草稿不应丢失')
      await page.selectOption('[data-testid="project-create-pack"]', `${PROJECT_FIXTURE.packId}@${PROJECT_FIXTURE.packVersion}`)
      await page.click('[data-testid="project-create-submit"]')
      await page.waitForSelector('[data-testid="project-create-failure"][data-family="server"]')

      // The reason is Chinese, the raw 500 body is never rendered, and the page/draft stay.
      const reason = await page.textContent('[data-testid="project-create-failure"] [data-testid="public-state-reason"]')
      expect(reason).toContain('服务')
      expect(await page.textContent('[data-testid="project-create-failure"]')).not.toContain(secret)
      expect(await page.inputValue('[data-testid="project-create-title"]')).toBe('草稿不应丢失')
      expect(await page.locator('[data-testid="project-workspace"]').count()).toBe(1)
      expect(await page.locator('[data-testid="project-detail"]').count()).toBe(1)

      // The retry entry re-submits the same preserved draft once the service recovers.
      failCreate = false
      const before = await page.locator('[data-testid="project-list-item"]').count()
      await page.click('[data-testid="project-create-failure"] [data-testid="public-state-recover"]')
      await page.waitForFunction(
        (count) => document.querySelectorAll('[data-testid="project-list-item"]').length > count,
        before,
      )
      expect(await page.locator('[data-testid="project-create-failure"]').count()).toBe(0)

      await capture(page, 'public-states-500-draft-preserved')
      await record('public-states-500-draft-preserved', ['family=server', 'recovery=retry', 'draft=preserved', 'rawBody=hidden'])
    } finally {
      await context.close()
    }
  })

  it('classifies a not-ready dataset with its kind and a retry entry while inputs stay', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    try {
      await openProjectWorkspace(page)
      await createProject(page, '未就绪项目')

      await context.route(/\/api\/v1\/projects\/[^/]+\/dataset-snapshots$/, async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 409,
            contentType: 'application/json',
            body: failureBody('DATASET_NOT_READY', 'materialization job building', {
              retryable: true,
              reasons: ['materialization job 42 is building'],
            }),
          })
          return
        }
        await route.continue()
      })

      await page.fill('[data-testid="dataset-object"]', 'device')
      await page.click('[data-testid="dataset-materialize"]')
      await page.waitForSelector('[data-testid="project-action-error"][data-family="not_ready"]')
      expect(await page.textContent('[data-testid="project-action-error"] [data-testid="public-state-reason"]')).toContain('查询数据')
      expect(await page.locator('[data-testid="project-action-error"] [data-testid="public-state-recover"]').count()).toBe(1)
      expect(await page.inputValue('[data-testid="dataset-object"]')).toBe('device')
      expect(await page.locator('[data-testid="project-detail"]').count()).toBe(1)

      await capture(page, 'public-states-not-ready')
      await record('public-states-not-ready', ['family=not_ready', 'kind=dataset', 'recovery=retry', 'page=preserved'])
    } finally {
      await context.close()
    }
  })

  it('shows a Chinese permission reason with no retry entry and discloses nothing', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    try {
      await openProjectWorkspace(page)
      await createProject(page, '权限项目')

      await context.route(/\/api\/v1\/projects\/[^/]+\/dataset-snapshots$/, async (route) => {
        if (route.request().method() === 'POST') {
          await route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: failureBody('FORBIDDEN', 'another tenant project exists'),
          })
          return
        }
        await route.continue()
      })

      await page.fill('[data-testid="dataset-object"]', 'device')
      await page.click('[data-testid="dataset-materialize"]')
      await page.waitForSelector('[data-testid="project-action-error"][data-family="permission"]')
      expect(await page.textContent('[data-testid="project-action-error"] [data-testid="public-state-reason"]')).toContain('权限')
      expect(await page.locator('[data-testid="project-action-error"] [data-testid="public-state-recover"]').count()).toBe(0)
      expect(await page.content()).not.toContain('another tenant project exists')

      await capture(page, 'public-states-permission')
      await record('public-states-permission', ['family=permission', 'recovery=none', 'retryButton=0'])
    } finally {
      await context.close()
    }
  })

  it('hides every write entry for a readonly principal', async () => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
    const page = await context.newPage()
    try {
      await openProjectWorkspace(page, '?case=readonly')
      await page.waitForSelector('[data-testid="project-workspace"]')
      expect(await page.locator('[data-testid="project-create"]').count()).toBe(0)
      expect(await page.locator('[data-testid="mapping-confirm-button"]').count()).toBe(0)
      expect(await page.locator('[data-testid="dataset-materialize"]').count()).toBe(0)
      await record('public-states-readonly', ['createForm=0', 'mappingConfirm=0', 'datasetMaterialize=0'])
    } finally {
      await context.close()
    }
  })
})

describe('public business result read survives a 500 without blanking the page', () => {
  it('keeps the workbench and offers a retry when the verified result read fails', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    const page = await context.newPage()
    try {
      let failResult = true
      await context.route(/\/api\/v1\/answers\/[^/]+\/result$/, async (route) => {
        if (failResult) {
          await route.fulfill({ status: 500, contentType: 'application/json', body: failureBody('INTERNAL_ERROR', 'result store offline', { retryable: true }) })
          return
        }
        await route.continue()
      })

      await page.goto(`${businessWeb.origin}/business-results-harness.html`)
      await page.waitForSelector('[data-testid="business-workbench"]')
      await page.click('[data-testid="task-entry"]')
      await page.click('[data-testid="business-run"]')
      await page.waitForSelector('[data-testid="result-error"][data-family="server"]')

      expect(await page.textContent('[data-testid="result-error"] [data-testid="public-state-reason"]')).toContain('服务')
      expect(await page.locator('[data-testid="business-workbench"]').count()).toBe(1)
      expect(await page.locator('[data-testid="result-error"] [data-testid="public-state-recover"]').count()).toBe(1)

      failResult = false
      await page.click('[data-testid="result-error"] [data-testid="public-state-recover"]')
      await page.waitForSelector('[data-testid="result-publication-kind"]')
      expect(await page.locator('[data-testid="result-error"]').count()).toBe(0)

      await capture(page, 'public-states-result-500-recovered')
      await record('public-states-result-500-recovered', ['family=server', 'recovery=retry', 'workbench=preserved', 'readback=recovered'])
    } finally {
      await context.close()
    }
  })
})
