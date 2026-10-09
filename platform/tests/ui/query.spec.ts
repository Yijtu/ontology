// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ErrorCode, PublishedAnswer, ResourceRef, RuntimeEvent } from '@ontology/contracts'
import { QueryPanel } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { RunEvent, RunEventHandlers, RunEventStreamFactory } from '@ontology/app-web/client'
import { PROFILE, SENTINEL_SECRET, startHarness } from './workbench-fixtures'
import type { Harness, HarnessOptions } from './workbench-fixtures'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { root: Root; container: HTMLElement }[] = []
const openHarnesses: Harness[] = []

/** A controllable SSE stream: the jsdom tests push frames without a real EventSource. */
class FakeStream {
  readonly opened: { readonly url: string; readonly lastEventId: string | undefined }[] = []
  closed = 0
  readonly generations: RunEventHandlers[] = []
  #handlers: RunEventHandlers | undefined

  readonly factory: RunEventStreamFactory = (url, lastEventId, handlers) => {
    this.opened.push({ url, lastEventId })
    this.#handlers = handlers
    this.generations.push(handlers)
    handlers.onOpen?.()
    return {
      close: () => {
        this.closed += 1
      },
    }
  }

  push(event: RunEvent): void {
    this.#handlers?.onEvent(event)
  }

  fail(): void {
    this.#handlers?.onError(new Error('stream error'))
  }
}

async function renderQuery(
  client: WorkbenchClient,
  initialRunId?: string,
  onEvidenceReference?: (ref: ResourceRef) => void,
  availableTasks: readonly string[] = [],
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(QueryPanel, {
        client,
        profileRef: PROFILE,
        timeZone: 'Asia/Shanghai',
        availableTasks,
        ...(onEvidenceReference === undefined ? {} : { onEvidenceReference }),
        ...(initialRunId === undefined ? {} : { initialRunId }),
      }),
    )
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

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function push(stream: FakeStream, event: RunEvent): Promise<void> {
  await act(async () => {
    stream.push(event)
  })
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    )
    descriptor?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function setInnerWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

async function harness(options?: HarnessOptions): Promise<Harness> {
  const built = await startHarness(options)
  openHarnesses.push(built)
  return built
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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

async function seedRun(run: Harness, awaitingInput = false): Promise<string> {
  const created = await run.app.inject({
    method: 'POST',
    url: '/api/v1/runs',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `seed-${randomUUID()}`,
      'x-test-subject': 'ui-owner',
      'x-test-roles': 'business-user',
    },
    payload: {
      profileRef: { id: PROFILE.id, version: PROFILE.version },
      question: 'seed question',
      context: { timeZone: 'Asia/Shanghai' },
      preferences: { route: 'auto', allowWeb: false },
    },
  })
  if (created.statusCode !== 202) {
    throw new Error(`the seed run was refused: ${created.statusCode} ${created.body}`)
  }
  const runId = (created.json() as { data: { runId: string } }).data.runId
  if (awaitingInput) {
    await run.runService.recordRuntimeEvent(runId, planEvent(runId), run.ctx)
    await run.runService.recordRuntimeEvent(runId, clarificationEvent(runId, randomUUID()), run.ctx)
  }
  return runId
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
    body: {
      schemaVersion: 'answer-draft@1',
      blocks: [{ kind: 'text', text: 'A verified result.' }],
      claims: [],
      assertions: [],
    },
    publishedAt: '2026-09-21T00:00:00Z',
    ...overrides,
  }
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

