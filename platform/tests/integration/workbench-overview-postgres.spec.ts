import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresWorkbenchStateReader,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { WorkbenchOverviewService } from '@ontology/application'
import { createToolContext } from '@ontology/contracts'
import type { ToolContext, WorkbenchCapability } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const RUN_ID = '00000000-0000-4000-8000-00000000000a'
const DIGEST = `sha256:${'a'.repeat(64)}`
const NOW = '2026-10-15T00:00:00Z'

const TENANT_A = randomUUID()
const SPACE_A = randomUUID()
const TENANT_B = randomUUID()
const SPACE_B = randomUUID()
const WORKSPACE_A = randomUUID()
const WORKSPACE_B = randomUUID()
const PROJECT_A = randomUUID()

const CAPABILITIES: readonly WorkbenchCapability[] = [
  { ability: 'generation', available: true },
  { ability: 'research', available: false, unavailableReason: '未配置公共搜索服务' },
]

function context(tenantId: string, spaceId: string, subjectId: string): ToolContext {
  return createToolContext({
    principal: { tenantId, subjectId, roles: ['business-user'], scopes: [], authEpoch: 1 },
    runId: RUN_ID,
    resolvedProfileHash: DIGEST,
    policyVersion: '1.0.0',
    deadline: '2026-10-15T00:10:00Z',
    budgetReservation: { reservationId: randomUUID(), runId: RUN_ID, grantedAt: NOW, expiresAt: '2026-10-15T00:10:00Z' },
    allowedResources: { tenantId, spaceId, resourceKinds: [], sourceRefs: [], collectionRefs: [], domains: [], maxRows: 0 },
    traceId: 'workbench-overview-pg',
  })
}

let container: PostgresContainer | undefined
let adminClient: Client
let database: ControlPostgresDatabase | undefined
let service: WorkbenchOverviewService

const versionRef = { id: 'pack-a', version: '1.0.0', digest: DIGEST }
const resourceRef = (kind: string) => ({ id: randomUUID(), version: '1.0.0', digest: DIGEST, kind })

async function seedTenantsAndSpaces(): Promise<void> {
  await adminClient.query(`INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, $3), ($2, $4)`, [TENANT_A, TENANT_B, `t-${TENANT_A.slice(0, 8)}`, `t-${TENANT_B.slice(0, 8)}`])
  await adminClient.query(`INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'a'), ($3, $4, 'b')`, [TENANT_A, SPACE_A, TENANT_B, SPACE_B])
}

async function seedWorkspace(tenantId: string, spaceId: string, workspaceId: string, state: 'draft' | 'published'): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.industry_workspaces
       (tenant_id, space_id, workspace_id, namespace, display_name, boundary, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4, '{"goals":[],"included":[],"excluded":[],"applicability":{}}'::jsonb, 4, $5, $6, $7, 'seed', $8, $8)`,
    [tenantId, spaceId, workspaceId, `ns-${workspaceId.slice(0, 8)}`, state, `create-${workspaceId}`, DIGEST, NOW],
  )
}

async function seedCandidateSource(tenantId: string, spaceId: string, workspaceId: string, reviewState: 'proposed' | 'approved'): Promise<string> {
  const sourceId = randomUUID()
  await adminClient.query(
    `INSERT INTO agent_platform.candidate_sources
       (tenant_id, space_id, workspace_id, source_id, revision, kind, trust_tier, review_state, origin, content_ref, content_digest, proposed_by, idempotency_key, request_digest, recorded_at, updated_at)
     VALUES ($1, $2, $3, $4, 1, 'web_fetch', 'agent_researched', $5, '{"url":"https://example.org"}'::jsonb, $6::jsonb, $7, 'researcher', $8, $7, $9, $9)`,
    [tenantId, spaceId, workspaceId, sourceId, reviewState, JSON.stringify(resourceRef('artifact')), DIGEST, `source-${sourceId}`, NOW],
  )
  return sourceId
}

async function seedAdmission(tenantId: string, spaceId: string, workspaceId: string, sourceId: string): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.workspace_source_admissions
       (tenant_id, space_id, workspace_id, admission_id, source_id, source_revision, trust_tier, source_ref, parse_id, parser_version, kind, document_set_ref, draft_revision, draft_digest, idempotency_key, request_digest, admitted_by, admitted_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'agent_researched', $6::jsonb, $7, '1.0.0', 'document', $8::jsonb, 2, $9, $10, $9, 'reviewer', $11)`,
    [tenantId, spaceId, workspaceId, randomUUID(), sourceId, JSON.stringify(resourceRef('document')), randomUUID(), JSON.stringify(resourceRef('artifact')), DIGEST, `admit-${sourceId}`, NOW],
  )
}

