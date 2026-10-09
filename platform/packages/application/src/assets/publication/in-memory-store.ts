import {
  PublishedPackAssetStoreError,
  assertPublishedPackAssetShape,
  isToolContext,
  assetDraftContent,
} from '@ontology/contracts'
import type {
  CommitApprovedPackInput,
  AssetDraftVersion,
  CommitApprovedPackResult,
  PublishedPackAsset,
  PublishedPackAssetFilter,
  PublishedPackAssetStore,
  ScopeRef,
  SemanticDefinitionStore,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../../profiles/canonical'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}`
}

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new PublishedPackAssetStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (
    ctx.allowedResources.tenantId !== ctx.principal.tenantId ||
    scopeRef.tenantId !== ctx.principal.tenantId ||
    scopeRef.spaceId !== ctx.allowedResources.spaceId
  ) {
    throw new PublishedPackAssetStoreError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
}

export interface InMemoryPublishedPackAssetStoreDependencies {
  readonly publicationGuard?: (scopeRef: ScopeRef, input: CommitApprovedPackInput, ctx: ToolContext) => Promise<void>
  /**
   * Called after a successful commit with the workspace head the publication advanced to. The
   * PostgreSQL store advances the workspace in the same transaction; an in-memory harness uses
   * this hook to keep its workspace double in step.
   */
  readonly onPublished?: (
    scopeRef: ScopeRef,
    workspaceId: string,
    revision: string,
    packRef: VersionRef,
    checkpoint?: AssetDraftVersion,
  ) => void | Promise<void>
  /**
   * The definition store the immutable definition version is written to, mirroring the single
   * PostgreSQL publication transaction. Absent means the harness does not need definition reads.
   */
  readonly definitions?: SemanticDefinitionStore
}

/**
 * Reference in-memory published-pack store (SEE ALSO migration 066 / PostgresPublishedPackAssetStore).
 * It enforces the same idempotency, pack-version and namespace conflicts so the publication service
 * is unit-tested against the real contract without a database.
 */
export class InMemoryPublishedPackAssetStore implements PublishedPackAssetStore {
  readonly #packs = new Map<string, Map<string, PublishedPackAsset>>()
  readonly #idempotency = new Map<string, { readonly scope: string; readonly packId: string; readonly version: string; readonly requestDigest: string }>()
  readonly #dependencies: InMemoryPublishedPackAssetStoreDependencies

  constructor(dependencies: InMemoryPublishedPackAssetStoreDependencies = {}) {
    this.#dependencies = dependencies
  }

