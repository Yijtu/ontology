import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256DigestOf } from '@ontology/core'
import type {
  DocumentChunkRecord,
  DocumentParseRecord,
  DocumentSpanReaderPort,
  ReadSpanRequest,
  ReadSpanResponse,
  ResourceRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { InMemoryDocumentParseStore } from '@ontology/adapter-extraction-document'
import {
  InMemoryKeywordIndexStore,
  InMemoryProjectDocumentStore,
  ProjectDocumentIndexService,
} from '@ontology/adapter-search-bm25'
import { createTestToolContext } from '../fixtures/documents/test-doubles'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CTX_A: ToolContext = createTestToolContext(TENANT_A, SPACE_A)
const CTX_B: ToolContext = createTestToolContext(TENANT_B, SPACE_B)
const NOW = '2026-09-30T00:00:00Z'

function artifactRef(label: string): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: sha256DigestOf(label), kind: 'artifact' }
}

interface CorpusDoc {
  readonly parse: DocumentParseRecord
  readonly documentId: Uuid
  readonly text: string
}

async function seedDocument(
  parseStore: InMemoryDocumentParseStore,
  label: string,
  text: string,
  ctx: ToolContext = CTX_A,
): Promise<CorpusDoc> {
  const parseId = randomUUID()
  const originalRef: ResourceRef = {
    id: randomUUID(),
    version: '1.0.0',
    digest: sha256DigestOf(`original-${label}`),
    kind: 'document',
  }
  const chunk: DocumentChunkRecord = {
    chunkId: randomUUID(),
    ordinal: 0,
    chunkKind: 'clause',
    text,
    textDigest: sha256DigestOf(text),
    locator: { kind: 'offset', startOffset: 0, endOffset: text.length },
    spanKind: 'verbatim',
    precision: 'exact',
    quoteDigest: sha256DigestOf(text),
    conditions: [],
    exceptions: [],
  }
  const parse: DocumentParseRecord = {
    parseId,
    scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
    mediaKind: 'text',
    originalMediaType: 'text/plain',
    originalRef,
    normalizedMediaType: 'text/plain',
    normalizedByteSize: text.length,
    normalizedRef: artifactRef(`${label}-normalized`),
    spanMapMediaType: 'application/json',
    spanMapRef: artifactRef(`${label}-span-map`),
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
    pages: [],
    createdAt: NOW,
  }
  await parseStore.recordParse(parse, [chunk], ctx)
  return { parse, documentId: randomUUID(), text }
}

/** A span reader that returns the exact indexed text keyed by the original ref id. */
class CorpusSpanReader implements DocumentSpanReaderPort {
  readonly #textByRefId: Map<string, string>

  constructor(textByRefId: Map<string, string>) {
    this.#textByRefId = textByRefId
  }

  async readSpan(request: ReadSpanRequest, _ctx: ToolContext): Promise<ReadSpanResponse> {
    void _ctx
    const text = this.#textByRefId.get(request.documentRef.id) ?? ''
    return {
      documentRef: request.documentRef,
      text,
      textDigest: sha256DigestOf(text),
      snapshot: {
        sourceRef: { namespace: 'ontology.document', sourceId: request.documentRef.id },
        schemaVersion: '1.0.0',
        readAt: NOW,
        consistency: 'immutable',
        resultDigest: request.documentRef.digest,
      },
    }
  }
}

interface Harness {
  readonly service: ProjectDocumentIndexService
  readonly parseStore: InMemoryDocumentParseStore
  readonly texts: Map<string, string>
}

function harness(maxFragments?: number): Harness {
  const parseStore = new InMemoryDocumentParseStore()
  const texts = new Map<string, string>()
  const service = new ProjectDocumentIndexService({
    store: new InMemoryProjectDocumentStore(),
    parseStore,
    indexStore: new InMemoryKeywordIndexStore(),
    spanReader: new CorpusSpanReader(texts),
    ...(maxFragments === undefined ? {} : { maxFragments }),
    now: () => NOW,
  })
  return { service, parseStore, texts }
}

async function register(
  service: ProjectDocumentIndexService,
  projectId: Uuid,
  doc: CorpusDoc,
  ctx: ToolContext = CTX_A,
): Promise<void> {
  await service.importDocument(
    projectId,
    {
      documentId: doc.documentId,
      documentRef: doc.parse.originalRef,
      documentDigest: doc.parse.originalRef.digest,
      parseId: doc.parse.parseId,
      parseRef: doc.parse.spanMapRef,
      textDigest: sha256DigestOf(doc.text),
      precision: 'exact',
      actor: 'operator',
      recordedAt: NOW,
    },
    ctx,
  )
}

