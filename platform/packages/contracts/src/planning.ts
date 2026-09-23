import type {
  DirectSqlQueryPlan,
  ModelRef,
  NonEmptyString,
  PlatformError,
  ResourceRef,
  Rfc3339UtcTimestamp,
  SemanticQueryPlan,
  Sha256Digest,
  ToolId,
  ToolResult,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'

/**
 * Routing, small-plan and no-progress contracts (SPEC D7.1–D7.3, C2/C3, ADR-14).
 *
 * These records are the seam between the workflow controller (which owns the outer phase
 * machine) and the planner/loop primitives in `@ontology/application`. They are pure data
 * and ports: no persistence, framework or industry implementation lives here, and every
 * port takes the host-minted `ToolContext`.
 */

/**
 * The three execution routes a run resolves to before collection:
 *
 * - `fixed_path`: a clearly specified path with a published plan. It must never force a
 *   JEV decision (D7.1).
 * - `small_plan`: the default for an ordinary complex question — one bounded, executable
 *   plan, compiled as a single query when the question spans several hops.
 * - `clarify`: a genuine ambiguity is resolved with the user before any collection.
 */
export type ExecutionRoute = 'fixed_path' | 'small_plan' | 'clarify'

/** A typed clarification the router raises when it refuses to guess (D7.3). */
export interface PlanClarification {
  readonly questionRef: VersionRef
  readonly questionType: 'choice' | 'score' | 'noul'
  readonly prompt: NonEmptyString
}

/**
 * One bounded, executable plan step. It references a whitelisted tool and carries only
 * typed arguments (a literal query plan or a bound predecessor value); it never carries
 * a secret, a database connection or a raw result body.
 */
export interface ExecutablePlanStep {
  readonly stepId: NonEmptyString
  readonly toolId: ToolId
  readonly arguments: Readonly<Record<string, unknown>>
  readonly dependsOn: readonly NonEmptyString[]
  /**
   * The source/semantic version this step is bound to. It is part of the repeat key, so a
   * re-run against a new mapping/source version is new work, not an identical repeat.
   */
  readonly sourceVersion?: VersionRef
}

/**
 * A bounded plan. Every step draws from the run's one shared budget, and the plan never
 * opens a second loop owner. `singleQuery` is true when every hop of the question is
 * expressed as one bounded backend query instead of a model round-trip per hop.
 */
export interface ExecutablePlan {
  readonly planRef: ResourceRef
  readonly steps: readonly ExecutablePlanStep[]
  readonly singleQuery: boolean
}

/**
 * Signals the preflight/discovery phase passes to the router. They are deterministic
 * observations, not model output: an ambiguity is a concrete missing or conflicting input,
 * and `routeAmbiguous` is the only case in which a JEV decision may be consulted.
 */
export interface RouteSignals {
  readonly ambiguous?: boolean
  readonly ambiguityReason?: NonEmptyString
  readonly routeAmbiguous?: boolean
}

/**
 * Traceable question-rewrite record (SPEC D7.1, ADR-14).
 *
 * It is the bounded pre-step that runs *before* SQL generation: it records the exact
 * original question, the rewritten question and the input references the rewrite read,
 * each with a content digest and a rewrite version. Carrying it on the route decision is
 * what lets the original → rewrite → generated-SQL chain be replayed from the run record;
 * a rewrite is never silently discarded and the original is never passed through as if it
 * had been rewritten.
 */
export interface QuestionRewrite {
  readonly rewriteId: Uuid
  readonly runId: Uuid
  /** The rewrite-step contract version that produced this record. */
  readonly version: NonEmptyString
  readonly originalQuestion: NonEmptyString
  readonly originalDigest: Sha256Digest
  readonly rewrittenQuestion: NonEmptyString
  readonly rewrittenDigest: Sha256Digest
  /** The inputs the rewrite read; they make the rewrite replayable. */
  readonly inputRefs: readonly ResourceRef[]
  readonly modelRef: ModelRef
  readonly recordedAt: Rfc3339UtcTimestamp
}

/** The router's decision. Exactly one of `plan`/`clarification` is present per route. */
export interface RouteDecision {
  readonly route: ExecutionRoute
  readonly reason: NonEmptyString
  readonly plan?: ExecutablePlan
  readonly clarification?: PlanClarification
  /** A deterministic fallback was used because the JEV decision was unavailable. */
  readonly fallback?: NonEmptyString
  /**
   * The traceable rewrite that produced the question this decision routed, when a rewrite
   * step ran. Its absence means no rewrite step was configured, never that a failed rewrite
   * was skipped.
   */
  readonly rewrite?: QuestionRewrite
}

/**
 * A semantic query plan compiled into one bounded, read-only backend query. The compiled
 * plan already has its identifiers resolved from the confirmed mapping, so it can be
 * executed without a second planning agent (C3).
 */
export interface CompiledSemanticQuery {
  readonly plan: DirectSqlQueryPlan
  readonly mappingRef: VersionRef
  readonly warnings: readonly NonEmptyString[]
}

/**
 * C3: the semantic query compiler. It resolves a semantic `QueryPlan` (concept/field/link
 * ids) against the confirmed mapping into one bounded backend query and never starts a
 * second planning agent. Implementations wrap `compileSemanticQuery`; the application
 * layer receives this by injection and never imports the engine.
 */
export interface SemanticQueryCompilerPort {
  compile(plan: SemanticQueryPlan, ctx: ToolContext): Promise<CompiledSemanticQuery>
}

/** The two explicit loop stops (C6.2). A tool failure is a different outcome entirely. */
export type LoopStopCode = 'NO_PROGRESS' | 'BUDGET_EXHAUSTED'

/**
 * One evidence call as the no-progress guard sees it (D7.3). Its repeat key is the tool,
 * the canonical arguments and the bound source/semantic version: the same tool and
 * arguments against a new source version are new work, not a repeat.
 */
export interface EvidenceCall {
  readonly toolId: ToolId
  readonly arguments: Readonly<Record<string, unknown>>
  readonly sourceVersion?: VersionRef
}

/** One executed evidence round: the call plus the tool result it produced. */
export interface EvidenceRound extends EvidenceCall {
  readonly result: ToolResult
}

export type LoopReason =
  | 'new_information'
  | 'duplicate'
  | 'empty'
  | 'no_new_information'
  | 'budget_exhausted'
  | 'round_limit'
  | 'failed'

/**
 * The guard's verdict for one round. `action` is `continue` only when a genuinely new
 * result determines the next step; otherwise it is `stop` with an explicit reason. A tool
 * failure is carried as `failure` and is never reported as an empty result.
 */
export interface LoopDecision {
  readonly action: 'continue' | 'stop'
  readonly reason: LoopReason
  /** Stable digest of tool + canonical arguments + source version. */
  readonly key: Sha256Digest
  readonly stopCode?: LoopStopCode
  /** Present only when the round failed; an empty result never sets it. */
  readonly failure?: PlatformError
}
