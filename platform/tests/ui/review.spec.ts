// @vitest-environment jsdom
import { act, createElement } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CandidateReviewPanel, JobProgressPanel } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import {
  CHARGER_TEXT,
  REVIEW_SENTINEL_SECRET,
  startReviewHarness,
} from './review-fixtures'
import type { ReviewHarness } from './review-fixtures'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

// Each test starts a real API over loopback and drives React through several async round
// trips; under a loaded machine that comfortably exceeds the 5s default.
vi.setConfig({ testTimeout: 30_000 })

const mounted: { root: Root; container: HTMLElement }[] = []
const openHarnesses: ReviewHarness[] = []

async function render(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  mounted.push({ root, container })
  return container
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  if (!check()) throw new Error(`timed out waiting for ${label}`)
}

async function click(element: Element | null): Promise<void> {
  if (element === null) throw new Error('cannot click a missing element')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function setInput(input: Element | null, value: string): Promise<void> {
  if (input === null) throw new Error('cannot fill a missing input')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function harness(options?: Parameters<typeof startReviewHarness>[0]): Promise<ReviewHarness> {
  const built = await startReviewHarness(options)
  openHarnesses.push(built)
  return built
}

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => {
      root.unmount()
    })
    container.remove()
  }
  for (const built of openHarnesses.splice(0)) {
    await built.app.close()
  }
})

describe('job progress UI (real API over HTTP)', () => {
  it('shows the stage, the partial failure and retries the failed stage', async () => {
    const built = await harness()
    const container = await render(
      createElement(JobProgressPanel, { client: built.client, initialJobId: built.failedJobId }),
    )
    await waitFor(() => container.querySelector('[data-testid="job-stages"]') !== null, 'job stages')
    expect(container.querySelector('[data-testid="job-stages"]')?.getAttribute('data-stage')).toBe('failed')
    const failure = container.querySelector('[data-testid="job-failure"]')
    expect(failure?.textContent).toContain('SOURCE_UNAVAILABLE')

    await click(container.querySelector('[data-testid="job-retry"]'))
    await waitFor(
      () => container.querySelector('[data-testid="job-attempts"]')?.getAttribute('data-count') === '2',
      'retry attempt',
    )
    expect(container.querySelector('[data-testid="job-notice"]')).not.toBeNull()
  })

  it('never presents the processed count as the published count', async () => {
    const built = await harness()
    const container = await render(
      createElement(JobProgressPanel, { client: built.client, initialJobId: built.publishedJobId }),
    )
    await waitFor(() => container.querySelector('[data-testid="job-publication"]') !== null, 'publication')
    expect(container.querySelector('[data-testid="count-processed"]')?.textContent).toContain('已处理（非已发布）')
    expect(container.querySelector('[data-testid="count-processed"]')?.textContent).toContain('4')
    expect(container.querySelector('[data-testid="published-count"]')?.getAttribute('data-count')).toBe('1')
    // The two numbers are genuinely different: 4 processed items, 1 published statement.
    expect(container.querySelector('[data-testid="count-processed"]')?.textContent).not.toBe(
      container.querySelector('[data-testid="published-count"]')?.textContent,
    )
  })

  it('renders the empty, failure and permission-denied states explicitly', async () => {
    const built = await harness()
    const empty = await render(createElement(JobProgressPanel, { client: built.client }))
    expect(empty.querySelector('[data-state="empty"]')).not.toBeNull()

    const failing = new WorkbenchClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    })
    const failure = await render(
      createElement(JobProgressPanel, { client: failing, initialJobId: '00000000-0000-4000-8000-000000000000' }),
    )
    await waitFor(() => failure.querySelector('[data-state="failure"]') !== null, 'failure state')

    const denied = await harness({ roles: 'business-user' })
    const permission = await render(
      createElement(JobProgressPanel, { client: denied.client, initialJobId: denied.failedJobId }),
    )
    await waitFor(
      () => permission.querySelector('[data-state="permission_denied"]') !== null,
      'permission denied state',
    )
  })
})

