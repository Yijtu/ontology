import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type {
  ActionDeclaration,
  AppendAssetDraftInput,
  AssetCandidateBatch,
  AssetCandidateVersion,
  AssetDraftVersion,
  DefinitionCandidatePayload,
  IndustryValidationReport,
  IndustryValidationReportStore,
  IndustryWorkspace,
  IndustryWorkspaceStore,
  ResourceRef,
  RevisionString,
  RuleActionCandidateVersion,
  ScopeRef,
  SyntheticExampleSetStore,
  SyntheticExampleSetVersion,
  ToolContext,
  Uuid,
  VersionRef,
  IndustryPackCatalogue,
} from '@ontology/contracts'
import { findIndustryPackViolations, findEmbeddedSecretViolations } from '@ontology/contracts'
import {
  InMemoryAssetCandidateStore,
  InMemoryCandidateStore,
  CompositeReviewableCandidateReader,
  createPackPublicationGuard,
  definitionApprovalPins,
  currentDefinitionProjection,
  diffDefinitionProjection,
  industryValidationDigest,
  ruleActionPublicationPins,
  currentRuleActionProjection,
  InMemoryPublishedPackAssetStore,
  InMemoryRuleActionCandidateStore,
  IndustryAssetPublicationService,
  IndustryPackExportService,
  StoreBackedIndustryManifestSource,
  StoreBackedIndustryPackCatalogue,
  buildVersionDiff,
  buildDefinitionRecord,
  resolveDefinitionPredecessor,
} from '@ontology/application'
import { InMemorySemanticDefinitionStore, InMemorySemanticPublicationStore } from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const DIGEST = `sha256:${'d'.repeat(64)}`
const EDITOR: ToolContext = toolContext(TENANT, SPACE, ['profile-editor'], 'editor-1')
const VIEWER: ToolContext = toolContext(TENANT, SPACE, ['scoped-reader'], 'viewer-1')

