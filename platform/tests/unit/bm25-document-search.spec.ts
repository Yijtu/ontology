import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  DocumentChunkRecord,
  DocumentParseRecord,
  DocumentSearchRequest,
  DocumentSpanReaderPort,
  ReadSpanRequest,
  ReadSpanResponse,
  ResourceRef,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import {
  Bm25DocumentSearchService,
  Bm25IndexBuilder,
  InMemoryKeywordIndexStore,
  createBm25DocumentSearchToolHandler,
  createBm25IndexBuildHandler,
  bm25TermScore,
  canonicalIndexDigest,
  termFrequencies,
  tokenize,
} from '@ontology/adapter-search-bm25'
import type { IndexedDocument, WriteGenerationInput } from '@ontology/adapter-search-bm25'
import { sha256DigestOf } from '@ontology/core'
import type { ToolHandler } from '@ontology/tool-services'
import { createTestToolContext } from '../fixtures/documents/test-doubles'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const COLLECTION = 'manuals/service-terms'
const CTX_A: ToolContext = createTestToolContext(TENANT_A, SPACE_A)
const CTX_B: ToolContext = createTestToolContext(TENANT_B, SPACE_B)
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }

function digestOfText(text: string): string {
  return sha256DigestOf(text)
}

function doc(overrides: {
  readonly chunkId?: string
  readonly text: string
  readonly documentDigest?: string
  readonly parseId?: string
  readonly sourceRef?: { readonly namespace: string; readonly sourceId: string }
  readonly mediaType?: string
}): IndexedDocument {
  const tokens = tokenize(overrides.text)
  const chunkId = overrides.chunkId ?? randomUUID()
  const documentDigest = overrides.documentDigest ?? sha256DigestOf(`document-${chunkId}`)
  const documentRef: ResourceRef = {
    id: chunkId,
    version: '1.0.0',
    digest: documentDigest,
    kind: 'document',
  }
  return {
    chunkId,
    parseId: overrides.parseId ?? randomUUID(),
    documentRef,
    documentDigest,
    ...(overrides.sourceRef === undefined ? {} : { sourceRef: overrides.sourceRef }),
    mediaType: overrides.mediaType ?? 'text/plain',
    text: overrides.text,
    textDigest: digestOfText(overrides.text),
    locator: { kind: 'offset', startOffset: 0, endOffset: overrides.text.length },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: digestOfText(overrides.text),
    ordinal: 0,
    recordedAt: '2026-09-21T00:00:00Z',
    length: tokens.length,
    termFrequencies: termFrequencies(tokens),
  }
}

async function seedGeneration(
  store: InMemoryKeywordIndexStore,
  collectionRef: string,
  generation: string,
  documents: readonly IndexedDocument[],
  ctx: ToolContext = CTX_A,
): Promise<void> {
  await writeGenerationOnly(store, collectionRef, generation, documents, ctx)
  await store.activateGeneration(SCOPE_A, collectionRef, generation, '2026-09-21T00:00:00Z', ctx)
}

async function writeGenerationOnly(
  store: InMemoryKeywordIndexStore,
  collectionRef: string,
  generation: string,
  documents: readonly IndexedDocument[],
  ctx: ToolContext = CTX_A,
): Promise<void> {
  const totalLength = documents.reduce((sum, document) => sum + document.length, 0)
  const indexDigest = canonicalIndexDigest(collectionRef, documents)
  const input: WriteGenerationInput = {
    collectionRef,
    generation,
    indexDigest,
    indexRef: { id: collectionRef, version: '1.0.0', digest: indexDigest },
    docCount: documents.length,
    avgDocLength: documents.length === 0 ? 0 : totalLength / documents.length,
    completeness: 'complete',
    builtAt: '2026-09-21T00:00:00Z',
    documents,
  }
  await store.writeGeneration(SCOPE_A, input, ctx)
}

class RecordingSpanReader implements DocumentSpanReaderPort {
  readonly calls: ReadSpanRequest[] = []
  readonly #text: string

  constructor(text: string) {
    this.#text = text
  }

