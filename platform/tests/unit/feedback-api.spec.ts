import { describe, expect, it } from 'vitest'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest, FeedbackWriter } from '@ontology/app-api'
import type { FeedbackView, RecordFeedbackInput } from '@ontology/application'
import type { ToolContext } from '@ontology/contracts'

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const RUN_ID = '11111111-aaaa-4aaa-8aaa-000000000001'
const ANSWER_ID = '22222222-aaaa-4aaa-8aaa-000000000001'

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const raw = request.headers['x-test-subject']
  const subject = Array.isArray(raw) ? raw[0] : raw
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  return {
    principal: {
      tenantId: SCOPE.tenantId,
      subjectId: subject,
      roles: ['business-user'],
      scopes: [],
      authEpoch: 1,
    },
    spaceId: SCOPE.spaceId,
  }
}

class FakeWriter implements FeedbackWriter {
  readonly recorded: RecordFeedbackInput[] = []
  lastSubject = ''

  recordFeedback(input: RecordFeedbackInput, ctx: ToolContext): Promise<FeedbackView> {
    this.recorded.push(input)
    this.lastSubject = ctx.principal.subjectId
    return Promise.resolve({
      feedbackId: input.feedbackId,
      runId: input.runId,
      ...(input.answerId === undefined ? {} : { answerId: input.answerId }),
      kind: input.kind,
      ...(input.rating === undefined ? {} : { rating: input.rating }),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      submittedBy: ctx.principal.subjectId,
      sequence: '1',
      occurredAt: '2026-09-21T00:00:00Z',
      recordedAt: '2026-09-21T00:00:01Z',
    })
  }

  listByRun(): Promise<readonly FeedbackView[]> {
    return Promise.resolve(this.#views())
  }

  listByAnswer(runId: string, answerId: string): Promise<readonly FeedbackView[]> {
    return Promise.resolve(
      this.#views().filter((view) => view.runId === runId && view.answerId === answerId),
    )
  }

  #views(): FeedbackView[] {
    return this.recorded.map((input, index) => ({
      feedbackId: input.feedbackId,
      runId: input.runId,
      ...(input.answerId === undefined ? {} : { answerId: input.answerId }),
      kind: input.kind,
      ...(input.rating === undefined ? {} : { rating: input.rating }),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      submittedBy: this.lastSubject,
      sequence: String(index + 1),
      occurredAt: '2026-09-21T00:00:00Z',
      recordedAt: '2026-09-21T00:00:01Z',
    }))
  }
}

function server(writer: FeedbackWriter) {
  return createApiServer({ authenticate: testAuthenticator, feedback: { writer } })
}

const headers = { 'x-test-subject': 'owner-a' }
const jsonHeaders = { ...headers, 'content-type': 'application/json' }

describe('feedback surface (C6, US-022)', () => {
  it('requires authentication', async () => {
    const app = server(new FakeWriter())
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN_ID}/feedback`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'feedback-0001' },
      payload: { kind: 'gap' },
    })
    expect(response.statusCode).toBe(401)
    await app.close()
  })

  it('requires an Idempotency-Key on submit', async () => {
    const app = server(new FakeWriter())
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN_ID}/feedback`,
      headers: jsonHeaders,
      payload: { kind: 'gap' },
    })
    expect(response.statusCode).toBe(400)
    const body = response.json<{ error: { code: string } }>()
    expect(body.error.code).toBe('INVALID_ARGUMENT')
    await app.close()
  })

  it('rejects an unknown feedback kind', async () => {
    const app = server(new FakeWriter())
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN_ID}/feedback`,
      headers: { ...jsonHeaders, 'idempotency-key': 'feedback-0001' },
      payload: { kind: 'not-a-kind' },
    })
    expect(response.statusCode).toBe(400)
    await app.close()
  })

  it('records feedback and returns 201', async () => {
    const writer = new FakeWriter()
    const app = server(writer)
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN_ID}/feedback`,
      headers: { ...jsonHeaders, 'idempotency-key': 'feedback-0001' },
      payload: { kind: 'answer_usefulness', answerId: ANSWER_ID, rating: 5, comment: 'great' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json<{ data: { feedback: FeedbackView } }>()
    expect(body.data.feedback.kind).toBe('answer_usefulness')
    expect(body.data.feedback.answerId).toBe(ANSWER_ID)
    expect(body.data.feedback.rating).toBe(5)
    expect(writer.recorded[0]?.idempotencyKey).toBe('feedback-0001')
    expect(writer.lastSubject).toBe('owner-a')
    await app.close()
  })

  it('reads feedback back by run and filters by answer', async () => {
    const writer = new FakeWriter()
    const app = server(writer)
    await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN_ID}/feedback`,
      headers: { ...jsonHeaders, 'idempotency-key': 'feedback-0001' },
      payload: { kind: 'gap', comment: 'run-level' },
    })
    await app.inject({
      method: 'POST',
      url: `/api/v1/runs/${RUN_ID}/feedback`,
      headers: { ...jsonHeaders, 'idempotency-key': 'feedback-0002' },
      payload: { kind: 'answer_usefulness', answerId: ANSWER_ID },
    })

    const byRun = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${RUN_ID}/feedback`,
      headers,
    })
    expect(byRun.statusCode).toBe(200)
    expect(byRun.json<{ data: { feedback: FeedbackView[] } }>().data.feedback).toHaveLength(2)

    const byAnswer = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${RUN_ID}/feedback?answerId=${ANSWER_ID}`,
      headers,
    })
    expect(byAnswer.statusCode).toBe(200)
    const filtered = byAnswer.json<{ data: { feedback: FeedbackView[] } }>().data.feedback
    expect(filtered).toHaveLength(1)
    expect(filtered[0]?.answerId).toBe(ANSWER_ID)
    await app.close()
  })
})
