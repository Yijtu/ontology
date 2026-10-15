import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_PAGE_ROWS,
  decodeTableReadCursor,
  encodeTableReadCursor,
  isTableArtifactManifest,
  isTableArtifactPageBody,
  isTableReadCursor,
  isTableVerificationReceipt,
  tableArtifactContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  ResourceRef,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableColumnDescriptor,
  TableReadCursor,
  TableVerificationReceipt,
} from '@ontology/contracts'

/**
 * V03-032 (#203): the table artifact manifest, the immutable page body and the fixed-revision
 * paginated read cursor. Runtime guards are proven here (not just TypeScript), and the page
 * body is proven separate from the read envelope so a page never points back at the parent
 * result manifest that references it.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`
const ANSWER_ID = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'

const versionRef = { id: 'output.schema', version: '1.0.0', digest: DIGEST }
const artifactRef: ResourceRef = { id: '4f2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', version: '1.0.0', digest: DIGEST, kind: 'artifact' }

const columns: readonly TableColumnDescriptor[] = [
  { columnRef: 'amount', semanticPredicate: 'energy.amount', valueType: 'quantity', schemaPointer: '/properties/amount', requiredContextPointers: ['unitPointer'] },
  { columnRef: 'site', semanticPredicate: 'site.id', valueType: 'entity_ref', schemaPointer: '/properties/site' },
]

function pageBody(pageIndex: number, rowKeys: readonly string[]): TableArtifactPageBody {
  return {
    schemaVersion: 'table-artifact-page@1',
    tableId: 'table.energy',
    outputSchemaRef: versionRef,
    pageIndex,
    columnRefs: ['amount', 'site'],
    rowKeyOrder: 'ascending',
    rows: rowKeys.map((rowKey) => ({
      rowKey,
      cells: { amount: '10.5', site: 'site-1' },
      bindings: [
        { rowKey, columnRef: 'amount', evidenceRef: artifactRef, resultDigest: DIGEST, valuePointer: '/amount', subjectPointer: '/site', unitPointer: '/unit' },
        { rowKey, columnRef: 'site', evidenceRef: artifactRef, resultDigest: DIGEST, valuePointer: '/site', subjectPointer: '/site' },
      ],
    })),
    coverage: { returned: rowKeys.length, truncated: false },
  }
}

function manifestFor(pages: readonly { body: TableArtifactPageBody }[]): TableArtifactManifest {
  return {
    schemaVersion: 'table-artifact-manifest@1',
    tableId: 'table.energy',
    outputSchemaRef: versionRef,
    columns,
    totalRows: pages.reduce((total, page) => total + page.body.rows.length, 0),
    rowKeyOrder: 'ascending',
    pages: pages.map((page) => ({
      pageIndex: page.body.pageIndex,
      artifactRef: { ...artifactRef, digest: tableArtifactContentDigest(page.body) },
      artifactDigest: tableArtifactContentDigest(page.body),
      rowCount: page.body.rows.length,
      firstRowKey: page.body.rows[0]?.rowKey ?? '',
      lastRowKey: page.body.rows[page.body.rows.length - 1]?.rowKey ?? '',
      pageCoverageDigest: tablePageCoverageDigest(page.body),
    })),
    coverage: { returned: 2, truncated: false },
    complete: true,
  }
}

describe('v0.3 table artifact manifest and page body', () => {
  it('accepts a well-formed manifest and page body', () => {
    const page = pageBody(0, ['r-001', 'r-002'])
    expect(isTableArtifactPageBody(page)).toBe(true)
    expect(isTableArtifactManifest(manifestFor([{ body: page }]))).toBe(true)
  })

  it('rejects a page with more rows than the frozen page size', () => {
    const rows = Array.from({ length: MAX_TABLE_PAGE_ROWS + 1 }, (_value, index) => `r-${String(index).padStart(4, '0')}`)
    const page = pageBody(0, rows)
    expect(isTableArtifactPageBody(page)).toBe(false)
  })

  it('rejects a manifest over the column cap but accepts exactly the cap', () => {
    const page = pageBody(0, ['r-001'])
    const manifest = manifestFor([{ body: page }])
    const extra: TableColumnDescriptor[] = Array.from({ length: MAX_TABLE_COLUMNS }, (_value, index) => ({
      columnRef: `c-${index}`,
      semanticPredicate: 'p',
      valueType: 'string',
      schemaPointer: '/properties/x',
    }))
    const over: TableArtifactManifest = { ...manifest, columns: [...manifest.columns, ...extra] }
    expect(over.columns.length).toBeGreaterThan(MAX_TABLE_COLUMNS)
    expect(isTableArtifactManifest(over)).toBe(false)
    const capped: TableArtifactManifest = {
      ...manifest,
      columns: [...manifest.columns, ...extra].slice(0, MAX_TABLE_COLUMNS),
    }
    expect(capped.columns.length).toBe(MAX_TABLE_COLUMNS)
    expect(isTableArtifactManifest(capped)).toBe(true)
  })

  it('proves the page body does not reference its parent result manifest', () => {
    expectTypeOf<TableArtifactPageBody>().not.toHaveProperty('resultManifestRef')
    expectTypeOf<TableArtifactPageBody>().toHaveProperty('tableId')
    expectTypeOf<TableArtifactPageBody>().toHaveProperty('pageIndex')
  })

  it('accepts a table verification receipt that is not counted into the body', () => {
    const receipt: TableVerificationReceipt = {
      schemaVersion: 'table-verification-receipt@1',
      draftHash: DIGEST,
      resultManifestRef: artifactRef,
      resultManifestDigest: DIGEST_B,
      tableId: 'table.energy',
      pageDigests: [DIGEST],
      checkedRows: 2,
      expectedRows: 2,
      checkedCells: 4,
      expectedCells: 4,
      checksDigest: DIGEST,
      policyVersion: 'table-verification-policy@1',
    }
    expect(isTableVerificationReceipt(receipt)).toBe(true)
    expectTypeOf<TableArtifactPageBody>().not.toHaveProperty('verificationReceiptRef')
  })
})

describe('v0.3 fixed-revision table read cursor', () => {
  function cursor(overrides: Partial<TableReadCursor> = {}): TableReadCursor {
    return {
      version: 1,
      answerId: ANSWER_ID,
      tableId: 'table.energy',
      resultManifestRef: artifactRef,
      resultManifestDigest: DIGEST,
      scopeDigest: DIGEST_B,
      pageIndex: 1,
      lastRowKey: 'r-001',
      ...overrides,
    }
  }

  it('round-trips through its opaque encoding', () => {
    const encoded = encodeTableReadCursor(cursor())
    const decoded = decodeTableReadCursor(encoded)
    expect(decoded).toEqual(cursor())
    expect(isTableReadCursor(decoded)).toBe(true)
  })

  it('rejects a malformed cursor instead of guessing a position', () => {
    const encoded = Buffer.from(JSON.stringify({ version: 2, pageIndex: 1 }), 'utf8').toString('base64url')
    expect(() => decodeTableReadCursor(encoded)).toThrowError(/cursor/i)
    expect(() => decodeTableReadCursor('not-base64-json')).toThrowError(/cursor/i)
  })
})
