import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { BlobStoreError, LocalImmutableBlobStore, resourceKindForPurpose, sha256Digest } from '@ontology/adapter-blob-local'
import type {
  ArtifactBlobRecord,
  ArtifactReferenceRecord,
  ArtifactReferenceView,
  ArtifactRegistry,
  ImmutableObjectStore,
  RecordArtifactReferenceInput,
  RecordArtifactReferenceResult,
  StagedObject,
} from '@ontology/adapter-blob-local'
import { JevStateResolutionError, jevActualStateDigest } from '@ontology/adapter-model-jev'
import type { ResourceRef, ScopeRef, ToolContext } from '@ontology/contracts'
import { createToolContext } from '@ontology/contracts'
import { createCoreJevActualStateResolver } from '../../apps/api/src/composition/jev-actual-state'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const RESERVATION_ID = '55555555-5555-4555-8555-555555555555'
const PROFILE_HASH = `sha256:${'a'.repeat(64)}`

class MemoryObjectStore implements ImmutableObjectStore {
  readonly #staged = new Map<string, Uint8Array>()
  readonly #objects = new Map<string, Uint8Array>()
  readCount = 0

  async stage(scope: { readonly tenantId: string; readonly spaceId: string }, content: Uint8Array): Promise<StagedObject> {
    const contentDigest = sha256Digest(content)
    this.#staged.set(`${scope.tenantId}/${scope.spaceId}/${contentDigest}`, new Uint8Array(content))
    return { contentDigest, byteSize: content.byteLength }
  }

  async readStaged(scope: { readonly tenantId: string; readonly spaceId: string }, contentDigest: string): Promise<Uint8Array> {
    const content = this.#staged.get(`${scope.tenantId}/${scope.spaceId}/${contentDigest}`)
    if (content === undefined) throw new BlobStoreError('BLOB_CONTENT_NOT_STAGED', 'staged object missing')
    return new Uint8Array(content)
  }

  async discardStaged(scope: { readonly tenantId: string; readonly spaceId: string }, contentDigest: string): Promise<void> {
    this.#staged.delete(`${scope.tenantId}/${scope.spaceId}/${contentDigest}`)
  }

  async publish(contentDigest: string, content: Uint8Array): Promise<void> {
    this.#objects.set(contentDigest, new Uint8Array(content))
  }

  async read(contentDigest: string): Promise<Uint8Array> {
    this.readCount += 1
    const content = this.#objects.get(contentDigest)
    if (content === undefined) throw new BlobStoreError('BLOB_OBJECT_MISSING', 'stored object missing')
    if (sha256Digest(content) !== contentDigest) {
      throw new BlobStoreError('BLOB_INTEGRITY_MISMATCH', 'stored digest mismatch')
    }
    return new Uint8Array(content)
  }

  async remove(contentDigest: string): Promise<void> {
    this.#objects.delete(contentDigest)
  }
}

class MemoryArtifactRegistry implements ArtifactRegistry {
  readonly #views = new Map<string, ArtifactReferenceView>()
  lookupCount = 0

  async recordReference(input: RecordArtifactReferenceInput): Promise<RecordArtifactReferenceResult> {
    const blob: ArtifactBlobRecord = {
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      contentDigest: input.contentDigest,
      mediaType: input.mediaType,
      byteSize: input.byteSize,
      objectKey: input.objectKey,
      lineageId: randomUUID(),
      createdAt: '2026-09-28T00:00:00.000Z',
    }
    const reference: ArtifactReferenceRecord = {
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      blobRefId: input.blobRefId,
      contentDigest: input.contentDigest,
      purpose: input.purpose,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.tenantAuthorizedRef === undefined ? {} : { tenantAuthorizedRef: input.tenantAuthorizedRef }),
      origin: input.origin ?? {},
      createdAt: '2026-09-28T00:00:00.000Z',
    }
    const view = { blob, reference }
    this.#views.set(this.#key(input.scope, input.blobRefId), view)
    return {
      blobRef: {
        id: input.blobRefId,
        version: '1.0.0',
        digest: input.contentDigest,
        kind: resourceKindForPurpose(input.purpose),
      },
      lineageId: blob.lineageId,
      deduplicated: false,
      reference,
    }
  }

  async findReference(scope: { readonly tenantId: string; readonly spaceId: string }, blobRefId: string): Promise<ArtifactReferenceView | undefined> {
    this.lookupCount += 1
    return this.#views.get(this.#key(scope, blobRefId))
  }

  async listOrigins(
    scope: { readonly tenantId: string; readonly spaceId: string },
    contentDigest: string,
  ): Promise<readonly ArtifactReferenceRecord[]> {
    return [...this.#views.values()]
      .map((view) => view.reference)
      .filter((reference) =>
        reference.tenantId === scope.tenantId &&
        reference.spaceId === scope.spaceId &&
        reference.contentDigest === contentDigest,
      )
  }

  async close(): Promise<void> {}

  setByteSize(scope: ScopeRef, blobRefId: string, byteSize: number): void {
    const key = this.#key(scope, blobRefId)
    const view = this.#views.get(key)
    if (view === undefined) throw new Error('fixture blob reference is missing')
    this.#views.set(key, { ...view, blob: { ...view.blob, byteSize } })
  }

  #key(scope: { readonly tenantId: string; readonly spaceId: string }, blobRefId: string): string {
    return `${scope.tenantId}/${scope.spaceId}/${blobRefId}`
  }
}

