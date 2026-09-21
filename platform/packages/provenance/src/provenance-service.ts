import { createHash } from 'node:crypto'
import { isToolContext } from '@ontology/contracts'
import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPort,
  ControlAppendEventRequest,
  ControlRepository,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import { ProvenanceError } from './errors'
import type { SourceLocationInput, SourceLocationRecord } from './source-location'
import {
  assertSourceLocationInput,
  buildSourceLocationRecord,
  lineageKeyOf,
  locatorKeyOf,
} from './source-location'

/**
 * Narrow byte-reading capability. `blob-local` implements it alongside
 * `BlobPort`; provenance receives it by construction injection and never
 * imports an adapter.
 */
export interface AuthorizedArtifactReader {
  readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array>
}

export interface ArtifactProvenanceServiceDependencies {
  readonly blobs: BlobPort
  readonly control: ControlRepository
  readonly reader?: AuthorizedArtifactReader
  readonly now?: () => string
}

function resolveTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new ProvenanceError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ProvenanceError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new ProvenanceError(
      'SCOPE_MISMATCH',
      'request scope does not match the trusted principal scope',
    )
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalSourceLocationPayload(input: SourceLocationInput, lineageKey: string): string {
  return JSON.stringify({
    scopeRef: { tenantId: input.scopeRef.tenantId, spaceId: input.scopeRef.spaceId },
    artifactRef: {
      id: input.artifactRef.id,
      version: input.artifactRef.version,
      digest: input.artifactRef.digest,
      kind: input.artifactRef.kind,
    },
    documentVersionRef: {
      id: input.documentVersionRef.id,
      version: input.documentVersionRef.version,
      digest: input.documentVersionRef.digest,
      kind: input.documentVersionRef.kind,
    },
    page: input.page ?? null,
    offset: input.offset ?? null,
    quoteDigest: input.quoteDigest,
    approximateLocator: input.approximateLocator ?? false,
    normalizationRef: input.normalizationRef ?? null,
    lineageKey,
  })
}

/**
 * Source-location / provenance service (C3.1, D3.2).
 *
 * It binds an evidence location to an *authorized* immutable artifact: the
 * artifact must be readable in the caller's tenant/space before a provenance
 * record is appended, and the append-only control event makes a retry
 * idempotent. It holds only ports — `BlobPort` and `ControlRepository` — and
 * never imports a concrete adapter.
 */
export class ArtifactProvenanceService {
  readonly #blobs: BlobPort
  readonly #control: ControlRepository
  readonly #reader: AuthorizedArtifactReader | undefined
  readonly #now: () => string

  constructor(dependencies: ArtifactProvenanceServiceDependencies) {
    this.#blobs = dependencies.blobs
    this.#control = dependencies.control
    this.#reader = dependencies.reader
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /**
   * Record a verifiable locator for an authorized artifact. The lineage key is
   * derived from the artifact's content digest, so duplicate copies of one
   * document share a lineage without any cross-tenant content lookup.
   */
  async recordSourceLocation(
    input: SourceLocationInput,
    ctx: ToolContext,
  ): Promise<SourceLocationRecord> {
    resolveTrustedScope(input.scopeRef, ctx)
    assertSourceLocationInput(input)

    let authorized: BlobGetAuthorizedResponse
    try {
      authorized = await this.#blobs.getAuthorized(
        { scopeRef: input.scopeRef, blobRef: input.artifactRef },
        ctx,
      )
    } catch (error) {
      throw new ProvenanceError(
        'ARTIFACT_NOT_AUTHORIZED',
        `artifact ${input.artifactRef.id} is not readable in the requested scope`,
        { cause: error },
      )
    }

    const lineageKey = lineageKeyOf(authorized.contentDigest)
    const payload = canonicalSourceLocationPayload(input, lineageKey)
    const payloadDigest = `sha256:${sha256Hex(payload)}`
    const request: ControlAppendEventRequest = {
      scopeRef: input.scopeRef,
      streamRef: `source-locations:${input.documentVersionRef.id}`,
      payloadDigest,
      idempotencyKey: [
        'source-location',
        input.documentVersionRef.id,
        input.artifactRef.id,
        locatorKeyOf(input),
        input.quoteDigest,
        input.approximateLocator === true ? 'approximate' : 'exact',
      ].join(':'),
    }

    let recordedSeq: string
    try {
      const appended = await this.#control.appendEvent(request, ctx)
      recordedSeq = appended.recordedSeq
    } catch (error) {
      if (error instanceof ProvenanceError) {
        throw error
      }
      throw new ProvenanceError(
        'PROVENANCE_PERSIST_FAILED',
        'could not persist the source location as an append-only control event',
        { cause: error },
      )
    }

    return buildSourceLocationRecord(input, lineageKey, recordedSeq, this.#now())
  }

  /** Same-domain authorized artifact metadata; delegates to the blob port. */
  async describeAuthorizedArtifact(
    blobRef: ResourceRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<BlobGetAuthorizedResponse> {
    resolveTrustedScope(scopeRef, ctx)
    return this.#blobs.getAuthorized({ scopeRef, blobRef }, ctx)
  }

  /** Same-domain authorized byte read through the injected scoped reader. */
  async readAuthorizedArtifact(
    blobRef: ResourceRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<Uint8Array> {
    resolveTrustedScope(scopeRef, ctx)
    if (this.#reader === undefined) {
      throw new ProvenanceError(
        'ARTIFACT_READER_NOT_CONFIGURED',
        'no authorized artifact reader was injected',
      )
    }
    return this.#reader.readAuthorized({ scopeRef, blobRef }, ctx)
  }
}
