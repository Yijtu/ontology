import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CONTROLLER_SERVICE_IDS,
  TOOL_CATALOGUE,
  TOOL_IDS,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
} from '@ontology/contracts'
import {
  ToolGatewayError,
  assertCatalogueExcludesControllerServices,
  resolveEnabledTools,
  type ToolExecutionOutcome,
} from '@ontology/tool-services'
import {
  LocalTransportError,
  createLocalToolRegistration,
  registerWithRuntime,
} from '@ontology/adapter-transport-local'
import {
  GATEWAY_RUN,
  GATEWAY_SCOPE,
  DATASET_REF,
  RecordingHandler,
  buildGateway,
  canonicalToolValidator,
  fullProfile,
  gatewayContext,
  observation,
  okOutcome,
  openGatewayLedger,
  resolvedProfile,
} from './tool-gateway-fixtures'

const COMPUTE_DIGEST = `sha256:${'2'.repeat(64)}`
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const SPACE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function forgedCall(toolId: string, args: Record<string, unknown> = {}): ToolCall {
  const raw: { callId: string; toolId: string; arguments: Record<string, unknown> } = {
    callId: randomUUID(),
    toolId,
    arguments: args,
  }
  return raw as ToolCall
}

function lookupHandler(outcome: ToolExecutionOutcome = okOutcome()): RecordingHandler {
  return new RecordingHandler('ontology_lookup', outcome)
}

function documentHandler(outcome: ToolExecutionOutcome): RecordingHandler {
  return new RecordingHandler('document_search', outcome)
}

function dataQueryHandler(outcome: ToolExecutionOutcome): RecordingHandler {
  return new RecordingHandler('data_query', outcome)
}

function webHandler(outcome: ToolExecutionOutcome): RecordingHandler {
  return new RecordingHandler('web_search', outcome)
}

const DOC_ARGS = {
  query: 'backup requirement',
  allowedCollectionRefs: ['home-energy/manuals'],
  mode: 'keyword',
}
const WEB_ARGS = { query: 'home energy tariff', allowedDomains: ['example.com'] }

function computeArgs(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'compute',
    operationRef: { id: 'home-energy.plan', version: '1' },
    inputSchemaDigest: COMPUTE_DIGEST,
    inputRefs: [DATASET_REF],
    parameters: { siteRef: 'site-demo-a', strategyWhitelist: ['self_consumption'] },
    ...overrides,
  }
}

