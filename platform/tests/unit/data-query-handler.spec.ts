import { describe, expect, it } from 'vitest'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import type {
  CancelRequest,
  CancelResponse,
  DirectSqlQueryPlan,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  StructuredQueryPort,
  StructuredQueryValidateResponse,
  ToolContext,
  ToolCall,
} from '@ontology/contracts'
import {
  InMemorySemanticMappingRegistry,
  type SemanticMappingRegistry,
} from '@ontology/semantic-engine'
import { DataQueryHandler, createRunToolGateway, type ToolHandler } from '@ontology/tool-services'
import type { BudgetLedgerPort } from '@ontology/contracts'
import { MAPPING_A, OBJECT_A, SOURCE_A, semanticPlan } from '../fixtures/semantic-mapping'
import {
  GATEWAY_LEDGER,
  GATEWAY_RUN,
  InMemoryArtifactWriter,
  InMemoryEvidenceStore,
  canonicalToolValidator,
  fullProfile,
  gatewayContext,
  operationRegistry,
} from './tool-gateway-fixtures'
import { RecordingControlRepository } from './component-registry-fixtures'

const NOW = '2026-09-21T00:00:00Z'

class FakeStructuredQueryPort implements StructuredQueryPort {
  readonly executed: StructuredQueryExecuteRequest[] = []
  readonly contexts: ToolContext[] = []
  validateCalls = 0
  #rows: unknown[][] = [['m1', '2026-01-01T00:00:00.000Z', '12.5000000000', 'good']]

  async validate(): Promise<StructuredQueryValidateResponse> {
    this.validateCalls += 1
    return { valid: true, warnings: [] }
  }

  async execute(
    request: StructuredQueryExecuteRequest,
    ctx: ToolContext,
  ): Promise<StructuredQueryExecuteResponse> {
    this.executed.push(request)
    this.contexts.push(ctx)
    return {
      snapshot: {
        sourceRef: SOURCE_A,
        schemaVersion: '2026-09-01',
        readAt: NOW,
        asOf: NOW,
        consistency: 'repeatable_read',
        resultDigest: `sha256:${'a'.repeat(64)}`,
      },
      columns: [
        { name: 'meter_id', type: 'string' },
        { name: 'recorded_at', type: 'timestamp' },
        { name: 'energy_kwh', type: 'decimal' },
        { name: 'status', type: 'string' },
      ],
      rows: [...this.#rows],
      nextCursor: null,
      coverage: { returned: this.#rows.length, truncated: false, completeness: 'complete' },
    }
  }

  async cancel(request: CancelRequest): Promise<CancelResponse> {
    return { targetRef: request.targetRef, state: 'unsupported', acceptedAt: NOW }
  }
}

function buildGateway(handler: ToolHandler): {
  readonly gateway: ReturnType<typeof createRunToolGateway>
  readonly budget: BudgetLedgerPort
  readonly evidence: InMemoryEvidenceStore
} {
  const ledgerStore = new InMemoryBudgetLedgerStore()
  const inner = new BudgetService({
    store: ledgerStore,
    control: new RecordingControlRepository(),
    now: () => NOW,
  })
  const budget: BudgetLedgerPort = {
    openLedger: (input, ctx) => inner.openLedger(input, ctx),
    reserve: (input, ctx) => inner.reserve(input, ctx),
    recordIntent: (input, ctx) => inner.recordIntent(input, ctx),
    settle: (input, ctx) => inner.settle(input, ctx),
    remaining: (ledgerId, ctx) => inner.remaining(ledgerId, ctx),
  }
  const evidence = new InMemoryEvidenceStore()
  const artifacts = new InMemoryArtifactWriter()
  const gateway = createRunToolGateway(
    { validator: canonicalToolValidator(), budget, evidence, artifacts, handlers: [handler] },
    {
      runId: GATEWAY_RUN,
      ledgerId: GATEWAY_LEDGER,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    },
  )
  return { gateway, budget, evidence }
}

function directPlan(): DirectSqlQueryPlan {
  return {
    mode: 'direct',
    statementKind: 'select',
    sql: 'SELECT meter_id FROM public.energy_readings_a',
    parameters: [],
    referencedObjects: [OBJECT_A],
    readOnly: true,
  }
}

function call(argumentsValue: Record<string, unknown>): ToolCall {
  return { callId: '11111111-2222-4333-8444-555555555555', toolId: 'data_query', arguments: argumentsValue }
}

async function openLedger(budget: BudgetLedgerPort, ctx: ToolContext): Promise<void> {
  await budget.openLedger({ ledgerId: GATEWAY_LEDGER, kind: 'run', runId: GATEWAY_RUN }, ctx)
}

describe('data_query handler through the gateway', () => {
  it('executes a direct plan through the gateway, catalogue and permission path', async () => {
    const port = new FakeStructuredQueryPort()
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A] })
    const handler = new DataQueryHandler({ query: port, mappings: new InMemorySemanticMappingRegistry([]) })
    const harness = buildGateway(handler)
    await openLedger(harness.budget, ctx)

    const result = await harness.gateway.invoke(
      call({ kind: 'query', mode: 'direct', queryPlan: directPlan() }),
      ctx,
    )

    expect(result.status).toBe('ok')
    expect(port.executed).toHaveLength(1)
    expect(port.executed[0]?.plan).toMatchObject({ mode: 'direct', sql: directPlan().sql })
    // The adapter received exactly the run context the gateway was invoked with; the
    // handler captured no context of its own.
    expect(port.contexts).toHaveLength(1)
    expect(port.contexts[0]).toBe(ctx)
    expect(harness.evidence.records).toHaveLength(1)
    expect(result.evidenceRefs).toHaveLength(1)
  })

