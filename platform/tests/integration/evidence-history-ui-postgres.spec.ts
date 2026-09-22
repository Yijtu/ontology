import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresEvidenceStore,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { ProvenanceReadService } from '@ontology/provenance'
import { HistoryReadService, SupportEvidenceDependencySource, sha256DigestOf } from '@ontology/semantic-engine'
import type {
  EvidenceEnvelope,
  EvidenceKind,
  PublishedRuleVersion,
  PublishedStatement,
  PublishSemanticPublicationInput,
  ResourceRef,
  SourceSnapshot,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'

/**
 * The UI's provenance/history contract against a real PostgreSQL container and the real
 * evidence/history services (not a mock): the exact routes the browser app calls, driven with
 * the paging cursor the response envelope returns, a real published/materialised support DAG,
 * real archived snapshots, and a real tenant/space boundary.
 */
const DIGEST = `sha256:${'a'.repeat(64)}`
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const TENANT_B = '44444444-4444-4444-8444-444444444444'
const SPACE_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let publication: PostgresSemanticPublicationStore
let evidence: PostgresEvidenceStore
let blobStore: LocalImmutableBlobStore
let objectStore: FileSystemObjectStore
let registry: PostgresArtifactRegistry
let provenance: ProvenanceReadService
let history: HistoryReadService
let tempDir: string
let jobId: Uuid

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function evidenceSource(id: Uuid): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'evidence' }
}

function ruleRef(ruleId: string): VersionRef {
  return { id: ruleId, version: '1', digest: DIGEST }
}

async function archive(content: string, mediaType = 'text/plain'): Promise<ResourceRef> {
  const staged = await blobStore.stage(bytes(content), { scopeRef: scope.scopeRef }, ctx)
  const published = await blobStore.publish(
    {
      scopeRef: scope.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType,
      byteSize: staged.byteSize,
      purpose: 'large_result',
    },
    ctx,
  )
  return published.blobRef
}

async function recordEvidence(input: {
  readonly evidenceId: Uuid
  readonly kind: EvidenceKind
  readonly ruleRef?: VersionRef
  readonly sourceSnapshots: readonly SourceSnapshot[]
  readonly payloadRef?: ResourceRef
  readonly recordedSeq?: string
}): Promise<void> {
  const envelope: EvidenceEnvelope = {
    evidenceId: input.evidenceId,
    kind: input.kind,
    scopeRef: scope.scopeRef,
    producedBy: {
      componentRef: { id: 'component.provenance', version: '1.0.0', digest: DIGEST },
      runId: RUN_ID,
      ...(input.ruleRef === undefined ? {} : { ruleRef: input.ruleRef }),
    },
    observedAt: '2026-09-21T06:00:00Z',
    ...(input.recordedSeq === undefined ? {} : { recordedSeq: input.recordedSeq }),
    validity: VALIDITY,
    sourceSnapshots: [...input.sourceSnapshots],
    resultDigest: sha256DigestOf(input.evidenceId),
    integrity: { algorithm: 'sha256', digest: sha256DigestOf(`integrity:${input.evidenceId}`) },
    dependencies: [],
    dataMode: 'observed',
    ...(input.payloadRef === undefined ? {} : { payloadRef: input.payloadRef }),
  }
  await evidence.record(scope.scopeRef, envelope, ctx)
}

function immutableSnapshot(): SourceSnapshot {
  return {
    sourceRef: { namespace: 'postgres', sourceId: 'public.meter_readings' },
    schemaVersion: '1',
    readAt: '2026-09-21T05:00:00Z',
    consistency: 'immutable',
    resultDigest: DIGEST,
  }
}

function statement(
  overrides: Partial<PublishedStatement> & Pick<PublishedStatement, 'statementId' | 'sourceRefs'>,
): Omit<PublishedStatement, 'publicationId'> {
  return {
    propositionKey: 'device.battery_present',
    kind: 'entity',
    objectId: 'device.battery',
    predicate: 'device.battery_present',
    value: { value: true },
    validFrom: VALIDITY.validFrom,
    validTo: VALIDITY.validTo,
    recordedAt: '2026-09-21T00:00:00Z',
    sourceCandidateId: randomUUID(),
    version: '1',
    status: 'active',
    ...overrides,
  }
}

