import type {
  NonEmptyString,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Semver,
  Sha256Digest,
  Uuid,
} from './generated/contracts'
import type { AssetCandidateIssue, DefinitionCandidateKind, DefinitionCandidateProposal } from './asset-candidates'
import type { CandidateSourceSpan } from './extraction'
import type {
  ActionDeclaration,
  RuleApplicability,
  RuleDependencyCandidateReference,
} from './rule-action-candidates'
import type { RuleConclusionBinding, RuleExceptionNode, RuleExpressionNode } from './rule-extraction'
import type { ToolContext } from './trusted'
import { isRecord, isResourceRef, isSha256Digest, isUuid, isVersionRef } from './asset-workspace'

/**
 * The controlled candidate-submission command (design §5/§6/§7, ADR-04/C4 increment).
 *
 * `submit_candidates` is deliberately **not** one of the four model-visible data tools and it is
 * never hidden inside `data_query`/compute. It is a workspace write command: the model may call
 * it through the runtime action union (`runtime-action.ts`), but the platform owns every trusted
 * attribute of the resulting source/candidate.
 *
 * Two boundaries are enforced by the runtime validator:
 *
 *  - **The model supplies evidence, not authority.** Every candidate references evidence already
 *    obtained in this execution (an archived page or a located span) with its own locator/digest/
 *    parser version, and a reason. A candidate may carry **more than one** evidence item.
 *  - **The model cannot forge identity/audit/publication state.** Any `trustTier`, `reviewState`,
 *    `sourceId`, `candidateId`, `publishedAt`, `runId`, `idempotencyKey` or `principal` field is
 *    rejected outright, at any depth, so the service — not the model — fixes
 *    `trustTier=agent_researched`, `reviewState=proposed` and the candidate identity.
 *
 * The service fixes the idempotency key from `run + logical action + content digest`; the wire
 * command therefore carries none (design §7).
 */

export type CandidateSubmissionKind = 'source' | 'definition' | 'rule' | 'action'

/**
 * A reference to a page this execution already archived through `web_search`. It names both the
 * original snapshot and its manifest, so a reader can tell the retrieved bytes apart from the
 * derived parse and re-read them.
 */
export interface WebPageEvidenceRef {
  readonly kind: 'web_page'
  readonly url: string
  readonly snapshotRef: ResourceRef
  readonly snapshotManifestRef: ResourceRef
  readonly contentDigest: Sha256Digest
  readonly fetchedAt: Rfc3339UtcTimestamp
  readonly parserVersion: Semver
}

/**
 * A located span in an already-authorized document set (uploaded material or a research staged
 * document set). `span` is the existing `CandidateSourceSpan`, so a research candidate's
 * provenance is exactly the provenance an upload-sourced candidate uses.
 */
export interface LocatedSourceEvidenceRef {
  readonly kind: 'located_span'
  readonly sourceRef: ResourceRef
  readonly span: CandidateSourceSpan
  readonly parserVersion: Semver
}

export type CandidateEvidence = WebPageEvidenceRef | LocatedSourceEvidenceRef

/** Where a newly proposed web source came from. It carries no trust tier — the service fixes it. */
export interface SubmitSourceOrigin {
  readonly url?: string
  readonly publisher?: string
  readonly standardRef?: ResourceRef
  readonly fetchedAt?: Rfc3339UtcTimestamp
}

interface CandidateSubmissionCommon {
  /** One or more evidence items; a candidate with no evidence is rejected. */
  readonly evidence: readonly CandidateEvidence[]
  /** Why the model proposes this candidate, grounded in the evidence. Never an authority claim. */
  readonly reason: NonEmptyString
}

/** A proposed new source: this execution's archived pages plus a reason. */
export interface SourceCandidateSubmission extends CandidateSubmissionCommon {
  readonly kind: 'source'
  readonly origin: SubmitSourceOrigin
  readonly title?: NonEmptyString
}

