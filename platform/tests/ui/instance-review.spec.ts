// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { InstanceNormalizedValue, InstanceRecordView } from '@ontology/contracts'
import { InstanceReviewPanel, readInstanceFieldSource } from '@ontology/app-web'
import { WorkbenchClient } from '@ontology/app-web/client'

const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true

const DIGEST = `sha256:${'a'.repeat(64)}`
const PROJECT_ID = '44444444-4444-4444-8444-444444444444'
const RECORD_ID = '77777777-7777-4777-8777-777777777777'

const RECORD: InstanceRecordView = {
  projectId: PROJECT_ID,
  recordId: RECORD_ID,
  recordRevision: '1',
  objectTypeRef: 'device',
  identity: {
    state: 'unresolved',
    confidence: 'candidate',
    candidates: [
      {
        entityId: '88888888-8888-4888-8888-888888888888',
        objectId: 'device',
        displayName: 'Bridge A',
        strategy: 'native_id',
      },
      {
        entityId: '99999999-9999-4999-8999-999999999999',
        objectId: 'sensor',
        displayName: 'Bridge A',
        strategy: 'context',
      },
    ],
    sameNameDifferentMeaning: true,
    cannotLinkEntityIds: [],
    adjudications: [],
    decisionRevision: '0',
  },
  fields: [
    {
      fieldId: 'device_name',
      rawValue: 'Bridge A',
      normalizedValue: { kind: 'scalar', value: 'Bridge A' },
      source: {
        documentRef: { id: RECORD_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' },
        parseId: RECORD_ID,
        chunkId: RECORD_ID,
        locator: {
          kind: 'json_pointer',
          pointer: '/device_name',
          startByte: 0,
          endByte: 4,
          normalizationMapRef: 'nm',
        },
        textDigest: DIGEST,
        quoteDigest: DIGEST,
      },
      status: 'pending',
      confirmationRevision: '0',
    },
  ],
  relations: [],
  publicationState: 'draft',
  sourceRef: { id: RECORD_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' },
  actor: 'tester',
  recordedAt: '2026-09-29T00:00:00Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function clientForFixture(): WorkbenchClient {
  return new WorkbenchClient({
    baseUrl: 'http://api.test',
    fetchImpl: (input) => {
      const url = String(input)
      if (url.endsWith('/instance-records')) {
        return Promise.resolve(jsonResponse({ data: { records: [RECORD] } }))
      }
      if (url.includes(`/instance-records/${RECORD_ID}`)) {
        return Promise.resolve(jsonResponse({ data: { record: RECORD } }))
      }
      return Promise.resolve(jsonResponse({ data: {} }, 404))
    },
  })
}

async function render(
  panel: ReturnType<typeof createElement>,
): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(panel)
  })
  return { container, root }
}

