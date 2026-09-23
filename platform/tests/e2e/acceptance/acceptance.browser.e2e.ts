import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ErrorCode, RuntimeEvent } from '@ontology/contracts'
import { PROFILE, SENTINEL_SECRET, startHarness } from '../../ui/workbench-fixtures'
import type { Harness } from '../../ui/workbench-fixtures'
import { capture, record, startWebHost } from '../web-host'
import type { WebHost } from '../web-host'

const profileQuery = `profileId=${PROFILE.id}&profileVersion=${PROFILE.version}`

/**
 * LOCAL-054 browser acceptance — one journey across the real UI slices.
 *
 * The built app is served by the loopback static host that proxies `/api` to the real Fastify
 * server, so the page uses the real HTTP/SSE routes and the real responsive CSS. It drives
 * the configuration workbench, asks a business question (shared budget/scope), then shows a
 * normal published answer and an insufficient-data outcome, saving PNG/log evidence into the
 * gitignored `tests/e2e/artifacts/`. Run with `pnpm run build:web && pnpm run test:e2e`.
 */
let harness: Harness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startHarness({ fixedPrincipal: true })
  if (!harness.baseUrl.startsWith('http://127.0.0.1:')) {
    throw new Error('the browser acceptance harness must bind to loopback only')
  }
  web = await startWebHost(harness.baseUrl)
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  await web?.close().catch(() => undefined)
  await harness?.app.close().catch(() => undefined)
})

async function seedRun(): Promise<string> {
  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: { 'content-type': 'application/json', 'idempotency-key': `acceptance-browser-${randomUUID()}` },
    payload: {
      profileRef: { id: PROFILE.id, version: PROFILE.version },
      question: '明天备电策略如何安排？',
      context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
      preferences: { route: 'auto', allowWeb: false },
    },
  })
  if (created.statusCode !== 202) throw new Error(`seed run refused: ${created.statusCode}`)
  return (created.json() as { data: { runId: string } }).data.runId
}

function failedEvent(runId: string, code: ErrorCode): RuntimeEvent {
  return {
    type: 'failed',
    runId,
    eventId: randomUUID(),
    sequence: 2,
    occurredAt: '2026-09-21T00:03:00Z',
    error: { code, message: `simulated ${code}`, retryable: false },
  }
}

describe('LOCAL-054 browser projection checks (not a workflow end-to-end)', () => {
  it('shows configuration and query state without fabricating a published answer', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()

    // 1. Configuration workbench: preflight resolves and the profile activates.
    await page.goto(`${web.origin}/?${profileQuery}&view=workbench`)
    await page.waitForSelector('[data-testid="preflight"]')
    await page.click('[data-testid="preflight"]')
    await page.waitForSelector('[data-testid="preflight-status"][data-status="resolved"]')
    await page.click('[data-testid="activate"]')
    await page.waitForSelector('[data-testid="active-revision"]')
    await capture(page, 'acceptance-1-workbench-activated')

    // 2. Business question: only the profile's enabled tools, web search disabled, shared budget.
    await page.goto(`${web.origin}/?${profileQuery}&view=query`)
    await page.waitForSelector('[data-testid="query-ask"]')
    const webDisabled = await page.locator('[data-testid="query-allow-web"]').isDisabled()
    expect(webDisabled).toBe(true)
    await page.fill('[data-testid="query-question"]', '明天备电策略如何安排？')
    await page.click('[data-testid="query-ask"]')
    await page.waitForSelector('[data-testid="query-run"]')
    await page.waitForSelector('[data-testid="budget-tool-calls"]')
    const budget = await page.textContent('[data-testid="budget-tool-calls"]')
    await capture(page, 'acceptance-2-query-asked')

    // The HTTP route in this UI fixture only creates the run; this check deliberately
    // asserts that the browser does not claim an answer until workflow dispatch is wired.
    const runId = await page.getAttribute('[data-testid="query-run"]', 'data-run-id')
    if (runId === null) throw new Error('the query panel did not expose its created run id')
    await page.goto(`${web.origin}/?${profileQuery}&view=query&run=${runId}`)
    await page.waitForSelector('[data-testid="answer-unavailable"], [data-answer-state="in_progress"]')
    expect(await page.locator('[data-testid="answer-hash"]').count()).toBe(0)
    const events = await page.evaluate(async (id: string) => {
      const response = await fetch(`/api/v1/runs/${id}/events`)
      return response.text()
    }, runId)
    expect(events).not.toContain('unverified_answer.delta')
    await capture(page, 'acceptance-3-no-fabricated-answer')

    // 4. Abnormal: an insufficient-data outcome is distinct, and no secret leaks to the page.
    const gapRun = await seedRun()
    await harness.runService.recordRuntimeEvent(gapRun, failedEvent(gapRun, 'INSUFFICIENT_DATA'), harness.ctx)
    await page.goto(`${web.origin}/?${profileQuery}&view=query&run=${gapRun}`)
    await page.waitForSelector('[data-testid="outcome-gap"]')
    await capture(page, 'acceptance-4-insufficient-data')

    const html = await page.content()
    expect(html).not.toContain(SENTINEL_SECRET)
    await record('acceptance-journey', [
      `origin=${web.origin}`,
      'viewport=1280x900',
      `webSearchDisabled=${String(webDisabled)}`,
      `budget=${budget ?? ''}`,
      'seedAnswer=false',
      'hasDraftDelta=' + String(events.includes('unverified_answer.delta')),
      `containsSecret=${String(html.includes(SENTINEL_SECRET))}`,
    ])
    await context.close()
  })
})
