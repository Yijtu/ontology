import {
  assertCandidateSourceShape,
  CandidateSourceError,
  isResourceRef,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  CandidateSource,
  CandidateSourceStore,
  ImmutableArtifactWriter,
  ResourceRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'

/** A snapshot is bounded so one page can never exhaust the workspace's artifact store. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

/** The provenance every ingested web snapshot shares, independent of how its bytes were archived. */
export interface ArchivedWebSnapshotInput {
  readonly workspaceId: Uuid
  /** The canonical `https://` page address the snapshot was retrieved from. */
  readonly url: string
  readonly title?: string
  readonly publisher?: string
  /** A versioned standard the page cites, when it is a public standard. */
  readonly standardRef?: VersionRef
  /** When the provider actually retrieved the page. */
  readonly fetchedAt: Rfc3339UtcTimestamp
  /** When this workspace ingested the snapshot; the freshness clock starts here. */
  readonly retrievedAt: Rfc3339UtcTimestamp
  readonly validUntil?: Rfc3339UtcTimestamp
  /** The immutable snapshot the provider archived; the candidate source's content pin. */
  readonly contentRef: ResourceRef
  readonly contentDigest: Sha256Digest
  readonly idempotencyKey: string
}

export interface WebSnapshotIngestionInput extends Omit<ArchivedWebSnapshotInput, 'contentRef' | 'contentDigest'> {
  readonly mediaType: string
  /** The exact retrieved bytes, archived immutably and never presented as trusted text. */
  readonly content: Uint8Array
}

export interface CandidateSourceIngestionDependencies {
  /** Archives the snapshot bytes immutably; the returned ref is the source's content pin. */
  readonly artifacts: ImmutableArtifactWriter
  readonly sources: CandidateSourceStore
  readonly now?: () => string
}

function isTimestamp(value: unknown): value is Rfc3339UtcTimestamp {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value))
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 200
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/**
 * Ingests an agent-researched web snapshot as a proposed `CandidateSource`.
 *
 * The page is never trusted: its bytes are archived immutably (so "traceable" survives a page that
 * later changes), it is recorded with the `agent_researched` tier and the `proposed` review state,
 * and it may only ground a publishable candidate after a human promotes it. The source id is
 * derived from the idempotency key, the workspace and the archived digest, so a replay of the same
 * snapshot is the same row.
 */
export class CandidateSourceIngestionService {
  constructor(readonly dependencies: CandidateSourceIngestionDependencies) {}

  /** Archive the retrieved bytes, then record the proposed source. */
  async ingestWebSnapshot(input: WebSnapshotIngestionInput, ctx: ToolContext): Promise<CandidateSource> {
    this.#assertContext(ctx)
    if (!isUuid(input.workspaceId)) throw new CandidateSourceError('INVALID_SOURCE', 'a workspace UUID is required')
    if (typeof input.mediaType !== 'string' || input.mediaType.length === 0 || input.mediaType.length > 128) {
      throw new CandidateSourceError('INVALID_SOURCE', 'a web snapshot requires a bounded media type')
    }
    if (!(input.content instanceof Uint8Array) || input.content.byteLength === 0 || input.content.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new CandidateSourceError('INVALID_SOURCE', `a web snapshot must carry 1..${String(MAX_SNAPSHOT_BYTES)} bytes`)
    }
    this.#assertProvenance(input)
    const archived = await this.dependencies.artifacts.putBytes(
      { scopeRef: scopeOf(ctx), content: input.content, mediaType: input.mediaType },
      ctx,
    )
    return this.#persist({ ...input, contentRef: archived.blobRef, contentDigest: archived.contentDigest }, ctx)
  }

  /** Record a proposed source for a snapshot a provider already archived. */
  async ingestArchivedWebSnapshot(input: ArchivedWebSnapshotInput, ctx: ToolContext): Promise<CandidateSource> {
    this.#assertContext(ctx)
    if (!isUuid(input.workspaceId)) throw new CandidateSourceError('INVALID_SOURCE', 'a workspace UUID is required')
    if (!isResourceRef(input.contentRef) || typeof input.contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.contentDigest)) {
      throw new CandidateSourceError('INVALID_SOURCE', 'an archived web snapshot requires an immutable content ref and digest')
    }
    this.#assertProvenance(input)
    return this.#persist(input, ctx)
  }

  /**
   * Build the same proposed `CandidateSource` as `ingestArchivedWebSnapshot` without persisting it,
   * so the atomic candidate-commit port can write it inside the fence-checked transaction
   * (design §7, S08). The server-fixed kind/tier/state and id derivation are unchanged.
   */
  prepareArchivedWebSnapshot(input: ArchivedWebSnapshotInput, ctx: ToolContext): CandidateSource {
    this.#assertContext(ctx)
    if (!isUuid(input.workspaceId)) throw new CandidateSourceError('INVALID_SOURCE', 'a workspace UUID is required')
    if (!isResourceRef(input.contentRef) || typeof input.contentDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.contentDigest)) {
      throw new CandidateSourceError('INVALID_SOURCE', 'an archived web snapshot requires an immutable content ref and digest')
    }
    this.#assertProvenance(input)
    return this.#build(input, ctx)
  }

  #assertContext(ctx: ToolContext): void {
    if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) {
      throw new CandidateSourceError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
    }
  }

  #assertProvenance(input: Omit<ArchivedWebSnapshotInput, 'contentRef' | 'contentDigest'>): void {
    if (!isHttpsUrl(input.url)) throw new CandidateSourceError('INVALID_SOURCE', 'a web snapshot requires an https page address')
    if (!isTimestamp(input.fetchedAt) || !isTimestamp(input.retrievedAt)
      || (input.validUntil !== undefined && !isTimestamp(input.validUntil))) {
      throw new CandidateSourceError('INVALID_SOURCE', 'web snapshot timestamps must be valid instants')
    }
    if (!isKey(input.idempotencyKey)) throw new CandidateSourceError('INVALID_SOURCE', 'a web snapshot requires an idempotency key of 8..200 characters')
  }

  async #persist(input: ArchivedWebSnapshotInput, ctx: ToolContext): Promise<CandidateSource> {
    const scope = scopeOf(ctx)
    const source = this.#build(input, ctx)
    return this.dependencies.sources.putSource(scope, { source, idempotencyKey: input.idempotencyKey }, ctx)
  }

  #build(input: ArchivedWebSnapshotInput, ctx: ToolContext): CandidateSource {
    const sourceId = candidateIdFor(sha256DigestOf(canonicalJson({
      workspaceId: input.workspaceId, url: input.url, contentDigest: input.contentDigest, idempotencyKey: input.idempotencyKey,
    })))
    const recordedAt = (this.dependencies.now ?? (() => new Date().toISOString()))()
    const source: CandidateSource = {
      schemaVersion: 'candidate-source@1',
      sourceId,
      workspaceId: input.workspaceId,
      kind: 'web_fetch',
      trustTier: 'agent_researched',
      origin: {
        url: input.url,
        ...(input.publisher === undefined ? {} : { publisher: input.publisher }),
        ...(input.standardRef === undefined ? {} : { standardRef: input.standardRef }),
        fetchedAt: input.fetchedAt,
      },
      contentRef: input.contentRef,
      contentDigest: input.contentDigest,
      freshness: { retrievedAt: input.retrievedAt, ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }) },
      reviewState: 'proposed',
      proposedBy: ctx.principal.subjectId,
      recordedAt,
    }
    assertCandidateSourceShape(source)
    return source
  }
}
