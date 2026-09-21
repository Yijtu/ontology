import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryRunStore, RunService, RunServiceError } from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import type {
  ProfileRef,
  RuntimeCheckpointRef,
  RuntimeEvent,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  RUN_A,
  RUN_B,
  fixedClock,
  toolContext,
} from './component-registry-fixtures'
import { SCOPE_A, SCOPE_B } from './profile-resolver-fixtures'
import { RecordingControlRepository } from './component-registry-fixtures'

const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const RUNTIME_REF: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }
const OTHER_RUNTIME_REF: VersionRef = { id: 'runtime-pi', version: '2.0.0', digest: `sha256:${'c'.repeat(64)}` }

class FakeProfileBinder implements RunProfileBinder {
  binding: RunProfileBinding = {
    profileRef: PROFILE_REF,
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    resolvedProfileRef: { id: PROFILE_REF.id, version: PROFILE_REF.version, snapshotHash: `sha256:${'a'.repeat(64)}` },
    runtimeRef: RUNTIME_REF,
  }

  readonly calls: { readonly profileRef: ProfileRef; readonly scopeRef: ScopeRef; readonly subjectId: string }[] = []

  async bindProfileForRun(
    profileRef: ProfileRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<RunProfileBinding> {
    this.calls.push({ profileRef, scopeRef, subjectId: ctx.principal.subjectId })
    return this.binding
  }
}

function makeService(): {
  service: RunService
  store: InMemoryRunStore
  binder: FakeProfileBinder
  control: RecordingControlRepository
} {
  const store = new InMemoryRunStore()
  const binder = new FakeProfileBinder()
  const control = new RecordingControlRepository()
  const service = new RunService({ store, control, profiles: binder, now: fixedClock(), newId: () => randomUUID() })
  return { service, store, binder, control }
}

function createInput(overrides?: { readonly idempotencyKey?: string; readonly question?: string; readonly runId?: string }) {
  return {
    runId: overrides?.runId ?? RUN_A,
    profileRef: PROFILE_REF,
    question: overrides?.question ?? 'compare tomorrow energy strategies',
    context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
    preferences: { route: 'auto' as const, allowWeb: false },
    idempotencyKey: overrides?.idempotencyKey ?? 'idem-key-0001',
  }
}

function planEvent(runId: string, eventId: string, sequence = 0): RuntimeEvent {
  return {
    type: 'plan_proposed',
    runId,
    eventId,
    sequence,
    occurredAt: '2026-09-21T00:01:00Z',
    planRef: { id: 'plan-1', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}`, kind: 'artifact' },
    stepCount: 2,
    toolIds: ['data_query'],
  }
}

function clarificationEvent(runId: string, eventId: string, clarificationId: string): RuntimeEvent {
  return {
    type: 'clarification_requested',
    runId,
    eventId,
    sequence: 1,
    occurredAt: '2026-09-21T00:02:00Z',
    clarificationId,
    questionRef: { id: 'clarify-1', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` },
    questionType: 'choice',
  }
}

function collectionCompleteEvent(runId: string, eventId: string): RuntimeEvent {
  return {
    type: 'collection_complete',
    runId,
    eventId,
    sequence: 2,
    occurredAt: '2026-09-21T00:03:00Z',
    draftAllowed: true,
    evidenceCount: 3,
  }
}

function cancelledEvent(runId: string, eventId: string): RuntimeEvent {
  return {
    type: 'cancelled',
    runId,
    eventId,
    sequence: 3,
    occurredAt: '2026-09-21T00:04:00Z',
    reason: 'runtime stopped',
    abandonedAttempts: [],
  }
}

async function expectError(run: () => Promise<unknown>): Promise<RunServiceError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof RunServiceError) return error
    throw error
  }
  throw new Error('expected a RunServiceError')
}

const OWNER_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', RUN_A)
const OTHER_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'other-a', RUN_A)
const OPERATOR_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['operator'], 'operator-a', RUN_A)
const OWNER_B: ToolContext = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['business-user'], 'owner-b', RUN_B)

