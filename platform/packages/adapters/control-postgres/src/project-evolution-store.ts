import type { PoolClient, QueryResultRow } from 'pg'
import { assertProjectEvolutionPlan, assertProjectFactInputShape, isToolContext, isUuid, isRevisionString, isSha256Digest, isResourceRef, ProjectStoreError, PROJECT_EVOLUTION_TOPIC } from '@ontology/contracts'
import type { ExtractionInputVersion, ProjectEvolutionPlan, ProjectEvolutionRecord, ProjectEvolutionSnapshot, ProjectEvolutionStore, ProjectEvolutionState, ResourceRef, ScopeRef, ToolContext } from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'
import { assertConfirmation } from './project-fact-publication-fence'
interface Row {
    plan: ProjectEvolutionPlan
    revision: string
    state: ProjectEvolutionState
    attempts: number
    record_operations: number
    batches: number
    candidate_ids: string[]
    snapshots: ProjectEvolutionRecord['snapshots'] | null
    input_snapshot_ref: ResourceRef | null
    error: string | null
    lease_until: Date | null
    lease_expired?: boolean
}
const scoped = `tenant_id=current_setting('app.tenant_id')::uuid AND space_id=current_setting('app.space_id')::uuid`
function record(row: Row): ProjectEvolutionRecord {
    assertProjectEvolutionPlan(row.plan)
    return {
        plan: row.plan, revision: row.revision, state: row.state, attempts: row.attempts, recordOperations: row.record_operations, batches: row.batches, candidateIds: row.candidate_ids, ...(row.input_snapshot_ref === null ? {} : {
            inputSnapshotRef: row.input_snapshot_ref
        }), ...(row.snapshots == null ? {} : {
            snapshots: row.snapshots
        }), ...(row.error === null ? {} : {
            error: row.error
        })
    }
}
function conflict(message: string): never {
    throw new ProjectStoreError('VERSION_CONFLICT', message)
}
interface EvolutionQuery {
    query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{
        rows: Row[]
        rowCount: number | null
    }>
}
export async function assertEvolutionSourcePins(client: EvolutionQuery, plan: ProjectEvolutionPlan): Promise<void> {
    for (const source of [...plan.sources].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
        const member = await client.query<{
            state: string
            membership_revision: string
            document_digest: string
            parse_id: string
        }>(`SELECT state,membership_revision::text,document_digest,parse_id FROM agent_platform.project_document_memberships WHERE ${scoped} AND project_id=$1::uuid AND document_id=$2::uuid ORDER BY membership_revision DESC LIMIT 1 FOR SHARE`, [plan.targetRevisionRef.projectId, source.documentId])
        const actual = member.rows[0]
        if (actual?.state !== 'active' || actual.membership_revision !== source.membershipRevision || actual.document_digest !== source.originalRef.digest || actual.parse_id !== source.parseId)
            conflict('an original source was withdrawn or replaced')
        const statements = await client.query<{
            statement_id: string
            version: string
            status: string
        }>(`SELECT statement_id,version::text,status FROM agent_platform.published_statements WHERE ${scoped} AND statement_id=ANY($1::uuid[]) ORDER BY statement_id FOR SHARE`, [source.previousStatements.map((pin) => pin.statementId)])
        const expectedStatements = new Map(source.previousStatements.map((pin) => [pin.statementId, pin.version]))
        if (statements.rows.length !== source.previousStatements.length || statements.rows.some((statement) => statement.status !== 'active' || expectedStatements.get(statement.statement_id) !== statement.version))
            conflict('an original published fact was withdrawn or corrected')
    }
    const visibility = await client.query<{
        epoch: string
    }>(`SELECT visibility_epoch::text AS epoch FROM agent_platform.project_visibility WHERE ${scoped} AND project_id=$1::uuid FOR SHARE`, [plan.targetRevisionRef.projectId])
    if (plan.sources.some((source) => source.visibilityEpoch !== visibility.rows[0]?.epoch))
        conflict('source visibility changed during evolution')
}
export class PostgresProjectEvolutionStore implements ProjectEvolutionStore {
    constructor(private readonly database: ControlPostgresDatabase) {
    }
    async #scope<T>(scope: ScopeRef, ctx: ToolContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
        if (!isToolContext(ctx) || ctx.principal.tenantId !== scope.tenantId || ctx.allowedResources.tenantId !== scope.tenantId || ctx.allowedResources.spaceId !== scope.spaceId)
            throw new ProjectStoreError('SCOPE_MISMATCH', 'the evolution scope must match the trusted principal')
        return this.database.withIdentityScope(scope, run)
    }
    async #locked(client: PoolClient, projectId: string, id: string): Promise<Row> {
        // Same project-first ordering as revision append; source membership/visibility locks follow.
        const project = await client.query(`SELECT project_id FROM agent_platform.projects WHERE ${scoped} AND project_id=$1::uuid FOR UPDATE`, [projectId])
        if (project.rows.length === 0)
            throw new ProjectStoreError('PROJECT_NOT_FOUND', 'project is unavailable')
        const result = await client.query<Row>(`SELECT *,lease_until<=now() AS lease_expired FROM agent_platform.project_evolutions WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid FOR UPDATE`, [projectId, id])
        const row = result.rows[0]
        if (row === undefined)
            throw new ProjectStoreError('REVISION_NOT_FOUND', 'evolution is unavailable')
        return row
    }
    async #sources(client: PoolClient, plan: ProjectEvolutionPlan): Promise<void> {
        await assertEvolutionSourcePins(client, plan)
    }
    async #facts(c: PoolClient, row: Row): Promise<void> {
        const plan = row.plan, projectId = plan.targetRevisionRef.projectId
        for (const candidateId of [...row.candidate_ids].sort()) {
            const candidate = await c.query<{
                input_version: ExtractionInputVersion
                idempotency_key: string
            }>(`SELECT input_version,idempotency_key FROM agent_platform.extraction_candidates WHERE ${scoped} AND candidate_id=$1::uuid FOR SHARE`, [candidateId])
            const value = candidate.rows[0], pin = value?.input_version.projectFact?.sources[0]
            const instance = await c.query<{
                revision: string
                matched_entity_id: string
            }>(`SELECT revision::text,matched_entity_id FROM agent_platform.instance_review_records WHERE ${scoped} AND project_id=$1::uuid AND record_id=$2::uuid ORDER BY revision DESC LIMIT 1 FOR SHARE`, [projectId, candidateId])
            const human = instance.rows[0]
            if (pin === undefined || human === undefined || pin.projectRevisionRef.digest !== plan.targetRevisionRef.digest || pin.entityCandidateId !== candidateId || !plan.sources.some((source) => source.documentId === pin.documentId && source.parseId === pin.parseId && source.mappingRef.id === pin.mappingRef.id && source.mappingRef.digest === pin.mappingRef.digest))
                conflict('rebuilt candidate identity/source pins differ')
            await assertConfirmation({
                query: async (text, values) => {
                    const result = await c.query(text, values === undefined ? undefined : [...values])
                    return {
                        rows: result.rows, rowCount: result.rowCount ?? 0
                    }
                }
            }, {
                candidateId, candidateDigest: value!.idempotency_key, source: pin, instanceRevision: human.revision, entityId: human.matched_entity_id
            })
            const published = await c.query<{
                status: string
                source_candidate_id: string
            }>(`SELECT status,source_candidate_id FROM agent_platform.published_statements WHERE ${scoped} AND statement_id=$1::uuid FOR SHARE`, [candidateId])
            if (published.rows[0]?.status !== 'active' || published.rows[0].source_candidate_id !== candidateId)
                conflict('a rebuilt publication was withdrawn')
            const physical = await c.query<{
                revision: string
                content_digest: string
            }>(`SELECT revision::text,content_digest FROM agent_platform.project_record_versions WHERE ${scoped} AND project_id=$1::uuid AND record_id=$2::uuid ORDER BY revision DESC LIMIT 1 FOR SHARE`, [projectId, pin.recordId])
            if (physical.rows[0]?.revision !== pin.recordRevision || physical.rows[0].content_digest !== pin.contentDigest)
                conflict('a rebuilt physical source changed before activation')
        }
    }
    async get(scope: ScopeRef, projectId: string, id: string, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const r = await c.query<Row>(`SELECT * FROM agent_platform.project_evolutions WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid`, [projectId, id])
            return r.rows[0] === undefined ? undefined : record(r.rows[0])
        })
    }
    async assertSources(scope: ScopeRef, projectId: string, id: string, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const r = await c.query<Row>(`SELECT * FROM agent_platform.project_evolutions WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid`, [projectId, id])
            if (r.rows[0] === undefined)
                conflict('the original rebuild plan is unavailable')
            await this.#sources(c, r.rows[0].plan)
        })
    }
    async findByKey(scope: ScopeRef, projectId: string, key: string, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const r = await c.query<Row>(`SELECT * FROM agent_platform.project_evolutions WHERE ${scoped} AND project_id=$1::uuid AND idempotency_key=$2`, [projectId, key])
            return r.rows[0] === undefined ? undefined : record(r.rows[0])
        })
    }
    async activeRebuild(scope: ScopeRef, projectId: string, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const r = await c.query<Row>(`SELECT e.* FROM agent_platform.project_evolutions e JOIN agent_platform.projects p USING (tenant_id,space_id,project_id) WHERE e.tenant_id=current_setting('app.tenant_id')::uuid AND e.space_id=current_setting('app.space_id')::uuid AND e.project_id=$1::uuid AND (((e.plan->'previousRevisionRef'->>'revision')::bigint=p.active_revision AND p.active_revision<>p.head_revision) OR (e.state='ready' AND (e.plan->'targetRevisionRef'->>'revision')::bigint=p.active_revision)) ORDER BY e.recorded_at DESC LIMIT 1`, [projectId])
            return r.rows[0] === undefined ? undefined : record(r.rows[0])
        })
    }
    async claim(scope: ScopeRef, projectId: string, id: string, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const row = await this.#locked(c, projectId, id)
            if (row.state !== 'queued' && !(row.state === 'running' && row.lease_expired === true))
                return undefined
            const plan = row.plan
            try {
                await this.#sources(c, plan)
            }
            catch (error) {
                if (!(error instanceof ProjectStoreError) || error.code !== 'VERSION_CONFLICT')
                    throw error
                await c.query(`UPDATE agent_platform.project_evolutions SET state='failed',revision=revision+1,error='SOURCE_CHANGED',lease_until=NULL WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid`, [projectId, id])
                await c.query(`UPDATE agent_platform.projects SET staging_writable=false WHERE ${scoped} AND project_id=$1::uuid`, [projectId])
                return undefined
            }
            const records = plan.sources.reduce((n, s) => n + s.rawRecordCount, 0)
            const batches = plan.sources.reduce((n, s) => n + Math.ceil(s.expectedRecords / 200), 0)
            if (row.attempts >= plan.maxAttempts || row.record_operations + records > plan.maxRecordOperations || row.batches + batches > plan.maxBatches)
                conflict('the shared evolution retry/work budget is exhausted')
            const r = await c.query<Row>(`UPDATE agent_platform.project_evolutions SET state='running',revision=revision+1,attempts=attempts+1,record_operations=record_operations+$3,batches=batches+$4,lease_until=LEAST(now()+interval '15 minutes',$5::timestamptz),error=NULL WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid RETURNING *`, [projectId, id, records, batches, ctx.deadline])
            return record(r.rows[0]!)
        })
    }
    async checkpoint(scope: ScopeRef, input: ProjectEvolutionRecord, state: 'awaiting_review' | 'needs_human' | 'failed', ids: readonly string[], error: string | undefined, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const projectId = input.plan.targetRevisionRef.projectId, row = await this.#locked(c, projectId, input.plan.evolutionId)
            if (row.state !== 'running' || row.revision !== input.revision)
                conflict('the evolution attempt lost its CAS or was cancelled')
            const expected = row.plan.sources.reduce((n, source) => n + source.expectedRecords, 0)
            if (ids.length > expected || new Set(ids).size !== ids.length || !ids.every(isUuid) || (state === 'awaiting_review' && ids.length !== expected))
                conflict('the rebuild candidate coverage is invalid')
            const candidates = await c.query<{
                candidate_id: string
                job_id: string
                kind: string
                input_version: ExtractionInputVersion
            }>(`SELECT candidate_id,job_id,kind,input_version FROM agent_platform.extraction_candidates WHERE ${scoped} AND candidate_id=ANY($1::uuid[])`, [ids])
            if (candidates.rows.length !== ids.length)
                conflict('every candidate selector must be stored')
            for (const candidate of candidates.rows) {
                const fact = candidate.input_version.projectFact
                assertProjectFactInputShape(fact)
                const pin = fact.sources[0]
                if (candidate.kind !== 'entity' || fact.sources.length !== 1 || pin === undefined || pin.projectRevisionRef.digest !== row.plan.targetRevisionRef.digest || pin.entityCandidateId !== candidate.candidate_id || !row.plan.sources.some((source) => source.sourceJobId === candidate.job_id && source.mappingRef.id === pin.mappingRef.id && source.mappingRef.digest === pin.mappingRef.digest && source.documentId === pin.documentId && source.parseId === pin.parseId))
                    conflict('candidate selectors do not belong to this exact original rebuild')
            }
            const r = await c.query<Row>(`UPDATE agent_platform.project_evolutions SET state=$3,revision=revision+1,candidate_ids=$4::jsonb,error=$5,lease_until=NULL WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid RETURNING *`, [projectId, row.plan.evolutionId, state, JSON.stringify(ids), error ?? null])
            return record(r.rows[0]!)
        })
    }
    async cancel(scope: ScopeRef, projectId: string, id: string, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const row = await this.#locked(c, projectId, id)
            if (row.state === 'ready')
                conflict('an activated evolution cannot be cancelled')
            if (row.state === 'cancelled')
                return record(row)
            await c.query(`UPDATE agent_platform.projects SET staging_writable=false WHERE ${scoped} AND project_id=$1::uuid AND head_revision=(($2::jsonb)->'targetRevisionRef'->>'revision')::bigint`, [projectId, JSON.stringify(row.plan)])
            await c.query(`UPDATE agent_platform.project_readiness SET state='revoked',fence_revision=fence_revision+1 WHERE ${scoped} AND project_id=$1::uuid AND project_revision=$2::bigint`, [projectId, row.plan.targetRevisionRef.revision])
            const r = await c.query<Row>(`UPDATE agent_platform.project_evolutions SET state='cancelled',revision=revision+1,lease_until=NULL WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid RETURNING *`, [projectId, id])
            return record(r.rows[0]!)
        })
    }
    async retry(scope: ScopeRef, projectId: string, id: string, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const row = await this.#locked(c, projectId, id)
            if (row.state === 'queued')
                return record(row)
            if (row.state !== 'failed' && row.state !== 'needs_human')
                conflict('only a failed evolution can be retried')
            await this.#sources(c, row.plan)
            if (row.attempts >= row.plan.maxAttempts)
                conflict('the evolution attempt budget is exhausted')
            const r = await c.query<Row>(`UPDATE agent_platform.project_evolutions SET state='queued',revision=revision+1,error=NULL WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid RETURNING *`, [projectId, id])
            const next = r.rows[0]!
            await c.query(`INSERT INTO agent_platform.job_outbox(tenant_id,space_id,outbox_id,job_id,topic,payload,idempotency_key,state,attempts,available_at,created_at)
        VALUES(current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,gen_random_uuid(),$1::uuid,$2,$3::jsonb,$4,'pending',0,now(),now()) ON CONFLICT(tenant_id,space_id,idempotency_key) DO NOTHING`, [row.plan.jobId, PROJECT_EVOLUTION_TOPIC, JSON.stringify({
                    projectId, evolutionId: id
                }), `evolution-retry:${id}:${next.revision}`])
            return record(next)
        })
    }
    async activate(scope: ScopeRef, input: ProjectEvolutionRecord, snapshots: readonly ProjectEvolutionSnapshot[], inputSnapshotRef: ResourceRef, ctx: ToolContext) {
        return this.#scope(scope, ctx, async (c) => {
            const projectId = input.plan.targetRevisionRef.projectId
            const row = await this.#locked(c, projectId, input.plan.evolutionId)
            const plan = row.plan
            if (row.state === 'ready')
                return record(row)
            if (row.state !== 'awaiting_review' || row.revision !== input.revision)
                conflict('evolution is no longer awaiting this exact activation')
            await this.#sources(c, plan)
            await this.#facts(c, row)
            const requiredRelations = plan.impacts.filter((impact) => impact.handling === 'human_relation').map((impact) => impact.logicalId)
            if (requiredRelations.length > 0) {
                const relations = await c.query<{
                    statement_id: string
                    relation_id: string
                    source_candidate_id: string
                }>(`SELECT statement_id,relation_id,source_candidate_id FROM agent_platform.published_statements WHERE ${scoped} AND kind='relation' AND status='active' AND relation_id=ANY($1::text[]) AND value#>>'{provenance,sources,0,projectRevisionRef,digest}'=$2 ORDER BY statement_id LIMIT 201 FOR SHARE`, [requiredRelations, plan.targetRevisionRef.digest])
                if (relations.rows.length > 200 || requiredRelations.some((id) => !relations.rows.some((relation) => relation.relation_id === id)))
                    conflict('changed relations require bounded actual published target relations')
                for (const relation of relations.rows) {
                    const candidate = await c.query<{
                        input_version: ExtractionInputVersion
                        idempotency_key: string
                    }>(`SELECT input_version,idempotency_key FROM agent_platform.extraction_candidates WHERE ${scoped} AND candidate_id=$1::uuid AND kind='relation' FOR SHARE`, [relation.source_candidate_id])
                    const saved = candidate.rows[0], fact = saved?.input_version.projectFact
                    assertProjectFactInputShape(fact)
                    if (fact.sources.length !== 2 || fact.sources.some((source) => source.projectRevisionRef.digest !== plan.targetRevisionRef.digest || !row.candidate_ids.includes(source.entityCandidateId)))
                        conflict('the relation endpoints do not belong to this rebuild')
                    const reviewed = await c.query<{
                        decision: string
                        content_digest: string
                    }>(`SELECT r.decision,r.content_digest FROM agent_platform.candidate_review_heads h JOIN agent_platform.semantic_candidate_reviews r USING(tenant_id,space_id,candidate_id,revision) WHERE h.tenant_id=current_setting('app.tenant_id')::uuid AND h.space_id=current_setting('app.space_id')::uuid AND h.candidate_id=$1::uuid FOR SHARE OF h`, [relation.source_candidate_id])
                    if (reviewed.rows[0]?.decision !== 'approve' || reviewed.rows[0].content_digest !== saved?.idempotency_key)
                        conflict('the exact relation review was withdrawn or changed')
                }
            }
            if (!isResourceRef(inputSnapshotRef))
                conflict('the actual approved-input artifact is required')
            const snapshot = snapshots[snapshots.length - 1]?.snapshotRef
            const objects = new Set(plan.sources.map((source) => source.objectId))
            if (snapshot === undefined || snapshots.length !== objects.size || snapshots.some((value) => !objects.has(value.objectId) || !isResourceRef(value.snapshotRef) || !isSha256Digest(value.sourceDigest) || !isRevisionString(value.factRecordedPoint.semantic) || !isRevisionString(value.factRecordedPoint.identity)) || new Set(snapshots.map((value) => value.objectId)).size !== objects.size)
                conflict('every rebuilt object needs its actual activated snapshot')
            await c.query(`SELECT revision FROM agent_platform.semantic_publication_heads WHERE ${scoped} FOR SHARE`)
            const identity = await c.query<{
                revision: string
            }>(`SELECT revision::text FROM agent_platform.identity_scope_read_heads WHERE ${scoped} FOR SHARE`)
            const semantic = await c.query<{
                revision: string
            }>(`SELECT (COALESCE((SELECT revision FROM agent_platform.semantic_publication_heads WHERE ${scoped}),0)+COALESCE((SELECT SUM(version) FROM agent_platform.statement_revisions WHERE ${scoped}),0))::text AS revision`)
            if (snapshots.some((value) => value.factRecordedPoint.semantic !== semantic.rows[0]?.revision || value.factRecordedPoint.identity !== (identity.rows[0]?.revision ?? '0')))
                conflict('published facts or human identity changed after snapshot creation')
            const projections = await c.query<{
                kind: string
                state: string
                target_ref: ResourceRef
                target_digest: string
                completeness: string
            }>(`SELECT kind,state,target_ref,target_digest,completeness FROM agent_platform.project_readiness WHERE ${scoped} AND project_id=$1::uuid AND project_revision=$2::bigint AND kind IN ('dataset','published_semantics') FOR SHARE`, [projectId, plan.targetRevisionRef.revision])
            if (projections.rows.length !== 2 || projections.rows.some((p) => p.state !== 'ready' || p.completeness !== 'complete') || !projections.rows.some((p) => p.kind === 'dataset' && p.target_ref.id === snapshot.id && p.target_ref.digest === snapshot.digest && p.target_digest === snapshot.digest))
                conflict('facts and exact dataset readiness must both be ready')
            const updated = await c.query(`UPDATE agent_platform.projects SET active_revision=$3::bigint,updated_at=now() WHERE ${scoped} AND project_id=$1::uuid AND head_revision=$3::bigint AND active_revision=$2::bigint AND staging_writable=true AND state<>'archived'`, [projectId, plan.previousRevisionRef.revision, plan.targetRevisionRef.revision])
            if (updated.rowCount !== 1)
                conflict('the project activation CAS failed')
            if (plan.strategy.kind === 'retire_previous')
                await c.query(`UPDATE agent_platform.project_readiness SET state='revoked',fence_revision=fence_revision+1 WHERE ${scoped} AND project_id=$1::uuid AND project_revision=$2::bigint`, [projectId, plan.previousRevisionRef.revision])
            const r = await c.query<Row>(`UPDATE agent_platform.project_evolutions SET state='ready',revision=revision+1,snapshots=$3::jsonb,input_snapshot_ref=$4::jsonb WHERE ${scoped} AND project_id=$1::uuid AND evolution_id=$2::uuid RETURNING *`, [projectId, plan.evolutionId, JSON.stringify(snapshots), JSON.stringify(inputSnapshotRef)])
            return record(r.rows[0]!)
        })
    }
}
