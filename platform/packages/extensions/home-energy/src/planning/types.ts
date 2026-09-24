import type {
  DataMode,
  DomainResultStatus,
  ResourceRef,
  Sha256Digest,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '../input/snapshot'
import type { EnergyInputSnapshot } from '../input'
import type {
  BatterySpecDeclaration,
  GridSpec,
  PlanTrajectory,
  ReserveConstraint,
  SeriesBinding,
  SimulationResult,
  SimulationMissingInput,
  SimulationTolerance,
  TariffBinding,
  TopologyDeclaration,
} from '../simulation'

/**
 * Pure energy planning contracts (SPEC E5–E7; ADR-11/ADR-12, INV-08/INV-10).
 *
 * The planner generates a *bounded* set of deterministic candidate trajectories within the
 * declared device capability constraints, evaluates **every** candidate through the same
 * `EnergySimulatorPort`, and reports the best of the tested candidates. It owns no port, no
 * credential, no clock and no randomness: `plan` is a pure, synchronous function of its request.
 *
 * Boundary rules made structural:
 *   - the objective is a deterministic cost computed by code; an optional JEV strategy score is a
 *     probabilistic judgement recorded *separately* and never blended into the objective;
 *   - the output is `best_of_tested_candidates`, never a global physical optimum;
 *   - no feasible candidate is an explicit outcome — the planner never forces a pick and never
 *     lowers the user's backup requirement to manufacture a feasible plan;
 *   - the baseline and every candidate share the same input snapshot, device parameters, tariff
 *     and reserve conditions; a cost comparison on a different terminal-energy basis is refused.
 */

export const PLANNER_VERSION = '1.0.0'

/**
 * Fixed algorithm identity, derived from the version string so a stored result can always name
 * the code that produced it. The digest is content-addressed, not hand-written.
 */
export const ENERGY_PLANNER_ALGORITHM: VersionRef = {
  id: 'home-energy.planner',
  version: PLANNER_VERSION,
  digest: sha256DigestOf(new TextEncoder().encode('home-energy.planner@1.0.0')),
}

/** The bounded deterministic candidate strategies of the first controlled model (SPEC E5). */
export type CandidateStrategyKind = 'self_consumption' | 'reserve_first' | 'price_window'

export const DEFAULT_CANDIDATE_STRATEGIES: readonly CandidateStrategyKind[] = [
  'self_consumption',
  'reserve_first',
  'price_window',
]

/** The deterministic reference plan: no battery action at all. */
export type BaselineStrategyKind = 'no_battery_action'

export const BASELINE_STRATEGY: BaselineStrategyKind = 'no_battery_action'

export type CandidateUnavailabilityReason =
  | 'grid_charging_not_allowed'
  | 'missing_tariff_prices'
  | 'no_price_spread'

/** Why a bounded strategy could not be generated for this device/data combination. */
export interface CandidateUnavailability {
  readonly strategy: CandidateStrategyKind
  readonly reason: CandidateUnavailabilityReason
  readonly detail: string
}

/**
 * The deterministic selection objective. It is a cost, not a probability: `objectiveKind` is
 * always `deterministic_cost`, and `excludes` names the cost items the model does not account for.
 */
export type ObjectiveBasis = 'total_cost' | 'total_cost_with_terminal_energy_valuation'

export interface CandidateObjective {
  readonly kind: 'deterministic_cost'
  readonly currency: string
  readonly netCost: number
  readonly degradationCost: number
  readonly degradationModelled: boolean
  readonly totalCost: number
  readonly terminalEnergyKwh: number
  readonly reserveSatisfied: boolean
  readonly objectiveValue: number
  readonly objectiveBasis: ObjectiveBasis
  readonly includes: readonly string[]
  readonly excludes: readonly string[]
}

export interface CandidatePlan {
  readonly planRef: ResourceRef
  readonly strategy: CandidateStrategyKind
  readonly plan: PlanTrajectory
  readonly objective: CandidateObjective
  readonly simulation: SimulationResult
}

export interface BaselinePlan {
  readonly planRef: ResourceRef
  readonly strategy: BaselineStrategyKind
  readonly plan: PlanTrajectory
  readonly objective: CandidateObjective
  readonly simulation: SimulationResult
}

/**
 * A declared value for leftover stored energy, used to compare plans that end at different
 * terminal SOC on one unified basis (SPEC E5, E-08). Without it, an unequal-terminal comparison
 * is refused rather than presented as a saving.
 */
export interface TerminalEnergyValuation {
  readonly currency: string
  readonly valuationPerKwh: number
  readonly source: 'user_declared' | 'fixture_declared'
}

/**
 * An optional JEV strategy score (ADR-09). It is a probabilistic judgement about a strategy, not
 * a physical result, so it is recorded beside the deterministic objective and never folded in.
 */
export interface JevStrategyScore {
  readonly kind: 'jev_strategy_score'
  readonly planRef: ResourceRef
  readonly strategy: CandidateStrategyKind
  readonly probability: number
  readonly confidence?: number
  readonly optionSetRef: VersionRef
}

export type ComparisonBasisKind = 'equal_terminal_energy' | 'unified_valuation'

export type BaselineComparisonRefusal =
  | 'different_input_snapshot'
  | 'different_currency'
  | 'valuation_currency_mismatch'
  | 'baseline_not_feasible'
  | 'candidate_not_feasible'
  | 'unequal_terminal_energy_without_valuation'

/**
 * The fair baseline comparison (SPEC E5, E-08). `comparable` is false — and `savingsClaim` stays
 * false — whenever the two plans were not computed on the same input or the same terminal-energy
 * basis. A refused comparison is still a successful computation result.
 */
export interface BaselineComparison {
  readonly comparable: boolean
  readonly basis?: ComparisonBasisKind
  readonly refusal?: BaselineComparisonRefusal
  readonly currency: string
  readonly baselineTerminalEnergyKwh: number
  readonly candidateTerminalEnergyKwh: number
  readonly terminalEnergyDeltaKwh: number
  readonly baselineTotalCost: number
  readonly candidateTotalCost: number
  readonly rawCostDelta: number
  readonly adjustedCostDelta?: number
  readonly valuationPerKwh?: number
  readonly savingsClaim: boolean
  readonly notes: readonly string[]
}

/** A comparison tied to the candidate it belongs to, so a result never has to re-identify it. */
export interface CandidateComparison extends BaselineComparison {
  readonly planRef: ResourceRef
  readonly strategy: CandidateStrategyKind
}

export type PlannerSelectionReason =
  | 'lowest_objective_among_feasible'
  | 'no_feasible_candidate'
  | 'all_strategies_unavailable'
  | 'insufficient_data'
  | 'unsupported_topology'

export interface PlannerSelection {
  readonly reason: PlannerSelectionReason
  readonly optimality: 'best_of_tested_candidates'
  readonly objectiveKind: 'deterministic_cost'
  readonly selectedPlanRef?: ResourceRef
  readonly selectedStrategy?: CandidateStrategyKind
  readonly objectiveValue?: number
  /**
   * True when all feasible candidates end at the same terminal energy, or when a declared
   * valuation puts them on one basis. False means the ranking used raw total cost and the result
   * says so explicitly.
   */
  readonly comparableBasis: boolean
  readonly notes: readonly string[]
}

export type PlannerStatus =
  | 'feasible'
  | 'infeasible'
  | 'insufficient_data'
  | 'unsupported_topology'

export interface PlannerResult {
  readonly status: PlannerStatus
  readonly domainStatus: DomainResultStatus
  readonly optimality: 'best_of_tested_candidates'
  readonly executionMode: 'simulation'
  readonly liveSupported: false
  readonly plannerVersion: string
  readonly numericPolicy: string
  readonly algorithmVersion: VersionRef
  readonly inputDataMode: DataMode
  readonly inputManifestHash: Sha256Digest
  readonly snapshotRef: ResourceRef
  readonly candidates: readonly CandidatePlan[]
  readonly missingInputs: readonly SimulationMissingInput[]
  readonly unavailableStrategies: readonly CandidateUnavailability[]
  readonly selection: PlannerSelection
  readonly baseline?: BaselinePlan
  readonly comparisons: readonly CandidateComparison[]
  readonly jevStrategyScores: readonly JevStrategyScore[]
  /** Always false: a JEV score is never used as the objective or the ranking key. */
  readonly jevScoresInfluencedSelection: false
  readonly unaccountedCostItems: readonly string[]
  readonly assumptions: readonly string[]
  readonly evidenceRefs: readonly ResourceRef[]
  readonly resultDigest: Sha256Digest
}

export interface EnergyPlanRequest {
  readonly snapshot: EnergyInputSnapshot
  readonly executionMode: 'simulation'
  readonly topology: TopologyDeclaration
  readonly battery: BatterySpecDeclaration
  readonly grid: GridSpec
  readonly load: readonly SeriesBinding[]
  readonly pv: readonly SeriesBinding[]
  readonly tariff: TariffBinding
  readonly reserves: readonly ReserveConstraint[]
  readonly tolerance: SimulationTolerance
  readonly assumptions: readonly string[]
  /** The bounded strategies to consider. Defaults to every supported strategy. */
  readonly strategyWhitelist?: readonly CandidateStrategyKind[]
  /** Required to compare plans that end at a different terminal energy. */
  readonly terminalEnergyValuation?: TerminalEnergyValuation
  /** Optional JEV judgements, recorded separately and never used for ranking. */
  readonly jevStrategyScores?: readonly JevStrategyScore[]
}

/**
 * The replaceable energy planning port (SPEC E1). It is a pure, synchronous domain interface.
 * `LOCAL-046` registers an implementation of this port as a `ComputePort` operation.
 */
export interface EnergyPlannerPort {
  plan(request: EnergyPlanRequest): PlannerResult
}