describe('RunService creation and idempotency', () => {
  it('locks the resolved profile hash at creation and starts in created', async () => {
    const { service } = makeService()
    const result = await service.createRun(createInput(), OWNER_A)
    expect(result.state).toBe('created')
    expect(result.revision).toBe('1')
    expect(result.resolvedProfileHash).toBe(`sha256:${'a'.repeat(64)}`)
    expect(result.reused).toBe(false)

    const view = await service.getRun(RUN_A, OWNER_A)
    expect(view.resolvedProfileHash).toBe(result.resolvedProfileHash)
    expect(view.ownerSubjectId).toBe('owner-a')
  })

  it('returns the same run for the same key and canonical payload', async () => {
    const { service } = makeService()
    const first = await service.createRun(createInput(), OWNER_A)
    const second = await service.createRun(createInput(), OWNER_A)
    expect(second.runId).toBe(first.runId)
    expect(second.reused).toBe(true)
    const events = await service.listEvents(RUN_A, undefined, OWNER_A)
    expect(events).toHaveLength(1)
  })

  it('rejects the same key with a different payload with IDEMPOTENCY_CONFLICT', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    const error = await expectError(() =>
      service.createRun(createInput({ question: 'a different question' }), OWNER_A),
    )
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT')
    expect(error.httpStatus).toBe(409)
  })

  it('requires a well-formed Idempotency-Key', async () => {
    const { service } = makeService()
    const error = await expectError(() => service.createRun(createInput({ idempotencyKey: 'short' }), OWNER_A))
    expect(error.code).toBe('INVALID_ARGUMENT')
  })

  it('keeps the locked profile hash when the binder later resolves a newer version', async () => {
    const { service, binder } = makeService()
    await service.createRun(createInput(), OWNER_A)
    binder.binding = {
      ...binder.binding,
      resolvedProfileHash: `sha256:${'f'.repeat(64)}`,
      resolvedProfileRef: { id: PROFILE_REF.id, version: '2.0.0', snapshotHash: `sha256:${'f'.repeat(64)}` },
    }
    const view = await service.getRun(RUN_A, OWNER_A)
    expect(view.resolvedProfileHash).toBe(`sha256:${'a'.repeat(64)}`)
    expect(view.profileRef).toEqual(PROFILE_REF)
  })

  it('hides a run from another tenant/space', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    const error = await expectError(() => service.getRun(RUN_A, OWNER_B))
    expect(error.code).toBe('RUN_NOT_FOUND')
    expect(error.httpStatus).toBe(404)
  })
})

describe('RunService optimistic concurrency', () => {
  it('requires If-Match on cancel (428) and rejects a stale revision (409)', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    const missing = await expectError(() =>
      service.cancelRun({ runId: RUN_A, reason: 'user changed their mind', expectedRevision: undefined }, OWNER_A),
    )
    expect(missing.code).toBe('REVISION_REQUIRED')
    expect(missing.httpStatus).toBe(428)

    const stale = await expectError(() =>
      service.cancelRun({ runId: RUN_A, reason: 'user changed their mind', expectedRevision: '99' }, OWNER_A),
    )
    expect(stale.code).toBe('VERSION_CONFLICT')
    expect(stale.httpStatus).toBe(409)
  })

  it('moves cancelling -> cancelled and refuses last-write-wins', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    const cancelled = await service.cancelRun(
      { runId: RUN_A, reason: 'stop now', expectedRevision: '1' },
      OWNER_A,
    )
    expect(cancelled.state).toBe('cancelled')
    expect(cancelled.revision).toBe('3')
    expect(cancelled.cancelReason).toBe('stop now')

    const again = await service.cancelRun(
      { runId: RUN_A, reason: 'stop now', expectedRevision: '1' },
      OWNER_A,
    )
    expect(again.state).toBe('cancelled')
    expect(again.revision).toBe('3')
  })

  it('allows the owner and an operator to cancel, but refuses an unrelated user', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    const forbidden = await expectError(() =>
      service.cancelRun({ runId: RUN_A, reason: 'not mine', expectedRevision: '1' }, OTHER_A),
    )
    expect(forbidden.code).toBe('FORBIDDEN')
    expect(forbidden.httpStatus).toBe(403)

    const byOperator = await service.cancelRun(
      { runId: RUN_A, reason: 'operator stop', expectedRevision: '1' },
      OPERATOR_A,
    )
    expect(byOperator.state).toBe('cancelled')
  })
})

