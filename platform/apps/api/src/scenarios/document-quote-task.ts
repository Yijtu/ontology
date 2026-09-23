import { randomUUID } from 'node:crypto'
import type { ProfileRef } from '@ontology/contracts'
import { defineQueryTaskDescriptor } from '../composition/query-tasks'
import type { RegisteredQueryTask } from '../composition/query-tasks'
import type { EvidenceStorePort, DraftWriterPort, ImmutableArtifactWriter } from '@ontology/contracts'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { LOCAL_POLICY_COLLECTION, LocalDocumentCapability } from '../composition/local-documents'
import { createDocumentQuoteDraftWriter } from './task-drafts'

export const DOCUMENT_QUOTE_TASK_ID = 'documents.policy-quote'

export function createDocumentQuoteTask(input: {
  readonly profileRef: ProfileRef
  readonly documents: LocalDocumentCapability
  readonly evidence: EvidenceStorePort
  readonly artifacts: ImmutableArtifactWriter
  readonly blobStore: LocalImmutableBlobStore
}): RegisteredQueryTask {
  const draftWriter: DraftWriterPort = createDocumentQuoteDraftWriter({ evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobStore })
  return {
    profileRef: input.profileRef,
    descriptor: defineQueryTaskDescriptor({
      taskId: DOCUMENT_QUOTE_TASK_ID, version: '1.0.0', handlerVersion: '1.0.0',
      label: '从已导入文档定位原文',
      description: '返回已授权文档中的精确 span 引文；不会把关键词命中解释为语义结论或全集缺失。',
      fields: [],
    }),
    draftWriter,
    supportsQuestion: (question) => question.trim().length >= 2,
    async *execute({ question, gateway, ctx }) {
      yield { type: 'step_started', stepId: 'policy-document-search', toolId: 'document_search' }
      const result = await gateway.invoke({
        callId: randomUUID(),
        toolId: 'document_search',
        arguments: { query: question, allowedCollectionRefs: [LOCAL_POLICY_COLLECTION], mode: 'keyword', limit: 5 },
      }, ctx)
      yield { type: 'result', toolId: 'document_search', result }
    },
  }
}
