import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CandidateSubmissionService,
  InMemoryAssetCandidateStore,
  InMemoryCandidateSubmissionStore,
  InMemoryResearchDocumentSetStore,
  ResearchMaterialReadService,
  StaticDefinitionTerminologySource,
} from '@ontology/application'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import type {
  AssetDraftVersion,
  BudgetLedgerPort,
  CreateIndustryWorkspaceInput,
  IndustryWorkspace,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceStore,
  IndustryWorkspaceWriteResult,
  ResearchDocumentMember,
  ResourceRef,
  RevisionString,
  ScopeRef,
  CandidateSubmission,
  SubmitCandidatesCommand,
  SubmitCandidatesRequest,
  SourceGroundingPort,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'
import { RecordingControlRepository } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const WORKSPACE = '99999999-9999-4999-8999-999999999999'
const RUN = '33333333-3333-4333-8333-333333333333'
const EDITOR = toolContext(TENANT, SPACE, ['profile-editor'], 'editor', RUN)
const RESEARCHER = toolContext(TENANT, SPACE, ['researcher'], 'researcher', RUN)

const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const DIGEST_C = `sha256:${'c'.repeat(64)}`
const DIGEST_D = `sha256:${'d'.repeat(64)}`
const DIGEST_E = `sha256:${'e'.repeat(64)}`

function ref(id: string, digest = DIGEST_A): ResourceRef {
  return { id, version: '1.0.0', digest, kind: 'artifact' }
}

const SNAPSHOT = ref('aaaa1111-1111-4111-8111-111111111111', DIGEST_A)
const MANIFEST = ref('bbbb2222-2222-4222-8222-222222222222', DIGEST_B)
const ARCHIVE_DOC = ref('dddd4444-4444-4444-8444-444444444444', DIGEST_C)
const AUTH_DOC = ref('eeee5555-5555-4555-8555-555555555555', DIGEST_E)
const ARCHIVE_PARSE_ID = '22222222-2222-4222-8222-222222222222'
const AUTH_PARSE_ID = '55555555-5555-4555-8555-555555555555'

const webEvidence = {
  kind: 'web_page' as const,
  url: 'https://docs.example.com/heat-pump-tariff',
  snapshotRef: SNAPSHOT,
  snapshotManifestRef: MANIFEST,
  contentDigest: DIGEST_C,
  fetchedAt: '2026-10-16T00:00:00Z',
  parserVersion: '1.0.0',
}

const locatedEvidence = {
  kind: 'located_span' as const,
  sourceRef: AUTH_DOC,
  span: {
    kind: 'text' as const,
    parseId: AUTH_PARSE_ID,
    chunkId: '66666666-6666-4666-8666-666666666666',
    locator: { kind: 'offset' as const, startOffset: 0, endOffset: 20 },
    spanKind: 'verbatim' as const,
    precision: 'exact' as const,
    quoteDigest: DIGEST_E,
    textDigest: DIGEST_E,
  },
  parserVersion: '1.0.0',
}

class FixtureWorkspaceStore implements IndustryWorkspaceStore {
  readonly #workspaces = new Map<string, IndustryWorkspace>()
  readonly #drafts = new Map<string, AssetDraftVersion[]>()

  seed(workspace: IndustryWorkspace, drafts: readonly AssetDraftVersion[]): void {
    this.#workspaces.set(workspace.workspaceId, workspace)
    this.#drafts.set(workspace.workspaceId, [...drafts])
  }

  async createWorkspace(_input: CreateIndustryWorkspaceInput, _scopeRef: ScopeRef, _ctx: ToolContext): Promise<IndustryWorkspaceWriteResult> {
    void _input; void _scopeRef; void _ctx
    throw new Error('not implemented in fixture')
  }

  async getWorkspace(scopeRef: ScopeRef, workspaceId: Uuid, _ctx: ToolContext): Promise<IndustryWorkspace | undefined> {
    void _ctx
    if (scopeRef.tenantId !== TENANT || scopeRef.spaceId !== SPACE) return undefined
    return this.#workspaces.get(workspaceId)
  }

  async listWorkspaces(_scopeRef: ScopeRef, _filter: IndustryWorkspaceListFilter, _ctx: ToolContext): Promise<IndustryWorkspace[]> {
    void _scopeRef; void _filter; void _ctx
    return [...this.#workspaces.values()]
  }

  async getDraft(scopeRef: ScopeRef, workspaceId: Uuid, revision: RevisionString, _ctx: ToolContext): Promise<AssetDraftVersion | undefined> {
    void scopeRef; void _ctx
    return this.#drafts.get(workspaceId)?.find((entry) => entry.revision === revision)
  }

  async listDrafts(scopeRef: ScopeRef, workspaceId: Uuid, _ctx: ToolContext): Promise<AssetDraftVersion[]> {
    void scopeRef; void _ctx
    return [...(this.#drafts.get(workspaceId) ?? [])]
  }

  async appendDraft(_scopeRef: ScopeRef, _workspaceId: Uuid, _input: unknown, _ctx: ToolContext): Promise<IndustryWorkspaceWriteResult> {
    void _scopeRef; void _workspaceId; void _input; void _ctx
    throw new Error('not implemented in fixture')
  }
}

function makeWorkspace(): IndustryWorkspace {
  return {
    workspaceId: WORKSPACE,
    namespace: 'r05-test',
    displayName: 'R05 workspace',
    boundary: { goals: ['model equipment'], included: ['catalog'], excluded: [], applicability: {} },
    headRevision: '1',
    state: 'draft',
  }
}

function makeDraft(): AssetDraftVersion {
  return { workspaceId: WORKSPACE, revision: '1', digest: DIGEST_A, documentSetRef: ref('10101010-1010-4010-8010-101010101010'), candidateRefs: [] }
}

function archiveMember(): ResearchDocumentMember {
  return {
    schemaVersion: 'research-document-member@1', memberId: randomUUID(), workspaceId: WORKSPACE, runId: RUN,
    kind: 'research_archive', documentRef: ARCHIVE_DOC, parseId: ARCHIVE_PARSE_ID, parserVersion: '1.0.0',
    parseRef: ref('cccc3333-3333-4333-8333-333333333333', DIGEST_D), provenanceRef: MANIFEST, contentDigest: DIGEST_C,
    fetchedAt: '2026-10-16T00:00:00Z', sourceUrl: webEvidence.url, staged: true, inGroundingCorpus: false,
    recordedAt: '2026-10-16T00:00:00Z',
  }
}

function authorizedMember(): ResearchDocumentMember {
  return {
    schemaVersion: 'research-document-member@1', memberId: randomUUID(), workspaceId: WORKSPACE, runId: RUN,
    kind: 'authorized_document', documentRef: AUTH_DOC, parseId: AUTH_PARSE_ID, parserVersion: '1.0.0',
    parseRef: ref('77777777-7777-4777-8777-777777777777', DIGEST_E), contentDigest: DIGEST_E,
    staged: true, inGroundingCorpus: false, recordedAt: '2026-10-16T00:00:00Z',
  }
}

function definitionCandidate(evidence: readonly CandidateSubmission['evidence'][number][]) {
  return {
    kind: 'definition' as const,
    definitionKind: 'object' as const,
    reason: 'grounded in the archived tariff guide',
    evidence,
    payload: {
      kind: 'object' as const,
      logicalId: 'HeatPumpTariff',
      displayName: '热泵电价',
      businessMeaning: 'A residential heat-pump electricity tariff.',
      suggestedReason: 'The archived guide describes the tariff structure.',
      identityAttributeIds: [],
    },
  } satisfies CandidateSubmission
}

async function harness(overrides: { grounding?: SourceGroundingPort; withArchive?: boolean; withAuthorized?: boolean; budget?: { readonly port: BudgetLedgerPort; readonly ledgerId: Uuid } } = {}) {
  const workspaces = new FixtureWorkspaceStore()
  workspaces.seed(makeWorkspace(), [makeDraft()])
  const members = new InMemoryResearchDocumentSetStore()
  if (overrides.withArchive !== false) await members.appendMember(SCOPE, archiveMember(), EDITOR)
  if (overrides.withAuthorized === true) await members.appendMember(SCOPE, authorizedMember(), EDITOR)
  const definitionCandidates = new InMemoryAssetCandidateStore()
  const receipts = new InMemoryCandidateSubmissionStore()
  const service = new CandidateSubmissionService({
    workspaces,
    definitionCandidates,
    terminology: new StaticDefinitionTerminologySource(),
    evidence: new ResearchMaterialReadService({ members }),
    receipts,
    ...(overrides.grounding === undefined ? {} : { sourceGrounding: overrides.grounding }),
    ...(overrides.budget === undefined ? {} : { budget: overrides.budget.port, ledgerIdFor: () => overrides.budget!.ledgerId }),
    now: () => '2026-10-16T01:00:00Z',
    newId: () => randomUUID(),
  })
  return { service, workspaces, members, definitionCandidates, receipts }
}

function request(command: SubmitCandidatesCommand, idempotencyKey = 'idem-key-0001'): SubmitCandidatesRequest {
  return { command, runId: RUN, logicalActionId: 'action-1', idempotencyKey }
}

function command(candidates: readonly CandidateSubmission[], workspaceId = WORKSPACE): SubmitCandidatesCommand {
  return { schemaVersion: 'submit-candidates@1', commandKind: 'submit_candidates', workspaceId, candidates }
}

describe('controlled candidate submission', () => {
  it('rejects evidence this run never obtained (forged snapshot)', async () => {
    const { service } = await harness()
    const forged = { ...webEvidence, contentDigest: DIGEST_A }
    const receipt = await service.submit(SCOPE, request(command([definitionCandidate([forged])])), EDITOR)
    expect(receipt.accepted).toHaveLength(0)
    expect(receipt.rejected[0]?.code).toBe('EVIDENCE_DIGEST_MISMATCH')
  })

  it('accepts a candidate with several evidence items and keeps it pending while one source is unconfirmed', async () => {
    const { service, receipts } = await harness({ withAuthorized: true })
    const receipt = await service.submit(SCOPE, request(command([definitionCandidate([webEvidence, locatedEvidence])])), EDITOR)
    expect(receipt.rejected).toHaveLength(0)
    const entry = receipt.accepted[0]
    expect(entry?.pendingConfirmation).toBe(true)
    expect(entry?.issues.some((issue) => issue.code === 'SOURCE_TRUST_BLOCKED')).toBe(true)
    const links = await receipts.listLinksForCandidate(SCOPE, entry!.candidateId, EDITOR)
    expect(links).toHaveLength(2)
    expect(links.map((link) => link.trustTier).sort()).toEqual(['agent_researched', 'customer_authoritative'])
  })

  it('replays the same host idempotency key without writing a second candidate', async () => {
    const { service, definitionCandidates } = await harness()
    const first = await service.submit(SCOPE, request(command([definitionCandidate([webEvidence])])), EDITOR)
    const second = await service.submit(SCOPE, request(command([definitionCandidate([webEvidence])])), EDITOR)
    expect(second.replayed).toBe(true)
    expect(second.accepted[0]?.candidateId).toBe(first.accepted[0]?.candidateId)
    expect(await definitionCandidates.listCandidates(SCOPE, WORKSPACE, {}, EDITOR)).toHaveLength(1)
  })

  it('re-grounds a pending candidate into a new version after its source is approved', async () => {
    const grounding: SourceGroundingPort = {
      read: async (request, _ctx, budget) => ({
        documentSetRef: makeDraft().documentSetRef,
        coverage: 'complete',
        usage: budget.usage(),
        sources: request.sourceRefs.map((sourceRef) => ({
          sourceRef, trust: 'untrusted_source_data' as const, trustTier: 'customer_authoritative' as const, status: 'complete' as const, reasons: [],
          contents: [{ kind: 'text' as const, text: 'Approved tariff text.', sourceSpan: {
            parseId: ARCHIVE_PARSE_ID, chunkId: '88888888-8888-4888-8888-888888888888',
            locator: { kind: 'offset' as const, startOffset: 0, endOffset: 20 }, spanKind: 'verbatim' as const, precision: 'exact' as const,
            quoteDigest: DIGEST_A, textDigest: DIGEST_A } }],
        })),
      }),
    }
    const { service, definitionCandidates } = await harness({ grounding })
    const submitted = await service.submit(SCOPE, request(command([definitionCandidate([webEvidence])])), EDITOR)
    const original = submitted.accepted[0]!
    const originalCandidate = await definitionCandidates.getCandidate(SCOPE, original.candidateId, EDITOR)
    expect(originalCandidate?.pendingConfirmation).toBe(true)
    const regrounded = await service.reground(WORKSPACE, original.candidateId, originalCandidate!.contentDigest, 'reground-key-0001', EDITOR)
    const next = await definitionCandidates.getCandidate(SCOPE, regrounded.newCandidateId, EDITOR)
    expect(regrounded.newCandidateId).not.toBe(original.candidateId)
    expect(next?.replacesCandidateId).toBe(original.candidateId)
    expect(next?.pendingConfirmation).toBe(false)
    expect(next?.issues.some((issue) => issue.code === 'SOURCE_TRUST_BLOCKED')).toBe(false)
    // The original blocked candidate is preserved, not washed away in place.
    expect((await definitionCandidates.getCandidate(SCOPE, original.candidateId, EDITOR))?.pendingConfirmation).toBe(true)
  })

  it('refuses to re-ground while any cited source is still unapproved (partial review cannot unblock)', async () => {
    const grounding: SourceGroundingPort = {
      read: async (request, _ctx, budget) => ({
        documentSetRef: makeDraft().documentSetRef,
        coverage: 'partial',
        usage: budget.usage(),
        sources: request.sourceRefs.map((sourceRef, index) => index === 0
          ? { sourceRef, trust: 'untrusted_source_data' as const, trustTier: 'agent_researched' as const, status: 'failed' as const, reasons: ['NOT_APPROVED' as const], contents: [] }
          : { sourceRef, trust: 'untrusted_source_data' as const, trustTier: 'customer_authoritative' as const, status: 'complete' as const, reasons: [],
              contents: [{ kind: 'text' as const, text: 'Approved tariff text.', sourceSpan: {
                parseId: AUTH_PARSE_ID, chunkId: '88888888-8888-4888-8888-888888888888',
                locator: { kind: 'offset' as const, startOffset: 0, endOffset: 20 }, spanKind: 'verbatim' as const, precision: 'exact' as const,
                quoteDigest: DIGEST_A, textDigest: DIGEST_A } }] }),
      }),
    }
    const { service, definitionCandidates } = await harness({ grounding, withAuthorized: true })
    const submitted = await service.submit(SCOPE, request(command([definitionCandidate([webEvidence, locatedEvidence])])), EDITOR)
    const original = submitted.accepted[0]!
    expect(original.pendingConfirmation).toBe(true)
    const originalCandidate = await definitionCandidates.getCandidate(SCOPE, original.candidateId, EDITOR)
    await expect(service.reground(WORKSPACE, original.candidateId, originalCandidate!.contentDigest, 'reground-partial-0001', EDITOR))
      .rejects.toMatchObject({ code: 'SOURCE_TRUST_BLOCKED' })
    // The blocked candidate is untouched; no unblocked successor was written.
    expect((await definitionCandidates.getCandidate(SCOPE, original.candidateId, EDITOR))?.pendingConfirmation).toBe(true)
    expect((await definitionCandidates.listCandidates(SCOPE, WORKSPACE, {}, EDITOR)).length).toBe(1)
  })

  it('refuses a submission aimed at a workspace outside the trusted scope', async () => {
    const { service } = await harness()
    await expect(service.submit(SCOPE, request(command([definitionCandidate([webEvidence])], '00000000-0000-4000-8000-000000000000')), EDITOR))
      .rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })

  it('lets a researcher propose a source but denies a definition write', async () => {
    const { service } = await harness()
    const receipt = await service.submit(SCOPE, request(command([definitionCandidate([webEvidence])], WORKSPACE)), RESEARCHER)
    expect(receipt.accepted).toHaveLength(0)
    expect(receipt.rejected[0]?.code).toBe('PERMISSION_DENIED')
  })
})

describe('candidate budget on the run ledger', () => {
  it('cannot bypass candidateLimit across two separate submissions', async () => {
    const ledgerId = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
    const port: BudgetLedgerPort = new BudgetService({
      store: new InMemoryBudgetLedgerStore(),
      control: new RecordingControlRepository(),
      newId: () => randomUUID(),
    })
    await port.openLedger({ ledgerId, kind: 'run', runId: RUN, overrideLimits: { maxCandidates: 1 } }, EDITOR)
    const { service } = await harness({ budget: { port, ledgerId } })

    const first = await service.submit(SCOPE, request(command([definitionCandidate([webEvidence])]), 'candidate-budget-0001'), EDITOR)
    expect(first.accepted).toHaveLength(1)

    // A second, distinct submission for the same run cannot buy the last candidate again.
    await expect(
      service.submit(SCOPE, request(command([definitionCandidate([webEvidence])]), 'candidate-budget-0002'), EDITOR),
    ).rejects.toMatchObject({ code: 'CANDIDATE_LIMIT_EXCEEDED' })
  })
})
