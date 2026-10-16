import type {
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  ToolId,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { SecretValue } from './source-bindings'
import type { ToolContext } from './trusted'
import { isRecord, isRevisionString, isUuid, isVersionRef } from './asset-workspace'

/**
 * AI settings: the tool-connection catalogue, per-tool assignment and per-execution binding
 * (design §9).
 *
 * This mirrors the model-connection contracts (`model-selection.ts`) deliberately, because a tool
 * connection and a model connection are **different entities** but share the same lifecycle:
 * configure a connection, assign it to a scope, bind the resolved connection to one execution. A
 * `web_search` search service is a tool connection; `research` is a model capability. Registering a
 * search service as a generation model is rejected by the closed vocabularies here.
 *
 * Nothing here carries an API key: a credential is an opaque `ResourceRef` the host secret
 * custodian resolves. A search/archive probe reports a sanitized item result, never a provider body,
 * and the **search and archive tests are separate** so "search works" never implies "pages archive".
 *
 * Using a connection is not authorization: a normal editor may only pick an already-authorized
 * connection, and a connection can never widen an allowlist or a budget (design §9).
 */

/** The registered tool adapter family. It is the vendor dialect, kept out of the domain. */
export type ToolAdapterType = 'native_tavily' | 'http_compat'

/** The model-visible tools a tool connection can serve. First phase: web search only. */
export type ToolConnectionCapability = ToolId

export type ToolCredentialState = 'present' | 'missing' | 'revoked'

export type ToolTargetScope =
  | { readonly kind: 'space' }
  | { readonly kind: 'industry_workspace'; readonly workspaceId: Uuid }
  | { readonly kind: 'project'; readonly projectId: Uuid }

export type ToolConnectionProbeStatus = 'passed' | 'failed' | 'skipped'

/**
 * Why one probe item did not pass. `page_not_readable`/`digest_mismatch` are the archive-test
 * outcomes; the rest are shared connectivity/auth outcomes. A skipped archive item means the
 * archiver was not exercised, never that it passed.
 */
export type ToolConnectionProbeReason =
  | 'authentication_failed'
  | 'timeout'
  | 'rate_limited'
  | 'protocol_mismatch'
  | 'unreachable'
  | 'invalid_response'
  | 'page_not_readable'
  | 'digest_mismatch'
  | 'not_configured'

/** One item of a probe; the two items (search, archive) are reported independently. */
export interface ToolConnectionProbeItem {
  readonly status: ToolConnectionProbeStatus
  readonly reason?: ToolConnectionProbeReason
  readonly latencyMs?: number
}

/**
 * The probe result. The small real search query and the archive read-back are reported separately,
 * so "接口适配完成" is never mistaken for "真实可用" (design §9).
 */
export interface ToolConnectionProbeResult {
  readonly schemaVersion: 'tool-connection-test-result@1'
  readonly connectionId?: Uuid
  readonly connectionRevision?: RevisionString
  readonly testedAt: Rfc3339UtcTimestamp
  /** True when the probe tested an unsaved draft rather than a stored revision. */
  readonly draft: boolean
  readonly credentialConfigured: boolean
  readonly search: ToolConnectionProbeItem
  readonly archive: ToolConnectionProbeItem
}

/** Non-secret connection metadata safe to expose wherever a tool must be named. */
export interface ToolConnectionSummary {
  readonly connectionId: Uuid
  readonly name: string
  readonly revision: RevisionString
  readonly adapterType: ToolAdapterType
  readonly capabilities: readonly ToolConnectionCapability[]
  readonly enabled: boolean
  readonly credentialState: ToolCredentialState
  readonly probeSummary?: ToolConnectionProbeResult
  readonly updatedAt: Rfc3339UtcTimestamp
}

/** The administrator connection view: adds the endpoint, still no secret value. */
export interface ToolConnectionAdminView extends ToolConnectionSummary {
  readonly endpoint?: string
}

/** A create/edit descriptor. It never carries a credential; that is a separate write. */
export interface ToolConnectionDescriptor {
  readonly name: string
  readonly adapterType: ToolAdapterType
  readonly capabilities: readonly ToolConnectionCapability[]
  readonly enabled: boolean
  readonly endpoint?: string
}

/** An opaque credential reference; the host resolves it and never returns the value. */
export interface ToolConnectionCredentialChangeSet {
  readonly action: 'set'
  readonly credentialRef: ResourceRef
}
export interface ToolConnectionCredentialChangeClear {
  readonly action: 'clear'
}
export type ToolConnectionCredentialChange =
  | ToolConnectionCredentialChangeSet
  | ToolConnectionCredentialChangeClear

/** Per-tool selection: inherit the next layer, terminate resolution, or name a connection. */
export type ToolConnectionSelection =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'connection'; readonly connectionId: Uuid }

