import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createToolGatewayComposition } from '@ontology/app-api'
import { InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import type { DirectSqlQueryPlan, ToolCall } from '@ontology/contracts'
import { observeToolResult } from '../../composition/conformance'
import {
  CONFIGURED_MODULES,
  NOT_CONFIGURED_MODULES,
  X_CASE_REPORT,
} from '../../composition/not-configured'
import {
  EXPECTED_ROWS,
  MAPPING_C,
  OBJECT_C,
  SOURCE_C,
  rowsForMappingC,
  semanticPlan,
} from '../../fixtures/semantic-mapping'
import {
  canonicalToolValidator,
  fullProfile,
  gatewayContext,
  operationRegistry,
} from '../../unit/tool-gateway-fixtures'
import { PI_RUN, startAcceptanceEnvironment } from './acceptance-environment'
import type { AcceptanceEnvironment } from './acceptance-environment'
import { configureProfile, publishPiProfile } from './acceptance-helpers'

/**
 * LOCAL-054 cross-layer acceptance — the replaceability matrix.
 *
 * This leg drives the two runtimes end to end through the real workflow controller, and the
 * no-ontology direct path versus a second data mapping through the real DuckDB backend and
 * the real gateway. The two-transport (local / stdio MCP) and remaining X-cases are the
 * merged LOCAL-049 composition suite; this spec asserts that ledger rather than duplicating
 * the already-real conformance tests.
 */

let env: AcceptanceEnvironment

beforeAll(async () => {
  env = await startAcceptanceEnvironment()
  await configureProfile(env)
  await publishPiProfile(env)
  await env.duckdb.materialiseRelation('energy_readings_c', rowsForMappingC())
}, 300_000)

afterAll(async () => {
  await env?.close()
})

describe('LOCAL-054 matrix — both runtimes through the real controller', () => {
  it('publishes with the Template runtime', async () => {
    const view = await env.startTemplateRun('11111111-aaaa-4aaa-8aaa-0000000000b1')
    expect(view.state).toBe('published')
    expect(view.runtimeRef.id).toBe('runtime-template')
    expect(view.evidenceCount).toBe(2)
  })

  it('publishes with the Pi runtime on the same contract', async () => {
    const view = await env.startPiRun(PI_RUN)
    expect(view.state).toBe('published')
    expect(view.runtimeRef.id).toBe('runtime-pi')
    expect(view.evidenceCount).toBe(2)
  })
})

describe('LOCAL-054 matrix — no-ontology direct query versus a second mapping', () => {
  async function runDataQuery(call: ToolCall): Promise<ReturnType<typeof observeToolResult>> {
    const ctx = gatewayContext({
      tenantId: env.scope.tenantId,
      spaceId: env.scope.spaceId,
      sourceRefs: [SOURCE_C],
      deadline: '2099-01-01T00:00:00Z',
    })
    const ledgerId = randomUUID()
    await env.budget.openLedger({ ledgerId, kind: 'run', runId: ctx.runId }, ctx)
    const composition = createToolGatewayComposition({
      database: env.database,
      blobStore: env.blobStore,
      budget: env.budget,
      validator: canonicalToolValidator(),
      handlers: [
        new DataQueryHandler({
          query: env.duckdb,
          mappings: new InMemorySemanticMappingRegistry([MAPPING_C]),
        }),
      ],
    })
    const gateway = composition.forRun({
      runId: ctx.runId,
      ledgerId,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    })
    return observeToolResult(await gateway.invoke(call, ctx))
  }

  it('compiles and executes the second mapping with the real DuckDB backend', async () => {
    const observation = await runDataQuery({
      callId: randomUUID(),
      toolId: 'data_query',
      arguments: { kind: 'query', mode: 'semantic', queryPlan: semanticPlan(MAPPING_C) },
    })
    expect(observation.status).toBe('ok')
    expect(observation.rows).toEqual(EXPECTED_ROWS)
  })

  it('runs the no-ontology direct SQL path through the same handler and gateway', async () => {
    const plan: DirectSqlQueryPlan = {
      mode: 'direct',
      statementKind: 'select',
      sql: 'SELECT meter_id, energy_kwh FROM energy_readings_c WHERE status_text = ? ORDER BY meter_id',
      parameters: ['ok'],
      referencedObjects: [OBJECT_C],
      readOnly: true,
    }
    const observation = await runDataQuery({
      callId: randomUUID(),
      toolId: 'data_query',
      arguments: { kind: 'query', mode: 'direct', queryPlan: plan },
    })
    expect(observation.status).toBe('ok')
    expect(observation.rows?.length).toBeGreaterThan(0)
  })
})

describe('LOCAL-054 matrix — the two-transport and X-case ledger (reused from LOCAL-049)', () => {
  it('declares both local and stdio MCP transports as real configured modules', () => {
    const configured = CONFIGURED_MODULES.map((module) => module.moduleId)
    expect(configured).toContain('transport-local')
    expect(configured).toContain('transport-mcp-stdio')
    expect(configured).toContain('runtime-pi')
    expect(configured).toContain('runtime-template')
  })

  it('keeps every externally unverified module explicitly not_configured', () => {
    expect(NOT_CONFIGURED_MODULES.every((module) => module.state === 'not_configured')).toBe(true)
    const unverified = NOT_CONFIGURED_MODULES.map((module) => module.moduleId)
    expect(unverified).toContain('data-ha')
    expect(unverified).toContain('blob-s3')
    expect(unverified).toContain('search-vector')
    expect(unverified).toContain('data-starrocks')
    expect(unverified).toContain('data-iceberg')
    expect(unverified).toContain('search-milvus')
    expect(unverified).toContain('model-company-endpoint')
    expect(unverified).toContain('model-jev-endpoint')
    expect(unverified).toContain('transport-mcp-http')
  })

  it('reports every X-case as exercised with real adapters', () => {
    expect(X_CASE_REPORT.map((entry) => entry.caseId)).toEqual([
      'X-01',
      'X-02',
      'X-03',
      'X-04',
      'X-05',
      'X-06',
      'X-07',
      'X-08',
    ])
    expect(X_CASE_REPORT.every((entry) => entry.state === 'configured')).toBe(true)
  })
})
