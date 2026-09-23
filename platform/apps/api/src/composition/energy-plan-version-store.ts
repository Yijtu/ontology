import type { ResourceRef, ToolContext } from '@ontology/contracts'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { LocalPlanDetail } from '../http/local-plan-detail'

export type EnergyPlanStatus = 'Selected' | 'Superseded'
export interface EnergyPlanVersionRecord {
  readonly planKey: string
  readonly versionId: string
  readonly planRef: ResourceRef
  readonly runId: string
  readonly scenarioRef: ResourceRef
  readonly parentPlanRef?: ResourceRef
  readonly stateRevision: number
  readonly status: EnergyPlanStatus
  readonly detail: LocalPlanDetail
  readonly createdAt: string
}
export class EnergyPlanVersionError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(code: string, httpStatus: number, message: string) { super(message); this.name = 'EnergyPlanVersionError'; this.code = code; this.httpStatus = httpStatus }
}
function keyOf(ref: ResourceRef): string { return `${ref.kind}:${ref.id}@${ref.version}:${ref.digest}` }
function sameRef(a: ResourceRef | undefined, b: ResourceRef | undefined): boolean { return a === undefined ? b === undefined : b !== undefined && a.id === b.id && a.version === b.version && a.digest === b.digest && a.kind === b.kind }
function scope(ctx: ToolContext) { return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId } }
function recordOf(row: Record<string, unknown>): EnergyPlanVersionRecord {
  return {
    planKey: String(row.plan_key), versionId: String(row.version_id), planRef: row.plan_ref as ResourceRef,
    runId: String(row.run_id), scenarioRef: row.scenario_ref as ResourceRef,
    ...(row.parent_plan_ref === null ? {} : { parentPlanRef: row.parent_plan_ref as ResourceRef }),
    stateRevision: Number(row.state_revision), status: row.status as EnergyPlanStatus,
    detail: row.detail as LocalPlanDetail, createdAt: new Date(row.created_at as string).toISOString(),
  }
}

export interface EnergyPlanVersionStore {
  select(input: Omit<EnergyPlanVersionRecord, 'versionId' | 'status' | 'createdAt'>, ctx: ToolContext): Promise<EnergyPlanVersionRecord>
  getSelected(planKey: string, ctx: ToolContext): Promise<EnergyPlanVersionRecord | undefined>
  get(planKey: string, planRef: ResourceRef, ctx: ToolContext): Promise<EnergyPlanVersionRecord | undefined>
  list(planKey: string, ctx: ToolContext): Promise<{ readonly versions: readonly EnergyPlanVersionRecord[]; readonly truncated: boolean }>
}

