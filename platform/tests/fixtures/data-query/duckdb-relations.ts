import { createToolContext } from '@ontology/contracts'
import type { QueryColumn, ScopeRef, SourceObjectRef, SourceRef, ToolContext } from '@ontology/contracts'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'

/**
 * Shared fixtures for the DuckDB adapter tests. The same logical relation shape is what
 * the PostgreSQL adapter must expose for the X-03 equivalence check, so it is kept in one
 * place rather than duplicated per test file.
 */
export const DUCKDB_TENANT = '11111111-1111-4111-8111-111111111111'
export const DUCKDB_SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
export const DUCKDB_RUN = '33333333-3333-4333-8333-333333333333'
export const DUCKDB_DEADLINE = '2099-01-01T00:00:00Z'

export const DUCKDB_SCOPE: ScopeRef = {
  tenantId: DUCKDB_TENANT,
  spaceId: DUCKDB_SPACE,
}

export const ENERGY_SOURCE: SourceRef = { namespace: 'home-energy', sourceId: 'warehouse' }
export const OTHER_SOURCE: SourceRef = { namespace: 'other', sourceId: 'warehouse' }

export const READINGS_OBJECT: SourceObjectRef = {
  sourceRef: ENERGY_SOURCE,
  objectPath: 'public.energy_readings',
}

export const READINGS_COLUMNS: readonly QueryColumn[] = [
  { name: 'reading_id', type: 'string' },
  { name: 'meter_id', type: 'string' },
  { name: 'recorded_at', type: 'timestamp' },
  { name: 'energy_kwh', type: 'decimal' },
  { name: 'quality_flag', type: 'integer' },
  { name: 'is_estimated', type: 'boolean' },
]

export function readingsRelation(overrides: Partial<RegisteredRelation> = {}): RegisteredRelation {
  return {
    relation: 'readings',
    objectRef: READINGS_OBJECT,
    schemaRevision: '2026-09-01',
    columns: READINGS_COLUMNS,
    physicalTypes: { energy_kwh: 'DECIMAL(18,4)', recorded_at: 'TIMESTAMP' },
    ...overrides,
  }
}

export const READINGS_ROWS: readonly (readonly (string | number | boolean | null)[])[] = [
  ['r1', 'm1', '2026-01-01T00:00:00Z', 12.5, 1, false],
  ['r2', 'm1', '2026-01-02T00:00:00Z', 8.25, 0, false],
  ['r3', 'm1', '2026-01-03T00:00:00Z', 15.0, 1, true],
  ['r4', 'm2', '2026-01-01T00:00:00Z', 20.0, 1, false],
  ['r5', 'm2', '2026-01-02T00:00:00Z', 9.75, 0, false],
  ['r6', 'm3', '2026-01-01T00:00:00Z', 11.0, 1, false],
]

export interface ContextOverrides {
  readonly sourceRefs?: readonly SourceRef[]
  readonly maxRows?: number
  readonly deadline?: string
  readonly runId?: string
}

/** A trusted context whose source allowlist matches the registered relation. */
export function duckdbContext(overrides: ContextOverrides = {}): ToolContext {
  const runId = overrides.runId ?? DUCKDB_RUN
  return createToolContext({
    principal: {
      tenantId: DUCKDB_TENANT,
      subjectId: 'user:duckdb-test',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: `sha256:${'2'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: overrides.deadline ?? DUCKDB_DEADLINE,
    budgetReservation: {
      reservationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      runId,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: overrides.deadline ?? DUCKDB_DEADLINE,
    },
    allowedResources: {
      tenantId: DUCKDB_TENANT,
      spaceId: DUCKDB_SPACE,
      resourceKinds: ['dataset'],
      sourceRefs: [...(overrides.sourceRefs ?? [ENERGY_SOURCE])],
      collectionRefs: [],
      domains: [],
      maxRows: overrides.maxRows ?? 1000,
    },
    traceId: 'trace-duckdb',
  })
}

export function directPlan(overrides: {
  readonly sql: string
  readonly parameters?: readonly (string | number | boolean | null)[]
  readonly referencedObjects?: readonly SourceObjectRef[]
}): {
  mode: 'direct'
  statementKind: 'select'
  sql: string
  parameters: (string | number | boolean | null)[]
  referencedObjects: SourceObjectRef[]
  readOnly: true
} {
  return {
    mode: 'direct',
    statementKind: 'select',
    sql: overrides.sql,
    parameters: [...(overrides.parameters ?? [])],
    referencedObjects: [...(overrides.referencedObjects ?? [READINGS_OBJECT])],
    readOnly: true,
  }
}
