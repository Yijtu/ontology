import {
  SyntheticValidationError,
  assertSyntheticExampleSetVersion,
  assertSyntheticNotPublishedAsObserved,
  bindActionDeclaration,
  isActionCandidateVersion,
  isIndependentExpectationOrigin,
  isRuleCandidateVersion,
} from '@ontology/contracts'
import type {
  ActionCapabilityBinding,
  ActionCapabilityBindingInput,
  ActionCapabilityFinding,
  ActionDeclaration,
  ActionTrialPort,
  ActionValidationResult,
  DefinitionPublicationValidationPort,
  IndustryValidationIssue,
  IndustryValidationReport,
  IndustryValidationReportStore,
  IndustryWorkspaceStore,
  ResourceRef,
  RuleActionCandidateStore,
  RuleActionCandidateVersion,
  RuleCandidateVersion,
  RuleSupportValidator,
  RuleValidationResult,
  RunIndustryValidationInput,
  ScopeRef,
  Sha256Digest,
  SyntheticCaseCoverage,
  SyntheticCaseEvaluator,
  SyntheticExpectation,
  SyntheticExpectationResult,
  SyntheticExampleSetStore,
  SyntheticExampleSetVersion,
  ToolContext,
  Uuid,
  ValidationSurfaceGate,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../extraction/canonical'

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']
const DEFAULT_PAGE = 100
const CANDIDATE_PAGE = 250

export interface IndustryValidationServiceDependencies {
  readonly workspaces: IndustryWorkspaceStore
  readonly exampleSets: SyntheticExampleSetStore
  readonly reports: IndustryValidationReportStore
  readonly definitions: DefinitionPublicationValidationPort
  readonly ruleActions: RuleActionCandidateStore
  readonly support: RuleSupportValidator
  readonly evaluator: SyntheticCaseEvaluator
  readonly actionTrials?: ActionTrialPort
  readonly now?: () => string
  readonly newId?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new SyntheticValidationError(
    'FORBIDDEN',
    'only a profile-editor or platform-admin may run an industry validation',
  )
}

function requireRevision(revision: string | undefined, action: string): string {
  if (revision === undefined) {
    throw new SyntheticValidationError('REVISION_REQUIRED', `an If-Match revision is required to ${action}`)
  }
  return revision
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new SyntheticValidationError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}

function issueFor(
  code: IndustryValidationIssue['code'],
  surface: IndustryValidationIssue['surface'],
  message: string,
  extra: Partial<IndustryValidationIssue> = {},
): IndustryValidationIssue {
  return { code, surface, message, ...extra }
}

/**
 * The industry validation service (SPEC v0.3a §3.4, §4.1; V03-014 / #186; A.US-005,
 * P.US-009/011). It runs an isolation-marked synthetic example set against the current draft:
 *
 *  - definitions are validated through the V03-009 publication port;
 *  - every rule candidate is re-checked against the frozen finite subset (the SAME support
 *    validator the publish/evaluate stages use);
 *  - every action candidate is re-bound to a registered, authorized, contract-equal operation
 *    and its capability requirements are surfaced;
 *  - each independent expectation is compared to the actual result, so a synthetic sample that
 *    does not behave as expected blocks publication.
 *
 * The two surfaces `semanticPublished` (a definition/rule/action may be published) and
 * `deploymentExecutable` (a registered implementation can actually run) are reported
 * separately. Synthetic validation never writes a real published fact, and never creates a
 * business approval: the report is the only output.
 */
export class IndustryValidationService {
  readonly #deps: IndustryValidationServiceDependencies
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: IndustryValidationServiceDependencies) {
    this.#deps = dependencies
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  /** Hard backend refusal to promote a synthetic set as observed/live or across a scope. */
  assertSyntheticTarget(
    set: SyntheticExampleSetVersion,
    targetDataMode: 'synthetic' | 'observed' | 'live',
    targetScopeRef: ScopeRef,
    ctx: ToolContext,
  ): void {
    assertSyntheticExampleSetVersion(set)
    assertSyntheticNotPublishedAsObserved({
      sourceDataMode: set.dataMode,
      targetDataMode,
      sourceScopeRef: scopeOf(ctx),
      targetScopeRef,
    })
  }

  async validate(
    workspaceId: Uuid,
    input: RunIndustryValidationInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<IndustryValidationReport> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    const scopeRef = scopeOf(ctx)
    const workspace = await this.#deps.workspaces.getWorkspace(scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new SyntheticValidationError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} is not visible in this scope`)
    }
    const expected = requireRevision(input.expectedRevision, 'run an industry validation')
    if (workspace.headRevision !== expected) {
      throw new SyntheticValidationError('VERSION_CONFLICT', 'the workspace head moved before this validation')
    }
    const replay = await this.#deps.reports.findByIdempotencyKey(scopeRef, key, ctx)
    if (replay !== undefined) return replay

    const set = await this.#deps.exampleSets.get(scopeRef, workspaceId, input.exampleSetId, ctx)
    if (set === undefined) {
      throw new SyntheticValidationError(
        'EXAMPLE_SET_NOT_FOUND',
        `example set ${input.exampleSetId} is not visible in this workspace`,
      )
    }
    assertSyntheticExampleSetVersion(set)

    const semanticBlockers: IndustryValidationIssue[] = []
    const deploymentBlockers: IndustryValidationIssue[] = []

    const definition = await this.#deps.definitions.validateForPublication(
      { workspaceId, revision: workspace.headRevision },
      ctx,
    )
    for (const finding of definition.blockers) {
      semanticBlockers.push(
        issueFor('DEFINITION_BLOCKER', 'semantic', finding.message, {
          logicalId: finding.logicalId,
        }),
      )
    }

    const candidates = await this.#deps.ruleActions.list(scopeRef, workspaceId, { limit: CANDIDATE_PAGE }, ctx)
    const current = currentCandidates(candidates)
    const ruleCandidates = current.filter(isRuleCandidateVersion)
    const actionCandidates = current.filter(isActionCandidateVersion)

    const ruleResults: RuleValidationResult[] = []
    for (const candidate of ruleCandidates) {
      const payload = candidate.payload
      const support = this.#deps.support.validate({
        ruleId: payload.ruleId,
        condition: payload.condition,
        exceptions: payload.exceptions,
        ruleDependencies: payload.ruleDependencies,
      })
      if (!support.executable) {
        deploymentBlockers.push(
          issueFor(
            'RULE_NOT_EXECUTABLE',
            'deployment',
            `rule ${payload.ruleId} is outside the executable subset`,
            { ruleId: payload.ruleId },
          ),
        )
      }
      ruleResults.push({
        candidateId: candidate.candidateId,
        ruleId: payload.ruleId,
        supportState: support.supportState,
        semanticPublished: true,
        deploymentExecutable: support.executable,
        findings: support.findings,
        coveredCaseIds: coveredCases(set, 'rule', payload.ruleId),
      })
    }

    const actionResults: ActionValidationResult[] = []
    for (const candidate of actionCandidates) {
      const declaration = candidate.payload.declaration
      const binding = this.#bind(declaration, candidate.payload.binding, input.actionBindingContext)
      const findings: ActionCapabilityFinding[] = [...(binding?.findings ?? [
        { code: 'NO_REGISTERED_OPERATION', message: 'no trusted binding context was provided for this validation' },
      ])]
      const missingCapabilities = missingCapabilitiesOf(declaration, binding, input.actionBindingContext)
      const executable = binding?.executable === true
      if (!executable) {
        deploymentBlockers.push(
          issueFor(
            'ACTION_NOT_EXECUTABLE',
            'deployment',
            `action ${declaration.actionId} has no executable capability binding`,
            { actionId: declaration.actionId },
          ),
        )
        for (const missing of missingCapabilities) {
          deploymentBlockers.push(
            issueFor('MISSING_CAPABILITY', 'deployment', `action ${declaration.actionId} requires the ${missing} capability`, {
              actionId: declaration.actionId,
            }),
          )
        }
      }
      const trials = await this.#runTrials(declaration, binding, set, actionableCases(set, declaration.actionId), ctx)
      for (const trial of trials) {
        if (trial.status === 'failed') {
          deploymentBlockers.push(
            issueFor('TRIAL_FAILED', 'deployment', `action ${declaration.actionId} trial failed: ${trial.message}`, {
              actionId: declaration.actionId,
              caseId: trial.caseId,
            }),
          )
        }
      }
      actionResults.push({
        candidateId: candidate.candidateId,
        actionId: declaration.actionId,
        bindingStatus: binding?.status ?? 'not_executable',
        semanticPublished: true,
        deploymentExecutable: executable,
        findings,
        requiredCapabilities: declaration.requiredCapabilities,
        missingCapabilities,
        trials,
        coveredCaseIds: coveredCases(set, 'action', declaration.actionId),
      })
    }

    const ruleByRuleId = new Map(ruleResults.map((result) => [result.ruleId, result]))
    const actionByActionId = new Map(actionResults.map((result) => [result.actionId, result]))
    const caseById = new Map(set.cases.map((item) => [item.caseId, item]))
    const coverageMap = new Map<string, { ruleIds: Set<string>; actionIds: Set<string> }>()
    const expectationResults: SyntheticExpectationResult[] = []

    for (const expectation of set.expectations) {
      const coverage = coverageMap.get(expectation.caseId) ?? { ruleIds: new Set<string>(), actionIds: new Set<string>() }
      coverageMap.set(expectation.caseId, coverage)
      const independent = isIndependentExpectationOrigin(expectation.origin)
      if (!independent) {
        semanticBlockers.push(
          issueFor(
            'EXPECTATION_NOT_INDEPENDENT',
            'semantic',
            `expectation ${expectation.expectationId} is not expert-confirmed or an authored oracle`,
            { caseId: expectation.caseId },
          ),
        )
        expectationResults.push(expectationResult(expectation, 'not_independent', 'not_independent', false))
        continue
      }
      const item = caseById.get(expectation.caseId)
      if (item === undefined) {
        semanticBlockers.push(
          issueFor('EXPECTATION_UNKNOWN_CASE', 'semantic', `expectation ${expectation.expectationId} references an unknown case`, {
            caseId: expectation.caseId,
          }),
        )
        expectationResults.push(expectationResult(expectation, 'unknown_case', 'unknown_case', false))
        continue
      }
      if (expectation.kind === 'rule') {
        coverage.ruleIds.add(expectation.ruleId)
        const result = ruleByRuleId.get(expectation.ruleId)
        if (result === undefined) {
          semanticBlockers.push(
            issueFor('EXPECTATION_UNKNOWN_RULE', 'semantic', `expectation references unknown rule ${expectation.ruleId}`, {
              ruleId: expectation.ruleId,
              caseId: expectation.caseId,
            }),
          )
          expectationResults.push(expectationResult(expectation, expectation.expected, 'unknown_rule', false))
          continue
        }
        if (!result.deploymentExecutable) {
          expectationResults.push(expectationResult(expectation, expectation.expected, 'not_executable', false))
          deploymentBlockers.push(
            issueFor('EXPECTATION_MISMATCH', 'deployment', `rule ${expectation.ruleId} is not executable to satisfy ${expectation.expectationId}`, {
              ruleId: expectation.ruleId,
              caseId: expectation.caseId,
            }),
          )
          continue
        }
        const payload = ruleCandidatePayload(ruleCandidates, expectation.ruleId)
        const evaluated = this.#deps.evaluator.evaluateRule({
          condition: payload.condition,
          exceptions: payload.exceptions,
          fields: item.fields,
        })
        const matched = evaluated.conditionState === expectation.expected
        expectationResults.push(expectationResult(expectation, expectation.expected, evaluated.conditionState, matched))
        if (!matched) {
          deploymentBlockers.push(
            issueFor(
              'EXPECTATION_MISMATCH',
              'deployment',
              `case ${item.caseId} expected ${expectation.expected} for rule ${expectation.ruleId} but the engine produced ${evaluated.conditionState}`,
              { ruleId: expectation.ruleId, caseId: item.caseId },
            ),
          )
        }
        continue
      }
      coverage.actionIds.add(expectation.actionId)
      const result = actionByActionId.get(expectation.actionId)
      if (result === undefined) {
        semanticBlockers.push(
          issueFor('EXPECTATION_UNKNOWN_ACTION', 'semantic', `expectation references unknown action ${expectation.actionId}`, {
            actionId: expectation.actionId,
            caseId: expectation.caseId,
          }),
        )
        expectationResults.push(expectationResult(expectation, expectation.expected, 'unknown_action', false))
        continue
      }
      const actual = result.deploymentExecutable ? 'executable' : 'blocked'
      const matched = actual === expectation.expected
      expectationResults.push(expectationResult(expectation, expectation.expected, actual, matched))
      if (!matched) {
        deploymentBlockers.push(
          issueFor(
            'EXPECTATION_MISMATCH',
            'deployment',
            `case ${item.caseId} expected action ${expectation.actionId} to be ${expectation.expected} but it is ${actual}`,
            { actionId: expectation.actionId, caseId: item.caseId },
          ),
        )
      }
    }

    if (set.expectations.length === 0) {
      semanticBlockers.push(
        issueFor(
          'NO_INDEPENDENT_EXPECTATIONS',
          'semantic',
          'the synthetic example set carries no independent expectation',
        ),
      )
    }
    for (const kind of set.caseKinds) {
      if (!set.cases.some((item) => item.caseKind === kind)) {
        semanticBlockers.push(
          issueFor('CASE_KIND_UNCOVERED', 'semantic', `no synthetic case covers the ${kind} counterexample`),
        )
      }
    }

    const coverage: SyntheticCaseCoverage[] = set.cases.map((item) => {
      const entry = coverageMap.get(item.caseId)
      return {
        caseId: item.caseId,
        caseKind: item.caseKind,
        ruleIds: [...(entry?.ruleIds ?? [])].sort(),
        actionIds: [...(entry?.actionIds ?? [])].sort(),
      }
    })

    const semanticPassed = semanticBlockers.length === 0
    const deploymentPassed =
      deploymentBlockers.length === 0 &&
      ruleResults.every((result) => result.deploymentExecutable) &&
      actionResults.every((result) => result.deploymentExecutable)
    const semanticPublished: ValidationSurfaceGate = { passed: semanticPassed, blockers: semanticBlockers }
    const deploymentExecutable: ValidationSurfaceGate = {
      passed: deploymentPassed,
      blockers: deploymentBlockers,
    }
    const publishable = semanticPassed && deploymentPassed
    const gate: IndustryValidationReport['gate'] = publishable
      ? 'open'
      : !semanticPassed && !deploymentPassed
        ? 'blocked_both'
        : !semanticPassed
          ? 'blocked_semantic'
          : 'blocked_execution'

    const issues = [...semanticBlockers, ...deploymentBlockers]
    const exampleSetRef: ResourceRef = {
      id: set.exampleSetId,
      version: '1.0.0',
      digest: set.contentDigest,
      kind: 'dataset',
    }
    const report: IndustryValidationReport = {
      validationId: this.#newId(),
      workspaceId,
      revision: workspace.headRevision,
      ...(input.draftRef === undefined ? {} : { draftRef: input.draftRef }),
      ...(input.definitionRef === undefined ? {} : { definitionRef: input.definitionRef }),
      exampleSetId: set.exampleSetId,
      exampleSetRef,
      ...(input.validationPolicyRef === undefined ? {} : { validationPolicyRef: input.validationPolicyRef }),
      dataMode: 'synthetic',
      isolationLabel: 'synthetic test',
      businessApproval: 'none',
      realFactsWritten: false,
      definition,
      rules: ruleResults,
      actions: actionResults,
      semanticPublished,
      deploymentExecutable,
      publishable,
      gate,
      issues,
      expectationResults,
      coverage,
      contentDigest: this.#contentDigest(exampleSetRef, ruleResults, actionResults, expectationResults),
      idempotencyKey: key,
      actor,
      recordedAt: this.#now(),
    }
    return this.#deps.reports.insert(scopeRef, report, ctx)
  }

  async getReport(workspaceId: Uuid, validationId: Uuid, ctx: ToolContext): Promise<IndustryValidationReport | undefined> {
    return this.#deps.reports.get(scopeOf(ctx), workspaceId, validationId, ctx)
  }

  listReports(workspaceId: Uuid, limit: number | undefined, ctx: ToolContext): Promise<IndustryValidationReport[]> {
    return this.#deps.reports.list(scopeOf(ctx), workspaceId, limit ?? DEFAULT_PAGE, ctx)
  }

  #bind(
    declaration: ActionDeclaration,
    stored: ActionCapabilityBinding | undefined,
    context: ActionCapabilityBindingInput | undefined,
  ): ActionCapabilityBinding | undefined {
    if (context !== undefined) return bindActionDeclaration(declaration, context)
    return stored
  }

  async #runTrials(
    declaration: ActionDeclaration,
    binding: ActionCapabilityBinding | undefined,
    set: SyntheticExampleSetVersion,
    caseIds: readonly string[],
    ctx: ToolContext,
  ): Promise<ActionValidationResult['trials']> {
    if (binding === undefined) return []
    const byId = new Map(set.cases.map((item) => [item.caseId, item]))
    const receipts: ActionValidationResult['trials'][number][] = []
    for (const caseId of caseIds) {
      const item = byId.get(caseId)
      if (item === undefined) continue
      if (!binding.executable) {
        receipts.push({
          actionId: declaration.actionId,
          caseId,
          status: 'blocked',
          message: 'the action declaration has no executable capability binding',
          recordedAt: this.#now(),
        })
        continue
      }
      if (this.#deps.actionTrials === undefined) {
        receipts.push({
          actionId: declaration.actionId,
          caseId,
          status: 'not_run',
          message: 'no controlled action trial extension is registered in this deployment',
          recordedAt: this.#now(),
        })
        continue
      }
      receipts.push(
        await this.#deps.actionTrials.trial(
          { declaration, binding, caseId, caseKind: item.caseKind, fields: item.fields },
          ctx,
        ),
      )
    }
    return receipts
  }

  #contentDigest(
    exampleSetRef: ResourceRef,
    rules: readonly RuleValidationResult[],
    actions: readonly ActionValidationResult[],
    expectations: readonly SyntheticExpectationResult[],
  ): Sha256Digest {
    return sha256DigestOf(
      canonicalJson({
        exampleSetRef,
        rules,
        actions,
        expectations,
      }),
    )
  }
}

