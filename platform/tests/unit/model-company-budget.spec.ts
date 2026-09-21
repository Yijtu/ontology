import { afterEach, describe, expect, it } from 'vitest'
import type { GenerationEvent } from '@ontology/contracts'
import {
  budgetHarness,
  collect,
  generationRequest,
  makeAdapter,
  remainingOf,
  reservationsOf,
  startCompanyServer,
  waitFor,
  type CompanyServer,
} from './model-company-fixtures'

const servers: CompanyServer[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

async function server(): Promise<CompanyServer> {
  const started = await startCompanyServer()
  servers.push(started)
  return started
}

describe('company generation adapter — shared budget integration', () => {
  it('draws every attempt from the one ledger and never resets the budget on retry', async () => {
    const api = await server()
    // The estimate exactly fills the ledger: the first attempt holds it as `usage_unknown`
    // (the remote may have been billed), so the retry cannot reserve a fresh allowance.
    const harness = await budgetHarness({ maxModelTokens: 256 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'interrupted_before_output',
      harness,
      maxAttempts: 3,
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'BUDGET_EXHAUSTED' } })
    expect(api.requests).toHaveLength(1)
    const remaining = await remainingOf(harness)
    expect(remaining.remaining.tokensRemaining).toBe(0)
  })

  it('propagates the run deadline to the reservation instead of granting a fresh one', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000, deadlineOffsetMs: 30_000 })
    const adapter = makeAdapter({ server: api, fixture: 'normal', harness })

    await collect(adapter.generate(generationRequest(), harness.ctx))

    const reservations = await reservationsOf(harness)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.deadline).toBe(harness.ctx.deadline)
    expect(reservations[0]?.status).toBe('settled')
  })

  it('keeps the same propagated deadline across a retry', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000, deadlineOffsetMs: 30_000 })
    const adapter = makeAdapter({ server: api, fixture: 'http_503', harness, maxAttempts: 2 })

    await collect(adapter.generate(generationRequest(), harness.ctx))

    const reservations = await reservationsOf(harness)
    expect(reservations).toHaveLength(2)
    expect(reservations[0]?.deadline).toBe(harness.ctx.deadline)
    expect(reservations[1]?.deadline).toBe(harness.ctx.deadline)
    expect(Date.parse(reservations[1]?.deadline ?? '')).not.toBeGreaterThan(
      Date.parse(reservations[0]?.deadline ?? ''),
    )
  })

  it('settles measured usage on success and releases only the over-estimate', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'normal', harness })

    await collect(adapter.generate(generationRequest(), harness.ctx))

    const remaining = await remainingOf(harness)
    // The reservation charged 256 up front; the measured 12 + 7 tokens are what remains consumed.
    expect(remaining.remaining.tokensRemaining).toBe(1_000 - 19)
  })

  it('aborts the in-flight request on cancellation and settles the reservation', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const controller = new AbortController()
    const adapter = makeAdapter({
      server: api,
      fixture: 'slow',
      harness,
      signal: controller.signal,
      maxAttempts: 1,
    })

    const events: GenerationEvent[] = []
    for await (const event of adapter.generate(generationRequest(), harness.ctx)) {
      events.push(event)
      if (event.type === 'text_delta') controller.abort()
    }

    expect(events.some((event) => event.type === 'completed')).toBe(false)
    await waitFor(() => api.abortedResponses.length > 0)
    expect(api.abortedResponses.length).toBeGreaterThan(0)
    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('usage_unknown')
    const remaining = await remainingOf(harness)
    expect(remaining.remaining.tokensRemaining).toBe(1_000 - 256)
  })

  it('settles the measured usage when cancellation follows a reported usage', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const controller = new AbortController()
    const adapter = makeAdapter({
      server: api,
      fixture: 'slow_usage',
      harness,
      signal: controller.signal,
      maxAttempts: 1,
    })

    for await (const event of adapter.generate(generationRequest(), harness.ctx)) {
      if (event.type === 'usage') controller.abort()
    }

    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('abandoned')
    expect(reservations[0]?.actual?.modelTokens).toBe(11)
  })

  it('holds a possibly-billed timeout as usage_unknown instead of freeing it', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'slow_no_output',
      harness,
      requestTimeoutMs: 40,
      maxAttempts: 1,
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'DEADLINE_EXCEEDED', remoteStateUnknown: true },
    })
    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('usage_unknown')
    const remaining = await remainingOf(harness)
    // The 256-token estimate is held, not released as free allowance.
    expect(remaining.remaining.tokensRemaining).toBe(1_000 - 256)
  })

  it('holds a possibly-billed HTTP 504 as usage_unknown instead of freeing it', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'http_504', harness, maxAttempts: 1 })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'DEADLINE_EXCEEDED', remoteStateUnknown: true },
    })
    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('usage_unknown')
    const remaining = await remainingOf(harness)
    expect(remaining.remaining.tokensRemaining).toBe(1_000 - 256)
  })

  it('gives two calls for the same run distinct reservations', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'normal', harness })

    await collect(adapter.generate(generationRequest(), harness.ctx))
    await collect(adapter.generate(generationRequest(), harness.ctx))

    const reservations = await reservationsOf(harness)
    expect(reservations).toHaveLength(2)
    expect(reservations[0]?.reservationId).not.toBe(reservations[1]?.reservationId)
    expect(api.requests).toHaveLength(2)
  })

  it('retries an interrupted stream only before any output, from the same ledger', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'interrupted_before_output',
      harness,
      maxAttempts: 2,
    })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(api.requests).toHaveLength(2)
    expect(events.some((event) => event.type === 'completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'MODEL_UNAVAILABLE' } })
    const reservations = await reservationsOf(harness)
    expect(reservations).toHaveLength(2)
    expect(reservations.every((reservation) => reservation.status === 'usage_unknown')).toBe(true)
  })

  it('settles the reservation when the consumer stops early instead of leaking it', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'slow', harness, maxAttempts: 1 })

    for await (const event of adapter.generate(generationRequest(), harness.ctx)) {
      if (event.type === 'text_delta') break
    }

    const reservations = await reservationsOf(harness)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.status).toBe('usage_unknown')
  })

  it('does not retry once any output has been streamed', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'interrupted', harness, maxAttempts: 3 })

    const events = await collect(adapter.generate(generationRequest(), harness.ctx))

    expect(api.requests).toHaveLength(1)
    expect(events.some((event) => event.type === 'completed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'error' })
  })
})
