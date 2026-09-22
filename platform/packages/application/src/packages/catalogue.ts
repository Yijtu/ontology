import { isPackMaturityUsable, isToolContext, packMaturityLabelOf } from '@ontology/contracts'
import type {
  IndustryPackCatalogue,
  IndustryPackPreparation,
  PackAsset,
  PackCatalogEntry,
  PackCatalogSummary,
  ScopeRef,
  Semver,
  ToolContext,
} from '@ontology/contracts'
import { IndustryPackError } from './errors'

function packKey(packId: string, version: Semver): string {
  return `${packId}\u0000${version}`
}

/**
 * Reference catalogue of registered packs and preparation material, for unit tests and local
 * composition. The composition root preloads it; the application layer never imports an
 * industry pack. A `findPack` requires an exact id+version and returns `undefined` rather
 * than defaulting to another version.
 */
export class InMemoryIndustryPackCatalogue implements IndustryPackCatalogue {
  readonly #packs = new Map<string, PackAsset>()
  readonly #preparations: IndustryPackPreparation[] = []

  registerPack(asset: PackAsset): void {
    const key = packKey(asset.ref.id, asset.ref.version)
    if (this.#packs.has(key)) {
      throw new IndustryPackError(
        'INVALID_ARGUMENT',
        `pack ${asset.ref.id}@${asset.ref.version} is already registered in the catalogue`,
      )
    }
    this.#packs.set(key, structuredClone(asset))
  }

  registerPreparation(preparation: IndustryPackPreparation): void {
    this.#preparations.push(structuredClone(preparation))
  }

  async listEntries(scopeRef: ScopeRef, ctx: ToolContext): Promise<readonly PackCatalogEntry[]> {
    assertTrusted(scopeRef, ctx)
    const entries: PackCatalogEntry[] = []
    for (const asset of this.#packs.values()) {
      entries.push({ kind: 'registered_pack', asset: structuredClone(asset) })
    }
    for (const preparation of this.#preparations) {
      entries.push({ kind: 'preparation', preparation: structuredClone(preparation) })
    }
    return entries
  }

  async findPack(
    packId: string,
    version: Semver,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<PackAsset | undefined> {
    assertTrusted(scopeRef, ctx)
    const asset = this.#packs.get(packKey(packId, version))
    return asset === undefined ? undefined : structuredClone(asset)
  }
}

function assertTrusted(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new IndustryPackError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (scopeRef.tenantId !== ctx.principal.tenantId) {
    throw new IndustryPackError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

/**
 * Derive the maturity-gated summary the API/UI reports. `usable` is computed from the
 * canonical maturity, so preparation material (`planned`/`preview`) is always `usable:false`
 * and is only ever labelled `defined`/`experimental`, never `validated`.
 */
export function summarizePackCatalogEntry(entry: PackCatalogEntry): PackCatalogSummary {
  if (entry.kind === 'registered_pack') {
    const manifest = entry.asset.manifest
    return {
      kind: 'registered_pack',
      namespace: manifest.namespace,
      displayName: manifest.namespace,
      packRef: entry.asset.ref,
      maturity: manifest.maturity,
      maturityLabel: packMaturityLabelOf(manifest.maturity),
      usable: isPackMaturityUsable(manifest.maturity),
    }
  }
  const preparation = entry.preparation
  return {
    kind: 'preparation',
    namespace: preparation.namespace,
    displayName: preparation.displayName,
    maturity: preparation.maturity,
    maturityLabel: packMaturityLabelOf(preparation.maturity),
    usable: isPackMaturityUsable(preparation.maturity),
  }
}
