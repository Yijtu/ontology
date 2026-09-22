import { CONTROLLER_SERVICE_IDS, createToolContext, isToolContext } from '@ontology/contracts'
import type {
  AllowedResources,
  BudgetReservationRef,
  NonEmptyString,
  Principal,
  Rfc3339UtcTimestamp,
  Semver,
  Sha256Digest,
  ToolContext,
  ToolDefinition,
  ToolGateway,
  Uuid,
} from '@ontology/contracts'
import { McpTransportError } from './errors'

/**
 * The identity a trusted launcher establishes for one inbound MCP connection (C5, SPEC §3).
 *
 * A stdio server process receives this from the host that spawned it (the launcher), never
 * from the connecting client. It is the only source of the session's principal, scope,
 * run and budget binding; a `tenant_id`/`run_id`/role supplied by the client in tool
 * arguments carries no trust and is rejected by the gateway's trusted-envelope check.
 */
export interface McpLauncherIdentity {
  readonly sessionId: NonEmptyString
  readonly principal: Principal
  readonly allowedResources: AllowedResources
  readonly runId: Uuid
  readonly budgetReservation: BudgetReservationRef
  readonly resolvedProfileHash: Sha256Digest
  readonly policyVersion: Semver
  readonly deadline: Rfc3339UtcTimestamp
  readonly traceId: NonEmptyString
}

/**
 * A limited, host-established tool session: a single host-minted `ToolContext`, the
 * server-side gateway it is bound to, and the whitelisted tool definitions the session
 * may expose. The quota is enforced by the gateway's shared budget ledger, so an
 * external standalone call cannot bypass it and a cross-transport retry draws from the
 * same counters.
 */
export interface McpToolSession {
  readonly sessionId: NonEmptyString
  readonly runId: Uuid
  readonly context: ToolContext
  readonly gateway: ToolGateway
  readonly tools: readonly ToolDefinition[]
  readonly maxCalls: number
}

export interface McpSessionLauncher {
  openSession(): McpToolSession | Promise<McpToolSession>
  closeSession?(session: McpToolSession): void | Promise<void>
}

export interface CreateMcpSessionInput {
  readonly identity: McpLauncherIdentity
  readonly gateway: ToolGateway
  readonly tools: readonly ToolDefinition[]
  readonly maxCalls?: number
}

const DEFAULT_MAX_CALLS = 8

/**
 * Mint the host-side tool context from a launcher identity. The branded context is
 * produced only here, so it can never be reconstructed from client JSON.
 */
export function mintSessionContext(identity: McpLauncherIdentity): ToolContext {
  if (identity.principal.tenantId !== identity.allowedResources.tenantId) {
    throw new McpTransportError(
      'IDENTITY_REJECTED',
      'the launcher identity carries an inconsistent tenant scope',
    )
  }
  if (identity.runId !== identity.budgetReservation.runId) {
    throw new McpTransportError(
      'IDENTITY_REJECTED',
      'the launcher budget reservation does not belong to the session run',
    )
  }
  return createToolContext({
    principal: identity.principal,
    runId: identity.runId,
    resolvedProfileHash: identity.resolvedProfileHash,
    policyVersion: identity.policyVersion,
    deadline: identity.deadline,
    budgetReservation: identity.budgetReservation,
    allowedResources: identity.allowedResources,
    traceId: identity.traceId,
  })
}

/**
 * Mint the host-side tool session. The `ToolContext` is produced only here, from the
 * launcher identity, so the branded context can never be reconstructed from client JSON.
 */
export function createMcpSession(input: CreateMcpSessionInput): McpToolSession {
  const { identity } = input
  const controllerIds: readonly string[] = CONTROLLER_SERVICE_IDS
  for (const definition of input.tools) {
    if (controllerIds.includes(definition.toolId)) {
      throw new McpTransportError(
        'IDENTITY_REJECTED',
        `${definition.toolId} is a controller service and must never be exposed as an MCP tool`,
      )
    }
  }
  const context = mintSessionContext(identity)
  return Object.freeze({
    sessionId: identity.sessionId,
    runId: identity.runId,
    context,
    gateway: input.gateway,
    tools: Object.freeze([...input.tools]),
    maxCalls: input.maxCalls ?? DEFAULT_MAX_CALLS,
  })
}

/**
 * Re-assert the invariants of a session supplied by a launcher. A launcher that hands
 * back a forged (unbranded) context or a run mismatch is refused before any call runs.
 */
export function assertMcpToolSession(session: McpToolSession): void {
  if (!isToolContext(session.context)) {
    throw new McpTransportError(
      'IDENTITY_REJECTED',
      'the launcher session does not carry a host-minted tool context',
    )
  }
  if (session.context.runId !== session.runId) {
    throw new McpTransportError('IDENTITY_REJECTED', 'the session context run does not match the session')
  }
  if (session.context.principal.tenantId !== session.context.allowedResources.tenantId) {
    throw new McpTransportError('IDENTITY_REJECTED', 'the session context carries inconsistent tenant scope')
  }
}
