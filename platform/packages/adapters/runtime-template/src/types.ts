import type {
  ComponentManifest,
  PlanSpec,
  PlanClarification,
  ResourceRef,
  ResumeInput,
  RuntimeDependencies,
  RuntimeInput,
  ToolContext,
  ToolResultStatus,
  Uuid,
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
  /**
   * New host seam for one run-bound route preparation. The runtime supplies the full input
   * and its real capabilities so a resolver can use the exact question, cancellation signal,
   * and already-bound shared-ledger model ports. Existing resolvers may keep using `resolve`.
   */
  prepare?(request: TemplatePlanPreparationRequest): Promise<TemplatePlanPreparation>
}

export interface TemplatePlanPreparationRequest {
  readonly mode: 'start' | 'resume'
  readonly input: RuntimeInput | ResumeInput
  /** The exact ref requested by RuntimeInput or decoded from its private checkpoint. */
  readonly planRef?: ResourceRef
  readonly dependencies: RuntimeDependencies
}

export type TemplatePlanPreparation =
  | {
      readonly kind: 'plan'
      readonly published: PublishedPlan
      /** Required to prove that a supplied checkpoint/ref was loaded before preparing a result. */
      readonly sourceReceiptRef?: ResourceRef
    }
  | {
      readonly kind: 'clarification'
      /** An immutable route receipt that a future resume can resolve without re-planning blindly. */
      readonly receiptRef: ResourceRef
      /** Stable across an idempotent route retry so the response binds to this receipt. */
      readonly clarificationId: Uuid
      readonly clarification: PlanClarification
      readonly fallback?: string
      /** Required when this clarification was derived from a prior receipt. */
      readonly sourceReceiptRef?: ResourceRef
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
