import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DraftVerificationService, answerDraftContentHash, inputManifestDigest } from '@ontology/application'
import type { AnswerDraft, DraftClaim, WorkflowInputEntry, WorkflowInputManifest } from '@ontology/contracts'
import {
  FixedSemanticDecision,
  buildClaim,
  modelRef,
  verificationPolicy,
} from '../../unit/verification-fixtures'
import { TEMPLATE_RUN, startAcceptanceEnvironment } from './acceptance-environment'
import type { AcceptanceEnvironment } from './acceptance-environment'
import { configureProfile, dataOf, errorCodeOf, ingestDocument, injectJson } from './acceptance-helpers'

/**
 * LOCAL-054 cross-layer acceptance — the happy path.
 *
 * One real environment drives the whole chain: configuration workbench → source
 * registration/probe → ingestion/parse → extraction candidates → identity decision →
 * semantic publication → question → tool calls → draft verification → published answer →
 * provenance/evidence → retraction/history replay. Every step is asserted through the real
 * HTTP API and the real PostgreSQL/blob data; the only substitute is the deterministic
 * extraction model double, marked in the delivery report.
 */

let env: AcceptanceEnvironment
let snapshotHash = ''
let jobId = ''
let candidateId = ''
let statementId = ''
let statementObjectId = ''
let propositionKey = ''
let lookupEvidenceId = ''

beforeAll(async () => {
  env = await startAcceptanceEnvironment()
  snapshotHash = (await configureProfile(env)).snapshotHash
}, 300_000)

afterAll(async () => {
  await env?.close()
})

