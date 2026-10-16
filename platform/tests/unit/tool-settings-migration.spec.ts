import { mkdtemp, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreToolSettingsMigration } from '@ontology/app-api'
import { ToolAssignmentService, ToolConnectionService, ToolSelectionService } from '@ontology/application'
import {
  TEST_SCOPE,
  adminContext,
  InMemoryToolAssignmentStore,
  InMemoryToolConnectionStore,
  InMemoryToolCredentialCustodian,
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

function migration(directory: string, h: ReturnType<typeof build>, environment: Readonly<Record<string, string | undefined>>) {
  return new CoreToolSettingsMigration({
    connections: h.connectionService,
    assignments: h.assignmentService,
    scopeRef: TEST_SCOPE,
    objectDirectory: directory,
    environment,
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
    expect(list[0]?.endpoint).toBe('https://search.example.com/v1/search')
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
      descriptor: { name: '管理员改名', adapterType: 'http_compat', capabilities: ['web_search'], enabled: true, endpoint: 'https://search.example.com/v1/search' },
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
})
