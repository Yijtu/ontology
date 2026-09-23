import type {
  CancelRequest,
  CancelResponse,
  SourceObjectRef,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryPort,
  StructuredQueryValidateRequest,
  StructuredQueryValidateResponse,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type { SemanticMapping, SemanticMappingRegistry } from '@ontology/semantic-engine'

export interface RegisteredQueryPortBinding {
  readonly adapter: StructuredQueryPort
  readonly mappingRefs: readonly VersionRef[]
  /** Exact, deployment-owned physical objects accepted by direct queries. */
  readonly objects: readonly SourceObjectRef[]
}

function sameRef(left: { readonly id: string; readonly version: string; readonly digest: string }, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sameObject(left: SourceObjectRef, right: SourceObjectRef): boolean {
  return left.sourceRef.namespace === right.sourceRef.namespace &&
    left.sourceRef.sourceId === right.sourceRef.sourceId && left.objectPath === right.objectPath
}

function activeTargetsOf(adapter: StructuredQueryPort): readonly string[] {
  const method: unknown = Reflect.get(adapter, 'activeTargets')
  if (typeof method !== 'function') return []
  const result: unknown = Reflect.apply(method, adapter, [])
  return Array.isArray(result) ? result.filter((value): value is string => typeof value === 'string') : []
}

/**
 * Multiplexes only over deployment-registered mapping refs or exact physical object refs.
 * Semantic plans pin an exact mapping digest; direct plans must name only objects that belong
 * to one adapter binding. A mixed-source plan is rejected instead of routing by first object.
 */
export class ProfileQueryPort implements StructuredQueryPort {
  readonly #bindings: readonly RegisteredQueryPortBinding[]
  readonly #mappings: SemanticMappingRegistry

  constructor(bindings: readonly RegisteredQueryPortBinding[], mappings: SemanticMappingRegistry) {
    this.#bindings = bindings
    this.#mappings = mappings
  }

  async validate(request: StructuredQueryValidateRequest, ctx: ToolContext): Promise<StructuredQueryValidateResponse> {
    const adapter = this.#resolve(request.plan)
    if (adapter === undefined) return { valid: false, warnings: [], rejectedReason: { code: 'UNSUPPORTED_QUERY', message: 'the query plan is not bound to one registered source and mapping', retryable: false } }
    return adapter.validate(request, ctx)
  }

  async execute(request: StructuredQueryExecuteRequest, ctx: ToolContext): Promise<StructuredQueryExecuteResponse> {
    const adapter = this.#resolve(request.plan)
    if (adapter === undefined) throw new Error('the query plan is not bound to one registered source and mapping')
    return adapter.execute(request, ctx)
  }

  activeTargets(): readonly string[] {
    return this.#bindings.flatMap((binding) => activeTargetsOf(binding.adapter))
  }

  async cancel(request: CancelRequest, ctx: ToolContext): Promise<CancelResponse> {
    const matching = this.#bindings.filter((binding) => activeTargetsOf(binding.adapter).includes(request.targetRef))
    const adapter = matching.length === 1 ? matching[0]?.adapter : undefined
    return adapter === undefined
      ? { targetRef: request.targetRef, state: 'unsupported', acceptedAt: new Date().toISOString() }
      : adapter.cancel(request, ctx)
  }

  #resolve(plan: StructuredQueryValidateRequest['plan']): StructuredQueryPort | undefined {
    if (plan.mode === 'semantic') {
      const mapping: SemanticMapping | undefined = this.#mappings.resolve(plan.mappingVersion)
      if (mapping === undefined) return undefined
      const matching = this.#bindings.filter((binding) =>
        binding.mappingRefs.some((ref) => sameRef(ref, plan.mappingVersion)) &&
        mapping.objects.length > 0 && mapping.objects.every((mapped) => binding.objects.some((object) => sameObject(object, mapped.sourceObjectRef))),
      )
      return matching.length === 1 ? matching[0]?.adapter : undefined
    }
    const refs = plan.referencedObjects
    if (refs.length === 0) return undefined
    const matching = this.#bindings.filter((binding) => refs.every((ref) => binding.objects.some((object) => sameObject(object, ref))))
    return matching.length === 1 ? matching[0]?.adapter : undefined
  }
}
