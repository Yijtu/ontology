// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import {
  DefinitionWorkbenchPanel,
  buildEditedPayload,
  isCandidateStale,
} from '@ontology/app-web'
import type { DefinitionCandidatePayload, AssetCandidateVersion } from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const DIGEST = `sha256:${'a'.repeat(64)}`
const IN_SCHEMA = `sha256:${'b'.repeat(64)}`
const OUT_SCHEMA = `sha256:${'c'.repeat(64)}`

const OBJECT_ID = '00000000-0000-4000-8000-000000000001'
const ATTRIBUTE_ID = '00000000-0000-4000-8000-000000000002'
const RELATION_ID = '00000000-0000-4000-8000-000000000003'
const PENDING_ID = '00000000-0000-4000-8000-000000000004'
const RULE_UNSUPPORTED_ID = '00000000-0000-4000-8000-000000000005'
const ACTION_UNBOUND_ID = '00000000-0000-4000-8000-000000000006'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function definitionCandidate(args: {
  readonly candidateId: string
  readonly logicalId: string
  readonly kind: 'object' | 'attribute' | 'relation'
  readonly payload: DefinitionCandidatePayload
  readonly state?: string
  readonly sourceCount?: number
  readonly pending?: boolean
}): Record<string, unknown> {
  const sourceRefs = Array.from({ length: args.sourceCount ?? 1 }, (_value, index) => ({
    id: `00000000-0000-4000-8000-00000000010${String(index)}`,
    version: '1.0.0',
    digest: DIGEST,
    kind: 'artifact',
  }))
  return {
    candidateId: args.candidateId,
    batchId: '00000000-0000-4000-8000-000000000020',
    workspaceId: WORKSPACE_ID,
    logicalId: args.logicalId,
    domain: 'definition',
    kind: args.kind,
    payload: args.payload,
    inputDraftRef: { workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST },
    sourceRefs,
    sourceSpans: [],
    state: args.state ?? 'produced',
    issues: [],
    pendingConfirmation: args.pending ?? false,
    contentDigest: DIGEST,
    idempotencyKey: DIGEST,
    recordedAt: '2026-09-29T00:00:00Z',
  }
}

const OBJECT_PAYLOAD: DefinitionCandidatePayload = {
  kind: 'object',
  logicalId: 'device',
  displayName: '设备',
  businessMeaning: '桥架上的设备构件',
  suggestedReason: '资料中反复出现',
  conflicts: [],
  identityAttributeIds: ['device_code'],
}
const ATTRIBUTE_PAYLOAD: DefinitionCandidatePayload = {
  kind: 'attribute',
  logicalId: 'capacity',
  displayName: '承载能力',
  businessMeaning: '构件可承载的重量',
  suggestedReason: '规格表给出',
  conflicts: [{ kind: 'unit_conflict', message: '与已发布单位 kg 不一致', relatedLogicalIds: ['capacity'] }],
  objectLogicalId: 'device',
  valueType: 'quantity',
  unitCode: 't',
  minCardinality: 0,
  maxCardinality: 1,
}
const RELATION_PAYLOAD: DefinitionCandidatePayload = {
  kind: 'relation',
  logicalId: 'part_of',
  displayName: '属于',
  businessMeaning: '设备属于某个桥架段',
  suggestedReason: '结构层级',
  conflicts: [{ kind: 'endpoint_unresolved', message: '终点对象 tray_section 尚未定义', relatedLogicalIds: ['tray_section'] }],
  fromObjectLogicalId: 'device',
  toObjectLogicalId: 'tray_section',
  minCardinality: 0,
  maxCardinality: 'unbounded',
}

function ruleCandidateUnsupported(): Record<string, unknown> {
  const condition = { op: 'relation', relationId: 'meter_of', spans: [] }
  return {
    candidateId: RULE_UNSUPPORTED_ID,
    workspaceId: WORKSPACE_ID,
    logicalId: 'rule.multi_or',
    domain: 'definition',
    kind: 'rule',
    displayName: '多条件或规则',
    businessMeaning: '不同条件的或关系',
    suggestedReason: '资料',
    payload: {
      kind: 'rule',
      ruleId: 'rule.multi_or',
      applicability: { objectId: 'device' },
      condition,
      exceptions: [],
      ruleDependencies: [],
      support: {
        ruleId: 'rule.multi_or',
        supportState: 'not_yet_executable',
        executable: false,
        findings: [{ code: 'RELATION_PREMISE_UNSUPPORTED', message: '关系前提暂不支持', path: 'condition' }],
        condition,
        exceptions: [],
        dependencyDepth: 0,
      },
    },
    sourceRefs: [],
    sourceSpans: [],
    lifecycle: 'draft',
    contentDigest: DIGEST,
    idempotencyKey: DIGEST,
    actor: 'e2e',
    recordedAt: '2026-09-29T00:00:00Z',
  }
}

