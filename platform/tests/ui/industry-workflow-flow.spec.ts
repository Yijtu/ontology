// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import {
  DefinitionWorkbenchPanel,
  IndustryWorkflowGuide,
  deriveIndustryWorkflow,
} from '@ontology/app-web'
import type { IndustryWorkflowTarget } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { EffectiveModelSelection } from '../../apps/web/src/api/model-connections'

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
environment.IS_REACT_ACT_ENVIRONMENT = true

const W = '11111111-1111-4111-8111-111111111111'
const S = '22222222-2222-4222-8222-222222222222'
const P = '66666666-6666-4666-8666-666666666666'
const GEN_ID = '33333333-3333-4333-8333-333333333333'
const RESEARCH_ID = '44444444-4444-4444-8444-444444444444'
const digest = `sha256:${'a'.repeat(64)}`

const workspace = { workspaceId: W, namespace: 'test', displayName: '行业工作区', boundary: { goals: ['目标'], included: [], excluded: [], applicability: {} }, state: 'draft', headRevision: '1' }
const draft = { workspaceId: W, revision: '1', digest, documentSetRef: { id: P, version: '1.0.0', digest, kind: 'artifact' }, candidateRefs: [] }
const corpusSource = (id: string, name: string) => ({
  sourceRef: { id, version: '1.0.0', digest, kind: 'document' }, name, kind: 'document', parseId: P, parserVersion: '1.0.0', status: 'complete', previewCoverage: 'complete',
  coverage: { status: 'complete', completeness: 'complete', totalUnits: 0, parsedUnits: 0, skippedUnits: 0, skippedReasons: [], notes: [] },
})
const candidateSource = (sourceId: string, reviewState: string) => ({
  schemaVersion: 'candidate-source@1', sourceId, workspaceId: W, kind: 'web_fetch', trustTier: 'agent_researched',
  origin: { url: `https://example.test/${sourceId}` }, contentRef: { id: sourceId, version: '1.0.0', digest, kind: 'document' }, contentDigest: digest,
  reviewState, proposedBy: 'researcher', title: '待确认网页归档', recordedAt: '2026-10-01T00:00:00Z', revision: '1',
})
const effectiveGeneration = (state: EffectiveModelSelection['state']): EffectiveModelSelection => ({
  schemaVersion: 'effective-model-selection@1', scope: { kind: 'industry_workspace', workspaceId: W }, capability: 'generation',
  selection: state === 'unconfigured' ? { kind: 'inherit' } : { kind: 'connection', connectionId: GEN_ID }, resolvedFrom: 'unconfigured', state,
  ...(state === 'available' ? {
    connectionId: GEN_ID,
    connectionSummary: { connectionId: GEN_ID, name: '主生成模型', revision: '1', adapterType: 'company_generation', protocol: 'openai_compatible', capabilities: ['generation'], enabled: true, credentialState: 'present', updatedAt: '2026-01-02T00:00:00.000Z' },
  } : {}),
  resolvedAt: '2026-01-02T00:00:00.000Z',
})
const effectiveResearchBlocked: EffectiveModelSelection = {
  schemaVersion: 'effective-model-selection@1', scope: { kind: 'industry_workspace', workspaceId: W }, capability: 'research',
  selection: { kind: 'connection', connectionId: RESEARCH_ID }, resolvedFrom: 'space_capability', state: 'blocked', connectionId: RESEARCH_ID,
  blockedReason: 'CREDENTIAL_MISSING', resolvedAt: '2026-01-02T00:00:00.000Z',
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } })

type Call = { readonly method: string; readonly path: string }

function client(handler: (call: Call) => Response): WorkbenchClient {
  return new WorkbenchClient({
    baseUrl: 'http://industry-flow.test',
    fetchImpl: (input, init) => Promise.resolve(handler({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname })),
  })
}

