import type {
  ModelRef,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { SecretValue } from './source-bindings'
import type { ToolContext } from './trusted'
import { isRecord, isRevisionString, isUuid, isVersionRef } from './asset-workspace'

/**
 * AI settings: the model-connection catalogue, per-capability/per-object assignment and the
 * per-execution binding (design §5.3).
 *
 * Three things are deliberately split: **configuring a connection**, **assigning a connection to
 * a capability/object** and **binding the resolved connection to one execution**. Nothing here
 * ever carries an API key: a credential is referenced by an opaque `ResourceRef` the host's
 * secret custodian resolves, so no plaintext secret can enter a domain entity, a model-call
 * contract, an event or a job payload (A-R09).
 *
 * `GenerationPort` and `DecisionPort` are never merged. A research run reuses `GenerationPort`
 * with an explicit purpose supplied by the calling entry; a model output can never select its own
 * connection. JEV keeps its own adapter/protocol and its existing execution behaviour policy.
 */

/** Closed, versioned capability set. Extend by adding a value, never by overloading one. */
export type ModelCapability = 'generation' | 'research' | 'decision_jev'
export const MODEL_CAPABILITIES: readonly ModelCapability[] = ['generation', 'research', 'decision_jev']

/** The registered adapter family; distinct from the wire protocol it speaks. */
export type ModelAdapterType = 'company_generation' | 'jev'
/** The wire protocol; a generation adapter may use either of the first two, JEV uses its own. */
export type ModelProtocol = 'openai_compatible' | 'private' | 'jev'
export const MODEL_PROTOCOLS: readonly ModelProtocol[] = ['openai_compatible', 'private', 'jev']

export type ModelCredentialState = 'present' | 'missing' | 'revoked'

/**
 * A model target is a discriminated union: the whole space, one industry workspace, or one
 * project. A project never inherits the model settings of the workspace that produced the pack it
 * mounts (A-R10).
 */
export type ModelTargetScope =
  | { readonly kind: 'space' }
  | { readonly kind: 'industry_workspace'; readonly workspaceId: Uuid }
  | { readonly kind: 'project'; readonly projectId: Uuid }

export type ModelConnectionTestStatus = 'passed' | 'failed'
export type ModelConnectionTestReason =
  | 'authentication_failed'
  | 'timeout'
  | 'rate_limited'
  | 'protocol_mismatch'
  | 'unreachable'
  | 'invalid_response'

export interface ModelConnectionTestSummary {
  readonly revision: RevisionString
  readonly status: ModelConnectionTestStatus
  readonly testedAt: Rfc3339UtcTimestamp
  readonly reason?: ModelConnectionTestReason
}

/** Non-secret connection metadata safe to expose wherever a model must be named. */
export interface ModelConnectionSummary {
  readonly connectionId: Uuid
  readonly name: string
  readonly revision: RevisionString
  readonly adapterType: ModelAdapterType
  readonly protocol: ModelProtocol
  readonly capabilities: readonly ModelCapability[]
  readonly enabled: boolean
  readonly credentialState: ModelCredentialState
  readonly testSummary?: ModelConnectionTestSummary
  readonly updatedAt: Rfc3339UtcTimestamp
}

/** The administrator connection view: adds address/endpoint/provider model name, still no secret value. */
export interface ModelConnectionAdminView extends ModelConnectionSummary {
  readonly baseUrl?: string
  readonly endpoint?: string
  readonly platformModelId: string
  /** The provider's own model name; the vendor wire vocabulary itself stays in the adapter. */
  readonly providerModelName: string
}

/** A create/edit descriptor. It never carries a credential; that is a separate write. */
export interface ModelConnectionDescriptor {
  readonly name: string
  readonly adapterType: ModelAdapterType
  readonly protocol: ModelProtocol
  readonly capabilities: readonly ModelCapability[]
  readonly enabled: boolean
  readonly baseUrl?: string
  readonly endpoint?: string
  readonly platformModelId: string
  readonly providerModelName: string
}

/** An opaque credential reference; the host resolves it and never returns the value. */
export interface ModelConnectionCredentialChangeSet {
  readonly action: 'set'
  readonly credentialRef: ResourceRef
}
export interface ModelConnectionCredentialChangeClear {
  readonly action: 'clear'
}
export type ModelConnectionCredentialChange =
  | ModelConnectionCredentialChangeSet
  | ModelConnectionCredentialChangeClear

/** A per-capability selection: inherit the next layer, terminate resolution, or name a connection. */
export type ModelConnectionSelection =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'connection'; readonly connectionId: Uuid }

