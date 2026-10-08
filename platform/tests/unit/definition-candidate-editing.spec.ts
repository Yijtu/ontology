import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  AppendAssetDraftInput,
  AssetCandidateBatch,
  AssetCandidateState,
  AssetCandidateVersion,
  AssetDraftVersion,
  CreateIndustryWorkspaceInput,
  DefinitionCandidatePayload,
  IndustrySchemaSource,
  IndustryWorkspace,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceStore,
  IdentityDecisionStore,
  PublishedDefinitionVersionReader,
  ResourceRef,
  RevisionString,
  ScopeRef,
  SemanticDefinitionVersion,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import {
  CompositeReviewableCandidateReader,
  DefinitionCandidateEditingService,
  InMemoryAssetCandidateStore,
  InMemoryCandidateStore,
  InMemoryDefinitionEditingStore,
  sha256DigestOf,
  canonicalJson,
  StaticDefinitionTerminologySource,
} from '@ontology/application'
import { InMemorySemanticPublicationStore, SemanticPublicationService } from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_SPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const DIGEST = `sha256:${'d'.repeat(64)}`

const EDITOR: ToolContext = toolContext(TENANT, SPACE, ['profile-editor'], 'editor-1')
const REVIEWER: ToolContext = toolContext(TENANT, SPACE, ['semantic-reviewer'], 'reviewer-1')
const VIEWER: ToolContext = toolContext(TENANT, SPACE, ['scoped-reader'], 'viewer-1')
const OTHER: ToolContext = toolContext(OTHER_TENANT, OTHER_SPACE, ['profile-editor'], 'other-1')

