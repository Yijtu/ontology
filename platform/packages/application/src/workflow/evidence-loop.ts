import type {
  BudgetRemaining,
  EvidenceCall,
  ExecutablePlan,
  LoopDecision,
  LoopStopCode,
  PlatformError,
  ResourceRef,
  Sha256Digest,
  ToolCall,
  ToolContext,
  ToolResult,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { WorkflowControllerError } from './errors'

/**
 * The bounded evidence-loop guard (SPEC D7.3, C6.2).
 *
 * It is the only owner of the no-progress rule. A call's repeat key is its tool, its
 * canonical arguments and the bound source/semantic version, so the same tool and
 * arguments against a new source version are new work. Identical repeats are detected and
 * never re-executed. The loop continues only when a genuinely new result determines the
 * next step, and it stops explicitly on `NO_PROGRESS` or `BUDGET_EXHAUSTED`.
 *
 * A tool failure is classified as a failure and is never reported as an empty result. It no
 * longer aborts the deterministic loop on the first error (FR-29): up to `maxFailureRepairs`
 * failed rounds may be followed by a repair round that draws on the same budget. The repair
 * count and the round limit both bound the loop, and a repeat of the failed call is still a
 * duplicate, so a repair is new work rather than an unbounded retry.
 */
export class NoProgressGuard {
  readonly #maxRounds: number
  readonly #maxFailureRepairs: number
  readonly #results = new Map<string, ToolResult>()
  readonly #digests = new Set<string>()
  #rounds = 0
  #failureRepairs = 0

  constructor(options: { readonly maxRounds: number; readonly maxFailureRepairs?: number }) {
    if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1) {
      throw new WorkflowControllerError(
        'INVALID_ARGUMENT',
        'the evidence loop requires a positive integer maxRounds',
      )
    }
    const maxFailureRepairs = options.maxFailureRepairs ?? 1
    if (!Number.isInteger(maxFailureRepairs) || maxFailureRepairs < 0) {
      throw new WorkflowControllerError(
        'INVALID_ARGUMENT',
        'the evidence loop requires a non-negative integer maxFailureRepairs',
      )
    }
    this.#maxRounds = options.maxRounds
    this.#maxFailureRepairs = maxFailureRepairs
  }

  /** tool + canonical arguments + source/semantic version. */
  keyFor(call: EvidenceCall): Sha256Digest {
    return sha256DigestOf(
      canonicalJson({
        toolId: call.toolId,
        arguments: call.arguments,
        sourceVersion: call.sourceVersion ?? null,
      }),
    )
  }

  /** The cached result of an identical earlier call, or `undefined` when it is new work. */
  previousResult(call: EvidenceCall): ToolResult | undefined {
    return this.#results.get(this.keyFor(call))
  }

  /** The explicit stop when the shared budget has no calls left, else `undefined`. */
  budgetStop(call: EvidenceCall, remaining: BudgetRemaining): LoopDecision | undefined {
    if (remaining.toolCallsRemaining > 0) return undefined
    return {
      action: 'stop',
      reason: 'budget_exhausted',
      key: this.keyFor(call),
      stopCode: 'BUDGET_EXHAUSTED',
    }
  }

  /** Record one executed round and decide whether another round may start. */
  observe(call: EvidenceCall, result: ToolResult, remaining: BudgetRemaining): LoopDecision {
    const key = this.keyFor(call)
    const prior = this.#results.get(key)
    this.#results.set(key, result)
    this.#rounds += 1

    const budget = this.budgetStop(call, remaining)
    if (budget !== undefined) return budget

    if (this.#rounds > this.#maxRounds) {
      return { action: 'stop', reason: 'round_limit', key, stopCode: 'NO_PROGRESS' }
    }
    if (result.status === 'error') {
      const failure = failureOf(result)
      if (this.#failureRepairs < this.#maxFailureRepairs) {
        // Bounded repair: the failed round is carried as a failure but the deterministic
        // loop may run one more (non-identical) step on the same budget.
        this.#failureRepairs += 1
        return { action: 'continue', reason: 'failed', key, failure }
      }
      return { action: 'stop', reason: 'failed', key, failure }
    }
    if (prior !== undefined) {
      return { action: 'stop', reason: 'duplicate', key, stopCode: 'NO_PROGRESS' }
    }
    if (result.status === 'empty') {
      return { action: 'stop', reason: 'empty', key, stopCode: 'NO_PROGRESS' }
    }
    const digest = resultDigest(result)
    if (this.#digests.has(digest)) {
      return { action: 'stop', reason: 'no_new_information', key, stopCode: 'NO_PROGRESS' }
    }
    this.#digests.add(digest)
    return { action: 'continue', reason: 'new_information', key }
  }
}

