// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '@ontology/contracts'
import { BusinessWorkbenchPanel, ResultWorkbenchPanel, createScenarioRegistry, createWorkbenchResultSource } from '@ontology/app-web'
import type { RunEvent, RunEventHandlers, RunEventStreamFactory } from '@ontology/app-web/client'
import { PROFILE } from './workbench-fixtures'
import { businessEvidenceRef, startBusinessResultsHarness } from './business-results-fixtures'
import type { BusinessResultsHarness } from './business-results-fixtures'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { root: Root; container: HTMLElement }[] = []
const harnesses: BusinessResultsHarness[] = []

/** A controllable SSE stream: the jsdom tests push persisted frames without a real EventSource. */
class FakeStream {
  readonly opened: { readonly url: string; readonly lastEventId: string | undefined }[] = []
  #handlers: RunEventHandlers | undefined

  readonly factory: RunEventStreamFactory = (url, lastEventId, handlers) => {
    this.opened.push({ url, lastEventId })
    this.#handlers = handlers
    handlers.onOpen?.()
    return { close: () => undefined }
  }

  push(event: RunEvent): void {
    this.#handlers?.onEvent(event)
  }
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

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  await Promise.all(harnesses.splice(0).map((entry) => entry.harness.app.close()))
})

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

async function submit(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
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

async function renderWorkbench(
  harness: BusinessResultsHarness,
  options: { readonly grantedCapabilities?: readonly string[]; readonly readOnly?: boolean; readonly initialRunId?: string } = {},
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const client = harness.harness.client
  await act(async () => {
    root.render(
      createElement(BusinessWorkbenchPanel, {
        client,
        registry: createScenarioRegistry(),
        profileRef: PROFILE,
        timeZone: 'Asia/Shanghai',
        declarations: {
          ontology: [],
          business: [
            { moduleRef: { id: 'scene.neutral.alpha', version: '1.0.0', digest: `sha256:${'a1'.repeat(32)}` }, taskBindingRefs: [], requiredCapabilities: ['data.readonly'] },
            { moduleRef: { id: 'scene.neutral.beta', version: '1.0.0', digest: `sha256:${'b2'.repeat(32)}` }, taskBindingRefs: [], requiredCapabilities: ['pricing.compute'] },
          ],
        },
        grantedCapabilities: options.grantedCapabilities ?? ['data.readonly', 'pricing.compute'],
        resultSource: createWorkbenchResultSource(client),
        ...(options.readOnly === true ? { readOnly: true } : {}),
        ...(options.initialRunId === undefined ? {} : { initialRunId: options.initialRunId }),
      }),
    )
  })
  mounted.push({ root, container })
  return container
}

async function renderResult(harness: BusinessResultsHarness): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(ResultWorkbenchPanel, {
        source: createWorkbenchResultSource(harness.harness.client),
        runId: harness.runId,
      }),
    )
  })
  mounted.push({ root, container })
  return container
}

async function harness(): Promise<BusinessResultsHarness> {
  const built = await startBusinessResultsHarness()
  harnesses.push(built)
  return built
}

describe('public business workbench lists mounted and authorised tasks', () => {
  it('lists only the mounted+authorised tasks and explains a missing capability', async () => {
    const built = await harness()
    const container = await renderWorkbench(built)
    await waitFor(() => container.querySelectorAll('[data-testid="task-entry"]').length === 2, 'two task entries')

    const restricted = await renderWorkbench(built, { grantedCapabilities: ['data.readonly'] })
    await waitFor(() => restricted.querySelectorAll('[data-testid="task-entry"]').length === 1, 'one authorised task')
    const unavailable = restricted.querySelector('[data-testid="task-unavailable"]')?.textContent ?? ''
    expect(unavailable).toContain('pricing.compute')
  })

  it('hides task and run actions for a readonly principal', async () => {
    const built = await harness()
    const container = await renderWorkbench(built, { readOnly: true })
    await waitFor(() => container.querySelectorAll('[data-testid="task-entry"]').length === 2, 'task entries')
    for (const button of container.querySelectorAll<HTMLButtonElement>('[data-testid="task-entry"]')) {
      expect(button.disabled).toBe(true)
    }
    expect(container.querySelector<HTMLButtonElement>('[data-testid="business-run"]')?.disabled).toBe(true)
  })
})

describe('parameter change requires an explicit confirmation', () => {
  it('shows a concrete diff and does not apply it until confirmed', async () => {
    const built = await harness()
    const container = await renderWorkbench(built)
    await waitFor(() => container.querySelectorAll('[data-testid="task-entry"]').length === 2, 'task entries')
    await click(container.querySelectorAll('[data-testid="task-entry"]')[0] as Element)

    const parameter = container.querySelector<HTMLInputElement>('[data-testid="business-parameter"]')
    if (parameter === null) throw new Error('parameter input missing')
    await type(parameter, '42')
    expect(container.querySelector('[data-testid="business-parameter-diff"]')).toBeNull()

    await click(container.querySelector('[data-testid="business-parameter-preview"]') as Element)
    expect(container.querySelector('[data-testid="diff-proposed"]')?.textContent).toContain('42')
    expect(container.querySelector('[data-testid="business-parameter-confirmed"]')).toBeNull()

    await click(container.querySelector('[data-testid="business-parameter-confirm"]') as Element)
    expect(container.querySelector('[data-testid="business-parameter-confirmed"]')?.textContent).toContain('42')
    expect(container.querySelector('[data-testid="business-parameter-diff"]')).toBeNull()
  })
})

