import {
  CONTRACT_VERSION,
  ModelSelectionError,
  SecretValue,
  createToolContext,
} from '@ontology/contracts'
import type {
  ExecutionModelBinding,
  ExecutionModelBindingStore,
  ModelAssignmentSet,
  ModelAssignmentStore,
  ModelCapability,
  ModelConnectionAdminView,
  ModelConnectionCredentialChange,
  ModelConnectionDescriptor,
  ModelConnectionProbePort,
  ModelConnectionStore,
  ModelConnectionSummary,
  ModelConnectionTestRecord,
  ModelConnectionTestResult,
  ModelCredentialCustodian,
  ModelTargetDirectory,
  ModelTargetScope,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

export const TEST_SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

export function adminContext(scope: ScopeRef = TEST_SCOPE): ToolContext {
  return context(scope, ['platform-admin'], 'admin')
}

export function editorContext(scope: ScopeRef = TEST_SCOPE): ToolContext {
  return context(scope, ['profile-editor'], 'editor')
}

export function context(scope: ScopeRef, roles: readonly string[], subjectId: string): ToolContext {
  const grantedAt = new Date('2026-10-15T00:00:00Z')
  const expiresAt = new Date(grantedAt.getTime() + 3_600_000)
  return createToolContext({
    principal: { tenantId: scope.tenantId, subjectId, roles: [...roles], scopes: [], authEpoch: 1 },
    runId: '00000000-0000-4000-8000-0000000000aa',
    resolvedProfileHash: `sha256:${'0'.repeat(64)}`,
    policyVersion: CONTRACT_VERSION,
    deadline: expiresAt.toISOString(),
    budgetReservation: {
      reservationId: '00000000-0000-4000-8000-0000000000bb',
      runId: '00000000-0000-4000-8000-0000000000aa',
      grantedAt: grantedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    allowedResources: {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: 'test-trace',
  })
}

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}:${scopeRef.spaceId}`
}

export function scopeIdOf(scope: ModelTargetScope): string {
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
  view: ModelConnectionAdminView
  descriptor: ModelConnectionDescriptor
  credentialRef?: ResourceRef
}

/** A faithful in-memory `ModelConnectionStore` (metadata only; credentials are refs). */
export class InMemoryModelConnectionStore implements ModelConnectionStore {
  readonly rows = new Map<string, ConnectionRow>()
  readonly idempotency = new Map<string, { connectionId: string; descriptor: ModelConnectionDescriptor }>()
  readonly tests: ModelConnectionTestRecord[] = []
  nextRevision = 1

  #key(scopeRef: ScopeRef, id: string): string {
    return `${scopeKey(scopeRef)}:${id}`
  }

  async listConnections(scopeRef: ScopeRef, filter: { enabled?: boolean; capability?: ModelCapability; limit?: number }): Promise<ModelConnectionAdminView[]> {
    const prefix = `${scopeKey(scopeRef)}:`
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, row]) => row.view)
      .filter((view) => filter.enabled === undefined || view.enabled === filter.enabled)
      .filter((view) => filter.capability === undefined || view.capabilities.includes(filter.capability))
      .slice(0, filter.limit ?? 100)
  }

  async getConnection(scopeRef: ScopeRef, connectionId: Uuid): Promise<ModelConnectionAdminView | undefined> {
    return this.rows.get(this.#key(scopeRef, connectionId))?.view
  }

  async putConnection(scopeRef: ScopeRef, input: { connectionId?: Uuid; descriptor: ModelConnectionDescriptor; expectedRevision?: string; idempotencyKey: string }): Promise<ModelConnectionAdminView> {
    if (input.connectionId === undefined) throw new ModelSelectionError('INVALID_ARGUMENT', 'connectionId required')
    const idemKey = `${scopeKey(scopeRef)}:${input.idempotencyKey}`
    const idem = this.idempotency.get(idemKey)
    if (idem !== undefined) {
      if (JSON.stringify(idem.descriptor) !== JSON.stringify(input.descriptor)) {
        throw new ModelSelectionError('IDEMPOTENCY_CONFLICT', 'different payload')
      }
      const replay = this.rows.get(this.#key(scopeRef, idem.connectionId))
      if (replay === undefined) throw new ModelSelectionError('STORE_FAILED', 'replay row missing')
      return replay.view
    }
    const key = this.#key(scopeRef, input.connectionId)
    const existing = this.rows.get(key)
    const revision = existing === undefined ? '1' : String(BigInt(existing.view.revision) + 1n)
    if (existing !== undefined && (input.expectedRevision === undefined || input.expectedRevision !== existing.view.revision)) {
      throw new ModelSelectionError('VERSION_CONFLICT', 'moved')
    }
    if (existing === undefined && input.expectedRevision !== undefined) {
      throw new ModelSelectionError('VERSION_CONFLICT', 'no row')
    }
    const view: ModelConnectionAdminView = {
      connectionId: input.connectionId,
      name: input.descriptor.name,
      revision,
      adapterType: input.descriptor.adapterType,
      protocol: input.descriptor.protocol,
      capabilities: [...input.descriptor.capabilities],
      enabled: input.descriptor.enabled,
      credentialState: existing?.view.credentialState ?? 'missing',
      ...(input.descriptor.baseUrl === undefined ? {} : { baseUrl: input.descriptor.baseUrl }),
      ...(input.descriptor.endpoint === undefined ? {} : { endpoint: input.descriptor.endpoint }),
      platformModelId: input.descriptor.platformModelId,
      providerModelName: input.descriptor.providerModelName,
      updatedAt: new Date().toISOString(),
    }
    this.rows.set(key, { view, descriptor: input.descriptor, ...(existing?.credentialRef === undefined ? {} : { credentialRef: existing.credentialRef }) })
    this.idempotency.set(idemKey, { connectionId: input.connectionId, descriptor: input.descriptor })
    return view
  }

  async deleteConnection(scopeRef: ScopeRef, connectionId: Uuid): Promise<void> {
    this.rows.delete(this.#key(scopeRef, connectionId))
  }

  async setCredential(scopeRef: ScopeRef, input: { connectionId: Uuid; change: ModelConnectionCredentialChange }): Promise<ModelConnectionSummary> {
    const row = this.rows.get(this.#key(scopeRef, input.connectionId))
    if (row === undefined) throw new ModelSelectionError('NOT_FOUND', 'missing')
    const view: ModelConnectionAdminView = {
      ...row.view,
      revision: String(BigInt(row.view.revision) + 1n),
      credentialState: input.change.action === 'set' ? 'present' : 'missing',
      updatedAt: new Date().toISOString(),
    }
    const { testSummary, ...withoutTest } = view
    void testSummary
    const next: ConnectionRow = {
      view: withoutTest,
      descriptor: row.descriptor,
      ...(input.change.action === 'set' ? { credentialRef: input.change.credentialRef } : {}),
    }
    this.rows.set(this.#key(scopeRef, input.connectionId), next)
    return summaryOf(withoutTest)
  }

  async getCredentialRef(scopeRef: ScopeRef, connectionId: Uuid): Promise<ResourceRef | undefined> {
    return this.rows.get(this.#key(scopeRef, connectionId))?.credentialRef
  }

  async recordTest(scopeRef: ScopeRef, record: ModelConnectionTestRecord): Promise<ModelConnectionSummary> {
    const row = this.rows.get(this.#key(scopeRef, record.connectionId))
    if (row === undefined) throw new ModelSelectionError('NOT_FOUND', 'missing')
    this.tests.push(record)
    const view: ModelConnectionAdminView = {
      ...row.view,
      testSummary: {
        revision: record.revision,
        status: record.status,
        testedAt: record.testedAt,
        ...(record.reason === undefined ? {} : { reason: record.reason }),
      },
    }
    this.rows.set(this.#key(scopeRef, record.connectionId), { ...row, view })
    return summaryOf(view)
  }
}

export function summaryOf(view: ModelConnectionAdminView): ModelConnectionSummary {
  return {
    connectionId: view.connectionId,
    name: view.name,
    revision: view.revision,
    adapterType: view.adapterType,
    protocol: view.protocol,
    capabilities: view.capabilities,
    enabled: view.enabled,
    credentialState: view.credentialState,
    ...(view.testSummary === undefined ? {} : { testSummary: view.testSummary }),
    updatedAt: view.updatedAt,
  }
}

/** In-memory assignment store with CAS and one set per scope. */
export class InMemoryModelAssignmentStore implements ModelAssignmentStore {
  readonly rows = new Map<string, ModelAssignmentSet>()

  #key(scopeRef: ScopeRef, scope: ModelTargetScope): string {
    return `${scopeKey(scopeRef)}:${scopeIdOf(scope)}`
  }

  async getAssignmentSet(scopeRef: ScopeRef, scope: ModelTargetScope): Promise<ModelAssignmentSet | undefined> {
    return this.rows.get(this.#key(scopeRef, scope))
  }

  async listAssignmentSets(scopeRef: ScopeRef): Promise<ModelAssignmentSet[]> {
    const prefix = `${scopeKey(scopeRef)}:`
    return [...this.rows.entries()].filter(([key]) => key.startsWith(prefix)).map(([, row]) => row)
  }

  async putAssignmentSet(scopeRef: ScopeRef, input: { set: ModelAssignmentSet; expectedRevision?: string }): Promise<ModelAssignmentSet> {
    const key = this.#key(scopeRef, input.set.scope)
    const current = this.rows.get(key)
    if (current !== undefined) {
      if (input.expectedRevision === undefined || input.expectedRevision !== current.revision) {
        throw new ModelSelectionError('VERSION_CONFLICT', 'assignment moved')
      }
      const next: ModelAssignmentSet = { ...input.set, revision: String(BigInt(current.revision) + 1n) }
      this.rows.set(key, next)
      return next
    }
    if (input.expectedRevision !== undefined) throw new ModelSelectionError('VERSION_CONFLICT', 'no set')
    const next: ModelAssignmentSet = { ...input.set, revision: '1' }
    this.rows.set(key, next)
    return next
  }
}

/** In-memory execution binding store: write-once per (execution, capability). */
export class InMemoryExecutionBindingStore implements ExecutionModelBindingStore {
  readonly rows = new Map<string, ExecutionModelBinding>()

  async putBinding(_scopeRef: ScopeRef, binding: ExecutionModelBinding): Promise<ExecutionModelBinding> {
    const key = `${binding.executionId}:${binding.capability}`
    const existing = this.rows.get(key)
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(binding)) {
        throw new ModelSelectionError('MODEL_BINDING_REVOKED', 'different binding')
      }
      return existing
    }
    this.rows.set(key, binding)
    return binding
  }

  async getBinding(_scopeRef: ScopeRef, executionId: Uuid, capability: ModelCapability): Promise<ExecutionModelBinding | undefined> {
    return this.rows.get(`${executionId}:${capability}`)
  }
}

/** In-memory credential custodian; a `resolve` never happens unless a value was staged/activated. */
export class InMemoryCredentialCustodian implements ModelCredentialCustodian {
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
    if (value === undefined) throw new ModelSelectionError('CREDENTIAL_MISSING', 'not staged')
    return value
  }
}

/** A probe that resolves its credential through the custodian and reports a fixed outcome. */
export class RecordingProbe implements ModelConnectionProbePort {
  calls: { credentialRef?: ResourceRef; draft: ModelConnectionDescriptor }[] = []
  outcome: ModelConnectionTestResult['status'] = 'passed'
  reason: ModelConnectionTestResult['reason']

  constructor(private readonly credentials: ModelCredentialCustodian, private readonly now: () => string = () => '2026-10-15T00:00:00Z') {}

  async probe(_scopeRef: ScopeRef, request: { draft: ModelConnectionDescriptor; credentialRef?: ResourceRef; signal?: AbortSignal }, ctx: ToolContext): Promise<ModelConnectionTestResult> {
    this.calls.push({ ...(request.credentialRef === undefined ? {} : { credentialRef: request.credentialRef }), draft: request.draft })
    let credentialConfigured = false
    if (request.credentialRef !== undefined) {
      await this.credentials.resolve(_scopeRef, request.credentialRef, ctx)
      credentialConfigured = true
    }
    return {
      schemaVersion: 'model-connection-test-result@1',
      status: this.outcome,
      testedAt: this.now(),
      draft: false,
      credentialConfigured,
      latencyMs: 5,
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    }
  }
}

/** Permissive target directory; tests can register foreign targets to assert rejection. */
export class RecordingTargetDirectory implements ModelTargetDirectory {
  readonly allowed = new Set<string>()
  async assertTargetInScope(_scopeRef: ScopeRef, scope: ModelTargetScope): Promise<void> {
    if (scope.kind === 'space') return
    if (!this.allowed.has(scopeIdOf(scope))) {
      throw new ModelSelectionError('SCOPE_MISMATCH', 'the target is not visible in this scope')
    }
  }
}

