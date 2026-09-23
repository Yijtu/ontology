import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { ExecutionRecord } from '@ontology/extension-home-energy'
import { decodeEnergyOperationInput } from '@ontology/extension-home-energy'
import type { ImmutableArtifactWriter, ResourceRef, ToolContext } from '@ontology/contracts'

export interface LegacyVirtualState {
  readonly energyKwh: number
  readonly socPercent: number
  readonly revision: number
  readonly updatedAt: string
  readonly simulatedAt?: string
  readonly stateRef?: ResourceRef
}

/** One-time upgrade of an observed v0.2 state whose execution stored a final blob only in its receipt. */
export async function recoverLegacyVirtualSolixState(input: {
  readonly database: ControlPostgresDatabase
  readonly blobs: LocalImmutableBlobStore
  readonly artifacts: ImmutableArtifactWriter
  readonly state: LegacyVirtualState
  readonly ctx: ToolContext
}): Promise<LegacyVirtualState & { readonly simulatedAt: string; readonly stateRef: ResourceRef }> {
  const { state, ctx } = input
  if (state.revision <= 0 || state.stateRef !== undefined) throw new Error('legacy recovery requires a persisted post-execution state without a stateRef')
  const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  const receipt = await input.database.withIdentityScope(scopeRef, async (client) => {
    const result = await client.query<{ record: ExecutionRecord }>(`SELECT record FROM agent_platform.energy_execution_records ORDER BY created_at DESC LIMIT 1`)
    return result.rows[0]?.record
  }, { readOnly: true })
  const originalRef = receipt?.finalStateRef
  const scenarioRef = receipt?.inputRefs[0]
  if (originalRef === undefined || scenarioRef === undefined || receipt?.finalState?.revision !== state.revision || receipt.finalState.energyKwh !== state.energyKwh || receipt.finalState.socPercent !== state.socPercent) {
    throw new Error('the legacy Virtual SOLIX state has no matching execution receipt')
  }
  const original = JSON.parse(new TextDecoder().decode(await input.blobs.readAuthorized({ scopeRef, blobRef: originalRef }, ctx))) as Record<string, unknown>
  if (original['energyKwh'] !== state.energyKwh || original['socPercent'] !== state.socPercent || original['revision'] !== state.revision) {
    throw new Error('the legacy execution artifact does not match the persisted state')
  }
  const scenario = decodeEnergyOperationInput(await input.blobs.readAuthorized({ scopeRef, blobRef: scenarioRef }, ctx))
  const simulatedAt = scenario.snapshot.manifest.horizon.end
  if (typeof original['simulatedAt'] === 'string' && original['simulatedAt'] !== simulatedAt) {
    throw new Error('the legacy execution artifact conflicts with its scenario horizon')
  }
  const upgradedState = {
    deviceId: 'virtual-solix-1', mode: 'simulation', energyKwh: state.energyKwh,
    socPercent: state.socPercent, revision: state.revision, updatedAt: state.updatedAt,
    simulatedAt, source: 'home-energy.legacy-state-recovery', recoveredFrom: originalRef,
  }
  const written = await input.artifacts.putBytes({ scopeRef, content: new TextEncoder().encode(JSON.stringify(upgradedState)), mediaType: 'application/vnd.ontology.virtual-solix-state+json' }, ctx)
  const observed = JSON.parse(new TextDecoder().decode(await input.blobs.readAuthorized({ scopeRef, blobRef: written.blobRef }, ctx))) as Record<string, unknown>
  if (observed['energyKwh'] !== state.energyKwh || observed['socPercent'] !== state.socPercent || observed['revision'] !== state.revision || observed['simulatedAt'] !== simulatedAt) {
    throw new Error('recovered Virtual SOLIX state failed artifact read-back')
  }
  const repaired = { ...state, simulatedAt, stateRef: written.blobRef }
  const committed = await input.database.withIdentityScope(scopeRef, async (client) => {
    const result = await client.query<{ state: LegacyVirtualState }>(`UPDATE agent_platform.virtual_solix_states SET state=$1::jsonb WHERE device_id='virtual-solix-1' AND revision=$2 AND NOT (state ? 'stateRef') RETURNING state`, [JSON.stringify(repaired), state.revision])
    return result.rows[0]?.state
  })
  if (committed?.stateRef === undefined || committed.simulatedAt !== simulatedAt) {
    throw new Error('Virtual SOLIX state changed during legacy recovery; restart the read-back')
  }
  return { ...committed, simulatedAt, stateRef: committed.stateRef }
}
