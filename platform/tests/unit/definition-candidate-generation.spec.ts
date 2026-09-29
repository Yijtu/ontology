import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
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
  InMemoryAssetCandidateStore,
  StaticDefinitionTerminologySource,
  TBOX_RESPONSE_SCHEMA_REF,
} from '@ontology/application'
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
    yield { type: 'completed', stopReason: 'stop', candidateOnly: true }
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

function buildHarness(responses: readonly string[], terminology = new StaticDefinitionTerminologySource()) {
  const workspaces = new FixtureWorkspaceStore()
  const ws = workspace()
  workspaces.seed(EDITOR_SCOPE, ws, [draft(ws.workspaceId, '1')])
  const candidates = new InMemoryAssetCandidateStore()
  const generation = new ScriptedGenerationPort(responses)
  const service = new DefinitionCandidateGenerationService({
    workspaces,
    candidates,
    terminology,
    generationForRun: () => generation,
    modelRef: MODEL_REF,
    outputLimit: { maxTokens: 1_024 },
    now: () => '2026-09-29T00:00:00Z',
    newId: () => randomUUID(),
  })
  return { service, workspaces, candidates, generation, ws }
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
      sourceIndex: 0,
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
      sourceIndex: 0,
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
      sourceIndex: 0,
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
      sourceIndex: 0,
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
          sourceIndex: 0,
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
          sourceIndex: 0,
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
    workspaces.seed(EDITOR_SCOPE, ws, [draft(ws.workspaceId, '1')])
    const candidates = new InMemoryAssetCandidateStore()
    const service = new DefinitionCandidateGenerationService({
      workspaces,
      candidates,
      terminology: new StaticDefinitionTerminologySource(),
      generationForRun: () => undefined,
      modelRef: MODEL_REF,
      outputLimit: { maxTokens: 1_024 },
    })
    await expect(service.generate(input(), 'editor-1', EDITOR)).rejects.toMatchObject({
      code: 'MODEL_NOT_CONFIGURED',
    })
    expect(await service.listBatches(WORKSPACE_ID, 10, EDITOR)).toHaveLength(0)
  })
})
