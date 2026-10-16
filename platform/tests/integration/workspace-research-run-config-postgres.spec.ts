import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAssetWorkspaceStore,
  PostgresComponentRegistryStore,
  PostgresJobStore,
  PostgresProfileStore,
  PostgresWorkspaceResearchRunConfigStore,
} from '@ontology/adapter-control-postgres'
import { IndustryWorkspaceService, ProfileResolver, WorkspaceResearchRunConfigService } from '@ontology/application'
import {
  isWorkspaceResearchProfileRef,
  workspaceIdOfResearchProfileRef,
} from '@ontology/contracts'
import type {
  ResourceRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const RUNTIME_REF: VersionRef = { id: 'runtime-pi', version: 'pi-runtime@1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const POLICY_REF: VersionRef = { id: 'core-local-policy', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let ctx: ToolContext
let otherCtx: ToolContext
let workspaceService: IndustryWorkspaceService
let configService: WorkspaceResearchRunConfigService
let profileResolver: ProfileResolver

function resourceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'document' }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'ws-research-config')
  otherScope = await createJobScope(harness.adminClient, 'ws-research-config-other')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['profile-editor'])
  otherCtx = toolContext(otherScope.tenantId, otherScope.spaceId, ['profile-editor'])
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  workspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: new PostgresJobStore(database) })
  configService = new WorkspaceResearchRunConfigService({
    workspaces: workspaceStore,
    configs: new PostgresWorkspaceResearchRunConfigStore(database),
    runtimeRef: RUNTIME_REF,
    policyRef: POLICY_REF,
    toolBindings: [
      { toolId: 'ontology_lookup', enabled: true, maxCallsPerRun: 4 },
      { toolId: 'document_search', enabled: true },
      { toolId: 'web_search', enabled: true },
      { toolId: 'data_query', enabled: false },
    ],
    now: () => '2026-10-16T00:00:00.000Z',
  })
  profileResolver = new ProfileResolver({
    control: new ControlPostgresRepository(database),
    store: new PostgresProfileStore(database),
    registry: new PostgresComponentRegistryStore(database),
    industry: { getManifest: () => Promise.resolve(undefined) },
    validator: () => ({ valid: true, issues: [] }),
    workspaceResearch: configService,
  })
}, 240_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

async function bootstrapWorkspace(): Promise<string> {
  const created = await workspaceService.createWorkspace(
    { namespace: `research-${randomUUID().slice(0, 8)}`, displayName: 'zero-pack research workspace', boundary: { goals: [], included: [], excluded: [], applicability: {} }, documentSetRef: resourceRef() },
    `ws-${randomUUID().slice(0, 12)}`,
    'tester',
    ctx,
  )
  return created.workspace.workspaceId
}

describe('workspace-research run config (real PostgreSQL)', () => {
  it('resolves a config for a workspace with no project, scenario or published industry pack', async () => {
    const workspaceId = await bootstrapWorkspace()
    const config = await configService.resolveForRun({ workspaceId, draftRevision: '1' }, ctx)
    expect(config.schemaVersion).toBe('workspace-research-profile-spec@1')
    expect(config.workspaceId).toBe(workspaceId)
    expect(config.draftRevision).toBe('1')
    expect(config.draftRef).toMatchObject({ id: workspaceId, version: '1' })
    expect(config.toolBindings.find((tool) => tool.toolId === 'web_search')?.enabled).toBe(true)
    expect(config.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('freezes the resolved config: editing the draft never retargets the original revision', async () => {
    const workspaceId = await bootstrapWorkspace()
    const first = await configService.resolveForRun({ workspaceId, draftRevision: '1' }, ctx)
    // Advance the workspace head through the real editor service (a new immutable draft revision).
    const edited = await workspaceService.draftOperation(
      workspaceId,
      { operation: 'edit', expectedRevision: '1', reason: 'add a source', documentSetRef: resourceRef() },
      `edit-${randomUUID().slice(0, 12)}`,
      'tester',
      ctx,
    )
    expect(edited.workspace.headRevision).toBe('2')

    // The original config is immutable: a replay returns the original revision and digest.
    const replay = await configService.resolveForRun({ workspaceId, draftRevision: '1' }, ctx)
    expect(replay).toEqual(first)
    expect(replay.draftRef).toEqual(first.draftRef)

    // The new revision resolves to a distinct config, never the earlier one.
    const second = await configService.resolveForRun({ workspaceId, draftRevision: '2' }, ctx)
    expect(second.draftRevision).toBe('2')
    expect(second.snapshotHash).not.toBe(first.snapshotHash)
  })

  it('keeps tenant/space isolation: another scope cannot resolve the workspace draft', async () => {
    const workspaceId = await bootstrapWorkspace()
    await configService.resolveForRun({ workspaceId, draftRevision: '1' }, ctx)
    await expect(configService.resolveForRun({ workspaceId, draftRevision: '1' }, otherCtx))
      .rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' })
  })

  it('binds a run profile through the profile-resolver branch with no published profile', async () => {
    const workspaceId = await bootstrapWorkspace()
    const binding = await profileResolver.bindWorkspaceResearchRun({ workspaceId, draftRevision: '1' }, scope.scopeRef, ctx)
    expect(isWorkspaceResearchProfileRef(binding.profileRef)).toBe(true)
    expect(workspaceIdOfResearchProfileRef(binding.profileRef)).toBe(workspaceId)
    expect(binding.resolvedProfileHash).toBe(binding.resolvedProfileRef.snapshotHash)
    expect(binding.runtimeRef).toEqual(RUNTIME_REF)
  })
})
