// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { ImportMappingVersion, ProjectRecordVersion, ResourceRef } from '@ontology/contracts'
import { ProjectFactStaging } from '@ontology/app-web'
import type { ProjectSourceCatalogue } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true
const PROJECT = '10000000-0000-4000-8000-000000000001'
const DOCUMENT = '10000000-0000-4000-8000-000000000002'
const PARSE = '10000000-0000-4000-8000-000000000003'
const RECORD = '10000000-0000-4000-8000-000000000004'
const CANDIDATE = '10000000-0000-4000-8000-000000000005'
const JOB = '10000000-0000-4000-8000-000000000006'
const SHA = `sha256:${'a'.repeat(64)}`
const ORIGINAL: ResourceRef = { id: DOCUMENT, version: '1.0.0', digest: SHA, kind: 'document' }
const DEFINITION = { id: 'definition', version: '1.0.0', digest: SHA }
const MAPPING: ImportMappingVersion = {
  schemaVersion: 'import-mapping@1', projectId: PROJECT,
  mappingId: '10000000-0000-4000-8000-000000000007', version: '1.0.0',
  ref: { id: '10000000-0000-4000-8000-000000000007', version: '1.0.0', digest: SHA, role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'project-import', sourceId: DOCUMENT }, objectPath: 'asset' } },
  definitionRef: DEFINITION, format: 'csv', parseId: PARSE, originalRef: ORIGINAL,
  originalMediaType: 'text/csv', options: { headerRow: 1 }, objectId: 'asset', entries: [],
  digest: SHA, actor: 'reviewer', recordedAt: '2026-10-11T00:00:00Z',
}
const ROW: ProjectRecordVersion = {
  schemaVersion: 'project-record@1', projectId: PROJECT, recordId: RECORD, revision: '1',
  mappingId: MAPPING.mappingId, mappingVersion: MAPPING.version, objectId: 'asset',
  sourceRowKey: 'ASSET-001', sourceDigest: SHA, contentDigest: SHA,
  fields: [{ fieldId: 'asset_id', raw: 'ASSET-001', normalized: { kind: 'scalar', value: 'ASSET-001' }, status: 'confirmed',
    locator: { kind: 'table_cell', format: 'csv', recordIndex: 0, row: 2, column: 1, address: 'A2', normalizationMapRef: 'map-1' } }],
  status: 'confirmed', actor: 'reviewer', recordedAt: '2026-10-11T00:00:00Z',
}
const CATALOGUE: ProjectSourceCatalogue = {
  project: { projectId: PROJECT, title: 'Actual selected project', headRevision: '2', activeRevision: '2', state: 'draft',
    createdBy: 'reviewer', createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' },
  revision: { ref: { projectId: PROJECT, revision: '2', digest: SHA },
    industryPackRef: { id: 'pack', version: '1.0.0', digest: SHA }, definitionRef: DEFINITION,
    mappingRefs: [MAPPING.ref], profileRef: { id: 'profile', version: '1.0.0', snapshotHash: SHA },
    documentSetRef: { id: DOCUMENT, version: '1.0.0', digest: SHA, kind: 'artifact' },
    semanticPublicationRefs: [], sourceVisibilityEpoch: '1', changeReason: 'source mapped' },
  sources: [{ documentId: DOCUMENT, originalRef: ORIGINAL, parseRef: { id: PARSE, version: '1.0.0', digest: SHA, kind: 'artifact' },
    parseId: PARSE, precision: 'exact', kind: 'csv' }],
  objects: [],
}

function stagedResponse(): Response {
  return new Response(JSON.stringify({ data: { candidates: [{ candidateId: CANDIDATE, jobId: JOB, kind: 'entity', objectId: 'asset',
    attributes: [], sourceSpans: [{ kind: 'structured', parseId: PARSE }],
    inputVersion: { definitionRef: DEFINITION, projectFact: { sources: [{ documentId: DOCUMENT, recordId: RECORD,
      recordRevision: ROW.revision, projectRevisionRef: CATALOGUE.revision.ref }] } } }] } }),
  { status: 201, headers: { 'content-type': 'application/json' } })
}

async function pendingStage() {
  let requestSignal: AbortSignal | null | undefined
  let complete: (response: Response) => void = () => { throw new Error('the actual stage request has not started') }
  const client = new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: (input, init) => {
    expect(String(input)).toBe(`http://api.test/api/v1/core/projects/${PROJECT}/fact-candidates`)
    expect(JSON.parse(String(init?.body))).toEqual({ documentId: DOCUMENT, recordRefs: [{ recordId: RECORD, revision: '1' }] })
    requestSignal = init?.signal
    return new Promise<Response>((resolve) => { complete = resolve })
  } })
  const props = { client, projectId: PROJECT, rows: [ROW], mappings: [MAPPING], catalogue: CATALOGUE,
    readOnly: false, onReview: () => undefined, onRefresh: () => undefined }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(createElement(ProjectFactStaging, props)) })
  const stage = container.querySelector<HTMLButtonElement>('[data-testid="project-stage-facts"]')
  if (stage === null) throw new Error('the user-visible fact staging action is missing')
  await act(async () => { stage.click() })
  expect(stage.disabled).toBe(true)
  expect(requestSignal).toBeDefined()
  return { props, root, container, signal: () => requestSignal, complete: () => complete(stagedResponse()),
    close: async () => { await act(async () => { root.unmount() }); container.remove() } }
}

