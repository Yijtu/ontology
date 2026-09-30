import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  ActionDeclaration,
  AppendAssetDraftInput,
  AssetDraftVersion,
  CapabilityLimits,
  CreateIndustryWorkspaceInput,
  IndustryWorkspace,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceStore,
  OperationRegistry,
  RegisteredOperation,
  ResourceRef,
  RevisionString,
  RuleExceptionNode,
  RuleExpressionNode,
  RuleComparisonOperator,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { assessRuleSupport, bindActionDeclaration } from '@ontology/contracts'
import {
  InMemoryRuleActionCandidateStore,
  RuleActionCandidateService,
  parseRuleActionCandidateOutput,
} from '@ontology/application'
import { FiniteGrammarRuleSupportValidator } from '@ontology/semantic-engine'
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
const OTHER: ToolContext = toolContext(OTHER_TENANT, OTHER_SPACE, ['profile-editor'], 'other-1')

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

function harness() {
  const workspaces = new FixtureWorkspaceStore()
  const workspace: IndustryWorkspace = {
    workspaceId: WORKSPACE_ID,
    namespace: 'rules-ws',
    displayName: 'Rule workspace',
    boundary: { goals: [], included: [], excluded: [], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
  workspaces.seed(SCOPE, workspace, [
    { workspaceId: WORKSPACE_ID, revision: '1', digest: DIGEST, documentSetRef: resourceRef(), candidateRefs: [] },
  ])
  const candidates = new InMemoryRuleActionCandidateStore()
  const service = new RuleActionCandidateService({
    workspaces,
    candidates,
    support: new FiniteGrammarRuleSupportValidator(),
    now: () => '2026-09-29T00:00:00Z',
  })
  return { service, workspaces, candidates }
}

function compare(attributeId: string, value: string | number | boolean, operator: RuleComparisonOperator = 'eq'): RuleExpressionNode {
  return { op: 'compare', attributeId, operator, value, spans: [] }
}

const RANGE: RuleExpressionNode = { op: 'range', attributeId: 'operating_hours', min: 100, unitCode: 'h', spans: [] }
const DIFFERENT_OR: RuleExpressionNode = {
  op: 'any',
  operands: [
    { op: 'compare', attributeId: 'operating_hours', operator: 'gte', value: 100, spans: [] },
    { op: 'compare', attributeId: 'alarm', operator: 'eq', value: true, spans: [] },
  ],
  spans: [],
}
const SAME_OR: RuleExpressionNode = {
  op: 'any',
  operands: [
    { op: 'compare', attributeId: 'status', operator: 'eq', value: 'on', spans: [] },
    { op: 'compare', attributeId: 'status', operator: 'eq', value: 'on', spans: [] },
  ],
  spans: [],
}
const RELATION: RuleExpressionNode = { op: 'relation', relationId: 'meter_of', spans: [] }

function ruleProposal(overrides: {
  readonly ruleId?: string
  readonly condition?: RuleExpressionNode
  readonly exceptions?: readonly RuleExceptionNode[]
  readonly ruleDependencies?: readonly string[]
} = {}) {
  return {
    displayName: 'Rule display',
    businessMeaning: 'business meaning',
    suggestedReason: 'derived from source',
    ruleId: overrides.ruleId ?? 'rule.power_ok',
    applicability: { objectId: 'device' },
    condition: overrides.condition ?? RANGE,
    exceptions: overrides.exceptions ?? [],
    ruleDependencies: overrides.ruleDependencies ?? [],
    sourceRefs: [resourceRef()],
  }
}

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
    preconditions: ['site is approved'],
    requiredCapabilities: [{ name: 'home-energy.planning', versionRange: { min: '1.0.0' } }],
    permissions: ['compute:plan'],
    readOnly: true,
    sideEffect: 'read_only',
    evidenceRequirements: ['computation'],
    suggestedOperationRef: { id: 'home-energy.plan', version: '1' },
    ...overrides,
  }
}