describe('instance review panel', () => {
  it('reads a field beyond the bounded preview from its exact current-record endpoint and rejects a different revision', async () => {
    const exact = '9007199254740993.00000000000000000001'
    const locator = { kind: 'table_cell' as const, format: 'xlsx' as const, sheetId: 'sheet2', sheetName: '已选工作表', recordIndex: 12, row: 14, column: 2, address: 'B14', normalizationMapRef: 'actual-native-map' }
    const originalRef = { id: RECORD_ID, version: '1.0.0', digest: DIGEST, kind: 'document' as const }
    const selected: InstanceRecordView = { ...RECORD, fields: [{ ...RECORD.fields[0]!, fieldId: 'reading', rawValue: '已审核的记录值', source: { ...RECORD.fields[0]!.source, documentRef: originalRef, locator } }], sourceRef: originalRef }
    const actual = { projectId: PROJECT_ID, recordId: RECORD_ID, recordRevision: '1', fieldId: 'reading', precision: 'exact', readability: 're_readable', originalRef, parseRef: { id: RECORD_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' }, parseId: RECORD_ID, locator, cells: [{ raw: exact, locator, columnLabel: '原始读数', rowLabel: '14' }] }
    const requests: string[] = []
    let wrongRevision = false
    const client = new WorkbenchClient({ baseUrl: 'http://api.test', fetchImpl: (input) => {
      const url = new URL(String(input)); requests.push(url.pathname + url.search)
      if (url.pathname.endsWith('/fields/reading/source')) return Promise.resolve(jsonResponse({ data: wrongRevision ? { ...actual, recordRevision: '2' } : actual }))
      if (url.pathname.endsWith('/instance-records')) return Promise.resolve(jsonResponse({ data: { records: [selected] } }))
      if (url.pathname.endsWith(`/instance-records/${RECORD_ID}`)) return Promise.resolve(jsonResponse({ data: { record: selected } }))
      return Promise.resolve(jsonResponse({ data: {} }, 404))
    } })
    const { container, root } = await render(createElement(InstanceReviewPanel, { client, projectId: PROJECT_ID }))
    try {
      await act(async () => { await Promise.resolve() })
      const open = container.querySelector('[data-testid="instance-field-source"] button')
      if (open === null) throw new Error('field source action missing')
      await act(async () => { open.dispatchEvent(new MouseEvent('click', { bubbles: true })); await Promise.resolve() })
      const body = container.querySelector('[aria-label="当前字段的原始来源"]')
      expect(body?.textContent).toContain(exact)
      expect(body?.textContent).toContain('B14')
      expect(requests).toContain(`/api/v1/core/projects/${PROJECT_ID}/instance-records/${RECORD_ID}/fields/reading/source?recordRevision=1`)
      expect(container.textContent).not.toContain('当前有界原始预览未唯一返回')
      wrongRevision = true
      await expect(readInstanceFieldSource(client, selected, 'reading')).rejects.toMatchObject({ code: 'SOURCE_REFERENCE_MISMATCH' })
    } finally { await act(async () => root.unmount()); container.remove() }
  })
  it('shows the empty state when no record is visible', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: () => Promise.resolve(jsonResponse({ data: { records: [] } })),
    })
    const { container, root } = await render(
      createElement(InstanceReviewPanel, { client, projectId: PROJECT_ID }),
    )
    try {
      expect(container.querySelector('[data-testid="instance-review-empty"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('renders a record with its raw/normalized/source/status and identity confidence', async () => {
    const client = clientForFixture()
    const { container, root } = await render(
      createElement(InstanceReviewPanel, { client, projectId: PROJECT_ID }),
    )
    try {
      await act(async () => {
        await Promise.resolve()
      })
      expect(container.querySelector('[data-testid="instance-identity-confidence"]')?.textContent).toContain(
        'candidate',
      )
      expect(container.querySelector('[data-testid="instance-identity-same-name"]')?.textContent).toContain(
        '是',
      )
      const row = container.querySelector('[data-testid="instance-field-row"]')
      expect(row?.querySelector('[data-testid="instance-field-raw"]')?.textContent).toBe('Bridge A')
      expect(row?.querySelector('[data-testid="instance-field-status"]')?.getAttribute('data-status')).toBe(
        'pending',
      )
      expect(container.querySelector('[data-testid="instance-field-confirm"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('hides every edit, approve and publish entry for a readonly principal', async () => {
    const client = clientForFixture()
    const { container, root } = await render(
      createElement(InstanceReviewPanel, { client, projectId: PROJECT_ID, readOnly: true }),
    )
    try {
      await act(async () => {
        await Promise.resolve()
      })
      expect(container.querySelector('[data-testid="instance-field-confirm"]')).toBeNull()
      expect(container.querySelector('[data-testid="instance-field-edit-start"]')).toBeNull()
      expect(container.querySelector('[data-testid="instance-identity-match"]')).toBeNull()
      expect(container.querySelector('[data-testid="instance-approve"]')).toBeNull()
      expect(container.querySelector('[data-testid="instance-publish"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it.each([
    {
      initial: { kind: 'quantity', value: '1.25', unitCode: 'kW' } satisfies InstanceNormalizedValue,
      typed: '9007199254740993.00000000000000000001',
      expected: { kind: 'quantity', value: '9007199254740993.00000000000000000001', unitCode: 'kW' },
      schema: { valueType: 'quantity', unit: 'kW' },
    },
    {
      initial: { kind: 'scalar', value: true } satisfies InstanceNormalizedValue,
      typed: 'false',
      expected: { kind: 'scalar', value: false },
      schema: { valueType: 'boolean' },
    },
    {
      initial: {
        kind: 'reference',
        entityId: '88888888-8888-4888-8888-888888888888',
      } satisfies InstanceNormalizedValue,
      typed: '99999999-9999-4999-8999-999999999999',
      expected: { kind: 'reference', entityId: '99999999-9999-4999-8999-999999999999' },
      schema: { valueType: 'reference', referencesObjectId: 'device' },
    },
  ])(
    'submits the stored value family and preserves exact input ($initial.kind)',
    async ({ initial, typed, expected, schema }) => {
      const field = RECORD.fields[0]
      if (field === undefined) throw new Error('fixture field missing')
      const record: InstanceRecordView = { ...RECORD, fields: [{ ...field, normalizedValue: initial }] }
      let body: unknown
      let revision: string | null = null
      const project = {
        projectId: PROJECT_ID,
        title: '合成类型检查项目',
        headRevision: '1',
        state: 'draft',
        createdBy: 'tester',
        createdAt: RECORD.recordedAt,
        updatedAt: RECORD.recordedAt,
      }
      const projectRevision = {
        ref: { projectId: PROJECT_ID, revision: '1', digest: DIGEST },
        industryPackRef: { id: 'typed-editor-pack', version: '1.0.0', digest: DIGEST },
        definitionRef: { id: 'typed-editor-definition', version: '1.0.0', digest: DIGEST },
        profileRef: { id: 'typed-editor-profile', version: '1.0.0', snapshotHash: DIGEST },
        mappingRefs: [],
        documentSetRef: RECORD.sourceRef,
        semanticPublicationRefs: [],
        sourceVisibilityEpoch: '1',
        changeReason: 'synthetic UI field-family fixture',
      }
      const objects = [
        {
          objectId: 'device',
          displayName: '设备',
          attributes: [{ attributeId: field.fieldId, displayName: '待核对值', required: true, ...schema }],
          entities: [
            { entityId: '88888888-8888-4888-8888-888888888888', displayName: '已确认设备 A' },
            { entityId: '99999999-9999-4999-8999-999999999999', displayName: '已确认设备 B' },
          ],
        },
      ]
      const client = new WorkbenchClient({
        baseUrl: 'http://api.test',
        fetchImpl: (input, options) => {
          if (String(input).endsWith('/source-catalogue'))
            return Promise.resolve(
              jsonResponse({ data: { project, revision: projectRevision, sources: [], objects } }),
            )
          if (String(input).endsWith('/task-catalogue'))
            return Promise.resolve(
              jsonResponse({
                data: {
                  project,
                  revision: projectRevision,
                  tasks: [
                    {
                      bindingRef: { id: 'editor-options', version: '1.0.0', digest: DIGEST },
                      taskKind: 'published_facts',
                      displayName: '已发布事实',
                      parameterSchema: { type: 'object', properties: {} },
                      requiredCapabilities: [],
                      requiredReadiness: [],
                      available: true,
                      unavailableReasons: [],
                      objects,
                    },
                  ],
                },
              }),
            )
          if (String(input).endsWith('/field-edits')) {
            body = JSON.parse(String(options?.body))
            revision = new Headers(options?.headers).get('if-match')
            return Promise.resolve(jsonResponse({ data: { record } }))
          }
          return Promise.resolve(
            jsonResponse({
              data: String(input).endsWith('/instance-records') ? { records: [record] } : { record },
            }),
          )
        },
      })
      const { container, root } = await render(
        createElement(InstanceReviewPanel, { client, projectId: PROJECT_ID }),
      )
      try {
        await act(async () => {
          container.querySelector<HTMLButtonElement>('[data-testid="instance-field-edit-start"]')?.click()
        })
        const input = container.querySelector<HTMLInputElement | HTMLSelectElement>(
          '[data-testid="instance-field-edit-input"]',
        )
        const reason = container.querySelector<HTMLInputElement>('[data-testid="instance-field-edit-reason"]')
        if (input === null || reason === null) throw new Error('typed editor missing')
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
            'value',
          )?.set?.call(input, typed)
          input.dispatchEvent(
            new Event(input instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
          )
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
            reason,
            '核对实际来源后修正',
          )
          reason.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => {
          container
            .querySelector('form')
            ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
        })
        expect(body).toMatchObject({
          fieldId: 'device_name',
          normalizedValue: expected,
          reason: '核对实际来源后修正',
        })
        expect(revision).toBe('1')
      } finally {
        await act(async () => root.unmount())
        container.remove()
      }
    },
  )

  it('does not restore an old project record when its read finishes after selection changes', async () => {
    let finishOld: ((response: Response) => void) | undefined
    const otherProject = '55555555-5555-4555-8555-555555555555'
    const otherRecord = {
      ...RECORD,
      projectId: otherProject,
      recordId: '66666666-6666-4666-8666-666666666666',
    }
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: (input) => {
        const path = String(input)
        if (path.endsWith(`/instance-records/${RECORD_ID}`))
          return new Promise<Response>((resolve) => {
            finishOld = resolve
          })
        const other = path.includes(otherProject)
        return Promise.resolve(
          jsonResponse({
            data: path.endsWith('/instance-records')
              ? { records: [other ? otherRecord : RECORD] }
              : { record: otherRecord },
          }),
        )
      },
    })
    const { container, root } = await render(
      createElement(InstanceReviewPanel, { client, projectId: PROJECT_ID }),
    )
    try {
      expect(finishOld).toBeDefined()
      await act(async () => {
        root.render(createElement(InstanceReviewPanel, { client, projectId: otherProject }))
      })
      expect(container.querySelector('[data-testid="instance-detail"]')?.getAttribute('data-record-id')).toBe(
        otherRecord.recordId,
      )
      await act(async () => {
        finishOld?.(jsonResponse({ data: { record: RECORD } }))
      })
      expect(container.querySelector('[data-testid="instance-detail"]')?.getAttribute('data-record-id')).toBe(
        otherRecord.recordId,
      )
      expect(container.querySelector('[data-testid="instance-field-edit-form"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
