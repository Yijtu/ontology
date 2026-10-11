import { expect, it, vi } from 'vitest'
import { InMemoryDocumentParseStore, InMemoryStructuredIngestionStore, LocalStructuredIngestionService, STRUCTURED_PROJECTION_MAX_MAP_BYTES, StructuredDocumentProjectionService, StructuredDocumentSpanReader } from '@ontology/adapter-extraction-document'
import { createTestToolContext, InMemoryArtifactStore } from '../fixtures/documents/test-doubles'
import { isRecord, isStructuredParseSelection } from '@ontology/contracts'

it('refuses unknown or script-like native selection fields rather than coercing them', () => {
  expect(isStructuredParseSelection({ sheetName: 'Chosen', headerRow: 2, delimiter: ';' })).toBe(true)
  expect(isStructuredParseSelection({ script: 'anything' })).toBe(false)
  expect(isStructuredParseSelection({ delimiter: [';'] })).toBe(false)
  expect(isStructuredParseSelection({ caps: { maxRows: '1000' } })).toBe(false)
  expect(isStructuredParseSelection(new Date())).toBe(false)
})

it('bounds a wide table source map and accounts for every excluded row', async () => {
  const scope = { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  const ctx = createTestToolContext(scope.tenantId, scope.spaceId)
  const blobs = new InMemoryArtifactStore()
  const ingestion = new InMemoryStructuredIngestionStore()
  const parses = new InMemoryDocumentParseStore()
  const columns = Array.from({ length: 128 }, (_, index) => `column${index}`)
  const bytes = new TextEncoder().encode(columns.join(',') + '\n' + Array.from({ length: 200 }, () => columns.map(() => 'x').join(',')).join('\n'))
  const staged = await blobs.stage(bytes, { scopeRef: scope }, ctx)
  const original = await blobs.publish({ scopeRef: scope, contentDigest: staged.contentDigest, mediaType: 'text/csv', byteSize: bytes.byteLength, purpose: 'document' }, ctx)
  const parsed = await new LocalStructuredIngestionService({ blobs, store: ingestion }).parse({ scopeRef: scope, originalRef: original.blobRef, options: {} }, ctx)
  expect(parsed.parse.counts.succeeded).toBe(200)
  const projection = await new StructuredDocumentProjectionService({ blobs, parses, ingestion }).project(parsed.parse, ctx)
  expect(projection.coverage.completeness).toBe('truncated')
  expect(projection.coverage.parsedUnits).toBeLessThan(200)
  expect(projection.coverage.parsedUnits + projection.coverage.skippedUnits).toBe(200)
  expect((await blobs.readAuthorized({ scopeRef: scope, blobRef: projection.spanMapRef }, ctx)).byteLength).toBeLessThanOrEqual(STRUCTURED_PROJECTION_MAX_MAP_BYTES)
  expect(projection.normalizedByteSize).toBeLessThanOrEqual(1_048_576 + 100)
})

it('replays a projection after persisted JSON keys reorder but rejects an altered source pin', async () => {
  const scope = { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  const ctx = createTestToolContext(scope.tenantId, scope.spaceId)
  const blobs = new InMemoryArtifactStore()
  const ingestion = new InMemoryStructuredIngestionStore()
  const parses = new InMemoryDocumentParseStore()
  const bytes = new TextEncoder().encode('asset_id,value\nA,9\n')
  const staged = await blobs.stage(bytes, { scopeRef: scope }, ctx)
  const original = await blobs.publish({ scopeRef: scope, ...staged, mediaType: 'text/csv', purpose: 'document' }, ctx)
  const parsed = await new LocalStructuredIngestionService({ blobs, store: ingestion }).parse({ scopeRef: scope, originalRef: original.blobRef, options: { headerRow: 1 } }, ctx)
  const projection = await new StructuredDocumentProjectionService({ blobs, parses, ingestion }).project(parsed.parse, ctx)
  const chunk = (await parses.listChunks(scope, projection.parseId, ctx))[0]
  if (chunk === undefined) throw new Error('the actual CSV projection has no chunk')
  const lookup = ingestion.findParseByDigest.bind(ingestion)
  vi.spyOn(ingestion, 'findParseByDigest').mockImplementation(async (...args) => {
    const stored = await lookup(...args)
    if (stored === undefined) return undefined
    // PostgreSQL JSONB may reorder keys without changing the pinned source.
    return { ...stored, originalRef: { digest: stored.originalRef.digest, version: stored.originalRef.version, kind: stored.originalRef.kind, id: stored.originalRef.id } }
  })
  const reader = new StructuredDocumentSpanReader({ blobs, parses, ingestion })
  const request = { documentRef: original.blobRef, locator: chunk.locator }
  expect((await reader.readOrigin(request, ctx))?.originalRef).toEqual(original.blobRef)
  expect((await reader.readSpan(request, ctx)).text).toContain('"A","9"')

  const saved: unknown = JSON.parse(new TextDecoder().decode(await blobs.readAuthorized({ scopeRef: scope, blobRef: projection.spanMapRef }, ctx)))
  if (!isRecord(saved)) throw new Error('the actual saved projection map is malformed')
  const alteredBytes = new TextEncoder().encode(JSON.stringify({ ...saved, originalRef: { ...original.blobRef, version: '99.0.0' } }))
  const alteredStage = await blobs.stage(alteredBytes, { scopeRef: scope }, ctx)
  const altered = await blobs.publish({ scopeRef: scope, ...alteredStage, mediaType: projection.spanMapMediaType, purpose: 'artifact' }, ctx)
  vi.spyOn(parses, 'findParseByDigest').mockResolvedValueOnce({ ...projection, spanMapRef: altered.blobRef })
  await expect(reader.readOrigin({ ...request, locator: { ...chunk.locator, normalizationMapRef: altered.blobRef.digest } }, ctx)).rejects.toThrow('does not reproduce the pinned projection map')
})