describe('industry workflow derivation (N09)', () => {
  it('maps real counts to the six steps and points 验证/发布 at their own panel without inventing a result', () => {
    const steps = deriveIndustryWorkflow({
      corpusSourceCount: 0, pendingSourceReviewCount: 0, approvedNotAdmittedCount: 0,
      definitionCandidateCount: 0, ruleActionCandidateCount: 0, pendingSourceConfirmationCount: 0, selections: [],
    })
    expect(steps.map((step) => step.id)).toEqual(['sources', 'generate', 'edit', 'review', 'validate', 'publish'])
    expect(steps[0]?.status).toBe('pending')
    expect(steps[1]?.status).toBe('pending')
    const validate = steps.find((step) => step.id === 'validate')
    const publish = steps.find((step) => step.id === 'publish')
    expect(validate?.target.stage).toBe('publish')
    expect(publish?.target.stage).toBe('publish')
    expect(validate?.detail).toContain('不预判')
  })

  it('jumps to the specific pending source and shows the blocked research model reason', () => {
    const steps = deriveIndustryWorkflow({
      corpusSourceCount: 2, pendingSourceReviewCount: 1, approvedNotAdmittedCount: 0, firstPendingSourceId: S,
      definitionCandidateCount: 0, ruleActionCandidateCount: 0, pendingSourceConfirmationCount: 0, selections: [effectiveResearchBlocked],
    })
    const sources = steps[0]
    expect(sources?.status).toBe('attention')
    expect(sources?.target).toEqual({ stage: 'sources', sourceId: S })
    expect(sources?.manual).toContain('凭据缺失')
  })

  it('keeps a manual path when the generation model is unconfigured, without blocking', () => {
    const steps = deriveIndustryWorkflow({
      corpusSourceCount: 1, pendingSourceReviewCount: 0, approvedNotAdmittedCount: 0,
      definitionCandidateCount: 0, ruleActionCandidateCount: 0, pendingSourceConfirmationCount: 0, selections: [effectiveGeneration('unconfigured')],
    })
    const generate = steps[1]
    expect(generate?.manual).toContain('仍可手动编辑')
    expect(generate?.target.stage).toBe('review')
  })

  it('marks review as attention and targets the exact candidate when sources are unconfirmed', () => {
    const steps = deriveIndustryWorkflow({
      corpusSourceCount: 1, pendingSourceReviewCount: 0, approvedNotAdmittedCount: 0,
      definitionCandidateCount: 3, ruleActionCandidateCount: 0, pendingSourceConfirmationCount: 2,
      firstPendingCandidateId: 'cand-2', firstCandidateId: 'cand-1', selections: [],
    })
    const review = steps[3]
    expect(review?.status).toBe('attention')
    expect(review?.target).toEqual({ stage: 'review', candidateId: 'cand-2' })
    expect(steps[2]?.target).toEqual({ stage: 'review', candidateId: 'cand-1' })
  })
})

async function render(node: ReturnType<typeof createElement>): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return { container, root }
}

