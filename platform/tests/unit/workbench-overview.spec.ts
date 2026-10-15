import { describe, expect, it } from 'vitest'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { WorkbenchOverviewService } from '@ontology/application'
import { createToolContext, isSha256Digest } from '@ontology/contracts'
import type {
  ProjectReadinessKind,
  ProjectReadinessState,
  ScopeRef,
  ToolContext,
  WorkbenchCapability,
  WorkbenchCapabilitySource,
  WorkbenchProjectState,
  WorkbenchReadinessSummary,
  WorkbenchSpaceState,
  WorkbenchStateReader,
  WorkbenchSubject,
  WorkbenchWorkspaceState,
} from '@ontology/contracts'

const SCOPE: ScopeRef = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}
const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'
const DIGEST = `sha256:${'a'.repeat(64)}`

function context(scope: ScopeRef = SCOPE): ToolContext {
  return createToolContext({
    principal: { tenantId: scope.tenantId, subjectId: 'overview-reader', roles: ['business-user'], scopes: [], authEpoch: 1 },
    runId: '33333333-3333-4333-8333-333333333333',
    resolvedProfileHash: DIGEST,
    policyVersion: '1.0.0',
    deadline: '2026-10-15T00:05:00Z',
    budgetReservation: { reservationId: '44444444-4444-4444-8444-444444444444', runId: '33333333-3333-4333-8333-333333333333', grantedAt: '2026-10-15T00:00:00Z', expiresAt: '2026-10-15T00:05:00Z' },
    allowedResources: { tenantId: scope.tenantId, spaceId: scope.spaceId, resourceKinds: [], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 100 },
    traceId: 'workbench-overview-test',
  })
}

function workspaceState(overrides: Partial<WorkbenchWorkspaceState> = {}): WorkbenchWorkspaceState {
  return {
    workspaceId: WORKSPACE_ID,
    revision: '7',
    state: 'draft',
    sourceCount: 0,
    proposedSourceCount: 0,
    approvedSourceCount: 0,
    admittedSourceCount: 0,
    candidateCount: 0,
    candidatesPendingReview: 0,
    validationSatisfied: false,
    ...overrides,
  }
}

function projectState(overrides: Partial<WorkbenchProjectState> = {}): WorkbenchProjectState {
  return {
    projectId: PROJECT_ID,
    revision: '3',
    recordsPendingConfirmation: 0,
    readiness: [],
    availableTaskCount: 0,
    ...overrides,
  }
}

function readiness(kind: ProjectReadinessKind, state: ProjectReadinessState, overrides: Partial<WorkbenchReadinessSummary> = {}): WorkbenchReadinessSummary {
  return { kind, state, retryable: state !== 'revoked', ...overrides }
}

class FakeStateReader implements WorkbenchStateReader {
  constructor(
    private readonly options: {
      readonly space?: WorkbenchSpaceState
      readonly workspace?: WorkbenchWorkspaceState
      readonly project?: WorkbenchProjectState
    },
  ) {}

  readSpaceState(): Promise<WorkbenchSpaceState> {
    return Promise.resolve(this.options.space ?? { workspaceCount: 0, projectCount: 0, proposedSources: 0, approvedSourcesNotAdmitted: 0, candidatesPendingReview: 0, recordsPendingConfirmation: 0, blockedTasks: 0 })
  }

  readWorkspaceState(): Promise<WorkbenchWorkspaceState | undefined> {
    return Promise.resolve(this.options.workspace)
  }

  readProjectState(): Promise<WorkbenchProjectState | undefined> {
    return Promise.resolve(this.options.project)
  }
}

const CAPABILITIES: readonly WorkbenchCapability[] = [
  { ability: 'generation', available: true },
  { ability: 'research', available: false, unavailableReason: '未配置公共搜索服务' },
]

const capabilitySource = (capabilities: readonly WorkbenchCapability[] = CAPABILITIES): WorkbenchCapabilitySource => ({
  readCapabilities: () => Promise.resolve(capabilities),
})

function service(reader: WorkbenchStateReader, now?: () => string, capabilities = capabilitySource()): WorkbenchOverviewService {
  return new WorkbenchOverviewService({ state: reader, capabilities, ...(now === undefined ? {} : { now }) })
}

const WORKSPACE_SUBJECT: WorkbenchSubject = { kind: 'industry_workspace', workspaceId: WORKSPACE_ID, revision: '0' }
const PROJECT_SUBJECT: WorkbenchSubject = { kind: 'project', projectId: PROJECT_ID, revision: '0' }

