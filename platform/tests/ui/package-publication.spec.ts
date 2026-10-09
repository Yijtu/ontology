// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import {
  PackagePublicationPanel,
  coveredCaseKinds,
  expectationSummary,
  publicationBlocked,
} from '@ontology/app-web'
import type {
  IndustryValidationReportView,
  SyntheticExampleSetView,
} from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const VALIDATION_ID = '22222222-2222-4222-8222-222222222222'
const EXAMPLE_SET_ID = '44444444-4444-4444-8444-444444444444'
const PACK_ID = 'demo.bridge-pack'
const PACK_VERSION = '1.0.0'
const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function exampleSet(): SyntheticExampleSetView {
  return {
    exampleSetId: EXAMPLE_SET_ID,
    workspaceId: WORKSPACE_ID,
    sourceKind: 'synthetic',
    dataMode: 'synthetic',
    isolationLabel: 'synthetic test',
    targetDraftRef: { id: WORKSPACE_ID, version: '1', digest: DIGEST },
    caseKinds: ['missing_parameter', 'wrong_unit', 'missing_capability'],
    cases: [
      { caseId: 'case-1', caseKind: 'missing_parameter', objectTypeRef: 'device', fields: [] },
      { caseId: 'case-2', caseKind: 'wrong_unit', objectTypeRef: 'device', fields: [{ fieldId: 'capacity', value: 1, unitCode: 'kg' }] },
      { caseId: 'case-3', caseKind: 'missing_capability', objectTypeRef: 'device', fields: [] },
    ],
    expectations: [
      { expectationId: 'e1', caseId: 'case-1', kind: 'rule', ruleId: 'rule.a', expected: 'unknown', origin: 'expert_confirmed', reason: 'expert' },
    ],
    contentDigest: DIGEST,
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function report(overrides: Partial<IndustryValidationReportView> = {}): IndustryValidationReportView {
  return {
    validationId: VALIDATION_ID,
    workspaceId: WORKSPACE_ID,
    revision: '1',
    exampleSetId: EXAMPLE_SET_ID,
    exampleSetRef: { id: EXAMPLE_SET_ID, version: '1.0.0', digest: DIGEST, kind: 'dataset' },
    dataMode: 'synthetic',
    isolationLabel: 'synthetic test',
    businessApproval: 'none',
    realFactsWritten: false,
    semanticPublished: { passed: true, blockers: [] },
    deploymentExecutable: {
      passed: false,
      blockers: [{ code: 'ACTION_NOT_EXECUTABLE', surface: 'deployment', message: '动作未绑定', actionId: 'action.export' }],
    },
    publishable: false,
    gate: 'blocked_execution',
    issues: [
      { code: 'ACTION_NOT_EXECUTABLE', surface: 'deployment', message: '动作未绑定', actionId: 'action.export' },
    ],
    expectationResults: [
      { expectationId: 'e1', caseId: 'case-1', kind: 'rule', targetId: 'rule.a', expected: 'unknown', actual: 'unknown', matched: true, origin: 'expert_confirmed', independent: true },
      { expectationId: 'e2', caseId: 'case-2', kind: 'rule', targetId: 'rule.a', expected: 'false', actual: 'unknown', matched: false, origin: 'authored_oracle', independent: true },
    ],
    coverage: [
      { caseId: 'case-1', caseKind: 'missing_parameter', ruleIds: ['rule.a'], actionIds: [] },
      { caseId: 'case-2', caseKind: 'wrong_unit', ruleIds: [], actionIds: [] },
    ],
    contentDigest: DIGEST,
    recordedAt: '2026-09-30T00:00:00Z',
    ...overrides,
  }
}

interface MockState {
  packs: Record<string, unknown>[]
  report: IndustryValidationReportView
  published: Record<string, unknown>[]
}

function createFetchImpl(state: MockState): typeof fetch {
  return (input, init) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.endsWith(`/industry-workspaces/${WORKSPACE_ID}`) && method === 'GET') return Promise.resolve(jsonResponse({ data: { workspace: { workspaceId: WORKSPACE_ID, namespace: 'test', displayName: '测试工作区', boundary: { goals: ['独立验核'], included: [], excluded: [], applicability: {} }, headRevision: state.report.revision, state: 'draft' } } }))
    if (url.includes('/synthetic-example-sets') && method === 'GET') {
      return Promise.resolve(jsonResponse({ data: { exampleSets: [exampleSet()] } }))
    }
    if (url.includes('/validations/') && method === 'GET') {
      return Promise.resolve(jsonResponse({ data: { validation: state.report } }))
    }
    if (url.includes('/validations') && method === 'POST') {
      return Promise.resolve(jsonResponse({ data: { validation: state.report } }, 201))
    }
    if (url.includes('/publications') && method === 'POST') {
      const published = {
        packRef: { id: PACK_ID, version: PACK_VERSION, digest: DIGEST_B },
        capabilities: {
          semanticPublished: true,
          deploymentExecutable: false,
          requiredCapabilities: ['pricing.compute'],
          missingCapabilities: ['pricing.compute'],
          actions: [],
        },
      }
      state.packs = [
        { kind: 'registered_pack', namespace: PACK_ID, displayName: '桥架行业包', packRef: published.packRef, maturity: 'stable', maturityLabel: 'validated', usable: true },
      ]
      state.published.push(published)
      return Promise.resolve(
        jsonResponse({
          data: {
            pack: { ...published, revision: '2', publishedAt: '2026-09-30T00:00:00Z' },
            packRef: published.packRef,
            capabilityStatus: published.capabilities,
          },
        }, 201),
      )
    }
    if (url.includes('/export') && method === 'GET') {
      return Promise.resolve(
        jsonResponse({
          data: {
            exportVersion: '1.0.0',
            packRef: { id: PACK_ID, version: PACK_VERSION, digest: DIGEST_B },
            namespace: PACK_ID,
            maturity: 'stable',
            maturityLabel: 'validated',
            usable: true,
            manifest: {},
            identityPolicy: {},
            mappingTemplates: [{}, {}],
            standardProvenance: [],
            testSuite: {},
            capabilityStatus: {
              semanticPublished: true,
              deploymentExecutable: false,
              requiredCapabilities: [],
              missingCapabilities: ['pricing.compute'],
              actions: [],
            },
            versionDiff: {
              toPackRef: { id: PACK_ID, version: PACK_VERSION, digest: DIGEST_B },
              changes: [{ scope: 'action', change: 'ACTION_UNBOUND', logicalId: 'action.export', breaking: false, message: '动作未绑定' }],
              breakingChanges: [],
              digest: DIGEST_B,
            },
            exportedAt: '2026-09-30T00:00:00Z',
            contentDigest: DIGEST_B,
          },
        }),
      )
    }
    if (url.includes('/projects') && method === 'GET') {
      return Promise.resolve(
        jsonResponse({ data: { project: { projectId: '55555555-5555-4555-8555-555555555555', title: '既有项目', headRevision: '1', state: 'draft', createdBy: 'e2e', createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' } } }),
      )
    }
    if (url.includes('/pack-mounts') && method === 'POST') {
      return Promise.resolve(jsonResponse({ data: mountedView() }))
    }
    if (url.endsWith('/projects') && method === 'POST') {
      return Promise.resolve(
        jsonResponse(
          {
            data: {
              project: { projectId: '66666666-6666-4666-8666-666666666666', title: '新项目', headRevision: '1', state: 'draft', createdBy: 'e2e', createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' },
              revision: projectRevision('66666666-6666-4666-8666-666666666666'),
            },
          },
          201,
        ),
      )
    }
    if (url.includes('/industry-packs') && method === 'GET') {
      return Promise.resolve(jsonResponse({ data: { packs: state.packs } }))
    }
    return Promise.resolve(jsonResponse({ error: { code: 'NOT_FOUND', message: `no mock for ${method} ${url}` } }, 404))
  }
}

function projectRevision(projectId: string): Record<string, unknown> {
  return {
    ref: { projectId, revision: '1', digest: DIGEST },
    industryPackRef: { id: PACK_ID, version: PACK_VERSION, digest: DIGEST_B },
    definitionRef: { id: 'definition', version: '1.0.0', digest: DIGEST },
    mappingRefs: [],
    profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: DIGEST },
    documentSetRef: { id: '77777777-7777-4777-8777-777777777777', version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    semanticPublicationRefs: [],
    sourceVisibilityEpoch: '1',
    changeReason: 'create',
  }
}

function mountedView(): Record<string, unknown> {
  return {
    project: { projectId: '55555555-5555-4555-8555-555555555555', title: '既有项目', headRevision: '2', state: 'draft', createdBy: 'e2e', createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z' },
    revision: projectRevision('55555555-5555-4555-8555-555555555555'),
    previousRevision: projectRevision('55555555-5555-4555-8555-555555555555'),
    changes: [],
    readinessInvalidated: [],
    created: true,
  }
}

async function mount(
  state: MockState,
  props: Partial<Parameters<typeof PackagePublicationPanel>[0]> = {},
): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const client = new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: createFetchImpl(state) })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(PackagePublicationPanel, { client, workspaceId: WORKSPACE_ID, ...props }))
  })
  return { container, root }
}

