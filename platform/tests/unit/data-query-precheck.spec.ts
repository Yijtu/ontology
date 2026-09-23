import { describe, expect, it } from 'vitest'
import type {
  CancelRequest,
  CancelResponse,
  DirectSqlQueryPlan,
  ScalarValue,
  SourceObjectRef,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryPort,
  StructuredQueryValidateRequest,
  StructuredQueryValidateResponse,
  ToolCall,
  ToolContext,
} from '@ontology/contracts'
import { InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import { validateReadOnlySql } from '@ontology/adapter-data-postgres'
import type { BusinessObjectMapping } from '@ontology/adapter-data-postgres'
import { DuckDbAdapterError, DuckDbQueryAdapter, validateSql, RelationRegistry } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import {
  ENERGY_SOURCE,
  READINGS_OBJECT,
  duckdbContext,
  readingsRelation,
} from '../fixtures/data-query/duckdb-relations'
import {
  GATEWAY_LEDGER,
  SOURCE_REF,
  buildGateway,
  gatewayContext,
  openGatewayLedger,
} from './tool-gateway-fixtures'

const NOW = '2026-09-21T00:00:00.000Z'

const ORDERS_OBJECT: SourceObjectRef = { sourceRef: SOURCE_REF, objectPath: 'sales.orders' }

const PG_ALLOWLIST: readonly BusinessObjectMapping[] = [
  {
    objectRef: ORDERS_OBJECT,
    schema: 'sales',
    relation: 'orders',
    relationKind: 'table',
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'amount', type: 'decimal' },
    ],
  },
]

function directPlan(sql: string, parameters: readonly ScalarValue[] = []): DirectSqlQueryPlan {
  return {
    mode: 'direct',
    statementKind: 'select',
    sql,
    parameters: [...parameters],
    referencedObjects: [ORDERS_OBJECT],
    readOnly: true,
  }
}

function call(queryPlan: DirectSqlQueryPlan, extra: Record<string, unknown> = {}): ToolCall {
  return {
    callId: '11111111-2222-4333-8444-555555555555',
    toolId: 'data_query',
    arguments: { kind: 'query', mode: 'direct', queryPlan, ...extra },
  }
}

function executeResponse(rows: readonly unknown[][]): StructuredQueryExecuteResponse {
  return {
    snapshot: {
      sourceRef: SOURCE_REF,
      schemaVersion: '2026-09-01',
      readAt: NOW,
      asOf: NOW,
      consistency: 'repeatable_read',
      resultDigest: `sha256:${'a'.repeat(64)}`,
    },
    columns: [{ name: 'id', type: 'integer' }],
    rows: [...rows],
    nextCursor: null,
    coverage: { returned: rows.length, truncated: false, completeness: 'complete' },
  }
}

/** A `StructuredQueryPort` whose validate/execute are scripted and whose order is observed. */
class ScriptedQueryPort implements StructuredQueryPort {
  readonly events: string[] = []
  readonly validated: StructuredQueryValidateRequest[] = []
  readonly executed: StructuredQueryExecuteRequest[] = []
  readonly contexts: ToolContext[] = []
  readonly #script: (request: StructuredQueryValidateRequest) => StructuredQueryValidateResponse

  constructor(script: (request: StructuredQueryValidateRequest) => StructuredQueryValidateResponse) {
    this.#script = script
  }

  async validate(request: StructuredQueryValidateRequest): Promise<StructuredQueryValidateResponse> {
    this.events.push('validate')
    this.validated.push(request)
    return this.#script(request)
  }