  it('compiles a semantic plan to a parameterised direct plan with no extra planning round', async () => {
    const port = new FakeStructuredQueryPort()
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A] })
    const mappings: SemanticMappingRegistry = new InMemorySemanticMappingRegistry([MAPPING_A])
    const handler = new DataQueryHandler({ query: port, mappings })
    const harness = buildGateway(handler)
    await openLedger(harness.budget, ctx)

    const result = await harness.gateway.invoke(
      call({ kind: 'query', mode: 'semantic', queryPlan: semanticPlan(MAPPING_A) }),
      ctx,
    )

    expect(result.status).toBe('ok')
    // Exactly one execute and no separate validate/plan round: the port only runs the
    // compiled query, it does not start a second planner.
    expect(port.executed).toHaveLength(1)
    expect(port.validateCalls).toBe(0)
    const plan = port.executed[0]?.plan
    expect(plan?.mode).toBe('direct')
    if (plan?.mode === 'direct') {
      expect(plan.sql).toContain('"energy_readings_a"')
      expect(plan.sql).toContain('$1')
      expect(plan.parameters.length).toBeGreaterThan(0)
    }
    expect(result.warnings.some((warning) => warning.code === 'SEMANTIC_MAPPING_VERSION')).toBe(true)
    expect(result.warnings[0]?.message).toContain(MAPPING_A.mappingRef.id)
  })

  it('refuses a direct plan whose source is outside the trusted allowlist', async () => {
    const port = new FakeStructuredQueryPort()
    const ctx = gatewayContext({ sourceRefs: [{ namespace: 'other', sourceId: 'warehouse' }] })
    const handler = new DataQueryHandler({ query: port, mappings: new InMemorySemanticMappingRegistry([]) })
    const harness = buildGateway(handler)
    await openLedger(harness.budget, ctx)

    const result = await harness.gateway.invoke(
      call({ kind: 'query', mode: 'direct', queryPlan: directPlan() }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
    expect(port.executed).toHaveLength(0)
  })

  it('refuses the compute branch because it is served by a registered operation handler', async () => {
    const port = new FakeStructuredQueryPort()
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A] })
    const handler = new DataQueryHandler({ query: port, mappings: new InMemorySemanticMappingRegistry([]) })
    const harness = buildGateway(handler)
    await openLedger(harness.budget, ctx)

    const result = await harness.gateway.invoke(
      call({
        kind: 'compute',
        operationRef: { id: 'home-energy.plan', version: '1.0.0' },
        inputSchemaDigest: `sha256:${'b'.repeat(64)}`,
        inputRefs: [],
        parameters: {},
      }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(port.executed).toHaveLength(0)
  })

  it('is rejected when the pinned mapping version is not available', async () => {
    const port = new FakeStructuredQueryPort()
    const ctx = gatewayContext({ sourceRefs: [SOURCE_A] })
    const handler = new DataQueryHandler({ query: port, mappings: new InMemorySemanticMappingRegistry([]) })
    const harness = buildGateway(handler)
    await openLedger(harness.budget, ctx)

    const result = await harness.gateway.invoke(
      call({ kind: 'query', mode: 'semantic', queryPlan: semanticPlan(MAPPING_A) }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(port.executed).toHaveLength(0)
  })
})
