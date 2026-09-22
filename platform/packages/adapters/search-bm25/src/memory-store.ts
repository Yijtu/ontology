import type { RevisionString, ScopeRef, Sha256Digest, ToolContext } from '@ontology/contracts'
import { DocumentSearchError } from './errors'
import { generationKey, resolveTrustedScope, scopeKey } from './scope'
import type {
  GenerationWriteResult,
  IndexedDocument,
  KeywordIndexGeneration,
  KeywordIndexStore,
  MatchingDocumentPage,
  WriteGenerationInput,
} from './types'

type MutableGeneration = {
  -readonly [Key in keyof KeywordIndexGeneration]: KeywordIndexGeneration[Key]
}

interface StoredGeneration {
  generation: MutableGeneration
  documents: Map<string, IndexedDocument>
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Reference implementation of the versioned keyword index store for unit tests
 * and local composition. It enforces the same invariants as the database
 * implementation — scope isolation, atomic generation writes, digest-derived
 * idempotency, a single active pointer and immutable superseded generations — so
 * the service is exercised against the real rules rather than a permissive fake.
 */
export class InMemoryKeywordIndexStore implements KeywordIndexStore {
  readonly #generations = new Map<string, Map<RevisionString, StoredGeneration>>()
  readonly #active = new Map<string, RevisionString>()

  async writeGeneration(
    scopeRef: ScopeRef,
    input: WriteGenerationInput,
    ctx: ToolContext,
  ): Promise<GenerationWriteResult> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const key = generationKey(scope, input.collectionRef)
    const generations = this.#generations.get(key) ?? new Map<RevisionString, StoredGeneration>()

    const existingByDigest = [...generations.values()].find(
      (entry) => entry.generation.indexDigest === input.indexDigest,
    )
    if (existingByDigest !== undefined) {
      return { generation: clone(existingByDigest.generation), created: false }
    }
    const existingByNumber = generations.get(input.generation)
    if (existingByNumber !== undefined) {
      // The same generation number must never be reused for different content.
      throw new DocumentSearchError(
        'STORE_FAILED',
        `generation ${input.generation} already exists with a different corpus digest`,
      )
    }

    const documents = new Map<string, IndexedDocument>()
    for (const document of input.documents) {
      if (documents.has(document.chunkId)) {
        // A duplicate chunk id inside one generation is a programming error; the
        // database primary key would reject it, so the reference store does too.
        throw new DocumentSearchError(
          'STORE_FAILED',
          `duplicate chunk ${document.chunkId} in generation ${input.generation}`,
        )
      }
      documents.set(document.chunkId, clone(document))
    }

    const generation: MutableGeneration = {
      collectionRef: input.collectionRef,
      generation: input.generation,
      indexDigest: input.indexDigest,
      indexRef: input.indexRef,
      docCount: input.docCount,
      avgDocLength: input.avgDocLength,
      completeness: input.completeness,
      state: 'staged',
      builtAt: input.builtAt,
    }
    generations.set(input.generation, { generation, documents })
    this.#generations.set(key, generations)
    return { generation: clone(generation), created: true }
  }

  async getGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const entry = this.#generations.get(generationKey(scope, collectionRef))?.get(generation)
    return entry === undefined ? undefined : clone(entry.generation)
  }

  async findGenerationByDigest(
    scopeRef: ScopeRef,
    collectionRef: string,
    indexDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const generations = this.#generations.get(generationKey(scope, collectionRef))
    if (generations === undefined) return undefined
    const entry = [...generations.values()].find(
      (candidate) => candidate.generation.indexDigest === indexDigest,
    )
    return entry === undefined ? undefined : clone(entry.generation)
  }

  async getActiveGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration | undefined> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const key = generationKey(scope, collectionRef)
    const generation = this.#active.get(key)
    if (generation === undefined) return undefined
    const entry = this.#generations.get(key)?.get(generation)
    return entry === undefined ? undefined : clone(entry.generation)
  }

  async activateGeneration(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    activatedAt: string,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const key = generationKey(scope, collectionRef)
    const generations = this.#generations.get(key)
    const target = generations?.get(generation)
    if (generations === undefined || target === undefined) {
      throw new DocumentSearchError(
        'INDEX_VERSION_NOT_FOUND',
        `generation ${generation} of ${collectionRef} does not exist`,
      )
    }
    const previous = this.#active.get(key)
    if (previous !== undefined && previous !== generation) {
      const previousEntry = generations.get(previous)
      if (previousEntry !== undefined) previousEntry.generation.state = 'superseded'
    }
    target.generation.state = 'active'
    this.#active.set(key, generation)
    void activatedAt
    return clone(target.generation)
  }

  async listGenerations(
    scopeRef: ScopeRef,
    collectionRef: string,
    ctx: ToolContext,
  ): Promise<KeywordIndexGeneration[]> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const generations = this.#generations.get(generationKey(scope, collectionRef))
    if (generations === undefined) return []
    return [...generations.values()]
      .map((entry) => clone(entry.generation))
      .sort((left, right) => Number(left.generation) - Number(right.generation))
  }

  async listMatchingDocuments(
    scopeRef: ScopeRef,
    collectionRef: string,
    generation: RevisionString,
    terms: readonly string[],
    limit: number,
    ctx: ToolContext,
  ): Promise<MatchingDocumentPage> {
    const scope = resolveTrustedScope(scopeRef, ctx)
    const entry = this.#generations.get(generationKey(scope, collectionRef))?.get(generation)
    if (entry === undefined) {
      throw new DocumentSearchError(
        'INDEX_VERSION_NOT_FOUND',
        `generation ${generation} of ${collectionRef} does not exist`,
      )
    }
    const wanted = new Set(terms)
    const matches = [...entry.documents.values()].filter((document) =>
      [...document.termFrequencies.keys()].some((term) => wanted.has(term)),
    )
    const bounded = matches.slice(0, limit)
    return {
      documents: bounded.map(clone),
      truncated: matches.length > bounded.length,
    }
  }

  /** Test helper: every document id in one generation, in insertion-independent order. */
  documentIds(scope: ScopeRef, collectionRef: string, generation: RevisionString): string[] {
    const entry = this.#generations
      .get(generationKey(scope, collectionRef))
      ?.get(generation)
    if (entry === undefined) return []
    return [...entry.documents.keys()].sort()
  }

  /** Test helper: the raw scope key, so a test can assert cross-tenant absence. */
  hasScope(scope: ScopeRef): boolean {
    const prefix = `${scopeKey(scope)}\u0000`
    return [...this.#generations.keys()].some((key) => key.startsWith(prefix))
  }

  async close(): Promise<void> {
    this.#generations.clear()
    this.#active.clear()
  }
}