  async execute(
    request: StructuredQueryExecuteRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryExecuteResponse> {
    this.events.push('execute')
    this.executed.push(request)
    this.contexts.push(ctx)
    return executeResponse([[1]])
  }

  async cancel(request: CancelRequest): Promise<CancelResponse> {
    return { targetRef: request.targetRef, state: 'unsupported', acceptedAt: NOW }
  }
}

/** Delegate `validate` to the real PostgreSQL AST validator (no database is opened). */
function postgresValidator(
  request: StructuredQueryValidateRequest,
): StructuredQueryValidateResponse {
  const plan = request.plan
  if (plan.mode !== 'direct') {
    return { valid: false, warnings: [], rejectedReason: { code: 'UNSUPPORTED_QUERY', message: 'direct only', retryable: false } }
  }
  const result = validateReadOnlySql({
    sql: plan.sql,
    parameters: plan.parameters,
    allowlist: PG_ALLOWLIST,
    declaredObjects: plan.referencedObjects,
    authorizedSourceRefs: [SOURCE_REF],
  })
  if (result.valid) {
    return {
      valid: true,
      normalizedPlan: { ...plan, referencedObjects: [...result.referencedObjects] },
      warnings: [...result.warnings],
    }
  }
  return {
    valid: false,
    warnings: [...result.warnings],
    rejectedReason: { code: result.code, message: result.reason, retryable: false },
  }
}

function handlerFor(port: StructuredQueryPort): DataQueryHandler {
  return new DataQueryHandler({ query: port, mappings: new InMemorySemanticMappingRegistry([]) })
}

async function openLedger(harness: ReturnType<typeof buildGateway>, ctx: ToolContext): Promise<void> {
  await openGatewayLedger(harness, ctx)
}

describe('data_query static pre-execution check (LOCAL-077)', () => {
  it('runs the pre-check before execution and executes the checked plan on the same port and context', async () => {
    const port = new ScriptedQueryPort((request) => ({
      valid: true,
      normalizedPlan: request.plan,
      warnings: ['declared object sales.orders was not referenced by the statement'],
    }))
    const ctx = gatewayContext({ sourceRefs: [SOURCE_REF] })
    const harness = buildGateway({ handlers: [handlerFor(port)] })
    await openLedger(harness, ctx)

    const result = await harness.gateway.invoke(call(directPlan('SELECT id FROM sales.orders')), ctx)

    expect(result.status).toBe('ok')
    // Validate strictly precedes execute.
    expect(port.events).toEqual(['validate', 'execute'])
    // The exact plan that passed the pre-check is the one that executes, through the same
    // port instance and the same trusted context (same read-only role and binding path).
    expect(port.executed).toHaveLength(1)
    expect(port.executed[0]?.plan).toEqual(port.validated[0]?.plan)
    expect(port.contexts[0]).toBe(ctx)
    expect(result.warnings.map((warning) => warning.code)).toContain('QUERY_PRECHECK_WARNING')
  })

  it('reports a locatable rejection and never executes', async () => {
    const port = new ScriptedQueryPort(() => ({
      valid: false,
      warnings: [],
      rejectedReason: {
        code: 'UNSUPPORTED_QUERY',
        message: 'relation sales.secret is not in the principal\'s confirmed mapping',
        retryable: false,
      },
    }))
    const ctx = gatewayContext({ sourceRefs: [SOURCE_REF] })
    const harness = buildGateway({ handlers: [handlerFor(port)] })
    await openLedger(harness, ctx)

    const result = await harness.gateway.invoke(call(directPlan('SELECT id FROM sales.secret')), ctx)

    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('UNSUPPORTED_QUERY')
    expect(result.error?.message).toContain('sales.secret')
    expect(result.error?.fieldErrors?.[0]).toMatchObject({
      pointer: '/queryPlan/sql',
      reason: expect.stringContaining('sales.secret'),
    })
    expect(port.executed).toHaveLength(0)
    expect(port.events).toEqual(['validate'])
  })

  it('preserves the adapter field locators when the rejection carries them', async () => {
    const port = new ScriptedQueryPort(() => ({
      valid: false,
      warnings: [],
      rejectedReason: {
        code: 'INVALID_ARGUMENT',
        message: 'the statement references $2 but only 1 parameter(s) were supplied',
        retryable: false,
        fieldErrors: [{ pointer: '/queryPlan/parameters', reason: 'missing $2' }],
      },
    }))
    const ctx = gatewayContext({ sourceRefs: [SOURCE_REF] })
    const harness = buildGateway({ handlers: [handlerFor(port)] })
    await openLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      call(directPlan('SELECT id FROM sales.orders WHERE id = $2', [1])),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
    expect(result.error?.fieldErrors).toEqual([{ pointer: '/queryPlan/parameters', reason: 'missing $2' }])
  })

  it('rejects EXPLAIN, DESCRIBE and SHOW through the real PostgreSQL AST validator', async () => {
    for (const sql of [
      'EXPLAIN SELECT id FROM sales.orders',
      'DESCRIBE sales.orders',
      'SHOW search_path',
    ]) {
      const port = new ScriptedQueryPort(postgresValidator)
      const ctx = gatewayContext({ sourceRefs: [SOURCE_REF] })
      const harness = buildGateway({ handlers: [handlerFor(port)] })
      await openLedger(harness, ctx)

      const result = await harness.gateway.invoke(call(directPlan(sql)), ctx)
      expect(result.status, sql).toBe('error')
      expect(result.error?.code, sql).toBe('UNSUPPORTED_QUERY')
      expect(port.executed, sql).toHaveLength(0)
    }
  })

  it('lets valid read-only SQL through the pre-check to execution', async () => {
    const port = new ScriptedQueryPort(postgresValidator)
    const ctx = gatewayContext({ sourceRefs: [SOURCE_REF] })
    const harness = buildGateway({ handlers: [handlerFor(port)] })
    await openLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      call(directPlan('SELECT id FROM sales.orders WHERE id = $1', [1])),
      ctx,
    )
    expect(result.status).toBe('ok')
    expect(port.events).toEqual(['validate', 'execute'])
    const executedPlan = port.executed[0]?.plan
    expect(executedPlan?.mode).toBe('direct')
    if (executedPlan?.mode === 'direct') {
      expect(executedPlan.parameters).toEqual([1])
    }
  })

  it('does not charge execution rows when the pre-check fails (intent only)', async () => {
    const port = new ScriptedQueryPort(() => ({
      valid: false,
      warnings: [],
      rejectedReason: { code: 'UNSUPPORTED_QUERY', message: 'forbidden form', retryable: false },
    }))
    const ctx = gatewayContext({ sourceRefs: [SOURCE_REF] })
    const harness = buildGateway({ handlers: [handlerFor(port)] })
    await openLedger(harness, ctx)

    const before = await harness.budget.remaining(GATEWAY_LEDGER, ctx)
    const result = await harness.gateway.invoke(call(directPlan('EXPLAIN SELECT id FROM sales.orders')), ctx)
    const after = await harness.budget.remaining(GATEWAY_LEDGER, ctx)

    expect(result.status).toBe('error')
    // The call slot (intent) is consumed exactly once; no execution rows are billed.
    expect(after.remaining.toolCallsRemaining).toBe(before.remaining.toolCallsRemaining - 1)
    expect(after.rowsRemaining).toBe(before.rowsRemaining)
  })
})

