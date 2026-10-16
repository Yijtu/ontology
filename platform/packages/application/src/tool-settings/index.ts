/**
 * AI settings: tool-connection catalogue, per-tool assignment, effective resolution and
 * per-execution binding (design §9).
 *
 * These services depend only on `@ontology/contracts` ports. Credentials cross exactly one port
 * (`ToolCredentialCustodian`) and never enter a returned entity, a summary, a probe result or a
 * job/event payload. A tool connection is a different entity from a model connection: `web_search`
 * is a tool capability, `research` is a model capability.
 */
export {
  ToolConnectionService,
  toolDescriptorOf,
  toolDescriptorOfSnapshot,
  toolExecutionSnapshotOf,
} from './tool-connection-service'
export type {
  ToolConnectionServiceDependencies,
  ToolConnectionCreateInput,
  ToolConnectionUpdateInput,
  ToolConnectionCopyInput,
  ToolCredentialWrite,
} from './tool-connection-service'

export { ToolAssignmentService } from './tool-assignment-service'
export type {
  ToolAssignmentServiceDependencies,
  ToolAssignmentWrite,
} from './tool-assignment-service'

export { ToolSelectionService } from './tool-selection-service'
export type { ToolSelectionServiceDependencies } from './tool-selection-service'

export { ExecutionToolBindingService } from './execution-tool-binding-service'
export type { ExecutionToolBindingServiceDependencies } from './execution-tool-binding-service'

export {
  toolAdapterSupportsCapability,
  capabilitiesSupportedByAdapter,
} from './tool-adapter-capabilities'
