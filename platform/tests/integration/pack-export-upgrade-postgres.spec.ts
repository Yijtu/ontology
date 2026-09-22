import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresComponentRegistryStore,
  PostgresProfileStore,
  PostgresSemanticDefinitionStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  ComponentRegistry,
  InMemoryIndustryManifestSource,
  IndustryPackError,
  IndustryPackExportService,
  IndustryPackUpgradeService,
  ProfileResolver,
  summarizePackCatalogEntry,
} from '@ontology/application'
import type { UpgradeRequest } from '@ontology/contracts'
import { findEmbeddedSecretViolations } from '@ontology/contracts'
import { SemanticDefinitionService } from '@ontology/semantic-engine'
import {
  HOME_ENERGY_DEFINITIONS,
  HOME_ENERGY_TEST_SUITE_REF,
  buildHomeEnergyManifest,
} from '@ontology/industry-pack-home-energy'
import { AUTOMOTIVE_PREPARATION } from '@ontology/industry-pack-automotive'
import { HEALTH_SERVICES_PREPARATION } from '@ontology/industry-pack-health-services'
import { findPackExportViolations, InMemoryIndustryPackCatalogue } from '@ontology/application'
import {
  INDUSTRY_REF,
  PACK_ADMIN_A,
  PACK_EDITOR_A,
  PACK_RUNNER_A,
  RUN_A,
  RUNTIME_V1,
  RUNTIME_V2,
  SCOPE_A,
  TELEMETRY_MAPPING_REF_B,
  componentRecord,
  homeEnergyComponents,
  homeEnergyTestSuite,
  sampleProfileSpec,
  seedComponents,
  toolContext,
} from '../unit/pack-fixtures'
import { FakeBlobPort, canonicalManifestValidator } from '../unit/component-registry-fixtures'
import { canonicalProfileValidator } from '../unit/profile-resolver-fixtures'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

