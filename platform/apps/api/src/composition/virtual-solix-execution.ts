import type { ResourceRef, ToolContext } from '@ontology/contracts'
import { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ImmutableArtifactWriter } from '@ontology/contracts'
import type { ExecutionRecord, RequestExecutionInput, SimulationStepExecutionRecord } from '@ontology/extension-home-energy'
import { decodeEnergyOperationInput } from '@ontology/extension-home-energy'
import { DEFAULT_SCENARIO_START_UTC } from './home-energy-scenario'
import { SimulationSurfaceError } from './energy-simulation'
import type { ExecutionSurface, VirtualBatteryStateView } from './energy-simulation'
import { listPostgresSimulationRecords } from './postgres-energy-simulation-store'

interface PlannerPayload {
  readonly status: string
  readonly selection: { readonly selectedPlanRef?: ResourceRef }
  readonly candidates: readonly { readonly planRef: ResourceRef; readonly plan: { readonly steps: readonly { readonly slotIndex: number; readonly chargeKw: number; readonly dischargeKw: number }[] }; readonly simulation: { readonly status: string; readonly intervals?: readonly { readonly slotIndex: number; readonly endUtc: string }[] } }[]
}
interface StoredVirtualState { readonly energyKwh: number; readonly socPercent: number; readonly revision: number; readonly updatedAt: string; readonly simulatedAt: string; readonly stateRef?: ResourceRef }
function asPlannerPayload(value: unknown): PlannerPayload | undefined {
  if (typeof value !== 'object' || value === null || !('candidates' in value) || !Array.isArray(value.candidates) || !('selection' in value)) return undefined
  return value as PlannerPayload
}
function refEqual(a: ResourceRef, b: ResourceRef): boolean { return a.id === b.id && a.version === b.version && a.digest === b.digest && a.kind === b.kind }
function refsEqual(a: readonly ResourceRef[], b: readonly ResourceRef[]): boolean { return a.length === b.length && a.every((ref, index) => { const other = b[index]; return other !== undefined && refEqual(ref, other) }) }
function scope(ctx: ToolContext) { return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId } }
function refuse(code: string, message: string): never { throw new SimulationSurfaceError(code, code === 'CAPABILITY_NOT_CONFIGURED' ? 409 : 422, message) }