function digest(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function versionRef(id: string): VersionRef {
  return { id, version: '1.0.0', digest: DIGEST }
}

class EmptySyntheticExampleSetStore implements SyntheticExampleSetStore {
  async insert(): Promise<never> {
    throw new Error('not implemented in fixture')
  }

  async get(): Promise<undefined> {
    return undefined
  }

  async findByIdempotencyKey(): Promise<undefined> {
    return undefined
  }

  async list(): Promise<SyntheticExampleSetVersion[]> {
    return []
  }
}

class FixtureValidationReportStore implements IndustryValidationReportStore {
  readonly #reports = new Map<Uuid, IndustryValidationReport>()

  seed(report: IndustryValidationReport): void {
    this.#reports.set(report.validationId, report)
  }

  async insert(): Promise<never> {
    throw new Error('not implemented in fixture')
  }

  async get(_scopeRef: ScopeRef, _workspaceId: Uuid, validationId: Uuid): Promise<IndustryValidationReport | undefined> {
    void _scopeRef
    void _workspaceId
    return this.#reports.get(validationId)
  }

  async findByIdempotencyKey(): Promise<undefined> {
    return undefined
  }

  async list(): Promise<IndustryValidationReport[]> {
    return [...this.#reports.values()]
  }
}

class FixtureWorkspaceStore implements IndustryWorkspaceStore {
  readonly #workspaces = new Map<string, IndustryWorkspace>()
  readonly #drafts = new Map<string, AssetDraftVersion>()

  seed(workspace: IndustryWorkspace): void {
    this.#workspaces.set(workspace.workspaceId, workspace)
  }
  seedDraft(draft: AssetDraftVersion): void {
    this.#drafts.set(draft.workspaceId, draft)
  }

  advanceHead(workspaceId: Uuid, revision: RevisionString, packRef: VersionRef): void {
    const current = this.#workspaces.get(workspaceId)
    if (current === undefined) return
    this.#workspaces.set(workspaceId, { ...current, headRevision: revision, state: 'published', latestPublishedPackRef: packRef })
  }

  async createWorkspace(): Promise<never> {
    throw new Error('not implemented in fixture')
  }

  async getWorkspace(_scopeRef: ScopeRef, workspaceId: Uuid): Promise<IndustryWorkspace | undefined> {
    return this.#workspaces.get(workspaceId)
  }

  async listWorkspaces(): Promise<IndustryWorkspace[]> {
    return [...this.#workspaces.values()]
  }

  async getDraft(): Promise<undefined> {
    return undefined
  }

  async listDrafts(_scope: ScopeRef, workspaceId: Uuid): Promise<AssetDraftVersion[]> {
    void _scope
    const draft = this.#drafts.get(workspaceId)
    return draft === undefined ? [] : [draft]
  }

  async appendDraft(_s: ScopeRef, _w: Uuid, _i: AppendAssetDraftInput, _c: ToolContext): Promise<never> {
    void _s
    void _w
    void _i
    void _c
    throw new Error('not implemented in fixture')
  }
}

function definitionCandidate(
  batchId: Uuid,
  logicalId: string,
  payload: DefinitionCandidatePayload,
  recordedAt: string,
): AssetCandidateVersion {
  return {
    candidateId: randomUUID(),
    batchId,
    workspaceId: WORKSPACE_ID,
    logicalId,
    domain: 'definition',
    kind: payload.kind,
    payload,
    inputDraftRef: { workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST },
    sourceRefs: [resourceRef()],
    sourceSpans: [],
    state: 'produced',
    issues: [],
    pendingConfirmation: false,
    contentDigest: DIGEST,
    idempotencyKey: digest(`${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`),
    recordedAt,
  }
}

function batch(batchId: Uuid, total: number): AssetCandidateBatch {
  return {
    batchId,
    workspaceId: WORKSPACE_ID,
    domain: 'definition',
    inputDraftRef: { workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST },
    modelRef: { modelId: 'fixture-model', version: '1.0.0' },
    responseSchemaRef: versionRef('tbox-response'),
    documentSetRef: resourceRef(),
    generationPolicyRef: versionRef('tbox-policy'),
    state: 'completed',
    counts: { total, produced: total, pendingConfirmation: 0, pendingReview: 0, failed: 0 },
    idempotencyKey: `batch-${randomUUID()}`,
    requestDigest: DIGEST,
    createdBy: 'editor-1',
    recordedAt: '2026-09-29T00:00:00Z',
  }
}

function unboundDeclaration(): ActionDeclaration {
  return {
    actionId: 'action.plan_charge',
    displayName: 'Plan charge',
    businessMeaning: 'plan a charge schedule',
    suggestedReason: 'reviewed source',
    inputSchemaRef: versionRef('plan.input'),
    outputSchemaRef: versionRef('plan.output'),
    preconditions: [],
    requiredCapabilities: [{ name: 'compute.plan', versionRange: { min: '1.0.0' } }],
    permissions: ['compute:plan'],
    readOnly: true,
    sideEffect: 'read_only',
    evidenceRequirements: ['computation'],
  }
}

function actionCandidate(recordedAt: string): RuleActionCandidateVersion {
  return {
    candidateId: randomUUID(),
    workspaceId: WORKSPACE_ID,
    logicalId: 'action.plan_charge',
    domain: 'definition',
    kind: 'action',
    displayName: 'Plan charge',
    businessMeaning: 'plan a charge schedule',
    suggestedReason: 'reviewed source',
    payload: { kind: 'action', declaration: unboundDeclaration() },
    sourceRefs: [resourceRef()],
    sourceSpans: [],
    lifecycle: 'enabled',
    enabledAt: recordedAt,
    contentDigest: DIGEST,
    idempotencyKey: digest(`${randomUUID().replaceAll('-', '')}${randomUUID().replaceAll('-', '')}`),
    actor: 'editor-1',
    recordedAt,
  }
}

function validationReport(
  overrides: Partial<IndustryValidationReport> = {},
): IndustryValidationReport {
  const exampleSetId = randomUUID()
  return {
    validationId: randomUUID(),
    workspaceId: WORKSPACE_ID,
    revision: '1',
    exampleSetId,
    exampleSetRef: { id: exampleSetId, version: '1.0.0', digest: DIGEST, kind: 'dataset' },
    dataMode: 'synthetic',
    isolationLabel: 'synthetic test',
    businessApproval: 'none',
    realFactsWritten: false,
    rules: [],
    actions: [
      {
        candidateId: randomUUID(),
        actionId: 'action.plan_charge',
        bindingStatus: 'not_executable',
        semanticPublished: true,
        deploymentExecutable: false,
        findings: [],
        requiredCapabilities: [{ name: 'compute.plan', versionRange: { min: '1.0.0' } }],
        missingCapabilities: ['compute.plan'],
        trials: [],
        coveredCaseIds: [],
      },
    ],
    semanticPublished: { passed: true, blockers: [] },
    deploymentExecutable: {
      passed: false,
      blockers: [{ code: 'ACTION_NOT_EXECUTABLE', surface: 'deployment', message: 'action is unbound' }],
    },
    publishable: false,
    gate: 'blocked_execution',
    issues: [],
    expectationResults: [
      {
        expectationId: 'e1',
        caseId: 'case-1',
        kind: 'action',
        targetId: 'action.plan_charge',
        expected: 'blocked',
        actual: 'blocked',
        matched: true,
        origin: 'authored_oracle',
        independent: true,
      },
    ],
    coverage: [],
    contentDigest: DIGEST,
    idempotencyKey: `validation-${randomUUID()}`,
    actor: 'editor-1',
    recordedAt: '2026-09-29T00:00:00Z',
    ...overrides,
  }
}

interface Harness {
  readonly clock: { now: () => string }
  readonly workspaces: FixtureWorkspaceStore
  readonly definitions: InMemorySemanticDefinitionStore
  readonly published: InMemoryPublishedPackAssetStore
  readonly reports: FixtureValidationReportStore
  readonly service: IndustryAssetPublicationService
  readonly catalogue: StoreBackedIndustryPackCatalogue
  readonly manifestSource: StoreBackedIndustryManifestSource
  readonly exporter: IndustryPackExportService
  seedWorkspace(): void
  seedDefinitionCandidates(): Promise<void>
  seedAction(): Promise<void>
  seedReport(report: IndustryValidationReport): Promise<void>
  readonly candidates: InMemoryAssetCandidateStore
  readonly reviews: InMemorySemanticPublicationStore
  readonly ruleActions: InMemoryRuleActionCandidateStore
}

function harness(baseCatalogue?: IndustryPackCatalogue): Harness {
  let tick = 0
  const now = (): string => {
    tick += 1
    return new Date(Date.UTC(2026, 8, 29, 0, 0, tick)).toISOString()
  }
  const workspaces = new FixtureWorkspaceStore()
  const definitionCandidates = new InMemoryAssetCandidateStore()
  const ruleActions = new InMemoryRuleActionCandidateStore()
  const syntheticSets = new EmptySyntheticExampleSetStore()
  const reviews = new InMemorySemanticPublicationStore()
  const reviewableCandidates = new CompositeReviewableCandidateReader({ definition: definitionCandidates, instance: new InMemoryCandidateStore() })
  const definitions = new InMemorySemanticDefinitionStore()
  const published = new InMemoryPublishedPackAssetStore({
    definitions,
    publicationGuard: createPackPublicationGuard({ workspaces, definitionCandidates, ruleActions, reviews, reviewableCandidates }),
    onPublished: (scopeRef, workspaceId, revision, packRef) => {
      void scopeRef
      workspaces.advanceHead(workspaceId, revision, packRef)
    },
  })
  const reports = new FixtureValidationReportStore()

  const service = new IndustryAssetPublicationService({
    ...(baseCatalogue === undefined ? {} : { baseCatalogue }),
    workspaces,
    reviews, reviewableCandidates,
    validations: reports,
    definitionCandidates,
    ruleActions,
    syntheticSets,
    definitions,
    store: published,
    now,
    newId: () => randomUUID(),
  })
  const catalogue = new StoreBackedIndustryPackCatalogue({ store: published })
  const manifestSource = new StoreBackedIndustryManifestSource({ store: published })
  const exporter = new IndustryPackExportService({ catalogue, definitions, published, now })

  const seedWorkspace = (): void => {
    const workspace: IndustryWorkspace = {
      workspaceId: WORKSPACE_ID,
      namespace: 'demo-industry',
      displayName: 'Demo industry',
      boundary: { goals: [], included: [], excluded: [], applicability: {} },
      headRevision: '1',
      state: 'draft',
    }
    workspaces.seed(workspace)
  }

  const seedDefinitionCandidates = async (): Promise<void> => {
    const batchId = randomUUID()
    const candidates = [
      definitionCandidate(batchId, 'device', {
        kind: 'object',
        logicalId: 'device',
        displayName: 'Device',
        businessMeaning: 'a monitored device',
        suggestedReason: 'source',
        conflicts: [],
        identityAttributeIds: ['device_id'],
      }, '2026-09-29T00:00:01Z'),
      definitionCandidate(batchId, 'device_id', {
        kind: 'attribute',
        logicalId: 'device_id',
        displayName: 'Device id',
        businessMeaning: 'stable device identifier',
        suggestedReason: 'source',
        conflicts: [],
        objectLogicalId: 'device',
        valueType: 'string',
        minCardinality: 1,
        maxCardinality: 1,
      }, '2026-09-29T00:00:02Z'),
      definitionCandidate(batchId, 'power', {
        kind: 'attribute',
        logicalId: 'power',
        displayName: 'Power',
        businessMeaning: 'rated power',
        suggestedReason: 'source',
        conflicts: [],
        objectLogicalId: 'device',
        valueType: 'quantity',
        unitCode: 'kW',
        dimension: 'power',
        minCardinality: 0,
        maxCardinality: 1,
      }, '2026-09-29T00:00:03Z'),
    ]
    await definitionCandidates.insertBatch(SCOPE, batch(batchId, candidates.length), candidates, EDITOR)
    for (const candidate of candidates) await reviews.appendReview(SCOPE, { expectedRevision: '0', draft: {
      reviewId: randomUUID(), candidateId: candidate.candidateId, contentDigest: candidate.contentDigest, decision: 'approve',
      reason: 'reviewed declaration', evidenceRefs: [], recordedAt: now(), actor: 'reviewer-1',
    } }, EDITOR)
  }

  const seedAction = async (): Promise<void> => {
    await ruleActions.insert(SCOPE, actionCandidate('2026-09-29T00:00:04Z'), EDITOR)
  }

  const seedReport = async (report: IndustryValidationReport): Promise<void> => {
    const projection = currentDefinitionProjection(await definitionCandidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR))
    const approvals = await definitionApprovalPins(projection, SCOPE, EDITOR, reviewableCandidates, reviews)
    const workspace = await workspaces.getWorkspace(SCOPE, WORKSPACE_ID)
    if (workspace === undefined) throw new Error('fixture workspace is missing')
    const draft = (await workspaces.listDrafts(SCOPE, WORKSPACE_ID)).at(-1)
    const prior = await resolveDefinitionPredecessor({ definitions, publishedPacks: published,
      ...(baseCatalogue === undefined ? {} : { baseCatalogue }) }, workspace, draft, SCOPE, EDITOR)
    const previous = prior?.definition
    const actionIds = new Map((await ruleActions.list(SCOPE, WORKSPACE_ID, {}, EDITOR)).filter((candidate) => candidate.payload.kind === 'action').map((candidate) => [candidate.logicalId, candidate.candidateId]))
    const pinned: IndustryValidationReport = { ...report,
      actions: report.actions.map((result) => ({ ...result, candidateId: actionIds.get(result.actionId) ?? result.candidateId })),
      definition: { workspaceId: WORKSPACE_ID, revision: report.revision, checkedCandidateIds: projection.map((candidate) => candidate.candidateId),
        approvalPins: approvals.pins, blockers: approvals.blockers, warnings: [], nonExecutableRules: [], publishable: approvals.blockers.length === 0,
        compatibility: diffDefinitionProjection(projection, previous, { workspaceId: WORKSPACE_ID, revision: report.revision,
          ...(previous === undefined ? {} : { publishedRef: previous.ref }), ...(report.strategy === undefined ? {} : { strategy: report.strategy }) }) },
      ruleActionPins: ruleActionPublicationPins(currentRuleActionProjection(await ruleActions.list(SCOPE, WORKSPACE_ID, {}, EDITOR))),
    }
    reports.seed({ ...pinned, contentDigest: industryValidationDigest(pinned) })
  }

  return {
    clock: { now },
    workspaces,
    definitions,
    published,
    reports,
    service,
    catalogue,
    manifestSource,
    exporter,
    candidates: definitionCandidates, reviews, ruleActions,
    seedWorkspace,
    seedDefinitionCandidates,
    seedAction,
    seedReport,
  }
}

async function seedAll(h: Harness): Promise<IndustryValidationReport> {
  h.seedWorkspace()
  await h.seedDefinitionCandidates()
  await h.seedAction()
  const report = validationReport()
  await h.seedReport(report)
  return report
}

function publishFixture(h: Harness, report: IndustryValidationReport, overrides: Partial<Parameters<IndustryAssetPublicationService['publish']>[1]> = {}) {
  return h.service.publish(WORKSPACE_ID, { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId,
    expectedRevision: report.revision, idempotencyKey: `publish-${randomUUID()}`, ...overrides }, 'editor-1', EDITOR)
}

describe('content-pinned publication approvals', () => {
  it('uses the workspace predecessor even when a namespace peer is newer and the list page omits its own version', async () => {
    const own = harness()
    const first = await publishFixture(own, await seedAll(own))
    const peer = harness()
    const peerAsset = await publishFixture(peer, await seedAll(peer), { packId: 'peer-pack', version: '2.0.0' })
    const report = validationReport({ revision: '2' })
    await own.seedReport(report)
    const list = vi.spyOn(own.published, 'listPacks').mockResolvedValue([peerAsset])
    const find = vi.spyOn(own.published, 'findByRef')
    try {
      const next = await publishFixture(own, report, { version: '3.0.0' })
      expect(next.diff.fromPackRef).toEqual(first.packRef)
      expect(find).toHaveBeenCalledWith(SCOPE, first.packRef, EDITOR)
      expect(next.diff.breakingChanges).toEqual([])
    } finally {
      list.mockRestore()
      find.mockRestore()
    }
  })

  it('rejects a workspace pointer with the wrong digest instead of choosing a namespace fallback', async () => {
    const h = harness()
    const first = await publishFixture(h, await seedAll(h))
    const report = validationReport({ revision: '2' })
    await h.seedReport(report)
    const workspace = (await h.workspaces.getWorkspace(SCOPE, WORKSPACE_ID))!
    h.workspaces.seed({ ...workspace, latestPublishedPackRef: { ...first.packRef, digest: digest('b') } })
    await expect(publishFixture(h, report, { version: '2.0.0' })).rejects.toMatchObject({ code: 'VALIDATION_STALE' })
  })

  it('publishes against its exact current pointer after the predecessor falls outside a 100-version catalogue page', async () => {
    const h = harness()
    let current = await publishFixture(h, await seedAll(h))
    for (let version = 2; version <= 101; version += 1) {
      const report = validationReport({ revision: String(version) })
      await h.seedReport(report)
      current = await publishFixture(h, report, { version: `${String(version)}.0.0` })
    }
    const page = await h.published.listPacks(SCOPE, { namespace: 'demo-industry', limit: 100 }, EDITOR)
    expect(page.map((asset) => asset.packRef)).not.toContainEqual(current.packRef)
    const report = validationReport({ revision: '102' })
    await h.seedReport(report)
    const next = await publishFixture(h, report, { version: '102.0.0' })
    expect(next.diff.fromPackRef).toEqual(current.packRef)
  })

  it.each(['definition', 'catalogue'] as const)('resolves an exact static %s base pin for initial publication', async (kind) => {
    const source = harness()
    const sourceAsset = await publishFixture(source, await seedAll(source))
    const version = await source.definitions.findVersion('demo-industry', sourceAsset.definitionRef.id, sourceAsset.definitionRef.version, SCOPE, EDITOR)
    if (version === undefined) throw new Error('base definition missing')
    const baseCatalogue: IndustryPackCatalogue = { listEntries: async () => [{ kind: 'registered_pack', asset: sourceAsset.packAsset }],
      findPack: async () => sourceAsset.packAsset }
    const h = harness(kind === 'catalogue' ? baseCatalogue : undefined)
    h.seedWorkspace()
    await h.seedDefinitionCandidates()
    await h.seedAction()
    await h.definitions.insertVersion(SCOPE, version, { digest: version.ref.digest, payloadDigest: DIGEST,
      idempotencyKey: `base-${randomUUID()}`, actor: 'seed', occurredAt: h.clock.now() }, EDITOR)
    const basePackRef = kind === 'catalogue' ? sourceAsset.packRef : version.ref
    h.workspaces.seedDraft({ workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST, documentSetRef: resourceRef(), candidateRefs: [], basePackRef })
    const report = validationReport()
    await h.seedReport(report)
    const next = await publishFixture(h, report, { version: '2.0.0' })
    expect(next.diff.fromPackRef).toEqual(basePackRef)
    expect(next.diff.breakingChanges).toEqual([])
    const definition = await h.definitions.findVersion('demo-industry', next.definitionRef.id, next.definitionRef.version, SCOPE, EDITOR)
    expect(definition?.baseRef).toEqual(basePackRef)
  })

  it.each(['failed', 'pending_confirmation', 'rejected'] as const)('refuses an approved candidate in %s state', async (state) => {
    const h = harness()
    const report = await seedAll(h)
    const candidate = (await h.candidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR))[0]!
    await h.candidates.transitionCandidate(SCOPE, candidate.candidateId, { state, issues: [], transitionedAt: h.clock.now() }, EDITOR)
    await expect(publishFixture(h, report)).rejects.toMatchObject({ code: state === 'rejected' ? 'VALIDATION_STALE' : 'VALIDATION_BLOCKED' })
  })

  it.each(['reject', 'legacy_approve', 'wrong_digest'] as const)('refuses the current %s ledger decision', async (decision) => {
    const h = harness()
    const report = await seedAll(h)
    const candidate = (await h.candidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR))[0]!
    await h.reviews.appendReview(SCOPE, { expectedRevision: '1', draft: { reviewId: randomUUID(), candidateId: candidate.candidateId,
      ...(decision === 'legacy_approve' ? {} : { contentDigest: decision === 'wrong_digest' ? digest('a') : candidate.contentDigest }),
      decision: decision === 'reject' ? 'reject' : 'approve', reason: 'review changed', evidenceRefs: [], actor: 'reviewer', recordedAt: h.clock.now() } }, EDITOR)
    await expect(publishFixture(h, report)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
    expect(await h.reviews.getReview(SCOPE, candidate.candidateId, '1', EDITOR)).toMatchObject({ decision: 'approve', contentDigest: candidate.contentDigest })
  })

  it('keeps an unapproved replacement visible in the draft and invalidates the old approval', async () => {
    const h = harness()
    const report = await seedAll(h)
    const original = (await h.candidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR))[0]!
    const batchId = randomUUID()
    const replacement = { ...definitionCandidate(batchId, original.logicalId, original.payload, h.clock.now()), replacesCandidateId: original.candidateId }
    await h.candidates.insertBatch(SCOPE, batch(batchId, 1), [replacement], EDITOR)
    const projection = currentDefinitionProjection(await h.candidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR))
    expect(projection.map((candidate) => candidate.candidateId)).toContain(replacement.candidateId)
    expect(projection.map((candidate) => candidate.candidateId)).not.toContain(original.candidateId)
    await expect(publishFixture(h, report)).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
    expect(await h.reviews.getReview(SCOPE, original.candidateId, '1', EDITOR)).toMatchObject({ decision: 'approve' })
  })

  it.each(['draft', 'rejected'] as const)('does not fall back to an enabled rule/action ancestor when its latest revision is %s', async (lifecycle) => {
    const h = harness()
    const report = await seedAll(h)
    const original = (await h.ruleActions.list(SCOPE, WORKSPACE_ID, {}, EDITOR))[0]!
    const { enabledAt, ...draftOriginal } = original
    void enabledAt
    const replacement = { ...draftOriginal, candidateId: randomUUID(), lifecycle,
      replacesCandidateId: original.candidateId, recordedAt: h.clock.now(), idempotencyKey: digest('b') }
    await h.ruleActions.insert(SCOPE, replacement, EDITOR)
    await expect(publishFixture(h, report)).rejects.toMatchObject({ code: 'VALIDATION_STALE' })
    await h.seedReport(report)
    const asset = await publishFixture(h, report)
    expect(asset.capabilities.actions).toEqual([])
    expect(asset.ruleActionPins).toEqual([])
  })

  it('invalidates validation when approval changes even to another approve', async () => {
    const h = harness()
    const report = await seedAll(h)
    const candidate = (await h.candidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR))[0]!
    await h.reviews.appendReview(SCOPE, { expectedRevision: '1', draft: { reviewId: randomUUID(), candidateId: candidate.candidateId,
      contentDigest: candidate.contentDigest, decision: 'approve', reason: 'new decision', evidenceRefs: [], actor: 'reviewer', recordedAt: h.clock.now() } }, EDITOR)
    await expect(publishFixture(h, report)).rejects.toMatchObject({ code: 'VALIDATION_STALE' })
  })

  it.each(['new_version', 'keep_independent', 'retire_previous'] as const)('carries %s strategy into publication while preserving the prior asset', async (kind) => {
    const h = harness()
    const first = await seedAll(h)
    const previous = await publishFixture(h, first)
    const original = (await h.candidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR)).find((candidate) => candidate.logicalId === 'power')!
    const batchId = randomUUID()
    const changed = { ...definitionCandidate(batchId, 'power', { kind: 'attribute', logicalId: 'power', displayName: 'Power label',
      businessMeaning: 'a label', suggestedReason: 'reviewed', conflicts: [], objectLogicalId: 'device', valueType: 'string', minCardinality: 0, maxCardinality: 1 }, h.clock.now()),
      replacesCandidateId: original.candidateId }
    await h.candidates.insertBatch(SCOPE, batch(batchId, 1), [changed], EDITOR)
    await h.reviews.appendReview(SCOPE, { expectedRevision: '0', draft: { reviewId: randomUUID(), candidateId: changed.candidateId,
      contentDigest: changed.contentDigest, decision: 'approve', reason: 'reviewed', evidenceRefs: [], actor: 'reviewer', recordedAt: h.clock.now() } }, EDITOR)
    const noStrategy = validationReport({ revision: '2' })
    await h.seedReport(noStrategy)
    await expect(publishFixture(h, noStrategy, { version: '2.0.0' })).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
    const strategy = { kind, reason: 'explicit revision decision', ...(kind === 'retire_previous' ? { supersedesRef: previous.definitionRef } : {}) }
    const report = validationReport({ revision: '2', strategy })
    await h.seedReport(report)
    await expect(publishFixture(h, report, { version: '2.0.0' })).rejects.toMatchObject({ code: 'VALIDATION_STALE' })
    const asset = await publishFixture(h, report, { version: '2.0.0', strategy, packId: kind === 'keep_independent' ? 'independent-pack' : 'demo-pack' })
    expect(asset.strategy).toEqual(strategy)
    expect(asset.diff.breakingChanges.map((change) => change.change)).toContain('VALUE_TYPE_CHANGED')
    expect(await h.published.findByRef(SCOPE, previous.packRef, EDITOR)).toEqual(previous)
  })

  it.each(['blank_reason', 'same_version', 'same_identity', 'wrong_predecessor'] as const)('blocks an invalid strategy: %s', async (failure) => {
    const h = harness()
    const first = await seedAll(h)
    await publishFixture(h, first)
    const strategy = failure === 'same_identity' ? { kind: 'keep_independent' as const, reason: 'independent' }
      : failure === 'wrong_predecessor' ? { kind: 'retire_previous' as const, reason: 'retire', supersedesRef: versionRef('other') }
      : { kind: 'new_version' as const, reason: failure === 'blank_reason' ? ' ' : 'version' }
    const report = validationReport({ revision: '2', strategy })
    await h.seedReport(report)
    await expect(publishFixture(h, report, { version: failure === 'same_version' ? '1.0.0' : '2.0.0', strategy })).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
  })

  it('uses the same complete semantic diff in editing and pack publication', async () => {
    const h = harness()
    const report = await seedAll(h)
    const priorAsset = await publishFixture(h, report)
    const base = await h.candidates.listCandidates(SCOPE, WORKSPACE_ID, {}, EDITOR)
    const relation = definitionCandidate(randomUUID(), 'linked', { kind: 'relation', logicalId: 'linked', displayName: 'Linked', businessMeaning: '', suggestedReason: '', conflicts: [],
      fromObjectLogicalId: 'device', toObjectLogicalId: 'device', minCardinality: 0, maxCardinality: 'unbounded' }, h.clock.now())
    const refAttribute = definitionCandidate(randomUUID(), 'owner', { kind: 'attribute', logicalId: 'owner', displayName: 'Owner', businessMeaning: '', suggestedReason: '', conflicts: [],
      objectLogicalId: 'device', valueType: 'reference', referencesObjectLogicalId: 'device', minCardinality: 0, maxCardinality: 'unbounded' }, h.clock.now())
    const before = [...base, relation, refAttribute]
    const after = before.filter((candidate) => candidate.logicalId !== 'device_id').map((candidate): AssetCandidateVersion => {
      const payload = candidate.payload
      if (payload.kind === 'object') return { ...candidate, payload: { ...payload, identityAttributeIds: [] } }
      if (payload.kind === 'relation') return { ...candidate, payload: { ...payload, toObjectLogicalId: 'other', minCardinality: 1, maxCardinality: 1 } }
      const { unitCode, dimension, ...withoutUnit } = payload
      void unitCode; void dimension
      return { ...candidate, payload: { ...withoutUnit, objectLogicalId: 'other', minCardinality: 1, maxCardinality: 1,
        ...(payload.valueType === 'reference' ? { referencesObjectLogicalId: 'other' } : { valueType: 'number' }) } }
    })
    const workspace = (await h.workspaces.getWorkspace(SCOPE, WORKSPACE_ID))!
    const record = (projection: readonly AssetCandidateVersion[]) => buildDefinitionRecord({ workspace, scopeRef: SCOPE, definitionId: 'diff', version: '1.0.0',
      projection, standardProvenance: [], publishedAt: h.clock.now() })
    const prior = record(before)
    const editing = diffDefinitionProjection(after, prior, { workspaceId: WORKSPACE_ID, revision: '1' })
    const diff = buildVersionDiff({ toPackRef: versionRef('next'), from: { definition: prior,
      asset: priorAsset },
      toDefinition: record(after), toCapabilities: { semanticPublished: true, deploymentExecutable: true, requiredCapabilities: [], missingCapabilities: [], actions: [] } })
    expect(diff.changes.filter((change) => change.scope === 'definition').map((change) => change.change).sort())
      .toEqual([...editing.additions, ...editing.changes].map((change) => change.code).sort())
    expect(editing.breakingChanges.map((change) => change.code)).toEqual(expect.arrayContaining([
      'IDENTITY_CHANGED', 'REFERENCE_CHANGED', 'ATTRIBUTE_CHANGED', 'VALUE_TYPE_CHANGED', 'UNIT_CHANGED', 'RELATION_CHANGED', 'CARDINALITY_CHANGED', 'ATTRIBUTE_REMOVED',
    ]))
  })
})

