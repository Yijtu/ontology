// @vitest-environment jsdom
// N10 project task/result UI units: source evidence axes, task readiness, project model coverage.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProvenanceEvidenceView } from '@ontology/contracts'
import {
  EvidenceSummary,
  ProjectModelCoverage,
  TaskReadinessList,
  sourceReadabilityNotice,
} from '@ontology/app-web'
import type { AnswerSourceView, ProjectTaskItem } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true

const mounted: { root: Root; container: HTMLElement }[] = []

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
})

const DIGEST = `sha256:${'a'.repeat(64)}` as const
const PROJECT = '20000000-0000-4000-8000-000000000001'

async function render(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(element)
  })
  mounted.push({ root, container })
  return container
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  if (!check()) throw new Error(`timed out waiting for ${label}`)
}

function evidence(overrides: Partial<ProvenanceEvidenceView> = {}): ProvenanceEvidenceView {
  return {
    evidenceId: '30000000-0000-4000-8000-000000000001',
    outcome: 'verifiable',
    kind: 'rule_derivation',
    dataMode: 'observed',
    scopeRef: { tenantId: 'tenant-1', spaceId: 'space-1' },
    producedBy: { componentRef: { id: 'component.provenance', version: '1.0.0', digest: DIGEST } },
    observedAt: '2026-10-15T00:00:00Z',
    recordedAt: '2026-10-15T00:01:00Z',
    revision: '1',
    resultDigest: DIGEST,
    integrityVerified: true,
    ruleRefs: [],
    supportResolution: { state: 'resolved', complete: true },
    factSupport: { complete: true },
    premiseGroups: [{ groupId: 'g1', alternativeEvidenceIds: ['30000000-0000-4000-8000-0000000000a1'] }],
    sources: [],
    originalSourceReReadable: true,
    dependencies: [],
    ...overrides,
  }
}

