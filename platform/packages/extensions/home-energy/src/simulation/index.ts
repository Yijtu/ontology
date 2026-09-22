export { EnergySimulationError } from './errors'
export type { EnergySimulationErrorCode } from './errors'

export { EnergySimulator, assertSimulationMode } from './simulator'

export { dispatchSlot } from './dispatch'
export type { SlotDispatchInputs, SlotFlows } from './dispatch'

export { inRange, round, withinTolerance } from './tolerance'

export {
  DEFAULT_SIMULATION_TOLERANCE,
  ENERGY_SIMULATOR_ALGORITHM,
  NUMERIC_POLICY,
  SIMULATION_VERSION,
} from './types'
export type {
  BatterySpecDeclaration,
  ConstraintViolation,
  EnergySimulationRequest,
  EnergySimulatorPort,
  GridSpec,
  PlanStep,
  PlanTrajectory,
  ReserveConstraint,
  ReserveMargin,
  SamplingMarker,
  SeriesBinding,
  SimulationConstraintKind,
  SimulationCosts,
  SimulationIntervalResult,
  SimulationMissingInput,
  SimulationMissingReason,
  SimulationResult,
  SimulationStatus,
  SimulationTolerance,
  SupportedTopology,
  SupportedTopologyKind,
  TariffBinding,
  TariffPriceSlot,
  TopologyDeclaration,
  UnsupportedTopology,
  UnsupportedTopologyKind,
} from './types'