export interface ModelCapabilitySelection {
  readonly capability: ModelCapability
  readonly selection: ModelConnectionSelection
}

/** The assignment set for one target scope: a default plus per-capability overrides, versioned. */
export interface ModelAssignmentSet {
  readonly schemaVersion: 'model-assignment-set@1'
  readonly scope: ModelTargetScope
  readonly defaultSelection: ModelConnectionSelection
  readonly capabilitySelections: readonly ModelCapabilitySelection[]
  readonly revision: RevisionString
  readonly updatedAt: Rfc3339UtcTimestamp
}

/** Where the effective selection was resolved from, in the fixed resolution order. */
export type ModelSelectionSource =
  | 'object_capability'
  | 'object_default'
  | 'space_capability'
  | 'space_default'
  | 'unconfigured'

/** The fixed resolution order (A-R10): object capability → object default → space capability → space default. */
export const MODEL_SELECTION_RESOLUTION_ORDER: readonly ModelSelectionSource[] = [
  'object_capability',
  'object_default',
  'space_capability',
  'space_default',
]

export type EffectiveModelState = 'available' | 'unconfigured' | 'disabled' | 'blocked'

/** Stable machine reason codes (design §5.3); cross-scope targets are invisible, not blocked. */
export type ModelSelectionReason =
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_DISABLED'
  | 'MODEL_CAPABILITY_MISMATCH'
  | 'CREDENTIAL_MISSING'
  | 'MODEL_IN_USE'
  | 'MODEL_BINDING_REVOKED'

export const MODEL_SELECTION_REASONS: readonly ModelSelectionReason[] = [
  'MODEL_NOT_CONFIGURED',
  'MODEL_DISABLED',
  'MODEL_CAPABILITY_MISMATCH',
  'CREDENTIAL_MISSING',
  'MODEL_IN_USE',
  'MODEL_BINDING_REVOKED',
]

/** The resolved, explainable selection for one capability/object. Never silently switches vendor. */
export interface EffectiveModelSelection {
  readonly schemaVersion: 'effective-model-selection@1'
  readonly scope: ModelTargetScope
  readonly capability: ModelCapability
  readonly selection: ModelConnectionSelection
  readonly resolvedFrom: ModelSelectionSource
  readonly state: EffectiveModelState
  readonly connectionId?: Uuid
  readonly connectionSummary?: ModelConnectionSummary
  /** The revision of the assignment set the selection was resolved from; pinned into a binding. */
  readonly assignmentRevision?: RevisionString
  readonly blockedReason?: ModelSelectionReason
  readonly resolvedAt: Rfc3339UtcTimestamp
}

/**
 * The non-secret execution config of a model connection: exactly what the generation/decision
 * adapter is built from. Both a live `ModelConnectionAdminView` and a pinned
 * `ModelExecutionConnectionSnapshot` satisfy it, so a runtime can build the adapter from either.
 */
export interface ModelExecutionConfig {
  readonly connectionId: Uuid
  readonly revision: RevisionString
  readonly adapterType: ModelAdapterType
  readonly protocol: ModelProtocol
  readonly capabilities: readonly ModelCapability[]
  readonly baseUrl?: string
  readonly endpoint?: string
  readonly platformModelId: string
  /** The provider's own model name; the vendor wire vocabulary itself stays in the adapter. */
  readonly providerModelName: string
}

