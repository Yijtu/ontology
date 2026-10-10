import type { Client } from 'pg'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  PostgresIdentityDecisionStore,
  PostgresMaterializationStore,
  PostgresProjectReadinessStore,
  PostgresProjectStore,
  PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import { canonicalJson, sha256DigestOf } from '@ontology/application'
import { assertProjectFactInputShape, isRecord, isUuid } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'

interface ParentOutbox {
  job_id: string
  payload: unknown
  topic: string
  state: string
  attempts: number
  dispatched_at: Date | null
}

interface ChildOutbox {
  outbox_id: string
  payload: unknown
  state: string
  attempts: number
  dispatched_at: Date | null
}

/** A publication acknowledgment queues advances; only its exact children earn readiness. */
export function publicationMaterializationBarrier(options: {
  readonly client: Client
  readonly database: ControlPostgresDatabase
  readonly blobs: LocalImmutableBlobStore
  readonly scope: ScopeRef
  readonly context: () => ToolContext
  readonly assertWorkerHealthy: () => void
}) {
  const publications = new PostgresSemanticPublicationStore(options.database)
  const identities = new PostgresIdentityDecisionStore(options.database)
  const projects = new PostgresProjectStore(options.database)
  const readiness = new PostgresProjectReadinessStore(options.database)
  const materialization = new PostgresMaterializationStore(options.database)
  const scope = options.scope

  return async (outboxId: string): Promise<number> => {
    const deadline = Date.now() + 15_000
    const ctx = options.context()
    const initial = await options.client.query<ParentOutbox>(
      `SELECT job_id, payload, topic, state, attempts, dispatched_at FROM agent_platform.job_outbox
       WHERE tenant_id=$1 AND space_id=$2 AND outbox_id=$3`, [scope.tenantId, scope.spaceId, outboxId],
    )
    const parent = initial.rows[0]
    if (parent === undefined || parent.topic !== 'semantic.publication.published' || !isRecord(parent.payload) || !isUuid(parent.payload['publicationId'])) throw new Error('the barrier has no exact scoped publication outbox')
    const publication = await publications.getPublication(scope, parent.payload['publicationId'], ctx)
    if (publication === undefined || publication.outboxId !== outboxId) throw new Error('the parent outbox differs from its actual immutable publication')
    const changeIds = new Set([...publication.statements.map((row) => row.statementId), ...publication.ruleVersions.map((row) => row.ruleVersionId)])
    const bindings = parent.payload['materializationFences']
    if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 1_000 || bindings.length !== changeIds.size) throw new Error('the publication has no bounded exact materialization fence set')
    const changesByFence = new Map<string, string>()
    const seenChanges = new Set<string>()
    for (const binding of bindings) {
      if (!isRecord(binding) || !isUuid(binding['changeId']) || !isUuid(binding['fenceId']) || !changeIds.has(binding['changeId']) || seenChanges.has(binding['changeId']) || changesByFence.has(binding['fenceId'])) throw new Error('the actual publication fence set is malformed or ambiguous')
      changesByFence.set(binding['fenceId'], binding['changeId'])
      seenChanges.add(binding['changeId'])
    }
    const projectIds = new Set<string>()
    for (const statement of publication.statements) {
      const provenance = statement.value['provenance']
      assertProjectFactInputShape(provenance)
      for (const source of provenance.sources) projectIds.add(source.projectRevisionRef.projectId)
    }
    for (const rule of publication.ruleVersions) if (rule.projectId !== undefined) projectIds.add(rule.projectId)
    if (projectIds.size < 1 || projectIds.size > 32) throw new Error('the business publication has no bounded actual project ownership')
    let lastStage = 'parent publication dispatch'
    while (Date.now() < deadline) {
      options.assertWorkerHealthy()
      const current = (await options.client.query<ParentOutbox>(
        `SELECT job_id, payload, topic, state, attempts, dispatched_at FROM agent_platform.job_outbox
         WHERE tenant_id=$1 AND space_id=$2 AND outbox_id=$3`, [scope.tenantId, scope.spaceId, outboxId],
      )).rows[0]
      if (current === undefined || current.job_id !== parent.job_id || canonicalJson(current.payload) !== canonicalJson(parent.payload)) throw new Error('the actual publication outbox changed during completion capture')
      if (current.state === 'dispatched' && current.dispatched_at !== null) {
        if (current.attempts !== 1) throw new Error('the actual publication outbox was dispatched more than once')
        const children = (await options.client.query<ChildOutbox>(
          `SELECT outbox_id, payload, state, attempts, dispatched_at FROM agent_platform.job_outbox
           WHERE tenant_id=$1 AND space_id=$2 AND job_id=$3 AND topic='semantic.materialization.requested'
             AND ((payload ? 'fenceId' AND payload->>'fenceId'=ANY($4::text[])) OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'changes')='array' THEN payload->'changes' ELSE '[]'::jsonb END) member
               WHERE member->>'fenceId'=ANY($4::text[])))
           ORDER BY created_at, outbox_id LIMIT 1001`,
          [scope.tenantId, scope.spaceId, parent.job_id, [...changesByFence.keys()]],
        )).rows
        const seenFences = new Set<string>(), seenChanges = new Set<string>()
        const materializedChildIds = new Set<string>()
        let memberCount = 0
        for (const child of children) {
          if (!isRecord(child.payload)) throw new Error('an actual materialization child has a malformed payload')
          const raw = child.payload['changes']
          const entries = raw === undefined ? [{ fenceId: child.payload['fenceId'], change: child.payload['change'] }] : raw
          if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) throw new Error('an actual materialization batch has an invalid member count')
          for (const entry of entries) {
            if (!isRecord(entry) || !isUuid(entry['fenceId']) || !isRecord(entry['change']) || !isUuid(entry['change']['changeId']) || changesByFence.get(entry['fenceId']) !== entry['change']['changeId'] || seenFences.has(entry['fenceId']) || seenChanges.has(entry['change']['changeId'])) throw new Error('the actual child advances differ from the parent publication fence set')
            seenFences.add(entry['fenceId']); seenChanges.add(entry['change']['changeId']); memberCount += 1
          }
          materializedChildIds.add(child.outbox_id)
        }
        if (children.length > changeIds.size || memberCount > changeIds.size) throw new Error('the actual child advances exceed the exact publication change set')
        lastStage = `child advances (${children.filter((row) => row.state === 'dispatched').length}/${children.length}; ${memberCount}/${changesByFence.size} members)`
        if (memberCount === changesByFence.size && seenFences.size === changesByFence.size && children.length > 0 && children.every((row) => row.state === 'dispatched' && row.dispatched_at !== null)) {
          if (children.some((row) => row.attempts !== 1)) throw new Error('an actual materialization child was dispatched more than once')
          const fences = await Promise.all([...changesByFence.keys()].map((id) => materialization.getFence(scope, id, ctx)))
          if (fences.some((fence) => fence === undefined || fence.state !== 'closed' || fence.closedAt === undefined)) throw new Error('a dispatched materialization child has no actual closed fence')
          lastStage = 'current active project readiness receipt'
          let ready = true
          for (const projectId of projectIds) {
            const project = await projects.getProject(scope, projectId, ctx)
            const selected = project?.activeRevision ?? project?.headRevision
            const revision = selected === undefined ? undefined : await projects.getRevision(scope, projectId, selected, ctx)
            if (project === undefined || project.state === 'archived' || revision === undefined || revision.executionPurpose === 'synthetic_validation') throw new Error('the completed business publication has no actual active project revision')
            const [projection, state] = await Promise.all([readiness.getProjection(scope, revision.ref, 'published_semantics', ctx), materialization.getProjectionState(scope, ctx)])
            if (projection?.state !== 'ready' || projection.completeness !== 'complete' || projection.failedCount !== 0 || projection.expectedCount < 1 || projection.processedCount !== projection.expectedCount || projection.targetDigest !== revision.definitionRef.digest || canonicalJson(projection.targetRef) !== canonicalJson(revision.definitionRef) || projection.receiptRef === undefined || projection.jobId !== parent.job_id || state === undefined || state.dirty || state.watermark.kind !== 'sequence') { ready = false; break }
            const request = { scopeRef: scope, blobRef: projection.receiptRef }
            const metadata = await options.blobs.getAuthorizedMetadata(request, ctx)
            if (!Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 1 || metadata.byteSize > 1_048_576) throw new Error('the actual readiness receipt exceeds its finite read bound')
            const bytes = await options.blobs.readAuthorized(request, ctx)
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            if (bytes.byteLength !== metadata.byteSize || sha256DigestOf(text) !== projection.receiptRef.digest) throw new Error('the actual readiness receipt differs from its immutable bytes')
            const body: unknown = JSON.parse(text)
            const [semantic, identity, afterProject, afterRevision, afterState] = await Promise.all([publications.latestReadRevision(scope, ctx), identities.latestReadRevision(scope, ctx), projects.getProject(scope, projectId, ctx), projects.getRevision(scope, projectId, revision.ref.revision, ctx), materialization.getProjectionState(scope, ctx)])
            if (!isRecord(body) || body['schemaVersion'] !== 'project-published-semantics-readiness@1' || canonicalJson(body['projectRevisionRef']) !== canonicalJson(revision.ref) || canonicalJson(body['definitionRef']) !== canonicalJson(revision.definitionRef) || canonicalJson(body['industryPackRef']) !== canonicalJson(revision.industryPackRef) || canonicalJson(body['sourceReadRevision']) !== canonicalJson({ semantic, identity }) || canonicalJson(body['projection']) !== canonicalJson(state) || body['expectedFacts'] !== projection.expectedCount || typeof body['sourceDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(body['sourceDigest']) || typeof body['outboxId'] !== 'string' || !materializedChildIds.has(body['outboxId']) || afterProject?.state !== project.state || (afterProject.activeRevision ?? afterProject.headRevision) !== selected || canonicalJson(afterRevision) !== canonicalJson(revision) || canonicalJson(afterState) !== canonicalJson(state)) { ready = false; break }
          }
          if (ready) { options.assertWorkerHealthy(); return current.attempts }
        }
      }
      await new Promise<void>((done) => setTimeout(done, 100))
    }
    throw new Error(`the actual publication materialization did not finish within its fixed 15-second barrier: ${lastStage}`)
  }
}
