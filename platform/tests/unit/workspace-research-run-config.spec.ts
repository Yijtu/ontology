import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WorkspaceResearchRunConfigService } from '@ontology/application'
import { WorkspaceResearchConfigError } from '@ontology/contracts'
import type {
  AssetDraftVersion,
  IndustryWorkspace,
  IndustryWorkspaceStore,
  ResolvedWorkspaceResearchProfile,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
  WorkspaceResearchRunConfigStore,
} from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const RUNTIME_REF: VersionRef = { id: 'runtime-pi', version: 'pi-runtime@1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const POLICY_REF: VersionRef = { id: 'core-local-policy', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }
const CTX: ToolContext = toolContext()

function draft(workspaceId: Uuid, revision: RevisionString, digestByte: string): AssetDraftVersion {
  return {
    workspaceId,
    revision,
    digest: `sha256:${digestByte.repeat(64)}`,
    documentSetRef: { id: randomUUID(), version: '1', digest: `sha256:${'c'.repeat(64)}`, kind: 'document' },
    candidateRefs: [],
  }
}

/** A minimal workspace store exposing only the draft read the config resolver needs. */
class FakeWorkspaceStore implements IndustryWorkspaceStore {
  readonly drafts = new Map<string, AssetDraftVersion>()
  readonly requested: { workspaceId: Uuid; revision: RevisionString }[] = []

  async getDraft(_scope: ScopeRef, workspaceId: Uuid, revision: RevisionString): Promise<AssetDraftVersion | undefined> {
    this.requested.push({ workspaceId, revision })
    return this.drafts.get(`${workspaceId}:${revision}`)
  }

  createWorkspace(): never { throw new Error('not used') }
  getWorkspace(): Promise<IndustryWorkspace | undefined> { return Promise.resolve(undefined) }
  listWorkspaces(): Promise<IndustryWorkspace[]> { return Promise.resolve([]) }
  listDrafts(): Promise<AssetDraftVersion[]> { return Promise.resolve([...this.drafts.values()]) }
  appendDraft(): never { throw new Error('not used') }
}

/** A write-once in-memory config store mirroring the PostgreSQL store's immutability. */
class FakeConfigStore implements WorkspaceResearchRunConfigStore {
  readonly rows = new Map<string, ResolvedWorkspaceResearchProfile>()

  putResolved(_scope: ScopeRef, config: ResolvedWorkspaceResearchProfile): Promise<ResolvedWorkspaceResearchProfile> {
    const key = `${config.workspaceId}:${config.draftRevision}`
    const existing = this.rows.get(key)
    if (existing !== undefined) {
      if (existing.snapshotHash !== config.snapshotHash) throw new WorkspaceResearchConfigError('VERSION_CONFLICT', 'already fixed')
      return Promise.resolve(existing)
    }
    this.rows.set(key, config)
    return Promise.resolve(config)
  }

  getResolved(_scope: ScopeRef, workspaceId: Uuid, draftRevision: RevisionString): Promise<ResolvedWorkspaceResearchProfile | undefined> {
    return Promise.resolve(this.rows.get(`${workspaceId}:${draftRevision}`))
  }

  findResolvedBySnapshot(_scope: ScopeRef, workspaceId: Uuid, draftRevision: RevisionString, snapshotHash: string): Promise<ResolvedWorkspaceResearchProfile | undefined> {
    return Promise.resolve(this.rows.get(`${workspaceId}:${draftRevision}`)?.['snapshotHash'] === snapshotHash ? this.rows.get(`${workspaceId}:${draftRevision}`) : undefined)
  }
}

function build(): { service: WorkspaceResearchRunConfigService; workspaces: FakeWorkspaceStore; configs: FakeConfigStore } {
  const workspaces = new FakeWorkspaceStore()
  const configs = new FakeConfigStore()
  const service = new WorkspaceResearchRunConfigService({
    workspaces,
    configs,
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
  return { service, workspaces, configs }
}

describe('workspace-research run config', () => {
  it('resolves a config for a workspace with no project, scenario or published pack', async () => {
    const { service, workspaces } = build()
    workspaces.drafts.set(`${WORKSPACE}:1`, draft(WORKSPACE, '1', 'd'))
    const config = await service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '1' }, CTX)
    expect(config.schemaVersion).toBe('workspace-research-profile-spec@1')
    expect(config.workspaceId).toBe(WORKSPACE)
    expect(config.draftRevision).toBe('1')
    expect(config.draftRef).toMatchObject({ id: WORKSPACE, version: '1', digest: `sha256:${'d'.repeat(64)}` })
    expect(config.runtimeRef).toEqual(RUNTIME_REF)
    expect(config.toolBindings.find((tool) => tool.toolId === 'web_search')?.enabled).toBe(true)
    expect(config.toolBindings.find((tool) => tool.toolId === 'data_query')?.enabled).toBe(false)
    expect(config.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('reads the exact requested revision, never the latest head', async () => {
    const { service, workspaces } = build()
    workspaces.drafts.set(`${WORKSPACE}:1`, draft(WORKSPACE, '1', 'd'))
    workspaces.drafts.set(`${WORKSPACE}:2`, draft(WORKSPACE, '2', 'e'))
    const config = await service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '1' }, CTX)
    expect(config.draftRevision).toBe('1')
    expect(config.draftRef.digest).toBe(`sha256:${'d'.repeat(64)}`)
    expect(workspaces.requested).toEqual([{ workspaceId: WORKSPACE, revision: '1' }])
  })

  it('freezes an earlier config: editing the draft never retargets the resolved revision', async () => {
    const { service, workspaces, configs } = build()
    workspaces.drafts.set(`${WORKSPACE}:1`, draft(WORKSPACE, '1', 'd'))
    const first = await service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '1' }, CTX)
    // The workspace head advances to revision 2 with different content.
    workspaces.drafts.set(`${WORKSPACE}:2`, draft(WORKSPACE, '2', 'e'))
    const replay = await service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '1' }, CTX)
    expect(replay).toEqual(first)
    expect(replay.draftRef.digest).toBe(`sha256:${'d'.repeat(64)}`)
    expect(configs.rows.size).toBe(1)
    const second = await service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '2' }, CTX)
    expect(second.draftRevision).toBe('2')
    expect(second.draftRef.digest).toBe(`sha256:${'e'.repeat(64)}`)
    expect(second.snapshotHash).not.toBe(first.snapshotHash)
  })

  it('reports a missing draft revision instead of fabricating an empty config', async () => {
    const { service } = build()
    await expect(service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '9' }, CTX))
      .rejects.toMatchObject({ code: 'DRAFT_NOT_FOUND' })
  })

  it('refuses a malformed workspace id or revision', async () => {
    const { service } = build()
    await expect(service.resolveForRun({ workspaceId: 'not-a-uuid', draftRevision: '1' }, CTX))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
    await expect(service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '-1' }, CTX))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' })
  })

  it('produces a deterministic snapshot hash across independent resolves', async () => {
    const a = build()
    a.workspaces.drafts.set(`${WORKSPACE}:1`, draft(WORKSPACE, '1', 'd'))
    const first = await a.service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '1' }, CTX)
    const b = build()
    b.workspaces.drafts.set(`${WORKSPACE}:1`, draft(WORKSPACE, '1', 'd'))
    const second = await b.service.resolveForRun({ workspaceId: WORKSPACE, draftRevision: '1' }, CTX)
    expect(second.snapshotHash).toBe(first.snapshotHash)
  })
})
