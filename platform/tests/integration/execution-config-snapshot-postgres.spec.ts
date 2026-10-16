import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresExecutionConnectionSnapshotStore,
  PostgresExecutionModelBindingStore,
  PostgresExecutionToolBindingStore,
  PostgresModelAssignmentStore,
  PostgresModelConnectionStore,
  PostgresToolAssignmentStore,
  PostgresToolConnectionStore,
} from '@ontology/adapter-control-postgres'
import {
  ExecutionModelBindingService,
  ExecutionToolBindingService,
  ModelAssignmentService,
  ModelConnectionService,
  ModelSelectionService,
  ToolAssignmentService,
  ToolConnectionService,
  ToolSelectionService,
} from '@ontology/application'
import { createCoreSearchBinding } from '@ontology/app-api'
import { SecretValue, ToolConnectionError } from '@ontology/contracts'
import type {
  ImmutableArtifactWriter,
  ModelConnectionDescriptor,
  ScopeRef,
  ToolConnectionAdminView,
  ToolConnectionDescriptor,
  ToolContext,
  ToolExecutionConnectionSnapshot,
  ToolTargetScope,
} from '@ontology/contracts'
import { createExecutionModelBindingRuntime, modelConnectionComponentRef } from '../../apps/api/src/composition/core-execution-model-binding'
import { budgetHarness, generationRequest, recordingEvidence } from '../unit/model-company-fixtures'
import { context, InMemoryCredentialCustodian, RecordingTargetDirectory } from '../unit/model-settings-fixtures'
import { InMemoryToolCredentialCustodian } from '../unit/tool-settings-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scopeA: JobTestScope
let scopeB: JobTestScope

const SPACE: ToolTargetScope = { kind: 'space' }
const artifacts = { putBytes: async () => { throw new Error('the snapshot binding test never archives bytes') } } as unknown as ImmutableArtifactWriter

function adminContext(scopeRef: ScopeRef): ToolContext {
  return context(scopeRef, ['platform-admin'], 'snapshot-admin-integration')
}

function toolDescriptor(overrides: Partial<ToolConnectionDescriptor> = {}): ToolConnectionDescriptor {
  return {
    name: '兼容网关',
    adapterType: 'http_compat',
    capabilities: ['web_search'],
    enabled: true,
    endpoint: 'https://search.old.example.com/v1/search',
    ...overrides,
  }
}

function modelDescriptor(overrides: Partial<ModelConnectionDescriptor> = {}): ModelConnectionDescriptor {
  return {
    name: '主生成模型',
    adapterType: 'company_generation',
    protocol: 'openai_compatible',
    capabilities: ['generation', 'research'],
    enabled: true,
    baseUrl: 'https://models.old.example.com',
    endpoint: '/v1/chat/completions',
    platformModelId: 'company-generation',
    providerModelName: 'gpt-company',
    ...overrides,
  }
}

function recordingFetch(): { readonly urls: string[]; readonly fetchImpl: typeof fetch } {
  const urls: string[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input))
    return new Response('', { status: 500 })
  }) as typeof fetch
  return { urls, fetchImpl }
}

function toolServices() {
  const connections = new PostgresToolConnectionStore(database)
  const assignments = new PostgresToolAssignmentStore(database)
  const bindings = new PostgresExecutionToolBindingStore(database)
  const snapshots = new PostgresExecutionConnectionSnapshotStore(database)
  const custodian = new InMemoryToolCredentialCustodian()
  const targets = new RecordingTargetDirectory()
  const connectionService = new ToolConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ToolAssignmentService({ assignments, connections, targets })
  const selectionService = new ToolSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionToolBindingService({ bindings, resolver: selectionService, connections, snapshots })
  return { connections, assignments, snapshots, custodian, connectionService, assignmentService, selectionService, bindingService }
}

function modelServices() {
  const connections = new PostgresModelConnectionStore(database)
  const assignments = new PostgresModelAssignmentStore(database)
  const bindings = new PostgresExecutionModelBindingStore(database)
  const snapshots = new PostgresExecutionConnectionSnapshotStore(database)
  const custodian = new InMemoryCredentialCustodian()
  const targets = new RecordingTargetDirectory()
  const connectionService = new ModelConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ModelAssignmentService({ assignments, connections, targets })
  const selectionService = new ModelSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionModelBindingService({ bindings, resolver: selectionService, connections, snapshots })
  return { connections, assignments, bindings, snapshots, custodian, connectionService, assignmentService, selectionService, bindingService }
}

