import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { PostgresIdentityDecisionStore, PostgresMaterializationStore, PostgresProjectReadinessStore, PostgresProjectStore, PostgresSemanticPublicationStore } from '@ontology/adapter-control-postgres'
import { canonicalJson, sha256DigestOf } from '@ontology/application'
import { isRecord } from '@ontology/contracts'
import type { ProjectRevisionRef, ReadinessProjection, ResourceRef, ScopeRef, ToolContext } from '@ontology/contracts'
import { publishedStatementProjectId } from '@ontology/semantic-engine'
import { actualArray, actualObject, actualResource, actualText, createFirstActiveProject, startFirstActiveFixture } from './core-first-active-fixture'
import type { FirstActiveFixture, FirstActivePack, FirstActiveProject } from './core-first-active-fixture'

let fixture: FirstActiveFixture, pack: FirstActivePack
const projects: FirstActiveProject[] = []

beforeAll(async () => {
  fixture = await startFirstActiveFixture()
  pack = await fixture.publishPack('h', false)
  projects.push(await createFirstActiveProject(fixture, pack, '真实项目 A readiness 恢复证明', [{ machineId: 'RECOVERY-A', hours: '9.125' }]))
  projects.push(await createFirstActiveProject(fixture, pack, '真实项目 B readiness 恢复证明', [{ machineId: 'RECOVERY-B', hours: '10.25' }]))
}, 300_000)

afterAll(async () => { await fixture?.close() })

function actualProjectRevisionRef(project: FirstActiveProject): ProjectRevisionRef {
  const ref = actualObject(project.revision['ref'])
  const projectId = ref['projectId'], revision = ref['revision'], digest = ref['digest']
  if (typeof projectId !== 'string' || typeof revision !== 'string' || typeof digest !== 'string') throw new Error('the actual project revision pin is malformed')
  return { projectId, revision, digest }
}

function actualParentPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('the actual statement revision outbox payload is malformed')
  return value
}

interface ActualOutboxRow { job_id: string; topic: string; state: string; attempts: number; payload: unknown }
interface ActualChildRow { outbox_id: string; state: string; attempts: number; dispatched_at: Date | null; payload: unknown }

