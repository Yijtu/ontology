import type {
  CandidateStore,
  CandidateRecord,
  EntityCandidate,
  IdentityDecisionStore,
  ResourceRef,
  SemanticPublicationStore,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type { EnergyOperationInput } from '@ontology/extension-home-energy'
import { PublishedRelationNavigator } from '@ontology/semantic-engine'
import type { LocalPlanDetail } from '../http/local-plan-detail'

export const ENERGY_EXPLANATION_RELATIONS = [
  'weather_informs_solar_forecast',
  'solar_forecast_guides_energy_plan',
  'energy_plan_controls_device',
] as const
const START_ENTITY_LIMIT = 32

export interface EnergyRunExplanation {
  readonly status: 'verified' | 'limited'
  readonly runId: string
  readonly definition: { readonly ref: VersionRef; readonly declaredRelations: typeof ENERGY_EXPLANATION_RELATIONS }
  readonly instancePath: readonly {
    readonly relationId: string
    readonly statementId: string
    readonly statementVersion: string
    readonly fromEntityId: string
    readonly toEntityId: string
    readonly sourceRefs: readonly ResourceRef[]
  }[]
  readonly runEvidence: {
    readonly scenarioRef: ResourceRef
    readonly sourceEvidenceRef: ResourceRef
    readonly resultRef: ResourceRef
    readonly selectedPlanRef: ResourceRef
    readonly inputManifestHash: string
    readonly weatherScenario: string
    readonly reserveSocPercent: number
    readonly reserveWindowStartSlot: number
    readonly reserveMargins: LocalPlanDetail['reserveMargins']
    readonly stateRevision: number
    readonly horizon: { readonly startUtc: string; readonly endUtc: string }
    readonly forecastPvKwh: number
    readonly candidateTotalCost: number
    readonly reserveSatisfied: boolean
  }
  readonly publicationRevision: string
  readonly gaps: readonly string[]
}

function sameVersion(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}
function validNativeId(candidate: CandidateRecord | undefined, objectId: string, expected: string): candidate is EntityCandidate {
  return candidate !== undefined && candidate.kind === 'entity' && candidate.objectId === objectId && candidate.nativeId === expected && candidate.sourceSpans.length > 0
}

/**
 * Bounded, read-only A4 projection. A complete explanation requires a live published
 * instance path whose confirmed entity identities bind to this run's exact scenario,
 * planner result, selected plan and Virtual SOLIX. The industry declaration alone never
 * produces a verified explanation.
 */
export async function explainEnergyRun(input: {
  readonly runId: string
  readonly scenarioRef: ResourceRef
  readonly scenarioInput: EnergyOperationInput
  readonly detail: LocalPlanDetail
  readonly definitionRef: VersionRef
  readonly publications: SemanticPublicationStore
  readonly identity: IdentityDecisionStore
  readonly candidates: CandidateStore
  readonly ctx: ToolContext
  readonly validAt: string
}): Promise<EnergyRunExplanation> {
  const scope = { tenantId: input.ctx.principal.tenantId, spaceId: input.ctx.allowedResources.spaceId }
  const gaps = new Set<string>()
  const sourceEvidenceRef = input.detail.sourceEvidenceRef
  const resultRef = input.detail.resultRef
  const selectedPlanRef = input.detail.selectedPlanRef
  const scenarioRevision = Number(input.scenarioInput.assumptions.find((item) => item.startsWith('state_revision='))?.slice('state_revision='.length) ?? 'NaN')
  const scenarioStateRefText = input.scenarioInput.assumptions.find((item) => item.startsWith('state_ref='))?.slice('state_ref='.length)
  let scenarioStateRefDigest: string | undefined
  if (scenarioStateRefText !== undefined) {
    try { scenarioStateRefDigest = (JSON.parse(scenarioStateRefText) as ResourceRef).digest } catch { gaps.add('SCENARIO_STATE_REF_INVALID') }
  }
  if (input.detail.runId !== input.runId || input.detail.inputManifestHash !== input.scenarioInput.snapshot.digest || input.detail.weatherScenario !== input.scenarioInput.assumptions.find((item) => item.startsWith('weather_scenario='))?.slice('weather_scenario='.length) || !Number.isSafeInteger(scenarioRevision) || scenarioRevision !== input.detail.stateRevision || input.scenarioInput.battery.initialEnergyKwh === undefined || Math.abs(input.detail.initialEnergyKwh - input.scenarioInput.battery.initialEnergyKwh) > 1e-6 || input.detail.reserveWindowStartSlot !== (input.scenarioInput.reserves[0]?.windowStartSlot ?? 0) || Math.abs(input.detail.reserveSocPercent - ((input.scenarioInput.reserves[0]?.reserveEnergyKwh ?? 0) / (input.scenarioInput.battery.energyCapacityKwh ?? 1) * 100)) > 0.01 || (input.detail.stateRef?.digest ?? undefined) !== scenarioStateRefDigest) gaps.add('RUN_ARTIFACT_BINDING_MISMATCH')
  // `pending` is the store's entity lifecycle state even after a reviewer has asserted a
  // candidate to it; confirmation here is the open, unique identity assertion checked below.
  const entities = (await input.identity.listEntities(scope, { objectId: 'weather_forecast', limit: START_ENTITY_LIMIT }, input.ctx)).filter((entity) => entity.state !== 'retired')
  if (entities.length === START_ENTITY_LIMIT) gaps.add('WEATHER_ENTITY_SCAN_LIMIT')
  const startIds: string[] = []
  for (const entity of entities) {
    const assertions = await input.identity.listAssertions(scope, { entityId: entity.entityId, openOnly: true, limit: 2 }, input.ctx)
    if (assertions.length !== 1) continue
    const candidate = await input.candidates.getCandidate(scope, assertions[0]!.candidateId, input.ctx)
    if (validNativeId(candidate, 'weather_forecast', `weather:${input.scenarioRef.digest}`)) startIds.push(entity.entityId)
  }
  if (startIds.length !== 1) gaps.add(startIds.length === 0 ? 'CURRENT_WEATHER_INSTANCE_NOT_CONFIRMED' : 'CURRENT_WEATHER_INSTANCE_AMBIGUOUS')

  let instancePath: EnergyRunExplanation['instancePath'] = []
  let publicationRevision = await input.publications.latestPublicationRevision(scope, input.ctx)
  if (startIds.length === 1) {
    const navigator = new PublishedRelationNavigator({
      publications: input.publications, identity: input.identity, definitionRef: input.definitionRef,
      allowedRelationIds: ENERGY_EXPLANATION_RELATIONS,
    })
    const navigation = await navigator.navigate({ startEntityId: startIds[0]!, relationIds: ENERGY_EXPLANATION_RELATIONS, validAt: input.validAt, maxPaths: 8 }, input.ctx)
    publicationRevision = navigation.publicationRevision
    for (const gap of navigation.gaps) gaps.add(gap)
    if (navigation.completeness !== 'complete') gaps.add(`RELATION_PATH_${navigation.completeness.toUpperCase()}`)
    if (navigation.paths.length !== 1 || navigation.paths[0]?.hops.length !== 3) gaps.add(navigation.paths.length === 0 ? 'CONFIRMED_RELATION_PATH_MISSING' : 'CONFIRMED_RELATION_PATH_AMBIGUOUS')
    const path = navigation.paths.length === 1 ? navigation.paths[0] : undefined
    if (path?.hops.length === 3) {
      const expectedNodes = [
        { objectId: 'weather_forecast', nativeId: `weather:${input.scenarioRef.digest}` },
        { objectId: 'solar_forecast', nativeId: `solar:${resultRef.digest}` },
        { objectId: 'energy_plan', nativeId: `plan:${selectedPlanRef.id}@${selectedPlanRef.version}:${selectedPlanRef.digest}` },
        { objectId: 'device', nativeId: 'device:virtual-solix-1' },
      ] as const
      let nodesValid = true
      for (let index = 0; index < path.hops.length; index += 1) {
        const hop = path.hops[index]!
        const edgeCandidate = await input.candidates.getCandidate(scope, hop.statementId, input.ctx)
        if (edgeCandidate?.kind !== 'relation' || edgeCandidate.relationId !== ENERGY_EXPLANATION_RELATIONS[index] || !sameVersion(edgeCandidate.inputVersion.definitionRef, input.definitionRef) || edgeCandidate.sourceSpans.length === 0 || hop.sourceRefs.length === 0) {
          gaps.add('RELATION_CANDIDATE_UNGROUNDED')
          nodesValid = false
          continue
        }
        const fromCandidateId = edgeCandidate.from.candidateId
        const toCandidateId = edgeCandidate.to.candidateId
        if (fromCandidateId === undefined || toCandidateId === undefined || fromCandidateId !== hop.fromCandidateId || toCandidateId !== hop.toCandidateId) {
          gaps.add('RELATION_ENDPOINT_CANDIDATE_MISMATCH')
          nodesValid = false
          continue
        }
        const [fromCandidate, toCandidate] = await Promise.all([
          input.candidates.getCandidate(scope, fromCandidateId, input.ctx),
          input.candidates.getCandidate(scope, toCandidateId, input.ctx),
        ])
        const fromExpected = expectedNodes[index]!
        const toExpected = expectedNodes[index + 1]!
        if (!validNativeId(fromCandidate, fromExpected.objectId, fromExpected.nativeId) || !validNativeId(toCandidate, toExpected.objectId, toExpected.nativeId)) {
          gaps.add('RUN_INSTANCE_IDENTITY_MISMATCH')
          nodesValid = false
        }
      }
      if (nodesValid) instancePath = path.hops.map((hop) => ({
        relationId: hop.relationId, statementId: hop.statementId, statementVersion: hop.statementVersion,
        fromEntityId: hop.fromEntityId, toEntityId: hop.toEntityId, sourceRefs: hop.sourceRefs,
      }))
    }
  }
  if (input.detail.intervals.length === 0 || input.detail.intervals[0] === undefined || input.detail.intervals.at(-1) === undefined) gaps.add('PLAN_TRAJECTORY_MISSING')
  const refsValid = input.scenarioRef.kind === 'artifact' && sourceEvidenceRef.kind === 'evidence' && resultRef.kind === 'artifact' && selectedPlanRef.kind === 'plan'
  if (!refsValid) gaps.add('RUN_EVIDENCE_REFERENCE_INVALID')
  const forecastPvKwh = input.detail.intervals.reduce((sum, slot) => sum + slot.pvAvailableKw * input.detail.slotMinutes / 60, 0)
  const first = input.detail.intervals[0]
  const last = input.detail.intervals.at(-1)
  const gapsList = [...gaps].sort()
  return {
    status: gapsList.length === 0 && instancePath.length === ENERGY_EXPLANATION_RELATIONS.length ? 'verified' : 'limited',
    runId: input.runId,
    definition: { ref: input.definitionRef, declaredRelations: ENERGY_EXPLANATION_RELATIONS },
    instancePath,
    runEvidence: {
      scenarioRef: input.scenarioRef, sourceEvidenceRef, resultRef, selectedPlanRef,
      inputManifestHash: input.detail.inputManifestHash, weatherScenario: input.detail.weatherScenario,
      reserveSocPercent: input.detail.reserveSocPercent, reserveWindowStartSlot: input.detail.reserveWindowStartSlot,
      reserveMargins: input.detail.reserveMargins,
      stateRevision: input.detail.stateRevision,
      horizon: { startUtc: first?.startUtc ?? input.validAt, endUtc: last?.endUtc ?? input.validAt },
      forecastPvKwh, candidateTotalCost: input.detail.candidateTotalCost, reserveSatisfied: input.detail.reserveSatisfied,
    },
    publicationRevision,
    gaps: gapsList,
  }
}