/**
 * The immutable, non-secret execution-config snapshot of one model connection revision (design §5.3,
 * S02). It is written once at bind time and the binding references it, so changing today's catalogue
 * row (base URL, endpoint, protocol, provider model) can never retarget an in-flight execution. The
 * current catalogue is consulted only for the revoke/disable/permission fence. A snapshot carries no
 * credential — the key continues to resolve through custody, so rotation takes effect while a
 * cleared/revoked credential blocks through the fence.
 */
export interface ModelExecutionConnectionSnapshot extends ModelExecutionConfig {
  readonly schemaVersion: 'model-execution-connection-snapshot@1'
}

/** One execution's immutable model binding. A retry/resume/parallel run reuses it unchanged. */
export interface ExecutionModelBinding {
  readonly schemaVersion: 'execution-model-binding@1'
  readonly executionId: Uuid
  readonly capability: ModelCapability
  readonly connectionId?: Uuid
  readonly connectionRevision?: RevisionString
  readonly modelRef: ModelRef
  readonly componentRef: VersionRef
  /**
   * The immutable, non-secret snapshot this binding pins (S02). When present the runtime builds the
   * model from the snapshot rather than today's catalogue row. A binding created before snapshots
   * existed carries none and must be blocked rather than run on the current descriptor.
   */
  readonly snapshotRef?: VersionRef
  readonly assignmentRevision: RevisionString
  readonly resolvedFrom: ModelSelectionSource
  readonly boundAt: Rfc3339UtcTimestamp
}

/** The outcome of a connection probe. It reports a sanitized reason, never the provider body. */
export interface ModelConnectionTestResult {
  readonly schemaVersion: 'model-connection-test-result@1'
  readonly connectionId?: Uuid
  readonly connectionRevision?: RevisionString
  readonly status: ModelConnectionTestStatus
  readonly testedAt: Rfc3339UtcTimestamp
  readonly reason?: ModelConnectionTestReason
  readonly latencyMs?: number
  /** True when the probe tested an unsaved draft rather than a stored revision. */
  readonly draft: boolean
  readonly credentialConfigured: boolean
}

export type ModelSelectionErrorCode =
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_DISABLED'
  | 'MODEL_CAPABILITY_MISMATCH'
  | 'CREDENTIAL_MISSING'
  | 'MODEL_IN_USE'
  | 'MODEL_BINDING_REVOKED'
  | 'MODEL_BINDING_INCOMPLETE'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'SCOPE_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'STORE_FAILED'

const MODEL_SELECTION_HTTP_STATUS: Readonly<Record<ModelSelectionErrorCode, number>> = {
  MODEL_NOT_CONFIGURED: 409,
  MODEL_DISABLED: 409,
  MODEL_CAPABILITY_MISMATCH: 409,
  CREDENTIAL_MISSING: 409,
  MODEL_IN_USE: 409,
  MODEL_BINDING_REVOKED: 409,
  MODEL_BINDING_INCOMPLETE: 409,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  SCOPE_MISMATCH: 403,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_ARGUMENT: 400,
  STORE_FAILED: 500,
}

export class ModelSelectionError extends Error {
  readonly code: ModelSelectionErrorCode
  readonly httpStatus: number

  constructor(code: ModelSelectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ModelSelectionError'
    this.code = code
    this.httpStatus = MODEL_SELECTION_HTTP_STATUS[code]
  }
}

/**
 * Whether a registered adapter can serve a capability. It is decided by the adapter family (server
 * side), never by a user checkbox: a generation adapter cannot be selected for JEV, and JEV cannot
 * pretend to be a generation protocol.
 */
export function modelAdapterSupportsCapability(adapterType: ModelAdapterType, capability: ModelCapability): boolean {
  if (adapterType === 'jev') return capability === 'decision_jev'
  return capability === 'generation' || capability === 'research'
}

