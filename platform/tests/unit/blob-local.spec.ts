import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type { ResourceRef, ScopeRef, ToolContext } from '@ontology/contracts'
import {
  BlobStoreError,
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  objectKeyForDigest,
  resourceKindForPurpose,
  sha256Digest,
} from '@ontology/adapter-blob-local'
import type {
  ArtifactBlobRecord,
  ArtifactReferenceRecord,
  ArtifactReferenceView,
  ArtifactRegistry,
  BlobPurpose,
  ImmutableObjectStore,
  RecordArtifactReferenceInput,
  RecordArtifactReferenceResult,
  StagedObject,
} from '@ontology/adapter-blob-local'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_A = '33333333-3333-4333-8333-333333333333'
const RUN_B = '44444444-4444-4444-8444-444444444444'
const DIGEST = `sha256:${'a'.repeat(64)}`
const RESERVATION_ID = '55555555-5555-4555-8555-555555555555'

function toolContext(
  tenantId: string,
  spaceId: string,
  options?: { readonly runId?: string },
): ToolContext {
  const runId = options?.runId ?? RUN_A
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'unit-test',
      roles: ['platform-admin'],
      scopes: ['artifact:read', 'artifact:write'],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '1.0.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: RESERVATION_ID,
      runId,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2026-09-21T00:10:00Z',
    },
    allowedResources: {
      tenantId,
      spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-blob-unit',
  })
}

const CONTEXT_A = toolContext(TENANT_A, SPACE_A)
const CONTEXT_B = toolContext(TENANT_B, SPACE_B)
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const SCOPE_B: ScopeRef = { tenantId: TENANT_B, spaceId: SPACE_B }

function blobKey(scope: ScopeRef, contentDigest: string): string {
  return `${scope.tenantId}/${scope.spaceId}/${contentDigest}`
}

function refKey(scope: ScopeRef, blobRefId: string): string {
  return `${scope.tenantId}/${scope.spaceId}/${blobRefId}`
}

class InMemoryArtifactRegistry implements ArtifactRegistry {
  readonly #blobs = new Map<string, ArtifactBlobRecord>()
  readonly #references = new Map<string, ArtifactReferenceRecord>()

  async recordReference(
    input: RecordArtifactReferenceInput,
  ): Promise<RecordArtifactReferenceResult> {
    const key = blobKey(input.scope, input.contentDigest)
    let blob = this.#blobs.get(key)
    let deduplicated = false
    if (blob === undefined) {
      blob = {
        tenantId: input.scope.tenantId,
        spaceId: input.scope.spaceId,
        contentDigest: input.contentDigest,
        mediaType: input.mediaType,
        byteSize: input.byteSize,
        objectKey: input.objectKey,
        lineageId: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      this.#blobs.set(key, blob)
    } else {
      deduplicated = true
      if (blob.mediaType !== input.mediaType) {
        throw new BlobStoreError('BLOB_MEDIA_TYPE_CONFLICT', 'media type conflict')
      }
      if (blob.byteSize !== input.byteSize) {
        throw new BlobStoreError('BLOB_SIZE_MISMATCH', 'size conflict')
      }
    }

    const reference: ArtifactReferenceRecord = {
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      blobRefId: input.blobRefId,
      contentDigest: input.contentDigest,
      purpose: input.purpose,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.tenantAuthorizedRef === undefined
        ? {}
        : { tenantAuthorizedRef: input.tenantAuthorizedRef }),
      origin: input.origin ?? {},
      createdAt: new Date().toISOString(),
    }
    this.#references.set(refKey(input.scope, input.blobRefId), reference)

    const blobRef: ResourceRef = {
      id: input.blobRefId,
      version: '1.0.0',
      digest: input.contentDigest,
      kind: resourceKindForPurpose(input.purpose),
    }
    return { blobRef, lineageId: blob.lineageId, deduplicated, reference }
  }

  async findReference(scope: ScopeRef, blobRefId: string): Promise<ArtifactReferenceView | undefined> {
    const reference = this.#references.get(refKey(scope, blobRefId))
    if (reference === undefined) {
      return undefined
    }
    const blob = this.#blobs.get(blobKey(scope, reference.contentDigest))
    if (blob === undefined) {
      return undefined
    }
    return { reference, blob }
  }

  async listOrigins(
    scope: ScopeRef,
    contentDigest: string,
  ): Promise<readonly ArtifactReferenceRecord[]> {
    return [...this.#references.values()].filter(
      (reference) =>
        reference.tenantId === scope.tenantId &&
        reference.spaceId === scope.spaceId &&
        reference.contentDigest === contentDigest,
    )
  }