async function unmount(container: HTMLElement, root: ReturnType<typeof createRoot>): Promise<void> {
  await act(async () => root.unmount())
  container.remove()
}

describe('package publication helpers', () => {
  it('separates semantic publication from deployment executability', () => {
    const blocked = report()
    expect(publicationBlocked(blocked, false)).toBe(false)
    expect(publicationBlocked(blocked, true)).toBe(true)
    const semanticFail = report({ semanticPublished: { passed: false, blockers: [] }, publishable: false })
    expect(publicationBlocked(semanticFail, false)).toBe(true)
  })

  it('reports coverage and expectation totals from the report', () => {
    expect(expectationSummary(report().expectationResults)).toEqual({ matched: 1, mismatched: 1, total: 2 })
    expect(coveredCaseKinds(exampleSet(), report()).map((entry) => entry.covered)).toEqual([true, true, false])
  })
})

describe('package publication panel', () => {
  it('shows isolation-marked counter-examples and both validation surfaces from the server', async () => {
    const state: MockState = { packs: [], report: report(), published: [] }
    const { container, root } = await mount(state, { initialValidationId: VALIDATION_ID })
    try {
      expect(container.querySelectorAll('[data-testid="validation-counterexample"]')).toHaveLength(3)
      expect(container.querySelector('[data-testid="validation-counterexample"]')?.getAttribute('data-isolation')).toBe('synthetic test')
      expect(container.querySelector('[data-testid="validation-surface-semantic"]')?.getAttribute('data-passed')).toBe('true')
      expect(container.querySelector('[data-testid="validation-surface-semantic-status"]')?.textContent).toContain('通过')
      expect(container.querySelector('[data-testid="validation-surface-deployment"]')?.getAttribute('data-passed')).toBe('false')
      expect(container.querySelector('[data-testid="validation-blockers-deployment"]')?.textContent).toContain('ACTION_NOT_EXECUTABLE')
      expect(container.querySelector('[data-testid="validation-expectation-summary"]')?.textContent).toContain('1/2')
      expect(container.querySelectorAll('[data-testid="validation-coverage-item"][data-covered="false"]')).toHaveLength(1)
      expect(container.querySelector('[data-testid="validation-expectation"][data-matched="false"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="validation-isolation"]')?.textContent).toContain('synthetic test')
    } finally {
      await unmount(container, root)
    }
  })

  it('runs a synthetic validation against the selected example set and shows the report', async () => {
    const state: MockState = { packs: [], report: report(), published: [] }
    const { container, root } = await mount(state)
    try {
      expect(container.querySelector('[data-testid="validation-report"]')).toBeNull()
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="validation-run"]')?.click()
      })
      expect(container.querySelector('[data-testid="validation-report"]')).not.toBeNull()
      expect(container.querySelector('[data-testid="validation-surface-semantic"]')?.getAttribute('data-passed')).toBe('true')
    } finally {
      await unmount(container, root)
    }
  })

  it('blocks publication of a non-publishable report and allows a deployment-blocked semantic publish when not requiring executability', async () => {
    const state: MockState = { packs: [], report: report(), published: [] }
    const { container, root } = await mount(state, { initialValidationId: VALIDATION_ID })
    try {
      expect(container.querySelector('[data-testid="validation-publishable"]')?.getAttribute('data-publishable')).toBe('false')
      // Default: execution is advisory, so the semantic surface alone lets a publish through.
      const publishButton = container.querySelector<HTMLButtonElement>('[data-testid="asset-publish"]')
      expect(publishButton?.disabled).toBe(false)

      // Requiring executability re-enables the blocker.
      const requireExecutable = container.querySelector<HTMLInputElement>('[data-testid="asset-publish-require-executable"]')
      if (requireExecutable === null) throw new Error('the require-executable checkbox is missing')
      await act(async () => requireExecutable.click())
      expect(container.querySelector<HTMLButtonElement>('[data-testid="asset-publish"]')?.disabled).toBe(true)
      expect(container.querySelector('[data-testid="asset-publish-blocker"]')).not.toBeNull()
    } finally {
      await unmount(container, root)
    }
  })

  it('publishes an immutable pack and reports the two capability surfaces separately', async () => {
    const state: MockState = { packs: [], report: report(), published: [] }
    const { container, root } = await mount(state, { initialValidationId: VALIDATION_ID })
    try {
      const packId = container.querySelector<HTMLInputElement>('[data-testid="asset-publish-pack-id"]')
      if (packId === null) throw new Error('the pack id input is missing')
      await act(async () => setInputValue(packId, PACK_ID))
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="asset-publish"]')?.click()
      })
      expect(container.querySelector('[data-testid="publication-result"]')?.getAttribute('data-pack-ref')).toBe(`${PACK_ID}@${PACK_VERSION}`)
      expect(container.querySelector('[data-testid="publication-semantic-published"]')?.getAttribute('data-published')).toBe('true')
      expect(container.querySelector('[data-testid="publication-deployment-executable"]')?.getAttribute('data-executable')).toBe('false')
      expect(container.querySelector('[data-testid="publication-missing-capability"]')?.textContent).toContain('pricing.compute')
      // The catalogue is refreshed after publish.
      expect(container.querySelectorAll('[data-testid="pack-version"]')).toHaveLength(1)
    } finally {
      await unmount(container, root)
    }
  })

  it('exports an immutable declaration bundle with its digest and version diff', async () => {
    const state: MockState = {
      packs: [{ kind: 'registered_pack', namespace: PACK_ID, displayName: '桥架行业包', packRef: { id: PACK_ID, version: PACK_VERSION, digest: DIGEST_B }, maturity: 'stable', maturityLabel: 'validated', usable: true }],
      report: report(),
      published: [],
    }
    const { container, root } = await mount(state, { initialValidationId: VALIDATION_ID })
    try {
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="pack-export"]')?.click()
      })
      expect(container.querySelector('[data-testid="pack-export-digest"]')?.textContent).toContain(DIGEST_B)
      expect(container.querySelector('[data-testid="pack-export-result"]')?.textContent).toContain('映射模板 2 项')
      expect(container.querySelector('[data-testid="pack-version-diff-summary"]')?.textContent).toContain('变更 1 项')
      expect(container.querySelector('[data-testid="pack-version-diff-change"]')?.getAttribute('data-breaking')).toBe('false')
    } finally {
      await unmount(container, root)
    }
  })

  it('mounts a published pack into a new project', async () => {
    const state: MockState = {
      packs: [{ kind: 'registered_pack', namespace: PACK_ID, displayName: '桥架行业包', packRef: { id: PACK_ID, version: PACK_VERSION, digest: DIGEST_B }, maturity: 'stable', maturityLabel: 'validated', usable: true }],
      report: report(),
      published: [],
    }
    const { container, root } = await mount(state, {
      initialValidationId: VALIDATION_ID,
      mountBinding: {
        profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: DIGEST },
        mappingRefs: [{ id: 'mapping-1', version: '1.0.0', digest: DIGEST, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'demo', sourceId: 'mapping-1' }, objectPath: 'device' } }],
        documentSetRef: { id: '77777777-7777-4777-8777-777777777777', version: '1.0.0', digest: DIGEST, kind: 'artifact' },
      },
    })
    try {
      const title = container.querySelector<HTMLInputElement>('[data-testid="project-mount-title"]')
      if (title === null) throw new Error('the project title input is missing')
      await act(async () => setInputValue(title, '新项目'))
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="project-mount-submit"]')?.click()
      })
      expect(container.querySelector('[data-testid="project-mount-result"]')?.getAttribute('data-project-id')).toBe('66666666-6666-4666-8666-666666666666')
    } finally {
      await unmount(container, root)
    }
  })

  it('names the maintainer action when no project binding is configured', async () => {
    const state: MockState = { packs: [], report: report(), published: [] }
    const { container, root } = await mount(state, { initialValidationId: VALIDATION_ID })
    try {
      expect(container.querySelector('[data-testid="project-mount-blocker"]')?.getAttribute('data-code')).toBe('CAPABILITY_NOT_CONFIGURED')
    } finally {
      await unmount(container, root)
    }
  })

  it('hides publish/export/mount entry points for a read-only principal', async () => {
    const state: MockState = {
      packs: [{ kind: 'registered_pack', namespace: PACK_ID, displayName: '桥架行业包', packRef: { id: PACK_ID, version: PACK_VERSION, digest: DIGEST_B }, maturity: 'stable', maturityLabel: 'validated', usable: true }],
      report: report(),
      published: [],
    }
    const { container, root } = await mount(state, { initialValidationId: VALIDATION_ID, readOnly: true })
    try {
      expect(container.querySelector('[data-testid="asset-publish"]')).toBeNull()
      expect(container.querySelector('[data-testid="validation-run"]')).toBeNull()
      expect(container.querySelector('[data-testid="pack-export"]')).toBeNull()
      expect(container.querySelector('[data-testid="project-mount-submit"]')).toBeNull()
    } finally {
      await unmount(container, root)
    }
  })
})

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value',
  )?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