interface Harness {
  readonly scope: ScopeRef
  readonly ctx: ToolContext
  readonly objectStore: MemoryObjectStore
  readonly registry: MemoryArtifactRegistry
  readonly blobStore: LocalImmutableBlobStore
  readonly resolve: ReturnType<typeof createCoreJevActualStateResolver>
  readonly approvedRefs: Set<string>
}

function context(
  scope: ScopeRef,
  resourceKinds: readonly ('artifact' | 'document' | 'checkpoint')[] = ['artifact'],
  runId = RUN_ID,
): ToolContext {
  return createToolContext({
    principal: { tenantId: scope.tenantId, subjectId: 'jev-state-test', roles: ['operator'], scopes: [], authEpoch: 1 },
    runId,
    resolvedProfileHash: PROFILE_HASH,
    policyVersion: '1.0.0',
    deadline: '2026-09-28T00:10:00Z',
    budgetReservation: {
      reservationId: RESERVATION_ID,
      runId,
      grantedAt: '2026-09-28T00:00:00Z',
      expiresAt: '2026-09-28T00:10:00Z',
    },
    allowedResources: {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      resourceKinds: [...resourceKinds],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-jev-actual-state-test',
  })
}

function harness(scope: ScopeRef, resourceKinds?: readonly ('artifact' | 'document' | 'checkpoint')[]): Harness {
  const objectStore = new MemoryObjectStore()
  const registry = new MemoryArtifactRegistry()
  const blobStore = new LocalImmutableBlobStore({ objectStore, registry })
  const approvedRefs = new Set<string>()
  return {
    scope,
    ctx: context(scope, resourceKinds),
    objectStore,
    registry,
    blobStore,
    approvedRefs,
    resolve: createCoreJevActualStateResolver({
      blobStore,
      stateRefAuthorizer: {
        isApproved: async (approved, ctx) =>
          approved.runId === ctx.runId &&
          approved.resolvedProfileHash === ctx.resolvedProfileHash &&
          approvedRefs.has(approvalKey(approved.runId, approved.resolvedProfileHash, approved.stateRef)),
      },
    }),
  }
}

function approvalKey(runId: string, profileHash: string, ref: ResourceRef): string {
  return `${runId}\u0000${profileHash}\u0000${ref.id}\u0000${ref.version}\u0000${ref.digest}\u0000${ref.kind}`
}

async function publishJson(h: Harness, jsonText: string): Promise<ResourceRef> {
  const content = new TextEncoder().encode(jsonText)
  const staged = await h.blobStore.stage(content, { scopeRef: h.scope }, h.ctx)
  const published = await h.blobStore.publish({
    scopeRef: h.scope,
    contentDigest: staged.contentDigest,
    mediaType: 'application/json; charset=utf-8',
    byteSize: staged.byteSize,
    purpose: 'artifact',
  }, h.ctx)
  h.approvedRefs.add(approvalKey(h.ctx.runId, h.ctx.resolvedProfileHash, published.blobRef))
  return published.blobRef
}

async function expectResolutionCode(result: Promise<unknown>, code: JevStateResolutionError['code']): Promise<void> {
  try {
    await result
  } catch (error) {
    if (!(error instanceof JevStateResolutionError)) throw error
    expect(error.code).toBe(code)
    return
  }
  throw new Error(`expected JEV state resolution error ${code}`)
}

describe('Core JEV actual-state artifact resolver', () => {
  it('loads a host-archived canonical actual state and returns only the complete parsed value', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const json = '{"candidates":[{"id":"candidate-1","score":0}],"confirmed":false}'
    const stateRef = await publishJson(h, json)

    const resolved = await h.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 16 }, h.ctx)

    expect(resolved).toEqual({
      state: { candidates: [{ id: 'candidate-1', score: 0 }], confirmed: false },
      resolvedRef: stateRef,
      complete: true,
    })
    expect(jevActualStateDigest(resolved.state)).toBe(stateRef.digest)
    expect(h.objectStore.readCount).toBe(1)
  })

  it('rejects a disallowed artifact kind before it queries authorized metadata', async () => {
    const writer = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(writer, '{"current":true}')
    const reader = harness({ tenantId: TENANT_A, spaceId: SPACE_A }, [])

    await expectResolutionCode(reader.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 16 }, reader.ctx), 'SCOPE_MISMATCH')

    expect(reader.registry.lookupCount).toBe(0)
    expect(reader.objectStore.readCount).toBe(0)
  })

  it('checks authorized metadata byte size before the bounded scoped body read', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(h, '{"payload":"bounded actual state"}')
    const scope = h.scope
    h.registry.setByteSize(scope, stateRef.id, 100)
    const readSpy = vi.spyOn(h.blobStore, 'readAuthorized')

    await expectResolutionCode(h.resolve.resolve({ stateRef, maxBytes: 32, maxRecords: 16 }, h.ctx), 'TOO_LARGE')

    expect(h.registry.lookupCount).toBe(1)
    expect(h.objectStore.readCount).toBe(0)
    expect(readSpy).not.toHaveBeenCalled()
  })

  it('checks actual byte length as well as the authorized size hint', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(h, JSON.stringify({ payload: 'x'.repeat(100) }))
    h.registry.setByteSize(h.scope, stateRef.id, 1)

    await expectResolutionCode(h.resolve.resolve({ stateRef, maxBytes: 32, maxRecords: 128 }, h.ctx), 'TOO_LARGE')

    expect(h.objectStore.readCount).toBe(1)
  })

  it('reports a truncated or metadata-inconsistent body as incomplete', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const json = '{"complete":true}'
    const stateRef = await publishJson(h, json)
    h.registry.setByteSize(h.scope, stateRef.id, new TextEncoder().encode(json).byteLength + 1)

    await expectResolutionCode(h.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 16 }, h.ctx), 'INCOMPLETE')
  })

  it('maps cross-tenant references to the blob store non-disclosure not-found result', async () => {
    const writer = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(writer, '{"tenant":"A"}')
    const reader = harness({ tenantId: TENANT_B, spaceId: SPACE_B })
    // Fault-inject an approval in the target run so this case exercises the blob store's
    // independent tenant/space authorization rather than the host-owned run binding.
    reader.approvedRefs.add(approvalKey(reader.ctx.runId, reader.ctx.resolvedProfileHash, stateRef))

    await expectResolutionCode(reader.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 16 }, reader.ctx), 'NOT_FOUND')

    expect(reader.registry.lookupCount).toBe(1)
    expect(reader.objectStore.readCount).toBe(0)
  })

  it('rejects another run’s same-tenant state reference before metadata or body reads', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(h, '{"run":"owner"}')
    const otherRunContext = context(h.scope, ['artifact'], '44444444-4444-4444-8444-444444444444')

    await expectResolutionCode(
      h.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 16 }, otherRunContext),
      'NOT_FOUND',
    )
    expect(h.registry.lookupCount).toBe(0)
    expect(h.objectStore.readCount).toBe(0)
  })

  it('rejects invalid JSON without returning the artifact bytes in the typed error', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(h, '{"private":"PRIVATE_STATE_SENTINEL"')

    try {
      await h.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 16 }, h.ctx)
      throw new Error('expected the invalid JSON to be rejected')
    } catch (error) {
      if (!(error instanceof JevStateResolutionError)) throw error
      expect(error.code).toBe('INVALID_STATE')
      expect(error.message).not.toContain('PRIVATE_STATE_SENTINEL')
    }
  })

  it('rejects a valid JSON body whose canonical state digest differs from its stateRef', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(h, '{ "x" : 1 }')

    await expectResolutionCode(h.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 16 }, h.ctx), 'DIGEST_MISMATCH')
  })

  it('applies the shared JEV record cap to object, array, and scalar records', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(h, '[1,2]')

    await expectResolutionCode(h.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 2 }, h.ctx), 'TOO_LARGE')
  })

  it('checks cancellation before any metadata or object read', async () => {
    const h = harness({ tenantId: TENANT_A, spaceId: SPACE_A })
    const stateRef = await publishJson(h, '{"cancelled":false}')
    const controller = new AbortController()
    controller.abort()

    await expectResolutionCode(
      h.resolve.resolve({ stateRef, maxBytes: 1024, maxRecords: 16, signal: controller.signal }, h.ctx),
      'CANCELLED',
    )
    expect(h.registry.lookupCount).toBe(0)
    expect(h.objectStore.readCount).toBe(0)
  })
})
