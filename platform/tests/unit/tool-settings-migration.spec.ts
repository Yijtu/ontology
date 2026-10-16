import { mkdtemp, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreToolSettingsMigration, WEB_SEARCH_MIGRATION_KEY } from '@ontology/app-api'
import { ToolAssignmentService, ToolConnectionService, ToolSelectionService } from '@ontology/application'
import {
  TEST_SCOPE,
  adminContext,
  InMemoryToolAssignmentStore,
  InMemoryToolConnectionStore,
  InMemoryToolCredentialCustodian,
  InMemoryToolSettingsMigrationStore,
  RecordingTargetDirectory,
} from './tool-settings-fixtures'

const LEGACY_ENV = {
  CORE_WEB_SEARCH_BASE_URL: 'https://search.example.com',
  CORE_WEB_SEARCH_ENDPOINT: '/v1/search',
  CORE_WEB_SEARCH_API_KEY: 'tvly-legacy-secret',
} as const

function build() {
  const connections = new InMemoryToolConnectionStore()
  const assignments = new InMemoryToolAssignmentStore()
  const custodian = new InMemoryToolCredentialCustodian()
  const targets = new RecordingTargetDirectory()
  const connectionService = new ToolConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ToolAssignmentService({ assignments, connections, targets })
  const selectionService = new ToolSelectionService({ assignments, connections, targets })
  return { connections, assignments, custodian, connectionService, assignmentService, selectionService }
}

function migration(
  directory: string,
  h: ReturnType<typeof build>,
  environment: Readonly<Record<string, string | undefined>>,
  migrationStore?: InMemoryToolSettingsMigrationStore,
) {
  return new CoreToolSettingsMigration({
    connections: h.connectionService,
    assignments: h.assignmentService,
    scopeRef: TEST_SCOPE,
    objectDirectory: directory,
    environment,
    ...(migrationStore === undefined ? {} : { migrationStore }),
  })
}

