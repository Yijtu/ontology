import { createHash, randomUUID } from 'node:crypto'
import { createToolContext, isToolContext } from '@ontology/contracts'
import type {
  BlobGetAuthorizedRequest,
  BlobGetAuthorizedResponse,
  BlobPutImmutableResponse,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
} from '@ontology/contracts'
import type {
  DocumentArtifactPublishRequest,
  DocumentArtifactStageRequest,
  DocumentArtifactStageResult,
  DocumentArtifactStore,
  OcrPageInput,
  OcrPageResult,
  OcrTextProvider,
} from '@ontology/adapter-extraction-document'

const DIGEST = `sha256:${'a'.repeat(64)}`
const RESERVATION_ID = '55555555-5555-4555-8555-555555555555'

export function createTestToolContext(
  tenantId: string,
  spaceId: string,
  runId = '33333333-3333-4333-8333-333333333333',
): ToolContext {
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'document-parser-test',
      roles: ['platform-admin'],
      scopes: ['document:read', 'document:write'],
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
    traceId: 'trace-document-parser-test',
  })
}

export function sha256Of(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

interface StoredReference {
  readonly scope: ScopeRef
  readonly blobRef: ResourceRef
  readonly mediaType: string
  readonly byteSize: number
  readonly purpose: string
  readonly origin: Readonly<Record<string, unknown>>
}

function scopeKey(scope: ScopeRef): string {
  return `${scope.tenantId}|${scope.spaceId}`
}

/**
 * Structural stand-in for `LocalImmutableBlobStore` in unit tests. It keeps the
 * scope, content-addressing and duplicate-lineage rules so a unit test cannot
 * pass where the real store would refuse.
 */
export class InMemoryArtifactStore implements DocumentArtifactStore {
  readonly #staged = new Map<string, Uint8Array>()
  readonly #objects = new Map<string, Uint8Array>()
  readonly #references = new Map<string, StoredReference>()
  /** One lineage id per (scope, digest); duplicates reuse it. */
  readonly #lineage = new Map<string, string>()

  async stage(
    content: Uint8Array,
    request: DocumentArtifactStageRequest,
    ctx: ToolContext,
  ): Promise<DocumentArtifactStageResult> {
    const scope = this.#trustedScope(request.scopeRef, ctx)
    const digest = sha256Of(content)
    this.#staged.set(`${scopeKey(scope)}|${digest}`, new Uint8Array(content))
    return { contentDigest: digest, byteSize: content.byteLength }
  }

  async publish(
    request: DocumentArtifactPublishRequest,
    ctx: ToolContext,
  ): Promise<BlobPutImmutableResponse> {
    const trusted = this.#trustedScope(request.scopeRef, ctx)
    const stagedKey = `${scopeKey(trusted)}|${request.contentDigest}`
    const staged = this.#staged.get(stagedKey)
    if (staged === undefined) {
      throw new Error(`nothing staged for ${request.contentDigest}`)
    }
    if (sha256Of(staged) !== request.contentDigest) {
      throw new Error('staged content does not match the declared digest')
    }
    const objectKey = `${scopeKey(trusted)}|${request.contentDigest}`
    const deduplicated = this.#objects.has(objectKey)
    this.#objects.set(objectKey, staged)
    this.#staged.delete(stagedKey)
    const blobRef: ResourceRef = {
      id: randomUUID(),
      version: '1.0.0',
      digest: request.contentDigest,
      kind: request.purpose === 'document' ? 'document' : 'artifact',
    }
    this.#references.set(blobRef.id, {
      scope: trusted,
      blobRef,
      mediaType: request.mediaType,
      byteSize: request.byteSize,
      purpose: request.purpose,
      origin: request.origin ?? {},
    })
    if (!this.#lineage.has(objectKey)) {
      this.#lineage.set(objectKey, randomUUID())
    }
    return {
      blobRef,
      contentDigest: request.contentDigest,
      integrity: { algorithm: 'sha256', digest: request.contentDigest },
      deduplicated,
    }
  }

  async getAuthorized(
    request: BlobGetAuthorizedRequest,
    ctx: ToolContext,
  ): Promise<BlobGetAuthorizedResponse> {
    const reference = this.#authorize(request, ctx)
    return {
      blobRef: reference.blobRef,
      contentDigest: reference.blobRef.digest,
      mediaType: reference.mediaType,
      byteSize: reference.byteSize,
      integrityVerified: true,
    }
  }

  async readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array> {
    const reference = this.#authorize(request, ctx)
    const object = this.#objects.get(
      `${scopeKey(reference.scope)}|${reference.blobRef.digest}`,
    )
    if (object === undefined) {
      throw new Error(`object ${reference.blobRef.digest} is missing`)
    }
    return new Uint8Array(object)
  }

  lineageOf(scope: ScopeRef, digest: Sha256Digest): string | undefined {
    return this.#lineage.get(`${scopeKey(scope)}|${digest}`)
  }

  referencesFor(scope: ScopeRef, digest: Sha256Digest): StoredReference[] {
    return [...this.#references.values()].filter(
      (reference) =>
        scopeKey(reference.scope) === scopeKey(scope) && reference.blobRef.digest === digest,
    )
  }

  #trustedScope(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
    if (!isToolContext(ctx)) {
      throw new Error('a host-minted trusted tool context is required')
    }
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new Error('request scope does not match the trusted principal scope')
    }
    return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
  }

  #authorize(request: BlobGetAuthorizedRequest, ctx: ToolContext): StoredReference {
    const scope: ScopeRef = {
      tenantId: ctx.principal.tenantId,
      spaceId: ctx.allowedResources.spaceId,
    }
    const reference = this.#references.get(request.blobRef.id)
    if (
      reference === undefined ||
      scopeKey(reference.scope) !== scopeKey(scope) ||
      reference.blobRef.digest !== request.blobRef.digest
    ) {
      throw new Error(`no authorized blob ${request.blobRef.id} in this scope`)
    }
    return reference
  }
}

/** Deterministic OCR double. It simulates the OCR path; it is not an OCR engine. */
export class ScriptedOcrProvider implements OcrTextProvider {
  readonly #pages: ReadonlyMap<number, string>

  constructor(pages: ReadonlyMap<number, string>) {
    this.#pages = pages
  }

  async recognize(input: OcrPageInput): Promise<OcrPageResult> {
    const text = this.#pages.get(input.page)
    if (text === undefined) {
      throw new Error(`no scripted OCR text for page ${input.page}`)
    }
    return { text, approximate: true, providerId: 'scripted-test-ocr' }
  }
}