describe('RunService clarification and resume', () => {
  async function awaitingRun(service: RunService, ctx: ToolContext, clarificationId: string) {
    await service.createRun(createInput(), ctx)
    await service.recordRuntimeEvent(RUN_A, planEvent(RUN_A, randomUUID()), ctx)
    await service.recordRuntimeEvent(RUN_A, clarificationEvent(RUN_A, randomUUID(), clarificationId), ctx)
  }

  it('waits on a clarification and continues on a typed response', async () => {
    const { service } = makeService()
    const clarificationId = randomUUID()
    await awaitingRun(service, OWNER_A, clarificationId)
    const waiting = await service.getRun(RUN_A, OWNER_A)
    expect(waiting.state).toBe('awaiting_input')
    expect(waiting.pendingClarificationId).toBe(clarificationId)

    const missing = await expectError(() =>
      service.respondToClarification(
        { runId: RUN_A, clarificationId, typedResponse: { choice: 'a' }, expectedRevision: undefined },
        OWNER_A,
      ),
    )
    expect(missing.httpStatus).toBe(428)

    const wrong = await expectError(() =>
      service.respondToClarification(
        { runId: RUN_A, clarificationId: randomUUID(), typedResponse: { choice: 'a' }, expectedRevision: waiting.revision },
        OWNER_A,
      ),
    )
    expect(wrong.code).toBe('CLARIFICATION_NOT_FOUND')

    const continued = await service.respondToClarification(
      { runId: RUN_A, clarificationId, typedResponse: { choice: 'a' }, expectedRevision: waiting.revision },
      OWNER_A,
    )
    expect(continued.state).toBe('collecting')
    expect(continued.pendingClarificationId).toBeUndefined()
  })

  it('refuses a clarification response from a non-owner', async () => {
    const { service } = makeService()
    const clarificationId = randomUUID()
    await awaitingRun(service, OWNER_A, clarificationId)
    const run = await service.getRun(RUN_A, OWNER_A)
    const error = await expectError(() =>
      service.respondToClarification(
        { runId: RUN_A, clarificationId, typedResponse: { choice: 'a' }, expectedRevision: run.revision },
        OTHER_A,
      ),
    )
    expect(error.code).toBe('FORBIDDEN')
  })

  it('keeps the runtime-private checkpoint separate and refuses an incompatible runtime version', async () => {
    const { service } = makeService()
    const clarificationId = randomUUID()
    await awaitingRun(service, OWNER_A, clarificationId)
    const run = await service.getRun(RUN_A, OWNER_A)

    const checkpointId = randomUUID()
    const stateDigest = `sha256:${'1'.repeat(64)}`
    const ref: RuntimeCheckpointRef = await service.saveRuntimeCheckpoint(
      {
        runId: RUN_A,
        checkpointId,
        runtimeKind: RUNTIME_REF.id,
        runtimeVersion: RUNTIME_REF.version,
        stateDigest,
        payload: new Uint8Array([1, 2, 3]),
      },
      OWNER_A,
    )
    expect(ref.checkpointId).toBe(checkpointId)
    const view = await service.getRun(RUN_A, OWNER_A)
    expect(view.checkpoint?.checkpointId).toBe(checkpointId)
    expect(JSON.stringify(view)).not.toContain('payload')

    const incompatible = await expectError(() =>
      service.resumeRun(
        {
          runId: RUN_A,
          checkpointId,
          runtimeKind: OTHER_RUNTIME_REF.id,
          runtimeVersion: OTHER_RUNTIME_REF.version,
          stateDigest,
          expectedRevision: run.revision,
        },
        OWNER_A,
      ),
    )
    expect(incompatible.code).toBe('CHECKPOINT_INCOMPATIBLE')
    expect(incompatible.httpStatus).toBe(409)

    const missing = await expectError(() =>
      service.resumeRun(
        {
          runId: RUN_A,
          checkpointId: randomUUID(),
          runtimeKind: RUNTIME_REF.id,
          runtimeVersion: RUNTIME_REF.version,
          stateDigest,
          expectedRevision: run.revision,
        },
        OWNER_A,
      ),
    )
    expect(missing.code).toBe('CHECKPOINT_NOT_FOUND')

    const resumed = await service.resumeRun(
      {
        runId: RUN_A,
        checkpointId,
        runtimeKind: RUNTIME_REF.id,
        runtimeVersion: RUNTIME_REF.version,
        stateDigest,
        expectedRevision: run.revision,
      },
      OWNER_A,
    )
    expect(resumed.state).toBe('collecting')
  })

  it('refuses to save a checkpoint for a different runtime version', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    const error = await expectError(() =>
      service.saveRuntimeCheckpoint(
        {
          runId: RUN_A,
          checkpointId: randomUUID(),
          runtimeKind: OTHER_RUNTIME_REF.id,
          runtimeVersion: OTHER_RUNTIME_REF.version,
          stateDigest: `sha256:${'2'.repeat(64)}`,
          payload: new Uint8Array([1]),
        },
        OWNER_A,
      ),
    )
    expect(error.code).toBe('CHECKPOINT_INCOMPATIBLE')
  })
})