describe('industry workflow guide (N09)', () => {
  it('threads real source and model data into the flow and jumps to the specific items', async () => {
    const calls: IndustryWorkflowTarget[] = []
    const fake = client(({ path }) => {
      if (path === '/api/v1/core/workspaces/' + W + '/sources') return json({ workspace, draft, sources: [corpusSource(S, '原始台账'), corpusSource(P, '上传的旧资料')] })
      if (path === `/api/v1/industry-workspaces/${W}/sources`) return json({ sources: [candidateSource(S, 'proposed')] })
      if (path === `/api/v1/industry-workspaces/${W}/candidates`) return json({ candidates: [] })
      if (path === `/api/v1/industry-workspaces/${W}/rule-action-candidates`) return json({ candidates: [] })
      if (path === '/api/v1/core/ai/effective-models') return json([effectiveGeneration('unconfigured'), effectiveResearchBlocked])
      return json({}, 404)
    })
    const { container, root } = await render(createElement(IndustryWorkflowGuide, { client: fake, workspaceId: W, onOpenStage: (target: IndustryWorkflowTarget) => calls.push(target) }))
    try {
      const steps = container.querySelectorAll('[data-testid="industry-workflow-step"]')
      expect(steps).toHaveLength(6)
      const sourceStep = container.querySelector('[data-testid="industry-workflow-step"][data-step="sources"]')
      expect(sourceStep?.getAttribute('data-status')).toBe('attention')
      expect(container.querySelector('[data-testid="industry-workflow-target-sources"]')?.getAttribute('data-target-source-id')).toBe(S)
      const generateStep = container.querySelector('[data-testid="industry-workflow-step"][data-step="generate"]')
      expect(generateStep?.getAttribute('data-model-state')).toBe('unconfigured')
      expect(container.querySelector('[data-testid="industry-workflow-manual-generate"]')?.textContent).toContain('仍可手动编辑')
      expect(container.querySelector('[data-testid="industry-workflow-manual-sources"]')?.textContent).toContain('凭据缺失')
      expect(container.querySelectorAll('[data-testid="effective-model"]').length).toBe(2)

      await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="industry-workflow-step-sources"]')?.click() })
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="industry-workflow-step-generate"]')?.click() })
      expect(calls).toEqual([{ stage: 'sources', sourceId: S }, { stage: 'review' }])
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('shows a readable reason and never crashes when no data and no models are available', async () => {
    const fake = client(({ path }) => {
      if (path === '/api/v1/core/workspaces/' + W + '/sources') return json({ workspace, draft, sources: [] })
      if (path === `/api/v1/industry-workspaces/${W}/sources`) return json({ sources: [] })
      if (path.endsWith('/candidates')) return json({ candidates: [] })
      if (path === '/api/v1/core/ai/effective-models') return json({ error: { code: 'FORBIDDEN', message: 'nope' } }, 403)
      return json({}, 404)
    })
    const { container, root } = await render(createElement(IndustryWorkflowGuide, { client: fake, workspaceId: W, onOpenStage: () => undefined }))
    try {
      expect(container.querySelector('[data-testid="industry-workflow"]')?.getAttribute('data-phase')).toBe('ready')
      expect(container.querySelector('[data-testid="industry-workflow-step"][data-step="sources"]')?.getAttribute('data-status')).toBe('pending')
      expect(container.querySelector('[data-testid="industry-workflow-step"][data-step="generate"]')?.getAttribute('data-model-state')).toBe('unreadable')
      expect(container.querySelector('[data-testid="industry-workflow-model-note"]')?.textContent).toContain('人工处理路径不受影响')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})

const OBJECT_CANDIDATE_ID = '00000000-0000-4000-8000-000000000001'
const ATTRIBUTE_CANDIDATE_ID = '00000000-0000-4000-8000-000000000002'

function definitionCandidate(candidateId: string, name: string): Record<string, unknown> {
  return {
    candidateId, batchId: '00000000-0000-4000-8000-000000000020', workspaceId: W, logicalId: name, domain: 'definition', kind: 'object',
    payload: { kind: 'object', logicalId: name, displayName: name, businessMeaning: `${name} 的业务含义`, suggestedReason: '资料中出现', conflicts: [], identityAttributeIds: [] },
    inputDraftRef: { workspaceId: W, revision: '1', digest }, sourceRefs: [], sourceSpans: [], state: 'produced', issues: [], pendingConfirmation: false,
    contentDigest: digest, idempotencyKey: digest, recordedAt: '2026-09-29T00:00:00Z',
  }
}

describe('review workbench focus jump (N09)', () => {
  it('opens the exact candidate the workflow guide named, not the first row', async () => {
    const fake = client(({ path }) => {
      if (path.endsWith('/rule-action-candidates')) return json({ candidates: [] })
      if (path.endsWith('/candidates')) return json({ candidates: [definitionCandidate(OBJECT_CANDIDATE_ID, '设备'), definitionCandidate(ATTRIBUTE_CANDIDATE_ID, '承载能力')] })
      if (path.endsWith('/drafts')) return json({ drafts: [] })
      if (path.endsWith('/generations')) return json({ batches: [] })
      if (path.endsWith('/unsupported-rules')) return json({ rules: [] })
      if (path.endsWith('/definition-adjudications')) return json({ adjudications: [] })
      if (path.startsWith('/api/v1/candidates/') && path.endsWith('/reviews')) return json({ reviews: [] })
      return json({}, 404)
    })
    const { container, root } = await render(createElement(DefinitionWorkbenchPanel, { client: fake, workspaceId: W, focusCandidateId: ATTRIBUTE_CANDIDATE_ID }))
    try {
      const focused = container.querySelector(`[data-testid="definition-candidate"][data-candidate-id="${ATTRIBUTE_CANDIDATE_ID}"] button`)
      expect(focused?.getAttribute('aria-pressed')).toBe('true')
      const unfocused = container.querySelector(`[data-testid="definition-candidate"][data-candidate-id="${OBJECT_CANDIDATE_ID}"] button`)
      expect(unfocused?.getAttribute('aria-pressed')).toBe('false')
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
