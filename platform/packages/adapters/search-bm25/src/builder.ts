import type {
  DocumentChunkRecord,
  DocumentParseRecord,
  DocumentParseStore,
  RevisionString,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { canonicalIndexDigest, termFrequencies, tokenize } from './bm25'
import { DocumentSearchError } from './errors'
import { INDEX_REF_VERSION } from './service'
import { trustedScope } from './scope'
import type {
  IndexBuildRequest,
  IndexBuildResult,
  IndexedDocument,
  KeywordIndexGeneration,
  KeywordIndexStore,
} from './types'

export interface Bm25IndexBuilderDependencies {
  /** The LOCAL-023 chunk store. Chunks are read, never re-derived. */
  readonly parseStore: DocumentParseStore
  readonly indexStore: KeywordIndexStore
  readonly now?: () => string
}

function toIndexedDocument(
  parse: DocumentParseRecord,
  chunk: DocumentChunkRecord,
): IndexedDocument {
  const tokens = tokenize(chunk.text)
  return {
    chunkId: chunk.chunkId,
    parseId: parse.parseId,
    documentRef: parse.originalRef,
    documentDigest: parse.originalRef.digest,
    ...(parse.sourceRef === undefined ? {} : { sourceRef: parse.sourceRef }),
    mediaType: parse.originalMediaType,
    text: chunk.text,
    textDigest: chunk.textDigest,
    locator: chunk.locator,
    spanKind: chunk.spanKind,
    precision: chunk.precision,
    quoteDigest: chunk.quoteDigest,
    ordinal: chunk.ordinal,
    recordedAt: parse.createdAt,
    length: tokens.length,
    termFrequencies: termFrequencies(tokens),
  }
}

/**
 * Builds an immutable, versioned BM25 index generation for one authorized
 * collection from LOCAL-023 parse records. The build is idempotent on the corpus
 * digest: re-indexing unchanged content reuses the existing generation instead of
 * minting a new version, while changed content yields a new generation. The write
 * is a single atomic store call, so a crash cannot leave a half-built generation
 * for the job to publish.
 */
export class Bm25IndexBuilder {
  readonly #parseStore: DocumentParseStore
  readonly #indexStore: KeywordIndexStore
  readonly #now: () => string

  constructor(dependencies: Bm25IndexBuilderDependencies) {
    this.#parseStore = dependencies.parseStore
    this.#indexStore = dependencies.indexStore
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async build(request: IndexBuildRequest, ctx: ToolContext): Promise<IndexBuildResult> {
    const scope = trustedScope(ctx)
    if (request.collectionRef.trim().length === 0) {
      throw new DocumentSearchError('INVALID_ARGUMENT', 'collectionRef must be a non-empty string')
    }

    const byChunkId = new Map<string, IndexedDocument>()
    let complete = true
    for (const parse of request.parses) {
      if (parse.coverage.status !== 'complete') complete = false
      const chunks = await this.#parseStore.listChunks(scope, parse.parseId, ctx)
      for (const chunk of chunks) {
        byChunkId.set(chunk.chunkId, toIndexedDocument(parse, chunk))
      }
    }
    const documents = [...byChunkId.values()].sort((left, right) =>
      left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0,
    )

    const indexDigest = canonicalIndexDigest(request.collectionRef, documents)
    const existing = await this.#indexStore.findGenerationByDigest(
      scope,
      request.collectionRef,
      indexDigest,
      ctx,
    )
    if (existing !== undefined) {
      return { generation: existing, created: false, documentCount: documents.length }
    }

    // The generation number comes from a scope+collection bigint counter, not
    // `Number(max generation) + 1`: the old derivation raced between concurrent
    // builds and lost precision once a collection passed 2^53 generations.
    const generation = await this.#indexStore.reserveGeneration(scope, request.collectionRef, ctx)
    const totalLength = documents.reduce((sum, document) => sum + document.length, 0)
    const indexRef: VersionRef = {
      id: request.collectionRef,
      version: INDEX_REF_VERSION,
      digest: indexDigest,
    }
    const written = await this.#indexStore.writeGeneration(
      scope,
      {
        collectionRef: request.collectionRef,
        generation,
        indexDigest,
        indexRef,
        docCount: documents.length,
        avgDocLength: documents.length === 0 ? 0 : totalLength / documents.length,
        completeness: complete ? 'complete' : 'partial',
        builtAt: this.#now(),
        documents,
      },
      ctx,
    )
    return {
      generation: written.generation,
      created: written.created,
      documentCount: documents.length,
    }
  }

  /** Move the active pointer onto a committed generation. Idempotent. */
  async activate(
    collectionRef: string,
    generation: RevisionString,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration> {
    const scope = trustedScope(ctx)
    return this.#indexStore.activateGeneration(scope, collectionRef, generation, this.#now(), ctx)
  }
}
