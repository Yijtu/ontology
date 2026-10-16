/**
 * AI settings: model-connection catalogue, per-capability/per-object assignment, effective
 * resolution and per-execution binding (design §5.3, A-R09/A-R10/A-R11).
 *
 * These services depend only on `@ontology/contracts` ports. Credentials cross exactly one port
 * (`ModelCredentialCustodian`) and never enter a returned entity, a summary, a test result or a
 * job/event payload.
 */
export {
  ModelConnectionService,
  descriptorOf,
  modelExecutionSnapshotOf,
} from './model-connection-service'
export type {
  ModelConnectionServiceDependencies,
  ModelConnectionCreateInput,
  ModelConnectionUpdateInput,
  ModelConnectionCopyInput,
  ModelCredentialWrite,
} from './model-connection-service'

export { ModelAssignmentService } from './model-assignment-service'
export type {
  ModelAssignmentServiceDependencies,
  ModelAssignmentWrite,
} from './model-assignment-service'

export { ModelSelectionService, MODEL_RESOLUTION_LAYERS } from './model-selection-service'
export type { ModelSelectionServiceDependencies } from './model-selection-service'

export { ExecutionModelBindingService } from './execution-model-binding-service'
export type { ExecutionModelBindingServiceDependencies } from './execution-model-binding-service'
