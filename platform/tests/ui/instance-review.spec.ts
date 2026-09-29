// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { InstanceRecordView } from '@ontology/contracts'
import { InstanceReviewPanel } from '@ontology/app-web'
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
      { entityId: '88888888-8888-4888-8888-888888888888', objectId: 'device', displayName: 'Bridge A', strategy: 'native_id' },
      { entityId: '99999999-9999-4999-8999-999999999999', objectId: 'sensor', displayName: 'Bridge A', strategy: 'context' },
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
        locator: { kind: 'json_pointer', pointer: '/device_name', startByte: 0, endByte: 4, normalizationMapRef: 'nm' },
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

async function render(panel: ReturnType<typeof createElement>): Promise<{ container: HTMLElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(panel)
  })
  return { container, root }
}

describe('instance review panel', () => {
  it('shows the empty state when no record is visible', async () => {
    const client = new WorkbenchClient({
      baseUrl: 'http://api.test',
      fetchImpl: () => Promise.resolve(jsonResponse({ data: { records: [] } })),
    })
    const { container, root } = await render(createElement(InstanceReviewPanel, { client, projectId: PROJECT_ID }))
    try {
      expect(container.querySelector('[data-testid="instance-review-empty"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })

  it('renders a record with its raw/normalized/source/status and identity confidence', async () => {
    const client = clientForFixture()
    const { container, root } = await render(createElement(InstanceReviewPanel, { client, projectId: PROJECT_ID }))
    try {
      await act(async () => {
        await Promise.resolve()
      })
      expect(container.querySelector('[data-testid="instance-identity-confidence"]')?.textContent).toContain('candidate')
      expect(container.querySelector('[data-testid="instance-identity-same-name"]')?.textContent).toContain('是')
      const row = container.querySelector('[data-testid="instance-field-row"]')
      expect(row?.querySelector('[data-testid="instance-field-raw"]')?.textContent).toBe('Bridge A')
      expect(row?.querySelector('[data-testid="instance-field-status"]')?.getAttribute('data-status')).toBe('pending')
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
})
