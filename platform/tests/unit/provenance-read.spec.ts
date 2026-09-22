import { describe, expect, it } from 'vitest'
import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPort,
  BlobPutImmutableResponse,
  EvidenceDependencyEdge,
  EvidenceEnvelope,
  EvidenceRecord,
  EvidenceStorePort,
  ResourceRef,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { ProvenanceReadError, ProvenanceReadService } from '@ontology/provenance'
import type { AuthorizedArtifactReader, EvidenceDependencySource } from '@ontology/provenance'
import { toolContext } from './component-registry-fixtures'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`

const CONTEXT_A: ToolContext = toolContext(TENANT_A, SPACE_A, ['scoped-reader'], 'reader-a', RUN_ID)
const CONTEXT_B: ToolContext = toolContext(TENANT_B, SPACE_B, ['scoped-reader'], 'reader-b', RUN_ID)
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }

function resource(id: string, digest = DIGEST): ResourceRef {
  return { id, version: '1.0.0', digest, kind: 'evidence' }
}

class FakeEvidenceStore implements EvidenceStorePort {
  readonly #records = new Map<string, EvidenceRecord>()

  put(scopeRef: ScopeRef, record: EvidenceRecord): void {
    this.#records.set(`${scopeRef.tenantId}|${scopeRef.spaceId}|${record.evidenceRef.id}`, record)
  }

  record(): Promise<EvidenceRecord> {
    throw new Error('record is not exercised by the provenance read unit tests')
  }

  get(scopeRef: ScopeRef, evidenceId: Uuid): Promise<EvidenceRecord | undefined> {
    return Promise.resolve(
      this.#records.get(`${scopeRef.tenantId}|${scopeRef.spaceId}|${evidenceId}`),
    )
  }

  listByRun(scopeRef: ScopeRef, runId: Uuid): Promise<EvidenceRecord[]> {
    return Promise.resolve(
      [...this.#records.entries()]
        .filter(([key]) => key.startsWith(`${scopeRef.tenantId}|${scopeRef.spaceId}|`))
        .map(([, record]) => record)
        .filter((record) => record.envelope.producedBy.runId === runId),
    )
  }
}

interface StoredBlob {
  readonly digest: string
  readonly bytes: Uint8Array
  readonly mediaType: string
}

class FakeBlobPort implements BlobPort {
  readonly #blobs = new Map<string, StoredBlob>()

  put(id: string, bytes: Uint8Array, digest = DIGEST, mediaType = 'text/plain'): void {
    this.#blobs.set(id, { digest, bytes, mediaType })
  }

  remove(id: string): void {
    this.#blobs.delete(id)
  }

  putImmutable(): Promise<BlobPutImmutableResponse> {
    throw new Error('putImmutable is not exercised by the provenance read unit tests')
  }

  getAuthorized(
    request: BlobGetAuthorizedRequest,
  ): Promise<BlobGetAuthorizedResponse> {
    const blob = this.#blobs.get(request.blobRef.id)
    if (blob === undefined) return Promise.reject(new Error(`no authorized blob ${request.blobRef.id}`))
    if (blob.digest !== request.blobRef.digest) {
      return Promise.reject(new Error(`integrity mismatch for ${request.blobRef.id}`))
    }
    return Promise.resolve({
      blobRef: request.blobRef,
      contentDigest: blob.digest,
      mediaType: blob.mediaType,
      byteSize: blob.bytes.byteLength,
      integrityVerified: true,
    })
  }
}

class FakeReader implements AuthorizedArtifactReader {
  readonly #blobs: FakeBlobPort
  readonly #bytes = new Map<string, Uint8Array>()

  constructor(blobs: FakeBlobPort) {
    this.#blobs = blobs
  }

  expose(id: string, bytes: Uint8Array): void {
    this.#bytes.set(id, bytes)
    this.#blobs.put(id, bytes)
  }

  async readAuthorized(request: BlobGetAuthorizedRequest): Promise<Uint8Array> {
    const bytes = this.#bytes.get(request.blobRef.id)
    if (bytes === undefined) throw new Error(`no authorized bytes for ${request.blobRef.id}`)
    return bytes
  }
}

class FakeDependencySource implements EvidenceDependencySource {
  readonly #edges = new Map<string, readonly EvidenceDependencyEdge[]>()

  set(evidenceId: string, edges: readonly EvidenceDependencyEdge[]): void {
    this.#edges.set(evidenceId, edges)
  }

  dependenciesOf(
    _scopeRef: ScopeRef,
    evidence: EvidenceRecord,
  ): Promise<readonly EvidenceDependencyEdge[]> {
    return Promise.resolve(this.#edges.get(evidence.evidenceRef.id) ?? [])
  }
}

function envelope(overrides: Partial<EvidenceEnvelope> & Pick<EvidenceEnvelope, 'evidenceId'>): EvidenceEnvelope {
  return {
    kind: 'rule_derivation',
    scopeRef: SCOPE_A,
    producedBy: { componentRef: { id: 'component', version: '1.0.0', digest: DIGEST }, runId: RUN_ID },
    observedAt: '2026-09-21T00:00:00Z',
    recordedSeq: '1',
    sourceSnapshots: [],
    resultDigest: OTHER_DIGEST,
    integrity: { algorithm: 'sha256', digest: DIGEST },
    dependencies: [],
    dataMode: 'observed',
    ...overrides,
  }
}

function record(envelopeValue: EvidenceEnvelope): EvidenceRecord {
  return {
    evidenceRef: resource(envelopeValue.evidenceId),
    envelope: envelopeValue,
    envelopeDigest: envelopeValue.integrity.digest,
    revision: '1',
    recordedAt: '2026-09-21T00:00:01Z',
  }
}

function createService(): {
  service: ProvenanceReadService
  evidence: FakeEvidenceStore
  blobs: FakeBlobPort
  reader: FakeReader
  dependencies: FakeDependencySource
} {
  const evidence = new FakeEvidenceStore()
  const blobs = new FakeBlobPort()
  const reader = new FakeReader(blobs)
  const dependencies = new FakeDependencySource()
  const service = new ProvenanceReadService({
    evidence,
    blobs,
    dependencies,
    reader,
    maxDependencyDepth: 4,
    maxPageSize: 200,
  })
  return { service, evidence, blobs, reader, dependencies }
}

function supportEdge(to: string, groupId: string): EvidenceDependencyEdge {
  return {
    fromEvidenceId: 'root',
    toEvidenceId: to,
    relation: 'derives_from',
    origin: 'support',
    premiseGroup: groupId,
  }
}

describe('ProvenanceReadService.getEvidence', () => {
  it('traces to rule, premise groups and source snapshots with an explicit re-readability flag', async () => {
    const { service, evidence, blobs, dependencies } = createService()
    const evidenceId = 'e0000000-0000-4000-8000-000000000001'
    const archivedId = 'b0000000-0000-4000-8000-000000000002'
    blobs.put('payload', new TextEncoder().encode('result'), DIGEST, 'application/json')
    blobs.put(archivedId, new TextEncoder().encode('snapshot'), OTHER_DIGEST, 'text/plain')
    evidence.put(
      SCOPE_A,
      record(
        envelope({
          evidenceId,
          producedBy: {
            componentRef: { id: 'component', version: '1.0.0', digest: DIGEST },
            runId: RUN_ID,
            ruleRef: { id: 'rule.battery', version: '1', digest: DIGEST },
          },
          payloadRef: resource('payload'),
          sourceSnapshots: [
            {
              sourceRef: { namespace: 'postgres', sourceId: 'meter' },
              schemaVersion: '1',
              readAt: '2026-09-21T00:00:00Z',
              consistency: 'immutable',
              resultDigest: OTHER_DIGEST,
            },
            {
              sourceRef: { namespace: 'postgres', sourceId: 'billing' },
              schemaVersion: '1',
              readAt: '2026-09-21T00:00:00Z',
              consistency: 'repeatable_read',
              resultDigest: OTHER_DIGEST,
              archivedResultRef: resource(archivedId, OTHER_DIGEST),
            },
          ],
        }),
      ),
    )
    dependencies.set(evidenceId, [
      supportEdge('f0000000-0000-4000-8000-000000000001', 'g1'),
      supportEdge('f0000000-0000-4000-8000-000000000002', 'g1'),
      supportEdge('f0000000-0000-4000-8000-000000000003', 'g2'),
      {
        fromEvidenceId: evidenceId,
        toEvidenceId: 'f0000000-0000-4000-8000-000000000009',
        relation: 'same_source',
        origin: 'lineage',
      },
    ])

    const view = await service.getEvidence(evidenceId, {}, CONTEXT_A)

    expect(view.outcome).toBe('verifiable')
    expect(view.integrityVerified).toBe(true)
    expect(view.ruleRefs.map((ref) => ref.id)).toEqual(['rule.battery'])
    expect(view.premiseGroups).toEqual([
      {
        groupId: 'g1',
        alternativeEvidenceIds: [
          'f0000000-0000-4000-8000-000000000001',
          'f0000000-0000-4000-8000-000000000002',
        ],
      },
      { groupId: 'g2', alternativeEvidenceIds: ['f0000000-0000-4000-8000-000000000003'] },
    ])
    expect(view.sources.map((source) => source.reReadability)).toEqual([
      're_readable',
      'archived_snapshot_only',
    ])
    expect(view.originalSourceReReadable).toBe(true)
    expect(view.archivedResult).toEqual({ ref: resource('payload'), verified: true })
  })

  it('returns unverifiable when an archived source artifact is missing or corrupt', async () => {
    const { service, evidence } = createService()
    const evidenceId = 'e0000000-0000-4000-8000-000000000002'
    evidence.put(
      SCOPE_A,
      record(
        envelope({
          evidenceId,
          sourceSnapshots: [
            {
              sourceRef: { namespace: 'postgres', sourceId: 'billing' },
              schemaVersion: '1',
              readAt: '2026-09-21T00:00:00Z',
              consistency: 'repeatable_read',
              resultDigest: OTHER_DIGEST,
              archivedResultRef: resource('missing-artifact'),
            },
          ],
        }),
      ),
    )

    const view = await service.getEvidence(evidenceId, {}, CONTEXT_A)
    expect(view.outcome).toBe('unverifiable')
    expect(view.originalSourceReReadable).toBe(false)
    expect(view.sources[0]?.reReadability).toBe('unverifiable')
    expect(view.reason).toContain('archived source snapshot')
  })

  it('returns 404 for a missing evidence and refuses a cross-tenant read without disclosure', async () => {
    const { service, evidence } = createService()
    const evidenceId = 'e0000000-0000-4000-8000-000000000003'
    evidence.put(SCOPE_A, record(envelope({ evidenceId })))

    await expect(service.getEvidence(evidenceId, {}, CONTEXT_A)).resolves.toBeDefined()
    await expect(service.getEvidence(evidenceId, {}, CONTEXT_B)).rejects.toMatchObject({
      code: 'EVIDENCE_NOT_FOUND',
      httpStatus: 404,
    })
    await expect(
      service.getEvidence('e0000000-0000-4000-8000-0000000000ff', {}, CONTEXT_A),
    ).rejects.toBeInstanceOf(ProvenanceReadError)
  })

  it('hides evidence that was not yet recorded at the requested asOf version', async () => {
    const { service, evidence } = createService()
    const evidenceId = 'e0000000-0000-4000-8000-000000000004'
    evidence.put(SCOPE_A, record(envelope({ evidenceId, recordedSeq: '9' })))
    await expect(
      service.getEvidence(evidenceId, { asOf: '3' }, CONTEXT_A),
    ).rejects.toMatchObject({ code: 'EVIDENCE_NOT_FOUND' })
    await expect(service.getEvidence(evidenceId, { asOf: '9' }, CONTEXT_A)).resolves.toBeDefined()
  })
})

describe('ProvenanceReadService.getDependencies', () => {
  function chain(): ReturnType<typeof createService> {
    const harness = createService()
    for (let index = 0; index < 6; index += 1) {
      const id = `c0000000-0000-4000-8000-00000000000${String(index)}`
      harness.evidence.put(SCOPE_A, record(envelope({ evidenceId: id })))
    }
    for (let index = 0; index < 5; index += 1) {
      const from = `c0000000-0000-4000-8000-00000000000${String(index)}`
      const to = `c0000000-0000-4000-8000-00000000000${String(index + 1)}`
      harness.dependencies.set(from, [
        { fromEvidenceId: from, toEvidenceId: to, relation: 'derives_from', origin: 'support', premiseGroup: 'g' },
      ])
    }
    return harness
  }

  it('enforces depth and page size and marks a truncated traversal explicitly', async () => {
    const { service } = chain()
    const root = 'c0000000-0000-4000-8000-000000000000'
    const page = await service.getDependencies(root, { direction: 'outbound', depth: 99, limit: 2 }, CONTEXT_A)

    expect(page.depth).toBe(4)
    expect(page.nodes).toHaveLength(2)
    expect(page.coverage.truncated).toBe(true)
    expect(page.coverage.returned).toBe(2)
    expect(page.coverage.cursor).toBeDefined()

    const next = await service.getDependencies(
      root,
      { direction: 'outbound', depth: 99, limit: 2, cursor: page.coverage.cursor ?? '' },
      CONTEXT_A,
    )
    expect(next.nodes.map((node) => node.depth)).toEqual([2, 3])
    expect(next.nodes[0]?.evidenceId).toBe('c0000000-0000-4000-8000-000000000002')
  })

  it('follows inbound direction to the dependents of an evidence', async () => {
    const { service } = chain()
    const leaf = 'c0000000-0000-4000-8000-000000000001'
    const outbound = await service.getDependencies(leaf, { direction: 'outbound', depth: 1 }, CONTEXT_A)
    expect(outbound.nodes.map((node) => node.evidenceId)).toEqual([
      'c0000000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-000000000002',
    ])

    const inbound = await service.getDependencies(leaf, { direction: 'inbound', depth: 1 }, CONTEXT_A)
    expect(inbound.nodes.map((node) => node.evidenceId)).toEqual([
      'c0000000-0000-4000-8000-000000000001',
      'c0000000-0000-4000-8000-000000000000',
    ])
  })

  it('rejects a malformed cursor instead of silently resetting to the first page', async () => {
    const { service } = chain()
    const root = 'c0000000-0000-4000-8000-000000000000'
    await expect(
      service.getDependencies(root, { direction: 'outbound', depth: 1, cursor: 'not-a-cursor' }, CONTEXT_A),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' })
  })
})

describe('ProvenanceReadService.exportEvidence', () => {
  it('exports only authorized, verified artifacts and omits a missing one', async () => {
    const { service, evidence, reader } = createService()
    const evidenceId = 'e0000000-0000-4000-8000-00000000000a'
    reader.expose('payload', new TextEncoder().encode('payload-bytes'))
    evidence.put(
      SCOPE_A,
      record(
        envelope({
          evidenceId,
          payloadRef: resource('payload'),
          sourceSnapshots: [
            {
              sourceRef: { namespace: 'postgres', sourceId: 'meter' },
              schemaVersion: '1',
              readAt: '2026-09-21T00:00:00Z',
              consistency: 'repeatable_read',
              resultDigest: OTHER_DIGEST,
              archivedResultRef: resource('gone', OTHER_DIGEST),
            },
          ],
        }),
      ),
    )

    const bundle = await service.exportEvidence(evidenceId, {}, CONTEXT_A)
    expect(bundle.view.outcome).toBe('unverifiable')
    expect(bundle.artifacts.map((artifact) => artifact.ref.id)).toEqual(['payload'])
    expect(Buffer.from(bundle.artifacts[0]?.contentBase64 ?? '', 'base64').toString('utf8')).toBe(
      'payload-bytes',
    )
  })

  it('refuses an export of another tenant without disclosing existence', async () => {
    const { service, evidence } = createService()
    const evidenceId = 'e0000000-0000-4000-8000-00000000000b'
    evidence.put(SCOPE_A, record(envelope({ evidenceId })))
    await expect(service.exportEvidence(evidenceId, {}, CONTEXT_B)).rejects.toMatchObject({
      code: 'EVIDENCE_NOT_FOUND',
      httpStatus: 404,
    })
  })
})
