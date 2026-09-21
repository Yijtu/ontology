import type {
  ComponentManifest,
  PlanSpec,
  ResourceRef,
  ToolContext,
  ToolResultStatus,
} from '@ontology/contracts'

/**
 * A published template plan: the public `planRef` handle plus its already-registered
 * `PlanSpec`. Publication is what makes the plan trustworthy input; the runtime still
 * re-validates the structure (unique ids, known dependencies, no cycle) before executing
 * it (D7.1).
 */
export interface PublishedPlan {
  readonly planRef: ResourceRef
  readonly spec: PlanSpec
}

/**
 * Host-injected plan source. This is the *only* way the runtime obtains a plan, so the
 * runtime itself never opens a registry, database, blob store or filesystem. It is a
 * construction-time capability of the composition root, not a model-serializable value.
 */
export interface TemplatePlanResolver {
  resolve(planRef: ResourceRef | undefined, ctx: ToolContext): Promise<PublishedPlan>
}

export interface TemplateRuntimeConfig {
  readonly manifest: ComponentManifest
  readonly plans: TemplatePlanResolver
  readonly now?: () => string
  readonly newId?: () => string
}

/**
 * The bounded predecessor output the runtime may bind against. It deliberately carries
 * only what the gateway already returned: the capped inline payload, the evidence refs
 * and the execution status. No store, blob handle or driver is reachable from it.
 */
export interface StepOutput {
  readonly stepId: string
  readonly inlineData: unknown
  readonly evidenceRefs: readonly ResourceRef[]
  readonly status: ToolResultStatus
}
