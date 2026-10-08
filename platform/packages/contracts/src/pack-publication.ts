import type {
  CapabilityRequirement,
  IndustryManifest,
  IndustryMaturity,
  ResourceRef,
  RevisionString,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  Uuid,
  VersionRef,
} from './generated/contracts'
import type { PackAsset, PackMaturityLabel } from './pack-assets'
import type { ActionCapabilityStatus } from './rule-action-candidates'
import type { SemanticDefinitionAudit, SemanticDefinitionRecord } from './semantic-definitions'
import type { NewOutboxMessage } from './job-store'
import type { ToolContext } from './trusted'
import type { DefinitionApprovalPin, DefinitionRevisionStrategy } from './definition-editing'
import type { RuleActionPublicationPin } from './synthetic-validation'

/**
 * Immutable industry-pack publication and the persistent dynamic catalogue (SPEC v0.3a
 * asset-data-ui §3.1/§4.2/§6.1, issue V03-015 / #187; A.US-005, P.US-005/006/011, P.FR-14/15/17).
 *
 * Publication turns a human-reviewed draft plus its industry validation report into an
 * immutable, versioned pack. Three invariants shape this contract:
 *
 *  - **One transaction.** The published definition version, its audit event, the pack asset,
 *    the source index, the workspace publish pointer and the outbox message commit together
 *    (SPEC §4.2). A retry with the same idempotency key returns the stored asset and writes
 *    nothing again.
 *  - **Declaration data only.** The persisted asset and its export carry semantic declarations,
 *    an authorized/redacted source index and capability state. A customer instance, a real price
 *    table, an identity decision or a credential never enters the shared pack (INV-03/ADR-03).
 *  - **Two readiness surfaces stay separate.** `semanticPublished` (a definition/rule/action may
 *    be published) and `deploymentExecutable` (a registered implementation can actually run) are
 *    reported independently, so a pack can be semantically published while its actions are still
 *    unbound (SPEC §4.2/§6.1).
 *
 * The port lives in `contracts` so an adapter implements it while depending on `contracts`
 * alone (SPEC §2: adapters → contracts). The application service receives it by construction
 * injection and never imports an adapter or driver.
 */

/* ----------------------------------------------------------------------------------------- */
/* Source index, action pins and capability state                                             */
/* ----------------------------------------------------------------------------------------- */

/**
 * One entry of the pack source index. An entry is either an authorized declaration reference or a
 * redacted source: it never carries a customer full text, a physical address or a credential.
 */
export interface PackSourceIndexEntry {
  readonly kind: 'declaration' | 'redacted_source'
  /** Authorized declaration/source reference; a resource ref, never free-form content. */
  readonly ref: ResourceRef
  readonly label: string
  /** True when the entry is a redacted customer/private source rather than a public declaration. */
  readonly redacted: boolean
}

/** The deterministic source index of one published pack. */
export interface PackSourceIndex {
  readonly packRef: VersionRef
  readonly entries: readonly PackSourceIndexEntry[]
  readonly digest: Sha256Digest
}

/** One pinned action declaration of a published pack with its bound capability status. */
export interface PackActionDeclarationPin {
  readonly actionId: string
  readonly declarationRef: ResourceRef
  readonly bindingStatus: ActionCapabilityStatus
  readonly executable: boolean
  readonly requiredCapabilities: readonly CapabilityRequirement[]
  /** Required capability names no registered deployment provides. */
  readonly missingCapabilities: readonly string[]
}

/**
 * The two-surface capability state of a published pack. `semanticPublished` says the pack is a
 * valid semantic publication; `deploymentExecutable` says every required action can actually run
 * in this deployment. They are independent (SPEC §4.2/A.US-005.AC-01/P.FR-15).
 */
export interface PackCapabilityStatus {
  readonly semanticPublished: boolean
  readonly deploymentExecutable: boolean
  readonly requiredCapabilities: readonly string[]
  readonly missingCapabilities: readonly string[]
  readonly actions: readonly PackActionDeclarationPin[]
}

/* ----------------------------------------------------------------------------------------- */
/* Version diff                                                                               */
/* ----------------------------------------------------------------------------------------- */

export type PackVersionChangeScope = 'definition' | 'rule' | 'action' | 'capability'

/**
 * One change of a pack relative to the previously published version of the same namespace.
 * A `breaking` change can reinterpret or invalidate already published instances.
 */
