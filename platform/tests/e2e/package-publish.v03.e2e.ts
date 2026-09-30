import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'
import { startPackagePublishHarness } from '../ui/package-publish-fixtures'
import type { PackagePublishHarness } from '../ui/package-publish-fixtures'

/**
 * Real-browser E2E for the package validation / publish / export / project-mount frontend
 * (V03-021 / #202, SPEC v0.3a §9.2). The built `package-publish-harness.html` composition mounts
 * the V03-022 shell with the package panel as the ontology home. The loopback static host proxies
 * `/api` to a real Fastify server over in-memory stores and the real application services, so the
 * page exercises synthetic counter-examples, the two independent validation surfaces, blocked vs
 * successful publication, immutable export and project mounting over actual HTTP. The publication
 * result is produced by the real publish call during the test — it is not seeded.
 */

let harness: PackagePublishHarness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startPackagePublishHarness()
  web = await startWebHost(harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.close().catch(() => undefined)
})

async function openPanel(page: Page, validationId: string, extra = ''): Promise<void> {
  await page.goto(
    `${web.origin}/package-publish-harness.html?workspace=${harness.workspaceId}&validation=${validationId}${extra}`,
  )
  await page.waitForSelector('[data-testid="assistant-shell"]')
  await page.waitForSelector('[data-testid="package-publication"]')
  await page.waitForSelector('[data-testid="validation-sandbox"]')
}

describe('package validation, publish, export and mount in a real browser', () => {
  it('shows isolation-marked counter-examples, publishes a stable pack, exports it and mounts it into a new project', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page, harness.stableValidationId)
      expect(await page.locator('[data-testid="validation-counterexample"]').count()).toBe(3)
      expect(await page.locator('[data-testid="validation-counterexample"]').first().getAttribute('data-isolation')).toBe('synthetic test')

      // Both surfaces are present and independent.
      expect(await page.locator('[data-testid="validation-surface-semantic"]').getAttribute('data-passed')).toBe('true')
      expect(await page.locator('[data-testid="validation-surface-deployment"]').getAttribute('data-passed')).toBe('true')
      expect(await page.locator('[data-testid="validation-publishable"]').getAttribute('data-publishable')).toBe('true')

      // Publish the real pack: the result comes from the actual publication service.
      await page.fill('[data-testid="asset-publish-pack-id"]', 'demo.bridge-pack')
      await page.fill('[data-testid="asset-publish-version"]', '1.0.0')
      await page.click('[data-testid="asset-publish"]')
      await page.waitForSelector('[data-testid="publication-result"]')
      expect(await page.locator('[data-testid="publication-semantic-published"]').getAttribute('data-published')).toBe('true')
      expect(await page.locator('[data-testid="publication-deployment-executable"]').getAttribute('data-executable')).toBe('true')

      // The live catalogue now lists the exact published version.
      await page.waitForSelector('[data-testid="pack-version"]')

      await page.click('[data-testid="pack-export"]')
      await page.waitForSelector('[data-testid="pack-export-result"]')
      expect(await page.locator('[data-testid="pack-export-digest"]').textContent()).toContain('sha256:')
      expect(await page.locator('[data-testid="pack-export-capability"]').getAttribute('data-executable')).toBe('true')

      // Mount the published pack into a brand-new project through the real project service.
      await page.fill('[data-testid="project-mount-title"]', '桥架项目')
      await page.click('[data-testid="project-mount-submit"]')
      await page.waitForSelector('[data-testid="project-mount-result"]')
      expect(await page.locator('[data-testid="project-mount-result"]').textContent()).toContain('桥架项目')

      await capture(page, 'package-publish-stable')
      await record('package-publish-stable', [
        'counterExamples=3',
        'semanticSurface=passed',
        'deploymentSurface=passed',
        'publishedPack=demo.bridge-pack@1.0.0',
        'exportDigest=sha256',
        'mountedProject=true',
      ])
    } finally {
      await context.close()
    }
  })

  it('keeps semantic publication and deployment executability separate and blocks when the deployment surface is required', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page, harness.semanticOnlyValidationId)
      expect(await page.locator('[data-testid="validation-surface-semantic"]').getAttribute('data-passed')).toBe('true')
      expect(await page.locator('[data-testid="validation-surface-deployment"]').getAttribute('data-passed')).toBe('false')
      expect(await page.locator('[data-testid="validation-blocker-deployment"]').first().textContent()).toContain('ACTION_NOT_EXECUTABLE')
      expect(await page.locator('[data-testid="validation-publishable"]').getAttribute('data-publishable')).toBe('false')

      // Default: a dependency-free semantic publish is allowed and the two surfaces stay separate.
      expect(await page.locator('[data-testid="asset-publish"]').isEnabled()).toBe(true)
      await page.fill('[data-testid="asset-publish-pack-id"]', 'demo.bridge-pack')
      await page.fill('[data-testid="asset-publish-version"]', '2.0.0')
      await page.click('[data-testid="asset-publish"]')
      await page.waitForSelector('[data-testid="publication-result"]')
      expect(await page.locator('[data-testid="publication-semantic-published"]').getAttribute('data-published')).toBe('true')
      expect(await page.locator('[data-testid="publication-deployment-executable"]').getAttribute('data-executable')).toBe('false')
      expect(await page.locator('[data-testid="publication-missing-capability"]').first().textContent()).toContain('pricing.compute')

      await capture(page, 'package-publish-semantic-only')
      await record('package-publish-semantic-only', [
        'semanticSurface=passed',
        'deploymentSurface=blocked',
        'semanticPublished=true',
        'deploymentExecutable=false',
        'missingCapability=pricing.compute',
      ])
    } finally {
      await context.close()
    }
  })

  it('blocks publication when the semantic surface fails', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } })
    const page = await context.newPage()
    try {
      await openPanel(page, harness.blockedValidationId)
      expect(await page.locator('[data-testid="validation-surface-semantic"]').getAttribute('data-passed')).toBe('false')
      expect(await page.locator('[data-testid="validation-publishable"]').getAttribute('data-publishable')).toBe('false')
      expect(await page.locator('[data-testid="asset-publish"]').isDisabled()).toBe(true)
      expect(await page.locator('[data-testid="asset-publish-blocker"]').count()).toBe(1)

      await capture(page, 'package-publish-blocked')
      await record('package-publish-blocked', ['semanticSurface=blocked', 'publishButton=disabled'])
    } finally {
      await context.close()
    }
  })

  it('hides the publish, export and mount entry points for a read-only principal', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await openPanel(page, harness.stableValidationId, '&case=readonly')
      expect(await page.locator('[data-testid="asset-publish"]').count()).toBe(0)
      expect(await page.locator('[data-testid="validation-run"]').count()).toBe(0)
      expect(await page.locator('[data-testid="pack-export"]').count()).toBe(0)
      expect(await page.locator('[data-testid="project-mount-submit"]').count()).toBe(0)

      await capture(page, 'package-publish-readonly')
      await record('package-publish-readonly', ['publishButtons=0', 'exportButtons=0', 'mountButtons=0'])
    } finally {
      await context.close()
    }
  })
})
