import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresAnswerStore,
  PostgresEvidenceStore,
  PostgresRunExecutionBindingStore,
  PostgresTableArtifactStore,
  PostgresTableVerificationStore,
} from '@ontology/adapter-control-postgres'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ResultHistoryService,
  TableHardVerificationService,
  TableArtifactReadService,
  VerifiedResultExportService,
  VerifiedResultReadService,
  canonicalJson,
  typedResultManifestContentDigest,
} from '@ontology/application'
import type { VerificationArtifactStore } from '@ontology/application'
import { createApiServer, createBlobArtifactWriter } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import {
  createToolContext,
  sha256OfCanonical,
  tableManifestContentDigest,
  tableArtifactContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  ImmutableArtifactWriter,
  PublishedAnswer,
  ResourceRef,
  ScopeRef,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableColumnDescriptor,
  EvidenceEnvelope,
  ToolContext,
  TypedResultManifest,
  VerifiedTableManifestSource,
} from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

/**
 * V03-041 (#214) real-database acceptance for the result revision history and the structured
 * JSON export.
 *
 * Two runs on two project revisions of the SAME project are published through the real control
 * store, each with an archived execution binding and an `answer-draft@3`. The history route
 * groups them newest-first, labelling the current exact version apart from the older history;
 * the export route returns the exact version identity/status/source index of the requested
 * version and refuses an unsupported format. Both routes re-check tenant/space isolation.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const NOW = '2026-09-30T00:00:00Z'
const PROFILE = { id: 'result-history-demo', version: '1.0.0' }
const OUTPUT_SCHEMA_REF = { id: 'output.schema', version: '1.0.0', digest: DIGEST }

const COLUMNS: readonly TableColumnDescriptor[] = [
  {
    columnRef: 'amount',
    semanticPredicate: 'energy.amount',
    valueType: 'quantity',
    schemaPointer: '/amount',
    requiredContextPointers: ['unitPointer'],
  },
]

let harness: JobDbHarness
let database: ControlPostgresDatabase
let registry: PostgresArtifactRegistry
let artifactWriter: ImmutableArtifactWriter
let objectDirectory = ''
let scope: JobTestScope
let otherScope: JobTestScope
let answerStore: PostgresAnswerStore
let tableStore: PostgresTableArtifactStore
let verificationStore: PostgresTableVerificationStore
let verificationArtifacts: VerificationArtifactStore
let app: ReturnType<typeof createApiServer>

function ctxFor(target: JobTestScope, runId: string): ToolContext {
  return createToolContext({
    principal: { tenantId: target.tenantId, subjectId: 'history-tester', roles: ['business-user'], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.3.0',
    deadline: '2026-12-31T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId, grantedAt: NOW, expiresAt: '2026-12-31T00:00:00Z' },
    allowedResources: {
      tenantId: target.tenantId,
      spaceId: target.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: `result-history:${randomUUID()}`,
  })
}

function scopeRefOf(target: JobTestScope): ScopeRef {
  return { tenantId: target.tenantId, spaceId: target.spaceId }
}

function pageBody(pageIndex: number, evidenceRef: ResourceRef, resultDigest: string): TableArtifactPageBody {
  const rowKey = `r-${pageIndex}`
  return {
    schemaVersion: 'table-artifact-page@1',
    tableId: 'table.small',
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    pageIndex,
    columnRefs: ['amount'],
    rowKeyOrder: 'ascending',
    rows: [
      {
        rowKey,
        subject: `site-${rowKey}`,
    cells: { amount: { value: '1', unit: 'kWh' } },
        bindings: [
          { rowKey, columnRef: 'amount', evidenceRef, resultDigest, valuePointer: '/amount', subjectPointer: '/site', unitPointer: '/unit' },
        ],
      },
    ],
    coverage: { returned: 1, truncated: false },
  }
}

async function seedProfile(target: JobTestScope): Promise<void> {
  await harness.adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'result-history-seed')
     ON CONFLICT DO NOTHING`,
    [target.tenantId, target.spaceId, PROFILE.id, PROFILE.version, DIGEST],
  )
  await harness.adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [target.tenantId, target.spaceId, PROFILE.id, PROFILE.version, DIGEST],
  )
}

async function seedRun(target: JobTestScope, runId: string): Promise<void> {
  await harness.adminClient.query(
    `INSERT INTO agent_platform.runs
       (tenant_id, space_id, run_id, owner_subject_id, profile_id, profile_version,
        resolved_profile_hash, runtime_ref, question, context, preferences, state, revision,
        idempotency_key, request_digest, created_at, updated_at)
     VALUES ($1, $2, $3, 'history-tester', $4, $5, $6, $7::jsonb, 'result history', '{}'::jsonb,
             '{}'::jsonb, 'published', 1, $8, $6, now(), now())
     ON CONFLICT DO NOTHING`,
    [
      target.tenantId,
      target.spaceId,
      runId,
      PROFILE.id,
      PROFILE.version,
      DIGEST,
      JSON.stringify({ id: 'runtime-template', version: '1.0.0', digest: DIGEST }),
      `run-${runId}`,
    ],
  )
}

async function seedBinding(
  target: JobTestScope,
  runId: string,
  bindingRef: ResourceRef,
  projectId: string,
  projectRevision: string,
): Promise<void> {
  await harness.adminClient.query(
    `INSERT INTO agent_platform.run_execution_bindings
       (tenant_id, space_id, run_id, binding_id, version, digest, binding, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
     ON CONFLICT DO NOTHING`,
    [
      target.tenantId,
      target.spaceId,
      runId,
      bindingRef.id,
      bindingRef.version,
      bindingRef.digest,
      JSON.stringify({ request: { projectRevisionRef: { projectId, revision: projectRevision, digest: DIGEST } } }),
    ],
  )
}

interface SeededAnswer {
  readonly answerId: string
  readonly runId: string
  readonly contentHash: string
  readonly sourceEvidenceId: string
}

async function seedAnswer(
  target: JobTestScope,
  projectId: string,
  projectRevision: string,
  publishedAt: string,
): Promise<SeededAnswer> {
  const runId = randomUUID()
  const answerId = randomUUID()
  await seedRun(target, runId)
  const ctx = ctxFor(target, runId)
  const scopeRef = scopeRefOf(target)

  const payload = { amount: '1', site: 'site-r-0', unit: 'kWh' }
  const payloadBytes = new TextEncoder().encode(canonicalJson(payload))
  const payloadArtifact = await artifactWriter.putBytes({ scopeRef, content: payloadBytes, mediaType: 'application/json' }, ctx)
  const evidenceId = randomUUID()
  const envelope: EvidenceEnvelope = {
    evidenceId,
    kind: 'observation',
    scopeRef,
    producedBy: { componentRef: { id: 'result-history-fixture', version: '1.0.0', digest: DIGEST }, runId },
    observedAt: NOW,
    sourceSnapshots: [{ sourceRef: { namespace: 'fixture', sourceId: 'table-row' }, schemaVersion: '1', readAt: NOW, consistency: 'repeatable_read', resultDigest: payloadArtifact.blobRef.digest }],
    resultDigest: payloadArtifact.blobRef.digest,
    dependencies: [],
    dataMode: 'synthetic',
    payloadRef: payloadArtifact.blobRef,
    integrity: { algorithm: 'sha256', digest: payloadArtifact.blobRef.digest, verifiedAt: NOW },
  }
  const evidenceRecord = await new PostgresEvidenceStore(database).record(scopeRef, envelope, ctx)
  const body = pageBody(0, evidenceRecord.evidenceRef, payloadArtifact.blobRef.digest)
  const pageRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: tableArtifactContentDigest(body), kind: 'artifact' }
  await tableStore.putPage(scopeRef, pageRef, body, ctx)
  const tableManifest: TableArtifactManifest = {
    schemaVersion: 'table-artifact-manifest@1',
    tableId: 'table.small',
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    columns: COLUMNS,
    totalRows: 1,
    rowKeyOrder: 'ascending',
    pages: [
      {
        pageIndex: 0,
        artifactRef: pageRef,
        artifactDigest: pageRef.digest,
        rowCount: 1,
        firstRowKey: 'r-0',
        lastRowKey: 'r-0',
        pageCoverageDigest: tablePageCoverageDigest(body),
      },
    ],
    coverage: { returned: 1, truncated: false },
    complete: true,
  }
  const manifestBytes = new TextEncoder().encode(canonicalJson(tableManifest))
  const manifestArtifact = await artifactWriter.putBytes({ scopeRef, content: manifestBytes, mediaType: 'application/json' }, ctx)
  expect(manifestArtifact.blobRef.digest).toBe(tableManifestContentDigest(tableManifest))
  const contentHash = sha256OfCanonical({ content: answerId })
  const verifier = new TableHardVerificationService({ pages: tableStore, evidence: new PostgresEvidenceStore(database), artifacts: verificationArtifacts, receipts: verificationStore, progress: verificationStore })
  const verified = await verifier.verifyTable({ resultManifestRef: manifestArtifact.blobRef, resultManifestDigest: manifestArtifact.blobRef.digest, draftHash: contentHash, tableId: tableManifest.tableId, manifest: tableManifest }, ctx)
  if (verified.status !== 'pass') throw new Error(`the result-history fixture did not earn a verification receipt: ${verified.report.findings.map((finding) => finding.code).join(', ')}`)
  await tableStore.putManifest(scopeRef, answerId, manifestArtifact.blobRef, tableManifest, verified.receipt.ref, ctx)

  const bindingRef: ResourceRef = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'plan' }
  const typedManifest: TypedResultManifest = {
    schemaVersion: 'typed-result-manifest@1',
    executionBindingRef: bindingRef,
    taskBindingRef: { id: 'task.binding', version: '1.0.0', digest: DIGEST },
    resultKind: 'structured_query',
    outputSchemaRef: OUTPUT_SCHEMA_REF,
    inputSnapshotRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' },
    outputDigest: DIGEST,
    tables: [tableManifest],
    limitations: [],
    coverage: { returned: 1, truncated: false },
    domainStatus: 'known',
    dataMode: 'observed',
  }
  const resultManifestDigest = typedResultManifestContentDigest(typedManifest)
  const archived = await artifactWriter.putBytes(
    { scopeRef, content: new TextEncoder().encode(canonicalJson(typedManifest)), mediaType: 'application/json' },
    ctx,
  )
  expect(archived.blobRef.digest).toBe(resultManifestDigest)

  const answer: PublishedAnswer = {
    answerId,
    runId,
    draftId: randomUUID(),
    verificationId: randomUUID(),
    contentHash,
    evidenceManifestHash: DIGEST,
    scenarioManifestHash: DIGEST,
    publicationKind: 'verified',
    limitations: [],
    v3Body: {
      schemaVersion: 'answer-draft@3',
      resultManifestRef: archived.blobRef,
      resultManifestDigest,
      finalizationReceiptRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST_B, kind: 'verification' },
      finalizationReceiptDigest: DIGEST_B,
      executionBindingRef: bindingRef,
      blocks: [],
      claims: [
        {
          claimId: randomUUID(),
          kind: 'observation',
          subject: 'site-r-0',
          predicate: 'amount',
          value: { value: '1', unit: 'kWh' },
          time: { asOf: publishedAt },
          references: [
            { evidenceRef: evidenceRecord.evidenceRef, resultDigest: payloadArtifact.blobRef.digest, valuePointer: '/amount', unitPointer: '/unit', subjectPointer: '/site' },
            { evidenceRef: evidenceRecord.evidenceRef, resultDigest: payloadArtifact.blobRef.digest, valuePointer: '/amount', unitPointer: '/unit', subjectPointer: '/site' },
          ],
        },
      ],
      assertions: [],
      limitations: [],
    },
    publishedAt,
  }
  await answerStore.record({ answer, expectedRunState: 'published', expectedRunRevision: '1' }, ctx)
  await seedBinding(target, runId, bindingRef, projectId, projectRevision)
  return { answerId, runId, contentHash, sourceEvidenceId: evidenceRecord.evidenceRef.id }
}

function get(path: string, scopeTag: 'primary' | 'other' | 'none' = 'primary') {
  return app.inject({ method: 'GET', url: path, headers: { 'x-scope': scopeTag } })
}

beforeAll(async () => {
  harness = await startJobDatabase()
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 8 })
  scope = await createJobScope(harness.adminClient, 'result-history')
  otherScope = await createJobScope(harness.adminClient, 'result-history-other')
  await seedProfile(scope)
  await seedProfile(otherScope)

  objectDirectory = await mkdtemp(join(tmpdir(), 'ontology-result-history-'))
  const objectStore = new FileSystemObjectStore(objectDirectory)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 4 })
  const blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  verificationArtifacts = {
    getAuthorized: (request, ctx) => blobStore.getAuthorized(request, ctx),
    readAuthorized: (request, ctx) => blobStore.readAuthorized(request, ctx),
  }
  artifactWriter = createBlobArtifactWriter(blobStore)

  answerStore = new PostgresAnswerStore(database)
  tableStore = new PostgresTableArtifactStore(database, {
    writer: artifactWriter,
    reader: {
      read: (request, ctx) => {
        const target = request.approvedInputRefs[0]
        if (target === undefined) throw new Error('the table page read carried no approved input reference')
        return blobStore.readAuthorized(
          { scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: target },
          ctx,
        )
      },
    },
  })
  verificationStore = new PostgresTableVerificationStore(database)
  const verifiedManifests: VerifiedTableManifestSource = {
    resolve: async (scopeRef, answerId, tableId, ctx) => {
      const archived = await tableStore.resolve(scopeRef, answerId, tableId, ctx)
      if (archived === undefined || archived.verificationReceiptRef === undefined) return archived
      const receipt = await verificationStore.getReceipt(scopeRef, archived.verificationReceiptRef, ctx)
      return receipt === undefined ? { ref: archived.ref, manifest: archived.manifest } : archived
    },
  }
  const tableReadService = new TableArtifactReadService({ manifests: verifiedManifests, pages: tableStore, progress: tableStore })
  const resultService = new VerifiedResultReadService({
    answers: answerStore,
    results: {
      getAuthorized: (request, ctx) => blobStore.getAuthorized(request, ctx),
      readAuthorized: (request, ctx) => blobStore.readAuthorized(request, ctx),
    },
    tables: verifiedManifests,
  })
  const exporter = new VerifiedResultExportService({
    reads: resultService,
    answers: answerStore,
    tables: verifiedManifests,
    now: () => NOW,
  })
  const history = new ResultHistoryService({
    answers: answerStore,
    bindings: new PostgresRunExecutionBindingStore(database),
    history: answerStore,
  })

  app = createApiServer({
    authenticate: (request): AuthenticatedRequest | undefined => {
      const raw = request.headers['x-scope']
      const tag = Array.isArray(raw) ? raw[0] : raw
      if (tag === 'none') return undefined
      if (tag !== undefined && tag !== 'primary' && tag !== 'other') return undefined
      const target = tag === 'other' ? otherScope : scope
      return {
        principal: { tenantId: target.tenantId, subjectId: 'history-tester', roles: ['business-user'], scopes: [], authEpoch: 1 },
        spaceId: target.spaceId,
      }
    },
    answers: { result: resultService, tables: tableReadService, exporter, history },
  })
}, 300_000)

afterAll(async () => {
  await app?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await registry?.close().catch(() => undefined)
  await harness?.stop()
  if (objectDirectory !== '') await rm(objectDirectory, { recursive: true, force: true }).catch(() => undefined)
})

describe('result revision history and JSON export over real PostgreSQL', () => {
  it('lists newer/older revisions, labels fixed_version vs history, and reads a lost response back', async () => {
    const projectId = randomUUID()
    const older = await seedAnswer(scope, projectId, '6', '2026-09-20T00:00:00Z')
    const current = await seedAnswer(scope, projectId, '7', '2026-09-21T00:00:00Z')

    const historyResponse = await get(`/api/v1/runs/${current.runId}/answer/history`)
    expect(historyResponse.statusCode).toBe(200)
    const history = historyResponse.json<{
      data: {
        logicalKey: string
        currentAnswerId: string
        entries: { answerId: string; revisionIndex: number; readKind: string; contentHash: string }[]
      }
    }>().data
    expect(history.logicalKey).toBe(projectId)
    expect(history.currentAnswerId).toBe(current.answerId)
    expect(history.entries.map((entry) => entry.answerId)).toEqual([current.answerId, older.answerId])
    expect(history.entries[0]).toMatchObject({ revisionIndex: 1, readKind: 'fixed_version' })
    expect(history.entries[1]).toMatchObject({ revisionIndex: 2, readKind: 'history' })

    // Reading the publish result back by the same logical key (the run) yields the same version.
    const again = await get(`/api/v1/runs/${current.runId}/answer/history`)
    expect(again.json<{ data: { entries: { contentHash: string }[] } }>().data.entries[0]?.contentHash).toBe(current.contentHash)
  }, 240_000)

  it('exports the exact verified version with status, versions and source index', async () => {
    const projectId = randomUUID()
    const seeded = await seedAnswer(scope, projectId, '7', '2026-09-21T00:00:00Z')

    const response = await get(`/api/v1/runs/${seeded.runId}/answer/export?format=json`)
    expect(response.statusCode).toBe(200)
    const exported = response.json<{
      data: {
        schemaVersion: string
        status: { publicationKind: string; domainStatus: string }
        versions: { answerId: string; runId: string; contentHash: string; resultManifestDigest: string }
        tables: { tableId: string; verificationReceiptRef?: unknown }[]
        sourceIndex: { evidenceId: string; boundBy: string[] }[]
      }
    }>().data
    expect(exported.schemaVersion).toBe('verified-result-export@1')
    expect(exported.versions.answerId).toBe(seeded.answerId)
    expect(exported.versions.runId).toBe(seeded.runId)
    expect(exported.versions.contentHash).toBe(seeded.contentHash)
    expect(exported.status.publicationKind).toBe('verified')
    expect(exported.status.domainStatus).toBe('known')
    expect(exported.tables[0]?.tableId).toBe('table.small')
    expect(exported.tables[0]?.verificationReceiptRef).toBeDefined()
    expect(exported.sourceIndex).toHaveLength(1)
    expect(exported.sourceIndex[0]).toMatchObject({ evidenceId: seeded.sourceEvidenceId, boundBy: ['claim'] })

    // A later read returns the same exact version; the export never drifts to a newer edit.
    const second = await get(`/api/v1/runs/${seeded.runId}/answer/export?format=json`)
    expect(second.json<{ data: { versions: { contentHash: string } } }>().data.versions.contentHash).toBe(seeded.contentHash)
  }, 240_000)

  it('refuses an unsupported export format with EXPORT_FORMAT_UNSUPPORTED', async () => {
    const projectId = randomUUID()
    const seeded = await seedAnswer(scope, projectId, '7', '2026-09-21T00:00:00Z')
    const response = await get(`/api/v1/runs/${seeded.runId}/answer/export?format=xlsx`)
    expect(response.statusCode).toBe(422)
    expect(response.json<{ error: { code: string } }>().error.code).toBe('EXPORT_FORMAT_UNSUPPORTED')
  }, 240_000)

  it('isolates history and export by tenant/space and requires authentication', async () => {
    const projectId = randomUUID()
    const seeded = await seedAnswer(scope, projectId, '7', '2026-09-21T00:00:00Z')

    const foreignHistory = await get(`/api/v1/runs/${seeded.runId}/answer/history`, 'other')
    expect(foreignHistory.statusCode).toBe(404)

    const foreignExport = await get(`/api/v1/runs/${seeded.runId}/answer/export?format=json`, 'other')
    expect(foreignExport.statusCode).toBe(404)

    const unauthenticated = await get(`/api/v1/runs/${seeded.runId}/answer/export?format=json`, 'none')
    expect(unauthenticated.statusCode).toBe(401)
  }, 240_000)
})
