// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { EvidencePanel } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import {
  AUTHORIZED_SOURCE_LOCATOR,
  COT_SENTINEL,
  EVIDENCE_ID,
  FORBIDDEN_EVIDENCE_ID,
  FORBIDDEN_OBJECT_ID,
  HISTORY_OBJECT_ID,
  OTHER_TENANT_TEXT,
  SECRET_SENTINEL,
  createProvenanceHost,
} from './provenance-fixtures'
import type { ProvenanceFixtureOptions, ProvenanceHost } from './provenance-fixtures'
import { startHarness } from './workbench-fixtures'
import type { Harness } from './workbench-fixtures'

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { root: Root; container: HTMLElement }[] = []
const openHarnesses: Harness[] = []

async function renderEvidence(
  client: WorkbenchClient,
  initialEvidenceId?: string,
  initialObjectId?: string,
): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(EvidencePanel, {
        client,
        ...(initialEvidenceId === undefined ? {} : { initialEvidenceId }),
        ...(initialObjectId === undefined ? {} : { initialObjectId }),
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
    const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
    descriptor?.set?.call(element, value)
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function setInnerWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function provenanceHarness(options: ProvenanceFixtureOptions = {}): Promise<{ built: Harness; host: ProvenanceHost }> {
  const host = createProvenanceHost(options)
  const built = await startHarness({ provenance: { evidence: host.evidence, history: host.history } })
  openHarnesses.push(built)
  return { built, host }
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

describe('evidence/history UI states (real routes over HTTP)', () => {
  it('renders the loading state before the fixture answers', async () => {
    const pending = new Promise<Response>(() => undefined)
    const client = new WorkbenchClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: () => pending })
    const container = await renderEvidence(client, EVIDENCE_ID)
    expect(container.querySelector('[data-state="loading"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="evidence-panel"]')?.getAttribute('data-phase')).toBe('loading')
  })

  it('renders an explicit empty/awaiting-input state before any request', async () => {
    const { built } = await provenanceHarness()
    const container = await renderEvidence(built.client)
    await waitFor(() => container.querySelector('[data-state="empty"]') !== null, 'empty state')
    expect(container.querySelector('[data-testid="evidence-prompt"]')).not.toBeNull()
  })

  it('renders a failure state when the API is unreachable', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://127.0.0.1:1',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed')),
    })
    const container = await renderEvidence(client, EVIDENCE_ID)
    await waitFor(() => container.querySelector('[data-state="failure"]') !== null, 'failure state')
    expect(container.querySelector('[data-testid="state-error-code"]')?.textContent).toContain('NETWORK_ERROR')
  })

  it('renders a not-configured state for CAPABILITY_NOT_CONFIGURED', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(409, {
            error: {
              code: 'CAPABILITY_NOT_CONFIGURED',
              message: 'the evidence surface is not wired on this deployment',
              retryable: false,
            },
            traceId: 'trace-409',
          }),
        ),
    })
    const container = await renderEvidence(client, EVIDENCE_ID)
    await waitFor(() => container.querySelector('[data-state="not_configured"]') !== null, 'not configured')
    expect(container.querySelector('[data-testid="state-error-code"]')?.textContent).toContain(
      'CAPABILITY_NOT_CONFIGURED',
    )
  })
})

