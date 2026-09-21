import type { BudgetLedgerKind, BudgetLedgerLimits } from '@ontology/contracts'

/**
 * Initial adjustable budgets (SPEC §9).
 *
 * These are research baselines, not customer SLAs: a run gets 120s, 8 data-tool
 * calls, 2 shared re-collection/draft-repair attempts and 2 independent parallel
 * tools. Result rows and the model-visible tool summary are bounded per result;
 * the ledger tracks their run aggregate so a second round continues from what the
 * first round already spent.
 *
 * A scenario or deployment may tighten any field; a model may never loosen one, so
 * every override goes through `tightenBudgetLimits`.
 */
export const DEFAULT_RUN_BUDGET_LIMITS: BudgetLedgerLimits = {
  maxToolCalls: 8,
  maxRepairAttempts: 2,
  maxParallelTools: 2,
  // 8 calls x the 100-row default result stays inside this run aggregate.
  maxRows: 1_000,
  // 8 calls x the 32 KiB model-visible tool summary cap.
  maxBytes: 262_144,
  deadlineMs: 120_000,
}

/** Background ingestion/simulation jobs are limited separately from online runs. */
export const DEFAULT_BACKGROUND_BUDGET_LIMITS: BudgetLedgerLimits = {
  maxToolCalls: 8,
  maxRepairAttempts: 2,
  maxParallelTools: 4,
  maxRows: 100_000,
  maxBytes: 16_777_216,
  deadlineMs: 600_000,
}

export function defaultBudgetLimits(kind: BudgetLedgerKind): BudgetLedgerLimits {
  return kind === 'run' ? DEFAULT_RUN_BUDGET_LIMITS : DEFAULT_BACKGROUND_BUDGET_LIMITS
}

function minOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

/**
 * Intersect a deployment base with a requested override. Every field can only get
 * stricter, so a model-supplied or scenario-supplied override can never widen the
 * budget the deployment granted.
 */
export function tightenBudgetLimits(
  base: BudgetLedgerLimits,
  override: Partial<BudgetLedgerLimits>,
): BudgetLedgerLimits {
  const tightened: BudgetLedgerLimits = {
    maxToolCalls: Math.min(base.maxToolCalls, override.maxToolCalls ?? base.maxToolCalls),
    maxRepairAttempts: Math.min(
      base.maxRepairAttempts,
      override.maxRepairAttempts ?? base.maxRepairAttempts,
    ),
    maxParallelTools: Math.min(
      base.maxParallelTools,
      override.maxParallelTools ?? base.maxParallelTools,
    ),
    maxRows: Math.min(base.maxRows, override.maxRows ?? base.maxRows),
    maxBytes: Math.min(base.maxBytes, override.maxBytes ?? base.maxBytes),
    deadlineMs: Math.min(base.deadlineMs, override.deadlineMs ?? base.deadlineMs),
  }
  const maxModelTokens = minOptional(base.maxModelTokens, override.maxModelTokens)
  return maxModelTokens === undefined ? tightened : { ...tightened, maxModelTokens }
}