/**
 * LOCAL-041 real-database acceptance.
 *
 * The export and the compatibility upgrade run against the real control PostgreSQL: the
 * published definition version (migration 007), the component registry with its active-run
 * reference guard (006) and the immutable profile/resolved-manifest store (008). Nothing is
 * mocked; the container has a unique name and an ephemeral loopback port.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const PROFILE_V1 = { id: 'home-energy-demo', version: '1.0.0' }
const PROFILE_V2 = { id: 'home-energy-demo', version: '2.0.0' }

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let controlDatabase: ControlPostgresDatabase
let registryStore: PostgresComponentRegistryStore
let profileStore: PostgresProfileStore
let registry: ComponentRegistry
let resolver: ProfileResolver
let exporter: IndustryPackExportService
let upgrader: IndustryPackUpgradeService
let catalogue: InMemoryIndustryPackCatalogue

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function runtimeUpgrade(target: UpgradeRequest['targetRef']): UpgradeRequest {
  return {
    scopeRef: SCOPE_A,
    packId: INDUSTRY_REF.id,
    sourceProfileRef: PROFILE_V1,
    targetProfileRef: PROFILE_V2,
    slot: { kind: 'runtime' },
    targetRef: target,
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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'pack-node-41')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'pack-space')
     ON CONFLICT DO NOTHING`,
    [SCOPE_A.tenantId, SCOPE_A.spaceId],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  const control = new ControlPostgresRepository(controlDatabase)
  registryStore = new PostgresComponentRegistryStore(controlDatabase)
  profileStore = new PostgresProfileStore(controlDatabase)

  await seedComponents(registryStore, homeEnergyComponents(), SCOPE_A, PACK_ADMIN_A)

  const definitionService = new SemanticDefinitionService({
    control,
    store: new PostgresSemanticDefinitionStore(controlDatabase),
    now: () => new Date().toISOString(),
  })
  const published = await definitionService.publish(
    { scopeRef: SCOPE_A, ...HOME_ENERGY_DEFINITIONS },
    PACK_ADMIN_A,
  )
  const manifest = buildHomeEnergyManifest(published.ref)

  const industry = new InMemoryIndustryManifestSource()
  industry.register(INDUSTRY_REF, manifest)

  registry = new ComponentRegistry({
    control,
    store: registryStore,
    artifacts: new FakeBlobPort(),
    validator: canonicalManifestValidator(),
    now: () => new Date().toISOString(),
  })
  resolver = new ProfileResolver({
    control,
    store: profileStore,
    registry: registryStore,
    industry,
    validator: canonicalProfileValidator(),
    now: () => new Date().toISOString(),
  })

  catalogue = new InMemoryIndustryPackCatalogue()
  catalogue.registerPack({ ref: INDUSTRY_REF, manifest, testSuite: homeEnergyTestSuite() })
  catalogue.registerPreparation(AUTOMOTIVE_PREPARATION)
  catalogue.registerPreparation(HEALTH_SERVICES_PREPARATION)

  exporter = new IndustryPackExportService({ catalogue, definitions: new PostgresSemanticDefinitionStore(controlDatabase) })
  upgrader = new IndustryPackUpgradeService({ profiles: resolver, profileStore, registry, registryStore })
}, 300_000)

afterAll(async () => {
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('industry pack export and upgrade against real PostgreSQL', () => {
  it('exports a portable bundle and scans clean of customer data, decisions and credentials', async () => {
    const bundle = await exporter.export(
      { scopeRef: SCOPE_A, packId: INDUSTRY_REF.id, version: INDUSTRY_REF.version },
      PACK_EDITOR_A,
    )
    expect(bundle.definitions?.objects.map((object) => object.id)).toContain('observation_series')
    expect(bundle.identityPolicy.scopeDimensions.length).toBeGreaterThan(0)
    expect(bundle.mappingTemplates.length).toBeGreaterThan(0)
    expect(bundle.standardProvenance.length).toBeGreaterThan(0)
    expect(bundle.testSuite.ref).toEqual(HOME_ENERGY_TEST_SUITE_REF)
    expect(bundle.testSuite.cases.length).toBeGreaterThan(0)

    expect(findPackExportViolations(bundle)).toEqual([])
    expect(findEmbeddedSecretViolations(bundle)).toEqual([])
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(SCOPE_A.tenantId)
    expect(serialized).not.toContain(SCOPE_A.spaceId)
    expect(serialized).not.toContain('://')
    expect(serialized).not.toContain('synthetic_observation')
    expect(serialized).not.toContain('sourceObjectRef')
  })

  it('gates usability on maturity for registered and preparation packs', async () => {
    const entries = await catalogue.listEntries(SCOPE_A, PACK_EDITOR_A)
    const summaries = entries.map((entry) => summarizePackCatalogEntry(entry))
    const byNamespace = new Map(summaries.map((summary) => [summary.namespace, summary]))
    expect(byNamespace.get('home-energy')?.maturityLabel).toBe('experimental')
    expect(byNamespace.get('home-energy')?.usable).toBe(false)
    expect(byNamespace.get('automotive')?.maturityLabel).toBe('defined')
    expect(byNamespace.get('automotive')?.usable).toBe(false)
    expect(summaries.every((summary) => summary.maturityLabel !== 'validated')).toBe(true)
  })

  it('upgrades a core version for a new profile only and leaves the earlier resolved manifest byte-identical', async () => {
    await resolver.publish(
      { scopeRef: SCOPE_A, profileRef: PROFILE_V1, spec: sampleProfileSpec(), environment: 'local_dev' },
      PACK_EDITOR_A,
    )
    const before = await resolver.preflight({ scopeRef: SCOPE_A, profileRef: PROFILE_V1 }, PACK_EDITOR_A)
    if (before.resolvedProfile === undefined) throw new Error('v1 did not resolve')
    const beforeHash = before.resolvedProfile.snapshotHash
    const beforeRow = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_V1.id, beforeHash],
    )
    const beforeText = beforeRow.rows[0]?.body
    if (beforeText === undefined) throw new Error('the v1 resolved manifest was not persisted')

    await seedComponents(
      registryStore,
      [
        componentRecord({
          kind: 'runtime',
          id: 'runtime-template',
          version: '1.1.0',
          digest: RUNTIME_V2.digest,
          provides: [{ name: 'agent_runtime', version: '1.1.0' }],
        }),
      ],
      SCOPE_A,
      PACK_ADMIN_A,
    )
    const outcome = await upgrader.applyUpgrade(runtimeUpgrade(RUNTIME_V2), PACK_EDITOR_A)
    expect(outcome.status).toBe('applicable')
    expect(outcome.preflightStatus).toBe('resolved')

    const storedV1 = await profileStore.findProfileVersion(PROFILE_V1, SCOPE_A, PACK_EDITOR_A)
    expect(storedV1?.spec.runtimeRef).toEqual(RUNTIME_V1)
    const afterRow = await adminClient.query<{ body: string }>(
      `SELECT resolved_profile::text AS body FROM agent_platform.resolved_profiles
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = $3 AND snapshot_hash = $4`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, PROFILE_V1.id, beforeHash],
    )
    expect(afterRow.rows[0]?.body).toBe(beforeText)

    const storedV2 = await profileStore.findProfileVersion(PROFILE_V2, SCOPE_A, PACK_EDITOR_A)
    expect(storedV2?.spec.runtimeRef).toEqual(RUNTIME_V2)
  })

  it('upgrades to a second, differently shaped source mapping and resolves', async () => {
    const request: UpgradeRequest = {
      scopeRef: SCOPE_A,
      packId: INDUSTRY_REF.id,
      sourceProfileRef: PROFILE_V1,
      targetProfileRef: { id: 'home-energy-demo', version: '3.0.0' },
      slot: { kind: 'mapping', mappingId: 'home-energy.mapping.ha-anker' },
      targetRef: {
        id: TELEMETRY_MAPPING_REF_B.id,
        version: TELEMETRY_MAPPING_REF_B.version,
        digest: TELEMETRY_MAPPING_REF_B.digest,
      },
      targetMappingRef: TELEMETRY_MAPPING_REF_B,
    }
    const outcome = await upgrader.applyUpgrade(request, PACK_EDITOR_A)
    expect(outcome.status).toBe('applicable')
    expect(outcome.preflightStatus).toBe('resolved')

    const stored = await profileStore.findProfileVersion(
      { id: 'home-energy-demo', version: '3.0.0' },
      SCOPE_A,
      PACK_EDITOR_A,
    )
    const telemetry = stored?.spec.mappingRefs.find((mapping) => mapping.role === 'telemetry')
    expect(telemetry?.sourceObjectRef.objectPath).toBe('public.synthetic_observation_b')
  })

  it('refuses to uninstall a version referenced by an active run, then allows it after release', async () => {
    await registry.transition(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, to: 'deprecated' },
      PACK_ADMIN_A,
    )
    await registry.acquireActiveReference(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, runId: RUN_A },
      PACK_RUNNER_A,
    )

    const assessment = await upgrader.assessRetirement(
      { kind: 'runtime', id: 'runtime-template', version: '1.0.0' },
      SCOPE_A,
      PACK_ADMIN_A,
    )
    expect(assessment.status).toBe('blocked')
    const active = assessment.blockers.find((blocker) => blocker.code === 'ACTIVE_REFERENCE_EXISTS')
    expect(active?.recoverable).toBe(true)

    const error = await upgrader
      .retire({ kind: 'runtime', id: 'runtime-template', version: '1.0.0' }, SCOPE_A, PACK_ADMIN_A)
      .then(() => undefined)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(IndustryPackError)
    if (!(error instanceof IndustryPackError)) throw new Error('expected an IndustryPackError')
    expect(error.code).toBe('RETIREMENT_BLOCKED')

    const referenceRows = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.component_active_references
        WHERE tenant_id = $1 AND space_id = $2 AND component_id = 'runtime-template' AND run_id = $3`,
      [SCOPE_A.tenantId, SCOPE_A.spaceId, RUN_A],
    )
    expect(referenceRows.rows[0]?.count).toBe('1')

    await registry.releaseActiveReference(
      { scopeRef: SCOPE_A, kind: 'runtime', ref: RUNTIME_V1, runId: RUN_A },
      PACK_RUNNER_A,
    )
    const retired = await upgrader.retire(
      { kind: 'runtime', id: 'runtime-template', version: '1.0.0' },
      SCOPE_A,
      PACK_ADMIN_A,
    )
    expect(retired.lifecycleState).toBe('retired')
  })

  it('keeps the export inside the tenant/space boundary', async () => {
    const otherTenant = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const otherScope = { tenantId: otherTenant, spaceId: SCOPE_A.spaceId }
    const other = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['profile-editor'], 'other-editor')
    await expect(
      exporter.export({ scopeRef: otherScope, packId: INDUSTRY_REF.id, version: INDUSTRY_REF.version }, other),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })
})
