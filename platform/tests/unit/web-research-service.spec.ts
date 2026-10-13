import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createToolContext, ModelingBriefError } from '@ontology/contracts'
import type {
  CandidateSource,
  CandidateSourceListFilter,
  CandidateSourceReviewState,
  CandidateSourceStore,
  ImmutableArtifactWriter,
  ModelingBrief,
  ScopeRef,
  SourceTrustTier,
  ToolContext,
  Uuid,
  WebSearchProvider,
  WebSearchProviderRequest,
  WebSearchProviderResult,
} from '@ontology/contracts'
import { CandidateSourceIngestionService, WebResearchError, WebResearchService } from '@ontology/application'

const TENANT = '00000000-0000-4000-8000-000000000001'
const SPACE = '00000000-0000-4000-8000-000000000002'
const WORKSPACE = '00000000-0000-4000-8000-000000000003'
const scopeRef: ScopeRef = { tenantId: TENANT, spaceId: SPACE }

function ctx(roles: readonly string[] = ['researcher']): ToolContext {
  return createToolContext({
    principal: { tenantId: TENANT, subjectId: 'researcher-1', roles: [...roles], scopes: ['tool:invoke'], authEpoch: 1 },
    runId: randomUUID(),
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: { reservationId: randomUUID(), runId: randomUUID(), grantedAt: '2026-10-13T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
    allowedResources: { tenantId: TENANT, spaceId: SPACE, resourceKinds: ['artifact'], sourceRefs: [], collectionRefs: [], domains: ['standards.example.org'], maxRows: 100 },
    traceId: 'trace-research',
  })
}

function digestOf(text: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

class FakeStore implements CandidateSourceStore {
  #byKey = new Map<string, CandidateSource>()
  async putSource(_scope: ScopeRef, input: { readonly source: CandidateSource; readonly idempotencyKey: string }): Promise<CandidateSource> {
    const existing = this.#byKey.get(input.idempotencyKey)
    if (existing !== undefined) return existing
    this.#byKey.set(input.idempotencyKey, input.source)
    return input.source
  }
  async getSource(_scope: ScopeRef, sourceId: Uuid): Promise<CandidateSource | undefined> {
    return [...this.#byKey.values()].find((source) => source.sourceId === sourceId)
  }
  async listSources(_scope: ScopeRef, workspaceId: Uuid, filter: CandidateSourceListFilter): Promise<readonly CandidateSource[]> {
    return [...this.#byKey.values()].filter((source) => source.workspaceId === workspaceId
      && (filter.reviewState === undefined || source.reviewState === filter.reviewState)
      && (filter.trustTier === undefined || source.trustTier === filter.trustTier))
  }
  async reviewSource(_scope: ScopeRef, input: { readonly sourceId: Uuid; readonly reviewState: CandidateSourceReviewState; readonly trustTier?: SourceTrustTier; readonly reviewedBy: string }): Promise<CandidateSource> {
    const current = [...this.#byKey.values()].find((source) => source.sourceId === input.sourceId)
    if (current === undefined) throw new Error('missing source')
    return { ...current, reviewState: input.reviewState, trustTier: input.trustTier ?? current.trustTier, reviewedBy: input.reviewedBy }
  }
}

class FakeWriter implements ImmutableArtifactWriter {
  async putBytes(): Promise<{ blobRef: CandidateSource['contentRef']; contentDigest: `sha256:${string}`; integrity: { algorithm: 'sha256'; digest: `sha256:${string}` } }> {
    throw new Error('archived snapshots must not re-archive bytes')
  }
}

class FakeSearchProvider implements WebSearchProvider {
  readonly providerRef = { id: 'web-search.fake', version: '1.0.0', digest: digestOf('fake') }
  lastRequest: WebSearchProviderRequest | undefined
  constructor(readonly result: WebSearchProviderResult, readonly fail = false) {}
  async search(request: WebSearchProviderRequest): Promise<WebSearchProviderResult> {
    this.lastRequest = request
    if (this.fail) throw new Error('provider unavailable')
    return this.result
  }
}

function brief(overrides: Partial<ModelingBrief> = {}): ModelingBrief {
  return {
    schemaVersion: 'modeling-brief@1',
    workspaceId: WORKSPACE,
    goal: '按 GB50500 建桥架计价本体',
    allowedResearchDomains: ['standards.example.org'],
    freshnessHint: 'year',
    targetKinds: ['object', 'attribute'],
    candidateLimit: 5,
    ...overrides,
  }
}

function build(result: WebSearchProviderResult, fail = false) {
  const sources = new FakeStore()
  const ingestion = new CandidateSourceIngestionService({ artifacts: new FakeWriter(), sources, now: () => '2026-10-13T00:00:00Z' })
  const provider = new FakeSearchProvider(result, fail)
  const service = new WebResearchService({ webSearch: provider, ingestion })
  return { service, sources, provider }
}

const WITH_SNAPSHOT: WebSearchProviderResult = {
  pages: [
    { url: 'https://standards.example.org/gb50500', title: 'GB50500', snippet: 'load tables', fetchedAt: '2026-10-01T08:00:00Z',
      contentDigest: digestOf('page-a'), snapshotRef: { id: '00000000-0000-4000-8000-0000000000aa', version: '1.0.0', digest: digestOf('page-a'), kind: 'artifact' } },
    { url: 'https://standards.example.org/more', title: 'more', snippet: 'no snapshot', fetchedAt: '2026-10-01T08:00:00Z', contentDigest: digestOf('page-b') },
  ],
  truncated: false,
  excludedCount: 0,
}

describe('web research service', () => {
  it('turns a brief into proposed agent-researched sources, skipping pages without a snapshot', async () => {
    const h = build(WITH_SNAPSHOT)
    const result = await h.service.research({ brief: brief(), retrievedAt: '2026-10-13T00:00:00Z', deadline: '2099-01-01T00:00:00Z', idempotencyKey: `research-${randomUUID()}` }, ctx())
    expect(h.provider.lastRequest?.allowedDomains).toEqual(['standards.example.org'])
    expect(h.provider.lastRequest?.query).toBe('按 GB50500 建桥架计价本体')
    expect(result.sources).toHaveLength(1)
    expect(result.skippedWithoutSnapshot).toBe(1)
    expect(result.sources[0]).toMatchObject({ kind: 'web_fetch', trustTier: 'agent_researched', reviewState: 'proposed', workspaceId: WORKSPACE })
    expect(await h.sources.listSources(scopeRef, WORKSPACE, {})).toHaveLength(1)
  })

  it('rejects a brief with no valid research domain before any provider call', async () => {
    const h = build(WITH_SNAPSHOT)
    await expect(h.service.research({ brief: brief({ allowedResearchDomains: ['not a domain'] }), retrievedAt: '2026-10-13T00:00:00Z', deadline: '2099-01-01T00:00:00Z', idempotencyKey: 'research-bad-0001' }, ctx()))
      .rejects.toBeInstanceOf(ModelingBriefError)
    expect(h.provider.lastRequest).toBeUndefined()
  })

  it('refuses research for a principal without the researcher role', async () => {
    const h = build(WITH_SNAPSHOT)
    await expect(h.service.research({ brief: brief(), retrievedAt: '2026-10-13T00:00:00Z', deadline: '2099-01-01T00:00:00Z', idempotencyKey: 'research-role-0001' }, ctx(['business-user'])))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('classifies a provider failure as RESEARCH_FAILED rather than an empty result', async () => {
    const h = build(WITH_SNAPSHOT, true)
    await expect(h.service.research({ brief: brief(), retrievedAt: '2026-10-13T00:00:00Z', deadline: '2099-01-01T00:00:00Z', idempotencyKey: 'research-fail-0001' }, ctx()))
      .rejects.toBeInstanceOf(WebResearchError)
  })
})
