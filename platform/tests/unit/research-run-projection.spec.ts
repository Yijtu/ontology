import { describe, expect, it } from 'vitest'
import {
  initialResearchExecutionProjection,
  stopReasonOfTerminalRun,
  terminalResearchExecutionProjection,
} from '@ontology/application'
import type { ResearchExecutionV2 } from '@ontology/contracts'

const RESEARCH_ID = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'

function queued(): ResearchExecutionV2 {
  return initialResearchExecutionProjection({
    researchId: RESEARCH_ID,
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    goal: { kind: 'industry_workspace_research', workspaceId: WORKSPACE_ID, draftRevision: '1' },
    briefRef: { id: 'brief', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}`, kind: 'artifact' },
    policyRef: { id: 'policy', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` },
    budgetRef: { id: 'budget', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}` },
    limits: { sourceLimit: 5, candidateLimit: 5, deadline: '2030-01-01T00:00:00Z' },
    mustCover: [{ kind: 'rule', name: '停机条件' }],
    budgetLimits: undefined,
    ledgerDeadline: '2030-01-01T00:00:00Z',
    recordedAt: '2026-10-19T00:00:00Z',
  })
}

describe('terminal research projection', () => {
  it('advances a queued projection to a cancelled stop without rewriting the frozen inputs', () => {
    const before = queued()
    const after = terminalResearchExecutionProjection({
      projection: before,
      status: 'cancelled',
      stopReason: 'cancelled',
      recordedAt: '2026-10-19T00:05:00Z',
    })
    expect(after.status).toBe('cancelled')
    expect(after.stopReason).toBe('cancelled')
    expect(after.recordedAt).toBe('2026-10-19T00:05:00Z')
    // The frozen goal/brief/policy/budget and the coverage gaps survive unchanged.
    expect(after.goal).toEqual(before.goal)
    expect(after.briefRef).toEqual(before.briefRef)
    expect(after.budget).toEqual(before.budget)
    expect(after.coverageGaps).toEqual(before.coverageGaps)
  })

  it('keeps the phase the run died in and never relabels a failure as completed', () => {
    const running: ResearchExecutionV2 = { ...queued(), status: 'running', stage: 'searching' }
    const after = terminalResearchExecutionProjection({
      projection: running,
      status: 'failed',
      stopReason: 'provider_failed',
      recordedAt: '2026-10-19T00:05:00Z',
    })
    expect(after.stage).toBe('searching')
    expect(after.status).toBe('failed')
  })

  it('does not leave a completed stage on a terminal failure', () => {
    const completedStage: ResearchExecutionV2 = { ...queued(), status: 'running', stage: 'completed' }
    const after = terminalResearchExecutionProjection({
      projection: completedStage,
      status: 'failed',
      stopReason: 'provider_failed',
      recordedAt: '2026-10-19T00:05:00Z',
    })
    expect(after.stage).not.toBe('completed')
  })

  it('drops review todos that no longer apply to a run that never delivered', () => {
    const withTodos: ResearchExecutionV2 = {
      ...queued(),
      status: 'running',
      stage: 'archiving',
      humanTodos: [
        { todoId: '44444444-4444-4444-8444-444444444444', kind: 'source_review', message: 'review sources', createdAt: '2026-10-19T00:00:00Z' },
        { todoId: '55555555-5555-4555-8555-555555555555', kind: 'external_wait', message: 'wait for provider', createdAt: '2026-10-19T00:00:00Z' },
      ],
    }
    const after = terminalResearchExecutionProjection({
      projection: withTodos,
      status: 'failed',
      stopReason: 'provider_failed',
      recordedAt: '2026-10-19T00:05:00Z',
    })
    expect(after.humanTodos.map((todo) => todo.kind)).toEqual(['external_wait'])
  })
})

describe('terminal stop reason mapping', () => {
  it('maps a cancellation to cancelled regardless of its reason text', () => {
    expect(stopReasonOfTerminalRun('cancelled', 'user_cancelled_research')).toBe('cancelled')
    expect(stopReasonOfTerminalRun('cancelled', undefined)).toBe('cancelled')
  })

  it('maps the controller bounded reasons onto the canonical research stop reasons', () => {
    expect(stopReasonOfTerminalRun('failed', 'DEADLINE_EXCEEDED')).toBe('deadline_exceeded')
    expect(stopReasonOfTerminalRun('failed', 'BUDGET_EXHAUSTED')).toBe('budget_exhausted')
    expect(stopReasonOfTerminalRun('failed', 'candidate_quota_exhausted')).toBe('budget_exhausted')
  })

  it('reports an unrecognised failure as provider_failed, never as a completion', () => {
    expect(stopReasonOfTerminalRun('failed', 'workflow_failed')).toBe('provider_failed')
    expect(stopReasonOfTerminalRun('failed', 'NO_PROGRESS')).toBe('provider_failed')
    expect(stopReasonOfTerminalRun('failed', undefined)).toBe('provider_failed')
  })
})
