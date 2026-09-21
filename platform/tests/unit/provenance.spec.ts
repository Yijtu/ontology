import { describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPort,
  BlobPutImmutableResponse,
  ControlAppendEventRequest,
  ControlAppendEventResponse,
  ControlRepository,
  ProjectionState,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import {
  ArtifactProvenanceService,
  ProvenanceError,
  lineageKeyOf,
} from '@ontology/provenance'
import type { AuthorizedArtifactReader } from '@ontology/provenance'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const RESERVATION_ID = '44444444-4444-4444-8444-444444444444'
const DOC_VERSION = '55555555-5555-4555-8555-555555555555'
const ARTIFACT_ID = '66666666-6666-4666-8666-666666666666'
const DIGEST = `sha256:${'a'.repeat(64)}`
const QUOTE = `sha256:${'b'.repeat(64)}`
const CONTENT_DIGEST = `sha256:${'c'.repeat(64)}`

function toolContext(tenantId: string, spaceId: string): ToolContext {
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'unit-test',
      roles: ['platform-admin'],
      scopes: ['artifact:read'],
      authEpoch: 1,
    },
    runId: RUN_ID,
    resolvedProfileHash: DIGEST,
    policyVersion: '1.0.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: RESERVATION_ID,
      runId: RUN_ID,
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
    traceId: 'trace-provenance-unit',
  })
}

const CONTEXT_A = toolContext(TENANT_A, SPACE_A)
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }

const ARTIFACT_REF: ResourceRef = {
  id: ARTIFACT_ID,
  version: '1.0.0',
  digest: CONTENT_DIGEST,
  kind: 'document',
}
const DOCUMENT_VERSION_REF: ResourceRef = {
  id: DOC_VERSION,
  version: '1.0.0',
  digest: DIGEST,
  kind: 'document',
}

class FakeBlobPort implements BlobPort {
  readonly #digestById = new Map<string, string>()

  withArtifact(id: string, contentDigest: string): void {
    this.#digestById.set(id, contentDigest)
  }

  putImmutable(): Promise<BlobPutImmutableResponse> {
    throw new Error('putImmutable is not exercised by provenance unit tests')
  }

  getAuthorized(
    request: BlobGetAuthorizedRequest,
  ): Promise<BlobGetAuthorizedResponse> {
    const contentDigest = this.#digestById.get(request.blobRef.id)
    if (contentDigest === undefined) {
      return Promise.reject(new Error(`no authorized blob ${request.blobRef.id}`))
    }
    return Promise.resolve({
      blobRef: request.blobRef,
      contentDigest,
      mediaType: 'text/plain',
      byteSize: 12,
      integrityVerified: true,
    })
  }
}

class FakeControlRepository implements ControlRepository {
  readonly events: ControlAppendEventRequest[] = []
  readonly #seqByIdempotencyKey = new Map<string, string>()

  transaction(): Promise<void> {
    return Promise.resolve()
  }

  readProjection(): Promise<ProjectionState> {
    throw new Error('readProjection is not exercised by provenance unit tests')
  }

