import { chromium } from '@playwright/test'
import type { Browser, Page } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CHARGER_TEXT,
  REVIEW_SENTINEL_SECRET,
  insertReviewCandidate,
  startReviewHarness,
} from '../ui/review-fixtures'
import type { ReviewHarness } from '../ui/review-fixtures'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

/**
 * Real-browser E2E for the ingestion-job and candidate-review surfaces.
 *
 * The built app is served by a loopback-only static host that proxies `/api` to the real
 * Fastify server, so the browser exercises the actual HTTP routes and the responsive CSS.
 * This suite is NOT part of `pnpm run verify`: run `pnpm run build:web && pnpm run test:e2e`.
 * The API harness mints a fixed principal because a browser cannot attach the test identity
 * headers; it binds to 127.0.0.1 only and production uses verified OIDC (SPEC §3).
 */
let harness: ReviewHarness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startReviewHarness({ fixedPrincipal: true })
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

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${web.origin}/?${query}`)
}

describe('ingestion job and candidate review in a real browser', () => {
  it('shows the stage and partial failure, then retries the failed stage', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await open(page, `view=jobs&job=${harness.failedJobId}`)
    await page.waitForSelector('[data-testid="job-stages"]')
    expect(await page.getAttribute('[data-testid="job-stages"]', 'data-stage')).toBe('failed')
    expect(await page.textContent('[data-testid="job-failure"]')).toContain('SOURCE_UNAVAILABLE')

    await page.click('[data-testid="job-retry"]')
    await page.waitForSelector('[data-testid="job-attempts"][data-count="2"]')
    const attempts = await page.getAttribute('[data-testid="job-attempts"]', 'data-count')
    await capture(page, 'jobs-partial-failure-retry')
    await record('jobs-partial-failure-retry', [
      `origin=${web.origin}`,
      `jobId=${harness.failedJobId}`,
      'stage=failed',
      `attempts=${attempts ?? ''}`,
    ])
    await context.close()
  })

  it('keeps the processed count and the published count visibly apart', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await open(page, `view=jobs&job=${harness.publishedJobId}`)
    await page.waitForSelector('[data-testid="job-publication"]')
    const processed = await page.textContent('[data-testid="count-processed"]')
    const published = await page.textContent('[data-testid="published-count"]')
    expect(processed).toContain('4')
    expect(published).toContain('1')
    expect(processed).not.toBe(published)
    await capture(page, 'jobs-processed-not-published')
    await record('jobs-processed-not-published', [
      `jobId=${harness.publishedJobId}`,
      `processed=${processed ?? ''}`,
      `published=${published ?? ''}`,
    ])
    await context.close()
  })

  it('compares a candidate with the original text and records a decision', async () => {
    const candidate = await insertReviewCandidate(harness)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await open(page, `view=review&candidate=${candidate.candidateId}`)
    await page.waitForSelector('[data-testid="candidate-detail"]')

    await page.click('[data-testid="open-source"]')
    await page.waitForSelector('[data-testid="source-span"][data-status="resolved"]')
    expect(await page.textContent('[data-testid="source-span"] .review__quote')).toBe(CHARGER_TEXT)
    const html = await page.content()
    expect(html).not.toContain(REVIEW_SENTINEL_SECRET)

    await page.click('[data-testid="decision-create_pending"]')
    await page.waitForSelector('[data-testid="decision-record"][data-kind="create_pending"]')
    await page.fill('[data-testid="justification"]', '已核对原文')
    await page.click('[data-testid="decision-match"]')
    await page.waitForSelector('[data-testid="decision-record"][data-kind="match"]')
    const records = await page.locator('[data-testid="decision-record"]').count()
    await capture(page, 'review-compare-and-decide')
    await record('review-compare-and-decide', [
      `candidateId=${candidate.candidateId}`,
      `quote=${CHARGER_TEXT}`,
      `decisions=${records}`,
      `containsSecret=${html.includes(REVIEW_SENTINEL_SECRET)}`,
    ])
    await context.close()
  })

  it('shows an explicit missing-source state', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await open(page, `view=review&candidate=${harness.missingSourceCandidateId}`)
    await page.waitForSelector('[data-testid="open-source"]')
    await page.click('[data-testid="open-source"]')
    await page.waitForSelector('[data-testid="missing-source"]')
    await capture(page, 'review-missing-source')
    await record('review-missing-source', [`candidateId=${harness.missingSourceCandidateId}`])
    await context.close()
  })

  it('shows a conflict when another reviewer moved the decision head', async () => {
    const candidate = await insertReviewCandidate(harness)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await open(page, `view=review&candidate=${candidate.candidateId}`)
    await page.waitForSelector('[data-testid="decision-clarify"]')

    // Another reviewer records a decision first, moving the head from 0 to 1.
    await harness.client.decideCandidate(candidate.candidateId, { kind: 'create_pending', expectedRevision: '0' })

    await page.click('[data-testid="decision-clarify"]')
    await page.waitForSelector('[data-testid="review-conflict"][data-code="VERSION_CONFLICT"]')
    await capture(page, 'review-conflict')
    await record('review-conflict', [`candidateId=${candidate.candidateId}`, 'conflictCode=VERSION_CONFLICT'])
    await context.close()
  })

  it('approves, publishes, revises and keeps the prior basis readable', async () => {
    const candidate = await insertReviewCandidate(harness)
    const created = await harness.client.decideCandidate(candidate.candidateId, {
      kind: 'create_pending',
      expectedRevision: '0',
    })
    await harness.client.decideCandidate(candidate.candidateId, {
      kind: 'match',
      expectedRevision: '1',
      ...(created.targetEntityId === undefined ? {} : { targetEntityId: created.targetEntityId }),
      justification: '已核对原文',
    })

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await open(page, `view=review&candidate=${candidate.candidateId}`)
    await page.waitForSelector('[data-testid="review-approve"]')
    await page.click('[data-testid="review-approve"]')
    await page.waitForSelector('[data-testid="review-head"][data-approved="true"]')
    await page.click('[data-testid="publish"]')
    await page.waitForSelector('[data-testid="statement-current"]')

    await page.fill('[data-testid="revision-reason"]', '依据更新为现场核验')
    await page.click('[data-testid="revise-correction"]')
    await page.waitForSelector('[data-testid="revision-record"][data-kind="correction"]')
    const revision = await page.textContent('[data-testid="revision-record"]')
    expect(revision).toContain('依据更新为现场核验')
    expect(revision).toContain('取代 1')
    await capture(page, 'review-publish-and-revise')
    await record('review-publish-and-revise', [
      `candidateId=${candidate.candidateId}`,
      `revision=${revision ?? ''}`,
    ])
    await context.close()
  })

  it('shows an explicit not-configured error state when the document reader is absent', async () => {
    const built = await startReviewHarness({ fixedPrincipal: true, withoutDocuments: true })
    const host = await startWebHost(built.baseUrl)
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    try {
      await page.goto(`${host.origin}/?view=review&candidate=${built.sourceCandidateId}`)
      await page.waitForSelector('[data-testid="open-source"]')
      await page.click('[data-testid="open-source"]')
      await page.waitForSelector('[data-testid="source-error"][data-code="CAPABILITY_NOT_CONFIGURED"]')
      const error = await page.textContent('[data-testid="source-error"]')
      await capture(page, 'review-source-not-configured')
      await record('review-source-not-configured', [`error=${error ?? ''}`])
    } finally {
      await context.close()
      await host.close()
      await built.app.close()
    }
  })

  it('renders a single-column review layout under a narrow viewport', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await open(page, `view=review&candidate=${harness.sourceCandidateId}`)
    await page.waitForSelector('[data-testid="candidate-detail"]')
    expect(await page.getAttribute('.app', 'data-viewport')).toBe('narrow')
    const gridColumns = await page.$eval('.review__body', (node) => getComputedStyle(node).gridTemplateColumns)
    expect(gridColumns.trim().split(/\s+/).length).toBe(1)
    await capture(page, 'review-narrow')
    await record('review-narrow', ['viewport=390x844', `gridTemplateColumns=${gridColumns}`])
    await context.close()
  })
})