function actionCandidateUnbound(): Record<string, unknown> {
  return {
    candidateId: ACTION_UNBOUND_ID,
    workspaceId: WORKSPACE_ID,
    logicalId: 'action.export_member',
    domain: 'definition',
    kind: 'action',
    displayName: '导出构件',
    businessMeaning: '导出构件清单',
    suggestedReason: '资料',
    payload: {
      kind: 'action',
      declaration: {
        actionId: 'action.export_member',
        displayName: '导出构件',
        businessMeaning: '导出构件清单',
        suggestedReason: '资料',
        inputSchemaRef: { id: 'bridge.export.input', version: '1.0.0', digest: IN_SCHEMA },
        outputSchemaRef: { id: 'bridge.export.output', version: '1.0.0', digest: OUT_SCHEMA },
        preconditions: [],
        requiredCapabilities: [],
        permissions: [],
        readOnly: true,
        sideEffect: 'read_only',
        evidenceRequirements: [],
        suggestedOperationRef: { id: 'unknown.op', version: '1' },
      },
      binding: {
        actionId: 'action.export_member',
        status: 'not_executable',
        executable: false,
        findings: [{ code: 'NO_REGISTERED_OPERATION', message: 'operation unknown.op@1 未注册', path: undefined }],
        registryRef: { id: 'bridge', version: '1.0.0', digest: DIGEST },
        recordedAt: '2026-09-29T00:00:00Z',
      },
    },
    sourceRefs: [],
    sourceSpans: [],
    lifecycle: 'draft',
    contentDigest: DIGEST,
    idempotencyKey: DIGEST,
    actor: 'e2e',
    recordedAt: '2026-09-29T00:00:00Z',
  }
}

const COMPATIBILITY = {
  workspaceId: WORKSPACE_ID,
  revision: '2',
  additions: [{ code: 'OBJECT_ADDED', logicalId: 'device', kind: 'object', breaking: false, message: '新增对象' }],
  changes: [
    { code: 'UNIT_CHANGED', logicalId: 'capacity', kind: 'attribute', breaking: true, message: '单位变化', before: 'kg', after: 't' },
  ],
  breakingChanges: [
    { code: 'UNIT_CHANGED', logicalId: 'capacity', kind: 'attribute', breaking: true, message: '单位变化', before: 'kg', after: 't' },
  ],
  requiresRevisionStrategy: true,
}

const VALIDATION = {
  workspaceId: WORKSPACE_ID,
  revision: '2',
  checkedCandidateIds: [OBJECT_ID],
  blockers: [{ code: 'DANGLING_ENDPOINT', severity: 'blocker', candidateId: RELATION_ID, logicalId: 'part_of', path: 'payload.toObjectLogicalId', message: '终点未定义' }],
  warnings: [],
  nonExecutableRules: [],
  compatibility: COMPATIBILITY,
  publishable: false,
}

interface MockState {
  candidates: Record<string, unknown>[]
}

