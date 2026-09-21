import { isToolContext } from '@ontology/contracts'
import type {
  IndustryManifest,
  IndustryManifestSource,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { refKey } from './canonical'

/**
 * Reference `IndustryManifestSource` for unit tests and local composition. The composition
 * root preloads published packs by their exact reference; the resolver never imports an
 * industry pack and a missing reference resolves to `undefined` rather than a default.
 */
export class InMemoryIndustryManifestSource implements IndustryManifestSource {
  readonly #manifests = new Map<string, IndustryManifest>()

  constructor(entries?: readonly { readonly ref: VersionRef; readonly manifest: IndustryManifest }[]) {
    for (const entry of entries ?? []) {
      this.#manifests.set(refKey(entry.ref), entry.manifest)
    }
  }

  register(ref: VersionRef, manifest: IndustryManifest): void {
    this.#manifests.set(refKey(ref), manifest)
  }

  async getManifest(
    ref: VersionRef,
    _scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<IndustryManifest | undefined> {
    if (!isToolContext(ctx)) {
      throw new Error('a host-minted trusted tool context is required to resolve an industry manifest')
    }
    const manifest = this.#manifests.get(refKey(ref))
    return manifest === undefined ? undefined : structuredClone(manifest)
  }
}
