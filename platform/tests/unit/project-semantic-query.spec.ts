import { describe, expect, it } from 'vitest'
import {
  ProjectSemanticQueryError,
  ProjectSemanticQueryService,
  buildProjectSnapshotMapping,
  compileSemanticQuery,
  projectSnapshotMappingRef,
} from '@ontology/semantic-engine'
import type { ProjectSnapshotQueryPort } from '@ontology/contracts'
import {
  PROJECT_DATASET_SOURCE_NAMESPACE,
  projectDatasetSourceObjectRef,
  projectDatasetSourceRef,
} from '@ontology/contracts'
import type {
  CancelRequest,
  CancelResponse,
  ProjectDatasetRef,
  ProjectSnapshotQueryDescriptor,
  QueryLimits,
  SemanticQueryPlan,
  SourceSnapshot,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryValidateResponse,
  ToolContext,
} from '@ontology/contracts'
import { gatewayContext } from './tool-gateway-fixtures'
import { sha256DigestOf } from '@ontology/core'

/**
 * V03-025 unit coverage: the project-snapshot semantic query path compiles against the *fixed*
 * snapshot mapping, returns typed rows plus the exact per-row source locators, and refuses an
 * unsupported plan or a query against another object instead of falling back.
 */

const SNAPSHOT_ID = '99999999-9999-4999-8999-999999999999'
const SNAPSHOT_REF: ProjectDatasetRef = {
  id: SNAPSHOT_ID,
  version: '1.0.7',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'dataset',
}
const SOURCE_REF = projectDatasetSourceRef(SNAPSHOT_ID)

const DESCRIPTOR: ProjectSnapshotQueryDescriptor = {
  snapshotRef: SNAPSHOT_REF,
  objectId: 'Meter',
  dialect: 'duckdb',
  schema: 'main',
  relation: 'dsq_test_snapshot',
  relationKind: 'table',
  sourceObjectRef: projectDatasetSourceObjectRef(SNAPSHOT_ID, 'Meter'),
  columns: [
    { name: 'deviceId', valueType: 'string' },
    { name: 'meterValue', valueType: 'quantity', canonicalUnitCode: 'Wh', dimension: 'energy' },
  ],
}

const LIMITS: QueryLimits = { maxRows: 100, maxBytes: 1_048_576, maxDurationMs: 30_000 }

const SOURCE_LOCATOR = {
  fieldId: 'meterValue',
  documentRef: {
    id: '22222222-2222-4222-8222-222222222222',
    version: '1.0.0',
    digest: `sha256:${'b'.repeat(64)}`,
    kind: 'artifact' as const,
  },
  parseId: '55555555-5555-4555-8555-555555555555',
  locator: { kind: 'table_cell' as const, format: 'csv' as const, recordIndex: 1, row: 2, column: 2, normalizationMapRef: 'map' },
}

function planFor(mappingVersion = projectSnapshotMappingRef({ descriptor: DESCRIPTOR })): SemanticQueryPlan {
  return {
    mode: 'semantic',
    concepts: ['Meter'],
    fields: ['deviceId', 'meterValue'],
    links: [],
    filters: [],
    orderBy: [],
    limit: 100,
    mappingVersion,
  }
}

class FakeProjectSnapshotQuery implements ProjectSnapshotQueryPort {
  readonly backend = 'fake-project-dataset'
  validateResponse: StructuredQueryValidateResponse = { valid: true, warnings: [] }
  readonly seenPlans: { readonly mode: string; readonly sql: string }[] = []
  responseRows: unknown[][] = [
    ['d1', '1005.0000000000', 'rec-1', JSON.stringify([SOURCE_LOCATOR])],
    ['d2', '2500.0000000000', 'rec-2', JSON.stringify([])],
  ]

  async describeSnapshot(): Promise<ProjectSnapshotQueryDescriptor | undefined> {
    return DESCRIPTOR
  }

  async validate(): Promise<StructuredQueryValidateResponse> {
    return this.validateResponse
  }