/** A definition candidate: the existing object/attribute/relation structure plus evidence + reason. */
export interface DefinitionCandidateSubmission extends CandidateSubmissionCommon {
  readonly kind: 'definition'
  readonly definitionKind: DefinitionCandidateKind
  readonly payload: DefinitionCandidateProposal
}

/**
 * A rule candidate proposal. It carries the model's original condition/exceptions/conclusion and
 * its dependency references, but **not** the server-computed `support` report: the report is
 * recomputed by the finite-grammar validator on write.
 */
export interface SubmitRuleCandidatePayload {
  readonly ruleId: NonEmptyString
  readonly applicability: RuleApplicability
  readonly condition: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
  readonly conclusion?: RuleConclusionBinding
  readonly ruleDependencies: readonly string[]
  readonly dependencyRefs?: readonly RuleDependencyCandidateReference[]
}

export interface RuleCandidateSubmission extends CandidateSubmissionCommon {
  readonly kind: 'rule'
  readonly payload: SubmitRuleCandidatePayload
}

/** An action candidate: a semantic declaration only. It may not carry a capability binding. */
export interface ActionCandidateSubmission extends CandidateSubmissionCommon {
  readonly kind: 'action'
  readonly declaration: ActionDeclaration
}

export type CandidateSubmission =
  | SourceCandidateSubmission
  | DefinitionCandidateSubmission
  | RuleCandidateSubmission
  | ActionCandidateSubmission

/**
 * The `submit_candidates@1` command. `workspaceId` lets the service reject a command aimed at a
 * workspace other than the run's; it never lets the model pick the run, operator or scope.
 */
export interface SubmitCandidatesCommand {
  readonly schemaVersion: 'submit-candidates@1'
  readonly commandKind: 'submit_candidates'
  readonly workspaceId: Uuid
  readonly candidates: readonly CandidateSubmission[]
  /** An optional reviewer-facing hint (e.g. "疑似官方规范"). It is not an authority signal. */
  readonly note?: NonEmptyString
}

/**
 * The host envelope around a model command. `runId`, `logicalActionId` and `idempotencyKey` are
 * host-minted and never model-supplied; the operator/scope come from the trusted `ToolContext`.
 */
export interface SubmitCandidatesRequest {
  readonly command: SubmitCandidatesCommand
  readonly runId: Uuid
  readonly logicalActionId: NonEmptyString
  readonly idempotencyKey: NonEmptyString
}

/** One accepted candidate's outcome, projected back into the receipt. */
export interface CandidateReceiptEntry {
  readonly submissionIndex: number
  readonly candidateId: Uuid
  readonly kind: CandidateSubmissionKind
  /** The persisted candidate state (asset candidate lifecycle or source review state). */
  readonly state: string
  readonly pendingConfirmation: boolean
  readonly issues: readonly AssetCandidateIssue[]
  readonly sourceRefs: readonly ResourceRef[]
}

/** One rejected submission with a stable machine code; a partial success is never a silent success. */
export interface CandidateRejection {
  readonly submissionIndex: number
  readonly code: SubmitCandidatesErrorCode
  readonly message: string
}

/**
 * The idempotent receipt. `replayed` is true when the same host idempotency key returned the
 * stored outcome instead of writing a second candidate (design §7).
 */
export interface SubmitCandidatesReceipt {
  readonly schemaVersion: 'submit-candidates-receipt@1'
  readonly runId: Uuid
  readonly workspaceId: Uuid
  readonly commandDigest: Sha256Digest
  readonly accepted: readonly CandidateReceiptEntry[]
  readonly rejected: readonly CandidateRejection[]
  readonly replayed: boolean
  readonly recordedAt: Rfc3339UtcTimestamp
}