async function seedDefinitionCandidate(tenantId: string, spaceId: string, workspaceId: string, state: string): Promise<void> {
  const batchId = randomUUID()
  await adminClient.query(
    `INSERT INTO agent_platform.asset_candidate_batches
       (tenant_id, space_id, batch_id, workspace_id, input_draft_ref, model_ref, response_schema_ref, document_set_ref, generation_policy_ref, state, counts, idempotency_key, request_digest, created_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $5::jsonb, $5::jsonb, $5::jsonb, $5::jsonb, 'completed', '{}'::jsonb, $6, $7, 'seed', $8)`,
    [tenantId, spaceId, batchId, workspaceId, JSON.stringify(resourceRef('artifact')), `batch-${batchId}`, DIGEST, NOW],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.asset_candidate_versions
       (tenant_id, space_id, candidate_id, batch_id, workspace_id, logical_id, kind, payload, input_draft_ref, source_refs, source_spans, state, issues, pending_confirmation, content_digest, idempotency_key, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'object', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, $7, '[]'::jsonb, false, $8, $9, $10)`,
    [tenantId, spaceId, randomUUID(), batchId, workspaceId, `object-${randomUUID().slice(0, 8)}`, state, DIGEST, `candidate-${randomUUID()}`, NOW],
  )
}

async function seedProject(tenantId: string, spaceId: string, projectId: string): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.projects
       (tenant_id, space_id, project_id, title, head_revision, state, create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'device inspection', 1, 'active', $4, $5, 'seed', $6, $6)`,
    [tenantId, spaceId, projectId, `project-${projectId}`, DIGEST, NOW],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.project_revisions
       (tenant_id, space_id, project_id, revision, digest, body, source_visibility_epoch, change_reason, idempotency_key, request_digest, actor, recorded_at)
     VALUES ($1, $2, $3, 1, $4, $5::jsonb, 1, 'initial', $6, $4, 'seed', $7)`,
    [tenantId, spaceId, projectId, DIGEST, JSON.stringify({ industryPackRef: versionRef }), `revision-${projectId}`, NOW],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.project_readiness
       (tenant_id, space_id, project_id, project_revision, kind, target_ref, state, completeness, expected_count, processed_count, failed_count, target_digest, fence_revision, idempotency_key, request_digest, actor, recorded_at, available_at)
     VALUES
       ($1, $2, $3, 1, 'dataset', '{}'::jsonb, 'failed', 'partial', 10, 4, 6, $4, 1, $5, $4, 'seed', $6, $6),
       ($1, $2, $3, 1, 'document_index', '{}'::jsonb, 'ready', 'complete', 10, 10, 0, $4, 1, $7, $4, 'seed', $6, $6)`,
    [tenantId, spaceId, projectId, DIGEST, `readiness-dataset-${projectId}`, NOW, `readiness-index-${projectId}`],
  )
  for (let index = 0; index < 2; index += 1) {
    await adminClient.query(
      `INSERT INTO agent_platform.project_record_versions
         (tenant_id, space_id, project_id, record_id, revision, mapping_id, mapping_version, object_id, source_row_key, source_digest, content_digest, body, status, idempotency_key, request_digest, actor, recorded_at)
       VALUES ($1, $2, $3, $4, 1, $5, '1.0.0', 'equipment', $6, $7, $7, '{}'::jsonb, 'pending', $8, $7, 'seed', $9)`,
      [tenantId, spaceId, projectId, randomUUID(), randomUUID(), `row-${index}-${projectId}`, DIGEST, `record-${randomUUID()}`, NOW],
    )
  }
}