describe('fact staging during project refresh', () => {
  it('keeps an in-flight write and its result when the same immutable rows and source pins are refreshed', async () => {
    const fixture = await pendingStage()
    try {
      await act(async () => { fixture.root.render(createElement(ProjectFactStaging, { ...fixture.props,
        rows: structuredClone(fixture.props.rows), mappings: structuredClone(fixture.props.mappings), catalogue: structuredClone(CATALOGUE) })) })
      expect(fixture.signal()?.aborted).toBe(false)
      await act(async () => { fixture.complete() })
      expect(fixture.container.querySelector('[data-testid="project-create-reviews"]')).not.toBeNull()
      expect(fixture.container.textContent).toContain('已生成 1 条候选')
    } finally { await fixture.close() }
  })

  it.each(['project', 'row-version', 'source-visibility', 'original-source', 'original-kind', 'parse-kind'] as const)(
    'aborts the old write and excludes its late result when %s changes', async (change) => {
      const fixture = await pendingStage()
      try {
        const next = { ...fixture.props,
          ...(change === 'project' ? { projectId: '10000000-0000-4000-8000-000000000099' } : {}),
          ...(change === 'row-version' ? { rows: [{ ...ROW, revision: '2' }] } : {}),
          ...(change === 'source-visibility' ? { catalogue: { ...CATALOGUE, revision: { ...CATALOGUE.revision, sourceVisibilityEpoch: '2' } } } : {}),
          ...(change === 'original-source' ? { catalogue: { ...CATALOGUE, sources: CATALOGUE.sources.map((source) => ({ ...source,
            originalRef: { ...source.originalRef, digest: `sha256:${'b'.repeat(64)}` } })) } } : {}),
          ...(change === 'original-kind' ? { catalogue: { ...CATALOGUE, sources: CATALOGUE.sources.map((source) => ({ ...source,
            originalRef: { ...source.originalRef, kind: 'artifact' as const } })) } } : {}),
          ...(change === 'parse-kind' ? { catalogue: { ...CATALOGUE, sources: CATALOGUE.sources.map((source) => ({ ...source,
            parseRef: { ...source.parseRef, kind: 'document' as const } })) } } : {}),
        }
        await act(async () => { fixture.root.render(createElement(ProjectFactStaging, next)) })
        expect(fixture.signal()?.aborted).toBe(true)
        await act(async () => { fixture.complete() })
        expect(fixture.container.querySelector('[data-testid="project-create-reviews"]')).toBeNull()
        expect(fixture.container.textContent).not.toContain('已生成 1 条候选')
      } finally { await fixture.close() }
    },
  )
})