function createFetchImpl(state: MockState): typeof fetch {
  return (input, init) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.includes('/definition-compatibility')) {
      return Promise.resolve(jsonResponse({ data: { report: COMPATIBILITY } }))
    }
    if (url.includes('/definition-validations') && method === 'POST') {
      return Promise.resolve(jsonResponse({ data: { report: VALIDATION } }))
    }
    if (url.includes('/definition-adjudications')) {
      return Promise.resolve(jsonResponse({ data: { adjudications: [] } }))
    }
    if (url.includes('/unsupported-rules') && method === 'GET') {
      return Promise.resolve(
        jsonResponse({
          data: {
            rules: [
              {
                ruleId: 'rule.manual_unsupported',
                workspaceId: WORKSPACE_ID,
                reason: '规则语法超出可执行子集',
                rawForm: { op: 'unsupported_quantifier' },
                executable: false,
                idempotencyKey: DIGEST,
                actor: 'e2e',
                recordedAt: '2026-09-29T00:00:00Z',
              },
            ],
          },
        }),
      )
    }
    if (url.includes('/rule-action-candidates') && url.includes('/enable') && method === 'POST') {
      return Promise.resolve(
        jsonResponse({ error: { code: 'SUPPORT_VALIDATION_BLOCKED', message: '规则超出可执行子集', retryable: false } }, 422),
      )
    }
    if (url.includes('/rule-action-candidates') && method === 'GET') {
      return Promise.resolve(jsonResponse({ data: { candidates: [ruleCandidateUnsupported(), actionCandidateUnbound()] } }))
    }
    if (url.includes('/generations')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            batches: [
              {
                batchId: '00000000-0000-4000-8000-000000000020',
                workspaceId: WORKSPACE_ID,
                domain: 'definition',
                inputDraftRef: { workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST },
                modelRef: { modelId: 'fixture', version: '1.0.0' },
                responseSchemaRef: { id: 'schema', version: '1.0.0', digest: DIGEST },
                documentSetRef: { id: '00000000-0000-4000-8000-000000000099', version: '1.0.0', digest: DIGEST, kind: 'artifact' },
                generationPolicyRef: { id: 'policy', version: '1.0.0', digest: DIGEST },
                state: 'completed',
                counts: { total: 4, produced: 2, pendingConfirmation: 1, pendingReview: 0, failed: 0 },
                idempotencyKey: 'batch-1',
                requestDigest: DIGEST,
                createdBy: 'e2e',
                recordedAt: '2026-09-29T00:00:00Z',
              },
            ],
          },
        }),
      )
    }
    if (url.includes('/candidates/') && url.endsWith('/rejections') && method === 'POST') {
      const object = state.candidates.find((candidate) => candidate['candidateId'] === OBJECT_ID)
      if (object !== undefined) object['state'] = 'rejected'
      return Promise.resolve(
        jsonResponse({
          data: {
            adjudication: {
              adjudicationId: '00000000-0000-4000-8000-0000000000aa',
              workspaceId: WORKSPACE_ID,
              kind: 'reject',
              candidateIds: [OBJECT_ID],
              producedCandidateIds: [],
              reason: '重复术语',
              affected: [],
              findings: [],
              compatibility: COMPATIBILITY,
              requestDigest: DIGEST,
              idempotencyKey: DIGEST,
              actor: 'e2e',
              recordedAt: '2026-09-29T00:00:00Z',
            },
            candidates: [],
            created: true,
          },
        }),
      )
    }
    if (url.endsWith('/reviews') && method === 'GET') return Promise.resolve(jsonResponse({ data: { reviews: [] } }))
    if (url.includes('/candidates') && method === 'GET') {
      return Promise.resolve(jsonResponse({ data: { candidates: state.candidates } }))
    }
    if (url.includes('/drafts')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            drafts: [
              {
                workspaceId: WORKSPACE_ID,
                revision: '2',
                digest: DIGEST,
                documentSetRef: { id: '00000000-0000-4000-8000-000000000099', version: '1.0.0', digest: DIGEST, kind: 'artifact' },
                candidateRefs: [{ logicalId: 'device', candidateId: OBJECT_ID, digest: DIGEST }],
              },
            ],
          },
        }),
      )
    }
    return Promise.resolve(jsonResponse({ data: {} }, 404))
  }
}

async function mount(client: WorkbenchClient): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(DefinitionWorkbenchPanel, { client, workspaceId: WORKSPACE_ID }))
  })
  return { container, root }
}

async function unmount(container: HTMLElement, root: ReturnType<typeof createRoot>): Promise<void> {
  await act(async () => root.unmount())
  container.remove()
}

describe('definition workbench edit helpers', () => {
  it('preserves the candidate kind and only changes the edited fields', () => {
    const payload = buildEditedPayload(ATTRIBUTE_PAYLOAD, {
      displayName: '额定承载',
      businessMeaning: '',
      suggestedReason: '',
      valueType: 'quantity',
      unitCode: 'kg',
      fromObjectLogicalId: '',
      toObjectLogicalId: '',
      identityAttributeIds: '',
      reason: '修正单位',
    })
    expect(payload.kind).toBe('attribute')
    if (payload.kind !== 'attribute') throw new Error('expected an attribute payload')
    expect(payload.displayName).toBe('额定承载')
    expect(payload.unitCode).toBe('kg')
    expect(payload.businessMeaning).toBe('构件可承载的重量')
    expect(payload.objectLogicalId).toBe('device')
  })

  it('treats a candidate generated against an older revision as stale', () => {
    const candidate = { inputDraftRef: { revision: '1' } } as unknown as AssetCandidateVersion
    expect(isCandidateStale(candidate, '2')).toBe(true)
    expect(isCandidateStale(candidate, '1')).toBe(false)
  })
})