/** One probe outcome recorded against a stored connection revision. */
export interface ModelConnectionTestRecord {
  readonly connectionId: Uuid
  readonly revision: RevisionString
  readonly status: ModelConnectionTestStatus
  readonly testedAt: Rfc3339UtcTimestamp
  readonly reason?: ModelConnectionTestReason
  readonly latencyMs?: number
}

/** Control persistence for the connection catalogue. It stores metadata only, never a credential. */
export interface ModelConnectionStore {
  listConnections(
    scopeRef: ScopeRef,
    filter: { readonly enabled?: boolean; readonly capability?: ModelCapability; readonly limit?: number },
    ctx: ToolContext,
  ): Promise<readonly ModelConnectionAdminView[]>
  getConnection(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ModelConnectionAdminView | undefined>
  putConnection(
    scopeRef: ScopeRef,
    input: {
      readonly connectionId?: Uuid
      readonly descriptor: ModelConnectionDescriptor
      readonly expectedRevision?: RevisionString
      readonly idempotencyKey: string
    },
    ctx: ToolContext,
  ): Promise<ModelConnectionAdminView>
  deleteConnection(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void>
  /** Set or clear a credential by opaque reference; the value never crosses this port. */
  setCredential(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly change: ModelConnectionCredentialChange },
    ctx: ToolContext,
  ): Promise<ModelConnectionSummary>
  /**
   * The opaque credential reference for a connection, or `undefined` when it has none. The
   * reference is not a secret, but it is server-only: it lets the host resolve the value for a
   * probe without ever putting the value or the reference into a browser-facing view.
   */
  getCredentialRef(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ResourceRef | undefined>
  /** Record the latest probe summary on the connection; idempotent per connection revision. */
  recordTest(scopeRef: ScopeRef, record: ModelConnectionTestRecord, ctx: ToolContext): Promise<ModelConnectionSummary>
}

/** Control persistence for assignment sets; `putAssignmentSet` enforces default uniqueness. */
export interface ModelAssignmentStore {
  getAssignmentSet(scopeRef: ScopeRef, scope: ModelTargetScope, ctx: ToolContext): Promise<ModelAssignmentSet | undefined>
  listAssignmentSets(scopeRef: ScopeRef, ctx: ToolContext): Promise<readonly ModelAssignmentSet[]>
  putAssignmentSet(
    scopeRef: ScopeRef,
    input: { readonly set: ModelAssignmentSet; readonly expectedRevision?: RevisionString },
    ctx: ToolContext,
  ): Promise<ModelAssignmentSet>
}

/** Resolve the effective selection for one capability/object using the fixed resolution order. */
export interface ModelSelectionResolver {
  resolve(
    scopeRef: ScopeRef,
    request: { readonly scope: ModelTargetScope; readonly capability: ModelCapability },
    ctx: ToolContext,
  ): Promise<EffectiveModelSelection>
}

/** Probe a connection (or an unsaved draft) without ever echoing the credential or provider body. */
export interface ModelConnectionProbePort {
  probe(
    scopeRef: ScopeRef,
    request: {
      readonly draft: ModelConnectionDescriptor
      readonly credentialRef?: ResourceRef
      readonly signal?: AbortSignal
    },
    ctx: ToolContext,
  ): Promise<ModelConnectionTestResult>
}

/** Persist and read back one execution's fixed model binding. */
export interface ExecutionModelBindingStore {
  putBinding(scopeRef: ScopeRef, binding: ExecutionModelBinding, ctx: ToolContext): Promise<ExecutionModelBinding>
  getBinding(
    scopeRef: ScopeRef,
    executionId: Uuid,
    capability: ModelCapability,
    ctx: ToolContext,
  ): Promise<ExecutionModelBinding | undefined>
}

/**
 * Persist and read back an immutable, non-secret model execution-config snapshot, keyed by the exact
 * connection revision (S02). `putModelSnapshot` is idempotent per revision: a revision already stored
 * is returned unchanged, so the snapshot for a given revision can never be rewritten in place.
 */
export interface ModelExecutionSnapshotStore {
  putModelSnapshot(
    scopeRef: ScopeRef,
    snapshot: ModelExecutionConnectionSnapshot,
    ctx: ToolContext,
  ): Promise<ModelExecutionConnectionSnapshot>
  getModelSnapshot(
    scopeRef: ScopeRef,
    connectionId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<ModelExecutionConnectionSnapshot | undefined>
}

/**
 * Host credential custody: model API keys live outside the control database, in an
 * OS-protected local store keyed by an opaque `ResourceRef`. The plaintext is written once
 * (`stage` -> `activate`), never read back into a domain entity, never returned by a store
 * and never serialised (`SecretValue` renders `[redacted]`). Every operation is idempotent so
 * an interrupted write can be cleaned up and retried (design §5.3).
 */
export interface ModelCredentialCustodian {
  /** Write a new credential value under a fresh opaque ref without making it current. */
  stage(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly secret: SecretValue },
    ctx: ToolContext,
  ): Promise<ResourceRef>
  /** Make a staged credential current; idempotent if already active. */
  activate(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<void>
  /** Remove a staged-but-not-activated credential; idempotent when already gone. */
  discard(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<void>
  /** Remove every stored credential for a connection; idempotent when already clear. */
  revoke(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void>
  /** Resolve stored material for a probe/run; the value never crosses a serialisable boundary. */
  resolve(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<SecretValue>
}

/**
 * Ownership check for an assignment target. The path/query id is never trusted: the
 * host-supplied directory verifies the workspace/project actually belongs to the trusted
 * tenant/space before an assignment may name it. A foreign target is invisible (SCOPE_MISMATCH).
 */
export interface ModelTargetDirectory {
  assertTargetInScope(scopeRef: ScopeRef, scope: ModelTargetScope, ctx: ToolContext): Promise<void>
}

const ADAPTER_TYPES: readonly ModelAdapterType[] = ['company_generation', 'jev']
const CREDENTIAL_STATES: readonly ModelCredentialState[] = ['present', 'missing', 'revoked']
const TEST_STATUSES: readonly ModelConnectionTestStatus[] = ['passed', 'failed']
const TEST_REASONS: readonly ModelConnectionTestReason[] = [
  'authentication_failed', 'timeout', 'rate_limited', 'protocol_mismatch', 'unreachable', 'invalid_response',
]
const EFFECTIVE_STATES: readonly EffectiveModelState[] = ['available', 'unconfigured', 'disabled', 'blocked']
const SELECTION_SOURCES: readonly ModelSelectionSource[] = [
  'object_capability', 'object_default', 'space_capability', 'space_default', 'unconfigured',
]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCapabilityArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= MODEL_CAPABILITIES.length
    && value.every((capability) => MODEL_CAPABILITIES.includes(capability as ModelCapability))
    && new Set(value).size === value.length
}

function assertTargetScope(value: unknown): boolean {
  if (!isRecord(value)) return false
  switch (value['kind']) {
    case 'space':
      return true
    case 'industry_workspace':
      return isUuid(value['workspaceId'])
    case 'project':
      return isUuid(value['projectId'])
    default:
      return false
  }
}

function isModelRef(value: unknown): value is ModelRef {
  return isRecord(value) && isNonEmptyString(value['modelId']) && isNonEmptyString(value['version'])
}

function isSelection(value: unknown): value is ModelConnectionSelection {
  if (!isRecord(value)) return false
  switch (value['kind']) {
    case 'inherit':
    case 'disabled':
      return true
    case 'connection':
      return isUuid(value['connectionId'])
    default:
      return false
  }
}

function assertConnectionSummary(value: unknown): void {
  if (!isRecord(value) || !isUuid(value['connectionId']) || !isNonEmptyString(value['name'])
    || !isRevisionString(value['revision'])
    || !ADAPTER_TYPES.includes(value['adapterType'] as ModelAdapterType)
    || !MODEL_PROTOCOLS.includes(value['protocol'] as ModelProtocol)
    || !isCapabilityArray(value['capabilities'])
    || typeof value['enabled'] !== 'boolean'
    || !CREDENTIAL_STATES.includes(value['credentialState'] as ModelCredentialState)
    || !isNonEmptyString(value['updatedAt'])) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'invalid model connection summary')
  }
  const test = value['testSummary']
  if (test !== undefined && (!isRecord(test) || !isRevisionString(test['revision'])
    || !TEST_STATUSES.includes(test['status'] as ModelConnectionTestStatus)
    || !isNonEmptyString(test['testedAt'])
    || (test['reason'] !== undefined && !TEST_REASONS.includes(test['reason'] as ModelConnectionTestReason)))) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'invalid model connection test summary')
  }
}

/** Runtime validation of a non-secret connection summary (must reject any credential-shaped field). */
export function assertModelConnectionSummaryShape(value: unknown): asserts value is ModelConnectionSummary {
  if (isRecord(value) && ('apiKey' in value || 'credential' in value || 'secret' in value)) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'a model connection summary must never carry a credential')
  }
  assertConnectionSummary(value)
}

