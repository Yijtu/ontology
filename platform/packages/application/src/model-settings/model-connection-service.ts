import {
  ModelSelectionError,
  assertModelConnectionDescriptorShape,
  isUuid,
} from '@ontology/contracts'
import type {
  ModelAssignmentStore,
  ModelCapability,
  ModelConnectionAdminView,
  ModelConnectionDescriptor,
  ModelConnectionProbePort,
  ModelConnectionStore,
  ModelConnectionSummary,
  ModelConnectionTestResult,
  ModelCredentialCustodian,
  ScopeRef,
  SecretValue,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { assertModelAdministrator, requireIdempotencyKey, scopeOf } from './guards'

/**
 * Write a credential by value, never by echo. The value is handed to the custodian once; only
 * the resulting opaque reference ever reaches the metadata store (design §5.3).
 */
export type ModelCredentialWrite =
  | { readonly action: 'set'; readonly secret: SecretValue }
  | { readonly action: 'clear' }

export interface ModelConnectionCreateInput {
  readonly descriptor: ModelConnectionDescriptor
  readonly idempotencyKey: string
  readonly credential?: SecretValue
  readonly connectionId?: Uuid
}

export interface ModelConnectionUpdateInput {
  readonly connectionId: Uuid
  readonly descriptor: ModelConnectionDescriptor
  readonly expectedRevision: string
  readonly idempotencyKey: string
  readonly credential?: SecretValue
  readonly clearCredential?: boolean
}

export interface ModelConnectionCopyInput {
  readonly sourceConnectionId: Uuid
  readonly name: string
  readonly idempotencyKey: string
}

export interface ModelConnectionServiceDependencies {
  readonly connections: ModelConnectionStore
  readonly credentials: ModelCredentialCustodian
  readonly assignments: ModelAssignmentStore
  readonly probe?: ModelConnectionProbePort
  readonly now?: () => string
  readonly newId?: () => string
}

/** The non-secret descriptor of a stored connection, rebuilt for a probe. */
export function descriptorOf(view: ModelConnectionAdminView): ModelConnectionDescriptor {
  return {
    name: view.name,
    adapterType: view.adapterType,
    protocol: view.protocol,
    capabilities: view.capabilities,
    enabled: view.enabled,
    platformModelId: view.platformModelId,
    providerModelName: view.providerModelName,
    ...(view.baseUrl === undefined ? {} : { baseUrl: view.baseUrl }),
    ...(view.endpoint === undefined ? {} : { endpoint: view.endpoint }),
  }
}

/**
 * Model-connection catalogue service (design §5.3, A-R09).
 *
 * It owns create/edit/copy/delete, the reference check that protects a connection still named
 * by an assignment, CAS on every edit and the credential write path. It never puts an API key
 * into a domain entity, a summary, a test result or a log: the value only ever crosses the
 * `ModelCredentialCustodian` port.
 */
export class ModelConnectionService {
  readonly #connections: ModelConnectionStore
  readonly #credentials: ModelCredentialCustodian
  readonly #assignments: ModelAssignmentStore
  readonly #probe: ModelConnectionProbePort | undefined
  readonly #newId: () => string

  constructor(dependencies: ModelConnectionServiceDependencies) {
    this.#connections = dependencies.connections
    this.#credentials = dependencies.credentials
    this.#assignments = dependencies.assignments
    this.#probe = dependencies.probe
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async list(
    filter: { readonly enabled?: boolean; readonly capability?: ModelCapability; readonly limit?: number },
    ctx: ToolContext,
  ): Promise<readonly ModelConnectionAdminView[]> {
    assertModelAdministrator(ctx)
    const scope = scopeOf(ctx)
    const connections = await this.#connections.listConnections(scope, filter, ctx)
    return connections.map((view) => this.#present(view))
  }

  async get(connectionId: Uuid, ctx: ToolContext): Promise<ModelConnectionAdminView | undefined> {
    assertModelAdministrator(ctx)
    if (!isUuid(connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    const view = await this.#connections.getConnection(scopeOf(ctx), connectionId, ctx)
    return view === undefined ? undefined : this.#present(view)
  }

  async create(input: ModelConnectionCreateInput, ctx: ToolContext): Promise<ModelConnectionAdminView> {
    assertModelAdministrator(ctx)
    const scope = scopeOf(ctx)
    assertModelConnectionDescriptorShape(input.descriptor)
    requireIdempotencyKey(input.idempotencyKey)
    const connectionId = input.connectionId ?? this.#newId()
    if (!isUuid(connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')

    // Credential first: it is staged under the pre-minted connection id, so a metadata failure
    // leaves nothing current and a credential failure leaves a metadata row with no key.
    const staged = input.credential === undefined
      ? undefined
      : await this.#credentials.stage(scope, { connectionId, secret: input.credential }, ctx)
    let view: ModelConnectionAdminView
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

  async update(input: ModelConnectionUpdateInput, ctx: ToolContext): Promise<ModelConnectionAdminView> {
    assertModelAdministrator(ctx)
    const scope = scopeOf(ctx)
    assertModelConnectionDescriptorShape(input.descriptor)
    requireIdempotencyKey(input.idempotencyKey)
    if (!isUuid(input.connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    const current = await this.#connections.getConnection(scope, input.connectionId, ctx)
    if (current === undefined) throw new ModelSelectionError('NOT_FOUND', `connection ${input.connectionId} is not visible in this scope`)

    const writesCredential = input.credential !== undefined
    const clearsCredential = input.clearCredential === true
    if (writesCredential && clearsCredential) {
      throw new ModelSelectionError('INVALID_ARGUMENT', 'a connection edit cannot set and clear the credential together')
    }
    // Changing the service address must re-enter the key: an old key must never be sent to a new host.
    if (
      !writesCredential && !clearsCredential && current.credentialState !== 'missing' &&
      current.baseUrl !== input.descriptor.baseUrl
    ) {
      throw new ModelSelectionError(
        'INVALID_ARGUMENT',
        'changing the service address requires re-entering the API key so the old key is not sent to the new host',
      )
    }

    const staged = input.credential === undefined
      ? undefined
      : await this.#credentials.stage(scope, { connectionId: input.connectionId, secret: input.credential }, ctx)
    let view: ModelConnectionAdminView
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
  async copy(input: ModelConnectionCopyInput, ctx: ToolContext): Promise<ModelConnectionAdminView> {
    assertModelAdministrator(ctx)
    const scope = scopeOf(ctx)
    requireIdempotencyKey(input.idempotencyKey)
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new ModelSelectionError('INVALID_ARGUMENT', 'a copied connection requires a non-empty name')
    }
    const source = await this.#connections.getConnection(scope, input.sourceConnectionId, ctx)
    if (source === undefined) throw new ModelSelectionError('NOT_FOUND', 'the source connection is not visible in this scope')
    const copy = descriptorOf(source)
    return this.create({
      descriptor: { ...copy, name: input.name.trim(), enabled: false },
      idempotencyKey: input.idempotencyKey,
    }, ctx)
  }

  async remove(connectionId: Uuid, ctx: ToolContext): Promise<void> {
    assertModelAdministrator(ctx)
    const scope = scopeOf(ctx)
    if (!isUuid(connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    await this.#assertUnreferenced(scope, connectionId, ctx)
    await this.#credentials.revoke(scope, connectionId, ctx)
    await this.#connections.deleteConnection(scope, connectionId, ctx)
  }

  async setCredential(
    input: { readonly connectionId: Uuid } & ModelCredentialWrite,
    ctx: ToolContext,
  ): Promise<ModelConnectionSummary> {
    assertModelAdministrator(ctx)
    const scope = scopeOf(ctx)
    if (!isUuid(input.connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    const current = await this.#connections.getConnection(scope, input.connectionId, ctx)
    if (current === undefined) throw new ModelSelectionError('NOT_FOUND', 'the connection is not visible in this scope')
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

  async testStored(connectionId: Uuid, ctx: ToolContext, signal?: AbortSignal): Promise<ModelConnectionTestResult> {
    assertModelAdministrator(ctx)
    const probe = this.#requireProbe()
    const scope = scopeOf(ctx)
    if (!isUuid(connectionId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId must be a UUID')
    const view = await this.#connections.getConnection(scope, connectionId, ctx)
    if (view === undefined) throw new ModelSelectionError('NOT_FOUND', 'the connection is not visible in this scope')
    const credentialRef = await this.#connections.getCredentialRef(scope, connectionId, ctx)
    const result = await probe.probe(scope, {
      draft: descriptorOf(view),
      ...(credentialRef === undefined ? {} : { credentialRef }),
      ...(signal === undefined ? {} : { signal }),
    }, ctx)
    await this.#connections.recordTest(scope, {
      connectionId,
      revision: view.revision,
      status: result.status,
      testedAt: result.testedAt,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
      ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
    }, ctx)
    return result
  }

  /** Test an unsaved draft. The draft credential is staged, used, then discarded. */
  async testDraft(
    input: { readonly descriptor: ModelConnectionDescriptor; readonly credential?: SecretValue; readonly signal?: AbortSignal },
    ctx: ToolContext,
  ): Promise<ModelConnectionTestResult> {
    assertModelAdministrator(ctx)
    const probe = this.#requireProbe()
    const scope = scopeOf(ctx)
    assertModelConnectionDescriptorShape(input.descriptor)
    const throwaway = this.#newId()
    const ref = input.credential === undefined
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

  #requireProbe(): ModelConnectionProbePort {
    if (this.#probe === undefined) {
      throw new ModelSelectionError('STORE_FAILED', 'connection testing is not configured on this deployment')
    }
    return this.#probe
  }

  async #clearCredential(scope: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ModelConnectionSummary> {
    const summary = await this.#connections.setCredential(scope, { connectionId, change: { action: 'clear' } }, ctx)
    await this.#credentials.revoke(scope, connectionId, ctx)
    return summary
  }

  async #assertUnreferenced(scope: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void> {
    const sets = await this.#assignments.listAssignmentSets(scope, ctx)
    for (const set of sets) {
      const referenced = set.defaultSelection.kind === 'connection' && set.defaultSelection.connectionId === connectionId
        || set.capabilitySelections.some((entry) => entry.selection.kind === 'connection' && entry.selection.connectionId === connectionId)
      if (referenced) {
        throw new ModelSelectionError(
          'MODEL_IN_USE',
          'the connection is still named by an assignment; clear the assignment before deleting it',
        )
      }
    }
  }

  /** Drop a test summary that belongs to an older revision so a stale "passed" is never shown. */
  #present(view: ModelConnectionAdminView): ModelConnectionAdminView {
    const test = view.testSummary
    if (test !== undefined && test.revision === view.revision) return view
    const { testSummary, ...without } = view
    void testSummary
    return without
  }
}
