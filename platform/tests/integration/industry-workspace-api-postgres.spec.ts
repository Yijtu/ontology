import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import {
  ControlPostgresDatabase,
  PostgresAssetWorkspaceStore,
  PostgresJobStore,
} from '@ontology/adapter-control-postgres'
import { IndustryWorkspaceService } from '@ontology/application'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import type { ResourceRef } from '@ontology/contracts'
import { createAjv, expectValid, validator } from '../contracts/helpers'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

vi.setConfig({ testTimeout: 120_000 })

const DIGEST = `sha256:${'a'.repeat(64)}`

let harness: JobDbHarness
let database: ControlPostgresDatabase
let scope: JobTestScope
let otherScope: JobTestScope
let app: ReturnType<typeof createApiServer>
let validateWorkspace: ValidateFunction
let validateDraft: ValidateFunction

/**
 * A test authenticator that turns request headers into a trusted principal, standing in for the
 * server-side OIDC authenticator. Identity and scope are never read from the JSON body.
 */
function authenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles =
    typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : ['profile-editor']
  const rawScope = request.headers['x-test-scope']
  const scopeValue = Array.isArray(rawScope) ? rawScope[0] : rawScope
  const chosen = scopeValue === 'other' ? otherScope : scope
  return {
    principal: {
      tenantId: chosen.tenantId,
      subjectId: subject,
      roles,
      scopes: [],
      authEpoch: 1,
    },
    spaceId: chosen.spaceId,
  }
}

interface CallOptions {
  readonly body?: object
  readonly roles?: string
  readonly subject?: string | null
  readonly scope?: 'primary' | 'other'
  readonly ifMatch?: string
  readonly idempotencyKey?: string
}

function headersOf(options: CallOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-test-roles': options.roles ?? 'profile-editor',
    'x-test-scope': options.scope ?? 'primary',
  }
  if (options.subject !== null) headers['x-test-subject'] = options.subject ?? 'editor-1'
  if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch
  headers['idempotency-key'] = options.idempotencyKey ?? `idem-${randomUUID()}`
  return headers
}

async function post(url: string, options: CallOptions = {}) {
  return app.inject({
    method: 'POST',
    url,
    headers: headersOf(options),
    ...(options.body === undefined ? {} : { payload: options.body }),
  })
}

async function patch(url: string, options: CallOptions = {}) {
  return app.inject({
    method: 'PATCH',
    url,
    headers: headersOf(options),
    ...(options.body === undefined ? {} : { payload: options.body }),
  })
}

async function get(url: string, options: CallOptions = {}) {
  return app.inject({ method: 'GET', url, headers: headersOf(options) })
}

function resourceRef(id: string = randomUUID()): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
}

function boundary(goals: readonly string[]): {
  goals: readonly string[]
  included: readonly string[]
  excluded: readonly string[]
  applicability: { region: string }
} {
  return {
    goals,
    included: ['equipment-catalog'],
    excluded: ['pricing'],
    applicability: { region: 'CN' },
  }
}

interface CreatedWorkspace {
  readonly workspaceId: string
  readonly revision: string
}

async function createWorkspace(
  overrides: Partial<{
    namespace: string
    displayName: string
    goals: readonly string[]
    documentSetRef: ResourceRef
    idempotencyKey: string
  }> = {},
): Promise<CreatedWorkspace> {
  const response = await post('/api/v1/industry-workspaces', {
    ...(overrides.idempotencyKey === undefined ? {} : { idempotencyKey: overrides.idempotencyKey }),
    body: {
      namespace: overrides.namespace ?? 'test-industry',
      displayName: overrides.displayName ?? 'Transport equipment workspace',
      boundary: boundary(overrides.goals ?? ['model equipment maintenance']),
      documentSetRef: overrides.documentSetRef ?? resourceRef(),
    },
  })
  expect(response.statusCode).toBe(201)
  const data = response.json().data as {
    workspace: { workspaceId: string; headRevision: string }
    draftRef: { revision: string }
  }
  expectValid(validateWorkspace, data.workspace, 'created workspace')
  return { workspaceId: data.workspace.workspaceId, revision: data.draftRef.revision }
}

