import {
  isAssetCandidateState,
  isDefinitionCandidateKind,
  isDefinitionCandidatePayload,
  isRecord,
  isRevisionString,
  isRuleActionCandidateKind,
  isRuleActionCandidateLifecycle,
  isSha256Digest,
  isUuid,
} from '@ontology/contracts'
import type {
  ActionCandidatePayload,
  ActionDeclaration,
  AssetCandidateBatch,
  AssetCandidateVersion,
  DefinitionCandidateKind,
  DefinitionCandidatePayload,
  DefinitionCompatibilityReport,
  DefinitionEditAdjudication,
  DefinitionEditingResult,
  DefinitionRevisionStrategy,
  DefinitionValidationReport,
  ResourceRef,
  RevisionString,
  RuleActionCandidateLifecycle,
  RuleActionCandidateVersion,
  RuleCandidatePayload,
  UnsupportedDefinitionRule,
} from '@ontology/contracts'

/**
 * Wire shapes and runtime guards for the definition / rule / action review workbench
 * (V03-012 / #185, SPEC v0.3a §3.1/§3.3/§8.1).
 *
 * The browser talks to the API over HTTP only, so these shapes are declared here instead of
 * importing the application package. Every response passes a guard before it is rendered: a
 * well-formed envelope wrapping an unknown body is an explicit failure, never a guessed
 * candidate that could later be edited or approved under the wrong revision.
 */

/** The lean candidate revision an edit/merge/split returns (no batch/source echo). */
export interface EditedDefinitionCandidate {
  readonly candidateId: string
  readonly workspaceId: string
  readonly logicalId: string
  readonly kind: DefinitionCandidateKind
  readonly state: AssetCandidateVersion['state']
  readonly payload: DefinitionCandidatePayload
  readonly replacesCandidateId?: string
  readonly contentDigest: string
}

/** A rule/action edit or enable result carries one immutable candidate revision. */
export interface RuleActionCandidateView {
  readonly candidate: RuleActionCandidateVersion
  readonly created: boolean
}

export interface DefinitionCandidateFilter {
  readonly kind?: DefinitionCandidateKind
  readonly state?: AssetCandidateVersion['state']
  readonly limit?: number
}

export interface RuleActionCandidateFilter {
  readonly kind?: 'rule' | 'action'
  readonly lifecycle?: RuleActionCandidateLifecycle
  readonly limit?: number
}

export interface EditDefinitionCandidateRequest {
  readonly expectedRevision: RevisionString
  readonly payload: DefinitionCandidatePayload
  readonly reason: string
}

export interface MergeDefinitionCandidatesRequest {
  readonly expectedRevision: RevisionString
  readonly candidateIds: readonly string[]
  readonly mergedPayload: DefinitionCandidatePayload
  readonly reason: string
}

export interface KeepDefinitionsSeparateRequest {
  readonly expectedRevision: RevisionString
  readonly candidateIds: readonly string[]
  readonly reason: string
}

export interface RejectDefinitionCandidateRequest {
  readonly expectedRevision: RevisionString
  readonly reason: string
}

export interface ValidateDefinitionsRequest {
  readonly revision: RevisionString
  readonly strategy?: DefinitionRevisionStrategy
}

export interface RecordUnsupportedRuleRequest {
  readonly ruleId: string
  readonly reason: string
  readonly rawForm: unknown
  readonly sourceCandidateId?: string
}

/**
 * One rule or action to revise. It is the flat model-output shape the server re-parses and
 * re-validates, so a human edit goes through exactly the same support/binding checks as a model
 * response and never bypasses the finite-grammar or capability gate.
 */
export interface RuleCandidateDraft {
  readonly ruleId: string
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly objectId: string
  readonly applicabilityNote?: string
  readonly condition: unknown
  readonly exceptions: readonly unknown[]
  readonly conclusion?: unknown
  readonly ruleDependencies?: readonly string[]
}

