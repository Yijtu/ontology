import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  ActionDeclaration,
  AppendAssetDraftInput,
  AssetCandidateBatch,
  AssetCandidateVersion,
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
} from '@ontology/contracts'
import { findIndustryPackViolations, findEmbeddedSecretViolations } from '@ontology/contracts'
import {
  InMemoryAssetCandidateStore,
  InMemoryPublishedPackAssetStore,
  InMemoryRuleActionCandidateStore,
  IndustryAssetPublicationService,
  IndustryPackExportService,
  StoreBackedIndustryManifestSource,
  StoreBackedIndustryPackCatalogue,
  buildVersionDiff,
} from '@ontology/application'
import { InMemorySemanticDefinitionStore } from '@ontology/semantic-engine'
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

  seed(workspace: IndustryWorkspace): void {
    this.#workspaces.set(workspace.workspaceId, workspace)
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

  async listDrafts(): Promise<never[]> {
    return []
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
    lifecycle: 'draft',
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
  seedReport(report: IndustryValidationReport): void
}

function harness(): Harness {
  let tick = 0
  const now = (): string => {
    tick += 1
    return new Date(Date.UTC(2026, 8, 29, 0, 0, tick)).toISOString()
  }
  const workspaces = new FixtureWorkspaceStore()
  const definitionCandidates = new InMemoryAssetCandidateStore()
  const ruleActions = new InMemoryRuleActionCandidateStore()
  const syntheticSets = new EmptySyntheticExampleSetStore()
  const definitions = new InMemorySemanticDefinitionStore()
  const published = new InMemoryPublishedPackAssetStore({
    definitions,
    onPublished: (scopeRef, workspaceId, revision, packRef) => {
      void scopeRef
      workspaces.advanceHead(workspaceId, revision, packRef)
    },
  })
  const reports = new FixtureValidationReportStore()

  const service = new IndustryAssetPublicationService({
    workspaces,
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
  }

  const seedAction = async (): Promise<void> => {
    await ruleActions.insert(SCOPE, actionCandidate('2026-09-29T00:00:04Z'), EDITOR)
  }

  const seedReport = (report: IndustryValidationReport): void => {
    reports.seed(report)
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
  h.seedReport(report)
  return report
}

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
    h.seedReport(report)
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
    h.seedReport(stale)
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
    h.seedReport(second)
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
