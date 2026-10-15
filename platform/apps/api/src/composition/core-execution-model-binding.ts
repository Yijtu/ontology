import { CompanyGenerationAdapter } from '@ontology/adapter-model-company'
import type {
  CompanyModelProtocol,
  ModelCallEvidenceRecorder,
  ResponseSchemaValidator,
} from '@ontology/adapter-model-company'
import { JevDecisionAdapter } from '@ontology/adapter-model-jev'
import type {
  DecisionEvidenceRecorder,
  GenerativeClassificationFallback,
  JevActualStateResolver,
  JevFallbackPolicy,
} from '@ontology/adapter-model-jev'
import { ModelSelectionError, SecretValue } from '@ontology/contracts'
import type {
  BudgetLedgerPort,
  ComponentVersionRecord,
  DecisionPort,
  ExecutionModelBinding,
  ExecutionModelBindingStore,
  GenerationPort,
  ModelCapability,
  ModelConnectionAdminView,
  ModelConnectionStore,
  ModelCredentialCustodian,
  ModelTargetScope,
  ScopeRef,
  SecretResolver,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { ExecutionModelBindingService, ModelSelectionService, RunModelBinder } from '@ontology/application'
import { canonicalJson, sha256DigestOf } from '@ontology/core'
import { componentRecord } from './core-component-registration'

/**
 * Execution model binding wire-up (design §5.3).
 *
 * A run/execution fixes an `ExecutionModelBinding` (connection id + revision + component ref). This
 * module turns that immutable pin into the actual `GenerationPort`/`DecisionPort` of *that*
 * execution by resolving the pinned connection's config and custody credential — never by reading
 * today's space default. The two ports stay separate; the binding's `componentRef` is computed the
 * same way a registered model component is, so component registration and execution binding agree.
 */

const CONNECTION_SECRET_PREFIX = 'model-connection:'

/** The opaque, server-only secret ref a catalogue-bound adapter resolves through the custodian. */
export function modelConnectionSecretRef(connectionId: Uuid): string {
  return `${CONNECTION_SECRET_PREFIX}${connectionId}`
}

/**
 * A `SecretResolver` that resolves the credential of the pinned connection through credential
 * custody. It reads the connection's opaque credential reference from the catalogue and never puts
 * a value (or a reference) into an entity, a log or a wire payload.
 */
export function createCatalogueModelSecretResolver(input: {
  readonly connections: ModelConnectionStore
  readonly credentials: ModelCredentialCustodian
  readonly scopeRef: ScopeRef
}): SecretResolver {
  return {
    async resolve(secretRef: string, ctx: ToolContext): Promise<SecretValue> {
      if (typeof secretRef !== 'string' || !secretRef.startsWith(CONNECTION_SECRET_PREFIX)) {
        throw new ModelSelectionError('CREDENTIAL_MISSING', 'a catalogue model secretRef must name a connection')
      }
      const connectionId = secretRef.slice(CONNECTION_SECRET_PREFIX.length)
      const ref = await input.connections.getCredentialRef(input.scopeRef, connectionId, ctx)
      if (ref === undefined) {
        throw new ModelSelectionError('CREDENTIAL_MISSING', 'the pinned model connection has no credential')
      }
      return input.credentials.resolve(input.scopeRef, ref, ctx)
    },
  }
}

/**
 * The component version ref for a catalogue connection. It is byte-identical to the ref
 * `ExecutionModelBindingService` records, so a binding's component identity and the deployment's
 * component registration can be compared exactly.
 */
export function modelConnectionComponentRef(
  connection: Pick<ModelConnectionAdminView, 'connectionId' | 'revision'>,
): VersionRef {
  return {
    id: `model-connection:${connection.connectionId}`,
    version: `${connection.revision}.0.0`,
    digest: sha256DigestOf(canonicalJson({ connectionId: connection.connectionId, revision: connection.revision })),
  }
}

/** Catalogue connections as registerable component records, so registration matches bindings. */
export function catalogueModelComponentRecords(
  connections: readonly ModelConnectionAdminView[],
  now: string,
): ComponentVersionRecord[] {
  return connections.flatMap((connection): ComponentVersionRecord[] => {
    if (connection.adapterType === 'jev') {
      return [componentRecord({ kind: 'decision', ref: modelConnectionComponentRef(connection), capabilityNames: ['model.decision'], entrypoint: '@ontology/adapter-model-jev', now })]
    }
    return [componentRecord({ kind: 'generation', ref: modelConnectionComponentRef(connection), capabilityNames: ['model.generation'], entrypoint: '@ontology/adapter-model-company', now })]
  })
}

export interface ExecutionModelCapabilityDependencies {
  readonly budget: BudgetLedgerPort
  readonly generationEvidence?: ModelCallEvidenceRecorder
  readonly decisionEvidence?: DecisionEvidenceRecorder
  readonly decisionStateResolver?: JevActualStateResolver
  readonly schemaValidator?: ResponseSchemaValidator
  readonly generativeClassification?: GenerativeClassificationFallback
  /** JEV keeps its existing execution behaviour policy; the catalogue never edits it. */
  readonly jevFallbackPolicy: JevFallbackPolicy
  readonly fetchImpl?: typeof fetch
}

export interface ExecutionModelCapabilityContext {
  /** The already-opened run or background-job ledger. Binding an adapter never opens one. */
  readonly ledgerId: Uuid
  /** The controller/worker signal for this execution, used by every adapter attempt. */
  readonly signal: AbortSignal
}

/**
 * Build the per-execution generation/decision adapters from one fixed binding plus its pinned
 * connection. The returned ports are separate: a JEV connection only ever yields a `DecisionPort`
 * and a generation connection only ever yields a `GenerationPort`.
 */
export function createExecutionModelCapabilities(input: {
  readonly binding: ExecutionModelBinding
  readonly connection: ModelConnectionAdminView
  readonly dependencies: ExecutionModelCapabilityDependencies
  /** Resolves the pinned connection's credential through custody; never a value or reference. */
  readonly secrets: SecretResolver
  readonly context: ExecutionModelCapabilityContext
}): { readonly generation?: GenerationPort; readonly decision?: DecisionPort } {
  const { binding, connection, dependencies, secrets, context } = input
  if (binding.connectionId === undefined || binding.connectionId !== connection.connectionId) {
    throw new ModelSelectionError('MODEL_BINDING_REVOKED', 'the execution binding does not name this connection')
  }
  const models = { [connection.platformModelId]: { vendorModel: connection.providerModelName } }
  if (connection.adapterType === 'company_generation' && (binding.capability === 'generation' || binding.capability === 'research')) {
    const protocol: CompanyModelProtocol = connection.protocol === 'private' ? 'private' : 'openai-compatible'
    const generation = new CompanyGenerationAdapter({
      baseUrl: requiredBaseUrl(connection),
      ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
      protocol,
      secretRef: modelConnectionSecretRef(connection.connectionId),
      models,
      secrets,
      budget: dependencies.budget,
      ledgerId: context.ledgerId,
      evidence: dependencies.generationEvidence ?? missingGenerationEvidence(),
      ...(dependencies.schemaValidator === undefined ? {} : { schemaValidator: dependencies.schemaValidator }),
      signal: context.signal,
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    })
    return { generation }
  }
  if (connection.adapterType === 'jev' && binding.capability === 'decision_jev') {
    const decision = new JevDecisionAdapter({
      baseUrl: requiredBaseUrl(connection),
      ...(connection.endpoint === undefined ? {} : { endpoint: connection.endpoint }),
      secretRef: modelConnectionSecretRef(connection.connectionId),
      models: { [connection.platformModelId]: { vendorModel: connection.providerModelName, fallbackPolicy: dependencies.jevFallbackPolicy } },
      ...(dependencies.decisionStateResolver === undefined ? {} : { stateResolver: dependencies.decisionStateResolver }),
      fallbackPolicy: dependencies.jevFallbackPolicy,
      secrets,
      budget: dependencies.budget,
      ledgerId: context.ledgerId,
      evidence: dependencies.decisionEvidence ?? missingDecisionEvidence(),
      ...(dependencies.generativeClassification === undefined ? {} : { generativeClassification: dependencies.generativeClassification }),
      signal: context.signal,
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
    })
    return { decision }
  }
  throw new ModelSelectionError('MODEL_CAPABILITY_MISMATCH', `the pinned connection cannot serve ${binding.capability}`)
}

export interface ExecutionModelCapabilities {
  readonly generation?: GenerationPort
  /** True when a generation binding exists but is revoked/disabled: the port must fail closed. */
  readonly generationBlocked: boolean
  readonly decision?: DecisionPort
  readonly decisionBlocked: boolean
}

/**
 * The per-execution capability provider the runtime consults. It reads the persisted binding (never
 * re-resolves a default), enforces the revocation fence and fails closed: a binding whose connection
 * was disabled or cleared yields `blocked`, which makes the runtime disable the port rather than
 * fall through to another model (design §5.3/§5.5).
 */
export function createExecutionModelBindingRuntime(input: {
  readonly scopeRef: ScopeRef
  readonly bindings: ExecutionModelBindingStore
  readonly connections: ModelConnectionStore
  readonly credentials: ModelCredentialCustodian
  readonly isUsable: (executionId: Uuid, capability: ModelCapability, ctx: ToolContext) => Promise<boolean>
  readonly capabilityDependencies: ExecutionModelCapabilityDependencies
}) {
  type Resolution<T> =
    | { readonly kind: 'absent' }
    | { readonly kind: 'blocked' }
    | { readonly kind: 'ready'; readonly port: T }

  const capabilitiesFor = async <T extends GenerationPort | DecisionPort>(
    capability: ModelCapability,
    executionId: Uuid,
    context: ExecutionModelCapabilityContext,
    ctx: ToolContext,
  ): Promise<Resolution<T>> => {
    const binding = await input.bindings.getBinding(input.scopeRef, executionId, capability, ctx)
    if (binding === undefined) return { kind: 'absent' }
    if (!(await input.isUsable(executionId, capability, ctx))) return { kind: 'blocked' }
    if (binding.connectionId === undefined) return { kind: 'blocked' }
    const connection = await input.connections.getConnection(input.scopeRef, binding.connectionId, ctx)
    if (connection === undefined) return { kind: 'blocked' }
    const secrets = createCatalogueModelSecretResolver({ connections: input.connections, credentials: input.credentials, scopeRef: input.scopeRef })
    const built = createExecutionModelCapabilities({ binding, connection, dependencies: input.capabilityDependencies, secrets, context })
    const port = capability === 'decision_jev' ? built.decision : built.generation
    return port === undefined ? { kind: 'blocked' } : { kind: 'ready', port: port as T }
  }

  return {
    async capabilitiesForExecution(request: {
      readonly executionId: Uuid
      readonly ledgerId: Uuid
      readonly signal: AbortSignal
      readonly ctx: ToolContext
    }): Promise<ExecutionModelCapabilities> {
      const context: ExecutionModelCapabilityContext = { ledgerId: request.ledgerId, signal: request.signal }
      const generation = await capabilitiesFor<GenerationPort>('generation', request.executionId, context, request.ctx)
      const decision = await capabilitiesFor<DecisionPort>('decision_jev', request.executionId, context, request.ctx)
      return {
        ...(generation.kind === 'ready' ? { generation: generation.port } : {}),
        generationBlocked: generation.kind === 'blocked',
        ...(decision.kind === 'ready' ? { decision: decision.port } : {}),
        decisionBlocked: decision.kind === 'blocked',
      }
    },
  }
}

function requiredBaseUrl(connection: ModelConnectionAdminView): string {
  if (connection.baseUrl === undefined || connection.baseUrl.length === 0) {
    throw new ModelSelectionError('MODEL_NOT_CONFIGURED', 'the pinned model connection has no base URL')
  }
  return connection.baseUrl
}

function missingGenerationEvidence(): ModelCallEvidenceRecorder {
  throw new ModelSelectionError('MODEL_NOT_CONFIGURED', 'a generation evidence recorder is required to bind a generation model')
}

function missingDecisionEvidence(): DecisionEvidenceRecorder {
  throw new ModelSelectionError('MODEL_NOT_CONFIGURED', 'a decision evidence recorder is required to bind a JEV model')
}

/**
 * The run-acceptance binder (design §5.3). Before a job is dispatched it resolves the run's target
 * scope from the *catalogue* and fixes each available capability. A capability with no usable
 * catalogue selection leaves no binding, so a deterministic execution (structured import, manual
 * review, history read-back, registered compute) still starts on a host with no model configured.
 * The resolution+bind runs under a host-minted server context, so a business user's roles never
 * decide which model is selected.
 */
export function createRunModelBinder(input: {
  readonly selection: ModelSelectionService
  readonly bindings: ExecutionModelBindingService
  readonly serverContext: (runId: Uuid) => ToolContext
}): RunModelBinder {
  const CAPABILITIES: readonly ModelCapability[] = ['generation', 'decision_jev']
  return {
    async bindModelForRun(request, scopeRef, ctx) {
      // The caller's roles never decide the selection: the binding always runs under a host-minted
      // server context. `ctx` is accepted only to satisfy the injected port signature.
      void ctx
      const serverCtx = input.serverContext(request.runId)
      const scope: ModelTargetScope = request.execution === undefined
        ? { kind: 'space' }
        : { kind: 'project', projectId: request.execution.projectRevisionRef.projectId }
      let generationBinding: ExecutionModelBinding | undefined
      for (const capability of CAPABILITIES) {
        const effective = await input.selection.resolve(scopeRef, { scope, capability }, serverCtx)
        if (effective.state !== 'available') continue
        const binding = await input.bindings.ensureBinding({ executionId: request.runId, scope, capability }, serverCtx)
        if (capability === 'generation') generationBinding = binding
      }
      return generationBinding
    },
  }
}

