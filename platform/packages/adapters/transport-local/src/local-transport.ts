import { CONTROLLER_SERVICE_IDS } from '@ontology/contracts'
import type {
  CancelResponse,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolGateway,
  ToolResult,
} from '@ontology/contracts'

export type LocalTransportErrorCode = 'CONTROLLER_SERVICE_IN_TOOL_LIST' | 'EMPTY_TOOL_LIST'

export class LocalTransportError extends Error {
  readonly code: LocalTransportErrorCode

  constructor(code: LocalTransportErrorCode, message: string) {
    super(message)
    this.name = 'LocalTransportError'
    this.code = code
  }
}

/**
 * The only surface the runtime receives (C5).
 *
 * It is a closed, frozen facade over the gateway: `invoke` and `cancel` and nothing
 * else. No store, driver, blob handle, control repository or filesystem is reachable
 * from the injected dependency object, so a runtime can only reach data through the
 * gateway.
 */
export interface RestrictedToolGateway {
  invoke(call: ToolCall, ctx: ToolContext): Promise<ToolResult>
  cancel(callId: string, reason: string, ctx: ToolContext): Promise<CancelResponse>
}

export interface LocalRuntimeDependencies {
  readonly gateway: RestrictedToolGateway
}

export interface LocalToolRegistrationInput {
  /** The enabled tool definitions for this run, already resolved from the profile. */
  readonly tools: readonly ToolDefinition[]
  readonly gateway: ToolGateway
}

export interface LocalToolRegistration {
  readonly tools: readonly ToolDefinition[]
  readonly dependencies: LocalRuntimeDependencies
}

/**
 * The runtime-facing surface the local transport registers into (C5). The real runtimes
 * implement this in LOCAL-017/018; the local transport only declares it, so no domain
 * logic or adapter lives here.
 */
export interface RuntimeToolRegistry {
  registerTools(tools: readonly ToolDefinition[]): void
}

function restrictGateway(gateway: ToolGateway): RestrictedToolGateway {
  return Object.freeze({
    invoke: (call: ToolCall, ctx: ToolContext): Promise<ToolResult> => gateway.invoke(call, ctx),
    cancel: (callId: string, reason: string, ctx: ToolContext): Promise<CancelResponse> =>
      gateway.cancel(callId, reason, ctx),
  })
}

/**
 * ADR-05/C5: the local transport registers `ToolDefinition`s into the runtime and passes
 * a restricted closure as the runtime dependency object. It contains no domain logic: it
 * never queries a backend, resolves an operation or interprets a tool argument.
 *
 * `verify_result`/`final_answer` must never reach the model, so a tool list containing a
 * controller service id is rejected rather than silently filtered.
 */
export function createLocalToolRegistration(
  input: LocalToolRegistrationInput,
): LocalToolRegistration {
  if (input.tools.length === 0) {
    throw new LocalTransportError('EMPTY_TOOL_LIST', 'the local transport needs at least one tool')
  }
  const controllerIds: readonly string[] = CONTROLLER_SERVICE_IDS
  for (const definition of input.tools) {
    if (controllerIds.includes(definition.toolId)) {
      throw new LocalTransportError(
        'CONTROLLER_SERVICE_IN_TOOL_LIST',
        `${definition.toolId} is a controller service and must never be registered as a model tool`,
      )
    }
  }
  const tools = Object.freeze([...input.tools])
  const dependencies: LocalRuntimeDependencies = Object.freeze({
    gateway: restrictGateway(input.gateway),
  })
  return Object.freeze({ tools, dependencies })
}

/** Hand the registered definitions to the runtime's tool registry. */
export function registerWithRuntime(
  registry: RuntimeToolRegistry,
  registration: LocalToolRegistration,
): void {
  registry.registerTools(registration.tools)
}
