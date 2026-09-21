import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  BudgetService,
  DEFAULT_RUN_BUDGET_LIMITS,
  InMemoryBudgetLedgerStore,
  propagateDeadline,
  tightenBudgetLimits,
} from '@ontology/core'
import type { ResourceRef, ToolContext } from '@ontology/contracts'
import { RecordingControlRepository } from './component-registry-fixtures'
import { RUN_A, SCOPE_A, SCOPE_B, toolContext } from './profile-resolver-fixtures'

const LEDGER_RUN = '77777777-7777-4777-8777-777777777777'
const LEDGER_BACKGROUND = '88888888-8888-4888-8888-888888888888'
const OTHER_LEDGER = '99999999-9999-4999-8999-999999999999'

const CONTEXT_A: ToolContext = toolContext(
  SCOPE_A.tenantId,
  SCOPE_A.spaceId,
  ['business-user'],
  'owner-a',
  RUN_A,
)
const CONTEXT_B: ToolContext = toolContext(
  SCOPE_B.tenantId,
  SCOPE_B.spaceId,
  ['business-user'],
  'owner-b',
  RUN_A,
)

function mutableClock(start: string): { readonly now: () => string; readonly set: (value: string) => void } {
  let current = start
  return {
    now: () => current,
    set: (value: string) => {
      current = value
    },
  }
}

function makeService(options?: { readonly start?: string }) {
  const store = new InMemoryBudgetLedgerStore()
  const control = new RecordingControlRepository()
  const clock = mutableClock(options?.start ?? '2026-09-21T00:00:00Z')
  const service = new BudgetService({
    store,
    control,
    now: clock.now,
    newId: () => randomUUID(),
  })
  return { service, store, control, clock }
}

function evidenceRef(): ResourceRef {
  return { id: randomUUID(), version: '1.0.0', digest: `sha256:${'e'.repeat(64)}`, kind: 'evidence' }
}

describe('budget limits', () => {
  it('tightens a deployment budget and never lets an override loosen it', () => {
    const loosened = tightenBudgetLimits(DEFAULT_RUN_BUDGET_LIMITS, {
      maxToolCalls: 99,
      maxParallelTools: 99,
      deadlineMs: 999_999,
    })
    expect(loosened.maxToolCalls).toBe(DEFAULT_RUN_BUDGET_LIMITS.maxToolCalls)
    expect(loosened.maxParallelTools).toBe(DEFAULT_RUN_BUDGET_LIMITS.maxParallelTools)
    expect(loosened.deadlineMs).toBe(DEFAULT_RUN_BUDGET_LIMITS.deadlineMs)

    const tightened = tightenBudgetLimits(DEFAULT_RUN_BUDGET_LIMITS, {
      maxToolCalls: 3,
      maxParallelTools: 1,
      maxModelTokens: 500,
    })
    expect(tightened.maxToolCalls).toBe(3)
    expect(tightened.maxParallelTools).toBe(1)
    expect(tightened.maxModelTokens).toBe(500)
    expect(tightened.maxRepairAttempts).toBe(DEFAULT_RUN_BUDGET_LIMITS.maxRepairAttempts)
  })
})