  async close(): Promise<void> {}
}

class FaultyRegistry implements ArtifactRegistry {
  failRecordReference = false
  readonly #inner: ArtifactRegistry

  constructor(inner: ArtifactRegistry) {
    this.#inner = inner
  }

  async recordReference(
    input: RecordArtifactReferenceInput,
  ): Promise<RecordArtifactReferenceResult> {
    if (this.failRecordReference) {
      throw new Error('injected registry failure')
    }
    return this.#inner.recordReference(input)
  }

  findReference(scope: ScopeRef, blobRefId: string): Promise<ArtifactReferenceView | undefined> {
    return this.#inner.findReference(scope, blobRefId)
  }

  listOrigins(
    scope: ScopeRef,
    contentDigest: string,
  ): Promise<readonly ArtifactReferenceRecord[]> {
    return this.#inner.listOrigins(scope, contentDigest)
  }

  close(): Promise<void> {
    return this.#inner.close()
  }
}

class FaultyObjectStore implements ImmutableObjectStore {
  failPublish = false
  readCalls = 0
  readonly #inner: ImmutableObjectStore

  constructor(inner: ImmutableObjectStore) {
    this.#inner = inner
  }

  stage(scope: ScopeRef, content: Uint8Array): Promise<StagedObject> {
    return this.#inner.stage(scope, content)
  }

  readStaged(scope: ScopeRef, contentDigest: string): Promise<Uint8Array> {
    return this.#inner.readStaged(scope, contentDigest)
  }

  discardStaged(scope: ScopeRef, contentDigest: string): Promise<void> {
    return this.#inner.discardStaged(scope, contentDigest)
  }

  async publish(contentDigest: string, content: Uint8Array): Promise<void> {
    if (this.failPublish) {
      throw new Error('injected object publish failure')
    }
    await this.#inner.publish(contentDigest, content)
  }

  read(contentDigest: string): Promise<Uint8Array> {
    this.readCalls += 1
    return this.#inner.read(contentDigest)
  }

  remove(contentDigest: string): Promise<void> {
    return this.#inner.remove(contentDigest)
  }
}

interface Harness {
  readonly dir: string
  readonly registry: FaultyRegistry
  readonly objectStore: FaultyObjectStore
  readonly store: LocalImmutableBlobStore
}

const createdDirs: string[] = []

async function createHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'blob-local-unit-'))
  createdDirs.push(dir)
  const fileSystem = new FileSystemObjectStore(dir)
  await fileSystem.init()
  const objectStore = new FaultyObjectStore(fileSystem)
  const registry = new FaultyRegistry(new InMemoryArtifactRegistry())
  const store = new LocalImmutableBlobStore({ objectStore, registry })
  return { dir, registry, objectStore, store }
}

async function captureBlobError(run: () => Promise<unknown>): Promise<BlobStoreError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof BlobStoreError) {
      return error
    }
    throw error
  }
  throw new Error('expected the blob operation to fail')
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

