import type { ResourceRef, ToolContext } from '@ontology/contracts'
import { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ImmutableArtifactWriter } from '@ontology/contracts'
import type { ExecutionRecord, RequestExecutionInput, SimulationStepExecutionRecord } from '@ontology/extension-home-energy'
import { decodeEnergyOperationInput } from '@ontology/extension-home-energy'
import { SimulationSurfaceError } from './energy-simulation'
import type { ExecutionSurface } from './energy-simulation'
import { listPostgresSimulationRecords } from './postgres-energy-simulation-store'

interface PlannerPayload {
  readonly status: string
  readonly selection: { readonly selectedPlanRef?: ResourceRef }
  readonly candidates: readonly { readonly planRef: ResourceRef; readonly plan: { readonly steps: readonly { readonly slotIndex: number; readonly chargeKw: number; readonly dischargeKw: number }[] }; readonly simulation: { readonly status: string } }[]
}
interface StoredVirtualState { readonly energyKwh: number; readonly socPercent: number; readonly revision: number; readonly updatedAt: string }
function asPlannerPayload(value: unknown): PlannerPayload | undefined {
  if (typeof value !== 'object' || value === null || !('candidates' in value) || !Array.isArray(value.candidates) || !('selection' in value)) return undefined
  return value as PlannerPayload
}
function refEqual(a: ResourceRef, b: ResourceRef): boolean { return a.id === b.id && a.version === b.version && a.digest === b.digest && a.kind === b.kind }
function scope(ctx: ToolContext) { return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId } }
function refuse(code: string, message: string): never { throw new SimulationSurfaceError(code, code === 'CAPABILITY_NOT_CONFIGURED' ? 409 : 422, message) }