function answerSource(overrides: Partial<AnswerSourceView> = {}): AnswerSourceView {
  return {
    answerId: '40000000-0000-4000-8000-000000000001',
    evidenceId: '30000000-0000-4000-8000-000000000001',
    answerRef: { id: '40000000-0000-4000-8000-000000000001', version: '1.0.0', digest: DIGEST },
    evidenceRef: { id: '30000000-0000-4000-8000-000000000001', version: '1.0.0', digest: DIGEST, kind: 'evidence' },
    family: 'document_span',
    precision: 'exact',
    readability: 're_readable',
    title: '设备台账原文',
    dataMode: 'observed',
    originalRef: { id: 'doc-1', version: '1.0.0', digest: DIGEST, kind: 'document' },
    parseRef: { id: 'parse-1', version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    locator: {
      kind: 'table_cell',
      format: 'xlsx',
      recordIndex: 1,
      row: 3,
      column: 2,
      normalizationMapRef: 'map-1',
    },
    ...overrides,
  }
}

describe('EvidenceSummary source axes (N10)', () => {
  it('keeps fact and policy axes and discloses the missing source-category tier without inventing one', async () => {
    const container = await render(createElement(EvidenceSummary, { evidence: evidence() }))
    expect(container.querySelector('[data-testid="evidence-fact-axis"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="evidence-policy-axis"]')).not.toBeNull()
    const category = container.querySelector('[data-testid="evidence-source-category"]')
    expect(category).not.toBeNull()
    expect(category?.textContent ?? '').toContain('服务端未提供四级来源类别')
    // A missing tier must not be presented as an answer confidence.
    expect(container.textContent ?? '').toContain('不是「答案可信度」')
  })

  it('adds source type, reviewed versions and a current-invalidation notice from the source view', async () => {
    const container = await render(
      createElement(EvidenceSummary, {
        evidence: evidence(),
        source: answerSource({ readability: 'archived_snapshot_only' }),
      }),
    )
    const family = container.querySelector('[data-testid="evidence-source-family"]')
    expect(family?.getAttribute('data-family')).toBe('document_span')
    expect(family?.textContent ?? '').toContain('精确定位')
    const readability = container.querySelector('[data-testid="evidence-source-readability"]')
    expect(readability?.getAttribute('data-readability')).toBe('archived_snapshot_only')
    expect(readability?.textContent ?? '').toContain('当前失效提示')
    const reviewed = container.querySelector('[data-testid="evidence-source-reviewed-version"]')
    expect(reviewed?.textContent ?? '').toContain('doc-1@1.0.0')
    expect(reviewed?.textContent ?? '').toContain('parse-1@1.0.0')
  })

  it('adds the reviewed document version and parser version to the policy span details', async () => {
    const container = await render(
      createElement(EvidenceSummary, {
        evidence: evidence({
          specification: {
            coverage: { complete: true },
            spans: [
              {
                span: {
                  kind: 'structured',
                  parseId: '50000000-0000-4000-8000-000000000001',
                  recordId: '50000000-0000-4000-8000-000000000002',
                  sourceRowKey: 'row-1',
                  rowDigest: DIGEST,
                  locator: {
                    kind: 'table_cell',
                    format: 'xlsx',
                    recordIndex: 1,
                    row: 1,
                    column: 1,
                    normalizationMapRef: 'map-1',
                  },
                },
                documentRef: { id: 'doc-1', version: '1.0.0', digest: DIGEST, kind: 'document' },
                documentVersionRef: { id: 'doc-1', version: '1.0.0', digest: DIGEST, kind: 'document' },
                parserVersion: '2.3.1',
                evidenceRef: { id: '60000000-0000-4000-8000-000000000001', version: '1.0.0', digest: DIGEST, kind: 'evidence' },
              },
            ],
          },
        }),
      }),
    )
    expect(container.querySelector('[data-testid="evidence-policy-document-version"]')?.textContent ?? '').toContain('doc-1@1.0.0')
    expect(container.querySelector('[data-testid="evidence-policy-parser-version"]')?.textContent ?? '').toContain('2.3.1')
  })

  it('maps source readability to an invalidation notice, never a confidence', () => {
    expect(sourceReadabilityNotice('re_readable')).toContain('可重读')
    expect(sourceReadabilityNotice('archived_snapshot_only')).toContain('不能证明原始来源当前仍有效')
    expect(sourceReadabilityNotice('unverifiable')).toContain('已失效')
  })
})

describe('TaskReadinessList (N10)', () => {
  function task(overrides: Partial<ProjectTaskItem> = {}): ProjectTaskItem {
    return {
      bindingRef: { id: 'task.device-status', version: '1', digest: DIGEST },
      taskKind: 'published_facts',
      displayName: '设备状态查询',
      parameterSchema: {},
      requiredCapabilities: [],
      requiredReadiness: ['published_semantics'],
      available: true,
      unavailableReasons: [],
      ...overrides,
    }
  }

  it('shows each task readiness and its blockers, and only enables the available task', async () => {
    const used: string[] = []
    const container = await render(
      createElement(TaskReadinessList, {
        tasks: [
          task(),
          task({
            bindingRef: { id: 'task.doc-qa', version: '1', digest: DIGEST },
            displayName: '文档问答',
            taskKind: 'document_qa',
            requiredReadiness: ['document_index'],
            available: false,
            unavailableReasons: ['文档索引尚未构建'],
          }),
        ],
        readOnly: false,
        onUse: (selected) => used.push(selected.bindingRef.id),
      }),
    )
    const items = container.querySelectorAll('[data-testid="query-task-readiness-item"]')
    expect(items).toHaveLength(2)
    expect(items[0]?.getAttribute('data-available')).toBe('true')
    expect(items[1]?.getAttribute('data-available')).toBe('false')
    expect(items[1]?.querySelector('[data-testid="query-task-blockers"]')?.textContent ?? '').toContain('文档索引尚未构建')
    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-testid="query-task-use"]')
    expect(buttons[0]?.disabled).toBe(false)
    expect(buttons[1]?.disabled).toBe(true)
    await act(async () => {
      buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(used).toEqual(['task.device-status'])
  })
})

describe('ProjectModelCoverage (N10)', () => {
  function selectionBody(): unknown {
    return [
      {
        schemaVersion: 'effective-model-selection@1',
        scope: { kind: 'project', projectId: PROJECT },
        capability: 'generation',
        selection: { kind: 'connection', connectionId: '70000000-0000-4000-8000-000000000001' },
        resolvedFrom: 'object_default',
        state: 'available',
        connectionId: '70000000-0000-4000-8000-000000000001',
        connectionSummary: {
          connectionId: '70000000-0000-4000-8000-000000000001',
          name: '项目专属生成模型',
          revision: '2',
          adapterType: 'company_generation',
          protocol: 'openai_compatible',
          capabilities: ['generation'],
          enabled: true,
          credentialState: 'present',
          updatedAt: '2026-10-15T00:00:00Z',
        },
        assignmentRevision: '5',
        resolvedAt: '2026-10-15T00:00:00Z',
      },
    ]
  }

  it('resolves the project scope and never the pack author workspace', async () => {
    const urls: string[] = []
    const fetchImpl: typeof fetch = (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      urls.push(url)
      return Promise.resolve(
        new Response(JSON.stringify({ data: selectionBody() }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    const client = new WorkbenchClient({ baseUrl: '', fetchImpl })
    const container = await render(createElement(ProjectModelCoverage, { client, projectId: PROJECT }))
    await waitFor(() => container.querySelector('[data-testid="effective-model-name"]') !== null, 'effective model')
    expect(urls.every((url) => url.includes(`scope=project%3A${PROJECT}`))).toBe(true)
    expect(urls.some((url) => url.includes('workspace'))).toBe(false)
    expect(container.querySelector('[data-testid="effective-model-name"]')?.textContent).toBe('项目专属生成模型')
  })

  it('shows no model names when the account is not allowed to read them', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'not allowed' } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      )
    const client = new WorkbenchClient({ baseUrl: '', fetchImpl })
    const container = await render(createElement(ProjectModelCoverage, { client, projectId: PROJECT }))
    await waitFor(() => container.querySelector('[data-testid="project-model-forbidden"]') !== null, 'forbidden')
    expect(container.querySelector('[data-testid="effective-model-name"]')).toBeNull()
  })
})
