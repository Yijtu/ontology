import type { ToolContextData } from './generated/contracts'

/**
 * Runtime brand for the trusted tool context.
 *
 * The brand is a symbol, so it cannot be produced by JSON.parse of model output,
 * HTTP bodies or tool arguments. `createToolContext` is the only producer, and it is
 * called by the host/gateway when it establishes the server-side principal, run
 * budget reservation and allowlist.
 */
export const TOOL_CONTEXT_BRAND: unique symbol = Symbol.for('@ontology/contracts/ToolContext')

/**
 * Trusted, host-injected tool context (C4). Structurally it is ToolContextData plus a
 * non-serializable brand, so a model-shaped object literal does not satisfy it.
 *
 * The brand is intentionally NOT reachable from any tool input schema; see the
 * `tool-context-trust` contract test.
 */
export type ToolContext = ToolContextData & { readonly [TOOL_CONTEXT_BRAND]: true }

/**
 * The only way to mint a ToolContext. Must be called with server-established fields
 * (authentication result, policy version, deadline and the atomic budget reservation).
 */
export function createToolContext(fields: ToolContextData): ToolContext {
  return Object.freeze({ ...fields, [TOOL_CONTEXT_BRAND]: true as const })
}

/**
 * Runtime guard mirroring the type brand. Model-supplied or deserialized objects fail
 * this check even when they carry every ToolContextData field.
 */
export function isToolContext(value: unknown): value is ToolContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[TOOL_CONTEXT_BRAND] === true
  )
}
