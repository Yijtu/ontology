import { describe, expect, it } from 'vitest'
import {
  TABLE_HARD_VERIFICATION_POLICY_VERSION,
  TABLE_VERIFICATION_RECEIPT_SCHEMA_VERSION,
  isTableArtifactPageBody,
  isTableHardVerificationReport,
  isTableHardVerificationRequest,
  isTableVerificationProgress,
  tableArtifactContentDigest,
  tableManifestContentDigest,
  tablePageCoverageDigest,
} from '@ontology/contracts'
import type {
  ResourceRef,
  TableArtifactManifest,
  TableArtifactPageBody,
  TableColumnDescriptor,
  TableHardVerificationReport,
  TableVerificationProgress,
} from '@ontology/contracts'

/**
 * V03-033 (#204): the batched full-table hard-verification report, progress and request
 * runtime guards, plus the manifest content digest that makes a tampered manifest detectable.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

const versionRef = { id: 'output.schema', version: '1.0.0', digest: DIGEST }
const artifactRef: ResourceRef = { id: '4f2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', version: '1.0.0', digest: DIGEST, kind: 'artifact' }

const columns: readonly TableColumnDescriptor[] = [
  { columnRef: 'amount', semanticPredicate: 'energy.amount', valueType: 'quantity', schemaPointer: '/properties/amount', requiredContextPointers: ['unitPointer'] },
]

function body(): TableArtifactPageBody {
  return {
    schemaVersion: 'table-artifact-page@1',
    tableId: 'table.energy',
    outputSchemaRef: versionRef,
    pageIndex: 0,
    columnRefs: ['amount'],
    rowKeyOrder: 'ascending',
    rows: [
      {
        rowKey: 'site-1',
        subject: 'site-1',
        cells: { amount: { value: '10.5', unit: 'kWh' } },
        bindings: [
          { rowKey: 'site-1', columnRef: 'amount', evidenceRef: artifactRef, resultDigest: DIGEST, valuePointer: '/amount', subjectPointer: '/site', fieldRefPointer: '/table/columns/0', unitPointer: '/table/columns/0/unit' },
        ],
      },
    ],
    coverage: { returned: 1, truncated: false },
  }
}

function manifest(): TableArtifactManifest {
  const page = body()
  const digest = tableArtifactContentDigest(page)
  return {
    schemaVersion: 'table-artifact-manifest@1',
    tableId: 'table.energy',
    outputSchemaRef: versionRef,
    columns,
    totalRows: 1,
    rowKeyOrder: 'ascending',
    pages: [
      {
        pageIndex: 0,
        artifactRef: { ...artifactRef, digest },
        artifactDigest: digest,
        rowCount: 1,
        firstRowKey: 'site-1',
        lastRowKey: 'site-1',
        pageCoverageDigest: tablePageCoverageDigest(page),
      },
    ],
    coverage: { returned: 1, truncated: false },
    complete: true,
  }
}

function report(): TableHardVerificationReport {
  return {
    schemaVersion: 'table-hard-verification-report@1',
    resultManifestRef: artifactRef,
    resultManifestDigest: DIGEST,
    draftHash: DIGEST_B,
    tableId: 'table.energy',
    status: 'pass',
    checkedRows: 1,
    checkedCells: 1,
    expectedRows: 1,
    expectedCells: 1,
    pageDigests: [tableArtifactContentDigest(body())],
    checksDigest: DIGEST,
    policyVersion: TABLE_HARD_VERIFICATION_POLICY_VERSION,
    findings: [],
  }
}

function progress(): TableVerificationProgress {
  return {
    schemaVersion: 'table-verification-progress@1',
    resultManifestRef: artifactRef,
    resultManifestDigest: DIGEST,
    tableId: 'table.energy',
    totalRows: 1,
    checkedRows: 1,
    checkedCells: 1,
    nextPageIndex: 1,
    nextRowInPage: 0,
    boundSubjects: ['site-1'],
    batches: [
      { batchIndex: 0, firstPageIndex: 0, lastPageIndex: 0, rowCount: 1, cellCount: 1, firstRowKey: 'site-1', lastRowKey: 'site-1' },
    ],
    checksDigest: DIGEST,
    updatedAt: '2026-09-30T00:00:00Z',
  }
}

describe('batched full-table hard-verification contracts', () => {
  it('accepts a well-formed report and rejects a tampered status/digest', () => {
    expect(isTableHardVerificationReport(report())).toBe(true)
    expect(isTableHardVerificationReport({ ...report(), status: 'maybe' })).toBe(false)
    expect(isTableHardVerificationReport({ ...report(), checksDigest: 'nope' })).toBe(false)
    expect(TABLE_VERIFICATION_RECEIPT_SCHEMA_VERSION).toBe('table-verification-receipt@1')
  })

  it('accepts well-formed progress and rejects a non-digest accumulator', () => {
    expect(isTableVerificationProgress(progress())).toBe(true)
    expect(isTableVerificationProgress({ ...progress(), boundSubjects: [42] })).toBe(false)
    expect(isTableVerificationProgress({ ...progress(), nextPageIndex: -1 })).toBe(false)
  })

  it('accepts a request whose manifest matches the declared digest', () => {
    const table = manifest()
    const request = {
      resultManifestRef: { ...artifactRef, digest: tableManifestContentDigest(table) },
      resultManifestDigest: tableManifestContentDigest(table),
      draftHash: DIGEST_B,
      tableId: 'table.energy',
      manifest: table,
    }
    expect(isTableHardVerificationRequest(request)).toBe(true)
    expect(isTableHardVerificationRequest({ ...request, manifest: { ...table, tableId: '' } })).toBe(false)
  })

  it('detects a tampered manifest through its content digest and allows the row subject', () => {
    const table = manifest()
    const digest = tableManifestContentDigest(table)
    expect(digest).toBe(tableManifestContentDigest(manifest()))
    const tampered: TableArtifactManifest = {
      ...table,
      pages: table.pages.map((page) => ({ ...page, artifactDigest: DIGEST_B })),
    }
    expect(tableManifestContentDigest(tampered)).not.toBe(digest)
    expect(isTableArtifactPageBody(body())).toBe(true)
  })
})
