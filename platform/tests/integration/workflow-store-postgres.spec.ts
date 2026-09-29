import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ControlPostgresDatabase, PostgresAnswerStore, PostgresRunStore, PostgresWorkflowStore, runControlMigrations } from '@ontology/adapter-control-postgres'
import { inputManifestDigest } from '@ontology/application'
import { sha256DigestOf } from '@ontology/core'
import type { RunManifest, ToolContext, VerificationRecord, WorkflowInputManifest, WorkflowRunState } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { toolContext } from '../unit/profile-resolver-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROFILE = 'workflow-store-test'
const PROFILE_VERSION = '1.0.0'
const PROFILE_HASH = sha256DigestOf('workflow-store-profile')
const DIGEST = sha256DigestOf('workflow-store-fixture')
const NOW = '2026-09-28T00:00:00Z'
const RUN_ID = '33333333-3333-4333-8333-333333333333'

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//u, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

let container: PostgresContainer | undefined
let adminClient: Client | undefined
let control: ControlPostgresDatabase | undefined
let workflows: PostgresWorkflowStore | undefined
let ctx: ToolContext

beforeAll(async () => {
  container = await startPostgresContainer()
  await runControlMigrations({ connectionString: container.adminUrl, migrationsDir: MIGRATIONS_DIR })
  adminClient = new Client({ connectionString: container.adminUrl })
  await adminClient.connect()
  await adminClient.query(`INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'workflow-store-test')`, [TENANT])
  await adminClient.query(`INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'workflow-store-test')`, [TENANT, SPACE])
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, $6::timestamptz, 'test')`,
    [TENANT, SPACE, PROFILE, PROFILE_VERSION, PROFILE_HASH, NOW],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, $6::timestamptz, $6::timestamptz)`,
    [TENANT, SPACE, PROFILE, PROFILE_VERSION, PROFILE_HASH, NOW],
  )
  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build application login statement')
  await adminClient.query(alterStatement)
  control = new ControlPostgresDatabase({ connectionString: connectionStringFor(container.adminUrl, 'ontology_app', appPassword) })
  const runStore = new PostgresRunStore(control)
  ctx = toolContext(TENANT, SPACE, ['operator'], 'workflow-owner', RUN_ID)
  await runStore.insertRun(
    { tenantId: TENANT, spaceId: SPACE },
    {
      runId: RUN_ID,
      ownerSubjectId: 'workflow-owner',
      profileRef: { id: PROFILE, version: PROFILE_VERSION },
      resolvedProfileHash: PROFILE_HASH,
      runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
      question: 'read the workflow manifest',
      context: { timeZone: 'UTC' },
      preferences: { route: 'template', allowWeb: false },
      idempotencyKey: 'workflow-store-test-key',
      requestDigest: DIGEST,
      createdAt: NOW,
    },
    ctx,
  )
  workflows = new PostgresWorkflowStore(control)
}, 30000)

afterAll(async () => {
  await control?.close()
  await adminClient?.end()
  await container?.stop()
})

describe('PostgresWorkflowStore (migration 052, tenant scope and CAS)', () => {
  it('persists immutable manifests, exact verification records, and CAS state across reads', async () => {
    if (workflows === undefined) throw new Error('workflow store was not initialised')
    const input: WorkflowInputManifest = {
      manifestId: randomUUID(),
      runId: RUN_ID,
      revision: '1',
      entries: [],
      digest: inputManifestDigest(RUN_ID, []),
    }
    await expect(workflows.saveInputManifest({ ...input, revision: '5' }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(workflows.saveInputManifest(input, ctx)).resolves.toEqual(input)
    await expect(workflows.saveInputManifest(input, ctx)).resolves.toEqual(input)
    const nextInput: WorkflowInputManifest = {
      ...input,
      revision: '2',
      entries: [{ entryId: randomUUID(), kind: 'clarification', label: 'answer', addedInPhase: 'collecting', recordedAt: NOW }],
    }
    const nextWithDigest = { ...nextInput, digest: inputManifestDigest(RUN_ID, nextInput.entries) }
    await expect(workflows.saveInputManifest(nextWithDigest, ctx)).resolves.toEqual(nextWithDigest)
    await expect(workflows.saveInputManifest({ ...nextWithDigest, digest: DIGEST }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const manifest: RunManifest = {
      runId: RUN_ID,
      resolvedProfileRef: { id: PROFILE, version: PROFILE_VERSION, snapshotHash: PROFILE_HASH },
      runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
      budgetLedgerId: randomUUID(),
      inputManifestId: input.manifestId,
      createdAt: NOW,
    }
    await expect(workflows.saveRunManifest(manifest, ctx)).resolves.toEqual(manifest)
    await expect(workflows.saveRunManifest(manifest, ctx)).resolves.toEqual(manifest)
    await expect(workflows.saveRunManifest({ ...manifest, budgetLedgerId: randomUUID() }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const initialState: WorkflowRunState = {
      runId: RUN_ID,
      revision: '1',
      draftAttempts: 0,
      recheckCount: 0,
      staleEntryIds: [],
      usageUnknown: false,
      limitedResultAttempted: false,
      updatedAt: NOW,
    }
    await expect(workflows.saveRunState(initialState, '0', ctx)).resolves.toEqual(initialState)
    await expect(workflows.saveRunState(initialState, '0', ctx)).resolves.toEqual(initialState)
    const state2 = { ...initialState, revision: '2', draftAttempts: 1 }
    await expect(workflows.saveRunState(state2, '1', ctx)).resolves.toEqual(state2)
    await expect(workflows.saveRunState({ ...state2, usageUnknown: true }, '1', ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(workflows.getRunState(RUN_ID, ctx)).resolves.toEqual(state2)

    const record: VerificationRecord = {
      runId: RUN_ID,
      verification: {
        verificationId: randomUUID(),
        draftHash: DIGEST,
        evidenceManifestHash: input.digest,
        verdict: 'pass',
        failedChecks: [],
        policyVersion: 'verification-policy@1',
        verifiedAt: NOW,
        supportedAssertionIds: [],
      },
    }
    await workflows.record(record, ctx)
    await workflows.record(record, ctx)
    await expect(workflows.find(record.verification.verificationId, ctx)).resolves.toEqual(record)
    await expect(workflows.record({ ...record, runId: RUN_ID, verification: { ...record.verification, verdict: 'fail' } }, ctx)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const other = toolContext('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ['operator'], 'other-owner', RUN_ID)
    await expect(workflows.getRunManifest(RUN_ID, other)).resolves.toBeUndefined()
    await expect(workflows.getRunState(RUN_ID, other)).resolves.toBeUndefined()
  }, 30000)

  it('marks legacy metadata-only answer rows as body unavailable', async () => {
    if (adminClient === undefined || control === undefined) throw new Error('test database was not initialised')
    const answerId = randomUUID()
    await adminClient.query(
      `INSERT INTO agent_platform.answer_publications
         (tenant_id, space_id, run_id, answer_id, draft_id, verification_id, content_hash,
          evidence_manifest_hash, scenario_manifest_hash, publication_kind, as_of, limitations, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7, 'verified', NULL, '[]'::jsonb, $8::timestamptz)`,
      [TENANT, SPACE, RUN_ID, answerId, randomUUID(), randomUUID(), DIGEST, NOW],
    )
    const answers = new PostgresAnswerStore(control)
    const answer = await answers.findByRun(RUN_ID, ctx)
    expect(answer?.answerId).toBe(answerId)
    expect(answer?.body).toBeUndefined()
    expect(answer?.bodyUnavailableReason).toBe('legacy_metadata_only')
  }, 30000)
})
