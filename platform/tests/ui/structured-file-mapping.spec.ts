// @vitest-environment jsdom
// N07: the shared structured file-mapping intake experience (design §1.3/§2.6, node N07).
// These render the real components against a guarded HTTP fixture; they do not replace the
// normal-host browser acceptance proof.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProjectRecord, ProjectRevision } from '@ontology/contracts'
import { CoreImportPanel, ProjectWorkspacePanel, structuredIntakeStage } from '@ontology/app-web'
import type { ProjectBinding, ProjectSourceCandidate } from '@ontology/app-web'
import type { CoreDeploymentScenario } from '@ontology/app-web/client'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const DIGEST = `sha256:${'a'.repeat(64)}`
const PROJECT_ID = '44444444-4444-4444-8444-444444444444'
const DOCUMENT_ID = 'bbbbbbbb-0000-4000-8000-000000000003'
const PARSE_ID = 'aaaaaaaa-0000-4000-8000-000000000001'

const PROJECT: ProjectRecord = {
  projectId: PROJECT_ID,
  title: '设备台账项目',
  headRevision: '1',
  state: 'draft',
  createdBy: 'tester',
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z',
}

const REVISION: ProjectRevision = {
  ref: { projectId: PROJECT_ID, revision: '1', digest: DIGEST },
  industryPackRef: { id: 'demo.pack', version: '1.0.0', digest: DIGEST },
  definitionRef: { id: 'demo.pack-definition', version: '1.0.0', digest: DIGEST },
  mappingRefs: [],
  profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: DIGEST },
  documentSetRef: { id: PROJECT_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' },
  semanticPublicationRefs: [],
  sourceVisibilityEpoch: '1',
  changeReason: 'project created',
}

const BINDING: ProjectBinding = {
  profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: DIGEST },
  mappingRefs: [],
  documentSetRef: REVISION.documentSetRef,
}

