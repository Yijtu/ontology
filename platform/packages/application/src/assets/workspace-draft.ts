import type { AssetDraftVersion, IndustryWorkspaceStore, ScopeRef, ToolContext, Uuid } from '@ontology/contracts'

/** Production stores use DESC/LIMIT 1; legacy test stores may expose their complete history. */
export async function readLatestWorkspaceDraft(store: Pick<IndustryWorkspaceStore, 'listDrafts' | 'getLatestDraft'>,
  scope: ScopeRef, workspaceId: Uuid, ctx: ToolContext): Promise<AssetDraftVersion | undefined> {
  if (store.getLatestDraft !== undefined) return store.getLatestDraft(scope, workspaceId, ctx)
  const drafts = await store.listDrafts(scope, workspaceId, ctx)
  return drafts.reduce<AssetDraftVersion | undefined>((latest, draft) =>
    latest === undefined || BigInt(draft.revision) > BigInt(latest.revision) ? draft : latest, undefined)
}
