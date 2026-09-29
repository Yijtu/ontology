import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  ActionDeclaration,
  AppendAssetDraftInput,
  AssetDraftVersion,
  CapabilityLimits,
  CreateIndustryWorkspaceInput,
  DefinitionCompatibilityReport,
  DefinitionValidationReport,
  IndustryWorkspace,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceStore,
  OperationRegistry,
  RegisteredOperation,
  ResourceRef,
  RevisionString,
  RuleExceptionNode,
  RuleExpressionNode,
  ScopeRef,
  SyntheticCase,
  SyntheticExpectation,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { assertSyntheticNotPublishedAsObserved } from '@ontology/contracts'
import {
  InMemoryIndustryValidationReportStore,
  InMemoryRuleActionCandidateStore,
  InMemorySyntheticExampleSetStore,
  RuleActionCandidateService,
  SyntheticExampleService,
  IndustryValidationService,
} from '@ontology/application'
import type { ActionTrialInput, ActionTrialReceipt, DefinitionPublicationValidationPort } from '@ontology/contracts'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator } from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_SPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const DIGEST = `sha256:${'d'.repeat(64)}`
const IN_SCHEMA = `sha256:${'a'.repeat(64)}`
const OUT_SCHEMA = `sha256:${'b'.repeat(64)}`

