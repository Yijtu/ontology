import type { AssetCandidateVersion } from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'

function reusableContent(candidate: AssetCandidateVersion): unknown {
  return { payload: candidate.payload, inputDraftRef: candidate.inputDraftRef, issues: candidate.issues,
    state: candidate.state, pendingConfirmation: candidate.pendingConfirmation,
    sourceRefs: candidate.sourceRefs, sourceSpans: candidate.sourceSpans }
}

/** Replacement heads include rejection: regeneration cannot resurrect an approved ancestor. */
export function candidateHeads(history: readonly AssetCandidateVersion[]): AssetCandidateVersion[] {
  const replaced = new Set(history.flatMap((candidate) => candidate.replacesCandidateId === undefined ? [] : [candidate.replacesCandidateId]))
  return history.filter((candidate) => !replaced.has(candidate.candidateId))
}

export function rebaseDefinitionCandidates(proposed: readonly AssetCandidateVersion[], history: readonly AssetCandidateVersion[]): {
  readonly appended: readonly AssetCandidateVersion[]
  readonly reused: readonly AssetCandidateVersion[]
} {
  const heads = candidateHeads(history)
  const appended: AssetCandidateVersion[] = []
  const reused: AssetCandidateVersion[] = []
  for (const candidate of proposed) {
    const matches = heads.filter((current) => current.logicalId === candidate.logicalId)
    const current = matches.length === 1 ? matches[0] : undefined
    if (current !== undefined && current.kind === candidate.kind &&
      canonicalJson(reusableContent(current)) === canonicalJson(reusableContent(candidate))) {
      reused.push(current)
      continue
    }
    if (current === undefined && matches.length === 0) { appended.push(candidate); continue }
    // Human content survives a fresh model proposal. The difference becomes an explicit
    // reviewable conflict in a new revision, whose approval never carries over.
    const human = current !== undefined && current.generationCallRef === undefined
    const conflicting = matches.length > 1 || current?.kind !== candidate.kind
    const { conflicts: _proposedConflicts, ...proposedDefinition } = candidate.payload
    void _proposedConflicts
    const payload = human ? { ...current.payload, conflicts: [...current.payload.conflicts.filter((conflict) => conflict.kind !== 'human_edit_conflict'),
      { kind: 'human_edit_conflict' as const, relatedLogicalIds: [candidate.logicalId],
        message: 'Regeneration proposed different content or context; the human content was retained and new grounding/validation pins require review.',
        proposedContentDigest: candidate.contentDigest, proposedDefinition }] } : candidate.payload
    const issues = conflicting ? [...candidate.issues, { code: 'LOGICAL_ID_COLLISION' as const,
      message: 'regeneration cannot resolve multiple current revisions or change definition kind', path: 'logicalId' }]
      : human ? [...candidate.issues, { code: 'REBASE_CONFLICT' as const,
        message: 'human content was preserved; adjudicate the changed generation before approval', path: 'payload' }] : candidate.issues
    const groundedHuman = human && canonicalJson(current.sourceRefs) === canonicalJson(candidate.sourceRefs)
      && canonicalJson(current.sourceSpans) === canonicalJson(candidate.sourceSpans)
    const sourceRefs = human && !groundedHuman ? [] : candidate.sourceRefs
    const sourceSpans = human && !groundedHuman ? [] : candidate.sourceSpans
    const pendingConfirmation = sourceRefs.length === 0 || sourceSpans.length === 0
    const { generationCallRef, ...base } = candidate
    const shell = { ...base, kind: payload.kind, payload, issues, sourceRefs, sourceSpans, pendingConfirmation,
      state: conflicting ? 'failed' as const : pendingConfirmation ? 'pending_confirmation' as const : human ? 'pending_review' as const : candidate.state,
      ...(current === undefined ? {} : { replacesCandidateId: current.candidateId }),
      ...(human || generationCallRef === undefined ? {} : { generationCallRef }) }
    if (current !== undefined && canonicalJson(reusableContent(current)) === canonicalJson(reusableContent(shell))) {
      reused.push(current)
      continue
    }
    const contentDigest = sha256DigestOf(canonicalJson({ workspaceId: shell.workspaceId, logicalId: shell.logicalId,
      kind: shell.kind, payload, inputDraftRef: shell.inputDraftRef, sourceRefs: shell.sourceRefs,
      sourceSpans: shell.sourceSpans, issues, replacesCandidateId: shell.replacesCandidateId }))
    const idempotencyKey = sha256DigestOf(canonicalJson({ generation: candidate.idempotencyKey, contentDigest }))
    appended.push({ ...shell, contentDigest, idempotencyKey, candidateId: candidateIdFor(idempotencyKey) })
  }
  return { appended, reused }
}