function ruleVersion(ruleId: string, attributeId: string): Omit<PublishedRuleVersion, 'publicationId'> {
  return {
    ruleVersionId: randomUUID(),
    ruleId,
    version: '1',
    objectId: `${attributeId}.conclusion`,
    severity: 'soft',
    impact: 'low',
    expression: { op: 'compare', attributeId, operator: 'eq', value: true, spans: [] },
    exceptions: [],
    recordedAt: '2026-09-21T00:00:00Z',
    sourceCandidateId: randomUUID(),
  }
}

async function publishBundle(
  statements: readonly Omit<PublishedStatement, 'publicationId'>[],
  ruleVersions: readonly Omit<PublishedRuleVersion, 'publicationId'>[],
  key: string,
): Promise<void> {
  const publicationId = randomUUID()
  const input: PublishSemanticPublicationInput = {
    expectedRevision: await publication.latestPublicationRevision(scope.scopeRef, ctx),
    publication: {
      publicationId,
      versionRef: { id: publicationId, version: '1.0.0', digest: DIGEST },
      schemaRef: { id: 'home-energy.core', version: '1.0.0', digest: DIGEST },
      approvedCandidateRefs: [],
      statements: statements.map((entry) => ({ ...entry, publicationId })),
      ruleVersions: ruleVersions.map((entry) => ({ ...entry, publicationId })),
      outboxId: randomUUID(),
      publishedAt: '2026-09-21T00:00:00Z',
      actor: ctx.principal.subjectId,
    },
    idempotencyKey: key,
    requestDigest: DIGEST,
    identityBindings: [],
    outbox: {
      outboxId: randomUUID(),
      topic: 'semantic.publication.published',
      payload: { publicationId },
      idempotencyKey: `${key}:outbox`,
      availableAt: '2026-09-21T00:00:00Z',
      createdAt: '2026-09-21T00:00:00Z',
    },
    outboxJobId: jobId,
  }
  await publication.publish(scope.scopeRef, input, ctx)
}

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawScope = request.headers['x-test-scope']
  const isB = (Array.isArray(rawScope) ? rawScope[0] : rawScope) === 'b'
  return {
    principal: {
      tenantId: isB ? TENANT_B : scope.tenantId,
      subjectId: subject,
      roles: ['scoped-reader'],
      scopes: [],
      authEpoch: 1,
    },
    spaceId: isB ? SPACE_B : scope.spaceId,
  }
}

beforeAll(async () => {
  harness = await startJobDatabase()
  scope = await createJobScope(harness.adminClient, 'evidence-history-ui')
  ctx = toolContext(
    scope.tenantId,
    scope.spaceId,
    ['scoped-reader', 'semantic-publisher', 'platform-admin'],
    'reader',
    RUN_ID,
  )
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 6 })
  publication = new PostgresSemanticPublicationStore(database)
  evidence = new PostgresEvidenceStore(database)

  tempDir = await mkdtemp(join(tmpdir(), 'ontology-evidence-ui-'))
  objectStore = new FileSystemObjectStore(tempDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  provenance = new ProvenanceReadService({
    evidence,
    blobs: blobStore,
    dependencies: new SupportEvidenceDependencySource({ published: publication }),
    reader: blobStore,
  })
  history = new HistoryReadService({ store: publication })

  jobId = randomUUID()
  await harness.adminClient.query(
    `INSERT INTO agent_platform.jobs (
       tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
       idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'ingestion', 'evidence-history-ui', $4, '1.0.0', 'published',
       $5, $6, 1, '{}'::jsonb, now(), now(), 'evidence-history-ui-test', now())`,
    [
      scope.tenantId,
      scope.spaceId,
      jobId,
      randomUUID(),
      `evidence-history-ui-${jobId.slice(0, 8)}`,
      sha256DigestOf({ jobId }),
    ],
  )
}, 300_000)

afterAll(async () => {
  await registry?.close().catch(() => undefined)
  await database?.close().catch(() => undefined)
  await harness?.stop()
  if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
})