function snapshotOf(view: ToolConnectionAdminView): ToolExecutionConnectionSnapshot {
  return {
    schemaVersion: 'tool-execution-connection-snapshot@1',
    connectionId: view.connectionId,
    connectionRevision: view.revision,
    name: view.name,
    adapterType: view.adapterType,
    capabilities: [...view.capabilities],
    enabled: view.enabled,
    ...(view.endpoint === undefined ? {} : { endpoint: view.endpoint }),
  }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  scopeA = await createJobScope(harness.adminClient, 'snapshot-a')
  scopeB = await createJobScope(harness.adminClient, 'snapshot-b')
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('PostgresExecutionConnectionSnapshotStore', () => {
  it('stores one immutable snapshot per connection revision and isolates tenants', async () => {
    const { snapshots, connectionService } = toolServices()
    const scopeRef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const ctx = adminContext(scopeRef)
    const connection = await connectionService.create({ descriptor: toolDescriptor(), idempotencyKey: `snap-store-${randomUUID()}`, connectionId: randomUUID() }, ctx)
    const stored = await snapshots.putToolSnapshot(scopeRef, snapshotOf(connection), ctx)
    expect(await snapshots.getToolSnapshot(scopeRef, connection.connectionId, connection.revision, ctx)).toEqual(stored)

    // Write-once per revision: a different snapshot for the same revision is a conflict, not an overwrite.
    await expect(snapshots.putToolSnapshot(scopeRef, { ...snapshotOf(connection), endpoint: 'https://other.example.com/v1/search' }, ctx))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    // A foreign scope cannot see it.
    const scopeBRef = { tenantId: scopeB.tenantId, spaceId: scopeB.spaceId }
    expect(await snapshots.getToolSnapshot(scopeBRef, connection.connectionId, connection.revision, adminContext(scopeBRef))).toBeUndefined()
  })

  it('never stores a credential in a snapshot', async () => {
    const { snapshots, connectionService } = toolServices()
    const scopeRef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const ctx = adminContext(scopeRef)
    const connection = await connectionService.create({ descriptor: toolDescriptor(), idempotencyKey: `snap-secret-${randomUUID()}`, connectionId: randomUUID() }, ctx)
    const withSecret = { ...snapshotOf(connection), apiKey: 'tvly-top-secret' } as unknown as ToolExecutionConnectionSnapshot
    await expect(snapshots.putToolSnapshot(scopeRef, withSecret, ctx)).rejects.toBeInstanceOf(ToolConnectionError)
  })
})

describe('S02 tool snapshot: pinned config survives an edit, a default change and revocation', () => {
  it('keeps the old endpoint after the connection is edited, ignores default changes, and blocks on revoke', async () => {
    const { connections, custodian, connectionService, assignmentService, snapshots, bindingService } = toolServices()
    const scopeRef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const ctx = adminContext(scopeRef)
    const runId = randomUUID()
    const a = await connectionService.create({ descriptor: toolDescriptor({ name: `旧-${randomUUID().slice(0, 6)}` }), idempotencyKey: `snap-run-a-${randomUUID()}`, connectionId: randomUUID() }, ctx)
    await assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: a.connectionId }, toolSelections: [] }, ctx)

    const recording = recordingFetch()
    const binding = createCoreSearchBinding({ bindings: bindingService, connections, credentials: custodian, snapshots, scopeRef, artifacts, targetScope: SPACE, fetchImpl: recording.fetchImpl })
    const first = await binding.resolveForRun(runId, ctx)
    expect(first.state).toBe('available')
    if (first.state !== 'available') return
    expect(first.binding.snapshotRef).toBeDefined()

    // The catalogue row moves its endpoint.
    const moved = await connectionService.update({ connectionId: a.connectionId, descriptor: toolDescriptor({ name: a.name, endpoint: 'https://search.new.example.com/v1/search' }), expectedRevision: a.revision, idempotencyKey: `snap-run-move-${randomUUID()}` }, ctx)

    const resume = await binding.resolveForRun(runId, ctx)
    expect(resume.state).toBe('available')
    if (resume.state !== 'available') return
    const deadline = new Date(Date.now() + 5_000).toISOString()
    await expect(resume.provider.search({ query: 'q', allowedDomains: ['example.com'], limit: 1, deadline, signal: new AbortController().signal }, ctx)).rejects.toBeTruthy()
    expect(recording.urls.every((url) => url.includes('search.old.example.com'))).toBe(true)
    expect(recording.urls.some((url) => url.includes('search.new.example.com'))).toBe(false)

    // A new default assignment must not move the bound execution.
    const b = await connectionService.create({ descriptor: toolDescriptor({ name: `新-${randomUUID().slice(0, 6)}`, endpoint: 'https://search.b.example.com/v1/search' }), idempotencyKey: `snap-run-b-${randomUUID()}`, connectionId: randomUUID() }, ctx)
    const currentAssignment = await assignmentService.get(SPACE, ctx)
    await assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: b.connectionId }, toolSelections: [], ...(currentAssignment === undefined ? {} : { expectedRevision: currentAssignment.revision }) }, ctx)
    const afterDefault = await binding.resolveForRun(runId, ctx)
    expect(afterDefault.state).toBe('available')
    if (afterDefault.state !== 'available') return
    expect(afterDefault.binding.connectionId).toBe(a.connectionId)

    // Revoking the pinned connection blocks; it never falls through to B.
    await connectionService.update({ connectionId: a.connectionId, descriptor: toolDescriptor({ name: a.name, enabled: false, ...(a.endpoint === undefined ? {} : { endpoint: a.endpoint }) }), expectedRevision: moved.revision, idempotencyKey: `snap-run-revoke-${randomUUID()}` }, ctx)
    const blocked = await binding.resolveForRun(runId, ctx)
    expect(blocked.state).toBe('blocked')
    if (blocked.state !== 'blocked') return
    expect(blocked.reason).toBe('TOOL_BINDING_REVOKED')
  })
})

