import { sha256DigestOf } from '@ontology/core'
import type {
  DocumentParseRecord,
  DocumentParseStore,
  DocumentSpanReaderPort,
  DocumentSpan,
  ProjectDocumentFragment,
  ProjectDocumentIndexState,
  ProjectDocumentIndexStatus,
  ProjectDocumentMembership,
  ProjectDocumentSearchRequest,
  ProjectDocumentSearchResult,
  ProjectDocumentStore,
  ProjectIndexReceipt,
  ProjectReadinessStore,
  ProjectRevisionRef,
  ProjectStore,
  ReadSpanResponse,
  ResourceRef,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { projectCollectionRef, isToolContext, ProjectReadinessStoreError } from '@ontology/contracts'
import { Bm25IndexBuilder } from './builder'
import { DocumentSearchError } from './errors'
import { Bm25DocumentSearchService, DEFAULT_SEARCH_LIMIT } from './service'
import { trustedScope } from './scope'
import type { DocumentSearchDetail, KeywordIndexGeneration, KeywordIndexStore } from './types'

export const DEFAULT_MAX_FRAGMENTS = 10
export const DEFAULT_MAX_FRAGMENT_BYTES = 4_096
export const DEFAULT_MAX_CORPUS_DOCUMENTS = 1_000
const STATUS_DEFAULT_PAGE_LIMIT = 200
const STATUS_MAX_PAGE_LIMIT = 500
const SEARCH_CACHE_LIMIT = 64

export interface ProjectDocumentIndexDependencies {
  readonly store: ProjectDocumentStore
  readonly parseStore: DocumentParseStore
  readonly indexStore: KeywordIndexStore
  readonly spanReader: DocumentSpanReaderPort
  /** Optional: when both are supplied the build records `document_index` readiness. */
  readonly projects?: ProjectStore
  readonly readiness?: ProjectReadinessStore
  readonly maxFragments?: number
  readonly maxFragmentBytes?: number
  readonly maxCorpusDocuments?: number
  readonly now?: () => string
}

interface CurrentCorpus {
  readonly memberships: readonly ProjectDocumentMembership[]
  readonly parses: readonly DocumentParseRecord[]
  readonly truncated: boolean
}

interface CorpusView {
  readonly byDigest: ReadonlyMap<string, ProjectDocumentMembership>
}

interface CachedSearch {
  readonly result: ProjectDocumentSearchResult
}

function cacheKey(
  scope: ScopeRef,
  projectId: Uuid,
  receipt: ProjectIndexReceipt,
  query: string,
  limit: number,
): string {
  return [
    scope.tenantId,
    scope.spaceId,
    projectId,
    receipt.targetDigest,
    receipt.generation,
    receipt.visibilityEpoch,
    query,
    String(limit),
  ].join('\u0000')
}

/**
 * The project-document BM25 index (SPEC v0.3a asset-data-ui §7, issue V03-019 / #191).
 *
 * It composes the real BM25 builder, the versioned keyword index store and the
 * LOCAL-023 span reader around a fixed, project-scoped document corpus:
 *
 *  * `importDocument` / `reviseDocument` move a document into or out of the active
 *    corpus and bump the project visibility epoch, so any in-flight reader sees
 *    the change at its next epoch check.
 *  * `buildIndex` freezes the active corpus, builds one immutable generation over
 *    `collectionRef = project:<projectId>`, and CAS-activates it: a build that
 *    finished after a retraction is refused and never resurrects a withdrawn
 *    span. Readiness is only recorded `ready` for the verified target digest.
 *  * `search` binds to one active generation, returns real fragments of *this*
 *    project with a fixed revision/span and bounded coverage, and re-checks the
 *    epoch before returning so a retraction during the query cannot leak a
 *    withdrawn fragment.
 *
 * No cross-scope state is retained: the result cache key includes the
 * tenant/space scope, project, corpus digest, generation and visibility epoch, so
 * a different project, an updated corpus or a retraction is always a cache miss.
 */
export class ProjectDocumentIndexService {
  readonly #store: ProjectDocumentStore
  readonly #parseStore: DocumentParseStore
  readonly #indexStore: KeywordIndexStore
  readonly #builder: Bm25IndexBuilder
  readonly #search: Bm25DocumentSearchService
  readonly #spanReader: DocumentSpanReaderPort
  readonly #projects: ProjectStore | undefined
  readonly #readiness: ProjectReadinessStore | undefined
  readonly #maxFragments: number
  readonly #maxFragmentBytes: number
  readonly #maxCorpusDocuments: number
  readonly #now: () => string
  readonly #cache = new Map<string, CachedSearch>()

  constructor(dependencies: ProjectDocumentIndexDependencies) {
    this.#store = dependencies.store
    this.#parseStore = dependencies.parseStore
    this.#indexStore = dependencies.indexStore
    this.#spanReader = dependencies.spanReader
    this.#builder = new Bm25IndexBuilder({
      parseStore: dependencies.parseStore,
      indexStore: dependencies.indexStore,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    })
    this.#search = new Bm25DocumentSearchService({
      indexStore: dependencies.indexStore,
      spanReader: dependencies.spanReader,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    })
    this.#projects = dependencies.projects
    this.#readiness = dependencies.readiness
    this.#maxFragments = dependencies.maxFragments ?? DEFAULT_MAX_FRAGMENTS
    this.#maxFragmentBytes = dependencies.maxFragmentBytes ?? DEFAULT_MAX_FRAGMENT_BYTES
    this.#maxCorpusDocuments = dependencies.maxCorpusDocuments ?? DEFAULT_MAX_CORPUS_DOCUMENTS
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /** Add one authorised document to the project corpus, marking the index pending. */
  async importDocument(
    projectId: Uuid,
    input: Parameters<ProjectDocumentStore['registerDocument']>[2],
    ctx: ToolContext,
  ): Promise<ProjectDocumentIndexStatus> {
    trustScope(ctx)
    const scope = trustedScope(ctx)
    await this.#validateSource(input, ctx)
    await this.#store.registerDocument(scope, projectId, input, ctx)
    return this.getStatus(projectId, ctx)
  }

  /** Retract or replace a document; index visibility follows the new epoch. */
  async reviseDocument(
    projectId: Uuid,
    input: Parameters<ProjectDocumentStore['reviseDocument']>[2],
    ctx: ToolContext,
  ): Promise<ProjectDocumentIndexStatus> {
    trustScope(ctx)
    const scope = trustedScope(ctx)
    if (input.replacement !== undefined) await this.#validateSource(input.replacement, ctx)
    await this.#store.reviseDocument(scope, projectId, input, ctx)
    return this.getStatus(projectId, ctx)
  }

  /**
   * Build and CAS-activate one immutable generation over the frozen active corpus.
   * A build whose epoch moved before activation is reported `stale` and never
   * becomes the active index.
   */
  async buildIndex(projectId: Uuid, ctx: ToolContext, options: { readonly signal?: AbortSignal } = {}): Promise<ProjectDocumentIndexStatus> {
    trustScope(ctx)
    options.signal?.throwIfAborted()
    const scope = trustedScope(ctx)
    const collectionRef = projectCollectionRef(projectId)
    const visibility = await this.#store.getVisibility(scope, projectId, ctx)
    const epoch = visibility?.epoch ?? '0'
    const membershipRevision = visibility?.membershipRevision ?? '0'

    const corpus = await this.#currentCorpus(scope, projectId, ctx)
    const built = await this.#builder.build({ collectionRef, parses: corpus.parses }, ctx)
    options.signal?.throwIfAborted()
    const recordedAt = this.#now()
    const receiptWrite = await this.#store.recordIndexReceipt(
      scope,
      projectId,
      {
        collectionRef,
        generation: built.generation.generation,
        visibilityEpoch: epoch,
        membershipRevision,
        targetDigest: built.generation.indexDigest,
        indexRef: built.generation.indexRef,
        documentCount: built.generation.docCount,
        sourceDocumentCount: corpus.memberships.length,
        completeness: corpus.truncated ? 'truncated' : built.generation.completeness,
        recordedAt,
      },
      ctx,
    )
    if (!receiptWrite.activated) {
      // The corpus moved while the build ran; re-read the current status instead
      // of reporting the epoch the doomed build carried.
      return this.getStatus(projectId, ctx)
    }
    options.signal?.throwIfAborted()
    await this.#builder.activate(collectionRef, built.generation.generation, ctx)
    options.signal?.throwIfAborted()
    await this.#recordReadiness(projectId, receiptWrite.receipt, ctx)
    options.signal?.throwIfAborted()
    this.#cache.clear()
    const status = await this.getStatus(projectId, ctx)
    options.signal?.throwIfAborted()
    return status
  }

  async getStatus(projectId: Uuid, ctx: ToolContext): Promise<ProjectDocumentIndexStatus> {
    trustScope(ctx)
    const scope = trustedScope(ctx)
    const collectionRef = projectCollectionRef(projectId)
    const visibility = await this.#store.getVisibility(scope, projectId, ctx)
    const epoch = visibility?.epoch ?? '0'
    const membershipRevision = visibility?.membershipRevision ?? '0'
    const active = await this.#indexStore.getActiveGeneration(scope, collectionRef, ctx)
    if (active === undefined) {
      return this.#statusFrom(projectId, collectionRef, epoch, membershipRevision, undefined, undefined)
    }
    const receipt = await this.#store.getIndexReceipt(scope, projectId, active.generation, ctx)
    const current = await this.#store.getVisibility(scope, projectId, ctx)
    return this.#statusFrom(projectId, collectionRef, current?.epoch ?? epoch, current?.membershipRevision ?? membershipRevision, active, receipt)
  }

  /** Search the project's active index, returning real fragments with fixed revisions. */
  async search(
    request: ProjectDocumentSearchRequest,
    ctx: ToolContext,
  ): Promise<ProjectDocumentSearchResult> {
    trustScope(ctx)
    const scope = trustedScope(ctx)
    const projectId = request.projectId
    const collectionRef = projectCollectionRef(projectId)
    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_SEARCH_LIMIT, this.#maxFragments))

    const visibility = await this.#store.getVisibility(scope, projectId, ctx)
    const epoch = visibility?.epoch ?? '0'
    const active = await this.#indexStore.getActiveGeneration(scope, collectionRef, ctx)
    const receipt = active === undefined
      ? undefined
      : await this.#store.getIndexReceipt(scope, projectId, active.generation, ctx)

    if (active === undefined || receipt === undefined || receipt.visibilityEpoch !== epoch) {
      const state: ProjectDocumentIndexState = receipt !== undefined && receipt.visibilityEpoch !== epoch ? 'stale' : 'pending'
      return emptyResult(
        projectId,
        collectionRef,
        request.query,
        epoch,
        state,
        active?.generation,
        receipt?.visibilityEpoch,
        this.#maxFragments,
        this.#maxFragmentBytes,
      )
    }

    const key = cacheKey(scope, projectId, receipt, request.query, limit)
    const cached = this.#cache.get(key)
    if (cached !== undefined) {
      const current = await this.#store.getVisibility(scope, projectId, ctx)
      if (current?.epoch === epoch) return cached.result
      return emptyResult(projectId, collectionRef, request.query, current?.epoch ?? '0', 'stale', active.generation, receipt.visibilityEpoch, this.#maxFragments, this.#maxFragmentBytes)
    }

    let detail: DocumentSearchDetail
    try {
      detail = await this.#search.searchDetailed(
        {
          query: request.query,
          allowedCollectionRefs: [collectionRef],
          mode: 'keyword',
          limit,
        },
        ctx,
      )
    } catch (error) {
      if (error instanceof DocumentSearchError && (error.code === 'INDEX_NOT_FOUND' || error.code === 'SNAPSHOT_UNAVAILABLE')) {
        // The active generation was removed between the status read and the
        // search; report the index as not-ready instead of failing the caller.
        return emptyResult(
          projectId,
          collectionRef,
          request.query,
          epoch,
          'pending',
          active.generation,
          receipt.visibilityEpoch,
          this.#maxFragments,
          this.#maxFragmentBytes,
        )
      }
      throw error
    }

    const corpus = await this.#corpusView(scope, projectId, ctx)
    const bounded = detail.response.spans.slice(0, this.#maxFragments)
    const fragments: ProjectDocumentFragment[] = []
    for (const span of bounded) {
      const fragment = await this.#toFragment(span, corpus, request.maxBytesPerFragment, ctx)
      if (fragment !== undefined) fragments.push(fragment)
    }

    // Re-check the epoch before returning: a retraction during the query must not
    // surface a fragment that is no longer active in the current corpus. The
    // fragments are retained as explicit historical reads and marked, but the
    // result state is no longer `ready`.
    const current = await this.#store.getVisibility(scope, projectId, ctx)
    const currentEpoch = current?.epoch ?? '0'
    const historical = currentEpoch !== epoch
    const servedFragments = historical ? [] : fragments

    const returned = servedFragments.length
    const result: ProjectDocumentSearchResult = {
      projectId,
      collectionRef,
      query: request.query,
      fragments: servedFragments,
      state: historical ? 'stale' : 'ready',
      matchedTotal: detail.matchedTotal,
      coverage: {
        returned,
        knownTotal: detail.matchedTotal,
        truncated: detail.truncated || returned < detail.matchedTotal,
        completeness: historical
          ? 'partial'
          : returned < detail.matchedTotal
            ? 'truncated'
            : detail.response.completeness,
        maxFragments: this.#maxFragments,
        maxBytesPerFragment: this.#maxFragmentBytes,
      },
      indexEpoch: receipt.visibilityEpoch,
      visibilityEpoch: currentEpoch,
      generation: active.generation,
      scoreKind: detail.response.scoreKind === 'bm25' ? 'bm25' : 'none',
      historical,
    }
    this.#cacheSet(key, { result })
    return result
  }

  async #toFragment(
    span: DocumentSpan,
    corpus: CorpusView,
    maxBytesOverride: number | undefined,
    ctx: ToolContext,
  ): Promise<ProjectDocumentFragment | undefined> {
    const membership = corpus.byDigest.get(span.documentRef.digest)
    const maxBytes = Math.max(1, maxBytesOverride ?? this.#maxFragmentBytes)
    // A span that cannot be re-read is a real failure and propagates: silently
    // dropping it would hide a broken locator behind an apparently short page.
    const read = await this.#spanReader.readSpan(
      { documentRef: span.documentRef, locator: span.locator, maxBytes },
      ctx,
    )
    const parseRef = membership?.parseRef ?? fallbackParseRef(span, read)
    const revision = membership?.membershipRevision ?? '0'
    return {
      documentId: membership?.documentId ?? parseRef.id,
      documentRef: span.documentRef,
      parseRef,
      locator: span.locator,
      text: read.text,
      textDigest: read.textDigest,
      quoteDigest: span.quoteDigest,
      spanKind: span.spanKind,
      precision: membership?.precision ?? 'approximate',
      revision,
      score: span.score ?? 0,
      duplicateCount: 0,
      historical: membership !== undefined && membership.state !== 'active',
    }
  }

  async #currentCorpus(
    scope: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<CurrentCorpus> {
    const memberships: ProjectDocumentMembership[] = []
    let cursor: string | undefined
    let truncated = false
    for (;;) {
      const page = await this.#store.listDocuments(
        scope,
        projectId,
        { state: 'active', limit: STATUS_DEFAULT_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
        ctx,
      )
      for (const membership of page.memberships) {
        if (memberships.length >= this.#maxCorpusDocuments) {
          truncated = true
          break
        }
        memberships.push(membership)
      }
      if (truncated || page.nextCursor === null) break
      cursor = page.nextCursor
    }
    const parses: DocumentParseRecord[] = []
    let parseMissing = false
    for (const membership of memberships) {
      const parse = await this.#parseStore.getParse(scope, membership.parseId, ctx)
      if (parse === undefined) {
        parseMissing = true
        continue
      }
      parses.push(parse)
    }
    return { memberships, parses, truncated: truncated || parseMissing }
  }

  async #validateSource(input: Pick<ProjectDocumentMembership, 'documentRef' | 'documentDigest' | 'parseId' | 'parseRef' | 'textDigest' | 'precision'>, ctx: ToolContext): Promise<void> {
    const parse = await this.#parseStore.getParse(trustedScope(ctx), input.parseId, ctx)
    const sameRef = (left: ResourceRef, right: ResourceRef) => left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
    if (parse === undefined || !sameRef(parse.originalRef, input.documentRef) || input.documentDigest !== parse.originalRef.digest || !sameRef(parse.spanMapRef, input.parseRef)
      || (input.textDigest !== parse.normalizedRef.digest && input.textDigest !== parse.spanMapRef.digest)) throw new DocumentSearchError('INVALID_ARGUMENT', 'the membership must pin an actual authorized document parse and its original/projection artifacts')
    if (input.precision === 'exact' && (await this.#parseStore.listChunks(trustedScope(ctx), input.parseId, ctx)).some((chunk) => chunk.precision === 'approximate')) throw new DocumentSearchError('INVALID_ARGUMENT', 'approximate source chunks cannot be registered as exact')
  }

  async #corpusView(
    scope: ScopeRef,
    projectId: Uuid,
    ctx: ToolContext,
  ): Promise<CorpusView> {
    const byDigest = new Map<string, ProjectDocumentMembership>()
    let cursor: string | undefined
    for (;;) {
      const page = await this.#store.listDocuments(
        scope,
        projectId,
        { limit: STATUS_MAX_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
        ctx,
      )
      for (const membership of page.memberships) {
        const existing = byDigest.get(membership.documentRef.digest)
        if (membership.state === 'active' || existing === undefined) {
          // An active row wins over a withdrawn one sharing the same digest; a
          // withdrawn row is kept so a historical fragment is still marked.
          byDigest.set(membership.documentRef.digest, membership)
        }
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    return { byDigest }
  }

  #statusFrom(
    projectId: Uuid,
    collectionRef: string,
    epoch: RevisionString,
    membershipRevision: RevisionString,
    active: KeywordIndexGeneration | undefined,
    receipt: ProjectIndexReceipt | undefined,
  ): ProjectDocumentIndexStatus {
    if (active === undefined || receipt === undefined) {
      return {
        projectId,
        collectionRef,
        state: 'pending',
        visibilityEpoch: epoch,
        membershipRevision,
        documentCount: 0,
        sourceDocumentCount: 0,
        completeness: 'unknown',
        reason: 'the project document index has not been built yet',
        retryable: true,
      }
    }
    if (receipt.visibilityEpoch !== epoch) {
      return {
        projectId,
        collectionRef,
        state: 'stale',
        visibilityEpoch: epoch,
        membershipRevision,
        indexEpoch: receipt.visibilityEpoch,
        generation: active.generation,
        indexRef: active.indexRef,
        documentCount: receipt.documentCount,
        sourceDocumentCount: receipt.sourceDocumentCount,
        completeness: 'partial',
        reason: 'the corpus changed after this index was built; rebuild before searching',
        retryable: true,
      }
    }
    return {
      projectId,
      collectionRef,
      state: 'ready',
      visibilityEpoch: epoch,
      membershipRevision,
      indexEpoch: receipt.visibilityEpoch,
      generation: active.generation,
      indexRef: active.indexRef,
      documentCount: receipt.documentCount,
      sourceDocumentCount: receipt.sourceDocumentCount,
      completeness: receipt.completeness,
      retryable: false,
    }
  }

  #cacheSet(key: string, value: CachedSearch): void {
    if (this.#cache.size >= SEARCH_CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value
      if (oldest !== undefined) this.#cache.delete(oldest)
    }
    this.#cache.set(key, value)
  }

  async #recordReadiness(
    projectId: Uuid,
    receipt: ProjectIndexReceipt,
    ctx: ToolContext,
  ): Promise<void> {
    if (this.#projects === undefined || this.#readiness === undefined) return
    const scope = trustedScope(ctx)
    const project = await this.#projects.getProject(scope, projectId, ctx)
    if (project === undefined) return
    const revision = await this.#projects.getRevision(scope, projectId, project.activeRevision ?? project.headRevision, ctx)
    if (revision === undefined) return
    const projectRevisionRef: ProjectRevisionRef = revision.ref
    try {
      await this.#readiness.upsertProjection(
        scope,
        {
          projectRevisionRef,
          kind: 'document_index',
          targetRef: receipt.indexRef,
          state: 'ready',
          completeness: receipt.completeness,
          expectedCount: receipt.sourceDocumentCount,
          processedCount: receipt.sourceDocumentCount,
          failedCount: 0,
          targetDigest: receipt.targetDigest,
          fenceRevision: receipt.visibilityEpoch,
          idempotencyKey: `document-index:${projectId}:${receipt.generation}`,
          requestDigest: sha256DigestOf(
            JSON.stringify({
              projectRevisionRef,
              generation: receipt.generation,
              targetDigest: receipt.targetDigest,
            }),
          ),
          actor: 'project-document-index',
          recordedAt: this.#now(),
        },
        ctx,
      )
    } catch (error) {
      // Readiness is an advisory projection: a fence refusal (a newer revision
      // already exists) leaves the receipt visibility gate authoritative. Other
      // failures stay explicit and retryable rather than masquerading as success.
      if (!(error instanceof ProjectReadinessStoreError && error.code === 'FENCE_STALE')) throw error
    }
  }
}

