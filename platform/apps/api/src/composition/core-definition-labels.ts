import { canonicalJson, publishedPackContentDigest } from '@ontology/application'
import type { AssetCandidateStore, PublishedPackAssetStore, RuleActionCandidateStore, ScopeRef, ToolContext, VersionRef } from '@ontology/contracts'
import { InvalidRequestFieldError } from '../http/shared'

export interface CoreDefinitionLabels {
  readonly attributes: readonly { readonly objectId: string; readonly attributeId: string; readonly displayName: string }[]
  readonly relations: readonly { readonly relationId: string; readonly displayName: string }[]
  readonly rules?: readonly { readonly ruleId: string; readonly objectId: string; readonly displayName: string }[]
}
export type CoreDefinitionLabelReader = (scope: ScopeRef, packRef: VersionRef, definitionRef: VersionRef, ctx: ToolContext) => Promise<CoreDefinitionLabels | undefined>

/** Labels come from the exact immutable candidate CIDs frozen by this published pack. */
export function createCoreDefinitionLabelReader(options: {
  readonly packs: Pick<PublishedPackAssetStore, 'findByRef'>
  readonly candidates: Pick<AssetCandidateStore, 'getCandidate'>
  readonly ruleActions?: Pick<RuleActionCandidateStore,'get'>
}): CoreDefinitionLabelReader {
  return async (scope, packRef, definitionRef, ctx) => {
    const asset = await options.packs.findByRef(scope, packRef, ctx)
    if (asset === undefined) return undefined // Legacy declaration packs need not contain authored display metadata.
    if (asset.definitionRef.id !== definitionRef.id || asset.definitionRef.version !== definitionRef.version || asset.definitionRef.digest !== definitionRef.digest || publishedPackContentDigest(asset) !== packRef.digest || (asset.approvalPins?.length ?? 0) > 250) throw new InvalidRequestFieldError('the frozen term label source does not bind this actual pack and definition')
    const attributes: CoreDefinitionLabels['attributes'][number][] = [], relations: CoreDefinitionLabels['relations'][number][] = []
    const pins = asset.approvalPins ?? []
    for (let offset = 0; offset < pins.length; offset += 8) {
      const rows = await Promise.all(pins.slice(offset, offset + 8).map(async (pin) => ({ pin, candidate: await options.candidates.getCandidate(scope, pin.candidateId, ctx) })))
      for (const { pin, candidate } of rows) {
        if (candidate === undefined || candidate.workspaceId !== asset.workspaceId || candidate.contentDigest !== pin.contentDigest || candidate.logicalId !== candidate.payload.logicalId) throw new InvalidRequestFieldError('the frozen authored term label candidate is unavailable or changed')
        const payload = candidate.payload
        if (payload.kind === 'attribute') attributes.push({ objectId: payload.objectLogicalId, attributeId: payload.logicalId, displayName: payload.displayName })
        if (payload.kind === 'relation') relations.push({ relationId: payload.logicalId, displayName: payload.displayName })
      }
    }
    const rules: NonNullable<CoreDefinitionLabels['rules']>[number][] = []
    if (options.ruleActions !== undefined) for (const declaration of asset.ruleDeclarations ?? []) {
      const candidate = await options.ruleActions.get(scope,declaration.candidateId,ctx)
      if (candidate === undefined || candidate.kind !== 'rule' || candidate.workspaceId !== asset.workspaceId || candidate.contentDigest !== declaration.contentDigest || candidate.payload.kind !== 'rule' || canonicalJson(candidate.payload) !== canonicalJson(declaration.payload)) throw new InvalidRequestFieldError('the frozen authored rule label candidate is unavailable or changed')
      rules.push({ ruleId: candidate.payload.ruleId,objectId: candidate.payload.applicability.objectId,displayName: candidate.displayName })
    }
    return { attributes, relations, rules }
  }
}
