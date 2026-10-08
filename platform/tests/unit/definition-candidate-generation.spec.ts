import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  AssetDraftVersion,
  AppendAssetDraftInput,
  CreateIndustryWorkspaceInput,
  GenerationEvent,
  GenerationPort,
  GenerationRequest,
  IndustryWorkspace,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceStore,
  IndustryWorkspaceWriteResult,
  ResourceRef,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import {
  DefinitionCandidateGenerationService,
  DefinitionCandidateEditingService,
  InMemoryDefinitionEditingStore,
  InMemoryAssetCandidateStore,
  StaticDefinitionTerminologySource,
  TBOX_RESPONSE_SCHEMA_REF,
} from '@ontology/application'
import type { DefinitionCandidateGenerationDependencies } from '@ontology/application'
import { loadCompetencyQuestions } from '../fixtures/competency-questions/loader'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_SPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
const EDITOR_SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const DIGEST = `sha256:${'d'.repeat(64)}`
const POLICY_REF: VersionRef = { id: 'policy.tbox', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const MODEL_REF = { modelId: 'tbox-test-model', version: '1.0.0' } as const

const EDITOR: ToolContext = toolContext(TENANT, SPACE, ['profile-editor'], 'tbox-editor')
const VIEWER: ToolContext = toolContext(TENANT, SPACE, ['scoped-reader'], 'tbox-viewer')
const OTHER: ToolContext = toolContext(OTHER_TENANT, OTHER_SPACE, ['profile-editor'], 'tbox-other')

function resourceRef(id: string = randomUUID()): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function draft(workspaceId: string, revision: string): AssetDraftVersion {
  return { workspaceId, revision, digest: DIGEST, documentSetRef: resourceRef(), candidateRefs: [] }
}

/** A minimal workspace store: the generation service only reads the head and its drafts. */
class FixtureWorkspaceStore implements IndustryWorkspaceStore {
  readonly #workspaces = new Map<string, Map<string, IndustryWorkspace>>()
  readonly #drafts = new Map<string, Map<string, AssetDraftVersion[]>>()

  #key(scopeRef: ScopeRef): string {
    return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
  }

  seed(scopeRef: ScopeRef, workspace: IndustryWorkspace, drafts: readonly AssetDraftVersion[]): void {
    const key = this.#key(scopeRef)
    const workspaces = this.#workspaces.get(key) ?? new Map<string, IndustryWorkspace>()
    workspaces.set(workspace.workspaceId, workspace)
    this.#workspaces.set(key, workspaces)
    const draftMap = this.#drafts.get(key) ?? new Map<string, AssetDraftVersion[]>()
    draftMap.set(workspace.workspaceId, [...drafts])
    this.#drafts.set(key, draftMap)
  }

  async createWorkspace(
    _input: CreateIndustryWorkspaceInput,
    _scopeRef: ScopeRef,
    _ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    void _input
    void _scopeRef
    void _ctx
    throw new Error('not implemented in fixture')
  }

  async getWorkspace(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    _ctx: ToolContext,
  ): Promise<IndustryWorkspace | undefined> {
    void _ctx
    return this.#workspaces.get(this.#key(scopeRef))?.get(workspaceId)
  }

  async listWorkspaces(
    scopeRef: ScopeRef,
    _filter: IndustryWorkspaceListFilter,
    _ctx: ToolContext,
  ): Promise<IndustryWorkspace[]> {
    void _filter
    void _ctx
    return [...(this.#workspaces.get(this.#key(scopeRef))?.values() ?? [])]
  }

  async getDraft(
    scopeRef: ScopeRef,
    workspaceId: Uuid,
    revision: RevisionString,
    _ctx: ToolContext,
  ): Promise<AssetDraftVersion | undefined> {
    void _ctx
    return this.#drafts.get(this.#key(scopeRef))?.get(workspaceId)?.find((entry) => entry.revision === revision)
  }

  async listDrafts(scopeRef: ScopeRef, workspaceId: Uuid, _ctx: ToolContext): Promise<AssetDraftVersion[]> {
    void _ctx
    return [...(this.#drafts.get(this.#key(scopeRef))?.get(workspaceId) ?? [])]
  }

  async appendDraft(
    _scopeRef: ScopeRef,
    _workspaceId: Uuid,
    _input: AppendAssetDraftInput,
    _ctx: ToolContext,
  ): Promise<IndustryWorkspaceWriteResult> {
    void _scopeRef
    void _workspaceId
    void _input
    void _ctx
    throw new Error('not implemented in fixture')
  }

  headRevision(workspaceId: Uuid): string | undefined {
    for (const workspaces of this.#workspaces.values()) {
      const found = workspaces.get(workspaceId)
      if (found !== undefined) return found.headRevision
    }
    return undefined
  }

  draftCount(workspaceId: Uuid): number {
    for (const drafts of this.#drafts.values()) {
      const found = drafts.get(workspaceId)
      if (found !== undefined) return found.length
    }
    return 0
  }
}

class ScriptedGenerationPort implements GenerationPort {
  calls = 0
  readonly requests: GenerationRequest[] = []
  #responses: string[]
  #throws = false
  completed = true
  stopReason: 'stop' | 'length' = 'stop'
  beforeCompletion?: () => Promise<void>

  constructor(responses: readonly string[]) {
    this.#responses = [...responses]
  }

  failWith(): void {
    this.#throws = true
  }

  recover(): void {
    this.#throws = false
  }

  async *generate(request: GenerationRequest, _ctx: ToolContext): AsyncIterable<GenerationEvent> {
    void _ctx
    this.calls += 1
    this.requests.push(request)
    if (this.#throws) {
      throw new Error('provider unavailable')
    }
    const text = this.#responses.shift() ?? '{}'
    yield { type: 'text_delta', text }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 7 } }
    await this.beforeCompletion?.()
    if (this.completed) yield { type: 'completed', stopReason: this.stopReason, candidateOnly: true }
  }
}

function workspace(workspaceId: string = WORKSPACE_ID): IndustryWorkspace {
  return {
    workspaceId,
    namespace: 'tbox-test',
    displayName: 'TBox workspace',
    boundary: { goals: ['model equipment'], included: ['catalog'], excluded: ['pricing'], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
}

function buildHarness(responses: readonly string[], terminology = new StaticDefinitionTerminologySource(), overrides: Partial<DefinitionCandidateGenerationDependencies> = {}) {
  const workspaces = new FixtureWorkspaceStore()
  const ws = workspace()
  const initialDraft = draft(ws.workspaceId, '1')
  workspaces.seed(EDITOR_SCOPE, ws, [initialDraft])
  const candidates = new InMemoryAssetCandidateStore()
  const generation = new ScriptedGenerationPort(responses)
  let resolutions = 0
  const service = new DefinitionCandidateGenerationService({
    workspaces,
    candidates,
    terminology,
    sourceGrounding: {
      read: async (request, _ctx, budget) => ({ documentSetRef: initialDraft.documentSetRef,
        coverage: 'complete', usage: budget.usage(), sources: request.sourceRefs.map((sourceRef) => ({
          sourceRef, trust: 'untrusted_source_data', status: 'complete', reasons: [], contents: [{
            kind: 'text', text: 'Controlled source: equipment has rated capacity.', sourceSpan: {
              parseId: '22222222-2222-4222-8222-222222222222', chunkId: '33333333-3333-4333-8333-333333333333',
              locator: { kind: 'offset', startOffset: 0, endOffset: 53 }, spanKind: 'verbatim', precision: 'exact',
              quoteDigest: DIGEST, textDigest: DIGEST,
            },
          }],
        })) }),
    },
    generationForRun: () => { resolutions += 1; return generation },
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 16_384 },
    now: () => '2026-09-29T00:00:00Z',
    newId: () => randomUUID(),
    ...overrides,
  })
  return { service, workspaces, candidates, generation, ws, initialDraft, resolutions: () => resolutions }
}

function input(overrides: Partial<Parameters<DefinitionCandidateGenerationService['generate']>[0]> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    expectedRevision: '1',
    sourceRefs: [resourceRef('11111111-2222-4333-8444-555555555555')],
    kinds: ['object', 'attribute', 'relation'] as const,
    generationPolicyRef: POLICY_REF,
    idempotencyKey: `tbox-gen-${randomUUID()}`,
    ...overrides,
  }
}

const SOURCED_PAYLOAD = JSON.stringify({
  objects: [
    {
      logicalId: 'device',
      displayName: 'Device',
      businessMeaning: 'a monitored physical device',
      suggestedReason: 'the source lists devices with ratings',
      sourceIndex: 0, fragmentIndex: 0,
      identityAttributeIds: ['device_serial'],
    },
  ],
  attributes: [
    {
      logicalId: 'device_serial',
      displayName: 'Serial',
      businessMeaning: 'the manufacturer serial number',
      suggestedReason: 'appears on every device row',
      objectLogicalId: 'device',
      valueType: 'string',
      minCardinality: 1,
      maxCardinality: 1,
      sourceIndex: 0, fragmentIndex: 0,
    },
    {
      logicalId: 'rated_power',
      displayName: 'Rated power',
      businessMeaning: 'nameplate power',
      suggestedReason: 'device ratings are listed',
      objectLogicalId: 'device',
      valueType: 'quantity',
      unitCode: 'kW',
      dimension: 'power',
      sourceIndex: 0, fragmentIndex: 0,
    },
  ],
  relations: [
    {
      logicalId: 'meter_monitors_device',
      displayName: 'Monitors',
      businessMeaning: 'a meter observes a device',
      suggestedReason: 'the source pairs meters with devices',
      fromObjectLogicalId: 'meter',
      toObjectLogicalId: 'device',
      sourceIndex: 0, fragmentIndex: 0,
    },
  ],
})

describe('definition (TBox) candidate generation service', () => {
  it('produces object/attribute/relation candidates with meaning, type/unit, endpoints and provenance', async () => {
    const h = buildHarness([SOURCED_PAYLOAD])
    const result = await h.service.generate(input(), 'editor-1', EDITOR)

    expect(h.generation.calls).toBe(1)
    expect(result.created).toBe(true)
    expect(result.batch.domain).toBe('definition')
    expect(result.batch.modelRef.modelId).toBe('tbox-test-model')
    expect(result.batch.responseSchemaRef).toEqual(TBOX_RESPONSE_SCHEMA_REF)
    expect(result.batch.generationPolicyRef).toEqual(POLICY_REF)
    expect(result.batch.inputDraftRef).toMatchObject({ workspaceId: WORKSPACE_ID, revision: '1' })
    expect(result.batch.state).toBe('completed')

    const byId = new Map(result.candidates.map((candidate) => [candidate.logicalId, candidate]))
    const device = byId.get('device')
    expect(device?.domain).toBe('definition')
    expect(device?.kind).toBe('object')
    expect(device?.state).toBe('produced')
    expect(device?.sourceRefs).toHaveLength(1)
    expect(device?.payload.businessMeaning).toBe('a monitored physical device')

    const power = byId.get('rated_power')
    expect(power?.kind).toBe('attribute')
    expect(power?.payload.kind === 'attribute' ? power.payload.valueType : undefined).toBe('quantity')
    expect(power?.payload.kind === 'attribute' ? power.payload.unitCode : undefined).toBe('kW')

    // The relation endpoint `meter` is not mounted nor proposed: it is a hard, queryable failure.
    const relation = byId.get('meter_monitors_device')
    expect(relation?.state).toBe('failed')
    expect(relation?.issues.some((issue) => issue.code === 'ENDPOINT_UNRESOLVED')).toBe(true)

    const stored = await h.candidates.listCandidates(EDITOR_SCOPE, WORKSPACE_ID, {}, EDITOR)
    expect(stored).toHaveLength(4)
  })

  it('marks a suggestion without a source locator as pending confirmation', async () => {
    const payload = JSON.stringify({
      objects: [
        {
          logicalId: 'unattributed',
          displayName: 'Unattributed',
          businessMeaning: 'a guess',
          suggestedReason: 'no source cited',
        },
      ],
    })
    const h = buildHarness([payload])
    const result = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(result.batch.state).toBe('pending_confirmation')
    expect(result.batch.counts.pendingConfirmation).toBe(1)
    const candidate = result.candidates[0]
    expect(candidate?.state).toBe('pending_confirmation')
    expect(candidate?.pendingConfirmation).toBe(true)
    expect(candidate?.sourceRefs).toEqual([])
    expect(candidate?.issues.some((issue) => issue.code === 'MISSING_PROVENANCE')).toBe(true)
  })

  it('records a logical-id collision as a hard failure', async () => {
    const payload = JSON.stringify({
      objects: [
        { logicalId: 'dup', displayName: 'A', businessMeaning: 'a', suggestedReason: 'r', sourceIndex: 0 },
        { logicalId: 'dup', displayName: 'B', businessMeaning: 'b', suggestedReason: 'r', sourceIndex: 0 },
      ],
    })
    const h = buildHarness([payload])
    const result = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(result.candidates.every((candidate) => candidate.state === 'failed')).toBe(true)
    expect(
      result.candidates.every((candidate) => candidate.issues.some((issue) => issue.code === 'LOGICAL_ID_COLLISION')),
    ).toBe(true)
  })

  it('takes professional terminology from the mounted asset and surfaces a mismatch', async () => {
    const terminology = new StaticDefinitionTerminologySource([], {
      objectLogicalIds: ['device'],
      attributeLogicalIds: [],
      relationLogicalIds: [],
      attributes: [],
      displayNames: { device: 'Mounted Device' },
    })
    const payload = JSON.stringify({
      objects: [
        {
          logicalId: 'device',
          displayName: 'Device',
          businessMeaning: 'a monitored physical device',
          suggestedReason: 'listed',
          sourceIndex: 0, fragmentIndex: 0,
        },
      ],
    })
    const h = buildHarness([payload], terminology)
    const result = await h.service.generate(input(), 'editor-1', EDITOR)
    const candidate = result.candidates[0]
    expect(candidate?.state).toBe('produced')
    // The mounted asset's term wins; the model's differing label is a reviewable conflict.
    expect(candidate?.payload.displayName).toBe('Mounted Device')
    expect(candidate?.payload.conflicts.some((conflict) => conflict.kind === 'terminology_mismatch')).toBe(true)
  })

  it('flags a unit conflict when the mounted attribute declares another unit', async () => {
    const terminology = new StaticDefinitionTerminologySource([], {
      objectLogicalIds: ['device'],
      attributeLogicalIds: ['rated_power'],
      relationLogicalIds: [],
      attributes: [{ logicalId: 'rated_power', objectLogicalId: 'device', valueType: 'quantity', unitCode: 'W' }],
      displayNames: {},
    })
    const payload = JSON.stringify({
      attributes: [
        {
          logicalId: 'rated_power',
          displayName: 'Rated power',
          businessMeaning: 'nameplate power',
          suggestedReason: 'listed',
          objectLogicalId: 'device',
          valueType: 'quantity',
          unitCode: 'kW',
          sourceIndex: 0, fragmentIndex: 0,
        },
      ],
    })
    const h = buildHarness([payload], terminology)
    const result = await h.service.generate(input(), 'editor-1', EDITOR)
    const candidate = result.candidates[0]
    expect(candidate?.issues.some((issue) => issue.code === 'UNIT_CONFLICT')).toBe(true)
    expect(candidate?.payload.conflicts.some((conflict) => conflict.kind === 'unit_conflict')).toBe(true)
  })

  it('saves a failed, retryable batch when the model call fails and succeeds on retry', async () => {
    const h = buildHarness([SOURCED_PAYLOAD])
    h.generation.failWith()
    const failed = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(failed.batch.state).toBe('failed')
    expect(failed.batch.error?.retryable).toBe(true)
    expect(failed.candidates).toHaveLength(0)

    // A fresh attempt (new Idempotency-Key) can succeed; the first failure is preserved.
    h.generation.recover()
    const retried = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(retried.batch.state).toBe('completed')
    const batches = await h.service.listBatches(WORKSPACE_ID, 10, EDITOR)
    expect(batches.map((batch) => batch.state).sort()).toEqual(['completed', 'failed'])
  })

  it('replays an idempotent generation without a second model call and rejects a changed request', async () => {
    const h = buildHarness([SOURCED_PAYLOAD, SOURCED_PAYLOAD])
    const request = input()
    const first = await h.service.generate(request, 'editor-1', EDITOR)
    const replay = await h.service.generate(request, 'editor-1', EDITOR)
    expect(h.generation.calls).toBe(1)
    expect(replay.created).toBe(false)
    expect(replay.batch.batchId).toBe(first.batch.batchId)
    expect(replay.candidates).toHaveLength(first.candidates.length)

    await expect(
      h.service.generate({ ...request, kinds: ['object'] }, 'editor-1', EDITOR),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('never changes the workspace head or draft when candidates are generated', async () => {
    const h = buildHarness([SOURCED_PAYLOAD])
    const headBefore = h.workspaces.headRevision(WORKSPACE_ID)
    const draftsBefore = h.workspaces.draftCount(WORKSPACE_ID)
    await h.service.generate(input(), 'editor-1', EDITOR)
    expect(h.workspaces.headRevision(WORKSPACE_ID)).toBe(headBefore)
    expect(h.workspaces.draftCount(WORKSPACE_ID)).toBe(draftsBefore)
  })

  it('rejects a stale If-Match and a missing revision', async () => {
    const h = buildHarness([SOURCED_PAYLOAD])
    await expect(
      h.service.generate(input({ expectedRevision: '9' }), 'editor-1', EDITOR),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(
      h.service.generate(input({ expectedRevision: undefined }), 'editor-1', EDITOR),
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' })
  })

  it('enforces the editor role and tenant/space scope', async () => {
    const h = buildHarness([SOURCED_PAYLOAD])
    await expect(h.service.generate(input(), 'viewer', VIEWER)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.service.generate(input(), 'other', OTHER)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
  })

  it('reports a missing model capability as a configuration failure, with no batch', async () => {
    const workspaces = new FixtureWorkspaceStore()
    const ws = workspace()
    const initialDraft = draft(ws.workspaceId, '1')
  workspaces.seed(EDITOR_SCOPE, ws, [initialDraft])
    const candidates = new InMemoryAssetCandidateStore()
    const service = new DefinitionCandidateGenerationService({
      workspaces,
      candidates,
      terminology: new StaticDefinitionTerminologySource(),
      generationForRun: () => undefined,
      modelRef: MODEL_REF,
      outputLimit: { maxTokens: 16_384 },
    })
    await expect(service.generate(input(), 'editor-1', EDITOR)).rejects.toMatchObject({
      code: 'MODEL_NOT_CONFIGURED',
    })
    expect(await service.listBatches(WORKSPACE_ID, 10, EDITOR)).toHaveLength(0)
  })
})

function proposedObject(logicalId = 'equipment', source = true) {
  return { logicalId, displayName: 'Equipment', businessMeaning: 'An item maintained by this business.',
    suggestedReason: 'The approved source describes equipment.', ...(source ? { sourceIndex: 0, fragmentIndex: 0 } : {}) }
}

describe('grounded generation and immutable rebase', () => {
  it('includes actual untrusted text and server fragments; a source number alone stays pending', async () => {
    const object = { ...proposedObject(), fragmentIndex: undefined }
    const h = buildHarness([JSON.stringify({ objects: [object] })])
    const result = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(h.generation.requests[0]?.messages.at(-1)?.content).toContain('Controlled source: equipment has rated capacity.')
    expect(h.generation.requests[0]?.messages.at(-1)?.content).toContain('untrusted_source_data')
    expect(result.candidates[0]).toMatchObject({ state: 'pending_confirmation', sourceRefs: [], sourceSpans: [], pendingConfirmation: true })
  })

  it.each([{ sql: 'SELECT * FROM secrets' }, { script: 'eval(payload)' }])('rejects undeclared executable payload fields', async (extra) => {
    const h = buildHarness([JSON.stringify({ objects: [{ ...proposedObject(), ...extra }] })])
    expect((await h.service.generate(input(), 'editor-1', EDITOR)).batch).toMatchObject({ state: 'failed', error: { code: 'INVALID_MODEL_OUTPUT' } })
  })

  it('preserves two identical logical-id collision outputs as separate failed versions with accurate counts', async () => {
    const h = buildHarness([JSON.stringify({ objects: [proposedObject('duplicate'), proposedObject('duplicate')] })])
    const result = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(result.candidates).toHaveLength(2)
    expect(new Set(result.candidates.map((candidate) => candidate.candidateId)).size).toBe(2)
    expect(result.batch.counts).toMatchObject({ total: 2, failed: 2 })
    expect(result.candidates.every((candidate) => candidate.state === 'failed')).toBe(true)
  })

  it('does not accept fabricated fragment indices as source grounding', async () => {
    const h = buildHarness([JSON.stringify({ objects: [{ ...proposedObject(), fragmentIndex: 99 }] })])
    const result = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(result.candidates[0]).toMatchObject({ pendingConfirmation: true, sourceRefs: [], sourceSpans: [] })
  })

  it('reuses exact immutable content and original producing batches across new generation keys and replay', async () => {
    const h = buildHarness([SOURCED_PAYLOAD, SOURCED_PAYLOAD, SOURCED_PAYLOAD])
    const initial = await h.service.generate(input(), 'editor-1', EDITOR)
    const list = h.candidates.listCandidates.bind(h.candidates)
    let reverse = false
    const reordered = vi.spyOn(h.candidates, 'listCandidates').mockImplementation(async (...args) => {
      const rows = await list(...args)
      reverse = !reverse
      return reverse ? rows.reverse() : rows
    })
    const first = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(first.candidates.every((candidate) => initial.candidates.some((old) => old.candidateId === candidate.replacesCandidateId))).toBe(true)
    const nextInput = input()
    const second = await h.service.generate(nextInput, 'editor-1', EDITOR)
    expect(second.candidates.map((candidate) => candidate.candidateId).sort()).toEqual(first.candidates.map((candidate) => candidate.candidateId).sort())
    expect(second.candidates.every((candidate) => candidate.batchId === first.batch.batchId)).toBe(true)
    expect(second.batch.reusedCandidateIds).toHaveLength(first.candidates.length)
    expect(await h.candidates.listCandidatesByBatch(EDITOR_SCOPE, second.batch.batchId, EDITOR)).toEqual([])
    expect((await h.service.generate(nextInput, 'editor-1', EDITOR)).candidates).toEqual(second.candidates)
    expect(h.generation.calls).toBe(3)
    expect(second.batch.schemaDigest).toBe(first.batch.schemaDigest)
    reordered.mockRestore()
  })

  it('appends changed model content, then retains subsequent human edits as explicit conflicts', async () => {
    const payload = (name: string) => JSON.stringify({ objects: [{ ...proposedObject(), displayName: name }] })
    const h = buildHarness([payload('Equipment'), payload('Machine'), payload('Equipment'), payload('Equipment'), payload('Equipment')])
    const first = await h.service.generate(input(), 'editor-1', EDITOR)
    const changed = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(changed.candidates[0]?.replacesCandidateId).toBe(first.candidates[0]?.candidateId)
    const original = changed.candidates[0]
    if (original === undefined) throw new Error('expected changed object')
    const editing = new DefinitionCandidateEditingService({ workspaces: h.workspaces, candidates: h.candidates,
      editing: new InMemoryDefinitionEditingStore(), terminology: new StaticDefinitionTerminologySource() })
    const human = await editing.edit(WORKSPACE_ID, { expectedRevision: '1', candidateId: original.candidateId,
      payload: { ...original.payload, displayName: 'Human maintained equipment' }, reason: 'business owner wording', idempotencyKey: `human-${randomUUID()}` }, 'editor-1', EDITOR)
    const regenerated = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(regenerated.candidates[0]?.payload.displayName).toBe('Human maintained equipment')
    expect(regenerated.candidates[0]?.replacesCandidateId).toBe(human.candidates[0]?.candidateId)
    expect(regenerated.candidates[0]?.issues.some((issue) => issue.code === 'REBASE_CONFLICT')).toBe(true)
    expect(regenerated.candidates[0]?.state).toBe('pending_review')
    expect(regenerated.candidates[0]?.generationCallRef).toBeUndefined()
    expect((await h.candidates.getCandidate(EDITOR_SCOPE, human.candidates[0]?.candidateId ?? '', EDITOR))?.payload.displayName).toBe('Human maintained equipment')
    const refresh = await h.service.generate(input(), 'editor-1', EDITOR)
    const stable = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(stable.candidates[0]?.candidateId).toBe(refresh.candidates[0]?.candidateId)
    const conflict = refresh.candidates[0]?.payload.conflicts.find((value) => value.kind === 'human_edit_conflict')
    expect(conflict?.proposedDefinition?.displayName).toBe('Equipment')
    expect(conflict?.proposedContentDigest).toMatch(/^sha256:/)
    expect(h.generation.requests.at(-1)?.messages[1]?.content).not.toContain(conflict?.proposedContentDigest)
  })

  it('provides finite approved CQ intents and the business boundary without expected gold', async () => {
    const set = loadCompetencyQuestions()[0]
    if (set === undefined) throw new Error('expected authored transport declaration')
    const h = buildHarness([JSON.stringify({ objects: [proposedObject()] })], undefined, {
      competencyQuestions: { readApproved: async (scope, ref) => scope.tenantId === TENANT && ref.digest === set.ref.digest ? set : undefined },
    })
    const result = await h.service.generate(input({ competencyQuestionRef: set.ref }), 'editor-1', EDITOR)
    expect(result.batch.state).toBe('completed')
    const context = h.generation.requests[0]?.messages[1]?.content ?? ''
    expect(context).toContain(set.ref.digest)
    expect(context).toContain(set.body.questions[0]?.question)
    expect(context).toContain('model equipment')
    expect(context).not.toContain('derivation')
    expect(context).not.toContain('expected')
  })

  it('keeps header-only suggestions pending and refuses human confirmation without a real row', async () => {
    const corpus: { documentSetRef?: ResourceRef } = {}
    const h = buildHarness([JSON.stringify({ objects: [proposedObject()] })], undefined, { sourceGrounding: {
      read: async (request, _ctx, budget) => {
        const documentSetRef = corpus.documentSetRef
        if (documentSetRef === undefined) throw new Error('fixture corpus not ready')
        return { documentSetRef, coverage: 'complete', usage: budget.usage(), sources: request.sourceRefs.map((sourceRef) => ({
          sourceRef, trust: 'untrusted_source_data', status: 'complete', reasons: [], contents: [{ kind: 'table', format: 'csv',
            headerRow: 1, columns: [{ column: 1, index: 0, header: 'Equipment', headerDigest: DIGEST, address: 'A', hidden: false }], rows: [] }],
        })) }
      },
    } })
    corpus.documentSetRef = h.initialDraft.documentSetRef
    const candidate = (await h.service.generate(input(), 'editor-1', EDITOR)).candidates[0]
    if (candidate === undefined) throw new Error('expected pending suggestion')
    expect(candidate).toMatchObject({ state: 'pending_confirmation', sourceSpans: [] })
    expect(h.generation.requests[0]?.messages.at(-1)?.content).toContain('Equipment')
    await expect(h.service.confirmSource({ workspaceId: WORKSPACE_ID, expectedRevision: '1', candidateId: candidate.candidateId,
      contentDigest: candidate.contentDigest, sourceRef: input().sourceRefs[0] ?? resourceRef(), fragmentIndex: 0,
      reason: 'header is not a data row', idempotencyKey: `header-${randomUUID()}` }, 'editor-1', EDITOR)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
  })

  it('models relative to exact current draft candidates and resolves references to retained objects', async () => {
    const h = buildHarness([JSON.stringify({ objects: [proposedObject()] }), JSON.stringify({ attributes: [{ ...proposedObject('equipment_serial'), objectLogicalId: 'equipment', valueType: 'string' }] })])
    const first = await h.service.generate(input(), 'editor-1', EDITOR)
    const next = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(next.candidates[0]?.state).toBe('produced')
    expect(next.candidates[0]?.issues).toEqual([])
    expect(h.generation.requests[1]?.messages[1]?.content).toContain('equipment')
    expect(h.generation.requests[1]?.messages[1]?.content).not.toContain(first.candidates[0]?.candidateId)
    expect(h.generation.requests[1]?.messages[1]?.content).toContain('not_published_truth')
  })

  it('never reuses a clean version after draft/base and terminology validation change', async () => {
    const baseRef: VersionRef = { id: 'changed-base', version: '2.0.0', digest: DIGEST }
    const terminology = new StaticDefinitionTerminologySource([{ definitionRef: baseRef,
      terminology: { objectLogicalIds: ['device'], attributeLogicalIds: ['rated_power'], relationLogicalIds: [],
        displayNames: {}, attributes: [{ logicalId: 'rated_power', objectLogicalId: 'device', valueType: 'string' }] } }])
    const h = buildHarness([SOURCED_PAYLOAD, SOURCED_PAYLOAD], terminology)
    const first = await h.service.generate(input(), 'editor-1', EDITOR)
    h.workspaces.seed(EDITOR_SCOPE, { ...h.ws, headRevision: '2' }, [h.initialDraft,
      { ...h.initialDraft, revision: '2', digest: `sha256:${'e'.repeat(64)}`, basePackRef: baseRef }])
    const next = await h.service.generate(input({ expectedRevision: '2' }), 'editor-1', EDITOR)
    const oldAttribute = first.candidates.find((candidate) => candidate.logicalId === 'rated_power')
    const newAttribute = next.candidates.find((candidate) => candidate.logicalId === 'rated_power')
    expect(newAttribute?.candidateId).not.toBe(oldAttribute?.candidateId)
    expect(newAttribute?.replacesCandidateId).toBe(oldAttribute?.candidateId)
    expect(newAttribute?.issues.some((issue) => issue.code === 'TERMINOLOGY_MISMATCH')).toBe(true)
    expect(newAttribute?.inputDraftRef.revision).toBe('2')
    expect(next.batch.reusedCandidateIds).toEqual([])
  })

  it('human source confirmation appends the exact payload with a real span and requires a new review', async () => {
    const h = buildHarness([JSON.stringify({ objects: [proposedObject('equipment', false)] })])
    const pending = (await h.service.generate(input(), 'editor-1', EDITOR)).candidates[0]
    if (pending === undefined) throw new Error('expected pending suggestion')
    const confirm = { workspaceId: WORKSPACE_ID, expectedRevision: '1', candidateId: pending.candidateId,
      contentDigest: pending.contentDigest, sourceRef: resourceRef('11111111-2222-4333-8444-555555555555'),
      fragmentIndex: 0, reason: 'I read the equipment definition in this fragment', idempotencyKey: `confirm-${randomUUID()}` }
    const result = await h.service.confirmSource(confirm, 'editor-1', EDITOR)
    expect(result.candidates[0]?.candidateId).not.toBe(pending.candidateId)
    expect(result.candidates[0]).toMatchObject({ payload: pending.payload, replacesCandidateId: pending.candidateId,
      pendingConfirmation: false, sourceSpans: [{ quoteDigest: DIGEST }] })
    expect(result.candidates[0]?.generationCallRef).toBeUndefined()
    expect((await h.candidates.getCandidate(EDITOR_SCOPE, pending.candidateId, EDITOR))?.pendingConfirmation).toBe(true)
    expect((await h.service.confirmSource(confirm, 'editor-1', EDITOR)).created).toBe(false)
    expect(h.generation.calls).toBe(1)
    await expect(h.service.confirmSource({ ...confirm, idempotencyKey: `invalid-${randomUUID()}`, fragmentIndex: 33 }, 'editor-1', EDITOR)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it.each([['length', true], ['stop', false]] as const)('records incomplete streams (%s / completed=%s) as failures even with valid JSON', async (reason, completed) => {
    const h = buildHarness([JSON.stringify({ objects: [proposedObject()] })])
    h.generation.stopReason = reason
    h.generation.completed = completed
    const result = await h.service.generate(input(), 'editor-1', EDITOR)
    expect(result.batch).toMatchObject({ state: 'failed', error: { code: 'GENERATION_FAILED' } })
    expect(result.candidates).toEqual([])
  })

  it('shares cancellation and a bounded output allowance across all 500 candidates', async () => {
    const responses = Array.from({ length: 20 }, (_, page) => JSON.stringify({ objects: Array.from({ length: 25 }, (_, row) => proposedObject(`equipment_${page * 25 + row}`)) }))
    const h = buildHarness(responses)
    const result = await h.service.generate(input({ candidateLimit: 500 }), 'editor-1', EDITOR)
    expect(result.candidates).toHaveLength(500)
    expect(result.batch.counts.total).toBe(500)
    expect(h.generation.calls).toBe(20)
    expect(h.resolutions()).toBe(1)
    expect(h.generation.requests.every((request) => request.outputLimit.maxTokens === 13_312)).toBe(true)
    expect(new Set(result.candidates.map((candidate) => candidate.candidateId)).size).toBe(500)
  })

  it('keeps all batches on one shared port and saves no partial candidates when its budget refuses later calls', async () => {
    const responses = Array.from({ length: 4 }, (_, page) => JSON.stringify({ objects: Array.from({ length: 25 }, (_, row) => proposedObject(`bounded_${page * 25 + row}`)) }))
    const h = buildHarness(responses)
    h.generation.beforeCompletion = async () => { if (h.generation.calls === 3) throw new Error('shared model budget exhausted') }
    const result = await h.service.generate(input({ candidateLimit: 100 }), 'editor-1', EDITOR)
    expect(result.batch.state).toBe('failed')
    expect(result.candidates).toEqual([])
    expect(h.generation.calls).toBe(3)
    expect(h.resolutions()).toBe(1)
    expect(await h.service.listCandidates(WORKSPACE_ID, { limit: 100 }, EDITOR)).toEqual([])
  })

  it('discards late model content after cancellation and refuses missing approved CQ context', async () => {
    const h = buildHarness([SOURCED_PAYLOAD])
    const controller = new AbortController()
    h.generation.beforeCompletion = async () => { controller.abort() }
    const result = await h.service.generate(input(), 'editor-1', EDITOR, controller.signal)
    expect(result.batch).toMatchObject({ state: 'failed', error: { code: 'CANCELLED' } })
    expect(result.candidates).toEqual([])
    const another = buildHarness([SOURCED_PAYLOAD])
    const missing = await another.service.generate(input({ competencyQuestionRef: POLICY_REF }), 'editor-1', EDITOR)
    expect(missing.batch).toMatchObject({ state: 'failed', error: { code: 'VALIDATION_BLOCKED' } })
    expect(another.generation.calls).toBe(0)
  })
})
