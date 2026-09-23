import { randomUUID } from 'node:crypto'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ErrorCode, PublishedAnswer, RuntimeEvent } from '@ontology/contracts'
import { PROFILE, SENTINEL_SECRET, startHarness } from '../ui/workbench-fixtures'
import type { Harness } from '../ui/workbench-fixtures'
import { capture, record, startWebHost } from './web-host'
import type { WebHost } from './web-host'

const profileQuery = `profileId=${PROFILE.id}&profileVersion=${PROFILE.version}`

/**
 * Real-browser E2E for the business query surface. The built app is served by the loopback
 * host that proxies `/api` to the real Fastify server, so the page uses the real HTTP and
 * SSE routes and the real responsive CSS. The Playwright `EventSource` connects to the real
 * `GET /runs/{id}/events` route, so `Last-Event-ID` replay and the absence of a draft delta
 * are exercised end to end.
 *
 * This suite is NOT part of `pnpm run verify`: it needs the Playwright browser binaries and
 * the web build. Run `pnpm run build:web && pnpm run test:e2e`.
 */
let harness: Harness
let web: WebHost
let browser: Browser

beforeAll(async () => {
  harness = await startHarness({ fixedPrincipal: true })
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

async function seedRun(): Promise<string> {
  const created = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `e2e-query-${randomUUID()}`,
    },
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

function planEvent(runId: string): RuntimeEvent {
  return {
    type: 'plan_proposed',
    runId,
    eventId: randomUUID(),
    sequence: 0,
    occurredAt: '2026-09-21T00:01:00Z',
    planRef: { id: 'plan-1', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}`, kind: 'artifact' },
    stepCount: 2,
    toolIds: ['data_query'],
  }
}

function clarificationEvent(runId: string, clarificationId: string): RuntimeEvent {
  return {
    type: 'clarification_requested',
    runId,
    eventId: randomUUID(),
    sequence: 1,
    occurredAt: '2026-09-21T00:02:00Z',
    clarificationId,
    questionRef: { id: 'clarify-1', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` },
    questionType: 'choice',
  }
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

function publishedAnswer(runId: string, overrides: Partial<PublishedAnswer> = {}): PublishedAnswer {
  return {
    answerId: randomUUID(),
    runId,
    draftId: randomUUID(),
    verificationId: randomUUID(),
    contentHash: `sha256:${'a'.repeat(64)}`,
    evidenceManifestHash: `sha256:${'b'.repeat(64)}`,
    scenarioManifestHash: `sha256:${'c'.repeat(64)}`,
    publicationKind: 'verified',
    limitations: [],
    blocks: [],
    claims: [],
    publishedAt: '2026-09-21T00:00:00Z',
    ...overrides,
  }
}

describe('business query in a real browser', () => {
  it('asks within the allowed scope, shows progress and the shared budget, and no draft', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?${profileQuery}&view=query`)
    await page.waitForSelector('[data-testid="query-ask"]')
    expect(await page.getAttribute('[data-testid="query-panel"]', 'data-viewport')).toBe('desktop')

    const webDisabled = await page.locator('[data-testid="query-allow-web"]').isDisabled()
    expect(webDisabled).toBe(true)
    const toolCount = await page.locator('[data-testid="scope-tool"]').count()
    expect(toolCount).toBeGreaterThanOrEqual(3)

    await page.fill('[data-testid="query-question"]', '明天备电策略如何安排？')
    await page.click('[data-testid="query-ask"]')
    await page.waitForSelector('[data-testid="query-run"]')
    await page.waitForSelector('[data-testid="budget-tool-calls"]')
    const budget = await page.textContent('[data-testid="budget-tool-calls"]')
    expect(budget).toContain('8')

    const html = await page.content()
    expect(html).not.toContain(SENTINEL_SECRET)
    await capture(page, 'query-ask-scope')
    await record('query-ask-scope', [
      `origin=${web.origin}`,
      `webDisabled=${String(webDisabled)}`,
      `toolCount=${toolCount}`,
      `budget=${budget ?? ''}`,
      `containsSecret=${html.includes(SENTINEL_SECRET)}`,
    ])
    await context.close()
  })

  it('shows the normal answer and never exposes an unverified draft delta', async () => {
    const runId = await seedRun()
    const answer = publishedAnswer(runId)
    harness.seedAnswer(runId, answer)

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?${profileQuery}&view=query&run=${runId}`)
    await page.waitForSelector('[data-testid="outcome-normal"]')
    expect(await page.textContent('[data-testid="answer-hash"]')).toBe(answer.contentHash)

    // The real SSE route is read through the browser fetch: only public event names appear.
    const eventsPayload = await page.evaluate(async (id: string) => {
      const response = await fetch(`/api/v1/runs/${id}/events`)
      return response.text()
    }, runId)
    expect(eventsPayload).not.toContain('unverified_answer.delta')
    const eventNames = [...eventsPayload.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
    for (const name of eventNames) {
      expect([
        'run.state',
        'plan.summary',
        'tool.started',
        'tool.completed',
        'evidence.available',
        'clarification.required',
        'answer.published',
        'run.failed',
      ]).toContain(name)
    }
    const html = await page.content()
    expect(html).not.toContain('UNVERIFIED-DRAFT')
    await capture(page, 'query-normal-answer')
    await record('query-normal-answer', [
      `runId=${runId}`,
      `answerHash=${answer.contentHash}`,
      `sseEventNames=${eventNames.join(',')}`,
      `hasDraftDelta=${eventsPayload.includes('unverified_answer.delta')}`,
    ])
    await context.close()
  })

  it('resumes a clarification on the same shared budget', async () => {
    const runId = await seedRun()
    await harness.runService.recordRuntimeEvent(runId, planEvent(runId), harness.ctx)
    await harness.runService.recordRuntimeEvent(runId, clarificationEvent(runId, randomUUID()), harness.ctx)
    await harness.consumeBudget(runId, 2)

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?${profileQuery}&view=query&run=${runId}`)
    await page.waitForSelector('[data-testid="query-clarification"]')
    const before = await page.textContent('[data-testid="budget-tool-calls"]')
    expect(before).toContain('6')

    await page.fill('[data-testid="clarification-input"]', '备电优先')
    await page.click('[data-testid="clarification-submit"]')
    await page.waitForSelector('[data-testid="query-notice"]')
    const after = await page.textContent('[data-testid="budget-tool-calls"]')
    expect(after).toBe(before)
    const run = await harness.runService.getRun(runId, harness.ctx)
    expect(run.state).toBe('collecting')

    await capture(page, 'query-clarification-resume')
    await record('query-clarification-resume', [
      `runId=${runId}`,
      `budgetBefore=${before ?? ''}`,
      `budgetAfter=${after ?? ''}`,
      `stateAfter=${run.state}`,
    ])
    await context.close()
  })

  it('shows a distinct limited answer, gap, conflict and tool-failure interface', async () => {
    const limitedRun = await seedRun()
    harness.seedAnswer(
      limitedRun,
      publishedAnswer(limitedRun, { publicationKind: 'history_limited', limitations: ['仅覆盖历史时点'] }),
    )
    const gapRun = await seedRun()
    await harness.runService.recordRuntimeEvent(gapRun, failedEvent(gapRun, 'INSUFFICIENT_DATA'), harness.ctx)
    const conflictRun = await seedRun()
    await harness.runService.recordRuntimeEvent(conflictRun, failedEvent(conflictRun, 'DATA_CONFLICT'), harness.ctx)
    const toolRun = await seedRun()
    await harness.runService.recordRuntimeEvent(toolRun, failedEvent(toolRun, 'SOURCE_UNAVAILABLE'), harness.ctx)

    const scenarios: readonly { readonly runId: string; readonly selector: string; readonly name: string }[] = [
      { runId: limitedRun, selector: '[data-testid="outcome-limited"]', name: 'query-limited' },
      { runId: gapRun, selector: '[data-testid="outcome-gap"]', name: 'query-gap' },
      { runId: conflictRun, selector: '[data-testid="outcome-conflict"]', name: 'query-conflict' },
      { runId: toolRun, selector: '[data-testid="outcome-tool_failure"]', name: 'query-tool-failure' },
    ]

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const observed: string[] = []
    for (const scenario of scenarios) {
      await page.goto(`${web.origin}/?${profileQuery}&view=query&run=${scenario.runId}`)
      await page.waitForSelector(scenario.selector)
      observed.push(`${scenario.name}=ok`)
      await capture(page, scenario.name)
    }
    await record('query-five-outcomes', observed)
    await context.close()
  })

  it('cancels a run and renders the narrow layout', async () => {
    const runId = await seedRun()
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    await page.goto(`${web.origin}/?${profileQuery}&view=query&run=${runId}`)
    await page.waitForSelector('[data-testid="query-cancel"]')
    expect(await page.getAttribute('[data-testid="query-panel"]', 'data-viewport')).toBe('narrow')
    await page.click('[data-testid="query-cancel"]')
    await page.waitForSelector('[data-testid="outcome-cancelled"]')
    const run = await harness.runService.getRun(runId, harness.ctx)
    expect(run.state).toBe('cancelled')
    await capture(page, 'query-narrow-cancelled')
    await record('query-narrow-cancelled', [`runId=${runId}`, `state=${run.state}`, 'viewport=390x844'])
    await context.close()
  })
})