export interface ActionCandidateDraft {
  readonly actionId: string
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly inputSchemaRef: { readonly id: string; readonly version: string; readonly digest: string }
  readonly outputSchemaRef: { readonly id: string; readonly version: string; readonly digest: string }
  readonly preconditions: readonly string[]
  readonly requiredCapabilities: readonly { readonly name: string; readonly versionRange: { readonly min: string; readonly max?: string } }[]
  readonly permissions: readonly string[]
  readonly readOnly: boolean
  readonly sideEffect: 'none' | 'read_only' | 'writes' | 'external'
  readonly evidenceRequirements: readonly string[]
  readonly suggestedOperationRef?: { readonly id: string; readonly version: string }
}

export interface EditRuleCandidateRequest {
  readonly expectedRevision: RevisionString
  readonly rule: RuleCandidateDraft
  readonly reason: string
  readonly sourceRefs?: readonly ResourceRef[]
}

export interface EditActionCandidateRequest {
  readonly expectedRevision: RevisionString
  readonly action: ActionCandidateDraft
  readonly reason: string
  readonly sourceRefs?: readonly ResourceRef[]
}

export interface EnableRuleActionCandidateRequest {
  readonly expectedRevision: RevisionString
}

export type CandidateLifecycleView = RuleActionCandidateView

function isAssetCandidateVersion(value: unknown): value is AssetCandidateVersion {
  if (!isRecord(value)) return false
  if (!isUuid(value['candidateId']) || !isUuid(value['workspaceId'])) return false
  if (typeof value['logicalId'] !== 'string' || value['logicalId'].length === 0) return false
  if (value['domain'] !== 'definition') return false
  if (!isDefinitionCandidateKind(value['kind'])) return false
  if (!isAssetCandidateState(value['state'])) return false
  if (!isDefinitionCandidatePayload(value['payload'])) return false
  if (!Array.isArray(value['sourceRefs']) || !Array.isArray(value['issues'])) return false
  if (!isRecord(value['inputDraftRef'])) return false
  return true
}

function isAssetCandidateBatch(value: unknown): value is AssetCandidateBatch {
  if (!isRecord(value)) return false
  if (!isUuid(value['batchId']) || !isUuid(value['workspaceId'])) return false
  if (value['domain'] !== 'definition') return false
  if (!isRecord(value['inputDraftRef'])) return false
  if (typeof value['state'] !== 'string') return false
  if (!isRecord(value['counts'])) return false
  return typeof value['idempotencyKey'] === 'string'
}

function isRuleActionCandidatePayload(
  value: unknown,
): value is RuleCandidatePayload | ActionCandidatePayload {
  if (!isRecord(value)) return false
  const kind = value['kind']
  if (kind === 'rule') {
    return (
      typeof value['ruleId'] === 'string' &&
      isRecord(value['applicability']) &&
      isRecord(value['condition']) &&
      Array.isArray(value['exceptions']) &&
      isRecord(value['support']) &&
      typeof (value['support'] as Record<string, unknown>)['executable'] === 'boolean'
    )
  }
  if (kind === 'action') {
    if (!isRecord(value['declaration'])) return false
    const binding = value['binding']
    if (binding === undefined) return true
    return (
      isRecord(binding) &&
      (binding['status'] === 'executable' || binding['status'] === 'not_executable') &&
      typeof binding['executable'] === 'boolean'
    )
  }
  return false
}

function isRuleActionCandidateVersion(value: unknown): value is RuleActionCandidateVersion {
  if (!isRecord(value)) return false
  if (!isUuid(value['candidateId']) || !isUuid(value['workspaceId'])) return false
  if (typeof value['logicalId'] !== 'string' || value['logicalId'].length === 0) return false
  if (value['domain'] !== 'definition') return false
  if (!isRuleActionCandidateKind(value['kind'])) return false
  if (!isRuleActionCandidateLifecycle(value['lifecycle'])) return false
  if (typeof value['displayName'] !== 'string' || value['displayName'].length === 0) return false
  if (typeof value['businessMeaning'] !== 'string') return false
  if (typeof value['suggestedReason'] !== 'string') return false
  if (!isRuleActionCandidatePayload(value['payload'])) return false
  if (!Array.isArray(value['sourceRefs'])) return false
  return isSha256Digest(value['contentDigest'])
}

