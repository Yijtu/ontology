import type { AssetCandidateBatch, AssetCandidateCommitPin, DefinitionCandidateInputDraftRef } from './asset-candidates'
import type { RuleActionCandidateVersion } from './rule-action-candidates'
import type { ResourceRef, RevisionString, ScopeRef, Sha256Digest, Uuid, VersionRef } from './generated/contracts'
import type { ToolContext } from './trusted'
import type { CandidateSourceSpan } from './extraction'
import { assertAssetCandidateBatchShape } from './asset-candidates'
import { isResourceRef, isSha256Digest, isUuid } from './asset-workspace'

export function assertRuleActionGenerationBatch(value: unknown): asserts value is RuleActionGenerationBatch {
  assertAssetCandidateBatchShape(value)
  if (typeof value !== 'object' || value === null || !('generationFamily' in value) || value.generationFamily !== 'rule_action' ||
    !('contextDigest' in value) || !isSha256Digest(value.contextDigest) ||
    !('candidateIds' in value) || !Array.isArray(value.candidateIds) || value.candidateIds.length > 100 || value.candidateIds.some((id: unknown) => !isUuid(id)) || new Set(value.candidateIds).size !== value.candidateIds.length ||
    !('sourceRefs' in value) || !Array.isArray(value.sourceRefs) || value.sourceRefs.length > 64 || value.sourceRefs.some((ref: unknown) => !isResourceRef(ref))) {
    throw new Error('invalid rule/action generation batch')
  }
  if ('sourceConfirmationOf' in value && value.sourceConfirmationOf !== undefined) {
    const pin = value.sourceConfirmationOf
    if (typeof pin !== 'object' || pin === null || !('candidateId' in pin) || !isUuid(pin.candidateId) ||
      !('contentDigest' in pin) || !isSha256Digest(pin.contentDigest) || !('reason' in pin) || typeof pin.reason !== 'string' || pin.reason.trim().length === 0 || pin.reason.length > 2000) throw new Error('invalid source confirmation input pin')
  }
}

/** Model selections are indices into host-read fragments, never model-authored locators. */
export interface RuleActionSourceSelection {
  readonly path: string
  readonly sourceIndex: number
  readonly fragmentIndex: number
}

export interface RuleActionGenerationIssue {
  readonly code: 'SOURCE_UNRESOLVED' | 'SOURCE_INCOMPLETE' | 'TERM_UNRESOLVED' | 'DEPENDENCY_UNRESOLVED'
  readonly path: string
  readonly message: string
}

export interface RuleActionGenerationContext {
  /** Actual ordered corpus and resolved clause pins, independent of compacted candidate refs. */
  readonly inputSourceRefs: readonly ResourceRef[]
  readonly sourceBindings: readonly { readonly path: string; readonly sourceRef: ResourceRef; readonly sourceSpan: CandidateSourceSpan }[]
  readonly batchId: Uuid
  readonly inputDraftRef: DefinitionCandidateInputDraftRef
  readonly contextDigest: Sha256Digest
  readonly issues: readonly RuleActionGenerationIssue[]
  readonly sourceSelections: readonly RuleActionSourceSelection[]
}

/** Reuses the existing generation batch table; it carries no approval or execution authority. */
export interface RuleActionGenerationBatch extends AssetCandidateBatch {
  readonly sourceConfirmationOf?: { readonly candidateId: Uuid; readonly contentDigest: Sha256Digest; readonly reason: string }
  readonly generationFamily: 'rule_action'
  readonly contextDigest: Sha256Digest
  readonly sourceRefs: readonly ResourceRef[]
  readonly candidateIds: readonly Uuid[]
}

export interface RuleActionGenerationGuard {
  readonly latestPublishedPackRef: VersionRef | undefined
  readonly expectedWorkspaceRevision: RevisionString
  readonly inputDraftRef: DefinitionCandidateInputDraftRef
  readonly documentSetRef: ResourceRef
  readonly definitionPins: readonly AssetCandidateCommitPin[]
  readonly ruleActionPins: readonly RuleActionCandidateVersion[]
  readonly signal: AbortSignal
}

export interface RuleActionGenerationStore {
  find(scope: ScopeRef, key: string, ctx: ToolContext): Promise<RuleActionGenerationBatch | undefined>
  /** Read the immutable saved batch pinned by a candidate's generation context. */
  getById(scope: ScopeRef, batchId: Uuid, ctx: ToolContext): Promise<RuleActionGenerationBatch | undefined>
  commit(scope: ScopeRef, batch: RuleActionGenerationBatch, candidates: readonly RuleActionCandidateVersion[],
    guard: RuleActionGenerationGuard, ctx: ToolContext): Promise<{ readonly batch: RuleActionGenerationBatch; readonly candidates: readonly RuleActionCandidateVersion[]; readonly created: boolean }>
}
