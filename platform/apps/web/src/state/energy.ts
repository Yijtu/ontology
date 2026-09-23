import type {
  ExecutionRecordView,
  PlanResultView,
  ScenarioDescriptor,
  SimulationDetailView,
  SimulationRecordView,
  WeatherScenario,
} from '../api/energy'
import type { WorkbenchError, WorkbenchPhase } from './workbench'

/**
 * The home-energy plan/comparison/simulation reducer (US-021/US-022, FR-18/21/33).
 *
 * It reuses the same five explicit non-ready phases as the rest of the app and keeps the two
 * invariants that matter most for this surface:
 *
 *  - **A datum is never shown without its labels.** A version carries the server's typed result
 *    and the scenario descriptor that produced it; the reducer never derives a number the server
 *    did not return, and never merges two scenarios into one.
 *  - **Changing the backup requirement or the weather scenario is a new version.** Each scenario
 *    is content-addressed, so a rebuild produces a distinct `versionId`; the comparison is
 *    computed against the immediately previous version and records both the constraint gaps and
 *    the source changes.
 *
 * The simulation/live distinction is kept structural: an execution record is only ever stored for
 * `mode=simulation`, and a refused `mode=live` request is stored separately as `liveUnavailable`.
 */
export type EnergyPhase = WorkbenchPhase

export interface EnergyPlanVersion {
  /** The content-addressed scenario digest; two versions differ iff their input differs. */
  readonly versionId: string
  readonly scenario: ScenarioDescriptor
  readonly record: SimulationRecordView
  readonly detail: SimulationDetailView
  readonly result: PlanResultView | undefined
  readonly publishedRunId: string
  readonly executionPlanRef: import('@ontology/contracts').ResourceRef
  readonly executionInputRefs: readonly import('@ontology/contracts').ResourceRef[]
}

export interface ConstraintGap {
  readonly versionId: string
  readonly strategy: string
  readonly constraint: string
  readonly slotIndex: number
  readonly detail: string
  readonly observed: number
  readonly limit: number
  readonly unit: string
}

export interface SourceChange {
  readonly field: string
  readonly from: string
  readonly to: string
}

export interface EnergyPlanComparison {
  readonly baseVersionId: string
  readonly compareVersionId: string
  readonly baseStatus: string
  readonly compareStatus: string
  readonly statusChanged: boolean
  readonly constraintGaps: readonly ConstraintGap[]
  readonly sourceChanges: readonly SourceChange[]
}

export interface EnergyState {
  readonly phase: EnergyPhase
  readonly backupRequirementKwh: number
  readonly weatherScenario: WeatherScenario
  readonly scenario: ScenarioDescriptor | undefined
  readonly versions: readonly EnergyPlanVersion[]
  readonly comparison: EnergyPlanComparison | undefined
  readonly execution: ExecutionRecordView | undefined
  readonly liveUnavailable: WorkbenchError | undefined
  readonly error: WorkbenchError | undefined
  readonly notice: string | undefined
  readonly busy: boolean
}

export type EnergyEvent =
  | { readonly type: 'busy' }
  | { readonly type: 'setBackup'; readonly value: number }
  | { readonly type: 'setWeather'; readonly value: WeatherScenario }
  | { readonly type: 'scenarioBuilt'; readonly scenario: ScenarioDescriptor }
  | { readonly type: 'planLoaded'; readonly version: EnergyPlanVersion }
  | { readonly type: 'executionLoaded'; readonly execution: ExecutionRecordView }
  | { readonly type: 'liveUnavailable'; readonly error: WorkbenchError }
  | { readonly type: 'permissionDenied'; readonly error: WorkbenchError }
  | { readonly type: 'notConfigured'; readonly error: WorkbenchError }
  | { readonly type: 'failed'; readonly error: WorkbenchError }
  | { readonly type: 'empty' }
  | { readonly type: 'notice'; readonly message: string }

export const DEFAULT_BACKUP_REQUIREMENT_KWH = 2
export const DEFAULT_RESERVE_SOC_PERCENT = 20
export const DEFAULT_WEATHER_SCENARIO: WeatherScenario = 'sunny'

export function initialEnergyState(): EnergyState {
  return {
    phase: 'empty',
    backupRequirementKwh: DEFAULT_BACKUP_REQUIREMENT_KWH,
    weatherScenario: DEFAULT_WEATHER_SCENARIO,
    scenario: undefined,
    versions: [],
    comparison: undefined,
    execution: undefined,
    liveUnavailable: undefined,
    error: undefined,
    notice: undefined,
    busy: false,
  }
}