const SOURCE: ProjectSourceCandidate = {
  sourceId: 'source-1',
  label: '设备台账.csv',
  format: 'csv',
  mediaType: 'text/csv',
  documentRef: { id: DOCUMENT_ID, version: '1.0.0', digest: DIGEST, kind: 'document' },
  parseRef: { id: PARSE_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' },
  parseId: PARSE_ID,
  objects: [
    {
      objectId: 'device',
      label: '设备',
      fields: [
        { fieldRef: 'name', label: '名称', valueType: 'string', required: true },
        { fieldRef: 'capacity', label: '容量', valueType: 'quantity', unitCode: 'kWh', required: false },
      ],
      columns: [
        { columnIndex: 0, header: 'name', headerDigest: DIGEST },
        { columnIndex: 1, header: 'capacity_wh', headerDigest: DIGEST },
      ],
    },
  ],
}

const PACKS = [] as const

const LOCATOR = {
  kind: 'table_cell',
  format: 'csv',
  recordIndex: 5,
  row: 6,
  column: 3,
  address: 'C6',
  normalizationMapRef: 'saved-native-map',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface MockOptions {
  /** The server already reports every readiness projection ready. */
  readonly readinessReady?: boolean
  readonly onPreview?: (body: unknown) => void
}

function clientForFixture(options: MockOptions = {}): WorkbenchClient {
  return new WorkbenchClient({
    baseUrl: 'http://api.test',
    fetchImpl: (input, init) => {
      const url = new URL(String(input), 'http://api.test')
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.pathname
      if (method === 'GET' && path === '/api/v1/projects')
        return Promise.resolve(jsonResponse({ data: { projects: [PROJECT] } }))
      if (method === 'GET' && path.endsWith('/revisions'))
        return Promise.resolve(jsonResponse({ data: { revisions: [REVISION] } }))
      if (method === 'GET' && path.endsWith('/readiness'))
        return Promise.resolve(
          jsonResponse({
            data: {
              projectRevisionRef: REVISION.ref,
              projections: (['published_semantics', 'dataset', 'document_index'] as const).map((kind) => ({
                projectRevisionRef: REVISION.ref,
                kind,
                state: options.readinessReady === true ? 'ready' : 'pending',
                processedCount: 0,
                expectedCount: 0,
                failedCount: 0,
              })),
              requiredReadiness: ['published_semantics', 'dataset', 'document_index'],
              ready: options.readinessReady === true,
              blockers: options.readinessReady === true ? [] : [{ code: 'READINESS_NOT_BUILT', message: 'dataset readiness has not been built', retryable: true, readinessKind: 'dataset' }],
            },
          }),
        )
      if (method === 'GET' && path.endsWith('/mappings'))
        return Promise.resolve(jsonResponse({ data: { mappings: [] } }))
      if (method === 'GET' && path.endsWith('/document-index'))
        return Promise.resolve(
          jsonResponse({
            data: {
              status: {
                projectId: PROJECT_ID,
                collectionRef: `project:${PROJECT_ID}`,
                state: 'pending',
                visibilityEpoch: '1',
                membershipRevision: '0',
                documentCount: 0,
                sourceDocumentCount: 0,
                completeness: 'unknown',
                retryable: true,
              },
            },
          }),
        )
      if (method === 'GET' && path.endsWith('/records'))
        return Promise.resolve(jsonResponse({ data: { records: [], total: 0 } }))
      if (method === 'GET' && path.endsWith('/source-catalogue'))
        return Promise.resolve(
          jsonResponse({
            data: {
              project: PROJECT,
              revision: REVISION,
              sources: [
                {
                  documentId: DOCUMENT_ID,
                  originalRef: SOURCE.documentRef,
                  parseRef: SOURCE.parseRef,
                  parseId: PARSE_ID,
                  precision: 'approximate',
                  name: SOURCE.label,
                  kind: 'csv',
                  format: 'csv',
                  mediaType: SOURCE.mediaType,
                  options: {},
                  tables: [{ tableId: 'source-table', headerRow: 1, columns: SOURCE.objects[0]?.columns ?? [], rows: [] }],
                },
              ],
              objects: SOURCE.objects.map((object) => ({
                objectId: object.objectId,
                displayName: object.label,
                attributes: object.fields.map((field) => ({
                  attributeId: field.fieldRef,
                  displayName: field.label,
                  valueType: field.valueType,
                  required: field.required,
                  ...('unitCode' in field ? { unit: field.unitCode } : {}),
                })),
              })),
            },
          }),
        )
      if (method === 'POST' && path.endsWith('/mappings/preview')) {
        options.onPreview?.(JSON.parse(String(init?.body)))
        return Promise.resolve(
          jsonResponse({
            data: {
              preview: {
                projectId: PROJECT_ID,
                definitionRef: REVISION.definitionRef,
                objectId: 'device',
                format: 'csv',
                parseId: PARSE_ID,
                columns: [
                  {
                    fieldRef: 'capacity',
                    valueType: 'quantity',
                    canonicalUnitCode: 'kWh',
                    sourceUnitCode: 'Wh',
                    normalization: 'exact',
                    columnIndex: 1,
                    header: 'capacity_wh',
                    samples: [{ recordIndex: 1, row: 2, raw: '1500', canonical: '1.5', locator: LOCATOR }],
                  },
                ],
                unmappedColumns: [],
                issues: [
                  {
                    code: 'MISSING_COLUMN',
                    severity: 'error',
                    message: 'required attribute name has no column correspondence',
                    fieldRef: 'name',
                    recordIndex: 5,
                    columnIndex: 2,
                    header: 'unit',
                  },
                ],
                rowCount: 0,
                confirmable: false,
              },
            },
          }),
        )
      }
      return Promise.resolve(jsonResponse({ data: {} }, 404))
    },
  })
}

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = []
afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount())
    entry.container.remove()
  }
})

