import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresExecutionModelBindingStore,
  PostgresModelAssignmentStore,
  PostgresModelConnectionStore,
} from '@ontology/adapter-control-postgres'
import { ModelAssignmentService, ModelConnectionService, ExecutionModelBindingService, ModelSelectionService } from '@ontology/application'
import { SecretValue } from '@ontology/contracts'
import type { ModelConnectionDescriptor, ScopeRef, ToolContext } from '@ontology/contracts'
import { context } from '../unit/model-settings-fixtures'
import { InMemoryCredentialCustodian, RecordingTargetDirectory } from '../unit/model-settings-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scopeA: JobTestScope
let scopeB: JobTestScope

function adminContext(scopeRef: ScopeRef): ToolContext {
  return context(scopeRef, ['platform-admin'], 'admin-integration')
}

function descriptor(overrides: Partial<ModelConnectionDescriptor> = {}): ModelConnectionDescriptor {
  return {
    name: '主生成模型',
    adapterType: 'company_generation',
    protocol: 'openai_compatible',
    capabilities: ['generation', 'research'],
    enabled: true,
    baseUrl: 'https://models.example.com',
    endpoint: '/v1/chat/completions',
    platformModelId: 'company-generation',
    providerModelName: 'gpt-company',
    ...overrides,
  }
}

function services() {
  const connections = new PostgresModelConnectionStore(database)
  const assignments = new PostgresModelAssignmentStore(database)
  const bindings = new PostgresExecutionModelBindingStore(database)
  const custodian = new InMemoryCredentialCustodian()
  const targets = new RecordingTargetDirectory()
  const connectionService = new ModelConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ModelAssignmentService({ assignments, connections, targets })
  const selectionService = new ModelSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionModelBindingService({ bindings, resolver: selectionService })
  return { connections, assignments, connectionService, assignmentService, selectionService, bindingService }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  scopeA = await createJobScope(harness.adminClient, 'model-a')
  scopeB = await createJobScope(harness.adminClient, 'model-b')
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('PostgresModelConnectionStore', () => {
  it('is idempotent per key, CAS-guarded and never stores an echoed key in the view', async () => {
    const { connections, connectionService } = services()
    const scopeRef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const ctx = adminContext(scopeRef)
    const connectionId = randomUUID()
    const created = await connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'it-create-key-0001',
      credential: new SecretValue('sk-integration-secret'),
      connectionId,
    }, ctx)
    expect(created.connectionId).toBe(connectionId)
    expect(created.credentialState).toBe('present')
    expect(JSON.stringify(created)).not.toContain('sk-integration-secret')

    const replay = await connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'it-create-key-0001',
      connectionId,
    }, ctx)
    expect(replay.revision).toBe(created.revision)

    await expect(connectionService.create({
      descriptor: descriptor({ name: '不同的描述' }),
      idempotencyKey: 'it-create-key-0001',
      connectionId,
    }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    // Credential change bumps the revision and clears the stale test summary.
    const ref = await connections.getCredentialRef(scopeRef, connectionId, ctx)
    expect(ref).toBeDefined()
    const cleared = await connectionService.setCredential({ connectionId, action: 'clear' }, ctx)
    expect(cleared.credentialState).toBe('missing')
    expect(BigInt(cleared.revision)).toBeGreaterThan(BigInt(created.revision))
  })

  it('keeps tenant/space isolation: a foreign id is invisible', async () => {
    const { connectionService } = services()
    const scopeARef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const scopeBRef = { tenantId: scopeB.tenantId, spaceId: scopeB.spaceId }
    const created = await connectionService.create({
      descriptor: descriptor({ name: 'A 空间模型' }),
      idempotencyKey: 'it-isolation-0001',
      connectionId: randomUUID(),
    }, adminContext(scopeARef))

    expect(await connectionService.get(created.connectionId, adminContext(scopeARef))).toBeDefined()
    expect(await connectionService.get(created.connectionId, adminContext(scopeBRef))).toBeUndefined()
    const listB = await connectionService.list({}, adminContext(scopeBRef))
    expect(listB.map((view) => view.connectionId)).not.toContain(created.connectionId)
  })
})