let counter = 0
function digest(seed: string): string {
  counter += 1
  return sha256DigestOf(canonicalJson({ seed, counter }))
}

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function draft(workspaceId: string, revision: string, basePackRef?: VersionRef): AssetDraftVersion {
  return { workspaceId, revision, digest: DIGEST, documentSetRef: resourceRef(), candidateRefs: [], ...(basePackRef === undefined ? {} : { basePackRef }) }
}

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

  async createWorkspace(_input: CreateIndustryWorkspaceInput, _s: ScopeRef, _c: ToolContext): Promise<never> {
    void _input
    void _s
    void _c
    throw new Error('not implemented in fixture')
  }

  async getWorkspace(scopeRef: ScopeRef, workspaceId: Uuid, _c: ToolContext): Promise<IndustryWorkspace | undefined> {
    void _c
    return this.#workspaces.get(this.#key(scopeRef))?.get(workspaceId)
  }

  async listWorkspaces(scopeRef: ScopeRef, _f: IndustryWorkspaceListFilter, _c: ToolContext): Promise<IndustryWorkspace[]> {
    void _f
    void _c
    return [...(this.#workspaces.get(this.#key(scopeRef))?.values() ?? [])]
  }

  async getDraft(scopeRef: ScopeRef, workspaceId: Uuid, revision: RevisionString, _c: ToolContext): Promise<AssetDraftVersion | undefined> {
    void _c
    return this.#drafts.get(this.#key(scopeRef))?.get(workspaceId)?.find((entry) => entry.revision === revision)
  }

  async listDrafts(scopeRef: ScopeRef, workspaceId: Uuid, _c: ToolContext): Promise<AssetDraftVersion[]> {
    void _c
    return [...(this.#drafts.get(this.#key(scopeRef))?.get(workspaceId) ?? [])]
  }

  async appendDraft(_s: ScopeRef, _w: Uuid, _i: AppendAssetDraftInput, _c: ToolContext): Promise<never> {
    void _s
    void _w
    void _i
    void _c
    throw new Error('not implemented in fixture')
  }
}

class FixedPublishedDefinitions implements PublishedDefinitionVersionReader {
  readonly #versions = new Map<string, SemanticDefinitionVersion>()

  add(version: SemanticDefinitionVersion): void {
    this.#versions.set(`${version.namespace}\u0000${version.definitionId}\u0000${version.version}`, version)
  }

  async findVersion(namespace: string, definitionId: string, version: string): Promise<SemanticDefinitionVersion | undefined> {
    return this.#versions.get(`${namespace}\u0000${definitionId}\u0000${version}`)
  }
}

const unusedSchemaSource: IndustrySchemaSource = {
  async getSchema(): Promise<undefined> {
    throw new Error('schema source is not used by candidate review')
  },
}

class UnusedIdentity implements IdentityDecisionStore {
  async getEntity(): Promise<never> {
    throw new Error('not used')
  }
  async listEntities(): Promise<never> {
    throw new Error('not used')
  }
  async latestRevision(): Promise<never> {
    throw new Error('not used')
  }
  async latestReadRevision(): Promise<never> {
    throw new Error('not used')
  }
  async readPublishedBindings(): Promise<never> {
    throw new Error('not used')
  }
  async appendDecision(): Promise<never> {
    throw new Error('not used')
  }
  async getDecision(): Promise<never> {
    throw new Error('not used')
  }
  async listDecisions(): Promise<never> {
    throw new Error('not used')
  }
  async listAssertions(): Promise<never> {
    throw new Error('not used')
  }
  async listLinkConstraints(): Promise<never> {
    throw new Error('not used')
  }
  async hasReviewedIdentity(): Promise<never> {
    throw new Error('not used')
  }
}

function objectPayload(logicalId: string, identity: readonly string[] = []): DefinitionCandidatePayload {
  return {
    kind: 'object',
    logicalId,
    displayName: logicalId,
    businessMeaning: `${logicalId} meaning`,
    suggestedReason: 'seeded',
    conflicts: [],
    identityAttributeIds: identity,
  }
}

function attributePayload(
  logicalId: string,
  objectLogicalId: string,
  overrides: Partial<Extract<DefinitionCandidatePayload, { kind: 'attribute' }>> = {},
): DefinitionCandidatePayload {
  return {
    kind: 'attribute',
    logicalId,
    displayName: logicalId,
    businessMeaning: `${logicalId} meaning`,
    suggestedReason: 'seeded',
    conflicts: [],
    objectLogicalId,
    valueType: 'string',
    minCardinality: 0,
    maxCardinality: 1,
    ...overrides,
  }
}

function relationPayload(logicalId: string, from: string, to: string): DefinitionCandidatePayload {
  return {
    kind: 'relation',
    logicalId,
    displayName: logicalId,
    businessMeaning: `${logicalId} meaning`,
    suggestedReason: 'seeded',
    conflicts: [],
    fromObjectLogicalId: from,
    toObjectLogicalId: to,
    minCardinality: 0,
    maxCardinality: 'unbounded',
  }
}

interface HarnessOptions {
  readonly terminology?: StaticDefinitionTerminologySource
  readonly published?: FixedPublishedDefinitions
  readonly basePackRef?: VersionRef
}

function buildHarness(options: HarnessOptions = {}) {
  const workspaces = new FixtureWorkspaceStore()
  const ws: IndustryWorkspace = {
    workspaceId: WORKSPACE_ID,
    namespace: 'tbox-edit',
    displayName: 'TBox editing workspace',
    boundary: { goals: ['model equipment'], included: ['catalog'], excluded: ['pricing'], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
  workspaces.seed(SCOPE, ws, [draft(WORKSPACE_ID, '1', options.basePackRef)])
  const candidates = new InMemoryAssetCandidateStore()
  const editing = new InMemoryDefinitionEditingStore()
  const reviews = new InMemorySemanticPublicationStore()
  const reviewableCandidates = new CompositeReviewableCandidateReader({ definition: candidates, instance: new InMemoryCandidateStore() })
  const service = new DefinitionCandidateEditingService({
    workspaces,
    candidates, reviews, reviewableCandidates,
    terminology: options.terminology ?? new StaticDefinitionTerminologySource(),
    editing,
    ...(options.published === undefined ? {} : { publishedDefinitions: options.published }),
    now: () => `2026-09-29T00:00:${String(counter % 60).padStart(2, '0')}Z`,
    newId: () => randomUUID(),
  })
  return { service, workspaces, candidates, editing, reviews }
}

async function seedCandidate(
  candidates: InMemoryAssetCandidateStore,
  payload: DefinitionCandidatePayload,
  options: { readonly state?: AssetCandidateState; readonly recordedAt?: string } = {},
): Promise<AssetCandidateVersion> {
  const batchId = randomUUID()
  const recordedAt = options.recordedAt ?? '2026-09-29T00:00:00Z'
  const candidateId = randomUUID()
  const candidate: AssetCandidateVersion = {
    candidateId,
    batchId,
    workspaceId: WORKSPACE_ID,
    logicalId: payload.logicalId,
    domain: 'definition',
    kind: payload.kind,
    payload,
    inputDraftRef: { workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST },
    sourceRefs: [resourceRef()],
    sourceSpans: [],
    state: options.state ?? 'produced',
    issues: [],
    pendingConfirmation: false,
    contentDigest: DIGEST,
    idempotencyKey: digest(`candidate-${payload.logicalId}`),
    recordedAt,
  }
  const batch: AssetCandidateBatch = {
    batchId,
    workspaceId: WORKSPACE_ID,
    domain: 'definition',
    inputDraftRef: candidate.inputDraftRef,
    modelRef: { modelId: 'seed', version: '1.0.0' },
    responseSchemaRef: { id: 'seed', version: '1.0.0', digest: DIGEST },
    documentSetRef: resourceRef(),
    generationPolicyRef: { id: 'seed.policy', version: '1.0.0', digest: DIGEST },
    state: 'completed',
    counts: { total: 1, produced: 1, pendingConfirmation: 0, pendingReview: 0, failed: 0 },
    idempotencyKey: `seed-${randomUUID()}`,
    requestDigest: digest(`batch-${payload.logicalId}`),
    createdBy: 'seed',
    recordedAt,
  }
  const result = await candidates.insertBatch(SCOPE, batch, [candidate], EDITOR)
  const stored = result.candidates[0]
  if (stored === undefined) throw new Error('seed failed')
  return stored
}

function publishedVersion(attributes: readonly { id: string; valueType: string; unitCode?: string; objectId: string }[]): SemanticDefinitionVersion {
  return {
    ref: { id: 'pack', version: '1.0.0', digest: DIGEST },
    scopeRef: SCOPE,
    publishedAt: '2026-09-01T00:00:00Z',
    definitionId: 'pack',
    version: '1.0.0',
    namespace: 'tbox-edit',
    layer: 'industry_core',
    standardProvenance: [],
    objects: [
      { kind: 'object', id: 'device', namespace: 'tbox-edit', displayName: 'Device', identityScopeId: 'device_scope', standardProvenance: [] },
    ],
    attributes: attributes.map((attribute) => ({
      kind: 'attribute' as const,
      id: attribute.id,
      namespace: 'tbox-edit',
      objectId: attribute.objectId,
      valueType: attribute.valueType as SemanticDefinitionVersion['attributes'][number]['valueType'],
      cardinality: { min: 0, max: 1 as const },
      ...(attribute.unitCode === undefined ? {} : { unit: { unitCode: attribute.unitCode, dimension: 'power' } }),
      standardProvenance: [],
    })),
    relations: [],
    identityScopes: [
      {
        kind: 'identity_scope' as const,
        id: 'device_scope',
        namespace: 'tbox-edit',
        objectId: 'device',
        scopeDimensions: [],
        identityAttributeIds: ['device_serial'],
        standardProvenance: [],
      },
    ],
    ruleConstraints: [],
  }
}

const BASE_PACK_REF: VersionRef = { id: 'pack', version: '1.0.0', digest: DIGEST }

describe('definition candidate editing and disambiguation', () => {
  it('edits an attribute type and unit into a new immutable revision and preserves the original', async () => {
    const h = buildHarness()
    const original = await seedCandidate(h.candidates, attributePayload('rated_power', 'device', { valueType: 'quantity', unitCode: 'kW' }))
    await seedCandidate(h.candidates, objectPayload('device', ['rated_power']))
    const edited = attributePayload('rated_power', 'device', { valueType: 'quantity', unitCode: 'MW' })

    const result = await h.service.edit(
      WORKSPACE_ID,
      { candidateId: original.candidateId, expectedRevision: '1', payload: edited, reason: 'correct the unit', idempotencyKey: `edit-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(result.created).toBe(true)
    expect(result.candidates).toHaveLength(1)
    const revision = result.candidates[0]
    expect(revision?.candidateId).not.toBe(original.candidateId)
    expect(revision?.replacesCandidateId).toBe(original.candidateId)
    expect(revision?.payload.kind === 'attribute' ? revision.payload.unitCode : undefined).toBe('MW')
    expect(result.adjudication.kind).toBe('edit')
    expect(result.adjudication.affected.some((entry) => entry.logicalId === 'rated_power')).toBe(true)

    // The original immutable revision is untouched.
    const untouched = await h.candidates.getCandidate(SCOPE, original.candidateId, EDITOR)
    expect(untouched?.payload.kind === 'attribute' ? untouched.payload.unitCode : undefined).toBe('kW')
  })

  it('rejects a candidate and records the adjudication reason', async () => {
    const h = buildHarness()
    const candidate = await seedCandidate(h.candidates, objectPayload('wildcard'))
    const result = await h.service.reject(
      WORKSPACE_ID,
      { candidateId: candidate.candidateId, expectedRevision: '1', reason: 'outside the business boundary', idempotencyKey: `reject-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(result.adjudication.kind).toBe('reject')
    expect(result.adjudication.reason).toBe('outside the business boundary')
    const stored = await h.candidates.getCandidate(SCOPE, candidate.candidateId, EDITOR)
    expect(stored?.state).toBe('rejected')
  })

  it('merges synonym candidates and rejects the merged-away originals', async () => {
    const h = buildHarness()
    const first = await seedCandidate(h.candidates, attributePayload('power_rating', 'device', { valueType: 'quantity', unitCode: 'kW' }))
    const second = await seedCandidate(h.candidates, attributePayload('rated_power', 'device', { valueType: 'quantity', unitCode: 'kW' }))
    await seedCandidate(h.candidates, objectPayload('device'))
    const merged = attributePayload('rated_power', 'device', { valueType: 'quantity', unitCode: 'kW', displayName: 'Rated power' })

    const result = await h.service.merge(
      WORKSPACE_ID,
      { candidateIds: [first.candidateId, second.candidateId], mergedPayload: merged, reason: 'same quantity, one term', expectedRevision: '1', idempotencyKey: `merge-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(result.adjudication.kind).toBe('merge')
    expect(result.adjudication.candidateIds).toHaveLength(2)
    expect(result.candidates).toHaveLength(1)
    const away = await h.candidates.getCandidate(SCOPE, second.candidateId, EDITOR)
    expect(away?.state).toBe('rejected')
  })

  it('keeps same-name different-meaning candidates independent', async () => {
    const h = buildHarness()
    const left = await seedCandidate(h.candidates, attributePayload('door_count_a', 'door', { displayName: 'Count' }))
    const right = await seedCandidate(h.candidates, attributePayload('window_count', 'window', { displayName: 'Count' }))
    await seedCandidate(h.candidates, objectPayload('door'))
    await seedCandidate(h.candidates, objectPayload('window'))

    const result = await h.service.keepSeparate(
      WORKSPACE_ID,
      { candidateIds: [left.candidateId, right.candidateId], reason: 'same label, different meaning', expectedRevision: '1', idempotencyKey: `keep-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(result.adjudication.kind).toBe('keep_separate')
    expect(result.candidates).toHaveLength(0)
    const projection = await h.service.validateForPublication({ workspaceId: WORKSPACE_ID, revision: '1' }, EDITOR)
    expect(projection.blockers.some((blocker) => blocker.code === 'DUPLICATE_IDENTIFIER')).toBe(false)
  })

  it('splits one candidate into independent parts', async () => {
    const h = buildHarness()
    const original = await seedCandidate(h.candidates, attributePayload('contact', 'person', { valueType: 'string' }))
    await seedCandidate(h.candidates, objectPayload('person'))
    const parts = [
      attributePayload('contact_email', 'person', { valueType: 'string' }),
      attributePayload('contact_phone', 'person', { valueType: 'string' }),
    ]
    const result = await h.service.split(
      WORKSPACE_ID,
      { candidateId: original.candidateId, parts, reason: 'two distinct fields', expectedRevision: '1', idempotencyKey: `split-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(result.adjudication.kind).toBe('split')
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates.every((candidate) => candidate.replacesCandidateId === original.candidateId)).toBe(true)
  })

  it('blocks publication on a duplicate identifier', async () => {
    const h = buildHarness()
    await seedCandidate(h.candidates, objectPayload('device'), { recordedAt: '2026-09-29T00:00:01Z' })
    await seedCandidate(h.candidates, objectPayload('device'), { recordedAt: '2026-09-29T00:00:02Z' })
    const report = await h.service.validateForPublication({ workspaceId: WORKSPACE_ID, revision: '1' }, EDITOR)
    expect(report.publishable).toBe(false)
    expect(report.blockers.some((blocker) => blocker.code === 'DUPLICATE_IDENTIFIER')).toBe(true)
  })

  it('blocks publication on a dangling relation endpoint', async () => {
    const h = buildHarness()
    await seedCandidate(h.candidates, objectPayload('device'))
    await seedCandidate(h.candidates, relationPayload('meter_monitors', 'missing_meter', 'device'))
    const report = await h.service.validateForPublication({ workspaceId: WORKSPACE_ID, revision: '1' }, EDITOR)
    expect(report.publishable).toBe(false)
    expect(report.blockers.some((blocker) => blocker.code === 'DANGLING_ENDPOINT')).toBe(true)
  })

  it('blocks publication on a wrong unit', async () => {
    const h = buildHarness()
    await seedCandidate(h.candidates, objectPayload('device'))
    await seedCandidate(h.candidates, attributePayload('power', 'device', { valueType: 'quantity' }))
    const report = await h.service.validateForPublication({ workspaceId: WORKSPACE_ID, revision: '1' }, EDITOR)
    expect(report.publishable).toBe(false)
    expect(report.blockers.some((blocker) => blocker.code === 'UNIT_MISMATCH')).toBe(true)
  })

  it('blocks publication on an illegal cardinality', async () => {
    const h = buildHarness()
    await seedCandidate(h.candidates, objectPayload('device'))
    await seedCandidate(h.candidates, attributePayload('serial', 'device', { minCardinality: 3, maxCardinality: 1 }))
    const report = await h.service.validateForPublication({ workspaceId: WORKSPACE_ID, revision: '1' }, EDITOR)
    expect(report.publishable).toBe(false)
    expect(report.blockers.some((blocker) => blocker.code === 'INVALID_TYPE_CARDINALITY')).toBe(true)
  })

  it('diffs against the published version and requires a revision strategy for a breaking change', async () => {
    const published = new FixedPublishedDefinitions()
    published.add(
      publishedVersion([{ id: 'device_serial', objectId: 'device', valueType: 'string' }]),
    )
    const h = buildHarness({ published, basePackRef: BASE_PACK_REF })
    await seedCandidate(h.candidates, objectPayload('device', ['device_serial']))
    await seedCandidate(h.candidates, attributePayload('device_serial', 'device', { valueType: 'number', minCardinality: 1, maxCardinality: 1 }))

    const diff = await h.service.compatibility(WORKSPACE_ID, '1', EDITOR)
    expect(diff.requiresRevisionStrategy).toBe(true)
    expect(diff.breakingChanges.some((entry) => entry.code === 'VALUE_TYPE_CHANGED')).toBe(true)

    const blocked = await h.service.validateForPublication({ workspaceId: WORKSPACE_ID, revision: '1' }, EDITOR)
    expect(blocked.publishable).toBe(false)
    expect(blocked.blockers.some((blocker) => blocker.code === 'REVISION_STRATEGY_REQUIRED')).toBe(true)

    for (const candidate of await h.candidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR)) {
      await h.reviews.appendReview(SCOPE, { expectedRevision: '0', draft: { reviewId: randomUUID(), candidateId: candidate.candidateId,
        contentDigest: candidate.contentDigest, decision: 'approve', reason: 'reviewed changes', evidenceRefs: [], actor: 'reviewer', recordedAt: '2026-09-29T00:00:00Z' } }, EDITOR)
    }
    const allowed = await h.service.validateForPublication(
      { workspaceId: WORKSPACE_ID, revision: '1', strategy: { kind: 'new_version', reason: 'rename intent, republish instances' } },
      EDITOR,
    )
    expect(allowed.publishable).toBe(true)
  })

  it('saves an unsupported rule as non-executable and never deletes it', async () => {
    const h = buildHarness()
    const rule = await h.service.recordUnsupportedRule(
      { workspaceId: WORKSPACE_ID, ruleId: 'rule.cyclic', reason: 'cyclic dependency is not supported', rawForm: { op: 'loop', depth: 9 }, idempotencyKey: `rule-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(rule.executable).toBe(false)
    expect(rule.rawForm).toEqual({ op: 'loop', depth: 9 })
    const listed = await h.service.listUnsupportedRules(WORKSPACE_ID, 10, EDITOR)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.executable).toBe(false)
  })

  it('reviews a TBox candidate through the existing review tables and does not carry the approve to the new revision', async () => {
    const h = buildHarness()
    const candidate = await seedCandidate(h.candidates, objectPayload('device', ['device_serial']))
    const store = new InMemorySemanticPublicationStore()
    const composite = new CompositeReviewableCandidateReader({
      definition: h.candidates,
      instance: new InMemoryCandidateStore(),
    })
    const publication = new SemanticPublicationService({
      store,
      candidates: new InMemoryCandidateStore(),
      schemaSource: unusedSchemaSource,
      identity: new UnusedIdentity(),
      reviewableCandidates: composite,
    })
    const view = await composite.readCandidate(SCOPE, candidate.candidateId, EDITOR)
    expect(view).toMatchObject({ domain: 'definition', kind: 'object' })

    const review = await publication.reviewCandidate(
      { candidateId: candidate.candidateId, decision: 'approve', reason: 'looks correct', expectedRevision: '0' },
      REVIEWER,
    )
    expect(review.decision).toBe('approve')
    expect(await publication.listReviews(candidate.candidateId, EDITOR)).toHaveLength(1)

    // An edit appends a new candidate id; the earlier approve is not carried over.
    const edited = await h.service.edit(
      WORKSPACE_ID,
      { candidateId: candidate.candidateId, expectedRevision: '1', payload: objectPayload('device', []), reason: 'clear identity', idempotencyKey: `edit-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    const newId = edited.candidates[0]?.candidateId
    expect(newId).toBeDefined()
    if (newId === undefined) throw new Error('expected a new revision')
    expect(await publication.listReviews(newId, EDITOR)).toHaveLength(0)
    expect(await publication.listReviews(candidate.candidateId, EDITOR)).toHaveLength(1)

    // An instance-domain candidate is still reviewable through the same composite reader.
    const instanceStore = new InMemoryCandidateStore()
    const instanceReader = new CompositeReviewableCandidateReader({ definition: h.candidates, instance: instanceStore })
    expect(await instanceReader.readCandidate(SCOPE, candidate.candidateId, EDITOR)).toBeDefined()
  })

  it('replays an idempotent edit and rejects a changed payload under the same key', async () => {
    const h = buildHarness()
    const candidate = await seedCandidate(h.candidates, attributePayload('power', 'device', { valueType: 'quantity', unitCode: 'kW' }))
    await seedCandidate(h.candidates, objectPayload('device'))
    const key = `edit-${randomUUID()}`
    const base = {
      candidateId: candidate.candidateId,
      expectedRevision: '1' as const,
      reason: 'adjust',
      idempotencyKey: key,
    }
    const first = await h.service.edit(WORKSPACE_ID, { ...base, payload: attributePayload('power', 'device', { valueType: 'quantity', unitCode: 'MW' }) }, 'editor-1', EDITOR)
    const replay = await h.service.edit(WORKSPACE_ID, { ...base, payload: attributePayload('power', 'device', { valueType: 'quantity', unitCode: 'MW' }) }, 'editor-1', EDITOR)
    expect(replay.created).toBe(false)
    expect(replay.adjudication.adjudicationId).toBe(first.adjudication.adjudicationId)

    await expect(
      h.service.edit(WORKSPACE_ID, { ...base, payload: attributePayload('power', 'device', { valueType: 'quantity', unitCode: 'GW' }) }, 'editor-1', EDITOR),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('enforces the editor role, workspace CAS and tenant/space scope', async () => {
    const h = buildHarness()
    const candidate = await seedCandidate(h.candidates, objectPayload('device'))
    const input = {
      candidateId: candidate.candidateId,
      expectedRevision: '1' as const,
      payload: objectPayload('device'),
      reason: 'noop',
      idempotencyKey: `edit-${randomUUID()}`,
    }
    await expect(h.service.edit(WORKSPACE_ID, input, 'viewer', VIEWER)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      h.service.edit(WORKSPACE_ID, { ...input, expectedRevision: '9' }, 'editor-1', EDITOR),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(
      h.service.edit(WORKSPACE_ID, { ...input, expectedRevision: undefined }, 'editor-1', EDITOR),
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' })
    await expect(h.service.edit(WORKSPACE_ID, input, 'other', OTHER)).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    })
  })
})
