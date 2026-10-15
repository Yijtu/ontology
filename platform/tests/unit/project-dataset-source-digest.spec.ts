import { describe, expect, it } from 'vitest'
import { sha256DigestOf } from '@ontology/core'
import { assertProjectDatasetSnapshotShape, isProjectDatasetSourceOriginDigest, PROJECT_DATASET_SOURCE_ORIGIN_DIGEST_VERSION } from '@ontology/contracts'
import type { ProjectDatasetSnapshot } from '@ontology/contracts'

const id = '11111111-1111-4111-8111-111111111111'
const digest = sha256DigestOf('source-digest-contract')

function snapshot(columnName: string): ProjectDatasetSnapshot {
  return {
    ref: { id, version: '1.0.0', digest, kind: 'dataset' },
    body: {
      schemaVersion: 'project-dataset-snapshot@1', projectId: id, objectId: 'machine', projectRevision: '1', datasetRevision: '1',
      definitionRef: { id, version: '1.0.0', digest }, mappingRefs: [], backend: 'postgres',
      columns: [{ name: columnName, valueType: 'string' }], rows: [],
      coverage: { expectedCount: 0, processedCount: 0, excluded: [], completeness: 'complete' }, recordedAt: '2026-10-10T00:00:00.000Z',
    },
  }
}

describe('compact project dataset source pins', () => {
  it.each(['sources_full_json', 'SOURCES_FULL_JSON', 'Sources_Full_Json'])('reserves the adapter-private source column %s case-insensitively', (name) => {
    expect(() => assertProjectDatasetSnapshotShape(snapshot(name))).toThrow(/reserved names/u)
  })

  it('accepts only the closed versioned record and full-source digest body', () => {
    const token = { schemaVersion: PROJECT_DATASET_SOURCE_ORIGIN_DIGEST_VERSION, recordId: id, sourcesDigest: digest }
    expect(isProjectDatasetSourceOriginDigest(token)).toBe(true)
    expect(isProjectDatasetSourceOriginDigest({ ...token, extra: 'unbound' })).toBe(false)
    expect(isProjectDatasetSourceOriginDigest({ ...token, schemaVersion: 'project-dataset-source-origins@99' })).toBe(false)
    expect(isProjectDatasetSourceOriginDigest({ ...token, recordId: 'not-a-uuid' })).toBe(false)
    expect(isProjectDatasetSourceOriginDigest({ ...token, sourcesDigest: 'sha256:short' })).toBe(false)
  })
})