describe('input validation', () => {
  it('classifies an invalid reservation request before persistence', async () => {
    const { service } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    await expect(
      service.reserve({ ledgerId: LEDGER_RUN, idempotencyKey: 'short' }, CONTEXT_A),
    ).rejects.toMatchObject({ code: 'INVALID_BUDGET_REQUEST' })
    await expect(
      service.reserve(
        { ledgerId: LEDGER_RUN, idempotencyKey: 'invalid-amount-0001', toolCalls: -1 },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_BUDGET_REQUEST' })
    await expect(
      service.reserve(
        {
          ledgerId: LEDGER_RUN,
          idempotencyKey: 'invalid-deadline-0001',
          requestedDeadline: 'not-a-timestamp',
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_BUDGET_REQUEST' })
  })
})

describe('deadline propagation', () => {
  it('never extends a child past the parent deadline', () => {
    const parent = '2026-09-21T00:02:00Z'
    expect(propagateDeadline(parent, '2026-09-21T01:00:00Z')).toBe(parent)
    expect(propagateDeadline(parent, '2026-09-21T00:01:00Z')).toBe('2026-09-21T00:01:00Z')
    expect(propagateDeadline(parent, undefined)).toBe(parent)
  })

  it('hands each nested reservation at most the parent remaining time', async () => {
    const { service } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const ledger = await service.remaining(LEDGER_RUN, CONTEXT_A)
    expect(ledger.deadline).toBe('2026-09-21T00:02:00.000Z')

    const longChild = await service.reserve(
      {
        ledgerId: LEDGER_RUN,
        idempotencyKey: 'reserve-long-0001',
        requestedDeadline: '2026-09-21T01:00:00Z',
      },
      CONTEXT_A,
    )
    expect(longChild.granted).toBe(true)
    expect(longChild.reservation?.deadline).toBe(ledger.deadline)

    const shortChild = await service.reserve(
      {
        ledgerId: LEDGER_RUN,
        idempotencyKey: 'reserve-short-0001',
        requestedDeadline: '2026-09-21T00:00:30Z',
      },
      CONTEXT_A,
    )
    expect(shortChild.reservation?.deadline).toBe('2026-09-21T00:00:30Z')
  })

  it('refuses a reservation once the ledger deadline has passed', async () => {
    const { service, clock } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    clock.set('2026-09-21T00:02:00Z')
    const outcome = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'reserve-late-0001' },
      CONTEXT_A,
    )
    expect(outcome.granted).toBe(false)
    expect(outcome.denial?.code).toBe('DEADLINE_EXCEEDED')
  })
})

describe('atomic reservation contention', () => {
  it('grants exactly the allowance when reservations contend for the last slots', async () => {
    const { service } = makeService()
    await service.openLedger(
      { ledgerId: LEDGER_RUN, kind: 'run', overrideLimits: { maxToolCalls: 8 }, runId: RUN_A },
      CONTEXT_A,
    )
    const outcomes = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        service.reserve(
          { ledgerId: LEDGER_RUN, idempotencyKey: `contend-${String(index).padStart(4, '0')}` },
          CONTEXT_A,
        ),
      ),
    )
    const granted = outcomes.filter((outcome) => outcome.granted)
    const denied = outcomes.filter((outcome) => !outcome.granted)
    expect(granted).toHaveLength(8)
    expect(denied).toHaveLength(16)
    expect(denied.every((outcome) => outcome.denial?.code === 'BUDGET_EXHAUSTED')).toBe(true)

    const remaining = await service.remaining(LEDGER_RUN, CONTEXT_A)
    expect(remaining.remaining.toolCallsRemaining).toBe(0)
  })

  it('rate-limits parallel tools instead of oversubscribing', async () => {
    const { service } = makeService()
    await service.openLedger(
      { ledgerId: LEDGER_RUN, kind: 'run', overrideLimits: { maxParallelTools: 2 }, runId: RUN_A },
      CONTEXT_A,
    )
    const first = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'parallel-0001', parallel: true },
      CONTEXT_A,
    )
    const second = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'parallel-0002', parallel: true },
      CONTEXT_A,
    )
    const third = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'parallel-0003', parallel: true },
      CONTEXT_A,
    )
    expect(first.granted).toBe(true)
    expect(second.granted).toBe(true)
    expect(third.granted).toBe(false)
    expect(third.denial?.code).toBe('RATE_LIMITED')
    expect(third.denial?.retryAfterMs).toBeGreaterThanOrEqual(1_000)

    const released = first.reservation
    if (released === undefined) throw new Error('the first parallel reservation was not granted')
    await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: released.reservationId,
        status: 'failed',
        usage: { durationMs: 5 },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )
    const fourth = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'parallel-0004', parallel: true },
      CONTEXT_A,
    )
    expect(fourth.granted).toBe(true)
  })
})