async function seedInto(harnessRef: Harness, label: string, text: string): Promise<CorpusDoc> {
  const doc = await seedDocument(harnessRef.parseStore, label, text)
  harnessRef.texts.set(doc.parse.originalRef.id, text)
  return doc
}

describe('ProjectDocumentIndexService', () => {
  it('indexes an imported authorised document and returns a real fragment with a fixed revision', async () => {
    const h = harness()
    const doc = await seedInto(h, 'alpha', 'the battery warranty covers five years')
    const projectId = randomUUID()

    const pending = await h.service.getStatus(projectId, CTX_A)
    expect(pending.state).toBe('pending')

    await register(h.service, projectId, doc)
    const afterBuild = await h.service.buildIndex(projectId, CTX_A)
    expect(afterBuild.state).toBe('ready')
    expect(afterBuild.generation).toBe('1')
    expect(afterBuild.documentCount).toBe(1)
    expect(afterBuild.sourceDocumentCount).toBe(1)

    const result = await h.service.search({ projectId, query: 'battery warranty' }, CTX_A)
    expect(result.state).toBe('ready')
    expect(result.fragments).toHaveLength(1)
    const fragment = result.fragments[0]
    if (fragment === undefined) throw new Error('expected a fragment')
    expect(fragment.text).toContain('battery warranty')
    expect(fragment.revision).toBe('1')
    expect(fragment.documentId).toBe(doc.documentId)
    expect(fragment.locator.kind).toBe('offset')
    expect(result.coverage.maxFragments).toBeGreaterThan(0)
    expect(result.scoreKind).toBe('bm25')
  })

  it('cannot surface one project corpus from a different project or a different scope', async () => {
    const h = harness()
    const doc = await seedInto(h, 'alpha', 'battery warranty five years')
    const projectA = randomUUID()
    const projectB = randomUUID()
    await register(h.service, projectA, doc)
    await h.service.buildIndex(projectA, CTX_A)

    const otherProject = await h.service.search({ projectId: projectB, query: 'battery warranty' }, CTX_A)
    expect(otherProject.state).toBe('pending')
    expect(otherProject.fragments).toHaveLength(0)

    expect((await h.service.getStatus(projectA, CTX_B)).state).toBe('pending')
    expect((await h.service.search({ projectId: projectA, query: 'battery warranty' }, CTX_B)).fragments).toHaveLength(0)
  })

  it('marks the index stale after a retraction and stops serving the withdrawn fragment until rebuild', async () => {
    const h = harness()
    const doc = await seedInto(h, 'alpha', 'battery warranty five years')
    const projectId = randomUUID()
    await register(h.service, projectId, doc)
    expect((await h.service.buildIndex(projectId, CTX_A)).state).toBe('ready')
    expect((await h.service.search({ projectId, query: 'battery' }, CTX_A)).fragments).toHaveLength(1)

    const revised = await h.service.reviseDocument(
      projectId,
      { documentId: doc.documentId, op: 'retract', reason: 'source withdrawn', actor: 'operator', recordedAt: NOW },
      CTX_A,
    )
    expect(revised.state).toBe('stale')

    const afterRetract = await h.service.search({ projectId, query: 'battery' }, CTX_A)
    expect(afterRetract.state).toBe('stale')
    expect(afterRetract.fragments).toHaveLength(0)

    const rebuilt = await h.service.buildIndex(projectId, CTX_A)
    expect(rebuilt.state).toBe('ready')
    expect(rebuilt.sourceDocumentCount).toBe(0)
    expect((await h.service.search({ projectId, query: 'battery' }, CTX_A)).fragments).toHaveLength(0)
  })

  it('bounds the returned fragments and reports the coverage limit', async () => {
    const h = harness(2)
    const docs: CorpusDoc[] = []
    for (const label of ['a', 'b', 'c']) docs.push(await seedInto(h, label, `battery warranty clause ${label}`))
    const projectId = randomUUID()
    for (const doc of docs) await register(h.service, projectId, doc)
    await h.service.buildIndex(projectId, CTX_A)

    const result = await h.service.search({ projectId, query: 'battery warranty' }, CTX_A)
    expect(result.fragments).toHaveLength(2)
    expect(result.coverage.maxFragments).toBe(2)
    expect(result.coverage.truncated).toBe(true)
    expect(result.coverage.knownTotal).toBeGreaterThanOrEqual(3)
  })
})
