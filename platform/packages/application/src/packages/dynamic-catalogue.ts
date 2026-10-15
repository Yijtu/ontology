import type {
  IndustryManifest,
  IndustryManifestSource,
  IndustryPackCatalogue,
  PackAsset,
  PackCatalogEntry,
  PublishedPackAssetStore,
  ScopeRef,
  Semver,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { refKey } from '../profiles/canonical'

/**
 * Persistent dynamic package catalogue and manifest source (SPEC v0.3a asset-data-ui §6.1,
 * V03-015 / #187; A.ADR-04, A.US-005, P.FR-17).
 *
 * A pack published at runtime must become visible and mountable without a restart and without
 * editing the static example list. Both wrappers read the persisted `published_pack_assets` table
 * through the `PublishedPackAssetStore` port and fall back to a controlled static seed, so the
 * existing startup packs keep resolving while a newly published pack joins the same read path.
 *
 * The application layer depends only on the port; the PostgreSQL adapter owns the SQL.
 */

export interface StoreBackedIndustryPackCatalogueDependencies {
  readonly store: PublishedPackAssetStore
  /** The controlled static seed; dynamic packs take precedence over a same-ref seed. */
  readonly fallback?: IndustryPackCatalogue
}

function assetKey(asset: PackAsset): string {
  return refKey(asset.ref)
}

export class StoreBackedIndustryPackCatalogue implements IndustryPackCatalogue {
  readonly #store: PublishedPackAssetStore
  readonly #fallback: IndustryPackCatalogue | undefined

  constructor(dependencies: StoreBackedIndustryPackCatalogueDependencies) {
    this.#store = dependencies.store
    this.#fallback = dependencies.fallback
  }

  async listEntries(scopeRef: ScopeRef, ctx: ToolContext): Promise<readonly PackCatalogEntry[]> {
    const published = await this.#store.listPacks(scopeRef, {}, ctx)
    const entries: PackCatalogEntry[] = published.map((asset) => ({ kind: 'registered_pack', asset: asset.packAsset }))
    if (this.#fallback !== undefined) {
      const seen = new Set(entries.map((entry) => (entry.kind === 'registered_pack' ? assetKey(entry.asset) : '')))
      for (const entry of await this.#fallback.listEntries(scopeRef, ctx)) {
        if (entry.kind === 'registered_pack' && seen.has(assetKey(entry.asset))) continue
        entries.push(entry)
      }
    }
    return entries
  }

  async findPack(
    packId: string,
    version: Semver,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<PackAsset | undefined> {
    const published = await this.#store.findPack(scopeRef, packId, version, ctx)
    if (published !== undefined) return published.packAsset
    if (this.#fallback === undefined) return undefined
    return this.#fallback.findPack(packId, version, scopeRef, ctx)
  }
}

export interface StoreBackedIndustryManifestSourceDependencies {
  readonly store: PublishedPackAssetStore
  /** The controlled static seed; a dynamic manifest takes precedence. */
  readonly fallback?: IndustryManifestSource
}

export class StoreBackedIndustryManifestSource implements IndustryManifestSource {
  readonly #store: PublishedPackAssetStore
  readonly #fallback: IndustryManifestSource | undefined

  constructor(dependencies: StoreBackedIndustryManifestSourceDependencies) {
    this.#store = dependencies.store
    this.#fallback = dependencies.fallback
  }

  async getManifest(
    ref: VersionRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<IndustryManifest | undefined> {
    const published = await this.#store.findByRef(scopeRef, ref, ctx)
    if (published !== undefined) return published.manifest
    if (this.#fallback === undefined) return undefined
    return this.#fallback.getManifest(ref, scopeRef, ctx)
  }
}
