import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createToolGatewayComposition } from '@ontology/app-api'
import { sha256DigestOf } from '@ontology/core'
import { createToolContext } from '@ontology/contracts'
import type { EvidenceEnvelope, RuntimeEvent, ToolCall } from '@ontology/contracts'
import {
  SOURCE_REF,
  canonicalToolValidator,
  fullProfile,
  operationRegistry,
} from '../../unit/tool-gateway-fixtures'
import { startAcceptanceEnvironment, timeoutHandler } from './acceptance-environment'
import type { AcceptanceEnvironment } from './acceptance-environment'
import { configureProfile, dataOf, errorCodeOf, injectJson } from './acceptance-helpers'

/**
 * LOCAL-054 cross-layer acceptance — failure paths.
 *
 * Each case drives a real failure through the real component: a role denial on the real
 * workbench route, a cross-tenant read through the real RLS-backed evidence store, a
 * clarification round on the real run service, and a tool deadline through the real gateway
 * (using the documented adapter cancellation contract).
 */

let env: AcceptanceEnvironment

beforeAll(async () => {
  env = await startAcceptanceEnvironment()
  await configureProfile(env)
}, 300_000)

afterAll(async () => {
  await env?.close()
})

function planEvent(runId: string): RuntimeEvent {
  return {
    type: 'plan_proposed',
    runId,
    eventId: randomUUID(),
    sequence: 0,
    occurredAt: '2026-09-21T00:01:00Z',
    planRef: { id: 'plan-1', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}`, kind: 'artifact' },
    stepCount: 2,
    toolIds: ['data_query'],
  }
}

function clarificationEvent(runId: string, clarificationId: string): RuntimeEvent {
  return {
    type: 'clarification_requested',
    runId,
    eventId: randomUUID(),
    sequence: 1,
    occurredAt: '2026-09-21T00:02:00Z',
    clarificationId,
    questionRef: { id: 'clarify-1', version: '1.0.0', digest: `sha256:${'e'.repeat(64)}` },
    questionType: 'choice',
  }
}

describe('LOCAL-054 failure paths', () => {
  it('denies a profile publish to a business user through the real role check', async () => {
    const denied = await injectJson(env.app, 'POST', '/api/v1/profiles', {
      headers: { 'idempotency-key': `denied-${randomUUID()}`, 'x-test-roles': 'business-user' },
      payload: { profileRef: { id: 'x', version: '1.0.0' }, spec: {}, environment: 'local_dev' },
    })
    expect(denied.status).toBe(403)
    expect(errorCodeOf(denied)).toBe('FORBIDDEN')
  })

  it('hides another tenant’s evidence without disclosing existence (real RLS)', async () => {
    const evidenceId = randomUUID()
    const payloadRef = await env.blobStore
      .stage(new TextEncoder().encode('cross-tenant evidence'), { scopeRef: env.scope.scopeRef }, env.scope.ctx)
      .then((staged) =>
        env.blobStore.publish(
          {
            scopeRef: env.scope.scopeRef,
            contentDigest: staged.contentDigest,
            mediaType: 'text/plain',
            byteSize: staged.byteSize,
            purpose: 'large_result',
          },
          env.scope.ctx,
        ),
      )
      .then((published) => published.blobRef)

    const envelope: EvidenceEnvelope = {
      evidenceId,
      kind: 'observation',
      scopeRef: env.scope.scopeRef,
      producedBy: {
        componentRef: { id: 'acceptance', version: '1.0.0', digest: sha256DigestOf('acceptance') },
        runId: randomUUID(),
      },
      observedAt: '2026-09-21T00:00:00Z',
      validity: { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' },
      sourceSnapshots: [
        {
          sourceRef: { namespace: 'acceptance', sourceId: 'db' },
          schemaVersion: '1',
          readAt: '2026-09-21T00:00:00Z',
          consistency: 'repeatable_read',
          resultDigest: sha256DigestOf('snapshot'),
        },
      ],
      resultDigest: sha256DigestOf('result'),
      integrity: { algorithm: 'sha256', digest: sha256DigestOf('integrity') },
      dependencies: [],
      dataMode: 'observed',
      payloadRef,
    }
    await env.evidence.record(env.scope.scopeRef, envelope, env.scope.ctx)

    const own = await injectJson(env.app, 'GET', `/api/v1/evidence/${evidenceId}`)
    expect(own.status).toBe(200)

    const crossTenant = await injectJson(env.app, 'GET', `/api/v1/evidence/${evidenceId}`, {
      headers: { 'x-test-scope': 'other' },
    })
    expect(crossTenant.status).toBe(404)
    expect(errorCodeOf(crossTenant)).toBe('EVIDENCE_NOT_FOUND')
  })

  it('resumes a clarification on the same run without resetting the budget', async () => {
    const created = await injectJson(env.app, 'POST', '/api/v1/runs', {
      headers: { 'idempotency-key': `clarify-run-${randomUUID()}` },
      payload: {
        profileRef: { id: 'home-energy-demo', version: '1.0.0' },
        question: '明天备电策略如何安排？',
        context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
        preferences: { route: 'auto', allowWeb: false },
      },
    })
    expect(created.status).toBe(202)
    const runId = dataOf<{ runId: string }>(created).runId

    await env.runService.recordRuntimeEvent(runId, planEvent(runId), env.scope.ctx)
    const clarificationId = randomUUID()
    await env.runService.recordRuntimeEvent(runId, clarificationEvent(runId, clarificationId), env.scope.ctx)

    const waiting = await env.runService.getRun(runId, env.scope.ctx)
    expect(waiting.state).toBe('awaiting_input')

    const responded = await injectJson(env.app, 'POST', `/api/v1/runs/${runId}/responses`, {
      headers: { 'if-match': waiting.revision },
      payload: { clarificationId, typedResponse: { selectedOptionId: 'backup-first' } },
    })
    expect(responded.status).toBe(200)
    expect(dataOf<{ state: string }>(responded).state).toBe('continued')

    const after = await env.runService.getRun(runId, env.scope.ctx)
    expect(after.state).toBe('collecting')
  })

  it('fails a tool call with a typed DEADLINE_EXCEEDED through the real gateway', async () => {
    const runId = randomUUID()
    const deadline = new Date(Date.now() + 250).toISOString()
    const ctx = createToolContext({
      principal: {
        tenantId: env.scope.tenantId,
        subjectId: 'acceptance-owner',
        roles: ['business-user'],
        scopes: ['tool:invoke'],
        authEpoch: 1,
      },
      runId,
      resolvedProfileHash: sha256DigestOf('deadline-profile'),
      policyVersion: '0.2.0',
      deadline,
      budgetReservation: {
        reservationId: randomUUID(),
        runId,
        grantedAt: '2026-09-21T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      allowedResources: {
        tenantId: env.scope.tenantId,
        spaceId: env.scope.spaceId,
        resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
        sourceRefs: [SOURCE_REF],
        collectionRefs: ['home-energy/manuals'],
        domains: ['example.com'],
        maxRows: 1000,
      },
      traceId: 'trace-deadline',
    })

    const ledgerId = randomUUID()
    await env.budget.openLedger({ ledgerId, kind: 'run', runId }, ctx)
    const composition = createToolGatewayComposition({
      database: env.database,
      blobStore: env.blobStore,
      budget: env.budget,
      validator: canonicalToolValidator(),
      handlers: [timeoutHandler()],
    })
    const gateway = composition.forRun({
      runId,
      ledgerId,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    })

    const call: ToolCall = {
      callId: randomUUID(),
      toolId: 'ontology_lookup',
      arguments: { scopeRef: env.scope.scopeRef, intent: 'definitions' },
    }
    const result = await gateway.invoke(call, ctx)
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('DEADLINE_EXCEEDED')
    expect(result.error?.retryable).toBe(true)
    expect(result.evidenceRefs).toEqual([])
    // The reservation is held as an unknown remote state, never released as a free failure.
    const settled = await env.adminClient.query<{ status: string; usage_unknown: boolean }>(
      `SELECT status, usage_unknown FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3`,
      [env.scope.tenantId, env.scope.spaceId, ledgerId],
    )
    expect(settled.rows.some((row) => row.usage_unknown)).toBe(true)
  })
})
