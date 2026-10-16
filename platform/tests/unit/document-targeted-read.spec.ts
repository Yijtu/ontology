import { describe, expect, it } from 'vitest'
import {
  DocumentTargetedReader,
  InMemoryDocumentParseStore,
  LocalDocumentExtractionService,
  sha256DigestOfBytes,
  sha256DigestOfText,
} from '@ontology/adapter-extraction-document'
import type { DocumentIndexPresencePort } from '@ontology/adapter-extraction-document'
import { DocumentTargetedReadService } from '@ontology/application'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import { InMemoryArtifactStore, createTestToolContext } from '../fixtures/documents/test-doubles'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const CTX: ToolContext = createTestToolContext(TENANT_A, SPACE_A)
const WORKSPACE = '99999999-9999-4999-8999-999999999999'

const TEXT_DOCUMENT = [
  'SERVICE TERMS',
  '3.1 The service is provided on a best-effort basis and the supplier may suspend it for maintenance.',
  '3.2 Fees are invoiced monthly in arrears and are due within thirty days of the invoice date.',
].join('\n')

interface Harness {
  readonly blobs: InMemoryArtifactStore
  readonly store: InMemoryDocumentParseStore
  readonly reader: DocumentTargetedReader
}

function harness(index?: DocumentIndexPresencePort): Harness {
  const blobs = new InMemoryArtifactStore()
  const store = new InMemoryDocumentParseStore()
  const reader = new DocumentTargetedReader({
    blobs,
    store,
    ...(index === undefined ? {} : { index }),
    now: () => '2026-10-16T00:00:00Z',
  })
  return { blobs, store, reader }
}

async function parsedTextDocument(harnessed: Harness): Promise<Awaited<ReturnType<LocalDocumentExtractionService['parse']>>> {
  const service = new LocalDocumentExtractionService({ blobs: harnessed.blobs, store: harnessed.store, now: () => '2026-10-16T00:00:00Z' })
  const bytes = new TextEncoder().encode(TEXT_DOCUMENT)
  const staged = await harnessed.blobs.stage(bytes, { scopeRef: SCOPE_A }, CTX)
  const published = await harnessed.blobs.publish(
    { scopeRef: SCOPE_A, contentDigest: staged.contentDigest, mediaType: 'text/plain', byteSize: staged.byteSize, purpose: 'document' },
    CTX,
  )
  return service.parse({ scopeRef: SCOPE_A, originalRef: published.blobRef }, CTX)
}

describe('a targeted read reports index-not-ready instead of "no content"', () => {
  it('reads an archived fragment directly when no index is wired', async () => {
    const harnessed = harness()
    const parsed = await parsedTextDocument(harnessed)

    const result = await harnessed.reader.read(
      {
        schemaVersion: 'document-targeted-read@1',
        workspaceId: WORKSPACE,
        selections: [{ documentRef: parsed.originalRef }],
        maxBytes: 40,
        limit: 4,
      },
      CTX,
    )

    expect(result.items).toHaveLength(1)
    const item = result.items[0]
    expect(item?.indexState).toBe('not_indexed_readable')
    expect(item?.text.length).toBeGreaterThan(0)
    expect(item?.text).not.toContain('__none__')
    expect(item?.unavailableReason).toBeUndefined()
    // The fragment is bounded and the truncation is explicit (more text exists beyond the window).
    expect(new TextEncoder().encode(item?.text ?? '').byteLength).toBeLessThanOrEqual(40)
    expect(item?.truncated).toBe(true)
    expect(result.truncated).toBe(true)
    expect(result.nextCursor).toBeDefined()
  })

  it('reports indexState indexed when the parse is served by a ready index', async () => {
    const indexed: DocumentIndexPresencePort = { isIndexed: () => Promise.resolve(true) }
    const harnessed = harness(indexed)
    const parsed = await parsedTextDocument(harnessed)

    const result = await harnessed.reader.read(
      {
        schemaVersion: 'document-targeted-read@1',
        workspaceId: WORKSPACE,
        selections: [{ documentRef: parsed.originalRef, locator: { kind: 'offset', startOffset: 0, endOffset: 20 } }],
        maxBytes: 64,
        limit: 4,
      },
      CTX,
    )
    expect(result.items[0]?.indexState).toBe('indexed')
  })

  it('resumes from the returned cursor so a full read stays bounded', async () => {
    const harnessed = harness()
    const parsed = await parsedTextDocument(harnessed)

    const first = await harnessed.reader.read(
      { schemaVersion: 'document-targeted-read@1', workspaceId: WORKSPACE, selections: [{ documentRef: parsed.originalRef }], maxBytes: 30, limit: 4 },
      CTX,
    )
    const cursor = first.nextCursor
    expect(cursor).toBeDefined()
    if (cursor === undefined) return
    const second = await harnessed.reader.read(
      { schemaVersion: 'document-targeted-read@1', workspaceId: WORKSPACE, selections: [{ documentRef: parsed.originalRef }], cursor, maxBytes: 30, limit: 4 },
      CTX,
    )
    expect(second.items[0]?.text.length).toBeGreaterThan(0)
    expect(second.items[0]?.text).not.toBe(first.items[0]?.text)
  })
})

