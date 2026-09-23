import type { FastifyInstance } from 'fastify'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { EvidenceStorePort, PublishedAnswer, ResourceRef, ToolContext } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { authenticateRequest, readTraceId } from './shared'
import type { RequestAuthenticator } from './shared'

/** A projection of the archived simulation, only available after its answer is published. */
export interface LocalPlanDetail {
  readonly runId: string
  readonly answerId: string
  readonly sourceEvidenceRef: ResourceRef
  readonly resultRef: ResourceRef
  readonly selectedPlanRef: ResourceRef
  readonly inputManifestHash: string
  readonly weatherScenario: string
  readonly reserveSocPercent: number
  readonly reserveWindowStartSlot: number
  readonly initialEnergyKwh: number
  readonly initialSocPercent: number
  readonly stateRevision: number
  readonly slotMinutes: number
  readonly stateRef?: ResourceRef
  readonly parentPlanRef?: ResourceRef
  readonly dataMode: 'simulation'
  readonly optimality: 'best_of_tested_candidates'
  readonly selectedStrategy: string
  readonly candidateTotalCost: number
  readonly baselineTotalCost: number
  readonly currency: string
  readonly reserveSatisfied: boolean
  readonly intervals: readonly {
    readonly slotIndex: number
    readonly startUtc: string
    readonly endUtc: string
    readonly chargeKw: number
    readonly dischargeKw: number
    readonly pvAvailableKw: number
    readonly energyStartKwh: number
    readonly energyEndKwh: number
  }[]
  readonly reserveMargins: readonly {
    readonly windowStartSlot: number
    readonly windowEndSlot: number
    readonly reserveKwh: number
    readonly marginKwh: number
    readonly satisfied: boolean
  }[]
  readonly assumptions: readonly string[]
}

class LocalPlanDetailError extends Error {
  readonly code: string
  readonly httpStatus: number
  constructor(code: string, httpStatus: number, message: string) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, `${label} is not a record`)
  }
  return value as Record<string, unknown>
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, `${label} is not a finite number`)
  }
  return value
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, `${label} is missing`)
  }
  return value
}

function artifactRef(value: unknown): ResourceRef {
  const item = record(value, 'resultRef')
  if (item['kind'] !== 'artifact') throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'resultRef is not an artifact')
  return {
    id: string(item['id'], 'resultRef.id'),
    version: string(item['version'], 'resultRef.version'),
    digest: string(item['digest'], 'resultRef.digest'),
    kind: 'artifact',
  }
}

function matchingClaim(answer: PublishedAnswer, predicate: string, expected: number): void {
  const claim = answer.claims.find((item) => item.predicate === predicate)
  if (claim === undefined || claim.value.value !== expected) {
    throw new LocalPlanDetailError('PLAN_ANSWER_MISMATCH', 409, `archived plan differs from published ${predicate}`)
  }
}

