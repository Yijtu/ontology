import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ModelingBrief, ResearchRequest, ResourceRef } from '@ontology/contracts'
import {
  DEFAULT_RESEARCH_BUDGET_REF,
  DEFAULT_RESEARCH_POLICY_REF,
  RESEARCH_JOB_REQUEST_KIND,
  RESEARCH_JOB_VERSION_AGENT,
  RESEARCH_JOB_VERSION_LEGACY,
  decodeResearchJobRequest,
  encodeResearchJobRequest,
  isAgentResearchJobRequest,
  isLegacyResearchJobRequest,
  isResearchJobRef,
} from '@ontology/application'

const WORKSPACE = '00000000-0000-4000-8000-000000000003'

function brief(): ModelingBrief {
  return {
    schemaVersion: 'modeling-brief@1',
    workspaceId: WORKSPACE,
    goal: '按 GB50500 建桥架计价本体',
    allowedResearchDomains: ['standards.example.org'],
    targetKinds: ['object', 'attribute'],
    sourceLimit: 5,
    candidateLimit: 5,
  }
}

function request(): ResearchRequest {
  return {
    schemaVersion: 'research-request@1',
    workspaceId: WORKSPACE,
    brief: brief(),
    limits: { sourceLimit: 5, candidateLimit: 5, deadline: '2099-01-01T00:00:00Z' },
    allowedDomains: ['standards.example.org'],
    policyRef: DEFAULT_RESEARCH_POLICY_REF,
    budgetRef: DEFAULT_RESEARCH_BUDGET_REF,
    idempotencyKey: `research-key-${randomUUID().slice(0, 8)}`,
  }
}

function manifestRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' }
}

describe('research job reference version union', () => {
  it('round-trips the legacy request-bearing payload', () => {
    const researchId = randomUUID()
    const encoded = encodeResearchJobRequest({ kind: RESEARCH_JOB_REQUEST_KIND, version: RESEARCH_JOB_VERSION_LEGACY, researchId, request: request() })
    const decoded = decodeResearchJobRequest(encoded)
    expect(decoded.version).toBe(RESEARCH_JOB_VERSION_LEGACY)
    expect(isLegacyResearchJobRequest(decoded)).toBe(true)
    expect(isAgentResearchJobRequest(decoded)).toBe(false)
    if (!isLegacyResearchJobRequest(decoded)) throw new Error('expected a legacy job payload')
    expect(decoded.researchId).toBe(researchId)
    expect(decoded.request.brief.goal).toBe('按 GB50500 建桥架计价本体')
  })

  it('reads a job written before the version field as legacy', () => {
    const raw = JSON.stringify({ kind: RESEARCH_JOB_REQUEST_KIND, researchId: randomUUID(), request: request() })
    const decoded = decodeResearchJobRequest(raw)
    expect(decoded.version).toBe(RESEARCH_JOB_VERSION_LEGACY)
    expect(isLegacyResearchJobRequest(decoded)).toBe(true)
  })

  it('round-trips the agent run payload carrying only the run identity and manifest ref', () => {
    const researchId = randomUUID()
    const runId = randomUUID()
    const manifest = manifestRef()
    const encoded = encodeResearchJobRequest({ kind: RESEARCH_JOB_REQUEST_KIND, version: RESEARCH_JOB_VERSION_AGENT, researchId, runId, manifestRef: manifest })
    const decoded = decodeResearchJobRequest(encoded)
    expect(isAgentResearchJobRequest(decoded)).toBe(true)
    if (!isAgentResearchJobRequest(decoded)) throw new Error('expected an agent job payload')
    expect(decoded.runId).toBe(runId)
    expect(decoded.manifestRef).toEqual(manifest)
  })

  it('refuses an unknown version instead of executing it as a legacy request', () => {
    const raw = JSON.stringify({ kind: RESEARCH_JOB_REQUEST_KIND, version: '3.0.0', researchId: randomUUID(), request: request() })
    expect(() => decodeResearchJobRequest(raw)).toThrowError(/unknown research job version/)
    expect(isResearchJobRef(raw)).toBe(false)
  })

  it('refuses an agent payload missing its run id or manifest, and a non-job ref', () => {
    expect(() => decodeResearchJobRequest(JSON.stringify({ kind: RESEARCH_JOB_REQUEST_KIND, version: RESEARCH_JOB_VERSION_AGENT, researchId: randomUUID(), manifestRef: manifestRef() }))).toThrow()
    expect(() => decodeResearchJobRequest('not-json')).toThrow()
    expect(isResearchJobRef('not-json')).toBe(false)
    expect(isResearchJobRef(undefined)).toBe(false)
  })
})
