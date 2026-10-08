import { canonicalJson, sha256DigestOf } from '@ontology/application'
import type { ProjectDatasetRow, ProjectMappingStore, ProjectPublishedDatasetSource, ProjectRecordStore } from '@ontology/contracts'

/** A controlled publication-port fixture for unit/UI projection tests; no production truth bridge. */
export function controlledPublishedDatasetSource(records: ProjectRecordStore, mappings: ProjectMappingStore): ProjectPublishedDatasetSource {
  return { async read(scope, revision, objectId, ctx) {
    const rows: ProjectDatasetRow[] = []
    const excluded: { recordId: string; reason: string }[] = []
    let cursor: string | undefined
    do {
      const page = await records.listRecords(scope, revision.ref.projectId, { objectId, limit: 250, ...(cursor === undefined ? {} : { cursor }) }, ctx)
      for (const record of page.records) {
        if (record.status !== 'confirmed') { excluded.push({ recordId: record.recordId, reason: `status:${record.status}` }); continue }
        const mapping = await mappings.getMapping(scope, revision.ref.projectId, record.mappingId, record.mappingVersion, ctx)
        if (mapping === undefined) throw new Error('the controlled publication fixture has no mapping')
        rows.push({ recordId: record.recordId, objectId, sourceRowKey: record.sourceRowKey,
          values: Object.fromEntries(record.fields.map((field) => [field.fieldId, field.normalized])),
          sources: record.fields.map((field) => ({ fieldId: field.fieldId, documentRef: mapping.originalRef, parseId: mapping.parseId, locator: field.locator })) })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    rows.sort((a, b) => a.recordId.localeCompare(b.recordId))
    return { rows, coverage: { expectedCount: rows.length + excluded.length, processedCount: rows.length, excluded, completeness: excluded.length === 0 ? 'complete' : 'partial' },
      factRecordedPoint: { semantic: '1', identity: '1' }, sourceDigest: sha256DigestOf(canonicalJson({ rows, excluded })) }
  } }
}
