import {
  ToolConnectionError,
  assertToolConnectionDescriptorShape,
  assertToolConnectionSummaryShape,
  isUuid,
} from '@ontology/contracts'
import type {
  ResourceRef,
  ScopeRef,
  SecretValue,
  ToolAssignmentStore,
  ToolConnectionAdminView,
  ToolConnectionCapability,
  ToolConnectionDescriptor,
  ToolConnectionProbePort,
  ToolConnectionProbeResult,
  ToolConnectionStore,
  ToolConnectionSummary,
  ToolContext,
  ToolCredentialCustodian,
  Uuid,
} from '@ontology/contracts'
import { assertToolAdministrator, requireIdempotencyKey, scopeOf } from './guards'
import { capabilitiesSupportedByAdapter } from './tool-adapter-capabilities'

/**
 * Write a credential by value, never by echo. The value is handed to the custodian once; only
 * the resulting opaque reference ever reaches the metadata store (design §9, §5.3).
 */
export type ToolCredentialWrite =
  | { readonly action: 'set'; readonly secret: SecretValue }
  | { readonly action: 'clear' }

export interface ToolConnectionCreateInput {
  readonly descriptor: ToolConnectionDescriptor
  readonly idempotencyKey: string
  readonly credential?: SecretValue
  readonly connectionId?: Uuid
}

export interface ToolConnectionUpdateInput {
  readonly connectionId: Uuid
  readonly descriptor: ToolConnectionDescriptor
  readonly expectedRevision: string
  readonly idempotencyKey: string
  readonly credential?: SecretValue
  readonly clearCredential?: boolean
}

export interface ToolConnectionCopyInput {
  readonly sourceConnectionId: Uuid
  readonly name: string
  readonly idempotencyKey: string
}

export interface ToolConnectionServiceDependencies {
  readonly connections: ToolConnectionStore
  readonly credentials: ToolCredentialCustodian
  readonly assignments: ToolAssignmentStore
  /** Optional: a deployment without a probe still lists/edits connections; testing fails closed. */
  readonly probe?: ToolConnectionProbePort
  readonly now?: () => string
  readonly newId?: () => string
}

/** The non-secret descriptor of a stored connection, rebuilt for a probe. */
export function toolDescriptorOf(view: ToolConnectionAdminView): ToolConnectionDescriptor {
  return {
    name: view.name,
    adapterType: view.adapterType,
    capabilities: view.capabilities,
    enabled: view.enabled,
    ...(view.endpoint === undefined ? {} : { endpoint: view.endpoint }),
  }
}

/**
 * Tool-connection catalogue service (design §9).
 *
 * It owns create/edit/copy/delete, the reference check that protects a connection still named by an
 * assignment, CAS on every edit and the credential write path. It never puts an API key into a
 * domain entity, a summary, a probe result or a log: the value only ever crosses the
 * `ToolCredentialCustodian` port. A capability an adapter cannot serve is refused, so a search
 * service can never be declared as a data tool.
 */
export class ToolConnectionService {
  readonly #connections: ToolConnectionStore
  readonly #credentials: ToolCredentialCustodian
  readonly #assignments: ToolAssignmentStore
  readonly #probe: ToolConnectionProbePort | undefined
  readonly #newId: () => string

