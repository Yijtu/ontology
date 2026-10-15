import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresAssetWorkspaceStore,
  PostgresJobStore,
  PostgresProjectStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { JobService } from '@ontology/application'
import type {
  AssetDraftVersion,
  CreateIndustryWorkspaceInput,
  CreateProjectInput,
  IndustryWorkspace,
  MappingRef,
  NewOutboxMessage,
  ProjectRevision,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { MIGRATIONS_DIR, createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

const MIGRATION_058 = '058_industry_workspace_project_revisions.sql'
const RECORDED_AT: Rfc3339UtcTimestamp = '2026-09-29T00:00:00Z'

let harness: JobDbHarness
let database: ControlPostgresDatabase
let workspaceStore: PostgresAssetWorkspaceStore
let projectStore: PostgresProjectStore
let jobStore: PostgresJobStore
let jobService: JobService
let scope: JobTestScope
let otherScope: JobTestScope
let ctx: ToolContext
let otherCtx: ToolContext
let anchorJobId: Uuid
let otherAnchorJobId: Uuid

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function versionRef(id: string): VersionRef {
  return { id, version: '1.0.0', digest: sha('b') }
}

function resourceRef(id: string): ResourceRef {
  return { id, version: '1.0.0', digest: sha('a'), kind: 'artifact' }
}

function mappingRef(id: string): MappingRef {
  return {
    id,
    version: '1.0.0',
    digest: sha('c'),
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'test', sourceId: 'src-1' }, objectPath: 'records' },
  }
}

function outboxMessage(tag: string): NewOutboxMessage {
  return {
    outboxId: randomUUID(),
    topic: 'project.data.materialize',
    payload: { tag },
    idempotencyKey: `outbox-${tag}-${randomUUID().slice(0, 12)}`,
    availableAt: RECORDED_AT,
    createdAt: RECORDED_AT,
  }
}

