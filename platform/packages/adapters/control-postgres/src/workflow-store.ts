import { isToolContext } from '@ontology/contracts'
import type { RunManifest, ToolContext, Uuid, VerificationRecord, VerificationStorePort, WorkflowInputManifest, WorkflowManifestStore, WorkflowRunState } from '@ontology/contracts'
import type { QueryResultRow } from 'pg'
import { ControlPostgresDatabase } from './database'

function scope(ctx: ToolContext): { tenantId: string; spaceId: string } {
  if (!isToolContext(ctx) || ctx.allowedResources.tenantId !== ctx.principal.tenantId) throw new Error('trusted workflow scope is required')
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}
function value<T>(raw: unknown): T { return (typeof raw === 'string' ? JSON.parse(raw) : raw) as T }

/** PostgreSQL persistence for controller state. Every operation is RLS scoped and JSONB preserves the versioned contracts verbatim. */
export class PostgresWorkflowStore implements WorkflowManifestStore, VerificationStorePort {
  readonly #db: ControlPostgresDatabase
  constructor(database: ControlPostgresDatabase) { this.#db = database }

  async saveRunManifest(manifest: Parameters<WorkflowManifestStore['saveRunManifest']>[0], ctx: ToolContext) {
    const s = scope(ctx)
    return this.#db.withIdentityScope(s, async c => {
      const result = await c.query<{ manifest: unknown } & QueryResultRow>(`INSERT INTO agent_platform.workflow_run_manifests (tenant_id,space_id,run_id,manifest) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,$2::jsonb) ON CONFLICT (tenant_id,space_id,run_id) DO NOTHING RETURNING manifest`, [manifest.runId, JSON.stringify(manifest)])
      if (result.rows[0]) return value<typeof manifest>(result.rows[0].manifest)
      const prior = await c.query<{ manifest: unknown } & QueryResultRow>(`SELECT manifest FROM agent_platform.workflow_run_manifests WHERE run_id=$1`, [manifest.runId])
      const stored = prior.rows[0] && value<typeof manifest>(prior.rows[0].manifest)
      if (!stored || stored.inputManifestId !== manifest.inputManifestId) throw new Error('immutable workflow run manifest conflict')
      return stored
    })
  }
  async getRunManifest(runId: Uuid, ctx: ToolContext): Promise<RunManifest | undefined> { return this.#readOne<RunManifest>('workflow_run_manifests','manifest', 'run_id',runId,ctx) }
  async saveInputManifest(manifest: Parameters<WorkflowManifestStore['saveInputManifest']>[0], ctx: ToolContext) {
    const s=scope(ctx); return this.#db.withIdentityScope(s, async c => { await c.query(`INSERT INTO agent_platform.workflow_input_manifests (tenant_id,space_id,manifest_id,run_id,manifest) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,$2,$3::jsonb) ON CONFLICT (tenant_id,space_id,manifest_id) DO UPDATE SET manifest=EXCLUDED.manifest,updated_at=now()`,[manifest.manifestId,manifest.runId,JSON.stringify(manifest)]); return manifest })
  }
  async getInputManifest(manifestId: Uuid, ctx: ToolContext): Promise<WorkflowInputManifest | undefined> { return this.#readOne<WorkflowInputManifest>('workflow_input_manifests','manifest','manifest_id',manifestId,ctx) }
  async saveRunState(state: Parameters<WorkflowManifestStore['saveRunState']>[0],ctx:ToolContext) {
    const s=scope(ctx); return this.#db.withIdentityScope(s, async c => { await c.query(`INSERT INTO agent_platform.workflow_run_states (tenant_id,space_id,run_id,state) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,$2::jsonb) ON CONFLICT (tenant_id,space_id,run_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`,[state.runId,JSON.stringify(state)]); return state })
  }
  async getRunState(runId: Uuid,ctx:ToolContext): Promise<WorkflowRunState | undefined> { return this.#readOne<WorkflowRunState>('workflow_run_states','state','run_id',runId,ctx) }
  async record(record: VerificationRecord,ctx:ToolContext):Promise<void> {
    const s=scope(ctx); await this.#db.withIdentityScope(s, async c => { const id=record.verification.verificationId; const result=await c.query(`INSERT INTO agent_platform.workflow_verifications (tenant_id,space_id,verification_id,run_id,record) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,$2,$3::jsonb) ON CONFLICT (tenant_id,space_id,verification_id) DO NOTHING`,[id,record.runId,JSON.stringify(record)]); if(result.rowCount===0){const prior=await c.query<{record:unknown}&QueryResultRow>(`SELECT record FROM agent_platform.workflow_verifications WHERE verification_id=$1`,[id]); if(!prior.rows[0] || JSON.stringify(value<VerificationRecord>(prior.rows[0].record))!==JSON.stringify(record)) throw new Error('verification id conflicts with stored record')} })
  }
  async find(verificationId: Uuid,ctx:ToolContext): Promise<VerificationRecord | undefined> { return this.#readOne<VerificationRecord>('workflow_verifications','record','verification_id',verificationId,ctx) }
  async #readOne<T>(table:string,column:string,key:string,id:Uuid,ctx:ToolContext):Promise<T|undefined> { const s=scope(ctx); return this.#db.withIdentityScope(s,async c=>{const r=await c.query<{value:unknown}&QueryResultRow>(`SELECT ${column} AS value FROM agent_platform.${table} WHERE ${key}=$1`,[id]); return r.rows[0] ? value<T>(r.rows[0].value) : undefined},{readOnly:true}) }
}