describe('per-run monotonic counters', () => {
  it('continues the shared counters across re-collection and never resets them', async () => {
    const { service } = makeService()
    await service.openLedger(
      {
        ledgerId: LEDGER_RUN,
        kind: 'run',
        overrideLimits: { maxRows: 150, maxRepairAttempts: 1 },
        runId: RUN_A,
      },
      CONTEXT_A,
    )

    const primary = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'round-primary-0001', rows: 100 },
      CONTEXT_A,
    )
    expect(primary.granted).toBe(true)
    const primaryReservation = primary.reservation
    if (primaryReservation === undefined) throw new Error('the primary reservation was not granted')
    await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: primaryReservation.reservationId,
        status: 'completed',
        usage: { durationMs: 10, rows: 100 },
        evidenceRefs: [evidenceRef()],
      },
      CONTEXT_A,
    )

    // A second round continues from 100 consumed rows: 100 + 60 would exceed 150.
    const overBudget = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'round-repair-over-0001', repair: true, rows: 60 },
      CONTEXT_A,
    )
    expect(overBudget.granted).toBe(false)
    expect(overBudget.denial?.code).toBe('BUDGET_EXHAUSTED')

    const repair = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'round-repair-ok-0001', repair: true, rows: 50 },
      CONTEXT_A,
    )
    expect(repair.granted).toBe(true)
    const repairReservation = repair.reservation
    if (repairReservation === undefined) throw new Error('the repair reservation was not granted')
    await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: repairReservation.reservationId,
        status: 'completed',
        usage: { durationMs: 10, rows: 50 },
        evidenceRefs: [evidenceRef()],
      },
      CONTEXT_A,
    )

    const remaining = await service.remaining(LEDGER_RUN, CONTEXT_A)
    expect(remaining.rowsRemaining).toBe(0)
    expect(remaining.remaining.repairAttemptsRemaining).toBe(0)

    // A third repair is refused: the repair count is shared and was not reset.
    const thirdRepair = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'round-repair-third-0001', repair: true },
      CONTEXT_A,
    )
    expect(thirdRepair.granted).toBe(false)
    expect(thirdRepair.denial?.code).toBe('BUDGET_EXHAUSTED')
  })
})

describe('usage_unknown', () => {
  it('holds a possibly billed call and only releases it on reconciliation', async () => {
    const { service } = makeService()
    await service.openLedger(
      { ledgerId: LEDGER_RUN, kind: 'run', overrideLimits: { maxRows: 1_000 }, runId: RUN_A },
      CONTEXT_A,
    )
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'unknown-0001', rows: 500 },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')

    const held = await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: reservation.reservationId,
        status: 'usage_unknown',
        usage: { durationMs: 200, usageUnknown: true },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )
    expect(held.reservation.status).toBe('usage_unknown')
    expect(held.reservation.usageUnknown).toBe(true)
    expect((await service.remaining(LEDGER_RUN, CONTEXT_A)).rowsRemaining).toBe(500)

    const over = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'unknown-0002', rows: 600 },
      CONTEXT_A,
    )
    expect(over.granted).toBe(false)
    expect(over.denial?.code).toBe('BUDGET_EXHAUSTED')

    const reconciled = await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: reservation.reservationId,
        status: 'completed',
        usage: { durationMs: 200, rows: 20 },
        evidenceRefs: [evidenceRef()],
      },
      CONTEXT_A,
    )
    expect(reconciled.applied).toBe(true)
    expect(reconciled.reservation.status).toBe('settled')
    expect((await service.remaining(LEDGER_RUN, CONTEXT_A)).rowsRemaining).toBe(980)
  })

  it('never frees a failed call as if it were free', async () => {
    const { service } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'failed-0001' },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')
    await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: reservation.reservationId,
        status: 'failed',
        usage: { durationMs: 3 },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )
    expect((await service.remaining(LEDGER_RUN, CONTEXT_A)).remaining.toolCallsRemaining).toBe(7)
  })
})