  constructor(dependencies: ToolConnectionServiceDependencies) {
    this.#connections = dependencies.connections
    this.#credentials = dependencies.credentials
    this.#assignments = dependencies.assignments
    this.#probe = dependencies.probe
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async list(
    filter: { readonly enabled?: boolean; readonly capability?: ToolConnectionCapability; readonly limit?: number },
    ctx: ToolContext,
  ): Promise<readonly ToolConnectionAdminView[]> {
    assertToolAdministrator(ctx)
    const scope = scopeOf(ctx)
    const connections = await this.#connections.listConnections(scope, filter, ctx)
    return connections.map((view) => this.#present(view))
  }

  async get(connectionId: Uuid, ctx: ToolContext): Promise<ToolConnectionAdminView | undefined> {
    assertToolAdministrator(ctx)
    if (!isUuid(connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    const view = await this.#connections.getConnection(scopeOf(ctx), connectionId, ctx)
    return view === undefined ? undefined : this.#present(view)
  }

  async create(input: ToolConnectionCreateInput, ctx: ToolContext): Promise<ToolConnectionAdminView> {
    assertToolAdministrator(ctx)
    const scope = scopeOf(ctx)
    assertToolConnectionDescriptorShape(input.descriptor)
    this.#assertAdapterCapabilities(input.descriptor)
    requireIdempotencyKey(input.idempotencyKey)
    const connectionId = input.connectionId ?? this.#newId()
    if (!isUuid(connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')

    // Credential first: it is staged under the pre-minted connection id, so a metadata failure
    // leaves nothing current and a credential failure leaves a metadata row with no key.
    const staged = input.credential === undefined
      ? undefined
      : await this.#credentials.stage(scope, { connectionId, secret: input.credential }, ctx)
    let view: ToolConnectionAdminView
    try {
      view = await this.#connections.putConnection(scope, {
        connectionId,
        descriptor: input.descriptor,
        idempotencyKey: input.idempotencyKey,
      }, ctx)
      if (staged !== undefined) {
        await this.#connections.setCredential(scope, {
          connectionId,
          change: { action: 'set', credentialRef: staged },
        }, ctx)
        await this.#credentials.activate(scope, staged, ctx)
      }
    } catch (error) {
      if (staged !== undefined) {
        await this.#connections.setCredential(scope, { connectionId, change: { action: 'clear' } }, ctx).catch(() => undefined)
        await this.#credentials.discard(scope, staged, ctx).catch(() => undefined)
      }
      throw error
    }
    return this.#present(await this.#connections.getConnection(scope, connectionId, ctx) ?? view)
  }

  async update(input: ToolConnectionUpdateInput, ctx: ToolContext): Promise<ToolConnectionAdminView> {
    assertToolAdministrator(ctx)
    const scope = scopeOf(ctx)
    assertToolConnectionDescriptorShape(input.descriptor)
    this.#assertAdapterCapabilities(input.descriptor)
    requireIdempotencyKey(input.idempotencyKey)
    if (!isUuid(input.connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    const current = await this.#connections.getConnection(scope, input.connectionId, ctx)
    if (current === undefined) throw new ToolConnectionError('NOT_FOUND', `connection ${input.connectionId} is not visible in this scope`)

    const writesCredential = input.credential !== undefined
    const clearsCredential = input.clearCredential === true
    if (writesCredential && clearsCredential) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'a connection edit cannot set and clear the credential together')
    }
    // Changing the service address must re-enter the key: an old key must never be sent to a new host.
    if (
      !writesCredential && !clearsCredential && current.credentialState !== 'missing' &&
      current.endpoint !== input.descriptor.endpoint
    ) {
      throw new ToolConnectionError(
        'INVALID_ARGUMENT',
        'changing the service address requires re-entering the API key so the old key is not sent to the new host',
      )
    }

    const staged = input.credential === undefined
      ? undefined
      : await this.#credentials.stage(scope, { connectionId: input.connectionId, secret: input.credential }, ctx)
    let view: ToolConnectionAdminView
    try {
      view = await this.#connections.putConnection(scope, {
        connectionId: input.connectionId,
        descriptor: input.descriptor,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
      }, ctx)
      if (staged !== undefined) {
        await this.#connections.setCredential(scope, {
          connectionId: input.connectionId,
          change: { action: 'set', credentialRef: staged },
        }, ctx)
        await this.#credentials.activate(scope, staged, ctx)
      } else if (clearsCredential) {
        await this.#clearCredential(scope, input.connectionId, ctx)
      }
    } catch (error) {
      if (staged !== undefined) {
        await this.#connections.setCredential(scope, { connectionId: input.connectionId, change: { action: 'clear' } }, ctx).catch(() => undefined)
        await this.#credentials.discard(scope, staged, ctx).catch(() => undefined)
      }
      throw error
    }
    return this.#present(await this.#connections.getConnection(scope, input.connectionId, ctx) ?? view)
  }

  /** Copy non-sensitive fields only: a new id, disabled, no credential and no assignment. */
  async copy(input: ToolConnectionCopyInput, ctx: ToolContext): Promise<ToolConnectionAdminView> {
    assertToolAdministrator(ctx)
    const scope = scopeOf(ctx)
    requireIdempotencyKey(input.idempotencyKey)
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'a copied connection requires a non-empty name')
    }
    const source = await this.#connections.getConnection(scope, input.sourceConnectionId, ctx)
    if (source === undefined) throw new ToolConnectionError('NOT_FOUND', 'the source connection is not visible in this scope')
    const copy = toolDescriptorOf(source)
    return this.create({
      descriptor: { ...copy, name: input.name.trim(), enabled: false },
      idempotencyKey: input.idempotencyKey,
    }, ctx)
  }

  async remove(connectionId: Uuid, ctx: ToolContext): Promise<void> {
    assertToolAdministrator(ctx)
    const scope = scopeOf(ctx)
    if (!isUuid(connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    await this.#assertUnreferenced(scope, connectionId, ctx)
    await this.#credentials.revoke(scope, connectionId, ctx)
    await this.#connections.deleteConnection(scope, connectionId, ctx)
  }

  async setCredential(
    input: { readonly connectionId: Uuid } & ToolCredentialWrite,
    ctx: ToolContext,
  ): Promise<ToolConnectionSummary> {
    assertToolAdministrator(ctx)
    const scope = scopeOf(ctx)
    if (!isUuid(input.connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    const current = await this.#connections.getConnection(scope, input.connectionId, ctx)
    if (current === undefined) throw new ToolConnectionError('NOT_FOUND', 'the connection is not visible in this scope')
    if (input.action === 'clear') return this.#clearCredential(scope, input.connectionId, ctx)
    const ref = await this.#credentials.stage(scope, { connectionId: input.connectionId, secret: input.secret }, ctx)
    try {
      const summary = await this.#connections.setCredential(scope, {
        connectionId: input.connectionId,
        change: { action: 'set', credentialRef: ref },
      }, ctx)
      await this.#credentials.activate(scope, ref, ctx)
      return summary
    } catch (error) {
      await this.#connections.setCredential(scope, { connectionId: input.connectionId, change: { action: 'clear' } }, ctx).catch(() => undefined)
      await this.#credentials.discard(scope, ref, ctx).catch(() => undefined)
      throw error
    }
  }

  async testStored(connectionId: Uuid, ctx: ToolContext, signal?: AbortSignal): Promise<ToolConnectionProbeResult> {
    assertToolAdministrator(ctx)
    const probe = this.#requireProbe()
    const scope = scopeOf(ctx)
    if (!isUuid(connectionId)) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    const view = await this.#connections.getConnection(scope, connectionId, ctx)
    if (view === undefined) throw new ToolConnectionError('NOT_FOUND', 'the connection is not visible in this scope')
    const credentialRef = await this.#connections.getCredentialRef(scope, connectionId, ctx)
    const result = await probe.probe(scope, {
      draft: toolDescriptorOf(view),
      ...(credentialRef === undefined ? {} : { credentialRef }),
      ...(signal === undefined ? {} : { signal }),
    }, ctx)
    const recorded: ToolConnectionProbeResult = { ...result, connectionId, connectionRevision: view.revision }
    await this.#connections.recordProbe(scope, recorded, ctx)
    return recorded
  }

  /** Test an unsaved draft. The draft credential is staged, used, then discarded. */
  async testDraft(
    input: { readonly descriptor: ToolConnectionDescriptor; readonly credential?: SecretValue; readonly signal?: AbortSignal },
    ctx: ToolContext,
  ): Promise<ToolConnectionProbeResult> {
    assertToolAdministrator(ctx)
    const probe = this.#requireProbe()
    const scope = scopeOf(ctx)
    assertToolConnectionDescriptorShape(input.descriptor)
    this.#assertAdapterCapabilities(input.descriptor)
    const throwaway = this.#newId()
    const ref: ResourceRef | undefined = input.credential === undefined
      ? undefined
      : await this.#credentials.stage(scope, { connectionId: throwaway, secret: input.credential }, ctx)
    try {
      return await probe.probe(scope, {
        draft: input.descriptor,
        ...(ref === undefined ? {} : { credentialRef: ref }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, ctx)
    } finally {
      if (ref !== undefined) await this.#credentials.discard(scope, ref, ctx).catch(() => undefined)
    }
  }

  #requireProbe(): ToolConnectionProbePort {
    if (this.#probe === undefined) {
      throw new ToolConnectionError('STORE_FAILED', 'tool connection testing is not configured on this deployment')
    }
    return this.#probe
  }

  /** Refuse a declared capability the adapter family cannot serve (e.g. a search service as data_query). */
  #assertAdapterCapabilities(descriptor: ToolConnectionDescriptor): void {
    const supported = capabilitiesSupportedByAdapter(descriptor.adapterType)
    for (const capability of descriptor.capabilities) {
      if (!supported.includes(capability)) {
        throw new ToolConnectionError(
          'TOOL_CAPABILITY_MISMATCH',
          `the ${descriptor.adapterType} adapter cannot serve the ${capability} capability`,
        )
      }
    }
  }

  async #clearCredential(scope: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ToolConnectionSummary> {
    const summary = await this.#connections.setCredential(scope, { connectionId, change: { action: 'clear' } }, ctx)
    await this.#credentials.revoke(scope, connectionId, ctx)
    return summary
  }

  async #assertUnreferenced(scope: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void> {
    const sets = await this.#assignments.listAssignmentSets(scope, ctx)
    for (const set of sets) {
      const referenced = set.defaultSelection.kind === 'connection' && set.defaultSelection.connectionId === connectionId
        || set.toolSelections.some((entry) => entry.selection.kind === 'connection' && entry.selection.connectionId === connectionId)
      if (referenced) {
        throw new ToolConnectionError(
          'TOOL_IN_USE',
          'the connection is still named by an assignment; clear the assignment before deleting it',
        )
      }
    }
  }

  /** Drop a probe summary that belongs to an older revision so a stale "passed" is never shown. */
  #present(view: ToolConnectionAdminView): ToolConnectionAdminView {
    const probe = view.probeSummary
    if (probe === undefined || probe.connectionRevision === view.revision) {
      assertToolConnectionSummaryShape(view)
      return view
    }
    const { probeSummary, ...without } = view
    void probeSummary
    assertToolConnectionSummaryShape(without)
    return without
  }
}