export interface PackVersionChange {
  readonly scope: PackVersionChangeScope
  /**
   * The change kind, e.g. `OBJECT_REMOVED`. Deliberately not named `code` so the pack
   * declaration scanner (which forbids an executable-code field) never flags a pure diff.
   */
  readonly change: string
  readonly logicalId: string
  readonly breaking: boolean
  readonly message: string
  readonly before?: string
  readonly after?: string
}

export interface PackVersionDiff {
  readonly fromPackRef?: VersionRef
  readonly toPackRef: VersionRef
  readonly changes: readonly PackVersionChange[]
  readonly breakingChanges: readonly PackVersionChange[]
  readonly digest: Sha256Digest
}

/* ----------------------------------------------------------------------------------------- */
/* Published pack asset                                                                       */
/* ----------------------------------------------------------------------------------------- */

/**
 * One immutable published pack. `packAsset` is the portable declaration consumed by the dynamic
 * catalogue, the profile resolver and the export; the remaining fields pin the provenance the
 * catalogue reports and never carry customer data.
 */
export interface PublishedPackAsset {
  readonly strategy?: DefinitionRevisionStrategy
  readonly approvalPins?: readonly DefinitionApprovalPin[]
  readonly ruleActionPins?: readonly RuleActionPublicationPin[]
  readonly packRef: VersionRef
  readonly workspaceId: Uuid
  readonly namespace: string
  readonly maturity: IndustryMaturity
  readonly maturityLabel: PackMaturityLabel
  readonly manifest: IndustryManifest
  readonly packAsset: PackAsset
  readonly definitionRef: VersionRef
  readonly validationRef: ResourceRef
  readonly sourceIndex: PackSourceIndex
  readonly capabilities: PackCapabilityStatus
  readonly diff: PackVersionDiff
  /** The per-scope publication revision this asset advanced the workspace head to. */
  readonly revision: RevisionString
  readonly contentDigest: Sha256Digest
  readonly idempotencyKey: string
  readonly actor: string
  readonly publishedAt: Rfc3339UtcTimestamp
}

/** Everything except the store-assigned revision and timestamp. */
export type PublishedPackAssetDraft = Omit<PublishedPackAsset, 'revision' | 'publishedAt'>

export interface PublishedPackAssetFilter {
  readonly namespace?: string
  /** Bounded page size; a caller never reads an unbounded table. */
  readonly limit?: number
}

/* ----------------------------------------------------------------------------------------- */
/* Commit                                                                                     */
/* ----------------------------------------------------------------------------------------- */

/**
 * Everything `commitApprovedPack` applies in one transaction. Splitting any part would let a
 * committed pack lose its definition version or its workspace pointer (SPEC §4.2 point 4).
 */
export interface CommitApprovedPackInput {
  readonly approvalPins?: readonly DefinitionApprovalPin[]
  readonly ruleActionPins?: readonly RuleActionPublicationPin[]
  /** The workspace publication head the caller read; `0` means "first publication". */
  readonly expectedRevision: RevisionString
  /** The immutable definition version published in the same transaction. */
  readonly definition: SemanticDefinitionRecord
  readonly definitionAudit: SemanticDefinitionAudit
  readonly pack: PublishedPackAssetDraft
  readonly idempotencyKey: string
  readonly requestDigest: Sha256Digest
  readonly actor: string
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly outbox: NewOutboxMessage
  readonly outboxJobId: Uuid
}

export interface CommitApprovedPackResult {
  readonly asset: PublishedPackAsset
  /** False when the call replayed an earlier idempotent commit. */
  readonly created: boolean
}

/**
 * Control persistence for published industry packs and the dynamic catalogue (SPEC §4.1/§6.1).
 *
 * Every method runs in the trusted tenant/space scope and RLS is a second layer behind the
 * explicit scope predicate. `commitApprovedPack` is one transaction: it writes the published
 * definition version and event, the pack asset, advances the workspace publish pointer and
 * enqueues the outbox message. A pack id/version with a different digest, or a namespace/version
 * with a different digest, is refused instead of silently replacing a published version.
 */
