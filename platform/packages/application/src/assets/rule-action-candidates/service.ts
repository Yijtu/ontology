import {
  bindActionDeclaration,
  relationPremisesFromDefinition,
} from '@ontology/contracts'
import type {
  ActionCandidateVersion,
  ActionCapabilityBinding,
  ActionCapabilityBindingInput,
  ActionDeclaration,
  CandidateSourceSpan,
  IndustryWorkspace,
  IndustryWorkspaceStore,
  ResourceRef,
  RevisionString,
  RuleActionCandidateQuery,
  RuleActionCandidateStore,
  RuleActionCandidateVersion,
  RuleApplicability,
  RuleCandidateVersion,
  RuleConclusionBinding,
  RuleExceptionNode,
  RuleExpressionNode,
  RuleSupportReport,
  SemanticDefinitionVersion,
  RuleSupportValidator,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'
import { RuleActionCandidateError } from './errors'
import { parseRuleActionCandidateOutput } from './model-output'
import type { DraftRuleActionCandidate } from './model-output'

const EDITOR_ROLES: readonly string[] = ['profile-editor', 'platform-admin']
const DEFAULT_PAGE = 100

export interface RuleCandidateProposal {
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly ruleId: string
  readonly applicability: RuleApplicability
  readonly condition: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
  readonly conclusion?: RuleConclusionBinding
  readonly ruleDependencies?: readonly string[]
  readonly sourceRefs: readonly ResourceRef[]
  readonly sourceSpans?: readonly CandidateSourceSpan[]
}

export interface ActionCandidateProposal {
  readonly declaration: ActionDeclaration
  readonly sourceRefs: readonly ResourceRef[]
  readonly sourceSpans?: readonly CandidateSourceSpan[]
}

export interface SaveRuleCandidateInput extends RuleCandidateProposal {
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
}

export interface SaveActionCandidateInput extends ActionCandidateProposal {
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
  /** Trusted deployment binding context; never read from the request body or the model. */
  readonly bindingContext?: ActionCapabilityBindingInput
}

export interface IngestRuleActionOutputInput {
  readonly expectedRevision: RevisionString | undefined
  readonly rawOutput: string
  readonly sourceRefs: readonly ResourceRef[]
  readonly idempotencyKey: string
  readonly bindingContext?: ActionCapabilityBindingInput
}

export interface IngestRuleActionOutputView {
  readonly rules: readonly RuleCandidateVersion[]
  readonly actions: readonly ActionCandidateVersion[]
}

export interface EditRuleCandidateInput extends RuleCandidateProposal {
  readonly candidateId: Uuid
  readonly expectedRevision: RevisionString | undefined
  readonly reason: string
  readonly idempotencyKey: string
}

export interface EditActionCandidateInput extends ActionCandidateProposal {
  readonly candidateId: Uuid
  readonly expectedRevision: RevisionString | undefined
  readonly reason: string
  readonly idempotencyKey: string
  readonly bindingContext?: ActionCapabilityBindingInput
}

export interface EnableCandidateInput {
  readonly candidateId: Uuid
  readonly expectedRevision: RevisionString | undefined
}

export interface CandidateLifecycleView<T extends RuleActionCandidateVersion> {
  readonly candidate: T
  /** False when the candidate was already enabled. */
  readonly created: boolean
}

export interface RuleActionCandidateServiceDependencies {
  readonly workspaces: IndustryWorkspaceStore
  readonly candidates: RuleActionCandidateStore
  readonly support: RuleSupportValidator
  /** Trusted resolver of the workspace's pinned published definition. */
  readonly readRelationDefinition?: (workspaceId: Uuid, ctx: ToolContext) => Promise<SemanticDefinitionVersion | undefined>
  readonly now?: () => string
}

interface Prepared {
  readonly scopeRef: ScopeRef
  readonly workspace: IndustryWorkspace
  readonly draftRevision: RevisionString
  readonly draftDigest: Sha256Digest
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new RuleActionCandidateError(
    'FORBIDDEN',
    'only a profile-editor or platform-admin may propose or enable rule/action candidates',
  )
}

function requireRevision(revision: RevisionString | undefined, action: string): RevisionString {
  if (revision === undefined) {
    throw new RuleActionCandidateError('REVISION_REQUIRED', `an If-Match revision is required to ${action}`)
  }
  return revision
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new RuleActionCandidateError(
      'INVALID_ARGUMENT',
      'Idempotency-Key must be a string between 8 and 256 characters',
    )
  }
  return key
}

