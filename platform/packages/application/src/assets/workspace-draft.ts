import { assetDraftContent } from '@ontology/contracts'
import type { AssetDraftCandidateRef, AssetDraftVersion, IndustryWorkspaceStore, ResourceRef,
  RevisionString, ScopeRef, ToolContext, Uuid, VersionRef } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/** Production stores use DESC/LIMIT 1; legacy test stores may expose their complete history. */
export async function readLatestWorkspaceDraft(store: Pick<IndustryWorkspaceStore, 'listDrafts' | 'getLatestDraft'>,
  scope: ScopeRef, workspaceId: Uuid, ctx: ToolContext): Promise<AssetDraftVersion | undefined> {
  if (store.getLatestDraft !== undefined) return store.getLatestDraft(scope, workspaceId, ctx)
  const drafts = await store.listDrafts(scope, workspaceId, ctx)
  return drafts.reduce<AssetDraftVersion | undefined>((latest, draft) =>
    latest === undefined || BigInt(draft.revision) > BigInt(latest.revision) ? draft : latest, undefined)
}

/** The next immutable draft revision after `headRevision`. */
export function nextDraftRevision(headRevision: RevisionString): RevisionString {
  return (BigInt(headRevision) + 1n).toString()
}

export interface AssetDraftFields {
  readonly documentSetRef: ResourceRef
  readonly candidateRefs?: readonly AssetDraftCandidateRef[]
  readonly basePackRef?: VersionRef
  readonly syntheticExampleSetRef?: ResourceRef
  readonly validationRef?: ResourceRef
}

function sortedCandidateRefs(refs: readonly AssetDraftCandidateRef[]): AssetDraftCandidateRef[] {
  return [...refs].sort((left, right) =>
    left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0)
}

/**
 * Build one immutable draft revision with a content digest. This is the single builder shared by
 * the workspace edit path and the source-admission path, so a draft admitted from a reviewed source
 * hashes exactly like one appended by an editor.
 */
export function buildAssetDraft(workspaceId: Uuid, revision: RevisionString, fields: AssetDraftFields): AssetDraftVersion {
  const content = {
    workspaceId,
    revision,
    documentSetRef: fields.documentSetRef,
    candidateRefs: sortedCandidateRefs(fields.candidateRefs ?? []),
    ...(fields.basePackRef === undefined ? {} : { basePackRef: fields.basePackRef }),
    ...(fields.syntheticExampleSetRef === undefined ? {} : { syntheticExampleSetRef: fields.syntheticExampleSetRef }),
    ...(fields.validationRef === undefined ? {} : { validationRef: fields.validationRef }),
  }
  return { ...content, digest: sha256DigestOf(canonicalJson(assetDraftContent(content))) }
}
