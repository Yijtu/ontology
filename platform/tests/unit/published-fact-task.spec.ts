import { describe, expect, it } from 'vitest'
import { createPublishedFactTask, PUBLISHED_FACT_TASK_ID } from '@ontology/app-api'
import { sha256DigestOf } from '@ontology/core'
import { InMemoryArtifactWriter } from './tool-gateway-fixtures'
import { BLOB_ID, NOW, RUN_ID, InMemoryVerificationEvidence, buildEvidence, buildInputManifest, ownerContext } from './verification-fixtures'

const profileRef = { id: 'operator-sql-facilities', version: '1.0.0' }
const definitionRef = { id: 'operator.transport-facilities', version: '1.0.0', digest: `sha256:${'d'.repeat(64)}` }

async function harness(payload: unknown) {
  const evidence = new InMemoryVerificationEvidence()
  const artifacts = new InMemoryArtifactWriter()
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const payloadRef = { id: BLOB_ID, version: '1.0.0', digest: sha256DigestOf(new TextDecoder().decode(bytes)), kind: 'artifact' as const }
  const recorded = await evidence.record(
    { tenantId: ownerContext().principal.tenantId, spaceId: ownerContext().allowedResources.spaceId },
    buildEvidence({ payloadRef, resultDigest: payloadRef.digest }),
  )
  const task = createPublishedFactTask({
    profileRef, namespace: 'operator-transport', conceptId: 'road_facility', definitionRef,
    attributes: [{ id: 'facility_key', kind: 'string' }, { id: 'district', kind: 'string' }, { id: 'inspection_state', kind: 'enum' }],
    evidence, artifacts, blobStore: { readAuthorized: () => Promise.resolve(bytes) },
  })
  const request = {
    runId: RUN_ID, question: '已发布的本体设施事实有哪些？',
    inputManifest: buildInputManifest([recorded.evidenceRef]),
    deficits: [], remainingBudget: { deadline: NOW, toolCallsRemaining: 1, repairAttemptsRemaining: 0, parallelToolLimit: 1 }, attempt: 1,
  }
  return { task, request, artifacts }
}

function fact(state: string) {
  return {
    kind: 'fact', conceptRef: { namespace: 'operator-transport', conceptId: 'road_facility' },
    payload: { subjectEntityId: 'facility-entity-001', value: { attributes: [
      { attributeId: 'facility_key', value: 'bridge-n-01' },
      { attributeId: 'district', value: 'north' },
      { attributeId: 'inspection_state', value: state },
    ] } },
  }
}

describe('registered published ontology fact task', () => {
  it('pins a non-energy task and writes source-bound typed assertions', async () => {
    const { task, request, artifacts } = await harness({ items: [fact('needs_inspection')], gaps: [] })
    expect(task.descriptor.taskId).toBe(PUBLISHED_FACT_TASK_ID)
    expect(task.supportsQuestion('已发布的本体设施事实有哪些？')).toBe(true)
    expect(task.supportsQuestion('电池容量是多少？')).toBe(false)
    const result = await task.draftWriter.writeDraft(request, ownerContext())
    expect(result.draft.assertions?.map((assertion) => assertion.predicate)).toEqual(['facility_key', 'district', 'inspection_state'])
    expect(result.draft.assertions?.[2]).toMatchObject({ kind: 'enum', subject: 'facility-entity-001', value: 'needs_inspection' })
    expect(result.draft.assertions?.[2]?.references[0]).toMatchObject({
      valuePointer: '/items/0/payload/value/attributes/2/value', subjectPointer: '/items/0/payload/subjectEntityId',
    })
    expect(artifacts.written).toHaveLength(1)
    expect(result.evidenceRefs).toHaveLength(1)
  })

  it('refuses conflicting or incomplete published fact pages', async () => {
    const conflict = await harness({ items: [fact('needs_inspection'), fact('clear')], gaps: [] })
    await expect(conflict.task.draftWriter.writeDraft(conflict.request, ownerContext())).rejects.toThrow(/conflict/)
    expect(conflict.artifacts.written).toHaveLength(0)
    const incomplete = await harness({ items: [fact('needs_inspection')], gaps: ['facts_truncated'] })
    await expect(incomplete.task.draftWriter.writeDraft(incomplete.request, ownerContext())).rejects.toThrow(/coverage gap/)
    expect(incomplete.artifacts.written).toHaveLength(0)
  })
})
