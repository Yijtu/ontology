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
import type { RuleConclusionResult, RuleFact, SupportRule } from '../rules'
import { RuleEvaluator, conclusionQualifiedKey } from '../rules'
import { MaterializationDependencyIndex } from './dependency-index'
import { MaterializationError } from './errors'
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
  for (const rule of rules) {
    if (rule.conclusion.propositionKey !== propositionKey) continue
    for (const group of rule.premiseGroups) predicates.add(group.filter.fieldRef)
  }
  const boundaries = new Set<string>()
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
  if (changeWindow === undefined) return windows
  return windows.filter((window) => intersects(window, changeWindow))
}

function materializedConclusionOf(conclusion: RuleConclusionResult): MaterializedConclusion {
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
  readonly #evaluator: RuleEvaluator
  readonly #maxFanout: number
  readonly #now: () => string
  readonly #newId: () => string
  readonly #faultInjection: MaterializationServiceDependencies['faultInjection']

  constructor(dependencies: MaterializationServiceDependencies) {
    this.#publishedSource = dependencies.publishedSource
    this.#materialization = dependencies.materialization
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
    const index = MaterializationDependencyIndex.build(published)
    const affectedRuleIds =
      ticket.affectedRuleIds.length > 0 ? ticket.affectedRuleIds : index.affectedRuleIds(ticket.change)
    const evaluationRuleIds = index.evaluationRuleIds(affectedRuleIds)
    const affectedPropositionKeys =
      ticket.affectedPropositionKeys.length > 0
        ? ticket.affectedPropositionKeys
        : index.affectedPropositionKeys(affectedRuleIds)
    const evaluationRules = published.rules.filter((rule) => evaluationRuleIds.includes(rule.ruleId))
    const generation = nextGeneration(existing?.generation ?? '0')

    const slices: ProjectionSlice[] = []
    for (const propositionKey of affectedPropositionKeys) {
      const windows = subIntervalsFor(propositionKey, published.facts, published.rules, ticket.change)
      for (const window of windows) {
        const conclusion = this.#evaluateConclusion(
          scopeRef,
          ticket.change,
          window,
          published.facts,
          evaluationRules,
          propositionKey,
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
    const state = await this.#materialization.getProjectionState(scopeRef, ctx)
    const generation = state?.generation ?? '0'
    const dirty = state?.dirty === true
    const fences = await this.#materialization.listOpenFences(scopeRef, ctx)
    const coversAll = fences.some((fence) => fence.propositionKeys.length === 0)

    if (request.validAt === undefined || request.asOfRecordedSeq === undefined) {
      return this.readOnDemand(request, ctx)
    }

    const slices = await this.#materialization.readSlices(
      scopeRef,
      {
        ...(request.propositionKeys === undefined ? {} : { propositionKeys: request.propositionKeys }),
        validAt: request.validAt,
        asOfRecordedSeq: request.asOfRecordedSeq,
      },
      ctx,
    )
    const materialisedPropositions = [...new Set(slices.map((slice) => slice.propositionKey))].sort()
    const published = await this.#publishedSource.load(scopeRef, ctx)
    const allPropositions = [...new Set(published.rules.map((rule) => rule.conclusion.propositionKey))]
    const propositions =
      request.propositionKeys ??
      [...new Set([...materialisedPropositions, ...allPropositions])].sort()

    const conclusions: MaterializedConclusion[] = []
    const blockedPropositionKeys: string[] = []
    let usedOnDemand = false

    for (const proposition of propositions) {
      const blocked =
        dirty || coversAll || fences.some((fence) => fence.propositionKeys.includes(proposition))
      if (blocked) {
        blockedPropositionKeys.push(proposition)
        continue
      }
      const slice = bestSlice(slices, proposition, request.validAt, request.asOfRecordedSeq)
      if (slice !== undefined) {
        // The stored slice is keyed at its interval start; re-key it for the exact requested
        // view so a materialised read and an on-demand read of the same view are identical.
        conclusions.push({
          ...slice.conclusion,
          qualifiedPropositionKey: conclusionQualifiedKey(slice.predicate, {
            scopeRef,
            projectionRef: request.projectionRef,
            validAt: request.validAt,
            asOfRecordedSeq: request.asOfRecordedSeq,
          }),
        })
        continue
      }
      const fallback = this.#evaluatePropositions(published, scopeRef, request, [proposition])
      for (const conclusion of fallback) conclusions.push(conclusion)
      usedOnDemand = true
    }

    if (dirty || coversAll) {
      return {
        status: dirty ? 'dirty' : 'fenced',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys,
        reason: dirty
          ? 'the projection is dirty after a large fan-out'
          : 'a scope-wide recomputation fence is open',
      }
    }
    if (blockedPropositionKeys.length > 0) {
      return {
        status: 'fenced',
        scopeRef,
        generation,
        conclusions,
        blockedPropositionKeys,
        reason: 'a recomputation fence is open for the requested proposition',
      }
    }
    return {
      status: usedOnDemand ? 'on_demand' : 'materialized',
      scopeRef,
      generation,
      conclusions,
      blockedPropositionKeys,
    }
  }

  /** Answer directly from the published read view, without reading the projection. */
  async readOnDemand(request: MaterializationReadRequest, ctx: ToolContext): Promise<MaterializationReadResult> {
    const scopeRef = scopeOf(ctx)
    assertScope(request.scopeRef, scopeRef)
    const published = await this.#publishedSource.load(scopeRef, ctx)
    const conclusions = this.#evaluatePropositions(published, scopeRef, request, request.propositionKeys)
    const state = await this.#materialization.getProjectionState(scopeRef, ctx)
    return {
      status: 'on_demand',
      scopeRef,
      generation: state?.generation ?? '0',
      conclusions,
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
  ): MaterializedConclusion | undefined {
    const request: ControlReadProjectionRequest = {
      scopeRef,
      projectionRef: PROJECTION_REF,
      validAt: window.validFrom,
      asOfRecordedSeq: change.recordedSeq,
    }
    const result = this.#evaluator.evaluate({ scopeRef, request, facts, rules })
    const conclusion = result.conclusions.find((entry) => entry.propositionKey === propositionKey)
    return conclusion === undefined ? undefined : materializedConclusionOf(conclusion)
  }

  #evaluatePropositions(
    published: PublishedSemanticData,
    scopeRef: ScopeRef,
    request: MaterializationReadRequest,
    propositionKeys: readonly string[] | undefined,
  ): MaterializedConclusion[] {
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
    })
    const conclusions = result.conclusions.map(materializedConclusionOf)
    if (propositionKeys === undefined) return conclusions
    return conclusions.filter((conclusion) => propositionKeys.includes(conclusion.propositionKey))
  }

  async #closeFenceIfOpen(scopeRef: ScopeRef, fenceId: Uuid, ctx: ToolContext): Promise<void> {
    const fence = await this.#materialization.getFence(scopeRef, fenceId, ctx)
    if (fence === undefined || fence.state === 'closed') return
    await this.#materialization.closeFence(scopeRef, fenceId, this.#now(), ctx)
  }
}
