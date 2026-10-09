import { expect, it } from 'vitest'
import { InMemoryDocumentParseStore, InMemoryStructuredIngestionStore, LocalStructuredIngestionService, STRUCTURED_PROJECTION_MAX_MAP_BYTES, StructuredDocumentProjectionService } from '@ontology/adapter-extraction-document'
import { createTestToolContext, InMemoryArtifactStore } from '../fixtures/documents/test-doubles'

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