function requireReason(reason: string): string {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new RuleActionCandidateError('INVALID_ARGUMENT', 'a reason is required')
  }
  return reason
}

/**
 * The rule/action candidate service (SPEC v0.3a §3.1/§3.3/§4.2, issue V03-010 / #184).
 *
 * It saves rule and action candidates, recomputes the finite-grammar support report and the
 * capability binding server-side, appends a new immutable revision on every content-changing
 * edit, and only ever enables a candidate that fully passes both checks. A rule outside the
 * frozen executable subset is saved `not_yet_executable` with its conditions intact — never
 * deleted or weakened to force a pass.
 */
export class RuleActionCandidateService {
  readonly #workspaces: IndustryWorkspaceStore
  readonly #candidates: RuleActionCandidateStore
  readonly #support: RuleSupportValidator
  readonly #readRelationDefinition: RuleActionCandidateServiceDependencies['readRelationDefinition']
  readonly #now: () => string

  constructor(dependencies: RuleActionCandidateServiceDependencies) {
    this.#workspaces = dependencies.workspaces
    this.#candidates = dependencies.candidates
    this.#support = dependencies.support
    this.#readRelationDefinition = dependencies.readRelationDefinition
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async saveRuleCandidate(
    workspaceId: Uuid,
    input: SaveRuleCandidateInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<RuleCandidateVersion> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, ctx, 'save a rule candidate')
    return this.#persistRule(prepared, input, key, actor, ctx)
  }

