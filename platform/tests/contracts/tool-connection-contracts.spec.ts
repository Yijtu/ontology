import { describe, expect, it } from 'vitest'
import {
  assertExecutionToolBindingShape,
  assertEffectiveToolSelectionShape,
  assertToolAssignmentSetShape,
  assertToolConnectionDescriptorShape,
  assertToolConnectionProbeResultShape,
  assertToolConnectionSummaryShape,
} from '@ontology/contracts'

const CONNECTION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const WORKSPACE = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const DIGEST = `sha256:${'a'.repeat(64)}`
const versionRef = { id: 'web-search', version: '1.0.0', digest: DIGEST }

describe('tool connection catalogue mirrors model connections and never carries a secret', () => {
  it('accepts a search connection descriptor', () => {
    const descriptor = {
      name: 'Native Tavily',
      adapterType: 'native_tavily',
      capabilities: ['web_search'],
      enabled: true,
      endpoint: 'https://api.tavily.com',
    }
    expect(() => assertToolConnectionDescriptorShape(descriptor)).not.toThrow()
  })

  it('rejects an unknown adapter, an unknown capability and a credential-shaped summary', () => {
    expect(() => assertToolConnectionDescriptorShape({ name: 'x', adapterType: 'openai', capabilities: ['web_search'], enabled: true })).toThrow()
    expect(() => assertToolConnectionDescriptorShape({ name: 'x', adapterType: 'http_compat', capabilities: ['generate'], enabled: true })).toThrow()
    const summary = {
      connectionId: CONNECTION,
      name: '搜索',
      revision: '3',
      adapterType: 'http_compat',
      capabilities: ['web_search'],
      enabled: true,
      credentialState: 'present',
      updatedAt: '2026-10-16T00:00:00Z',
    }
    expect(() => assertToolConnectionSummaryShape(summary)).not.toThrow()
    expect(() => assertToolConnectionSummaryShape({ ...summary, apiKey: 'secret' })).toThrow()
  })

  it('reports search and archive probes as separate items', () => {
    const result = {
      schemaVersion: 'tool-connection-test-result@1',
      connectionId: CONNECTION,
      connectionRevision: '3',
      testedAt: '2026-10-16T00:00:00Z',
      draft: false,
      credentialConfigured: true,
      search: { status: 'passed', latencyMs: 120 },
      archive: { status: 'failed', reason: 'page_not_readable' },
    }
    expect(() => assertToolConnectionProbeResultShape(result)).not.toThrow()
    expect(() => assertToolConnectionProbeResultShape({ ...result, archive: undefined })).toThrow()
    expect(() => assertToolConnectionProbeResultShape({ ...result, search: { status: 'ok' } })).toThrow()
  })
})

describe('tool assignment resolution mirrors the model resolution order', () => {
  const assignmentSet = {
    schemaVersion: 'tool-assignment-set@1',
    scope: { kind: 'industry_workspace', workspaceId: WORKSPACE },
    defaultSelection: { kind: 'inherit' },
    toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: CONNECTION } }],
    revision: '1',
    updatedAt: '2026-10-16T00:00:00Z',
  }

  it('accepts inherit/disabled/connection selections per tool', () => {
    expect(() => assertToolAssignmentSetShape(assignmentSet)).not.toThrow()
    expect(() => assertToolAssignmentSetShape({
      ...assignmentSet,
      toolSelections: [
        { toolId: 'web_search', selection: { kind: 'disabled' } },
        { toolId: 'document_search', selection: { kind: 'inherit' } },
      ],
    })).not.toThrow()
  })

  it('rejects duplicate tool selections and an unknown selection kind', () => {
    expect(() => assertToolAssignmentSetShape({
      ...assignmentSet,
      toolSelections: [
        { toolId: 'web_search', selection: { kind: 'inherit' } },
        { toolId: 'web_search', selection: { kind: 'disabled' } },
      ],
    })).toThrow()
    expect(() => assertToolAssignmentSetShape({ ...assignmentSet, defaultSelection: { kind: 'auto' } })).toThrow()
  })

  it('requires an available effective selection to name a connection', () => {
    const effective = {
      schemaVersion: 'effective-tool-selection@1',
      scope: { kind: 'space' },
      toolId: 'web_search',
      selection: { kind: 'connection', connectionId: CONNECTION },
      resolvedFrom: 'space_tool',
      state: 'available',
      connectionId: CONNECTION,
      resolvedAt: '2026-10-16T00:00:00Z',
    }
    expect(() => assertEffectiveToolSelectionShape(effective)).not.toThrow()
    expect(() => assertEffectiveToolSelectionShape({ ...effective, state: 'available', connectionId: undefined })).toThrow()
    expect(() => assertEffectiveToolSelectionShape({ ...effective, state: 'blocked', blockedReason: 'CREDENTIAL_MISSING' })).not.toThrow()
  })

  it('binds one execution to a pinned connection version and rejects a secret', () => {
    const binding = {
      schemaVersion: 'execution-tool-binding@1',
      executionId: CONNECTION,
      toolId: 'web_search',
      connectionId: CONNECTION,
      connectionRevision: '3',
      connectionRef: versionRef,
      assignmentRevision: '1',
      resolvedFrom: 'space_tool',
      boundAt: '2026-10-16T00:00:00Z',
    }
    expect(() => assertExecutionToolBindingShape(binding)).not.toThrow()
    expect(() => assertExecutionToolBindingShape({ ...binding, secret: 'x' })).toThrow()
    expect(() => assertExecutionToolBindingShape({ ...binding, connectionRef: undefined })).toThrow()
  })
})
