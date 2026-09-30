/**
 * @ontology/adapter-runtime-template — the template runtime adapter (SPEC §4.2, C2, D7).
 *
 * It executes an already-registered `PlanSpec` through the host-injected tool gateway and
 * shared budget, in declared dependency order with safe read-only concurrency. It imports
 * only `@ontology/contracts` and `@ontology/core`: no SDK, database driver, industry pack,
 * extension, other adapter or application layer, and no publication path — its terminal
 * event is `collection_complete`, which only means a draft may be attempted.
 */
export { TemplateRuntimeAdapter, TEMPLATE_RUNTIME_KIND } from './runtime'
export {
  TemplateRuntimeError,
  isTemplateRuntimeError,
  platformErrorFor,
} from './errors'
export type { TemplateRuntimeErrorCode } from './errors'
export { resolveArguments, resolveJsonPointer, validatePlan } from './plan'
export type { ArgumentResolution, MissingArgument, MissingArgumentReason } from './plan'
export {
  CHECKPOINT_SCHEMA_VERSION,
  checkpointDigest,
  decodeCheckpoint,
  encodeCheckpoint,
  stableStringify,
} from './checkpoint'
export type { CheckpointPayload, CheckpointStepOutput } from './checkpoint'
export type {
  PublishedPlan,
  StepOutput,
  TemplatePlanPreparation,
  TemplatePlanPreparationRequest,
  TemplatePlanResolver,
  TemplateRuntimeConfig,
} from './types'