  async execute(request: StructuredQueryExecuteRequest): Promise<StructuredQueryExecuteResponse> {
    this.seenPlans.push({ mode: request.plan.mode, sql: request.plan.mode === 'direct' ? request.plan.sql : '' })
    const snapshot: SourceSnapshot = {
      sourceRef: SOURCE_REF,
      schemaVersion: SNAPSHOT_REF.version,
      readAt: '2026-09-30T00:00:00Z',
      consistency: 'immutable',
      resultDigest: `sha256:${'c'.repeat(64)}`,
    }
    return {
      snapshot,
      columns: [
        { name: 'deviceId', type: 'string' },
        { name: 'meterValue', type: 'decimal' },
        { name: 'record_id', type: 'string' },
        { name: 'sources_json', type: 'string' },
      ],
      rows: this.responseRows,
      nextCursor: null,
      coverage: { returned: 2, truncated: false, completeness: 'complete' },
    }
  }

  async cancel(request: CancelRequest): Promise<CancelResponse> {
    return { targetRef: request.targetRef, state: 'already_terminal', acceptedAt: '2026-09-30T00:00:00Z' }
  }
}

function context(): ToolContext {
  return gatewayContext({ sourceRefs: [SOURCE_REF], deadline: '2099-01-01T00:00:00Z' })
}

describe('project snapshot semantic mapping', () => {
  it('maps canonical attributes plus the reserved identity/sources columns', () => {
    const mapping = buildProjectSnapshotMapping({ descriptor: DESCRIPTOR })
    expect(mapping.dialect).toBe('duckdb')
    expect(mapping.mappingRef).toEqual(projectSnapshotMappingRef({ descriptor: DESCRIPTOR }))
    const object = mapping.objects[0]
    expect(object?.conceptId).toBe('Meter')
    expect(object?.relation).toBe('dsq_test_snapshot')
    const fields = object?.fields.map((field) => field.fieldRef) ?? []
    expect(fields).toEqual(['deviceId', 'meterValue', 'record_id', 'sources_json'])
    const quantity = object?.fields.find((field) => field.fieldRef === 'meterValue')
    expect(quantity?.unit).toEqual({ unitCode: 'Wh', dimension: 'energy' })
  })

  it('derives a different mapping ref for a different snapshot', () => {
    const other = { ...DESCRIPTOR, snapshotRef: { ...SNAPSHOT_REF, id: '88888888-8888-4888-8888-888888888888' } }
    expect(projectSnapshotMappingRef({ descriptor: other }).digest).not.toBe(
      projectSnapshotMappingRef({ descriptor: DESCRIPTOR }).digest,
    )
  })

  it('refuses a physical attribute id that is not a plain identifier', () => {
    const bad = { ...DESCRIPTOR, columns: [{ name: 'value; drop table', valueType: 'string' as const }] }
    const mapping = buildProjectSnapshotMapping({ descriptor: bad })
    expect(() =>
      compileSemanticQuery(
        planFor(mapping.mappingRef),
        mapping,
        { budget: { maxRows: 100, maxBytes: 1_048_576, maxJoinFanout: 10 } },
      ),
    ).toThrowError(/not a plain identifier/u)
  })

  it('names the fixed snapshot source namespace', () => {
    expect(SOURCE_REF.namespace).toBe(PROJECT_DATASET_SOURCE_NAMESPACE)
  })
})