export interface ToolConnectionSelectionEntry {
  readonly toolId: ToolConnectionCapability
  readonly selection: ToolConnectionSelection
}

/** The assignment set for one target scope: a default plus per-tool overrides, versioned. */
export interface ToolAssignmentSet {
  readonly schemaVersion: 'tool-assignment-set@1'
  readonly scope: ToolTargetScope
  readonly defaultSelection: ToolConnectionSelection
  readonly toolSelections: readonly ToolConnectionSelectionEntry[]
  readonly revision: RevisionString
  readonly updatedAt: Rfc3339UtcTimestamp
}

/** Where the effective selection was resolved from, in the fixed resolution order. */
export type ToolSelectionSource =
  | 'object_tool'
  | 'object_default'
  | 'space_tool'
  | 'space_default'
  | 'unconfigured'

export const TOOL_SELECTION_RESOLUTION_ORDER: readonly ToolSelectionSource[] = [
  'object_tool',
  'object_default',
  'space_tool',
  'space_default',
]

export type EffectiveToolState = 'available' | 'unconfigured' | 'disabled' | 'blocked'

export type ToolSelectionReason =
  | 'TOOL_NOT_CONFIGURED'
  | 'TOOL_DISABLED'
  | 'TOOL_CAPABILITY_MISMATCH'
  | 'CREDENTIAL_MISSING'
  | 'TOOL_IN_USE'
  | 'TOOL_BINDING_REVOKED'

export const TOOL_SELECTION_REASONS: readonly ToolSelectionReason[] = [
  'TOOL_NOT_CONFIGURED',
  'TOOL_DISABLED',
  'TOOL_CAPABILITY_MISMATCH',
  'CREDENTIAL_MISSING',
  'TOOL_IN_USE',
  'TOOL_BINDING_REVOKED',
]

/** The resolved, explainable selection for one tool/object. Never silently switches connection. */
export interface EffectiveToolSelection {
  readonly schemaVersion: 'effective-tool-selection@1'
  readonly scope: ToolTargetScope
  readonly toolId: ToolConnectionCapability
  readonly selection: ToolConnectionSelection
  readonly resolvedFrom: ToolSelectionSource
  readonly state: EffectiveToolState
  readonly connectionId?: Uuid
  readonly connectionSummary?: ToolConnectionSummary
  readonly assignmentRevision?: RevisionString
  readonly blockedReason?: ToolSelectionReason
  readonly resolvedAt: Rfc3339UtcTimestamp
}

/** One execution's immutable tool binding. A retry/resume reuses it unchanged (design §9). */
export interface ExecutionToolBinding {
  readonly schemaVersion: 'execution-tool-binding@1'
  readonly executionId: Uuid
  readonly toolId: ToolConnectionCapability
  readonly connectionId?: Uuid
  readonly connectionRevision?: RevisionString
  readonly connectionRef: VersionRef
  readonly assignmentRevision: RevisionString
  readonly resolvedFrom: ToolSelectionSource
  readonly boundAt: Rfc3339UtcTimestamp
}

export type ToolConnectionErrorCode =
  | 'TOOL_NOT_CONFIGURED'
  | 'TOOL_DISABLED'
  | 'TOOL_CAPABILITY_MISMATCH'
  | 'CREDENTIAL_MISSING'
  | 'TOOL_IN_USE'
  | 'TOOL_BINDING_REVOKED'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'SCOPE_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'STORE_FAILED'

