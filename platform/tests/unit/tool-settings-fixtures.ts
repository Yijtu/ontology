import { ToolConnectionError, SecretValue } from '@ontology/contracts'
import type {
  ExecutionToolBinding,
  ExecutionToolBindingStore,
  ResourceRef,
  ScopeRef,
  ToolAssignmentSet,
  ToolAssignmentStore,
  ToolConnectionAdminView,
  ToolConnectionCapability,
  ToolConnectionCredentialChange,
  ToolConnectionDescriptor,
  ToolConnectionProbeItem,
  ToolConnectionProbePort,
  ToolConnectionProbeResult,
  ToolConnectionSelectionEntry,
  ToolConnectionStore,
  ToolConnectionSummary,
  ToolCredentialCustodian,
  ToolContext,
  ToolTargetScope,
  Uuid,
} from '@ontology/contracts'

export { TEST_SCOPE, adminContext, editorContext, context } from './model-settings-fixtures'
export { RecordingTargetDirectory } from './model-settings-fixtures'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}:${scopeRef.spaceId}`
}

export function toolScopeIdOf(scope: ToolTargetScope): string {
  switch (scope.kind) {
    case 'space':
      return 'space'
    case 'industry_workspace':
      return `industry_workspace:${scope.workspaceId}`
    case 'project':
      return `project:${scope.projectId}`
  }
}

interface ConnectionRow {
  view: ToolConnectionAdminView
  descriptor: ToolConnectionDescriptor
  credentialRef?: ResourceRef
}

/** A faithful in-memory `ToolConnectionStore` (metadata only; credentials are refs). */
export class InMemoryToolConnectionStore implements ToolConnectionStore {
  readonly rows = new Map<string, ConnectionRow>()
  readonly idempotency = new Map<string, { connectionId: string; descriptor: ToolConnectionDescriptor }>()
  readonly probes: ToolConnectionProbeResult[] = []

  #key(scopeRef: ScopeRef, id: string): string {
    return `${scopeKey(scopeRef)}:${id}`
  }

  async listConnections(scopeRef: ScopeRef, filter: { enabled?: boolean; capability?: ToolConnectionCapability; limit?: number }): Promise<ToolConnectionAdminView[]> {
    const prefix = `${scopeKey(scopeRef)}:`
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => row.view)
      .filter((view) => filter.enabled === undefined || view.enabled === filter.enabled)
      .filter((view) => filter.capability === undefined || view.capabilities.includes(filter.capability))
      .slice(0, filter.limit ?? 100)
  }

  async getConnection(scopeRef: ScopeRef, connectionId: Uuid): Promise<ToolConnectionAdminView | undefined> {
    return this.rows.get(this.#key(scopeRef, connectionId))?.view
  }

  async putConnection(scopeRef: ScopeRef, input: { connectionId?: Uuid; descriptor: ToolConnectionDescriptor; expectedRevision?: string; idempotencyKey: string }): Promise<ToolConnectionAdminView> {
    if (input.connectionId === undefined) throw new ToolConnectionError('INVALID_ARGUMENT', 'connectionId required')
    const idemKey = `${scopeKey(scopeRef)}:${input.idempotencyKey}`
    const idem = this.idempotency.get(idemKey)
    if (idem !== undefined) {
      if (JSON.stringify(idem.descriptor) !== JSON.stringify(input.descriptor)) {
        throw new ToolConnectionError('IDEMPOTENCY_CONFLICT', 'different payload')
      }
      const replay = this.rows.get(this.#key(scopeRef, idem.connectionId))
      if (replay === undefined) throw new ToolConnectionError('STORE_FAILED', 'replay row missing')
      return replay.view
    }
    const key = this.#key(scopeRef, input.connectionId)
    const existing = this.rows.get(key)
    const revision = existing === undefined ? '1' : String(BigInt(existing.view.revision) + 1n)
    if (existing !== undefined && (input.expectedRevision === undefined || input.expectedRevision !== existing.view.revision)) {
      throw new ToolConnectionError('VERSION_CONFLICT', 'moved')
    }
    if (existing === undefined && input.expectedRevision !== undefined) {
      throw new ToolConnectionError('VERSION_CONFLICT', 'no row')
    }
    const view: ToolConnectionAdminView = {
      connectionId: input.connectionId,
      name: input.descriptor.name,
      revision,
      adapterType: input.descriptor.adapterType,
      capabilities: [...input.descriptor.capabilities],
      enabled: input.descriptor.enabled,
      credentialState: existing?.view.credentialState ?? 'missing',
      ...(input.descriptor.endpoint === undefined ? {} : { endpoint: input.descriptor.endpoint }),
      updatedAt: new Date().toISOString(),
    }
    this.rows.set(key, { view, descriptor: input.descriptor, ...(existing?.credentialRef === undefined ? {} : { credentialRef: existing.credentialRef }) })
    this.idempotency.set(idemKey, { connectionId: input.connectionId, descriptor: input.descriptor })
    return view
  }

  async deleteConnection(scopeRef: ScopeRef, connectionId: Uuid): Promise<void> {
    this.rows.delete(this.#key(scopeRef, connectionId))
  }

  async setCredential(scopeRef: ScopeRef, input: { connectionId: Uuid; change: ToolConnectionCredentialChange }): Promise<ToolConnectionSummary> {
    const row = this.rows.get(this.#key(scopeRef, input.connectionId))
    if (row === undefined) throw new ToolConnectionError('NOT_FOUND', 'missing')
    const view: ToolConnectionAdminView = {
      ...row.view,
      revision: String(BigInt(row.view.revision) + 1n),
      credentialState: input.change.action === 'set' ? 'present' : 'missing',
      updatedAt: new Date().toISOString(),
    }
    const { probeSummary, ...withoutProbe } = view
    void probeSummary
    const next: ConnectionRow = {
      view: withoutProbe,
      descriptor: row.descriptor,
      ...(input.change.action === 'set' ? { credentialRef: input.change.credentialRef } : {}),
    }
    this.rows.set(this.#key(scopeRef, input.connectionId), next)
    return summaryOf(withoutProbe)
  }

  async getCredentialRef(scopeRef: ScopeRef, connectionId: Uuid): Promise<ResourceRef | undefined> {
    return this.rows.get(this.#key(scopeRef, connectionId))?.credentialRef
  }

  async recordProbe(scopeRef: ScopeRef, result: ToolConnectionProbeResult): Promise<ToolConnectionSummary> {
    if (result.connectionId === undefined) throw new ToolConnectionError('INVALID_ARGUMENT', 'a probe must name its connection')
    const key = this.#key(scopeRef, result.connectionId)
    const row = this.rows.get(key)
    if (row === undefined) throw new ToolConnectionError('NOT_FOUND', 'missing')
    if (result.connectionRevision !== undefined && result.connectionRevision !== row.view.revision) {
      throw new ToolConnectionError('VERSION_CONFLICT', 'the connection revision changed before the probe was recorded')
    }
    this.probes.push(result)
    const view: ToolConnectionAdminView = { ...row.view, probeSummary: result }
    this.rows.set(key, { ...row, view })
    return summaryOf(view)
  }
}

export function summaryOf(view: ToolConnectionAdminView): ToolConnectionSummary {
  return {
    connectionId: view.connectionId,
    name: view.name,
    revision: view.revision,
    adapterType: view.adapterType,
    capabilities: view.capabilities,
    enabled: view.enabled,
    credentialState: view.credentialState,
    ...(view.probeSummary === undefined ? {} : { probeSummary: view.probeSummary }),
    updatedAt: view.updatedAt,
  }
}

/** In-memory assignment store with CAS and one set per scope. */
export class InMemoryToolAssignmentStore implements ToolAssignmentStore {
  readonly rows = new Map<string, ToolAssignmentSet>()

  #key(scopeRef: ScopeRef, scope: ToolTargetScope): string {
    return `${scopeKey(scopeRef)}:${toolScopeIdOf(scope)}`
  }

  async getAssignmentSet(scopeRef: ScopeRef, scope: ToolTargetScope): Promise<ToolAssignmentSet | undefined> {
    return this.rows.get(this.#key(scopeRef, scope))
  }

  async listAssignmentSets(scopeRef: ScopeRef): Promise<ToolAssignmentSet[]> {
    const prefix = `${scopeKey(scopeRef)}:`
    return [...this.rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row)
  }

  async putAssignmentSet(scopeRef: ScopeRef, input: { set: ToolAssignmentSet; expectedRevision?: string }): Promise<ToolAssignmentSet> {
    const key = this.#key(scopeRef, input.set.scope)
    const current = this.rows.get(key)
    if (current !== undefined) {
      if (input.expectedRevision === undefined || input.expectedRevision !== current.revision) {
        throw new ToolConnectionError('VERSION_CONFLICT', 'assignment moved')
      }
      const next: ToolAssignmentSet = { ...input.set, revision: String(BigInt(current.revision) + 1n) }
      this.rows.set(key, next)
      return next
    }
    if (input.expectedRevision !== undefined) throw new ToolConnectionError('VERSION_CONFLICT', 'no set')
    const next: ToolAssignmentSet = { ...input.set, revision: '1' }
    this.rows.set(key, next)
    return next
  }
}

/** In-memory execution binding store: write-once per (execution, toolId). */
export class InMemoryExecutionToolBindingStore implements ExecutionToolBindingStore {
  readonly rows = new Map<string, ExecutionToolBinding>()

  async putBinding(_scopeRef: ScopeRef, binding: ExecutionToolBinding): Promise<ExecutionToolBinding> {
    const key = `${binding.executionId}:${binding.toolId}`
    const existing = this.rows.get(key)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(binding)) {
        throw new ToolConnectionError('TOOL_BINDING_REVOKED', 'different binding')
      }
      return existing
    }
    this.rows.set(key, binding)
    return binding
  }

  async getBinding(_scopeRef: ScopeRef, executionId: Uuid, toolId: ToolConnectionCapability): Promise<ExecutionToolBinding | undefined> {
    return this.rows.get(`${executionId}:${toolId}`)
  }
}

/** In-memory tool credential custodian; a `resolve` never happens unless a value was staged. */
export class InMemoryToolCredentialCustodian implements ToolCredentialCustodian {
  readonly values = new Map<string, SecretValue>()
  readonly staged = new Set<string>()
  readonly active = new Set<string>()
  readonly byConnection = new Map<string, string[]>()

  async stage(_scopeRef: ScopeRef, input: { connectionId: Uuid; secret: SecretValue }): Promise<ResourceRef> {
    const id = `00000000-0000-4000-8000-${String(this.values.size).padStart(12, '0')}`
    this.values.set(id, input.secret)
    this.staged.add(id)
    const refs = this.byConnection.get(input.connectionId) ?? []
    refs.push(id)
    this.byConnection.set(input.connectionId, refs)
    return { id, version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' }
  }

  async activate(_scopeRef: ScopeRef, ref: ResourceRef): Promise<void> {
    this.staged.delete(ref.id)
    this.active.add(ref.id)
  }

  async discard(_scopeRef: ScopeRef, ref: ResourceRef): Promise<void> {
    this.staged.delete(ref.id)
    this.values.delete(ref.id)
  }

  async revoke(_scopeRef: ScopeRef, connectionId: Uuid): Promise<void> {
    for (const id of this.byConnection.get(connectionId) ?? []) {
      this.values.delete(id)
      this.active.delete(id)
      this.staged.delete(id)
    }
    this.byConnection.delete(connectionId)
  }

  async resolve(_scopeRef: ScopeRef, ref: ResourceRef): Promise<SecretValue> {
    const value = this.values.get(ref.id)
    if (value === undefined) throw new ToolConnectionError('CREDENTIAL_MISSING', 'not staged')
    return value
  }
}

/** A probe that resolves its credential through the custodian and reports a fixed two-item outcome. */
export class RecordingToolProbe implements ToolConnectionProbePort {
  calls: { credentialRef?: ResourceRef; draft: ToolConnectionDescriptor }[] = []
  search: ToolConnectionProbeItem = { status: 'passed', latencyMs: 4 }
  archive: ToolConnectionProbeItem = { status: 'passed', latencyMs: 9 }

  constructor(private readonly credentials: ToolCredentialCustodian, private readonly now: () => string = () => '2026-10-16T00:00:00Z') {}

  async probe(_scopeRef: ScopeRef, request: { draft: ToolConnectionDescriptor; credentialRef?: ResourceRef; signal?: AbortSignal }, ctx: ToolContext): Promise<ToolConnectionProbeResult> {
    this.calls.push({ ...(request.credentialRef === undefined ? {} : { credentialRef: request.credentialRef }), draft: request.draft })
    let credentialConfigured = false
    if (request.credentialRef !== undefined) {
      await this.credentials.resolve(_scopeRef, request.credentialRef, ctx)
      credentialConfigured = true
    }
    return {
      schemaVersion: 'tool-connection-test-result@1',
      testedAt: this.now(),
      draft: false,
      credentialConfigured,
      search: this.search,
      archive: this.archive,
    }
  }
}

export type { ToolConnectionSelectionEntry }