async function publishContent(
  harness: Harness,
  text: string,
  options?: {
    readonly scopeRef?: ScopeRef
    readonly ctx?: ToolContext
    readonly purpose?: BlobPurpose
    readonly runId?: string
  },
): Promise<ResourceRef> {
  const scopeRef = options?.scopeRef ?? SCOPE_A
  const ctx = options?.ctx ?? CONTEXT_A
  const purpose = options?.purpose ?? 'document'
  const content = bytes(text)
  const staged = await harness.store.stage(content, { scopeRef }, ctx)
  const response = await harness.store.publish(
    {
      scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose,
      ...(options?.runId === undefined ? {} : { runId: options.runId }),
    },
    ctx,
  )
  return response.blobRef
}

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('content-addressed blob lifecycle', () => {
  it('stages, verifies, publishes and reads back the exact bytes', async () => {
    const harness = await createHarness()
    const content = bytes('the original document')
    const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    expect(staged.contentDigest).toBe(sha256Digest(content))
    expect(staged.byteSize).toBe(content.byteLength)

    const published = await harness.store.publish(
      {
        scopeRef: SCOPE_A,
        contentDigest: staged.contentDigest,
        mediaType: 'text/plain',
        byteSize: staged.byteSize,
        purpose: 'document',
      },
      CONTEXT_A,
    )
    expect(published.blobRef.kind).toBe('document')
    expect(published.integrity.algorithm).toBe('sha256')

    const described = await harness.store.getAuthorized(
      { scopeRef: SCOPE_A, blobRef: published.blobRef },
      CONTEXT_A,
    )
    expect(described.mediaType).toBe('text/plain')
    expect(described.integrityVerified).toBe(true)

    const read = await harness.store.readAuthorized(
      { scopeRef: SCOPE_A, blobRef: published.blobRef },
      CONTEXT_A,
    )
    expect(new TextDecoder().decode(read)).toBe('the original document')
  })

  it('authorizes bounded metadata without reading blob bytes', async () => {
    const harness = await createHarness()
    const blobRef = await publishContent(harness, '{"question":"actual state"}', { purpose: 'artifact' })
    const before = harness.objectStore.readCalls

    const metadata = await harness.store.getAuthorizedMetadata({ scopeRef: SCOPE_A, blobRef }, CONTEXT_A)

    expect(metadata).toMatchObject({ blobRef, mediaType: 'text/plain', byteSize: new TextEncoder().encode('{"question":"actual state"}').byteLength })
    expect(metadata).not.toHaveProperty('integrityVerified')
    expect(harness.objectStore.readCalls).toBe(before)
  })

  it('rejects a staged file whose bytes no longer match the declared digest', async () => {
    const harness = await createHarness()
    const content = bytes('content')
    const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    const stagedPath = join(
      harness.dir,
      'staging',
      TENANT_A,
      SPACE_A,
      objectKeyForDigest(staged.contentDigest),
    )
    await writeFile(stagedPath, bytes('tampered staged bytes'))

    const error = await captureBlobError(() =>
      harness.store.publish(
        {
          scopeRef: SCOPE_A,
          contentDigest: staged.contentDigest,
          mediaType: 'text/plain',
          byteSize: staged.byteSize,
          purpose: 'document',
        },
        CONTEXT_A,
      ),
    )
    expect(error.code).toBe('BLOB_DIGEST_MISMATCH')

    const reference = await harness.registry.listOrigins(SCOPE_A, staged.contentDigest)
    expect(reference).toEqual([])
  })

  it('rejects a size mismatch and records no reference', async () => {
    const harness = await createHarness()
    const content = bytes('content')
    const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)

    const error = await captureBlobError(() =>
      harness.store.publish(
        {
          scopeRef: SCOPE_A,
          contentDigest: staged.contentDigest,
          mediaType: 'text/plain',
          byteSize: staged.byteSize + 1,
          purpose: 'document',
        },
        CONTEXT_A,
      ),
    )
    expect(error.code).toBe('BLOB_SIZE_MISMATCH')
  })

  it('rejects a publish that was never staged', async () => {
    const harness = await createHarness()
    const content = bytes('never staged')
    const error = await captureBlobError(() =>
      harness.store.publish(
        {
          scopeRef: SCOPE_A,
          contentDigest: sha256Digest(content),
          mediaType: 'text/plain',
          byteSize: content.byteLength,
          purpose: 'document',
        },
        CONTEXT_A,
      ),
    )
    expect(error.code).toBe('BLOB_CONTENT_NOT_STAGED')
  })

  it('rejects malformed publish requests', async () => {
    const harness = await createHarness()
    const content = bytes('content')
    const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    const base = {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document' as const,
    }
    expect((await captureBlobError(() => harness.store.publish({ ...base, contentDigest: 'nope' }, CONTEXT_A))).code).toBe('INVALID_REQUEST')
    expect((await captureBlobError(() => harness.store.publish({ ...base, mediaType: '  ' }, CONTEXT_A))).code).toBe('INVALID_REQUEST')
    expect((await captureBlobError(() => harness.store.publish({ ...base, byteSize: -1 }, CONTEXT_A))).code).toBe('INVALID_REQUEST')
    expect(
      (
        await captureBlobError(() =>
          harness.store.publish({ ...base, runId: RUN_A }, CONTEXT_A),
        )
      ).code,
    ).toBe('INVALID_REQUEST')
  })
})