function projectPlan(result: unknown, answer: PublishedAnswer, evidenceRef: ResourceRef, resultRef: ResourceRef): LocalPlanDetail {
  const planner = record(result, 'plan result')
  if (planner['status'] !== 'feasible' || planner['executionMode'] !== 'simulation' || planner['optimality'] !== 'best_of_tested_candidates') {
    throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'archived result is not a feasible simulation plan')
  }
  const selection = record(planner['selection'], 'selection')
  const selectedRef = record(selection['selectedPlanRef'], 'selectedPlanRef')
  const selectedId = string(selectedRef['id'], 'selectedPlanRef.id')
  const selectedDigest = string(selectedRef['digest'], 'selectedPlanRef.digest')
  const selectedVersion = string(selectedRef['version'], 'selectedPlanRef.version')
  if (!Array.isArray(planner['candidates'])) throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'plan candidates are missing')
  const candidate = planner['candidates']
    .map((item) => record(item, 'candidate'))
    .find((item) => {
      const ref = record(item['planRef'], 'candidate.planRef')
      return ref['id'] === selectedId && ref['digest'] === selectedDigest
    })
  if (candidate === undefined) throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'selected candidate was not archived')
  const objective = record(candidate['objective'], 'candidate objective')
  const baseline = record(planner['baseline'], 'baseline')
  const baselineObjective = record(baseline['objective'], 'baseline objective')
  const candidateTotalCost = number(objective['totalCost'], 'candidate cost')
  const baselineTotalCost = number(baselineObjective['totalCost'], 'baseline cost')
  const terminalEnergyKwh = number(objective['terminalEnergyKwh'], 'terminal energy')
  const reserveSatisfied = objective['reserveSatisfied']
  if (typeof reserveSatisfied !== 'boolean') throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'reserve status is missing')
  matchingClaim(answer, 'candidate_total_cost', candidateTotalCost)
  matchingClaim(answer, 'baseline_total_cost', baselineTotalCost)
  matchingClaim(answer, 'terminal_energy_kwh', terminalEnergyKwh)
  matchingClaim(answer, 'reserve_satisfied', reserveSatisfied ? 1 : 0)
  const simulation = record(candidate['simulation'], 'candidate simulation')
  if (simulation['status'] !== 'feasible' || !Array.isArray(simulation['intervals']) || simulation['intervals'].length === 0 || simulation['intervals'].length > 192) {
    throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'plan trajectory is missing or unbounded')
  }
  const intervals = simulation['intervals'].map((item) => {
    const entry = record(item, 'simulation interval')
    return {
      slotIndex: number(entry['slotIndex'], 'slotIndex'),
      startUtc: string(entry['startUtc'], 'startUtc'), endUtc: string(entry['endUtc'], 'endUtc'),
      chargeKw: number(entry['chargeKw'], 'chargeKw'), dischargeKw: number(entry['dischargeKw'], 'dischargeKw'),
      pvAvailableKw: number(entry['pvAvailableKw'], 'pvAvailableKw'),
      energyStartKwh: number(entry['energyStartKwh'], 'energyStartKwh'), energyEndKwh: number(entry['energyEndKwh'], 'energyEndKwh'),
    }
  })
  if (!Array.isArray(simulation['reserveMargins']) || simulation['reserveMargins'].length > 96) {
    throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'reserve checks are missing or unbounded')
  }
  const reserveMargins = simulation['reserveMargins'].map((item) => {
    const margin = record(item, 'reserve margin')
    if (typeof margin['satisfied'] !== 'boolean') throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'reserve check has no verdict')
    return {
      windowStartSlot: number(margin['windowStartSlot'], 'reserve window start'),
      windowEndSlot: number(margin['windowEndSlot'], 'reserve window end'),
      reserveKwh: number(margin['reserveKwh'], 'reserve energy'),
      marginKwh: number(margin['marginKwh'], 'reserve margin'),
      satisfied: margin['satisfied'],
    }
  })
  const assumptions = planner['assumptions']
  if (!Array.isArray(assumptions) || assumptions.length > 32 || assumptions.some((item) => typeof item !== 'string')) {
    throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'plan assumptions are invalid')
  }
  const assumption = (name: string): string | undefined => assumptions.find((item): item is string => typeof item === 'string' && item.startsWith(`${name}=`))?.slice(name.length + 1)
  const initialEnergyKwh = number(intervals[0]?.energyStartKwh, 'initial energy')
  const capacityKwh = Number(assumption('battery_capacity_kwh') ?? '10')
  if (!Number.isFinite(capacityKwh) || capacityKwh <= 0) throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'battery capacity assumption is invalid')
  const revisionValue = Number(assumption('state_revision') ?? '0')
  if (!Number.isSafeInteger(revisionValue) || revisionValue < 0) throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'state revision assumption is invalid')
  const refFromAssumption = (key: string): ResourceRef | undefined => {
    const raw = assumption(key)
    if (raw === undefined) return undefined
    try {
      const parsed = record(JSON.parse(raw) as unknown, key)
      if (key === 'parent_plan_ref' && parsed['kind'] !== 'plan') throw new Error('wrong resource kind')
      if (key === 'state_ref' && parsed['kind'] !== 'artifact') throw new Error('wrong resource kind')
      return { id: string(parsed['id'], `${key}.id`), version: string(parsed['version'], `${key}.version`), digest: string(parsed['digest'], `${key}.digest`), kind: parsed['kind'] as ResourceRef['kind'] }
    } catch { throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, `${key} is invalid`) }
  }
  const stateRef = refFromAssumption('state_ref')
  const parentPlanRef = refFromAssumption('parent_plan_ref')
  const reserveWindowStartSlot = Number(assumption('reserve_window_start_slot') ?? '0')
  if (!Number.isSafeInteger(reserveWindowStartSlot) || reserveWindowStartSlot < 0 || reserveWindowStartSlot >= 96) throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'reserve target window is invalid')
  const firstInterval = intervals[0]
  const slotMinutes = firstInterval === undefined ? 0 : (Date.parse(firstInterval.endUtc) - Date.parse(firstInterval.startUtc)) / 60_000
  if (!Number.isFinite(slotMinutes) || slotMinutes <= 0) throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'plan interval duration is invalid')
  return {
    runId: answer.runId, answerId: answer.answerId, sourceEvidenceRef: evidenceRef, resultRef,
    selectedPlanRef: { id: selectedId, version: selectedVersion, digest: selectedDigest, kind: 'plan' },
    inputManifestHash: string(planner['inputManifestHash'], 'input manifest hash'),
    weatherScenario: assumption('weather_scenario') ?? 'unknown',
    reserveSocPercent: (reserveMargins[0]?.reserveKwh ?? 0) / capacityKwh * 100,
    reserveWindowStartSlot,
    initialEnergyKwh,
    initialSocPercent: initialEnergyKwh / capacityKwh * 100,
    stateRevision: revisionValue,
    slotMinutes,
    ...(stateRef === undefined ? {} : { stateRef }),
    ...(parentPlanRef === undefined ? {} : { parentPlanRef }),
    dataMode: 'simulation', optimality: 'best_of_tested_candidates',
    selectedStrategy: string(candidate['strategy'], 'selected strategy'),
    candidateTotalCost, baselineTotalCost, currency: string(objective['currency'], 'currency'), reserveSatisfied,
    intervals, reserveMargins, assumptions,
  }
}

