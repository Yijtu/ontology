import { isToolContext } from '@ontology/contracts'
import type { SourceSnapshot, ToolContext } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import { containsValidAt } from './canonical'
import { IdentityRecallError } from './errors'
import type {
  IdentityIndexEntry,
  IdentityIndexPage,
  IdentityIndexQuery,
  IdentityIndexReader,
  IdentityIndexMatch,
} from './types'

export const IDENTITY_INDEX_NAMESPACE = 'ontology.identity_index'

function dimensionMatches(entry: IdentityIndexEntry, dimension: string, value: string): boolean {
  const provided = entry.dimensions?.[dimension]
  return provided !== undefined && provided === value
}

function matchesScope(entry: IdentityIndexEntry, query: IdentityIndexQuery): boolean {
  if (entry.tenantId !== query.tenantId || entry.spaceId !== query.spaceId) return false
  if (entry.objectId !== query.objectId) return false
  if (entry.identityScopeId !== query.identityScopeId) return false
  for (const { dimension, value } of query.scopeDimensions) {
    if (!dimensionMatches(entry, dimension, value)) return false
  }
  return true
}

function matchesMatch(entry: IdentityIndexEntry, match: IdentityIndexMatch): boolean {
  switch (match.kind) {
    case 'strong_identifier':
      return entry.nativeId !== undefined && entry.nativeId === match.nativeId
    case 'confirmed_alias':
      return (
        entry.aliasConfirmed &&
        entry.aliasNormalized !== undefined &&
        entry.aliasNormalized === match.normalizedAlias &&
        containsValidAt(entry.aliasValidFrom, entry.aliasValidTo, match.validAt)
      )
    case 'context':
      if (match.normalizedName !== undefined && entry.normalizedName !== match.normalizedName) return false
      if (match.entityType !== undefined && entry.entityType !== match.entityType) return false
      if (match.site !== undefined && entry.site !== match.site) return false
      return containsValidAt(entry.validFrom, entry.validTo, match.validAt)
  }
}

/**
 * Reference `IdentityIndexReader` for unit tests and local composition.
 *
 * It applies the same scope and match rules as the structured reader — every declared
 * scope dimension must match and the trusted tenant/space is always enforced — so the
 * service is exercised against the real scoping rules rather than a permissive fake. It
 * never touches a database.
 */
export class InMemoryIdentityIndexReader implements IdentityIndexReader {
  readonly #entries: readonly IdentityIndexEntry[]
  readonly #now: () => string

  constructor(entries: readonly IdentityIndexEntry[], now?: () => string) {
    this.#entries = entries
    this.#now = now ?? (() => new Date().toISOString())
  }

  async query(query: IdentityIndexQuery, ctx: ToolContext): Promise<IdentityIndexPage> {
    if (!isToolContext(ctx)) {
      throw new IdentityRecallError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    if (query.tenantId !== ctx.principal.tenantId || query.spaceId !== ctx.allowedResources.spaceId) {
      throw new IdentityRecallError('SCOPE_MISMATCH', 'query scope does not match the trusted principal scope')
    }
    const matched = this.#entries.filter((entry) => matchesScope(entry, query) && matchesMatch(entry, query.match))

    // Several alias rows can describe one entity; collapse to the strongest single row.
    const byEntity = new Map<string, IdentityIndexEntry>()
    for (const entry of matched) {
      if (!byEntity.has(entry.entityId)) byEntity.set(entry.entityId, entry)
    }
    const ranked = [...byEntity.values()].sort((left, right) =>
      left.entityId < right.entityId ? -1 : left.entityId > right.entityId ? 1 : 0,
    )
    const limit = Math.max(1, query.limit)
    const page = ranked.slice(0, limit)
    const snapshot: SourceSnapshot = {
      sourceRef: { namespace: IDENTITY_INDEX_NAMESPACE, sourceId: 'in-memory' },
      schemaVersion: '1.0.0',
      readAt: this.#now(),
      consistency: 'immutable',
      resultDigest: sha256DigestOf(ranked),
    }
    return {
      entries: page,
      truncated: ranked.length > page.length,
      knownTotal: ranked.length,
      schemaRevision: '1.0.0',
      snapshot,
    }
  }
}