  #scope(scopeRef: ScopeRef): Map<string, PublishedPackAsset> {
    const key = scopeKey(scopeRef)
    const existing = this.#packs.get(key)
    if (existing !== undefined) return existing
    const created = new Map<string, PublishedPackAsset>()
    this.#packs.set(key, created)
    return created
  }

  async commitApprovedPack(
    scopeRef: ScopeRef,
    input: CommitApprovedPackInput,
    ctx: ToolContext,
  ): Promise<CommitApprovedPackResult> {
    resolveScope(scopeRef, ctx)
    const scope = scopeKey(scopeRef)
    const idempotencyKey = `${scope}\u0000${input.idempotencyKey}`
    const prior = this.#idempotency.get(idempotencyKey)
    if (prior !== undefined) {
      if (prior.requestDigest !== input.requestDigest) {
        throw new PublishedPackAssetStoreError(
          'IDEMPOTENCY_CONFLICT',
          'the idempotency key was already used with a different publication request',
        )
      }
      const stored = this.#scope(scopeRef).get(`${prior.packId}\u0000${prior.version}`)
      if (stored === undefined) {
        throw new PublishedPackAssetStoreError('STORE_FAILED', 'the idempotent pack asset row is missing')
      }
      return { asset: structuredClone(stored), created: false }
    }

    if (this.#dependencies.publicationGuard !== undefined) {
      await this.#dependencies.publicationGuard(scopeRef, input, ctx)
    } else if (input.definition.objects.length + input.definition.attributes.length + input.definition.relations.length > 0) {
      throw new PublishedPackAssetStoreError('VERSION_CONFLICT', 'a content-pinned publication guard is required')
    }
    const packId = input.pack.packRef.id
    const version = input.pack.packRef.version
    const packs = this.#scope(scopeRef)
    for (const existing of packs.values()) {
      if (existing.packRef.id === packId && existing.packRef.version === version) {
        if (existing.contentDigest === input.pack.contentDigest) {
          return { asset: structuredClone(existing), created: false }
        }
        throw new PublishedPackAssetStoreError(
          'PACK_VERSION_EXISTS',
          `pack ${packId}@${version} is already published with a different digest`,
        )
      }
      if (existing.namespace === input.pack.namespace && existing.packRef.version === version) {
        if (existing.contentDigest === input.pack.contentDigest) {
          return { asset: structuredClone(existing), created: false }
        }
        throw new PublishedPackAssetStoreError(
          'NAMESPACE_CONFLICT',
          `namespace ${input.pack.namespace} already publishes version ${version} with a different digest`,
        )
      }
    }

    const revision = (BigInt(input.expectedRevision === '0' ? '0' : input.expectedRevision) + 1n).toString()
    const asset: PublishedPackAsset = { ...input.pack, revision, publishedAt: input.recordedAt }
    assertPublishedPackAssetShape(asset)
    if (this.#dependencies.definitions !== undefined) {
      await this.#dependencies.definitions.insertVersion(
        scopeRef,
        { ...input.definition, scopeRef },
        input.definitionAudit,
        ctx,
      )
    }
    packs.set(`${packId}\u0000${version}`, structuredClone(asset))
    this.#idempotency.set(idempotencyKey, {
      scope,
      packId,
      version,
      requestDigest: input.requestDigest,
    })
    const source = input.sourceDraft
    const body = source === undefined || asset.sourceDraftRef === undefined ? undefined : { ...source, revision,
      validationRef: asset.validationRef, publicationCheckpoint: { sourceDraftRef: asset.sourceDraftRef, packRef: asset.packRef, validationRef: asset.validationRef } }
    const checkpoint = body === undefined ? undefined : { ...body, digest: sha256DigestOf(canonicalJson(assetDraftContent(body))) }
    await this.#dependencies.onPublished?.(scopeRef, asset.workspaceId, revision, asset.packRef, checkpoint)
    return { asset, created: true }
  }

  async findPack(
    scopeRef: ScopeRef,
    packId: string,
    version: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset | undefined> {
    resolveScope(scopeRef, ctx)
    const stored = this.#scope(scopeRef).get(`${packId}\u0000${version}`)
    return stored === undefined ? undefined : structuredClone(stored)
  }

  async findByRef(scopeRef: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<PublishedPackAsset | undefined> {
    resolveScope(scopeRef, ctx)
    for (const stored of this.#scope(scopeRef).values()) {
      if (stored.packRef.id === ref.id && stored.packRef.version === ref.version && stored.packRef.digest === ref.digest) {
        return structuredClone(stored)
      }
    }
    return undefined
  }

  async listPacks(
    scopeRef: ScopeRef,
    filter: PublishedPackAssetFilter,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset[]> {
    resolveScope(scopeRef, ctx)
    const all = [...this.#scope(scopeRef).values()]
      .filter((asset) => filter.namespace === undefined || asset.namespace === filter.namespace)
      .sort((left, right) => (left.publishedAt < right.publishedAt ? -1 : left.publishedAt > right.publishedAt ? 1 : 0))
    const limit = filter.limit ?? 100
    return all.slice(0, limit).map((asset) => structuredClone(asset))
  }

  async findByIdempotencyKey(
    scopeRef: ScopeRef,
    key: string,
    ctx: ToolContext,
  ): Promise<PublishedPackAsset | undefined> {
    resolveScope(scopeRef, ctx)
    const located = this.#idempotency.get(`${scopeKey(scopeRef)}\u0000${key}`)
    if (located === undefined) return undefined
    const stored = this.#scope(scopeRef).get(`${located.packId}\u0000${located.version}`)
    return stored === undefined ? undefined : structuredClone(stored)
  }
}
