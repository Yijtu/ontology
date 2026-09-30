import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
  sha256Digest,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresAnswerStore,
  PostgresEvidenceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  PublicationValidityEngine,
  defaultPublicationEvidenceValidators,
} from '@ontology/application'
import { sha256DigestOf } from '@ontology/core'
import { AnswerStoreError } from '@ontology/contracts'
import type {
  EvidenceEnvelope,
  PublishedAnswer,
  PublicationDependencyPin,
  ResourceRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { SCOPE_A, buildEvidence, ownerContext } from '../unit/verification-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const TENANT_A = SCOPE_A.tenantId
const SPACE_A = SCOPE_A.spaceId
const PROFILE_ID = 'publication-validity-profile'

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let evidenceStore: PostgresEvidenceStore
let answerStore: PostgresAnswerStore

function engine(): PublicationValidityEngine {
  return new PublicationValidityEngine({
    evidence: evidenceStore,
    artifacts: blobStore,
    validators: defaultPublicationEvidenceValidators(),
  })
}

async function archive(kind: EvidenceEnvelope['kind'], payload: unknown, ctx: ToolContext): Promise<ResourceRef> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const contentDigest = sha256Digest(bytes)
  await blobStore.stage(bytes, { scopeRef: SCOPE_A }, ctx)
  const published = await blobStore.publish(
    { scopeRef: SCOPE_A, contentDigest, mediaType: 'application/json', byteSize: bytes.byteLength, purpose: 'artifact' },
    ctx,
  )
  const envelope = buildEvidence({ evidenceId: randomUUID(), payloadRef: published.blobRef, resultDigest: published.blobRef.digest, kind })
  const record = await evidenceStore.record(SCOPE_A, envelope, ctx)
  return record.evidenceRef
}

async function pinOf(ref: ResourceRef, ctx: ToolContext): Promise<PublicationDependencyPin> {
  const record = await evidenceStore.get(SCOPE_A, ref.id, ctx)
  if (record === undefined) throw new Error('the evidence was not recorded')
  return {
    evidenceRef: record.evidenceRef,
    evidenceKind: record.envelope.kind,
    resultDigest: record.envelope.resultDigest,
    envelopeDigest: record.envelopeDigest,
    revision: record.revision,
  }
}

function validityRequest(refs: readonly ResourceRef[], dependencies?: readonly PublicationDependencyPin[]) {
  return {
    runId: randomUUID(),
    runRevision: '1',
    verificationId: randomUUID(),
    evidenceManifestHash: sha256DigestOf('manifest'),
    evidenceRefs: refs,
    verifiedAt: new Date().toISOString(),
    ...(dependencies === undefined ? {} : { dependencies }),
  }
}

async function seedRun(runId: Uuid): Promise<void> {
  await adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, '1.0.0', $4, 'local_dev', '{}'::jsonb, now(), 'publication-validity')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, PROFILE_ID, sha256DigestOf('profile')],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest, resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, '1.0.0', $4, '1.0.0', $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, PROFILE_ID, sha256DigestOf('profile'), sha256DigestOf('profile')],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.runs
       (tenant_id, space_id, run_id, owner_subject_id, profile_id, profile_version, resolved_profile_hash,
        runtime_ref, question, context, preferences, state, revision, idempotency_key, request_digest, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner-a', $4, '1.0.0', $5,
        $6::jsonb,
        'publish?', '{"timeZone":"Asia/Shanghai"}'::jsonb, '{"route":"auto","allowWeb":false}'::jsonb,
        'verifying', 7, $7, $8, now(), now())`,
    [
      TENANT_A,
      SPACE_A,
      runId,
      PROFILE_ID,
      sha256DigestOf('profile'),
      JSON.stringify({ id: 'runtime-template', version: '1.0.0', digest: sha256DigestOf('runtime') }),
      `pub-${runId}`,
      sha256DigestOf('request'),
    ],
  )
}

function answerFor(runId: Uuid, pins: readonly PublicationDependencyPin[] | undefined): PublishedAnswer {
  void pins
  return {
    answerId: randomUUID(),
    runId,
    draftId: randomUUID(),
    verificationId: randomUUID(),
    contentHash: sha256DigestOf(`content:${runId}`),
    evidenceManifestHash: sha256DigestOf('manifest'),
    scenarioManifestHash: sha256DigestOf('scenario'),
    publicationKind: 'verified',
    limitations: [],
    body: { schemaVersion: 'answer-draft@2', blocks: [{ kind: 'summary' }], claims: [], assertions: [] },
    publishedAt: new Date().toISOString(),
  }
}

async function answerRowCount(runId: Uuid): Promise<number> {
  const result = await adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.answer_publications WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
    [TENANT_A, SPACE_A, runId],
  )
  return Number(result.rows[0]?.count ?? '0')
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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'publication-validity') ON CONFLICT DO NOTHING`,
    [TENANT_A],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'publication-validity') ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A],
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

  objectDir = await mkdtemp(join(tmpdir(), 'publication-validity-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  evidenceStore = new PostgresEvidenceStore(controlDatabase)
  answerStore = new PostgresAnswerStore(controlDatabase)
}, 300_000)

