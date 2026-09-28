import { describe, expect, it } from 'vitest'
import type { BudgetRemaining, EvidenceRecord, ResourceRef, ToolContext, WorkflowInputManifest } from '@ontology/contracts'
import { answerDraftContentHash } from '@ontology/application'
import { PublishedFactsDraftWriter } from '../../apps/api/src/composition/published-facts-draft'
import { toolContext } from './component-registry-fixtures'

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const EVIDENCE_REF: ResourceRef = {
  id: '11111111-1111-4111-8111-111111111111',
  version: '1.0.0',
  digest: `sha256:${'b'.repeat(64)}`,
  kind: 'evidence',
}
const PAYLOAD_REF: ResourceRef = {
  id: '22222222-2222-4222-8222-222222222222',
  version: '1.0.0',
  digest: `sha256:${'c'.repeat(64)}`,
  kind: 'artifact',
}
const SECOND_EVIDENCE_REF: ResourceRef = {
  id: '66666666-6666-4666-8666-666666666666',
  version: '1.0.0',
  digest: `sha256:${'f'.repeat(64)}`,
  kind: 'evidence',
}
const SECOND_PAYLOAD_REF: ResourceRef = {
  id: '77777777-7777-4777-8777-777777777777',
  version: '1.0.0',
  digest: `sha256:${'9'.repeat(64)}`,
  kind: 'artifact',
}
const RESULT_DIGEST = `sha256:${'d'.repeat(64)}`

function context(): ToolContext {
  return toolContext(undefined, undefined, ['business-user'], 'facts-writer', RUN_ID)
}

function manifest(): WorkflowInputManifest {
  const recordedAt = '2026-09-28T00:00:00.000Z'
  return {
    manifestId: '44444444-4444-4444-8444-444444444444',
    runId: RUN_ID,
    revision: '1',
    entries: [{
      entryId: '55555555-5555-4555-8555-555555555555',
      kind: 'evidence',
      label: 'evidence:published-facts',
      ref: EVIDENCE_REF,
      addedInPhase: 'collecting',
      recordedAt,
      readAt: recordedAt,
    }],
    digest: `sha256:${'e'.repeat(64)}`,
  }
}

function budgetRemaining(): BudgetRemaining {
  return {
    deadline: '2030-01-01T00:00:00.000Z',
    toolCallsRemaining: 100,
    repairAttemptsRemaining: 4,
    parallelToolLimit: 4,
    tokensRemaining: 1000,
  }
}

function evidenceRecord(ctx: ToolContext, evidenceRef = EVIDENCE_REF, payloadRef = PAYLOAD_REF): EvidenceRecord {
  const envelope = {
    evidenceId: evidenceRef.id,
    kind: 'observation' as const,
    scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
    producedBy: {
      componentRef: { id: 'tool-gateway', version: '1.0.0', digest: RESULT_DIGEST },
      runId: RUN_ID,
    },
    observedAt: '2026-09-28T00:00:00.000Z',
    sourceSnapshots: [{
      sourceRef: { namespace: 'published-semantics', sourceId: 'control' },
      schemaVersion: '1.0.0',
      readAt: '2026-09-28T00:00:00.000Z',
      consistency: 'repeatable_read' as const,
      resultDigest: RESULT_DIGEST,
    }],
    resultDigest: RESULT_DIGEST,
    integrity: { algorithm: 'sha256' as const, digest: RESULT_DIGEST },
    dependencies: [],
    dataMode: 'observed' as const,
    payloadRef,
  }
  return {
    evidenceRef,
    envelope,
    envelopeDigest: RESULT_DIGEST,
    revision: '1',
    recordedAt: '2026-09-28T00:00:00.000Z',
  }
}