describe('expand a conclusion to its real basis', () => {
  it('shows the rule, premise groups, source locators and re-readability, and no fabricated reasoning', async () => {
    const { built } = await provenanceHarness()
    const container = await renderEvidence(built.client, EVIDENCE_ID)
    await waitFor(() => container.querySelector('[data-testid="evidence-basis"]') !== null, 'basis')

    expect(container.querySelector('[data-testid="basis-kind"]')?.textContent).toContain('rule_derivation')
    expect(container.querySelector('[data-testid="rule-refs"]')?.textContent).toContain('rule.battery-ready')
    expect(container.querySelectorAll('[data-testid="premise-group"]').length).toBe(2)
    expect(container.querySelector('[data-testid="premise-alternatives"]')?.textContent).toContain('另有等价依据')

    const locators = [...container.querySelectorAll('[data-testid="source-locator"]')].map((node) => node.textContent)
    expect(locators.some((text) => text?.includes(AUTHORIZED_SOURCE_LOCATOR))).toBe(true)
    expect(locators.some((text) => text?.includes('document://battery-manual.pdf'))).toBe(true)
    const rereadability = [...container.querySelectorAll('[data-testid="source-rereadability"]')].map(
      (node) => node.textContent,
    )
    expect(rereadability.some((text) => text?.includes('原来源可重读'))).toBe(true)
    expect(rereadability.some((text) => text?.includes('仅归档快照'))).toBe(true)
    expect(container.querySelector('[data-testid="archived-result"]')?.getAttribute('data-verified')).toBe('true')
    const sourceSummary = container.querySelector('[data-testid="original-source-rereadable"]')
    expect(sourceSummary?.getAttribute('data-rereadable')).toBe('true')
    expect(sourceSummary?.textContent).toContain('所有已列来源证据均可复核（含归档快照）')
    expect(sourceSummary?.textContent).not.toContain('原来源整体可重读')

    // The UI renders only the real server fields: a fabricated chain-of-thought, a resolved
    // secret and another tenant's text that the (misbehaving) fixture attached are never shown.
    const html = container.innerHTML
    expect(html).not.toContain(COT_SENTINEL)
    expect(html).not.toContain(SECRET_SENTINEL)
    expect(html).not.toContain(OTHER_TENANT_TEXT)
    expect(container.querySelector('[data-testid="model-reasoning"]')).toBeNull()
    expect(container.querySelector('[data-testid="chain-of-thought"]')).toBeNull()
  })

  it('shows unresolved rule-support coverage separately from a verifiable evidence artifact', async () => {
    const { built } = await provenanceHarness({
      evidenceSupportResolution: {
        state: 'ambiguous',
        complete: false,
        reason: 'two entity instances match this rule and time',
      },
      graphSupportResolution: {
        state: 'unknown',
        complete: false,
        reason: 'the immutable child support slice is unavailable',
      },
    })
    const container = await renderEvidence(built.client, EVIDENCE_ID)
    await waitFor(() => container.querySelector('[data-testid="evidence-basis"]') !== null, 'basis')

    expect(container.querySelector('[data-testid="basis-outcome"]')?.textContent).toBe('verifiable')
    const status = container.querySelector('[data-testid="support-resolution"]')
    expect(status?.getAttribute('data-state')).toBe('ambiguous')
    expect(status?.getAttribute('data-complete')).toBe('false')
    expect(container.querySelector('[data-testid="support-resolution-reason"]')?.textContent)
      .toContain('two entity instances')

    await click(container.querySelector('[data-testid="load-graph"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="graph-support-coverage"]') !== null, 'graph support coverage')
    expect(container.querySelector('[data-testid="graph-support-coverage"]')?.getAttribute('data-complete')).toBe('false')
    expect(container.querySelector('[data-testid="graph-support-completeness"]')?.textContent)
      .toContain('不能据此判断不存在其他依据')
    expect(container.querySelector('[data-testid="graph-support-resolution"]')?.getAttribute('data-state')).toBe('unknown')
  })

  it('marks the view as an explicit historical replay when asOf/validAt are set', async () => {
    const { built } = await provenanceHarness()
    const container = await renderEvidence(built.client, EVIDENCE_ID)
    await waitFor(() => container.querySelector('[data-testid="evidence-basis"]') !== null, 'basis')
    expect(container.querySelector('[data-testid="evidence-scope"]')?.getAttribute('data-historical')).toBe('false')

    const asOf = container.querySelector<HTMLInputElement>('[data-testid="evidence-asof-input"]')
    if (asOf === null) throw new Error('the asOf field is missing')
    await type(asOf, '2026-09-21T06:00:00Z')
    await click(container.querySelector('[data-testid="load-evidence"]') as Element)
    await waitFor(
      () => container.querySelector('[data-testid="evidence-scope"]')?.getAttribute('data-historical') === 'true',
      'historical view',
    )
    expect(container.querySelector('[data-testid="evidence-scope"]')?.textContent).toContain('历史视图')
  })
})

describe('a large dependency graph pages on demand and marks truncation', () => {
  it('shows the truncation flag and the next cursor, then completes the traversal', async () => {
    const { built } = await provenanceHarness()
    const container = await renderEvidence(built.client, EVIDENCE_ID)
    await waitFor(() => container.querySelector('[data-testid="evidence-basis"]') !== null, 'basis')

    const direction = container.querySelector<HTMLSelectElement>('[data-testid="graph-direction"]')
    if (direction === null) throw new Error('the direction control is missing')
    await select(direction, 'inbound')
    const depth = container.querySelector<HTMLInputElement>('[data-testid="graph-depth"]')
    if (depth === null) throw new Error('the depth control is missing')
    await type(depth, '2')

    await click(container.querySelector('[data-testid="load-graph"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="graph-truncated"]') !== null, 'truncation flag')
    expect(container.querySelector('[data-testid="graph-complete"]')).toBeNull()
    expect(container.querySelector('[data-testid="load-more-graph"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="graph-meta"]')?.textContent).toContain('inbound')
    expect(container.querySelector('[data-testid="graph-meta"]')?.textContent).toContain('深度 2')
    expect(container.querySelector('[data-testid="graph-nodes"]')?.getAttribute('data-count')).toBe('1')

    await click(container.querySelector('[data-testid="load-more-graph"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="graph-complete"]') !== null, 'complete graph')
    expect(container.querySelector('[data-testid="graph-truncated"]')).toBeNull()
    expect(container.querySelector('[data-testid="graph-nodes"]')?.getAttribute('data-count')).toBe('4')
    expect(container.querySelector('[data-testid="graph-meta"]')?.textContent).toContain('已加载 2 页')
  })
})

