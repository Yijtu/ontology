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
  ControlPostgresRepository,
  PostgresBudgetLedgerStore,
  PostgresEvidenceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { createToolGatewayComposition } from '@ontology/app-api'
import { DraftVerificationService } from '@ontology/application'
import { BudgetService } from '@ontology/core'
import { type RunToolBinding } from '@ontology/tool-services'
import type {
  EvidenceEnvelope,
  ResourceRef,
  Sha256Digest,
  ToolCall,
  VerifiedAssertion,
  VersionRef,
} from '@ontology/contracts'
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
  buildEvidence,
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

/** A text digest helper for the integration fixtures (content-addressed, never rounded). */
function digestOf(text: string): Sha256Digest {
  return sha256Digest(new TextEncoder().encode(text))
}

/**
 * Archive one typed evidence payload through the real blob store and control-Postgres evidence
 * archive, then return the exact evidence record the verifier must read back.
 */
async function archiveTypedEvidence(
  kind: EvidenceEnvelope['kind'],
  payload: unknown,
  ctx = ownerContext(),
): Promise<{ readonly ref: ResourceRef; readonly resultDigest: Sha256Digest; readonly recordedAt: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const contentDigest = sha256Digest(bytes)
  await blobStore.stage(bytes, { scopeRef: SCOPE_A }, ctx)
  const published = await blobStore.publish(
    { scopeRef: SCOPE_A, contentDigest, mediaType: 'application/json', byteSize: bytes.byteLength, purpose: 'artifact' },
    ctx,
  )
  const envelope = buildEvidence({
    evidenceId: randomUUID(),
    payloadRef: published.blobRef,
    resultDigest: published.blobRef.digest,
    kind,
  })
  const record = await evidenceStore.record(SCOPE_A, envelope, ctx)
  return { ref: record.evidenceRef, resultDigest: record.envelope.resultDigest, recordedAt: record.recordedAt }
}