describe('WorkbenchOverviewService — deterministic workspace todo', () => {
  it('selects a source when the workspace has none', async () => {
    const overview = await service(new FakeStateReader({ workspace: workspaceState() })).readOverview(SCOPE, WORKSPACE_SUBJECT, context())
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['choose_source'])
    expect(overview.subject).toEqual({ kind: 'industry_workspace', workspaceId: WORKSPACE_ID, revision: '7' })
    expect(overview.revision).toBe('7')
  })

  it('refuses a stale expected revision rather than projecting under it', async () => {
    const reader = new FakeStateReader({ workspace: workspaceState({ revision: '7' }) })
    const stale: WorkbenchSubject = { kind: 'industry_workspace', workspaceId: WORKSPACE_ID, revision: '5' }
    const error = await service(reader).readOverview(SCOPE, stale, context()).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ name: 'WorkbenchOverviewError', code: 'INVALID_REQUEST' })
  })

  it('walks confirm -> admit -> generate -> review -> publish in order', async () => {
    const state = workspaceState({
      sourceCount: 5,
      proposedSourceCount: 2,
      approvedSourceCount: 2,
      admittedSourceCount: 1,
      candidateCount: 4,
      candidatesPendingReview: 3,
      validationSatisfied: true,
    })
    const overview = await service(new FakeStateReader({ workspace: state })).readOverview(SCOPE, WORKSPACE_SUBJECT, context())
    expect(overview.nextSteps.map((step) => step.action)).toEqual([
      'confirm_sources',
      'admit_sources',
      'review_candidates',
      'validate_and_publish',
    ])
    expect(overview.counts).toEqual({
      proposedSources: 2,
      approvedSourcesNotAdmitted: 1,
      candidatesPendingReview: 3,
      recordsPendingConfirmation: 0,
      blockedTasks: 0,
    })
    expect(overview.nextSteps.every((step) => step.target?.kind === 'industry_workspace')).toBe(true)
  })

  it('generates candidates once sources are admitted and none exist yet', async () => {
    const state = workspaceState({ sourceCount: 1, approvedSourceCount: 1, admittedSourceCount: 1 })
    const overview = await service(new FakeStateReader({ workspace: state })).readOverview(SCOPE, WORKSPACE_SUBJECT, context())
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['generate_candidates'])
  })

  it('reports a not-found for a workspace outside the scope instead of another scope’s counts', async () => {
    const error = await service(new FakeStateReader({})).readOverview(SCOPE, WORKSPACE_SUBJECT, context()).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ name: 'WorkbenchOverviewError', code: 'NOT_FOUND' })
  })

  it('refuses a requested scope that does not match the trusted principal', async () => {
    const other: ScopeRef = { tenantId: SCOPE.tenantId, spaceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
    const error = await service(new FakeStateReader({ workspace: workspaceState() })).readOverview(other, WORKSPACE_SUBJECT, context()).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ name: 'WorkbenchOverviewError', code: 'SCOPE_MISMATCH' })
  })

  it('pins a deterministic digest that ignores the projection time', async () => {
    const reader = new FakeStateReader({ workspace: workspaceState({ sourceCount: 3, proposedSourceCount: 1 }) })
    const first = await service(reader, () => '2026-10-15T00:00:00Z').readOverview(SCOPE, WORKSPACE_SUBJECT, context())
    const second = await service(reader, () => '2026-10-15T09:30:00Z').readOverview(SCOPE, WORKSPACE_SUBJECT, context())
    expect(isSha256Digest(first.digest)).toBe(true)
    expect(second.digest).toBe(first.digest)
    expect(second.asOf).not.toBe(first.asOf)
  })

  it('rejects an unavailable capability that carries no reason', async () => {
    const bad = capabilitySource([{ ability: 'research', available: false }] as readonly WorkbenchCapability[])
    const error = await service(new FakeStateReader({ workspace: workspaceState() }), undefined, bad)
      .readOverview(SCOPE, WORKSPACE_SUBJECT, context())
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ name: 'WorkbenchOverviewError', code: 'INVALID_REQUEST' })
  })
})

