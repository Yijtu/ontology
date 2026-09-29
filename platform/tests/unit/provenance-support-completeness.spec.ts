import { describe, expect, it } from 'vitest'
import type {
  BlobPort,
  EvidenceDependencyEdge,
  EvidenceDependencyReadResult,
  EvidenceEnvelope,
  EvidenceRecord,
  EvidenceStorePort,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { ProvenanceReadService } from '@ontology/provenance'
import type { EvidenceDependencySource } from '@ontology/provenance'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const DIGEST = `sha256:${'a'.repeat(64)}`
const SCOPE: ScopeRef = { tenantId: TENANT, spaceId: SPACE }
const CTX: ToolContext = toolContext(TENANT, SPACE, ['scoped-reader'], 'reader', RUN_ID)
const RULE_REF: VersionRef = { id: 'published-rule-v1', version: '1.0.0', digest: DIGEST }

function evidenceRef(id: Uuid): ResourceRef {
  return { id, version: '1.0.0', digest: DIGEST, kind: 'evidence' }
}

function evidenceRecord(id: Uuid, withRule = true): EvidenceRecord {
  const envelope: EvidenceEnvelope = {
    evidenceId: id,
    kind: withRule ? 'rule_derivation' : 'observation',
    scopeRef: SCOPE,
    producedBy: {
      componentRef: { id: 'component', version: '1.0.0', digest: DIGEST },
      runId: RUN_ID,
      ...(withRule ? { ruleRef: RULE_REF } : {}),
    },
    observedAt: '2026-09-21T06:00:00Z',
    recordedSeq: '1',
    sourceSnapshots: [],
    resultDigest: DIGEST,
    integrity: { algorithm: 'sha256', digest: DIGEST },
    dependencies: [],
    dataMode: 'observed',
  }
  return {
    evidenceRef: evidenceRef(id),
    envelope,
    envelopeDigest: DIGEST,
    revision: '1',
    recordedAt: '2026-09-21T06:00:01Z',
  }
}

class MemoryEvidenceStore implements EvidenceStorePort {
  readonly #records = new Map<string, EvidenceRecord>()

  put(record: EvidenceRecord): void {
    this.#records.set(record.evidenceRef.id, record)
  }

  record(_scopeRef: ScopeRef, envelope: EvidenceEnvelope): Promise<EvidenceRecord> {
    const saved: EvidenceRecord = {
      evidenceRef: evidenceRef(envelope.evidenceId),
      envelope,
      envelopeDigest: envelope.integrity.digest,
      revision: '1',
      recordedAt: envelope.observedAt,
    }
    this.put(saved)
    return Promise.resolve(saved)
  }

  get(_scopeRef: ScopeRef, evidenceId: Uuid): Promise<EvidenceRecord | undefined> {
    return Promise.resolve(this.#records.get(evidenceId))
  }

  listByRun(_scopeRef: ScopeRef, runId: Uuid): Promise<EvidenceRecord[]> {
    return Promise.resolve([...this.#records.values()].filter((record) => record.envelope.producedBy.runId === runId))
  }
}

class EmptyBlobPort implements BlobPort {
  putImmutable(): ReturnType<BlobPort['putImmutable']> {
    return Promise.reject(new Error('blob writes are not used in these tests'))
  }

  getAuthorized(): ReturnType<BlobPort['getAuthorized']> {
    return Promise.reject(new Error('no archived artifacts are used in these tests'))
  }
}

class DetailedDependencies implements EvidenceDependencySource {
  readonly #results = new Map<Uuid, EvidenceDependencyReadResult>()

  set(evidenceId: Uuid, result: EvidenceDependencyReadResult): void {
    this.#results.set(evidenceId, result)
  }

  dependenciesOf(_scopeRef: ScopeRef, evidence: EvidenceRecord): Promise<readonly EvidenceDependencyEdge[]> {
    return Promise.resolve(this.#results.get(evidence.evidenceRef.id)?.edges ?? [])
  }

  dependenciesWithResolutionOf(_scopeRef: ScopeRef, evidence: EvidenceRecord): Promise<EvidenceDependencyReadResult> {
    return Promise.resolve(this.#results.get(evidence.evidenceRef.id) ?? {
      edges: [],
      supportResolution: { state: 'unknown', complete: false, reason: 'not configured for this record' },
    })
  }
}

class LegacyDependencies implements EvidenceDependencySource {
  constructor(readonly edges: readonly EvidenceDependencyEdge[] = []) {}

  dependenciesOf(): Promise<readonly EvidenceDependencyEdge[]> {
    return Promise.resolve(this.edges)
  }
}

function service(evidence: MemoryEvidenceStore, dependencies: EvidenceDependencySource): ProvenanceReadService {
  return new ProvenanceReadService({ evidence, blobs: new EmptyBlobPort(), dependencies })
}

function supportEdge(from: Uuid, to: Uuid): EvidenceDependencyEdge {
  return {
    fromEvidenceId: from,
    toEvidenceId: to,
    relation: 'derives_from',
    origin: 'support',
    premiseGroup: 'condition:attribute',
  }
}

describe('provenance support-resolution coverage', () => {
  it('exposes detailed states without changing evidence/artifact verifiability', async () => {
    const cases = [
      { id: 'resolved', withRule: true, status: { state: 'resolved' as const }, complete: true },
      { id: 'not-applicable', withRule: true, status: { state: 'not_applicable' as const }, complete: true },
      { id: 'unavailable', withRule: true, status: { state: 'unavailable' as const, complete: true }, complete: false },
      { id: 'ambiguous', withRule: true, status: { state: 'ambiguous' as const, complete: true }, complete: false },
      { id: 'unknown', withRule: true, status: { state: 'unknown' as const, complete: true }, complete: false },
      { id: 'conflict', withRule: true, status: { state: 'conflict' as const, complete: true }, complete: false },
      { id: 'incomplete', withRule: true, status: { state: 'incomplete' as const, complete: true }, complete: false },
      { id: 'not-rule', withRule: false, status: { state: 'not_rule' as const }, complete: true },
    ]

    for (const item of cases) {
      const evidence = new MemoryEvidenceStore()
      const record = evidenceRecord(item.id, item.withRule)
      evidence.put(record)
      const dependencies = new DetailedDependencies()
      dependencies.set(record.evidenceRef.id, {
        edges: [],
        supportResolution: item.status,
      })
      const view = await service(evidence, dependencies).getEvidence(record.evidenceRef.id, {}, CTX)
      expect(view.outcome).toBe('verifiable')
      expect(view.supportResolution).toMatchObject({ state: item.status.state, complete: item.complete })
    }
  })

  it('marks legacy rule-evidence dependencies unknown while preserving their edges', async () => {
    const evidence = new MemoryEvidenceStore()
    const root = evidenceRecord('legacy-root')
    const parentId = 'legacy-parent'
    evidence.put(root)
    const dependencies = new LegacyDependencies([supportEdge(root.evidenceRef.id, parentId)])

    const view = await service(evidence, dependencies).getEvidence(root.evidenceRef.id, {}, CTX)
    expect(view.outcome).toBe('verifiable')
    expect(view.dependencies).toEqual([supportEdge(root.evidenceRef.id, parentId)])
    expect(view.supportResolution).toMatchObject({ state: 'unknown', complete: false })
  })

  it('propagates an unresolved child rule into bounded multi-hop graph coverage', async () => {
    const evidence = new MemoryEvidenceStore()
    const root = evidenceRecord('root-node')
    const child = evidenceRecord('child-node')
    evidence.put(root)
    evidence.put(child)
    const dependencies = new DetailedDependencies()
    dependencies.set(root.evidenceRef.id, {
      edges: [supportEdge(root.evidenceRef.id, child.evidenceRef.id)],
      supportResolution: { state: 'resolved' },
    })
    dependencies.set(child.evidenceRef.id, {
      edges: [],
      supportResolution: { state: 'unknown', reason: 'the child has no immutable support slice' },
    })

    const graph = await service(evidence, dependencies).getDependencies(
      root.evidenceRef.id,
      { direction: 'outbound', depth: 2 },
      CTX,
    )

    expect(graph.nodes.map((node) => node.evidenceId)).toEqual([root.evidenceRef.id, child.evidenceRef.id])
    expect(graph.coverage.truncated).toBe(false)
    expect(graph.coverage.support).toMatchObject({ complete: false })
    expect(graph.coverage.support?.resolutions).toEqual(expect.arrayContaining([
      { evidenceId: root.evidenceRef.id, resolution: { state: 'resolved', complete: true } },
      {
        evidenceId: child.evidenceRef.id,
        resolution: { state: 'unknown', complete: false, reason: 'the child has no immutable support slice' },
      },
    ]))
  })

  it('marks unresolved boundary and missing nodes incomplete without traversing beyond depth', async () => {
    const atDepthZero = new MemoryEvidenceStore()
    const rootOnly = evidenceRecord('depth-zero-root')
    atDepthZero.put(rootOnly)
    const depthZeroDependencies = new DetailedDependencies()
    depthZeroDependencies.set(rootOnly.evidenceRef.id, {
      edges: [],
      supportResolution: { state: 'unknown' },
    })
    const depthZeroGraph = await service(atDepthZero, depthZeroDependencies).getDependencies(
      rootOnly.evidenceRef.id,
      { direction: 'outbound', depth: 0 },
      CTX,
    )
    expect(depthZeroGraph.edges).toEqual([])
    expect(depthZeroGraph.coverage.support).toMatchObject({
      complete: false,
      resolutions: [expect.objectContaining({ evidenceId: rootOnly.evidenceRef.id, resolution: { state: 'unknown', complete: false } })],
    })

    const boundaryEvidence = new MemoryEvidenceStore()
    const boundaryRoot = evidenceRecord('boundary-root')
    const boundaryRule = evidenceRecord('boundary-rule')
    boundaryEvidence.put(boundaryRoot)
    boundaryEvidence.put(boundaryRule)
    const boundaryDependencies = new DetailedDependencies()
    boundaryDependencies.set(boundaryRoot.evidenceRef.id, {
      edges: [supportEdge(boundaryRoot.evidenceRef.id, boundaryRule.evidenceRef.id)],
      supportResolution: { state: 'resolved' },
    })
    boundaryDependencies.set(boundaryRule.evidenceRef.id, {
      edges: [],
      supportResolution: { state: 'conflict' },
    })
    const boundaryGraph = await service(boundaryEvidence, boundaryDependencies).getDependencies(
      boundaryRoot.evidenceRef.id,
      { direction: 'outbound', depth: 1 },
      CTX,
    )
    expect(boundaryGraph.nodes.map((node) => node.evidenceId)).toEqual([
      boundaryRoot.evidenceRef.id,
      boundaryRule.evidenceRef.id,
    ])
    expect(boundaryGraph.coverage.support?.complete).toBe(false)
    expect(boundaryGraph.coverage.support?.resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidenceId: boundaryRule.evidenceRef.id, resolution: { state: 'conflict', complete: false } }),
    ]))

    const missingEvidence = new MemoryEvidenceStore()
    const missingRoot = evidenceRecord('missing-root')
    const missingId = 'missing-node'
    missingEvidence.put(missingRoot)
    const missingDependencies = new DetailedDependencies()
    missingDependencies.set(missingRoot.evidenceRef.id, {
      edges: [supportEdge(missingRoot.evidenceRef.id, missingId)],
      supportResolution: { state: 'resolved' },
    })
    const missingGraph = await service(missingEvidence, missingDependencies).getDependencies(
      missingRoot.evidenceRef.id,
      { direction: 'outbound', depth: 1 },
      CTX,
    )
    expect(missingGraph.coverage.support?.complete).toBe(false)
    expect(missingGraph.coverage.support?.resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceId: missingId,
        resolution: expect.objectContaining({ state: 'unavailable', complete: false }),
      }),
    ]))
  })

  it('does not claim support completeness on a resumed page without prior-page support state', async () => {
    const evidence = new MemoryEvidenceStore()
    const root = evidenceRecord('paged-root')
    const firstChild = evidenceRecord('paged-child-a', false)
    const secondChild = evidenceRecord('paged-child-b', false)
    evidence.put(root)
    evidence.put(firstChild)
    evidence.put(secondChild)
    const dependencies = new DetailedDependencies()
    dependencies.set(root.evidenceRef.id, {
      edges: [
        supportEdge(root.evidenceRef.id, firstChild.evidenceRef.id),
        supportEdge(root.evidenceRef.id, secondChild.evidenceRef.id),
      ],
      supportResolution: { state: 'resolved' },
    })
    dependencies.set(firstChild.evidenceRef.id, { edges: [], supportResolution: { state: 'not_rule' } })
    dependencies.set(secondChild.evidenceRef.id, { edges: [], supportResolution: { state: 'not_rule' } })
    const readService = new ProvenanceReadService({
      evidence,
      blobs: new EmptyBlobPort(),
      dependencies,
      maxPageSize: 1,
    })

    const first = await readService.getDependencies(
      root.evidenceRef.id,
      { direction: 'outbound', depth: 2, limit: 1 },
      CTX,
    )
    expect(first.coverage.truncated).toBe(true)
    expect(first.coverage.support?.complete).toBe(true)
    const second = await readService.getDependencies(
      root.evidenceRef.id,
      { direction: 'outbound', depth: 2, limit: 1, cursor: first.coverage.cursor ?? '' },
      CTX,
    )
    expect(second.coverage.support?.complete).toBe(false)
    expect(second.coverage.support?.resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceId: root.evidenceRef.id,
        resolution: expect.objectContaining({ state: 'unknown', complete: false }),
      }),
    ]))
  })
})