  async readSpan(request: ReadSpanRequest, _ctx: ToolContext): Promise<ReadSpanResponse> {
    void _ctx
    this.calls.push(request)
    return {
      documentRef: request.documentRef,
      text: this.#text,
      textDigest: digestOfText(this.#text),
      snapshot: {
        sourceRef: { namespace: 'ontology.document', sourceId: request.documentRef.id },
        schemaVersion: '1.0.0',
        readAt: '2026-09-21T00:00:00Z',
        consistency: 'immutable',
        resultDigest: request.documentRef.digest,
      },
    }
  }
}

function serviceWith(store: InMemoryKeywordIndexStore): Bm25DocumentSearchService {
  return new Bm25DocumentSearchService({
    indexStore: store,
    spanReader: new RecordingSpanReader('original span text'),
    now: () => '2026-09-21T00:00:01Z',
  })
}

function keywordRequest(overrides: Partial<DocumentSearchRequest> = {}): DocumentSearchRequest {
  return {
    query: 'target',
    allowedCollectionRefs: [COLLECTION],
    mode: 'keyword',
    ...overrides,
  }
}

describe('BM25 scoring', () => {
  it('tokenizes case-insensitively and splits Han runs into characters', () => {
    expect(tokenize('Solar-Power 2024')).toEqual(['solar', 'power', '2024'])
    expect(tokenize('电池容量')).toEqual(['电', '池', '容', '量'])
  })

  it('scores a saturated term above an unsaturated one but not linearly', () => {
    const once = bm25TermScore(1, 10, 10, 2)
    const thrice = bm25TermScore(3, 10, 10, 2)
    expect(thrice).toBeGreaterThan(once)
    expect(thrice).toBeLessThan(3 * once)
  })

  it('normalises by document length', () => {
    const short = bm25TermScore(1, 2, 10, 2)
    const long = bm25TermScore(1, 30, 10, 2)
    expect(short).toBeGreaterThan(long)
  })

  it('ranks by IDF and term coverage: rare-term documents above common-term documents', async () => {
    const store = new InMemoryKeywordIndexStore()
    const rare = '00000000-0000-4000-8000-000000000001'
    const common = '00000000-0000-4000-8000-000000000002'
    const both = '00000000-0000-4000-8000-000000000003'
    await seedGeneration(store, COLLECTION, '1', [
      doc({ chunkId: rare, text: 'rare' }),
      doc({ chunkId: common, text: 'common' }),
      doc({ chunkId: both, text: 'rare common' }),
      doc({ chunkId: '00000000-0000-4000-8000-000000000004', text: 'common' }),
      doc({ chunkId: '00000000-0000-4000-8000-000000000005', text: 'common' }),
    ])
    const service = serviceWith(store)
    const response = await service.search(keywordRequest({ query: 'rare common' }), CTX_A)
    const ids = response.spans.map((span) => span.documentRef.id)
    // The two documents that contain the rare term are the only ones that can
    // outrank the four documents containing only the common term.
    expect(ids.slice(0, 2).sort()).toEqual([rare, both].sort())
    const rareIndex = ids.indexOf(rare)
    const commonIndex = ids.indexOf(common)
    expect(rareIndex).toBeGreaterThanOrEqual(0)
    expect(commonIndex).toBeGreaterThanOrEqual(0)
    expect(rareIndex).toBeLessThan(commonIndex)
  })

  it('excludes a document that contains none of the query terms', async () => {
    const store = new InMemoryKeywordIndexStore()
    await seedGeneration(store, COLLECTION, '1', [
      doc({ chunkId: '00000000-0000-4000-8000-00000000000a', text: 'target present' }),
      doc({ chunkId: '00000000-0000-4000-8000-00000000000b', text: 'unrelated text' }),
    ])
    const response = await serviceWith(store).search(keywordRequest(), CTX_A)
    expect(response.spans.map((span) => span.documentRef.id)).toEqual([
      '00000000-0000-4000-8000-00000000000a',
    ])
  })
})

describe('index version binding', () => {
  it('reports the generation it searched and binds a cursor to it', async () => {
    const store = new InMemoryKeywordIndexStore()
    await seedGeneration(store, COLLECTION, '1', [
      doc({ chunkId: '00000000-0000-4000-8000-000000000001', text: 'target alpha' }),
      doc({ chunkId: '00000000-0000-4000-8000-000000000002', text: 'target beta' }),
      doc({ chunkId: '00000000-0000-4000-8000-000000000003', text: 'target gamma' }),
    ])
    const service = serviceWith(store)
    const first = await service.search(keywordRequest({ limit: 2 }), CTX_A)
    expect(first.indexVersion.generation).toBe('1')
    expect(first.spans).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()

    // Build a new generation but do not activate it: the served version is unchanged.
    await writeGenerationOnly(store, COLLECTION, '2', [
      doc({ chunkId: '00000000-0000-4000-8000-000000000004', text: 'target delta' }),
    ])
    const afterStagedBuild = await service.search(keywordRequest({ limit: 2 }), CTX_A)
    expect(afterStagedBuild.indexVersion.generation).toBe('1')

    // Activate generation 2 with a different corpus.
    await store.activateGeneration(SCOPE_A, COLLECTION, '2', '2026-09-21T00:00:02Z', CTX_A)
    const afterActivation = await service.search(keywordRequest({ limit: 2 }), CTX_A)
    expect(afterActivation.indexVersion.generation).toBe('2')

    // The old cursor still reads generation 1, so paging cannot cross versions.
    const cursor = first.nextCursor
    if (cursor === null || cursor === undefined) throw new Error('expected a next cursor')
    const secondPage = await service.search(keywordRequest({ limit: 2, cursor }), CTX_A)
    expect(secondPage.indexVersion.generation).toBe('1')
    expect(secondPage.spans).toHaveLength(1)
    const combined = [...first.spans, ...secondPage.spans].map((span) => span.documentRef.id).sort()
    expect(combined).toEqual([
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ])
  })

  it('reuses an unchanged corpus instead of minting a new version', async () => {
    const store = new InMemoryKeywordIndexStore()
    const parses = [parseFixture('reuse', 'target reuse')]
    const parseStore = {
      listChunks: async () => parses[0]?.chunks ?? [],
      listChunksByScope: async () => [],
      recordParse: async () => ({ created: false }),
      findParseByDigest: async () => undefined,
      close: async () => undefined,
    }
    const builder = new Bm25IndexBuilder({
      parseStore,
      indexStore: store,
      now: () => '2026-09-21T00:00:00Z',
    })
    const first = await builder.build({ collectionRef: COLLECTION, parses }, CTX_A)
    const second = await builder.build({ collectionRef: COLLECTION, parses }, CTX_A)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.generation.generation).toBe(first.generation.generation)
    expect(await store.listGenerations(SCOPE_A, COLLECTION, CTX_A)).toHaveLength(1)
  })
})

