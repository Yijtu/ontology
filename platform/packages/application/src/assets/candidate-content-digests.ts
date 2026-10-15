import type { AssetCandidateVersion, ResourceRef, RevisionString, RuleActionCandidateVersion, RuleActionGenerationContext, CandidateSourceSpan, Sha256Digest, Uuid } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../extraction/canonical'

type DefinitionDigestInput = Pick<AssetCandidateVersion, 'workspaceId' | 'logicalId' | 'kind' | 'payload' | 'inputDraftRef' | 'sourceRefs' | 'sourceSpans' | 'issues'>

/** Exact producer envelope, shared by generation and authoritative read-back verification. */
export function definitionGeneratedContentDigest(input: DefinitionDigestInput): Sha256Digest {
  const { workspaceId, logicalId, kind, payload, inputDraftRef, sourceRefs, sourceSpans, issues } = input
  return sha256DigestOf(canonicalJson({ workspaceId, logicalId, kind, payload, inputDraftRef, sourceRefs, sourceSpans, issues }))
}

/** Editing intentionally preserves its existing envelope (source spans are pinned separately). */
export function definitionEditedContentDigest(input: Omit<DefinitionDigestInput, 'sourceSpans'>): Sha256Digest {
  const { workspaceId, logicalId, kind, payload, inputDraftRef, sourceRefs, issues } = input
  return sha256DigestOf(canonicalJson({ workspaceId, logicalId, kind, payload, inputDraftRef, sourceRefs, issues }))
}

export interface RuleActionDeclaredDigestInput {
  readonly workspaceId: Uuid
  readonly logicalId: string
  readonly kind: 'rule' | 'action'
  readonly payload: unknown
  readonly sourceRefs: readonly ResourceRef[]
  readonly sourceSpans: readonly CandidateSourceSpan[]
  readonly generationContext?: RuleActionGenerationContext
  readonly draftRevision: RevisionString
  readonly draftDigest: Sha256Digest
}

/** Exact manual declaration/edit producer, including the real draft and source pins. */
export function ruleActionDeclaredContentDigest(input: RuleActionDeclaredDigestInput): Sha256Digest {
  const { workspaceId, logicalId, kind, payload, sourceRefs, sourceSpans, generationContext, draftRevision, draftDigest } = input
  return sha256DigestOf(canonicalJson({ workspaceId, logicalId, kind, payload, sourceRefs, sourceSpans,
    ...(generationContext === undefined ? {} : { generationContext }), draftRevision, draftDigest }))
}

/** Exact grounded generation AND human reground envelope, retaining business and clause origin. */
export function ruleActionGroundedContentDigest(input: Pick<RuleActionCandidateVersion, 'workspaceId' | 'kind' | 'logicalId' | 'displayName' | 'businessMeaning' | 'suggestedReason' | 'payload' | 'sourceRefs' | 'sourceSpans' | 'generationContext'>): Sha256Digest {
  const { workspaceId, kind, logicalId, displayName, businessMeaning, suggestedReason, payload, sourceRefs, sourceSpans, generationContext } = input
  return sha256DigestOf(canonicalJson({ workspaceId, kind, logicalId, displayName, businessMeaning, suggestedReason, payload, sourceRefs, sourceSpans, generationContext }))
}