describe('DuckDB sandbox rejects the textbook dry-run forms (LOCAL-077)', () => {
  const readings: RegisteredRelation = readingsRelation()

  it('rejects EXPLAIN, DESCRIBE and SHOW before the engine is opened', async () => {
    const adapter = new DuckDbQueryAdapter({
      relations: [readings],
      catalogSchemaRevision: '2026-09-01',
      now: () => NOW,
    })
    const handler = new DataQueryHandler({ query: adapter, mappings: new InMemorySemanticMappingRegistry([]) })
    const ctx = duckdbContext()
    const harness = buildGateway({ handlers: [handler], ctx })
    await openLedger(harness, ctx)

    for (const sql of ['EXPLAIN SELECT reading_id FROM readings', 'DESCRIBE readings', 'SHOW TABLES']) {
      const result = await harness.gateway.invoke(
        {
          callId: '11111111-2222-4333-8444-555555555555',
          toolId: 'data_query',
          arguments: {
            kind: 'query',
            mode: 'direct',
            queryPlan: {
              mode: 'direct',
              statementKind: 'select',
              sql,
              parameters: [],
              referencedObjects: [READINGS_OBJECT],
              readOnly: true,
            },
          },
        },
        ctx,
      )
      expect(result.status, sql).toBe('error')
      expect(result.error?.code, sql).toBe('UNSUPPORTED_QUERY')
    }
    adapter.close()
  })

  it('accepts a valid read-only SELECT through the same validator', () => {
    const registry = new RelationRegistry([readings])
    const validation = validateSql({
      sql: 'SELECT reading_id FROM readings WHERE quality_flag = ?',
      registry,
      allowedTableFunctions: new Set(),
    })
    expect(validation.referencedRelations.map((relation) => relation.objectRef.objectPath)).toEqual([
      READINGS_OBJECT.objectPath,
    ])
    expect(validation.facts.parameters).toBe(1)
    expect(ENERGY_SOURCE).toEqual(READINGS_OBJECT.sourceRef)

    expect(() =>
      validateSql({ sql: 'EXPLAIN SELECT reading_id FROM readings', registry, allowedTableFunctions: new Set() }),
    ).toThrow(DuckDbAdapterError)
  })
})
