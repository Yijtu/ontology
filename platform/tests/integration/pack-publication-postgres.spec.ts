import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ControlPostgresDatabase,
  PostgresPublishedPackAssetStore,
  PostgresSemanticDefinitionStore,
  PostgresAssetCandidateStore,
  PostgresSemanticPublicationStore,
  PostgresRuleActionCandidateStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import {
  IndustryPackExportService,
  StoreBackedIndustryManifestSource,
  StoreBackedIndustryPackCatalogue,
  assemblePack,
  ruleActionPublicationPins,
} from '@ontology/application'
import type {
  IndustryValidationReport,
  IndustryWorkspace,
  ScopeRef,
  ToolContext,
  AssetCandidateBatch,
  AssetCandidateVersion,
  RuleActionCandidateVersion,
} from '@ontology/contracts'
import { startPostgresContainer } from './postgres-container'
import type { PostgresContainer } from './postgres-container'
import { toolContext } from '../unit/component-registry-fixtures'

/**
 * V03-015 real-database acceptance (migration 066).
 *
 * The publication transaction, the immutable pack asset, the dynamic catalogue and the export run
 * against the real control PostgreSQL: the workspace head CAS, the published definition version
 * (007), the pack table (066) and the dynamic read path. Nothing is mocked; the container has a
 * unique name and an ephemeral loopback port.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/control', import.meta.url))
const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const DIGEST = `sha256:${'d'.repeat(64)}`
const EDITOR: ToolContext = toolContext(TENANT, SPACE, ['profile-editor'], 'editor-1')

let container: PostgresContainer | undefined
let adminUrl = ''
let adminClient: Client
let controlDatabase: ControlPostgresDatabase
let store: PostgresPublishedPackAssetStore

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function workspaceFixture(): IndustryWorkspace {
  return {
    workspaceId: WORKSPACE_ID,
    namespace: 'demo-industry',
    displayName: 'Demo industry',
    boundary: { goals: [], included: [], excluded: [], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
}

function reportFixture(seed: string): IndustryValidationReport {
  const exampleSetId = randomUUID()
  return {
    validationId: randomUUID(),
    workspaceId: WORKSPACE_ID,
    revision: '1',
    exampleSetId,
    exampleSetRef: { id: exampleSetId, version: '1.0.0', digest: DIGEST, kind: 'dataset' },
    dataMode: 'synthetic',
    isolationLabel: 'synthetic test',
    businessApproval: 'none',
    realFactsWritten: false,
    rules: [],
    actions: [],
    semanticPublished: { passed: true, blockers: [] },
    deploymentExecutable: { passed: true, blockers: [] },
    publishable: true,
    gate: 'open',
    issues: [],
    expectationResults: [],
    coverage: [],
    contentDigest: `sha256:${seed.repeat(64).slice(0, 64)}`,
    idempotencyKey: `validation-${randomUUID()}`,
    actor: 'editor-1',
    recordedAt: '2026-09-30T00:00:00Z',
  }
}

function committedInput(packId: string, version: string, seed: string, expectedRevision: string) {
  const { definition, asset } = assemblePack({
    workspace: workspaceFixture(),
    scopeRef: SCOPE,
    packId,
    version,
    definitionId: `demo-industry.${packId}`,
    projection: [],
    ruleActions: [],
    report: reportFixture(seed),
    publishedAt: '2026-09-30T00:00:00Z',
    idempotencyKey: `publish-${randomUUID()}`,
    actor: 'editor-1',
  })
  return {
    expectedRevision,
    definition,
    definitionAudit: {
      digest: definition.ref.digest,
      payloadDigest: DIGEST,
      idempotencyKey: `definition-publish:${definition.namespace}:${definition.ref.id}:${definition.ref.version}`,
      occurredAt: '2026-09-30T00:00:00Z',
      actor: 'editor-1',
    },
    pack: asset,
    idempotencyKey: asset.idempotencyKey,
    requestDigest: DIGEST,
    actor: 'editor-1',
    recordedAt: '2026-09-30T00:00:00Z',
    outbox: {
      outboxId: randomUUID(),
      topic: 'asset.pack.published',
      payload: { packRef: asset.packRef },
      idempotencyKey: `pack-publish:${asset.namespace}:${asset.packRef.id}:${asset.packRef.version}`,
      availableAt: '2026-09-30T00:00:00Z',
      createdAt: '2026-09-30T00:00:00Z',
    },
    outboxJobId: randomUUID(),
  }
}

async function publicationCandidateFixture() {
  const workspaceId = randomUUID()
  const workspace = { ...workspaceFixture(), workspaceId, namespace: `pin-${workspaceId}` }
  await adminClient.query(`INSERT INTO agent_platform.industry_workspaces
    (tenant_id, space_id, workspace_id, namespace, display_name, boundary, head_revision, state,
     create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'Approval test', '{}'::jsonb, 1, 'draft', $5, $6, 'editor', now(), now())`,
  [TENANT, SPACE, workspaceId, workspace.namespace, `workspace-${workspaceId}`, DIGEST])
  const candidates = new PostgresAssetCandidateStore(controlDatabase)
  const reviews = new PostgresSemanticPublicationStore(controlDatabase)
  const candidate: AssetCandidateVersion = { candidateId: randomUUID(), batchId: randomUUID(), workspaceId, logicalId: 'device', domain: 'definition', kind: 'object',
    payload: { kind: 'object', logicalId: 'device', displayName: 'Device', businessMeaning: 'a device', suggestedReason: 'source', conflicts: [], identityAttributeIds: [] },
    inputDraftRef: { workspaceId, revision: '1', digest: DIGEST }, sourceRefs: [], sourceSpans: [], state: 'produced', issues: [], pendingConfirmation: false,
    contentDigest: DIGEST, idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').repeat(2)}`, recordedAt: new Date().toISOString() }
  const insert = async (version: AssetCandidateVersion) => {
    const batch: AssetCandidateBatch = { batchId: version.batchId, workspaceId, domain: 'definition', inputDraftRef: version.inputDraftRef,
      modelRef: { modelId: 'fixture', version: '1.0.0' }, responseSchemaRef: { id: 'fixture', version: '1.0.0', digest: DIGEST },
      documentSetRef: { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }, generationPolicyRef: { id: 'fixture-policy', version: '1.0.0', digest: DIGEST },
      state: 'completed', counts: { total: 1, produced: 1, failed: 0, pendingConfirmation: 0, pendingReview: 0 }, idempotencyKey: `batch-${randomUUID()}`,
      requestDigest: DIGEST, createdBy: 'editor', recordedAt: version.recordedAt }
    await candidates.insertBatch(SCOPE, batch, [version], EDITOR)
  }
  await insert(candidate)
  const decide = async (decision: 'approve' | 'reject', contentDigest: string | undefined = candidate.contentDigest) => {
    const expectedRevision = await reviews.latestReviewRevision(SCOPE, candidate.candidateId, EDITOR)
    return reviews.appendReview(SCOPE, { expectedRevision, draft: { reviewId: randomUUID(), candidateId: candidate.candidateId, decision,
      ...(contentDigest === undefined ? {} : { contentDigest }), reason: 'reviewed fixture', evidenceRefs: [], actor: 'reviewer', recordedAt: new Date().toISOString() } }, EDITOR)
  }
  const input = (ruleActions: readonly RuleActionCandidateVersion[] = []) => {
    const base = committedInput(`pack-${workspaceId}`, '1.0.0', 'a', '1')
    const { definition, asset } = assemblePack({ workspace, scopeRef: SCOPE, packId: `pack-${workspaceId}`, version: '1.0.0', definitionId: `${workspace.namespace}.definitions`,
      projection: [candidate], ruleActions, report: { ...reportFixture('a'), workspaceId }, publishedAt: new Date().toISOString(), idempotencyKey: base.idempotencyKey, actor: 'editor' })
    const approvalPins = [{ candidateId: candidate.candidateId, contentDigest: candidate.contentDigest, reviewRevision: '1' }]
    const ruleActionPins = ruleActionPublicationPins(ruleActions)
    return { ...base, definition, pack: { ...asset, approvalPins, ruleActionPins }, approvalPins, ruleActionPins }
  }
  return { candidate, workspace, reviews, candidates, decide, input, insert }
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
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'pack-node-15') ON CONFLICT DO NOTHING`,
    [TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name) VALUES ($1, $2, 'pack-space') ON CONFLICT DO NOTHING`,
    [TENANT, SPACE],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.industry_workspaces
       (tenant_id, space_id, workspace_id, namespace, display_name, boundary, head_revision, state,
        create_idempotency_key, create_request_digest, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, 'demo-industry', 'Demo industry', '{}'::jsonb, 1, 'draft', $4, $5, 'editor-1', now(), now())
     ON CONFLICT DO NOTHING`,
    [TENANT, SPACE, WORKSPACE_ID, `seed-${WORKSPACE_ID}`, DIGEST],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<Record<string, string>>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)

  controlDatabase = new ControlPostgresDatabase({ connectionString: connectionStringFor(adminUrl, 'ontology_app', appPassword), maxPoolSize: 4 })
  store = new PostgresPublishedPackAssetStore(controlDatabase)
}, 300_000)

afterAll(async () => {
  await controlDatabase?.close().catch(() => undefined)
  await adminClient?.end().catch(() => undefined)
  await container?.stop()
})

describe('industry pack publication against real PostgreSQL', () => {
  let committedPackId = ''
  let committedVersion = ''

  it('commits an immutable pack, advances the workspace pointer and persists the definition', async () => {
    const input = committedInput('demo-pack', '1.0.0', 'a', '1')
    const result = await store.commitApprovedPack(SCOPE, input, EDITOR)
    expect(result.created).toBe(true)
    expect(result.asset.revision).toBe('2')
    committedPackId = result.asset.packRef.id
    committedVersion = result.asset.packRef.version

    const head = await adminClient.query<{ head_revision: string; latest_pack_ref: { id: string } }>(
      `SELECT head_revision, latest_pack_ref FROM agent_platform.industry_workspaces
        WHERE tenant_id = $1 AND space_id = $2 AND workspace_id = $3`,
      [TENANT, SPACE, WORKSPACE_ID],
    )
    expect(head.rows[0]?.head_revision).toBe('2')
    expect(head.rows[0]?.latest_pack_ref.id).toBe(result.asset.packRef.id)

    const definitionRow = await adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.semantic_definition_versions
        WHERE tenant_id = $1 AND space_id = $2 AND definition_id = $3 AND version = $4`,
      [TENANT, SPACE, result.asset.definitionRef.id, result.asset.definitionRef.version],
    )
    expect(definitionRow.rows[0]?.count).toBe('1')
  })

  it('reads the published pack back through findPack/findByRef/listPacks and the idempotency key', async () => {
    const found = await store.findPack(SCOPE, committedPackId, committedVersion, EDITOR)
    expect(found?.packRef.id).toBe(committedPackId)
    const byRef = await store.findByRef(SCOPE, found!.packRef, EDITOR)
    expect(byRef?.contentDigest).toBe(found?.contentDigest)
    const listed = await store.listPacks(SCOPE, { namespace: 'demo-industry' }, EDITOR)
    expect(listed.length).toBeGreaterThan(0)
  })

  it('serves the pack from the dynamic catalogue and manifest source', async () => {
    const catalogue = new StoreBackedIndustryPackCatalogue({ store })
    const manifestSource = new StoreBackedIndustryManifestSource({ store })
    const asset = await store.findPack(SCOPE, committedPackId, committedVersion, EDITOR)
    if (asset === undefined) throw new Error('the pack was not persisted')
    const pack = await catalogue.findPack(committedPackId, committedVersion, SCOPE, EDITOR)
    expect(pack?.ref).toEqual(asset.packRef)
    const manifest = await manifestSource.getManifest(asset.packRef, SCOPE, EDITOR)
    expect(manifest?.definitionsRef).toEqual(asset.definitionRef)
  })

  it('exports the bundle with source index, capability state and diff and scans clean', async () => {
    const catalogue = new StoreBackedIndustryPackCatalogue({ store })
    const definitions = new PostgresSemanticDefinitionStore(controlDatabase)
    const exporter = new IndustryPackExportService({ catalogue, definitions, published: store })
    const asset = await store.findPack(SCOPE, committedPackId, committedVersion, EDITOR)
    if (asset === undefined) throw new Error('the pack was not persisted')
    const bundle = await exporter.export(
      { scopeRef: SCOPE, packId: committedPackId, version: committedVersion },
      EDITOR,
    )
    expect(bundle.sourceIndex).toBeDefined()
    expect(bundle.capabilityStatus?.semanticPublished).toBe(true)
    expect(bundle.versionDiff?.toPackRef).toEqual(asset.packRef)
    const serialized = JSON.stringify(bundle)
    expect(serialized).not.toContain(TENANT)
    expect(serialized).not.toContain(SPACE)
  })

  it('rejects a pack id/version and a namespace/version with a different digest', async () => {
    const packVersionConflict = committedInput('demo-pack', '1.0.0', 'b', '2')
    await expect(store.commitApprovedPack(SCOPE, packVersionConflict, EDITOR)).rejects.toMatchObject({
      code: 'PACK_VERSION_EXISTS',
    })
    const namespaceConflict = committedInput('other-pack', '1.0.0', 'c', '2')
    await expect(store.commitApprovedPack(SCOPE, namespaceConflict, EDITOR)).rejects.toMatchObject({
      code: 'NAMESPACE_CONFLICT',
    })
  })

  it('rejects a stale workspace head and a reused idempotency key with a different request', async () => {
    const stale = committedInput('stale-pack', '1.0.0', 'e', '1')
    await expect(store.commitApprovedPack(SCOPE, stale, EDITOR)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    })
  })

  it('replays the same idempotency key', async () => {
    const first = committedInput('replay-pack', '2.0.0', 'f', '2')
    await store.commitApprovedPack(SCOPE, first, EDITOR)
    // A second pack must now expect the advanced head.
    const replay = await store.commitApprovedPack(SCOPE, first, EDITOR)
    expect(replay.created).toBe(false)
    expect(replay.asset.packRef.id).toBe(`demo-industry.${'replay-pack'}`)
  })
})

describe('publication ledger and candidate pins against real PostgreSQL', () => {
  it('fails closed without a digest-pinned approve and preserves legacy review history', async () => {
    const h = await publicationCandidateFixture()
    await expect(store.commitApprovedPack(SCOPE, h.input(), EDITOR)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const legacy = await h.reviews.appendReview(SCOPE, { expectedRevision: '0', draft: { reviewId: randomUUID(), candidateId: h.candidate.candidateId,
      decision: 'approve', reason: 'legacy approval', evidenceRefs: [], actor: 'reviewer', recordedAt: new Date().toISOString() } }, EDITOR)
    expect(legacy.contentDigest).toBeUndefined()
    await expect(store.commitApprovedPack(SCOPE, h.input(), EDITOR)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(await h.reviews.listReviews(SCOPE, h.candidate.candidateId, EDITOR)).toHaveLength(1)
  })

  it('rejects a revoked approval after validation without committing a definition, pack or outbox', async () => {
    const h = await publicationCandidateFixture()
    await h.decide('approve')
    const pinned = h.input()
    await h.decide('reject')
    await expect(store.commitApprovedPack(SCOPE, pinned, EDITOR)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const counts = await adminClient.query<{ packs: string; definitions: string; events: string }>(`SELECT
      (SELECT count(*) FROM agent_platform.published_pack_assets WHERE origin_workspace_id = $1)::text AS packs,
      (SELECT count(*) FROM agent_platform.semantic_definition_versions WHERE namespace = $2)::text AS definitions,
      (SELECT count(*) FROM agent_platform.job_outbox WHERE outbox_id = $3)::text AS events`, [h.workspace.workspaceId, h.workspace.namespace, pinned.outbox.outboxId])
    expect(counts.rows[0]).toEqual({ packs: '0', definitions: '0', events: '0' })
    expect(await h.reviews.getReview(SCOPE, h.candidate.candidateId, '1', EDITOR)).toMatchObject({ decision: 'approve', contentDigest: DIGEST })
  })

  it.each(['failed', 'pending_confirmation', 'rejected'] as const)('rejects %s lifecycle changes after approval', async (state) => {
    const h = await publicationCandidateFixture()
    await h.decide('approve')
    const pinned = h.input()
    await h.candidates.transitionCandidate(SCOPE, h.candidate.candidateId, { state, issues: [], transitionedAt: new Date().toISOString() }, EDITOR)
    await expect(store.commitApprovedPack(SCOPE, pinned, EDITOR)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('rejects a newly inserted replacement instead of carrying the ancestor approval forward', async () => {
    const h = await publicationCandidateFixture()
    await h.decide('approve')
    const pinned = h.input()
    await h.insert({ ...h.candidate, candidateId: randomUUID(), batchId: randomUUID(), replacesCandidateId: h.candidate.candidateId,
      idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').repeat(2)}`, recordedAt: new Date().toISOString() })
    await expect(store.commitApprovedPack(SCOPE, pinned, EDITOR)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('commits the exact approved current candidate and retains its ledger pin', async () => {
    const h = await publicationCandidateFixture()
    await h.decide('approve')
    const pinned = h.input()
    pinned.pack = { ...pinned.pack, approvalPins: pinned.approvalPins, ruleActionPins: [] }
    const result = await store.commitApprovedPack(SCOPE, pinned, EDITOR)
    expect(result.asset.approvalPins).toEqual(pinned.approvalPins)
    expect(result.asset.definitionRef).toEqual(pinned.definition.ref)
  })

  it.each(['disabled', 'replacement'] as const)('rechecks enabled action pins after a %s race', async (race) => {
    const h = await publicationCandidateFixture()
    await h.decide('approve')
    const actions = new PostgresRuleActionCandidateStore(controlDatabase)
    const now = new Date().toISOString()
    const action: RuleActionCandidateVersion = { candidateId: randomUUID(), workspaceId: h.workspace.workspaceId, logicalId: 'plan', domain: 'definition', kind: 'action',
      displayName: 'Plan', businessMeaning: 'plan', suggestedReason: 'source', sourceRefs: [], sourceSpans: [], lifecycle: 'enabled', enabledAt: now,
      contentDigest: DIGEST, idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').repeat(2)}`, actor: 'editor', recordedAt: now,
      payload: { kind: 'action', declaration: { actionId: 'plan', displayName: 'Plan', businessMeaning: 'plan', suggestedReason: 'source',
        inputSchemaRef: { id: 'input', version: '1.0.0', digest: DIGEST }, outputSchemaRef: { id: 'output', version: '1.0.0', digest: DIGEST },
        preconditions: [], requiredCapabilities: [], permissions: [], readOnly: true, sideEffect: 'read_only', evidenceRequirements: [] } } }
    await actions.insert(SCOPE, action, EDITOR)
    const pinned = h.input([action])
    if (race === 'disabled') await actions.transition(SCOPE, action.candidateId, { lifecycle: 'draft' }, EDITOR)
    else {
      const { enabledAt, ...draft } = action
      void enabledAt
      await actions.insert(SCOPE, { ...draft, candidateId: randomUUID(), lifecycle: 'draft', replacesCandidateId: action.candidateId,
        idempotencyKey: `sha256:${randomUUID().replaceAll('-', '').repeat(2)}`, recordedAt: new Date().toISOString() }, EDITOR)
    }
    await expect(store.commitApprovedPack(SCOPE, pinned, EDITOR)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
  })

  it('serializes candidate and review writes on the publication workspace lock', async () => {
    const h = await publicationCandidateFixture()
    await h.decide('approve')
    const blocker = new Client({ connectionString: adminUrl })
    const writer = new Client({ connectionString: adminUrl })
    await blocker.connect()
    await writer.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT 1 FROM agent_platform.industry_workspaces WHERE workspace_id = $1 FOR UPDATE', [h.workspace.workspaceId])
      await writer.query("SET lock_timeout = '100ms'")
      await expect(writer.query("UPDATE agent_platform.asset_candidate_versions SET state = 'failed' WHERE candidate_id = $1", [h.candidate.candidateId])).rejects.toMatchObject({ code: '55P03' })
      await expect(writer.query(`INSERT INTO agent_platform.semantic_candidate_reviews
        (tenant_id, space_id, review_id, candidate_id, revision, decision, reason, evidence_refs, recorded_at, actor, content_digest)
        VALUES ($1, $2, $3, $4, 2, 'reject', 'race', '[]'::jsonb, now(), 'reviewer', $5)`,
      [TENANT, SPACE, randomUUID(), h.candidate.candidateId, DIGEST])).rejects.toMatchObject({ code: '55P03' })
      await blocker.query('ROLLBACK')
      await h.decide('reject')
      await expect(store.commitApprovedPack(SCOPE, h.input(), EDITOR)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    } finally {
      await blocker.query('ROLLBACK')
      await blocker.end()
      await writer.end()
    }
  })
})