describe('unsupported query modes', () => {
  it('refuses vector and hybrid with UNSUPPORTED_QUERY instead of degrading to keyword', async () => {
    const store = new InMemoryKeywordIndexStore()
    await seedGeneration(store, COLLECTION, '1', [doc({ text: 'target' })])
    const service = serviceWith(store)
    await expect(service.search(keywordRequest({ mode: 'vector' }), CTX_A)).rejects.toMatchObject({
      code: 'UNSUPPORTED_QUERY',
      httpStatus: 422,
    })
    await expect(service.search(keywordRequest({ mode: 'hybrid' }), CTX_A)).rejects.toMatchObject({
      code: 'UNSUPPORTED_QUERY',
    })
  })

  it('refuses a filter the keyword index cannot honour', async () => {
    const store = new InMemoryKeywordIndexStore()
    await seedGeneration(store, COLLECTION, '1', [doc({ text: 'target' })])
    await expect(
      serviceWith(store).search(
        keywordRequest({ filters: { languages: ['en'] } }),
        CTX_A,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
    await expect(
      serviceWith(store).search(
        keywordRequest({ filters: { validAt: '2026-09-21T00:00:00Z' } }),
        CTX_A,
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
  })
})

describe('snippet traceability', () => {
  it('returns a span that reads back through the LOCAL-023 span reader', async () => {
    const store = new InMemoryKeywordIndexStore()
    const indexed = doc({ chunkId: '00000000-0000-4000-8000-00000000000c', text: 'target clause' })
    await seedGeneration(store, COLLECTION, '1', [indexed])
    const reader = new RecordingSpanReader(indexed.text)
    const service = new Bm25DocumentSearchService({
      indexStore: store,
      spanReader: reader,
      now: () => '2026-09-21T00:00:01Z',
    })
    const response = await service.search(keywordRequest(), CTX_A)
    const span = response.spans[0]
    if (span === undefined) throw new Error('expected a span')
    expect(span.documentRef).toEqual(indexed.documentRef)
    expect(span.locator).toEqual(indexed.locator)
    expect(span.quoteDigest).toBe(indexed.quoteDigest)
    const read = await service.readSpan({ documentRef: span.documentRef, locator: span.locator }, CTX_A)
    expect(read.text).toBe(indexed.text)
    expect(reader.calls).toHaveLength(1)
  })
})

describe('coverage semantics', () => {
  it('reports a truncated recall range without hiding the matches beyond top-k', async () => {
    const store = new InMemoryKeywordIndexStore()
    await seedGeneration(store, COLLECTION, '1', [
      doc({ chunkId: '00000000-0000-4000-8000-000000000001', text: 'target one' }),
      doc({ chunkId: '00000000-0000-4000-8000-000000000002', text: 'target two' }),
      doc({ chunkId: '00000000-0000-4000-8000-000000000003', text: 'target three' }),
    ])
    const detail = await serviceWith(store).searchDetailed(keywordRequest({ limit: 1 }), CTX_A)
    expect(detail.response.spans).toHaveLength(1)
    expect(detail.matchedTotal).toBe(3)
    expect(detail.truncated).toBe(true)
    expect(detail.response.completeness).toBe('truncated')
    expect(detail.response.nextCursor).not.toBeNull()
  })

  it('never encodes a keyword miss as corpus-wide absence', async () => {
    const store = new InMemoryKeywordIndexStore()
    await seedGeneration(store, COLLECTION, '1', [
      doc({ chunkId: '00000000-0000-4000-8000-000000000001', text: 'the service is best effort' }),
    ])
    const service = serviceWith(store)
    const handler = createBm25DocumentSearchToolHandler({ service, ctx: CTX_A })
    const outcome = await handler.execute({
      callId: randomUUID(),
      toolId: 'document_search',
      arguments: { query: 'guaranteed refund', allowedCollectionRefs: [COLLECTION], mode: 'keyword' },
      resultLimits: { maxRows: 200, maxBytes: 1048576, maxDurationMs: 30000 },
      deadline: '2026-09-21T00:10:00Z',
      traceId: 'trace-bm25',
      signal: new AbortController().signal,
    })
    expect(outcome.status).toBe('empty')
    expect(outcome.coverage.returned).toBe(0)
    expect(outcome.coverage.knownTotal).toBe(0)
    expect(outcome.coverage.truncated).toBe(false)
    expect(outcome.warnings?.map((warning) => warning.code)).toContain('KEYWORD_MISS_IS_NOT_ABSENCE')
  })
})

describe('duplicate sources', () => {
  it('collapses copies of the same content into one independent evidence span', async () => {
    const store = new InMemoryKeywordIndexStore()
    const contentDigest = `sha256:${'e'.repeat(64)}`
    await seedGeneration(store, COLLECTION, '1', [
      doc({
        chunkId: '00000000-0000-4000-8000-000000000001',
        text: 'target duplicate',
        documentDigest: contentDigest,
        parseId: '00000000-0000-4000-8000-0000000000a1',
      }),
      doc({
        chunkId: '00000000-0000-4000-8000-000000000002',
        text: 'target duplicate',
        documentDigest: contentDigest,
        parseId: '00000000-0000-4000-8000-0000000000a2',
      }),
    ])
    const detail = await serviceWith(store).searchDetailed(keywordRequest(), CTX_A)
    expect(detail.response.spans).toHaveLength(1)
    expect(detail.matchedTotal).toBe(1)
    expect(detail.duplicatesCollapsed).toBe(1)
  })
})

describe('authorization', () => {
  it('does not serve one tenant index to another tenant', async () => {
    const store = new InMemoryKeywordIndexStore()
    await seedGeneration(store, COLLECTION, '1', [doc({ text: 'target tenant a' })], CTX_A)
    await expect(serviceWith(store).search(keywordRequest(), CTX_B)).rejects.toMatchObject({
      code: 'INDEX_NOT_FOUND',
    })
    expect(store.hasScope(SCOPE_A)).toBe(true)
  })

  it('refuses a collection with no active index', async () => {
    const store = new InMemoryKeywordIndexStore()
    await expect(serviceWith(store).search(keywordRequest(), CTX_A)).rejects.toMatchObject({
      code: 'INDEX_NOT_FOUND',
    })
  })
})

describe('generation write atomicity', () => {
  it('rejects a duplicate chunk id and leaves no generation behind', async () => {
    const store = new InMemoryKeywordIndexStore()
    const duplicate = doc({ chunkId: '00000000-0000-4000-8000-000000000001', text: 'target' })
    const indexDigest = canonicalIndexDigest(COLLECTION, [duplicate])
    await expect(
      store.writeGeneration(
        SCOPE_A,
        {
          collectionRef: COLLECTION,
          generation: '1',
          indexDigest,
          indexRef: { id: COLLECTION, version: '1.0.0', digest: indexDigest },
          docCount: 2,
          avgDocLength: 1,
          completeness: 'complete',
          builtAt: '2026-09-21T00:00:00Z',
          documents: [duplicate, duplicate],
        },
        CTX_A,
      ),
    ).rejects.toMatchObject({ code: 'STORE_FAILED' })
    expect(await store.getGeneration(SCOPE_A, COLLECTION, '1', CTX_A)).toBeUndefined()
  })
})

describe('index build stage handler', () => {
  it('is usable as the application ToolHandler for document_search', () => {
    const store = new InMemoryKeywordIndexStore()
    const service = serviceWith(store)
    const handler: ToolHandler = createBm25DocumentSearchToolHandler({ service, ctx: CTX_A })
    expect(handler.toolId).toBe('document_search')
  })

  it('builds, activates and reports a publication intent for the index version', async () => {
    const store = new InMemoryKeywordIndexStore()
    const parses = [parseFixture('stage', 'target stage handler')]
    const builder = new Bm25IndexBuilder({
      parseStore: {
        listChunks: async () => parses[0]?.chunks ?? [],
        listChunksByScope: async () => [],
        recordParse: async () => ({ created: false }),
        findParseByDigest: async () => undefined,
        close: async () => undefined,
      },
      indexStore: store,
      now: () => '2026-09-21T00:00:00Z',
    })
    const handler = createBm25IndexBuildHandler({
      builder,
      collectionRef: COLLECTION,
      parses,
    })
    expect(handler.stage).toBe('extracted')
    const outcome = await handler.run({
      job: jobFixture(),
      attempt: attemptFixture(),
      budget: unusedBudget(),
      ledgerId: randomUUID(),
      ctx: CTX_A,
      signal: new AbortController().signal,
    })
    expect(outcome.nextStage).toBe('published')
    expect(outcome.publication?.publicationKey).toContain('keyword-index:')
    const active = await store.getActiveGeneration(SCOPE_A, COLLECTION, CTX_A)
    expect(active?.generation).toBe('1')
  })
})

function parseFixture(label: string, text: string): DocumentParseRecord & { readonly chunks: DocumentChunkRecord[] } {
  const parseId = randomUUID()
  const contentDigest = sha256DigestOf(`content-${label}`)
  const originalRef: ResourceRef = {
    id: randomUUID(),
    version: '1.0.0',
    digest: contentDigest,
    kind: 'document',
  }
  const artifactRef = (suffix: string): ResourceRef => ({
    id: randomUUID(),
    version: '1.0.0',
    digest: sha256DigestOf(`${label}-${suffix}`),
    kind: 'artifact',
  })
  const chunk: DocumentChunkRecord = {
    chunkId: randomUUID(),
    ordinal: 0,
    chunkKind: 'clause',
    text,
    textDigest: digestOfText(text),
    locator: { kind: 'offset', startOffset: 0, endOffset: text.length },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: digestOfText(text),
    conditions: [],
    exceptions: [],
  }
  return {
    parseId,
    scopeRef: SCOPE_A,
    mediaKind: 'text',
    originalMediaType: 'text/plain',
    originalRef,
    normalizedMediaType: 'application/json',
    normalizedByteSize: text.length,
    normalizedRef: artifactRef('normalized'),
    spanMapMediaType: 'application/json',
    spanMapRef: artifactRef('span-map'),
    parserId: 'ontology.document-parser',
    parserVersion: '1.0.0',
    offsetUnit: 'byte',
    coverage: {
      status: 'complete',
      completeness: 'complete',
      totalUnits: 1,
      parsedUnits: 1,
      skippedUnits: 0,
      skippedReasons: [],
      notes: [],
    },
    pages: [{ page: 1, startOffset: 0, endOffset: text.length, approximate: false }],
    createdAt: '2026-09-21T00:00:00Z',
    chunks: [chunk],
  }
}

function jobFixture() {
  return {
    jobId: randomUUID(),
    kind: 'ingestion' as const,
    sourceRef: 'source-1',
    documentRef: 'document-1',
    pipelineVersion: '1.0.0',
    idempotencyKey: 'idem-bm25',
    inputDigest: sha256DigestOf('input'),
    counts: { total: 0, processed: 0, failed: 0, skipped: 0 },
    createdAt: '2026-09-21T00:00:00Z',
    createdBy: 'tester',
    stage: 'extracted' as const,
    revision: '1',
    attemptCount: 0,
    abandonedAttemptCount: 0,
    nextAttemptAt: '2026-09-21T00:00:00Z',
    updatedAt: '2026-09-21T00:00:00Z',
  }
}

function attemptFixture() {
  return {
    attemptId: randomUUID(),
    jobId: randomUUID(),
    attemptNumber: 1,
    state: 'leased' as const,
    stage: 'extracted' as const,
    workerId: 'test-worker',
    leaseExpiresAt: '2026-09-21T00:01:00Z',
    startedAt: '2026-09-21T00:00:00Z',
  }
}

function unusedBudget() {
  return {
    openLedger: async () => {
      throw new Error('not used')
    },
    reserve: async () => {
      throw new Error('not used')
    },
    recordIntent: async () => {
      throw new Error('not used')
    },
    settle: async () => {
      throw new Error('not used')
    },
    remaining: async () => {
      throw new Error('not used')
    },
  }
}