export function assertModelConnectionDescriptorShape(value: unknown): asserts value is ModelConnectionDescriptor {
  if (!isRecord(value) || !isNonEmptyString(value['name'])
    || !ADAPTER_TYPES.includes(value['adapterType'] as ModelAdapterType)
    || !MODEL_PROTOCOLS.includes(value['protocol'] as ModelProtocol)
    || !isCapabilityArray(value['capabilities'])
    || typeof value['enabled'] !== 'boolean'
    || !isNonEmptyString(value['platformModelId']) || !isNonEmptyString(value['providerModelName'])
    || (value['baseUrl'] !== undefined && !isNonEmptyString(value['baseUrl']))
    || (value['endpoint'] !== undefined && !isNonEmptyString(value['endpoint']))) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'invalid model connection descriptor')
  }
  for (const capability of value['capabilities'] as readonly ModelCapability[]) {
    if (!modelAdapterSupportsCapability(value['adapterType'] as ModelAdapterType, capability)) {
      throw new ModelSelectionError('MODEL_CAPABILITY_MISMATCH', 'the adapter does not support one of the declared capabilities')
    }
  }
}

export function assertModelAssignmentSetShape(value: unknown): asserts value is ModelAssignmentSet {
  if (!isRecord(value) || value.schemaVersion !== 'model-assignment-set@1' || !assertTargetScope(value['scope'])
    || !isSelection(value['defaultSelection']) || !isRevisionString(value['revision']) || !isNonEmptyString(value['updatedAt'])) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'invalid model assignment set')
  }
  const selections = value['capabilitySelections']
  if (!Array.isArray(selections)) throw new ModelSelectionError('INVALID_ARGUMENT', 'capability selections must be an array')
  const seen = new Set<ModelCapability>()
  for (const entry of selections) {
    if (!isRecord(entry) || !MODEL_CAPABILITIES.includes(entry['capability'] as ModelCapability) || !isSelection(entry['selection'])) {
      throw new ModelSelectionError('INVALID_ARGUMENT', 'each capability selection must name a known capability and a valid selection')
    }
    if (seen.has(entry['capability'] as ModelCapability)) throw new ModelSelectionError('INVALID_ARGUMENT', 'capability selections must be distinct')
    seen.add(entry['capability'] as ModelCapability)
  }
}