describe('catalogue gating (four tools only, controller services excluded)', () => {
  it('resolves exactly the four canonical tools for a full profile', () => {
    expect(resolveEnabledTools(fullProfile()).map((entry) => entry.definition.toolId)).toEqual([
      ...TOOL_IDS,
    ])
  })

  it('narrows to the profile-enabled subset and never adds a tool', () => {
    const profile = resolvedProfile({
      toolBindings: [
        { toolId: 'ontology_lookup', enabled: true },
        { toolId: 'data_query', enabled: true },
        { toolId: 'document_search', enabled: true },
        { toolId: 'web_search', enabled: false },
      ],
    })
    expect(resolveEnabledTools(profile).map((entry) => entry.definition.toolId)).toEqual([
      'ontology_lookup',
      'data_query',
      'document_search',
    ])
  })

  it('refuses a catalogue that lists a controller service', () => {
    const first = TOOL_CATALOGUE[0]
    if (first === undefined) throw new Error('the catalogue is empty')
    const controllerId: string = 'verify_result'
    const forged: ToolDefinition = { ...first, toolId: controllerId } as ToolDefinition
    expect(() => assertCatalogueExcludesControllerServices([...TOOL_CATALOGUE, forged])).toThrow(
      ToolGatewayError,
    )
    try {
      assertCatalogueExcludesControllerServices([...TOOL_CATALOGUE, forged])
    } catch (error) {
      expect(error).toBeInstanceOf(ToolGatewayError)
      expect((error as ToolGatewayError).code).toBe('CONTROLLER_SERVICE_NOT_CALLABLE')
    }
  })

  it('rejects final_answer and verify_result as tools and never executes them', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    for (const controllerService of CONTROLLER_SERVICE_IDS) {
      const result = await harness.gateway.invoke(forgedCall(controllerService), ctx)
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe('FORBIDDEN')
      expect(result.evidenceRefs).toEqual([])
    }
    expect(handler.calls).toHaveLength(0)
    expect(harness.evidence.records).toHaveLength(0)
  })

  it('rejects an unknown tool id', async () => {
    const harness = buildGateway({ handlers: [lookupHandler()] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)
    const result = await harness.gateway.invoke(forgedCall('execute_sql'), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('rejects a tool the resolved profile disabled', async () => {
    const profile = resolvedProfile({
      toolBindings: [
        { toolId: 'ontology_lookup', enabled: true },
        { toolId: 'data_query', enabled: true },
        { toolId: 'document_search', enabled: true },
        { toolId: 'web_search', enabled: false },
      ],
    })
    const handler = webHandler(okOutcome({ pages: [] }))
    const harness = buildGateway({ handlers: [handler], profile })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(forgedCall('web_search', WEB_ARGS), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(handler.calls).toHaveLength(0)
  })
})

describe('fixed gateway order (validate -> reserve -> intent -> execute -> evidence -> settle)', () => {
  it('runs every phase in order and returns a traceable success', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )

    expect(harness.log).toEqual([
      'validate',
      'reserve',
      'intent',
      'execute',
      'artifact',
      'evidence',
      'settle:completed',
    ])
    expect(result.status).toBe('ok')
    expect(result.evidenceRefs).toHaveLength(1)
    expect(harness.evidence.records).toHaveLength(1)
  })

  it('does not reserve budget when the arguments fail schema validation', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'everything' }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
    expect(harness.log).not.toContain('reserve')
    expect(harness.log).not.toContain('execute')
  })

  it('records the intent before the handler runs and refuses to run without it', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler], failIntent: true })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(harness.log).toEqual(['validate', 'reserve', 'intent', 'settle:failed'])
    expect(handler.calls).toHaveLength(0)
    expect(harness.evidence.records).toHaveLength(0)
  })

  it('refuses a reservation denial before recording an intent', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx, { maxToolCalls: 0 })

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('BUDGET_EXHAUSTED')
    expect(harness.log).toEqual(['validate', 'reserve'])
    expect(handler.calls).toHaveLength(0)
  })
})

describe('evidence gates a traceable success', () => {
  it('never returns ok when the result artifact cannot be archived', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    harness.artifacts.failNext = true
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('EVIDENCE_PERSIST_FAILED')
    expect(result.evidenceRefs).toEqual([])
    expect(harness.evidence.records).toHaveLength(0)
    expect(harness.log).toContain('settle:failed')
  })

  it('never returns ok when the evidence cannot be persisted, even though the handler ran', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    harness.evidence.failNext = true
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('EVIDENCE_PERSIST_FAILED')
    expect(result.evidenceRefs).toEqual([])
    expect(handler.calls).toHaveLength(1)
    expect(harness.log).toEqual([
      'validate',
      'reserve',
      'intent',
      'execute',
      'artifact',
      'evidence',
      'settle:failed',
    ])
  })

  it('archives the result, the source snapshot and the evidence on success', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('ok')
    expect(result.dataRef?.kind).toBe('artifact')
    expect(result.sourceSnapshots).toHaveLength(1)
    expect(result.sourceSnapshots[0]?.archivedResultRef?.id).toBe(result.dataRef?.id)
    expect(harness.artifacts.written).toHaveLength(1)

    const record = harness.evidence.records[0]
    expect(record?.evidenceRef.kind).toBe('evidence')
    expect(record?.envelope.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(record?.envelopeDigest).toBe(record?.envelope.integrity.digest)
  })
})

