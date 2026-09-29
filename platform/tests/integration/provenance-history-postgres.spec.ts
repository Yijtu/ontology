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
  PostgresMaterializationStore,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import { createApiServer, createPostgresProvenanceRead } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { ProvenanceReadService } from '@ontology/provenance'
import {
  HistoryReadService,
  IncrementalMaterializer,
  PublishedSemanticSource,
  sha256DigestOf,
} from '@ontology/semantic-engine'
import type {
  EvidenceEnvelope,
  EvidenceKind,
  MaterializationChange,
  PublishedRuleVersion,
  PublishedStatement,
  PublishSemanticPublicationInput,
  ResourceRef,
  RevisionString,
  RuleComputationArtifact,
  SourceSnapshot,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from '../unit/component-registry-fixtures'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness, JobTestScope } from './job-postgres-harness'
import { FixturePublishedIdentityReader } from './published-identity-reader'

const DIGEST = `sha256:${'a'.repeat(64)}`
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }
const RUN_ID = '33333333-3333-4333-8333-333333333333'
// The second tenant/space `startJobDatabase` seeds, so a cross-tenant HTTP read is attributed
// to a real scope rather than a forged one.
const TENANT_B = '44444444-4444-4444-8444-444444444444'
const SPACE_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

let harness: JobDbHarness
let scope: JobTestScope
let ctx: ToolContext
let database: ControlPostgresDatabase
let publication: PostgresSemanticPublicationStore
let materializationStore: PostgresMaterializationStore
let materializer: IncrementalMaterializer
let identity: FixturePublishedIdentityReader
let evidence: PostgresEvidenceStore
let blobStore: LocalImmutableBlobStore
let objectStore: FileSystemObjectStore
let registry: PostgresArtifactRegistry
let provenance: ProvenanceReadService
let history: HistoryReadService
let tempDir: string
let jobId: Uuid
const evidenceRefs = new Map<Uuid, ResourceRef>()

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function sameInstant(left: string, right: string): boolean {
  return Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right)
}

function evidenceSource(id: Uuid): ResourceRef {
  return evidenceRefs.get(id) ?? { id, version: '1.0.0', digest: DIGEST, kind: 'evidence' }
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
  const stored = await evidence.record(scope.scopeRef, envelope, ctx)
  evidenceRefs.set(input.evidenceId, stored.evidenceRef)
}

