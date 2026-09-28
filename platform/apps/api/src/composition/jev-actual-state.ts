import { BlobStoreError, LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import {
  JevStateResolutionError,
  jevActualStateDigest,
} from '@ontology/adapter-model-jev'
import type {
  JevActualState,
  JevActualStateResolutionInput,
  JevActualStateResolver,
} from '@ontology/adapter-model-jev'
import { isToolContext } from '@ontology/contracts'
import type { ResourceRef, ScopeRef, Sha256Digest, ToolContext, Uuid } from '@ontology/contracts'

export interface JevActualStateRefAuthorizer {
  /** True only for an immutable actual-state ref recorded for this exact run/profile. */
  isApproved(input: {
    readonly runId: Uuid
    readonly resolvedProfileHash: Sha256Digest
    readonly stateRef: ResourceRef
  }, ctx: ToolContext): Promise<boolean>
}

/**
 * Resolve a run-pinned JEV state through the local immutable artifact registry.
 * The resolver first asks the blob store for scoped authorization metadata (without
 * reading the object body), enforces its authoritative byte limit, and only then requests
 * the JSON bytes for parsing. The host must pass the run's actual stateRef; this closure is
 * not a client-controlled artifact lookup capability.
 */
export function createCoreJevActualStateResolver(input: {
  readonly blobStore: LocalImmutableBlobStore
  readonly stateRefAuthorizer: JevActualStateRefAuthorizer
}): JevActualStateResolver {
  return {
    async resolve(
      request: JevActualStateResolutionInput,
      ctx: ToolContext,
    ): Promise<{ readonly state: JevActualState; readonly resolvedRef: ResourceRef; readonly complete: true }> {
      const scopeRef = scopeFrom(ctx)
      if (!isSupportedStateRef(request.stateRef) || request.stateRef.kind !== 'artifact') {
        throw new JevStateResolutionError('SCOPE_MISMATCH')
      }
      if (!validLimit(request.maxBytes) || !validLimit(request.maxRecords)) {
        throw new JevStateResolutionError('INVALID_STATE')
      }
      if (isAborted(request.signal)) throw new JevStateResolutionError('CANCELLED')

      let isApproved: boolean
      try {
        isApproved = await input.stateRefAuthorizer.isApproved({
          runId: ctx.runId,
          resolvedProfileHash: ctx.resolvedProfileHash,
          stateRef: request.stateRef,
        }, ctx)
      } catch (error) {
        if (isAborted(request.signal)) throw new JevStateResolutionError('CANCELLED')
        if (error instanceof JevStateResolutionError) throw error
        throw new JevStateResolutionError('UNAVAILABLE')
      }
      if (isAborted(request.signal)) throw new JevStateResolutionError('CANCELLED')
      if (!isApproved) throw new JevStateResolutionError('NOT_FOUND')

      const authorizationRequest = { scopeRef, blobRef: request.stateRef }
      let metadata: Awaited<ReturnType<LocalImmutableBlobStore['getAuthorizedMetadata']>>
      try {
        metadata = await input.blobStore.getAuthorizedMetadata(authorizationRequest, ctx)
      } catch (error) {
        throw resolutionError(error, request.signal)
      }
      if (isAborted(request.signal)) throw new JevStateResolutionError('CANCELLED')
      if (!sameRef(metadata.blobRef, request.stateRef)) {
        throw new JevStateResolutionError('VERSION_MISMATCH')
      }
      if (metadata.contentDigest !== request.stateRef.digest) {
        throw new JevStateResolutionError('DIGEST_MISMATCH')
      }
      if (!Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 0) {
        throw new JevStateResolutionError('INVALID_STATE')
      }
      if (metadata.byteSize > request.maxBytes) throw new JevStateResolutionError('TOO_LARGE')
      if (!isJsonMediaType(metadata.mediaType)) throw new JevStateResolutionError('INVALID_STATE')

      let bytes: Uint8Array
      try {
        bytes = await input.blobStore.readAuthorized(authorizationRequest, ctx)
      } catch (error) {
        throw resolutionError(error, request.signal)
      }
      if (isAborted(request.signal)) throw new JevStateResolutionError('CANCELLED')
      if (bytes.byteLength > request.maxBytes) throw new JevStateResolutionError('TOO_LARGE')
      if (bytes.byteLength !== metadata.byteSize) throw new JevStateResolutionError('INCOMPLETE')

      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new JevStateResolutionError('INVALID_STATE')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        throw new JevStateResolutionError('INVALID_STATE')
      }
      assertJevState(parsed, request.maxRecords)
      if (isAborted(request.signal)) throw new JevStateResolutionError('CANCELLED')

      let digest: string
      try {
        digest = jevActualStateDigest(parsed)
      } catch {
        throw new JevStateResolutionError('INVALID_STATE')
      }
      if (digest !== request.stateRef.digest) throw new JevStateResolutionError('DIGEST_MISMATCH')
      return { state: parsed, resolvedRef: request.stateRef, complete: true }
    },
  }
}

function scopeFrom(ctx: ToolContext): ScopeRef {
  if (
    !isToolContext(ctx) ||
    ctx.allowedResources.tenantId !== ctx.principal.tenantId ||
    !ctx.allowedResources.resourceKinds.includes('artifact')
  ) {
    throw new JevStateResolutionError('SCOPE_MISMATCH')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function isSupportedStateRef(value: ResourceRef): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    typeof value.digest === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value.digest) &&
    typeof value.kind === 'string'
  )
}

function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest &&
    left.kind === right.kind
  )
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isJsonMediaType(value: string): boolean {
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function assertJevState(value: unknown, maxRecords: number): asserts value is JevActualState {
  const pending: unknown[] = [value]
  let count = 0
  while (pending.length > 0) {
    const current = pending.pop()
    count += 1
    if (count > maxRecords) throw new JevStateResolutionError('TOO_LARGE')
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new JevStateResolutionError('INVALID_STATE')
      continue
    }
    if (Array.isArray(current)) {
      if (current.length > maxRecords) throw new JevStateResolutionError('TOO_LARGE')
      for (const item of current) pending.push(item)
      continue
    }
    if (typeof current !== 'object') throw new JevStateResolutionError('INVALID_STATE')
    const prototype = Object.getPrototypeOf(current) as unknown
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JevStateResolutionError('INVALID_STATE')
    }
    for (const item of Object.values(current)) pending.push(item)
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

function resolutionError(error: unknown, signal: AbortSignal | undefined): JevStateResolutionError {
  if (isAborted(signal)) return new JevStateResolutionError('CANCELLED')
  if (error instanceof JevStateResolutionError) return error
  if (error instanceof BlobStoreError) {
    switch (error.code) {
      case 'BLOB_NOT_FOUND':
      case 'BLOB_OBJECT_MISSING':
        return new JevStateResolutionError('NOT_FOUND')
      case 'SCOPE_MISMATCH':
        return new JevStateResolutionError('SCOPE_MISMATCH')
      case 'BLOB_INTEGRITY_MISMATCH':
      case 'BLOB_DIGEST_MISMATCH':
        return new JevStateResolutionError('DIGEST_MISMATCH')
      case 'BLOB_SIZE_MISMATCH':
        return new JevStateResolutionError('TOO_LARGE')
      default:
        return new JevStateResolutionError('UNAVAILABLE')
    }
  }
  return new JevStateResolutionError('UNAVAILABLE')
}