describe('business query UI states (real API fixture over HTTP)', () => {
  it('renders the loading state before the fixture answers', async () => {
    const pending = new Promise<Response>(() => undefined)
    const client = new WorkbenchClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: () => pending })
    const container = await renderQuery(client)
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="query-panel"]')?.getAttribute('data-phase')).toBe('loading')
  })

  it('renders the empty state once the scope is known but no question was asked', async () => {
    const built = await harness()
    const container = await renderQuery(built.client)
    await waitFor(() => container.querySelector('[data-state="empty"]') !== null, 'empty state')
    expect(container.querySelector('[data-testid="query-ask"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="query-run"]')).toBeNull()
  })

  it('renders a failure state when the API is unreachable', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    })
    const container = await renderQuery(client)
    await waitFor(() => container.querySelector('[data-state="failure"]') !== null, 'failure state')
    expect(container.querySelector('[data-testid="state-error-code"]')?.textContent).toContain(
      'NETWORK_ERROR',
    )
  })

  it('renders a permission-denied state for a 403', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(403, {
            error: { code: 'FORBIDDEN', message: 'no role', retryable: false },
            traceId: 'trace-403',
          }),
        ),
    })
    const container = await renderQuery(client)
    await waitFor(
      () => container.querySelector('[data-state="permission_denied"]') !== null,
      'permission denied',
    )
    expect(container.querySelector('[data-testid="state-error-code"]')?.textContent).toContain('FORBIDDEN')
  })

  it('renders a not-configured state for CAPABILITY_NOT_CONFIGURED', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(409, {
            error: {
              code: 'CAPABILITY_NOT_CONFIGURED',
              message: 'the run scope projection is not configured',
              retryable: false,
            },
            traceId: 'trace-409',
          }),
        ),
    })
    const container = await renderQuery(client)
    await waitFor(() => container.querySelector('[data-state="not_configured"]') !== null, 'not configured')
    expect(container.querySelector('[data-testid="state-error-code"]')?.textContent).toContain(
      'CAPABILITY_NOT_CONFIGURED',
    )
  })

  it('renders the narrow viewport distinctly', async () => {
    setInnerWidth(390)
    const built = await harness()
    const container = await renderQuery(built.client)
    await waitFor(() => container.querySelector('[data-state="empty"]') !== null, 'empty state')
    expect(container.querySelector('[data-testid="query-panel"]')?.getAttribute('data-viewport')).toBe(
      'narrow',
    )
    setInnerWidth(1280)
  })

  it('never renders a resolved secret value in the HTML', async () => {
    const built = await harness()
    const container = await renderQuery(built.client)
    await waitFor(() => container.querySelector('[data-testid="query-scope"]') !== null, 'scope')
    expect(container.innerHTML).not.toContain(SENTINEL_SECRET)
  })
})