/** Local-only, deterministic Virtual SOLIX runner. There is deliberately no device adapter. */
export function createVirtualSolixExecutionSurface(options: {
  readonly database: ControlPostgresDatabase
  readonly blobs: LocalImmutableBlobStore
  readonly artifacts: ImmutableArtifactWriter
  readonly now?: () => string
  readonly authorizePublishedPlan?: (input: { readonly runId: string; readonly planRef: ResourceRef; readonly inputRefs: readonly ResourceRef[]; readonly energyInput: ReturnType<typeof decodeEnergyOperationInput> }, ctx: ToolContext) => Promise<boolean>
}): ExecutionSurface {
  const now = options.now ?? (() => new Date().toISOString())
  return {
    async getExecution(executionId, ctx) {
      return options.database.withIdentityScope(scope(ctx), async (client) => {
        const result = await client.query<{ record: ExecutionRecord }>(`SELECT record FROM agent_platform.energy_execution_records WHERE execution_id=$1::uuid`, [executionId])
        return result.rows[0]?.record
      }, { readOnly: true })
    },
    async requestExecution(request: RequestExecutionInput, ctx: ToolContext): Promise<ExecutionRecord> {
      if (request.mode === 'live') refuse('CAPABILITY_NOT_CONFIGURED', 'live device execution is not configured; no device request was sent')
      if (request.operationRef.id !== 'home-energy.simulate' || request.planRef.kind !== 'plan') refuse('INVALID_ARGUMENT', 'only a registered home-energy plan can be simulated')
      const records = await listPostgresSimulationRecords(options.database, ctx)
      let chosen: { resultRef: ResourceRef; payload: PlannerPayload } | undefined
      for (const record of records) {
        if (!record.inputRefs.some((ref) => request.inputRefs.some((input) => refEqual(ref, input)))) continue
        try {
          const bytes = await options.blobs.readAuthorized({ scopeRef: scope(ctx), blobRef: record.resultRef }, ctx)
          const payload = asPlannerPayload(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
          if (payload?.candidates.some((candidate) => refEqual(candidate.planRef, request.planRef))) { chosen = { resultRef: record.resultRef, payload }; break }
        } catch { /* untrusted or stale records are ignored; no execution is authorized by them */ }
      }
      if (chosen === undefined || chosen.payload.status !== 'feasible' || chosen.payload.selection.selectedPlanRef === undefined || !refEqual(chosen.payload.selection.selectedPlanRef, request.planRef)) {
        refuse('INVALID_ARGUMENT', 'execution requires the selected plan from a feasible archived simulation')
      }
      const candidate = chosen.payload.candidates.find((item) => refEqual(item.planRef, request.planRef))
      if (candidate === undefined || candidate.simulation.status !== 'feasible' || candidate.plan.steps.length === 0) refuse('INVALID_ARGUMENT', 'selected plan has no feasible steps')
      const inputRef = request.inputRefs[0]
      if (inputRef === undefined) refuse('INVALID_ARGUMENT', 'execution requires its archived input')
      const inputBytes = await options.blobs.readAuthorized({ scopeRef: scope(ctx), blobRef: inputRef }, ctx)
      const energyInput = decodeEnergyOperationInput(inputBytes)
      if (options.authorizePublishedPlan === undefined || !(await options.authorizePublishedPlan({ runId: request.runId, planRef: request.planRef, inputRefs: request.inputRefs, energyInput }, ctx))) refuse('VERIFICATION_FAILED', 'simulation execution requires a matching published, verified energy plan for this run')
      const battery = energyInput.battery
      if (battery.energyCapacityKwh === undefined || battery.initialEnergyKwh === undefined || battery.chargeEfficiency === undefined || battery.dischargeEfficiency === undefined || battery.chargePowerLimitKw === undefined || battery.dischargePowerLimitKw === undefined || energyInput.snapshot.manifest.slotMinutes <= 0) refuse('INVALID_ARGUMENT', 'the archived input has incomplete Virtual SOLIX parameters')
      const capacityKwh = battery.energyCapacityKwh
      const initialEnergyKwh = battery.initialEnergyKwh
      const chargeEfficiency = battery.chargeEfficiency
      const dischargeEfficiency = battery.dischargeEfficiency
      const chargePowerLimitKw = battery.chargePowerLimitKw
      const dischargePowerLimitKw = battery.dischargePowerLimitKw

      return options.database.withIdentityScope(scope(ctx), async (client) => {
        const key = request.idempotencyKey
        const prior = await client.query<{ record: ExecutionRecord }>(`SELECT record FROM agent_platform.energy_execution_records WHERE idempotency_key=$1`, [key])
        if (prior.rows[0] !== undefined) {
          if (!refEqual(prior.rows[0].record.planRef, request.planRef)) refuse('INVALID_ARGUMENT', 'idempotency key was already used for a different plan')
          return prior.rows[0].record
        }
        const existingPlan = await client.query<{ record: ExecutionRecord }>(`SELECT record FROM agent_platform.energy_execution_records WHERE plan_ref=$1::jsonb`, [JSON.stringify(request.planRef)])
        if (existingPlan.rows[0] !== undefined) refuse('INVALID_ARGUMENT', 'this plan has already been simulated; use the original idempotency key to read its result')
        await client.query(`INSERT INTO agent_platform.virtual_solix_states (tenant_id,space_id,device_id,revision,state) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,'virtual-solix-1',0,$1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify({ energyKwh: initialEnergyKwh, socPercent: initialEnergyKwh / capacityKwh * 100, revision: 0, updatedAt: now() })])
        const stateRow = await client.query<{ revision: string; state: StoredVirtualState }>(`SELECT revision,state FROM agent_platform.virtual_solix_states WHERE device_id='virtual-solix-1' FOR UPDATE`)
        const current = stateRow.rows[0]?.state
        if (current === undefined || Number(stateRow.rows[0]?.revision) !== current.revision || Math.abs(current.energyKwh - initialEnergyKwh) > 1e-9) refuse('INVALID_ARGUMENT', 'Virtual SOLIX state no longer matches this plan starting state; replan before execution')
        const baseRevision = current.revision
        const steps: SimulationStepExecutionRecord[] = []
        let energyKwh = current.energyKwh
        let stateRef: ResourceRef | undefined
        const slotHours = energyInput.snapshot.manifest.slotMinutes / 60
        for (const step of candidate.plan.steps) {
          const before = energyKwh
          const after = before + step.chargeKw * slotHours * chargeEfficiency - step.dischargeKw * slotHours / dischargeEfficiency
          const accepted = Number.isFinite(after) && step.chargeKw >= 0 && step.dischargeKw >= 0 && !(step.chargeKw > 0 && step.dischargeKw > 0) && after >= (battery.minEnergyKwh ?? 0) - 1e-9 && after <= (battery.maxEnergyKwh ?? capacityKwh) + 1e-9 && step.chargeKw <= chargePowerLimitKw + 1e-9 && step.dischargeKw <= dischargePowerLimitKw + 1e-9
          if (!accepted) refuse('INVALID_ARGUMENT', `Virtual SOLIX rejected step ${step.slotIndex} due to declared physical limits`)
          energyKwh = after
          const stepRevision = baseRevision + steps.length + 1
          const state = { deviceId: 'virtual-solix-1', mode: 'simulation' as const, energyKwh, socPercent: energyKwh / capacityKwh * 100, revision: stepRevision, updatedAt: now(), source: 'home-energy.simulator' }
          const written = await options.artifacts.putBytes({ scopeRef: scope(ctx), content: new TextEncoder().encode(JSON.stringify(state)), mediaType: 'application/vnd.ontology.virtual-solix-state+json' }, ctx)
          const observedBytes = await options.blobs.readAuthorized({ scopeRef: scope(ctx), blobRef: written.blobRef }, ctx)
          const observed = JSON.parse(new TextDecoder().decode(observedBytes)) as Record<string, unknown>
          if (observed.energyKwh !== energyKwh || observed.revision !== stepRevision) refuse('INTEGRITY_ERROR', 'Virtual SOLIX state read-back verification failed')
          stateRef = written.blobRef
          steps.push({ slotIndex: step.slotIndex, requested: { chargeKw: step.chargeKw, dischargeKw: step.dischargeKw }, accepted: true, observed: true, statusHistory: ['Requested', 'Accepted', 'Observed'], beforeEnergyKwh: before, afterEnergyKwh: energyKwh, stateRef, mode: 'simulation' })
        }
        if (stateRef === undefined) throw new Error('simulation produced no read-back state')
        const executionId = globalThis.crypto.randomUUID()
        const requestedAt = now()
        const finalRevision = baseRevision + steps.length
        const finalState = { energyKwh, socPercent: energyKwh / capacityKwh * 100, revision: finalRevision, updatedAt: requestedAt, mode: 'simulation' as const }
        const finalBytes = await options.blobs.readAuthorized({ scopeRef: scope(ctx), blobRef: stateRef }, ctx)
        const readBack = JSON.parse(new TextDecoder().decode(finalBytes)) as Record<string, unknown>
        if (readBack.energyKwh !== finalState.energyKwh || readBack.socPercent !== finalState.socPercent || readBack.revision !== finalState.revision) refuse('INTEGRITY_ERROR', 'final Virtual SOLIX state does not match the final step read-back')
        const record: ExecutionRecord = { executionId, runId: request.runId, mode: 'simulation', operationRef: request.operationRef, planRef: request.planRef, inputRefs: [...request.inputRefs], phase: 'completed', requestedAt, liveSupported: false, deviceRequestsSent: 0, stepRecords: steps, finalStateRef: stateRef, finalState: { energyKwh, socPercent: energyKwh / capacityKwh * 100, revision: finalRevision, mode: 'simulation' } }
        const updated = await client.query<{ state: StoredVirtualState; revision: string }>(`UPDATE agent_platform.virtual_solix_states SET revision=$1,state=$2::jsonb,updated_at=$3 WHERE device_id='virtual-solix-1' RETURNING state,revision`, [finalRevision, JSON.stringify(finalState), requestedAt])
        if (updated.rows[0]?.state.energyKwh !== energyKwh || Number(updated.rows[0]?.revision) !== finalRevision) refuse('INTEGRITY_ERROR', 'persisted Virtual SOLIX state failed database read-back')
        await client.query(`INSERT INTO agent_platform.energy_execution_records (tenant_id,space_id,execution_id,idempotency_key,plan_ref,record) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1::uuid,$2,$3::jsonb,$4::jsonb)`, [executionId, key, JSON.stringify(request.planRef), JSON.stringify(record)])
        return record
      })
    },
  }
}