export function assertEffectiveModelSelectionShape(value: unknown): asserts value is EffectiveModelSelection {
  if (!isRecord(value) || value.schemaVersion !== 'effective-model-selection@1' || !assertTargetScope(value['scope'])
    || !MODEL_CAPABILITIES.includes(value['capability'] as ModelCapability)
    || !isSelection(value['selection'])
    || !SELECTION_SOURCES.includes(value['resolvedFrom'] as ModelSelectionSource)
    || !EFFECTIVE_STATES.includes(value['state'] as EffectiveModelState)
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['assignmentRevision'] !== undefined && !isRevisionString(value['assignmentRevision']))
    || (value['blockedReason'] !== undefined && !MODEL_SELECTION_REASONS.includes(value['blockedReason'] as ModelSelectionReason))
    || !isNonEmptyString(value['resolvedAt'])) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'invalid effective model selection')
  }
  if (value['connectionSummary'] !== undefined) assertConnectionSummary(value['connectionSummary'])
  if (value['state'] === 'available' && value['connectionId'] === undefined) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'an available selection must name a connection')
  }
}

export function assertExecutionModelBindingShape(value: unknown): asserts value is ExecutionModelBinding {
  if (!isRecord(value) || value.schemaVersion !== 'execution-model-binding@1' || !isUuid(value['executionId'])
    || !MODEL_CAPABILITIES.includes(value['capability'] as ModelCapability)
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['connectionRevision'] !== undefined && !isRevisionString(value['connectionRevision']))
    || !isModelRef(value['modelRef']) || !isVersionRef(value['componentRef'])
    || (value['snapshotRef'] !== undefined && !isVersionRef(value['snapshotRef']))
    || !isRevisionString(value['assignmentRevision'])
    || !SELECTION_SOURCES.includes(value['resolvedFrom'] as ModelSelectionSource)
    || !isNonEmptyString(value['boundAt'])) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'invalid execution model binding')
  }
  if (isRecord(value) && ('apiKey' in value || 'credential' in value || 'secret' in value)) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'an execution model binding must never carry a credential')
  }
}

