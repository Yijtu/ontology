import { randomUUID } from 'node:crypto'
import type { ProfileRef } from '@ontology/contracts'
import { defineQueryTaskDescriptor } from '../composition/query-tasks'
import type { RegisteredQueryTask } from '../composition/query-tasks'
import type { EvidenceStorePort, DraftWriterPort, ImmutableArtifactWriter } from '@ontology/contracts'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { LocalTransportProfile } from '../composition/registered-transport-profile'
import { createTransportInspectionDraftWriter } from './task-drafts'

export const TRANSPORT_INSPECTION_TASK_ID = 'transport.inspection-list'

export function createTransportInspectionTask(input: {
  readonly source: LocalTransportProfile
  readonly evidence: EvidenceStorePort
  readonly artifacts: ImmutableArtifactWriter
  readonly blobStore: LocalImmutableBlobStore
}): RegisteredQueryTask {
  const profileRef: ProfileRef = input.source.profileRef
  const draftWriter: DraftWriterPort = createTransportInspectionDraftWriter({ evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobStore })
  return {
    profileRef,
    descriptor: defineQueryTaskDescriptor({
      taskId: TRANSPORT_INSPECTION_TASK_ID, version: '1.0.0', handlerVersion: '1.0.0',
      label: '列出待巡检设施',
      description: '按已登记的交通设施 schema 与 district mapping 查询待巡检设施。',
      fields: [{ name: 'district', label: '区域代码', kind: 'text', required: true, maxLength: 64, defaultValue: 'north' }],
    }),
    draftWriter,
    supportsQuestion: (question) => /(?:哪些|列出|名单|列表|list|which)/iu.test(question) && /(?:(?:设施|facility).{0,8}(?:待巡检|巡检|检查)|(?:待巡检|巡检|检查).{0,8}(?:设施|facility)|inspection list)/iu.test(question),
    async *execute({ taskInput, gateway, ctx }) {
      const district = taskInput['district']
      if (typeof district !== 'string') { yield { type: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'district must be text', retryable: false } }; return }
      let plan
      try { plan = input.source.planForDistrict(district) }
      catch { yield { type: 'failed', error: { code: 'INVALID_ARGUMENT', message: 'district is not a valid registered district key', retryable: false } }; return }
      yield { type: 'step_started', stepId: 'transport.inspection-query', toolId: 'data_query' }
      const result = await gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'query', mode: 'semantic', queryPlan: plan } }, ctx)
      yield { type: 'result', toolId: 'data_query', result }
    },
  }
}