const TOOL_CONNECTION_HTTP_STATUS: Readonly<Record<ToolConnectionErrorCode, number>> = {
  TOOL_NOT_CONFIGURED: 409,
  TOOL_DISABLED: 409,
  TOOL_CAPABILITY_MISMATCH: 409,
  CREDENTIAL_MISSING: 409,
  TOOL_IN_USE: 409,
  TOOL_BINDING_REVOKED: 409,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  SCOPE_MISMATCH: 403,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_ARGUMENT: 400,
  STORE_FAILED: 500,
}

export class ToolConnectionError extends Error {
  readonly code: ToolConnectionErrorCode
  readonly httpStatus: number

  constructor(code: ToolConnectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ToolConnectionError'
    this.code = code
    this.httpStatus = TOOL_CONNECTION_HTTP_STATUS[code]
  }
}

/** Control persistence for the tool-connection catalogue. It stores metadata only, never a credential. */
export interface ToolConnectionStore {
  listConnections(
    scopeRef: ScopeRef,
    filter: { readonly enabled?: boolean; readonly capability?: ToolConnectionCapability; readonly limit?: number },
    ctx: ToolContext,
  ): Promise<readonly ToolConnectionAdminView[]>
  getConnection(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ToolConnectionAdminView | undefined>
  putConnection(
    scopeRef: ScopeRef,
    input: {
      readonly connectionId?: Uuid
      readonly descriptor: ToolConnectionDescriptor
      readonly expectedRevision?: RevisionString
      readonly idempotencyKey: string
    },
    ctx: ToolContext,
  ): Promise<ToolConnectionAdminView>
  deleteConnection(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void>
  setCredential(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly change: ToolConnectionCredentialChange },
    ctx: ToolContext,
  ): Promise<ToolConnectionSummary>
  getCredentialRef(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<ResourceRef | undefined>
  /** Record the latest probe summary on the connection; idempotent per connection revision. */
  recordProbe(scopeRef: ScopeRef, result: ToolConnectionProbeResult, ctx: ToolContext): Promise<ToolConnectionSummary>
}

/** Control persistence for assignment sets; `putAssignmentSet` enforces default uniqueness. */
export interface ToolAssignmentStore {
  getAssignmentSet(scopeRef: ScopeRef, scope: ToolTargetScope, ctx: ToolContext): Promise<ToolAssignmentSet | undefined>
  listAssignmentSets(scopeRef: ScopeRef, ctx: ToolContext): Promise<readonly ToolAssignmentSet[]>
  putAssignmentSet(
    scopeRef: ScopeRef,
    input: { readonly set: ToolAssignmentSet; readonly expectedRevision?: RevisionString },
    ctx: ToolContext,
  ): Promise<ToolAssignmentSet>
}

/** Resolve the effective selection for one tool/object using the fixed resolution order. */
export interface ToolSelectionResolver {
  resolve(
    scopeRef: ScopeRef,
    request: { readonly scope: ToolTargetScope; readonly toolId: ToolConnectionCapability },
    ctx: ToolContext,
  ): Promise<EffectiveToolSelection>
}

/**
 * Probe a connection (or an unsaved draft) without echoing the credential or the provider body. It
 * runs a small real search query for the search item and a read-back of an approved test page for
 * the archive item; the two item results are returned separately.
 */
export interface ToolConnectionProbePort {
  probe(
    scopeRef: ScopeRef,
    request: {
      readonly draft: ToolConnectionDescriptor
      readonly credentialRef?: ResourceRef
      readonly signal?: AbortSignal
    },
    ctx: ToolContext,
  ): Promise<ToolConnectionProbeResult>
}

/** Persist and read back one execution's fixed tool binding. */
export interface ExecutionToolBindingStore {
  putBinding(scopeRef: ScopeRef, binding: ExecutionToolBinding, ctx: ToolContext): Promise<ExecutionToolBinding>
  getBinding(
    scopeRef: ScopeRef,
    executionId: Uuid,
    toolId: ToolConnectionCapability,
    ctx: ToolContext,
  ): Promise<ExecutionToolBinding | undefined>
}

/**
 * Host credential custody for tool connections. It is the same custody boundary the model
 * connections use: the plaintext is written once and never read back into a domain entity.
 */
export interface ToolCredentialCustodian {
  stage(
    scopeRef: ScopeRef,
    input: { readonly connectionId: Uuid; readonly secret: SecretValue },
    ctx: ToolContext,
  ): Promise<ResourceRef>
  activate(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<void>
  discard(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<void>
  revoke(scopeRef: ScopeRef, connectionId: Uuid, ctx: ToolContext): Promise<void>
  resolve(scopeRef: ScopeRef, credentialRef: ResourceRef, ctx: ToolContext): Promise<SecretValue>
}

/**
 * Ownership check for an assignment target. The path/query id is never trusted: the host-supplied
 * directory verifies the workspace/project actually belongs to the trusted tenant/space before an
 * assignment may name it. A foreign target is invisible.
 */
export interface ToolTargetDirectory {
  assertTargetInScope(scopeRef: ScopeRef, scope: ToolTargetScope, ctx: ToolContext): Promise<void>
}

const ADAPTER_TYPES: readonly ToolAdapterType[] = ['native_tavily', 'http_compat']
const CREDENTIAL_STATES: readonly ToolCredentialState[] = ['present', 'missing', 'revoked']
const PROBE_STATUSES: readonly ToolConnectionProbeStatus[] = ['passed', 'failed', 'skipped']
const PROBE_REASONS: readonly ToolConnectionProbeReason[] = [
  'authentication_failed', 'timeout', 'rate_limited', 'protocol_mismatch', 'unreachable',
  'invalid_response', 'page_not_readable', 'digest_mismatch', 'not_configured',
]
const EFFECTIVE_STATES: readonly EffectiveToolState[] = ['available', 'unconfigured', 'disabled', 'blocked']
const SELECTION_SOURCES: readonly ToolSelectionSource[] = [
  'object_tool', 'object_default', 'space_tool', 'space_default', 'unconfigured',
]
const TOOL_CAPABILITIES: readonly ToolConnectionCapability[] = [
  'ontology_lookup', 'data_query', 'document_search', 'web_search',
]

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isCapabilityArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= TOOL_CAPABILITIES.length
    && value.every((capability) => TOOL_CAPABILITIES.includes(capability as ToolConnectionCapability))
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

function isSelection(value: unknown): value is ToolConnectionSelection {
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

function assertProbeItem(value: unknown, field: string): void {
  if (!isRecord(value) || !PROBE_STATUSES.includes(value['status'] as ToolConnectionProbeStatus)
    || (value['reason'] !== undefined && !PROBE_REASONS.includes(value['reason'] as ToolConnectionProbeReason))
    || (value['latencyMs'] !== undefined && (!Number.isSafeInteger(value['latencyMs']) || (value['latencyMs'] as number) < 0))) {
    throw new ToolConnectionError('INVALID_ARGUMENT', `invalid tool probe ${field} item`)
  }
}

/** Runtime validation of a probe result. Both items must be present; a credential is never echoed. */
export function assertToolConnectionProbeResultShape(
  value: unknown,
): asserts value is ToolConnectionProbeResult {
  if (!isRecord(value) || value['schemaVersion'] !== 'tool-connection-test-result@1'
    || !isNonEmptyString(value['testedAt'])
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['connectionRevision'] !== undefined && !isRevisionString(value['connectionRevision']))
    || typeof value['draft'] !== 'boolean' || typeof value['credentialConfigured'] !== 'boolean') {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'invalid tool connection probe result')
  }
  assertProbeItem(value['search'], 'search')
  assertProbeItem(value['archive'], 'archive')
}

function assertConnectionSummary(value: unknown): void {
  if (!isRecord(value) || !isUuid(value['connectionId']) || !isNonEmptyString(value['name'])
    || !isRevisionString(value['revision'])
    || !ADAPTER_TYPES.includes(value['adapterType'] as ToolAdapterType)
    || !isCapabilityArray(value['capabilities'])
    || typeof value['enabled'] !== 'boolean'
    || !CREDENTIAL_STATES.includes(value['credentialState'] as ToolCredentialState)
    || !isNonEmptyString(value['updatedAt'])) {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'invalid tool connection summary')
  }
  if (value['probeSummary'] !== undefined) assertToolConnectionProbeResultShape(value['probeSummary'])
}

/** Runtime validation of a non-secret connection summary (must reject any credential-shaped field). */
export function assertToolConnectionSummaryShape(value: unknown): asserts value is ToolConnectionSummary {
  if (isRecord(value) && ('apiKey' in value || 'credential' in value || 'secret' in value)) {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'a tool connection summary must never carry a credential')
  }
  assertConnectionSummary(value)
}

export function assertToolConnectionDescriptorShape(value: unknown): asserts value is ToolConnectionDescriptor {
  if (!isRecord(value) || !isNonEmptyString(value['name'])
    || !ADAPTER_TYPES.includes(value['adapterType'] as ToolAdapterType)
    || !isCapabilityArray(value['capabilities'])
    || typeof value['enabled'] !== 'boolean'
    || (value['endpoint'] !== undefined && !isNonEmptyString(value['endpoint']))) {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'invalid tool connection descriptor')
  }
}

