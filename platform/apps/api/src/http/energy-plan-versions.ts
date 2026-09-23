import type { FastifyInstance } from 'fastify'
import type { ResourceRef, ToolContext } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { authenticateRequest, InvalidRequestFieldError, isRecord, readTraceId } from './shared'
import type { RequestAuthenticator } from './shared'
import type { LocalPlanDetail } from './local-plan-detail'
import type { EnergyPlanVersionStore } from '../composition/energy-plan-version-store'
import { EnergyPlanVersionError } from '../composition/energy-plan-version-store'
import type { VirtualBatteryStateView } from '../composition/energy-simulation'

export const HOME_ENERGY_PLAN_KEY = 'virtual-solix-1'
function ref(value: unknown, name: string): ResourceRef {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.version !== 'string' || typeof value.digest !== 'string' || value.kind !== 'plan') throw new InvalidRequestFieldError(`${name} must be a plan resource reference`)
  return { id: value.id, version: value.version, digest: value.digest, kind: 'plan' }
}
function refKey(value: ResourceRef): string { return `${value.id}@${value.version}:${value.digest}` }
function sumPv(plan: LocalPlanDetail): number { return plan.intervals.reduce((sum, slot) => sum + slot.pvAvailableKw * plan.slotMinutes / 60, 0) }
export function buildEnergyPlanDiff(parent: LocalPlanDetail, next: LocalPlanDetail, parentRef: ResourceRef, nextRef: ResourceRef) {
  if (parent.intervals.length !== next.intervals.length || parent.slotMinutes !== next.slotMinutes || parent.intervals[0]?.startUtc !== next.intervals[0]?.startUtc || parent.intervals.at(-1)?.endUtc !== next.intervals.at(-1)?.endUtc) throw new EnergyPlanVersionError('PLAN_DIFF_NOT_COMPARABLE', 409, 'plan horizons or interval boundaries differ; no trajectory comparison was produced')
  if (parent.stateRevision !== next.stateRevision || Math.abs(parent.initialEnergyKwh - next.initialEnergyKwh) > 1e-9) throw new EnergyPlanVersionError('PLAN_DIFF_NOT_COMPARABLE', 409, 'plan starting SOC/state revision differs; cost and trajectory deltas would mix causes')
  const slots = parent.intervals.length
  const affected = [] as { slotIndex: number; pvBeforeKw: number; pvAfterKw: number; chargeBeforeKw: number; chargeAfterKw: number; dischargeBeforeKw: number; dischargeAfterKw: number; energyBeforeKwh: number; energyAfterKwh: number }[]
  for (let i = 0; i < slots; i += 1) {
    const a = parent.intervals[i], b = next.intervals[i]
    if (a === undefined || b === undefined) continue
    if (a.pvAvailableKw !== b.pvAvailableKw || a.chargeKw !== b.chargeKw || a.dischargeKw !== b.dischargeKw || a.energyEndKwh !== b.energyEndKwh) affected.push({ slotIndex: i, pvBeforeKw: a.pvAvailableKw, pvAfterKw: b.pvAvailableKw, chargeBeforeKw: a.chargeKw, chargeAfterKw: b.chargeKw, dischargeBeforeKw: a.dischargeKw, dischargeAfterKw: b.dischargeKw, energyBeforeKwh: a.energyEndKwh, energyAfterKwh: b.energyEndKwh })
  }
  const inputChanges: Record<string, unknown> = {}
  if (parent.weatherScenario !== next.weatherScenario) { inputChanges['weatherBefore'] = parent.weatherScenario; inputChanges['weatherAfter'] = next.weatherScenario }
  if (parent.reserveSocPercent !== next.reserveSocPercent) { inputChanges['reserveSocBefore'] = parent.reserveSocPercent; inputChanges['reserveSocAfter'] = next.reserveSocPercent }
  if (parent.reserveWindowStartSlot !== next.reserveWindowStartSlot) { inputChanges['reserveWindowBefore'] = parent.reserveWindowStartSlot; inputChanges['reserveWindowAfter'] = next.reserveWindowStartSlot }
  if (parent.initialSocPercent !== next.initialSocPercent) { inputChanges['initialSocBefore'] = parent.initialSocPercent; inputChanges['initialSocAfter'] = next.initialSocPercent }
  const pvBefore = sumPv(parent), pvAfter = sumPv(next)
  const weatherChanged = parent.weatherScenario !== next.weatherScenario
  const solarChanged = Math.abs(pvBefore - pvAfter) > 1e-9
  const batteryChanged = affected.length > 0 || parent.reserveSatisfied !== next.reserveSatisfied
  const causeTrace: Record<string, unknown>[] = []
  if (weatherChanged) causeTrace.push({ stage: 'weather_input', before: parent.weatherScenario, after: next.weatherScenario, scenarioEvidence: next.resultRef })
  if (solarChanged) causeTrace.push({ stage: 'solar_forecast', pvBeforeKwh: pvBefore, pvAfterKwh: pvAfter, evidence: next.sourceEvidenceRef })
  if (batteryChanged) causeTrace.push({ stage: 'battery_plan', changedIntervals: affected.length, selectedStrategy: next.selectedStrategy, evidence: next.resultRef })
  return {
    parentPlanRef: parentRef, planRef: nextRef,
    evidenceRefs: [parent.sourceEvidenceRef, next.sourceEvidenceRef], resultRefs: [parent.resultRef, next.resultRef],
    inputChanges,
    forecast: { pvBeforeKwh: pvBefore, pvAfterKwh: pvAfter, pvDeltaKwh: pvAfter - pvBefore },
    result: { costBefore: parent.candidateTotalCost, costAfter: next.candidateTotalCost, costDelta: next.candidateTotalCost - parent.candidateTotalCost, reserveSatisfiedBefore: parent.reserveSatisfied, reserveSatisfiedAfter: next.reserveSatisfied },
    affectedIntervals: affected,
    causeTrace,
    limitations: ['差异由已发布计划输入与确定性预测/计划工件计算；本地本体未绑定 Weather→Solar→Battery 已确认关系时，不将该数据链解释成已验证本体因果关系。'],
  }
}

