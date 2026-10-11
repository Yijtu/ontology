import { describe, expect, it, vi } from 'vitest'
import type { OutboxMessageRecord, ProjectRecord, ProjectRevision, ResolvedProfileRecord, ResourceRef, SemanticDefinitionVersion, UpsertProjectReadinessInput } from '@ontology/contracts'
import { createCoreProjectSemanticReadiness } from '../../apps/api/src/composition/core-project-semantic-readiness'
import { DIGEST_A, SPACE_A, TENANT_A, toolContext } from './component-registry-fixtures'

const scope = { tenantId: TENANT_A, spaceId: SPACE_A }
const ctx = toolContext()
const timestamp = '2026-10-12T00:00:00Z'
const projectId = '77777777-7777-4777-8777-777777777777'
const ref = { id: 'readiness-test', version: '1.0.0', digest: DIGEST_A }
const mapping = { ...ref, role: 'catalog', sourceObjectRef: { sourceRef: { namespace: 'test', sourceId: 'source' }, objectPath: 'row' } }
const receipt: ResourceRef = { ...ref, kind: 'artifact' }
const revision: ProjectRevision = {
  ref: { projectId, revision: '1', digest: DIGEST_A }, industryPackRef: ref, definitionRef: ref, mappingRefs: [mapping],
  profileRef: { id: ref.id, version: ref.version, snapshotHash: DIGEST_A }, documentSetRef: receipt,
  semanticPublicationRefs: [], sourceVisibilityEpoch: '1', changeReason: 'unit capture fixture',
}
const project: ProjectRecord = { projectId, title: 'Capture fixture', headRevision: '1', activeRevision: '1', state: 'active', createdBy: 'test', createdAt: timestamp, updatedAt: timestamp }
const definition: SemanticDefinitionVersion = {
  scopeRef: scope, definitionId: ref.id, version: ref.version, namespace: 'test', layer: 'industry_core', standardProvenance: [],
  objects: [], attributes: [], relations: [], identityScopes: [], ruleConstraints: [], ref, publishedAt: timestamp,
}
const profile: ResolvedProfileRecord = {
  profileRef: ref, snapshotHash: DIGEST_A, outputVersion: '1.0.0', outputDigest: DIGEST_A,
  checkedAt: timestamp, resolvedAt: timestamp, createdAt: timestamp,
  resolved: { industryRef: ref, mappingRefs: [mapping], runtimeRef: ref, backendBindings: {}, modelBindings: {}, toolBindings: [], computeBindings: [],
    policyRef: ref, resolvedVersions: [], resolvedCapabilities: [], explicitDegradations: [], snapshotHash: DIGEST_A, resolvedAt: timestamp },
}
const message: OutboxMessageRecord = { outboxId: projectId, jobId: projectId, topic: 'semantic.materialization.requested', payload: {}, idempotencyKey: 'capture-unit', availableAt: timestamp, createdAt: timestamp, state: 'pending', attempts: 0 }

function fixture(mode: 'stable' | 'once' | 'always' | 'storage-error') {
  let semantic = '1'
  const archived: unknown[] = []
  const getProject = vi.fn(async () => project)
  const readCurrentInventory = vi.fn(async () => ({
    revision, definition, bindings: [], entities: [], declarations: [],
    source: { complete: true, readRevision: { semantic, identity: '1' }, entityBindings: [], rules: [], facts: [{
      projectId, assertionId: 'assertion', logicalAssertionId: 'logical', recordedSeq: semantic, op: 'assert' as const,
      subject: projectId, predicate: 'name', value: 'Asset', validity: { validFrom: timestamp }, sourceRef: { namespace: 'test', sourceId: 'source' },
    }] },
    catalog: { tasks: [], objects: [], entities: [], rules: [], relations: [], questions: [] },
  }))
  const stableWrite = vi.fn(async (_identity: string, bytes: Uint8Array): Promise<ResourceRef> => {
    if (mode === 'storage-error') throw new Error('storage unavailable')
    archived.push(JSON.parse(new TextDecoder().decode(bytes)))
    if (mode === 'always' || (mode === 'once' && archived.length === 1)) semantic = String(Number(semantic) + 1)
    return { ...receipt, id: `receipt-${archived.length}` }
  })
  const upsertProjection = vi.fn(async (_scope: typeof scope, input: UpsertProjectReadinessInput) => ({ projection: input, created: true }))
  const capture = createCoreProjectSemanticReadiness({
    projects: { getProject, getRevision: vi.fn(async () => revision) }, readiness: { upsertProjection },
    profiles: { getResolvedProfile: vi.fn(async () => profile) }, selectors: { readCurrentInventory },
    materialization: { getProjectionState: vi.fn(async () => ({ scopeRef: scope, generation: '1', dirty: false, watermark: { kind: 'sequence' as const, value: '1' } })), listOpenFences: vi.fn(async () => []) },
    currentRevisions: vi.fn(async () => [revision]), publications: { latestReadRevision: vi.fn(async () => semantic) },
    identity: { latestReadRevision: vi.fn(async () => '1') }, authoring: { stableWrite }, now: () => timestamp,
  })
  return { run: () => capture([projectId], message, ctx), archived, readCurrentInventory, getProject, upsertProjection, stableWrite }
}

describe('semantic readiness capture concurrency', () => {
  it('captures a stable source once without extra retries', async () => {
    const f = fixture('stable')
    await f.run()
    expect(f.readCurrentInventory).toHaveBeenCalledTimes(1)
    expect(f.upsertProjection).toHaveBeenCalledTimes(1)
    expect(f.archived[0]).toMatchObject({ sourceReadRevision: { semantic: '1', identity: '1' } })
  })

  it('fully recaptures a moved source and publishes only the newly fenced receipt', async () => {
    const f = fixture('once')
    await f.run()
    expect(f.readCurrentInventory).toHaveBeenCalledTimes(2)
    expect(f.getProject).toHaveBeenCalledTimes(4)
    expect(f.archived).toHaveLength(2)
    expect(f.archived[1]).toMatchObject({ sourceReadRevision: { semantic: '2', identity: '1' } })
    expect(f.upsertProjection).toHaveBeenCalledTimes(1)
    expect(f.upsertProjection.mock.calls[0]?.[1].receiptRef?.id).toBe('receipt-2')
  })

  it('fails after three moving captures without publishing readiness', async () => {
    const f = fixture('always')
    await expect(f.run()).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    expect(f.readCurrentInventory).toHaveBeenCalledTimes(3)
    expect(f.upsertProjection).not.toHaveBeenCalled()
  })

  it('does not retry or hide an unrelated storage failure', async () => {
    const f = fixture('storage-error')
    await expect(f.run()).rejects.toThrow('storage unavailable')
    expect(f.stableWrite).toHaveBeenCalledTimes(1)
    expect(f.upsertProjection).not.toHaveBeenCalled()
  })
})
