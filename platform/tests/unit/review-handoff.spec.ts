import { describe, expect, it } from 'vitest'
import { CandidateReviewHandoffService, CandidateSourceReviewService } from '@ontology/application'
import { CandidateSourceError } from '@ontology/contracts'
import type {
  CandidateSource,
  CandidateSourceRecord,
  CandidateSourceReviewCommand,
  CandidateSourceReviewEvent,
  CandidateSourceReviewReceipt,
  CandidateSourceStore,
  CandidateSubmissionRecord,
  CandidateSourceLink,
  AssetCandidateVersion,
  ScopeRef,
  SourceAdmission,
  SourceTierPromotionCommand,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const WORKSPACE = '99999999-9999-4999-8999-999999999999'
const CANDIDATE = '44444444-4444-4444-8444-444444444444'
const SOURCE_A = '55555555-5555-4555-8555-555555555555'
const SOURCE_B = '66666666-6666-4666-8666-666666666666'
const EDITOR = toolContext(TENANT, SPACE, ['profile-editor'], 'editor', 'run-1')
const ADMIN = toolContext(TENANT, SPACE, ['platform-admin'], 'admin', 'run-1')
const DIGEST = `sha256:${'a'.repeat(64)}`

function ref(id: string) {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'artifact' as const }
}

function candidateSource(sourceId: string, overrides: Partial<CandidateSource> = {}): CandidateSourceRecord {
  return {
    schemaVersion: 'candidate-source@1', sourceId, workspaceId: WORKSPACE, kind: 'web_fetch',
    trustTier: 'agent_researched', origin: { url: `https://example.test/${sourceId}` },
    contentRef: ref(sourceId), contentDigest: DIGEST, reviewState: 'proposed', proposedBy: 'researcher',
    recordedAt: '2026-10-16T00:00:00Z', revision: '1', ...overrides,
  }
}

class FakeSourceStore implements CandidateSourceStore {
  readonly sources = new Map<string, CandidateSourceRecord>()
  readonly events: CandidateSourceReviewEvent[] = []
  #seq = 0
  seed(record: CandidateSourceRecord): void { this.sources.set(record.sourceId, record) }
  async putSource(_s: ScopeRef, input: { readonly source: CandidateSource }, _c: ToolContext): Promise<CandidateSourceRecord> {
    void _s; void _c
    const record: CandidateSourceRecord = { ...input.source, revision: '1' }
    this.sources.set(record.sourceId, record)
    return record
  }
  async getSource(_s: ScopeRef, sourceId: Uuid, _c: ToolContext): Promise<CandidateSourceRecord | undefined> {
    void _s; void _c
    return this.sources.get(sourceId)
  }
  async listSources(_s: ScopeRef, workspaceId: Uuid, _f: { readonly limit?: number }, _c: ToolContext): Promise<readonly CandidateSourceRecord[]> {
    void _s; void _f; void _c
    return [...this.sources.values()].filter((entry) => entry.workspaceId === workspaceId)
  }
  async reviewSource(): Promise<CandidateSourceRecord> { throw new Error('unused') }
  async reviewSourceCommand(_s: ScopeRef, command: CandidateSourceReviewCommand, _c: ToolContext): Promise<CandidateSourceReviewReceipt> {
    void _s; void _c
    const current = this.sources.get(command.sourceId)
    if (current === undefined) throw new CandidateSourceError('NOT_FOUND', 'missing')
    if (current.revision !== command.expectedRevision) throw new CandidateSourceError('VERSION_CONFLICT', 'stale')
    const next: CandidateSourceRecord = {
      ...current, reviewState: command.reviewState,
      trustTier: command.trustTier ?? current.trustTier, reviewedBy: command.reviewedBy,
      revision: String(BigInt(current.revision) + 1n),
    }
    this.sources.set(next.sourceId, next)
    this.#seq += 1
    const eventId = `evt-${String(this.#seq)}`
    this.events.push({
      schemaVersion: 'candidate-source-review-event@1', eventId, sourceId: next.sourceId, workspaceId: next.workspaceId,
      previousState: current.reviewState, nextState: next.reviewState, previousTrustTier: current.trustTier,
      nextTrustTier: next.trustTier, reason: command.reason, basisRefs: command.basisRefs,
      actor: command.reviewedBy, recordedAt: '2026-10-16T00:00:00Z', idempotencyKey: command.idempotencyKey,
    })
    return { sourceId: next.sourceId, revision: next.revision, reviewState: next.reviewState, trustTier: next.trustTier, eventId, replayed: false }
  }
}

class FakeAdmissionStore {
  readonly admitted = new Set<string>()
  async findAdmissionBySource(_s: ScopeRef, _w: Uuid, sourceId: Uuid, _c: ToolContext): Promise<SourceAdmission | undefined> {
    void _s; void _w; void _c
    return this.admitted.has(sourceId) ? ({ schemaVersion: 'source-admission@1', admissionId: sourceId } as unknown as SourceAdmission) : undefined
  }
}

