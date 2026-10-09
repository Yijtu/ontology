import { sha256DigestOf } from '@ontology/core'
import type {
  CompletenessStatus,
  DocumentSearchRequest,
  DocumentSearchResponse,
  DocumentSpan,
  DocumentSpanReaderPort,
  IndexVersion,
  ReadSpanRequest,
  ReadSpanResponse,
  SearchFilters,
  SourceSnapshot,
  ToolContext,
} from '@ontology/contracts'
import { bm25Idf, bm25TermScore, tokenize } from './bm25'
import { decodeCursor, encodeCursor } from './cursor'
import { DocumentSearchError } from './errors'
import { trustedScope } from './scope'
import type {
  DocumentSearchDetail,
  IndexedDocument,
  KeywordIndexGeneration,
  KeywordIndexStore,
} from './types'

export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 1000
export const DEFAULT_MAX_CANDIDATES = 5000
export const KEYWORD_INDEX_NAMESPACE = 'ontology.keyword_index'
export const KEYWORD_INDEX_SCHEMA_VERSION = '1.0.0'
export const INDEX_REF_VERSION = '1.0.0'

export interface Bm25DocumentSearchDependencies {
  readonly indexStore: KeywordIndexStore
  /**
   * The LOCAL-023 span reader. The search backend composes the existing reader
   * instead of re-parsing, so `readSpan` returns the same byte-exact text the
   * parser produced (SPEC D3.2).
   */
  readonly spanReader: DocumentSpanReaderPort
  /** Bounded candidate set per collection; exceeding it is reported as partial. */
  readonly maxCandidates?: number
  readonly now?: () => string
}

interface ResolvedCollection {
  readonly collectionRef: string
  readonly generation: KeywordIndexGeneration
}

interface ScoredDocument {
  readonly document: IndexedDocument
  readonly score: number
}

function passesFilters(document: IndexedDocument, filters: SearchFilters | undefined): boolean {
  if (filters === undefined) return true
  if (filters.sourceRefs !== undefined && filters.sourceRefs.length > 0) {
    const source = document.sourceRef
    if (source === undefined) return false
    const allowed = filters.sourceRefs.some(
      (candidate) => candidate.namespace === source.namespace && candidate.sourceId === source.sourceId,
    )
    if (!allowed) return false
  }
  if (filters.mediaTypes !== undefined && filters.mediaTypes.length > 0) {
    if (!filters.mediaTypes.includes(document.mediaType)) return false
  }
  if (filters.recordedAfter !== undefined) {
    if (Date.parse(document.recordedAt) < Date.parse(filters.recordedAfter)) return false
  }
  if (filters.recordedBefore !== undefined) {
    if (Date.parse(document.recordedAt) > Date.parse(filters.recordedBefore)) return false
  }
  return true
}

function worstCompleteness(statuses: readonly CompletenessStatus[]): CompletenessStatus {
  if (statuses.includes('unknown')) return 'unknown'
  if (statuses.includes('partial')) return 'partial'
  if (statuses.includes('truncated')) return 'truncated'
  return 'complete'
}

function toSpan(entry: ScoredDocument): DocumentSpan {
  return {
    documentRef: entry.document.documentRef,
    locator: entry.document.locator,
    quoteDigest: entry.document.quoteDigest,
    spanKind: entry.document.spanKind,
    score: entry.score,
  }
}

/**
 * The first real `DocumentSearchPort` (SPEC C3/C4, ADR-07).
 *
 * Only the `keyword` mode is registered: a `vector` or `hybrid` request is
 * refused with `UNSUPPORTED_QUERY` and never silently degraded to BM25, because
 * reporting a vector backend that does not exist would be a false capability
 * claim. A query is bound to one immutable index generation per authorized
 * collection; the response states that generation and the cursor pins it, so a
 * rebuild can never change the results of an in-flight pagination.
 */
export class Bm25DocumentSearchService {
  readonly #store: KeywordIndexStore
  readonly #spanReader: DocumentSpanReaderPort
  readonly #maxCandidates: number
  readonly #now: () => string

