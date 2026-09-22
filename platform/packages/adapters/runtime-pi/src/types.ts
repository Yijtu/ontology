import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  ComponentManifest,
  GenerationRole,
  ModelRef,
  ResourceRef,
  ToolCoverage,
  ToolId,
  ToolResultStatus,
} from '@ontology/contracts'
import type { TUnsafe } from 'typebox'

/**
 * The locked `@earendil-works/pi-agent-core` version this adapter is compiled and tested
 * against. It is recorded in every private checkpoint and compared on resume, so an SDK
 * upgrade that changes the on-disk continuation state fails explicitly instead of silently
 * rehydrating a transcript a different kernel may misread.
 */
export const PI_AGENT_CORE_VERSION = '0.87.0'

/** Permissive parameter schema: the platform gateway owns canonical argument validation. */
export type GatewayToolParameters = TUnsafe<Record<string, unknown>>

/** The bounded, JSON-safe result the model sees back from a gateway call. */
export interface GatewayToolDetails {
  readonly status: ToolResultStatus
  readonly evidenceRefs: readonly ResourceRef[]
  readonly coverage: ToolCoverage
}

export type GatewayTool = AgentTool<GatewayToolParameters, GatewayToolDetails>

/**
 * Construction-time configuration for the Pi runtime adapter (SPEC C2, §4.2).
 *
 * Everything here is host-injected and expressed in canonical contracts. The Pi SDK types
 * stay inside this adapter; the platform only sees `RuntimeAdapter`.
 */
export interface PiRuntimeConfig {
  readonly manifest: ComponentManifest
  /**
   * The exact host-authorized tool subset the model may propose, resolved from the run's
   * profile. The runtime exposes only these tools; the gateway still authorizes every call,
   * so this list is a surface limit, never the authorization decision.
   */
  readonly toolIds: readonly ToolId[]
  /** Platform model reference sent to `GenerationPort`; never a vendor model id. */
  readonly modelRef: ModelRef
  /** Generation role label for the collection-loop model calls. Defaults to `planner`. */
  readonly generationRole?: GenerationRole
  /** Output token cap per model call. Defaults to 1024. */
  readonly maxTokens?: number
  /** System prompt for the collection loop. Defaults to a fixed, non-answering instruction. */
  readonly systemPrompt?: string
  /**
   * Locked Pi SDK version. Defaults to {@link PI_AGENT_CORE_VERSION}; overridable only so a
   * test can simulate an SDK upgrade/downgrade against a persisted checkpoint.
   */
  readonly sdkVersion?: string
  readonly now?: () => string
  readonly newId?: () => string
}