describe('project snapshot semantic query service', () => {
  it('returns typed rows with per-row source locators and strips the reserved columns', async () => {
    const port = new FakeProjectSnapshotQuery()
    const service = new ProjectSemanticQueryService({ query: port })
    const result = await service.execute({ descriptor: DESCRIPTOR, plan: planFor(), limits: LIMITS }, context())

    expect(result.mappingRef.id).toBe('project-snapshot:Meter')
    expect(result.snapshotRef).toEqual(SNAPSHOT_REF)
    expect(result.columns.map((column) => column.name)).toEqual(['deviceId', 'meterValue'])
    expect(result.columns.find((column) => column.name === 'meterValue')?.unit).toBe('Wh')
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]).toMatchObject({ recordId: 'rec-1', values: ['d1', '1005.0000000000'] })
    expect(result.rows[0]?.sources).toHaveLength(1)
    expect(result.rows[0]?.sources[0]).toMatchObject({ fieldId: 'meterValue', parseId: SOURCE_LOCATOR.parseId })
    expect(result.rows[1]?.sources).toEqual([])
    expect(result.coverage.returned).toBe(2)
    expect(result.snapshots).toHaveLength(1)

    // The executed plan projects the requested fields *and* the reserved identity/locator columns.
    expect(port.seenPlans[0]?.mode).toBe('direct')
    expect(port.seenPlans[0]?.sql).toContain('"record_id"')
    expect(port.seenPlans[0]?.sql).toContain('"sources_json"')
  })

  it('preserves the legacy mapping digest when the full source column uses the old default layout', () => {
    const expected = sha256DigestOf(JSON.stringify({
      id: 'project-snapshot:Meter',
      snapshotRef: SNAPSHOT_REF,
      objectId: 'Meter',
      dialect: 'duckdb',
      schema: 'main',
      relation: 'dsq_test_snapshot',
      sourceObjectRef: DESCRIPTOR.sourceObjectRef,
      columns: [
        { name: 'deviceId', valueType: 'string', canonicalUnitCode: null, dimension: null },
        { name: 'meterValue', valueType: 'quantity', canonicalUnitCode: 'Wh', dimension: 'energy' },
      ],
    }))
    expect(projectSnapshotMappingRef({ descriptor: DESCRIPTOR }).digest).toBe(expected)
  })

  it('pins an explicitly advertised full-source column while preserving the output contract', async () => {
    const port = new FakeProjectSnapshotQuery()
    const descriptor = { ...DESCRIPTOR, sourceProjection: 'full_array' as const }
    const service = new ProjectSemanticQueryService({ query: port })
    const result = await service.execute({ descriptor, plan: planFor(projectSnapshotMappingRef({ descriptor })), limits: LIMITS }, context())

    expect(port.seenPlans[0]?.sql).toContain('"sources_full_json"')
    expect(result.rows[0]?.sources).toEqual([SOURCE_LOCATOR])
    expect(result.columns.map((column) => column.name)).toEqual(['deviceId', 'meterValue'])
    expect(projectSnapshotMappingRef({ descriptor })).not.toEqual(projectSnapshotMappingRef({ descriptor: DESCRIPTOR }))

    const compactDescriptor = { ...descriptor, sourceProjection: 'compact_pin' as const }
    const compactMapping = buildProjectSnapshotMapping({ descriptor: compactDescriptor })
    expect(compactMapping.objects[0]?.fields.find((field) => field.fieldRef === 'sources_json')?.column).toBe('sources_json')
    expect(projectSnapshotMappingRef({ descriptor: compactDescriptor })).not.toEqual(projectSnapshotMappingRef({ descriptor }))
  })

  it('refuses a compact source token in the generic full-array source column', async () => {
    const port = new FakeProjectSnapshotQuery()
    port.responseRows = [[
      'd1',
      '1005.0000000000',
      'rec-1',
      JSON.stringify({ schemaVersion: 'project-dataset-source-origins@1', recordId: '00000000-0000-4000-8000-000000000001', sourcesDigest: `sha256:${'a'.repeat(64)}` }),
    ]]
    const service = new ProjectSemanticQueryService({ query: port })
    await expect(service.execute({ descriptor: DESCRIPTOR, plan: planFor(), limits: LIMITS }, context()))
      .rejects.toMatchObject({ code: 'SNAPSHOT_UNAVAILABLE', message: 'the fixed project row provenance is malformed' })
  })

  it('refuses a plan pinned to another mapping version instead of recompiling against latest', () => {
    const port = new FakeProjectSnapshotQuery()
    const service = new ProjectSemanticQueryService({ query: port })
    const plan = planFor({
      id: 'project-snapshot:Meter',
      version: '9.9.9',
      digest: `sha256:${'f'.repeat(64)}`,
    })
    return expect(
      service.execute({ descriptor: DESCRIPTOR, plan, limits: LIMITS }, context()),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
  })

  it('surfaces an adapter refusal as an explicit error, never a silent success', async () => {
    const port = new FakeProjectSnapshotQuery()
    port.validateResponse = {
      valid: false,
      warnings: [],
      rejectedReason: { code: 'UNSUPPORTED_QUERY', message: 'the SQL reads an unregistered object', retryable: false },
    }
    const service = new ProjectSemanticQueryService({ query: port })
    await expect(
      service.execute({ descriptor: DESCRIPTOR, plan: planFor(), limits: LIMITS }, context()),
    ).rejects.toBeInstanceOf(ProjectSemanticQueryError)
  })

  it('refuses a plan that names an attribute outside the fixed snapshot mapping', async () => {
    const port = new FakeProjectSnapshotQuery()
    const service = new ProjectSemanticQueryService({ query: port })
    const plan: SemanticQueryPlan = { ...planFor(), fields: ['notAnAttribute'] }
    await expect(
      service.execute({ descriptor: DESCRIPTOR, plan, limits: LIMITS }, context()),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_QUERY' })
  })
})