describe('every returned span is bound to its locator and digests', () => {
  it('binds the quote to the exact span the locator selects', async () => {
    const harnessed = harness()
    const parsed = await parsedTextDocument(harnessed)
    const clause = parsed.chunks.find((chunk) => chunk.text.startsWith('3.1 '))
    expect(clause).toBeDefined()
    if (clause === undefined) return

    const result = await harnessed.reader.read(
      {
        schemaVersion: 'document-targeted-read@1',
        workspaceId: WORKSPACE,
        selections: [{ documentRef: parsed.originalRef, locator: clause.locator, parseId: parsed.parseId }],
        maxBytes: 4096,
        limit: 4,
      },
      CTX,
    )
    const item = result.items[0]
    expect(item?.text).toBe(clause.text)
    expect(item?.parserVersion).toBe(parsed.parserVersion)
    expect(item?.truncated).toBe(false)
    expect(item?.quoteDigest).toBe(sha256DigestOfText(clause.text))
    expect(item?.textDigest).toBe(item?.quoteDigest)
  })

  it('reports an unavailable selection explicitly rather than as empty success', async () => {
    const harnessed = harness()
    await parsedTextDocument(harnessed)
    const unknown = { id: '88888888-8888-4888-8888-888888888888', version: '1.0.0', digest: sha256DigestOfBytes(new TextEncoder().encode('nope')), kind: 'document' as const }

    const result = await harnessed.reader.read(
      { schemaVersion: 'document-targeted-read@1', workspaceId: WORKSPACE, selections: [{ documentRef: unknown }], maxBytes: 64, limit: 4 },
      CTX,
    )
    expect(result.items[0]?.indexState).toBe('unavailable')
    expect(result.items[0]?.unavailableReason).toBe('not_authorized')
    expect(result.items[0]?.text).toBe('')
  })
})

describe('the targeted-read service validates at the boundary', () => {
  it('delegates a well-formed request and rejects a malformed one', async () => {
    const harnessed = harness()
    const parsed = await parsedTextDocument(harnessed)
    const service = new DocumentTargetedReadService({ reader: harnessed.reader })

    const ok = await service.read(
      { schemaVersion: 'document-targeted-read@1', workspaceId: WORKSPACE, selections: [{ documentRef: parsed.originalRef }], maxBytes: 64, limit: 4 },
      CTX,
    )
    expect(ok.schemaVersion).toBe('document-targeted-read-result@1')

    await expect(
      service.read(
        { schemaVersion: 'document-targeted-read@1', workspaceId: WORKSPACE, selections: [], maxBytes: 64, limit: 4 },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