describe('ask within the resolved scenario scope', () => {
  it('supports a bounded multi-attribute facts request in the normal question field', async () => {
    const stream = new FakeStream()
    const built = await harness({ streamFactory: stream.factory })
    const tasks = ['facts:inspection_due', 'facts:inspection_exempt', 'facts:facility_id']
    const container = await renderQuery(built.client, undefined, undefined, tasks)
    await waitFor(() => container.querySelector('[data-testid="query-ask"]') !== null, 'ask form')

    expect(container.querySelector('[data-testid="query-capability-note"]')?.textContent).toContain(
      '当前提供 3 项已注册任务',
    )
    const question = container.querySelector<HTMLTextAreaElement>('[data-testid="query-question"]')
    const ask = container.querySelector('[data-testid="query-ask"]')
    if (question === null || ask === null) throw new Error('the facts query fields are missing')
    const requestedQuestion = 'facts:inspection_due,inspection_exempt,facility_id'
    await type(question, requestedQuestion)
    await click(ask)
    await waitFor(() => stream.opened.length > 0, 'the multi-attribute run stream')

    const eventUrl = stream.opened[0]?.url
    if (eventUrl === undefined) throw new Error('the run event stream URL was not recorded')
    const runId = /\/api\/v1\/runs\/([^/]+)\/events/u.exec(new URL(eventUrl).pathname)?.[1]
    if (runId === undefined) throw new Error('the event stream did not identify its run')
    const run = await built.runService.getRun(runId, built.ctx)
    expect(run.question).toBe(requestedQuestion)
  })

  it('offers only the enabled tools and disables web when the profile does not allow it', async () => {
    const stream = new FakeStream()
    const built = await harness({ streamFactory: stream.factory })
    const container = await renderQuery(built.client)
    await waitFor(() => container.querySelector('[data-testid="query-ask"]') !== null, 'ask form')

    const tools = [...container.querySelectorAll('[data-testid="scope-tool"]')].map(
      (node) => node.textContent,
    )
    expect(tools).toContain('data_query')
    expect(tools).not.toContain('web_search')
    expect(container.querySelector('[data-testid="scope-web"]')?.getAttribute('data-enabled')).toBe('false')
    expect(container.querySelector<HTMLInputElement>('[data-testid="query-allow-web"]')?.disabled).toBe(true)
  })

  it('asks, shows auditable progress and the shared budget, and never the draft', async () => {
    const stream = new FakeStream()
    const built = await harness({ streamFactory: stream.factory })
    const container = await renderQuery(built.client)
    await waitFor(() => container.querySelector('[data-testid="query-ask"]') !== null, 'ask form')

    const question = container.querySelector<HTMLTextAreaElement>('[data-testid="query-question"]')
    if (question === null) throw new Error('the question field is missing')
    await type(question, '明天备电策略如何安排？')
    const ask = container.querySelector('[data-testid="query-ask"]')
    if (ask === null) throw new Error('the ask button is missing')
    await click(ask)

    await waitFor(() => container.querySelector('[data-testid="query-run"]') !== null, 'run panel')
    await waitFor(() => stream.opened.length > 0, 'the SSE stream to open')
    expect(stream.opened[0]?.url).toContain('/api/v1/runs/')
    expect(stream.opened[0]?.url).toContain('/events')

    await push(stream, {
      id: '2',
      event: 'plan.summary',
      data: { planRef: 'plan-1', stepCount: 2, toolIds: ['data_query'], occurredAt: '2026-09-21T00:01:00Z' },
    })
    await push(stream, {
      id: '3',
      event: 'tool.started',
      data: { stepId: 's1', toolId: 'data_query', attempt: 1, occurredAt: '2026-09-21T00:01:01Z' },
    })
    await push(stream, {
      id: '4',
      event: 'evidence.available',
      data: { evidenceRefs: ['ev-1', 'ev-2'], occurredAt: '2026-09-21T00:01:02Z' },
    })
    // A non-public draft delta must be rejected, never rendered as progress or an answer.
    const draftText = 'UNVERIFIED-DRAFT-BODY-7f3a'
    await push(stream, {
      id: '5',
      event: 'unverified_answer.delta',
      data: { delta: draftText },
    })

    await waitFor(
      () => container.querySelectorAll('[data-testid="progress-entry"]').length >= 3,
      'progress entries',
    )
    const events = [...container.querySelectorAll('[data-testid="progress-entry"]')].map((node) =>
      node.getAttribute('data-event'),
    )
    expect(events).toContain('plan.summary')
    expect(events).toContain('tool.started')
    expect(events).toContain('evidence.available')
    expect(events).not.toContain('unverified_answer.delta')

    expect(container.querySelector('[data-testid="query-budget"]')?.getAttribute('data-known')).toBe('true')
    expect(container.querySelector('[data-testid="budget-tool-calls"]')?.textContent).toContain('8')
    expect(container.querySelector('[data-testid="query-rejected-events"]')?.textContent).toContain(
      'unverified_answer.delta',
    )
    expect(container.innerHTML).not.toContain(draftText)
    expect(
      container.querySelector('[data-testid="query-answer"]')?.getAttribute('data-answer-state'),
    ).not.toBe('published')
  })
})