describe('RunService runtime event projection', () => {
  it('projects plan/clarification/collection events onto the public SSE surface', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    await service.recordRuntimeEvent(RUN_A, planEvent(RUN_A, randomUUID()), OWNER_A)
    await service.recordRuntimeEvent(RUN_A, clarificationEvent(RUN_A, randomUUID(), randomUUID()), OWNER_A)
    const events = await service.listEvents(RUN_A, undefined, OWNER_A)
    expect(events.map((event) => event.event)).toEqual([
      'run.state',
      'plan.summary',
      'clarification.required',
    ])
    for (const event of events) {
      expect(event.event).not.toBe('unverified_answer.delta')
    }
  })

  it('never exposes collection_complete as a published answer', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    await service.recordRuntimeEvent(RUN_A, planEvent(RUN_A, randomUUID()), OWNER_A)
    const result = await service.recordRuntimeEvent(RUN_A, collectionCompleteEvent(RUN_A, randomUUID()), OWNER_A)
    expect(result.disposition).toBe('applied')
    expect(result.runState).toBe('drafting')
    const events = await service.listEvents(RUN_A, undefined, OWNER_A)
    const last = events[events.length - 1]
    expect(last?.event).toBe('run.state')
    expect(last?.data['draftAllowed']).toBe(true)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)
  })

  it('treats checkpoint_ready as private and de-duplicates a re-delivered event id', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    const checkpointId = randomUUID()
    const stateDigest = `sha256:${'3'.repeat(64)}`
    await service.saveRuntimeCheckpoint(
      {
        runId: RUN_A,
        checkpointId,
        runtimeKind: RUNTIME_REF.id,
        runtimeVersion: RUNTIME_REF.version,
        stateDigest,
        payload: new Uint8Array([9]),
      },
      OWNER_A,
    )
    const checkpointEvent: RuntimeEvent = {
      type: 'checkpoint_ready',
      runId: RUN_A,
      eventId: randomUUID(),
      sequence: 1,
      occurredAt: '2026-09-21T00:02:00Z',
      checkpointRef: {
        checkpointId,
        runId: RUN_A,
        runtimeKind: RUNTIME_REF.id,
        runtimeVersion: RUNTIME_REF.version,
        stateDigest,
        createdAt: '2026-09-21T00:02:00Z',
      },
    }
    const privateResult = await service.recordRuntimeEvent(RUN_A, checkpointEvent, OWNER_A)
    expect(privateResult.disposition).toBe('private')
    const events = await service.listEvents(RUN_A, undefined, OWNER_A)
    expect(events).toHaveLength(1)

    const plan = planEvent(RUN_A, randomUUID())
    await service.recordRuntimeEvent(RUN_A, plan, OWNER_A)
    const duplicate = await service.recordRuntimeEvent(RUN_A, plan, OWNER_A)
    expect(duplicate.disposition).toBe('duplicate')
    const after = await service.listEvents(RUN_A, undefined, OWNER_A)
    expect(after).toHaveLength(2)
  })

  it('replays strictly after Last-Event-ID without gaps or duplicates', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    await service.recordRuntimeEvent(RUN_A, planEvent(RUN_A, randomUUID()), OWNER_A)
    await service.recordRuntimeEvent(RUN_A, collectionCompleteEvent(RUN_A, randomUUID()), OWNER_A)
    const all = await service.listEvents(RUN_A, undefined, OWNER_A)
    expect(all.map((event) => event.id)).toEqual(['1', '2', '3'])

    const replayed = await service.listEvents(RUN_A, '1', OWNER_A)
    expect(replayed.map((event) => event.id)).toEqual(['2', '3'])
    const ids = new Set([...all, ...replayed].map((event) => event.id))
    expect(ids.size).toBe(3)
  })
})

describe('RunService cancellation isolation', () => {
  it('quarantines a late runtime event and never revives a cancelled run', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    const cancelled = await service.cancelRun(
      { runId: RUN_A, reason: 'user cancelled', expectedRevision: '1' },
      OWNER_A,
    )
    const revision = cancelled.revision

    const late = await service.recordRuntimeEvent(RUN_A, collectionCompleteEvent(RUN_A, randomUUID()), OWNER_A)
    expect(late.disposition).toBe('abandoned')
    expect(late.runState).toBe('cancelled')

    const after = await service.getRun(RUN_A, OWNER_A)
    expect(after.state).toBe('cancelled')
    expect(after.revision).toBe(revision)
    const events = await service.listEvents(RUN_A, undefined, OWNER_A)
    expect(events.some((event) => event.event === 'answer.published')).toBe(false)

    const abandoned = await service.listAbandonedAttempts(RUN_A, OWNER_A)
    expect(abandoned).toHaveLength(1)
  })

  it('quarantines a late result recorded directly and does not publish', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    await service.cancelRun({ runId: RUN_A, reason: 'stop', expectedRevision: '1' }, OWNER_A)
    const attemptId = randomUUID()
    const record = await service.recordLateResult(
      RUN_A,
      { attemptId, reason: 'tool completed after cancellation' },
      OWNER_A,
    )
    expect(record.attemptId).toBe(attemptId)
    const view = await service.getRun(RUN_A, OWNER_A)
    expect(view.state).toBe('cancelled')
  })

  it('accepts a cancelled runtime event to settle a cancelling run', async () => {
    const { service } = makeService()
    await service.createRun(createInput(), OWNER_A)
    await service.recordRuntimeEvent(RUN_A, cancelledEvent(RUN_A, randomUUID()), OWNER_A)
    const view = await service.getRun(RUN_A, OWNER_A)
    expect(view.state).toBe('cancelled')
  })
})
