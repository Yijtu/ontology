import type {
  ResearchExecutionAny,
  ResearchRequest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { ResearchContinuationLinkage, ResearchRunView } from './research-workflow-service'

/**
 * The research run entry the HTTP async surface (`POST .../research-runs` and its read/cancel/
 * resume/continuation siblings) is written against (design §10, S10).
 *
 * It is the small, structural API of the durable research lifecycle. The legacy fixed-chain facade
 * (`ResearchWorkflowService`) implements it directly; the agentic entry (`AgentResearchRunEntry`)
 * implements the same shape but routes **newly-accepted** requests to the V2 workspace-research run
 * (design §4/§8) while a replay of an already-accepted request keeps the engine it was accepted
 * under. Keeping this as an interface means the HTTP surface never branches on the engine.
 */
export interface ResearchRunEntry {
  /** `false` when no research engine is wired: reads still work, but a new run cannot start. */
  readonly executionAvailable: boolean
  start(request: ResearchRequest, ctx: ToolContext, linkage?: ResearchContinuationLinkage): Promise<ResearchExecutionAny>
  get(researchId: Uuid, ctx: ToolContext): Promise<ResearchRunView>
  cancel(researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny>
  resume(researchId: Uuid, ctx: ToolContext): Promise<ResearchExecutionAny>
  continuations(previousResearchId: Uuid, request: ResearchRequest, ctx: ToolContext): Promise<ResearchExecutionAny>
}
