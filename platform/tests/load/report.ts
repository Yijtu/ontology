import type { CacheState, HardwareInfo, LatencySummary, Rate, ResourceUsage } from './metrics'
import type { QualityRun } from './gold-set'
import type { GoldSet } from './gold-set'

/**
 * The load/evaluation report (SPEC §9, V6).
 *
 * The report is deliberately explicit about its population: every rate carries its
 * denominator, every latency carries its sample count, and the hardware/cache/data scale are
 * recorded next to the numbers. A target that is missed is recorded as a miss with the
 * bottleneck that was observed — the harness never deletes a source or an adapter layer to
 * make a figure look better, and `evaluateTarget` refuses to report a miss without a reason.
 */
export interface CallCount {
  readonly tool: string
  readonly calls: number
}

export interface CallCounts {
  readonly attempted: number
  readonly byTool: readonly CallCount[]
  /** Each tool's share of all attempted calls; the denominator is `attempted`. */
  readonly shares: readonly { readonly tool: string; readonly share: Rate }[]
}

export interface Degradation {
  readonly degraded: Rate
  readonly byReason: readonly { readonly reason: string; readonly count: number }[]
}

export interface VerificationQuality {
  /** Drafts that should have failed but the real verifier passed them (must be 0). */
  readonly falsePass: Rate
  /** Drafts that should have passed but the real verifier rejected them. */
  readonly falseReject: Rate
  readonly cases: readonly {
    readonly caseId: string
    readonly expectedVerdict: 'pass' | 'fail'
    readonly observedVerdict: 'pass' | 'fail'
    readonly failedChecks: readonly string[]
  }[]
}

export interface TargetResult {
  readonly name: string
  readonly description: string
  readonly metric: string
  readonly target: number
  readonly unit: string
  readonly measured: number | undefined
  readonly samples: number
  readonly met: boolean
  /** Required whenever `met` is false: what actually bounded the result. */
  readonly bottleneck: string | undefined
}

export interface Coverage {
  readonly sources: readonly string[]
  readonly adapters: readonly string[]
  readonly fixtureSetDigest: string
}

export interface LoadReport {
  readonly generatedAt: string
  readonly dataScale: {
    readonly documents: number
    readonly assertions: number
    readonly telemetryRows: number
    readonly goldFixtures: number
    readonly heldOutFixtures: number
    readonly controlApiCalls: number
    readonly notes: string
  }
  readonly hardware: HardwareInfo
  readonly cacheState: CacheState
  readonly coverage: Coverage
  readonly quality: QualityRun
  readonly verification: VerificationQuality
  readonly callCounts: CallCounts
  readonly degradation: Degradation
  readonly latencies: {
    readonly controlApi: LatencySummary
    readonly localToolQuery: LatencySummary
    readonly simulation: LatencySummary
  }
  readonly resourceUsage: ResourceUsage
  readonly failureBoundaries: readonly FaultCaseResult[]
  readonly targets: readonly TargetResult[]
}

export interface FaultCaseResult {
  readonly caseId: string
  readonly description: string
  readonly expectedOutcome: string
  readonly observedOutcome: string
  readonly passed: boolean
  readonly detail: string
}

/**
 * Compare a measured value against a target. A miss must name the bottleneck; an undefined
 * measurement is reported as an unmeasured miss, never as a pass.
 */
export function evaluateTarget(input: {
  readonly name: string
  readonly description: string
  readonly metric: string
  readonly target: number
  readonly unit: string
  readonly measured: number | undefined
  readonly samples: number
  readonly bottleneck: string | undefined
}): TargetResult {
  const met = input.measured !== undefined && input.measured <= input.target
  if (!met && (input.bottleneck === undefined || input.bottleneck.length === 0)) {
    throw new Error(`target ${input.name} was missed without a recorded bottleneck`)
  }
  return {
    name: input.name,
    description: input.description,
    metric: input.metric,
    target: input.target,
    unit: input.unit,
    measured: input.measured,
    samples: input.samples,
    met,
    bottleneck: met ? undefined : input.bottleneck,
  }
}

/** The report fields SPEC §9 requires, used by the tests to prove the report is complete. */
export const REQUIRED_REPORT_FIELDS = [
  'dataScale',
  'hardware',
  'cacheState',
  'quality',
  'verification',
  'callCounts',
  'degradation',
  'latencies',
  'resourceUsage',
  'failureBoundaries',
  'targets',
] as const

export function buildCallCounts(byTool: readonly CallCount[]): CallCounts {
  const attempted = byTool.reduce((total, entry) => total + entry.calls, 0)
  return {
    attempted,
    byTool,
    shares: byTool.map((entry) => ({
      tool: entry.tool,
      share: { numerator: entry.calls, denominator: attempted },
    })),
  }
}

export function buildDegradation(
  reasons: readonly { readonly reason: string; readonly count: number }[],
  attempts: number,
): Degradation {
  const degraded = reasons.reduce((total, entry) => total + entry.count, 0)
  return { degraded: { numerator: degraded, denominator: attempts }, byReason: reasons }
}

export function buildGoldSetCoverage(
  goldSet: GoldSet,
  fixtureSetDigest: string,
  adapters: readonly string[],
): Coverage {
  const sources = [...goldSet.development.sources, ...goldSet.heldOut.sources].map(
    (source) => `${source.namespace}/${source.sourceId}`,
  )
  return {
    sources: [...new Set(sources)].sort(),
    adapters: [...adapters].sort(),
    fixtureSetDigest,
  }
}
