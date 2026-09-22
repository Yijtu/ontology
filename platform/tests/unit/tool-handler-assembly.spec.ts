import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ERROR_CATALOG,
  TOOL_CONTEXT_BRAND,
  type ErrorCode,
  type ToolCall,
  type ToolContext,
} from '@ontology/contracts'
import {
  ToolGatewayError,
  cancellationError,
  type ToolExecutionOutcome,
  type ToolExecutionRequest,
  type ToolHandler,
} from '@ontology/tool-services'
import {
  GATEWAY_LEDGER,
  RecordingHandler,
  buildGateway,
  gatewayContext,
  okOutcome,
  openGatewayLedger,
} from './tool-gateway-fixtures'

const CALL_ID = '11111111-2222-4333-8444-555555555555'

function call(toolId: ToolCall['toolId'], args: Record<string, unknown>): ToolCall {
  return { callId: CALL_ID, toolId, arguments: args }
}

const DOC_ARGS = { query: 'backup', allowedCollectionRefs: ['home-energy/manuals'], mode: 'keyword' }

/** A handler that hangs until the propagated signal aborts, then fails as cancelled. */
class HangingHandler implements ToolHandler {
  readonly toolId = 'document_search'
  signal: AbortSignal | undefined

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    this.signal = request.signal
    await new Promise<void>((resolve) => {
      if (request.signal.aborted) {
        resolve()
        return
      }
      request.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    throw cancellationError('the handler was cancelled')
  }
}

/** A handler that raises a port-shaped classified failure (no adapter import needed). */
class CodedFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remoteStateUnknown = false,
  ) {
    super(message)
    this.name = 'CodedFailure'
  }
}

class FailingHandler implements ToolHandler {
  readonly toolId = 'document_search'
  constructor(private readonly failure: unknown) {}

  async execute(): Promise<ToolExecutionOutcome> {
    throw this.failure
  }
}

function outcomeForCode(code: ErrorCode, remoteStateUnknown = false): CodedFailure {
  return new CodedFailure(code, `port refused with ${code}`, remoteStateUnknown)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

describe('the gateway injects the run ToolContext into the execute path', () => {
  it('passes the exact trusted context to the handler and no handler captures one', async () => {
    const handler = new RecordingHandler('document_search', okOutcome({ spans: [] }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(call('document_search', DOC_ARGS), ctx)
    expect(result.status).toBe('ok')
    expect(handler.calls).toHaveLength(1)
    expect(handler.calls[0]?.ctx).toBe(ctx)
  })

  it('refuses a context that names another run before any handler runs', async () => {
    const handler = new RecordingHandler('document_search', okOutcome({ spans: [] }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    const otherRun = gatewayContext({ runId: randomUUID() })
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(call('document_search', DOC_ARGS), otherRun)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('FORBIDDEN')
    expect(handler.calls).toHaveLength(0)
  })
})

describe('run cancellation interrupts the in-flight call', () => {
  function futureContext(): ToolContext {
    return gatewayContext({ deadline: new Date(Date.now() + 60_000).toISOString() })
  }

  it('aborts the handler signal, settles usage_unknown and never returns a success', async () => {
    const handler = new HangingHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = futureContext()
    await openGatewayLedger(harness, ctx)

    const pending = harness.gateway.invoke(call('document_search', DOC_ARGS), ctx)
    const started = await waitUntil(() => handler.signal !== undefined && !handler.signal.aborted)
    expect(started).toBe(true)

    const receipt = await harness.gateway.cancel(CALL_ID, 'the user cancelled the run', ctx)
    expect(receipt.state).toBe('cancelled')

    const result = await pending
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
    expect(result.error?.remoteStateUnknown).toBe(true)
    expect(result.evidenceRefs).toEqual([])

    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const reservations = await harness.ledgerStore.listReservations(scope, GATEWAY_LEDGER, ctx)
    const reservation = reservations.at(-1)
    expect(reservation?.status).toBe('usage_unknown')
    expect(reservation?.usageUnknown).toBe(true)

    const again = await harness.gateway.cancel(CALL_ID, 'again', ctx)
    expect(again.state).toBe('already_terminal')
  })

  it('rejects cancellation with an untrusted context', async () => {
    const handler = new HangingHandler()
    const harness = buildGateway({ handlers: [handler] })
    const ctx = futureContext()
    await openGatewayLedger(harness, ctx)

    const forged = { ...ctx }
    Reflect.deleteProperty(forged, TOOL_CONTEXT_BRAND)
    await expect(harness.gateway.cancel(CALL_ID, 'nope', forged)).rejects.toBeInstanceOf(
      ToolGatewayError,
    )
  })

  it('reports already_terminal when the call is not in flight', async () => {
    const harness = buildGateway({ handlers: [new HangingHandler()] })
    const ctx = futureContext()
    await openGatewayLedger(harness, ctx)
    const receipt = await harness.gateway.cancel(randomUUID(), 'nothing running', ctx)
    expect(receipt.state).toBe('already_terminal')
  })
})

describe('adapter-raised port errors keep their canonical classification', () => {
  const REQUIRED: readonly ErrorCode[] = [
    'UNSUPPORTED_QUERY',
    'RESULT_TOO_LARGE',
    'DEADLINE_EXCEEDED',
    'INVALID_ARGUMENT',
    'FORBIDDEN',
    'SOURCE_UNAVAILABLE',
    'SNAPSHOT_UNAVAILABLE',
    'INDEX_NOT_FOUND',
    'RATE_LIMITED',
    'BUDGET_EXHAUSTED',
  ]

  for (const code of REQUIRED.filter((entry) => entry !== 'BUDGET_EXHAUSTED')) {
    it(`preserves ${code} through the tool path`, async () => {
      const handler = new FailingHandler(outcomeForCode(code, code === 'DEADLINE_EXCEEDED'))
      const harness = buildGateway({ handlers: [handler] })
      const ctx = gatewayContext()
      await openGatewayLedger(harness, ctx)

      const result = await harness.gateway.invoke(call('document_search', DOC_ARGS), ctx)
      expect(result.status).toBe('error')
      expect(result.error?.code).toBe(code)
      expect(result.error?.retryable).toBe(ERROR_CATALOG[code].retryable !== 'never')
      if (code === 'DEADLINE_EXCEEDED') {
        expect(result.error?.remoteStateUnknown).toBe(true)
      }
    })
  }

  it('preserves BUDGET_EXHAUSTED from a reservation denial', async () => {
    const handler = new RecordingHandler('document_search', okOutcome({ spans: [] }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx, { maxToolCalls: 0 })

    const result = await harness.gateway.invoke(call('document_search', DOC_ARGS), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('BUDGET_EXHAUSTED')
    expect(handler.calls).toHaveLength(0)
  })

  it('keeps INVALID_ARGUMENT for schema-rejected arguments', async () => {
    const handler = new RecordingHandler('document_search', okOutcome({ spans: [] }))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(call('document_search', {}), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('still maps an unknown coded failure to INTERNAL_ERROR', async () => {
    const handler = new FailingHandler(new CodedFailure('NOT_A_CATALOGUE_CODE', 'mystery failure'))
    const harness = buildGateway({ handlers: [handler] })
    const ctx = gatewayContext()
    await openGatewayLedger(harness, ctx)

    const result = await harness.gateway.invoke(call('document_search', DOC_ARGS), ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('INTERNAL_ERROR')
  })
})
