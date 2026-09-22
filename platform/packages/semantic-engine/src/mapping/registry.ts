import type { Sha256Digest, VersionRef } from '@ontology/contracts'
import { sha256DigestOf, stableStringify } from '../definitions/canonical'
import type { SemanticMapping, SemanticMappingRegistry } from './types'

/**
 * A mapping's digest pins exactly the dialect, objects and links — not its own ref — so a
 * changed mapping is a new version and a plan that pins the old digest cannot be silently
 * reinterpreted.
 */
export function semanticMappingDigest(mapping: Omit<SemanticMapping, 'mappingRef'>): Sha256Digest {
  return sha256DigestOf(
    stableStringify({
      dialect: mapping.dialect,
      objects: mapping.objects,
      links: mapping.links,
    }),
  )
}

/** Build a confirmed, versioned mapping from its content. */
export function defineSemanticMapping(
  id: string,
  version: string,
  body: Omit<SemanticMapping, 'mappingRef'>,
): SemanticMapping {
  return { ...body, mappingRef: { id, version, digest: semanticMappingDigest(body) } }
}

function refKey(ref: VersionRef): string {
  return `${ref.id}\u0000${ref.version}\u0000${ref.digest}`
}

/**
 * Reference registry for tests and local composition. `resolve` requires an exact
 * id/version/digest match, so a stale plan is rejected rather than re-resolved.
 */
export class InMemorySemanticMappingRegistry implements SemanticMappingRegistry {
  readonly #byRef = new Map<string, SemanticMapping>()

  constructor(mappings: readonly SemanticMapping[]) {
    for (const mapping of mappings) {
      this.#byRef.set(refKey(mapping.mappingRef), mapping)
    }
  }

  resolve(mappingRef: VersionRef): SemanticMapping | undefined {
    return this.#byRef.get(refKey(mappingRef))
  }

  list(): readonly SemanticMapping[] {
    return [...this.#byRef.values()]
  }
}