describe('idempotent settlement', () => {
  it('does not double-count a duplicated completed settlement', async () => {
    const { service } = makeService()
    await service.openLedger(
      { ledgerId: LEDGER_RUN, kind: 'run', overrideLimits: { maxRows: 1_000 }, runId: RUN_A },
      CONTEXT_A,
    )
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'settle-dup-0001', rows: 300 },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')
    const settlement = {
      ledgerId: LEDGER_RUN,
      reservationId: reservation.reservationId,
      status: 'completed' as const,
      usage: { durationMs: 5, rows: 120 },
      evidenceRefs: [evidenceRef()],
    }
    const first = await service.settle(settlement, CONTEXT_A)
    expect(first.applied).toBe(true)
    const duplicate = await service.settle(settlement, CONTEXT_A)
    expect(duplicate.applied).toBe(false)
    expect((await service.remaining(LEDGER_RUN, CONTEXT_A)).rowsRemaining).toBe(880)
  })

  it('does not free allowance twice for a duplicated failed settlement', async () => {
    const { service } = makeService()
    await service.openLedger(
      { ledgerId: LEDGER_RUN, kind: 'run', overrideLimits: { maxRows: 1_000 }, runId: RUN_A },
      CONTEXT_A,
    )
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'settle-failed-dup-0001', rows: 400 },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')
    const settlement = {
      ledgerId: LEDGER_RUN,
      reservationId: reservation.reservationId,
      status: 'failed' as const,
      usage: { durationMs: 5, rows: 0 },
      evidenceRefs: [],
    }
    await service.settle(settlement, CONTEXT_A)
    await service.settle(settlement, CONTEXT_A)
    expect((await service.remaining(LEDGER_RUN, CONTEXT_A)).rowsRemaining).toBe(1_000)
  })

  it('is idempotent for a cancelled settlement', async () => {
    const { service, store } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'settle-cancel-0001' },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')
    const settlement = {
      ledgerId: LEDGER_RUN,
      reservationId: reservation.reservationId,
      status: 'cancelled' as const,
      usage: { durationMs: 5 },
      evidenceRefs: [],
    }
    expect((await service.settle(settlement, CONTEXT_A)).applied).toBe(true)
    expect((await service.settle(settlement, CONTEXT_A)).applied).toBe(false)
    const stored = await store.getReservation(
      SCOPE_A,
      LEDGER_RUN,
      reservation.reservationId,
      CONTEXT_A,
    )
    expect(stored?.status).toBe('abandoned')
    expect((await service.remaining(LEDGER_RUN, CONTEXT_A)).remaining.toolCallsRemaining).toBe(7)
  })

  it('refuses to turn a definitive terminal settlement into usage_unknown', async () => {
    const { service } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'settle-conflict-0001' },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')
    await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: reservation.reservationId,
        status: 'failed',
        usage: { durationMs: 1 },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )
    await expect(
      service.settle(
        {
          ledgerId: LEDGER_RUN,
          reservationId: reservation.reservationId,
          status: 'usage_unknown',
          usage: { durationMs: 1, usageUnknown: true },
          evidenceRefs: [],
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_CONFLICT' })
  })
})

describe('evidence and intent ordering', () => {
  it('refuses a completed settlement without evidence and records it as failed', async () => {
    const { service, store } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'evidence-gap-0001' },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')

    await expect(
      service.settle(
        {
          ledgerId: LEDGER_RUN,
          reservationId: reservation.reservationId,
          status: 'completed',
          usage: { durationMs: 5 },
          evidenceRefs: [],
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'EVIDENCE_PERSIST_FAILED' })

    const stored = await store.getReservation(
      SCOPE_A,
      LEDGER_RUN,
      reservation.reservationId,
      CONTEXT_A,
    )
    expect(stored?.status).toBe('failed')
  })

  it('requires a persisted intent before a tool reservation can be settled', async () => {
    const { service } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'intent-required-0001', requiresIntent: true },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')

    await expect(
      service.settle(
        {
          ledgerId: LEDGER_RUN,
          reservationId: reservation.reservationId,
          status: 'failed',
          usage: { durationMs: 1 },
          evidenceRefs: [],
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_RECORDED' })

    await service.recordIntent(
      {
        ledgerId: LEDGER_RUN,
        reservationId: reservation.reservationId,
        intentId: randomUUID(),
        descriptor: {
          callId: randomUUID(),
          toolId: 'data_query',
          argumentsDigest: `sha256:${'a'.repeat(64)}`,
          attempt: 1,
        },
      },
      CONTEXT_A,
    )
    const settled = await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: reservation.reservationId,
        status: 'failed',
        usage: { durationMs: 1 },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )
    expect(settled.reservation.status).toBe('failed')
  })

  it('flags a duplicate tool+arguments intent as NO_PROGRESS unless a retry reason is given', async () => {
    const { service } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const digest = `sha256:${'b'.repeat(64)}`

    const first = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'no-progress-0001', requiresIntent: true },
      CONTEXT_A,
    )
    const firstReservation = first.reservation
    if (firstReservation === undefined) throw new Error('the first reservation was not granted')
    await service.recordIntent(
      {
        ledgerId: LEDGER_RUN,
        reservationId: firstReservation.reservationId,
        intentId: randomUUID(),
        descriptor: { callId: randomUUID(), toolId: 'data_query', argumentsDigest: digest, attempt: 1 },
      },
      CONTEXT_A,
    )

    const second = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'no-progress-0002', requiresIntent: true },
      CONTEXT_A,
    )
    const secondReservation = second.reservation
    if (secondReservation === undefined) throw new Error('the second reservation was not granted')

    await expect(
      service.recordIntent(
        {
          ledgerId: LEDGER_RUN,
          reservationId: secondReservation.reservationId,
          intentId: randomUUID(),
          descriptor: {
            callId: randomUUID(),
            toolId: 'data_query',
            argumentsDigest: digest,
            attempt: 1,
          },
        },
        CONTEXT_A,
      ),
    ).rejects.toMatchObject({ code: 'NO_PROGRESS' })

    await expect(
      service.recordIntent(
        {
          ledgerId: LEDGER_RUN,
          reservationId: secondReservation.reservationId,
          intentId: randomUUID(),
          descriptor: {
            callId: randomUUID(),
            toolId: 'data_query',
            argumentsDigest: digest,
            attempt: 2,
          },
          retryReason: 'transient SOURCE_UNAVAILABLE',
        },
        CONTEXT_A,
      ),
    ).resolves.toBeDefined()
  })
})

