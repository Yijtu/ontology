import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  VERIFIED_RESULT_EXPORT_SCHEMA_VERSION,
  RESULT_HISTORY_SCHEMA_VERSION,
  isResultHistoryView,
  isVerifiedResultExport,
} from '@ontology/contracts'

/**
 * V03-041 (#214): the wire guards for the structured JSON export and the result history.
 * They reject a malformed payload so a browser reader never trusts a TypeScript assertion.
 */

const DIGEST = `sha256:${'a'.repeat(64)}`
const REF = { id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'artifact' }

function validExport(): Record<string, unknown> {
  return {
    schemaVersion: VERIFIED_RESULT_EXPORT_SCHEMA_VERSION,
    exportedAt: '2026-09-30T00:00:00Z',
    status: {
      publicationKind: 'verified',
      domainStatus: 'known',
      dataMode: 'observed',
      currentValidity: { state: 'current' },
      coverage: { returned: 1, truncated: false },
      limitations: [],
    },
    versions: {
      answerId: randomUUID(),
      runId: randomUUID(),
      contentHash: DIGEST,
      verificationId: randomUUID(),
      resultManifestRef: REF,
      resultManifestDigest: DIGEST,
      executionBindingRef: REF,
      finalizationReceiptRef: REF,
      finalizationReceiptDigest: DIGEST,
    },
    tables: [],
    sourceIndex: [],
  }
}

describe('verified result export guard', () => {
  it('accepts a well-formed export', () => {
    expect(isVerifiedResultExport(validExport())).toBe(true)
  })

  it('rejects a wrong schema version, a missing answer id and a non-array source index', () => {
    expect(isVerifiedResultExport({ ...validExport(), schemaVersion: 'verified-result-export@0' })).toBe(false)
    const exportMissing = validExport()
    const versions = { ...(exportMissing['versions'] as Record<string, unknown>) }
    delete versions['answerId']
    exportMissing['versions'] = versions
    expect(isVerifiedResultExport(exportMissing)).toBe(false)
    expect(isVerifiedResultExport({ ...validExport(), sourceIndex: {} })).toBe(false)
  })
})

describe('result history guard', () => {
  it('accepts a well-formed history and rejects a bad read kind', () => {
    const entry = {
      answerId: randomUUID(),
      runId: randomUUID(),
      revisionIndex: 1,
      contentHash: DIGEST,
      evidenceManifestHash: DIGEST,
      scenarioManifestHash: DIGEST,
      publicationKind: 'verified',
      publishedAt: '2026-09-30T00:00:00Z',
      readKind: 'fixed_version',
      label: '固定版本回读',
    }
    const view = {
      schemaVersion: RESULT_HISTORY_SCHEMA_VERSION,
      logicalKey: randomUUID(),
      currentAnswerId: entry.answerId,
      entries: [entry],
    }
    expect(isResultHistoryView(view)).toBe(true)
    expect(isResultHistoryView({ ...view, entries: [{ ...entry, readKind: 'recompute' }] })).toBe(false)
    expect(isResultHistoryView({ ...view, schemaVersion: 'result-history@0' })).toBe(false)
  })
})
