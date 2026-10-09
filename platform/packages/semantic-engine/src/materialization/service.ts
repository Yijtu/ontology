import { isToolContext } from '@ontology/contracts'
import type {
  ControlReadProjectionRequest,
  MaterializationChange,
  MaterializedConclusion,
  ProjectionSlice,
  RevisionString,
  ScopeRef,
  SourceWatermark,
  ToolContext,
  Uuid,
  ValidityInterval,
  VersionRef,
} from '@ontology/contracts'
import type { RuleApplicabilityResult, RuleConclusionResult, RuleFact, SupportRule } from '../rules'
import { RuleEvaluator, conclusionQualifiedKey } from '../rules'
import { MaterializationDependencyIndex } from './dependency-index'
import { MaterializationError } from './errors'
import { ruleComputationArtifactsOf } from './artifacts'
import type { RuleComputationArtifact } from '@ontology/contracts'
import type {
  MaterializationAdvanceResult,
  MaterializationPublishedSource,
  MaterializationReadRequest,
  MaterializationReadResult,
  MaterializationServiceDependencies,
  MaterializationTicket,
  PublishedSemanticData,
} from './types'

const DEFAULT_MAX_FANOUT = 256

/** A fixed projection identity for on-demand and materialised agreement comparisons. */
const PROJECTION_REF: VersionRef = {
  id: 'projection.materialized',
  version: '1.0.0',
  digest: `sha256:${'0'.repeat(64)}`,
}