describe('the evidence/history HTTP routes the UI calls, against real PostgreSQL', () => {
  it('expands a conclusion and pages the real support graph with an explicit truncation flag', async () => {
    const factA = randomUUID()
    const factB = randomUUID()
    const relation = randomUUID()
    const ruleEvidence = randomUUID()
    const rule = ruleRef('rule.ui-ready')
    const archivedSnapshot = await archive('meter snapshot')
    await recordEvidence({ evidenceId: factA, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })
    await recordEvidence({ evidenceId: factB, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })
    await recordEvidence({ evidenceId: relation, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })
    await recordEvidence({
      evidenceId: ruleEvidence,
      kind: 'rule_derivation',
      ruleRef: rule,
      recordedSeq: '1',
      sourceSnapshots: [
        {
          sourceRef: { namespace: 'document', sourceId: 'battery-manual.pdf' },
          schemaVersion: '1',
          readAt: '2026-09-21T05:30:00Z',
          consistency: 'repeatable_read',
          resultDigest: DIGEST,
          archivedResultRef: archivedSnapshot,
        },
      ],
    })
    await publishBundle(
      [
        statement({ statementId: randomUUID(), sourceRefs: [evidenceSource(factA)] }),
        statement({ statementId: randomUUID(), sourceRefs: [evidenceSource(factB)] }),
        statement({
          statementId: randomUUID(),
          kind: 'relation',
          relationId: 'device.located_in',
          predicate: 'device.located_in',
          value: { value: 'room.one' },
          sourceRefs: [evidenceSource(relation)],
        }),
      ],
      [ruleVersion(rule.id, 'device.battery_present')],
      'ui-support',
    )

    const app = createApiServer({
      authenticate: testAuthenticator,
      evidence: { service: provenance },
      history: { service: history },
    })
    try {
      const basis = await app.inject({
        method: 'GET',
        url: `/api/v1/evidence/${ruleEvidence}?validAt=2026-09-21T06:00:00Z`,
        headers: { 'x-test-subject': 'reader-a' },
      })
      expect(basis.statusCode).toBe(200)
      const basisBody = basis.json() as {
        data: {
          outcome: string
          ruleRefs: readonly { id: string }[]
          premiseGroups: readonly { alternativeEvidenceIds: readonly string[] }[]
          sources: readonly { reReadability: string }[]
        }
      }
      expect(basisBody.data.outcome).toBe('verifiable')
      expect(basisBody.data.ruleRefs.map((ref) => ref.id)).toEqual([rule.id])
      expect(basisBody.data.premiseGroups).toHaveLength(1)
      expect([...basisBody.data.premiseGroups[0]!.alternativeEvidenceIds].sort()).toEqual([factA, factB].sort())
      expect(basisBody.data.sources[0]?.reReadability).toBe('archived_snapshot_only')

      // Page 1 of the graph is explicitly truncated with a cursor.
      const firstPage = await app.inject({
        method: 'GET',
        url: `/api/v1/evidence/${ruleEvidence}/dependencies?direction=outbound&depth=1&limit=1`,
        headers: { 'x-test-subject': 'reader-a' },
      })
      expect(firstPage.statusCode).toBe(200)
      const firstBody = firstPage.json() as {
        data: { coverage: { truncated: boolean; returned: number }; nodes: readonly { evidenceId: string }[] }
        meta: { nextCursor?: string }
      }
      expect(firstBody.data.coverage.truncated).toBe(true)
      expect(typeof firstBody.meta.nextCursor).toBe('string')

      // Follow the envelope cursor to completion; the pages together cover both premises,
      // disjointly, and a truncated page is never mistaken for the complete graph.
      const pagedIds: string[] = [...firstBody.data.nodes.map((node) => node.evidenceId)]
      let cursor = firstBody.meta.nextCursor
      let pages = 1
      while (cursor !== undefined) {
        const page = await app.inject({
          method: 'GET',
          url: `/api/v1/evidence/${ruleEvidence}/dependencies?direction=outbound&depth=1&limit=1&cursor=${encodeURIComponent(
            cursor,
          )}`,
          headers: { 'x-test-subject': 'reader-a' },
        })
        expect(page.statusCode).toBe(200)
        const body = page.json() as {
          data: { coverage: { truncated: boolean }; nodes: readonly { evidenceId: string }[] }
          meta: { nextCursor?: string }
        }
        pagedIds.push(...body.data.nodes.map((node) => node.evidenceId))
        pages += 1
        cursor = body.data.coverage.truncated ? body.meta.nextCursor : undefined
        if (pages > 10) throw new Error('dependency paging did not terminate')
      }
      expect(pages).toBeGreaterThanOrEqual(2)
      expect(pagedIds).toContain(factA)
      expect(pagedIds).toContain(factB)
      // A relation assertion is a different graph and is never an evidence dependency.
      expect(pagedIds).not.toContain(relation)
      expect(new Set(pagedIds).size).toBe(pagedIds.length)

      // A cross-tenant read is a 404 that discloses no evidence of tenant A.
      const crossTenant = await app.inject({
        method: 'GET',
        url: `/api/v1/evidence/${ruleEvidence}`,
        headers: { 'x-test-subject': 'reader-b', 'x-test-scope': 'b' },
      })
      expect(crossTenant.statusCode).toBe(404)
      const crossBody = crossTenant.json() as { error: { code: string }; data?: unknown }
      expect(crossBody.error.code).toBe('EVIDENCE_NOT_FOUND')
      expect(crossBody.data).toBeUndefined()
      expect(JSON.stringify(crossBody)).not.toContain(factA)
    } finally {
      await app.close()
    }
  })

  it('replays immutable history versions and retains the prior basis after a retraction', async () => {
    const statementId = randomUUID()
    await publishBundle(
      [statement({ statementId, objectId: 'device.ui-history', sourceRefs: [evidenceSource(randomUUID())] })],
      [],
      'ui-history',
    )
    const app = createApiServer({
      authenticate: testAuthenticator,
      evidence: { service: provenance },
      history: { service: history },
    })
    try {
      const before = await app.inject({
        method: 'GET',
        url: '/api/v1/objects/device.ui-history/history',
        headers: { 'x-test-subject': 'reader-a' },
      })
      expect(before.statusCode).toBe(200)
      const beforeBody = before.json() as { data: { assertions: readonly { version: string }[] } }
      expect(beforeBody.data.assertions.map((assertion) => assertion.version)).toEqual(['1'])

      await publication.reviseStatement(
        scope.scopeRef,
        {
          expectedRevision: '1',
          revisionId: randomUUID(),
          statementId,
          kind: 'retraction',
          reason: 'the only supporting source was withdrawn',
          recordedAt: '2026-09-21T12:00:00Z',
          actor: ctx.principal.subjectId,
          outbox: {
            outboxId: randomUUID(),
            topic: 'semantic.statement.retracted',
            payload: { statementId },
            idempotencyKey: `retract-ui-${statementId}`,
            availableAt: '2026-09-21T12:00:00Z',
            createdAt: '2026-09-21T12:00:00Z',
          },
        },
        ctx,
      )

      const after = await app.inject({
        method: 'GET',
        url: '/api/v1/objects/device.ui-history/history',
        headers: { 'x-test-subject': 'reader-a' },
      })
      const afterBody = after.json() as {
        data: { assertions: readonly { version: string; status: string; revisionKind?: string }[] }
      }
      const versions = new Map(afterBody.data.assertions.map((assertion) => [assertion.version, assertion]))
      expect([...versions.keys()].sort()).toEqual(['1', '2'])
      expect(versions.get('1')?.status).toBe('active')
      expect(versions.get('2')).toMatchObject({ status: 'retracted', revisionKind: 'retraction' })

      // A recordedAt replay still sees only the version that existed then.
      const replay = await app.inject({
        method: 'GET',
        url: '/api/v1/objects/device.ui-history/history?recordedAt=2026-09-21T06:00:00Z',
        headers: { 'x-test-subject': 'reader-a' },
      })
      const replayBody = replay.json() as { data: { assertions: readonly { version: string }[] } }
      expect(replayBody.data.assertions.map((assertion) => assertion.version)).toEqual(['1'])
    } finally {
      await app.close()
    }
  })
})