export function registerLocalPlanDetailRoute(app: FastifyInstance, options: {
  readonly authenticate: RequestAuthenticator
  readonly getAnswer: (runId: string, ctx: ToolContext) => Promise<PublishedAnswer | undefined>
  readonly getParentPlanRef?: (runId: string, ctx: ToolContext) => Promise<ResourceRef | undefined>
  readonly evidence: EvidenceStorePort
  readonly blobs: LocalImmutableBlobStore
}): void {
  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/plan', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(options.authenticate, request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const ctx = createRequestToolContext({
      principal: auth.principal, spaceId: auth.spaceId, traceId, runId,
      allowedResourceKinds: ['evidence', 'artifact'],
    })
    const detail = await readLocalPlanDetail(runId, options, ctx)
    const parentPlanRef = await options.getParentPlanRef?.(runId, ctx)
    reply.status(200).send({ data: { ...detail, ...(parentPlanRef === undefined ? {} : { parentPlanRef }) }, meta: { traceId } })
    return reply
  })
}

export async function readLocalPlanDetail(runId: string, options: {
  readonly getAnswer: (runId: string, ctx: ToolContext) => Promise<PublishedAnswer | undefined>
  readonly evidence: EvidenceStorePort
  readonly blobs: LocalImmutableBlobStore
}, ctx: ToolContext): Promise<LocalPlanDetail> {
  const answer = await options.getAnswer(runId, ctx)
  if (answer === undefined) throw new LocalPlanDetailError('PLAN_NOT_AVAILABLE', 404, 'the run has no published plan answer')
  const cost = answer.claims.find((claim) => claim.predicate === 'candidate_total_cost')
  const evidenceRef = cost?.references[0]?.evidenceRef
  if (evidenceRef === undefined) throw new LocalPlanDetailError('PLAN_NOT_AVAILABLE', 404, 'the published answer has no plan evidence')
  const scopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  const evidence = await options.evidence.get(scopeRef, evidenceRef.id, ctx)
  if (evidence === undefined || evidence.evidenceRef.digest !== evidenceRef.digest || evidence.envelope.dataMode !== 'simulation' || evidence.envelope.payloadRef === undefined) throw new LocalPlanDetailError('PLAN_EVIDENCE_INVALID', 409, 'published plan evidence is unavailable or no longer matches')
  const authorizedEvidence = await options.blobs.getAuthorized({ scopeRef, blobRef: evidence.envelope.payloadRef }, ctx)
  if (!authorizedEvidence.integrityVerified) throw new LocalPlanDetailError('PLAN_EVIDENCE_INVALID', 409, 'plan evidence integrity failed')
  const payload = record(JSON.parse(new TextDecoder().decode(await options.blobs.readAuthorized({ scopeRef, blobRef: evidence.envelope.payloadRef }, ctx))) as unknown, 'plan evidence')
  const computation = record(payload['computation'], 'plan computation')
  const resultRef = artifactRef(computation['resultRef'])
  const authorizedResult = await options.blobs.getAuthorized({ scopeRef, blobRef: resultRef }, ctx)
  if (!authorizedResult.integrityVerified) throw new LocalPlanDetailError('PLAN_RESULT_INVALID', 409, 'plan artifact integrity failed')
  const result: unknown = JSON.parse(new TextDecoder().decode(await options.blobs.readAuthorized({ scopeRef, blobRef: resultRef }, ctx)))
  return projectPlan(result, answer, evidenceRef, resultRef)
}