export function registerEnergyPlanVersionRoutes(app: FastifyInstance, options: {
  readonly authenticate: RequestAuthenticator
  readonly store: EnergyPlanVersionStore
  readonly resolvePublishedPlan: (runId: string, ctx: ToolContext) => Promise<{ readonly detail: LocalPlanDetail; readonly scenarioRef: ResourceRef }>
  readonly getVirtualState: (ctx: ToolContext) => Promise<VirtualBatteryStateView>
}): void {
  app.post('/api/v1/energy/plan-versions/select', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(options.authenticate, request, reply)
    if (auth === undefined) return reply
    if (!auth.principal.roles.some((role) => ['business-user', 'simulation-user', 'operator', 'platform-admin'].includes(role))) throw new EnergyPlanVersionError('FORBIDDEN', 403, 'energy plan selection requires an authorized simulation user')
    if (!isRecord(request.body) || typeof request.body.runId !== 'string') throw new InvalidRequestFieldError('runId is required')
    const runId = request.body.runId
    const ctx = createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId, allowedResourceKinds: ['artifact', 'evidence', 'plan'] })
    const { detail, scenarioRef } = await options.resolvePublishedPlan(runId, ctx)
    const state = await options.getVirtualState(ctx)
    if (state.revision !== detail.stateRevision || Math.abs(state.energyKwh - detail.initialEnergyKwh) > 1e-9) throw new EnergyPlanVersionError('STALE_VIRTUAL_STATE', 409, 'the Virtual SOLIX changed while this plan was being checked; the existing selected plan remains active')
    const selected = await options.store.select({ planKey: HOME_ENERGY_PLAN_KEY, planRef: detail.selectedPlanRef, runId, scenarioRef, ...(detail.parentPlanRef === undefined ? {} : { parentPlanRef: detail.parentPlanRef }), stateRevision: detail.stateRevision, detail }, ctx)
    reply.status(201).send({ data: selected, meta: { traceId } })
    return reply
  })
  app.get('/api/v1/energy/plan-versions', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(options.authenticate, request, reply)
    if (auth === undefined) return reply
    const ctx = createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: globalThis.crypto.randomUUID(), allowedResourceKinds: ['artifact', 'evidence', 'plan'] })
    const [selected, history] = await Promise.all([options.store.getSelected(HOME_ENERGY_PLAN_KEY, ctx), options.store.list(HOME_ENERGY_PLAN_KEY, ctx)])
    reply.status(200).send({ data: { selected, versions: history.versions, historyTruncated: history.truncated }, meta: { traceId } })
    return reply
  })
  app.get<{ Params: { planId: string } }>('/api/v1/energy/plan-versions/:planId/diff', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(options.authenticate, request, reply)
    if (auth === undefined) return reply
    const query = request.query as Record<string, unknown>
    const parentRef = ref({ id: query['parentId'], version: query['parentVersion'], digest: query['parentDigest'], kind: 'plan' }, 'parent')
    const planRef = ref({ id: query['id'], version: query['version'], digest: query['digest'], kind: 'plan' }, 'plan')
    if (planRef.id !== request.params.planId) throw new InvalidRequestFieldError('plan id does not match the query reference')
    const ctx = createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId: globalThis.crypto.randomUUID(), allowedResourceKinds: ['artifact', 'evidence', 'plan'] })
    const [before, after] = await Promise.all([options.store.get(HOME_ENERGY_PLAN_KEY, parentRef, ctx), options.store.get(HOME_ENERGY_PLAN_KEY, planRef, ctx)])
    if (before === undefined || after === undefined || !after.parentPlanRef || refKey(after.parentPlanRef) !== refKey(parentRef)) throw new EnergyPlanVersionError('PLAN_VERSION_NOT_FOUND', 404, 'the requested parent/child plan versions are not linked')
    reply.status(200).send({ data: buildEnergyPlanDiff(before.detail, after.detail, parentRef, planRef), meta: { traceId } })
    return reply
  })
}
