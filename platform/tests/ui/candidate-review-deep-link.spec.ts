// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { CandidateReviewPanel } from '../../apps/web/src/components/CandidateReviewPanel'
import { WorkbenchClient } from '../../apps/web/src/api/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true
const candidateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function clientFor(list: Promise<Response>, candidate: Promise<Response>): WorkbenchClient {
  return new WorkbenchClient({
    baseUrl: 'http://candidate-review.test',
    fetchImpl: (input) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/v1/candidates') return list
      if (path === `/api/v1/candidates/${candidateId}`) return candidate
      if (path.endsWith('/decisions')) return Promise.resolve(json({ data: { decisions: [] } }))
      if (path.endsWith('/reviews')) return Promise.resolve(json({ data: { reviews: [] } }))
      if (path === `/api/v1/statements/${candidateId}`) return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'not published' } }, 404))
      return Promise.resolve(json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404))
    },
  })
}

async function mount(candidateList: Promise<Response>, candidate: Promise<Response>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(CandidateReviewPanel, { client: clientFor(candidateList, candidate), initialCandidateId: candidateId }))
  })
  await flush()
  return { container, root }
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (check()) return
    await flush()
  }
  if (!check()) throw new Error(`timed out waiting for ${label}`)
}

const emptyList = () => json({ data: { candidates: [] } })
const missingCandidate = () => json({ error: { code: 'NOT_FOUND', message: 'candidate not found in this scope' } }, 404)
const actualCandidate = json({ data: { candidate: {
  candidateId,
  jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  kind: 'entity',
  state: 'awaiting_review',
  deterministic: true,
  recordedAt: '2026-10-12T00:00:00.000Z',
  issues: [],
  sourceSpans: [],
  inputVersion: {},
  decisionRevision: '0',
  objectId: 'asset',
  attributes: [],
} } })

afterEach(() => { document.body.innerHTML = '' })

describe('candidate review deep-link scope failures', () => {
  it('does not show an empty state while an initial candidate lookup is pending after an empty list', async () => {
    const list = deferred<Response>()
    const candidate = deferred<Response>()
    const { container, root } = await mount(list.promise, candidate.promise)
    try {
      await act(async () => { list.resolve(emptyList()); await list.promise })
      expect(container.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase')).toBe('loading')
      expect(container.querySelector('[data-state="empty"]')).toBeNull()

      await act(async () => { candidate.resolve(missingCandidate()); await candidate.promise })
      await waitFor(() => container.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase') === 'failure', 'foreign candidate failure')
      expect(container.querySelector('[data-testid="candidate-item"]')).toBeNull()
      expect(container.querySelector('[data-testid="candidate-detail"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('keeps the direct-read failure when it completes before the empty candidate list', async () => {
    const list = deferred<Response>()
    const candidate = deferred<Response>()
    const { container, root } = await mount(list.promise, candidate.promise)
    try {
      await act(async () => { candidate.resolve(missingCandidate()); await candidate.promise })
      await waitFor(() => container.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase') === 'failure', 'foreign candidate failure')
      await act(async () => { list.resolve(emptyList()); await list.promise })
      await flush()
      expect(container.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase')).toBe('failure')
      expect(container.querySelector('[data-state="empty"]')).toBeNull()
      expect(container.querySelector('[data-testid="candidate-detail"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('keeps a successfully loaded deep-linked candidate when the later list is empty', async () => {
    const list = deferred<Response>()
    const candidate = deferred<Response>()
    const { container, root } = await mount(list.promise, candidate.promise)
    try {
      await act(async () => { candidate.resolve(actualCandidate); await candidate.promise })
      await waitFor(() => container.querySelector('[data-testid="candidate-detail"]') !== null, 'deep-linked candidate detail')
      await act(async () => { list.resolve(emptyList()); await list.promise })
      await flush()
      expect(container.querySelector('[data-testid="candidate-panel"]')?.getAttribute('data-phase')).toBe('ready')
      expect(container.querySelector('[data-testid="candidate-id"]')?.textContent).toBe(candidateId)
      expect(container.querySelector('[data-testid="candidate-detail"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })
})