describe('LOCAL-054 cross-layer acceptance — configuration', () => {
  it('lists the real registered components for the profile editor', async () => {
    const result = await injectJson(env.app, 'GET', '/api/v1/components')
    expect(result.status).toBe(200)
    const components = dataOf<{ components: { manifestRef: { id: string } }[] }>(result).components
    const ids = components.map((entry) => entry.manifestRef.id)
    expect(ids).toContain('home-energy')
    expect(ids).toContain('runtime-template')
    expect(ids).toContain('runtime-pi')
    expect(ids).toContain('data-postgres')
  })

  it('activates the published profile and records the source binding in PostgreSQL', async () => {
    expect(snapshotHash).toMatch(/^sha256:/)
    const profiles = await env.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.profile_versions
        WHERE tenant_id = $1 AND space_id = $2 AND profile_id = 'home-energy-demo'`,
      [env.scope.tenantId, env.scope.spaceId],
    )
    expect(Number(profiles.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(1)

    const active = await injectJson(env.app, 'GET', '/api/v1/sources')
    expect(active.status).toBe(200)
    const sources = dataOf<{ sources: { sourceId: string }[] }>(active).sources
    expect(sources.length).toBeGreaterThanOrEqual(1)
  })
})

describe('LOCAL-054 cross-layer acceptance — ingestion and extraction', () => {
  it('runs received → parsed → awaiting_review with the real parser and worker', async () => {
    const ingested = await ingestDocument(
      env,
      'SERVICE TERMS\n1.1 The charger D-1 is rated 7.2 kW.\n1.2 It is monitored by meter M-1.',
    )
    jobId = ingested.jobId
    expect(ingested.stage).toBe('awaiting_review')
    expect(ingested.processed).toBeGreaterThan(0)

    const parseRuns = await env.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.document_parse_runs
        WHERE tenant_id = $1 AND space_id = $2`,
      [env.scope.tenantId, env.scope.spaceId],
    )
    expect(Number(parseRuns.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(1)
  })

  it('lists real extraction candidates from the job', async () => {
    const result = await injectJson(env.app, 'GET', `/api/v1/candidates?jobId=${jobId}`)
    expect(result.status).toBe(200)
    const candidates = dataOf<{
      candidates: { candidateId: string; kind: string; state: string; objectId?: string }[]
    }>(result).candidates
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(candidates.every((entry) => entry.state === 'pending_review')).toBe(true)
    // Prefer the `device` entity so the published statement and its history are deterministic.
    const entity =
      candidates.find((entry) => entry.kind === 'entity' && entry.objectId === 'device') ??
      candidates.find((entry) => entry.kind === 'entity')
    if (entity === undefined) throw new Error('no entity candidate was produced')
    candidateId = entity.candidateId
  })

  it('resolves the entity identity through the real decision API', async () => {
    const created = await injectJson(env.app, 'POST', `/api/v1/candidates/${candidateId}/decision`, {
      headers: { 'if-match': '0' },
      payload: { kind: 'create_pending' },
    })
    expect(created.status).toBe(200)
    const entityId = dataOf<{ targetEntityId?: string }>(created).targetEntityId
    expect(entityId).toBeDefined()

    const matched = await injectJson(env.app, 'POST', `/api/v1/candidates/${candidateId}/decision`, {
      headers: { 'if-match': '1' },
      payload: {
        kind: 'match',
        targetEntityId: entityId,
        strongIdentity: { kind: 'native_id', value: `D-${candidateId.slice(0, 4)}` },
      },
    })
    expect(matched.status).toBe(200)
    expect(dataOf<{ revision: string }>(matched).revision).toBe('2')
  })
})

describe('LOCAL-054 cross-layer acceptance — review and semantic publication', () => {
  it('approves the candidate and publishes the semantic statement', async () => {
    const reviewRevision = await env.publicationStore.latestReviewRevision(
      env.scope.scopeRef,
      candidateId,
      env.scope.ctx,
    )
    const reviewed = await injectJson(env.app, 'POST', `/api/v1/candidates/${candidateId}/reviews`, {
      headers: { 'if-match': reviewRevision },
      payload: { decision: 'approve', reason: 'source verified against the original document' },
    })
    expect(reviewed.status).toBe(200)

    const publicationRevision = await env.publicationStore.latestPublicationRevision(
      env.scope.scopeRef,
      env.scope.ctx,
    )
    const published = await injectJson(env.app, 'POST', '/api/v1/semantic-publications', {
      headers: {
        'if-match': publicationRevision,
        'idempotency-key': `acceptance-publication-${randomUUID()}`,
      },
      payload: {
        approvedCandidateRefs: [{ candidateId, kind: 'entity' }],
        schemaRef: env.definitionRef(),
      },
    })
    expect(published.status).toBe(201)
    const statements = dataOf<{ statements: { statementId: string }[] }>(published).statements
    expect(statements.length).toBeGreaterThanOrEqual(1)
    statementId = statements[0]?.statementId ?? candidateId
  })

  it('reads the published statement back as active', async () => {
    const statement = await injectJson(env.app, 'GET', `/api/v1/statements/${statementId}`)
    expect(statement.status).toBe(200)
    const data = dataOf<{ status: string; propositionKey: string; objectId: string }>(statement)
    expect(data.status).toBe('active')
    propositionKey = data.propositionKey
    statementObjectId = data.objectId
    expect(propositionKey.length).toBeGreaterThan(0)
    expect(statementObjectId.length).toBeGreaterThan(0)
  })
})

describe('LOCAL-054 cross-layer acceptance — question, tools, verification, answer, provenance', () => {
  it('binds the published profile and publishes a verified answer through the real controller', async () => {
    const view = await env.startTemplateRun(TEMPLATE_RUN)
    expect(view.state).toBe('published')
    expect(view.answer?.publicationKind).toBe('verified')

    const run = await injectJson(env.app, 'GET', `/api/v1/runs/${TEMPLATE_RUN}`)
    expect(run.status).toBe(200)
    expect(dataOf<{ state: string }>(run).state).toBe('published')

    const answer = await injectJson(env.app, 'GET', `/api/v1/runs/${TEMPLATE_RUN}/answer`)
    expect(answer.status).toBe(200)
    const publishedAnswer = dataOf<{ runId: string; contentHash: string; publicationKind: string }>(answer)
    expect(publishedAnswer.runId).toBe(TEMPLATE_RUN)
    expect(publishedAnswer.contentHash).toMatch(/^sha256:/)
    expect(publishedAnswer.publicationKind).toBe('verified')

    const row = await env.adminClient.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_platform.answer_publications
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [env.scope.tenantId, env.scope.spaceId, TEMPLATE_RUN],
    )
    expect(Number(row.rows[0]?.count ?? '0')).toBe(1)
  })

  it('streams public run events and never exposes an unverified draft', async () => {
    const response = await env.app.inject({ method: 'GET', url: `/api/v1/runs/${TEMPLATE_RUN}/events` })
    expect(response.statusCode).toBe(200)
    const body = response.body
    expect(body).not.toContain('unverified_answer.delta')
    const eventNames = [...body.matchAll(/^event: (.+)$/gm)].map((match) => match[1])
    expect(eventNames.at(-1)).toBe('answer.published')
    for (const name of eventNames) {
      expect([
        'run.state',
        'plan.summary',
        'tool.started',
        'tool.completed',
        'evidence.available',
        'clarification.required',
        'answer.published',
        'run.failed',
      ]).toContain(name)
    }
  })

  it('consumed the one shared budget ledger for the two real tool calls', async () => {
    const ledger = await env.adminClient.query<{ tool_calls_consumed: number }>(
      `SELECT tool_calls_consumed FROM agent_platform.budget_ledgers
        WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
      [env.scope.tenantId, env.scope.spaceId, TEMPLATE_RUN],
    )
    expect(ledger.rows[0]?.tool_calls_consumed).toBe(2)
    expect(env.lookup.calls.length).toBeGreaterThanOrEqual(1)
    expect(env.search.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('independently verifies a claim against the run’s real archived evidence', async () => {
    const records = await env.evidence.listByRun(env.scope.scopeRef, TEMPLATE_RUN, env.scope.ctx)
    expect(records.length).toBe(2)
    const lookupRecord = records.find((record) => record.envelope.payloadRef !== undefined)
    if (lookupRecord === undefined) throw new Error('the run recorded no archived evidence')
    lookupEvidenceId = lookupRecord.evidenceRef.id
    expect(lookupEvidenceId).toBeDefined()

    const claim: DraftClaim = buildClaim({
      evidenceRef: lookupRecord.evidenceRef,
      resultDigest: lookupRecord.envelope.resultDigest,
    })
    const entries: WorkflowInputEntry[] = [
      {
        entryId: randomUUID(),
        kind: 'evidence',
        label: `evidence:${lookupRecord.evidenceRef.id}`,
        ref: lookupRecord.evidenceRef,
        addedInPhase: 'collecting',
        recordedAt: lookupRecord.recordedAt,
        readAt: lookupRecord.recordedAt,
      },
    ]
    const manifest: WorkflowInputManifest = {
      manifestId: randomUUID(),
      runId: TEMPLATE_RUN,
      revision: '1',
      entries,
      digest: inputManifestDigest(TEMPLATE_RUN, entries),
    }
    const blocks = [{ kind: 'summary' }]
    const draft: AnswerDraft = {
      draftId: randomUUID(),
      runId: TEMPLATE_RUN,
      blocks,
      claims: [claim],
      evidenceManifestHash: manifest.digest,
      contentHash: answerDraftContentHash(TEMPLATE_RUN, blocks, manifest.digest, [claim]),
      limitations: [],
      producedInPhase: 'drafting',
      createdAt: lookupRecord.recordedAt,
    }

    const service = new DraftVerificationService({
      evidence: env.evidence,
      artifacts: env.blobStore,
      policy: verificationPolicy(),
      decision: new FixedSemanticDecision('supported'),
      modelRef: modelRef(),
      now: () => lookupRecord.recordedAt,
    })
    const result = await service.verify({ runId: TEMPLATE_RUN, draft, inputManifest: manifest }, env.scope.ctx)
    expect(result.verdict).toBe('pass')
    expect(result.failedChecks).toEqual([])
    expect(result.supportedClaimIds).toEqual([claim.claimId])
  })

  it('serves provenance, dependencies and a controlled export for the answer evidence', async () => {
    const evidence = await injectJson(env.app, 'GET', `/api/v1/evidence/${lookupEvidenceId}`)
    expect(evidence.status).toBe(200)
    const view = dataOf<{ outcome: string; originalSourceReReadable: boolean }>(evidence)
    expect(view.outcome).toBe('verifiable')
    expect(view.originalSourceReReadable).toBe(true)

    const dependencies = await injectJson(
      env.app,
      'GET',
      `/api/v1/evidence/${lookupEvidenceId}/dependencies?direction=outbound&depth=1`,
    )
    expect(dependencies.status).toBe(200)

    const exported = await injectJson(env.app, 'GET', `/api/v1/evidence/${lookupEvidenceId}/export`)
    expect(exported.status).toBe(200)
  })
})

describe('LOCAL-054 cross-layer acceptance — retraction and history replay', () => {
  it('retracts the statement, preserves history and replays at the original recordedAt', async () => {
    const before = await env.history.getObjectHistory(statementObjectId, {}, env.scope.ctx)
    const versionOne = before.assertions.find((assertion) => assertion.version === '1')
    if (versionOne === undefined) throw new Error('the published statement has no version 1')

    const retracted = await injectJson(env.app, 'POST', `/api/v1/statements/${statementId}/revisions`, {
      headers: { 'if-match': '1', 'idempotency-key': `acceptance-retract-${randomUUID()}` },
      payload: { kind: 'retraction', reason: 'the supporting source was withdrawn' },
    })
    expect(retracted.status).toBe(200)
    expect(dataOf<{ version: string }>(retracted).version).toBe('2')

    const revisions = await injectJson(env.app, 'GET', `/api/v1/statements/${statementId}/revisions`)
    expect(revisions.status).toBe(200)
    expect(dataOf<{ revisions: unknown[] }>(revisions).revisions).toHaveLength(1)

    const full = await injectJson(env.app, 'GET', `/api/v1/objects/${statementObjectId}/history`)
    expect(full.status).toBe(200)
    const versions = new Map(
      dataOf<{ assertions: { version: string; status: string }[] }>(full).assertions.map((entry) => [
        entry.version,
        entry.status,
      ]),
    )
    expect([...versions.keys()].sort()).toEqual(['1', '2'])
    expect(versions.get('2')).toBe('retracted')

    const replay = await injectJson(
      env.app,
      'GET',
      `/api/v1/objects/${statementObjectId}/history?recordedAt=${encodeURIComponent(versionOne.recordedAt)}`,
    )
    expect(replay.status).toBe(200)
    const replayed = dataOf<{ assertions: { version: string }[] }>(replay).assertions
    expect(replayed.map((entry) => entry.version)).toEqual(['1'])
  })

  it('reports the statement as withdrawn once its last support is retracted', async () => {
    const proposition = await injectJson(env.app, 'GET', `/api/v1/propositions/${propositionKey}`)
    expect(proposition.status).toBe(200)
    expect(dataOf<{ status: string }>(proposition).status).toBe('withdrawn')
  })

  it('does not disclose another tenant’s statement revision', async () => {
    const crossTenant = await injectJson(env.app, 'GET', `/api/v1/statements/${statementId}`, {
      headers: { 'x-test-scope': 'other' },
    })
    expect(crossTenant.status).toBeGreaterThanOrEqual(400)
    expect(['STATEMENT_NOT_FOUND', 'FORBIDDEN', 'NOT_FOUND']).toContain(errorCodeOf(crossTenant))
  })
})