async function rowCount(): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.industry_workspaces
      WHERE tenant_id = $1 AND space_id = $2`,
    [scope.tenantId, scope.spaceId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

async function anchorJobCount(): Promise<number> {
  const result = await harness.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.jobs
      WHERE tenant_id = $1 AND space_id = $2 AND source_ref = 'industry-workspace-anchor'`,
    [scope.tenantId, scope.spaceId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'workspace-api')
  otherScope = await createJobScope(harness.adminClient, 'workspace-api-other')
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 6 })
  const workspaceStore = new PostgresAssetWorkspaceStore(database)
  const jobs = new PostgresJobStore(database)
  const service = new IndustryWorkspaceService({
    store: workspaceStore,
    jobs,
    newId: () => randomUUID(),
  })
  app = createApiServer({
    authenticate: authenticator,
    industryWorkspaces: { service },
  })
  await app.ready()
  const ajv: Ajv2020 = createAjv()
  validateWorkspace = validator(ajv, 'asset-workspace.schema.json', 'IndustryWorkspace')
  validateDraft = validator(ajv, 'asset-workspace.schema.json', 'AssetDraftVersion')
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close().catch(() => undefined)
  await harness?.stop()
})

describe('industry workspace draft management API (real PostgreSQL)', () => {
  it('creates a workspace with its first draft and reads it back consistently on refresh', async () => {
    const before = await rowCount()
    const created = await createWorkspace({ goals: ['inspect bridges'] })
    expect(await rowCount()).toBe(before + 1)

    const read = await get(`/api/v1/industry-workspaces/${created.workspaceId}`)
    expect(read.statusCode).toBe(200)
    const readBody = read.json() as {
      data: { workspace: { displayName: string; headRevision: string; boundary: { goals: string[] } } }
      meta: { revision: string }
    }
    expect(readBody.data.workspace.displayName).toBe('Transport equipment workspace')
    expect(readBody.data.workspace.boundary.goals).toEqual(['inspect bridges'])
    expect(readBody.meta.revision).toBe('1')
    expectValid(validateWorkspace, readBody.data.workspace, 'read workspace')

    const drafts = await get(`/api/v1/industry-workspaces/${created.workspaceId}/drafts`)
    expect(drafts.statusCode).toBe(200)
    const draftBodies = (drafts.json() as { data: { drafts: unknown[] } }).data.drafts
    expect(draftBodies).toHaveLength(1)

    const one = await get(`/api/v1/industry-workspaces/${created.workspaceId}/drafts/1`)
    expect(one.statusCode).toBe(200)
    const draft = (one.json() as { data: { draft: unknown } }).data.draft
    expectValid(validateDraft, draft, 'draft revision 1')
    expect((draft as { revision: string }).revision).toBe('1')

    const missing = await get(`/api/v1/industry-workspaces/${created.workspaceId}/drafts/9`)
    expect(missing.statusCode).toBe(404)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('DRAFT_NOT_FOUND')
  })

  it('replays an idempotent create and rejects a conflicting payload with 409', async () => {
    const key = `ws-idem-${randomUUID()}`
    const body = {
      namespace: 'test-industry',
      displayName: 'Idempotent workspace',
      boundary: boundary(['idempotent goal']),
      documentSetRef: resourceRef(),
    }
    const first = await post('/api/v1/industry-workspaces', { idempotencyKey: key, body })
    expect(first.statusCode).toBe(201)
    const firstId = (first.json() as { data: { workspace: { workspaceId: string } } }).data.workspace.workspaceId

    const replay = await post('/api/v1/industry-workspaces', { idempotencyKey: key, body })
    expect(replay.statusCode).toBe(201)
    const replayBody = replay.json() as { data: { workspace: { workspaceId: string }; created: boolean } }
    expect(replayBody.data.workspace.workspaceId).toBe(firstId)
    expect(replayBody.data.created).toBe(false)

    const conflict = await post('/api/v1/industry-workspaces', {
      idempotencyKey: key,
      body: { ...body, displayName: 'A different payload' },
    })
    expect(conflict.statusCode).toBe(409)
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('rejects a malformed boundary and a missing idempotency key without writing a row', async () => {
    const before = await rowCount()
    const malformed = await post('/api/v1/industry-workspaces', {
      body: {
        namespace: 'test-industry',
        displayName: 'Bad boundary',
        boundary: { goals: 'not-an-array', included: [], excluded: [], applicability: {} },
        documentSetRef: resourceRef(),
      },
    })
    expect(malformed.statusCode).toBe(400)
    expect((malformed.json() as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
    expect(await rowCount()).toBe(before)

    const extraKey = await post('/api/v1/industry-workspaces', {
      body: {
        namespace: 'test-industry',
        displayName: 'Unknown boundary key',
        boundary: { ...boundary(['x']), unexpected: 'nope' },
        documentSetRef: resourceRef(),
      },
    })
    expect(extraKey.statusCode).toBe(400)
    expect(await rowCount()).toBe(before)

    const noKey = await app.inject({
      method: 'POST',
      url: '/api/v1/industry-workspaces',
      headers: { 'content-type': 'application/json', 'x-test-subject': 'editor-1', 'x-test-roles': 'profile-editor' },
      payload: {
        namespace: 'test-industry',
        displayName: 'No key',
        boundary: boundary(['x']),
        documentSetRef: resourceRef(),
      },
    })
    expect(noKey.statusCode).toBe(400)
    expect(await rowCount()).toBe(before)
  })

  it('returns 401 without trusted authentication and 403 for an ordinary project user', async () => {
    const unauthenticated = await get('/api/v1/industry-workspaces', { subject: null })
    expect(unauthenticated.statusCode).toBe(401)
    expect((unauthenticated.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED')

    const forbiddenRead = await get('/api/v1/industry-workspaces', { roles: 'business-user' })
    expect(forbiddenRead.statusCode).toBe(200)

    const forbiddenCreate = await post('/api/v1/industry-workspaces', {
      roles: 'business-user',
      body: {
        namespace: 'test-industry',
        displayName: 'Ordinary user',
        boundary: boundary(['x']),
        documentSetRef: resourceRef(),
      },
    })
    expect(forbiddenCreate.statusCode).toBe(403)
    expect((forbiddenCreate.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN')
  })

  it('edits the boundary/name via If-Match CAS and appends an immutable draft revision', async () => {
    const created = await createWorkspace({ goals: ['old goal'] })
    const edited = await patch(`/api/v1/industry-workspaces/${created.workspaceId}`, {
      ifMatch: '1',
      body: { displayName: 'Renamed workspace', boundary: boundary(['new goal']), reason: 'clarified scope' },
    })
    expect(edited.statusCode).toBe(200)
    const data = edited.json() as {
      data: { workspace: { displayName: string; headRevision: string; boundary: { goals: string[] } }; changes: string[] }
    }
    expect(data.data.workspace.headRevision).toBe('2')
    expect(data.data.workspace.displayName).toBe('Renamed workspace')
    expect(data.data.workspace.boundary.goals).toEqual(['new goal'])
    expect(data.data.changes).toContain('displayName')
    expect(data.data.changes).toContain('boundary')
    expectValid(validateWorkspace, data.data.workspace, 'edited workspace')

    const refreshed = await get(`/api/v1/industry-workspaces/${created.workspaceId}`)
    expect((refreshed.json() as { data: { workspace: { displayName: string; headRevision: string } } }).data.workspace)
      .toMatchObject({ displayName: 'Renamed workspace', headRevision: '2' })

    const drafts = await get(`/api/v1/industry-workspaces/${created.workspaceId}/drafts`)
    expect(
      (drafts.json() as { data: { drafts: { revision: string }[] } }).data.drafts.map((d) => d.revision),
    ).toEqual(['1', '2'])
  })

  it('replays an idempotent edit after the head advanced without a false conflict', async () => {
    const created = await createWorkspace()
    const key = `ws-edit-idem-${randomUUID()}`
    const body = { displayName: 'Idempotent edit', reason: 'idempotent' }
    const first = await patch(`/api/v1/industry-workspaces/${created.workspaceId}`, {
      ifMatch: '1',
      idempotencyKey: key,
      body,
    })
    expect(first.statusCode).toBe(200)
    expect((first.json() as { data: { workspace: { headRevision: string } } }).data.workspace.headRevision).toBe('2')

    const replay = await patch(`/api/v1/industry-workspaces/${created.workspaceId}`, {
      ifMatch: '1',
      idempotencyKey: key,
      body,
    })
    expect(replay.statusCode).toBe(200)
    const replayBody = replay.json() as {
      data: { workspace: { headRevision: string }; draftRef: { revision: string }; created: boolean }
    }
    expect(replayBody.data.workspace.headRevision).toBe('2')
    expect(replayBody.data.draftRef.revision).toBe('2')
    expect(replayBody.data.created).toBe(false)
  })

  it('localises a stale edit as 409 VERSION_CONFLICT and requires If-Match with 428', async () => {
    const created = await createWorkspace()
    const firstEdit = await patch(`/api/v1/industry-workspaces/${created.workspaceId}`, {
      ifMatch: '1',
      body: { displayName: 'Head 2', reason: 'first' },
    })
    expect(firstEdit.statusCode).toBe(200)

    const stale = await patch(`/api/v1/industry-workspaces/${created.workspaceId}`, {
      ifMatch: '1',
      body: { displayName: 'Loser', reason: 'stale' },
    })
    expect(stale.statusCode).toBe(409)
    const staleBody = stale.json() as { error: { code: string; reasons?: string[] } }
    expect(staleBody.error.code).toBe('VERSION_CONFLICT')
    expect(staleBody.error.reasons).toEqual(['expectedRevision=1', 'currentRevision=2'])

    const noHeader = await patch(`/api/v1/industry-workspaces/${created.workspaceId}`, {
      body: { displayName: 'No match', reason: 'missing header' },
    })
    expect(noHeader.statusCode).toBe(428)
    expect((noHeader.json() as { error: { code: string } }).error.code).toBe('REVISION_REQUIRED')
  })

  it('refuses to publish a definition through the workspace edit surface', async () => {
    const created = await createWorkspace()
    const publish = await patch(`/api/v1/industry-workspaces/${created.workspaceId}`, {
      ifMatch: '1',
      body: { state: 'published', reason: 'publish it' },
    })
    expect(publish.statusCode).toBe(400)
    expect((publish.json() as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')

    const operation = await post(`/api/v1/industry-workspaces/${created.workspaceId}/draft-operations`, {
      ifMatch: '1',
      body: { operation: 'publish', reason: 'publish it' },
    })
    expect(operation.statusCode).toBe(400)
  })

  it('appends a new draft revision with a changed source set and keeps history immutable', async () => {
    const created = await createWorkspace()
    const nextSource = resourceRef()
    const appended = await post(`/api/v1/industry-workspaces/${created.workspaceId}/draft-operations`, {
      ifMatch: '1',
      body: {
        operation: 'edit',
        reason: 'added source set',
        documentSetRef: nextSource,
      },
    })
    expect(appended.statusCode).toBe(200)
    const appendedBody = appended.json() as { data: { workspace: { headRevision: string }; changes: string[] } }
    expect(appendedBody.data.workspace.headRevision).toBe('2')
    expect(appendedBody.data.changes).toContain('documentSetRef')

    const second = await get(`/api/v1/industry-workspaces/${created.workspaceId}/drafts/2`)
    const secondDraft = (second.json() as { data: { draft: { documentSetRef: ResourceRef } } }).data.draft
    expect(secondDraft.documentSetRef).toEqual(nextSource)
    expectValid(validateDraft, secondDraft, 'draft revision 2')

    const first = await get(`/api/v1/industry-workspaces/${created.workspaceId}/drafts/1`)
    const firstDraft = (first.json() as { data: { draft: { documentSetRef: ResourceRef } } }).data.draft
    expect(firstDraft.documentSetRef).not.toEqual(nextSource)
  })

  it('anchors every workspace write to one idempotent job rather than a job per request', async () => {
    const before = await anchorJobCount()
    await createWorkspace()
    await createWorkspace()
    expect(await anchorJobCount()).toBe(before)
    expect(before).toBe(1)
  })

  it('keeps a workspace invisible to another scope', async () => {
    const created = await createWorkspace()
    const crossScope = await get(`/api/v1/industry-workspaces/${created.workspaceId}`, { scope: 'other' })
    expect(crossScope.statusCode).toBe(404)
    expect((crossScope.json() as { error: { code: string } }).error.code).toBe('WORKSPACE_NOT_FOUND')

    const crossAppend = await patch(`/api/v1/industry-workspaces/${created.workspaceId}`, {
      scope: 'other',
      ifMatch: '1',
      body: { displayName: 'Hijack', reason: 'cross scope' },
    })
    expect(crossAppend.statusCode).toBe(404)
  })
})