describe('cross-project readiness recovery after a real Core host restart', () => {
  it('rebuilds current A and B receipts from durable inventory when only B has a child after restart', async () => {
    const scope: ScopeRef = fixture.scope, ctx: ToolContext = fixture.proofContext(pack.profileRef)
    const publications = new PostgresSemanticPublicationStore(fixture.proofDatabase)
    const identity = new PostgresIdentityDecisionStore(fixture.proofDatabase)
    const projectStore = new PostgresProjectStore(fixture.proofDatabase)
    const readiness = new PostgresProjectReadinessStore(fixture.proofDatabase)
    const materialization = new PostgresMaterializationStore(fixture.proofDatabase)
    const currentProjects = projects.slice()
    if (currentProjects.length !== 2) throw new Error('the actual A/B business projects were not created')
    const [projectA, projectB] = currentProjects
    if (projectA === undefined || projectB === undefined) throw new Error('the actual A/B project handles are unavailable')
    for (const project of currentProjects) {
      expect(project.candidateIds).toHaveLength(1)
      const declared = project.sourceColumns.map((column) => actualText(column['header'])).filter((header) => header === 'machine_id' || header === 'hours').sort()
      expect(declared).toEqual(['hours', 'machine_id'])
    }
    const revisionA = actualProjectRevisionRef(projectA), revisionB = actualProjectRevisionRef(projectB)
    const readyBeforeA = await readiness.getProjection(scope, revisionA, 'published_semantics', ctx)
    const readyBeforeB = await readiness.getProjection(scope, revisionB, 'published_semantics', ctx)
    if (readyBeforeA?.state !== 'ready' || readyBeforeB?.state !== 'ready' || readyBeforeA.receiptRef === undefined || readyBeforeB.receiptRef === undefined) throw new Error('both actual projects must start with earned semantic readiness')
    const originalReceiptA = actualResource(readyBeforeA.receiptRef), originalReceiptB = actualResource(readyBeforeB.receiptRef)
    const statementRows = await publications.listStatements(scope, { status: 'active', limit: 1_000 }, ctx)
    const statementA = statementRows.find((row) => publishedStatementProjectId(row) === projectA.projectId)
    const statementB = statementRows.find((row) => publishedStatementProjectId(row) === projectB.projectId)
    if (statementA === undefined || statementB === undefined) throw new Error('the actual A/B publication statements are unavailable')

    const correctActualStatement = async (statementId: string, expectedVersion: string, label: string) => {
      const actual = await fixture.call(`/api/v1/statements/${statementId}`)
      const value = actualObject(actual['value']), recordedAt = actualText(actual['recordedAt'])
      const originalValidFrom = typeof actual['validFrom'] === 'string' ? actual['validFrom'] : recordedAt
      const instant = Date.parse(originalValidFrom)
      if (!Number.isFinite(instant)) throw new Error('the actual statement has no valid source-time bound')
      const validFrom = new Date(instant + 1_000).toISOString()
      const corrected = await fixture.call(`/api/v1/statements/${statementId}/revisions`, {
        kind: 'correction', reason: `正常HTTP更正真实项目${label}已发布statement有效时间`, correctedValue: value, validFrom,
      }, expectedVersion)
      if (canonicalJson(corrected['correctedValue']) !== canonicalJson(value) || corrected['validFrom'] !== validFrom) throw new Error('the real statement correction did not preserve its full value and changed validity')
      return actualText(corrected['invalidationOutboxId'])
    }

    const locker = fixture.harness.adminClient
    const observer = new Client({ connectionString: fixture.harness.adminUrl })
    await observer.connect()
    let lockHeld = false
    let aFenceId: string | undefined
    let bFenceId: string | undefined
    let bParentId: string | undefined
    try {
      await locker.query('BEGIN')
      lockHeld = true
      const lockOwner = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]
      if (lockOwner === undefined) throw new Error('the PostgreSQL readiness lock owner has no backend PID')
      const lockedProjection = await locker.query(
        `SELECT generation FROM agent_platform.projection_state
         WHERE tenant_id=$1 AND space_id=$2 AND projection_ref='projection.materialized' FOR UPDATE`,
        [scope.tenantId, scope.spaceId],
      )
      if (lockedProjection.rowCount !== 1) throw new Error(`the real scope projection row was not locked: ${String(lockedProjection.rowCount)}`)

      const aParentId = await correctActualStatement(statementA.statementId, statementA.version, 'A')
      const aParent = (await locker.query<ActualOutboxRow>(
        `SELECT job_id,topic,state,attempts,payload FROM agent_platform.job_outbox WHERE tenant_id=$1 AND space_id=$2 AND outbox_id=$3`,
        [scope.tenantId, scope.spaceId, aParentId],
      )).rows[0]
      if (aParent?.topic !== 'semantic.statement.corrected') throw new Error('the actual A correction has no durable parent event')
      const aBindings = actualArray(actualParentPayload(aParent.payload)['materializationFences']).map(actualObject)
      if (aBindings.length !== 1) throw new Error('the actual A correction has no exact pre-opened fence')
      aFenceId = actualText(aBindings[0]?.['fenceId'])

      const blockedDeadline = Date.now() + 15_000
      let observedBlock = false
      let aBlockedChild: ActualChildRow | undefined
      while (Date.now() < blockedDeadline) {
        if (fixture.workerErrors.length > 0) throw new Error(`the actual worker failed before its A child lock wait: ${JSON.stringify(fixture.workerErrors.slice(-4))}`)
        const waiting = await observer.query<{ pid: number; query: string }>(
          `SELECT pid,query FROM pg_stat_activity
           WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE '%projection_state%'`,
          [lockOwner.pid],
        )
        if (waiting.rows.length > 0) {
          const child = await locker.query<ActualChildRow>(
            `SELECT outbox_id,state,attempts,dispatched_at,payload FROM agent_platform.job_outbox
             WHERE tenant_id=$1 AND space_id=$2 AND job_id=$3 AND topic='semantic.materialization.requested'
               AND payload->>'fenceId'=$4`, [scope.tenantId, scope.spaceId, aParent.job_id, aFenceId],
          )
          if (child.rows.length === 1) { aBlockedChild = child.rows[0]; observedBlock = true; break }
        }
        await new Promise<void>((done) => setTimeout(done, 100))
      }
      if (!observedBlock) {
        const [parentSnapshot, children, projection, waiting] = await Promise.all([
          locker.query<{ job_id: string; topic: string; state: string; attempts: number }>(
            `SELECT job_id,topic,state,attempts FROM agent_platform.job_outbox WHERE tenant_id=$1 AND space_id=$2 AND outbox_id=$3`,
            [scope.tenantId, scope.spaceId, aParentId],
          ),
          locker.query<{ outbox_id: string; state: string; attempts: number; dispatched_at: Date | null }>(
            `SELECT outbox_id,state,attempts,dispatched_at FROM agent_platform.job_outbox
             WHERE tenant_id=$1 AND space_id=$2 AND topic='semantic.materialization.requested'
               AND payload->>'fenceId'=$3`, [scope.tenantId, scope.spaceId, aFenceId],
          ),
          locker.query<{ generation: string }>(`SELECT generation::text FROM agent_platform.projection_state WHERE tenant_id=$1 AND space_id=$2 AND projection_ref='projection.materialized'`, [scope.tenantId, scope.spaceId]),
          observer.query<{ pid: number; application_name: string; wait_event_type: string | null; wait_event: string | null; query: string; blockers: number[] }>(
            `SELECT pid,application_name,wait_event_type,wait_event,left(query,400) AS query,pg_blocking_pids(pid) AS blockers
             FROM pg_stat_activity WHERE datname=current_database() AND pid<>$1
               AND (wait_event_type IS NOT NULL OR query ILIKE '%materialization%') ORDER BY pid`, [lockOwner.pid],
          ),
        ])
        throw new Error(`the actual A child did not block on the locked projection row: ${JSON.stringify({ parent: parentSnapshot.rows, children: children.rows, projection: projection.rows, sessions: waiting.rows, workerErrors: fixture.workerErrors.slice(-4) })}`)
      }
      expect(aBlockedChild?.state).toBe('pending')
      expect(aBlockedChild?.attempts).toBe(0)
      expect(aBlockedChild?.dispatched_at).toBeNull()

      bParentId = await correctActualStatement(statementB.statementId, statementB.version, 'B')
      const bParent = (await locker.query<ActualOutboxRow>(
        `SELECT job_id,topic,state,attempts,payload FROM agent_platform.job_outbox WHERE tenant_id=$1 AND space_id=$2 AND outbox_id=$3`,
        [scope.tenantId, scope.spaceId, bParentId],
      )).rows[0]
      if (bParent?.topic !== 'semantic.statement.corrected') throw new Error('the actual B correction has no durable parent event')
      const bBindings = actualArray(actualParentPayload(bParent.payload)['materializationFences']).map(actualObject)
      if (bBindings.length !== 1) throw new Error('the actual B correction has no exact pre-opened fence')
      bFenceId = actualText(bBindings[0]?.['fenceId'])

      await fixture.restart({
        releaseLock: async () => { if (lockHeld) { await locker.query('COMMIT'); lockHeld = false } },
        beforeStart: async () => {
          const [pendingB, priorReadyA, priorReadyB, fenceA, fenceB] = await Promise.all([
            locker.query<ActualOutboxRow>(`SELECT job_id,topic,state,attempts,payload FROM agent_platform.job_outbox WHERE tenant_id=$1 AND space_id=$2 AND outbox_id=$3`, [scope.tenantId, scope.spaceId, bParentId]),
            readiness.getProjection(scope, revisionA, 'published_semantics', fixture.proofContext(pack.profileRef)),
            readiness.getProjection(scope, revisionB, 'published_semantics', fixture.proofContext(pack.profileRef)),
            materialization.getFence(scope, aFenceId!, fixture.proofContext(pack.profileRef)),
            materialization.getFence(scope, bFenceId!, fixture.proofContext(pack.profileRef)),
          ])
          expect(pendingB.rows[0]?.state).toBe('pending')
          expect(pendingB.rows[0]?.attempts).toBe(0)
          expect(priorReadyA?.receiptRef).toEqual(originalReceiptA)
          expect(priorReadyB?.receiptRef).toEqual(originalReceiptB)
          expect(fenceA?.state).toBe('closed')
          expect(fenceB?.state).toBe('open')
          expect(fixture.workerErrors).toHaveLength(0)
        },
      })
      expect(fixture.workerErrors).toHaveLength(0)

      const deadline = Date.now() + 15_000
      let finalChildren: ActualChildRow[] = []
      let finalParent: ActualOutboxRow | undefined
      let finalState: Awaited<ReturnType<typeof materialization.getProjectionState>>
      let finalReadyA: ReadinessProjection | undefined, finalReadyB: ReadinessProjection | undefined
      while (Date.now() < deadline) {
        fixture.setWorkerContext('outbox_dispatch_wait', bParentId)
        const [parentResult, state, openFences, readyA, readyB] = await Promise.all([
          locker.query<ActualOutboxRow>(`SELECT job_id,topic,state,attempts,payload FROM agent_platform.job_outbox WHERE tenant_id=$1 AND space_id=$2 AND outbox_id=$3`, [scope.tenantId, scope.spaceId, bParentId]),
          materialization.getProjectionState(scope, fixture.proofContext(pack.profileRef)),
          materialization.listOpenFences(scope, fixture.proofContext(pack.profileRef)),
          readiness.getProjection(scope, revisionA, 'published_semantics', fixture.proofContext(pack.profileRef)),
          readiness.getProjection(scope, revisionB, 'published_semantics', fixture.proofContext(pack.profileRef)),
        ])
        finalParent = parentResult.rows[0]
        finalState = state
        finalReadyA = readyA
        finalReadyB = readyB
        const [childRows, fence] = await Promise.all([
          locker.query<ActualChildRow>(
            `SELECT outbox_id,state,attempts,dispatched_at,payload FROM agent_platform.job_outbox
             WHERE tenant_id=$1 AND space_id=$2 AND job_id=$3 AND topic='semantic.materialization.requested'
               AND payload->>'fenceId'=$4`, [scope.tenantId, scope.spaceId, finalParent?.job_id, bFenceId],
          ),
          materialization.getFence(scope, bFenceId!, fixture.proofContext(pack.profileRef)),
        ])
        finalChildren = childRows.rows
        if (finalParent?.state === 'dispatched' && finalParent.attempts === 1 && finalChildren.length === 1 && finalChildren[0]?.state === 'dispatched' && finalChildren[0].attempts === 1 && finalChildren[0].dispatched_at !== null && fence?.state === 'closed' && openFences.length === 0 && state !== undefined && !state.dirty && readyA?.state === 'ready' && readyB?.state === 'ready' && readyA.receiptRef !== undefined && readyB.receiptRef !== undefined && canonicalJson(readyA.receiptRef) !== canonicalJson(originalReceiptA) && canonicalJson(readyB.receiptRef) !== canonicalJson(originalReceiptB)) break
        await new Promise<void>((done) => setTimeout(done, 100))
      }
      expect(finalParent?.state).toBe('dispatched')
      expect(finalParent?.attempts).toBe(1)
      expect(finalChildren).toHaveLength(1)
      const bChild = finalChildren[0]
      if (bChild === undefined || finalParent === undefined || finalState === undefined || finalReadyA?.receiptRef === undefined || finalReadyB?.receiptRef === undefined || bParentId === undefined) throw new Error('the restarted worker did not earn both current project receipts')
      expect(bChild.state).toBe('dispatched')
      expect(bChild.attempts).toBe(1)
      expect(bChild.dispatched_at).not.toBeNull()
      expect(finalState.dirty).toBe(false)
      expect(finalState.watermark.kind).toBe('sequence')
      expect(fixture.workerErrors).toHaveLength(0)

      const [projectAAfter, projectBAfter, semanticHead, identityHead] = await Promise.all([
        projectStore.getProject(scope, projectA.projectId, fixture.proofContext(pack.profileRef)),
        projectStore.getProject(scope, projectB.projectId, fixture.proofContext(pack.profileRef)),
        publications.latestReadRevision(scope, fixture.proofContext(pack.profileRef)),
        identity.latestReadRevision(scope, fixture.proofContext(pack.profileRef)),
      ])
      expect(projectAAfter?.activeRevision ?? projectAAfter?.headRevision).toBe(revisionA.revision)
      expect(projectBAfter?.activeRevision ?? projectBAfter?.headRevision).toBe(revisionB.revision)
      const readReceipt = async (readinessProjection: ReadinessProjection, project: FirstActiveProject, revisionRef: ProjectRevisionRef) => {
        const receiptRef: ResourceRef = actualResource(readinessProjection.receiptRef)
        const request = { scopeRef: scope, blobRef: receiptRef }, receiptCtx = fixture.proofContext(pack.profileRef)
        const metadata = await fixture.blobs.getAuthorizedMetadata(request, receiptCtx)
        expect(Number.isSafeInteger(metadata.byteSize)).toBe(true)
        expect(metadata.byteSize).toBeGreaterThan(0)
        expect(metadata.byteSize).toBeLessThanOrEqual(1_048_576)
        const bytes = await fixture.blobs.readAuthorized(request, receiptCtx)
        const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!isRecord(body)) throw new Error('the durable readiness receipt body is malformed')
        expect(metadata.byteSize).toBe(bytes.byteLength)
        expect(bytes.byteLength).toBeGreaterThan(0)
        expect(sha256DigestOf(new TextDecoder('utf-8', { fatal: true }).decode(bytes))).toBe(receiptRef.digest)
        expect(canonicalJson(body['projectRevisionRef'])).toBe(canonicalJson(revisionRef))
        expect(canonicalJson(body['definitionRef'])).toBe(canonicalJson(project.revision['definitionRef']))
        expect(canonicalJson(body['industryPackRef'])).toBe(canonicalJson(project.revision['industryPackRef']))
        expect(canonicalJson(body['sourceReadRevision'])).toBe(canonicalJson({ semantic: semanticHead, identity: identityHead }))
        expect(canonicalJson(body['projection'])).toBe(canonicalJson(finalState))
        expect(readinessProjection.expectedCount).toBe(2)
        expect(readinessProjection.processedCount).toBe(2)
        expect(body['expectedFacts']).toBe(2)
        expect(typeof body['sourceDigest']).toBe('string')
        expect(body['sourceDigest']).toMatch(/^sha256:[0-9a-f]{64}$/u)
        expect(body['outboxId']).toBe(bChild.outbox_id)
        expect(readinessProjection.jobId).toBe(finalParent.job_id)
        expect(readinessProjection.projectRevisionRef).toEqual(revisionRef)
        expect(readinessProjection.targetRef).toEqual(project.revision['definitionRef'])
        expect(readinessProjection.targetDigest).toBe(actualObject(project.revision['definitionRef'])['digest'])
        expect(readinessProjection.completeness).toBe('complete')
        expect(readinessProjection.failedCount).toBe(0)
        return body
      }
      const receiptBodyA = await readReceipt(finalReadyA, projectA, revisionA)
      const receiptBodyB = await readReceipt(finalReadyB, projectB, revisionB)
      expect(receiptBodyA['sourceDigest']).not.toBe(receiptBodyB['sourceDigest'])
      expect(fixture.workerErrors).toHaveLength(0)
    } finally {
      if (lockHeld) {
        await locker.query('ROLLBACK').catch(() => undefined)
        lockHeld = false
      }
      await observer.end().catch(() => undefined)
    }
  }, 120_000)
})
