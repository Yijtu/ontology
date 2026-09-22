import { Type } from 'typebox'
import type { ToolCall, ToolContext, ToolGateway, ToolId, ToolResult } from '@ontology/contracts'
import type { GatewayTool, GatewayToolParameters } from './types'

const INLINE_PREVIEW_CHARS = 4_000

/** Permissive parameter schema: the platform gateway owns canonical argument validation. */
const GATEWAY_PARAMETERS: GatewayToolParameters = Type.Unsafe<Record<string, unknown>>(
  Type.Object({}, { additionalProperties: true }),
)

export interface GatewayToolHooks {
  /** Recorded before the gateway call so cancellation can name the in-flight attempt. */
  readonly onCall: (call: ToolCall) => void
  /** Recorded after the gateway returns; the runtime derives `evidence_added` from it. */
  readonly onResult: (call: ToolCall, result: ToolResult) => void
}

/**
 * Wrap every model-proposable tool as a Pi `AgentTool` whose `execute` is the *only*
 * execution path: it calls `deps.gateway.invoke`. The runtime has no other way to reach a
 * data source, driver or filesystem, so the gateway's validate → reserve → intent →
 * execute → evidence → settle sequence is unavoidable (ADR-04, C4).
 *
 * The tool description and parameter schema only tell the model what it may propose. They
 * are not authorization: an enabled-surface call is still authorized by the gateway, which
 * can reject it for scope, profile, budget or schema reasons.
 */
export function createGatewayTools(input: {
  readonly toolIds: readonly ToolId[]
  readonly gateway: ToolGateway
  readonly ctx: ToolContext
  readonly hooks: GatewayToolHooks
  readonly newId: () => string
}): readonly GatewayTool[] {
  return input.toolIds.map((toolId) => ({
    name: toolId,
    label: toolId,
    description: `Propose the ${toolId} collection call. It is routed through the platform tool gateway.`,
    parameters: GATEWAY_PARAMETERS,
    execute: async (toolCallId, params) => {
      // The model's tool-call id is opaque and untrusted; the platform call id is a
      // host-minted UUID the gateway persists.
      void toolCallId
      const call: ToolCall = {
        callId: input.newId(),
        toolId,
        arguments: { ...params },
      }
      input.hooks.onCall(call)
      const result = await input.gateway.invoke(call, input.ctx)
      input.hooks.onResult(call, result)
      return {
        content: [{ type: 'text', text: renderResult(result) }],
        details: {
          status: result.status,
          evidenceRefs: result.evidenceRefs,
          coverage: result.coverage,
        },
      }
    },
  }))
}

function renderResult(result: ToolResult): string {
  if (result.status === 'error') {
    const code = result.error?.code ?? 'UNKNOWN'
    return `error: ${code}: ${result.error?.message ?? 'the tool call failed'}`
  }
  const inline =
    result.inlineData === undefined ? '(no inline payload; read the archived dataRef)' : JSON.stringify(result.inlineData)
  const preview = inline.length > INLINE_PREVIEW_CHARS ? `${inline.slice(0, INLINE_PREVIEW_CHARS)}…` : inline
  return `status=${result.status} returned=${String(result.coverage.returned)} truncated=${String(result.coverage.truncated)}\n${preview}`
}