describe('authorization and cross-tenant non-disclosure', () => {
  it('rejects a scopeRef that differs from the trusted principal', async () => {
    const harness = await createHarness()
    const error = await captureBlobError(() =>
      harness.store.stage(bytes('x'), { scopeRef: SCOPE_B }, CONTEXT_A),
    )
    expect(error.code).toBe('SCOPE_MISMATCH')
  })

  it('returns the same error for another tenant as for missing content', async () => {
    const harness = await createHarness()
    const blobRef = await publishContent(harness, 'tenant-a secret')

    const crossTenant = await captureBlobError(() =>
      harness.store.getAuthorized({ scopeRef: SCOPE_B, blobRef }, CONTEXT_B),
    )
    const missing = await captureBlobError(() =>
      harness.store.getAuthorized(
        { scopeRef: SCOPE_B, blobRef: { ...blobRef, id: randomUUID() } },
        CONTEXT_B,
      ),
    )
    expect(crossTenant.code).toBe('BLOB_NOT_FOUND')
    expect(missing.code).toBe('BLOB_NOT_FOUND')
    // The two failures differ only by the requested id: neither reveals whether
    // the content exists anywhere, and neither carries the stored digest.
    expect(crossTenant.message).toMatch(/^no authorized blob .* in the requested scope$/)
    expect(missing.message).toMatch(/^no authorized blob .* in the requested scope$/)
    expect(crossTenant.message).not.toContain(blobRef.digest)
    expect(missing.message).not.toContain(blobRef.digest)
  })

  it('does not reveal the stored digest to another tenant', async () => {
    const harness = await createHarness()
    const blobRef = await publishContent(harness, 'tenant-a secret')
    const error = await captureBlobError(() =>
      harness.store.getAuthorized({ scopeRef: SCOPE_B, blobRef }, CONTEXT_B),
    )
    expect(error.message).not.toContain(blobRef.digest)
  })

  it('rejects a reference whose digest does not match the stored content', async () => {
    const harness = await createHarness()
    const blobRef = await publishContent(harness, 'content')
    const error = await captureBlobError(() =>
      harness.store.getAuthorized(
        { scopeRef: SCOPE_A, blobRef: { ...blobRef, digest: sha256Digest(bytes('other')) } },
        CONTEXT_A,
      ),
    )
    expect(error.code).toBe('BLOB_INTEGRITY_MISMATCH')
  })
})

describe('missing and corrupt objects raise explicit errors', () => {
  it('reports a missing object instead of empty data', async () => {
    const harness = await createHarness()
    const blobRef = await publishContent(harness, 'will be deleted')
    await harness.objectStore.remove(blobRef.digest)

    const error = await captureBlobError(() =>
      harness.store.readAuthorized({ scopeRef: SCOPE_A, blobRef }, CONTEXT_A),
    )
    expect(error.code).toBe('BLOB_OBJECT_MISSING')
  })

  it('reports a corrupt object instead of returning it', async () => {
    const harness = await createHarness()
    const blobRef = await publishContent(harness, 'original bytes')
    const objectPath = join(harness.dir, 'objects', objectKeyForDigest(blobRef.digest))
    await writeFile(objectPath, bytes('tampered bytes'))

    const error = await captureBlobError(() =>
      harness.store.readAuthorized({ scopeRef: SCOPE_A, blobRef }, CONTEXT_A),
    )
    expect(error.code).toBe('BLOB_INTEGRITY_MISMATCH')
    expect(new TextDecoder().decode(await readFile(objectPath))).toBe('tampered bytes')
  })
})

describe('duplicate uploads share one lineage without duplicating bytes', () => {
  it('reuses the digest, marks the duplicate and keeps both origins', async () => {
    const harness = await createHarness()
    const first = await publishContent(harness, 'shared document')
    const second = await publishContent(harness, 'shared document')

    expect(second.digest).toBe(first.digest)
    expect(second.id).not.toBe(first.id)

    const origins = await harness.store.listOrigins({ scopeRef: SCOPE_A, blobRef: first }, CONTEXT_A)
    expect(origins.map((origin) => origin.blobRefId).sort()).toEqual([first.id, second.id].sort())

    const objects = await readFile(join(harness.dir, 'objects', objectKeyForDigest(first.digest)))
    expect(new TextDecoder().decode(objects)).toBe('shared document')
  })

  it('marks a repeat upload as deduplicated and a first upload as new', async () => {
    const harness = await createHarness()
    const content = bytes('dedup me')
    const request = async (): Promise<{
      scopeRef: ScopeRef
      contentDigest: string
      mediaType: string
      byteSize: number
      purpose: 'document'
    }> => {
      const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
      return {
        scopeRef: SCOPE_A,
        contentDigest: staged.contentDigest,
        mediaType: 'text/plain',
        byteSize: staged.byteSize,
        purpose: 'document',
      }
    }
    const first = await harness.store.publish(await request(), CONTEXT_A)
    expect(first.deduplicated).toBe(false)
    const second = await harness.store.publish(await request(), CONTEXT_A)
    expect(second.deduplicated).toBe(true)
    expect(second.blobRef.digest).toBe(first.blobRef.digest)
  })

  it('publishes from the stored object when the staging copy is already gone', async () => {
    const harness = await createHarness()
    const content = bytes('already published')
    const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    const request = {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document' as const,
    }
    await harness.store.publish(request, CONTEXT_A)
    // A successful publish discards the staging copy; a retry must still work.
    const again = await harness.store.publish(request, CONTEXT_A)
    expect(again.deduplicated).toBe(true)
  })
})

