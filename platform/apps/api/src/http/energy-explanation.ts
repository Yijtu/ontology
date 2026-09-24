import type { FastifyInstance } from 'fastify'
import type { CandidateStore, IdentityDecisionStore, ResourceRef, SemanticPublicationStore, ToolContext, VersionRef } from '@ontology/contracts'
import { createRequestToolContext } from './context'
import { authenticateRequest, InvalidRequestFieldError, isRecord, readTraceId } from './shared'
import type { RequestAuthenticator } from './shared'
import type { EnergyOperationInput } from '@ontology/extension-home-energy'
import type { LocalPlanDetail } from './local-plan-detail'
import { explainEnergyRun } from '../composition/energy-run-explanation'

export interface EnergyExplanationRun {
  readonly state: string
  readonly profileRef: { readonly id: string; readonly version: string }
  readonly context: { readonly taskId?: unknown; readonly taskInput?: unknown }
}

function readScenarioRef(taskInput: unknown): ResourceRef {
  if (!isRecord(taskInput) || typeof taskInput['scenarioRef'] !== 'string') throw new InvalidRequestFieldError('the published energy run has no scenario artifact reference')
  let value: unknown
  try { value = JSON.parse(taskInput['scenarioRef']) as unknown } catch { throw new InvalidRequestFieldError('the published energy run scenario reference is invalid') }
  if (!isRecord(value) || typeof value['id'] !== 'string' || typeof value['version'] !== 'string' || typeof value['digest'] !== 'string' || value['kind'] !== 'artifact') throw new InvalidRequestFieldError('the published energy run scenario reference is invalid')
  return { id: value['id'], version: value['version'], digest: value['digest'], kind: 'artifact' }
}

export function registerEnergyExplanationRoute(app: FastifyInstance, options: {
  readonly authenticate: RequestAuthenticator
  readonly getRun: (runId: string, ctx: ToolContext) => Promise<EnergyExplanationRun>
  readonly getPlanDetail: (runId: string, ctx: ToolContext) => Promise<LocalPlanDetail>
  readonly readScenario: (ref: ResourceRef, ctx: ToolContext) => Promise<EnergyOperationInput>
  readonly definitionRef: VersionRef
  readonly publications: SemanticPublicationStore
  readonly identity: IdentityDecisionStore
  readonly candidates: CandidateStore
}): void {
  app.get<{ Params: { runId: string } }>('/api/v1/runs/:runId/energy-explanation', async (request, reply) => {
    const traceId = readTraceId(request)
    const auth = authenticateRequest(options.authenticate, request, reply)
    if (auth === undefined) return reply
    const runId = request.params.runId
    const ctx = createRequestToolContext({ principal: auth.principal, spaceId: auth.spaceId, traceId, runId, allowedResourceKinds: ['artifact', 'dataset', 'evidence', 'plan'] })
    const run = await options.getRun(runId, ctx)
    if (run.state !== 'published' || run.context.taskId !== 'energy.plan-candidate' || !['home-energy-demo', 'home-energy-demo-wide', 'home-energy-demo-long'].includes(run.profileRef.id)) {
      reply.status(409).send({ error: { code: 'ENERGY_EXPLANATION_RUN_UNAVAILABLE', message: 'A4 explanation requires a published local energy planning run' }, traceId })
      return reply
    }
    const scenarioRef = readScenarioRef(run.context.taskInput)
    const [detail, scenario] = await Promise.all([options.getPlanDetail(runId, ctx), options.readScenario(scenarioRef, ctx)])
    const explanation = await explainEnergyRun({
      runId, scenarioRef, scenarioInput: scenario, detail,
      definitionRef: options.definitionRef, publications: options.publications,
      identity: options.identity, candidates: options.candidates, ctx,
      validAt: detail.intervals[0]?.startUtc ?? 'invalid',
    })
    reply.status(200).send({ data: explanation, meta: { traceId } })
    return reply
  })
}