function emptyResult(
  projectId: Uuid,
  collectionRef: string,
  query: string,
  epoch: RevisionString,
  state: ProjectDocumentIndexState,
  generation: RevisionString | undefined,
  indexEpoch: RevisionString | undefined,
  maxFragments: number,
  maxFragmentBytes: number,
): ProjectDocumentSearchResult {
  return {
    projectId,
    collectionRef,
    query,
    fragments: [],
    state,
    matchedTotal: 0,
    coverage: {
      returned: 0,
      knownTotal: 0,
      truncated: false,
      completeness: 'unknown',
      maxFragments,
      maxBytesPerFragment: maxFragmentBytes,
    },
    ...(indexEpoch === undefined ? {} : { indexEpoch }),
    visibilityEpoch: epoch,
    ...(generation === undefined ? {} : { generation }),
    scoreKind: 'none',
    historical: false,
  }
}

function fallbackParseRef(span: DocumentSpan, read: ReadSpanResponse): ResourceRef {
  return {
    id: span.documentRef.id,
    version: span.documentRef.version,
    digest: read.textDigest,
    kind: 'artifact',
  }
}

function trustScope(ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new DocumentSearchError('FORBIDDEN', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new DocumentSearchError('FORBIDDEN', 'trusted context carries inconsistent tenant scope')
  }
}
