import { describe, expect, it } from 'vitest'
import { createApiServer } from '@ontology/app-api'
import type { AnswerReader, AuthenticatedRequest } from '@ontology/app-api'
import type { PublishedAnswer, RevisionString, RunState } from '@ontology/contracts'

const SCOPE = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const RUN_ID = '11111111-aaaa-4aaa-8aaa-000000000001'

function testAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const raw = request.headers['x-test-subject']
  const subject = Array.isArray(raw) ? raw[0] : raw
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  return {
    principal: { tenantId: SCOPE.tenantId, subjectId: subject, roles: ['business-user'], scopes: [], authEpoch: 1 },
    spaceId: SCOPE.spaceId,
  }
}

class FakeReader implements AnswerReader {
  constructor(
    private readonly state: RunState,
    private readonly answer: PublishedAnswer | undefined,
  ) {}

  getRun(): Promise<{ readonly state: RunState; readonly revision: RevisionString }> {
    return Promise.resolve({ state: this.state, revision: '2' })
  }

  getAnswer(): Promise<PublishedAnswer | undefined> {
    return Promise.resolve(this.answer)
  }
}

const ANSWER: PublishedAnswer = {
  answerId: '22222222-aaaa-4aaa-8aaa-000000000001',
  runId: RUN_ID,
  draftId: '33333333-aaaa-4aaa-8aaa-000000000001',
  verificationId: '44444444-aaaa-4aaa-8aaa-000000000001',
  contentHash: `sha256:${'a'.repeat(64)}`,
  evidenceManifestHash: `sha256:${'b'.repeat(64)}`,
  scenarioManifestHash: `sha256:${'c'.repeat(64)}`,
  publicationKind: 'verified',
  limitations: [],
  blocks: [],
  claims: [],
  publishedAt: '2026-09-21T00:00:00Z',
}

function server(reader: AnswerReader) {
  return createApiServer({ authenticate: testAuthenticator, answers: { reader } })
}

const headers = { 'x-test-subject': 'owner-a' }

describe('GET /runs/{id}/answer (C6)', () => {
  it('returns the verified answer when one is published', async () => {
    const app = server(new FakeReader('published', ANSWER))
    const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/answer`, headers })
    expect(response.statusCode).toBe(200)
    const body = response.json<{ data: PublishedAnswer }>()
    expect(body.data.answerId).toBe(ANSWER.answerId)
    expect(body.data.publicationKind).toBe('verified')
    await app.close()
  })

  it('returns 202 while the run is still in progress', async () => {
    const app = server(new FakeReader('collecting', undefined))
    const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/answer`, headers })
    expect(response.statusCode).toBe(202)
    const body = response.json<{ data: { runId: string; state: string } }>()
    expect(body.data.state).toBe('collecting')
    await app.close()
  })

  it('returns an explicit 404 when a terminal run has no verified answer', async () => {
    const app = server(new FakeReader('cancelled', undefined))
    const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/answer`, headers })
    expect(response.statusCode).toBe(404)
    const body = response.json<{ error: { code: string } }>()
    expect(body.error.code).toBe('ANSWER_NOT_AVAILABLE')
    await app.close()
  })

  it('requires authentication', async () => {
    const app = server(new FakeReader('published', ANSWER))
    const response = await app.inject({ method: 'GET', url: `/api/v1/runs/${RUN_ID}/answer` })
    expect(response.statusCode).toBe(401)
    await app.close()
  })
})