interface ValidityWindow {
  readonly validFrom: string
  readonly validTo?: string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new MaterializationError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new MaterializationError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertScope(scopeRef: ScopeRef, trusted: ScopeRef): void {
  if (scopeRef.tenantId !== trusted.tenantId || scopeRef.spaceId !== trusted.spaceId) {
    throw new MaterializationError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

function compareRevision(left: RevisionString, right: RevisionString): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left < right ? -1 : left > right ? 1 : 0
}

function nextGeneration(generation: RevisionString): RevisionString {
  const parsed = Number(generation)
  return Number.isFinite(parsed) ? String(parsed + 1) : `${generation}.1`
}

function covers(slice: ProjectionSlice, validAt: string): boolean {
  if (slice.validity.validFrom > validAt) return false
  const validTo = slice.validity.validTo
  return validTo === undefined || validAt < validTo
}

/** The latest slice covering `validAt` that was recorded no later than `asOf` (D3.1). */
function bestSlice(
  slices: readonly ProjectionSlice[],
  propositionKey: string,
  validAt: string,
  asOf: RevisionString,
): ProjectionSlice | undefined {
  let best: ProjectionSlice | undefined
  for (const slice of slices) {
    if (slice.propositionKey !== propositionKey) continue
    if (!covers(slice, validAt)) continue
    if (compareRevision(slice.recordedSeq, asOf) > 0) continue
    if (
      best === undefined ||
      compareRevision(slice.recordedSeq, best.recordedSeq) > 0 ||
      (compareRevision(slice.recordedSeq, best.recordedSeq) === 0 &&
        slice.validity.validFrom > best.validity.validFrom)
    ) {
      best = slice
    }
  }
  return best
}

function intersects(left: ValidityWindow, right: ValidityInterval): boolean {
  const leftTo = left.validTo
  const rightTo = right.validTo
  const startsBeforeOtherEnds = rightTo === undefined || left.validFrom < rightTo
  const otherStartsBeforeThisEnds = leftTo === undefined || right.validFrom < leftTo
  return startsBeforeOtherEnds && otherStartsBeforeThisEnds
}

function changeValidity(change: MaterializationChange): ValidityInterval | undefined {
  switch (change.kind) {
    case 'assertion_published':
    case 'assertion_corrected':
    case 'assertion_retracted':
      return change.validity
    default:
      return undefined
  }
}

/**
 * The distinct validity windows of the facts that feed a proposition, split by every validity
 * boundary so a partial-interval correction materialises only the interval it acts on (D3.1).
 */
function subIntervalsFor(
  propositionKey: string,
  facts: readonly RuleFact[],
  rules: readonly SupportRule[],
  change: MaterializationChange,
): readonly ValidityWindow[] {
  const predicates = new Set<string>()
  const boundariesForRule = new Set<string>()
  const visited = new Set<string>()
  const pending = [propositionKey]
  while (pending.length > 0) {
    const key = pending.pop()
    if (key === undefined || visited.has(key)) continue
    visited.add(key)
    for (const rule of rules) {
      if (rule.conclusion.propositionKey !== key) continue
      if (rule.publishedInstance?.validFrom !== undefined) boundariesForRule.add(rule.publishedInstance.validFrom)
      if (rule.publishedInstance?.validTo !== undefined) boundariesForRule.add(rule.publishedInstance.validTo)
      for (const group of rule.premiseGroups) {
        predicates.add(group.filter.fieldRef)
        for (const alternative of group.alternatives) if (alternative.propositionKey !== undefined) pending.push(alternative.propositionKey)
      }
    }
  }
  const boundaries = new Set<string>(boundariesForRule)
  for (const fact of facts) {
    if (!predicates.has(fact.predicate)) continue
    // Only facts visible at the change's recorded version shape this view's intervals, so a
    // correction recorded later splits the interval only when it becomes visible (D3.1).
    if (compareRevision(fact.recordedSeq, change.recordedSeq) > 0) continue
    boundaries.add(fact.validity.validFrom)
    if (fact.validity.validTo !== undefined) boundaries.add(fact.validity.validTo)
  }
  const changeWindow = changeValidity(change)
  if (changeWindow !== undefined) {
    boundaries.add(changeWindow.validFrom)
    if (changeWindow.validTo !== undefined) boundaries.add(changeWindow.validTo)
  }
  const sorted = [...boundaries].sort()
  const windows: ValidityWindow[] = []
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const validFrom = sorted[index]
    const validTo = sorted[index + 1]
    if (validFrom === undefined || validTo === undefined) continue
    windows.push({ validFrom, validTo })
  }
  const only = sorted[0]
  if (sorted.length === 1 && only !== undefined) windows.push({ validFrom: only })
  const last = sorted.at(-1)
  if (sorted.length > 1 && last !== undefined) windows.push({ validFrom: last })
  if (changeWindow === undefined) return windows
  return windows.filter((window) => intersects(window, changeWindow))
}

function materializedConclusionOf(
  conclusion: RuleConclusionResult,
  ruleArtifacts: readonly RuleComputationArtifact[] = [],
): MaterializedConclusion {
  return {
    propositionKey: conclusion.propositionKey,
    qualifiedPropositionKey: conclusion.qualifiedPropositionKey,
    predicate: conclusion.predicate,
    domainStatus: conclusion.domainStatus,
    ...(conclusion.value === undefined ? {} : { value: conclusion.value }),
    satisfiedBy: conclusion.satisfiedBy.map((entry) => ({
      groupId: entry.groupId,
      alternativeIds: [...entry.alternativeIds],
    })),
    ruleRefs: conclusion.ruleRefs.map((ref) => ({ id: ref.id, version: ref.version, digest: ref.digest })),
    factRefs: conclusion.factRefs.map((ref) => ({
      assertionId: ref.assertionId,
      logicalAssertionId: ref.logicalAssertionId,
      recordedSeq: ref.recordedSeq,
      digest: ref.digest,
    })),
    supportNodeId: conclusion.supportNodeId,
    ...(ruleArtifacts.length === 0 ? {} : { ruleArtifacts: [...ruleArtifacts] }),
  }
}

interface MaterializationEvaluation {
  readonly conclusions: readonly MaterializedConclusion[]
  readonly applicabilities: readonly RuleApplicabilityResult[]
  readonly ruleArtifacts: readonly RuleComputationArtifact[]
}

function artifactsForProposition(
  propositionKey: string,
  rules: readonly SupportRule[],
  artifacts: readonly RuleComputationArtifact[],
): RuleComputationArtifact[] {
  const instanceKeys = new Set(
    rules
      .filter((rule) => rule.conclusion.propositionKey === propositionKey)
      .flatMap((rule) => rule.publishedInstance === undefined ? [] : [rule.publishedInstance.instanceKey]),
  )
  return artifacts.filter((artifact) => instanceKeys.has(artifact.instanceKey))
}

function dedupeArtifacts(artifacts: readonly RuleComputationArtifact[]): RuleComputationArtifact[] {
  const byInstance = new Map<string, RuleComputationArtifact>()
  for (const artifact of artifacts) byInstance.set(artifact.instanceKey, artifact)
  return [...byInstance.values()].sort((left, right) => left.instanceKey.localeCompare(right.instanceKey))
}

function isIncompletePublishedRead(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return error.code === 'INCOMPLETE_PUBLISHED_READ'
}

function incompleteReason(published: PublishedSemanticData): string {
  const issues = issuesOf(published).map((issue) => `${issue.code}: ${issue.message}`)
  return issues.length === 0
    ? 'the published semantic source did not complete its stable read'
    : `the published semantic source is incomplete: ${issues.join('; ')}`
}

function issuesOf(published: PublishedSemanticData): NonNullable<MaterializationReadResult['issues']> {
  return [
    ...(published.issues ?? []),
    ...(published.ruleIssues ?? []).map((issue) => ({
      code: issue.code,
      message: issue.message,
      ...(issue.subjectEntityId === undefined ? {} : { subjectEntityId: issue.subjectEntityId }),
    })),
    ...(published.attributeIssues ?? []).map((issue) => ({
      code: issue.code,
      message: issue.attributeId === undefined ? issue.message : `${issue.attributeId}: ${issue.message}`,
      statementId: issue.statementId,
    })),
  ]
}

function knownPropositions(published: PublishedSemanticData): string[] {
  return [...new Set(published.rules.map((rule) => rule.conclusion.propositionKey))].sort()
}

function incompleteReadResult(
  scopeRef: ScopeRef,
  generation: RevisionString,
  published: PublishedSemanticData | undefined,
  propositionKeys: readonly string[] | undefined,
  status: 'dirty' | 'fenced' | 'history_unavailable',
  reason: string,
): MaterializationReadResult {
  return {
    status,
    scopeRef,
    generation,
    conclusions: [],
    blockedPropositionKeys: propositionKeys === undefined
      ? (published === undefined ? [] : knownPropositions(published))
      : [...new Set(propositionKeys)].sort(),
    reason,
    ...(published === undefined ? {} : { issues: issuesOf(published) }),
  }
}

/**
 * Change-driven incremental materialisation (SPEC D5/D5.1, ADR-13, US-016/US-017,
 * FR-18/FR-19/FR-20).
 *
 * `beginChange` resolves the change through the dependency index and opens the invalidation
 * fence *before* any recomputation; `advance` then evaluates only the affected rules and commits
 * a new projection generation, closing the fence in the same transaction. A read that meets an
 * open fence or a dirty scope returns `fenced`/`dirty` instead of an out-of-date conclusion. The
 * projection is append-only across `(validity interval, recordedSeq)`, so a partial correction
 * never overwrites another interval and a historical read still resolves the older slice.
 */
export class IncrementalMaterializer {
  readonly #publishedSource: MaterializationPublishedSource
  readonly #materialization: MaterializationServiceDependencies['materialization']
  readonly #projectionRef: VersionRef
  readonly #evaluator: RuleEvaluator
  readonly #maxFanout: number
  readonly #now: () => string
  readonly #newId: () => string
  readonly #faultInjection: MaterializationServiceDependencies['faultInjection']

