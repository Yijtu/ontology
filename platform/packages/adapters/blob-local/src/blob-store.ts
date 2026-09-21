import { randomUUID } from 'node:crypto'
import { isToolContext } from '@ontology/contracts'
import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPort,
  BlobPutImmutableRequest,
  BlobPutImmutableResponse,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { isSha256Digest, objectKeyForDigest, sha256Digest } from './digest'
import { BlobStoreError } from './errors'
import type { BlobScope, ImmutableObjectStore } from './object-store'
import type {
  ArtifactReferenceView,
  ArtifactRegistry,
  BlobPurpose,
  RecordArtifactReferenceResult,
} from './registry'
import { isBlobPurpose } from './registry'

export interface BlobStageRequest {
  readonly scopeRef: ScopeRef
}

export interface BlobStageResult {
  readonly contentDigest: Sha256Digest
  readonly byteSize: number
}

/**
 * Adapter-level extension of the canonical `BlobPutImmutableRequest`. The port
 * shape cannot carry the purpose or the owning run, but an immutable reference
 * needs both to enforce the private-checkpoint scope, so `publish` accepts them
 * and `putImmutable` delegates with the generic `artifact` purpose.
 */
export interface BlobPublishRequest extends BlobPutImmutableRequest {
  readonly purpose: BlobPurpose
  readonly runId?: Uuid
  readonly origin?: Readonly<Record<string, unknown>>
}

export interface LocalImmutableBlobStoreDependencies {
  readonly objectStore: ImmutableObjectStore
  readonly registry: ArtifactRegistry
  readonly idFactory?: () => Uuid
  readonly now?: () => string
}

/**
 * Scope is taken from the trusted ToolContext, never from the request body. A
 * model that supplies a different `scopeRef` is rejected before any read or
 * write happens.
 */
function resolveTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): BlobScope {
  if (!isToolContext(ctx)) {
    throw new BlobStoreError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new BlobStoreError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new BlobStoreError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
  return { tenantId, spaceId }
}

/**
 * Content-addressed immutable blob store (ADR-08).
 *
 * The write path is stage → verify → publish-reference. Each step is atomic and
 * the authorization reference is the last one, so a crash or a failure at any
 * point leaves at most a stray staged file or object — never a reference that
 * points at content nobody verified. Because the object key is the content
 * digest, a retry is idempotent and a duplicate upload reuses the stored bytes
 * while still recording a distinct origin.
 *
 * Every read is authorized through the tenant/space-scoped registry; an
 * unauthorized lookup and a missing one return the same typed `BLOB_NOT_FOUND`,
 * so a cross-tenant caller cannot learn whether the content exists.
 */
export class LocalImmutableBlobStore implements BlobPort {
  readonly #objectStore: ImmutableObjectStore
  readonly #registry: ArtifactRegistry
  readonly #idFactory: () => Uuid
  readonly #now: () => string

  constructor(dependencies: LocalImmutableBlobStoreDependencies) {
    this.#objectStore = dependencies.objectStore
    this.#registry = dependencies.registry
    this.#idFactory = dependencies.idFactory ?? randomUUID
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /** Write content into the staging area and compute its digest. */
  async stage(content: Uint8Array, request: BlobStageRequest, ctx: ToolContext): Promise<BlobStageResult> {
    const scope = resolveTrustedScope(request.scopeRef, ctx)
    return this.#objectStore.stage(scope, content)
  }

  /**
   * Promote staged content to an authorized immutable reference. The staged
   * bytes are verified against the declared digest and size before the object
   * is published and before the reference is recorded.
   */
  async publish(request: BlobPublishRequest, ctx: ToolContext): Promise<BlobPutImmutableResponse> {
    const scope = resolveTrustedScope(request.scopeRef, ctx)
    validatePublishRequest(request)

    const staged = await this.#readStagedOrPublished(scope, request.contentDigest)
    const actualDigest = sha256Digest(staged)
    if (actualDigest !== request.contentDigest) {
      await this.#objectStore.discardStaged(scope, request.contentDigest).catch(() => undefined)
      throw new BlobStoreError(
        'BLOB_DIGEST_MISMATCH',
        `staged content digest ${actualDigest} does not match the declared digest ${request.contentDigest}`,
      )
    }
    if (staged.byteLength !== request.byteSize) {
      await this.#objectStore.discardStaged(scope, request.contentDigest).catch(() => undefined)
      throw new BlobStoreError(
        'BLOB_SIZE_MISMATCH',
        `staged content size ${staged.byteLength} does not match the declared size ${request.byteSize}`,
      )
    }

    await this.#objectStore.publish(request.contentDigest, staged)

    const recorded: RecordArtifactReferenceResult = await this.#registry.recordReference({
      scope,
      blobRefId: this.#idFactory(),
      contentDigest: request.contentDigest,
      mediaType: request.mediaType,
      byteSize: request.byteSize,
      objectKey: objectKeyForDigest(request.contentDigest),
      purpose: request.purpose,
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      ...(request.tenantAuthorizedRef === undefined
        ? {}
        : { tenantAuthorizedRef: request.tenantAuthorizedRef }),
      ...(request.origin === undefined ? {} : { origin: request.origin }),
    })

    // The reference is durable now; a leftover staged file is only garbage.
    await this.#objectStore.discardStaged(scope, request.contentDigest).catch(() => undefined)

    return {
      blobRef: recorded.blobRef,
      contentDigest: request.contentDigest,
      integrity: {
        algorithm: 'sha256',
        digest: request.contentDigest,
        verifiedAt: this.#now(),
      },
      deduplicated: recorded.deduplicated,
    }
  }

  async putImmutable(
    request: BlobPutImmutableRequest,
    ctx: ToolContext,
  ): Promise<BlobPutImmutableResponse> {
    return this.publish({ ...request, purpose: 'artifact' }, ctx)
  }

  async getAuthorized(
    request: BlobGetAuthorizedRequest,
    ctx: ToolContext,
  ): Promise<BlobGetAuthorizedResponse> {
    const view = await this.#authorize(request, ctx)
    // Reading the object verifies the stored bytes against the digest; a missing
    // or corrupt object raises an explicit typed error instead of empty data.
    await this.#objectStore.read(view.blob.contentDigest)
    return {
      blobRef: request.blobRef,
      contentDigest: view.blob.contentDigest,
      mediaType: view.blob.mediaType,
      byteSize: view.blob.byteSize,
      integrityVerified: true,
    }
  }

  /** Authorized byte read. Only reachable after the same scope/run checks. */
  async readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array> {
    const view = await this.#authorize(request, ctx)
    return this.#objectStore.read(view.blob.contentDigest)
  }

  /** Origins that reference the same content, newest first, in this scope. */
  async listOrigins(
    request: BlobGetAuthorizedRequest,
    ctx: ToolContext,
  ): Promise<readonly { blobRefId: Uuid; purpose: BlobPurpose; createdAt: string }[]> {
    const view = await this.#authorize(request, ctx)
    const scope = resolveTrustedScope(request.scopeRef, ctx)
    const origins = await this.#registry.listOrigins(scope, view.blob.contentDigest)
    return origins.map((origin) => ({
      blobRefId: origin.blobRefId,
      purpose: origin.purpose,
      createdAt: origin.createdAt,
    }))
  }

  /**
   * Prefer the freshly staged bytes. If the staging copy is gone — a concurrent
   * identical upload already discarded it, or a previous attempt crashed after
   * publishing the object — fall back to the content-addressed object, which is
   * only accepted after its digest is verified. Both paths therefore verify the
   * bytes before a reference is recorded.
   */
  async #readStagedOrPublished(scope: BlobScope, contentDigest: Sha256Digest): Promise<Uint8Array> {
    try {
      return await this.#objectStore.readStaged(scope, contentDigest)
    } catch (error) {
      if (!(error instanceof BlobStoreError) || error.code !== 'BLOB_CONTENT_NOT_STAGED') {
        throw error
      }
    }
    try {
      return await this.#objectStore.read(contentDigest)
    } catch (error) {
      if (error instanceof BlobStoreError && error.code === 'BLOB_OBJECT_MISSING') {
        throw new BlobStoreError(
          'BLOB_CONTENT_NOT_STAGED',
          `no staged content matches ${contentDigest} in this scope`,
          { cause: error },
        )
      }
      throw error
    }
  }

  async #authorize(
    request: BlobGetAuthorizedRequest,
    ctx: ToolContext,
  ): Promise<ArtifactReferenceView> {
    const scope = resolveTrustedScope(request.scopeRef, ctx)
    if (request.blobRef.id.length === 0) {
      throw new BlobStoreError('INVALID_REQUEST', 'blobRef.id must be a non-empty id')
    }
    const view = await this.#registry.findReference(scope, request.blobRef.id)
    if (view === undefined) {
      throw notFound(request.blobRef)
    }
    if (view.blob.contentDigest !== request.blobRef.digest) {
      throw new BlobStoreError(
        'BLOB_INTEGRITY_MISMATCH',
        `blob reference digest ${request.blobRef.digest} does not match the stored digest ${view.blob.contentDigest}`,
      )
    }
    if (view.reference.purpose === 'checkpoint' && view.reference.runId !== ctx.runId) {
      // Deliberately the same error as "absent": a different run must not learn
      // that a private checkpoint exists.
      throw notFound(request.blobRef)
    }
    return view
  }
}

function notFound(blobRef: ResourceRef): BlobStoreError {
  return new BlobStoreError(
    'BLOB_NOT_FOUND',
    `no authorized blob ${blobRef.id} in the requested scope`,
  )
}

function validatePublishRequest(request: BlobPublishRequest): void {
  if (!isSha256Digest(request.contentDigest)) {
    throw new BlobStoreError(
      'INVALID_REQUEST',
      'contentDigest must be a sha256 digest of the form sha256:<64 lowercase hex>',
    )
  }
  if (!Number.isInteger(request.byteSize) || request.byteSize < 0) {
    throw new BlobStoreError('INVALID_REQUEST', 'byteSize must be a non-negative integer')
  }
  if (request.mediaType.trim().length === 0) {
    throw new BlobStoreError('INVALID_REQUEST', 'mediaType must be a non-empty string')
  }
  if (!isBlobPurpose(request.purpose)) {
    throw new BlobStoreError('INVALID_REQUEST', 'purpose is not a declared blob purpose')
  }
  if (request.purpose === 'checkpoint' && request.runId === undefined) {
    throw new BlobStoreError(
      'BLOB_CHECKPOINT_RUN_REQUIRED',
      'a private checkpoint must be bound to the run that produced it',
    )
  }
  if (request.purpose !== 'checkpoint' && request.runId !== undefined) {
    // The database enforces the same rule; reject here so the caller gets a
    // classified error instead of a raw constraint violation.
    throw new BlobStoreError(
      'INVALID_REQUEST',
      'only a checkpoint reference may be bound to a run',
    )
  }
}
