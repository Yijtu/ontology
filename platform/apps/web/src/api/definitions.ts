import {
  isAssetCandidateState,
  isDefinitionCandidateKind,
  isDefinitionCandidatePayload,
  isRecord,
  isResourceRef,
  isVersionRef,
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
  RuleDependencyCandidateReference,
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
  readonly dependencyRefs?: readonly RuleDependencyCandidateReference[]
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
  readonly taskBindingRef?: { readonly id: string; readonly version: string; readonly digest: string }
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
  if (!isDefinitionCandidatePayload(value['payload']) || value['payload'].kind !== value['kind'] || value['payload'].logicalId !== value['logicalId']) return false
  if (!Array.isArray(value['sourceRefs']) || !value['sourceRefs'].every(isResourceRef) || !Array.isArray(value['sourceSpans']) || !Array.isArray(value['issues']) || !value['issues'].every((v: unknown) => isRecord(v) && typeof v['message'] === 'string' && typeof v['code'] === 'string')) return false
  if (!isRecord(value['inputDraftRef']) || value['inputDraftRef']['workspaceId'] !== value['workspaceId'] || !isRevisionString(value['inputDraftRef']['revision']) || !isSha256Digest(value['inputDraftRef']['digest'])) return false
  return isSha256Digest(value['contentDigest']) && typeof value['pendingConfirmation'] === 'boolean'
}

function isAssetCandidateBatch(value: unknown): value is AssetCandidateBatch {
  if (!isRecord(value)) return false
  if (!isUuid(value['batchId']) || !isUuid(value['workspaceId'])) return false
  if (value['domain'] !== 'definition') return false
  if (!isRecord(value['inputDraftRef'])) return false
  if (typeof value['state'] !== 'string') return false
  const counts = value['counts']
  if (!isRecord(counts) || !['total','produced','pendingConfirmation','pendingReview','failed'].every((key) => typeof counts[key] === 'number' && Number.isSafeInteger(counts[key]) && counts[key] >= 0)) return false
  if (value['error'] !== undefined && (!isRecord(value['error']) || typeof value['error']['code'] !== 'string' || typeof value['error']['message'] !== 'string' || typeof value['error']['retryable'] !== 'boolean')) return false
  return typeof value['idempotencyKey'] === 'string'
}

function stringList(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every((v): v is string => typeof v === 'string') }
export function isRuleExpression(value: unknown, depth = 0): boolean {
  if (depth > 64 || !isRecord(value) || !Array.isArray(value['spans'])) return false
  if (value['op'] === 'compare') return typeof value['attributeId'] === 'string' && ['eq','ne','gt','gte','lt','lte'].includes(String(value['operator'])) && (typeof value['value'] === 'string' || typeof value['value'] === 'boolean' || typeof value['value'] === 'number' && Number.isFinite(value['value']))
  if (value['op'] === 'range') return typeof value['attributeId'] === 'string' && (value['min'] === undefined || typeof value['min'] === 'number' && Number.isFinite(value['min'])) && (value['max'] === undefined || typeof value['max'] === 'number' && Number.isFinite(value['max']))
  if (value['op'] === 'relation') return typeof value['relationId'] === 'string' && (value['targetCondition'] === undefined || isRuleExpression(value['targetCondition'], depth + 1))
  if (value['op'] === 'not') return isRuleExpression(value['operand'], depth + 1)
  return (value['op'] === 'all' || value['op'] === 'any') && Array.isArray(value['operands']) && value['operands'].length <= 256 && value['operands'].every((v: unknown) => isRuleExpression(v, depth + 1))
}
function findings(value: unknown): boolean { return Array.isArray(value) && value.every((v: unknown) => isRecord(v) && typeof v['message'] === 'string' && typeof v['code'] === 'string') }
function isRuleActionCandidatePayload(value: unknown): value is RuleCandidatePayload | ActionCandidatePayload {
  if (!isRecord(value)) return false
  if (value['kind'] === 'rule') return typeof value['ruleId'] === 'string' && isRecord(value['applicability']) && typeof value['applicability']['objectId'] === 'string' && isRuleExpression(value['condition']) &&
    Array.isArray(value['exceptions']) && value['exceptions'].every((v: unknown) => isRecord(v) && typeof v['exceptionId'] === 'string' && isRuleExpression(v['condition'])) &&
    stringList(value['ruleDependencies']) && (value['dependencyRefs'] === undefined || Array.isArray(value['dependencyRefs'])) && isRecord(value['support']) && typeof value['support']['executable'] === 'boolean' && findings(value['support']['findings'])
  if (value['kind'] !== 'action' || !isRecord(value['declaration'])) return false
  const d = value['declaration']; const binding = value['binding']
  return typeof d['actionId'] === 'string' && typeof d['displayName'] === 'string' && typeof d['businessMeaning'] === 'string' && typeof d['suggestedReason'] === 'string' && isVersionRef(d['inputSchemaRef']) && isVersionRef(d['outputSchemaRef']) && stringList(d['preconditions']) && stringList(d['permissions']) && stringList(d['evidenceRequirements']) && typeof d['readOnly'] === 'boolean' && ['none','read_only','writes','external'].includes(String(d['sideEffect'])) && Array.isArray(d['requiredCapabilities']) && d['requiredCapabilities'].every((v: unknown) => isRecord(v) && typeof v['name'] === 'string' && isRecord(v['versionRange']) && typeof v['versionRange']['min'] === 'string') &&
    (binding === undefined || isRecord(binding) && ['executable','not_executable'].includes(String(binding['status'])) && typeof binding['executable'] === 'boolean' && findings(binding['findings']))
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
  if (!isRuleActionCandidatePayload(value['payload']) || value['payload'].kind !== value['kind']) return false
  if (!Array.isArray(value['sourceRefs']) || !value['sourceRefs'].every(isResourceRef) || !Array.isArray(value['sourceSpans'])) return false
  const generation = value['generationContext']
  if (generation !== undefined && (!isRecord(generation) || !isRecord(generation['inputDraftRef']) || !isRevisionString(generation['inputDraftRef']['revision']) || !Array.isArray(generation['issues']) || !generation['issues'].every((v: unknown) => isRecord(v) && typeof v['code'] === 'string' && typeof v['message'] === 'string') || !Array.isArray(generation['inputSourceRefs']) || !generation['inputSourceRefs'].every(isResourceRef))) return false
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

function isDefinitionChange(value: unknown): boolean { return isRecord(value) && typeof value['code'] === 'string' && typeof value['logicalId'] === 'string' && isDefinitionCandidateKind(value['kind']) && typeof value['breaking'] === 'boolean' && typeof value['message'] === 'string' && (value['before'] === undefined || typeof value['before'] === 'string') && (value['after'] === undefined || typeof value['after'] === 'string') }
function isDefinitionCompatibilityReport(value: unknown): value is DefinitionCompatibilityReport {
  if (!isRecord(value)) return false
  if (!isUuid(value['workspaceId']) || !isRevisionString(value['revision'])) return false
  if (!Array.isArray(value['additions']) || !value['additions'].every(isDefinitionChange) || !Array.isArray(value['changes']) || !value['changes'].every(isDefinitionChange)) return false
  if (!Array.isArray(value['breakingChanges']) || !value['breakingChanges'].every(isDefinitionChange)) return false
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