export type SubmitCandidatesErrorCode =
  | 'INVALID_COMMAND'
  | 'FORBIDDEN_MODEL_FIELD'
  | 'EVIDENCE_NOT_AUTHORIZED'
  | 'EVIDENCE_DIGEST_MISMATCH'
  | 'CANDIDATE_LIMIT_EXCEEDED'
  | 'TERMINOLOGY_CONFLICT'
  | 'RULE_DEPENDENCY_UNRESOLVED'
  | 'ACTION_BINDING_FAILED'
  | 'SOURCE_TRUST_BLOCKED'
  | 'FENCE_STALE'
  | 'PERMISSION_DENIED'
  | 'SCOPE_MISMATCH'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STORE_FAILED'

export class SubmitCandidatesError extends Error {
  readonly code: SubmitCandidatesErrorCode

  constructor(code: SubmitCandidatesErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SubmitCandidatesError'
    this.code = code
  }
}

/**
 * The controlled write port. It is implemented by the application layer; `tool-services` must not
 * depend on it. A plain data-tool session never receives this port, so read-only sessions cannot
 * obtain candidate write permission (design §5).
 */
export interface CandidateSubmissionPort {
  submit(
    scopeRef: ScopeRef,
    request: SubmitCandidatesRequest,
    ctx: ToolContext,
  ): Promise<SubmitCandidatesReceipt>
  /** Resolve a prior receipt by its host idempotency key, so a crash-replay returns the same one. */
  findReceipt?(
    scopeRef: ScopeRef,
    runId: Uuid,
    idempotencyKey: string,
    ctx: ToolContext,
  ): Promise<SubmitCandidatesReceipt | undefined>
}

export const CANDIDATE_SUBMISSION_KINDS: readonly CandidateSubmissionKind[] = [
  'source',
  'definition',
  'rule',
  'action',
]

/**
 * Fields the model must never set on a candidate. They are trusted attributes the service derives:
 * identity (`sourceId`/`candidateId`/`runId`/`workspaceId`), review (`reviewState`/`reviewedBy`),
 * publication (`publishedAt`) and the provenance tier (`trustTier`). A `confidence`/`credibility`
 * field is rejected too, so the model cannot smuggle a "可信度 92%" claim into the command.
 */
export const FORBIDDEN_MODEL_CANDIDATE_FIELDS: readonly string[] = [
  'trustTier',
  'trust',
  'reviewState',
  'reviewResult',
  'reviewedBy',
  'reviewer',
  'publicationState',
  'publishedState',
  'publishedAt',
  'approvedAt',
  'rejectedAt',
  'sourceId',
  'candidateId',
  'proposedBy',
  'authority',
  'isOfficial',
  'confidence',
  'credibility',
  'idempotencyKey',
  'principal',
  'operatorId',
  'subjectId',
  'runId',
]

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/
const SOURCE_KINDS: readonly DefinitionCandidateKind[] = ['object', 'attribute', 'relation']

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSemver(value: unknown): value is Semver {
  return typeof value === 'string' && SEMVER_PATTERN.test(value)
}

function isInstant(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** A stable dotted path to the first forbidden field found, or `undefined` when the value is clean. */
export interface ForbiddenModelField {
  readonly path: string
  readonly field: string
}

/**
 * Deep scan for a model-forged trusted field. It reports the offending path so the service can
 * reject the whole command instead of silently dropping the field.
 */
export function findForbiddenModelFields(
  value: unknown,
  path = 'candidates',
  out: ForbiddenModelField[] = [],
): readonly ForbiddenModelField[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenModelFields(entry, `${path}[${index}]`, out))
    return out
  }
  if (!isRecord(value)) return out
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_MODEL_CANDIDATE_FIELDS.includes(key)) {
      out.push({ path: `${path}.${key}`, field: key })
      continue
    }
    findForbiddenModelFields(child, `${path}.${key}`, out)
  }
  return out
}

