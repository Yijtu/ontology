import type {
  AssetDraftVersion, IndustryPackCatalogue, IndustryWorkspace, PublishedDefinitionVersionReader,
  PublishedPackAsset, PublishedPackAssetStore, ScopeRef, SemanticDefinitionVersion, ToolContext, VersionRef,
} from '@ontology/contracts'

export interface DefinitionPredecessor {
  readonly packRef: VersionRef
  readonly definition: SemanticDefinitionVersion
  readonly asset?: PublishedPackAsset
}

export class DefinitionPredecessorError extends Error {}

/** Resolve the exact workspace/draft pin; namespace peers never choose a predecessor. */
export async function resolveDefinitionPredecessor(
  deps: {
    readonly definitions?: PublishedDefinitionVersionReader
    readonly publishedPacks?: Pick<PublishedPackAssetStore, 'findByRef'>
    readonly baseCatalogue?: IndustryPackCatalogue
  },
  workspace: IndustryWorkspace,
  draft: AssetDraftVersion | undefined,
  scope: ScopeRef,
  ctx: ToolContext,
): Promise<DefinitionPredecessor | undefined> {
  const pin = workspace.latestPublishedPackRef ?? draft?.basePackRef
  if (pin === undefined) return undefined
  const asset = await deps.publishedPacks?.findByRef(scope, pin, ctx)
  if (asset !== undefined && (asset.packRef.id !== pin.id || asset.packRef.version !== pin.version || asset.packRef.digest !== pin.digest)) {
    throw new DefinitionPredecessorError('the published pack does not match the exact predecessor pin')
  }
  if (workspace.latestPublishedPackRef !== undefined && asset === undefined) {
    throw new DefinitionPredecessorError('the exact workspace publication pin is unavailable')
  }
  let definitionRef = asset?.definitionRef ?? pin
  let namespace = asset?.namespace ?? workspace.namespace
  if (asset === undefined && deps.baseCatalogue !== undefined) {
    const base = await deps.baseCatalogue.findPack(pin.id, pin.version, scope, ctx)
    if (base !== undefined) {
      if (base.ref.id !== pin.id || base.ref.version !== pin.version || base.ref.digest !== pin.digest) throw new DefinitionPredecessorError('the base pack does not match its pin')
      definitionRef = base.manifest.definitionsRef
      namespace = base.manifest.namespace
    }
  }
  const definition = await deps.definitions?.findVersion(namespace, definitionRef.id, definitionRef.version, scope, ctx)
  if (definition === undefined || definition.ref.id !== definitionRef.id || definition.ref.version !== definitionRef.version || definition.ref.digest !== definitionRef.digest) {
    throw new DefinitionPredecessorError('the exact predecessor definition pin is unavailable')
  }
  return { packRef: pin, definition, ...(asset === undefined ? {} : { asset }) }
}
