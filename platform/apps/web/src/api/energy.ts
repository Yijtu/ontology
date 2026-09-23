import type { OperationRef, ResourceRef, Sha256Digest } from '@ontology/contracts'

/**
 * The home-energy simulation surface (C6) as the browser sees it.
 *
 * The types here are the *narrow* projection the plan/simulation UI reads. They deliberately
 * mirror the server's sanitised output: every number is a labelled field with a unit and a
 * time, every result names its source and data mode, and the simulation/live distinction is an
 * explicit field (`mode`, `liveSupported`) rather than something the UI infers. The browser
 * never imports a server package: it only speaks HTTP.
 */

export const WEATHER_SCENARIOS = ['anker_base', 'afternoon_overcast', 'sunny', 'overcast', 'storm'] as const

export type WeatherScenario = (typeof WEATHER_SCENARIOS)[number]

export function isWeatherScenario(value: unknown): value is WeatherScenario {
  return typeof value === 'string' && (WEATHER_SCENARIOS as readonly string[]).includes(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

export interface ScenarioSeriesDescriptor {
  readonly measurementPointRef: string
  readonly role: 'load' | 'pv'
  readonly metric: string
  readonly unit: string
  readonly samplingType: string
  readonly sourceRef: { readonly namespace: string; readonly sourceId: string }
  readonly dataMode: string
  readonly firstSlotUtc: string
  readonly lastSlotUtc: string
}

export interface ScenarioDescriptor {
  readonly inputRef: ResourceRef
  readonly inputDigest: Sha256Digest
  readonly dataMode: string
  readonly timeZone: string
  readonly slotMinutes: number
  readonly slotCount: number
  readonly horizon: { readonly start: string; readonly end: string }
  readonly backupRequirementKwh: number
  readonly reserveSocPercent: number
  readonly reserveWindowStartSlot: number
  readonly initialEnergyKwh: number
  readonly initialSocPercent: number
  readonly stateRevision: number
  readonly stateRef?: ResourceRef
  readonly parentPlanRef?: ResourceRef
  readonly weatherScenario: WeatherScenario
  readonly batterySpecSource: string
  readonly series: readonly ScenarioSeriesDescriptor[]
  readonly assumptions: readonly string[]
}

export interface CreateScenarioRequest {
  readonly backupRequirementKwh?: number
  readonly reserveSocPercent?: number
  readonly weatherScenario: WeatherScenario
  readonly reserveWindowStartSlot?: number
}

export interface SimulationRecordView {
  readonly simulationId: string
  readonly operationRef: OperationRef
  readonly mode: 'simulation'
  readonly liveSupported: false
  readonly domainStatus: string
  readonly dataMode: string
  readonly inputRefs: readonly ResourceRef[]
  readonly resultRef: ResourceRef
  readonly createdAt: string
  readonly status: string
}

export interface EnergySourceView {
  readonly sourceRef: { readonly namespace: string; readonly sourceId: string }
  readonly schemaVersion: string
  readonly consistency: string
  readonly resultDigest?: string
}

export interface SimulationDetailView extends SimulationRecordView {
  readonly integrityVerified: boolean
  readonly scenario: ScenarioDescriptor
  readonly result: unknown
  readonly sources: readonly EnergySourceView[]
}

export interface RequestSimulationInput {
  readonly operationRef: OperationRef
  readonly inputRefs: readonly ResourceRef[]
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface RequestExecutionRequest {
  readonly runId: string
  readonly expectedStateRevision: number
  readonly operationRef: OperationRef
  readonly planRef: ResourceRef
  readonly inputRefs: readonly ResourceRef[]
  readonly mode: 'simulation' | 'live'
}

export interface ExecutionRecordView {
  readonly executionId: string
  readonly mode: 'simulation'
  readonly operationRef: OperationRef
  readonly planRef: ResourceRef
  readonly inputRefs: readonly ResourceRef[]
  readonly phase: string
  readonly requestedAt: string
  readonly liveSupported: false
  readonly deviceRequestsSent: number
  readonly stepRecords?: readonly { readonly slotIndex: number; readonly requested: { readonly chargeKw: number; readonly dischargeKw: number }; readonly accepted: boolean; readonly observed: boolean; readonly statusHistory: readonly ('Requested' | 'Accepted' | 'Observed')[]; readonly beforeEnergyKwh: number; readonly afterEnergyKwh: number; readonly stateRef: ResourceRef; readonly mode: 'simulation' }[]
  readonly finalStateRef?: ResourceRef
  readonly finalState?: { readonly energyKwh: number; readonly socPercent: number; readonly revision: number; readonly mode: 'simulation' }
}

export interface PlanViolationView {
  readonly constraint: string
  readonly slotIndex: number
  readonly detail: string
  readonly observed: number
  readonly limit: number
  readonly unit: string
}

export interface ReserveMarginView {
  readonly reserveKwh: number
  readonly windowStartSlot: number
  readonly windowEndSlot: number
  readonly minimumEnergyKwh: number
  readonly marginKwh: number
  readonly satisfied: boolean
  readonly severity: string
}

export interface PlanSimulationView {
  readonly status: string
  readonly executionMode: string
  readonly liveSupported: boolean
  readonly reserveMargins: readonly ReserveMarginView[]
  readonly violations: readonly PlanViolationView[]
  readonly costs: { readonly currency: string; readonly netCost: number; readonly totalCost: number }
}

export interface PlanCandidateView {
  readonly strategy: string
  readonly planRef: ResourceRef
  readonly objective: {
    readonly currency: string
    readonly netCost: number
    readonly totalCost: number
    readonly terminalEnergyKwh: number
    readonly reserveSatisfied: boolean
    readonly objectiveBasis: string
    readonly degradationModelled: boolean
  }
  readonly simulation: PlanSimulationView
}

export interface PlanComparisonView {
  readonly strategy: string
  readonly comparable: boolean
  readonly basis?: string
  readonly refusal?: string
  readonly currency: string
  readonly savingsClaim: boolean
  readonly baselineTotalCost: number
  readonly candidateTotalCost: number
  readonly rawCostDelta: number
  readonly adjustedCostDelta?: number
  readonly baselineTerminalEnergyKwh: number
  readonly candidateTerminalEnergyKwh: number
  readonly terminalEnergyDeltaKwh: number
  readonly notes: readonly string[]
}

export interface PlanSelectionView {
  readonly reason: string
  readonly optimality: string
  readonly selectedStrategy?: string
  readonly objectiveValue?: number
  readonly comparableBasis: boolean
  readonly notes: readonly string[]
}

export interface PlanResultView {
  readonly status: string
  readonly domainStatus: string
  readonly optimality: string
  readonly executionMode: string
  readonly liveSupported: boolean
  readonly inputManifestHash: string
  readonly algorithmVersion: { readonly id: string; readonly version: string; readonly digest: string }
  readonly selection: PlanSelectionView
  readonly candidates: readonly PlanCandidateView[]
  readonly baseline?: PlanCandidateView
  readonly comparisons: readonly PlanComparisonView[]
  readonly unavailableStrategies: readonly { readonly strategy: string; readonly reason: string }[]
  readonly assumptions: readonly string[]
  readonly unaccountedCostItems: readonly string[]
}

function resourceRefOf(value: unknown): ResourceRef | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.digest !== 'string' ||
    typeof value.kind !== 'string'
  ) {
    return undefined
  }
  return { id: value.id, version: value.version, digest: value.digest, kind: value.kind as ResourceRef['kind'] }
}

function sourceRefOf(value: unknown): { namespace: string; sourceId: string } | undefined {
  if (!isRecord(value) || typeof value.namespace !== 'string' || typeof value.sourceId !== 'string') {
    return undefined
  }
  return { namespace: value.namespace, sourceId: value.sourceId }
}

export function asScenarioDescriptor(value: unknown): ScenarioDescriptor | undefined {
  if (!isRecord(value)) return undefined
  const inputRef = resourceRefOf(value.inputRef)
  const horizon = isRecord(value.horizon) ? value.horizon : undefined
  const timeZone = asString(value.timeZone)
  const slotMinutes = asNumber(value.slotMinutes)
  const slotCount = asNumber(value.slotCount)
  const weather = value.weatherScenario
  if (
    inputRef === undefined ||
    typeof value.inputDigest !== 'string' ||
    typeof value.dataMode !== 'string' ||
    timeZone === undefined ||
    slotMinutes === undefined ||
    slotCount === undefined ||
    horizon === undefined ||
    typeof horizon.start !== 'string' ||
    typeof horizon.end !== 'string' ||
    !isWeatherScenario(weather)
  ) {
    return undefined
  }
  const series: ScenarioSeriesDescriptor[] = []
  if (Array.isArray(value.series)) {
    for (const entry of value.series) {
      if (!isRecord(entry)) return undefined
      const sourceRef = sourceRefOf(entry.sourceRef)
      const samplingType = asString(entry.samplingType)
      if (
        typeof entry.measurementPointRef !== 'string' ||
        (entry.role !== 'load' && entry.role !== 'pv') ||
        typeof entry.metric !== 'string' ||
        typeof entry.unit !== 'string' ||
        samplingType === undefined ||
        sourceRef === undefined ||
        typeof entry.dataMode !== 'string' ||
        typeof entry.firstSlotUtc !== 'string' ||
        typeof entry.lastSlotUtc !== 'string'
      ) {
        return undefined
      }
      series.push({
        measurementPointRef: entry.measurementPointRef,
        role: entry.role,
        metric: entry.metric,
        unit: entry.unit,
        samplingType,
        sourceRef,
        dataMode: entry.dataMode,
        firstSlotUtc: entry.firstSlotUtc,
        lastSlotUtc: entry.lastSlotUtc,
      })
    }
  }
  const stateRef = resourceRefOf(value.stateRef)
  const parentPlanRef = resourceRefOf(value.parentPlanRef)
  return {
    inputRef,
    inputDigest: value.inputDigest,
    dataMode: value.dataMode,
    timeZone,
    slotMinutes,
    slotCount,
    horizon: { start: horizon.start, end: horizon.end },
    backupRequirementKwh: asNumber(value.backupRequirementKwh) ?? 0,
    reserveSocPercent: asNumber(value.reserveSocPercent) ?? (asNumber(value.backupRequirementKwh) ?? 0) * 10,
    reserveWindowStartSlot: asNumber(value.reserveWindowStartSlot) ?? 0,
    initialEnergyKwh: asNumber(value.initialEnergyKwh) ?? 3.5,
    initialSocPercent: asNumber(value.initialSocPercent) ?? 35,
    stateRevision: asNumber(value.stateRevision) ?? 0,
    ...(stateRef === undefined ? {} : { stateRef }),
    ...(parentPlanRef === undefined ? {} : { parentPlanRef }),
    weatherScenario: weather,
    batterySpecSource: asString(value.batterySpecSource) ?? 'unknown',
    series,
    assumptions: asStringArray(value.assumptions),
  }
}

export function asSimulationRecord(value: unknown): SimulationRecordView | undefined {
  if (!isRecord(value)) return undefined
  const operationRef = isRecord(value.operationRef) ? value.operationRef : undefined
  const resultRef = resourceRefOf(value.resultRef)
  if (
    typeof value.simulationId !== 'string' ||
    operationRef === undefined ||
    typeof operationRef.id !== 'string' ||
    typeof operationRef.version !== 'string' ||
    value.mode !== 'simulation' ||
    value.liveSupported !== false ||
    typeof value.domainStatus !== 'string' ||
    typeof value.dataMode !== 'string' ||
    !Array.isArray(value.inputRefs) ||
    resultRef === undefined ||
    typeof value.createdAt !== 'string'
  ) {
    return undefined
  }
  const inputRefs: ResourceRef[] = []
  for (const entry of value.inputRefs) {
    const ref = resourceRefOf(entry)
    if (ref === undefined) return undefined
    inputRefs.push(ref)
  }
  return {
    simulationId: value.simulationId,
    operationRef: { id: operationRef.id, version: operationRef.version },
    mode: 'simulation',
    liveSupported: false,
    domainStatus: value.domainStatus,
    dataMode: value.dataMode,
    inputRefs,
    resultRef,
    createdAt: value.createdAt,
    status: asString(value.status) ?? 'completed',
  }
}

export function asSimulationDetail(value: unknown): SimulationDetailView | undefined {
  const record = asSimulationRecord(value)
  if (record === undefined || !isRecord(value)) return undefined
  const scenario = asScenarioDescriptor(value.scenario)
  if (scenario === undefined || typeof value.integrityVerified !== 'boolean') return undefined
  const sources: EnergySourceView[] = []
  if (Array.isArray(value.sources)) {
    for (const entry of value.sources) {
      if (!isRecord(entry)) continue
      const sourceRef = sourceRefOf(entry.sourceRef)
      if (sourceRef === undefined) continue
      const resultDigest = asString(entry.resultDigest)
      sources.push({
        sourceRef,
        schemaVersion: asString(entry.schemaVersion) ?? 'unknown',
        consistency: asString(entry.consistency) ?? 'unknown',
        ...(resultDigest === undefined ? {} : { resultDigest }),
      })
    }
  }
  return {
    ...record,
    integrityVerified: value.integrityVerified,
    scenario,
    result: value.result,
    sources,
  }
}

function asViolations(value: unknown): PlanViolationView[] {
  if (!Array.isArray(value)) return []
  const out: PlanViolationView[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const constraint = asString(entry.constraint)
    const slotIndex = asNumber(entry.slotIndex)
    const detail = asString(entry.detail)
    const observed = asNumber(entry.observed)
    const limit = asNumber(entry.limit)
    const unit = asString(entry.unit)
    if (
      constraint === undefined ||
      slotIndex === undefined ||
      detail === undefined ||
      observed === undefined ||
      limit === undefined ||
      unit === undefined
    ) {
      continue
    }
    out.push({ constraint, slotIndex, detail, observed, limit, unit })
  }
  return out
}

function asReserveMargins(value: unknown): ReserveMarginView[] {
  if (!Array.isArray(value)) return []
  const out: ReserveMarginView[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const reserveKwh = asNumber(entry.reserveKwh)
    const marginKwh = asNumber(entry.marginKwh)
    const minimumEnergyKwh = asNumber(entry.minimumEnergyKwh)
    const windowStartSlot = asNumber(entry.windowStartSlot)
    const windowEndSlot = asNumber(entry.windowEndSlot)
    const satisfied = asBoolean(entry.satisfied)
    if (
      reserveKwh === undefined ||
      marginKwh === undefined ||
      minimumEnergyKwh === undefined ||
      windowStartSlot === undefined ||
      windowEndSlot === undefined ||
      satisfied === undefined
    ) {
      continue
    }
    out.push({
      reserveKwh,
      windowStartSlot,
      windowEndSlot,
      minimumEnergyKwh,
      marginKwh,
      satisfied,
      severity: asString(entry.severity) ?? 'hard',
    })
  }
  return out
}

function asSimulationView(value: unknown): PlanSimulationView | undefined {
  if (!isRecord(value)) return undefined
  const costs = isRecord(value.costs) ? value.costs : undefined
  return {
    status: asString(value.status) ?? 'unknown',
    executionMode: asString(value.executionMode) ?? 'unknown',
    liveSupported: asBoolean(value.liveSupported) ?? false,
    reserveMargins: asReserveMargins(value.reserveMargins),
    violations: asViolations(value.violations),
    costs: {
      currency: costs === undefined ? 'unknown' : (asString(costs.currency) ?? 'unknown'),
      netCost: costs === undefined ? 0 : (asNumber(costs.netCost) ?? 0),
      totalCost: costs === undefined ? 0 : (asNumber(costs.totalCost) ?? 0),
    },
  }
}

function asCandidate(value: unknown): PlanCandidateView | undefined {
  if (!isRecord(value)) return undefined
  const strategy = asString(value.strategy)
  const plan = isRecord(value.plan) ? value.plan : undefined
  const planRef = plan === undefined ? undefined : resourceRefOf(plan.planRef)
  const objective = isRecord(value.objective) ? value.objective : undefined
  const simulation = asSimulationView(value.simulation)
  if (strategy === undefined || planRef === undefined || objective === undefined || simulation === undefined) {
    return undefined
  }
  return {
    strategy,
    planRef,
    objective: {
      currency: asString(objective.currency) ?? 'unknown',
      netCost: asNumber(objective.netCost) ?? 0,
      totalCost: asNumber(objective.totalCost) ?? 0,
      terminalEnergyKwh: asNumber(objective.terminalEnergyKwh) ?? 0,
      reserveSatisfied: asBoolean(objective.reserveSatisfied) ?? false,
      objectiveBasis: asString(objective.objectiveBasis) ?? 'unknown',
      degradationModelled: asBoolean(objective.degradationModelled) ?? false,
    },
    simulation,
  }
}

function asComparison(value: unknown): PlanComparisonView | undefined {
  if (!isRecord(value)) return undefined
  const strategy = asString(value.strategy)
  const currency = asString(value.currency)
  const comparable = asBoolean(value.comparable)
  const savingsClaim = asBoolean(value.savingsClaim)
  if (strategy === undefined || currency === undefined || comparable === undefined || savingsClaim === undefined) {
    return undefined
  }
  const basis = asString(value.basis)
  const refusal = asString(value.refusal)
  const adjusted = asNumber(value.adjustedCostDelta)
  return {
    strategy,
    comparable,
    currency,
    savingsClaim,
    baselineTotalCost: asNumber(value.baselineTotalCost) ?? 0,
    candidateTotalCost: asNumber(value.candidateTotalCost) ?? 0,
    rawCostDelta: asNumber(value.rawCostDelta) ?? 0,
    baselineTerminalEnergyKwh: asNumber(value.baselineTerminalEnergyKwh) ?? 0,
    candidateTerminalEnergyKwh: asNumber(value.candidateTerminalEnergyKwh) ?? 0,
    terminalEnergyDeltaKwh: asNumber(value.terminalEnergyDeltaKwh) ?? 0,
    notes: asStringArray(value.notes),
    ...(basis === undefined ? {} : { basis }),
    ...(refusal === undefined ? {} : { refusal }),
    ...(adjusted === undefined ? {} : { adjustedCostDelta: adjusted }),
  }
}

/**
 * Recognise a planner result. The UI renders numbers only from a recognised shape; an
 * unrecognised payload is shown as an explicit "not displayable" notice rather than guessed at.
 */
export function asPlanResult(value: unknown): PlanResultView | undefined {
  if (!isRecord(value)) return undefined
  const selection = isRecord(value.selection) ? value.selection : undefined
  const algorithmVersion = isRecord(value.algorithmVersion) ? value.algorithmVersion : undefined
  if (
    typeof value.status !== 'string' ||
    typeof value.domainStatus !== 'string' ||
    typeof value.executionMode !== 'string' ||
    typeof value.inputManifestHash !== 'string' ||
    selection === undefined ||
    typeof selection.reason !== 'string' ||
    algorithmVersion === undefined ||
    typeof algorithmVersion.id !== 'string' ||
    typeof algorithmVersion.version !== 'string' ||
    typeof algorithmVersion.digest !== 'string' ||
    !Array.isArray(value.candidates)
  ) {
    return undefined
  }
  const candidates: PlanCandidateView[] = []
  for (const entry of value.candidates) {
    const candidate = asCandidate(entry)
    if (candidate === undefined) return undefined
    candidates.push(candidate)
  }
  const comparisons: PlanComparisonView[] = []
  if (Array.isArray(value.comparisons)) {
    for (const entry of value.comparisons) {
      const comparison = asComparison(entry)
      if (comparison !== undefined) comparisons.push(comparison)
    }
  }
  const baseline = value.baseline === undefined ? undefined : asCandidate(value.baseline)
  const selectedStrategy = asString(selection.selectedStrategy)
  const objectiveValue = asNumber(selection.objectiveValue)
  const unavailableStrategies: { strategy: string; reason: string }[] = []
  if (Array.isArray(value.unavailableStrategies)) {
    for (const entry of value.unavailableStrategies) {
      if (!isRecord(entry)) continue
      const strategy = asString(entry.strategy)
      const reason = asString(entry.reason)
      if (strategy !== undefined && reason !== undefined) unavailableStrategies.push({ strategy, reason })
    }
  }
  return {
    status: value.status,
    domainStatus: value.domainStatus,
    optimality: asString(value.optimality) ?? 'not_claimed',
    executionMode: value.executionMode,
    liveSupported: asBoolean(value.liveSupported) ?? false,
    inputManifestHash: value.inputManifestHash,
    algorithmVersion: {
      id: algorithmVersion.id,
      version: algorithmVersion.version,
      digest: algorithmVersion.digest,
    },
    selection: {
      reason: selection.reason,
      optimality: asString(selection.optimality) ?? 'best_of_tested_candidates',
      comparableBasis: asBoolean(selection.comparableBasis) ?? false,
      notes: asStringArray(selection.notes),
      ...(selectedStrategy === undefined ? {} : { selectedStrategy }),
      ...(objectiveValue === undefined ? {} : { objectiveValue }),
    },
    candidates,
    comparisons,
    unavailableStrategies,
    assumptions: asStringArray(value.assumptions),
    unaccountedCostItems: asStringArray(value.unaccountedCostItems),
    ...(baseline === undefined ? {} : { baseline }),
  }
}

export function asExecutionRecord(value: unknown): ExecutionRecordView | undefined {
  if (!isRecord(value)) return undefined
  const operationRef = isRecord(value.operationRef) ? value.operationRef : undefined
  const planRef = resourceRefOf(value.planRef)
  if (
    typeof value.executionId !== 'string' ||
    value.mode !== 'simulation' ||
    value.liveSupported !== false ||
    operationRef === undefined ||
    typeof operationRef.id !== 'string' ||
    typeof operationRef.version !== 'string' ||
    planRef === undefined ||
    typeof value.phase !== 'string' ||
    typeof value.requestedAt !== 'string' ||
    !Array.isArray(value.inputRefs)
  ) {
    return undefined
  }
  const inputRefs: ResourceRef[] = []
  for (const entry of value.inputRefs) {
    const ref = resourceRefOf(entry)
    if (ref === undefined) return undefined
    inputRefs.push(ref)
  }
  const stepRecords: NonNullable<ExecutionRecordView['stepRecords']>[number][] = []
  if (Array.isArray(value.stepRecords)) for (const step of value.stepRecords) {
    if (!isRecord(step) || !isRecord(step.requested)) continue
    const stateRef = resourceRefOf(step.stateRef)
    const slotIndex = asNumber(step.slotIndex), beforeEnergyKwh = asNumber(step.beforeEnergyKwh), afterEnergyKwh = asNumber(step.afterEnergyKwh)
    const chargeKw = asNumber(step.requested.chargeKw), dischargeKw = asNumber(step.requested.dischargeKw)
    const statusHistory = Array.isArray(step.statusHistory) ? step.statusHistory.filter((status): status is 'Requested' | 'Accepted' | 'Observed' => status === 'Requested' || status === 'Accepted' || status === 'Observed') : []
    if (stateRef !== undefined && slotIndex !== undefined && beforeEnergyKwh !== undefined && afterEnergyKwh !== undefined && chargeKw !== undefined && dischargeKw !== undefined && typeof step.accepted === 'boolean' && typeof step.observed === 'boolean' && statusHistory.join(',') === 'Requested,Accepted,Observed' && step.mode === 'simulation') stepRecords.push({ slotIndex, requested: { chargeKw, dischargeKw }, accepted: step.accepted, observed: step.observed, statusHistory, beforeEnergyKwh, afterEnergyKwh, stateRef, mode: 'simulation' })
  }
  const finalStateRef = resourceRefOf(value.finalStateRef)
  const finalStateValue = isRecord(value.finalState) ? value.finalState : undefined
  const finalEnergy = finalStateValue === undefined ? undefined : asNumber(finalStateValue.energyKwh)
  const finalSoc = finalStateValue === undefined ? undefined : asNumber(finalStateValue.socPercent)
  const finalRevision = finalStateValue === undefined ? undefined : asNumber(finalStateValue.revision)
  return {
    executionId: value.executionId,
    mode: 'simulation',
    operationRef: { id: operationRef.id, version: operationRef.version },
    planRef,
    inputRefs,
    phase: value.phase,
    requestedAt: value.requestedAt,
    liveSupported: false,
    deviceRequestsSent: asNumber(value.deviceRequestsSent) ?? 0,
    ...(stepRecords.length === 0 ? {} : { stepRecords }),
    ...(finalStateRef === undefined ? {} : { finalStateRef }),
    ...(finalEnergy === undefined || finalSoc === undefined || finalRevision === undefined || finalStateValue?.mode !== 'simulation' ? {} : { finalState: { energyKwh: finalEnergy, socPercent: finalSoc, revision: finalRevision, mode: 'simulation' as const } }),
  }
}

export interface VirtualBatteryStateView {
  readonly deviceId: string
  readonly energyKwh: number
  readonly capacityKwh: number
  readonly socPercent: number
  readonly revision: number
  readonly mode: 'simulation'
  readonly updatedAt: string
  readonly simulatedAt: string
  readonly stateRef?: ResourceRef
}

export function asVirtualBatteryState(value: unknown): VirtualBatteryStateView | undefined {
  if (!isRecord(value) || value.mode !== 'simulation') return undefined
  const stateRef = resourceRefOf(value.stateRef)
  const deviceId = asString(value.deviceId), energyKwh = asNumber(value.energyKwh), capacityKwh = asNumber(value.capacityKwh), socPercent = asNumber(value.socPercent), revision = asNumber(value.revision), updatedAt = asString(value.updatedAt), simulatedAt = asString(value.simulatedAt)
  if (deviceId === undefined || energyKwh === undefined || capacityKwh === undefined || socPercent === undefined || revision === undefined || updatedAt === undefined || simulatedAt === undefined || !Number.isSafeInteger(revision) || revision < 0) return undefined
  return { deviceId, energyKwh, capacityKwh, socPercent, revision, mode: 'simulation', updatedAt, simulatedAt, ...(stateRef === undefined ? {} : { stateRef }) }
}