export interface PublishedPackAssetStore {
  commitApprovedPack(
    scopeRef: ScopeRef,
    input: CommitApprovedPackInput,
    ctx: ToolContext,
  ): Promise<CommitApprovedPackResult>
  findPack(
    scopeRef: ScopeRef,
    packId: string,
    version: Semver,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset | undefined>
  findByRef(scopeRef: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<PublishedPackAsset | undefined>
  listPacks(
    scopeRef: ScopeRef,
    filter: PublishedPackAssetFilter,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset[]>
  findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset | undefined>
}

export type PublishedPackAssetStoreErrorCode =
  | 'SCOPE_MISMATCH'
  | 'WORKSPACE_NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PACK_VERSION_EXISTS'
  | 'NAMESPACE_CONFLICT'
  | 'DEFINITION_VERSION_EXISTS'
  | 'INVALID_ASSET'
  | 'STORE_FAILED'

export class PublishedPackAssetStoreError extends Error {
  readonly code: PublishedPackAssetStoreErrorCode

  constructor(code: PublishedPackAssetStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PublishedPackAssetStoreError'
    this.code = code
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Publication errors                                                                         */
/* ----------------------------------------------------------------------------------------- */

export type IndustryAssetPublicationErrorCode =
  | 'SCOPE_MISMATCH'
  | 'FORBIDDEN'
  | 'WORKSPACE_NOT_FOUND'
  | 'DRAFT_NOT_FOUND'
  | 'VALIDATION_NOT_FOUND'
  | 'VALIDATION_STALE'
  | 'VALIDATION_BLOCKED'
  | 'NAMESPACE_CONFLICT'
  | 'PACK_VERSION_EXISTS'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'EXPORT_LEAK_DETECTED'
  | 'STORE_FAILED'

const PUBLICATION_HTTP_STATUS: Readonly<Record<IndustryAssetPublicationErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  FORBIDDEN: 403,
  WORKSPACE_NOT_FOUND: 404,
  DRAFT_NOT_FOUND: 404,
  VALIDATION_NOT_FOUND: 404,
  VALIDATION_STALE: 409,
  VALIDATION_BLOCKED: 409,
  NAMESPACE_CONFLICT: 409,
  PACK_VERSION_EXISTS: 409,
  VERSION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_ARGUMENT: 400,
  EXPORT_LEAK_DETECTED: 422,
  STORE_FAILED: 500,
}

export class IndustryAssetPublicationError extends Error {
  readonly code: IndustryAssetPublicationErrorCode
  readonly httpStatus: number
  readonly reasons: readonly string[]

  constructor(
    code: IndustryAssetPublicationErrorCode,
    message: string,
    options?: ErrorOptions & { readonly reasons?: readonly string[] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'IndustryAssetPublicationError'
    this.code = code
    this.httpStatus = PUBLICATION_HTTP_STATUS[code]
    this.reasons = options?.reasons ?? []
  }
}

export function isIndustryAssetPublicationError(value: unknown): value is IndustryAssetPublicationError {
  return value instanceof IndustryAssetPublicationError
}

/* ----------------------------------------------------------------------------------------- */
/* Requests                                                                                   */
/* ----------------------------------------------------------------------------------------- */

export interface PublishIndustryPackInput {
  readonly strategy?: DefinitionRevisionStrategy
  readonly packId: string
  readonly version: Semver
  /** The industry validation report the draft was confirmed by. */
  readonly validationId: Uuid
  /** The workspace head the caller read; `undefined` means the If-Match header was absent. */
  readonly expectedRevision: RevisionString | undefined
  readonly idempotencyKey: string
  /**
   * When true a pack whose deployment surface is not fully executable is refused rather than
   * published with unbound actions. Default false: a declaration may be semantically published
   * while its actions stay `not_executable` (SPEC §4.2).
   */
  readonly requireDeploymentExecutable?: boolean
}

/* ----------------------------------------------------------------------------------------- */
/* Runtime guards                                                                             */
/* ----------------------------------------------------------------------------------------- */

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const REVISION_PATTERN = /^(0|[1-9][0-9]*)$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function isUuid(value: unknown): value is Uuid {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export function isRevisionStringValue(value: unknown): value is RevisionString {
  return typeof value === 'string' && REVISION_PATTERN.test(value)
}

export function isVersionRefValue(value: unknown): value is VersionRef {
  return isRecord(value) && isNonEmptyString(value['id']) && isNonEmptyString(value['version']) && isDigest(value['digest'])
}

export function isResourceRefValue(value: unknown): value is ResourceRef {
  return (
    isRecord(value) &&
    isUuid(value['id']) &&
    isNonEmptyString(value['version']) &&
    isDigest(value['digest']) &&
    isNonEmptyString(value['kind'])
  )
}

/**
 * Validate the persisted shape of a published pack asset. A malformed asset is rejected before it
 * is written or returned, so a catalogue reader never sees an ill-formed declaration.
 */
export function assertPublishedPackAssetShape(value: unknown): asserts value is PublishedPackAsset {
  if (!isRecord(value)) throw invalid('a published pack asset must be an object')
  const approvals = value['approvalPins']
  if (approvals !== undefined && (!Array.isArray(approvals) || !approvals.every((pin: unknown) => isRecord(pin) &&
      isUuid(pin['candidateId']) && isDigest(pin['contentDigest']) && isRevisionStringValue(pin['reviewRevision']) && pin['reviewRevision'] !== '0'))) {
    throw invalid('approvalPins must contain candidate/content/review revision pins')
  }
  const enabled = value['ruleActionPins']
  if (enabled !== undefined && (!Array.isArray(enabled) || !enabled.every((pin: unknown) => isRecord(pin) &&
      isUuid(pin['candidateId']) && isDigest(pin['contentDigest']) && typeof pin['enabledAt'] === 'string' && Number.isFinite(Date.parse(pin['enabledAt']))))) {
    throw invalid('ruleActionPins must contain candidate/content/enablement pins')
  }
  const strategy = value['strategy']
  if (strategy !== undefined && (!isRecord(strategy) || !['new_version', 'keep_independent', 'retire_previous'].includes(String(strategy['kind'])) ||
      typeof strategy['reason'] !== 'string' || strategy['reason'].trim().length === 0 ||
      (strategy['supersedesRef'] !== undefined && !isVersionRefValue(strategy['supersedesRef'])))) {
    throw invalid('strategy must contain a supported decision, reason and optional predecessor pin')
  }
  if (!isVersionRefValue(value['packRef'])) throw invalid('packRef must be a version reference')
  if (!isUuid(value['workspaceId'])) throw invalid('workspaceId must be a uuid')
  if (!isNonEmptyString(value['namespace'])) throw invalid('namespace must be a non-empty string')
  if (!isRecord(value['manifest'])) throw invalid('manifest must be an object')
  if (!isVersionRefValue(value['definitionRef'])) throw invalid('definitionRef must be a version reference')
  if (!isResourceRefValue(value['validationRef'])) throw invalid('validationRef must be a resource reference')
  if (!isRecord(value['sourceIndex'])) throw invalid('sourceIndex must be an object')
  if (typeof value['sourceIndex']['digest'] !== 'string' || !isDigest(value['sourceIndex']['digest'])) {
    throw invalid('sourceIndex.digest must be a sha256 digest')
  }
  if (!Array.isArray(value['sourceIndex']['entries'])) throw invalid('sourceIndex.entries must be an array')
  if (!isRecord(value['capabilities'])) throw invalid('capabilities must be an object')
  if (typeof value['capabilities']['semanticPublished'] !== 'boolean') {
    throw invalid('capabilities.semanticPublished must be a boolean')
  }
  if (typeof value['capabilities']['deploymentExecutable'] !== 'boolean') {
    throw invalid('capabilities.deploymentExecutable must be a boolean')
  }
  if (!Array.isArray(value['capabilities']['actions'])) throw invalid('capabilities.actions must be an array')
  if (!isRecord(value['diff'])) throw invalid('diff must be an object')
  if (!isRevisionStringValue(value['revision'])) throw invalid('revision must be a decimal string')
  if (!isDigest(value['contentDigest'])) throw invalid('contentDigest must be a sha256 digest')
  if (!isNonEmptyString(value['idempotencyKey'])) throw invalid('idempotencyKey must be a non-empty string')
  if (!isNonEmptyString(value['actor'])) throw invalid('actor must be a non-empty string')
  if (!isNonEmptyString(value['publishedAt'])) throw invalid('publishedAt must be a timestamp')
}

export function isPublishedPackAsset(value: unknown): value is PublishedPackAsset {
  try {
    assertPublishedPackAssetShape(value)
    return true
  } catch {
    return false
  }
}

function invalid(message: string): PublishedPackAssetStoreError {
  return new PublishedPackAssetStoreError('INVALID_ASSET', message)
}
