/**
 * @ontology/adapter-transport-local — local tool registration (C5, ADR-05).
 *
 * Registers the run's `ToolDefinition`s into the runtime and injects a restricted
 * closure that exposes only the gateway. It contains no domain logic and imports no
 * other adapter, extension or industry pack.
 */
export {
  LocalTransportError,
  createLocalToolRegistration,
  registerWithRuntime,
} from './local-transport'
export type {
  LocalRuntimeDependencies,
  LocalToolRegistration,
  LocalToolRegistrationInput,
  LocalTransportErrorCode,
  RestrictedToolGateway,
  RuntimeToolRegistry,
} from './local-transport'