  constructor(dependencies: MaterializationServiceDependencies) {
    this.#publishedSource = dependencies.publishedSource
    this.#materialization = dependencies.materialization
    this.#projectionRef = dependencies.projectionRef ?? PROJECTION_REF
    this.#evaluator = dependencies.evaluator ?? new RuleEvaluator()
    this.#maxFanout = dependencies.maxFanout ?? DEFAULT_MAX_FANOUT
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#faultInjection = dependencies.faultInjection
  }

  /**
   * Set the invalidation fence for a change and resolve the affected set. It does not recompute:
   * the worker calls {@link advance} asynchronously. A fan-out larger than `maxFanout` is
   * conservatively deferred with a scope-wide fence and a dirty flag.
   */
  async beginChange(change: MaterializationChange, ctx: ToolContext): Promise<MaterializationTicket> {
    const scopeRef = scopeOf(ctx)
    assertScope(change.scopeRef, scopeRef)
    const published = await this.#publishedSource.load(scopeRef, ctx)
    if (published.complete === false) {
      const reason = incompleteReason(published)
      const fence = await this.#materialization.openFence(
        scopeRef,
        {
          fenceId: this.#newId(),
          reason: `incomplete published snapshot for change ${change.changeId}: ${reason}`,
          propositionKeys: [],
          openedAt: change.recordedAt,
        },
        ctx,
      )
      await this.#materialization.markDirty(
        scopeRef,
        { reason, recordedSeq: change.recordedSeq, markedAt: change.recordedAt },
        ctx,
      )
      return {
        change,
        fenceId: fence.fenceId,
        affectedRuleIds: [],
        affectedPropositionKeys: [],
        deferred: true,
      }
    }
    const index = MaterializationDependencyIndex.build(published)
    const affectedRuleIds = index.affectedRuleIds(change)
    const affectedPropositionKeys = index.affectedPropositionKeys(affectedRuleIds)
    const deferred = affectedRuleIds.length > this.#maxFanout
    const fence = await this.#materialization.openFence(
      scopeRef,
      {
        fenceId: this.#newId(),
        reason: `change ${change.changeId} (${change.kind})`,
        propositionKeys: deferred ? [] : affectedPropositionKeys,
        openedAt: change.recordedAt,
      },
      ctx,
    )
    if (deferred) {
      await this.#materialization.markDirty(
        scopeRef,
        {
          reason: `fan-out of ${String(affectedRuleIds.length)} rules exceeds ${String(this.#maxFanout)}`,
          recordedSeq: change.recordedSeq,
          markedAt: change.recordedAt,
        },
        ctx,
      )
    }
    return { change, fenceId: fence.fenceId, affectedRuleIds, affectedPropositionKeys, deferred }
  }

  /** Recompute the affected evaluations and commit the new projection generation. */
  async advance(ticket: MaterializationTicket, ctx: ToolContext): Promise<MaterializationAdvanceResult> {
    const scopeRef = scopeOf(ctx)
    assertScope(ticket.change.scopeRef, scopeRef)
    const existing = await this.#materialization.getProjectionState(scopeRef, ctx)
    if (existing !== undefined && compareRevision(existing.watermark.value, ticket.change.recordedSeq) >= 0) {
      // At-least-once delivery replayed a change that is already reflected; just release the fence.
      await this.#closeFenceIfOpen(scopeRef, ticket.fenceId, ctx)
      return {
        scopeRef,
        generation: existing.generation,
        recomputedRuleIds: [],
        recomputedPropositionKeys: [],
        appendedSlices: 0,
        deferred: ticket.deferred,
      }
    }

    this.#faultInjection?.beforeCommit?.()

    const published = await this.#publishedSource.load(scopeRef, ctx)
    if (published.complete === false) {
      throw new MaterializationError(
        'MATERIALIZATION_FAILED',
        `refusing to commit a projection from an incomplete published snapshot: ${incompleteReason(published)}`,
      )
    }
    const index = MaterializationDependencyIndex.build(published)
    const affectedRuleIds = [...new Set([...ticket.affectedRuleIds, ...index.affectedRuleIds(ticket.change)])]
    const evaluationRuleIds = index.evaluationRuleIds(affectedRuleIds)
    const affectedPropositionKeys = [...new Set([...ticket.affectedPropositionKeys, ...index.affectedPropositionKeys(affectedRuleIds)])]
    const evaluationRules = published.rules.filter((rule) => evaluationRuleIds.includes(rule.ruleId))
    const generation = nextGeneration(existing?.generation ?? '0')

    const slices: ProjectionSlice[] = []
    for (const propositionKey of affectedPropositionKeys) {
      const owners = published.partitions?.filter((part) => part.rules.some((rule) => rule.conclusion.propositionKey === propositionKey)) ?? []
      if (owners.length > 1) throw new MaterializationError('MATERIALIZATION_FAILED', 'a proposition has ambiguous definition partition authority')
      if (published.partitions !== undefined && owners.length === 0) throw new MaterializationError('MATERIALIZATION_FAILED', 'the affected proposition lost its definition partition; retain the invalidation fence')
      const partition = owners[0] ?? published
      const partitionRuleIds = new Set(partition.rules.map((rule) => rule.ruleId))
      const windows = subIntervalsFor(propositionKey, partition.facts, partition.rules, ticket.change)
      for (const window of windows) {
        const conclusion = this.#evaluateConclusion(
          scopeRef,
          ticket.change,
          window,
          partition.facts,
          evaluationRules.filter((rule) => partitionRuleIds.has(rule.ruleId)),
          propositionKey,
          partition.definitionRef,
          partition.complete,
          partition.premiseInput,
        )
        if (conclusion === undefined) continue
        slices.push({
          scopeRef,
          generation,
          propositionKey,
          qualifiedPropositionKey: conclusion.qualifiedPropositionKey,
          predicate: conclusion.predicate,
          domainStatus: conclusion.domainStatus,
          ...(conclusion.value === undefined ? {} : { value: conclusion.value }),
          validity: { validFrom: window.validFrom, ...(window.validTo === undefined ? {} : { validTo: window.validTo }) },
          recordedSeq: ticket.change.recordedSeq,
          conclusion,
        })
      }
    }

    const watermark: SourceWatermark = { kind: 'sequence', value: ticket.change.recordedSeq }
    let committed
    try {
      committed = await this.#materialization.commitProjection(
        scopeRef,
        {
          fenceId: ticket.fenceId,
          expectedGeneration: existing?.generation ?? '0',
          recordedSeq: ticket.change.recordedSeq,
          watermark,
          slices,
          committedAt: this.#now(),
        },
        ctx,
      )
    } catch (error) {
      throw new MaterializationError('GENERATION_CONFLICT', 'the projection advanced concurrently', {
        cause: error,
      })
    }

    return {
      scopeRef,
      generation: committed.state.generation,
      recomputedRuleIds: evaluationRuleIds,
      recomputedPropositionKeys: affectedPropositionKeys,
      appendedSlices: committed.appendedSlices,
      deferred: ticket.deferred,
    }
  }

  /** `beginChange` + `advance` in one call, for a synchronous caller or a test. */
  async applyChange(change: MaterializationChange, ctx: ToolContext): Promise<MaterializationAdvanceResult> {
    const ticket = await this.beginChange(change, ctx)
    return this.advance(ticket, ctx)
  }

  /**
   * A materialised read. It never returns an out-of-date conclusion: an open fence or a dirty
   * scope yields `fenced`/`dirty` (or the unaffected part), and a proposition with no slice falls
   * back to the same evaluator on demand.
   */
  async read(request: MaterializationReadRequest, ctx: ToolContext): Promise<MaterializationReadResult> {
    const scopeRef = scopeOf(ctx)
    assertScope(request.scopeRef, scopeRef)
    const hasRequestedPropositions = (request.propositionKeys?.length ?? 0) > 0
    const state = await this.#materialization.getProjectionState(scopeRef, ctx)
    const generation = state?.generation ?? '0'

    if (request.validAt === undefined || request.asOfRecordedSeq === undefined) {
      return this.readOnDemand(request, ctx)
    }

    const slices = await this.#materialization.readSlices(
      scopeRef,
      {
        ...(!hasRequestedPropositions ? {} : { propositionKeys: request.propositionKeys ?? [] }),
        validAt: request.validAt,
        asOfRecordedSeq: request.asOfRecordedSeq,
      },
      ctx,
    )
    const conclusions: MaterializedConclusion[] = []
    const materialisedPropositions = new Set<string>()
    const missingPropositionKeys: string[] = []
    const recordedViewPersisted =
      state?.watermark.kind === 'sequence' &&
      compareRevision(state.watermark.value, request.asOfRecordedSeq) >= 0
    for (const proposition of (hasRequestedPropositions ? request.propositionKeys : undefined) ??
      [...new Set(slices.map((slice) => slice.propositionKey))].sort()) {
      const slice = recordedViewPersisted
        ? bestSlice(slices, proposition, request.validAt, request.asOfRecordedSeq)
        : undefined
      if (slice !== undefined) {
        // The stored slice is keyed at its interval start; re-key it for the exact requested
        // view so a materialised read and an on-demand read of the same view are identical. The
        // proposition key carries published rule/entity/schema identity for scoped instances.
        conclusions.push({
          ...slice.conclusion,
          qualifiedPropositionKey: conclusionQualifiedKey(slice.predicate, {
            scopeRef,
            projectionRef: request.projectionRef,
            validAt: request.validAt,
            asOfRecordedSeq: request.asOfRecordedSeq,
          }, slice.conclusion.ruleArtifacts?.[0]?.definitionRef, proposition),
        })
        materialisedPropositions.add(proposition)
        continue
      }
      missingPropositionKeys.push(proposition)
    }
    conclusions.sort((left, right) => left.propositionKey.localeCompare(right.propositionKey))
    let storedRuleArtifacts = dedupeArtifacts(conclusions.flatMap((conclusion) => conclusion.ruleArtifacts ?? []))

    // Historical projection slices are immutable recorded-time evidence. Return them even while
    // the latest source snapshot is incomplete, the scope is dirty, or a newer change is fenced;
    // those conditions only block propositions for which no qualifying historical slice exists.
    let latestState = state
    let fences = await this.#materialization.listOpenFences(scopeRef, ctx)
    if (!hasRequestedPropositions && slices.length === 0) {
      latestState = await this.#materialization.getProjectionState(scopeRef, ctx)
      fences = await this.#materialization.listOpenFences(scopeRef, ctx)
      const scopeFence = fences.some((fence) => fence.propositionKeys.length === 0)
      if (latestState?.dirty === true || scopeFence) {
        return {
          status: latestState?.dirty === true ? 'dirty' : 'fenced',
          scopeRef,
          generation: latestState?.generation ?? generation,
          conclusions: [],
          blockedPropositionKeys: [],
          reason: latestState?.dirty === true
            ? 'the projection is dirty and no historical slice is available for this scope read'
            : 'a scope-wide recomputation fence is open and no historical slice is available for this scope read',
        }
      }
    }
    if (missingPropositionKeys.length === 0 && hasRequestedPropositions) {
      return {
        status: 'materialized',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: [],
        ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
      }
    }

    latestState = await this.#materialization.getProjectionState(scopeRef, ctx)
    fences = await this.#materialization.listOpenFences(scopeRef, ctx)
    const coversAll = fences.some((fence) => fence.propositionKeys.length === 0)
    const dirty = latestState?.dirty === true
    const fenceBlocked = missingPropositionKeys.filter((proposition) =>
      coversAll || fences.some((fence) => fence.propositionKeys.includes(proposition)),
    )
    if (missingPropositionKeys.length > 0 && (dirty || fenceBlocked.length > 0)) {
      return {
        status: dirty ? 'dirty' : 'fenced',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: missingPropositionKeys,
        reason: dirty
          ? 'the projection is dirty; missing historical slices remain blocked'
          : 'an open recomputation fence covers a requested proposition without a historical slice',
        ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
      }
    }

    let published: PublishedSemanticData
    try {
      published = await this.#publishedSource.load(scopeRef, ctx)
    } catch (error) {
      if (!isIncompletePublishedRead(error)) throw error
      const currentState = await this.#materialization.getProjectionState(scopeRef, ctx)
      const currentFences = await this.#materialization.listOpenFences(scopeRef, ctx)
      if (currentState?.dirty === true || currentFences.length > 0) {
        return {
          status: currentState?.dirty === true ? 'dirty' : 'fenced',
          scopeRef,
          generation: currentState?.generation ?? generation,
          conclusions,
          blockedPropositionKeys: missingPropositionKeys,
          reason: 'a dirty scope or open fence blocks historical fallback while the source snapshot is incomplete',
          ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
        }
      }
      return {
        status: 'history_unavailable',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: missingPropositionKeys,
        reason: error instanceof Error ? error.message : 'the current source cannot reconstruct the requested historical slice',
        ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
      }
    }
    const propositions = (hasRequestedPropositions ? request.propositionKeys : undefined) ?? [...new Set([
      ...slices.map((slice) => slice.propositionKey),
      ...published.rules.map((rule) => rule.conclusion.propositionKey),
    ])].sort()
    let newlyMissing = propositions.filter((proposition) => !materialisedPropositions.has(proposition))
    if (newlyMissing.length === 0 && hasRequestedPropositions) {
      return {
        status: 'materialized',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: [],
        ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
        issues: issuesOf(published),
      }
    }
    latestState = await this.#materialization.getProjectionState(scopeRef, ctx)
    fences = await this.#materialization.listOpenFences(scopeRef, ctx)
    const fencedMissing = newlyMissing.filter((proposition) =>
      latestState?.dirty === true ||
      fences.some((fence) => fence.propositionKeys.length === 0 || fence.propositionKeys.includes(proposition)),
    )
    if (fencedMissing.length > 0) {
      return {
        status: latestState?.dirty === true ? 'dirty' : 'fenced',
        scopeRef,
        generation: latestState?.generation ?? generation,
        conclusions,
        blockedPropositionKeys: fencedMissing,
        reason: 'a recomputation fence covers a requested proposition without a historical slice',
        ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
        issues: issuesOf(published),
      }
    }
    const persistedThroughAsOf =
      latestState?.watermark.kind === 'sequence' &&
      compareRevision(latestState.watermark.value, request.asOfRecordedSeq) >= 0
    if (newlyMissing.length > 0 && persistedThroughAsOf) {
      // The first slice read may have raced a commit that atomically closed its fence. Re-read
      // after observing the new watermark so a completed projection is not misreported as an
      // unavailable history snapshot.
      const committedSlices = await this.#materialization.readSlices(scopeRef, {
        propositionKeys: newlyMissing,
        validAt: request.validAt,
        asOfRecordedSeq: request.asOfRecordedSeq,
      }, ctx)
      const stillMissing: string[] = []
      for (const proposition of newlyMissing) {
        const slice = bestSlice(committedSlices, proposition, request.validAt, request.asOfRecordedSeq)
        if (slice === undefined) {
          stillMissing.push(proposition)
          continue
        }
        conclusions.push({
          ...slice.conclusion,
          qualifiedPropositionKey: conclusionQualifiedKey(slice.predicate, {
            scopeRef,
            projectionRef: request.projectionRef,
            validAt: request.validAt,
            asOfRecordedSeq: request.asOfRecordedSeq,
          }, slice.conclusion.ruleArtifacts?.[0]?.definitionRef, proposition),
        })
        materialisedPropositions.add(proposition)
      }
      newlyMissing = stillMissing
      conclusions.sort((left, right) => left.propositionKey.localeCompare(right.propositionKey))
      storedRuleArtifacts = dedupeArtifacts(conclusions.flatMap((conclusion) => conclusion.ruleArtifacts ?? []))
    }
    if (published.complete === false) {
      return {
        status: 'history_unavailable',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: newlyMissing,
        reason: `historical slices are missing and ${incompleteReason(published)}`,
        issues: issuesOf(published),
        ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
      }
    }
    if (
      !hasRequestedPropositions &&
      slices.length === 0 &&
      published.historicalAsOfSupported === false
    ) {
      return {
        status: 'history_unavailable',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: [],
        reason: 'the published source exposes only current heads and no historical projection slice exists for this asOf view',
        issues: issuesOf(published),
      }
    }
    if (newlyMissing.length === 0) {
      return {
        status: 'materialized',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: [],
        ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
        issues: issuesOf(published),
      }
    }
    if (published.historicalAsOfSupported === false) {
      return {
        status: 'history_unavailable',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: newlyMissing,
        reason: 'the published source exposes only current heads and cannot reconstruct this asOf view',
        issues: issuesOf(published),
        ...(storedRuleArtifacts.length === 0 ? {} : { ruleArtifacts: storedRuleArtifacts }),
      }
    }
    const evaluation = this.#evaluatePropositions(published, scopeRef, request, newlyMissing)
    conclusions.push(...evaluation.conclusions)
    conclusions.sort((left, right) => left.propositionKey.localeCompare(right.propositionKey))
    if (newlyMissing.length > evaluation.conclusions.length) {
      return {
        status: 'history_unavailable',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys: newlyMissing.filter((proposition) =>
          !evaluation.conclusions.some((entry) => entry.propositionKey === proposition),
        ),
        reason: 'the requested historical projection slice is absent and no complete historical source result was produced',
        ...(dedupeArtifacts([...storedRuleArtifacts, ...evaluation.ruleArtifacts]).length === 0
          ? {}
          : { ruleArtifacts: dedupeArtifacts([...storedRuleArtifacts, ...evaluation.ruleArtifacts]) }),
        issues: issuesOf(published),
      }
    }
    return {
      status: 'on_demand',
      scopeRef,
      generation,
      conclusions,
      blockedPropositionKeys: [],
      ...(dedupeArtifacts([...storedRuleArtifacts, ...evaluation.ruleArtifacts]).length === 0
        ? {}
        : { ruleArtifacts: dedupeArtifacts([...storedRuleArtifacts, ...evaluation.ruleArtifacts]) }),
      issues: issuesOf(published),
    }
  }

  /** Answer directly from the published read view, without reading the projection. */
  async readOnDemand(request: MaterializationReadRequest, ctx: ToolContext): Promise<MaterializationReadResult> {
    const scopeRef = scopeOf(ctx)
    assertScope(request.scopeRef, scopeRef)
    const state = await this.#materialization.getProjectionState(scopeRef, ctx)
    const generation = state?.generation ?? '0'
    const fences = await this.#materialization.listOpenFences(scopeRef, ctx)
    if (state?.dirty === true || fences.length > 0) {
      return incompleteReadResult(
        scopeRef,
        generation,
        undefined,
        request.propositionKeys,
        state?.dirty === true ? 'dirty' : 'fenced',
        'the projection is dirty or an invalidation fence is open; on-demand answers are withheld',
      )
    }
    let published: PublishedSemanticData
    try {
      published = await this.#publishedSource.load(scopeRef, ctx)
    } catch (error) {
      if (!isIncompletePublishedRead(error)) throw error
      return incompleteReadResult(
        scopeRef,
        generation,
        undefined,
        request.propositionKeys,
        'dirty',
        error instanceof Error ? error.message : 'the published semantic read was incomplete',
      )
    }
    if (published.complete === false) {
      return incompleteReadResult(scopeRef, generation, published, request.propositionKeys, 'dirty', incompleteReason(published))
    }
    if (request.asOfRecordedSeq !== undefined && published.historicalAsOfSupported === false) {
      return incompleteReadResult(
        scopeRef,
        generation,
        published,
        request.propositionKeys,
        'history_unavailable',
        'the published source exposes only current heads; historical on-demand recomputation is unavailable',
      )
    }
    const evaluation = this.#evaluatePropositions(published, scopeRef, request, request.propositionKeys)
    const fencesAfter = await this.#materialization.listOpenFences(scopeRef, ctx)
    const stateAfter = await this.#materialization.getProjectionState(scopeRef, ctx)
    if (fencesAfter.length > 0 || stateAfter?.dirty === true) {
      return incompleteReadResult(
        scopeRef,
        stateAfter?.generation ?? generation,
        published,
        request.propositionKeys,
        stateAfter?.dirty === true ? 'dirty' : 'fenced',
        'a projection invalidation fence opened during the read',
      )
    }
    return {
      status: 'on_demand',
      scopeRef,
      generation: stateAfter?.generation ?? generation,
      conclusions: [...evaluation.conclusions],
      ...(evaluation.ruleArtifacts.length === 0 ? {} : { ruleArtifacts: [...evaluation.ruleArtifacts] }),
      issues: issuesOf(published),
      blockedPropositionKeys: [],
    }
  }

  #evaluateConclusion(
    scopeRef: ScopeRef,
    change: MaterializationChange,
    window: ValidityWindow,
    facts: readonly RuleFact[],
    rules: readonly SupportRule[],
    propositionKey: string,
    definitionRef: VersionRef | undefined,
    complete: boolean | undefined,
    premiseInput: PublishedSemanticData['premiseInput'],
  ): MaterializedConclusion | undefined {
    const request: ControlReadProjectionRequest = {
      scopeRef,
      projectionRef: this.#projectionRef,
      validAt: window.validFrom,
      asOfRecordedSeq: change.recordedSeq,
    }
    const result = this.#evaluator.evaluate({
      scopeRef,
      request,
      facts,
      rules,
      ...(definitionRef === undefined ? {} : { definitionRef }),
      ...(complete === undefined ? {} : { complete }),
    })
    const conclusion = result.conclusions.find((entry) => entry.propositionKey === propositionKey)
    if (conclusion === undefined) return undefined
    const artifacts = ruleComputationArtifactsOf(result.applicabilities, rules).map((artifact) => ({ ...artifact,
      ...(premiseInput === undefined ? {} : { premiseInput: { ...premiseInput, request, evaluatedRuleIds: rules.map((rule) => rule.ruleId), complete: complete !== false } }),
    }))
    return materializedConclusionOf(conclusion, artifactsForProposition(propositionKey, rules, artifacts))
  }

  #evaluatePropositions(
    published: PublishedSemanticData,
    scopeRef: ScopeRef,
    request: MaterializationReadRequest,
    propositionKeys: readonly string[] | undefined,
  ): MaterializationEvaluation {
    if (published.partitions !== undefined) {
      const parts = published.partitions.map((part) => this.#evaluatePropositions(part, scopeRef, request, propositionKeys))
      return { conclusions: parts.flatMap((part) => part.conclusions), applicabilities: parts.flatMap((part) => part.applicabilities), ruleArtifacts: parts.flatMap((part) => part.ruleArtifacts) }
    }
    const evaluationRequest: ControlReadProjectionRequest = {
      scopeRef,
      projectionRef: request.projectionRef,
      ...(request.asOfRecordedSeq === undefined ? {} : { asOfRecordedSeq: request.asOfRecordedSeq }),
      ...(request.validAt === undefined ? {} : { validAt: request.validAt }),
    }
    const result = this.#evaluator.evaluate({
      scopeRef,
      request: evaluationRequest,
      facts: published.facts,
      rules: published.rules,
      ...(published.definitionRef === undefined ? {} : { definitionRef: published.definitionRef }),
      ...(published.complete === undefined ? {} : { complete: published.complete }),
    })
    const ruleArtifacts = ruleComputationArtifactsOf(result.applicabilities, published.rules).map((artifact) => ({ ...artifact,
      ...(published.premiseInput === undefined ? {} : { premiseInput: { ...published.premiseInput, request: evaluationRequest, evaluatedRuleIds: published.rules.map((rule) => rule.ruleId), complete: published.complete !== false } }),
    }))
    const conclusions = result.conclusions.map((conclusion) =>
      materializedConclusionOf(
        conclusion,
        artifactsForProposition(conclusion.propositionKey, published.rules, ruleArtifacts),
      ),
    )
    const filteredConclusions = propositionKeys === undefined
      ? conclusions
      : conclusions.filter((conclusion) => propositionKeys.includes(conclusion.propositionKey))
    const applicabilities = propositionKeys === undefined
      ? result.applicabilities
      : result.applicabilities.filter((entry) => propositionKeys.includes(entry.propositionKey))
    const selectedInstanceKeys = new Set(
      published.rules
        .filter((rule) => propositionKeys === undefined || propositionKeys.includes(rule.conclusion.propositionKey))
        .flatMap((rule) => rule.publishedInstance === undefined ? [] : [rule.publishedInstance.instanceKey]),
    )
    const filteredArtifacts = ruleArtifacts.filter((artifact) => selectedInstanceKeys.has(artifact.instanceKey))
    return { conclusions: filteredConclusions, applicabilities, ruleArtifacts: filteredArtifacts }
  }

  async #closeFenceIfOpen(scopeRef: ScopeRef, fenceId: Uuid, ctx: ToolContext): Promise<void> {
    const fence = await this.#materialization.getFence(scopeRef, fenceId, ctx)
    if (fence === undefined || fence.state === 'closed') return
    await this.#materialization.closeFence(scopeRef, fenceId, this.#now(), ctx)
  }
}
