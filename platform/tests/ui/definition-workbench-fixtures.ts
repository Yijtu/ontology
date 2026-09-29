import { randomUUID } from 'node:crypto'
import { createApiServer } from '@ontology/app-api'
import {
  DefinitionCandidateEditingService,
  DefinitionCandidateGenerationService,
  InMemoryAssetCandidateStore,
  InMemoryDefinitionEditingStore,
  InMemoryRuleActionCandidateStore,
  IndustryWorkspaceService,
  RuleActionCandidateService,
  StaticDefinitionTerminologySource,
  InMemoryJobStore,
} from '@ontology/application'
import { FiniteGrammarRuleSupportValidator } from '@ontology/semantic-engine'
import { createToolContext } from '@ontology/contracts'
import type {
  ActionDeclaration,
  AssetCandidateBatch,
  AssetCandidateVersion,
  CapabilityLimits,
  OperationRegistry,
  RegisteredOperation,
  ResourceRef,
  RevisionString,
  RuleExceptionNode,
  RuleExpressionNode,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'
import {
  InMemoryIndustryWorkspaceStore,
  WORKSPACE_ALL_ROLES,
  WORKSPACE_SCOPE,
  workspaceAuthenticator,
  workspaceTrustedContext,
} from './workspace-fixtures'

/**
 * Test-only in-memory harness for the public definition / rule / action review workbench
 * (V03-012 / #185). It mounts the real Fastify routes over the shared in-memory stores so the
 * browser E2E drives actual HTTP behaviour — candidate listing with source/conflicts, an edit
 * that appends a new revision, a human draft append that leaves generated candidates stale, a
 * supported/unsupported rule and an executable/not-executable action binding — rather than a
 * hand-written fake.
 */

export const DEFINITION_WORKBENCH_NAMESPACE = 'bridge-ontology'

const DIGEST = `sha256:${'a'.repeat(64)}`
const IN_SCHEMA = `sha256:${'b'.repeat(64)}`
const OUT_SCHEMA = `sha256:${'c'.repeat(64)}`

function hexDigest(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function versionRef(id: string, digest = DIGEST): VersionRef {
  return { id, version: '1.0.0', digest }
}

function compare(
  attributeId: string,
  value: string | number | boolean,
  operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte' = 'eq',
): RuleExpressionNode {
  return { op: 'compare', attributeId, operator, value, spans: [] }
}

const SAME_OR: RuleExpressionNode = {
  op: 'any',
  operands: [compare('status', 'on'), compare('status', 'on')],
  spans: [],
}
const DIFFERENT_OR: RuleExpressionNode = {
  op: 'any',
  operands: [compare('operating_hours', 100, 'gte'), compare('alarm', true)],
  spans: [],
}

function registeredOperation(): RegisteredOperation {
  const limits: CapabilityLimits = { maxRows: 100, maxBytes: 65_536, maxDurationMs: 2_000 }
  return {
    operationRef: { id: 'bridge.inspect', version: '1' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    inputSchemaDigest: IN_SCHEMA,
    outputSchemaDigest: OUT_SCHEMA,
    handlerRef: { id: 'extension-bridge', version: '0.1.0', digest: DIGEST },
    handlerDigest: DIGEST,
    readOnly: true,
    requiredCapabilities: ['bridge.inspection'],
    limits,
    dataMode: 'simulation',
  }
}

function registry(): OperationRegistry {
  return {
    namespace: 'bridge',
    registryVersion: '1.0.0',
    registryDigest: DIGEST,
    operations: [registeredOperation()],
  }
}

function actionDeclaration(overrides: Partial<ActionDeclaration> = {}): ActionDeclaration {
  return {
    actionId: 'action.inspect_member',
    displayName: '构件检查',
    businessMeaning: '对桥架构件执行只读检查',
    suggestedReason: '来自资料',
    inputSchemaRef: versionRef('bridge.inspect.input', IN_SCHEMA),
    outputSchemaRef: versionRef('bridge.inspect.output', OUT_SCHEMA),
    preconditions: ['构件已登记'],
    requiredCapabilities: [{ name: 'bridge.inspection', versionRange: { min: '1.0.0' } }],
    permissions: ['compute:inspect'],
    readOnly: true,
    sideEffect: 'read_only',
    evidenceRequirements: ['computation'],
    suggestedOperationRef: { id: 'bridge.inspect', version: '1' },
    ...overrides,
  }
}

export interface DefinitionWorkbenchHarness {
  readonly app: ReturnType<typeof createApiServer>
  readonly client: WorkbenchClient
  readonly baseUrl: string
  readonly workspaceId: Uuid
  readonly candidateIds: {
    readonly object: Uuid
    readonly attribute: Uuid
    readonly relation: Uuid
    readonly pending: Uuid
  }
  readonly ruleCandidateIds: { readonly supported: Uuid; readonly unsupported: Uuid }
  readonly actionCandidateIds: { readonly executable: Uuid; readonly notExecutable: Uuid }
  readonly ctx: ToolContext
  /** Append a draft revision server-side so a panel holding an older head must hit VERSION_CONFLICT. */
  readonly bumpWorkspaceHead: () => Promise<void>
  readonly close: () => Promise<void>
}

function seedDefinitionBatch(args: {
  readonly workspaceId: Uuid
  readonly draftDigest: string
  readonly documentSetRef: ResourceRef
}): { readonly batch: AssetCandidateBatch; readonly candidates: readonly AssetCandidateVersion[] } {
  const batchId = randomUUID()
  const inputDraftRef = { workspaceId: args.workspaceId, revision: '1' as RevisionString, digest: args.draftDigest }
  const source = resourceRef()
  const base = {
    batchId,
    workspaceId: args.workspaceId,
    domain: 'definition' as const,
    logicalId: '',
    inputDraftRef,
    sourceSpans: [],
    pendingConfirmation: false,
    contentDigest: DIGEST,
    idempotencyKey: hexDigest('1'),
    recordedAt: '2026-09-29T00:00:00Z',
  }
  const candidates: AssetCandidateVersion[] = [
    {
      ...base,
      candidateId: randomUUID(),
      logicalId: 'device',
      kind: 'object',
      payload: {
        kind: 'object',
        logicalId: 'device',
        displayName: '设备',
        businessMeaning: '桥架上的设备构件',
        suggestedReason: '资料中反复出现',
        conflicts: [],
        identityAttributeIds: ['device_code'],
      },
      sourceRefs: [source],
      state: 'produced',
      issues: [],
      idempotencyKey: hexDigest('2'),
    },
    {
      ...base,
      candidateId: randomUUID(),
      logicalId: 'capacity',
      kind: 'attribute',
      payload: {
        kind: 'attribute',
        logicalId: 'capacity',
        displayName: '承载能力',
        businessMeaning: '构件可承载的重量',
        suggestedReason: '规格表给出',
        conflicts: [
          { kind: 'unit_conflict', message: '与已发布单位 kg 不一致（推导为 t）', relatedLogicalIds: ['capacity'] },
        ],
        objectLogicalId: 'device',
        valueType: 'quantity',
        unitCode: 't',
        minCardinality: 0,
        maxCardinality: 1,
      },
      sourceRefs: [source],
      state: 'produced',
      issues: [],
      idempotencyKey: hexDigest('3'),
    },
    {
      ...base,
      candidateId: randomUUID(),
      logicalId: 'part_of',
      kind: 'relation',
      payload: {
        kind: 'relation',
        logicalId: 'part_of',
        displayName: '属于',
        businessMeaning: '设备属于某个桥架段',
        suggestedReason: '结构层级',
        conflicts: [
          { kind: 'endpoint_unresolved', message: '终点对象 tray_section 尚未定义', relatedLogicalIds: ['tray_section'] },
        ],
        fromObjectLogicalId: 'device',
        toObjectLogicalId: 'tray_section',
        minCardinality: 0,
        maxCardinality: 'unbounded',
      },
      sourceRefs: [source],
      state: 'produced',
      issues: [],
      idempotencyKey: hexDigest('4'),
    },
    {
      ...base,
      candidateId: randomUUID(),
      logicalId: 'ghost_term',
      kind: 'object',
      payload: {
        kind: 'object',
        logicalId: 'ghost_term',
        displayName: '未定位术语',
        businessMeaning: '缺少来源定位的候选',
        suggestedReason: '模型猜测',
        conflicts: [],
        identityAttributeIds: [],
      },
      sourceRefs: [],
      state: 'pending_confirmation',
      issues: [],
      pendingConfirmation: true,
      idempotencyKey: hexDigest('5'),
    },
  ]
  const counts = {
    total: candidates.length,
    produced: 2,
    pendingConfirmation: 1,
    pendingReview: 0,
    failed: 0,
  }
  const batch: AssetCandidateBatch = {
    batchId,
    workspaceId: args.workspaceId,
    domain: 'definition',
    inputDraftRef,
    modelRef: { modelId: 'fixture-generation', version: '1.0.0' },
    responseSchemaRef: versionRef('ontology.generation.definition-candidates'),
    documentSetRef: args.documentSetRef,
    generationPolicyRef: versionRef('ontology.generation.policy'),
    state: 'completed',
    counts,
    idempotencyKey: 'seed-batch-1',
    requestDigest: hexDigest('9'),
    createdBy: 'e2e-owner',
    recordedAt: '2026-09-29T00:00:00Z',
  }
  return { batch, candidates }
}

export async function startDefinitionWorkbenchHarness(): Promise<DefinitionWorkbenchHarness> {
  const workspaceStore = new InMemoryIndustryWorkspaceStore()
  const jobStore = new InMemoryJobStore()
  const candidateStore = new InMemoryAssetCandidateStore()
  const editingStore = new InMemoryDefinitionEditingStore()
  const ruleActionStore = new InMemoryRuleActionCandidateStore()
  const terminology = new StaticDefinitionTerminologySource()

  const workspaceService = new IndustryWorkspaceService({
    store: workspaceStore,
    jobs: jobStore,
    newId: () => randomUUID(),
    now: () => '2026-09-29T00:00:00Z',
  })
  const generation = new DefinitionCandidateGenerationService({
    workspaces: workspaceStore,
    candidates: candidateStore,
    terminology,
    generationForRun: () => undefined,
    modelRef: { modelId: 'fixture-generation', version: '1.0.0' },
    outputLimit: { maxTokens: 1_024 },
    now: () => '2026-09-29T00:00:00Z',
    newId: () => randomUUID(),
  })
  const editingService = new DefinitionCandidateEditingService({
    workspaces: workspaceStore,
    candidates: candidateStore,
    terminology,
    editing: editingStore,
    now: () => '2026-09-29T00:00:00Z',
    newId: () => randomUUID(),
  })
  const ruleActionService = new RuleActionCandidateService({
    workspaces: workspaceStore,
    candidates: ruleActionStore,
    support: new FiniteGrammarRuleSupportValidator(),
    now: () => '2026-09-29T00:00:00Z',
  })

  const bindingContext = {
    registry: registry(),
    authorizedOperations: [{ id: 'bridge.inspect', version: '1' }],
    availableCapabilities: ['bridge.inspection'],
    recordedAt: '2026-09-29T00:00:00Z',
  }

  const app = createApiServer({
    authenticate: workspaceAuthenticator,
    industryWorkspaces: { service: workspaceService },
    assetCandidates: { generation },
    definitionEditing: { service: editingService },
    ruleActionCandidates: { service: ruleActionService, bindingContext: () => bindingContext },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('the definition workbench API did not bind a TCP port')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  const client = new WorkbenchClient({ baseUrl })
  const ctx = workspaceTrustedContext(WORKSPACE_ALL_ROLES.split(','), 'e2e-owner')

  const documentSetRef = resourceRef()
  const created = await workspaceService.createWorkspace(
    {
      namespace: DEFINITION_WORKBENCH_NAMESPACE,
      displayName: '桥架本体工作区',
      boundary: { goals: ['建模桥架设备'], included: [], excluded: [], applicability: { region: 'CN' } },
      documentSetRef,
    },
    'seed-workspace',
    'e2e-owner',
    ctx,
  )
  const workspaceId = created.workspace.workspaceId

  // Seed the immutable generated candidates, then a human draft append that moves the head to
  // revision 2 so the generated candidates are visibly stale and must not be re-applied.
  const { batch, candidates } = seedDefinitionBatch({
    workspaceId,
    draftDigest: created.draft.digest,
    documentSetRef,
  })
  await candidateStore.insertBatch(WORKSPACE_SCOPE, batch, candidates, ctx)
  await workspaceService.draftOperation(
    workspaceId,
    { operation: 'edit', expectedRevision: '1', reason: '人工调整草稿', documentSetRef },
    'seed-draft-2',
    'e2e-owner',
    ctx,
  )

  const supportedRule = await ruleActionService.saveRuleCandidate(
    workspaceId,
    {
      displayName: '运行状态规则',
      businessMeaning: '运行状态满足时成立',
      suggestedReason: '资料',
      ruleId: 'rule.status_ok',
      applicability: { objectId: 'device' },
      condition: SAME_OR,
      exceptions: [] as readonly RuleExceptionNode[],
      ruleDependencies: [],
      sourceRefs: [resourceRef()],
      expectedRevision: '2',
      idempotencyKey: 'seed-rule-supported',
    },
    'e2e-owner',
    ctx,
  )
  const unsupportedRule = await ruleActionService.saveRuleCandidate(
    workspaceId,
    {
      displayName: '多条件或规则',
      businessMeaning: '不同条件的或关系',
      suggestedReason: '资料',
      ruleId: 'rule.multi_or',
      applicability: { objectId: 'device' },
      condition: DIFFERENT_OR,
      exceptions: [],
      ruleDependencies: [],
      sourceRefs: [resourceRef()],
      expectedRevision: '2',
      idempotencyKey: 'seed-rule-unsupported',
    },
    'e2e-owner',
    ctx,
  )
  const executableAction = await ruleActionService.saveActionCandidate(
    workspaceId,
    {
      declaration: actionDeclaration(),
      sourceRefs: [resourceRef()],
      expectedRevision: '2',
      idempotencyKey: 'seed-action-executable',
      bindingContext,
    },
    'e2e-owner',
    ctx,
  )
  const notExecutableAction = await ruleActionService.saveActionCandidate(
    workspaceId,
    {
      declaration: actionDeclaration({ actionId: 'action.export_member', displayName: '导出构件' }),
      sourceRefs: [resourceRef()],
      expectedRevision: '2',
      idempotencyKey: 'seed-action-unbound',
      bindingContext: { ...bindingContext, authorizedOperations: [] },
    },
    'e2e-owner',
    ctx,
  )

  await editingService.recordUnsupportedRule(
    {
      workspaceId,
      ruleId: 'rule.manual_unsupported',
      reason: '规则语法超出可执行子集',
      rawForm: { op: 'unsupported_quantifier' },
      idempotencyKey: 'seed-unsupported-definition-rule',
    },
    'e2e-owner',
    ctx,
  )

  const bumpWorkspaceHead = async (): Promise<void> => {
    const current = await workspaceService.getWorkspace(workspaceId, ctx)
    await workspaceService.draftOperation(
      workspaceId,
      { operation: 'edit', expectedRevision: current.headRevision, reason: '外部草稿修订', documentSetRef },
      `seed-draft-${randomUUID()}`,
      'e2e-owner',
      ctx,
    )
  }

  return {
    app,
    client,
    baseUrl,
    workspaceId,
    candidateIds: {
      object: candidates[0]?.candidateId ?? '',
      attribute: candidates[1]?.candidateId ?? '',
      relation: candidates[2]?.candidateId ?? '',
      pending: candidates[3]?.candidateId ?? '',
    },
    ruleCandidateIds: { supported: supportedRule.candidateId, unsupported: unsupportedRule.candidateId },
    actionCandidateIds: { executable: executableAction.candidateId, notExecutable: notExecutableAction.candidateId },
    ctx,
    bumpWorkspaceHead,
    close: async () => {
      await app.close()
    },
  }
}

/** Convenience for the jsdom test: a fixed authenticated context is not needed there. */
export function definitionTrustedContext(): ToolContext {
  return createToolContext({
    principal: {
      tenantId: WORKSPACE_SCOPE.tenantId,
      subjectId: 'e2e-owner',
      roles: WORKSPACE_ALL_ROLES.split(','),
      scopes: [],
      authEpoch: 1,
    },
    runId: '33333333-3333-4333-8333-333333333333',
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: '55555555-5555-4555-8555-555555555555',
      runId: '33333333-3333-4333-8333-333333333333',
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: WORKSPACE_SCOPE.tenantId,
      spaceId: WORKSPACE_SCOPE.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-definition-workbench-fixture',
  })
}