describe('CoreToolSettingsMigration', () => {
  it('bridges the legacy compat gateway once and is idempotent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-migration-'))
    const h = build()
    const migrate = migration(directory, h, { ...LEGACY_ENV })

    expect(await migrate.isMigrated()).toBe(false)
    await migrate.migrate()
    expect(await migrate.isMigrated()).toBe(true)

    const list = await h.connections.listConnections(TEST_SCOPE, {})
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('兼容网关')
    expect(list[0]?.adapterType).toBe('http_compat')
    expect(list[0]?.capabilities).toEqual(['web_search'])
    expect(list[0]?.enabled).toBe(true)
    // The base address and the endpoint path are preserved **separately** (S03): the address is not
    // merged with the path, so the adapter's `/v1/search` default never overwrites an imported path.
    expect(list[0]?.endpoint).toBe('https://search.example.com')
    expect(list[0]?.searchStrategy?.compatEndpointPath).toBe('/v1/search')
    expect(list[0]?.credentialState).toBe('present')
    expect(JSON.stringify(list)).not.toContain('tvly-legacy-secret')

    const assignment = await h.assignments.getAssignmentSet(TEST_SCOPE, { kind: 'space' })
    expect(assignment?.defaultSelection).toEqual({ kind: 'inherit' })
    expect(assignment?.toolSelections).toEqual([
      { toolId: 'web_search', selection: { kind: 'connection', connectionId: list[0]?.connectionId } },
    ])

    // A second run must not duplicate (completion marker).
    await migrate.migrate()
    expect(await h.connections.listConnections(TEST_SCOPE, {})).toHaveLength(1)
  })

  it('leaves the tool unconfigured with no environment and never imports once switched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-migration-'))
    const h = build()
    const empty = migration(directory, h, {})
    await empty.migrate()
    expect(await empty.isMigrated()).toBe(true)
    expect(await h.connections.listConnections(TEST_SCOPE, {})).toHaveLength(0)

    // Env appearing later is not a second source of truth: the catalogue owns the selection now.
    const later = migration(directory, h, { ...LEGACY_ENV })
    await later.migrate()
    expect(await h.connections.listConnections(TEST_SCOPE, {})).toHaveLength(0)
  })

  it('does not overwrite a UI edit made after the one-time import', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-migration-'))
    const h = build()
    await migration(directory, h, { ...LEGACY_ENV }).migrate()
    const admin = adminContext()
    const imported = (await h.connections.listConnections(TEST_SCOPE, {}))[0]
    expect(imported).toBeDefined()
    if (imported === undefined) return
    await h.connectionService.update({
      connectionId: imported.connectionId,
      descriptor: { name: '管理员改名', adapterType: 'http_compat', capabilities: ['web_search'], enabled: true, endpoint: 'https://search.example.com' },
      expectedRevision: imported.revision,
      idempotencyKey: 'tool-migration-ui-edit',
    }, admin)

    await migration(directory, h, { ...LEGACY_ENV }).migrate()
    const list = await h.connections.listConnections(TEST_SCOPE, {})
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('管理员改名')
  })

  it('is resumable: a re-run after an interruption reuses the same deterministic id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-migration-'))
    const h = build()
    const migrate = migration(directory, h, { ...LEGACY_ENV })
    await migrate.migrate()
    const first = await h.connections.listConnections(TEST_SCOPE, {})
    await unlink(join(directory, '.core-settings', TEST_SCOPE.tenantId, TEST_SCOPE.spaceId, 'tool-connections-migrated.flag')).catch(() => undefined)
    await migrate.migrate()
    const second = await h.connections.listConnections(TEST_SCOPE, {})
    expect(second.map((view) => view.connectionId)).toEqual(first.map((view) => view.connectionId))
  })

  it('imports a keyless compat gateway that still resolves as usable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-migration-'))
    const h = build()
    await migration(directory, h, { CORE_WEB_SEARCH_BASE_URL: 'https://search.example.com' }).migrate()

    const list = await h.connections.listConnections(TEST_SCOPE, {})
    expect(list).toHaveLength(1)
    expect(list[0]?.credentialState).toBe('missing')

    const selection = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, adminContext())
    expect(selection.state).toBe('available')
    expect(selection.resolvedFrom).toBe('space_tool')
  })

  it('preserves the legacy search timeout and archive byte cap on the imported connection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-migration-'))
    const h = build()
    await migration(directory, h, {
      ...LEGACY_ENV,
      CORE_WEB_SEARCH_MAX_TIMEOUT_MS: '1234',
      CORE_WEB_SEARCH_MAX_BYTES: '4096',
    }).migrate()

    const imported = (await h.connections.listConnections(TEST_SCOPE, {}))[0]
    expect(imported?.searchStrategy).toEqual({ compatEndpointPath: '/v1/search', maxTimeoutMs: 1234 })
    expect(imported?.archiveLimits).toEqual({ maxBytes: 4096, maxTimeoutMs: 1234 })
  })

  it('records a durable idempotency marker so a lost local flag cannot re-import the environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tool-migration-'))
    const h = build()
    const store = new InMemoryToolSettingsMigrationStore()
    await migration(directory, h, { ...LEGACY_ENV }, store).migrate()
    expect(await store.isApplied(TEST_SCOPE, WEB_SEARCH_MIGRATION_KEY)).toBe(true)

    const imported = (await h.connections.listConnections(TEST_SCOPE, {}))[0]
    if (imported === undefined) throw new Error('expected the imported connection')
    await h.connectionService.update({
      connectionId: imported.connectionId,
      descriptor: { name: '管理员改名', adapterType: 'http_compat', capabilities: ['web_search'], enabled: true, endpoint: 'https://search.example.com' },
      expectedRevision: imported.revision,
      idempotencyKey: 'tool-migration-durable-edit',
    }, adminContext())

    // Delete the *local* marker file: the durable record is what prevents a re-import after the edit.
    await unlink(join(directory, '.core-settings', TEST_SCOPE.tenantId, TEST_SCOPE.spaceId, 'tool-connections-migrated.flag')).catch(() => undefined)
    await migration(directory, h, { ...LEGACY_ENV }, store).migrate()

    const list = await h.connections.listConnections(TEST_SCOPE, {})
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('管理员改名')
  })
})