describe('PublishedFactsDraftWriter', () => {
  it('renders only deterministic typed assertions from an archived, complete fact result', async () => {
    const ctx = context()
    const sourceEvidence = evidenceRecord(ctx)
    const payload = {
      definitionVersion: { id: 'synthetic-transport.schema', version: '1.0.0', digest: RESULT_DIGEST },
      gaps: [],
      items: [{
        kind: 'fact',
        ref: { id: 'statement-T-01#inspection_due@1', version: '1.0.0', digest: RESULT_DIGEST },
        conceptRef: { namespace: 'synthetic-transport', conceptId: 'inspection_due', definitionVersion: '1.0.0' },
        payload: {
          subjectEntityId: 'T-01',
          objectId: 'transport_facility',
          attributeId: 'inspection_due',
          value: true,
          schemaRef: { id: 'synthetic-transport.schema', version: '1.0.0', digest: RESULT_DIGEST },
          validity: { validFrom: '2026-01-01T00:00:00Z' },
          recordedSeq: '1',
          assertionId: 'statement-T-01#inspection_due@1',
          logicalAssertionId: 'statement-T-01#inspection_due',
          sourceStatementId: 'statement-T-01',
          sourceRefs: [EVIDENCE_REF],
        },
      }],
      autoPublished: false,
    }
    const writer = new PublishedFactsDraftWriter({
      evidence: {
        get: async () => sourceEvidence,
        record: async () => sourceEvidence,
        listByRun: async () => [sourceEvidence],
      },
      artifacts: {
        getAuthorized: async () => ({ integrityVerified: true }),
        readAuthorized: async () => new TextEncoder().encode(JSON.stringify(payload)),
      },
    })
    const request = {
      runId: RUN_ID,
      question: '按已发布数据列出T-01的inspection_due。',
      inputManifest: manifest(),
      deficits: [],
      remainingBudget: budgetRemaining(),
      attempt: 1,
    }

    const first = await writer.writeDraft(request, ctx)
    const retry = await writer.writeDraft(request, ctx)
    expect(first.draft.schemaVersion).toBe('answer-draft@2')
    expect(first.draft.blocks).toEqual([{ kind: 'assertion', assertionId: first.draft.assertions?.[0]?.assertionId }])
    expect(first.draft.assertions?.[0]).toMatchObject({
      kind: 'boolean',
      subject: 'T-01',
      predicate: 'inspection_due',
      value: true,
      references: [{
        evidenceRef: EVIDENCE_REF,
        valuePointer: '/items/0/payload/value',
        subjectPointer: '/items/0/payload/subjectEntityId',
        fieldRefPointer: '/items/0/payload/attributeId',
      }],
    })
    expect(retry.draft.contentHash).toBe(first.draft.contentHash)
    expect(retry.draft.claims).toEqual(first.draft.claims)
    expect(first.draft.contentHash).toBe(answerDraftContentHash(
      RUN_ID,
      first.draft.blocks,
      manifest().digest,
      first.draft.claims ?? [],
      first.draft.assertions ?? [],
      { schemaVersion: 'answer-draft@2', limitations: [] },
    ))
  })

  it('does not turn an incomplete facts page into a publishable typed answer', async () => {
    const ctx = context()
    const completeEvidence = evidenceRecord(ctx)
    const incompleteEvidence = evidenceRecord(ctx, SECOND_EVIDENCE_REF, SECOND_PAYLOAD_REF)
    const inputManifest = {
      ...manifest(),
      entries: [
        ...manifest().entries,
        {
          entryId: '88888888-8888-4888-8888-888888888888',
          kind: 'evidence' as const,
          label: `evidence:${SECOND_EVIDENCE_REF.id}`,
          ref: SECOND_EVIDENCE_REF,
          addedInPhase: 'collecting' as const,
          recordedAt: '2026-09-28T00:00:00.000Z',
          readAt: '2026-09-28T00:00:00.000Z',
        },
      ],
    }
    const writer = new PublishedFactsDraftWriter({
      evidence: {
        get: async (_scope, evidenceId) => evidenceId === EVIDENCE_REF.id ? completeEvidence : incompleteEvidence,
        record: async () => completeEvidence,
        listByRun: async () => [completeEvidence, incompleteEvidence],
      },
      artifacts: {
        getAuthorized: async () => ({ integrityVerified: true }),
        readAuthorized: async (request) => new TextEncoder().encode(JSON.stringify(
          request.blobRef.id === PAYLOAD_REF.id
            ? { gaps: [], items: [{ kind: 'fact' }] }
            : { gaps: ['facts_uncovered:result_page_truncated'], items: [] },
        )),
      },
    })
    await expect(writer.writeDraft({
      runId: RUN_ID,
      question: '列出所有设施。',
      inputManifest,
      deficits: [],
      remainingBudget: budgetRemaining(),
      attempt: 1,
    }, ctx)).rejects.toMatchObject({ code: 'INSUFFICIENT_DATA' })
  })
})