describe('separate background and online quotas', () => {
  it('exhausting a background ledger never starves an online run', async () => {
    const { service } = makeService()
    await service.openLedger(
      {
        ledgerId: LEDGER_BACKGROUND,
        kind: 'background',
        overrideLimits: { maxToolCalls: 2 },
      },
      CONTEXT_A,
    )
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)

    const backgroundOne = await service.reserve(
      { ledgerId: LEDGER_BACKGROUND, idempotencyKey: 'background-0001' },
      CONTEXT_A,
    )
    const backgroundTwo = await service.reserve(
      { ledgerId: LEDGER_BACKGROUND, idempotencyKey: 'background-0002' },
      CONTEXT_A,
    )
    const backgroundThree = await service.reserve(
      { ledgerId: LEDGER_BACKGROUND, idempotencyKey: 'background-0003' },
      CONTEXT_A,
    )
    expect(backgroundOne.granted).toBe(true)
    expect(backgroundTwo.granted).toBe(true)
    expect(backgroundThree.granted).toBe(false)
    expect(backgroundThree.denial?.code).toBe('BUDGET_EXHAUSTED')

    const online = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'online-0001' },
      CONTEXT_A,
    )
    expect(online.granted).toBe(true)
    expect((await service.remaining(LEDGER_RUN, CONTEXT_A)).remaining.toolCallsRemaining).toBe(7)
    expect(
      (await service.remaining(LEDGER_BACKGROUND, CONTEXT_A)).remaining.toolCallsRemaining,
    ).toBe(0)
  })
})

describe('tenant isolation and audit', () => {
  it('hides a ledger from another tenant/space', async () => {
    const { service } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    await expect(
      service.reserve({ ledgerId: LEDGER_RUN, idempotencyKey: 'cross-scope-0001' }, CONTEXT_B),
    ).rejects.toMatchObject({ code: 'LEDGER_NOT_FOUND' })
  })

  it('reports an unknown ledger explicitly instead of an empty budget', async () => {
    const { service } = makeService()
    await expect(service.remaining(OTHER_LEDGER, CONTEXT_A)).rejects.toMatchObject({
      code: 'LEDGER_NOT_FOUND',
    })
  })

  it('appends reservation and settlement events to the durable audit ledger', async () => {
    const { service, control } = makeService()
    await service.openLedger({ ledgerId: LEDGER_RUN, kind: 'run', runId: RUN_A }, CONTEXT_A)
    const reserved = await service.reserve(
      { ledgerId: LEDGER_RUN, idempotencyKey: 'audit-0001' },
      CONTEXT_A,
    )
    const reservation = reserved.reservation
    if (reservation === undefined) throw new Error('the reservation was not granted')
    await service.settle(
      {
        ledgerId: LEDGER_RUN,
        reservationId: reservation.reservationId,
        status: 'failed',
        usage: { durationMs: 1 },
        evidenceRefs: [],
      },
      CONTEXT_A,
    )
    expect(control.appended.map((event) => event.idempotencyKey)).toEqual([
      `budget-reserved:${reservation.reservationId}:reserved`,
      `budget-settled:${reservation.reservationId}:failed`,
    ])
    expect(control.appended.every((event) => event.streamRef === `budget:${LEDGER_RUN}`)).toBe(true)
  })
})
