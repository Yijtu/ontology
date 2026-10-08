/**
 * Registered compute execution: the idempotent invocation ledger, the immutable result
 * artifact wrapper and the raw output bindings (SPEC v0.3a §EX-6, issue V03-031).
 */
export { ComputeExecutionError, isComputeExecutionError } from './errors'
export type { ComputeExecutionErrorCode } from './errors'
export { assertComputeHandlerArtifact, computeBuildArtifactDigest, createArtifactComputeHandlers, verifyComputeBuildArtifact } from './build-artifact'
export type { ArtifactComputeHandlerOptions, ComputeBuildArtifactManifest } from './build-artifact'
export {
  EXAMPLE_ALGORITHM_REF,
  EXAMPLE_INPUT_SCHEMA_VERSION,
  EXAMPLE_OPERATION_LIMITS,
  EXAMPLE_OPERATION_REF,
  EXAMPLE_RESULT_MEDIA_TYPE,
  createExampleComputeHandlers,
  exampleOperationRegistry,
  exampleRegisteredOperation,
} from './example-operation'
export type { ExampleComputeArtifactOptions } from './example-operation'
export {
  RegisteredComputeExecutionService,
  computeLogicalKeyDigest,
  registeredOperationDigest,
} from './execution-service'
export type {
  ComputeExecutionInput,
  ComputeExecutionResult,
  RegisteredComputeExecutionDependencies,
} from './execution-service'
export { SyntheticActionTrial } from './synthetic-trial'
export type { SyntheticActionTrialDependencies } from './synthetic-trial'
