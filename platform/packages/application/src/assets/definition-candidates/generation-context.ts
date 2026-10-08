import type { AssetCandidateVersion } from '@ontology/contracts'
import { canonicalJson } from '../../extraction/canonical'

/** Model context contains semantics, not its own changing candidate/audit identities. */
export function semanticDraftContext(candidates: readonly AssetCandidateVersion[]): unknown {
  const declarations = candidates.map((candidate) => {
    const { conflicts, ...body } = candidate.payload
    return { logicalId: candidate.logicalId, kind: candidate.kind,
      payload: { ...body, conflicts: conflicts.map((conflict) => conflict.kind === 'human_edit_conflict'
        ? { kind: conflict.kind, relatedLogicalIds: conflict.relatedLogicalIds, proposedDefinition: conflict.proposedDefinition }
        : { kind: conflict.kind, relatedLogicalIds: conflict.relatedLogicalIds, message: conflict.message }) },
      state: candidate.state, issues: candidate.issues, pendingConfirmation: candidate.pendingConfirmation,
      sourceRefs: candidate.sourceRefs, sourceSpans: candidate.sourceSpans }
  })
  declarations.sort((left, right) => {
    const a = `${left.kind}\u0000${left.logicalId}\u0000${canonicalJson(left)}`
    const b = `${right.kind}\u0000${right.logicalId}\u0000${canonicalJson(right)}`
    return a < b ? -1 : a > b ? 1 : 0
  })
  return { trust: 'untrusted_proposed_semantics', status: 'not_published_truth', candidates: declarations }
}