const EDITOR: ToolContext = toolContext(TENANT, SPACE, ['profile-editor'], 'editor-1')
const VIEWER: ToolContext = toolContext(TENANT, SPACE, ['scoped-reader'], 'viewer-1')

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function versionRef(id: string, digest = DIGEST): VersionRef {
  return { id, version: '1.0.0', digest }
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

  async getWorkspace(scopeRef: ScopeRef, workspaceId: Uuid): Promise<IndustryWorkspace | undefined> {
    return this.#workspaces.get(this.#key(scopeRef))?.get(workspaceId)
  }

  async listWorkspaces(scopeRef: ScopeRef, _f: IndustryWorkspaceListFilter): Promise<IndustryWorkspace[]> {
    void _f
    return [...(this.#workspaces.get(this.#key(scopeRef))?.values() ?? [])]
  }

  async getDraft(scopeRef: ScopeRef, workspaceId: Uuid, revision: RevisionString): Promise<AssetDraftVersion | undefined> {
    return this.#drafts.get(this.#key(scopeRef))?.get(workspaceId)?.find((entry) => entry.revision === revision)
  }

  async listDrafts(scopeRef: ScopeRef, workspaceId: Uuid): Promise<AssetDraftVersion[]> {
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

function definitionReport(workspaceId: Uuid, publishable: boolean): DefinitionValidationReport {
  const compatibility: DefinitionCompatibilityReport = {
    workspaceId,
    revision: '1',
    additions: [],
    changes: [],
    breakingChanges: [],
    requiresRevisionStrategy: false,
  }
  return {
    workspaceId,
    revision: '1',
    checkedCandidateIds: [],
    blockers: publishable
      ? []
      : [
          {
            code: 'DUPLICATE_IDENTIFIER',
            severity: 'blocker',
            candidateId: randomUUID(),
            logicalId: 'duplicate',
            path: 'payload.logicalId',
            message: 'a duplicate identifier blocks publication',
          },
        ],
    warnings: [],
    nonExecutableRules: [],
    compatibility,
    publishable,
  }
}

class StubDefinitionValidation implements DefinitionPublicationValidationPort {
  #publishable = true

  setPublishable(value: boolean): void {
    this.#publishable = value
  }

  async validateForPublication(input: { readonly workspaceId: Uuid }, _ctx: ToolContext): Promise<DefinitionValidationReport> {
    void _ctx
    return definitionReport(input.workspaceId, this.#publishable)
  }
}

class FakeActionTrials {
  readonly calls: ActionTrialInput[] = []

  async trial(input: ActionTrialInput, _ctx: ToolContext): Promise<ActionTrialReceipt> {
    void _ctx
    this.calls.push(input)
    return {
      actionId: input.declaration.actionId,
      caseId: input.caseId,
      status: 'passed',
      message: 'controlled trial executed in the sandbox',
      outputDigest: DIGEST,
      recordedAt: '2026-09-29T00:00:00Z',
    }
  }
}

function harness() {
  const workspaces = new FixtureWorkspaceStore()
  const workspace: IndustryWorkspace = {
    workspaceId: WORKSPACE_ID,
    namespace: 'synthetic-ws',
    displayName: 'Synthetic workspace',
    boundary: { goals: [], included: [], excluded: [], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
  workspaces.seed(SCOPE, workspace, [
    { workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST, documentSetRef: resourceRef(), candidateRefs: [] },
  ])
  const ruleActions = new InMemoryRuleActionCandidateStore()
  const ruleActionService = new RuleActionCandidateService({
    workspaces,
    candidates: ruleActions,
    support: new FiniteGrammarRuleSupportValidator(),
    now: () => '2026-09-29T00:00:00Z',
  })
  const exampleSets = new InMemorySyntheticExampleSetStore()
  const reports = new InMemoryIndustryValidationReportStore()
  const exampleService = new SyntheticExampleService({
    workspaces,
    sets: exampleSets,
    now: () => '2026-09-29T00:00:00Z',
  })
  const definitions = new StubDefinitionValidation()
  const actionTrials = new FakeActionTrials()
  const validationService = new IndustryValidationService({
    workspaces,
    exampleSets,
    reports,
    definitions,
    ruleActions,
    support: new FiniteGrammarRuleSupportValidator(),
    evaluator: new FiniteGrammarSyntheticEvaluator(),
    actionTrials,
    now: () => '2026-09-29T00:00:00Z',
    newId: () => randomUUID(),
  })
  return { workspaces, ruleActions, ruleActionService, exampleSets, reports, exampleService, definitions, actionTrials, validationService }
}

const POWER_RANGE: RuleExpressionNode = { op: 'range', attributeId: 'power', min: 10, unitCode: 'kW', spans: [] }

function registeredOperation(): RegisteredOperation {
  const limits: CapabilityLimits = { maxRows: 100, maxBytes: 65536, maxDurationMs: 2000 }
  return {
    operationRef: { id: 'home-energy.plan', version: '1' },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    inputSchemaDigest: IN_SCHEMA,
    outputSchemaDigest: OUT_SCHEMA,
    handlerRef: { id: 'extension-home-energy', version: '0.1.0', digest: DIGEST },
    handlerDigest: DIGEST,
    readOnly: true,
    requiredCapabilities: ['home-energy.planning'],
    limits,
    dataMode: 'simulation',
  }
}

function registry(): OperationRegistry {
  return {
    namespace: 'home-energy',
    registryVersion: '1.0.0',
    registryDigest: DIGEST,
    operations: [registeredOperation()],
  }
}

function actionDeclaration(overrides: Partial<ActionDeclaration> = {}): ActionDeclaration {
  return {
    actionId: 'action.plan_charge',
    displayName: 'Plan charge',
    businessMeaning: 'plan a charge schedule',
    suggestedReason: 'from source',
    inputSchemaRef: versionRef('home-energy.plan.input', IN_SCHEMA),
    outputSchemaRef: versionRef('home-energy.plan.output', OUT_SCHEMA),
    preconditions: [],
    requiredCapabilities: [{ name: 'home-energy.planning', versionRange: { min: '1.0.0' } }],
    permissions: ['compute:plan'],
    readOnly: true,
    sideEffect: 'read_only',
    evidenceRequirements: ['computation'],
    suggestedOperationRef: { id: 'home-energy.plan', version: '1' },
    ...overrides,
  }
}

function unboundDeclaration(): ActionDeclaration {
  const base = actionDeclaration()
  return {
    actionId: 'action.unbound',
    displayName: base.displayName,
    businessMeaning: base.businessMeaning,
    suggestedReason: base.suggestedReason,
    inputSchemaRef: base.inputSchemaRef,
    outputSchemaRef: base.outputSchemaRef,
    preconditions: base.preconditions,
    requiredCapabilities: base.requiredCapabilities,
    permissions: base.permissions,
    readOnly: base.readOnly,
    sideEffect: base.sideEffect,
    evidenceRequirements: base.evidenceRequirements,
  }
}

async function seedRule(h: ReturnType<typeof harness>, condition: RuleExpressionNode, exceptions: readonly RuleExceptionNode[] = []) {
  return h.ruleActionService.saveRuleCandidate(
    WORKSPACE_ID,
    {
      displayName: 'Power rule',
      businessMeaning: 'power must be at least 10 kW',
      suggestedReason: 'derived from source',
      ruleId: 'rule.power_ok',
      applicability: { objectId: 'device' },
      condition,
      exceptions,
      ruleDependencies: [],
      sourceRefs: [resourceRef()],
      expectedRevision: '1',
      idempotencyKey: `rule-${randomUUID()}`,
    },
    'editor-1',
    EDITOR,
  )
}

async function seedAction(h: ReturnType<typeof harness>, declaration: ActionDeclaration) {
  return h.ruleActionService.saveActionCandidate(
    WORKSPACE_ID,
    {
      declaration,
      sourceRefs: [resourceRef()],
      expectedRevision: '1',
      idempotencyKey: `action-${randomUUID()}`,
      bindingContext: {
        registry: registry(),
        authorizedOperations: [{ id: 'home-energy.plan', version: '1' }],
        availableCapabilities: ['home-energy.planning'],
        recordedAt: '2026-09-29T00:00:00Z',
      },
    },
    'editor-1',
    EDITOR,
  )
}

function cases(): SyntheticCase[] {
  return [
    { caseId: 'case-missing', caseKind: 'missing_parameter', objectTypeRef: 'device', fields: [] },
    {
      caseId: 'case-same-name',
      caseKind: 'same_name_different_meaning',
      objectTypeRef: 'device',
      displayName: 'Meter',
      alternateObjectTypeRef: 'sensor',
      fields: [{ fieldId: 'power', value: 5, unitCode: 'kW' }],
    },
    {
      caseId: 'case-contradiction',
      caseKind: 'contradiction',
      objectTypeRef: 'device',
      fields: [
        { fieldId: 'power', value: 5, unitCode: 'kW' },
        { fieldId: 'power', value: 20, unitCode: 'kW' },
      ],
    },
    {
      caseId: 'case-wrong-unit',
      caseKind: 'wrong_unit',
      objectTypeRef: 'device',
      fields: [{ fieldId: 'power', value: 5, unitCode: 'kWh' }],
    },
    {
      caseId: 'case-missing-capability',
      caseKind: 'missing_capability',
      objectTypeRef: 'device',
      fields: [{ fieldId: 'power', value: 20, unitCode: 'kW' }],
    },
  ]
}

function expectations(): SyntheticExpectation[] {
  const base = {
    origin: 'authored_oracle' as const,
    reason: 'independent traffic/industry oracle',
    confirmedBy: 'expert-1',
    confirmedAt: '2026-09-29T00:00:00Z',
  }
  return [
    { ...base, expectationId: 'e-missing', caseId: 'case-missing', kind: 'rule', ruleId: 'rule.power_ok', expected: 'unknown' },
    { ...base, expectationId: 'e-same-name', caseId: 'case-same-name', kind: 'rule', ruleId: 'rule.power_ok', expected: 'false' },
    { ...base, expectationId: 'e-contradiction', caseId: 'case-contradiction', kind: 'rule', ruleId: 'rule.power_ok', expected: 'conflict' },
    { ...base, expectationId: 'e-wrong-unit', caseId: 'case-wrong-unit', kind: 'rule', ruleId: 'rule.power_ok', expected: 'unknown' },
    {
      ...base,
      expectationId: 'e-action',
      caseId: 'case-missing-capability',
      kind: 'action',
      actionId: 'action.plan_charge',
      expected: 'executable',
    },
  ]
}

async function generateSet(h: ReturnType<typeof harness>, override?: { expectations?: SyntheticExpectation[] }) {
  return h.exampleService.generate(
    WORKSPACE_ID,
    {
      caseKinds: ['missing_parameter', 'same_name_different_meaning', 'contradiction', 'wrong_unit', 'missing_capability'],
      cases: cases(),
      expectations: override?.expectations ?? expectations(),
      expectedRevision: '1',
      idempotencyKey: `set-${randomUUID()}`,
    },
    'editor-1',
    EDITOR,
  )
}

describe('isolated synthetic example sets', () => {
  it('marks a synthetic set with fixed isolation fields and keeps it out of any real fact shape', async () => {
    const h = harness()
    const set = await generateSet(h)
    expect(set.sourceKind).toBe('synthetic')
    expect(set.dataMode).toBe('synthetic')
    expect(set.isolationLabel).toBe('synthetic test')
    expect(set.page.caseRefs).toHaveLength(5)
    expect(set.expectations).toHaveLength(5)
    // The few-shot example set carries `kind`/`collectionRef`; a synthetic set must not.
    expect('collectionRef' in set).toBe(false)
    expect('kind' in set).toBe(false)
  })

  it('rejects an expectation that is not expert-confirmed or an authored oracle', async () => {
    const h = harness()
    const bad: SyntheticExpectation[] = [
      {
        expectationId: 'e-generated',
        caseId: 'case-missing',
        kind: 'rule',
        ruleId: 'rule.power_ok',
        expected: 'unknown',
        origin: 'generated',
        reason: 'model self-answer',
        confirmedBy: 'model',
        confirmedAt: '2026-09-29T00:00:00Z',
      },
    ]
    await expect(generateSet(h, { expectations: bad })).rejects.toMatchObject({
      code: 'EXPECTATION_NOT_INDEPENDENT',
    })
  })

  it('enforces editor role, CAS and Idempotency-Key', async () => {
    const h = harness()
    await expect(
      h.exampleService.generate(
        WORKSPACE_ID,
        {
          caseKinds: ['missing_parameter'],
          cases: cases(),
          expectations: expectations(),
          expectedRevision: '1',
          idempotencyKey: `set-${randomUUID()}`,
        },
        'viewer',
        VIEWER,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      h.exampleService.generate(
        WORKSPACE_ID,
        {
          caseKinds: ['missing_parameter'],
          cases: cases(),
          expectations: expectations(),
          expectedRevision: '9',
          idempotencyKey: `set-${randomUUID()}`,
        },
        'editor-1',
        EDITOR,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

describe('industry validation service', () => {
  it('validates rules/actions against independent samples and reports the two surfaces separately', async () => {
    const h = harness()
    await seedRule(h, POWER_RANGE)
    await seedAction(h, actionDeclaration())
    const set = await generateSet(h)
    const report = await h.validationService.validate(
      WORKSPACE_ID,
      { exampleSetId: set.exampleSetId, expectedRevision: '1', idempotencyKey: `val-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(report.publishable).toBe(true)
    expect(report.gate).toBe('open')
    expect(report.semanticPublished.passed).toBe(true)
    expect(report.deploymentExecutable.passed).toBe(true)
    expect(report.realFactsWritten).toBe(false)
    expect(report.businessApproval).toBe('none')
    expect(report.dataMode).toBe('synthetic')
    expect(report.rules[0]?.supportState).toBe('executable')
    expect(report.rules[0]?.deploymentExecutable).toBe(true)
    expect(report.actions[0]?.deploymentExecutable).toBe(true)
    expect(report.actions[0]?.trials.every((trial) => trial.status === 'passed')).toBe(true)
    expect(report.expectationResults.every((result) => result.matched)).toBe(true)
    expect(report.coverage.find((entry) => entry.caseId === 'case-contradiction')?.ruleIds).toContain('rule.power_ok')
    // The same idempotency key replays the stored report.
    const replay = await h.validationService.validate(
      WORKSPACE_ID,
      { exampleSetId: set.exampleSetId, expectedRevision: '1', idempotencyKey: report.idempotencyKey },
      'editor-1',
      EDITOR,
    )
    expect(replay.validationId).toBe(report.validationId)
  })

  it('blocks publication when an independent expectation does not match the engine', async () => {
    const h = harness()
    await seedRule(h, POWER_RANGE)
    await seedAction(h, actionDeclaration())
    const wrong = expectations().map((expectation) =>
      expectation.kind === 'rule' && expectation.caseId === 'case-same-name'
        ? { ...expectation, expected: 'true' as const }
        : expectation,
    )
    const set = await generateSet(h, { expectations: wrong })
    const report = await h.validationService.validate(
      WORKSPACE_ID,
      { exampleSetId: set.exampleSetId, expectedRevision: '1', idempotencyKey: `val-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(report.publishable).toBe(false)
    expect(report.gate).toBe('blocked_execution')
    expect(report.semanticPublished.passed).toBe(true)
    expect(report.deploymentExecutable.passed).toBe(false)
    expect(report.deploymentExecutable.blockers.some((issue) => issue.code === 'EXPECTATION_MISMATCH')).toBe(true)
  })

  it('keeps an unbound action as a deployment blocker while the semantics stay publishable', async () => {
    const h = harness()
    await seedRule(h, POWER_RANGE)
    await seedAction(h, unboundDeclaration())
    const actionExpectations = expectations().map((expectation) =>
      expectation.kind === 'action'
        ? { ...expectation, actionId: 'action.unbound', expected: 'blocked' as const }
        : expectation,
    )
    const set = await generateSet(h, { expectations: actionExpectations })
    const report = await h.validationService.validate(
      WORKSPACE_ID,
      { exampleSetId: set.exampleSetId, expectedRevision: '1', idempotencyKey: `val-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(report.semanticPublished.passed).toBe(true)
    expect(report.deploymentExecutable.passed).toBe(false)
    expect(report.gate).toBe('blocked_execution')
    expect(report.actions[0]?.deploymentExecutable).toBe(false)
    expect(report.actions[0]?.bindingStatus).toBe('not_executable')
    expect(report.deploymentExecutable.blockers.some((issue) => issue.code === 'ACTION_NOT_EXECUTABLE')).toBe(true)
  })

  it('surfaces missing capabilities as an explicit blocker', async () => {
    const h = harness()
    await seedRule(h, { op: 'relation', relationId: 'meter_of', spans: [] })
    const report = await (async () => {
      const set = await generateSet(h, {
        expectations: [
          {
            expectationId: 'only',
            caseId: 'case-missing-capability',
            kind: 'rule',
            ruleId: 'rule.power_ok',
            expected: 'unknown',
            origin: 'expert_confirmed',
            reason: 'oracle',
            confirmedBy: 'expert-1',
            confirmedAt: '2026-09-29T00:00:00Z',
          },
        ],
      })
      return h.validationService.validate(
        WORKSPACE_ID,
        { exampleSetId: set.exampleSetId, expectedRevision: '1', idempotencyKey: `val-${randomUUID()}` },
        'editor-1',
        EDITOR,
      )
    })()
    expect(report.rules[0]?.deploymentExecutable).toBe(false)
    expect(report.deploymentExecutable.blockers.some((issue) => issue.code === 'RULE_NOT_EXECUTABLE')).toBe(true)
  })

  it('blocks the semantic surface when the definition has a hard blocker', async () => {
    const h = harness()
    h.definitions.setPublishable(false)
    await seedRule(h, POWER_RANGE)
    await seedAction(h, actionDeclaration())
    const set = await generateSet(h)
    const report = await h.validationService.validate(
      WORKSPACE_ID,
      {
        exampleSetId: set.exampleSetId,
        draftRef: versionRef('draft', DIGEST),
        expectedRevision: '1',
        idempotencyKey: `val-${randomUUID()}`,
      },
      'editor-1',
      EDITOR,
    )
    expect(report.semanticPublished.passed).toBe(false)
    expect(report.deploymentExecutable.passed).toBe(true)
    expect(report.gate).toBe('blocked_semantic')
    expect(report.semanticPublished.blockers.some((issue) => issue.code === 'DEFINITION_BLOCKER')).toBe(true)
  })

  it('requires an editor role and an exact head revision', async () => {
    const h = harness()
    await seedRule(h, POWER_RANGE)
    const set = await generateSet(h)
    await expect(
      h.validationService.validate(
        WORKSPACE_ID,
        { exampleSetId: set.exampleSetId, expectedRevision: '1', idempotencyKey: `val-${randomUUID()}` },
        'viewer',
        VIEWER,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      h.validationService.validate(
        WORKSPACE_ID,
        { exampleSetId: set.exampleSetId, expectedRevision: '2', idempotencyKey: `val-${randomUUID()}` },
        'editor-1',
        EDITOR,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })
})

describe('synthetic isolation guard', () => {
  it('refuses to promote a synthetic sample to observed/live or across scopes', () => {
    expect(() =>
      assertSyntheticNotPublishedAsObserved({
        sourceDataMode: 'synthetic',
        targetDataMode: 'observed',
        sourceScopeRef: SCOPE,
        targetScopeRef: SCOPE,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SYNTHETIC_NOT_PUBLISHABLE' }))
    expect(() =>
      assertSyntheticNotPublishedAsObserved({
        sourceDataMode: 'synthetic',
        targetDataMode: 'synthetic',
        sourceScopeRef: SCOPE,
        targetScopeRef: { tenantId: OTHER_TENANT, spaceId: OTHER_SPACE },
      }),
    ).toThrowError(expect.objectContaining({ code: 'TARGET_SCOPE_MISMATCH' }))
    expect(() =>
      assertSyntheticNotPublishedAsObserved({
        sourceDataMode: 'synthetic',
        targetDataMode: 'synthetic',
        sourceScopeRef: SCOPE,
        targetScopeRef: SCOPE,
      }),
    ).not.toThrow()
  })

  it('exposes the hard refusal through the validation service', async () => {
    const h = harness()
    const set = await generateSet(h)
    expect(() =>
      h.validationService.assertSyntheticTarget(set, 'live', SCOPE, EDITOR),
    ).toThrowError(expect.objectContaining({ code: 'SYNTHETIC_NOT_PUBLISHABLE' }))
  })
})