  async saveActionCandidate(
    workspaceId: Uuid,
    input: SaveActionCandidateInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<ActionCandidateVersion> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, ctx, 'save an action candidate')
    return this.#persistAction(prepared, input, key, actor, ctx, input.bindingContext)
  }

  /**
   * Ingest a model response as rule/action candidates. The parser preserves the original
   * condition and exceptions; an unsupported form is kept and reported non-executable. Each
   * candidate is bound to the source it cites and stored idempotently.
   */
  async ingestRuleActionOutput(
    workspaceId: Uuid,
    input: IngestRuleActionOutputInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<IngestRuleActionOutputView> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, ctx, 'ingest rule/action candidates')
    const parsed = parseRuleActionCandidateOutput(input.rawOutput)
    const rules: RuleCandidateVersion[] = []
    const actions: ActionCandidateVersion[] = []
    for (const [index, draft] of parsed.candidates.entries()) {
      const sourceRefs = sourceRefsOf(draft, input.sourceRefs)
      const candidateKey = `${key}#${String(index)}`
      if (draft.kind === 'rule') {
        rules.push(
          await this.#persistRule(
            prepared,
            {
              displayName: draft.displayName,
              businessMeaning: draft.businessMeaning,
              suggestedReason: draft.suggestedReason,
              ruleId: draft.ruleId,
              applicability: { objectId: draft.objectId, ...(draft.applicabilityNote === undefined ? {} : { note: draft.applicabilityNote }) },
              condition: draft.condition,
              exceptions: draft.exceptions,
              ...(draft.conclusion === undefined ? {} : { conclusion: draft.conclusion }),
              ruleDependencies: draft.ruleDependencies,
              sourceRefs,
            },
            candidateKey,
            actor,
            ctx,
          ),
        )
      } else {
        actions.push(
          await this.#persistAction(
            prepared,
            { declaration: draft.declaration, sourceRefs },
            candidateKey,
            actor,
            ctx,
            input.bindingContext,
          ),
        )
      }
    }
    return { rules, actions }
  }

  /** Append a new rule revision replacing `input.candidateId`; the original is preserved. */
  async editRuleCandidate(
    workspaceId: Uuid,
    input: EditRuleCandidateInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<RuleCandidateVersion> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    requireReason(input.reason)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, ctx, 'edit a rule candidate')
    const original = await this.#requireRule(workspaceId, input.candidateId, ctx)
    return this.#persistRule(prepared, input, key, actor, ctx, original.candidateId)
  }

  /** Append a new action revision replacing `input.candidateId`; the original is preserved. */
  async editActionCandidate(
    workspaceId: Uuid,
    input: EditActionCandidateInput,
    actor: string,
    ctx: ToolContext,
  ): Promise<ActionCandidateVersion> {
    assertEditor(ctx)
    const key = requireIdempotencyKey(input.idempotencyKey)
    requireReason(input.reason)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, ctx, 'edit an action candidate')
    const original = await this.#requireAction(workspaceId, input.candidateId, ctx)
    return this.#persistAction(prepared, input, key, actor, ctx, input.bindingContext, original.candidateId)
  }

  /**
   * Enable a rule candidate. The support report is recomputed from the stored condition and
   * exceptions; a candidate outside the executable subset is refused with its findings and is
   * never enabled by dropping a condition.
   */
  async enableRuleCandidate(
    workspaceId: Uuid,
    input: EnableCandidateInput,
    ctx: ToolContext,
  ): Promise<CandidateLifecycleView<RuleCandidateVersion>> {
    assertEditor(ctx)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, ctx, 'enable a rule candidate')
    const candidate = await this.#requireRule(workspaceId, input.candidateId, ctx)
    if (candidate.lifecycle === 'enabled') return { candidate, created: false }
    if (candidate.lifecycle === 'rejected') {
      throw new RuleActionCandidateError('LIFECYCLE_INVALID', 'a rejected rule candidate cannot be enabled')
    }
    const definition = await this.#relationDefinition(workspaceId, prepared.scopeRef, ctx)
    const support = this.#supportReport(candidate.payload, definition)
    if (!support.executable) {
      throw new RuleActionCandidateError(
        'SUPPORT_VALIDATION_BLOCKED',
        'the rule is outside the executable subset and cannot be enabled',
        { reasons: support.findings.map((finding) => `${finding.code}: ${finding.message}`) },
      )
    }
    const enabled = await this.#candidates.transition(
      prepared.scopeRef,
      candidate.candidateId,
      { lifecycle: 'enabled', enabledAt: this.#now() },
      ctx,
    )
    return { candidate: asRule(enabled), created: true }
  }

  /**
   * Enable an action candidate. Only a fully executable binding — a registered, authorized,
   * contract-equal, read-only operation — may be enabled; an unbound or incompatible
   * declaration is refused with its reasons.
   */
  async enableActionCandidate(
    workspaceId: Uuid,
    input: EnableCandidateInput,
    ctx: ToolContext,
  ): Promise<CandidateLifecycleView<ActionCandidateVersion>> {
    assertEditor(ctx)
    const prepared = await this.#prepare(workspaceId, input.expectedRevision, ctx, 'enable an action candidate')
    const candidate = await this.#requireAction(workspaceId, input.candidateId, ctx)
    if (candidate.lifecycle === 'enabled') return { candidate, created: false }
    if (candidate.lifecycle === 'rejected') {
      throw new RuleActionCandidateError('LIFECYCLE_INVALID', 'a rejected action candidate cannot be enabled')
    }
    const binding = candidate.payload.binding
    if (binding === undefined || !binding.executable) {
      throw new RuleActionCandidateError(
        'CAPABILITY_NOT_BOUND',
        'the action declaration has no executable capability binding',
        { reasons: (binding?.findings ?? []).map((finding) => `${finding.code}: ${finding.message}`) },
      )
    }
    const enabled = await this.#candidates.transition(
      prepared.scopeRef,
      candidate.candidateId,
      { lifecycle: 'enabled', enabledAt: this.#now() },
      ctx,
    )
    return { candidate: asAction(enabled), created: true }
  }

  listCandidates(
    workspaceId: Uuid,
    query: RuleActionCandidateQuery,
    ctx: ToolContext,
  ): Promise<RuleActionCandidateVersion[]> {
    return this.#candidates.list(scopeOf(ctx), workspaceId, query, ctx)
  }

  async getCandidate(candidateId: Uuid, ctx: ToolContext): Promise<RuleActionCandidateVersion | undefined> {
    return this.#candidates.get(scopeOf(ctx), candidateId, ctx)
  }

  /* ----------------------------------------------------------------------------------- */

  #supportReport(payload: { applicability: RuleApplicability; ruleId: string; condition: RuleExpressionNode; exceptions: readonly RuleExceptionNode[]; ruleDependencies: readonly string[] }, definition: SemanticDefinitionVersion | undefined): RuleSupportReport {
    return this.#support.validate({
      ruleId: payload.ruleId,
      condition: payload.condition,
      exceptions: payload.exceptions,
      ruleDependencies: payload.ruleDependencies,
      relationPremises: (definition === undefined ? [] : relationPremisesFromDefinition(definition, payload.condition)).filter((premise) => premise.fromObjectId === payload.applicability.objectId),
    })
  }

  async #persistRule(
    prepared: Prepared,
    proposal: RuleCandidateProposal,
    key: string,
    actor: string,
    ctx: ToolContext,
    replacesCandidateId?: Uuid,
  ): Promise<RuleCandidateVersion> {
    const definition = await this.#relationDefinition(prepared.workspace.workspaceId, prepared.scopeRef, ctx)
    const ruleDependencies = proposal.ruleDependencies ?? []
    const support = this.#support.validate({
      ruleId: proposal.ruleId,
      condition: proposal.condition,
      exceptions: proposal.exceptions,
      ruleDependencies,
      relationPremises: (definition === undefined ? [] : relationPremisesFromDefinition(definition, proposal.condition)).filter((premise) => premise.fromObjectId === proposal.applicability.objectId),
    })
    const version: RuleCandidateVersion = {
      candidateId: this.#candidateId(key, proposal.ruleId),
      workspaceId: prepared.workspace.workspaceId,
      logicalId: proposal.ruleId,
      domain: 'definition',
      kind: 'rule',
      displayName: proposal.displayName,
      businessMeaning: proposal.businessMeaning,
      suggestedReason: proposal.suggestedReason,
      payload: {
        kind: 'rule',
        ruleId: proposal.ruleId,
        applicability: proposal.applicability,
        condition: proposal.condition,
        exceptions: proposal.exceptions,
        ...(proposal.conclusion === undefined ? {} : { conclusion: proposal.conclusion }),
        ruleDependencies,
        support,
      },
      sourceRefs: proposal.sourceRefs,
      sourceSpans: proposal.sourceSpans ?? [],
      lifecycle: 'draft',
      ...(replacesCandidateId === undefined ? {} : { replacesCandidateId }),
      contentDigest: this.#contentDigest({
        workspaceId: prepared.workspace.workspaceId,
        logicalId: proposal.ruleId,
        kind: 'rule',
        payload: {
          kind: 'rule',
          ruleId: proposal.ruleId,
          applicability: proposal.applicability,
          condition: proposal.condition,
          exceptions: proposal.exceptions,
          ...(proposal.conclusion === undefined ? {} : { conclusion: proposal.conclusion }),
          ruleDependencies,
          support,
        },
        sourceRefs: proposal.sourceRefs,
        draftRevision: prepared.draftRevision,
        draftDigest: prepared.draftDigest,
      }),
      idempotencyKey: this.#candidateKeyDigest(key, proposal.ruleId),
      actor,
      recordedAt: this.#now(),
    }
    const stored = await this.#candidates.insert(prepared.scopeRef, version, ctx)
    return asRule(stored)
  }

  async #persistAction(
    prepared: Prepared,
    proposal: ActionCandidateProposal,
    key: string,
    actor: string,
    ctx: ToolContext,
    bindingContext?: ActionCapabilityBindingInput,
    replacesCandidateId?: Uuid,
  ): Promise<ActionCandidateVersion> {
    const binding: ActionCapabilityBinding | undefined =
      bindingContext === undefined ? undefined : bindActionDeclaration(proposal.declaration, bindingContext)
    const payload = {
      kind: 'action' as const,
      declaration: proposal.declaration,
      ...(binding === undefined ? {} : { binding }),
    }
    const version: ActionCandidateVersion = {
      candidateId: this.#candidateId(key, proposal.declaration.actionId),
      workspaceId: prepared.workspace.workspaceId,
      logicalId: proposal.declaration.actionId,
      domain: 'definition',
      kind: 'action',
      displayName: proposal.declaration.displayName,
      businessMeaning: proposal.declaration.businessMeaning,
      suggestedReason: proposal.declaration.suggestedReason,
      payload,
      sourceRefs: proposal.sourceRefs,
      sourceSpans: proposal.sourceSpans ?? [],
      lifecycle: 'draft',
      ...(replacesCandidateId === undefined ? {} : { replacesCandidateId }),
      contentDigest: this.#contentDigest({
        workspaceId: prepared.workspace.workspaceId,
        logicalId: proposal.declaration.actionId,
        kind: 'action',
        payload,
        sourceRefs: proposal.sourceRefs,
        draftRevision: prepared.draftRevision,
        draftDigest: prepared.draftDigest,
      }),
      idempotencyKey: this.#candidateKeyDigest(key, proposal.declaration.actionId),
      actor,
      recordedAt: this.#now(),
    }
    const stored = await this.#candidates.insert(prepared.scopeRef, version, ctx)
    return asAction(stored)
  }

  #candidateId(key: string, logicalId: string): Uuid {
    return candidateIdFor(this.#candidateKeyDigest(key, logicalId))
  }

  #candidateKeyDigest(key: string, logicalId: string): Sha256Digest {
    return sha256DigestOf(canonicalJson({ idempotencyKey: key, logicalId }))
  }

  #contentDigest(args: {
    readonly workspaceId: Uuid
    readonly logicalId: string
    readonly kind: 'rule' | 'action'
    readonly payload: unknown
    readonly sourceRefs: readonly ResourceRef[]
    readonly draftRevision: RevisionString
    readonly draftDigest: Sha256Digest
  }): Sha256Digest {
    return sha256DigestOf(
      canonicalJson({
        workspaceId: args.workspaceId,
        logicalId: args.logicalId,
        kind: args.kind,
        payload: args.payload,
        sourceRefs: args.sourceRefs,
        draftRevision: args.draftRevision,
        draftDigest: args.draftDigest,
      }),
    )
  }

  async #prepare(
    workspaceId: Uuid,
    expectedRevision: RevisionString | undefined,
    ctx: ToolContext,
    action: string,
  ): Promise<Prepared> {
    const scopeRef = scopeOf(ctx)
    const workspace = await this.#workspaces.getWorkspace(scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new RuleActionCandidateError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} is not visible in this scope`)
    }
    const expected = requireRevision(expectedRevision, action)
    if (workspace.headRevision !== expected) {
      throw new RuleActionCandidateError('VERSION_CONFLICT', 'the workspace head moved before this change', {
        reasons: [`expectedRevision=${expected}`, `currentRevision=${workspace.headRevision}`],
      })
    }
    const drafts = await this.#workspaces.listDrafts(scopeRef, workspaceId, ctx)
    const draft = drafts[drafts.length - 1]
    if (draft === undefined) {
      throw new RuleActionCandidateError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} has no draft revision`)
    }
    return {
      scopeRef,
      workspace,
      draftRevision: draft.revision,
      draftDigest: draft.digest,
    }
  }

  async #relationDefinition(workspaceId: Uuid, scopeRef: ScopeRef, ctx: ToolContext): Promise<SemanticDefinitionVersion | undefined> {
    const definition = await this.#readRelationDefinition?.(workspaceId, ctx)
    return definition?.scopeRef.tenantId === scopeRef.tenantId && definition.scopeRef.spaceId === scopeRef.spaceId ? definition : undefined
  }

  async #requireRule(workspaceId: Uuid, candidateId: Uuid, ctx: ToolContext): Promise<RuleCandidateVersion> {
    const candidate = await this.#candidates.get(scopeOf(ctx), candidateId, ctx)
    if (candidate === undefined || candidate.workspaceId !== workspaceId || candidate.kind !== 'rule') {
      throw new RuleActionCandidateError('CANDIDATE_NOT_FOUND', `rule candidate ${candidateId} is not visible in this workspace`)
    }
    return asRule(candidate)
  }

  async #requireAction(workspaceId: Uuid, candidateId: Uuid, ctx: ToolContext): Promise<ActionCandidateVersion> {
    const candidate = await this.#candidates.get(scopeOf(ctx), candidateId, ctx)
    if (candidate === undefined || candidate.workspaceId !== workspaceId || candidate.kind !== 'action') {
      throw new RuleActionCandidateError('CANDIDATE_NOT_FOUND', `action candidate ${candidateId} is not visible in this workspace`)
    }
    return asAction(candidate)
  }
}

function asRule(candidate: RuleActionCandidateVersion): RuleCandidateVersion {
  if (candidate.kind !== 'rule' || candidate.payload.kind !== 'rule') {
    throw new RuleActionCandidateError('INVALID_ARGUMENT', 'the candidate is not a rule candidate')
  }
  return candidate as RuleCandidateVersion
}

function asAction(candidate: RuleActionCandidateVersion): ActionCandidateVersion {
  if (candidate.kind !== 'action' || candidate.payload.kind !== 'action') {
    throw new RuleActionCandidateError('INVALID_ARGUMENT', 'the candidate is not an action candidate')
  }
  return candidate as ActionCandidateVersion
}

function sourceRefsOf(draft: DraftRuleActionCandidate, sources: readonly ResourceRef[]): readonly ResourceRef[] {
  if (draft.sourceIndex === undefined) return []
  const ref = sources[draft.sourceIndex]
  return ref === undefined ? [] : [ref]
}

/** A page size helper shared by callers that do not page themselves. */
export const DEFAULT_RULE_ACTION_PAGE = DEFAULT_PAGE