/** Plan lifecycle has its own tenant-scoped CAS boundary; generic run records remain unchanged. */
export function createPostgresEnergyPlanVersionStore(database: ControlPostgresDatabase): EnergyPlanVersionStore {
  return {
    async select(input, ctx) {
      if (!Number.isSafeInteger(input.stateRevision) || input.stateRevision < 0) throw new EnergyPlanVersionError('INVALID_ARGUMENT', 422, 'plan state revision is invalid')
      return database.withIdentityScope(scope(ctx), async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id') || ':' || current_setting('app.space_id') || ':' || $1,0))`, [input.planKey])
        const state = await client.query<{ revision: string }>(`SELECT revision FROM agent_platform.virtual_solix_states WHERE device_id='virtual-solix-1' FOR UPDATE`)
        const currentRevision = Number(state.rows[0]?.revision ?? 0)
        if (currentRevision !== input.stateRevision) throw new EnergyPlanVersionError('STALE_VIRTUAL_STATE', 409, 'Virtual SOLIX state advanced while this plan was being verified; the plan stays unselected')
        const selected = await client.query<Record<string, unknown>>(`SELECT plan_key,version_id,plan_ref,run_id,scenario_ref,parent_plan_ref,state_revision,status,detail,created_at FROM agent_platform.energy_plan_versions WHERE plan_key=$1 AND status='Selected' FOR UPDATE`, [input.planKey])
        const currentRow = selected.rows[0]
        if (currentRow !== undefined) {
          const current = recordOf(currentRow)
          if (sameRef(current.planRef, input.planRef) && current.detail.inputManifestHash === input.detail.inputManifestHash && current.stateRevision === input.stateRevision) return current
        }
        const retry = await client.query<Record<string, unknown>>(`SELECT plan_key,version_id,plan_ref,run_id,scenario_ref,parent_plan_ref,state_revision,status,detail,created_at FROM agent_platform.energy_plan_versions WHERE plan_key=$1 AND version_id=$2::uuid`, [input.planKey,input.runId])
        if (retry.rows[0] !== undefined) return recordOf(retry.rows[0])
        const current = currentRow === undefined ? undefined : recordOf(currentRow)
        if (!sameRef(current?.planRef, input.parentPlanRef)) throw new EnergyPlanVersionError('STALE_PLAN_PARENT', 409, 'the selected parent plan changed; refresh plan history before selecting this version')
        if (current !== undefined) await client.query(`UPDATE agent_platform.energy_plan_versions SET status='Superseded' WHERE plan_key=$1 AND version_id=$2::uuid AND status='Selected'`, [input.planKey,current.versionId])
        const createdAt = new Date().toISOString()
        const record: EnergyPlanVersionRecord = { ...input, versionId: input.runId, status: 'Selected', createdAt }
        await client.query(`INSERT INTO agent_platform.energy_plan_versions (tenant_id,space_id,plan_key,version_id,plan_ref_key,plan_ref,run_id,scenario_ref,parent_plan_ref,state_revision,status,detail,created_at,selected_at)
          VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,$2::uuid,$3,$4::jsonb,$2::uuid,$5::jsonb,$6::jsonb,$7,'Selected',$8::jsonb,$9,$9)`,
          [input.planKey,input.runId,keyOf(input.planRef),JSON.stringify(input.planRef),JSON.stringify(input.scenarioRef),input.parentPlanRef===undefined?null:JSON.stringify(input.parentPlanRef),input.stateRevision,JSON.stringify(input.detail),createdAt])
        return record
      })
    },
    async getSelected(planKey, ctx) {
      return database.withIdentityScope(scope(ctx), async (client) => {
        const result = await client.query<Record<string, unknown>>(`SELECT plan_key,version_id,plan_ref,run_id,scenario_ref,parent_plan_ref,state_revision,status,detail,created_at FROM agent_platform.energy_plan_versions WHERE plan_key=$1 AND status='Selected'`, [planKey])
        return result.rows[0] === undefined ? undefined : recordOf(result.rows[0])
      }, { readOnly: true })
    },
    async get(planKey, planRef, ctx) {
      return database.withIdentityScope(scope(ctx), async (client) => {
        const result = await client.query<Record<string, unknown>>(`SELECT plan_key,version_id,plan_ref,run_id,scenario_ref,parent_plan_ref,state_revision,status,detail,created_at FROM agent_platform.energy_plan_versions WHERE plan_key=$1 AND plan_ref_key=$2 ORDER BY created_at DESC,version_id DESC LIMIT 1`, [planKey,keyOf(planRef)])
        return result.rows[0] === undefined ? undefined : recordOf(result.rows[0])
      }, { readOnly: true })
    },
    async list(planKey, ctx) {
      return database.withIdentityScope(scope(ctx), async (client) => {
        const result = await client.query<Record<string, unknown>>(`SELECT plan_key,version_id,plan_ref,run_id,scenario_ref,parent_plan_ref,state_revision,status,detail,created_at FROM agent_platform.energy_plan_versions WHERE plan_key=$1 ORDER BY created_at DESC,version_id DESC LIMIT 101`, [planKey])
        return { versions: result.rows.slice(0, 100).map(recordOf), truncated: result.rows.length > 100 }
      }, { readOnly: true })
    },
  }
}