describe('candidate review UI (real API over HTTP)', () => {
  it('compares a candidate against the original text and keeps the source metadata private', async () => {
    const built = await harness()
    const container = await render(
      createElement(CandidateReviewPanel, { client: built.client, initialCandidateId: built.sourceCandidateId }),
    )
    await waitFor(() => container.querySelector('[data-testid="candidate-detail"]') !== null, 'candidate detail')
    await click(container.querySelector('[data-testid="open-source"]'))
    await waitFor(() => container.querySelector('[data-testid="source-span"]') !== null, 'source span')
    const span = container.querySelector('[data-testid="source-span"]')
    expect(span?.getAttribute('data-status')).toBe('resolved')
    expect(span?.querySelector('.review__quote')?.textContent).toBe(CHARGER_TEXT)
    expect(container.querySelector('[data-testid="span-locator"]')?.textContent).toContain('第 3 页')
    expect(container.innerHTML).not.toContain(REVIEW_SENTINEL_SECRET)

    // The API projection must not echo the internal chunk heading the sentinel lives in.
    const raw = await built.app.inject({
      method: 'GET',
      url: `/api/v1/candidates/${built.sourceCandidateId}/source`,
      headers: { 'x-test-subject': 'ui-reviewer', 'x-test-roles': 'semantic-reviewer' },
    })
    expect(raw.statusCode).toBe(200)
    expect(raw.body).not.toContain(REVIEW_SENTINEL_SECRET)
  })

  it('records match / create-pending / clarify / reject and keeps the history readable', async () => {
    const built = await harness()
    const container = await render(
      createElement(CandidateReviewPanel, { client: built.client, initialCandidateId: built.sourceCandidateId }),
    )
    await waitFor(() => container.querySelector('[data-testid="decision-history"]') !== null, 'decision history')

    await click(container.querySelector('[data-testid="decision-create_pending"]'))
    await waitFor(
      () => container.querySelectorAll('[data-testid="decision-record"]').length === 1,
      'create_pending recorded',
    )

    await setInput(container.querySelector('[data-testid="justification"]'), '已核对原文')
    await click(container.querySelector('[data-testid="decision-match"]'))
    await waitFor(
      () => container.querySelectorAll('[data-testid="decision-record"]').length === 2,
      'match recorded',
    )

    await click(container.querySelector('[data-testid="decision-clarify"]'))
    await waitFor(
      () => container.querySelectorAll('[data-testid="decision-record"]').length === 3,
      'clarify recorded',
    )

    await click(container.querySelector('[data-testid="decision-reject"]'))
    await waitFor(
      () => container.querySelectorAll('[data-testid="decision-record"]').length === 4,
      'reject recorded',
    )

    const kinds = [...container.querySelectorAll('[data-testid="decision-record"]')].map((node) =>
      node.getAttribute('data-kind'),
    )
    expect(kinds).toEqual(['create_pending', 'match', 'clarify', 'reject'])
  })

  it('shows a conflict when another reviewer moved the decision head', async () => {
    const built = await harness()
    const container = await render(
      createElement(CandidateReviewPanel, { client: built.client, initialCandidateId: built.sourceCandidateId }),
    )
    await waitFor(() => container.querySelector('[data-testid="decision-history"]') !== null, 'decision history')

    // Another reviewer records a decision first, moving the head from 0 to 1.
    await built.client.decideCandidate(built.sourceCandidateId, {
      kind: 'create_pending',
      expectedRevision: '0',
    })

    await click(container.querySelector('[data-testid="decision-clarify"]'))
    await waitFor(() => container.querySelector('[data-testid="review-conflict"]') !== null, 'conflict')
    expect(container.querySelector('[data-testid="review-conflict"]')?.getAttribute('data-code')).toBe(
      'VERSION_CONFLICT',
    )
  })

  it('shows an explicit missing-source state and a not-configured source state', async () => {
    const built = await harness()
    const missing = await render(
      createElement(CandidateReviewPanel, {
        client: built.client,
        initialCandidateId: built.missingSourceCandidateId,
      }),
    )
    await waitFor(() => missing.querySelector('[data-testid="open-source"]') !== null, 'open source')
    await click(missing.querySelector('[data-testid="open-source"]'))
    await waitFor(() => missing.querySelector('[data-testid="missing-source"]') !== null, 'missing source')

    const noDocuments = await harness({ withoutDocuments: true })
    const unconfigured = await render(
      createElement(CandidateReviewPanel, {
        client: noDocuments.client,
        initialCandidateId: noDocuments.sourceCandidateId,
      }),
    )
    await waitFor(() => unconfigured.querySelector('[data-testid="open-source"]') !== null, 'open source')
    await click(unconfigured.querySelector('[data-testid="open-source"]'))
    await waitFor(() => unconfigured.querySelector('[data-testid="source-error"]') !== null, 'source error')
    expect(unconfigured.querySelector('[data-testid="source-error"]')?.getAttribute('data-code')).toBe(
      'CAPABILITY_NOT_CONFIGURED',
    )
  })

  it('approves, publishes, revises and keeps the prior basis readable', async () => {
    const built = await harness()
    const created = await built.client.decideCandidate(built.sourceCandidateId, {
      kind: 'create_pending',
      expectedRevision: '0',
    })
    await built.client.decideCandidate(built.sourceCandidateId, {
      kind: 'match',
      expectedRevision: '1',
      ...(created.targetEntityId === undefined ? {} : { targetEntityId: created.targetEntityId }),
      justification: '已核对原文',
    })

    const container = await render(
      createElement(CandidateReviewPanel, { client: built.client, initialCandidateId: built.sourceCandidateId }),
    )
    await waitFor(() => container.querySelector('[data-testid="review-approve"]') !== null, 'review buttons')

    await click(container.querySelector('[data-testid="review-approve"]'))
    await waitFor(() => container.querySelector('[data-testid="review-head"]')?.getAttribute('data-approved') === 'true', 'approved')

    await click(container.querySelector('[data-testid="publish"]'))
    await waitFor(() => container.querySelector('[data-testid="statement-current"]') !== null, 'statement')

    await setInput(container.querySelector('[data-testid="revision-reason"]'), '依据更新为现场核验')
    await click(container.querySelector('[data-testid="revise-correction"]'))
    await waitFor(() => container.querySelectorAll('[data-testid="revision-record"]').length === 1, 'revision recorded')
    const record = container.querySelector('[data-testid="revision-record"]')
    expect(record?.getAttribute('data-kind')).toBe('correction')
    expect(record?.textContent).toContain('依据更新为现场核验')
    expect(record?.textContent).toContain('取代 1')
    expect(container.querySelector('[data-testid="statement-current"]')?.getAttribute('data-version')).toBe('2')
  })

  it('renders the empty, failure and permission-denied states explicitly', async () => {
    const empty = await harness({ emptyCandidates: true })
    const emptyContainer = await render(createElement(CandidateReviewPanel, { client: empty.client }))
    await waitFor(() => emptyContainer.querySelector('[data-state="empty"]') !== null, 'empty state')

    const failing = new WorkbenchClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    })
    const failure = await render(createElement(CandidateReviewPanel, { client: failing }))
    await waitFor(() => failure.querySelector('[data-state="failure"]') !== null, 'failure state')

    const denied = await harness({ roles: 'business-user' })
    const permission = await render(createElement(CandidateReviewPanel, { client: denied.client }))
    await waitFor(
      () => permission.querySelector('[data-state="permission_denied"]') !== null,
      'permission denied state',
    )
  })
})