async function render(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(element)
  })
  await act(async () => {
    await Promise.resolve()
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
  setter?.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('structured file-mapping intake (N07)', () => {
  it('explains the file-snapshot boundary and keeps the database connector in planning', async () => {
    const scenarios: readonly CoreDeploymentScenario[] = [
      {
        scenarioId: 'device-ledger',
        label: '设备台账（合成演示）',
        profileRef: { id: 'profile-1', version: '1.0.0' },
        environment: 'local_dev',
        namespace: 'synthetic-device-ledger',
        definitionRef: { id: 'device-definition', version: '1.0.0', digest: DIGEST },
        availableTasks: [],
        mappingRefs: [],
        rawSourceRefs: [{ namespace: 'synthetic-device-ledger', sourceId: 'asset-ledger' }],
      },
    ]
    const container = await render(
      createElement(CoreImportPanel, {
        client: new WorkbenchClient({ baseUrl: 'http://core.test' }),
        scenarios,
        operatorEnabled: true,
      }),
    )
    const snapshot = container.querySelector('[data-testid="core-import-intake-snapshot"]')?.textContent ?? ''
    expect(snapshot).toContain('文件快照接入')
    expect(snapshot).toContain('不是实时同步')
    expect(container.querySelector('[data-testid="core-import-intake-database"]')?.textContent).toContain('规划能力')
    const databaseNote = container.querySelector('[data-testid="core-import-intake-database-note"]')?.textContent ?? ''
    expect(databaseNote).toContain('不提供数据库连接')
    // The notice never exposes a connector form that cannot complete.
    expect(container.querySelector('[data-testid="core-import-intake"] input')).toBeNull()
  })

  it('shares the intake notice across the project entry and never shows 就绪 before the server does', async () => {
    const client = clientForFixture({ readinessReady: true })
    const container = await render(
      createElement(ProjectWorkspacePanel, {
        client,
        projectBinding: BINDING,
        packs: PACKS,
        sources: [SOURCE],
        initialStep: 'mapping',
      }),
    )
    await flush()
    const projectSnapshot =
      container.querySelector('[data-testid="project-import-intake-snapshot"]')?.textContent ?? ''
    expect(projectSnapshot).toContain('文件快照接入')
    const mappingSnapshot = container.querySelector('[data-testid="mapping-intake-snapshot"]')?.textContent ?? ''
    expect(mappingSnapshot).toContain('文件快照接入')
    const status = container.querySelector('[data-testid="structured-intake-status"]')
    // Even with the server reporting every projection ready, no mapping/records exist yet,
    // so the intake must not claim 就绪.
    expect(status?.getAttribute('data-stage')).toBe('mapping_pending')
    expect(status?.textContent).not.toContain('就绪')
  })

  it('previews the original value, the canonical value and its unit, and locates the failing row', async () => {
    const client = clientForFixture()
    const container = await render(
      createElement(ProjectWorkspacePanel, {
        client,
        projectBinding: BINDING,
        packs: PACKS,
        sources: [SOURCE],
        initialStep: 'mapping',
      }),
    )
    await flush()
    const source = container.querySelector('[data-testid="mapping-source"]') as HTMLSelectElement
    await act(async () => {
      setSelectValue(source, `${DOCUMENT_ID}:source-table`)
    })
    const object = container.querySelector('[data-testid="mapping-object"]') as HTMLSelectElement
    await act(async () => {
      setSelectValue(object, 'device')
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="mapping-preview-button"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const unit = container.querySelector('[data-testid="mapping-preview-unit-capacity"]')?.textContent ?? ''
    expect(unit).toContain('Wh')
    expect(unit).toContain('kWh')
    const location = container.querySelector('[data-testid="mapping-issue-location"]')?.textContent ?? ''
    expect(location).toContain('记录 5')
    expect(location).toContain('列 3')
    expect(location).toContain('表头「unit」')
    expect(container.querySelector('[data-testid="mapping-issue"]')?.getAttribute('data-code')).toBe('MISSING_COLUMN')
  })

  it('shows a reason and a recovery entry when a required column is missing', async () => {
    const client = clientForFixture()
    const container = await render(
      createElement(ProjectWorkspacePanel, {
        client,
        projectBinding: BINDING,
        packs: PACKS,
        sources: [SOURCE],
        initialStep: 'mapping',
      }),
    )
    await flush()
    await act(async () => {
      setSelectValue(container.querySelector('[data-testid="mapping-source"]') as HTMLSelectElement, `${DOCUMENT_ID}:source-table`)
    })
    await act(async () => {
      setSelectValue(container.querySelector('[data-testid="mapping-object"]') as HTMLSelectElement, 'device')
    })
    await act(async () => {
      ;(container.querySelector('[data-testid="mapping-preview-button"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    const missing = container.querySelector('[data-testid="mapping-missing-column"]')
    expect(missing?.textContent).toContain('缺少必填列')
    await act(async () => {
      ;(container.querySelector('[data-testid="mapping-missing-column-recover"]') as HTMLButtonElement).click()
    })
    expect(container.querySelector('[data-testid="mapping-preview"]')).toBeNull()
  })

  it('derives the intake stage from server readback and only reaches 就绪 when records and readiness exist', () => {
    expect(structuredIntakeStage({ sourceCount: 0, mappingCount: 0, mappingConfirmed: false, recordTotal: 0, readiness: undefined })).toBe('awaiting_mapping')
    expect(structuredIntakeStage({ sourceCount: 1, mappingCount: 0, mappingConfirmed: false, recordTotal: 0, readiness: undefined })).toBe('mapping_pending')
    expect(structuredIntakeStage({ sourceCount: 1, mappingCount: 1, mappingConfirmed: true, recordTotal: 0, readiness: undefined })).toBe('records_pending')
    expect(structuredIntakeStage({ sourceCount: 1, mappingCount: 1, mappingConfirmed: true, recordTotal: 4, readiness: undefined })).toBe('building')
    expect(structuredIntakeStage({ sourceCount: 1, mappingCount: 1, mappingConfirmed: true, recordTotal: 4, readiness: { blockers: [{ code: 'x' }], states: ['ready', 'ready', 'ready'] } })).toBe('building')
    expect(structuredIntakeStage({ sourceCount: 1, mappingCount: 1, mappingConfirmed: true, recordTotal: 4, readiness: { blockers: [], states: ['ready', 'ready', 'ready'] } })).toBe('ready')
    expect(structuredIntakeStage({ sourceCount: 1, mappingCount: 1, mappingConfirmed: true, recordTotal: 4, readiness: { blockers: [], states: ['ready', 'pending', 'ready'] } })).toBe('building')
  })
})
