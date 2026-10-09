// @vitest-environment jsdom
import { randomUUID } from 'node:crypto'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { RuntimeEvent, ResourceRef } from '@ontology/contracts'
import type { ProjectTaskItem, ProjectComputeInputSelection, SavedCellSelector } from '@ontology/app-web'
import {
  BusinessWorkbenchPanel,
  ResultWorkbenchPanel,
  TaskRunForm,
  createScenarioRegistry,
  createWorkbenchResultSource,
} from '@ontology/app-web'
import type { RunEvent, RunEventHandlers, RunEventStreamFactory } from '@ontology/app-web/client'
import { PROFILE, startHarness } from './workbench-fixtures'
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
async function select(element: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function renderWorkbench(
  harness: BusinessResultsHarness,
  options: {
    readonly grantedCapabilities?: readonly string[]
    readonly readOnly?: boolean
    readonly initialRunId?: string
  } = {},
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
            {
              moduleRef: { id: 'scene.neutral.alpha', version: '1.0.0', digest: `sha256:${'a1'.repeat(32)}` },
              taskBindingRefs: [],
              requiredCapabilities: ['data.readonly'],
            },
            {
              moduleRef: { id: 'scene.neutral.beta', version: '1.0.0', digest: `sha256:${'b2'.repeat(32)}` },
              taskBindingRefs: [],
              requiredCapabilities: ['pricing.compute'],
            },
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
    await waitFor(
      () => container.querySelectorAll('[data-testid="task-entry"]').length === 2,
      'two task entries',
    )

    const restricted = await renderWorkbench(built, { grantedCapabilities: ['data.readonly'] })
    await waitFor(
      () => restricted.querySelectorAll('[data-testid="task-entry"]').length === 1,
      'one authorised task',
    )
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
  it('selects actual single-value compute fields, rejects unsupported units and confirms inputs separately from parameters', async () => {
    const accepted: { parameters: Readonly<Record<string, unknown>>; selection?: ProjectComputeInputSelection }[] = []
    const task: ProjectTaskItem = {
      bindingRef: { id: 'registered-compute', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }, taskKind: 'compute', displayName: '汇总每件数量',
      parameterSchema: {}, requiredCapabilities: [], requiredReadiness: ['dataset'], available: true, unavailableReasons: [], requiresInputSelection: true,
      inputRequirements: { maxDecimalPlaces: 4, units: ['each'], currencies: ['CNY'], minimumAmount: '0', description: '这项登记计算支持非负数、最多四位小数；工时暂不可用。', maxRows: 1000 },
      objects: [
        { objectId: 'goods', displayName: '已确认商品', attributes: [
          { attributeId: 'sku', displayName: '商品编号', valueType: 'string', required: true, minCardinality: 1, maxCardinality: 1 },
          { attributeId: 'amount', displayName: '精确数量', valueType: 'number', required: true, minCardinality: 1, maxCardinality: 1 },
          { attributeId: 'hours', displayName: '工时', valueType: 'quantity', unit: 'h', required: true, minCardinality: 1, maxCardinality: 1 },
          { attributeId: 'pieces', displayName: '每件数量', valueType: 'quantity', unit: 'each', required: true, minCardinality: 1, maxCardinality: 1 },
          { attributeId: 'units', displayName: '确认单位', valueType: 'enum', enumValues: ['each'], required: true, minCardinality: 1, maxCardinality: 1 },
          { attributeId: 'multi', displayName: '多个数量', valueType: 'number', required: true, minCardinality: 1, maxCardinality: 'unbounded' },
        ] },
        { objectId: 'logs', displayName: '另一种记录', attributes: [] },
      ],
    }
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); mounted.push({ root, container })
    await act(async () => root.render(createElement(TaskRunForm, { task, objects: [], disabled: false, onRun: (parameters, selection) => { accepted.push({ parameters, ...(selection === undefined ? {} : { selection }) }); return Promise.resolve() } })))
    const input = (key: string) => {
      const element = container.querySelector<HTMLSelectElement>(`[data-testid="compute-input-${key}"]`)
      if (element === null) throw new Error(`input selector missing: ${key}`)
      return element
    }
    expect(container.textContent).toContain('最多四位小数')
    expect(container.textContent).toContain('最多 1000 条记录')
    expect(container.querySelector('textarea')).toBeNull()
    await select(input('objectId'), 'goods')
    expect([...input('amountField').options].map((option) => option.value)).toEqual(['', 'amount', 'pieces'])
    await select(input('idField'), 'sku')
    await select(input('amountField'), 'amount')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-run"]')?.disabled).toBe(true)
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-parameter-preview"]')?.disabled).toBe(true)
    await select(input('unitField'), 'units')
    await click(container.querySelector('[data-testid="task-parameter-preview"]') as Element)
    expect(container.querySelector('[data-testid="task-parameter-diff"]')?.textContent).toContain('汇总数值字段：未选择 → 精确数量')
    await submit(container.querySelector('form') as Element)
    expect(accepted).toEqual([])
    await click(container.querySelector('[data-testid="task-parameter-confirm"]') as Element)
    await submit(container.querySelector('form') as Element)
    expect(accepted).toEqual([{ parameters: {}, selection: { objectId: 'goods', idField: 'sku', amountField: 'amount', unitField: 'units' } }])
    await select(input('objectId'), 'logs')
    expect(input('idField').value).toBe('')
    expect(input('amountField').value).toBe('')
    expect(input('unitField').value).toBe('')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-run"]')?.disabled).toBe(true)
    await submit(container.querySelector('form') as Element)
    expect(accepted).toHaveLength(1)
  })
  it('shows a concrete schema parameter diff and submits only the confirmed values', async () => {
    const accepted: Readonly<Record<string, unknown>>[] = []
    const task: ProjectTaskItem = {
      bindingRef: { id: 'test.exact-quantity', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` },
      taskKind: 'compute',
      displayName: '核对数量',
      parameterSchema: {
        type: 'object',
        properties: { quantity: { type: 'string', title: '数量' } },
        required: ['quantity'],
        additionalProperties: false,
      },
      requiredCapabilities: [],
      requiredReadiness: [],
      available: true,
      unavailableReasons: [],
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted.push({ root, container })
    await act(async () => {
      root.render(
        createElement(TaskRunForm, {
          task,
          objects: [],
          disabled: false,
          onRun: (parameters) => {
            accepted.push(parameters)
            return Promise.resolve()
          },
        }),
      )
    })
    const parameter = container.querySelector<HTMLInputElement>('[data-testid="task-parameter-quantity"]')
    if (parameter === null) throw new Error('schema parameter input missing')
    const exact = '9007199254740993.00000000000000000001'
    await type(parameter, exact)
    expect(container.querySelector('[data-testid="task-parameter-diff"]')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-run"]')?.disabled).toBe(true)
    await click(container.querySelector('[data-testid="task-parameter-preview"]') as Element)
    expect(container.querySelector('[data-testid="task-parameter-diff"]')?.textContent).toContain(
      `数量：未提供 → ${exact}`,
    )
    expect(accepted).toEqual([])
    await click(container.querySelector('[data-testid="task-parameter-confirm"]') as Element)
    expect(container.querySelector('[data-testid="task-parameter-diff"]')).toBeNull()
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-run"]')?.disabled).toBe(false)
    await submit(container.querySelector('[data-testid="task-schema-form"]') as Element)
    expect(accepted).toEqual([{ quantity: exact }])
    await type(parameter, '43')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-run"]')?.disabled).toBe(true)
    await click(container.querySelector('[data-testid="task-parameter-preview"]') as Element)
    expect(container.querySelector('[data-testid="task-parameter-diff"]')?.textContent).toContain(
      `${exact} → 43`,
    )
    expect(accepted).toEqual([{ quantity: exact }])
  })
})

describe('typed results share the same verified version', () => {
  it('keeps a later clicked cell when an earlier source read of the same evidence returns late', async () => {
    const built = await harness()
    const actual = createWorkbenchResultSource(built.harness.client)
    let release: (() => void) | undefined
    let waiting = false
    const source = { ...actual, loadSource: async (...args: Parameters<NonNullable<typeof actual.loadSource>>) => {
      if (actual.loadSource === undefined) throw new Error('source route missing')
      const view = await actual.loadSource(...args)
      if (args[3]?.columnRef === 'name') {
        waiting = true
        await new Promise<void>((resolve) => { release = resolve })
        return { ...view, title: '较早字段的迟到来源' }
      }
      return { ...view, title: '当前容量字段的来源' }
    } }
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); mounted.push({ root, container })
    await act(async () => root.render(createElement(ResultWorkbenchPanel, { source, runId: built.runId, initialTab: 'tables' })))
    await waitFor(() => container.querySelector('[data-testid="result-cell-evidence"]') !== null, 'actual cell actions')
    const row = container.querySelector('[data-testid="result-table-row"]')
    const name = row?.querySelector('[data-testid="result-table-cell-name"] button')
    const capacity = row?.querySelector('[data-testid="result-table-cell-capacity"] button')
    if (name === undefined || name === null || capacity === undefined || capacity === null) throw new Error('cell actions missing')
    await click(name)
    await waitFor(() => waiting, 'earlier source read paused after actual HTTP read')
    await click(container.querySelector('dialog button[aria-label="关闭结果依据"]') as Element)
    await click(capacity)
    await waitFor(() => container.querySelector('[data-testid="result-evidence"]')?.textContent?.includes('当前容量字段的来源') === true, 'later same-evidence cell source')
    await act(async () => release?.())
    expect(container.querySelector('[data-testid="result-evidence"]')?.textContent).toContain('当前容量字段的来源')
    expect(container.textContent).not.toContain('较早字段的迟到来源')
    expect(container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page')).toBe('0')
  })
  it('uses the earned per-table manifest independently of the outer result format and sends the clicked later-page cell selector', async () => {
    const built = await harness()
    const actual = createWorkbenchResultSource(built.harness.client)
    const requested: SavedCellSelector[] = []
    const source = { ...actual,
      loadResult: async (runId: string) => {
        const load = await actual.loadResult(runId)
        if (load.kind !== 'verified') return load
        const outer: ResourceRef = { id: 'outer-result-format-wire', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'artifact' }
        return { ...load, view: { ...load.view, resultManifestRef: outer, resultManifestDigest: outer.digest, tables: load.view.tables.map((table) => table.verificationReceiptRef === undefined ? table : { ...table, tableManifestRef: load.view.resultManifestRef, tableManifestDigest: load.view.resultManifestDigest }) } }
      },
      loadSource: async (...args: Parameters<NonNullable<typeof actual.loadSource>>) => {
        if (args[3] !== undefined) requested.push(args[3])
        if (actual.loadSource === undefined) throw new Error('source route missing')
        return actual.loadSource(...args)
      },
    }
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); mounted.push({ root, container })
    await act(async () => root.render(createElement(ResultWorkbenchPanel, { source, runId: built.runId, initialTab: 'tables' })))
    await waitFor(() => container.querySelector('[data-testid="result-table-row"]') !== null, 'real earned per-table page with distinct outer format')
    expect(container.querySelector('[data-testid="result-table-error"]')).toBeNull()
    await click(container.querySelector('[data-testid="result-table-next"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page') === '1', 'later immutable page')
    const firstRow = container.querySelector('[data-testid="result-table-row"]')
    const capacity = firstRow?.querySelector('[data-testid="result-table-cell-capacity"] [data-testid="result-cell-evidence"]')
    if (capacity === undefined || capacity === null) throw new Error('bound later-page cell source missing')
    await click(capacity)
    await waitFor(() => container.querySelector('[data-testid="result-evidence"]') !== null, 'exact selected source response')
    expect(requested).toEqual([{ tableId: built.verifiedTableId, rowKey: 'r3', columnRef: 'capacity' }])
    expect(container.querySelector('[data-testid="result-evidence"]')?.getAttribute('data-readability')).toBe('missing')
    expect(container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page')).toBe('1')
  })
  it('renders 正文/结果表/依据, pages the table and keeps provenance states apart', async () => {
    const built = await harness()
    const container = await renderResult(built)
    await waitFor(
      () => container.querySelector('[data-testid="result-workbench"] [data-testid="result-body"]') !== null,
      'verified result',
    )

    // 正文: the verified @3 narrative is rendered from its result-bound claims.
    expect(container.querySelector('[data-testid="published-answer-body"]')).not.toBeNull()

    // 结果表: a formal table requires a verification receipt; page 1 then page 2 of the SAME version.
    await click(container.querySelector('[data-testid="result-tab-tables"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="result-table-row"]') !== null, 'table page')
    expect(container.querySelectorAll('[data-testid="result-table-row"]').length).toBe(2)
    expect(container.querySelectorAll('[data-testid="result-cell-evidence"]').length).toBe(4)
    expect(container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page')).toBe('0')

    // 依据: the first row's source is current; a later page's source is missing.
    await click(container.querySelector('[data-testid="result-cell-evidence"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="result-evidence"]') !== null, 'evidence view')
    expect(container.querySelector('[data-testid="result-evidence"]')?.getAttribute('data-readability')).toBe(
      'current',
    )
    expect(container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page')).toBe('0')
    const closeSource = container.querySelector('dialog button[aria-label="关闭结果依据"]')
    if (closeSource === null) throw new Error('source drawer close action missing')
    await click(closeSource)

    await click(container.querySelector('[data-testid="result-tab-tables"]') as Element)
    const next = container.querySelector<HTMLButtonElement>('[data-testid="result-table-next"]')
    if (next === null) throw new Error('next page button missing')
    await click(next)
    await waitFor(
      () => container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page') === '1',
      'second page',
    )
    await click(container.querySelector('[data-testid="result-cell-evidence"]') as Element)
    await waitFor(
      () =>
        container.querySelector('[data-testid="result-evidence"]')?.getAttribute('data-readability') ===
        'missing',
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

  it('does not restore an earlier table page after switching to another real run', async () => {
    const built = await harness()
    const actual = createWorkbenchResultSource(built.harness.client)
    let release: (() => void) | undefined
    let requested = false
    const source = {
      ...actual,
      loadTablePage: async (answerId: string, tableId: string, cursor?: string) => {
        const page = await actual.loadTablePage(answerId, tableId, cursor)
        requested = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return page
      },
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mounted.push({ root, container })
    await act(async () => {
      root.render(createElement(ResultWorkbenchPanel, { source, runId: built.runId, initialTab: 'tables' }))
    })
    await waitFor(() => requested, 'actual first page read')
    const second = await startHarness()
    try {
      const next = await second.client.createRun({
        profileRef: PROFILE,
        question: 'another real run',
        context: { timeZone: 'Asia/Shanghai' },
        preferences: { route: 'auto', allowWeb: false },
      })
      const nextSource = createWorkbenchResultSource(second.client)
      await act(async () => {
        root.render(
          createElement(ResultWorkbenchPanel, {
            source: nextSource,
            runId: next.runId,
            initialTab: 'tables',
          }),
        )
      })
      await waitFor(
        () => container.querySelector('[data-testid="result-in-progress"]') !== null,
        'second run in progress',
      )
      await act(async () => {
        release?.()
      })
      expect(container.querySelectorAll('[data-testid="result-table-row"]').length).toBe(0)
      expect(container.querySelector('[data-testid="result-workbench"]')?.getAttribute('data-run-id')).toBe(
        next.runId,
      )
    } finally {
      await second.app.close()
    }
  })
  it('keeps archived query payload and fixed refs folded while stating the original-cell read limitation', async () => {
    const built = await harness()
    const actual = createWorkbenchResultSource(built.harness.client)
    const load = actual.loadSource
    if (load === undefined) throw new Error('actual fixed source route unavailable')
    const source = { ...actual, loadSource: async (...args: Parameters<typeof load>) => ({ ...await load(...args), sourceReadLimitation: '保存的是该运行的查询结果。', archivedPayload: { internal_snapshot_marker: 'ARCHIVE_PAYLOAD_SENTINEL', lexical_decimal: '9007199254740993.000000000001' }, fixedInputRef: { id: 'wire-input-fixture', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' as const }, fixedDatasetSnapshotRef: { id: 'wire-dataset-fixture', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' as const } }) }
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); mounted.push({ root, container })
    await act(async () => { root.render(createElement(ResultWorkbenchPanel, { source, runId: built.runId, initialTab: 'tables' })) })
    await waitFor(() => container.querySelector('[data-testid="result-cell-evidence"]') !== null, 'actual verified table source action')
    await click(container.querySelector('[data-testid="result-cell-evidence"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="query-source-archive"]') !== null, 'saved query source detail')
    const view = container.querySelector('[data-testid="result-evidence"]')
    expect(view?.textContent).toContain('暂不支持回读原始表格单元格')
    expect(view?.querySelector('blockquote')).toBeNull()
    const archive = view?.querySelector<HTMLDetailsElement>('[data-testid="query-source-archive"]')
    expect(archive?.open).toBe(false)
    expect(archive?.querySelector('pre')?.textContent).toContain('ARCHIVE_PAYLOAD_SENTINEL')
    expect(archive?.textContent).toContain('9007199254740993.000000000001')
    expect(archive?.textContent).toContain('wire-input-fixture')
    expect(container.querySelector('[data-testid="result-table"]')?.getAttribute('data-page')).toBe('0')
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
    await built.harness.runService.recordRuntimeEvent(
      runId,
      clarificationEvent(runId, randomUUID()),
      built.harness.ctx,
    )

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
    await waitFor(
      () => container.querySelector('[data-testid="business-clarification"]') !== null,
      'clarification',
    )

    const input = container.querySelector<HTMLInputElement>('[data-testid="business-clarification-input"]')
    if (input === null) throw new Error('the clarification input is missing')
    await type(input, '选择 A')
    await click(container.querySelector('[data-testid="business-clarification-submit"]') as Element)
    await waitFor(
      () => container.querySelector('[data-testid="business-notice"]') !== null,
      'clarification notice',
    )
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
      () =>
        container.querySelector('[data-testid="business-outcome"]')?.getAttribute('data-outcome') ===
        'cancelled',
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
