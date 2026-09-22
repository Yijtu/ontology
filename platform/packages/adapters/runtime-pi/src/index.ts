/**
 * @ontology/adapter-runtime-pi — the Pi Agent Core runtime adapter (SPEC §4.2, C2, D7).
 *
 * It drives an evidence-collection loop with the real `@earendil-works/pi-agent-core`
 * `Agent`. A host-injected controlled stream function bridges the Pi transcript to
 * `GenerationPort`; every model-proposed tool call is wrapped so its only execution path is
 * `deps.gateway.invoke`. The adapter imports `@ontology/contracts`, `@ontology/core` and the
 * locked Pi SDK: no database driver, industry pack, extension, other adapter or application
 * layer. It has no publication path — its terminal event is `collection_complete`, which only
 * means a draft may be attempted.
 */
export { PiRuntimeAdapter } from './runtime'
export { PiRuntimeError, isPiRuntimeError, platformErrorFor } from './errors'
export type { PiRuntimeErrorCode } from './errors'
export { createControlledStreamFn } from './stream'
export type { ControlledStreamInput } from './stream'
export { createGatewayTools } from './tools'
export type { GatewayToolHooks } from './tools'
export {
  CHECKPOINT_SCHEMA_VERSION,
  checkpointDigest,
  decodeCheckpoint,
  encodeCheckpoint,
  stableStringify,
} from './checkpoint'
export type { CheckpointPayload } from './checkpoint'
export { PI_AGENT_CORE_VERSION } from './types'
export type {
  GatewayTool,
  GatewayToolDetails,
  GatewayToolParameters,
  PiRuntimeConfig,
} from './types'
