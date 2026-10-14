import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryStructuredIngestionStore, LocalStructuredIngestionService, StructuredClauseSourceReader } from '@ontology/adapter-extraction-document'
import type { StructuredCandidateSourceSpan, StructuredIngestionStore, StructuredParseRecord } from '@ontology/contracts'
import { createTestToolContext, InMemoryArtifactStore } from '../fixtures/documents/test-doubles'

const scope = { tenantId: '11111111-1111-4111-8111-111111111111', spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
const ctx = createTestToolContext(scope.tenantId, scope.spaceId)
const foreignCtx = createTestToolContext(scope.tenantId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

async function fixture(options: Record<string, unknown> | undefined = { headerRow: 1 }) {
  const blobs = new InMemoryArtifactStore()
  const tables = new InMemoryStructuredIngestionStore()
  const bytes = new TextEncoder().encode('name,cost\nA,0.10\nB,0.20\n')
  const staged = await blobs.stage(bytes, { scopeRef: scope }, ctx)
  const originalRef = (await blobs.publish({ scopeRef: scope, ...staged, mediaType: 'text/csv', purpose: 'document' }, ctx)).blobRef
  const { parse } = await new LocalStructuredIngestionService({ blobs, store: tables }).parse({ scopeRef: scope, originalRef, options }, ctx)
  const rows = await tables.listRecords(scope, parse.parseId, { limit: 100 }, ctx)
  const row = rows.records[1]
  if (row === undefined) throw new Error('fixture produced no second row')
  const span: StructuredCandidateSourceSpan = { kind: 'structured', parseId: parse.parseId, recordId: row.recordId,
    sourceRowKey: row.sourceRowKey, locator: row.locator, rowDigest: row.rowDigest }
  const reader = new StructuredClauseSourceReader({ artifacts: blobs, ingestion: tables })
  return { blobs, tables, parse, span, reader }
}

describe('authored structured rule-clause source reader', () => {
  it('re-reads the exact row and reports a fingerprint matching the span row digest', async () => {
    const h = await fixture()
    const read = await h.reader.read(h.span, ctx)
    expect(read).toBeDefined()
    expect(read?.documentRef).toEqual(h.parse.originalRef)
    expect(read?.parserVersion).toBe(h.parse.parserVersion)
    expect(read?.rowText).toContain('B')
    const digest = `sha256:${createHash('sha256').update(new TextEncoder().encode(read?.rowText ?? '')).digest('hex')}`
    expect(digest).toBe(h.span.rowDigest)
  })

  it('fails closed when the parse recorded no options, the scope differs, the original is tampered, or the row is gone', async () => {
    const h = await fixture()
    const stripped: Pick<StructuredIngestionStore, 'getParse'> = { getParse: async (scopeRef, parseId, context) => {
      const parse = await h.tables.getParse(scopeRef, parseId, context)
      if (parse === undefined) return undefined
      const { parseOptions: dropped, ...rest } = parse
      void dropped
      return rest as StructuredParseRecord
    } }
    expect(await new StructuredClauseSourceReader({ artifacts: h.blobs, ingestion: stripped }).read(h.span, ctx)).toBeUndefined()
    expect(await h.reader.read(h.span, foreignCtx)).toBeUndefined()
    const tampered = {
      getAuthorized: h.blobs.getAuthorized.bind(h.blobs),
      readAuthorized: async (request: Parameters<InMemoryArtifactStore['readAuthorized']>[0], context: typeof ctx) => {
        const original = await h.blobs.readAuthorized(request, context)
        const copy = new Uint8Array(original)
        copy[0] = (copy[0] ?? 0) ^ 0xff
        return copy
      },
    }
    expect(await new StructuredClauseSourceReader({ artifacts: tampered, ingestion: h.tables }).read(h.span, ctx)).toBeUndefined()
    const ghostSpan: StructuredCandidateSourceSpan = { ...h.span, recordId: randomUUID() }
    expect(await h.reader.read(ghostSpan, ctx)).toBeUndefined()
  })
})