describe('typed results share the same verified version', () => {
  it('renders 正文/结果表/依据, pages the table and keeps provenance states apart', async () => {
    const built = await harness()
    const container = await renderResult(built)
    await waitFor(() => container.querySelector('[data-testid="result-workbench"] [data-testid="result-body"]') !== null, 'verified result')

    // 正文: the verified @3 narrative is rendered from its result-bound claims.
    expect(container.querySelector('[data-testid="published-answer-body"]')).not.toBeNull()

    // 结果表: a formal table requires a verification receipt; page 1 then page 2 of the SAME version.
    await click(container.querySelector('[data-testid="result-tab-tables"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="result-table-row"]') !== null, 'table page')
    expect(container.querySelectorAll('[data-testid="result-table-row"]').length).toBe(2)
    expect(container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page')).toBe('0')

    // 依据: the first row's source is current; a later page's source is missing.
    await click(container.querySelector('[data-testid="result-cell-evidence"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="result-evidence"]') !== null, 'evidence view')
    expect(container.querySelector('[data-testid="result-evidence"]')?.getAttribute('data-readability')).toBe('current')

    await click(container.querySelector('[data-testid="result-tab-tables"]') as Element)
    const next = container.querySelector<HTMLButtonElement>('[data-testid="result-table-next"]')
    if (next === null) throw new Error('next page button missing')
    await click(next)
    await waitFor(() => container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page') === '1', 'second page')
    await click(container.querySelector('[data-testid="result-cell-evidence"]') as Element)
    await waitFor(
      () => container.querySelector('[data-testid="result-evidence"]')?.getAttribute('data-readability') === 'missing',
      'missing evidence',
    )
  })

  it('refuses a table that has no full-table verification receipt (server side)', async () => {
    const built = await harness()
    const response = await built.harness.client.getAnswer(built.runId)
    expect(response.kind).toBe('published')
    const status = await built.harness.app.inject({
      method: 'GET',
      url: `/api/v1/answers/${built.answerId}/tables/${built.unverifiedTableId}`,
    })
    expect(status.statusCode).toBe(422)
    expect((status.json() as { error: { code: string } }).error.code).toBe('TABLE_UNVERIFIED')
  })
})

describe('running a task is controllable', () => {
  it('answers a clarification on the same run', async () => {
    const stream = new FakeStream()
    const built = await startBusinessResultsHarness({ streamFactory: stream.factory })
    harnesses.push(built)
    const created = await built.harness.app.inject({
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
    expect(created.statusCode).toBe(202)
    const runId = (created.json() as { data: { runId: string } }).data.runId
    await built.harness.runService.recordRuntimeEvent(runId, planEvent(runId), built.harness.ctx)
    await built.harness.runService.recordRuntimeEvent(runId, clarificationEvent(runId, randomUUID()), built.harness.ctx)

    const container = await renderWorkbench(built, { initialRunId: runId })
    await waitFor(() => stream.opened.length > 0, 'the SSE stream to open')
    const run = await built.harness.runService.getRun(runId, built.harness.ctx)
    const clarificationId = run.pendingClarificationId
    if (clarificationId === undefined) throw new Error('the run has no pending clarification')
    await act(async () => {
      stream.push({
        id: '3',
        event: 'clarification.required',
        data: { clarificationId, questionType: 'choice', occurredAt: '2026-09-21T00:02:00Z' },
      })
    })
    await waitFor(() => container.querySelector('[data-testid="business-clarification"]') !== null, 'clarification')

    const input = container.querySelector<HTMLInputElement>('[data-testid="business-clarification-input"]')
    if (input === null) throw new Error('the clarification input is missing')
    await type(input, '选择 A')
    await click(container.querySelector('[data-testid="business-clarification-submit"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="business-notice"]') !== null, 'clarification notice')
  })

  it('cancels a run and records the cancelled outcome', async () => {
    const built = await harness()
    const container = await renderWorkbench(built)
    await waitFor(() => container.querySelectorAll('[data-testid="task-entry"]').length === 2, 'task entries')
    await click(container.querySelectorAll('[data-testid="task-entry"]')[0] as Element)
    await submit(container.querySelector('[data-testid="business-ask-form"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="business-run-panel"]') !== null, 'run panel')

    const cancel = container.querySelector<HTMLButtonElement>('[data-testid="business-cancel"]')
    if (cancel === null) throw new Error('the cancel button is missing')
    await click(cancel)
    await waitFor(
      () => container.querySelector('[data-testid="business-outcome"]')?.getAttribute('data-outcome') === 'cancelled',
      'cancelled outcome',
    )
  })
})

describe('provenance distinguishes current, historical and missing sources', () => {
  it('reports each evidence re-readability through the real evidence route', async () => {
    const built = await harness()
    const source = createWorkbenchResultSource(built.harness.client)
    expect((await source.loadEvidence(businessEvidenceRef(1))).originalSourceReReadable).toBe(true)
    expect((await source.loadEvidence(businessEvidenceRef(2))).originalSourceReReadable).toBe(false)
    expect((await source.loadEvidence(businessEvidenceRef(3))).outcome).toBe('unverifiable')
  })
})