describe('error / empty / partial stay distinct', () => {
  it('returns a successful empty result, not an error', async () => {
    const handler = lookupHandler({
      payload: [],
      status: 'empty',
      coverage: { returned: 0, truncated: false, completeness: 'complete' },
      sources: [observation()],
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'facts' }),
      ctx,
    )
    expect(result.status).toBe('empty')
    expect(result.error).toBeUndefined()
    expect(result.coverage).toEqual({ returned: 0, truncated: false, completeness: 'complete' })
    expect(result.evidenceRefs).toHaveLength(1)
  })

  it('keeps a truncated recall range as partial with coverage.truncated', async () => {
    const handler = lookupHandler({
      payload: { items: [1, 2, 3] },
      status: 'partial',
      coverage: { returned: 3, knownTotal: 100, truncated: true, completeness: 'truncated' },
      sources: [observation()],
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('partial')
    expect(result.coverage.truncated).toBe(true)
    expect(result.coverage.knownTotal).toBe(100)
  })

  it('rejects a partial outcome that does not declare truncation', async () => {
    const handler = lookupHandler({
      payload: { items: [1] },
      status: 'partial',
      coverage: { returned: 1, truncated: false },
      sources: [observation()],
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INTERNAL_ERROR')
  })

  it('rejects an ok outcome that hides a truncated recall range', async () => {
    const handler = lookupHandler({
      payload: { items: [1] },
      status: 'ok',
      coverage: { returned: 1, truncated: true, completeness: 'truncated' },
      sources: [observation()],
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('error')
  })

  it('treats a domain infeasible computation as a successful result, not a platform error', async () => {
    const handler = dataQueryHandler({
      payload: {
        resultKind: 'computation',
        computation: { domainStatus: 'infeasible' },
      },
      status: 'ok',
      coverage: { returned: 1, truncated: false },
      sources: [observation()],
      domainStatus: 'infeasible',
      evidenceKind: 'computation',
      dataMode: 'simulation',
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(forgedCall('data_query', computeArgs()), ctx)
    expect(result.status).toBe('ok')
    expect(result.domainStatus).toBe('infeasible')
    expect(result.error).toBeUndefined()
  })
})

describe('identity and allowlists come from the trusted context only', () => {
  it('rejects a model-supplied scope that differs from the trusted context', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', {
        scopeRef: { tenantId: TENANT_B, spaceId: SPACE_B },
        intent: 'definitions',
      }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
    expect(handler.calls).toHaveLength(0)
  })

  it('rejects host-only identity fields in the arguments', async () => {
    const harness = buildGateway({ handlers: [lookupHandler()] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', {
        scopeRef: GATEWAY_SCOPE,
        intent: 'definitions',
        tenantId: TENANT_B,
        principal: { tenantId: TENANT_B },
      }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('rejects a domain allowlist wider than the trusted context', async () => {
    const handler = webHandler(okOutcome({ pages: [] }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('web_search', { query: 'x', allowedDomains: ['evil.example.net'] }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
    expect(handler.calls).toHaveLength(0)
  })

  it('rejects a collection outside the approved collection set', async () => {
    const handler = documentHandler({
      payload: { spans: [], scoreKind: 'none', completeness: 'complete' },
      status: 'ok',
      coverage: { returned: 1, truncated: false },
      sources: [observation()],
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('document_search', { ...DOC_ARGS, allowedCollectionRefs: ['secret-collection'] }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
  })

  it('accepts the trusted scope and executes against it', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('ok')
    expect(handler.calls[0]?.arguments.scopeRef).toEqual(GATEWAY_SCOPE)
  })

  it('refuses a trusted context bound to a different run', async () => {
    const harness = buildGateway({ handlers: [lookupHandler()] })
    const otherRun: ToolContext = gatewayContext({ runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' })
    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      otherRun,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
    expect(otherRun.runId).not.toBe(GATEWAY_RUN)
  })
})

describe('compute references only registered, enabled operations (ADR-11)', () => {
  it('rejects an unregistered operation even with well-formed parameters', async () => {
    const handler = dataQueryHandler(okOutcome({ resultKind: 'computation' }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall(
        'data_query',
        computeArgs({ operationRef: { id: 'home-energy.dispatch', version: '1' } }),
      ),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(handler.calls).toHaveLength(0)
  })

  it('rejects a registered operation the profile did not enable', async () => {
    const profile = fullProfile()
    const disabled = resolvedProfile({
      computeBindings: profile.computeBindings.map((binding) => ({ ...binding, enabled: false })),
    })
    const handler = dataQueryHandler(okOutcome({ resultKind: 'computation' }))
    const harness = buildGateway({ handlers: [handler], profile: disabled })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(forgedCall('data_query', computeArgs()), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(handler.calls).toHaveLength(0)
  })

  it('rejects parameters that do not match the registered operation schema', async () => {
    const handler = dataQueryHandler(okOutcome({ resultKind: 'computation' }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall(
        'data_query',
        computeArgs({ parameters: { strategyWhitelist: ['sell_everything'] } }),
      ),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
    expect(result.error?.fieldErrors?.length ?? 0).toBeGreaterThan(0)
  })

  it('rejects a code or script field in the compute parameters', async () => {
    const handler = dataQueryHandler(okOutcome({ resultKind: 'computation' }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall(
        'data_query',
        computeArgs({
          parameters: {
            siteRef: 'site-demo-a',
            strategyWhitelist: ['self_consumption'],
            code: 'export function hack() {}',
          },
        }),
      ),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
    expect(handler.calls).toHaveLength(0)
  })

  it('executes a registered, enabled operation with matching schema digest', async () => {
    const handler = dataQueryHandler({
      payload: { resultKind: 'computation' },
      status: 'ok',
      coverage: { returned: 1, truncated: false },
      sources: [observation()],
      evidenceKind: 'computation',
      dataMode: 'simulation',
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(forgedCall('data_query', computeArgs()), ctx)
    expect(result.status).toBe('ok')
    expect(handler.calls).toHaveLength(1)
    expect(harness.evidence.records[0]?.envelope.kind).toBe('computation')
    expect(harness.evidence.records[0]?.envelope.dataMode).toBe('simulation')
  })
})

describe('malicious and oversized parameters are rejected before execution', () => {
  it('rejects prototype-pollution-shaped arguments', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const polluted = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>
    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions', ...polluted }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
    expect(handler.calls).toHaveLength(0)
  })

  it('rejects a requested row limit above the tool ceiling', async () => {
    const handler = documentHandler(okOutcome({ spans: [] }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    // document_search's schema allows limit up to 1000, but the tool ceiling is 200.
    const result = await harness.gateway.invoke(
      forgedCall('document_search', { ...DOC_ARGS, limit: 500 }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('RESULT_TOO_LARGE')
    expect(handler.calls).toHaveLength(0)
  })

  it('rejects an unbounded collection in the arguments', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const concepts = Array.from({ length: 2_000 }, (_, index) => ({
      namespace: 'home-energy',
      conceptId: `concept-${String(index)}`,
    }))
    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions', concepts }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('RESULT_TOO_LARGE')
    expect(handler.calls).toHaveLength(0)
  })

  it('rejects an oversized single argument string', async () => {
    const handler = documentHandler(okOutcome({ spans: [] }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('document_search', { ...DOC_ARGS, query: 'x'.repeat(70_000) }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('RESULT_TOO_LARGE')
    expect(handler.calls).toHaveLength(0)
  })

  it('rejects an oversized result instead of truncating it silently', async () => {
    const handler = documentHandler({
      payload: { spans: [] },
      status: 'ok',
      coverage: { returned: 300, truncated: false },
      sources: [observation()],
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(forgedCall('document_search', DOC_ARGS), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('RESULT_TOO_LARGE')
  })

  it('rejects a success without any source snapshot', async () => {
    const handler = lookupHandler({
      payload: { items: [] },
      status: 'ok',
      coverage: { returned: 1, truncated: false },
      sources: [],
    })
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('error')
    expect(harness.evidence.records).toHaveLength(0)
  })
})

describe('restricted closure handed to the runtime (C5)', () => {
  it('registers the four tools and injects only the gateway facade', async () => {
    const harness = buildGateway({ handlers: [lookupHandler()] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)
    const registration = createLocalToolRegistration({
      tools: harness.tools,
      gateway: harness.gateway,
    })

    expect(registration.tools.map((tool) => tool.toolId)).toEqual([...TOOL_IDS])
    expect(Object.keys(registration.dependencies)).toEqual(['gateway'])
    expect(Object.keys(registration.dependencies.gateway).sort()).toEqual(['cancel', 'invoke'])
    expect(
      Object.values(registration.dependencies.gateway).every((value) => typeof value === 'function'),
    ).toBe(true)
    expect(Object.isFrozen(registration.dependencies.gateway)).toBe(true)
  })

  it('exposes no store, driver or filesystem handle reachable from the dependency object', () => {
    const harness = buildGateway({ handlers: [lookupHandler()] })
    const registration = createLocalToolRegistration({
      tools: harness.tools,
      gateway: harness.gateway,
    })

    const forbidden = [
      'reserve',
      'settle',
      'recordIntent',
      'openLedger',
      'putImmutable',
      'putBytes',
      'getAuthorized',
      'appendEvent',
      'readProjection',
      'query',
      'stage',
      'publish',
      'getLedger',
      'close',
    ]
    const reachable = collectObjects(registration.dependencies)
    for (const object of reachable) {
      for (const key of Object.keys(object)) {
        expect(forbidden, `forbidden capability ${key} is reachable from the runtime dependencies`).not.toContain(key)
      }
    }
  })

  it('registers the definitions with the runtime and routes invocation through the gateway', async () => {
    const handler = lookupHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const registered: string[] = []
    const runtime = {
      registerTools: (tools: readonly ToolDefinition[]): void => {
        registered.push(...tools.map((tool) => tool.toolId))
      },
    }
    const registration = createLocalToolRegistration({
      tools: harness.tools,
      gateway: harness.gateway,
    })
    registerWithRuntime(runtime, registration)

    expect(registered).toEqual([...TOOL_IDS])
    const result = await registration.dependencies.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(result.status).toBe('ok')
    expect(handler.calls).toHaveLength(1)
  })

  it('refuses to register a controller service as a model tool', () => {
    const harness = buildGateway({ handlers: [lookupHandler()] })
    const first = TOOL_CATALOGUE[0]
    if (first === undefined) throw new Error('the catalogue is empty')
    const controllerId: string = 'final_answer'
    const forged = { ...first, toolId: controllerId } as ToolDefinition
    expect(() =>
      createLocalToolRegistration({ tools: [forged], gateway: harness.gateway }),
    ).toThrow(LocalTransportError)
  })
})

describe('results conform to the canonical ToolResult schema', () => {
  it('validates a success and an error result against tools.schema.json#/$defs/ToolResult', async () => {
    const validate = canonicalToolValidator()
    const ref = 'https://ontology.local/schema/tools.schema.json#/$defs/ToolResult'

    const harness = buildGateway({ handlers: [lookupHandler()] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)
    const ok = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      ctx,
    )
    expect(validate.validateRef(ref, ok)).toEqual({ valid: true, issues: [] })

    const error = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'nope' }),
      ctx,
    )
    expect(validate.validateRef(ref, error)).toEqual({ valid: true, issues: [] })
    expect(error.status).toBe('error')
  })

  it('rejects a model-shaped object as a trusted context', async () => {
    const harness = buildGateway({ handlers: [lookupHandler()] })
    const ctx = gatewayContext()
    const deserialized = JSON.parse(JSON.stringify(ctx)) as ToolContext
    const result = await harness.gateway.invoke(
      forgedCall('ontology_lookup', { scopeRef: GATEWAY_SCOPE, intent: 'definitions' }),
      deserialized,
    )
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
  })
})

/** Collect every plain object reachable through own enumerable properties. */
function collectObjects(root: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const record = value as Record<string, unknown>
    found.push(record)
    for (const entry of Object.values(record)) visit(entry)
  }
  visit(root)
  return found
}