  constructor(dependencies: Bm25DocumentSearchDependencies) {
    this.#store = dependencies.indexStore
    this.#spanReader = dependencies.spanReader
    this.#maxCandidates = dependencies.maxCandidates ?? DEFAULT_MAX_CANDIDATES
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /** `DocumentSearchPort.search` — the canonical response shape. */
  async search(request: DocumentSearchRequest, ctx: ToolContext): Promise<DocumentSearchResponse> {
    return (await this.searchDetailed(request, ctx)).response
  }

  /**
   * Adapter-level search that also reports the recall-range statistics the tool
   * handler needs for an honest `ToolCoverage` (`matchedTotal`, `truncated`,
   * `duplicatesCollapsed`). The public port response carries none of these.
   */
  async searchDetailed(
    request: DocumentSearchRequest,
    ctx: ToolContext,
    /** Constructor/host-selected immutable generations; never part of tool arguments. */
    fixedCollections?: readonly { readonly collectionRef: string; readonly generation: string }[],
  ): Promise<DocumentSearchDetail> {
    const scope = trustedScope(ctx)
    assertKeywordMode(request)
    assertSupportedFilters(request.filters)
    if (request.query.trim().length === 0) {
      throw new DocumentSearchError('INVALID_ARGUMENT', 'query must be a non-empty string')
    }
    if (request.allowedCollectionRefs.length === 0) {
      throw new DocumentSearchError('INVALID_ARGUMENT', 'at least one authorized collection is required')
    }
    const collections = [...new Set(request.allowedCollectionRefs)]
    const queryDigest = sha256DigestOf(
      JSON.stringify({
        query: request.query,
        collections,
        mode: request.mode,
        filters: request.filters ?? null,
      }),
    )
    const terms = [...new Set(tokenize(request.query))]

    const resolved = fixedCollections === undefined
      ? await this.#resolveCollections(scope, collections, request, queryDigest, ctx)
      : await Promise.all(fixedCollections.map(async (pin) => {
          if (request.cursor !== undefined || fixedCollections.length !== collections.length || new Set(fixedCollections.map((entry) => entry.collectionRef)).size !== collections.length || !collections.includes(pin.collectionRef)) throw new DocumentSearchError('INVALID_ARGUMENT', 'the fixed collection pins differ from the authorized request')
          const generation = await this.#store.getGeneration(scope, pin.collectionRef, pin.generation, ctx)
          if (generation === undefined) throw new DocumentSearchError('SNAPSHOT_UNAVAILABLE', 'the fixed index generation is unavailable')
          return { collectionRef: pin.collectionRef, generation }
        }))

    const scored: ScoredDocument[] = []
    const completenesses: CompletenessStatus[] = []
    let indexDocumentCount = 0
    let candidateTruncated = false

    for (const entry of resolved) {
      indexDocumentCount += entry.generation.docCount
      completenesses.push(entry.generation.completeness)
      if (terms.length === 0) continue
      const page = await this.#store.listMatchingDocuments(
        scope,
        entry.collectionRef,
        entry.generation.generation,
        terms,
        this.#maxCandidates,
        ctx,
      )
      if (page.truncated) candidateTruncated = true
      const documents = page.documents
      // Document frequency is corpus statistics over the recall range: every
      // document containing a query term is in this candidate set.
      const documentFrequency = new Map<string, number>()
      for (const term of terms) {
        let count = 0
        for (const document of documents) if (document.termFrequencies.has(term)) count += 1
        documentFrequency.set(term, count)
      }
      for (const document of documents) {
        if (!passesFilters(document, request.filters)) continue
        let score = 0
        for (const term of terms) {
          const frequency = document.termFrequencies.get(term) ?? 0
          const idf = bm25Idf(entry.generation.docCount, documentFrequency.get(term) ?? 0)
          score += bm25TermScore(frequency, document.length, entry.generation.avgDocLength, idf)
        }
        if (score > 0) scored.push({ document, score })
      }
    }

    // Collapse copies of the same located quote, while retaining distinct rows or
    // clauses from one original. A repeated file is not independent evidence.
    const best = new Map<string, ScoredDocument>()
    for (const entry of scored) {
      const locator = entry.document.locator
      const key = JSON.stringify([entry.document.documentDigest, entry.document.quoteDigest, locator.kind, locator.page ?? null, locator.startOffset ?? null, locator.endOffset ?? null])
      const existing = best.get(key)
      if (existing === undefined || entry.score > existing.score) {
        best.set(key, entry)
      }
    }
    const duplicatesCollapsed = scored.length - best.size
    const ranked = [...best.values()].sort((left, right) => {
      if (left.score !== right.score) return right.score - left.score
      if (left.document.documentDigest !== right.document.documentDigest) {
        return left.document.documentDigest < right.document.documentDigest ? -1 : 1
      }
      return left.document.chunkId < right.document.chunkId ? -1 : 1
    })

    const limit = Math.max(1, Math.min(request.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT))
    const offset = request.cursor === undefined ? 0 : decodeCursor(request.cursor).offset
    const page = ranked.slice(offset, offset + limit)
    const more = offset + page.length < ranked.length
    const truncated = more || candidateTruncated
    const completeness: CompletenessStatus = candidateTruncated
      ? 'partial'
      : more
        ? 'truncated'
        : worstCompleteness(completenesses)

    const indexVersion = buildIndexVersion(resolved, this.#now())
    const spans = page.map(toSpan)
    const response: DocumentSearchResponse = {
      spans,
      scoreKind: terms.length === 0 ? 'none' : 'bm25',
      indexVersion,
      completeness,
      snapshot: buildSnapshot(resolved, spans, this.#now()),
      nextCursor: more
        ? encodeCursor({
            version: 1,
            queryDigest,
            collections: resolved.map((entry) => ({
              collectionRef: entry.collectionRef,
              generation: entry.generation.generation,
            })),
            offset: offset + page.length,
          })
        : null,
    }
    return {
      response,
      matchedTotal: ranked.length,
      truncated,
      indexDocumentCount,
      duplicatesCollapsed,
    }
  }

  /** `DocumentSearchPort.readSpan` — delegates to the LOCAL-023 span reader. */
  async readSpan(request: ReadSpanRequest, ctx: ToolContext): Promise<ReadSpanResponse> {
    trustedScope(ctx)
    return this.#spanReader.readSpan(request, ctx)
  }

  async #resolveCollections(
    scope: { readonly tenantId: string; readonly spaceId: string },
    collections: readonly string[],
    request: DocumentSearchRequest,
    queryDigest: string,
    ctx: ToolContext,
  ): Promise<readonly ResolvedCollection[]> {
    if (request.cursor === undefined) {
      const resolved: ResolvedCollection[] = []
      for (const collectionRef of collections) {
        const generation = await this.#store.getActiveGeneration(scope, collectionRef, ctx)
        if (generation === undefined) {
          throw new DocumentSearchError(
            'INDEX_NOT_FOUND',
            `collection ${collectionRef} has no active keyword index in this scope`,
          )
        }
        resolved.push({ collectionRef, generation })
      }
      return resolved
    }

    const cursor = decodeCursor(request.cursor)
    if (cursor.queryDigest !== queryDigest) {
      throw new DocumentSearchError(
        'INVALID_ARGUMENT',
        'the cursor belongs to a different query and cannot be replayed',
      )
    }
    const pinned = new Set(cursor.collections.map((entry) => entry.collectionRef))
    for (const collectionRef of pinned) {
      if (!collections.includes(collectionRef)) {
        throw new DocumentSearchError(
          'INVALID_ARGUMENT',
          `the cursor names collection ${collectionRef}, which this request is not authorized for`,
        )
      }
    }
    const resolved: ResolvedCollection[] = []
    for (const entry of cursor.collections) {
      const generation = await this.#store.getGeneration(
        scope,
        entry.collectionRef,
        entry.generation,
        ctx,
      )
      if (generation === undefined) {
        throw new DocumentSearchError(
          'SNAPSHOT_UNAVAILABLE',
          `index generation ${entry.generation} of ${entry.collectionRef} is no longer available`,
        )
      }
      resolved.push({ collectionRef: entry.collectionRef, generation })
    }
    return resolved
  }
}