describe('S02 model snapshot: pinned config survives an edit and revocation', () => {
  it('keeps the old base URL after the connection is edited and fails closed on revoke', async () => {
    const { connections, custodian, connectionService, assignmentService, snapshots, bindings, bindingService } = modelServices()
    const scopeRef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const ctx = adminContext(scopeRef)
    const runId = randomUUID()
    const created = await connectionService.create({ descriptor: modelDescriptor(), idempotencyKey: `snap-model-a-${randomUUID()}`, connectionId: randomUUID(), credential: new SecretValue('sk-snap-secret') }, ctx)
    await assignmentService.put({
      scope: { kind: 'space' }, defaultSelection: { kind: 'inherit' },
      capabilitySelections: [{ capability: 'generation', selection: { kind: 'connection', connectionId: created.connectionId } }],
    }, ctx)

    const bound = await bindingService.ensureBinding({ executionId: runId, scope: { kind: 'space' }, capability: 'generation' }, ctx)
    expect(bound.snapshotRef).toBeDefined()
    const snapshot = await snapshots.getModelSnapshot(scopeRef, created.connectionId, created.revision, ctx)
    expect(snapshot?.baseUrl).toBe('https://models.old.example.com')
    expect(JSON.stringify(snapshot)).not.toContain('sk-snap-secret')

    await connectionService.update({ connectionId: created.connectionId, descriptor: modelDescriptor({ baseUrl: 'https://models.new.example.com' }), expectedRevision: created.revision, idempotencyKey: `snap-model-move-${randomUUID()}`, credential: new SecretValue('sk-snap-secret-2') }, ctx)

    const recording = recordingFetch()
    const budget = await budgetHarness({ maxModelTokens: 10_000, scope: { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId } })
    const runtime = createExecutionModelBindingRuntime({
      scopeRef, bindings, connections, credentials: custodian, snapshots,
      isUsable: (executionId, capability, ctx2) => bindingService.isUsable(executionId, capability, ctx2),
      capabilityDependencies: { budget: budget.budget, generationEvidence: recordingEvidence().recorder, jevFallbackPolicy: 'reject', fetchImpl: recording.fetchImpl },
    })
    const resolved = await runtime.capabilitiesForExecution({ executionId: runId, ledgerId: budget.ledgerId, signal: new AbortController().signal, ctx })
    expect(resolved.generationBlocked).toBe(false)
    if (resolved.generation === undefined) return
    const request = generationRequest({ modelRef: { modelId: modelConnectionComponentRef({ connectionId: created.connectionId, revision: created.revision }).id, version: '1.0.0' } })
    for await (const _event of resolved.generation.generate(request, budget.ctx)) { void _event }
    expect(recording.urls.length).toBeGreaterThan(0)
    expect(recording.urls.every((url) => url.includes('models.old.example.com'))).toBe(true)
    expect(recording.urls.some((url) => url.includes('models.new.example.com'))).toBe(false)

    // Revoking the pinned credential fails closed and never falls through to another model.
    await connectionService.setCredential({ connectionId: created.connectionId, action: 'clear' }, ctx)
    const revoked = await runtime.capabilitiesForExecution({ executionId: runId, ledgerId: budget.ledgerId, signal: new AbortController().signal, ctx })
    expect(revoked.generation).toBeUndefined()
    expect(revoked.generationBlocked).toBe(true)
  })
})