  appendEvent(
    request: ControlAppendEventRequest,
  ): Promise<ControlAppendEventResponse> {
    this.events.push(request)
    const existing = this.#seqByIdempotencyKey.get(request.idempotencyKey)
    if (existing !== undefined) {
      return Promise.resolve({ recordedSeq: existing, appended: false })
    }
    const recordedSeq = String(this.#seqByIdempotencyKey.size + 1)
    this.#seqByIdempotencyKey.set(request.idempotencyKey, recordedSeq)
    return Promise.resolve({ recordedSeq, appended: true })
  }
}

class FailingControlRepository extends FakeControlRepository {
  override appendEvent(): Promise<ControlAppendEventResponse> {
    return Promise.reject(new Error('control storage unavailable'))
  }
}

function readerFor(bytes: Uint8Array): AuthorizedArtifactReader {
  return {
    readAuthorized: () => Promise.resolve(bytes),
  }
}

function sourceLocation(overrides?: {
  readonly scopeRef?: ScopeRef
  readonly artifactRef?: ResourceRef
}): {
  scopeRef: ScopeRef
  artifactRef: ResourceRef
  documentVersionRef: ResourceRef
  page: number
  quoteDigest: string
} {
  return {
    scopeRef: overrides?.scopeRef ?? SCOPE_A,
    artifactRef: overrides?.artifactRef ?? ARTIFACT_REF,
    documentVersionRef: DOCUMENT_VERSION_REF,
    page: 3,
    quoteDigest: QUOTE,
  }
}

function createService(options?: {
  readonly blobs?: FakeBlobPort
  readonly reader?: AuthorizedArtifactReader
}): {
  service: ArtifactProvenanceService
  blobs: FakeBlobPort
  control: FakeControlRepository
} {
  const blobs = options?.blobs ?? new FakeBlobPort()
  blobs.withArtifact(ARTIFACT_ID, CONTENT_DIGEST)
  const control = new FakeControlRepository()
  const service = new ArtifactProvenanceService({
    blobs,
    control,
    ...(options?.reader === undefined ? {} : { reader: options.reader }),
    now: () => '2026-09-21T00:00:05Z',
  })
  return { service, blobs, control }
}

describe('source-location validation (D3.2)', () => {
  it('requires a page or a byte offset', async () => {
    const { service } = createService()
    await expect(
      service.recordSourceLocation(
        {
          scopeRef: SCOPE_A,
          artifactRef: ARTIFACT_REF,
          documentVersionRef: DOCUMENT_VERSION_REF,
          quoteDigest: QUOTE,
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE_LOCATION' })
  })

  it('rejects a non half-open offset and a malformed quote digest', async () => {
    const { service } = createService()
    await expect(
      service.recordSourceLocation(
        {
          ...sourceLocation(),
          offset: { start: 5, end: 5 },
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE_LOCATION' })

    await expect(
      service.recordSourceLocation({ ...sourceLocation(), quoteDigest: 'not-a-digest' }, CONTEXT_A),
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE_LOCATION' })
  })

  it('rejects a scope that differs from the trusted principal', async () => {
    const { service } = createService()
    await expect(
      service.recordSourceLocation(
        sourceLocation({ scopeRef: { tenantId: TENANT_B, spaceId: SPACE_B } }),
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })
})

describe('source location binds to an authorized artifact', () => {
  it('refuses an artifact the caller cannot read', async () => {
    const { service } = createService()
    await expect(
      service.recordSourceLocation(
        sourceLocation({ artifactRef: { ...ARTIFACT_REF, id: 'not-authorized' } }),
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_AUTHORIZED' })
  })

  it('records a locator with a content-derived lineage key', async () => {
    const { service, control } = createService()
    const record = await service.recordSourceLocation(sourceLocation(), CONTEXT_A)

    expect(record.lineageKey).toBe(lineageKeyOf(CONTENT_DIGEST))
    expect(record.recordedSeq).toBe('1')
    expect(record.approximateLocator).toBe(false)
    expect(record.sourceLocationRef.id).toHaveLength(36)
    expect(control.events).toHaveLength(1)
    expect(control.events[0]?.streamRef).toBe(`source-locations:${DOC_VERSION}`)
  })

  it('gives duplicate copies of one document the same lineage key', async () => {
    const blobs = new FakeBlobPort()
    blobs.withArtifact(ARTIFACT_ID, CONTENT_DIGEST)
    blobs.withArtifact('another-copy', CONTENT_DIGEST)
    const service = new ArtifactProvenanceService({
      blobs,
      control: new FakeControlRepository(),
    })
    const first = await service.recordSourceLocation(sourceLocation(), CONTEXT_A)
    const second = await service.recordSourceLocation(
      sourceLocation({ artifactRef: { ...ARTIFACT_REF, id: 'another-copy' } }),
      CONTEXT_A,
    )
    expect(first.lineageKey).toBe(second.lineageKey)
  })

  it('is idempotent for a repeated identical locator', async () => {
    const { service, control } = createService()
    const first = await service.recordSourceLocation(sourceLocation(), CONTEXT_A)
    const replay = await service.recordSourceLocation(sourceLocation(), CONTEXT_A)
    expect(replay.recordedSeq).toBe(first.recordedSeq)
    expect(replay.sourceLocationRef.id).toBe(first.sourceLocationRef.id)
    expect(control.events).toHaveLength(2)
  })

  it('keeps an approximate locator distinct from an exact one', async () => {
    const { service, control } = createService()
    await service.recordSourceLocation({ ...sourceLocation(), approximateLocator: false }, CONTEXT_A)
    await service.recordSourceLocation({ ...sourceLocation(), approximateLocator: true }, CONTEXT_A)
    expect(control.events).toHaveLength(2)
    expect(control.events[0]?.idempotencyKey).not.toBe(control.events[1]?.idempotencyKey)
  })

  it('maps a persistence failure to a typed provenance error', async () => {
    const blobs = new FakeBlobPort()
    blobs.withArtifact(ARTIFACT_ID, CONTENT_DIGEST)
    const service = new ArtifactProvenanceService({
      blobs,
      control: new FailingControlRepository(),
    })
    const error = await service
      .recordSourceLocation(sourceLocation(), CONTEXT_A)
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ProvenanceError)
    expect(error).toMatchObject({ code: 'PROVENANCE_PERSIST_FAILED' })
  })
})

describe('authorized artifact access', () => {
  it('reads bytes through the injected scoped reader', async () => {
    const { service } = createService({ reader: readerFor(new TextEncoder().encode('payload')) })
    const bytes = await service.readAuthorizedArtifact(ARTIFACT_REF, SCOPE_A, CONTEXT_A)
    expect(new TextDecoder().decode(bytes)).toBe('payload')
  })

  it('fails explicitly when no reader was injected', async () => {
    const { service } = createService()
    await expect(
      service.readAuthorizedArtifact(ARTIFACT_REF, SCOPE_A, CONTEXT_A),
    ).rejects.toMatchObject({ code: 'ARTIFACT_READER_NOT_CONFIGURED' })
  })
})
