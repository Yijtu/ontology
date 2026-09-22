import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AUTHORIZED_SOURCE_LOCATOR,
  COT_SENTINEL,
  EVIDENCE_ID,
  FORBIDDEN_EVIDENCE_ID,
  HISTORY_OBJECT_ID,
  OTHER_TENANT_TEXT,
  SECRET_SENTINEL,
  createProvenanceHost,
} from '../ui/provenance-fixtures'
import type { ProvenanceHost } from '../ui/provenance-fixtures'
import { startHarness } from '../ui/workbench-fixtures'
import type { Harness } from '../ui/workbench-fixtures'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

/**
 * Real-browser E2E for the provenance/history surface. The built app is served by the loopback
 * host that proxies `/api` to the real Fastify server, so the page drives the real HTTP routes
 * (with a controlled evidence/history read surface) and the real responsive CSS.
 *
 * This suite is NOT part of `pnpm run verify`: it needs the Playwright browser binaries and the
 * web build. Run `pnpm run build:web && pnpm run test:e2e`.
 */
let harness: Harness
let host: ProvenanceHost
let web: WebHost
let browser: Browser

beforeAll(async () => {
  host = createProvenanceHost()
  harness = await startHarness({
    fixedPrincipal: true,
    provenance: { evidence: host.evidence, history: host.history },
  })
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

describe('provenance and history in a real browser', () => {
  it('expands a conclusion to its real basis and pages a truncated graph', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?view=evidence&evidence=${EVIDENCE_ID}`)
    await page.waitForSelector('[data-testid="evidence-basis"]')
    expect(await page.textContent('[data-testid="rule-refs"]')).toContain('rule.battery-ready')
    expect(await page.locator('[data-testid="premise-group"]').count()).toBe(2)
    expect(await page.textContent('[data-testid="source-locator"]')).toContain('postgres://public.meter_readings')

    const html = await page.content()
    expect(html).not.toContain(COT_SENTINEL)
    expect(html).not.toContain(SECRET_SENTINEL)
    expect(html).not.toContain(OTHER_TENANT_TEXT)
    await capture(page, 'evidence-basis')

    await page.click('[data-testid="load-graph"]')
    await page.waitForSelector('[data-testid="graph-truncated"]')
    expect(await page.locator('[data-testid="load-more-graph"]').count()).toBe(1)
    await capture(page, 'evidence-graph-truncated')

    await page.click('[data-testid="load-more-graph"]')
    await page.waitForSelector('[data-testid="graph-complete"]')
    expect(await page.getAttribute('[data-testid="graph-nodes"]', 'data-count')).toBe('4')

    await record('evidence-basis', [
      `origin=${web.origin}`,
      `rule=rule.battery-ready`,
      `premiseGroups=2`,
      `truncationMarked=true`,
      `containsCot=${html.includes(COT_SENTINEL)}`,
      `containsSecret=${html.includes(SECRET_SENTINEL)}`,
      `containsOtherTenantText=${html.includes(OTHER_TENANT_TEXT)}`,
    ])
    await context.close()
  })

  it('shows a permission-denied state with no original text on a 403', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?view=evidence&evidence=${FORBIDDEN_EVIDENCE_ID}`)
    await page.waitForSelector('[data-state="permission_denied"]')
    const html = await page.content()
    expect(html).not.toContain(AUTHORIZED_SOURCE_LOCATOR)
    expect(html).not.toContain(OTHER_TENANT_TEXT)
    expect(html).not.toContain(SECRET_SENTINEL)
    await capture(page, 'evidence-permission-denied')
    await record('evidence-permission-denied', [
      `evidenceId=${FORBIDDEN_EVIDENCE_ID}`,
      `state=permission_denied`,
      `containsAuthorizedText=${html.includes(AUTHORIZED_SOURCE_LOCATOR)}`,
      `containsOtherTenantText=${html.includes(OTHER_TENANT_TEXT)}`,
    ])
    await context.close()
  })

  it('clears the stale comparison after a version change but keeps the history', async () => {
    host.resetHistory()
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?view=evidence&object=${HISTORY_OBJECT_ID}`)
    await page.waitForSelector('[data-testid="history-assertions"]')
    expect(await page.getAttribute('[data-testid="history-assertions"]', 'data-count')).toBe('1')

    await page.fill('[data-testid="base-version-input"]', '1')
    await page.fill('[data-testid="compare-version-input"]', '1')
    await page.click('[data-testid="compare-versions"]')
    await page.waitForSelector('[data-testid="history-comparison"]')
    await capture(page, 'evidence-history-comparison')

    host.advanceHistory()
    await page.click('[data-testid="load-history"]')
    await page.waitForFunction(
      () => document.querySelector('[data-testid="history-assertions"]')?.getAttribute('data-count') === '2',
    )
    expect(await page.locator('[data-testid="history-comparison"]').count()).toBe(0)
    expect(await page.textContent('[data-testid="evidence-notice"]')).toContain('版本变化')
    expect(await page.locator('[data-testid="history-assertion"]').count()).toBe(2)
    await capture(page, 'evidence-history-version-change')
    await record('evidence-history-version-change', [
      `objectId=${HISTORY_OBJECT_ID}`,
      `versions=2`,
      `comparisonCleared=true`,
      `historyStillViewable=true`,
    ])
    await context.close()
  })

  it('renders the narrow layout', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?view=evidence`)
    await page.waitForSelector('[data-state="empty"]')
    expect(await page.getAttribute('[data-testid="evidence-panel"]', 'data-viewport')).toBe('narrow')
    await capture(page, 'evidence-narrow')
    await record('evidence-narrow', [`viewport=390x844`, `layout=narrow`])
    await context.close()
  })
})