function sourceChangesOf(base: ScenarioDescriptor, compare: ScenarioDescriptor): SourceChange[] {
  const changes: SourceChange[] = []
  const push = (field: string, from: string, to: string): void => {
    if (from !== to) changes.push({ field, from, to })
  }
  push('inputDigest', base.inputDigest, compare.inputDigest)
  push('weatherScenario', base.weatherScenario, compare.weatherScenario)
  push('backupRequirementKwh', String(base.backupRequirementKwh), String(compare.backupRequirementKwh))
  push('dataMode', base.dataMode, compare.dataMode)
  push('timeZone', base.timeZone, compare.timeZone)
  push('slotMinutes', String(base.slotMinutes), String(compare.slotMinutes))
  push('slotCount', String(base.slotCount), String(compare.slotCount))
  push('batterySpecSource', base.batterySpecSource, compare.batterySpecSource)
  for (const series of compare.series) {
    const before = base.series.find((entry) => entry.measurementPointRef === series.measurementPointRef)
    const prefix = `series.${series.measurementPointRef}`
    if (before === undefined) {
      changes.push({ field: `${prefix}.present`, from: 'absent', to: series.samplingType })
      continue
    }
    push(`${prefix}.samplingType`, before.samplingType, series.samplingType)
    push(`${prefix}.unit`, before.unit, series.unit)
    push(`${prefix}.source`, `${before.sourceRef.namespace}/${before.sourceRef.sourceId}`, `${series.sourceRef.namespace}/${series.sourceRef.sourceId}`)
  }
  return changes
}

export function constraintGapsOf(version: EnergyPlanVersion): readonly ConstraintGap[] {
  const result = version.result
  if (result === undefined) return []
  const gaps: ConstraintGap[] = []
  const candidates = result.baseline === undefined ? result.candidates : [result.baseline, ...result.candidates]
  for (const candidate of candidates) {
    for (const violation of candidate.simulation.violations) {
      gaps.push({
        versionId: version.versionId,
        strategy: candidate.strategy,
        constraint: violation.constraint,
        slotIndex: violation.slotIndex,
        detail: violation.detail,
        observed: violation.observed,
        limit: violation.limit,
        unit: violation.unit,
      })
    }
    for (const margin of candidate.simulation.reserveMargins) {
      if (!margin.satisfied || margin.marginKwh < 0) {
        gaps.push({
          versionId: version.versionId,
          strategy: candidate.strategy,
          constraint: 'backup_reserve',
          slotIndex: margin.windowStartSlot,
          detail: `备电缺口 ${Math.abs(margin.marginKwh).toFixed(3)} kWh（最低 ${margin.minimumEnergyKwh.toFixed(3)} / 要求 ${margin.reserveKwh.toFixed(3)}）`,
          observed: margin.minimumEnergyKwh,
          limit: margin.reserveKwh,
          unit: 'kWh',
        })
      }
    }
  }
  return gaps
}

export function buildComparison(
  base: EnergyPlanVersion,
  compare: EnergyPlanVersion,
): EnergyPlanComparison {
  const baseStatus = base.result?.status ?? 'unknown'
  const compareStatus = compare.result?.status ?? 'unknown'
  return {
    baseVersionId: base.versionId,
    compareVersionId: compare.versionId,
    baseStatus,
    compareStatus,
    statusChanged: baseStatus !== compareStatus,
    constraintGaps: constraintGapsOf(compare),
    sourceChanges: sourceChangesOf(base.scenario, compare.scenario),
  }
}

export function energyReducer(state: EnergyState, event: EnergyEvent): EnergyState {
  switch (event.type) {
    case 'busy':
      return {
        ...state,
        phase: state.versions.length === 0 && state.scenario === undefined ? 'loading' : state.phase,
        busy: true,
        error: undefined,
        notice: undefined,
      }
    case 'setBackup':
      return { ...state, backupRequirementKwh: event.value }
    case 'setWeather':
      return { ...state, weatherScenario: event.value }
    case 'scenarioBuilt':
      return {
        ...state,
        phase: state.versions.length === 0 ? 'ready' : state.phase,
        scenario: event.scenario,
        busy: false,
        error: undefined,
        notice: `已构建情景 ${event.scenario.weatherScenario} · 备电 ${event.scenario.backupRequirementKwh} kWh（输入摘要 ${event.scenario.inputDigest.slice(0, 18)}…）`,
      }
    case 'planLoaded': {
      const previous = state.versions[state.versions.length - 1]
      const comparison = previous === undefined ? undefined : buildComparison(previous, event.version)
      const versions = [...state.versions, event.version]
      return {
        ...state,
        phase: 'ready',
        versions,
        comparison,
        busy: false,
        error: undefined,
        liveUnavailable: undefined,
        notice: comparison === undefined ? '已生成首个计划版本' : '已生成新计划版本，并给出与上一版的差异',
      }
    }
    case 'executionLoaded':
      return { ...state, execution: event.execution, liveUnavailable: undefined, busy: false, notice: '已调度模拟执行（mode=simulation，未发送任何设备请求）' }
    case 'liveUnavailable':
      // A refused live request never becomes an execution; the previous simulation record stands.
      return { ...state, liveUnavailable: event.error, busy: false }
    case 'permissionDenied':
      return { ...state, phase: 'permission_denied', error: event.error, busy: false }
    case 'notConfigured':
      return { ...state, phase: 'not_configured', error: event.error, busy: false }
    case 'failed':
      return { ...state, phase: state.versions.length === 0 ? 'failure' : state.phase, error: event.error, busy: false }
    case 'empty':
      return { ...state, phase: 'empty', busy: false }
    case 'notice':
      return { ...state, notice: event.message, busy: false }
  }
}
