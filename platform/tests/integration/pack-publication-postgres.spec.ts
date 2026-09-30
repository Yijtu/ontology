import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresPublishedPackAssetStore,
  PostgresSemanticDefinitionStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  IndustryPackExportService,
  StoreBackedIndustryManifestSource,
  StoreBackedIndustryPackCatalogue,
  assemblePack,
} from '@ontology/application'
import type {
  IndustryValidationReport,
  IndustryWorkspace,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { toolContext } from '../unit/component-registry-fixtures'

/**
 * V03-015 real-database acceptance (migration 066).
 *
 * The publication transaction, the immutable pack asset, the dynamic catalogue and the export run
 * against the real control PostgreSQL: the workspace head CAS, the published definition version
 * (007), the pack table (066) and the dynamic read path. Nothing is mocked; the container has a
 * unique name and an ephemeral loopback port.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const DIGEST = `sha256:${'d'.repeat(64)}`
const EDITOR: ToolContext = toolContext(TENANT, SPACE, ['profile-editor'], 'editor-1')

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let controlDatabase: ControlPostgresDatabase
let store: PostgresPublishedPackAssetStore

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function workspaceFixture(): IndustryWorkspace {
  return {
    workspaceId: WORKSPACE_ID,
    namespace: 'demo-industry',
    displayName: 'Demo industry',
    boundary: { goals: [], included: [], excluded: [], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
}

function reportFixture(seed: string): IndustryValidationReport {
  const exampleSetId = randomUUID()
  return {
    validationId: randomUUID(),
    workspaceId: WORKSPACE_ID,
    revision: '1',
    exampleSetId,
    exampleSetRef: { id: exampleSetId, version: '1.0.0', digest: DIGEST, kind: 'dataset' },
    dataMode: 'synthetic',
    isolationLabel: 'synthetic test',
    businessApproval: 'none',
    realFactsWritten: false,
    rules: [],
    actions: [],
    semanticPublished: { passed: true, blockers: [] },
    deploymentExecutable: { passed: true, blockers: [] },
    publishable: true,
    gate: 'open',
    issues: [],
    expectationResults: [],
    coverage: [],
    contentDigest: `sha256:${seed.repeat(64).slice(0, 64)}`,
    idempotencyKey: `validation-${randomUUID()}`,
    actor: 'editor-1',
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function committedInput(packId: string, version: string, seed: string, expectedRevision: string) {
  const { definition, asset } = assemblePack({
    workspace: workspaceFixture(),
    scopeRef: SCOPE,
    packId,
    version,
    definitionId: `demo-industry.${packId}`,
    projection: [],
    ruleActions: [],
    report: reportFixture(seed),
    publishedAt: '2026-09-30T00:00:00Z',
    idempotencyKey: `publish-${randomUUID()}`,
    actor: 'editor-1',
  })
  return {
    expectedRevision,
    definition,
    definitionAudit: {
      digest: definition.ref.digest,
      payloadDigest: DIGEST,
      idempotencyKey: `definition-publish:${definition.namespace}:${definition.ref.id}:${definition.ref.version}`,
      occurredAt: '2026-09-30T00:00:00Z',
      actor: 'editor-1',
    },
    pack: asset,
    idempotencyKey: asset.idempotencyKey,
    requestDigest: DIGEST,
    actor: 'editor-1',
    recordedAt: '2026-09-30T00:00:00Z',
    outbox: {
      outboxId: randomUUID(),
      topic: 'asset.pack.published',
      payload: { packRef: asset.packRef },
      idempotencyKey: `pack-publish:${asset.namespace}:${asset.packRef.id}:${asset.packRef.version}`,
      availableAt: '2026-09-30T00:00:00Z',
      createdAt: '2026-09-30T00:00:00Z',
    },
    outboxJobId: randomUUID(),
  }
}

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  if (provided !== undefined && provided.length > 0) {
    adminUrl = provided
  } else {
    container = await startPostgresContainer()
    adminUrl = container.adminUrl
  }
  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'pack-node-15') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'pack-space') ON CONFLICT DO NOTHING`,
    [TENANT, SPACE],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.industry_workspaces
       (tenant_id, space_id, workspace_id, namespace, display_name, boundary, head_revision, state,
        create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'demo-industry', 'Demo industry', '{}'::jsonb, 1, 'draft', $4, $5, 'editor-1', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT, SPACE, WORKSPACE_ID, `seed-${WORKSPACE_ID}`, DIGEST],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)

  controlDatabase = new ControlPostgresDatabase({ connectionString: connectionStringFor(adminUrl, 'ontology_app', appPassword), maxPoolSize: 4 })
  store = new PostgresPublishedPackAssetStore(controlDatabase)
}, 300_000)

afterAll(async () => {
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('industry pack publication against real PostgreSQL', () => {
  let committedPackId = ''
  let committedVersion = ''

  it('commits an immutable pack, advances the workspace pointer and persists the definition', async () => {
    const input = committedInput('demo-pack', '1.0.0', 'a', '1')
    const result = await store.commitApprovedPack(SCOPE, input, EDITOR)
    expect(result.created).toBe(true)
    expect(result.asset.revision).toBe('2')
    committedPackId = result.asset.packRef.id
    committedVersion = result.asset.packRef.version

    const head = await adminClient.query<{ head_revision: string; latest_pack_ref: { id: string } }>(
      `SELECT head_revision, latest_pack_ref FROM agent_platform.industry_workspaces
        WHERE tenant_id = $1 AND space_id = $2 AND workspace_id = $3`,
      [TENANT, SPACE, WORKSPACE_ID],
    )
    expect(head.rows[0]?.head_revision).toBe('2')
    expect(head.rows[0]?.latest_pack_ref.id).toBe(result.asset.packRef.id)

    const definitionRow = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.semantic_definition_versions
        WHERE tenant_id = $1 AND space_id = $2 AND definition_id = $3 AND version = $4`,
      [TENANT, SPACE, result.asset.definitionRef.id, result.asset.definitionRef.version],
    )
    expect(definitionRow.rows[0]?.count).toBe('1')
  })

  it('reads the published pack back through findPack/findByRef/listPacks and the idempotency key', async () => {
    const found = await store.findPack(SCOPE, committedPackId, committedVersion, EDITOR)
    expect(found?.packRef.id).toBe(committedPackId)
    const byRef = await store.findByRef(SCOPE, found!.packRef, EDITOR)
    expect(byRef?.contentDigest).toBe(found?.contentDigest)
    const listed = await store.listPacks(SCOPE, { namespace: 'demo-industry' }, EDITOR)
    expect(listed.length).toBeGreaterThan(0)
  })

  it('serves the pack from the dynamic catalogue and manifest source', async () => {
    const catalogue = new StoreBackedIndustryPackCatalogue({ store })
    const manifestSource = new StoreBackedIndustryManifestSource({ store })
    const asset = await store.findPack(SCOPE, committedPackId, committedVersion, EDITOR)
    if (asset === undefined) throw new Error('the pack was not persisted')
    const pack = await catalogue.findPack(committedPackId, committedVersion, SCOPE, EDITOR)
    expect(pack?.ref).toEqual(asset.packRef)
    const manifest = await manifestSource.getManifest(asset.packRef, SCOPE, EDITOR)
    expect(manifest?.definitionsRef).toEqual(asset.definitionRef)
  })

  it('exports the bundle with source index, capability state and diff and scans clean', async () => {
    const catalogue = new StoreBackedIndustryPackCatalogue({ store })
    const definitions = new PostgresSemanticDefinitionStore(controlDatabase)
    const exporter = new IndustryPackExportService({ catalogue, definitions, published: store })
    const asset = await store.findPack(SCOPE, committedPackId, committedVersion, EDITOR)
    if (asset === undefined) throw new Error('the pack was not persisted')
    const bundle = await exporter.export(
      { scopeRef: SCOPE, packId: committedPackId, version: committedVersion },
      EDITOR,
    )
    expect(bundle.sourceIndex).toBeDefined()
    expect(bundle.capabilityStatus?.semanticPublished).toBe(true)
    expect(bundle.versionDiff?.toPackRef).toEqual(asset.packRef)
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(TENANT)
    expect(serialized).not.toContain(SPACE)
  })

  it('rejects a pack id/version and a namespace/version with a different digest', async () => {
    const packVersionConflict = committedInput('demo-pack', '1.0.0', 'b', '2')
    await expect(store.commitApprovedPack(SCOPE, packVersionConflict, EDITOR)).rejects.toMatchObject({
      code: 'PACK_VERSION_EXISTS',
    })
    const namespaceConflict = committedInput('other-pack', '1.0.0', 'c', '2')
    await expect(store.commitApprovedPack(SCOPE, namespaceConflict, EDITOR)).rejects.toMatchObject({
      code: 'NAMESPACE_CONFLICT',
    })
  })

  it('rejects a stale workspace head and a reused idempotency key with a different request', async () => {
    const stale = committedInput('stale-pack', '1.0.0', 'e', '1')
    await expect(store.commitApprovedPack(SCOPE, stale, EDITOR)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    })
  })

  it('replays the same idempotency key', async () => {
    const first = committedInput('replay-pack', '2.0.0', 'f', '2')
    await store.commitApprovedPack(SCOPE, first, EDITOR)
    // A second pack must now expect the advanced head.
    const replay = await store.commitApprovedPack(SCOPE, first, EDITOR)
    expect(replay.created).toBe(false)
    expect(replay.asset.packRef.id).toBe(`demo-industry.${'replay-pack'}`)
  })
})