/** A semantic-only declaration without any implementation hint. */
function unboundActionDeclaration(): ActionDeclaration {
  const base = actionDeclaration()
  return {
    actionId: base.actionId,
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

describe('finite-grammar rule support validator', () => {
  const validator = new FiniteGrammarRuleSupportValidator()

  it('accepts the supported subset and preserves the condition verbatim', () => {
    const report = validator.validate({ ruleId: 'r1', condition: SAME_OR, exceptions: [] })
    expect(report.executable).toBe(true)
    expect(report.supportState).toBe('executable')
    expect(report.findings).toEqual([])
    expect(report.condition).toEqual(SAME_OR)
  })

  it('accepts a genuinely different-condition OR and preserves it verbatim', () => {
    const report = validator.validate({ ruleId: 'r2', condition: DIFFERENT_OR, exceptions: [] })
    expect(report.executable).toBe(true)
    expect(report.supportState).toBe('executable')
    expect(report.findings).toEqual([])
    expect(report.condition).toEqual(DIFFERENT_OR)
  })

  it('marks a relation premise not executable', () => {
    const report = validator.validate({ ruleId: 'r3', condition: RELATION, exceptions: [] })
    expect(report.executable).toBe(false)
    expect(report.findings.some((finding) => finding.code === 'RELATION_PREMISE_UNSUPPORTED')).toBe(true)
  })

  it('rejects negation of a compound operand', () => {
    const condition: RuleExpressionNode = { op: 'not', operand: { op: 'all', operands: [RANGE, compare('status', 'on', 'eq')], spans: [] }, spans: [] }
    const report = validator.validate({ ruleId: 'r4', condition, exceptions: [] })
    expect(report.executable).toBe(false)
    expect(report.findings.some((finding) => finding.code === 'UNSUPPORTED_NEGATION')).toBe(true)
  })

  it('rejects a dependency cycle and an over-deep chain', () => {
    const cycleLookup = new Map<string, readonly string[]>([
      ['rule.a', ['rule.b']],
      ['rule.b', ['rule.a']],
    ])
    const cycle = validator.validate({
      ruleId: 'rule.a',
      condition: RANGE,
      exceptions: [],
      ruleDependencies: ['rule.b'],
      dependencyLookup: cycleLookup,
    })
    expect(cycle.findings.some((finding) => finding.code === 'RULE_DEPENDENCY_CYCLE')).toBe(true)

    const deepLookup = new Map<string, readonly string[]>([
      ['r1', ['r2']],
      ['r2', ['r3']],
      ['r3', ['r4']],
      ['r4', ['r5']],
    ])
    const deep = validator.validate({
      ruleId: 'root',
      condition: RANGE,
      exceptions: [],
      ruleDependencies: ['r1'],
      dependencyLookup: deepLookup,
    })
    expect(deep.findings.some((finding) => finding.code === 'RULE_DEPENDENCY_DEPTH')).toBe(true)
  })

  it('keeps unknown, conflict and explicit false distinct', () => {
    expect(assessRuleSupport('true', [{ exceptionId: 'e1', state: 'false' }])).toMatchObject({
      applicability: 'applicable',
      propositionState: 'true',
    })
    expect(assessRuleSupport('false', [])).toMatchObject({ applicability: 'not_applicable', propositionState: 'unknown' })
    expect(assessRuleSupport('unknown', [])).toMatchObject({ applicability: 'unknown', propositionState: 'unknown' })
    expect(assessRuleSupport('conflict', [])).toMatchObject({ applicability: 'conflict', propositionState: 'conflict' })
    expect(assessRuleSupport('true', [{ exceptionId: 'e1', state: 'true' }])).toMatchObject({
      applicability: 'not_applicable',
      propositionState: 'unknown',
    })
  })
})

describe('action capability binding', () => {
  const input = {
    registry: registry(),
    authorizedOperations: [{ id: 'home-energy.plan', version: '1' }],
    availableCapabilities: ['home-energy.planning'],
    recordedAt: '2026-09-29T00:00:00Z',
  }

  it('binds only to a registered, authorized, contract-equal read-only operation', () => {
    const binding = bindActionDeclaration(actionDeclaration(), input)
    expect(binding.status).toBe('executable')
    expect(binding.executable).toBe(true)
    expect(binding.operationRef).toEqual({ id: 'home-energy.plan', version: '1' })
    expect(binding.registryRef.digest).toBe(DIGEST)
  })

  it('marks an unbound declaration not executable', () => {
    const binding = bindActionDeclaration(unboundActionDeclaration(), input)
    expect(binding.status).toBe('not_executable')
    expect(binding.findings.some((finding) => finding.code === 'NO_REGISTERED_OPERATION')).toBe(true)
  })

  it('marks an unregistered or unauthorized operation not executable', () => {
    const unregistered = bindActionDeclaration(
      actionDeclaration({ suggestedOperationRef: { id: 'unknown.op', version: '1' } }),
      input,
    )
    expect(unregistered.findings.some((finding) => finding.code === 'NO_REGISTERED_OPERATION')).toBe(true)

    const unauthorized = bindActionDeclaration(actionDeclaration(), { ...input, authorizedOperations: [] })
    expect(unauthorized.findings.some((finding) => finding.code === 'OPERATION_NOT_AUTHORIZED')).toBe(true)
  })

  it('marks a contract mismatch and a missing capability not executable', () => {
    const mismatch = bindActionDeclaration(
      actionDeclaration({ outputSchemaRef: versionRef('other.output', DIGEST) }),
      input,
    )
    expect(mismatch.findings.some((finding) => finding.code === 'CONTRACT_INCOMPATIBLE')).toBe(true)

    const missing = bindActionDeclaration(actionDeclaration(), { ...input, availableCapabilities: [] })
    expect(missing.findings.some((finding) => finding.code === 'MISSING_CAPABILITY')).toBe(true)
  })
})

describe('rule/action candidate service', () => {
  it('saves an unsupported rule non-executable and refuses to enable it without deleting conditions', async () => {
    const h = harness()
    const saved = await h.service.saveRuleCandidate(
      WORKSPACE_ID,
      { ...ruleProposal({ condition: RELATION }), expectedRevision: '1', idempotencyKey: `save-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(saved.kind).toBe('rule')
    expect(saved.payload.kind === 'rule' ? saved.payload.support.executable : true).toBe(false)
    expect(saved.payload.kind === 'rule' ? saved.payload.condition : undefined).toEqual(RELATION)

    await expect(
      h.service.enableRuleCandidate(WORKSPACE_ID, { candidateId: saved.candidateId, expectedRevision: '1' }, EDITOR),
    ).rejects.toMatchObject({ code: 'SUPPORT_VALIDATION_BLOCKED' })

    const after = await h.service.getCandidate(saved.candidateId, EDITOR)
    expect(after?.lifecycle).toBe('draft')
    expect(after?.payload.kind === 'rule' ? after.payload.condition : undefined).toEqual(RELATION)
  })

  it('saves and enables a genuine different-condition OR candidate', async () => {
    const h = harness()
    const saved = await h.service.saveRuleCandidate(
      WORKSPACE_ID,
      { ...ruleProposal({ condition: DIFFERENT_OR }), expectedRevision: '1', idempotencyKey: `save-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(saved.payload.kind === 'rule' ? saved.payload.support.executable : false).toBe(true)
    expect(saved.payload.kind === 'rule' ? saved.payload.condition : undefined).toEqual(DIFFERENT_OR)
    const enabled = await h.service.enableRuleCandidate(
      WORKSPACE_ID,
      { candidateId: saved.candidateId, expectedRevision: '1' },
      EDITOR,
    )
    expect(enabled.candidate.lifecycle).toBe('enabled')
  })

  it('enables an executable rule candidate', async () => {
    const h = harness()
    const saved = await h.service.saveRuleCandidate(
      WORKSPACE_ID,
      { ...ruleProposal(), expectedRevision: '1', idempotencyKey: `save-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    const enabled = await h.service.enableRuleCandidate(
      WORKSPACE_ID,
      { candidateId: saved.candidateId, expectedRevision: '1' },
      EDITOR,
    )
    expect(enabled.created).toBe(true)
    expect(enabled.candidate.lifecycle).toBe('enabled')
  })

  it('appends a new rule revision on edit and preserves the original', async () => {
    const h = harness()
    const original = await h.service.saveRuleCandidate(
      WORKSPACE_ID,
      { ...ruleProposal(), expectedRevision: '1', idempotencyKey: `save-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    const edited = await h.service.editRuleCandidate(
      WORKSPACE_ID,
      {
        ...ruleProposal({ condition: compare('power', 10, 'gte') }),
        candidateId: original.candidateId,
        expectedRevision: '1',
        reason: 'tighten the bound',
        idempotencyKey: `edit-${randomUUID()}`,
      },
      'editor-1',
      EDITOR,
    )
    expect(edited.candidateId).not.toBe(original.candidateId)
    expect(edited.replacesCandidateId).toBe(original.candidateId)
    const untouched = await h.service.getCandidate(original.candidateId, EDITOR)
    expect(untouched?.payload.kind === 'rule' ? untouched.payload.condition : undefined).toEqual(RANGE)
  })

  it('ingests model output, preserving conditions and marking unsupported forms non-executable', async () => {
    const h = harness()
    const output = JSON.stringify({
      rules: [
        { ruleId: 'rule.supported', displayName: 'supported', businessMeaning: 'b', suggestedReason: 's', objectId: 'device', condition: SAME_OR, exceptions: [], sourceIndex: 0 },
        { ruleId: 'rule.unsupported', displayName: 'unsupported', businessMeaning: 'b', suggestedReason: 's', objectId: 'device', condition: RELATION, exceptions: [], sourceIndex: 0 },
      ],
    })
    const view = await h.service.ingestRuleActionOutput(
      WORKSPACE_ID,
      { expectedRevision: '1', rawOutput: output, sourceRefs: [resourceRef()], idempotencyKey: `ingest-${randomUUID()}` },
      'editor-1',
      EDITOR,
    )
    expect(view.rules).toHaveLength(2)
    const statuses = view.rules.map((rule) => (rule.payload.kind === 'rule' ? rule.payload.support.executable : true))
    expect(statuses).toEqual([true, false])
    expect(view.rules[1]?.payload.kind === 'rule' ? view.rules[1].payload.condition : undefined).toEqual(RELATION)
  })

  it('rejects a model action that smuggles executable content', () => {
    const output = JSON.stringify({
      actions: [
        {
          actionId: 'action.evil',
          displayName: 'Evil',
          businessMeaning: 'b',
          suggestedReason: 's',
          inputSchemaRef: versionRef('x', IN_SCHEMA),
          outputSchemaRef: versionRef('y', OUT_SCHEMA),
          preconditions: [],
          requiredCapabilities: [],
          permissions: [],
          readOnly: true,
          sideEffect: 'read_only',
          evidenceRequirements: [],
          code: 'fetch("https://evil.example")',
        },
      ],
    })
    expect(() => parseRuleActionCandidateOutput(output)).toThrowError(
      expect.objectContaining({ code: 'ARBITRARY_EXECUTABLE_REJECTED' }),
    )
  })

  it('saves an unbound action non-executable and refuses to enable it', async () => {
    const h = harness()
    const declaration = unboundActionDeclaration()
    const saved = await h.service.saveActionCandidate(
      WORKSPACE_ID,
      {
        declaration,
        sourceRefs: [resourceRef()],
        expectedRevision: '1',
        idempotencyKey: `action-${randomUUID()}`,
        bindingContext: {
          registry: registry(),
          authorizedOperations: [],
          availableCapabilities: ['home-energy.planning'],
          recordedAt: '2026-09-29T00:00:00Z',
        },
      },
      'editor-1',
      EDITOR,
    )
    expect(saved.payload.kind === 'action' ? saved.payload.binding?.status : 'executable').toBe('not_executable')
    await expect(
      h.service.enableActionCandidate(WORKSPACE_ID, { candidateId: saved.candidateId, expectedRevision: '1' }, EDITOR),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_BOUND' })
  })

  it('enables an action bound to a registered authorized operation', async () => {
    const h = harness()
    const saved = await h.service.saveActionCandidate(
      WORKSPACE_ID,
      {
        declaration: actionDeclaration(),
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
    const enabled = await h.service.enableActionCandidate(
      WORKSPACE_ID,
      { candidateId: saved.candidateId, expectedRevision: '1' },
      EDITOR,
    )
    expect(enabled.candidate.lifecycle).toBe('enabled')
  })

  it('enforces the editor role, CAS and tenant/space scope', async () => {
    const h = harness()
    const proposal = { ...ruleProposal(), expectedRevision: '1' as const, idempotencyKey: `save-${randomUUID()}` }
    await expect(h.service.saveRuleCandidate(WORKSPACE_ID, proposal, 'viewer', VIEWER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      h.service.saveRuleCandidate(WORKSPACE_ID, { ...proposal, expectedRevision: '9' }, 'editor-1', EDITOR),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    await expect(
      h.service.saveRuleCandidate(WORKSPACE_ID, { ...proposal, expectedRevision: undefined }, 'editor-1', EDITOR),
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' })
    await expect(h.service.saveRuleCandidate(WORKSPACE_ID, proposal, 'other', OTHER)).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    })
  })
})
