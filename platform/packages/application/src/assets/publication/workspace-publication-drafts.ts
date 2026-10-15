import { assertAssetDraftVersionShape, assertPublishedPackAssetShape, assetDraftContent, assetDraftSourceContent, SourceGroundingError } from '@ontology/contracts'
import type { AssetCandidateStore, AssetDraftVersion, IndustryWorkspaceStore, PublishedPackAssetStore, RuleActionCandidateStore, ScopeRef, ToolContext } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../../profiles/canonical'
import { currentDefinitionProjection } from '../definition-candidates/validation'
import { currentRuleActionProjection, ruleActionPublicationPins } from './publication-pins'
import { publishedPackContentDigest } from './pack-assembly'

/** Only actual publication receipt edges can preserve an original generation source frame. */
export async function readWorkspacePublicationSourceDrafts(deps: {
  readonly workspaces: Pick<IndustryWorkspaceStore, 'getWorkspace' | 'getDraft'>
  readonly packs: Pick<PublishedPackAssetStore, 'findByRef'>
  readonly definitions: Pick<AssetCandidateStore, 'listCandidates'>
  readonly ruleActions: Pick<RuleActionCandidateStore, 'list'>
}, scope: ScopeRef, workspaceId: string, currentDraft: AssetDraftVersion, ctx: ToolContext, signal?: AbortSignal): Promise<readonly AssetDraftVersion[]> {
  const check = () => { if (signal?.aborted === true) throw new SourceGroundingError('CANCELLED', 'publication source verification was cancelled') }
  const invalid = (): never => { throw new SourceGroundingError('DOCUMENT_SET_CHANGED', 'the actual publication checkpoint does not authenticate this source draft') }
  check()
  const workspace = await deps.workspaces.getWorkspace(scope, workspaceId, ctx)
  const stored = await deps.workspaces.getDraft(scope, workspaceId, currentDraft.revision, ctx)
  assertAssetDraftVersionShape(currentDraft)
  if (workspace?.headRevision !== currentDraft.revision || currentDraft.workspaceId !== workspaceId || canonicalJson(stored) !== canonicalJson(currentDraft) || sha256DigestOf(canonicalJson(assetDraftContent(currentDraft))) !== currentDraft.digest) invalid()
  const terms = await deps.definitions.listCandidates(scope, workspaceId, { limit: 250 }, ctx)
  const actions = await deps.ruleActions.list(scope, workspaceId, { limit: 250 }, ctx)
  if (terms.length === 250 || actions.length === 250) invalid()
  const pins = currentDefinitionProjection(terms).map(({ candidateId, contentDigest }) => ({ candidateId, contentDigest })).sort((a, b) => a.candidateId.localeCompare(b.candidateId))
  const rulePins = ruleActionPublicationPins(currentRuleActionProjection(actions)).sort((a, b) => a.candidateId.localeCompare(b.candidateId))
  const frames: AssetDraftVersion[] = [currentDraft]
  let cursor = currentDraft
  for (let depth = 0; cursor.publicationCheckpoint !== undefined; depth += 1) {
    if (depth >= 32) invalid()
    check()
    const receipt = cursor.publicationCheckpoint
    const asset = await deps.packs.findByRef(scope, receipt.packRef, ctx)
    if (asset === undefined) invalid()
    assertPublishedPackAssetShape(asset)
    if (asset.workspaceId !== workspaceId || asset.revision !== cursor.revision || canonicalJson(asset.sourceDraftRef) !== canonicalJson(receipt.sourceDraftRef) || canonicalJson(asset.validationRef) !== canonicalJson(receipt.validationRef) || canonicalJson(cursor.validationRef) !== canonicalJson(receipt.validationRef) || asset.packRef.digest !== asset.contentDigest || publishedPackContentDigest(asset) !== asset.contentDigest) invalid()
    const source = await deps.workspaces.getDraft(scope, workspaceId, receipt.sourceDraftRef.revision, ctx)
    if (source === undefined) invalid()
    assertAssetDraftVersionShape(source)
    if (source.workspaceId !== workspaceId || source.digest !== receipt.sourceDraftRef.digest || BigInt(source.revision) >= BigInt(cursor.revision) || sha256DigestOf(canonicalJson(assetDraftContent(source))) !== source.digest || canonicalJson(assetDraftSourceContent(source)) !== canonicalJson(assetDraftSourceContent(cursor))) invalid()
    const originalPins = (asset.approvalPins ?? []).map(({ candidateId, contentDigest }) => ({ candidateId, contentDigest })).sort((a, b) => a.candidateId.localeCompare(b.candidateId))
    // A real candidate edit/enablement change invalidates the old bridge, while a new
    // producer bound directly to the actual current draft remains independently eligible.
    if (canonicalJson(originalPins) !== canonicalJson(pins) || canonicalJson([...(asset.ruleActionPins ?? [])].sort((a, b) => a.candidateId.localeCompare(b.candidateId))) !== canonicalJson(rulePins)) break
    frames.push(source)
    cursor = source
  }
  check()
  if (canonicalJson(await deps.workspaces.getWorkspace(scope, workspaceId, ctx)) !== canonicalJson(workspace) || canonicalJson(await deps.workspaces.getDraft(scope, workspaceId, currentDraft.revision, ctx)) !== canonicalJson(currentDraft)) invalid()
  return frames
}
