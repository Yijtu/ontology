import type { ToolResult, VersionRef } from '@ontology/contracts'

const DIGEST = `sha256:${'a'.repeat(64)}`
const NOW = '2026-09-21T00:00:00Z'

export const SAMPLE_SCHEMA_REF: VersionRef = { id: 'data_query.output', version: '1.0.0', digest: DIGEST }

/** Convert a typed value into the loose record the MCP wire carries, without an assertion. */
export function toStructuredContent(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value))
}

/** A schema-valid `ToolResult` used as the remote wire payload in the MCP tests. */
export function sampleToolResult(overrides?: Partial<ToolResult>): ToolResult {
  return {
    callId: '44444444-4444-4444-8444-444444444444',
    status: 'ok',
    inlineData: { resultKind: 'table', table: { columns: [], rows: [] } },
    schemaRef: SAMPLE_SCHEMA_REF,
    evidenceRefs: [
      { id: '55555555-5555-4555-8555-555555555555', version: '1.0.0', digest: DIGEST, kind: 'evidence' },
    ],
    sourceSnapshots: [
      {
        sourceRef: { namespace: 'demo', sourceId: 'business-db' },
        schemaVersion: '2026-09-01',
        readAt: NOW,
        consistency: 'repeatable_read',
        resultDigest: DIGEST,
      },
    ],
    coverage: { returned: 0, truncated: false },
    usage: { durationMs: 1 },
    warnings: [],
    ...overrides,
  }
}