function failureOf(result: ToolResult): PlatformError {
  if (result.error !== undefined) return result.error
  return {
    code: 'INTERNAL_ERROR',
    message: 'the tool call failed without a classified error',
    retryable: false,
  }
}

/** Content digest of a result: snapshots, evidence refs and coverage, never the call id. */
function resultDigest(result: ToolResult): string {
  return sha256DigestOf(
    canonicalJson({
      snapshots: result.sourceSnapshots.map((snapshot) => snapshot.resultDigest),
      evidence: result.evidenceRefs.map((ref) => `${ref.id}@${ref.version}#${ref.digest}`),
      returned: result.coverage.returned,
      truncated: result.coverage.truncated,
    }),
  )
}

export interface PlanExecutionResult {
  readonly planRef: ResourceRef
  readonly executedStepIds: readonly string[]
  readonly skippedStepIds: readonly string[]
  readonly evidenceRefs: readonly ResourceRef[]
  readonly decisions: readonly LoopDecision[]
  readonly stopped: boolean
  readonly stopCode?: LoopStopCode
  readonly failure?: PlatformError
}

export interface SmallPlanExecutorDependencies {
  readonly gateway: {
    invoke(call: ToolCall, ctx: ToolContext): Promise<ToolResult>
  }
  readonly guard: NoProgressGuard
  /** Reads the run's one shared budget projection; it never opens or resets a ledger. */
  readonly remaining: (ctx: ToolContext) => Promise<BudgetRemaining>
  readonly newId?: () => string
}

/**
 * Executes a bounded small plan through the injected gateway. It opens no budget ledger,
 * starts no model loop and executes each step at most once: an identical repeat is skipped
 * by the guard. The plan is fully literal-bound (a compiled multi-hop query is one step),
 * so the executor makes no per-hop model call.
 */
export class SmallPlanExecutor {
  readonly #deps: SmallPlanExecutorDependencies
  readonly #newId: () => string

  constructor(dependencies: SmallPlanExecutorDependencies) {
    this.#deps = dependencies
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async execute(plan: ExecutablePlan, ctx: ToolContext): Promise<PlanExecutionResult> {
    const executedStepIds: string[] = []
    const skippedStepIds: string[] = []
    const evidenceRefs: ResourceRef[] = []
    const decisions: LoopDecision[] = []
    let stopped = false
    let stopCode: LoopStopCode | undefined
    let failure: PlatformError | undefined

    for (const step of plan.steps) {
      const call: EvidenceCall = {
        toolId: step.toolId,
        arguments: step.arguments,
        ...(step.sourceVersion === undefined ? {} : { sourceVersion: step.sourceVersion }),
      }
      const remaining = await this.#deps.remaining(ctx)

      const previous = this.#deps.guard.previousResult(call)
      if (previous !== undefined) {
        skippedStepIds.push(step.stepId)
        const decision = this.#deps.guard.observe(call, previous, remaining)
        decisions.push(decision)
        stopped = true
        stopCode = decision.stopCode
        break
      }

      const budget = this.#deps.guard.budgetStop(call, remaining)
      if (budget !== undefined) {
        decisions.push(budget)
        stopped = true
        stopCode = budget.stopCode
        break
      }

      const result = await this.#deps.gateway.invoke(
        { callId: this.#newId(), toolId: step.toolId, arguments: { ...step.arguments } },
        ctx,
      )
      executedStepIds.push(step.stepId)
      if (result.evidenceRefs.length > 0) evidenceRefs.push(...result.evidenceRefs)

      const decision = this.#deps.guard.observe(call, result, remaining)
      decisions.push(decision)
      // A failure is surfaced even when the guard allows a bounded repair, so the caller
      // never mistakes a repaired round for a clean success.
      if (decision.failure !== undefined) failure = decision.failure
      if (decision.action === 'stop') {
        stopped = true
        stopCode = decision.stopCode
        break
      }
    }

    return {
      planRef: plan.planRef,
      executedStepIds,
      skippedStepIds,
      evidenceRefs,
      decisions,
      stopped,
      ...(stopCode === undefined ? {} : { stopCode }),
      ...(failure === undefined ? {} : { failure }),
    }
  }
}
