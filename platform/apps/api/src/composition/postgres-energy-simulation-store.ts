import type { ToolContext } from '@ontology/contracts'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { SimulationRecordStore, SimulationRecordView } from './energy-simulation'

/** Small scoped persistence adapter for the energy surface's record index. Result bytes stay immutable blobs. */
export function createPostgresSimulationRecordStore(database: ControlPostgresDatabase): SimulationRecordStore {
  return {
    async put(record: SimulationRecordView, ctx: ToolContext) {
      await database.withIdentityScope({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, async (client) => {
        await client.query(
          `INSERT INTO agent_platform.energy_simulation_records (tenant_id,space_id,simulation_id,record)
           VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1::uuid,$2::jsonb)
           ON CONFLICT (tenant_id,space_id,simulation_id) DO NOTHING`,
          [record.simulationId, JSON.stringify(record)],
        )
      })
    },
    async get(simulationId: string, ctx: ToolContext) {
      return database.withIdentityScope({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, async (client) => {
        const result = await client.query<{ record: SimulationRecordView }>(
          `SELECT record FROM agent_platform.energy_simulation_records WHERE simulation_id=$1::uuid`,
          [simulationId],
        )
        return result.rows[0]?.record
      }, { readOnly: true })
    },
  }
}

export async function listPostgresSimulationRecords(database: ControlPostgresDatabase, ctx: ToolContext): Promise<readonly SimulationRecordView[]> {
  return database.withIdentityScope({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, async (client) => {
    const result = await client.query<{ record: SimulationRecordView }>(
      `SELECT record FROM agent_platform.energy_simulation_records ORDER BY created_at DESC LIMIT 500`,
    )
    return result.rows.map((row) => row.record)
  }, { readOnly: true })
}
