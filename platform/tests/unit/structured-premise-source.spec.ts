import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256DigestOfBytes, StructuredDocumentParser, StructuredPremiseSourceReader, reconcileStructuredResult } from '@ontology/adapter-extraction-document'
import type { CandidateRecord, EntityCandidate, ResourceRef, StructuredParseRecord, VersionRef } from '@ontology/contracts'
import type { ImportMappingVersion, StructuredCandidateSourceSpan } from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'

const scope = { tenantId: randomUUID(), spaceId: randomUUID() }
const ctx = toolContext(scope.tenantId, scope.spaceId)
const parserVersion = '1.0.0'
const bytes = new TextEncoder().encode('asset_code,inspection_due\nasset-code-1,false\n')

function ref(id: string, digest: string): ResourceRef {
  return { id, version: '1.0.0', digest, kind: 'document' }
}

async function fixture(input: { readonly candidateOriginal?: ResourceRef; readonly mappingOriginal?: ResourceRef; readonly cachedOriginal?: ResourceRef; readonly integrityVerified?: boolean } = {}) {
  const digest = sha256DigestOfBytes(bytes)
  const currentOriginal = input.mappingOriginal ?? ref(randomUUID(), digest)
  const candidateOriginal = input.candidateOriginal ?? currentOriginal
  const cachedOriginal = input.cachedOriginal ?? ref(randomUUID(), digest)
  const parseId = randomUUID()
  const projectId = randomUUID()
  const mappingId = randomUUID()
  const candidateId = randomUUID()
  const definitionRef: VersionRef = { id: 'premise-test-definition', version: '1.0.0', digest }
  const parsed = new StructuredDocumentParser().parse(bytes, { mediaType: 'text/csv', headerRow: 1 })
  if (parsed.status !== 'complete') throw new Error('test CSV did not parse completely')
  const reconciled = reconcileStructuredResult(parsed, scope, digest)
  const entry = reconciled.entries[0]
  const cell = parsed.tables[0]?.rows[0]?.cells[0]
  if (entry === undefined || cell === undefined) throw new Error('test CSV did not produce a located cell')
  const span: StructuredCandidateSourceSpan = { kind: 'structured', parseId, recordId: entry.recordId, sourceRowKey: entry.sourceRowKey, rowDigest: entry.rowDigest, locator: cell.locator }
  const mappingRef = { id: mappingId, version: '1.0.0', digest, role: 'catalog' as const,
    sourceObjectRef: { sourceRef: { namespace: 'premise-test', sourceId: 'original' }, objectPath: 'asset' } }
  const mapping: ImportMappingVersion = { schemaVersion: 'import-mapping@1', projectId, mappingId, version: '1.0.0', ref: mappingRef,
    definitionRef, format: 'csv', parseId, originalRef: currentOriginal, originalMediaType: 'text/csv', options: { headerRow: 1 }, objectId: 'asset', entries: [], digest,
    actor: 'test', recordedAt: '2026-10-11T00:00:00Z' }
  const candidate: CandidateRecord = { kind: 'entity', candidateId, jobId: randomUUID(), objectId: 'asset', nativeId: 'asset-code-1', attributes: [{ attributeId: 'asset_code', value: 'asset-code-1' }],
    sourceSpans: [span], deterministic: true, state: 'pending_review', issues: [], inputVersion: { projectFact: { sources: [{ projectRevisionRef: { projectId, revision: '1', digest }, definitionRef, mappingRef,
      recordId: entry.recordId, recordRevision: '1', contentDigest: digest, sourceDigest: digest, sourceRecordedAt: '2026-10-11T00:00:00Z', documentId: randomUUID(), parseId,
      membershipRevision: '1', visibilityEpoch: '1', entityCandidateId: candidateId }] }, definitionRef, parseId, parserVersion, pipelineVersion: '1.0.0', documentVersionRef: candidateOriginal },
    idempotencyKey: digest, recordedAt: '2026-10-11T00:00:00Z' } satisfies EntityCandidate
  const cachedParse: StructuredParseRecord = { parseId, scopeRef: scope, format: parsed.format, originalMediaType: 'text/csv', originalRef: cachedOriginal,
    parserId: 'ontology.structured-parser', parserVersion, parseOptions: { headerRow: 1 }, status: 'complete', coverage: parsed.coverage, counts: reconciled.counts,
    sheets: parsed.sheets, diagnostics: parsed.diagnostics, documentVersionRef: cachedOriginal, createdAt: '2026-10-11T00:00:00Z' }
  const reads: ResourceRef[] = []
  const reader = new StructuredPremiseSourceReader({
    mappings: { getMapping: async () => mapping },
    ingestion: { getParse: async (_scope, wanted) => wanted === parseId ? cachedParse : undefined },
    artifacts: {
      getAuthorized: async () => ({ integrityVerified: input.integrityVerified ?? true, byteSize: bytes.byteLength }),
      readAuthorized: async ({ blobRef }) => { reads.push(blobRef); return bytes },
    },
  })
  return { candidate, span, currentOriginal, cachedOriginal, reader, reads, mapping }
}

describe('StructuredPremiseSourceReader', () => {
  it('uses exact cached parse metadata but reads and returns the current mapping original', async () => {
    const f = await fixture()
    expect(f.cachedOriginal.id).not.toBe(f.currentOriginal.id)
    const result = await f.reader.read(f.candidate, f.span, ctx)
    expect(result).toMatchObject({ documentRef: f.currentOriginal, documentVersionRef: f.currentOriginal, parserVersion })
    expect(result?.rowText).toContain('asset-code-1')
    expect(f.reads).toEqual([f.currentOriginal])
  })

  it('rejects a candidate whose pinned document version is not the actual mapping original', async () => {
    const f = await fixture({ candidateOriginal: ref(randomUUID(), sha256DigestOfBytes(bytes)) })
    expect(await f.reader.read(f.candidate, f.span, ctx)).toBeUndefined()
    expect(f.reads).toEqual([])
  })

  it('rejects a cached parse with another content digest or an unreadable current original', async () => {
    const differentBytes = new TextEncoder().encode('asset_code,inspection_due\nother,false\n')
    const f = await fixture({ cachedOriginal: ref(randomUUID(), sha256DigestOfBytes(differentBytes)) })
    expect(await f.reader.read(f.candidate, f.span, ctx)).toBeUndefined()
    expect(f.reads).toEqual([])

    const unreadable = await fixture({ integrityVerified: false })
    expect(await unreadable.reader.read(unreadable.candidate, unreadable.span, ctx)).toBeUndefined()
    expect(unreadable.reads).toEqual([])
  })
})