function assertKeywordMode(request: DocumentSearchRequest): void {
  if (request.mode === 'keyword') return
  const label = request.mode === 'vector' ? 'vector' : 'hybrid'
  throw new DocumentSearchError(
    'UNSUPPORTED_QUERY',
    `the ${label} search mode is not configured: only a keyword (BM25) backend is registered`,
  )
}

function assertSupportedFilters(filters: SearchFilters | undefined): void {
  if (filters === undefined) return
  if (filters.languages !== undefined) {
    throw new DocumentSearchError(
      'UNSUPPORTED_QUERY',
      'language filtering is not supported by the keyword index',
    )
  }
  if (filters.validAt !== undefined) {
    throw new DocumentSearchError(
      'UNSUPPORTED_QUERY',
      'validAt filtering requires a bitemporal store the keyword index does not provide',
    )
  }
}

function buildIndexVersion(
  resolved: readonly ResolvedCollection[],
  readAt: string,
): IndexVersion {
  const first = resolved[0]
  if (first === undefined) {
    throw new DocumentSearchError('INDEX_NOT_FOUND', 'no keyword index generation was resolved')
  }
  if (resolved.length === 1) {
    return {
      indexRef: first.generation.indexRef,
      generation: first.generation.generation,
      builtAt: first.generation.builtAt,
    }
  }
  const digest = sha256DigestOf(
    JSON.stringify(
      resolved.map((entry) => [
        entry.collectionRef,
        entry.generation.generation,
        entry.generation.indexDigest,
      ]),
    ),
  )
  const maxGeneration = resolved.reduce(
    (max, entry) => Math.max(max, Number(entry.generation.generation)),
    0,
  )
  const builtAt = resolved
    .map((entry) => entry.generation.builtAt)
    .sort()
    .at(-1)
  return {
    indexRef: {
      id: resolved.map((entry) => entry.collectionRef).join('+'),
      version: INDEX_REF_VERSION,
      digest,
    },
    generation: String(maxGeneration),
    builtAt: builtAt ?? readAt,
  }
}

function buildSnapshot(
  resolved: readonly ResolvedCollection[],
  spans: readonly DocumentSpan[],
  readAt: string,
): SourceSnapshot {
  return {
    sourceRef: {
      namespace: KEYWORD_INDEX_NAMESPACE,
      sourceId: resolved.map((entry) => entry.collectionRef).join(','),
    },
    schemaVersion: KEYWORD_INDEX_SCHEMA_VERSION,
    readAt,
    consistency: 'immutable',
    resultDigest: sha256DigestOf(JSON.stringify(spans)),
  }
}
