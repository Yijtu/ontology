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
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresEvidenceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { createToolGatewayComposition } from '@ontology/app-api'
import { DraftVerificationService } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import { type RunToolBinding } from '@ontology/tool-services'
import type { ResourceRef, ToolCall } from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import {
  RecordingHandler,
  canonicalToolValidator,
  fullProfile,
  observation,
  operationRegistry,
} from '../unit/tool-gateway-fixtures'
import {
  FixedSemanticDecision,
  RESULT_PAYLOAD,
  RUN_ID,
  SCOPE_A,
  buildClaim,
  buildDraft,
  buildInputManifest,
  modelRef,
  ownerContext,
  toolContext,
  verificationPolicy,
} from '../unit/verification-fixtures'

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))

const TENANT_A = SCOPE_A.tenantId
const SPACE_A = SCOPE_A.spaceId
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function connectionStringFor(adminUrl: string, user: string, password: string): string {
  const base = new URL(adminUrl)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

/** A controlled in-process handler whose payload carries the claim-bindable fields. */
function resultHandler(): RecordingHandler {
  return new RecordingHandler('ontology_lookup', {
    payload: RESULT_PAYLOAD,
    status: 'ok',
    coverage: { returned: 1, truncated: false },
    sources: [observation()],
  })
}

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let objectDir = ''
let registry: PostgresArtifactRegistry
let blobStore: LocalImmutableBlobStore
let controlDatabase: ControlPostgresDatabase
let evidenceStore: PostgresEvidenceStore
let budget: BudgetService
let composition: ReturnType<typeof createToolGatewayComposition>
let handler: RecordingHandler

function binding(ledgerId: string): RunToolBinding {
  return {
    runId: RUN_ID,
    ledgerId,
    resolvedProfile: fullProfile(),
    operations: operationRegistry(),
  }
}

function lookupCall(): ToolCall {
  return {
    callId: randomUUID(),
    toolId: 'ontology_lookup',
    arguments: { scopeRef: SCOPE_A, intent: 'definitions' },
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
    `INSERT INTO agent_platform.tenants (tenant_id, slug)
     VALUES ($1, 'verification-tenant-a'), ($2, 'verification-tenant-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, TENANT_B],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'verification-space-a'), ($3, $4, 'verification-space-b')
     ON CONFLICT DO NOTHING`,
    [TENANT_A, SPACE_A, TENANT_B, SPACE_B],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) {
    throw new Error('could not build the application-role login statement')
  }
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  objectDir = await mkdtemp(join(tmpdir(), 'draft-verification-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  controlDatabase = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 4 })
  budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(controlDatabase),
    control: new ControlPostgresRepository(controlDatabase),
  })
  evidenceStore = new PostgresEvidenceStore(controlDatabase)
  handler = resultHandler()

  composition = createToolGatewayComposition({
    database: controlDatabase,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [handler],
  })
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

/**
 * Run one real tool call through the gateway and return its persisted evidence reference.
 *
 * Each call opens its own run ledger, so the same read is a fresh run rather than a
 * no-progress duplicate of an earlier call in one ledger (D7.3).
 */
async function invokeAndPersist(ctx = ownerContext()): Promise<ResourceRef> {
  const ledgerId = randomUUID()
  await budget.openLedger({ ledgerId, kind: 'run', runId: RUN_ID }, ctx)
  const result = await composition.forRun(binding(ledgerId)).invoke(lookupCall(), ctx)
  expect(result.status).toBe('ok')
  expect(result.evidenceRefs).toHaveLength(1)
  const evidenceRef = result.evidenceRefs[0]
  if (evidenceRef === undefined) throw new Error('the tool call returned no evidence reference')
  return evidenceRef
}

describe('DraftVerificationService against real PostgreSQL, blob store and tool gateway', () => {
  it('runs against a real PostgreSQL (containerised unless CONTROL_TEST_DATABASE_URL is set)', async () => {
    const result = await adminClient.query<{ version: string }>('SELECT version() AS version')
    expect(result.rows[0]?.version).toContain('PostgreSQL')
    if (container !== undefined) {
      process.stdout.write(
        `[draft-verification] image=${container.image} container=${container.containerName}\n`,
      )
    }
  })

  it('verifies a claim bound to a real archived tool result', async () => {
    const ctx = ownerContext()
    const evidenceRef = await invokeAndPersist(ctx)
    const record = await evidenceStore.get(SCOPE_A, evidenceRef.id, ctx)
    expect(record).toBeDefined()
    if (record === undefined) throw new Error('the evidence was not recorded')

    const claim = buildClaim({ evidenceRef, resultDigest: record.envelope.resultDigest })
    const manifest = buildInputManifest([evidenceRef])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const decision = new FixedSemanticDecision('supported')
    const service = new DraftVerificationService({
      evidence: evidenceStore,
      artifacts: blobStore,
      policy: verificationPolicy(),
      decision,
      modelRef: modelRef(),
      now: () => record.recordedAt,
    })

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)
    expect(result.verdict).toBe('pass')
    expect(result.failedChecks).toEqual([])
    expect(result.draftHash).toBe(draft.contentHash)
    expect(result.evidenceManifestHash).toBe(manifest.digest)
    expect(result.supportedClaimIds).toEqual([claim.claimId])
  })

  it('locates an injected wrong unit against the real archived result', async () => {
    const ctx = ownerContext()
    const evidenceRef = await invokeAndPersist(ctx)
    const record = await evidenceStore.get(SCOPE_A, evidenceRef.id, ctx)
    if (record === undefined) throw new Error('the evidence was not recorded')

    const claim = buildClaim({
      evidenceRef,
      resultDigest: record.envelope.resultDigest,
      unit: 'MWh',
    })
    const manifest = buildInputManifest([evidenceRef])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const service = new DraftVerificationService({
      evidence: evidenceStore,
      artifacts: blobStore,
      policy: verificationPolicy(),
      decision: new FixedSemanticDecision('supported', 0.999),
      modelRef: modelRef(),
      now: () => record.recordedAt,
    })

    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctx)
    expect(result.verdict).toBe('fail')
    const finding = result.findings?.find((entry) => entry.code === 'unit_mismatch')
    expect(finding?.claimId).toBe(claim.claimId)
    expect(finding?.field).toBe('unit')
    expect(finding?.evidenceRef?.id).toBe(evidenceRef.id)
    expect(result.explanations?.some((entry) => entry.message.includes(claim.claimId))).toBe(true)
  })

  it('hides another tenant evidence row from the verifier (real RLS)', async () => {
    const ctxA = ownerContext()
    const evidenceRef = await invokeAndPersist(ctxA)
    const record = await evidenceStore.get(SCOPE_A, evidenceRef.id, ctxA)
    if (record === undefined) throw new Error('the evidence was not recorded')

    const claim = buildClaim({ evidenceRef, resultDigest: record.envelope.resultDigest })
    const manifest = buildInputManifest([evidenceRef])
    const draft = buildDraft({ evidenceManifestHash: manifest.digest, claims: [claim] })
    const service = new DraftVerificationService({
      evidence: evidenceStore,
      artifacts: blobStore,
      policy: verificationPolicy(),
      decision: new FixedSemanticDecision('supported'),
      modelRef: modelRef(),
      now: () => record.recordedAt,
    })

    const ctxB = toolContext(TENANT_B, SPACE_B, ['business-user'], 'owner-b', RUN_ID)
    const result = await service.verify({ runId: RUN_ID, draft, inputManifest: manifest }, ctxB)
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('evidence_not_found')
    expect(result.missingEvidence).toEqual([evidenceRef.id])
  })

  it('archives the real result payload the verifier reads back', async () => {
    const ctx = ownerContext()
    const evidenceRef = await invokeAndPersist(ctx)
    const record = await evidenceStore.get(SCOPE_A, evidenceRef.id, ctx)
    if (record?.envelope.payloadRef === undefined) throw new Error('the evidence carried no payload ref')
    const authorized = await blobStore.getAuthorized(
      { scopeRef: SCOPE_A, blobRef: record.envelope.payloadRef },
      ctx,
    )
    expect(authorized.integrityVerified).toBe(true)
    expect(record.envelope.payloadRef.kind).toBe('artifact')
  })
})
