import { describe, expect, it } from 'vitest'
import { createToolContext } from '@ontology/contracts'
import type { ResearchAuthorizationReceipt, ToolContext } from '@ontology/contracts'
import {
  WorkspaceResearchContextError,
  createWorkspaceResearchContextResolver,
} from '../../apps/api/src/composition/core-workspace-research-context'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN = '33333333-3333-4333-8333-333333333333'
const WORKSPACE = '99999999-9999-4999-8999-999999999999'
const DEADLINE = new Date(Date.now() + 30 * 60_000).toISOString()

/** The generic worker context a research run must *not* be authorized by. */
function workerContext(): ToolContext {
  return createToolContext({
    principal: {
      tenantId: TENANT,
      subjectId: 'core-local-worker',
      roles: ['platform-admin', 'run-controller'],
      scopes: [],
      authEpoch: 1,
    },
    runId: RUN,
    resolvedProfileHash: `sha256:${'a'.repeat(64)}`,
    policyVersion: '0.2.0',
    deadline: DEADLINE,
    budgetReservation: {
      reservationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      runId: RUN,
      grantedAt: new Date().toISOString(),
      expiresAt: DEADLINE,
    },
    allowedResources: {
      tenantId: TENANT,
      spaceId: SPACE,
      resourceKinds: ['artifact'],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 1000,
    },
    traceId: 'core-worker',
  })
}

function receipt(overrides?: Partial<ResearchAuthorizationReceipt>): ResearchAuthorizationReceipt {
  return {
    schemaVersion: 'research-authorization-receipt@1',
    researchId: RUN,
    runId: RUN,
    workspaceId: WORKSPACE,
    draftRevision: '1',
    operatorSubjectId: 'user:researcher',
    operatorRoles: ['researcher'],
    allowedCommands: ['submit_candidates'],
    materialScopeRefs: [{ id: 'doc-1', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}`, kind: 'document' }],
    allowedDomains: ['standards.example.org'],
    effectiveQuota: { sourceLimit: 5, candidateLimit: 5, deadline: DEADLINE },
    deadline: DEADLINE,
    profileRef: { id: `workspace-research:${WORKSPACE}`, version: '1.0.0' },
    configSnapshotHash: `sha256:${'e'.repeat(64)}`,
    issuedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('a research context is rebuilt from the persisted receipt, not the worker context', () => {
  it('carries the receipt operator, domains, original deadline and config hash', async () => {
    const resolver = createWorkspaceResearchContextResolver({
      readReceipt: () => Promise.resolve(receipt()),
    })
    const { ctx, receipt: read } = await resolver.resolve(RUN, workerContext())

    expect(read.runId).toBe(RUN)
    expect(ctx.principal.subjectId).toBe('user:researcher')
    expect(ctx.principal.roles).toEqual(['researcher'])
    // The receipt's effective allowlist, not the worker's empty list.
    expect(ctx.allowedResources.domains).toEqual(['standards.example.org'])
    // The original deadline, not a rolling window from "now".
    expect(ctx.deadline).toBe(DEADLINE)
    expect(ctx.resolvedProfileHash).toBe(receipt().configSnapshotHash)
    expect(ctx.runId).toBe(RUN)
  })

  it('reports an unreadable admission as an explicit block instead of a wide context', async () => {
    const resolver = createWorkspaceResearchContextResolver({
      readReceipt: () => Promise.reject(new Error('no admission')),
    })
    await expect(resolver.resolve(RUN, workerContext())).rejects.toBeInstanceOf(WorkspaceResearchContextError)
    await expect(resolver.resolve(RUN, workerContext())).rejects.toMatchObject({ code: 'ADMISSION_NOT_FOUND' })
  })

  it('refuses a receipt that names a different run', async () => {
    const resolver = createWorkspaceResearchContextResolver({
      readReceipt: () => Promise.resolve(receipt({ runId: '44444444-4444-4444-8444-444444444444' })),
    })
    await expect(resolver.resolve(RUN, workerContext())).rejects.toMatchObject({ code: 'RECEIPT_UNREADABLE' })
  })

  it('intersects the persisted authorization with the current revocation state', async () => {
    const resolver = createWorkspaceResearchContextResolver({
      readReceipt: () => Promise.resolve(receipt()),
      revocations: () => Promise.resolve(['AUTHORIZATION_REVOKED']),
    })
    await expect(resolver.resolve(RUN, workerContext())).rejects.toMatchObject({ code: 'AUTHORIZATION_REVOKED' })
  })
})
