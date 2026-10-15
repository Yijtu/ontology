import { describe, expect, it } from 'vitest'
import {
  CandidateSourceError,
  SourceAdmissionError,
  assertSourceAdmissionCommandShape,
  assertSourceAdmissionShape,
  assertSourceRetractionCommandShape,
} from '@ontology/contracts'
import type { CandidateSourceRecord, CandidateSourceStore, Uuid } from '@ontology/contracts'
import { CandidateSourceReviewService } from '@ontology/application'
import { toolContext } from './component-registry-fixtures'

const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222'

function command(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'source-admission-command@1',
    workspaceId: WORKSPACE,
    sourceId: '33333333-3333-4333-8333-333333333333',
    expectedSourceRevision: '2',
    expectedWorkspaceRevision: '1',
    idempotencyKey: 'admission-key-0001',
    ...overrides,
  }
}

describe('source admission contract shapes', () => {
  it('accepts a well-formed admission command and rejects a malformed revision or key', () => {
    expect(() => assertSourceAdmissionCommandShape(command())).not.toThrow()
    expect(() => assertSourceAdmissionCommandShape(command({ parseOptions: { headerRow: 1, sheetName: 'S' } }))).not.toThrow()
    expect(() => assertSourceAdmissionCommandShape(command({ expectedWorkspaceRevision: '-1' }))).toThrow(SourceAdmissionError)
    expect(() => assertSourceAdmissionCommandShape(command({ idempotencyKey: '' }))).toThrow(SourceAdmissionError)
    expect(() => assertSourceAdmissionCommandShape(command({ parseOptions: { headerRow: 0 } }))).toThrow(SourceAdmissionError)
    expect(() => assertSourceAdmissionCommandShape(command({ parseOptions: { unknown: true } }))).toThrow(SourceAdmissionError)
  })

  it('accepts a well-formed retraction command and rejects a missing reason', () => {
    const retraction = { schemaVersion: 'source-retraction-command@1', workspaceId: WORKSPACE,
      sourceId: '33333333-3333-4333-8333-333333333333', expectedRevision: '2', reason: '标准已被替代', idempotencyKey: 'retraction-key-01' }
    expect(() => assertSourceRetractionCommandShape(retraction)).not.toThrow()
    expect(() => assertSourceRetractionCommandShape({ ...retraction, reason: '' })).toThrow(SourceAdmissionError)
    expect(() => assertSourceRetractionCommandShape({ ...retraction, expectedRevision: 'x' })).toThrow(SourceAdmissionError)
  })

  it('requires an admitted source to bind a document reference and a known tier', () => {
    const admission = {
      schemaVersion: 'source-admission@1', admissionId: '44444444-4444-4444-8444-444444444444', workspaceId: WORKSPACE,
      sourceId: '33333333-3333-4333-8333-333333333333', sourceRevision: '2', trustTier: 'public_standard',
      sourceRef: { id: '55555555-5555-4555-8555-555555555555', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'document' },
      parseId: '66666666-6666-4666-8666-666666666666', parserVersion: '1.0.0', kind: 'document',
      documentSetRef: { id: '77777777-7777-4777-8777-777777777777', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}`, kind: 'artifact' },
      draftRevision: '2', draftDigest: `sha256:${'c'.repeat(64)}`, admittedBy: 'editor', admittedAt: '2026-10-15T00:00:00Z',
      idempotencyKey: 'admission-key-0001',
    }
    expect(() => assertSourceAdmissionShape(admission)).not.toThrow()
    expect(() => assertSourceAdmissionShape({ ...admission, trustTier: 'trusted_vendor' })).toThrow(SourceAdmissionError)
    expect(() => assertSourceAdmissionShape({ ...admission, sourceRef: { ...admission.sourceRef, kind: 'artifact' } })).toThrow(SourceAdmissionError)
  })
})

class SingleSourceStore implements CandidateSourceStore {
  constructor(readonly row: CandidateSourceRecord) {}
  async putSource(): Promise<CandidateSourceRecord> { throw new Error('unused') }
  async getSource(_scope: unknown, sourceId: Uuid): Promise<CandidateSourceRecord | undefined> {
    return sourceId === this.row.sourceId ? this.row : undefined
  }
  async listSources(): Promise<readonly CandidateSourceRecord[]> { return [this.row] }
  async reviewSource(): Promise<CandidateSourceRecord> { throw new Error('unused') }
}

function record(): CandidateSourceRecord {
  return {
    schemaVersion: 'candidate-source@1', sourceId: '33333333-3333-4333-8333-333333333333', workspaceId: WORKSPACE,
    revision: '1', kind: 'web_fetch', trustTier: 'agent_researched',
    origin: { url: 'https://standards.example.org/gb50500' },
    contentRef: { id: '55555555-5555-4555-8555-555555555555', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}`, kind: 'artifact' },
    contentDigest: `sha256:${'e'.repeat(64)}`, reviewState: 'proposed', proposedBy: 'researcher', recordedAt: '2026-10-15T00:00:00Z',
  }
}

describe('candidate source review service guards', () => {
  const row = record()
  const ctx = toolContext('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ['profile-editor'], 'editor-1')

  it('rejects a review with a role that cannot review', async () => {
    const service = new CandidateSourceReviewService({ sources: new SingleSourceStore(row) })
    const viewer = toolContext(ctx.principal.tenantId, ctx.allowedResources.spaceId, ['business-user'], 'viewer')
    await expect(service.review({ schemaVersion: 'candidate-source-review@1', sourceId: row.sourceId, workspaceId: WORKSPACE,
      reviewState: 'approved', reviewedBy: 'viewer', reason: 'x', expectedRevision: '1', basisRefs: [], idempotencyKey: 'k-00000001' }, viewer))
      .rejects.toMatchObject({ code: 'FORBIDDEN', name: 'CandidateSourceError' })
  })

  it('rejects a review whose workspace does not own the source', async () => {
    const service = new CandidateSourceReviewService({ sources: new SingleSourceStore(row) })
    await expect(service.review({ schemaVersion: 'candidate-source-review@1', sourceId: row.sourceId, workspaceId: OTHER_WORKSPACE,
      reviewState: 'approved', reviewedBy: 'editor-1', reason: 'x', expectedRevision: '1', basisRefs: [], idempotencyKey: 'k-00000002' }, ctx))
      .rejects.toBeInstanceOf(CandidateSourceError)
  })

  it('fails closed when a store has no append-only review command', async () => {
    const service = new CandidateSourceReviewService({ sources: new SingleSourceStore(row) })
    await expect(service.review({ schemaVersion: 'candidate-source-review@1', sourceId: row.sourceId, workspaceId: WORKSPACE,
      reviewState: 'approved', reviewedBy: 'editor-1', reason: 'x', expectedRevision: '1', basisRefs: [], idempotencyKey: 'k-00000003' }, ctx))
      .rejects.toMatchObject({ code: 'STORE_FAILED' })
  })

  it('fails closed when there is no retraction store', async () => {
    const service = new CandidateSourceReviewService({ sources: new SingleSourceStore(row) })
    await expect(service.retract({ schemaVersion: 'source-retraction-command@1', workspaceId: WORKSPACE, sourceId: row.sourceId,
      expectedRevision: '1', reason: 'withdraw', idempotencyKey: 'k-00000004' }, ctx))
      .rejects.toMatchObject({ code: 'STORE_FAILED', name: 'SourceAdmissionError' })
  })
})
