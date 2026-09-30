import { randomUUID } from 'node:crypto'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import {
  InMemoryAssetCandidateStore,
  InMemoryIndustryValidationReportStore,
  InMemoryJobStore,
  InMemoryProjectReadinessStore,
  InMemoryPublishedPackAssetStore,
  InMemoryRuleActionCandidateStore,
  InMemorySyntheticExampleSetStore,
  IndustryAssetPublicationService,
  IndustryPackExportService,
  IndustryWorkspaceService,
  ProjectService,
  StoreBackedIndustryManifestSource,
  StoreBackedIndustryPackCatalogue,
  SyntheticExampleService,
  IndustryValidationService,
} from '@ontology/application'
import type { IndustryPackUpgradeService } from '@ontology/application'
import { InMemorySemanticDefinitionStore } from '@ontology/semantic-engine'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator } from '@ontology/semantic-engine'
import type {
  ActionDeclaration,
  AssetCandidateBatch,
  AssetCandidateVersion,
  DefinitionCandidatePayload,
  DefinitionValidationReport,
  IndustryValidationReport,
  ResourceRef,
  RuleActionCandidateVersion,
  SyntheticExampleSetVersion,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'
import {
  InMemoryIndustryWorkspaceStore,
  WORKSPACE_SCOPE,
  workspaceAuthenticator,
  workspaceTrustedContext,
} from './workspace-fixtures'
import { InMemoryProjectStore } from './project-fixtures'

/**
 * Test-only harness for the package validation / publish / export / mount frontend (V03-021).
 *
 * It wires the real merged `SyntheticExampleService` / `IndustryValidationService` (for the
 * counter-example reads), `IndustryAssetPublicationService` (real immutable publication),
 * `IndustryPackExportService` + dynamic `StoreBackedIndustryPackCatalogue` (real export and the
 * live catalogue the mount entry reads) and `ProjectService` (real project create/mount) onto
 * in-memory stores and a real Fastify host. The browser E2E therefore drives actual HTTP
 * behaviour — it does not seed the publication result: the pack is produced by the real publish
 * operation during the test.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`

function hex(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function resourceRef(kind: ResourceRef['kind'] = 'artifact'): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: hex(randomUUID().replaceAll('-', '')), kind }
}

function versionRef(id: string, digest = DIGEST): VersionRef {
  return { id, version: '1.0.0', digest }
}

function definitionCandidate(
  batchId: Uuid,
  workspaceId: string,
  revision: string,
  draftDigest: string,
  payload: DefinitionCandidatePayload,
): AssetCandidateVersion {
  return {
    candidateId: randomUUID(),
    batchId,
    workspaceId,
    logicalId: payload.logicalId,
    domain: 'definition',
    kind: payload.kind,
    payload,
    inputDraftRef: { workspaceId, revision, digest: draftDigest },
    sourceRefs: [resourceRef()],
    sourceSpans: [],
    state: 'produced',
    issues: [],
    pendingConfirmation: false,
    contentDigest: DIGEST,
    idempotencyKey: hex(randomUUID().replaceAll('-', '')),
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function candidateBatch(batchId: Uuid, workspaceId: string, revision: string, draftDigest: string, total: number): AssetCandidateBatch {
  return {
    batchId,
    workspaceId,
    domain: 'definition',
    inputDraftRef: { workspaceId, revision, digest: draftDigest },
    modelRef: { modelId: 'fixture-model', version: '1.0.0' },
    responseSchemaRef: versionRef('tbox-response'),
    documentSetRef: resourceRef(),
    generationPolicyRef: versionRef('tbox-policy'),
    state: 'completed',
    counts: { total, produced: total, pendingConfirmation: 0, pendingReview: 0, failed: 0 },
    idempotencyKey: `batch-${randomUUID()}`,
    requestDigest: DIGEST,
    createdBy: 'e2e-owner',
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function unboundDeclaration(): ActionDeclaration {
  return {
    actionId: 'action.inspect_member',
    displayName: '构件检查',
    businessMeaning: '对桥架构件执行只读检查',
    suggestedReason: '来自资料',
    inputSchemaRef: versionRef('inspect.input', hex('b')),
    outputSchemaRef: versionRef('inspect.output', hex('c')),
    preconditions: [],
    requiredCapabilities: [{ name: 'pricing.compute', versionRange: { min: '1.0.0' } }],
    permissions: ['compute:inspect'],
    readOnly: true,
    sideEffect: 'read_only',
    evidenceRequirements: ['computation'],
    suggestedOperationRef: { id: 'bridge.inspect', version: '1' },
  }
}

function actionCandidate(workspaceId: string): RuleActionCandidateVersion {
  return {
    candidateId: randomUUID(),
    workspaceId,
    logicalId: 'action.inspect_member',
    domain: 'definition',
    kind: 'action',
    displayName: '构件检查',
    businessMeaning: '对桥架构件执行只读检查',
    suggestedReason: '来自资料',
    payload: { kind: 'action', declaration: unboundDeclaration() },
    sourceRefs: [resourceRef()],
    sourceSpans: [],
    lifecycle: 'draft',
    contentDigest: DIGEST,
    idempotencyKey: hex(randomUUID().replaceAll('-', '')),
    actor: 'e2e-owner',
    recordedAt: '2026-09-30T00:00:04Z',
  }
}

function exampleSet(workspaceId: string, revision: string): SyntheticExampleSetVersion {
  const exampleSetId = randomUUID()
  return {
    exampleSetId,
    workspaceId,
    sourceKind: 'synthetic',
    dataMode: 'synthetic',
    isolationLabel: 'synthetic test',
    targetDraftRef: { id: workspaceId, version: revision, digest: DIGEST },
    caseKinds: ['missing_parameter', 'wrong_unit', 'missing_capability'],
    cases: [
      { caseId: 'case-missing-parameter', caseKind: 'missing_parameter', objectTypeRef: 'device', fields: [] },
      {
        caseId: 'case-wrong-unit',
        caseKind: 'wrong_unit',
        objectTypeRef: 'device',
        fields: [{ fieldId: 'power', value: 1, unitCode: 'kg' }],
      },
      { caseId: 'case-missing-capability', caseKind: 'missing_capability', objectTypeRef: 'device', fields: [] },
    ],
    expectations: [
      {
        expectationId: 'expectation-1',
        caseId: 'case-missing-parameter',
        kind: 'action',
        actionId: 'action.inspect_member',
        expected: 'blocked',
        origin: 'expert_confirmed',
        reason: '缺少必填参数时检查动作应被阻断',
        confirmedBy: 'expert',
        confirmedAt: '2026-09-30T00:00:00Z',
      },
    ],
    page: { pageIndex: 0, pageSize: 100, caseRefs: [] },
    contentDigest: hex('e'),
    idempotencyKey: `example-set-${randomUUID()}`,
    actor: 'e2e-owner',
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function validationReport(
  workspaceId: string,
  exampleSetId: string,
  options: {
    readonly semanticPassed: boolean
    readonly deploymentPassed: boolean
    readonly actionExecutable: boolean
    readonly missingCapabilities?: readonly string[]
  },
): IndustryValidationReport {
  const { semanticPassed, deploymentPassed, actionExecutable } = options
  const missingCapabilities = options.missingCapabilities ?? []
  const publishable = semanticPassed && deploymentPassed
  const semanticBlockers = semanticPassed
    ? []
    : [{ code: 'DEFINITION_BLOCKER' as const, surface: 'semantic' as const, message: '定义存在未解决的阻断项', logicalId: 'device' }]
  const deploymentBlockers = deploymentPassed
    ? []
    : [
        {
          code: 'ACTION_NOT_EXECUTABLE' as const,
          surface: 'deployment' as const,
          message: 'action action.inspect_member has no executable capability binding',
          actionId: 'action.inspect_member',
        },
        ...missingCapabilities.map((name) => ({
          code: 'MISSING_CAPABILITY' as const,
          surface: 'deployment' as const,
          message: `action action.inspect_member requires the ${name} capability`,
          actionId: 'action.inspect_member',
        })),
      ]
  return {
    validationId: randomUUID(),
    workspaceId,
    revision: '1',
    exampleSetId,
    exampleSetRef: { id: exampleSetId, version: '1.0.0', digest: hex('e'), kind: 'dataset' },
    dataMode: 'synthetic',
    isolationLabel: 'synthetic test',
    businessApproval: 'none',
    realFactsWritten: false,
    semanticPublished: { passed: semanticPassed, blockers: semanticBlockers },
    deploymentExecutable: { passed: deploymentPassed, blockers: deploymentBlockers },
    publishable,
    gate: publishable ? 'open' : semanticPassed ? 'blocked_execution' : 'blocked_semantic',
    issues: [...semanticBlockers, ...deploymentBlockers],
    rules: [],
    actions: [
      {
        candidateId: randomUUID(),
        actionId: 'action.inspect_member',
        bindingStatus: actionExecutable ? 'executable' : 'not_executable',
        semanticPublished: true,
        deploymentExecutable: actionExecutable,
        findings: [],
        requiredCapabilities: [{ name: 'pricing.compute', versionRange: { min: '1.0.0' } }],
        missingCapabilities: [...missingCapabilities],
        trials: [],
        coveredCaseIds: ['case-missing-parameter'],
      },
    ],
    expectationResults: [
      {
        expectationId: 'expectation-1',
        caseId: 'case-missing-parameter',
        kind: 'action',
        targetId: 'action.inspect_member',
        expected: 'blocked',
        actual: 'blocked',
        matched: true,
        origin: 'expert_confirmed',
        independent: true,
      },
    ],
    coverage: [
      { caseId: 'case-missing-parameter', caseKind: 'missing_parameter', ruleIds: [], actionIds: ['action.inspect_member'] },
      { caseId: 'case-wrong-unit', caseKind: 'wrong_unit', ruleIds: [], actionIds: [] },
    ],
    contentDigest: hex('f'),
    idempotencyKey: `validation-${randomUUID()}`,
    actor: 'e2e-owner',
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function definitionValidationReport(workspaceId: string): DefinitionValidationReport {
  return {
    workspaceId,
    revision: '1',
    checkedCandidateIds: [],
    blockers: [],
    warnings: [],
    nonExecutableRules: [],
    compatibility: {
      workspaceId,
      revision: '1',
      additions: [],
      changes: [],
      breakingChanges: [],
      requiresRevisionStrategy: false,
    },
    publishable: true,
  }
}

export interface PackagePublishHarness {
  readonly app: ReturnType<typeof createApiServer>
  readonly client: WorkbenchClient
  readonly baseUrl: string
  readonly workspaceId: Uuid
  readonly exampleSetId: Uuid
  readonly stableValidationId: Uuid
  readonly semanticOnlyValidationId: Uuid
  readonly blockedValidationId: Uuid
  readonly close: () => Promise<void>
}

export async function startPackagePublishHarness(): Promise<PackagePublishHarness> {
  const workspaceStore = new InMemoryIndustryWorkspaceStore()
  const jobStore = new InMemoryJobStore()
  const candidateStore = new InMemoryAssetCandidateStore()
  const ruleActionStore = new InMemoryRuleActionCandidateStore()
  const exampleSets = new InMemorySyntheticExampleSetStore()
  const reports = new InMemoryIndustryValidationReportStore()
  const definitions = new InMemorySemanticDefinitionStore()
  const published = new InMemoryPublishedPackAssetStore({ definitions })

  const workspaceService = new IndustryWorkspaceService({
    store: workspaceStore,
    jobs: jobStore,
    newId: () => randomUUID(),
    now: () => '2026-09-30T00:00:00Z',
  })
  const exampleService = new SyntheticExampleService({
    workspaces: workspaceStore,
    sets: exampleSets,
    now: () => '2026-09-30T00:00:00Z',
    newId: () => randomUUID(),
  })
  const validationService = new IndustryValidationService({
    workspaces: workspaceStore,
    exampleSets,
    reports,
    definitions: { validateForPublication: async (input) => definitionValidationReport(input.workspaceId) },
    ruleActions: ruleActionStore,
    support: new FiniteGrammarRuleSupportValidator(),
    evaluator: new FiniteGrammarSyntheticEvaluator(),
    now: () => '2026-09-30T00:00:00Z',
    newId: () => randomUUID(),
  })
  const publication = new IndustryAssetPublicationService({
    workspaces: workspaceStore,
    validations: reports,
    definitionCandidates: candidateStore,
    ruleActions: ruleActionStore,
    syntheticSets: exampleSets,
    definitions,
    store: published,
    now: () => '2026-09-30T00:00:01Z',
    newId: () => randomUUID(),
  })
  const catalogue = new StoreBackedIndustryPackCatalogue({ store: published })
  const manifestSource = new StoreBackedIndustryManifestSource({ store: published })
  const packExports = new IndustryPackExportService({ catalogue, definitions, published, now: () => '2026-09-30T00:00:02Z' })
  // The upgrade/retire routes are outside this node; a type-compatible placeholder keeps the
  // pack surface registered without pretending an unexercised path is implemented.
  const packUpgrades = {
    applyUpgrade: async () => {
      throw new Error('pack upgrade is not exercised by the package-publish harness')
    },
    retire: async () => {
      throw new Error('pack retire is not exercised by the package-publish harness')
    },
  } as unknown as IndustryPackUpgradeService

  const projectService = new ProjectService({
    projects: new InMemoryProjectStore(),
    readiness: new InMemoryProjectReadinessStore(),
    jobs: jobStore,
    catalogue,
    newId: () => randomUUID(),
    now: () => '2026-09-30T00:00:03Z',
  })

  const ctx = workspaceTrustedContext(WORKSPACE_SCOPE_ALL_ROLES().split(','), 'e2e-owner')
  const created = await workspaceService.createWorkspace(
    {
      namespace: 'package-publish-industry',
      displayName: '包发布工作区',
      boundary: { goals: ['验证并发布行业包'], included: [], excluded: [], applicability: { region: 'CN' } },
      documentSetRef: resourceRef(),
    },
    `seed-workspace-${randomUUID()}`,
    'e2e-owner',
    ctx,
  )
  const workspaceId = created.workspace.workspaceId

  const batchId = randomUUID()
  const revision = created.workspace.headRevision
  const draftDigest = created.draft.digest
  const candidates = [
    definitionCandidate(
      batchId,
      workspaceId,
      revision,
      draftDigest,
      {
        kind: 'object',
        logicalId: 'device',
        displayName: '设备',
        businessMeaning: '桥架设备',
        suggestedReason: '资料',
        conflicts: [],
        identityAttributeIds: ['device_id'],
      },
    ),
    definitionCandidate(
      batchId,
      workspaceId,
      revision,
      draftDigest,
      {
        kind: 'attribute',
        logicalId: 'device_id',
        displayName: '设备编号',
        businessMeaning: '稳定设备标识',
        suggestedReason: '资料',
        conflicts: [],
        objectLogicalId: 'device',
        valueType: 'string',
        minCardinality: 1,
        maxCardinality: 1,
      },
    ),
    definitionCandidate(
      batchId,
      workspaceId,
      revision,
      draftDigest,
      {
        kind: 'attribute',
        logicalId: 'power',
        displayName: '功率',
        businessMeaning: '额定功率',
        suggestedReason: '资料',
        conflicts: [],
        objectLogicalId: 'device',
        valueType: 'quantity',
        unitCode: 'kW',
        dimension: 'power',
        minCardinality: 0,
        maxCardinality: 1,
      },
    ),
  ]
  const batch = candidateBatch(batchId, workspaceId, revision, draftDigest, candidates.length)
  await candidateStore.insertBatch(WORKSPACE_SCOPE, batch, candidates, ctx)

  await ruleActionStore.insert(WORKSPACE_SCOPE, actionCandidate(workspaceId), ctx)

  const set = exampleSet(workspaceId, revision)
  await exampleSets.insert(WORKSPACE_SCOPE, set, ctx)

  const stable = validationReport(workspaceId, set.exampleSetId, {
    semanticPassed: true,
    deploymentPassed: true,
    actionExecutable: true,
  })
  const semanticOnly = validationReport(workspaceId, set.exampleSetId, {
    semanticPassed: true,
    deploymentPassed: false,
    actionExecutable: false,
    missingCapabilities: ['pricing.compute'],
  })
  const blocked = validationReport(workspaceId, set.exampleSetId, {
    semanticPassed: false,
    deploymentPassed: false,
    actionExecutable: false,
    missingCapabilities: ['pricing.compute'],
  })
  await reports.insert(WORKSPACE_SCOPE, stable, ctx)
  await reports.insert(WORKSPACE_SCOPE, semanticOnly, ctx)
  await reports.insert(WORKSPACE_SCOPE, blocked, ctx)

  const app = createApiServer({
    authenticate: packagePublishAuthenticator,
    industryWorkspaces: { service: workspaceService },
    syntheticValidation: { exampleService, validationService },
    packs: { catalogue, packExports, packUpgrades, publication },
    projects: { service: projectService },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('the package-publish API did not bind a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  void manifestSource

  return {
    app,
    client: new WorkbenchClient({ baseUrl }),
    baseUrl,
    workspaceId,
    exampleSetId: set.exampleSetId,
    stableValidationId: stable.validationId,
    semanticOnlyValidationId: semanticOnly.validationId,
    blockedValidationId: blocked.validationId,
    close: async () => {
      await app.close()
    },
  }
}

function WORKSPACE_SCOPE_ALL_ROLES(): string {
  return 'platform-admin,profile-editor,data-editor,semantic-reviewer,business-user,scoped-reader'
}

function packagePublishAuthenticator(): AuthenticatedRequest {
  const auth = workspaceAuthenticator()
  return auth
}

export { workspaceTrustedContext }
export type { ToolContext }