function assertEvidence(value: unknown, path: string, submissionIndex: number): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw invalid(`submission ${submissionIndex} ${path} must carry 1..32 evidence items`)
  }
  for (const entry of value) {
    if (!isRecord(entry) || !isSemver(entry['parserVersion'])) {
      throw invalid(`submission ${submissionIndex} ${path} evidence requires a parser version`)
    }
    if (entry['kind'] === 'web_page') {
      if (typeof entry['url'] !== 'string' || !entry['url'].startsWith('https://')
        || !isResourceRef(entry['snapshotRef']) || !isResourceRef(entry['snapshotManifestRef'])
        || !isSha256Digest(entry['contentDigest']) || !isInstant(entry['fetchedAt'])) {
        throw invalid(`submission ${submissionIndex} ${path} web page evidence is malformed`)
      }
      continue
    }
    if (entry['kind'] === 'located_span') {
      if (!isResourceRef(entry['sourceRef']) || !isRecord(entry['span'])) {
        throw invalid(`submission ${submissionIndex} ${path} located span evidence is malformed`)
      }
      continue
    }
    throw invalid(`submission ${submissionIndex} ${path} evidence kind is not known`)
  }
}

function assertSourceOrigin(origin: unknown, submissionIndex: number): void {
  if (!isRecord(origin)) throw invalid(`source submission ${submissionIndex} requires an origin`)
  if (origin['url'] !== undefined && (typeof origin['url'] !== 'string' || !origin['url'].startsWith('https://'))) {
    throw invalid(`source submission ${submissionIndex} origin url must be https`)
  }
  if (origin['publisher'] !== undefined && !isNonEmptyString(origin['publisher'])) {
    throw invalid(`source submission ${submissionIndex} origin publisher must be non-empty`)
  }
  if (origin['standardRef'] !== undefined && !isResourceRef(origin['standardRef'])) {
    throw invalid(`source submission ${submissionIndex} origin standardRef is malformed`)
  }
  if (origin['fetchedAt'] !== undefined && !isInstant(origin['fetchedAt'])) {
    throw invalid(`source submission ${submissionIndex} origin fetchedAt must be an instant`)
  }
}

function assertDefinitionSubmission(entry: Record<string, unknown>, submissionIndex: number): void {
  if (!SOURCE_KINDS.includes(entry['definitionKind'] as DefinitionCandidateKind)) {
    throw invalid(`definition submission ${submissionIndex} has an unknown definition kind`)
  }
  const payload = entry['payload']
  if (!isRecord(payload) || payload['kind'] !== entry['definitionKind'] || !isNonEmptyString(payload['logicalId'])) {
    throw invalid(`definition submission ${submissionIndex} payload does not match its kind`)
  }
}

function assertRuleSubmission(entry: Record<string, unknown>, submissionIndex: number): void {
  const payload = entry['payload']
  if (!isRecord(payload) || !isNonEmptyString(payload['ruleId']) || !isRecord(payload['applicability'])
    || !isRecord(payload['condition']) || !Array.isArray(payload['exceptions'])) {
    throw invalid(`rule submission ${submissionIndex} payload is malformed`)
  }
  const dependencies = payload['ruleDependencies']
  const dependencyRefs = payload['dependencyRefs']
  if (!Array.isArray(dependencies) || dependencies.length > 16
    || dependencies.some((id) => !isNonEmptyString(id)) || new Set(dependencies).size !== dependencies.length) {
    throw invalid(`rule submission ${submissionIndex} ruleDependencies must be at most 16 distinct ids`)
  }
  if (dependencyRefs !== undefined && (!Array.isArray(dependencyRefs) || dependencyRefs.length !== dependencies.length)) {
    throw invalid(`rule submission ${submissionIndex} must pin every declared dependency`)
  }
}

function assertActionSubmission(entry: Record<string, unknown>, submissionIndex: number): void {
  const declaration = entry['declaration']
  if (!isRecord(declaration) || !isNonEmptyString(declaration['actionId'])) {
    throw invalid(`action submission ${submissionIndex} requires a declaration`)
  }
  if (!isVersionRef(declaration['inputSchemaRef']) || !isVersionRef(declaration['outputSchemaRef'])
    || !Array.isArray(declaration['requiredCapabilities']) || typeof declaration['readOnly'] !== 'boolean') {
    throw invalid(`action submission ${submissionIndex} declaration is malformed`)
  }
  if (declaration['suggestedOperationRef'] !== undefined && !isRecord(declaration['suggestedOperationRef'])) {
    throw invalid(`action submission ${submissionIndex} suggested operator reference is malformed`)
  }
}