class FakeSubmissionStore {
  constructor(readonly records: readonly CandidateSubmissionRecord[]) {}
  async listUnconfirmedByWorkspace(_s: ScopeRef, workspaceId: Uuid, _c: ToolContext): Promise<readonly CandidateSubmissionRecord[]> {
    void _s; void _c
    return this.records.filter((record) => record.workspaceId === workspaceId)
  }
  async listLinksForCandidate(): Promise<readonly CandidateSourceLink[]> { return [] }
  async findByKey(): Promise<undefined> { return undefined }
  async record(): Promise<never> { throw new Error('unused') }
}

function link(candidateId: string, evidenceIndex: number, sourceRefId: string, overrides: Partial<CandidateSourceLink> = {}): CandidateSourceLink {
  return {
    candidateId, candidateKind: 'definition', submissionIndex: 0, evidenceIndex, sourceRef: ref(sourceRefId),
    trustTier: 'agent_researched', parserVersion: '1.0.0', pendingConfirmation: true, recordedAt: '2026-10-16T00:00:00Z', ...overrides,
  }
}

function record(links: readonly CandidateSourceLink[]): CandidateSubmissionRecord {
  return {
    schemaVersion: 'candidate-submission-record@1', runId: '33333333-3333-4333-8333-333333333333', workspaceId: WORKSPACE,
    idempotencyKey: 'idem-1', commandDigest: DIGEST,
    receipt: { schemaVersion: 'submit-candidates-receipt@1', runId: '33333333-3333-4333-8333-333333333333', workspaceId: WORKSPACE,
      commandDigest: DIGEST, accepted: [{ submissionIndex: 0, candidateId: CANDIDATE, kind: 'definition', state: 'pending_confirmation', pendingConfirmation: true, issues: [], sourceRefs: links.map((l) => l.sourceRef) }],
      rejected: [], replayed: false, recordedAt: '2026-10-16T00:00:00Z' },
    links, createdBy: 'agent', recordedAt: '2026-10-16T00:00:00Z',
  }
}

function successor(overrides: Partial<AssetCandidateVersion>): AssetCandidateVersion {
  return {
    candidateId: '77777777-7777-4777-8777-777777777777', batchId: 'batch-1', workspaceId: WORKSPACE,
    logicalId: 'tariff', domain: 'definition', kind: 'object',
    payload: { kind: 'object', logicalId: 'tariff', displayName: '电价', businessMeaning: 'x', suggestedReason: 'y', conflicts: [], identityAttributeIds: [] },
    inputDraftRef: { workspaceId: WORKSPACE, revision: '1', digest: DIGEST }, sourceRefs: [], sourceSpans: [],
    state: 'pending_review', pendingConfirmation: false, issues: [], contentDigest: DIGEST, idempotencyKey: 'k', recordedAt: '2026-10-16T00:00:00Z',
    replacesCandidateId: CANDIDATE, ...overrides,
  }
}

function store(overrides: Partial<{ definitionCandidates: { getCandidate: (s: ScopeRef, id: Uuid, c: ToolContext) => Promise<AssetCandidateVersion | undefined>; listCandidates: (s: ScopeRef, w: Uuid, q: { readonly limit?: number }, c: ToolContext) => Promise<AssetCandidateVersion[]> } }> = {}) {
  const sources = new FakeSourceStore()
  sources.seed(candidateSource(SOURCE_A))
  sources.seed(candidateSource(SOURCE_B))
  const admissions = new FakeAdmissionStore()
  const submissions = new FakeSubmissionStore([record([link(CANDIDATE, 0, SOURCE_A), link(CANDIDATE, 1, SOURCE_B)])])
  const service = new CandidateReviewHandoffService({ receipts: submissions, sources, admissions, ...overrides })
  return { service, sources, admissions }
}

