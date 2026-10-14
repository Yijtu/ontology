import { describe, expect, it } from 'vitest'
import { CandidateSourceError, assertCandidateSourceShape } from '@ontology/contracts'

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'candidate-source@1',
    sourceId: '00000000-0000-4000-8000-000000000001',
    workspaceId: '00000000-0000-4000-8000-000000000002',
    kind: 'web_fetch',
    trustTier: 'agent_researched',
    origin: { url: 'https://example.org/standard' },
    contentRef: { id: '00000000-0000-4000-8000-000000000003', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' },
    contentDigest: `sha256:${'b'.repeat(64)}`,
    reviewState: 'proposed',
    proposedBy: 'researcher',
    recordedAt: '2026-10-13T00:00:00Z',
    ...overrides,
  }
}

describe('candidate source shape', () => {
  it('accepts a well-formed proposed source', () => {
    expect(() => assertCandidateSourceShape(valid())).not.toThrow()
    expect(() => assertCandidateSourceShape(valid({ freshness: { retrievedAt: '2026-10-13T00:00:00Z' } }))).not.toThrow()
  })

  it('rejects an unknown trust tier or provenance kind', () => {
    expect(() => assertCandidateSourceShape(valid({ trustTier: 'trusted_vendor' }))).toThrow(CandidateSourceError)
    expect(() => assertCandidateSourceShape(valid({ kind: 'crawl' }))).toThrow(CandidateSourceError)
  })

  it('rejects a malformed content digest', () => {
    expect(() => assertCandidateSourceShape(valid({ contentDigest: 'deadbeef' }))).toThrow(CandidateSourceError)
  })
})