describe('permission failure shows nothing sensitive', () => {
  it('clears the previously loaded original text and shows a permission-denied state', async () => {
    const { built } = await provenanceHarness()
    const container = await renderEvidence(built.client, EVIDENCE_ID)
    await waitFor(() => container.querySelector('[data-testid="evidence-basis"]') !== null, 'basis')
    expect(container.innerHTML).toContain(AUTHORIZED_SOURCE_LOCATOR)

    const input = container.querySelector<HTMLInputElement>('[data-testid="evidence-id-input"]')
    if (input === null) throw new Error('the evidence id field is missing')
    await type(input, FORBIDDEN_EVIDENCE_ID)
    await click(container.querySelector('[data-testid="load-evidence"]') as Element)

    await waitFor(
      () => container.querySelector('[data-state="permission_denied"]') !== null,
      'permission denied',
    )
    const html = container.innerHTML
    expect(html).not.toContain(AUTHORIZED_SOURCE_LOCATOR)
    expect(html).not.toContain(OTHER_TENANT_TEXT)
    expect(html).not.toContain(SECRET_SENTINEL)
    expect(container.querySelector('[data-testid="evidence-basis"]')).toBeNull()
  })

  it('shows a permission-denied state for a forbidden object history read', async () => {
    const { built } = await provenanceHarness()
    const container = await renderEvidence(built.client, undefined, FORBIDDEN_OBJECT_ID)
    await waitFor(
      () => container.querySelector('[data-state="permission_denied"]') !== null,
      'permission denied',
    )
    expect(container.innerHTML).not.toContain(OTHER_TENANT_TEXT)
  })
})

describe('a version change clears the comparison but keeps the history', () => {
  it('clears the stale comparison and still shows every version', async () => {
    const { built, host } = await provenanceHarness()
    const container = await renderEvidence(built.client, undefined, HISTORY_OBJECT_ID)
    await waitFor(() => container.querySelector('[data-testid="history-assertions"]') !== null, 'history')

    const base = container.querySelector<HTMLInputElement>('[data-testid="base-version-input"]')
    const compare = container.querySelector<HTMLInputElement>('[data-testid="compare-version-input"]')
    if (base === null || compare === null) throw new Error('the comparison fields are missing')
    await type(base, '1')
    await type(compare, '1')
    await click(container.querySelector('[data-testid="compare-versions"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="history-comparison"]') !== null, 'comparison')
    expect(container.querySelector('[data-testid="comparison-identical"]')).not.toBeNull()

    // A new version is published, then the operator refreshes history.
    host.advanceHistory()
    await click(container.querySelector('[data-testid="load-history"]') as Element)
    await waitFor(
      () => container.querySelector('[data-testid="history-assertions"]')?.getAttribute('data-count') === '2',
      'the refreshed history',
    )
    expect(container.querySelector('[data-testid="history-comparison"]')).toBeNull()
    expect(container.querySelector('[data-testid="evidence-notice"]')?.textContent).toContain('版本变化')
    // The history itself remains readable.
    expect(container.querySelectorAll('[data-testid="history-assertion"]').length).toBe(2)

    // A comparison across the two versions still works after the refresh.
    await type(base, '1')
    await type(compare, '2')
    await click(container.querySelector('[data-testid="compare-versions"]') as Element)
    await waitFor(() => container.querySelector('[data-testid="history-comparison"]') !== null, 'comparison again')
    const changes = [...container.querySelectorAll('[data-testid="comparison-change"]')].map((node) =>
      node.getAttribute('data-field'),
    )
    expect(changes).toContain('status')
    expect(changes).toContain('revisionKind')
  })
})

describe('responsive and secret hygiene', () => {
  it('renders the narrow viewport distinctly', async () => {
    setInnerWidth(390)
    const { built } = await provenanceHarness()
    const container = await renderEvidence(built.client)
    await waitFor(() => container.querySelector('[data-state="empty"]') !== null, 'empty state')
    expect(container.querySelector('[data-testid="evidence-panel"]')?.getAttribute('data-viewport')).toBe('narrow')
    setInnerWidth(1280)
  })

  it('never renders a resolved secret value in the HTML', async () => {
    const { built } = await provenanceHarness()
    const container = await renderEvidence(built.client, EVIDENCE_ID)
    await waitFor(() => container.querySelector('[data-testid="evidence-basis"]') !== null, 'basis')
    expect(container.innerHTML).not.toContain(SECRET_SENTINEL)
  })
})
