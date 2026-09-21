import { afterEach, describe, expect, it } from 'vitest'
import {
  budgetHarness,
  choiceQuestion,
  decisionRequest,
  makeAdapter,
  remainingOf,
  reservationsOf,
  startJevServer,
  waitFor,
  type JevServer,
} from './model-jev-fixtures'

const servers: JevServer[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

async function server(): Promise<JevServer> {
  const started = await startJevServer()
  servers.push(started)
  return started
}

describe('JEV decision adapter — shared budget integration', () => {
  it('settles measured usage on success and releases only the over-estimate', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'choice', harness })

    await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    const remaining = await remainingOf(harness)
    // The reservation charged the 256-token estimate; the measured 20 + 5 are consumed.
    expect(remaining.remaining.tokensRemaining).toBe(1_000 - 25)
    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('settled')
  })

  it('holds a possibly-billed HTTP 504 as usage_unknown instead of freeing it', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'http_504',
      harness,
      fallbackPolicy: 'reject',
      maxAttempts: 1,
    })

    await expect(adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    })
    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('usage_unknown')
    const remaining = await remainingOf(harness)
    expect(remaining.remaining.tokensRemaining).toBe(1_000 - 256)
  })

  it('holds a possibly-billed request timeout as usage_unknown', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'slow_no_output',
      harness,
      fallbackPolicy: 'reject',
      requestTimeoutMs: 40,
      maxAttempts: 1,
    })

    await expect(adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'DEADLINE_EXCEEDED',
    })
    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('usage_unknown')
    expect((await remainingOf(harness)).remaining.tokensRemaining).toBe(1_000 - 256)
  })

  it('settles the reservation as usage_unknown when the run is cancelled mid-call', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const controller = new AbortController()
    const adapter = makeAdapter({
      server: api,
      fixture: 'slow_no_output',
      harness,
      signal: controller.signal,
      fallbackPolicy: 'reject',
      maxAttempts: 1,
    })

    const pending = adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)
    const rejection = expect(pending).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
    await waitFor(() => api.requests.length > 0)
    controller.abort()
    await rejection
    await waitFor(() => api.abortedResponses.length > 0)
    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('usage_unknown')
  })

  it('never resets the ledger on retry: a second attempt is refused once the estimate is held', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 256 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'drop',
      harness,
      fallbackPolicy: 'reject',
      maxAttempts: 3,
      estimatedTokens: 256,
    })

    await expect(adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    })
    expect(api.requests).toHaveLength(1)
    expect((await remainingOf(harness)).remaining.tokensRemaining).toBe(0)
  })

  it('retries an unavailable provider from the same ledger and then succeeds', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({
      server: api,
      fixture: 'flaky_503',
      harness,
      maxAttempts: 2,
    })

    const result = await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    expect(result.fallback).toBeUndefined()
    expect(api.requests).toHaveLength(2)
    const reservations = await reservationsOf(harness)
    expect(reservations).toHaveLength(2)
    expect(reservations[1]?.status).toBe('settled')
  })

  it('propagates the run deadline to the reservation instead of granting a fresh one', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000, deadlineOffsetMs: 30_000 })
    const adapter = makeAdapter({ server: api, fixture: 'choice', harness })

    await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    const reservations = await reservationsOf(harness)
    expect(reservations).toHaveLength(1)
    expect(reservations[0]?.deadline).toBe(harness.ctx.deadline)
  })

  it('gives two calls for the same run distinct reservations', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'choice', harness })

    await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)
    await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    const reservations = await reservationsOf(harness)
    expect(reservations).toHaveLength(2)
    expect(reservations[0]?.reservationId).not.toBe(reservations[1]?.reservationId)
    expect(api.requests).toHaveLength(2)
  })

  it('marks a partial usage report as unknown instead of rounding it to zero', async () => {
    const api = await server()
    const harness = await budgetHarness({ maxModelTokens: 1_000 })
    const adapter = makeAdapter({ server: api, fixture: 'partial_usage', harness })

    await adapter.decide(decisionRequest([choiceQuestion()]), harness.ctx)

    const reservations = await reservationsOf(harness)
    expect(reservations[0]?.status).toBe('usage_unknown')
    expect((await remainingOf(harness)).remaining.tokensRemaining).toBe(1_000 - 256)
  })
})