describe('PostgresModelAssignmentStore and bindings', () => {
  it('stores one assignment set per scope with CAS and binds an execution', async () => {
    const { connectionService, assignmentService, bindingService, selectionService } = services()
    const scopeRef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const ctx = adminContext(scopeRef)
    const connection = await connectionService.create({
      descriptor: descriptor({ name: '分配模型' }),
      idempotencyKey: `it-assignment-${randomUUID()}`,
      credential: new SecretValue('sk-assignment'),
      connectionId: randomUUID(),
    }, ctx)

    const set = await assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: connection.connectionId },
      capabilitySelections: [],
    }, ctx)
    expect(set.revision).toBe('1')

    await expect(assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'disabled' },
      capabilitySelections: [],
      expectedRevision: '999',
    }, ctx)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    const selection = await selectionService.resolve(scopeRef, { scope: { kind: 'space' }, capability: 'generation' }, ctx)
    expect(selection.state).toBe('available')
    expect(selection.resolvedFrom).toBe('space_default')

    const executionId = randomUUID()
    const binding = await bindingService.bind({ executionId, scope: { kind: 'space' }, capability: 'generation' }, ctx)
    expect(binding.connectionId).toBe(connection.connectionId)
    expect(JSON.stringify(binding)).not.toContain('sk-assignment')
    const readBack = await bindingService.readBack(executionId, 'generation', ctx)
    expect(readBack).toEqual(binding)
  })

  it('serialises concurrent space-default writes: one winner, one row, no silent overwrite', async () => {
    const { connectionService, assignmentService, selectionService } = services()
    const scope = await createJobScope(harness.adminClient, `model-concurrent-${randomUUID().slice(0, 8)}`)
    const scopeRef = { tenantId: scope.tenantId, spaceId: scope.spaceId }
    const ctx = adminContext(scopeRef)
    const first = await connectionService.create({
      descriptor: descriptor({ name: `并发甲-${randomUUID().slice(0, 6)}` }),
      idempotencyKey: `it-concurrent-a-${randomUUID()}`,
      credential: new SecretValue('sk-concurrent-a'),
      connectionId: randomUUID(),
    }, ctx)
    const second = await connectionService.create({
      descriptor: descriptor({ name: `并发乙-${randomUUID().slice(0, 6)}` }),
      idempotencyKey: `it-concurrent-b-${randomUUID()}`,
      credential: new SecretValue('sk-concurrent-b'),
      connectionId: randomUUID(),
    }, ctx)

    const attempts = await Promise.allSettled([
      assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'connection', connectionId: first.connectionId }, capabilitySelections: [] }, ctx),
      assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'connection', connectionId: second.connectionId }, capabilitySelections: [] }, ctx),
      assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'disabled' }, capabilitySelections: [] }, ctx),
    ])
    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const losers = attempts.filter((attempt) => attempt.status === 'rejected') as PromiseRejectedResult[]
    // Exactly one write wins; the others must fail closed (CAS conflict or the composite-key unique
    // constraint), never silently overwrite the winner.
    expect(winners).toHaveLength(1)
    for (const loser of losers) {
      expect(['VERSION_CONFLICT', '23505']).toContain((loser.reason as { code?: string }).code)
    }

    const rows = await harness.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.model_assignment_sets
        WHERE tenant_id = $1 AND space_id = $2 AND scope_kind = 'space'`,
      [scopeRef.tenantId, scopeRef.spaceId],
    )
    expect(rows.rows[0]?.count).toBe('1')
    const stored = await selectionService.resolve(scopeRef, { scope: { kind: 'space' }, capability: 'generation' }, ctx)
    const winner = winners[0] as PromiseFulfilledResult<{ defaultSelection: { kind: string; connectionId?: string }; revision: string }>
    expect(winner.value.revision).toBe('1')
    expect(stored.assignmentRevision).toBe('1')
    if (winner.value.defaultSelection.kind === 'connection') expect(stored.connectionId).toBe(winner.value.defaultSelection.connectionId)
    else expect(stored.state).toBe('disabled')
  })
})