describe('clarification resumes on the same shared budget', () => {
  it('submits the clarification with If-Match and shows the unchanged remaining budget', async () => {
    const stream = new FakeStream()
    const built = await harness({ streamFactory: stream.factory })
    const runId = await seedRun(built, true)
    await built.consumeBudget(runId, 2)

    const container = await renderQuery(built.client, runId)
    await waitFor(() => container.querySelector('[data-testid="query-run"]') !== null, 'run panel')
    // The persisted clarification event is replayed on connect.
    await waitFor(() => stream.opened.length > 0, 'the SSE stream to open')
    const run = await built.runService.getRun(runId, built.ctx)
    expect(run.pendingClarificationId).toBeDefined()
    await push(stream, {
      id: '3',
      event: 'clarification.required',
      data: {
        clarificationId: run.pendingClarificationId,
        questionRef: { id: 'clarify-1', version: '1.0.0' },
        questionType: 'choice',
        occurredAt: '2026-09-21T00:02:00Z',
      },
    })
    await waitFor(
      () => container.querySelector('[data-testid="query-clarification"]') !== null,
      'clarification',
    )

    const before = container.querySelector('[data-testid="budget-tool-calls"]')?.textContent ?? ''
    expect(before).toContain('6')

    const input = container.querySelector<HTMLInputElement>('[data-testid="clarification-input"]')
    if (input === null) throw new Error('the clarification input is missing')
    await type(input, '备电优先')
    const submit = container.querySelector('[data-testid="clarification-submit"]')
    if (submit === null) throw new Error('the clarification submit button is missing')
    await click(submit)

    await waitFor(
      () => container.querySelector('[data-testid="query-notice"]') !== null,
      'clarification notice',
    )
    const after = container.querySelector('[data-testid="budget-tool-calls"]')?.textContent ?? ''
    expect(after).toContain('6')
    expect(after).toBe(before)

    const refreshed = await built.runService.getRun(runId, built.ctx)
    expect(refreshed.state).toBe('collecting')
  })
})

