import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type {
  CandidateSource,
  CandidateSourceListFilter,
  CandidateSourceReviewState,
  CandidateSourceStore,
  ImmutableArtifactWriter,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  SourceTrustTier,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { CandidateSourceIngestionService } from '@ontology/application'

const TENANT = '00000000-0000-4000-8000-000000000001'
const SPACE = '00000000-0000-4000-8000-000000000002'
const WORKSPACE = '00000000-0000-4000-8000-000000000003'
const scopeRef: ScopeRef = { tenantId: TENANT, spaceId: SPACE }

function ctx(): ToolContext {
  return createToolContext({
    principal: { tenantId: TENANT, subjectId: 'researcher-1', roles: ['profile-editor'], scopes: ['tool:invoke'], authEpoch: 1 },
    runId: randomUUID(),
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId: randomUUID(), grantedAt: '2026-10-13T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    allowedResources: { tenantId: TENANT, spaceId: SPACE, resourceKinds: ['artifact'], sourceRefs: [], collectionRefs: [], domains: ['example.org'], maxRows: 100 },
    traceId: 'trace-ingest',
  })
}

function digestOf(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

class RecordingArtifactWriter implements ImmutableArtifactWriter {
  calls = 0
  async putBytes(request: { readonly content: Uint8Array; readonly mediaType: string }): Promise<{ blobRef: ResourceRef; contentDigest: Sha256Digest; integrity: { algorithm: 'sha256'; digest: Sha256Digest } }> {
    this.calls += 1
    const contentDigest = digestOf(request.content)
    return {
      blobRef: { id: randomUUID(), version: '1.0.0', digest: contentDigest, kind: 'artifact' },
      contentDigest,
      integrity: { algorithm: 'sha256', digest: contentDigest },
    }
  }
}

class InMemoryCandidateSourceStore implements CandidateSourceStore {
  #byKey = new Map<string, CandidateSource>()
  #byId = new Map<string, CandidateSource>()
  async putSource(_scope: ScopeRef, input: { readonly source: CandidateSource; readonly idempotencyKey: string }): Promise<CandidateSource> {
    const existing = this.#byKey.get(input.idempotencyKey)
    if (existing !== undefined) return existing
    this.#byKey.set(input.idempotencyKey, input.source)
    this.#byId.set(input.source.sourceId, input.source)
    return input.source
  }
  async getSource(_scope: ScopeRef, sourceId: Uuid): Promise<CandidateSource | undefined> {
    return this.#byId.get(sourceId)
  }
  async listSources(_scope: ScopeRef, workspaceId: Uuid, filter: CandidateSourceListFilter): Promise<readonly CandidateSource[]> {
    return [...this.#byId.values()].filter((source) => source.workspaceId === workspaceId
      && (filter.reviewState === undefined || source.reviewState === filter.reviewState)
      && (filter.trustTier === undefined || source.trustTier === filter.trustTier))
  }
  async reviewSource(_scope: ScopeRef, input: { readonly sourceId: Uuid; readonly reviewState: CandidateSourceReviewState; readonly trustTier?: SourceTrustTier; readonly reviewedBy: string }): Promise<CandidateSource> {
    const current = this.#byId.get(input.sourceId)
    if (current === undefined) throw new Error('missing source')
    const next = { ...current, reviewState: input.reviewState, trustTier: input.trustTier ?? current.trustTier, reviewedBy: input.reviewedBy }
    this.#byId.set(input.sourceId, next)
    return next
  }
}

function build() {
  const artifacts = new RecordingArtifactWriter()
  const sources = new InMemoryCandidateSourceStore()
  const service = new CandidateSourceIngestionService({ artifacts, sources, now: () => '2026-10-13T00:00:00Z' })
  return { service, artifacts, sources }
}

function input(overrides: Partial<Parameters<CandidateSourceIngestionService['ingestWebSnapshot']>[0]> = {}) {
  return {
    workspaceId: WORKSPACE,
    url: 'https://standards.example.org/gb50500/cable-tray',
    title: 'Cable tray load table',
    publisher: 'example standards body',
    fetchedAt: '2026-10-01T08:00:00Z',
    retrievedAt: '2026-10-13T00:00:00Z',
    mediaType: 'text/html',
    content: new TextEncoder().encode('<html>cable tray load capacity 3.5kN</html>'),
    idempotencyKey: `web-${randomUUID()}`,
    ...overrides,
  }
}

describe('candidate source web-snapshot ingestion', () => {
  it('archives the snapshot and stores a proposed agent-researched candidate source', async () => {
    const h = build()
    const source = await h.service.ingestWebSnapshot(input(), ctx())
    expect(h.artifacts.calls).toBe(1)
    expect(source).toMatchObject({
      schemaVersion: 'candidate-source@1',
      workspaceId: WORKSPACE,
      kind: 'web_fetch',
      trustTier: 'agent_researched',
      reviewState: 'proposed',
      proposedBy: 'researcher-1',
      origin: { url: 'https://standards.example.org/gb50500/cable-tray', publisher: 'example standards body', fetchedAt: '2026-10-01T08:00:00Z' },
      freshness: { retrievedAt: '2026-10-13T00:00:00Z' },
      recordedAt: '2026-10-13T00:00:00Z',
    })
    expect(source.contentDigest).toBe(digestOf(input().content))
    const stored = await h.sources.listSources(scopeRef, WORKSPACE, {})
    expect(stored).toHaveLength(1)
  })

  it('is idempotent for a repeated snapshot key so a replay is the same row', async () => {
    const h = build()
    const request = input({ idempotencyKey: 'web-same-key-0001' })
    const first = await h.service.ingestWebSnapshot(request, ctx())
    const replay = await h.service.ingestWebSnapshot(request, ctx())
    expect(replay.sourceId).toBe(first.sourceId)
    expect(await h.sources.listSources(scopeRef, WORKSPACE, {})).toHaveLength(1)
  })

  it('refuses a non-https or empty snapshot rather than archiving untrusted content', async () => {
    const h = build()
    await expect(h.service.ingestWebSnapshot(input({ url: 'http://insecure.example.org/page' }), ctx()))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE' })
    await expect(h.service.ingestWebSnapshot(input({ content: new Uint8Array() }), ctx()))
      .rejects.toMatchObject({ code: 'INVALID_SOURCE' })
    expect(h.artifacts.calls).toBe(0)
  })
})