describe('WorkbenchOverviewService — deterministic project todo', () => {
  it('asks to mount a pack when none is mounted', async () => {
    const overview = await service(new FakeStateReader({ project: projectState() })).readOverview(SCOPE, PROJECT_SUBJECT, context())
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['map_project_data'])
  })

  it('returns concrete readiness blockers with a recovery target', async () => {
    const state = projectState({
      mountedPackRef: { id: 'pack-a', version: '1.0.0', digest: DIGEST },
      readiness: [readiness('dataset', 'failed', { retryable: true, errorCode: 'ADAPTER_UNAVAILABLE' }), readiness('document_index', 'revoked')],
    })
    const overview = await service(new FakeStateReader({ project: state })).readOverview(SCOPE, PROJECT_SUBJECT, context())
    expect(overview.counts.blockedTasks).toBe(2)
    expect(overview.blockers).toHaveLength(2)
    const codes = overview.blockers.map((blocker) => blocker.code).sort()
    expect(codes).toEqual(['READINESS_DATASET_FAILED', 'READINESS_DOCUMENT_INDEX_REVOKED'])
    expect(overview.blockers.every((blocker) => blocker.recoveryAction === 'map_project_data')).toBe(true)
    expect(overview.blockers.every((blocker) => blocker.target?.id === PROJECT_ID)).toBe(true)
    expect(overview.blockers.find((blocker) => blocker.code === 'READINESS_DOCUMENT_INDEX_REVOKED')?.retryable).toBe(false)
  })

  it('asks to build project data when no readiness projection exists yet', async () => {
    const state = projectState({ mountedPackRef: { id: 'pack-a', version: '1.0.0', digest: DIGEST } })
    const overview = await service(new FakeStateReader({ project: state })).readOverview(SCOPE, PROJECT_SUBJECT, context())
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['map_project_data'])
  })

  it('asks to run a task once everything is ready', async () => {
    const state = projectState({
      mountedPackRef: { id: 'pack-a', version: '1.0.0', digest: DIGEST },
      readiness: [readiness('dataset', 'ready'), readiness('document_index', 'ready'), readiness('published_semantics', 'ready')],
      availableTaskCount: 3,
    })
    const overview = await service(new FakeStateReader({ project: state })).readOverview(SCOPE, PROJECT_SUBJECT, context())
    expect(overview.blockers).toEqual([])
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['run_task'])
  })

  it('asks to confirm records before running a task', async () => {
    const state = projectState({
      mountedPackRef: { id: 'pack-a', version: '1.0.0', digest: DIGEST },
      readiness: [readiness('dataset', 'ready')],
      recordsPendingConfirmation: 5,
      availableTaskCount: 2,
    })
    const overview = await service(new FakeStateReader({ project: state })).readOverview(SCOPE, PROJECT_SUBJECT, context())
    expect(overview.counts.recordsPendingConfirmation).toBe(5)
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['confirm_records'])
  })
})

describe('WorkbenchOverviewService — space summary', () => {
  it('derives the scope-wide next steps from persisted counts', async () => {
    const space: WorkbenchSpaceState = {
      workspaceCount: 2,
      projectCount: 1,
      proposedSources: 3,
      approvedSourcesNotAdmitted: 1,
      candidatesPendingReview: 0,
      recordsPendingConfirmation: 0,
      blockedTasks: 1,
    }
    const overview = await service(new FakeStateReader({ space })).readOverview(SCOPE, { kind: 'space' }, context())
    expect(overview.summary).toBe('当前空间概览')
    expect(overview.counts.proposedSources).toBe(3)
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['confirm_sources', 'admit_sources', 'map_project_data'])
  })
})

describe('workbench overview HTTP surface', () => {
  function authenticator(request: { headers: Record<string, string | string[] | undefined> }): AuthenticatedRequest | undefined {
    const raw = request.headers['x-test-subject']
    const subject = Array.isArray(raw) ? raw[0] : raw
    if (typeof subject !== 'string' || subject.length === 0) return undefined
    return {
      principal: { tenantId: SCOPE.tenantId, subjectId: subject, roles: ['business-user'], scopes: [], authEpoch: 1 },
      spaceId: SCOPE.spaceId,
    }
  }

  const headers = { 'x-test-subject': 'owner-a' }

  function app(reader: WorkbenchStateReader) {
    return createApiServer({ authenticate: authenticator, workbenchOverview: { overview: service(reader) } })
  }

  it('returns the space, workspace and project projections', async () => {
    const reader = new FakeStateReader({
      space: { workspaceCount: 1, projectCount: 0, proposedSources: 0, approvedSourcesNotAdmitted: 0, candidatesPendingReview: 0, recordsPendingConfirmation: 0, blockedTasks: 0 },
      workspace: workspaceState({ sourceCount: 2, proposedSourceCount: 2 }),
      project: projectState({ mountedPackRef: { id: 'pack-a', version: '1.0.0', digest: DIGEST }, readiness: [readiness('dataset', 'ready')], availableTaskCount: 1 }),
    })
    const server = app(reader)
    const space = await server.inject({ method: 'GET', url: '/api/v1/workbench/overview', headers })
    expect(space.statusCode).toBe(200)
    expect(space.json<{ data: { subject: { kind: string } } }>().data.subject.kind).toBe('space')

    const workspace = await server.inject({ method: 'GET', url: `/api/v1/industry-workspaces/${WORKSPACE_ID}/overview`, headers })
    expect(workspace.statusCode).toBe(200)
    expect(workspace.json<{ data: { revision: string } }>().data.revision).toBe('7')

    const project = await server.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/overview`, headers })
    expect(project.statusCode).toBe(200)
    await server.close()
  })

  it('requires authentication and validates the id', async () => {
    const server = app(new FakeStateReader({ workspace: workspaceState() }))
    const unauthenticated = await server.inject({ method: 'GET', url: '/api/v1/workbench/overview' })
    expect(unauthenticated.statusCode).toBe(401)
    const invalid = await server.inject({ method: 'GET', url: '/api/v1/industry-workspaces/not-a-uuid/overview', headers })
    expect(invalid.statusCode).toBe(400)
    await server.close()
  })

  it('maps a not-found subject to 404', async () => {
    const server = app(new FakeStateReader({}))
    const response = await server.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/overview`, headers })
    expect(response.statusCode).toBe(404)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND')
    await server.close()
  })
})