function invalid(message: string): SubmitCandidatesError {
  return new SubmitCandidatesError('INVALID_COMMAND', message)
}

/**
 * Validate a model-authored `submit_candidates@1` command before the service acts on it. It
 * rejects a forged trusted field and any candidate without evidence, so an ungrounded or
 * self-authorized submission never reaches persistence.
 */
export function assertSubmitCandidatesCommandShape(
  value: unknown,
): asserts value is SubmitCandidatesCommand {
  if (!isRecord(value) || value['schemaVersion'] !== 'submit-candidates@1'
    || value['commandKind'] !== 'submit_candidates' || !isUuid(value['workspaceId'])) {
    throw invalid('a submit_candidates@1 command requires a workspaceId, commandKind and schemaVersion')
  }
  const forbidden = findForbiddenModelFields(value['candidates'])
  if (forbidden.length > 0) {
    throw new SubmitCandidatesError('FORBIDDEN_MODEL_FIELD', `the model may not supply ${forbidden[0]?.field}`)
  }
  const candidates = value['candidates']
  if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > 500) {
    throw invalid('a submit_candidates command must carry 1..500 candidates')
  }
  if (value['note'] !== undefined && (!isNonEmptyString(value['note']) || value['note'].length > 4000)) {
    throw invalid('a submit_candidates note must be a bounded non-empty string')
  }
  candidates.forEach((entry, index) => {
    if (!isRecord(entry) || !isNonEmptyString(entry['reason']) || entry['reason'].length > 4000) {
      throw invalid(`submission ${index} requires a bounded reason`)
    }
    assertEvidence(entry['evidence'], 'evidence', index)
    switch (entry['kind']) {
      case 'source':
        assertSourceOrigin(entry['origin'], index)
        return
      case 'definition':
        assertDefinitionSubmission(entry, index)
        return
      case 'rule':
        assertRuleSubmission(entry, index)
        return
      case 'action':
        assertActionSubmission(entry, index)
        return
      default:
        throw invalid(`submission ${index} kind is not known`)
    }
  })
}

/** Runtime validation of a persisted receipt before it is returned to the runtime. */
export function assertSubmitCandidatesReceiptShape(
  value: unknown,
): asserts value is SubmitCandidatesReceipt {
  if (!isRecord(value) || value['schemaVersion'] !== 'submit-candidates-receipt@1'
    || !isUuid(value['runId']) || !isUuid(value['workspaceId'])
    || typeof value['commandDigest'] !== 'string' || !SHA256_PATTERN.test(value['commandDigest'])
    || typeof value['replayed'] !== 'boolean' || !isNonEmptyString(value['recordedAt'])) {
    throw new SubmitCandidatesError('STORE_FAILED', 'invalid submit_candidates receipt')
  }
  const accepted = value['accepted']
  const rejected = value['rejected']
  if (!Array.isArray(accepted) || !accepted.every((entry) => isRecord(entry)
    && Number.isSafeInteger(entry['submissionIndex']) && isUuid(entry['candidateId'])
    && CANDIDATE_SUBMISSION_KINDS.includes(entry['kind'] as CandidateSubmissionKind)
    && isNonEmptyString(entry['state']) && typeof entry['pendingConfirmation'] === 'boolean')) {
    throw new SubmitCandidatesError('STORE_FAILED', 'invalid accepted candidate receipt entry')
  }
  if (!Array.isArray(rejected) || !rejected.every((entry) => isRecord(entry)
    && Number.isSafeInteger(entry['submissionIndex']) && isNonEmptyString(entry['code']) && isNonEmptyString(entry['message']))) {
    throw new SubmitCandidatesError('STORE_FAILED', 'invalid candidate rejection entry')
  }
}