type ActionCandidateVersionDeclaration = Parameters<typeof bindActionDeclaration>[0]

function currentCandidates(candidates: readonly RuleActionCandidateVersion[]): RuleActionCandidateVersion[] {
  const latest = new Map<string, RuleActionCandidateVersion>()
  for (const candidate of candidates) {
    if (candidate.lifecycle === 'rejected') continue
    const existing = latest.get(candidate.logicalId)
    if (existing === undefined || existing.recordedAt <= candidate.recordedAt) latest.set(candidate.logicalId, candidate)
  }
  return [...latest.values()].sort((left, right) => left.logicalId.localeCompare(right.logicalId))
}

function coveredCases(set: SyntheticExampleSetVersion, kind: SyntheticExpectation['kind'], targetId: string): string[] {
  return set.expectations
    .filter((expectation) =>
      kind === 'rule'
        ? expectation.kind === 'rule' && expectation.ruleId === targetId
        : expectation.kind === 'action' && expectation.actionId === targetId,
    )
    .map((expectation) => expectation.caseId)
    .sort()
}

function actionableCases(set: SyntheticExampleSetVersion, actionId: string): string[] {
  return coveredCases(set, 'action', actionId)
}

function missingCapabilitiesOf(
  declaration: ActionCandidateVersionDeclaration,
  binding: ActionCapabilityBinding | undefined,
  context: ActionCapabilityBindingInput | undefined,
): string[] {
  const missing = new Set<string>()
  if (context !== undefined) {
    const available = new Set(context.availableCapabilities)
    for (const requirement of declaration.requiredCapabilities) {
      if (!available.has(requirement.name)) missing.add(requirement.name)
    }
  }
  for (const finding of binding?.findings ?? []) {
    if (finding.code === 'MISSING_CAPABILITY') {
      const match = /the ([^ ]+) capability/.exec(finding.message)
      if (match?.[1] !== undefined) missing.add(match[1])
    }
  }
  return [...missing].sort()
}

function ruleCandidatePayload(candidates: readonly RuleCandidateVersion[], ruleId: string): {
  readonly condition: RuleCandidateVersion['payload']['condition']
  readonly exceptions: RuleCandidateVersion['payload']['exceptions']
} {
  const candidate = candidates.find((entry) => entry.payload.ruleId === ruleId)
  if (candidate === undefined) {
    throw new SyntheticValidationError('INVALID_ARGUMENT', `rule ${ruleId} is not part of the validated draft`)
  }
  return { condition: candidate.payload.condition, exceptions: candidate.payload.exceptions }
}

function expectationResult(
  expectation: SyntheticExpectation,
  expected: string,
  actual: string,
  matched: boolean,
): SyntheticExpectationResult {
  return {
    expectationId: expectation.expectationId,
    caseId: expectation.caseId,
    kind: expectation.kind,
    targetId: expectation.kind === 'rule' ? expectation.ruleId : expectation.actionId,
    expected,
    actual,
    matched,
    origin: expectation.origin,
    independent: isIndependentExpectationOrigin(expectation.origin),
  }
}

export const DEFAULT_INDUSTRY_VALIDATION_PAGE = DEFAULT_PAGE
