import { describe, expect, it } from 'vitest'
import {
  ResearchRunAdmissionError,
  assertResearchRunAdmissionShape,
} from '@ontology/contracts'
import type { ResearchRunAdmission } from '@ontology/contracts'

const RUN = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const RESEARCH = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const WORKSPACE = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const DIGEST = `sha256:${'a'.repeat(64)}`
const ref = { id: RUN, version: '1.0.0', digest: DIGEST, kind: 'artifact' as const }

function admission(overrides?: Partial<ResearchRunAdmission>): ResearchRunAdmission {
  return {
    schemaVersion: 'research-run-admission@1',
    runId: RUN,
    researchId: RESEARCH,
    workspaceId: WORKSPACE,
    draftRevision: '1',
    idempotencyKey: 'admission-idempotency-0001',
    requestDigest: DIGEST,
    state: 'ready',
    goal: { kind: 'industry_workspace_research', workspaceId: WORKSPACE, draftRevision: '1' },
    briefRef: ref,
    authorizationReceiptRef: ref,
    configSnapshotRef: ref,
    modelSnapshotRefs: [],
    toolSnapshotRefs: [],
    configSnapshotHash: DIGEST,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    readyAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  }
}

describe('research run admission contracts', () => {
  it('accepts a well-formed ready admission and a preparing one', () => {
    expect(() => assertResearchRunAdmissionShape(admission())).not.toThrow()
    const preparing = admission({ state: 'preparing' })
    delete (preparing as { readyAt?: string }).readyAt
    expect(() => assertResearchRunAdmissionShape(preparing)).not.toThrow()
  })

  it('rejects a ready admission without a readyAt instant, or a preparing one that carries one', () => {
    const missing = admission()
    delete (missing as { readyAt?: string }).readyAt
    expect(() => assertResearchRunAdmissionShape(missing)).toThrow(ResearchRunAdmissionError)
    expect(() => assertResearchRunAdmissionShape(admission({ state: 'preparing' }))).toThrow(ResearchRunAdmissionError)
  })

  it('rejects a malformed request digest, goal or snapshot list', () => {
    expect(() => assertResearchRunAdmissionShape(admission({ requestDigest: 'not-a-digest' as never }))).toThrow(ResearchRunAdmissionError)
    expect(() => assertResearchRunAdmissionShape(admission({ goal: { kind: 'unknown' } as never }))).toThrow(ResearchRunAdmissionError)
    expect(() => assertResearchRunAdmissionShape(admission({ toolSnapshotRefs: [{}] as never }))).toThrow(ResearchRunAdmissionError)
  })
})