function makeWorkspace(workspaceId: string): IndustryWorkspace {
  return {
    workspaceId,
    namespace: 'test.industry',
    displayName: `Workspace ${workspaceId.slice(0, 8)}`,
    boundary: { goals: ['model equipment'], included: ['catalog'], excluded: ['pricing'], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
}

function makeDraft(workspaceId: string, revision: string): AssetDraftVersion {
  return {
    workspaceId,
    revision,
    digest: sha('d'),
    documentSetRef: resourceRef(randomUUID()),
    candidateRefs: [],
  }
}

function makeRevision(projectId: string, revision: string, changeReason = 'initial'): ProjectRevision {
  return {
    ref: { projectId, revision, digest: sha('e') },
    industryPackRef: versionRef('pack-1'),
    definitionRef: versionRef('definition-1'),
    mappingRefs: [mappingRef('mapping-1')],
    profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: sha('f') },
    documentSetRef: resourceRef(randomUUID()),
    semanticPublicationRefs: [],
    sourceVisibilityEpoch: '1',
    changeReason,
  }
}

async function anchorJob(target: ToolContext): Promise<Uuid> {
  const jobId = randomUUID()
  await jobService.createJob(
    {
      jobId,
      kind: 'ingestion',
      sourceRef: 'asset-project-store-test',
      documentRef: randomUUID(),
      pipelineVersion: '1.0.0',
      idempotencyKey: `anchor-${jobId.slice(0, 12)}`,
    },
    target,
  )
  return jobId
}

async function countOutbox(target: ScopeRef, idempotencyKey: string): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.job_outbox
      WHERE tenant_id = $1 AND space_id = $2 AND idempotency_key = $3`,
    [target.tenantId, target.spaceId, idempotencyKey],
  )
  return Number(result.rows[0]?.count ?? '0')
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'asset-project')
  otherScope = await createJobScope(harness.adminClient, 'asset-project-other')
  ctx = toolContext(scope.tenantId, scope.spaceId, ['platform-admin'])
  otherCtx = toolContext(otherScope.tenantId, otherScope.spaceId, ['platform-admin'])

  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 4 })
  workspaceStore = new PostgresAssetWorkspaceStore(database)
  projectStore = new PostgresProjectStore(database)
  jobStore = new PostgresJobStore(database)
  jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  anchorJobId = await anchorJob(ctx)
  otherAnchorJobId = await anchorJob(otherCtx)
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('industry workspace and project revision control stores (real PostgreSQL)', () => {
  it('applies migration 058 additively and keeps an existing workspace readable after re-apply', async () => {
    const workspaceId = randomUUID()
    const createInput: CreateIndustryWorkspaceInput = {
      workspace: makeWorkspace(workspaceId),
      firstDraft: makeDraft(workspaceId, '1'),
      idempotencyKey: `ws-create-${randomUUID().slice(0, 12)}`,
      requestDigest: sha('1'),
      actor: 'tester',
      recordedAt: RECORDED_AT,
      outbox: outboxMessage('ws-create'),
      outboxJobId: anchorJobId,
    }
    const created = await workspaceStore.createWorkspace(createInput, scope.scopeRef, ctx)
    expect(created.created).toBe(true)

    const report = await runControlMigrations({
      connectionString: harness.adminUrl,
      migrationsDir: MIGRATIONS_DIR,
    })
    expect(report.applied).toHaveLength(0)
    expect(report.skipped).toContain(MIGRATION_058)

    const readBack = await workspaceStore.getWorkspace(scope.scopeRef, workspaceId, ctx)
    expect(readBack).toMatchObject({ workspaceId, headRevision: '1', state: 'draft' })
  })

  it('runs workspace create idempotently and CAS-appends append-only draft revisions', async () => {
    const workspaceId = randomUUID()
    const createKey = `ws-key-${randomUUID().slice(0, 12)}`
    const createInput: CreateIndustryWorkspaceInput = {
      workspace: makeWorkspace(workspaceId),
      firstDraft: makeDraft(workspaceId, '1'),
      idempotencyKey: createKey,
      requestDigest: sha('2'),
      actor: 'tester',
      recordedAt: RECORDED_AT,
      outbox: outboxMessage('ws-idem'),
      outboxJobId: anchorJobId,
    }
    const first = await workspaceStore.createWorkspace(createInput, scope.scopeRef, ctx)
    expect(first.created).toBe(true)

    const replay = await workspaceStore.createWorkspace(createInput, scope.scopeRef, ctx)
    expect(replay.created).toBe(false)
    expect(replay.workspace.workspaceId).toBe(workspaceId)

    await expect(
      workspaceStore.createWorkspace(
        { ...createInput, requestDigest: sha('3') },
        scope.scopeRef,
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const appendKey = `ws-append-${randomUUID().slice(0, 12)}`
    const appendInput = {
      expectedRevision: '1',
      draft: makeDraft(workspaceId, '2'),
      idempotencyKey: appendKey,
      requestDigest: sha('4'),
      actor: 'tester',
      recordedAt: RECORDED_AT,
      outbox: outboxMessage('ws-append'),
      outboxJobId: anchorJobId,
    }
    const appended = await workspaceStore.appendDraft(scope.scopeRef, workspaceId, appendInput, ctx)
    expect(appended.created).toBe(true)
    expect(appended.workspace.headRevision).toBe('2')

    const appendReplay = await workspaceStore.appendDraft(scope.scopeRef, workspaceId, appendInput, ctx)
    expect(appendReplay.created).toBe(false)
    expect(appendReplay.draft.revision).toBe('2')

    await expect(
      workspaceStore.appendDraft(
        scope.scopeRef,
        workspaceId,
        { ...appendInput, idempotencyKey: `${appendKey}-x`, requestDigest: sha('5') },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    await expect(
      workspaceStore.appendDraft(
        scope.scopeRef,
        workspaceId,
        {
          ...appendInput,
          expectedRevision: '2',
          idempotencyKey: `${appendKey}-y`,
          draft: makeDraft(workspaceId, '9'),
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'DRAFT_REVISION_INVALID' })

    const drafts = await workspaceStore.listDrafts(scope.scopeRef, workspaceId, ctx)
    expect(drafts.map((draft) => draft.revision)).toEqual(['1', '2'])
  })

  it('writes the outbox in the same transaction as the state change and rolls it back together', async () => {
    const workspaceId = randomUUID()
    const createOutbox = outboxMessage('ws-atomic')
    await workspaceStore.createWorkspace(
      {
        workspace: makeWorkspace(workspaceId),
        firstDraft: makeDraft(workspaceId, '1'),
        idempotencyKey: `ws-atomic-${randomUUID().slice(0, 12)}`,
        requestDigest: sha('6'),
        actor: 'tester',
        recordedAt: RECORDED_AT,
        outbox: createOutbox,
        outboxJobId: anchorJobId,
      },
      scope.scopeRef,
      ctx,
    )
    expect(await countOutbox(scope.scopeRef, createOutbox.idempotencyKey)).toBe(1)

    const failingOutbox = outboxMessage('ws-fail')
    await expect(
      workspaceStore.appendDraft(
        scope.scopeRef,
        workspaceId,
        {
          expectedRevision: '7',
          draft: makeDraft(workspaceId, '8'),
          idempotencyKey: `ws-fail-${randomUUID().slice(0, 12)}`,
          requestDigest: sha('7'),
          actor: 'tester',
          recordedAt: RECORDED_AT,
          outbox: failingOutbox,
          outboxJobId: anchorJobId,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await countOutbox(scope.scopeRef, failingOutbox.idempotencyKey)).toBe(0)
  })

  it('CAS-appends project revisions and keeps field confirmations append-only', async () => {
    const projectId = randomUUID()
    const createKey = `project-create-${randomUUID().slice(0, 12)}`
    const createInput: CreateProjectInput = {
      projectId,
      title: 'Bridge costing project',
      firstRevision: makeRevision(projectId, '1'),
      idempotencyKey: createKey,
      requestDigest: sha('8'),
      actor: 'tester',
      recordedAt: RECORDED_AT,
      outbox: outboxMessage('project-create'),
      outboxJobId: anchorJobId,
    }
    const created = await projectStore.createProject(createInput, scope.scopeRef, ctx)
    expect(created.created).toBe(true)
    expect(created.project.headRevision).toBe('1')

    const replay = await projectStore.createProject(createInput, scope.scopeRef, ctx)
    expect(replay.created).toBe(false)

    await expect(
      projectStore.createProject({ ...createInput, requestDigest: sha('9') }, scope.scopeRef, ctx),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const appended = await projectStore.appendRevision(
      scope.scopeRef,
      projectId,
      {
        expectedRevision: '1',
        revision: makeRevision(projectId, '2', 'mapping changed'),
        idempotencyKey: `project-append-${randomUUID().slice(0, 12)}`,
        requestDigest: sha('a1'),
        actor: 'tester',
        recordedAt: RECORDED_AT,
        outbox: outboxMessage('project-append'),
        outboxJobId: anchorJobId,
      },
      ctx,
    )
    expect(appended.created).toBe(true)
    expect(appended.project.headRevision).toBe('2')
    expect(appended.revision.changeReason).toBe('mapping changed')

    await expect(
      projectStore.appendRevision(
        scope.scopeRef,
        projectId,
        {
          expectedRevision: '1',
          revision: makeRevision(projectId, '2', 'stale'),
          idempotencyKey: `project-stale-${randomUUID().slice(0, 12)}`,
          requestDigest: sha('a2'),
          actor: 'tester',
          recordedAt: RECORDED_AT,
          outbox: outboxMessage('project-stale'),
          outboxJobId: anchorJobId,
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    const revisions = await projectStore.listRevisions(scope.scopeRef, projectId, ctx)
    expect(revisions.map((revision) => revision.ref.revision)).toEqual(['1', '2'])

    const recordId = randomUUID()
    const confirmationKey = `confirm-${randomUUID().slice(0, 12)}`
    const firstConfirmation = await projectStore.appendFieldConfirmation(
      scope.scopeRef,
      projectId,
      {
        recordId,
        fieldId: 'power/0',
        recordRevision: '1',
        contentDigest: sha('b1'),
        status: 'pending',
        sourceRef: resourceRef(randomUUID()),
        eventPayload: { rawValue: '1500' },
        actor: 'tester',
        recordedAt: RECORDED_AT,
        idempotencyKey: confirmationKey,
        requestDigest: sha('b1'),
      },
      ctx,
    )
    expect(firstConfirmation.confirmationRevision).toBe('1')

    const replayedConfirmation = await projectStore.appendFieldConfirmation(
      scope.scopeRef,
      projectId,
      {
        recordId,
        fieldId: 'power/0',
        recordRevision: '1',
        contentDigest: sha('b1'),
        status: 'pending',
        sourceRef: resourceRef(randomUUID()),
        eventPayload: { rawValue: '1500' },
        actor: 'tester',
        recordedAt: RECORDED_AT,
        idempotencyKey: confirmationKey,
        requestDigest: sha('b1'),
      },
      ctx,
    )
    expect(replayedConfirmation.confirmationRevision).toBe('1')

    await expect(
      projectStore.appendFieldConfirmation(
        scope.scopeRef,
        projectId,
        {
          recordId,
          fieldId: 'power/0',
          recordRevision: '1',
          contentDigest: sha('b1'),
          status: 'pending',
          sourceRef: resourceRef(randomUUID()),
          eventPayload: { rawValue: '9999' },
          actor: 'tester',
          recordedAt: RECORDED_AT,
          idempotencyKey: confirmationKey,
          requestDigest: sha('b9'),
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const corrected = await projectStore.appendFieldConfirmation(
      scope.scopeRef,
      projectId,
      {
        recordId,
        fieldId: 'power/0',
        recordRevision: '2',
        contentDigest: sha('b2'),
        status: 'confirmed',
        sourceRef: resourceRef(randomUUID()),
        reason: 'source verified',
        eventPayload: { rawValue: '1500', normalized: '1500' },
        actor: 'reviewer',
        recordedAt: RECORDED_AT,
        idempotencyKey: `confirm-fix-${randomUUID().slice(0, 12)}`,
        requestDigest: sha('b2'),
      },
      ctx,
    )
    expect(corrected.confirmationRevision).toBe('2')

    const events = await projectStore.listFieldConfirmations(scope.scopeRef, projectId, recordId, ctx)
    expect(events.map((event) => event.confirmationRevision)).toEqual(['1', '2'])
    expect(events[1]).toMatchObject({ status: 'confirmed', reason: 'source verified' })
  })

  it('keeps a workspace and project invisible to another scope', async () => {
    const workspaceId = randomUUID()
    await workspaceStore.createWorkspace(
      {
        workspace: makeWorkspace(workspaceId),
        firstDraft: makeDraft(workspaceId, '1'),
        idempotencyKey: `ws-isolation-${randomUUID().slice(0, 12)}`,
        requestDigest: sha('c1'),
        actor: 'tester',
        recordedAt: RECORDED_AT,
        outbox: outboxMessage('ws-isolation'),
        outboxJobId: anchorJobId,
      },
      scope.scopeRef,
      ctx,
    )
    expect(await workspaceStore.getWorkspace(otherScope.scopeRef, workspaceId, otherCtx)).toBeUndefined()
    expect(
      (await workspaceStore.listWorkspaces(otherScope.scopeRef, {}, otherCtx)).some(
        (workspace) => workspace.workspaceId === workspaceId,
      ),
    ).toBe(false)

    await expect(
      workspaceStore.appendDraft(
        otherScope.scopeRef,
        workspaceId,
        {
          expectedRevision: '1',
          draft: makeDraft(workspaceId, '2'),
          idempotencyKey: `ws-isolation-append-${randomUUID().slice(0, 12)}`,
          requestDigest: sha('c2'),
          actor: 'tester',
          recordedAt: RECORDED_AT,
          outbox: outboxMessage('ws-isolation-append'),
          outboxJobId: otherAnchorJobId,
        },
        otherCtx,
      ),
    ).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })

    const projectId = randomUUID()
    await projectStore.createProject(
      {
        projectId,
        title: 'Isolated project',
        firstRevision: makeRevision(projectId, '1'),
        idempotencyKey: `project-isolation-${randomUUID().slice(0, 12)}`,
        requestDigest: sha('c3'),
        actor: 'tester',
        recordedAt: RECORDED_AT,
        outbox: outboxMessage('project-isolation'),
        outboxJobId: anchorJobId,
      },
      scope.scopeRef,
      ctx,
    )
    expect(await projectStore.getProject(otherScope.scopeRef, projectId, otherCtx)).toBeUndefined()
    expect(
      (await projectStore.listProjects(otherScope.scopeRef, {}, otherCtx)).some(
        (project) => project.projectId === projectId,
      ),
    ).toBe(false)
  })

  it('lets exactly one of two concurrent CAS appends win', async () => {
    const workspaceId = randomUUID()
    await workspaceStore.createWorkspace(
      {
        workspace: makeWorkspace(workspaceId),
        firstDraft: makeDraft(workspaceId, '1'),
        idempotencyKey: `ws-race-${randomUUID().slice(0, 12)}`,
        requestDigest: sha('d1'),
        actor: 'tester',
        recordedAt: RECORDED_AT,
        outbox: outboxMessage('ws-race'),
        outboxJobId: anchorJobId,
      },
      scope.scopeRef,
      ctx,
    )

    const attempt = (tag: string) =>
      workspaceStore.appendDraft(
        scope.scopeRef,
        workspaceId,
        {
          expectedRevision: '1',
          draft: makeDraft(workspaceId, '2'),
          idempotencyKey: `ws-race-append-${tag}-${randomUUID().slice(0, 8)}`,
          requestDigest: sha(tag === 'a' ? 'e1' : 'e2'),
          actor: 'tester',
          recordedAt: RECORDED_AT,
          outbox: outboxMessage(`ws-race-${tag}`),
          outboxJobId: anchorJobId,
        },
        ctx,
      )

    const results = await Promise.allSettled([attempt('a'), attempt('b')])
    const fulfilled = results.filter((result) => result.status === 'fulfilled')
    const rejected = results.filter((result) => result.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    const failure = rejected[0]
    expect(failure?.status === 'rejected' ? failure.reason : undefined).toMatchObject({
      code: 'VERSION_CONFLICT',
    })

    const drafts = await workspaceStore.listDrafts(scope.scopeRef, workspaceId, ctx)
    expect(drafts).toHaveLength(2)
    const workspace = await workspaceStore.getWorkspace(scope.scopeRef, workspaceId, ctx)
    expect(workspace?.headRevision).toBe('2')
  })

  it('reads the committed revision back from a fresh pool after a restart', async () => {
    const projectId = randomUUID()
    await projectStore.createProject(
      {
        projectId,
        title: 'Restart project',
        firstRevision: makeRevision(projectId, '1'),
        idempotencyKey: `project-restart-${randomUUID().slice(0, 12)}`,
        requestDigest: sha('f1'),
        actor: 'tester',
        recordedAt: RECORDED_AT,
        outbox: outboxMessage('project-restart'),
        outboxJobId: anchorJobId,
      },
      scope.scopeRef,
      ctx,
    )
    await projectStore.appendRevision(
      scope.scopeRef,
      projectId,
      {
        expectedRevision: '1',
        revision: makeRevision(projectId, '2', 'restart'),
        idempotencyKey: `project-restart-append-${randomUUID().slice(0, 12)}`,
        requestDigest: sha('f2'),
        actor: 'tester',
        recordedAt: RECORDED_AT,
        outbox: outboxMessage('project-restart-append'),
        outboxJobId: anchorJobId,
      },
      ctx,
    )

    const restarted = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 2 })
    try {
      const restartedStore = new PostgresProjectStore(restarted)
      const project = await restartedStore.getProject(scope.scopeRef, projectId, ctx)
      expect(project?.headRevision).toBe('2')
      const revision = await restartedStore.getRevision(scope.scopeRef, projectId, '2', ctx)
      expect(revision?.changeReason).toBe('restart')
      expect(revision?.ref.revision).toBe('2')
    } finally {
      await restarted.close()
    }
  })

  it('rejects a malformed workspace, draft and revision before any SQL runs', async () => {
    const workspaceId = randomUUID()
    await expect(
      workspaceStore.createWorkspace(
        {
          workspace: { ...makeWorkspace(workspaceId), displayName: '' },
          firstDraft: makeDraft(workspaceId, '1'),
          idempotencyKey: `ws-bad-${randomUUID().slice(0, 12)}`,
          requestDigest: sha('11'),
          actor: 'tester',
          recordedAt: RECORDED_AT,
          outbox: outboxMessage('ws-bad'),
          outboxJobId: anchorJobId,
        },
        scope.scopeRef,
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' })

    const projectId = randomUUID()
    await expect(
      projectStore.createProject(
        {
          projectId,
          title: 'Bad revision',
          firstRevision: { ...makeRevision(projectId, '1'), mappingRefs: [] },
          idempotencyKey: `project-bad-${randomUUID().slice(0, 12)}`,
          requestDigest: sha('12'),
          actor: 'tester',
          recordedAt: RECORDED_AT,
          outbox: outboxMessage('project-bad'),
          outboxJobId: anchorJobId,
        },
        scope.scopeRef,
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REVISION' })
  })
})