async function seedTaskBinding(tenantId: string, spaceId: string): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.published_task_bindings (tenant_id, space_id, task_binding_id, version, digest, binding, registered_at)
     VALUES ($1, $2, 'equipment-check', '1.0.0', $3, '{}'::jsonb, $4)`,
    [tenantId, spaceId, DIGEST, NOW],
  )
}

beforeAll(async () => {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const adminUrl = provided !== undefined && provided.length > 0
    ? provided
    : (container = await startPostgresContainer()).adminUrl
  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await seedTenantsAndSpaces()

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>("SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement", [appPassword])
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const base = new URL(adminUrl)
  const appUrl = `${base.protocol}//ontology_app:${encodeURIComponent(appPassword)}@${base.hostname}:${base.port}/${base.pathname.replace(/^\//, '') || 'postgres'}`

  database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 2 })
  service = new WorkbenchOverviewService({
    state: new PostgresWorkbenchStateReader(database),
    capabilities: { readCapabilities: () => Promise.resolve(CAPABILITIES) },
    now: () => NOW,
  })

  await seedWorkspace(TENANT_A, SPACE_A, WORKSPACE_A, 'draft')
  await seedWorkspace(TENANT_B, SPACE_B, WORKSPACE_B, 'draft')
  await seedCandidateSource(TENANT_A, SPACE_A, WORKSPACE_A, 'proposed')
  await seedCandidateSource(TENANT_A, SPACE_A, WORKSPACE_A, 'proposed')
  const admittedSource = await seedCandidateSource(TENANT_A, SPACE_A, WORKSPACE_A, 'approved')
  await seedCandidateSource(TENANT_A, SPACE_A, WORKSPACE_A, 'approved')
  await seedAdmission(TENANT_A, SPACE_A, WORKSPACE_A, admittedSource)
  await seedDefinitionCandidate(TENANT_A, SPACE_A, WORKSPACE_A, 'produced')
  await seedProject(TENANT_A, SPACE_A, PROJECT_A)
  await seedTaskBinding(TENANT_A, SPACE_A)
}, 300_000)

afterAll(async () => {
  await database?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('PostgresWorkbenchStateReader over real PostgreSQL', () => {
  it('projects the authorized workspace todo deterministically', async () => {
    const overview = await service.readOverview(
      { tenantId: TENANT_A, spaceId: SPACE_A },
      { kind: 'industry_workspace', workspaceId: WORKSPACE_A, revision: '0' },
      context(TENANT_A, SPACE_A, 'reader-a'),
    )
    expect(overview.revision).toBe('4')
    expect(overview.counts).toEqual({
      proposedSources: 2,
      approvedSourcesNotAdmitted: 1,
      candidatesPendingReview: 1,
      recordsPendingConfirmation: 0,
      blockedTasks: 0,
    })
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['confirm_sources', 'admit_sources', 'review_candidates'])
  })

  it('projects the project mounted version, readiness blockers and pending records', async () => {
    const overview = await service.readOverview(
      { tenantId: TENANT_A, spaceId: SPACE_A },
      { kind: 'project', projectId: PROJECT_A, revision: '0' },
      context(TENANT_A, SPACE_A, 'reader-a'),
    )
    expect(overview.counts.recordsPendingConfirmation).toBe(2)
    expect(overview.counts.blockedTasks).toBe(1)
    expect(overview.blockers.map((blocker) => blocker.code)).toEqual(['READINESS_DATASET_FAILED'])
    expect(overview.blockers[0]?.target).toEqual({ kind: 'project', id: PROJECT_A })
    expect(overview.nextSteps.map((step) => step.action)).toEqual(['map_project_data', 'confirm_records'])
  })

  it('projects the scope-wide counts and never leaks another scope', async () => {
    const space = await service.readOverview({ tenantId: TENANT_A, spaceId: SPACE_A }, { kind: 'space' }, context(TENANT_A, SPACE_A, 'reader-a'))
    expect(space.counts).toEqual({
      proposedSources: 2,
      approvedSourcesNotAdmitted: 1,
      candidatesPendingReview: 1,
      recordsPendingConfirmation: 2,
      blockedTasks: 1,
    })

    const otherSpace = await service.readOverview({ tenantId: TENANT_B, spaceId: SPACE_B }, { kind: 'space' }, context(TENANT_B, SPACE_B, 'reader-b'))
    expect(otherSpace.counts).toEqual({
      proposedSources: 0,
      approvedSourcesNotAdmitted: 0,
      candidatesPendingReview: 0,
      recordsPendingConfirmation: 0,
      blockedTasks: 0,
    })

    const crossScope = await service
      .readOverview({ tenantId: TENANT_B, spaceId: SPACE_B }, { kind: 'industry_workspace', workspaceId: WORKSPACE_A, revision: '0' }, context(TENANT_B, SPACE_B, 'reader-b'))
      .catch((error: unknown) => error)
    expect(crossScope).toMatchObject({ name: 'WorkbenchOverviewError', code: 'NOT_FOUND' })
  })
})