afterAll(async () => {
  await registry?.close().catch(() => undefined)
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  if (objectDir !== '') {
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
  }
  await container?.stop()
})

describe('publication validity against a real containerised PostgreSQL', () => {
  it('revalidates every evidence kind and their support against the real evidence archive', async () => {
    const ctx = ownerContext()
    const premise = await archive('observation', { items: [{ kind: 'fact' }] }, ctx)
    const span = await archive('document_span', { textDigest: `sha256:${'a'.repeat(64)}`, quoteDigest: `sha256:${'b'.repeat(64)}` }, ctx)
    const rule = await archive('rule_derivation', {
      schemaVersion: 'rule-computation-artifact@1',
      complete: true,
      premiseRefs: [premise],
    }, ctx)
    const compute = await archive('computation', {
      coverage: { returned: 1, truncated: false },
      dependencyEvidenceRefs: [premise],
    }, ctx)

    const report = await engine().check(validityRequest([premise, span, rule, compute]), ctx)
    expect(report.publishable).toBe(true)
    expect((report.dependencies ?? []).length).toBe(4)
  })

  it('blocks when a transitive premise is retracted and when a pinned version changed', async () => {
    const ctx = ownerContext()
    const premise = await archive('observation', { items: [{ kind: 'fact' }] }, ctx)
    const rule = await archive('rule_derivation', {
      schemaVersion: 'rule-computation-artifact@1',
      complete: true,
      premiseRefs: [premise],
    }, ctx)

    const premisePin = await pinOf(premise, ctx)
    await adminClient.query(
      `UPDATE agent_platform.evidence_records SET revision = revision + 1 WHERE tenant_id = $1 AND space_id = $2 AND evidence_id = $3`,
      [TENANT_A, SPACE_A, premise.id],
    )
    const edited = await engine().check(validityRequest([premise], [premisePin]), ctx)
    expect(edited.publishable).toBe(false)
    expect(edited.blockedReasons).toContain('dependency_edited')

    await adminClient.query(
      `DELETE FROM agent_platform.evidence_records WHERE tenant_id = $1 AND space_id = $2 AND evidence_id = $3`,
      [TENANT_A, SPACE_A, premise.id],
    )
    const retracted = await engine().check(validityRequest([rule]), ctx)
    expect(retracted.publishable).toBe(false)
    expect(retracted.blockedReasons).toContain('evidence_retracted')
  })

  it('records exactly one answer per run and re-checks dependency pins inside the transaction', async () => {
    const ctx = ownerContext()
    const runId = randomUUID()
    await seedRun(runId)
    const evidenceRef = await archive('observation', { items: [{ kind: 'fact' }] }, ctx)
    const pin = await pinOf(evidenceRef, ctx)
    const answer = answerFor(runId, [pin])

    // Lost response: the first insert commits, the retry returns the same immutable answer.
    const first = await answerStore.record({ answer, expectedRunState: 'verifying', expectedRunRevision: '7', dependencyPins: [pin] }, ctx)
    const retry = await answerStore.record({ answer, expectedRunState: 'verifying', expectedRunRevision: '7', dependencyPins: [pin] }, ctx)
    expect(retry.answerId).toBe(first.answerId)
    expect(await answerRowCount(runId)).toBe(1)

    // A run CAS mismatch (cancelled between verification and publication) writes nothing.
    await expect(
      answerStore.record({ answer: { ...answer, answerId: randomUUID() }, expectedRunState: 'verifying', expectedRunRevision: '6', dependencyPins: [pin] }, ctx),
    ).rejects.toMatchObject({ code: 'RUN_NOT_PUBLISHABLE' })
    expect(await answerRowCount(runId)).toBe(1)
  })

  it('refuses to commit when a pinned dependency changed before the transaction', async () => {
    const ctx = ownerContext()
    const runId = randomUUID()
    await seedRun(runId)
    const evidenceRef = await archive('observation', { items: [{ kind: 'fact' }] }, ctx)
    const pin = await pinOf(evidenceRef, ctx)
    await adminClient.query(
      `UPDATE agent_platform.evidence_records SET revision = revision + 1 WHERE tenant_id = $1 AND space_id = $2 AND evidence_id = $3`,
      [TENANT_A, SPACE_A, evidenceRef.id],
    )

    let thrown: unknown
    try {
      await answerStore.record({ answer: answerFor(runId, [pin]), expectedRunState: 'verifying', expectedRunRevision: '7', dependencyPins: [pin] }, ctx)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AnswerStoreError)
    expect((thrown as AnswerStoreError).code).toBe('RUN_NOT_PUBLISHABLE')
    expect(await answerRowCount(runId)).toBe(0)
  })
})