/**
 * Runtime validation of an immutable model execution-config snapshot. It rejects any credential-shaped
 * field, so a pinned snapshot can never become a second place a key is stored (design §5.3).
 */
export function assertModelExecutionSnapshotShape(value: unknown): asserts value is ModelExecutionConnectionSnapshot {
  if (!isRecord(value) || value['schemaVersion'] !== 'model-execution-connection-snapshot@1'
    || !isUuid(value['connectionId']) || !isRevisionString(value['revision'])
    || !ADAPTER_TYPES.includes(value['adapterType'] as ModelAdapterType)
    || !MODEL_PROTOCOLS.includes(value['protocol'] as ModelProtocol)
    || !Array.isArray(value['capabilities']) || value['capabilities'].length === 0
    || !value['capabilities'].every((capability) => MODEL_CAPABILITIES.includes(capability as ModelCapability))
    || !isNonEmptyString(value['platformModelId']) || !isNonEmptyString(value['providerModelName'])
    || (value['baseUrl'] !== undefined && !isNonEmptyString(value['baseUrl']))
    || (value['endpoint'] !== undefined && !isNonEmptyString(value['endpoint']))) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'invalid model execution snapshot')
  }
  if ('apiKey' in value || 'credential' in value || 'secret' in value || 'credentialRef' in value) {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'a model execution snapshot must never carry a credential')
  }
}

export function assertModelConnectionTestResultShape(value: unknown): asserts value is ModelConnectionTestResult {
  if (!isRecord(value) || value.schemaVersion !== 'model-connection-test-result@1'
    || !TEST_STATUSES.includes(value['status'] as ModelConnectionTestStatus)
    || !isNonEmptyString(value['testedAt'])
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['connectionRevision'] !== undefined && !isRevisionString(value['connectionRevision']))
    || (value['reason'] !== undefined && !TEST_REASONS.includes(value['reason'] as ModelConnectionTestReason))
    || (value['latencyMs'] !== undefined && (!Number.isSafeInteger(value['latencyMs']) || (value['latencyMs'] as number) < 0))
    || typeof value['draft'] !== 'boolean' || typeof value['credentialConfigured'] !== 'boolean') {
    throw new ModelSelectionError('INVALID_ARGUMENT', 'invalid model connection test result')
  }
}