/** Local-only, deterministic Virtual SOLIX runner. There is deliberately no device adapter. */
export function createVirtualSolixExecutionSurface(options: {
  readonly database: ControlPostgresDatabase
  readonly blobs: LocalImmutableBlobStore
  readonly artifacts: ImmutableArtifactWriter
  readonly now?: () => string
  readonly initialEnergyKwh?: number
  readonly capacityKwh?: number
  readonly initialSimulatedAt?: string
  /** The local product requires the plan to remain selected at the state-write boundary. */
  readonly requireSelectedPlanVersion?: boolean
  readonly authorizePublishedPlan?: (input: { readonly runId: string; readonly planRef: ResourceRef; readonly inputRefs: readonly ResourceRef[]; readonly energyInput: ReturnType<typeof decodeEnergyOperationInput> }, ctx: ToolContext) => Promise<boolean>
}): ExecutionSurface {
  const now = options.now ?? (() => new Date().toISOString())
  const initialEnergyKwh = options.initialEnergyKwh ?? 3.5
  const capacityKwh = options.capacityKwh ?? 10
  const initialSimulatedAt = options.initialSimulatedAt ?? DEFAULT_SCENARIO_START_UTC
  return {
    async getVirtualState(ctx): Promise<VirtualBatteryStateView> {
      const row = await options.database.withIdentityScope(scope(ctx), async (client) => {
        const result = await client.query<{ state: StoredVirtualState; revision: string }>(`SELECT state,revision FROM agent_platform.virtual_solix_states WHERE device_id='virtual-solix-1'`)
        return result.rows[0]
      }, { readOnly: true })
      if (row === undefined) return { deviceId: 'virtual-solix-1', energyKwh: initialEnergyKwh, capacityKwh, socPercent: initialEnergyKwh / capacityKwh * 100, revision: 0, mode: 'simulation', updatedAt: now(), simulatedAt: initialSimulatedAt }
      let stateRef = row.state.stateRef
      if (stateRef === undefined) {
        const last = await options.database.withIdentityScope(scope(ctx), async (client) => {
          const result = await client.query<{ record: ExecutionRecord }>(`SELECT record FROM agent_platform.energy_execution_records WHERE plan_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1`)
          return result.rows[0]?.record.finalStateRef
        }, { readOnly: true })
        stateRef = last
      }
      if (stateRef === undefined && Number(row.revision) === 0) return { deviceId: 'virtual-solix-1', energyKwh: row.state.energyKwh, capacityKwh, socPercent: row.state.socPercent, revision: 0, mode: 'simulation', updatedAt: row.state.updatedAt, simulatedAt: row.state.simulatedAt ?? initialSimulatedAt }
      if (stateRef === undefined) refuse('VERIFICATION_FAILED', 'persisted Virtual SOLIX state has no integrity-bound read-back artifact')
      const bytes = await options.blobs.readAuthorized({ scopeRef: scope(ctx), blobRef: stateRef }, ctx)
      const stored = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      if (stored.energyKwh !== row.state.energyKwh || stored.socPercent !== row.state.socPercent || stored.revision !== row.state.revision || stored.simulatedAt !== row.state.simulatedAt) refuse('VERIFICATION_FAILED', 'Virtual SOLIX state artifact and control record differ')
      return { deviceId: 'virtual-solix-1', energyKwh: row.state.energyKwh, capacityKwh, socPercent: row.state.socPercent, revision: Number(row.revision), mode: 'simulation', updatedAt: row.state.updatedAt, simulatedAt: row.state.simulatedAt, stateRef }
    },
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
          const record = prior.rows[0].record
          const replayRevision = record.expectedStateRevision ?? (record.finalState === undefined || record.stepRecords === undefined ? undefined : record.finalState.revision - record.stepRecords.length)
          if (!refEqual(record.planRef, request.planRef) || record.runId !== request.runId || record.operationRef.id !== request.operationRef.id || record.operationRef.version !== request.operationRef.version || !refsEqual(record.inputRefs, request.inputRefs) || replayRevision !== request.expectedStateRevision) refuse('INVALID_ARGUMENT', 'idempotency key was already used for a different execution request')
          return record
        }
        const existingPlan = await client.query<{ record: ExecutionRecord }>(`SELECT record FROM agent_platform.energy_execution_records WHERE plan_ref=$1::jsonb`, [JSON.stringify(request.planRef)])
        if (existingPlan.rows[0] !== undefined) refuse('INVALID_ARGUMENT', 'this plan has already been simulated; use the original idempotency key to read its result')
        await client.query(`INSERT INTO agent_platform.virtual_solix_states (tenant_id,space_id,device_id,revision,state) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,'virtual-solix-1',0,$1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify({ energyKwh: initialEnergyKwh, socPercent: initialEnergyKwh / capacityKwh * 100, revision: 0, updatedAt: now(), simulatedAt: initialSimulatedAt })])
        const stateRow = await client.query<{ revision: string; state: StoredVirtualState }>(`SELECT revision,state FROM agent_platform.virtual_solix_states WHERE device_id='virtual-solix-1' FOR UPDATE`)
        const current = stateRow.rows[0]?.state
        if (current === undefined || Number(stateRow.rows[0]?.revision) !== current.revision || Math.abs(current.energyKwh - initialEnergyKwh) > 1e-9) refuse('INVALID_ARGUMENT', 'Virtual SOLIX state no longer matches this plan starting state; replan before execution')
        if (options.requireSelectedPlanVersion === true) {
          const selected = await client.query<{ plan_ref: ResourceRef }>(`SELECT plan_ref FROM agent_platform.energy_plan_versions WHERE plan_key='virtual-solix-1' AND status='Selected' FOR SHARE`)
          if (selected.rows[0] === undefined || !refEqual(selected.rows[0].plan_ref, request.planRef)) refuse('VERIFICATION_FAILED', 'the plan was superseded before Virtual SOLIX could apply an action')
        }
        if (request.expectedStateRevision === undefined || request.expectedStateRevision !== current.revision) refuse('INVALID_ARGUMENT', 'If-Match state revision is missing or stale; rebuild the scenario against current Virtual SOLIX state')
        const expectedRevision = Number(energyInput.assumptions.find((value) => value.startsWith('state_revision='))?.slice('state_revision='.length) ?? 'NaN')
        const expectedStart = energyInput.assumptions.find((value) => value.startsWith('simulation_clock_start='))?.slice('simulation_clock_start='.length)
        const stateRefText = energyInput.assumptions.find((value) => value.startsWith('state_ref='))?.slice('state_ref='.length)
        let expectedStateRef: ResourceRef | undefined
        if (stateRefText !== undefined) { try { expectedStateRef = JSON.parse(stateRefText) as ResourceRef } catch { refuse('VERIFICATION_FAILED', 'the scenario state reference is invalid') } }
        if (expectedRevision !== current.revision || expectedStart !== current.simulatedAt || !refEqual(expectedStateRef ?? request.planRef, current.stateRef ?? request.planRef)) refuse('INVALID_ARGUMENT', 'the selected plan was built from a stale Virtual SOLIX state/time revision')
        const baseRevision = current.revision
        const steps: SimulationStepExecutionRecord[] = []
        let energyKwh = current.energyKwh
        let stateRef: ResourceRef | undefined
        const slotHours = energyInput.snapshot.manifest.slotMinutes / 60
        for (const step of candidate.plan.steps) {
          const before = energyKwh
          const after = before + step.chargeKw * slotHours * chargeEfficiency - step.dischargeKw * slotHours / dischargeEfficiency
          const interval = candidate.simulation.intervals?.find((item) => item.slotIndex === step.slotIndex)
          if (interval === undefined) refuse('VERIFICATION_FAILED', `the archived plan has no end time for step ${step.slotIndex}`)
          const accepted = Number.isFinite(after) && step.chargeKw >= 0 && step.dischargeKw >= 0 && !(step.chargeKw > 0 && step.dischargeKw > 0) && after >= (battery.minEnergyKwh ?? 0) - 1e-9 && after <= (battery.maxEnergyKwh ?? capacityKwh) + 1e-9 && step.chargeKw <= chargePowerLimitKw + 1e-9 && step.dischargeKw <= dischargePowerLimitKw + 1e-9
          if (!accepted) refuse('INVALID_ARGUMENT', `Virtual SOLIX rejected step ${step.slotIndex} due to declared physical limits`)
          energyKwh = after
          const stepRevision = baseRevision + steps.length + 1
          const state = { deviceId: 'virtual-solix-1', mode: 'simulation' as const, energyKwh, socPercent: energyKwh / capacityKwh * 100, revision: stepRevision, updatedAt: now(), simulatedAt: interval.endUtc, source: 'home-energy.simulator' }
          const written = await options.artifacts.putBytes({ scopeRef: scope(ctx), content: new TextEncoder().encode(JSON.stringify(state)), mediaType: 'application/vnd.ontology.virtual-solix-state+json' }, ctx)
          const observedBytes = await options.blobs.readAuthorized({ scopeRef: scope(ctx), blobRef: written.blobRef }, ctx)
          const observed = JSON.parse(new TextDecoder().decode(observedBytes)) as Record<string, unknown>
          if (observed.energyKwh !== energyKwh || observed.revision !== stepRevision || observed.simulatedAt !== interval.endUtc) refuse('INTEGRITY_ERROR', 'Virtual SOLIX state read-back verification failed')
          stateRef = written.blobRef
          steps.push({ slotIndex: step.slotIndex, requested: { chargeKw: step.chargeKw, dischargeKw: step.dischargeKw }, accepted: true, observed: true, statusHistory: ['Requested', 'Accepted', 'Observed'], beforeEnergyKwh: before, afterEnergyKwh: energyKwh, stateRef, mode: 'simulation' })
        }
        if (stateRef === undefined) throw new Error('simulation produced no read-back state')
        const executionId = globalThis.crypto.randomUUID()
        const requestedAt = now()
        const finalRevision = baseRevision + steps.length
        const simulatedAt = candidate.simulation.intervals?.at(-1)?.endUtc
        if (simulatedAt === undefined) refuse('VERIFICATION_FAILED', 'the selected plan has no final simulated timestamp')
        const finalState = { energyKwh, socPercent: energyKwh / capacityKwh * 100, revision: finalRevision, updatedAt: requestedAt, simulatedAt, mode: 'simulation' as const, stateRef }
        const finalBytes = await options.blobs.readAuthorized({ scopeRef: scope(ctx), blobRef: stateRef }, ctx)
        const readBack = JSON.parse(new TextDecoder().decode(finalBytes)) as Record<string, unknown>
        if (readBack.energyKwh !== finalState.energyKwh || readBack.socPercent !== finalState.socPercent || readBack.revision !== finalState.revision || readBack.simulatedAt !== finalState.simulatedAt) refuse('INTEGRITY_ERROR', 'final Virtual SOLIX state does not match the final step read-back')
        const record: ExecutionRecord = { executionId, runId: request.runId, mode: 'simulation', operationRef: request.operationRef, planRef: request.planRef, inputRefs: [...request.inputRefs], expectedStateRevision: request.expectedStateRevision, phase: 'completed', requestedAt, liveSupported: false, deviceRequestsSent: 0, stepRecords: steps, finalStateRef: stateRef, finalState: { energyKwh, socPercent: energyKwh / capacityKwh * 100, revision: finalRevision, mode: 'simulation' } }
        const updated = await client.query<{ state: StoredVirtualState; revision: string }>(`UPDATE agent_platform.virtual_solix_states SET revision=$1,state=$2::jsonb,updated_at=$3 WHERE device_id='virtual-solix-1' RETURNING state,revision`, [finalRevision, JSON.stringify(finalState), requestedAt])
        if (updated.rows[0]?.state.energyKwh !== energyKwh || Number(updated.rows[0]?.revision) !== finalRevision) refuse('INTEGRITY_ERROR', 'persisted Virtual SOLIX state failed database read-back')
        await client.query(`INSERT INTO agent_platform.energy_execution_records (tenant_id,space_id,execution_id,idempotency_key,plan_ref,record) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1::uuid,$2,$3::jsonb,$4::jsonb)`, [executionId, key, JSON.stringify(request.planRef), JSON.stringify(record)])
        return record
      })
    },
  }
}
