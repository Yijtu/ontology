import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresExecutionToolBindingStore,
  PostgresToolAssignmentStore,
  PostgresToolConnectionStore,
} from '@ontology/adapter-control-postgres'
import { ExecutionToolBindingService, ToolAssignmentService, ToolConnectionService, ToolSelectionService } from '@ontology/application'
import { SecretValue } from '@ontology/contracts'
import type { ScopeRef, ToolConnectionDescriptor, ToolContext } from '@ontology/contracts'
import { context } from '../unit/model-settings-fixtures'
import { InMemoryToolCredentialCustodian, RecordingTargetDirectory } from '../unit/tool-settings-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scopeA: JobTestScope
let scopeB: JobTestScope

function adminContext(scopeRef: ScopeRef): ToolContext {
  return context(scopeRef, ['platform-admin'], 'tool-admin-integration')
}

function descriptor(overrides: Partial<ToolConnectionDescriptor> = {}): ToolConnectionDescriptor {
  return {
    name: '兼容网关',
    adapterType: 'http_compat',
    capabilities: ['web_search'],
    enabled: true,
    endpoint: 'https://search.example.com/v1/search',
    ...overrides,
  }
}

function services() {
  const connections = new PostgresToolConnectionStore(database)
  const assignments = new PostgresToolAssignmentStore(database)
  const bindings = new PostgresExecutionToolBindingStore(database)
  const custodian = new InMemoryToolCredentialCustodian()
  const targets = new RecordingTargetDirectory()
  const connectionService = new ToolConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ToolAssignmentService({ assignments, connections, targets })
  const selectionService = new ToolSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionToolBindingService({ bindings, resolver: selectionService, connections })
  return { connections, assignments, connectionService, assignmentService, selectionService, bindingService }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  scopeA = await createJobScope(harness.adminClient, 'tool-a')
  scopeB = await createJobScope(harness.adminClient, 'tool-b')
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('PostgresToolConnectionStore', () => {
  it('is idempotent per key, CAS-guarded and never stores an echoed key in the view', async () => {
    const { connections, connectionService } = services()
    const scopeRef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const ctx = adminContext(scopeRef)
    const connectionId = randomUUID()
    const created = await connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'tool-it-create-0001',
      credential: new SecretValue('tvly-integration-secret'),
      connectionId,
    }, ctx)
    expect(created.connectionId).toBe(connectionId)
    expect(created.credentialState).toBe('present')
    expect(JSON.stringify(created)).not.toContain('tvly-integration-secret')

    const replay = await connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'tool-it-create-0001',
      connectionId,
    }, ctx)
    expect(replay.revision).toBe(created.revision)

    await expect(connectionService.create({
      descriptor: descriptor({ name: '不同的描述' }),
      idempotencyKey: 'tool-it-create-0001',
      connectionId,
    }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

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
      descriptor: descriptor({ name: 'A 空间搜索' }),
      idempotencyKey: 'tool-it-isolation-0001',
      connectionId: randomUUID(),
    }, adminContext(scopeARef))

    expect(await connectionService.get(created.connectionId, adminContext(scopeARef))).toBeDefined()
    expect(await connectionService.get(created.connectionId, adminContext(scopeBRef))).toBeUndefined()
    const listB = await connectionService.list({}, adminContext(scopeBRef))
    expect(listB.map((view) => view.connectionId)).not.toContain(created.connectionId)
  })
})

describe('PostgresToolAssignmentStore and bindings', () => {
  it('stores one per-tool assignment set per scope with CAS and binds an execution', async () => {
    const { connectionService, assignmentService, bindingService, selectionService } = services()
    const scopeRef = { tenantId: scopeA.tenantId, spaceId: scopeA.spaceId }
    const ctx = adminContext(scopeRef)
    const connection = await connectionService.create({
      descriptor: descriptor({ name: '分配搜索' }),
      idempotencyKey: `tool-it-assignment-${randomUUID()}`,
      connectionId: randomUUID(),
    }, ctx)

    const set = await assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: connection.connectionId } }],
    }, ctx)
    expect(set.revision).toBe('1')

    await expect(assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'disabled' } }],
      expectedRevision: '999',
    }, ctx)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    const selection = await selectionService.resolve(scopeRef, { scope: { kind: 'space' }, toolId: 'web_search' }, ctx)
    expect(selection.state).toBe('available')
    expect(selection.resolvedFrom).toBe('space_tool')

    const executionId = randomUUID()
    const binding = await bindingService.bind({ executionId, scope: { kind: 'space' }, toolId: 'web_search' }, ctx)
    expect(binding.connectionId).toBe(connection.connectionId)
    const readBack = await bindingService.readBack(executionId, 'web_search', ctx)
    expect(readBack).toEqual(binding)
  })

  it('serialises concurrent space-default writes: one winner, one row, no silent overwrite', async () => {
    const { connectionService, assignmentService } = services()
    const scope = await createJobScope(harness.adminClient, `tool-concurrent-${randomUUID().slice(0, 8)}`)
    const scopeRef = { tenantId: scope.tenantId, spaceId: scope.spaceId }
    const ctx = adminContext(scopeRef)
    const first = await connectionService.create({
      descriptor: descriptor({ name: `并发甲-${randomUUID().slice(0, 6)}` }),
      idempotencyKey: `tool-it-concurrent-a-${randomUUID()}`,
      connectionId: randomUUID(),
    }, ctx)
    const second = await connectionService.create({
      descriptor: descriptor({ name: `并发乙-${randomUUID().slice(0, 6)}` }),
      idempotencyKey: `tool-it-concurrent-b-${randomUUID()}`,
      connectionId: randomUUID(),
    }, ctx)

    const attempts = await Promise.allSettled([
      assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'inherit' }, toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: first.connectionId } }] }, ctx),
      assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'inherit' }, toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: second.connectionId } }] }, ctx),
      assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'inherit' }, toolSelections: [{ toolId: 'web_search', selection: { kind: 'disabled' } }] }, ctx),
    ])
    const winners = attempts.filter((attempt) => attempt.status === 'fulfilled')
    const losers = attempts.filter((attempt) => attempt.status === 'rejected') as PromiseRejectedResult[]
    expect(winners).toHaveLength(1)
    for (const loser of losers) {
      expect(['VERSION_CONFLICT', '23505']).toContain((loser.reason as { code?: string }).code)
    }

    const rows = await harness.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.tool_assignment_sets
        WHERE tenant_id = $1 AND space_id = $2 AND scope_kind = 'space'`,
      [scopeRef.tenantId, scopeRef.spaceId],
    )
    expect(rows.rows[0]?.count).toBe('1')
  })
})