function isEditedDefinitionCandidate(value: unknown): value is EditedDefinitionCandidate {
  if (!isRecord(value)) return false
  if (!isUuid(value['candidateId']) || !isUuid(value['workspaceId'])) return false
  if (!isDefinitionCandidateKind(value['kind'])) return false
  if (!isAssetCandidateState(value['state'])) return false
  if (!isDefinitionCandidatePayload(value['payload'])) return false
  return isSha256Digest(value['contentDigest'])
}

function isDefinitionEditAdjudication(value: unknown): value is DefinitionEditAdjudication {
  if (!isRecord(value)) return false
  if (!isUuid(value['adjudicationId'])) return false
  if (typeof value['kind'] !== 'string' || typeof value['reason'] !== 'string') return false
  if (!Array.isArray(value['candidateIds']) || !Array.isArray(value['producedCandidateIds'])) return false
  if (!Array.isArray(value['affected']) || !Array.isArray(value['findings'])) return false
  return isRecord(value['compatibility'])
}

function isDefinitionEditingResult(value: unknown): value is DefinitionEditingResult {
  if (!isRecord(value)) return false
  if (!isDefinitionEditAdjudication(value['adjudication'])) return false
  if (typeof value['created'] !== 'boolean') return false
  if (!Array.isArray(value['candidates'])) return false
  return value['candidates'].every(isEditedDefinitionCandidate)
}

function isDefinitionCompatibilityReport(value: unknown): value is DefinitionCompatibilityReport {
  if (!isRecord(value)) return false
  if (!isUuid(value['workspaceId']) || !isRevisionString(value['revision'])) return false
  if (!Array.isArray(value['additions']) || !Array.isArray(value['changes'])) return false
  if (!Array.isArray(value['breakingChanges'])) return false
  return typeof value['requiresRevisionStrategy'] === 'boolean'
}

function isDefinitionValidationReport(value: unknown): value is DefinitionValidationReport {
  if (!isRecord(value)) return false
  if (!isUuid(value['workspaceId']) || !isRevisionString(value['revision'])) return false
  if (!Array.isArray(value['blockers']) || !Array.isArray(value['warnings'])) return false
  if (!Array.isArray(value['checkedCandidateIds'])) return false
  if (!Array.isArray(value['nonExecutableRules'])) return false
  if (!isDefinitionCompatibilityReport(value['compatibility'])) return false
  return typeof value['publishable'] === 'boolean'
}

function isUnsupportedDefinitionRule(value: unknown): value is UnsupportedDefinitionRule {
  if (!isRecord(value)) return false
  if (typeof value['ruleId'] !== 'string' || value['ruleId'].length === 0) return false
  if (!isUuid(value['workspaceId'])) return false
  if (value['executable'] !== false) return false
  if (typeof value['reason'] !== 'string') return false
  return 'rawForm' in value
}

function isCandidateLifecycleView(value: unknown): value is CandidateLifecycleView {
  if (!isRecord(value)) return false
  return isRuleActionCandidateVersion(value['candidate']) && typeof value['created'] === 'boolean'
}

export const definitionGuard = {
  assetCandidateVersion: isAssetCandidateVersion,
  assetCandidateBatch: isAssetCandidateBatch,
  ruleActionCandidateVersion: isRuleActionCandidateVersion,
  definitionEditAdjudication: isDefinitionEditAdjudication,
  definitionEditingResult: isDefinitionEditingResult,
  definitionCompatibilityReport: isDefinitionCompatibilityReport,
  definitionValidationReport: isDefinitionValidationReport,
  unsupportedDefinitionRule: isUnsupportedDefinitionRule,
  candidateLifecycleView: isCandidateLifecycleView,
}

export type {
  ActionCandidatePayload,
  ActionDeclaration,
  AssetCandidateBatch,
  AssetCandidateVersion,
  DefinitionCandidateKind,
  DefinitionCandidatePayload,
  DefinitionCompatibilityReport,
  DefinitionEditAdjudication,
  DefinitionEditingResult,
  DefinitionRevisionStrategy,
  DefinitionValidationReport,
  RuleActionCandidateVersion,
  UnsupportedDefinitionRule,
}