describe('industry asset publication', () => {
  it('publishes an immutable pack, pins declarations/source index and keeps the two surfaces separate', async () => {
    const h = harness()
    const report = await seedAll(h)
    const asset = await h.service.publish(
      WORKSPACE_ID,
      {
        packId: 'demo-pack',
        version: '1.0.0',
        validationId: report.validationId,
        expectedRevision: '1',
        idempotencyKey: `publish-${randomUUID()}`,
      },
      'editor-1',
      EDITOR,
    )

    expect(asset.packRef.id).toBe('demo-industry.demo-pack')
    expect(asset.definitionRef.id).toBe('demo-industry.demo-pack')
    expect(asset.manifest.definitionsRef).toEqual(asset.definitionRef)
    expect(asset.maturity).toBe('preview')
    expect(asset.revision).toBe('2')
    // Semantic surface passes, deployment surface does not: the two stay independent.
    expect(asset.capabilities.semanticPublished).toBe(true)
    expect(asset.capabilities.deploymentExecutable).toBe(false)
    expect(asset.capabilities.actions).toHaveLength(1)
    expect(asset.capabilities.actions[0]?.executable).toBe(false)
    expect(asset.capabilities.missingCapabilities).toContain('compute.plan')
    expect(asset.manifest.requiredCapabilities.map((entry) => entry.name)).toContain('compute.plan')
    // Source index entries are authorized refs only; no customer full text is present.
    expect(asset.sourceIndex.entries.length).toBeGreaterThan(0)
    expect(asset.sourceIndex.entries.every((entry) => typeof entry.ref.id === 'string')).toBe(true)
    expect(findIndustryPackViolations(asset.packAsset)).toEqual([])
    expect(findEmbeddedSecretViolations(asset)).toEqual([])
    // The workspace publish pointer advanced to the new revision.
    const workspace = await h.workspaces.getWorkspace(SCOPE, WORKSPACE_ID)
    expect(workspace?.headRevision).toBe('2')
    expect(workspace?.latestPublishedPackRef).toEqual(asset.packRef)
  })

  it('replays the stored asset for the same Idempotency-Key', async () => {
    const h = harness()
    const report = await seedAll(h)
    const key = `publish-${randomUUID()}`
    const first = await h.service.publish(
      WORKSPACE_ID,
      { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId, expectedRevision: '1', idempotencyKey: key },
      'editor-1',
      EDITOR,
    )
    const replay = await h.service.publish(
      WORKSPACE_ID,
      { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId, expectedRevision: '1', idempotencyKey: key },
      'editor-1',
      EDITOR,
    )
    expect(replay.packRef).toEqual(first.packRef)
    expect(replay.contentDigest).toBe(first.contentDigest)
  })

  it('blocks publication when the semantic surface failed', async () => {
    const h = harness()
    h.seedWorkspace()
    await h.seedDefinitionCandidates()
    const report = validationReport({
      semanticPublished: {
        passed: false,
        blockers: [{ code: 'DEFINITION_BLOCKER', surface: 'semantic', message: 'duplicate identifier' }],
      },
      deploymentExecutable: { passed: true, blockers: [] },
      gate: 'blocked_semantic',
    })
    await h.seedReport(report)
    await expect(
      h.service.publish(
        WORKSPACE_ID,
        { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId, expectedRevision: '1', idempotencyKey: `publish-${randomUUID()}` },
        'editor-1',
        EDITOR,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
  })

  it('blocks an unexecutable pack only when the caller demands full executability', async () => {
    const h = harness()
    const report = await seedAll(h)
    await expect(
      h.service.publish(
        WORKSPACE_ID,
        {
          packId: 'demo-pack',
          version: '1.0.0',
          validationId: report.validationId,
          expectedRevision: '1',
          idempotencyKey: `publish-${randomUUID()}`,
          requireDeploymentExecutable: true,
        },
        'editor-1',
        EDITOR,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_BLOCKED' })
  })

  it('refuses a stale validation and a stale workspace head', async () => {
    const h = harness()
    const report = await seedAll(h)
    const stale = validationReport({ validationId: randomUUID(), revision: '0' })
    await h.seedReport(stale)
    await expect(
      h.service.publish(
        WORKSPACE_ID,
        { packId: 'demo-pack', version: '1.0.0', validationId: stale.validationId, expectedRevision: '1', idempotencyKey: `publish-${randomUUID()}` },
        'editor-1',
        EDITOR,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_STALE' })
    await expect(
      h.service.publish(
        WORKSPACE_ID,
        { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId, expectedRevision: '9', idempotencyKey: `publish-${randomUUID()}` },
        'editor-1',
        EDITOR,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('refuses a namespace/version collision with different content', async () => {
    const h = harness()
    const report = await seedAll(h)
    await h.service.publish(
      WORKSPACE_ID,
      { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId, expectedRevision: '1', idempotencyKey: `publish-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    // A second pack in the same namespace claiming the same version is refused.
    const second = validationReport({ validationId: randomUUID(), revision: '2' })
    await h.seedReport(second)
    await expect(
      h.service.publish(
        WORKSPACE_ID,
        { packId: 'another-pack', version: '1.0.0', validationId: second.validationId, expectedRevision: '2', idempotencyKey: `publish-${randomUUID()}` },
        'editor-1',
        EDITOR,
      ),
    ).rejects.toMatchObject({ code: 'NAMESPACE_CONFLICT' })
  })

  it('requires the editor role', async () => {
    const h = harness()
    const report = await seedAll(h)
    await expect(
      h.service.publish(
        WORKSPACE_ID,
        { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId, expectedRevision: '1', idempotencyKey: `publish-${randomUUID()}` },
        'viewer',
        VIEWER,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('dynamic package catalogue', () => {
  it('lists and re-mounts a newly published pack without a static registration', async () => {
    const h = harness()
    const report = await seedAll(h)
    const asset = await h.service.publish(
      WORKSPACE_ID,
      { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId, expectedRevision: '1', idempotencyKey: `publish-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )

    const found = await h.catalogue.findPack(asset.packRef.id, '1.0.0', SCOPE, EDITOR)
    expect(found?.ref).toEqual(asset.packRef)
    const entries = await h.catalogue.listEntries(SCOPE, EDITOR)
    expect(entries.some((entry) => entry.kind === 'registered_pack' && entry.asset.ref.id === asset.packRef.id)).toBe(true)
    const manifest = await h.manifestSource.getManifest(asset.packRef, SCOPE, EDITOR)
    expect(manifest?.definitionsRef).toEqual(asset.definitionRef)
  })
})

describe('dynamic pack export', () => {
  it('exports the source index, action declarations, capability state and version diff without customer data', async () => {
    const h = harness()
    const report = await seedAll(h)
    const asset = await h.service.publish(
      WORKSPACE_ID,
      { packId: 'demo-pack', version: '1.0.0', validationId: report.validationId, expectedRevision: '1', idempotencyKey: `publish-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    const bundle = await h.exporter.export(
      { scopeRef: SCOPE, packId: asset.packRef.id, version: asset.packRef.version },
      EDITOR,
    )
    expect(bundle.definitions?.objects.map((object) => object.id)).toContain('device')
    expect(bundle.sourceIndex?.entries.length).toBeGreaterThan(0)
    expect(bundle.actionDeclarations).toHaveLength(1)
    expect(bundle.capabilityStatus?.semanticPublished).toBe(true)
    expect(bundle.capabilityStatus?.deploymentExecutable).toBe(false)
    expect(bundle.versionDiff?.toPackRef).toEqual(asset.packRef)
    expect(findIndustryPackViolations(bundle)).toEqual([])
    expect(findEmbeddedSecretViolations(bundle)).toEqual([])
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(TENANT)
    expect(serialized).not.toContain(SPACE)
    expect(serialized).not.toContain('://')
  })
})

describe('pack version diff', () => {
  it('marks a removed object as a breaking change', () => {
    const toPackRef = versionRef('demo-industry.demo-pack')
    const definition = (objectId: string): Parameters<typeof buildVersionDiff>[0]['toDefinition'] => ({
      ref: versionRef('demo-industry.demo-pack'),
      publishedAt: '2026-09-29T00:00:00Z',
      definitionId: 'demo-industry.demo-pack',
      version: '2.0.0',
      namespace: 'demo-industry',
      layer: 'industry_core',
      standardProvenance: [],
      objects: [
        {
          kind: 'object',
          id: objectId,
          namespace: 'demo-industry',
          displayName: objectId,
          identityScopeId: `${objectId}.identity`,
          standardProvenance: [],
        },
      ],
      attributes: [],
      relations: [],
      identityScopes: [],
      ruleConstraints: [],
    })
    const previous = {
      definition: definition('device'),
      asset: {
        packRef: versionRef('demo-industry.demo-pack'),
        workspaceId: WORKSPACE_ID,
        namespace: 'demo-industry',
        maturity: 'preview' as const,
        maturityLabel: 'experimental' as const,
        manifest: {} as never,
        packAsset: {} as never,
        definitionRef: versionRef('demo-industry.demo-pack'),
        validationRef: resourceRef(),
        sourceIndex: { packRef: versionRef('demo-industry.demo-pack'), entries: [], digest: DIGEST },
        capabilities: { semanticPublished: true, deploymentExecutable: false, requiredCapabilities: [], missingCapabilities: [], actions: [] },
        diff: { toPackRef, changes: [], breakingChanges: [], digest: DIGEST },
        revision: '1',
        contentDigest: DIGEST,
        idempotencyKey: 'x',
        actor: 'editor-1',
        publishedAt: '2026-09-29T00:00:00Z',
      },
    }
    const diff = buildVersionDiff({
      toPackRef,
      from: previous,
      toDefinition: definition('other'),
      toCapabilities: { semanticPublished: true, deploymentExecutable: false, requiredCapabilities: [], missingCapabilities: [], actions: [] },
    })
    expect(diff.breakingChanges.some((change) => change.change === 'OBJECT_REMOVED')).toBe(true)
    expect(diff.changes.some((change) => change.change === 'OBJECT_ADDED')).toBe(true)
  })
})
