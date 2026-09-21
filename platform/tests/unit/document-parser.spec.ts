import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DocumentExtractionError,
  DocumentSpanReader,
  InMemoryDocumentParseStore,
  LocalDocumentExtractionService,
  sha256DigestOfBytes,
} from '@ontology/adapter-extraction-document'
import type { OcrTextProvider } from '@ontology/adapter-extraction-document'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import {
  InMemoryArtifactStore,
  ScriptedOcrProvider,
  createTestToolContext,
  sha256Of,
} from '../fixtures/documents/test-doubles'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const SPACE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SCOPE_A: ScopeRef = { tenantId: TENANT_A, spaceId: SPACE_A }
const CTX: ToolContext = createTestToolContext(TENANT_A, SPACE_A)

const TEXT_DOCUMENT = [
  'SERVICE TERMS',
  '3.1 The service is provided on a best-effort basis.',
  'Condition: only when the customer account is active.',
  'Exception: outages caused by force majeure are excluded.',
  '3.2 Fees are invoiced monthly in arrears.',
  'Table 1: Rate schedule',
  'Tier A | 0.10 | 100',
  'Tier B | 0.20 | 250',
].join('\n')

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/documents/${name}`, import.meta.url))))
}

interface Harness {
  readonly blobs: InMemoryArtifactStore
  readonly store: InMemoryDocumentParseStore
  readonly service: LocalDocumentExtractionService
  readonly reader: DocumentSpanReader
}

function harness(ocr?: OcrTextProvider): Harness {
  const blobs = new InMemoryArtifactStore()
  const store = new InMemoryDocumentParseStore()
  const service = new LocalDocumentExtractionService({
    blobs,
    store,
    ...(ocr === undefined ? {} : { ocr }),
    now: () => '2026-09-21T00:00:00Z',
  })
  const reader = new DocumentSpanReader({ blobs, store, now: () => '2026-09-21T00:00:01Z' })
  return { blobs, store, service, reader }
}

async function ingest(
  harnessed: Harness,
  bytes: Uint8Array,
  mediaType: string,
): Promise<Awaited<ReturnType<LocalDocumentExtractionService['parse']>>> {
  const staged = await harnessed.blobs.stage(bytes, { scopeRef: SCOPE_A }, CTX)
  const published = await harnessed.blobs.publish(
    {
      scopeRef: SCOPE_A,
      contentDigest: staged.contentDigest,
      mediaType,
      byteSize: staged.byteSize,
      purpose: 'document',
    },
    CTX,
  )
  return harnessed.service.parse({ scopeRef: SCOPE_A, originalRef: published.blobRef }, CTX)
}

describe('plain text parsing', () => {
  it('round-trips a chunk span to the exact original bytes', async () => {
    const harnessed = harness()
    const bytes = new TextEncoder().encode(TEXT_DOCUMENT)
    const parsed = await ingest(harnessed, bytes, 'text/plain')

    expect(parsed.mediaKind).toBe('text')
    expect(parsed.offsetUnit).toBe('byte')
    expect(parsed.coverage.status).toBe('complete')
    expect(parsed.parserId).toBe('ontology.document-parser')
    expect(parsed.parserVersion).toBe('1.0.0')
    expect(parsed.reused).toBe(false)

    const clause = parsed.chunks.find((chunk) => chunk.text.startsWith('3.1 '))
    expect(clause).toBeDefined()
    if (clause === undefined) return
    expect(clause.chunkKind).toBe('clause')
    expect(clause.conditions).toEqual(['Condition: only when the customer account is active.'])
    expect(clause.exceptions).toEqual(['Exception: outages caused by force majeure are excluded.'])
    expect(clause.spanKind).toBe('verbatim')
    expect(clause.precision).toBe('exact')

    const read = await harnessed.reader.readSpan(
      { documentRef: parsed.originalRef, locator: clause.locator },
      CTX,
    )
    const expectedBytes = bytes.subarray(clause.locator.startOffset ?? 0, clause.locator.endOffset ?? 0)
    expect(read.text).toBe(new TextDecoder().decode(expectedBytes))
    expect(read.text).toBe(clause.text)
    expect(read.textDigest).toBe(clause.textDigest)
    expect(read.snapshot.consistency).toBe('immutable')
  })

  it('marks a bounded span read as truncated instead of silently shortening it', async () => {
    const harnessed = harness()
    const bytes = new TextEncoder().encode(TEXT_DOCUMENT)
    const parsed = await ingest(harnessed, bytes, 'text/plain')
    const clause = parsed.chunks.find((chunk) => chunk.text.startsWith('3.1 '))
    expect(clause).toBeDefined()
    if (clause === undefined) return

    const full = await harnessed.reader.readSpan(
      { documentRef: parsed.originalRef, locator: clause.locator },
      CTX,
    )
    expect(full.truncated).toBeUndefined()

    const bounded = await harnessed.reader.readSpan(
      { documentRef: parsed.originalRef, locator: clause.locator, maxBytes: 12 },
      CTX,
    )
    expect(bounded.truncated).toBe(true)
    expect(new TextEncoder().encode(bounded.text).byteLength).toBeLessThanOrEqual(12)
    expect(bounded.text.length).toBeLessThan(full.text.length)
  })

  it('keeps the original bytes unchanged after parsing', async () => {
    const harnessed = harness()
    const bytes = new TextEncoder().encode(TEXT_DOCUMENT)
    const digestBefore = sha256Of(bytes)
    const parsed = await ingest(harnessed, bytes, 'text/plain')

    const readBack = await harnessed.blobs.readAuthorized(
      { scopeRef: SCOPE_A, blobRef: parsed.originalRef },
      CTX,
    )
    expect(sha256DigestOfBytes(readBack)).toBe(digestBefore)
    expect(new TextDecoder().decode(readBack)).toBe(TEXT_DOCUMENT)
    expect(parsed.originalRef.digest).toBe(digestBefore)
    const references = harnessed.blobs.referencesFor(SCOPE_A, parsed.originalRef.digest)
    expect(references.some((reference) => reference.purpose === 'document')).toBe(true)
    // The normalized text is a genuinely separate derived artifact.
    expect(parsed.normalizedRef.digest).not.toBe(parsed.originalRef.digest)
    const derived = harnessed.blobs.referencesFor(SCOPE_A, parsed.normalizedRef.digest)
    expect(
      derived.some(
        (reference) => reference.purpose === 'artifact' && reference.origin.kind === 'normalized_text',
      ),
    ).toBe(true)
  })

  it('reuses one logical parse for a duplicate upload and shares lineage', async () => {
    const harnessed = harness()
    const bytes = new TextEncoder().encode(TEXT_DOCUMENT)
    const first = await ingest(harnessed, bytes, 'text/plain')
    const second = await ingest(harnessed, bytes, 'text/plain')

    expect(second.reused).toBe(true)
    expect(second.parseId).toBe(first.parseId)
    expect(second.chunks).toHaveLength(first.chunks.length)

    const lineage = harnessed.blobs.lineageOf(SCOPE_A, first.originalRef.digest)
    expect(lineage).toBeDefined()
    const documentReferences = harnessed.blobs
      .referencesFor(SCOPE_A, first.originalRef.digest)
      .filter((reference) => reference.purpose === 'document')
    expect(documentReferences).toHaveLength(2)
  })
})

describe('real PDF parsing', () => {
  it('extracts text, detects a heading by font size and preserves clause context', async () => {
    const harnessed = harness()
    const parsed = await ingest(harnessed, fixture('service-terms.pdf'), 'application/pdf')

    expect(parsed.mediaKind).toBe('pdf')
    expect(parsed.offsetUnit).toBe('character')
    expect(parsed.coverage).toMatchObject({
      status: 'complete',
      completeness: 'complete',
      totalUnits: 2,
      parsedUnits: 2,
      skippedUnits: 0,
    })
    expect(parsed.chunks.map((chunk) => chunk.chunkKind)).toEqual([
      'section',
      'clause',
      'clause',
      'table',
    ])

    const section = parsed.chunks[0]
    expect(section?.text).toBe('3. Service Terms')
    expect(section?.spanKind).toBe('normalized')

    const clause = parsed.chunks[1]
    expect(clause?.text).toContain('3.1 The service is provided on a best-effort basis.')
    expect(clause?.conditions).toEqual(['Condition: only when the customer account is active.'])
    expect(clause?.exceptions).toEqual([
      'Exception: outages caused by force majeure are excluded.',
    ])

    const table = parsed.chunks[3]
    expect(table?.caption).toBe('Table 1: Rate schedule')
    expect(table?.tableHeader).toBe('Tier A | 0.10 | 100')
    expect(table?.text).toContain('Tier C | 0.35 | 500')
  })

  it('parses a FlateDecode-compressed content stream', async () => {
    const harnessed = harness()
    const parsed = await ingest(harnessed, fixture('compressed-service-terms.pdf'), 'application/pdf')

    expect(parsed.coverage.status).toBe('complete')
    expect(parsed.chunks.some((chunk) => chunk.text.includes('Compressed clause body'))).toBe(true)
  })

  it('reads a page span back to the exact chunk text', async () => {
    const harnessed = harness()
    const parsed = await ingest(harnessed, fixture('service-terms.pdf'), 'application/pdf')
    const clause = parsed.chunks.find((chunk) => chunk.chunkKind === 'clause' && chunk.text.startsWith('3.1 '))
    expect(clause).toBeDefined()
    if (clause === undefined) return

    const read = await harnessed.reader.readSpan(
      { documentRef: parsed.originalRef, locator: clause.locator },
      CTX,
    )
    expect(read.text).toBe(clause.text)
    expect(read.snapshot.resultDigest).toBe(parsed.normalizedRef.digest)
    expect(clause.locator.normalizationMapRef).toBe(parsed.spanMapRef.digest)
  })

  it('reports a partway failure as partial, never as complete', async () => {
    const harnessed = harness()
    const parsed = await ingest(harnessed, fixture('broken-page-2.pdf'), 'application/pdf')

    expect(parsed.coverage.status).toBe('partial')
    expect(parsed.coverage.completeness).toBe('partial')
    expect(parsed.coverage.totalUnits).toBe(2)
    expect(parsed.coverage.parsedUnits).toBe(1)
    expect(parsed.coverage.skippedUnits).toBe(1)
    expect(parsed.coverage.skippedReasons.join(' ')).toContain('page 2')
    expect(parsed.chunks.some((chunk) => chunk.text.includes('Readable first page clause'))).toBe(true)
  })

  it('refuses an image-only page when no OCR provider is configured', async () => {
    const harnessed = harness()
    await expect(
      ingest(harnessed, fixture('scanned-notice.pdf'), 'application/pdf'),
    ).rejects.toMatchObject({ code: 'DOCUMENT_PARSE_FAILED' })
  })

  it('marks OCR-recovered spans as approximate, never exact', async () => {
    const harnessed = harness(
      new ScriptedOcrProvider(new Map([[1, '1.1 Scanned notice clause.\nCondition: only when scanned.']])),
    )
    const parsed = await ingest(harnessed, fixture('scanned-notice.pdf'), 'application/pdf')

    expect(parsed.coverage.status).toBe('complete')
    expect(parsed.coverage.notes.join(' ')).toContain('OCR')
    expect(parsed.pages[0]?.approximate).toBe(true)

    const clause = parsed.chunks[0]
    expect(clause?.precision).toBe('approximate')
    expect(clause?.spanKind).toBe('approximate')
    expect(clause?.locator.kind).toBe('approximate_locator')
    expect(clause?.conditions).toEqual(['Condition: only when scanned.'])
  })
})

describe('parser versioning', () => {
  it('treats a different parser version as a new logical parse', async () => {
    const harnessed = harness()
    const bytes = new TextEncoder().encode(TEXT_DOCUMENT)
    const staged = await harnessed.blobs.stage(bytes, { scopeRef: SCOPE_A }, CTX)
    const published = await harnessed.blobs.publish(
      {
        scopeRef: SCOPE_A,
        contentDigest: staged.contentDigest,
        mediaType: 'text/plain',
        byteSize: staged.byteSize,
        purpose: 'document',
      },
      CTX,
    )
    const originalRef = published.blobRef

    const first = await harnessed.service.parse(
      { scopeRef: SCOPE_A, originalRef, parserVersion: '1.0.0' },
      CTX,
    )
    const second = await harnessed.service.parse(
      { scopeRef: SCOPE_A, originalRef, parserVersion: '1.1.0' },
      CTX,
    )
    expect(first.reused).toBe(false)
    expect(second.reused).toBe(false)
    expect(second.parserVersion).toBe('1.1.0')
    expect(second.parseId).not.toBe(first.parseId)

    const replay = await harnessed.service.parse(
      { scopeRef: SCOPE_A, originalRef, parserVersion: '1.1.0' },
      CTX,
    )
    expect(replay.reused).toBe(true)
    expect(replay.parseId).toBe(second.parseId)
  })

  it('refuses a span whose normalization map does not belong to the parse', async () => {
    const harnessed = harness()
    const parsed = await ingest(harnessed, fixture('service-terms.pdf'), 'application/pdf')
    const clause = parsed.chunks[1]
    expect(clause).toBeDefined()
    if (clause === undefined) return
    const tampered = { ...clause.locator, normalizationMapRef: `sha256:${'b'.repeat(64)}` }
    await expect(
      harnessed.reader.readSpan({ documentRef: parsed.originalRef, locator: tampered }, CTX),
    ).rejects.toMatchObject({ code: 'SPAN_OUT_OF_RANGE' })
  })
})

describe('parse store visibility', () => {
  it('does not expose a parse to another tenant', async () => {
    const harnessed = harness()
    const parsed = await ingest(harnessed, new TextEncoder().encode(TEXT_DOCUMENT), 'text/plain')
    const otherTenant = createTestToolContext(
      '22222222-2222-4222-8222-222222222222',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    )
    const clause = parsed.chunks[0]
    expect(clause).toBeDefined()
    if (clause === undefined) return
    await expect(
      harnessed.reader.readSpan({ documentRef: parsed.originalRef, locator: clause.locator }, otherTenant),
    ).rejects.toBeInstanceOf(DocumentExtractionError)
  })
})