describe('definition workbench panel', () => {
  it('shows a selectable queue, current source state, conflicts, drift and actual batch counts', async () => {
    const state: MockState = { candidates: [
      definitionCandidate({ candidateId: OBJECT_ID, logicalId: 'device', kind: 'object', payload: OBJECT_PAYLOAD }),
      definitionCandidate({ candidateId: ATTRIBUTE_ID, logicalId: 'capacity', kind: 'attribute', payload: ATTRIBUTE_PAYLOAD }),
      definitionCandidate({ candidateId: RELATION_ID, logicalId: 'part_of', kind: 'relation', payload: RELATION_PAYLOAD, sourceCount: 0 }),
      definitionCandidate({ candidateId: PENDING_ID, logicalId: 'ghost_term', kind: 'object', payload: { ...OBJECT_PAYLOAD, logicalId: 'ghost_term', displayName: '未定位术语', conflicts: [] }, state: 'pending_confirmation', sourceCount: 0, pending: true }),
    ] }
    const { container, root } = await mount(new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: createFetchImpl(state) }))
    try {
      expect(container.querySelectorAll('[data-testid="definition-candidate"]')).toHaveLength(4)
      expect(container.textContent).toContain('此候选产生于较早的工作区版本')
      expect(container.textContent).toContain('实际产生 4 个候选')
      await act(async () => container.querySelector<HTMLButtonElement>(`[data-candidate-id="${ATTRIBUTE_ID}"] button`)?.click())
      expect(container.querySelector('.ontology-detail')?.textContent).toContain('与已发布单位 kg 不一致')
      await act(async () => container.querySelector<HTMLButtonElement>(`[data-candidate-id="${PENDING_ID}"] button`)?.click())
      expect(container.querySelector('.ontology-detail')?.textContent).toContain('待确认来源')
      const approval = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '批准当前内容')
      expect(approval?.disabled).toBe(true)
      expect(container.querySelector('.ontology-advanced')?.hasAttribute('open')).toBe(false)
    } finally { await unmount(container, root) }
  })

  it('preserves unsupported conditions, action binding reasons and complete before/after diffs', async () => {
    const { container, root } = await mount(new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: createFetchImpl({ candidates: [] }) }))
    try {
      expect(container.querySelector('.ontology-detail')?.textContent).toContain('暂不可执行')
      expect(container.querySelector('.ontology-detail')?.textContent).toContain('RELATION_PREMISE_UNSUPPORTED')
      await act(async () => container.querySelector<HTMLButtonElement>(`[data-candidate-id="${ACTION_UNBOUND_ID}"] button`)?.click())
      expect(container.querySelector('.ontology-detail')?.textContent).toContain('NO_REGISTERED_OPERATION')
      expect(container.textContent).toContain('保留的不可执行规则')
      expect(container.querySelector('.ontology-full-diff')?.textContent).toContain('变更前')
      expect(container.querySelector('.ontology-full-diff')?.textContent).toContain('变更后')
      expect(container.querySelector('.ontology-full-diff')?.textContent).toContain('破坏性变更')
    } finally { await unmount(container, root) }
  })

  it('prevents enabling a rule lacking support/current content approval without issuing a write', async () => {
    let enableCalls = 0
    const original = createFetchImpl({ candidates: [] })
    const client = new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: (input, init) => { if (String(input).endsWith('/enable')) enableCalls++; return original(input, init) } })
    const { container, root } = await mount(client)
    try {
      const enable = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '启用通过验核的声明')
      expect(enable?.disabled).toBe(true)
      await act(async () => enable?.click())
      expect(enableCalls).toBe(0)
    } finally { await unmount(container, root) }
  })

  it('withdraws a definition through its actual adjudication endpoint and keeps the returned state', async () => {
    const state: MockState = { candidates: [definitionCandidate({ candidateId: OBJECT_ID, logicalId: 'device', kind: 'object', payload: OBJECT_PAYLOAD })] }
    const { container, root } = await mount(new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: createFetchImpl(state) }))
    try {
      const reason = [...container.querySelectorAll<HTMLTextAreaElement>('textarea')].find((input) => document.querySelector(`label[for="${input.id}"]`)?.textContent === '审核意见')
      if (reason === undefined) throw new Error('the human reason field is missing')
      await act(async () => setInputValue(reason, '重复术语'))
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '撤销此定义候选')?.click())
      expect(container.querySelector(`[data-candidate-id="${OBJECT_ID}"]`)?.getAttribute('data-state')).toBe('rejected')
      expect(container.querySelector('.ontology-detail')?.textContent).toContain('已拒绝')
    } finally { await unmount(container, root) }
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