describe('typed evidence verifier against real PostgreSQL, blob store and evidence archive', () => {
  const RULE_REF: VersionRef = { id: 'rule.maintenance', version: '1.0.0', digest: digestOf('rule-maintenance') }
  const DEFINITION_REF: VersionRef = { id: 'def.transport', version: '2.0.0', digest: digestOf('def-transport') }
  const DOCUMENT: ResourceRef = { id: 'd1111111-1111-4111-8111-111111111111', version: '1.0.0', digest: digestOf('document'), kind: 'artifact' }

  function serviceFor(now: string): DraftVerificationService {
    return new DraftVerificationService({
      evidence: evidenceStore,
      artifacts: blobStore,
      policy: verificationPolicy({ semanticReview: 'disabled' }),
      now: () => now,
    })
  }

  it('blocks a wrong rule verdict recomputed from the real archived rule artifact', async () => {
    const ctx = ownerContext()
    const artifact = {
      schemaVersion: 'rule-computation-artifact@1',
      scopeRef: SCOPE_A,
      definitionRef: DEFINITION_REF,
      ruleRef: RULE_REF,
      ruleId: 'rule.maintenance',
      ruleVersionId: randomUUID(),
      publishedRevision: '4',
      instanceKey: 'I-04',
      objectId: 'transport_facility',
      subjectEntityId: 'I-04',
      predicate: 'maintenance_applicability',
      applicability: { state: 'applicable', conditionState: 'true', exceptionStates: [], positiveSupport: true },
      factRefs: [],
      sourceStatementIds: [],
      inputDigest: digestOf('input'),
      computationDigest: digestOf('computation'),
      sourceSpans: [],
      complete: true,
    }
    const support = {
      schemaVersion: 'rule-derivation-support-payload@1',
      artifact,
      sourceEvidenceMappings: [],
      policySourceEvidenceMappings: [],
    }
    const evidence = await archiveTypedEvidence('rule_derivation', support, ctx)
    const assertion: VerifiedAssertion = {
      assertionId: randomUUID(),
      kind: 'rule_judgement',
      subject: 'I-04',
      predicate: 'maintenance_applicability',
      value: 'false',
      ruleRef: RULE_REF,
      premiseRefs: [],
      judgementAxis: 'applicability',
      references: [{
        evidenceRef: evidence.ref,
        resultDigest: evidence.resultDigest,
        valuePointer: '/artifact',
        subjectPointer: '/artifact/subjectEntityId',
        rulePointer: '/artifact',
      }],
    }
    const manifest = buildInputManifest([evidence.ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [],
      assertions: [assertion],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'assertion', assertionId: assertion.assertionId }],
    })
    const result = await serviceFor(evidence.recordedAt).verify(
      { runId: RUN_ID, draft, inputManifest: manifest },
      ctx,
    )
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('rule_judgement_mismatch')
  })

  it('blocks a swapped relation endpoint against the real archived edge', async () => {
    const ctx = ownerContext()
    const edge = {
      statementId: 'stmt-1',
      statementVersion: '4',
      relationId: 'feeds',
      definitionRef: DEFINITION_REF,
      fromEntityId: 'E-A',
      toEntityId: 'E-B',
      fromCandidateId: 'c-a',
      toCandidateId: 'c-b',
      sourceRefs: [],
    }
    const evidence = await archiveTypedEvidence('observation', { resultKind: 'relations', edges: [edge] }, ctx)
    const ref = (id: string): ResourceRef => ({ id, version: '1.0.0', digest: digestOf(id), kind: 'artifact' })
    const assertion: VerifiedAssertion = {
      assertionId: randomUUID(),
      kind: 'relation_ref',
      subject: 'E-A',
      predicate: 'feeds',
      value: { type: 'feeds', from: ref('E-B'), to: ref('E-A') },
      statementId: 'stmt-1',
      definitionRef: DEFINITION_REF,
      references: [{
        evidenceRef: evidence.ref,
        resultDigest: evidence.resultDigest,
        valuePointer: '/edges/0',
        subjectPointer: '/edges/0/fromEntityId',
        relationPointer: '/edges/0',
      }],
    }
    const manifest = buildInputManifest([evidence.ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [],
      assertions: [assertion],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'assertion', assertionId: assertion.assertionId }],
    })
    const result = await serviceFor(evidence.recordedAt).verify(
      { runId: RUN_ID, draft, inputManifest: manifest },
      ctx,
    )
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('relation_endpoint_mismatch')
  })

  it('blocks a citation whose locator does not match the real archived document span', async () => {
    const ctx = ownerContext()
    const quote = 'the inspection interval is 90 days'
    const locator = { kind: 'page', page: 4 }
    const payload = {
      subject: 'entity.device-17',
      quote,
      quoteDigest: digestOf(quote),
      textDigest: digestOf('full-document-text'),
      locator,
      documentRef: DOCUMENT,
    }
    const evidence = await archiveTypedEvidence('document_span', payload, ctx)
    const assertion: VerifiedAssertion = {
      assertionId: randomUUID(),
      kind: 'document_quote',
      subject: 'entity.device-17',
      predicate: 'inspection_note',
      quote,
      documentRef: DOCUMENT,
      locator: { kind: 'page', page: 5 },
      quoteDigest: digestOf(quote),
      textDigest: digestOf('full-document-text'),
      precision: 'exact',
      references: [{
        evidenceRef: evidence.ref,
        resultDigest: evidence.resultDigest,
        valuePointer: '/quote',
        subjectPointer: '/subject',
        documentPointer: '/documentRef',
        locatorPointer: '/locator',
        quoteDigestPointer: '/quoteDigest',
        textDigestPointer: '/textDigest',
      }],
    }
    const manifest = buildInputManifest([evidence.ref])
    const draft = buildDraft({
      evidenceManifestHash: manifest.digest,
      claims: [],
      assertions: [assertion],
      schemaVersion: 'answer-draft@2',
      blocks: [{ kind: 'assertion', assertionId: assertion.assertionId }],
    })
    const result = await serviceFor(evidence.recordedAt).verify(
      { runId: RUN_ID, draft, inputManifest: manifest },
      ctx,
    )
    expect(result.verdict).toBe('fail')
    expect(result.failedChecks).toContain('citation_locator_mismatch')
  })
})