export function assertToolAssignmentSetShape(value: unknown): asserts value is ToolAssignmentSet {
  if (!isRecord(value) || value['schemaVersion'] !== 'tool-assignment-set@1' || !assertTargetScope(value['scope'])
    || !isSelection(value['defaultSelection']) || !isRevisionString(value['revision']) || !isNonEmptyString(value['updatedAt'])) {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'invalid tool assignment set')
  }
  const selections = value['toolSelections']
  if (!Array.isArray(selections)) throw new ToolConnectionError('INVALID_ARGUMENT', 'tool selections must be an array')
  const seen = new Set<ToolConnectionCapability>()
  for (const entry of selections) {
    if (!isRecord(entry) || !TOOL_CAPABILITIES.includes(entry['toolId'] as ToolConnectionCapability) || !isSelection(entry['selection'])) {
      throw new ToolConnectionError('INVALID_ARGUMENT', 'each tool selection must name a known tool and a valid selection')
    }
    if (seen.has(entry['toolId'] as ToolConnectionCapability)) throw new ToolConnectionError('INVALID_ARGUMENT', 'tool selections must be distinct')
    seen.add(entry['toolId'] as ToolConnectionCapability)
  }
}

export function assertEffectiveToolSelectionShape(value: unknown): asserts value is EffectiveToolSelection {
  if (!isRecord(value) || value['schemaVersion'] !== 'effective-tool-selection@1' || !assertTargetScope(value['scope'])
    || !TOOL_CAPABILITIES.includes(value['toolId'] as ToolConnectionCapability)
    || !isSelection(value['selection'])
    || !SELECTION_SOURCES.includes(value['resolvedFrom'] as ToolSelectionSource)
    || !EFFECTIVE_STATES.includes(value['state'] as EffectiveToolState)
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['assignmentRevision'] !== undefined && !isRevisionString(value['assignmentRevision']))
    || (value['blockedReason'] !== undefined && !TOOL_SELECTION_REASONS.includes(value['blockedReason'] as ToolSelectionReason))
    || !isNonEmptyString(value['resolvedAt'])) {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'invalid effective tool selection')
  }
  if (value['connectionSummary'] !== undefined) assertConnectionSummary(value['connectionSummary'])
  if (value['state'] === 'available' && value['connectionId'] === undefined) {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'an available selection must name a connection')
  }
}

export function assertExecutionToolBindingShape(value: unknown): asserts value is ExecutionToolBinding {
  if (!isRecord(value) || value['schemaVersion'] !== 'execution-tool-binding@1' || !isUuid(value['executionId'])
    || !TOOL_CAPABILITIES.includes(value['toolId'] as ToolConnectionCapability)
    || (value['connectionId'] !== undefined && !isUuid(value['connectionId']))
    || (value['connectionRevision'] !== undefined && !isRevisionString(value['connectionRevision']))
    || !isVersionRef(value['connectionRef'])
    || !isRevisionString(value['assignmentRevision'])
    || !SELECTION_SOURCES.includes(value['resolvedFrom'] as ToolSelectionSource)
    || !isNonEmptyString(value['boundAt'])) {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'invalid execution tool binding')
  }
  if (isRecord(value) && ('apiKey' in value || 'credential' in value || 'secret' in value)) {
    throw new ToolConnectionError('INVALID_ARGUMENT', 'an execution tool binding must never carry a credential')
  }
}