describe('source → asset review hand-off', () => {
  it('stays blocked while any cited source is not approved, and shows each source separately', async () => {
    const { service, sources, admissions } = store()
    admissions.admitted.add(SOURCE_A)
    // Source A approved + admitted, source B still proposed: the candidate must stay blocked.
    await sources.reviewSourceCommand(SCOPE, { schemaVersion: 'candidate-source-review@1', sourceId: SOURCE_A, workspaceId: WORKSPACE,
      reviewState: 'approved', trustTier: 'public_standard', reviewedBy: 'admin', reason: 'r', expectedRevision: '1', basisRefs: [], idempotencyKey: 'k1' }, ADMIN)
    const view = await service.readHandoff(WORKSPACE, EDITOR)
    const candidate = view.candidates[0]
    expect(candidate?.links).toHaveLength(2)
    expect(candidate?.blocked).toBe(true)
    expect(candidate?.readiness).toBe('pending_sources')
    expect(candidate?.blockCodes).toContain('SOURCE_TRUST_BLOCKED')
    expect(candidate?.links.map((entry) => entry.reviewState).sort()).toEqual(['approved', 'proposed'])
  })

  it('marks a candidate whose sources are all confirmed as awaiting re-grounding (not ready)', async () => {
    const { service, sources, admissions } = store()
    admissions.admitted.add(SOURCE_A)
    admissions.admitted.add(SOURCE_B)
    for (const id of [SOURCE_A, SOURCE_B]) {
      await sources.reviewSourceCommand(SCOPE, { schemaVersion: 'candidate-source-review@1', sourceId: id, workspaceId: WORKSPACE,
        reviewState: 'approved', trustTier: 'public_standard', reviewedBy: 'admin', reason: 'r', expectedRevision: '1', basisRefs: [], idempotencyKey: `k-${id}` }, ADMIN)
    }
    const candidate = (await service.readHandoff(WORKSPACE, EDITOR)).candidates[0]
    expect(candidate?.allSourcesConfirmed).toBe(true)
    expect(candidate?.blocked).toBe(true)
    expect(candidate?.readiness).toBe('regrounding_required')
    expect(candidate?.blockCodes).toEqual(['REGROUNDING_REQUIRED'])
  })

  it('marks the candidate ready only after a re-grounding successor exists, preserving the original', async () => {
    const definitionCandidates = {
      getCandidate: async (): Promise<AssetCandidateVersion | undefined> => undefined,
      listCandidates: async (): Promise<AssetCandidateVersion[]> => [successor({})],
    }
    const { service, sources, admissions } = store({ definitionCandidates })
    admissions.admitted.add(SOURCE_A)
    admissions.admitted.add(SOURCE_B)
    for (const id of [SOURCE_A, SOURCE_B]) {
      await sources.reviewSourceCommand(SCOPE, { schemaVersion: 'candidate-source-review@1', sourceId: id, workspaceId: WORKSPACE,
        reviewState: 'approved', trustTier: 'public_standard', reviewedBy: 'admin', reason: 'r', expectedRevision: '1', basisRefs: [], idempotencyKey: `k2-${id}` }, ADMIN)
    }
    const candidate = (await service.readHandoff(WORKSPACE, EDITOR)).candidates[0]
    expect(candidate?.blocked).toBe(false)
    expect(candidate?.readiness).toBe('ready_for_review')
    expect(candidate?.regroundedCandidateId).toBe('77777777-7777-4777-8777-777777777777')
    expect(candidate?.blockCodes).toEqual([])
  })

  it('does not treat a pending source as confirmed just because an approval exists', async () => {
    const { service } = store()
    // No source approved at all: still blocked with a reason per link.
    const candidate = (await service.readHandoff(WORKSPACE, EDITOR)).candidates[0]
    expect(candidate?.links.every((entry) => entry.pendingConfirmation && entry.blockReason !== undefined)).toBe(true)
    expect(candidate?.allSourcesConfirmed).toBe(false)
  })
})

describe('review is not a tier promotion', () => {
  it('refuses a review that would change the source trust tier', async () => {
    const sources = new FakeSourceStore(); sources.seed(candidateSource(SOURCE_A))
    const service = new CandidateSourceReviewService({ sources })
    await expect(service.review({ schemaVersion: 'candidate-source-review@1', sourceId: SOURCE_A, workspaceId: WORKSPACE,
      reviewState: 'approved', trustTier: 'public_standard', reviewedBy: 'editor', reason: 'r', expectedRevision: '1', basisRefs: [], idempotencyKey: 'k' }, EDITOR))
      .rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('accepts a review that keeps the same tier', async () => {
    const sources = new FakeSourceStore(); sources.seed(candidateSource(SOURCE_A))
    const service = new CandidateSourceReviewService({ sources })
    const receipt = await service.review({ schemaVersion: 'candidate-source-review@1', sourceId: SOURCE_A, workspaceId: WORKSPACE,
      reviewState: 'approved', reviewedBy: 'editor', reason: 'r', expectedRevision: '1', basisRefs: [], idempotencyKey: 'k' }, EDITOR)
    expect(receipt.reviewState).toBe('approved')
    expect(receipt.trustTier).toBe('agent_researched')
  })

  it('requires a platform-admin to promote a tier and preserves the review state', async () => {
    const sources = new FakeSourceStore(); sources.seed(candidateSource(SOURCE_A, { reviewState: 'approved' }))
    const service = new CandidateSourceReviewService({ sources })
    const command: SourceTierPromotionCommand = { schemaVersion: 'source-tier-promotion@1', workspaceId: WORKSPACE, sourceId: SOURCE_A,
      expectedRevision: '1', nextTrustTier: 'public_standard', reason: 'human confirmed the standard', basisRefs: [], promotedBy: 'editor', idempotencyKey: 'p1' }
    await expect(service.promoteTier(command, EDITOR)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const receipt = await service.promoteTier({ ...command, promotedBy: 'admin' }, ADMIN)
    expect(receipt.trustTier).toBe('public_standard')
    expect(receipt.reviewState).toBe('approved')
  })
})