function immutableSnapshot(): SourceSnapshot {
  return {
    sourceRef: { namespace: 'postgres', sourceId: 'meter' },
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

function ruleVersion(
  ruleId: string,
  attributeId: string,
  objectId = 'device.battery',
): Omit<PublishedRuleVersion, 'publicationId'> {
  return {
    ruleVersionId: randomUUID(),
    ruleId,
    version: '1',
    objectId,
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
): Promise<RevisionString> {
  const publicationId = randomUUID()
  const publishedStatements = statements.map((entry) => ({ ...entry, publicationId }))
  const publishedRules = ruleVersions.map((rule) => ({ ...rule, publicationId }))
  identity.bindStatements(publishedStatements)
  const input: PublishSemanticPublicationInput = {
    expectedRevision: await publication.latestPublicationRevision(scope.scopeRef, ctx),
    publication: {
      publicationId,
      versionRef: { id: publicationId, version: '1.0.0', digest: DIGEST },
      schemaRef: { id: 'home-energy.core', version: '1.0.0', digest: DIGEST },
      approvedCandidateRefs: [],
      statements: publishedStatements,
      ruleVersions: publishedRules,
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
  const recordedSeq = await publication.latestReadRevision(scope.scopeRef, ctx)
  if (publishedRules.length > 0) {
    const publishedRule = publishedRules[0]
    if (publishedRule === undefined) throw new Error('rule publication returned no rule version')
    const change: MaterializationChange = {
      changeId: randomUUID(),
      scopeRef: scope.scopeRef,
      recordedSeq,
      recordedAt: publishedRule.recordedAt,
      kind: 'rule_changed',
      ruleId: publishedRule.ruleId,
      propositionKey: publishedRule.objectId,
    }
    const advance = await materializer.applyChange(change, ctx)
    if (advance.recomputedRuleIds.length === 0 || advance.appendedSlices === 0) {
      throw new Error(`materialization produced no rule support for publication ${publicationId}`)
    }
  }
  return recordedSeq
}

async function publishedRuleRef(ruleId: string): Promise<VersionRef> {
  const versions = await publication.listRuleVersions(scope.scopeRef, {}, ctx)
  const rule = versions.find((candidate) => candidate.ruleId === ruleId)
  if (rule === undefined) throw new Error(`published rule ${ruleId} was not found`)
  return { id: rule.ruleVersionId, version: `${rule.version}.0.0`, digest: sha256DigestOf(rule) }
}

async function materializedArtifact(
  ruleRefValue: VersionRef,
  subjectEntityId: string,
  recordedSeq: RevisionString,
  validAt: string = VALIDITY.validFrom,
): Promise<RuleComputationArtifact> {
  const slices = await materializationStore.readSlices(scope.scopeRef, {
    validAt,
    asOfRecordedSeq: recordedSeq,
    limit: 10_000,
  }, ctx)
  const artifact = slices.flatMap((slice) => slice.conclusion.ruleArtifacts ?? []).find((candidate) =>
    candidate.subjectEntityId === subjectEntityId &&
    candidate.ruleRef.id === ruleRefValue.id &&
    candidate.ruleRef.version === ruleRefValue.version &&
    candidate.ruleRef.digest === ruleRefValue.digest &&
    sameInstant(candidate.validAt ?? '', validAt) &&
    candidate.asOfRecordedSeq === recordedSeq,
  )
  if (artifact === undefined) throw new Error(`no materialized support artifact for ${ruleRefValue.id} and ${subjectEntityId}`)
  return artifact
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
  scope = await createJobScope(harness.adminClient, 'provenance-history')
  ctx = toolContext(
    scope.tenantId,
    scope.spaceId,
    ['scoped-reader', 'semantic-publisher', 'platform-admin'],
    'reader',
    RUN_ID,
  )
  database = new ControlPostgresDatabase({ connectionString: harness.appUrl, maxPoolSize: 6 })

  tempDir = await mkdtemp(join(tmpdir(), 'ontology-provenance-'))
  objectStore = new FileSystemObjectStore(tempDir)
  await objectStore.init()
  registry = new PostgresArtifactRegistry({ connectionString: harness.appUrl, maxPoolSize: 4 })
  blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  const provenanceComposition = createPostgresProvenanceRead({ database, blobStore })
  publication = provenanceComposition.publication
  evidence = provenanceComposition.evidence
  provenance = provenanceComposition.provenance
  history = provenanceComposition.history
  identity = new FixturePublishedIdentityReader()
  materializationStore = new PostgresMaterializationStore(database)
  materializer = new IncrementalMaterializer({
    publishedSource: new PublishedSemanticSource(publication, { identity }),
    materialization: materializationStore,
  })

  jobId = randomUUID()
  await harness.adminClient.query(
    `INSERT INTO agent_platform.jobs (
       tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
       idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'ingestion', 'provenance-history', $4, '1.0.0', 'published',
       $5, $6, 1, '{}'::jsonb, now(), now(), 'provenance-history-test', now())`,
    [
      scope.tenantId,
      scope.spaceId,
      jobId,
      randomUUID(),
      `provenance-history-${jobId.slice(0, 8)}`,
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

describe('on-demand provenance against real PostgreSQL and real blob-local', () => {
  it('traces a conclusion to its rule, premise groups and sources and states re-readability', async () => {
    const factEvidenceA = randomUUID()
    const factEvidenceB = randomUUID()
    const relationEvidence = randomUUID()
    const ruleEvidence = randomUUID()
    const ruleId = 'rule.battery-ready'

    const archivedSnapshot = await archive('meter snapshot')
    await recordEvidence({ evidenceId: factEvidenceA, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })
    await recordEvidence({ evidenceId: factEvidenceB, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })
    await recordEvidence({ evidenceId: relationEvidence, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })

    const recordedSeq = await publishBundle(
      [
        statement({
          statementId: randomUUID(),
          subjectEntityId: 'entity.battery',
          predicate: 'device',
          value: { attributes: [{ attributeId: 'device.battery_present', value: true }] },
          sourceRefs: [evidenceSource(factEvidenceA)],
        }),
        statement({
          statementId: randomUUID(),
          subjectEntityId: 'entity.battery',
          predicate: 'device',
          value: { attributes: [{ attributeId: 'device.battery_present', value: true }] },
          sourceRefs: [evidenceSource(factEvidenceB)],
        }),
        statement({
          statementId: randomUUID(),
          kind: 'relation',
          relationId: 'device.located_in',
          predicate: 'device.located_in',
          value: { value: 'room.one' },
          sourceRefs: [evidenceSource(relationEvidence)],
        }),
      ],
      [ruleVersion(ruleId, 'device.battery_present')],
      'provenance-support',
    )
    const rule = await publishedRuleRef(ruleId)
    const payloadRef = await archive(JSON.stringify(await materializedArtifact(rule, 'entity.battery', recordedSeq)), 'application/json')
    await recordEvidence({
      evidenceId: ruleEvidence,
      kind: 'rule_derivation',
      ruleRef: rule,
      recordedSeq,
      payloadRef,
      sourceSnapshots: [
        {
          sourceRef: { namespace: 'postgres', sourceId: 'billing' },
          schemaVersion: '1',
          readAt: '2026-09-21T05:30:00Z',
          consistency: 'repeatable_read',
          resultDigest: DIGEST,
          archivedResultRef: archivedSnapshot,
        },
      ],
    })

    const view = await provenance.getEvidence(ruleEvidence, {}, ctx)
    expect(view.outcome).toBe('verifiable')
    expect(view.ruleRefs.map((ref) => ref.id)).toEqual([rule.id])
    expect(view.premiseGroups).toHaveLength(1)
    expect([...view.premiseGroups[0]!.alternativeEvidenceIds].sort()).toEqual(
      [factEvidenceA, factEvidenceB].sort(),
    )
    expect(view.sources[0]?.reReadability).toBe('archived_snapshot_only')
    expect(view.originalSourceReReadable).toBe(true)
    expect(view.archivedResult).toMatchObject({ verified: true })

    const graph = await provenance.getDependencies(ruleEvidence, { direction: 'outbound', depth: 1 }, ctx)
    const targets = graph.edges.map((edge) => edge.toEvidenceId)
    expect(targets).toContain(factEvidenceA)
    expect(targets).toContain(factEvidenceB)
    // A relation assertion is a different graph and is not an evidence dependency.
    expect(targets).not.toContain(relationEvidence)
    expect(graph.edges.some((edge) => edge.origin === 'support')).toBe(true)
  })

  it('pins one of two entity instances from an archived artifact and keeps that support after retraction', async () => {
    const evidenceA = randomUUID()
    const evidenceB = randomUUID()
    const unpinnedEvidence = randomUUID()
    const pinnedEvidence = randomUUID()
    const parentA = randomUUID()
    const parentB = randomUUID()
    const ruleId = 'rule.multi-entity'
    await recordEvidence({ evidenceId: evidenceA, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })
    await recordEvidence({ evidenceId: evidenceB, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })

    const recordedSeq = await publishBundle([
      statement({
        statementId: parentA,
        subjectEntityId: 'entity.a',
        objectId: 'device.battery',
        predicate: 'device.battery',
        value: { attributes: [{ attributeId: 'device.battery_present', value: true }] },
        sourceRefs: [evidenceSource(evidenceA)],
      }),
      statement({
        statementId: parentB,
        subjectEntityId: 'entity.b',
        objectId: 'device.battery',
        predicate: 'device.battery',
        value: { attributes: [{ attributeId: 'device.battery_present', value: true }] },
        sourceRefs: [evidenceSource(evidenceB)],
      }),
    ], [ruleVersion(ruleId, 'device.battery_present')], 'provenance-two-entities')
    const rule = await publishedRuleRef(ruleId)
    const selectedArtifact = await materializedArtifact(rule, 'entity.b', recordedSeq)
    const payloadRef = await archive(JSON.stringify(selectedArtifact), 'application/json')
    await recordEvidence({
      evidenceId: unpinnedEvidence,
      kind: 'rule_derivation',
      ruleRef: rule,
      recordedSeq,
      sourceSnapshots: [immutableSnapshot()],
    })
    await recordEvidence({
      evidenceId: pinnedEvidence,
      kind: 'rule_derivation',
      ruleRef: rule,
      recordedSeq,
      payloadRef,
      sourceSnapshots: [immutableSnapshot()],
    })

    const unpinned = await provenance.getEvidence(unpinnedEvidence, {}, ctx)
    expect(unpinned.outcome).toBe('verifiable')
    expect(unpinned.supportResolution).toMatchObject({ state: 'ambiguous', complete: false })
    expect(unpinned.dependencies.filter((edge) => edge.origin === 'support')).toEqual([])

    const pinned = await provenance.getEvidence(pinnedEvidence, {}, ctx)
    expect(pinned.supportResolution).toMatchObject({ state: 'resolved', complete: true })
    expect(pinned.dependencies.filter((edge) => edge.origin === 'support').map((edge) => edge.toEvidenceId))
      .toEqual([evidenceB])
    expect(pinned.dependencies.map((edge) => edge.toEvidenceId)).not.toContain(evidenceA)

    const revisionId = randomUUID()
    const retractedAt = '2026-09-21T12:00:00Z'
    await publication.reviseStatement(scope.scopeRef, {
      expectedRevision: '1',
      revisionId,
      statementId: parentB,
      kind: 'retraction',
      reason: 'the source assertion was withdrawn',
      recordedAt: retractedAt,
      actor: ctx.principal.subjectId,
      outbox: {
        outboxId: randomUUID(),
        topic: 'semantic.statement.retracted',
        payload: { statementId: parentB },
        idempotencyKey: `multi-entity-retract-${parentB}`,
        availableAt: retractedAt,
        createdAt: retractedAt,
      },
    }, ctx)
    const retractedSeq = await publication.latestReadRevision(scope.scopeRef, ctx)
    await materializer.applyChange({
      changeId: randomUUID(),
      scopeRef: scope.scopeRef,
      recordedSeq: retractedSeq,
      recordedAt: retractedAt,
      kind: 'assertion_retracted',
      logicalAssertionId: parentB,
      predicate: 'device.battery',
      subjectEntityId: 'entity.b',
      validity: VALIDITY,
    }, ctx)

    const historical = await provenance.getEvidence(pinnedEvidence, {}, ctx)
    expect(historical.supportResolution).toMatchObject({ state: 'resolved', complete: true })
    expect(historical.dependencies.filter((edge) => edge.origin === 'support').map((edge) => edge.toEvidenceId))
      .toEqual([evidenceB])
  })

  it('marks a truncated traversal explicitly and pages with a cursor', async () => {
    const ruleEvidence = randomUUID()
    const factEvidence = randomUUID()
    const ruleId = 'rule.second'
    await recordEvidence({ evidenceId: factEvidence, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })
    const recordedSeq = await publishBundle(
      [statement({
        statementId: randomUUID(),
        subjectEntityId: 'entity.second',
        objectId: 'device.second',
        propositionKey: 'device.second',
        predicate: 'device.second',
        value: { attributes: [{ attributeId: 'device.second_present', value: true }] },
        sourceRefs: [evidenceSource(factEvidence)],
      })],
      [ruleVersion(ruleId, 'device.second_present', 'device.second')],
      'provenance-truncation',
    )
    const rule = await publishedRuleRef(ruleId)
    const payloadRef = await archive(JSON.stringify(await materializedArtifact(rule, 'entity.second', recordedSeq)), 'application/json')
    await recordEvidence({
      evidenceId: ruleEvidence,
      kind: 'rule_derivation',
      ruleRef: rule,
      recordedSeq,
      payloadRef,
      sourceSnapshots: [immutableSnapshot()],
    })

    const first = await provenance.getDependencies(ruleEvidence, { direction: 'outbound', depth: 1, limit: 1 }, ctx)
    expect(first.nodes).toHaveLength(1)
    expect(first.coverage.truncated).toBe(true)
    expect(first.coverage.cursor).toBeDefined()

    const next = await provenance.getDependencies(
      ruleEvidence,
      { direction: 'outbound', depth: 1, limit: 1, cursor: first.coverage.cursor ?? '' },
      ctx,
    )
    expect(next.nodes[0]?.evidenceId).toBe(factEvidence)
  })

  it('returns unverifiable when the archived artifact is missing from storage', async () => {
    const evidenceId = randomUUID()
    const archived = await archive('to be removed')
    await recordEvidence({
      evidenceId,
      kind: 'computation',
      recordedSeq: '1',
      sourceSnapshots: [
        {
          sourceRef: { namespace: 'postgres', sourceId: 'warehouse' },
          schemaVersion: '1',
          readAt: '2026-09-21T05:00:00Z',
          consistency: 'repeatable_read',
          resultDigest: archived.digest,
          archivedResultRef: archived,
        },
      ],
    })
    await objectStore.remove(archived.digest)

    const view = await provenance.getEvidence(evidenceId, {}, ctx)
    expect(view.outcome).toBe('unverifiable')
    expect(view.sources[0]?.reReadability).toBe('unverifiable')
    expect(view.reason).toContain('archived source snapshot')
  })

  it('refuses a cross-tenant evidence read without disclosing existence', async () => {
    const evidenceId = randomUUID()
    await recordEvidence({ evidenceId, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })

    const ctxB = toolContext(TENANT_B, SPACE_B, ['scoped-reader'], 'reader-b', RUN_ID)
    const error = await provenance.getEvidence(evidenceId, {}, ctxB).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'EVIDENCE_NOT_FOUND', httpStatus: 404 })
    expect(String(error)).toContain('no authorized evidence')
  })
})

describe('object history against real PostgreSQL', () => {
  it('replays immutable versions at recordedAt and validAt without erasing history', async () => {
    const statementId = randomUUID()
    await publishBundle(
      [statement({
        statementId,
        subjectEntityId: 'entity.history',
        objectId: 'device.history',
        predicate: 'device.history',
        value: { attributes: [{ attributeId: 'device.history.present', value: true }] },
        sourceRefs: [evidenceSource(randomUUID())],
      })],
      [],
      'history-publish',
    )

    const before = await history.getObjectHistory('device.history', {}, ctx)
    expect(before.assertions.map((assertion) => assertion.version)).toEqual(['1'])

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
          idempotencyKey: `retract-history-${statementId}`,
          availableAt: '2026-09-21T12:00:00Z',
          createdAt: '2026-09-21T12:00:00Z',
        },
      },
      ctx,
    )

    const full = await history.getObjectHistory('device.history', {}, ctx)
    const versions = new Map(full.assertions.map((assertion) => [assertion.version, assertion]))
    expect([...versions.keys()].sort()).toEqual(['1', '2'])
    expect(versions.get('1')).toMatchObject({ status: 'active' })
    expect(versions.get('2')).toMatchObject({ status: 'retracted', revisionKind: 'retraction' })

    const asOfBefore = await history.getObjectHistory(
      'device.history',
      { recordedAt: '2026-09-21T06:00:00Z' },
      ctx,
    )
    expect(asOfBefore.assertions.map((assertion) => assertion.version)).toEqual(['1'])

    const validOutside = await history.getObjectHistory(
      'device.history',
      { validAt: '2026-09-23T00:00:00Z' },
      ctx,
    )
    expect(validOutside.assertions).toHaveLength(0)

    const validInside = await history.getObjectHistory(
      'device.history',
      { validAt: '2026-09-21T06:00:00Z' },
      ctx,
    )
    expect(validInside.assertions.map((assertion) => assertion.version).sort()).toEqual(['1', '2'])

    // RLS limits history to the same domain: another tenant sees nothing, not another tenant's
    // records, and the empty result does not disclose that the object exists.
    const ctxB = toolContext(TENANT_B, SPACE_B, ['scoped-reader'], 'reader-b', RUN_ID)
    const crossTenant = await history.getObjectHistory('device.history', {}, ctxB)
    expect(crossTenant.assertions).toHaveLength(0)
  })
})

describe('evidence and history HTTP surface', () => {
  it('serves the provenance, dependency and history routes and hides another tenant', async () => {
    const factEvidence = randomUUID()
    const ruleEvidence = randomUUID()
    const ruleId = 'rule.http'
    await recordEvidence({ evidenceId: factEvidence, kind: 'observation', sourceSnapshots: [immutableSnapshot()], recordedSeq: '1' })
    const recordedSeq = await publishBundle(
      [statement({
        statementId: randomUUID(),
        subjectEntityId: 'entity.http',
        objectId: 'device.http',
        propositionKey: 'device.http',
        predicate: 'device.http',
        value: { attributes: [{ attributeId: 'device.http_present', value: true }] },
        sourceRefs: [evidenceSource(factEvidence)],
      })],
      [ruleVersion(ruleId, 'device.http_present', 'device.http')],
      'http-publish',
    )
    const rule = await publishedRuleRef(ruleId)
    const payloadRef = await archive(JSON.stringify(await materializedArtifact(rule, 'entity.http', recordedSeq)), 'application/json')
    await recordEvidence({
      evidenceId: ruleEvidence,
      kind: 'rule_derivation',
      ruleRef: rule,
      recordedSeq,
      payloadRef,
      sourceSnapshots: [immutableSnapshot()],
    })

    const app = createApiServer({
      authenticate: testAuthenticator,
      evidence: { service: provenance },
      history: { service: history },
    })
    try {
      const own = await app.inject({
        method: 'GET',
        url: `/api/v1/evidence/${ruleEvidence}`,
        headers: { 'x-test-subject': 'reader-a' },
      })
      expect(own.statusCode).toBe(200)
      const ownBody = own.json() as { data: { outcome: string; ruleRefs: unknown[] } }
      expect(ownBody.data.outcome).toBe('verifiable')
      expect(ownBody.data.ruleRefs).toHaveLength(1)

      const dependencies = await app.inject({
        method: 'GET',
        url: `/api/v1/evidence/${ruleEvidence}/dependencies?direction=outbound&depth=1&limit=1`,
        headers: { 'x-test-subject': 'reader-a' },
      })
      expect(dependencies.statusCode).toBe(200)
      const depBody = dependencies.json() as {
        data: { coverage: { truncated: boolean } }
        meta: { nextCursor?: string }
      }
      expect(depBody.data.coverage.truncated).toBe(true)
      expect(depBody.meta.nextCursor).toBeDefined()

      const exported = await app.inject({
        method: 'GET',
        url: `/api/v1/evidence/${ruleEvidence}/export`,
        headers: { 'x-test-subject': 'reader-a' },
      })
      expect(exported.statusCode).toBe(200)

      const crossTenant = await app.inject({
        method: 'GET',
        url: `/api/v1/evidence/${ruleEvidence}`,
        headers: { 'x-test-subject': 'reader-b', 'x-test-scope': 'b' },
      })
      expect(crossTenant.statusCode).toBe(404)
      expect((crossTenant.json() as { error: { code: string } }).error.code).toBe('EVIDENCE_NOT_FOUND')

      const objectHistory = await app.inject({
        method: 'GET',
        url: '/api/v1/objects/device.http/history',
        headers: { 'x-test-subject': 'reader-a' },
      })
      expect(objectHistory.statusCode).toBe(200)
      const historyBody = objectHistory.json() as { data: { assertions: unknown[] } }
      expect(historyBody.data.assertions.length).toBeGreaterThan(0)

      const badDirection = await app.inject({
        method: 'GET',
        url: `/api/v1/evidence/${ruleEvidence}/dependencies?direction=sideways`,
        headers: { 'x-test-subject': 'reader-a' },
      })
      expect(badDirection.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})