describe('cancel and the five observable outcomes', () => {
  it.each(['network', 'server'] as const)('never restores project A after project B creation %s failure and retries B with the same idempotency key', async (fault) => {
    const stream = new FakeStream()
    const built = await harness()
    const runId = await seedRun(built)
    const projectA = '10000000-0000-4000-8000-000000000001'
    const projectB = '10000000-0000-4000-8000-000000000002'
    const sha = `sha256:${'a'.repeat(64)}`
    const projects = [projectA, projectB].map((projectId) => ({ projectId, title: projectId === projectA ? '项目甲' : '项目乙', headRevision: '1', state: 'active', createdBy: 'human', createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z' }))
    const submissions: { body: Record<string, unknown>; key: string | null }[] = []
    let oldRunReads = 0
    const client = new WorkbenchClient({ baseUrl: built.baseUrl, eventStreamFactory: stream.factory, fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path === `/api/v1/runs/${runId}`) oldRunReads += 1
      if (path === '/api/v1/projects') return jsonResponse(200, { data: { projects } })
      if (path.endsWith('/task-catalogue')) {
        const projectId = path.includes(projectA) ? projectA : projectB
        return jsonResponse(200, { data: { project: projects.find((project) => project.projectId === projectId), revision: { ref: { projectId, revision: '1', digest: sha }, industryPackRef: { id: 'pack', version: '1.0.0', digest: sha }, definitionRef: { id: 'definition', version: '1.0.0', digest: sha }, mappingRefs: [], profileRef: { ...PROFILE, snapshotHash: sha }, documentSetRef: { id: projectId, version: '1.0.0', digest: sha, kind: 'artifact' }, semanticPublicationRefs: [], sourceVisibilityEpoch: '1', changeReason: 'independent UI wire context' }, tasks: [] } })
      }
      if (path === '/api/v1/runs' && init?.method === 'POST') {
        submissions.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, key: new Headers(init.headers).get('idempotency-key') })
        if (fault === 'network') throw new TypeError('injected project B creation transport failure')
        return jsonResponse(503, { error: { code: 'SOURCE_UNAVAILABLE', message: 'injected project B creation server failure', retryable: true } })
      }
      return fetch(input, { ...init, headers: { ...(init?.headers ?? {}), 'x-test-subject': 'ui-owner', 'x-test-roles': 'platform-admin,business-user,scoped-reader,operator', 'x-test-scope': 'a' } })
    } })
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); mounted.push({ root, container })
    const props = { client, profileRef: PROFILE, timeZone: 'Asia/Shanghai', initialRunId: runId }
    await act(async () => { root.render(createElement(QueryPanel, { ...props, projectId: projectA })) })
    await waitFor(() => container.querySelector('[data-testid="query-run"]') !== null, 'actual A deep-linked run')
    const readsBefore = oldRunReads
    await act(async () => { root.render(createElement(QueryPanel, { ...props, projectId: projectB })) })
    await waitFor(() => container.querySelector('[data-testid="query-run"]') === null && container.textContent?.includes('当前项目尚无就绪的任务') === true, 'B project context and actual catalogue wire')
    const question = container.querySelector<HTMLTextAreaElement>('[data-testid="query-question"]')
    const ask = container.querySelector('[data-testid="query-ask"]')
    if (question === null || ask === null) throw new Error('B ask controls missing')
    await type(question, '只查询项目乙的当前资料')
    await click(ask)
    await waitFor(() => container.querySelector('[data-testid="state-panel-recover"]') !== null, 'B create failure recovery')
    await click(container.querySelector('[data-testid="state-panel-recover"]') as Element)
    await waitFor(() => submissions.length === 2 && container.querySelector('[data-testid="state-panel-recover"]') !== null, 'same B submission recovery attempt')
    expect(submissions[0]?.body['projectId']).toBe(projectB)
    expect(submissions[1]?.body).toEqual(submissions[0]?.body)
    expect(submissions[1]?.key).toBe(submissions[0]?.key)
    expect(submissions[0]?.key).toBeTruthy()
    expect(oldRunReads).toBe(readsBefore)
    expect(stream.generations).toHaveLength(1)
    expect(container.querySelector('[data-testid="query-run"]')).toBeNull()
    await act(async () => { stream.generations[0]?.onEvent({ id: 'late-A-published', event: 'answer.published', data: { publicationKind: 'verified' } }) })
    expect(container.querySelector('[data-testid="outcome-normal"]')).toBeNull()
  })
  it('clears a saved run when the selected project changes and ignores its late stream', async () => {
    const stream = new FakeStream()
    const built = await harness({ streamFactory: stream.factory })
    const runId = await seedRun(built)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted.push({ root, container })
    const props = {
      client: built.client,
      profileRef: PROFILE,
      timeZone: 'Asia/Shanghai',
      initialRunId: runId,
    }
    await act(async () => {
      root.render(createElement(QueryPanel, { ...props, projectId: '10000000-0000-4000-8000-000000000001' }))
    })
    await waitFor(
      () => container.querySelector('[data-testid="query-run"]') !== null,
      'saved run in first project context',
    )
    const previous = stream.generations[0]
    await act(async () => {
      root.render(createElement(QueryPanel, { ...props, projectId: '10000000-0000-4000-8000-000000000002' }))
    })
    await waitFor(
      () => container.querySelector('[data-testid="query-run"]') === null,
      'cleared run in new project context',
    )
    await act(async () => {
      previous?.onEvent({
        id: 'late-project-frame',
        event: 'answer.published',
        data: { publicationKind: 'verified' },
      })
    })
    expect(stream.generations).toHaveLength(1)
    expect(container.querySelector('[data-testid="query-run"]')).toBeNull()
    expect(container.querySelector('[data-testid="outcome-normal"]')).toBeNull()
  })
  it.each(['conflict', 'lost_response'] as const)(
    're-reads the actual run after a cancel %s and fences old callbacks',
    async (fault) => {
      const stream = new FakeStream()
      const built = await harness()
      const runId = await seedRun(built)
      await built.runService.recordRuntimeEvent(runId, planEvent(runId), built.ctx)
      await built.consumeBudget(runId, 2)
      let injected = false
      let creates = 0
      const client = new WorkbenchClient({
        baseUrl: built.baseUrl,
        eventStreamFactory: stream.factory,
        fetchImpl: async (input, init) => {
          const path = new URL(String(input)).pathname
          if (path === '/api/v1/runs' && init?.method === 'POST') creates += 1
          const options: RequestInit = {
            ...init,
            headers: {
              ...(init?.headers ?? {}),
              'x-test-subject': 'ui-owner',
              'x-test-roles':
                'platform-admin,profile-editor,business-user,scoped-reader,operator,semantic-reviewer,semantic-publisher',
              'x-test-scope': 'a',
            },
          }
          if (path.endsWith('/cancel') && !injected) {
            injected = true
            if (fault === 'conflict')
              return jsonResponse(409, {
                error: {
                  code: 'VERSION_CONFLICT',
                  message: 'injected cancel write conflict',
                  retryable: false,
                },
              })
            await fetch(input, options)
            throw new TypeError('injected lost cancel response after actual write')
          }
          return fetch(input, options)
        },
      })
      const container = await renderQuery(client, runId)
      await waitFor(() => stream.generations.length === 1, 'original actual run session')
      const old = stream.generations[0]
      const before = container.querySelector('[data-testid="budget-tool-calls"]')?.textContent
      await click(container.querySelector('[data-testid="query-cancel"]') as Element)
      await waitFor(
        () => container.querySelector('[data-testid="state-panel-recover"]') !== null,
        'cancel recovery entry',
      )
      await click(container.querySelector('[data-testid="state-panel-recover"]') as Element)
      await waitFor(
        () =>
          fault === 'conflict'
            ? stream.generations.length === 2
            : container.querySelector('[data-testid="outcome-cancelled"]') !== null,
        'actual cancellation readback',
      )
      await act(async () => {
        old?.onEvent({
          id: 'late-cancel-frame',
          event: 'answer.published',
          data: { publicationKind: 'verified' },
        })
      })
      expect(container.querySelector('[data-testid="outcome-normal"]')).toBeNull()
      expect(container.querySelector('[data-testid="budget-tool-calls"]')?.textContent).toBe(before)
      expect(creates).toBe(0)
      if (fault === 'conflict') {
        expect((await built.runService.getRun(runId, built.ctx)).state).toBe('collecting')
        await click(container.querySelector('[data-testid="query-cancel"]') as Element)
        await waitFor(
          () => container.querySelector('[data-testid="outcome-cancelled"]') !== null,
          'cancel after restored active session',
        )
      }
      expect((await built.runService.getRun(runId, built.ctx)).state).toBe('cancelled')
    },
  )
  it('cancels the run and shows the cancelled outcome', async () => {
    const stream = new FakeStream()
    const built = await harness({ streamFactory: stream.factory })
    const runId = await seedRun(built)
    const container = await renderQuery(built.client, runId)
    await waitFor(() => container.querySelector('[data-testid="query-cancel"]') !== null, 'cancel button')
    await click(container.querySelector('[data-testid="query-cancel"]') as Element)
    await waitFor(
      () => container.querySelector('[data-testid="outcome-cancelled"]') !== null,
      'cancelled outcome',
    )
    const run = await built.runService.getRun(runId, built.ctx)
    expect(run.state).toBe('cancelled')
  })

  it('shows the normal answer with the server-published hash', async () => {
    const built = await harness()
    const runId = await seedRun(built)
    const answer = publishedAnswer(runId)
    built.seedAnswer(runId, answer)
    const container = await renderQuery(built.client, runId)
    await waitFor(() => container.querySelector('[data-testid="outcome-normal"]') !== null, 'normal outcome')
    expect(container.querySelector('[data-testid="answer-hash"]')?.textContent).toBe(answer.contentHash)
    expect(container.querySelector('[data-testid="query-answer"]')?.getAttribute('data-answer-state')).toBe(
      'published',
    )
  })

  it('shows the limited answer with its limitations', async () => {
    const built = await harness()
    const runId = await seedRun(built)
    built.seedAnswer(
      runId,
      publishedAnswer(runId, {
        publicationKind: 'history_limited',
        asOf: '2026-09-20T00:00:00Z',
        limitations: ['incomplete-evidence'],
      }),
    )
    const container = await renderQuery(built.client, runId)
    await waitFor(
      () => container.querySelector('[data-testid="outcome-limited"]') !== null,
      'limited outcome',
    )
    expect(container.querySelector('[data-testid="published-answer-limitations"]')?.textContent).toContain(
      '证据不完整',
    )
    expect(container.querySelector('[data-testid="published-answer-as-of"]')?.textContent).toContain(
      '2026-09-20T00:00:00Z',
    )
  })

  it('keeps a typed answer in place while viewing its source and passes the full ref on explicit navigation', async () => {
    const built = await harness()
    const runId = await seedRun(built)
    const evidenceRef: ResourceRef = {
      id: randomUUID(),
      version: '1.0.0',
      digest: `sha256:${'d'.repeat(64)}`,
      kind: 'evidence',
    }
    const assertionId = randomUUID()
    built.seedAnswer(
      runId,
      publishedAnswer(runId, {
        body: {
          schemaVersion: 'answer-draft@2',
          blocks: [{ kind: 'assertion', assertionId }],
          claims: [],
          assertions: [
            {
              assertionId,
              subject: 'facility-T-01',
              predicate: 'inspection_due',
              kind: 'boolean',
              value: false,
              references: [
                {
                  evidenceRef,
                  resultDigest: evidenceRef.digest,
                  valuePointer: '/table/rows/0/columns/0',
                  subjectPointer: '/table/rows/0/columns/1',
                  fieldRefPointer: '/table/columns/0/fieldRef',
                },
              ],
            },
          ],
        },
      }),
    )
    const opened: ResourceRef[] = []
    const container = await renderQuery(built.client, runId, (ref) => opened.push(ref))

    await waitFor(
      () => container.querySelector('[data-testid="published-answer-boolean"]') !== null,
      'typed published answer body',
    )
    expect(container.querySelector('[data-testid="published-answer-boolean"]')?.textContent).toBe('否')
    await click(container.querySelector('[data-testid="published-answer-evidence-reference"]') as Element)
    expect(container.querySelector('dialog[open]')).not.toBeNull()
    expect(container.querySelector('[data-testid="published-answer-boolean"]')?.textContent).toBe('否')
    expect(opened).toEqual([])
    const navigation = Array.from(container.querySelectorAll('dialog button')).find(
      (button) => button.textContent === '查看完整来源页面',
    )
    if (navigation === undefined) throw new Error('explicit source navigation missing')
    await click(navigation)
    expect(opened).toEqual([evidenceRef])
  })

  it('shows a distinct panel for a gap, a conflict and a tool failure', async () => {
    const stream = new FakeStream()
    const built = await harness({ streamFactory: stream.factory })
    const runId = await seedRun(built)
    const container = await renderQuery(built.client, runId)
    await waitFor(() => stream.opened.length > 0, 'the SSE stream to open')

    await built.runService.recordRuntimeEvent(runId, failedEvent(runId, 'INSUFFICIENT_DATA'), built.ctx)
    await push(stream, {
      id: '10',
      event: 'run.failed',
      data: { error: { code: 'INSUFFICIENT_DATA', message: 'not enough evidence' } },
    })
    await waitFor(() => container.querySelector('[data-testid="outcome-gap"]') !== null, 'gap outcome')
    await waitFor(
      () =>
        container.querySelector('[data-testid="query-answer"]')?.getAttribute('data-answer-state') ===
        'unavailable',
      'the unavailable answer state',
    )
  })

  it('distinguishes a conflict from a tool failure', async () => {
    const conflictStream = new FakeStream()
    const conflictHarness = await harness({ streamFactory: conflictStream.factory })
    const conflictRun = await seedRun(conflictHarness)
    const conflictContainer = await renderQuery(conflictHarness.client, conflictRun)
    await waitFor(() => conflictStream.opened.length > 0, 'conflict stream')
    await conflictHarness.runService.recordRuntimeEvent(
      conflictRun,
      failedEvent(conflictRun, 'DATA_CONFLICT'),
      conflictHarness.ctx,
    )
    await push(conflictStream, {
      id: '11',
      event: 'run.failed',
      data: { error: { code: 'DATA_CONFLICT', message: 'conflicting evidence' } },
    })
    await waitFor(
      () => conflictContainer.querySelector('[data-testid="outcome-conflict"]') !== null,
      'conflict',
    )

    const toolStream = new FakeStream()
    const toolHarness = await harness({ streamFactory: toolStream.factory })
    const toolRun = await seedRun(toolHarness)
    const toolContainer = await renderQuery(toolHarness.client, toolRun)
    await waitFor(() => toolStream.opened.length > 0, 'tool stream')
    await toolHarness.runService.recordRuntimeEvent(
      toolRun,
      failedEvent(toolRun, 'SOURCE_UNAVAILABLE'),
      toolHarness.ctx,
    )
    await push(toolStream, {
      id: '12',
      event: 'run.failed',
      data: { error: { code: 'SOURCE_UNAVAILABLE', message: 'source down' } },
    })
    await waitFor(
      () => toolContainer.querySelector('[data-testid="outcome-tool_failure"]') !== null,
      'tool failure',
    )
  })
})