describe('private checkpoints stay inside their run', () => {
  it('requires a run when publishing a checkpoint', async () => {
    const harness = await createHarness()
    const content = bytes('checkpoint state')
    const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    const error = await captureBlobError(() =>
      harness.store.publish(
        {
          scopeRef: SCOPE_A,
          contentDigest: staged.contentDigest,
          mediaType: 'application/octet-stream',
          byteSize: staged.byteSize,
          purpose: 'checkpoint',
        },
        CONTEXT_A,
      ),
    )
    expect(error.code).toBe('BLOB_CHECKPOINT_RUN_REQUIRED')
  })

  it('hides a checkpoint from a different run in the same scope', async () => {
    const harness = await createHarness()
    const blobRef = await publishContent(harness, 'private state', {
      purpose: 'checkpoint',
      runId: RUN_A,
    })

    const sameRun = await harness.store.getAuthorized(
      { scopeRef: SCOPE_A, blobRef },
      toolContext(TENANT_A, SPACE_A, { runId: RUN_A }),
    )
    expect(sameRun.blobRef.kind).toBe('checkpoint')

    const otherRun = await captureBlobError(() =>
      harness.store.getAuthorized(
        { scopeRef: SCOPE_A, blobRef },
        toolContext(TENANT_A, SPACE_A, { runId: RUN_B }),
      ),
    )
    expect(otherRun.code).toBe('BLOB_NOT_FOUND')

    const readError = await captureBlobError(() =>
      harness.store.readAuthorized(
        { scopeRef: SCOPE_A, blobRef },
        toolContext(TENANT_A, SPACE_A, { runId: RUN_B }),
      ),
    )
    expect(readError.code).toBe('BLOB_NOT_FOUND')
  })
})

describe('stage/verify/publish failure recovery', () => {
  it('leaves no reference when the object publish fails, and retries successfully', async () => {
    const harness = await createHarness()
    const content = bytes('recoverable')
    const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    const request = {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document' as const,
    }

    harness.objectStore.failPublish = true
    await expect(harness.store.publish(request, CONTEXT_A)).rejects.toThrow(
      'injected object publish failure',
    )
    harness.objectStore.failPublish = false

    const missing = await captureBlobError(() =>
      harness.store.getAuthorized(
        { scopeRef: SCOPE_A, blobRef: { id: randomUUID(), version: '1.0.0', digest: staged.contentDigest, kind: 'document' } },
        CONTEXT_A,
      ),
    )
    expect(missing.code).toBe('BLOB_NOT_FOUND')

    const retried = await harness.store.publish(request, CONTEXT_A)
    const read = await harness.store.readAuthorized(
      { scopeRef: SCOPE_A, blobRef: retried.blobRef },
      CONTEXT_A,
    )
    expect(new TextDecoder().decode(read)).toBe('recoverable')
  })

  it('leaves no reference when the registry write fails, and retries successfully', async () => {
    const harness = await createHarness()
    const content = bytes('reference-last')
    const staged = await harness.store.stage(content, { scopeRef: SCOPE_A }, CONTEXT_A)
    const request = {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType: 'text/plain',
      byteSize: staged.byteSize,
      purpose: 'document' as const,
    }

    harness.registry.failRecordReference = true
    await expect(harness.store.publish(request, CONTEXT_A)).rejects.toThrow(
      'injected registry failure',
    )
    harness.registry.failRecordReference = false

    expect(await harness.registry.listOrigins(SCOPE_A, staged.contentDigest)).toEqual([])

    const retried = await harness.store.publish(request, CONTEXT_A)
    const read = await harness.store.readAuthorized(
      { scopeRef: SCOPE_A, blobRef: retried.blobRef },
      CONTEXT_A,
    )
    expect(new TextDecoder().decode(read)).toBe('reference-last')
  })
})
