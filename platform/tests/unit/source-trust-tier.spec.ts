import { describe, expect, it } from 'vitest'
import { SourceGroundingError, assertGroundingDocumentSet, sourceTrustTierOf } from '@ontology/contracts'

const workspaceId = '00000000-0000-4000-8000-000000000001'
const parseId = '00000000-0000-4000-8000-000000000002'
const scopeRef = { tenantId: '00000000-0000-4000-8000-000000000003', spaceId: '00000000-0000-4000-8000-000000000004' }

function approvedSource(trustTier?: string) {
  return {
    sourceRef: { id: '00000000-0000-4000-8000-000000000005', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'document' },
    state: 'approved',
    kind: 'document',
    parserVersion: '1.0.0',
    parseId,
    ...(trustTier === undefined ? {} : { trustTier }),
  }
}

function documentSet(sources: readonly unknown[]) {
  return { schemaVersion: '1.0.0', scopeRef, workspaceId, sources }
}

describe('source trust tier', () => {
  it('defaults an unset tier to a customer-authoritative source', () => {
    expect(sourceTrustTierOf({})).toBe('customer_authoritative')
    expect(sourceTrustTierOf({ trustTier: 'public_standard' })).toBe('public_standard')
  })

  it('accepts a document set with an explicit tier and one with none', () => {
    expect(() => assertGroundingDocumentSet(documentSet([approvedSource('agent_researched')]))).not.toThrow()
    expect(() => assertGroundingDocumentSet(documentSet([approvedSource()]))).not.toThrow()
  })

  it('rejects an unknown tier at the artifact boundary', () => {
    expect(() => assertGroundingDocumentSet(documentSet([approvedSource('trusted_vendor')])))
      .toThrow(SourceGroundingError)
  })
})
