import {
  assertCandidateSourceShape,
  CandidateSourceError,
  isToolContext,
  isUuid,
} from '@ontology/contracts'
import type {
  CandidateSource,
  CandidateSourceStore,
  ImmutableArtifactWriter,
  Rfc3339UtcTimestamp,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'

/** A snapshot is bounded so one page can never exhaust the workspace's artifact store. */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024

export interface WebSnapshotIngestionInput {
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
  readonly mediaType: string
  /** The exact retrieved bytes, archived immutably and never presented as trusted text. */
  readonly content: Uint8Array
  readonly idempotencyKey: string
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
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

/**
 * Ingests an agent-researched web snapshot as a proposed `CandidateSource`.
 *
 * The page is never trusted: its bytes are archived immutably (so "traceable" survives a
 * page that later changes), it is recorded with the `agent_researched` tier and the
 * `proposed` review state, and it may only ground a publishable candidate after a human
 * promotes it. The source id is derived from the idempotency key, the workspace and the
 * archived digest, so a replay of the same snapshot is the same row.
 */
export class CandidateSourceIngestionService {
  constructor(readonly dependencies: CandidateSourceIngestionDependencies) {}

  async ingestWebSnapshot(input: WebSnapshotIngestionInput, ctx: ToolContext): Promise<CandidateSource> {
    if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) {
      throw new CandidateSourceError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
    }
    if (!isUuid(input.workspaceId)) throw new CandidateSourceError('INVALID_SOURCE', 'a workspace UUID is required')
    if (!isHttpsUrl(input.url)) throw new CandidateSourceError('INVALID_SOURCE', 'a web snapshot requires an https page address')
    if (typeof input.mediaType !== 'string' || input.mediaType.length === 0 || input.mediaType.length > 128) {
      throw new CandidateSourceError('INVALID_SOURCE', 'a web snapshot requires a bounded media type')
    }
    if (!(input.content instanceof Uint8Array) || input.content.byteLength === 0 || input.content.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new CandidateSourceError('INVALID_SOURCE', `a web snapshot must carry 1..${String(MAX_SNAPSHOT_BYTES)} bytes`)
    }
    if (!isTimestamp(input.fetchedAt) || !isTimestamp(input.retrievedAt)
      || (input.validUntil !== undefined && !isTimestamp(input.validUntil))) {
      throw new CandidateSourceError('INVALID_SOURCE', 'web snapshot timestamps must be valid instants')
    }
    if (input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new CandidateSourceError('INVALID_SOURCE', 'a web snapshot requires an idempotency key of 8..200 characters')
    }

    const scope = scopeOf(ctx)
    const archived = await this.dependencies.artifacts.putBytes(
      { scopeRef: scope, content: input.content, mediaType: input.mediaType },
      ctx,
    )
    const sourceId = candidateIdFor(sha256DigestOf(canonicalJson({
      workspaceId: input.workspaceId, url: input.url, contentDigest: archived.contentDigest, idempotencyKey: input.idempotencyKey,
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
      contentRef: archived.blobRef,
      contentDigest: archived.contentDigest,
      freshness: { retrievedAt: input.retrievedAt, ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }) },
      reviewState: 'proposed',
      proposedBy: ctx.principal.subjectId,
      recordedAt,
    }
    assertCandidateSourceShape(source)
    return this.dependencies.sources.putSource(scope, { source, idempotencyKey: input.idempotencyKey }, ctx)
  }
}
