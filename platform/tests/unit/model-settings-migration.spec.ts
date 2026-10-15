import { mkdtemp, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreLocalModelSettings, CoreModelSettingsMigration } from '@ontology/app-api'
import { ModelAssignmentService, ModelConnectionService } from '@ontology/application'
import {
  TEST_SCOPE,
  InMemoryCredentialCustodian,
  InMemoryModelAssignmentStore,
  InMemoryModelConnectionStore,
  RecordingTargetDirectory,
} from './model-settings-fixtures'

const LEGACY_ENV = {
  CORE_ENABLE_MODELS: 'true',
  CORE_COMPANY_MODEL_BASE_URL: 'https://legacy-models.example.com',
  CORE_COMPANY_MODEL_ENDPOINT: '/v1/chat/completions',
  CORE_COMPANY_MODEL_PROTOCOL: 'openai-compatible',
  CORE_COMPANY_MODEL_PLATFORM_ID: 'legacy-generation',
  CORE_COMPANY_MODEL_VENDOR_MODEL: 'legacy-model',
  CORE_COMPANY_MODEL_SECRET_REF: 'env:CORE_COMPANY_MODEL_API_KEY',
  CORE_COMPANY_MODEL_API_KEY: 'sk-legacy-secret-value',
} as const

function build() {
  const connections = new InMemoryModelConnectionStore()
  const assignments = new InMemoryModelAssignmentStore()
  const custodian = new InMemoryCredentialCustodian()
  const targets = new RecordingTargetDirectory()
  const connectionService = new ModelConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ModelAssignmentService({ assignments, connections, targets })
  return { connections, assignments, custodian, connectionService, assignmentService }
}

async function settings(directory: string) {
  return new CoreLocalModelSettings({ objectDirectory: directory, scopeRef: TEST_SCOPE, environment: { ...LEGACY_ENV } })
}

describe('CoreModelSettingsMigration', () => {
  it('bridges the legacy generation configuration once and is idempotent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'model-migration-'))
    const legacy = await settings(directory)
    const h = build()
    const migration = new CoreModelSettingsMigration({
      settings: legacy,
      connections: h.connectionService,
      assignments: h.assignmentService,
      environment: { ...LEGACY_ENV },
    })

    expect(await migration.isMigrated()).toBe(false)
    await migration.migrate()
    expect(await migration.isMigrated()).toBe(true)

    const list = await h.connections.listConnections(TEST_SCOPE, {})
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('原生成模型')
    expect(list[0]?.enabled).toBe(true)
    expect(list[0]?.credentialState).toBe('present')
    expect(JSON.stringify(list)).not.toContain('sk-legacy-secret-value')

    const assignment = await h.assignments.getAssignmentSet(TEST_SCOPE, { kind: 'space' })
    expect(assignment?.defaultSelection).toEqual({ kind: 'connection', connectionId: list[0]?.connectionId })

    // A second run must not duplicate or overwrite (completion marker).
    await migration.migrate()
    expect(await h.connections.listConnections(TEST_SCOPE, {})).toHaveLength(1)
  })

  it('clears the legacy plaintext credential once the catalogue owns the truth', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'model-migration-'))
    const legacy = await settings(directory)
    await legacy.save({
      revision: '0',
      enabled: true,
      baseUrl: 'https://legacy-models.example.com',
      endpoint: '/v1/chat/completions',
      protocol: 'openai-compatible',
      platformModelId: 'legacy-generation',
      vendorModel: 'legacy-model',
      apiKey: 'sk-legacy-file-secret',
    })
    const h = build()
    const migration = new CoreModelSettingsMigration({
      settings: legacy,
      connections: h.connectionService,
      assignments: h.assignmentService,
      environment: { ...LEGACY_ENV },
    })
    await migration.migrate()

    const reread = new CoreLocalModelSettings({ objectDirectory: directory, scopeRef: TEST_SCOPE, environment: {} })
    const view = await reread.read()
    expect(view.hasApiKey).toBe(false)
    // The non-secret configuration survives so it can be inspected as history.
    expect(view.platformModelId).toBe('legacy-generation')
  })

  it('is resumable: re-running after an interruption reuses the same deterministic id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'model-migration-'))
    const legacy = await settings(directory)
    const h = build()
    const migration = new CoreModelSettingsMigration({
      settings: legacy,
      connections: h.connectionService,
      assignments: h.assignmentService,
      environment: { ...LEGACY_ENV },
    })
    await migration.migrate()
    const first = await h.connections.listConnections(TEST_SCOPE, {})
    // Simulate an interrupted run: the completion marker is lost but the connection and assignment persist.
    await unlink(join(directory, '.core-settings', TEST_SCOPE.tenantId, TEST_SCOPE.spaceId, 'migrated.flag')).catch(() => undefined)
    await migration.migrate()
    const second = await h.connections.listConnections(TEST_SCOPE, {})
    expect(second.map((view) => view.connectionId)).toEqual(first.map((view) => view.connectionId))
  })
})

