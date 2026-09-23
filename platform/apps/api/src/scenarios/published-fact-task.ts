import { randomUUID } from 'node:crypto'
import type { DraftWriterPort, ProfileRef, VerifiedAssertion, VersionRef } from '@ontology/contracts'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { EvidenceStorePort, ImmutableArtifactWriter } from '@ontology/contracts'
import { defineQueryTaskDescriptor } from '../composition/query-tasks'
import type { RegisteredQueryTask } from '../composition/query-tasks'
import { archiveDraft, draftFromVerifiedAssertions, evidencePayloads } from './task-drafts'

export const PUBLISHED_FACT_TASK_ID = 'ontology.published-facts'

type AttributeSpec = { readonly id: string; readonly kind: 'string' | 'enum' | 'boolean' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A deployment contributes its industry concept/attributes; the task only accepts archived, verified fact pages. */
export function createPublishedFactTask(input: {
  readonly profileRef: ProfileRef
  readonly namespace: string
  readonly conceptId: string
  readonly definitionRef: VersionRef
  readonly attributes: readonly AttributeSpec[]
  readonly evidence: EvidenceStorePort
  readonly artifacts: ImmutableArtifactWriter
  readonly blobStore: Pick<LocalImmutableBlobStore, 'readAuthorized'>
}): RegisteredQueryTask {
  const allowed = new Map(input.attributes.map((attribute) => [attribute.id, attribute.kind]))
  const draftWriter: DraftWriterPort = {
    async writeDraft(request, ctx) {
      const sources = await evidencePayloads(request, { evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobStore }, ctx)
      const grouped = new Map<string, { readonly subject: string; readonly predicate: string; readonly kind: AttributeSpec['kind']; readonly value: string | boolean; readonly references: VerifiedAssertion['references'][number][] }>()
      for (const source of sources) {
        if (Array.isArray(source.payload['gaps']) && source.payload['gaps'].length > 0) throw new Error('published fact lookup reported a source or coverage gap')
        const items = source.payload['items']
        if (!Array.isArray(items)) continue
        for (const [itemIndex, rawItem] of items.entries()) {
          if (!isRecord(rawItem) || rawItem['kind'] !== 'fact' || !isRecord(rawItem['conceptRef']) || rawItem['conceptRef']['namespace'] !== input.namespace || rawItem['conceptRef']['conceptId'] !== input.conceptId) continue
          const fact = rawItem['payload']
          if (!isRecord(fact) || typeof fact['subjectEntityId'] !== 'string' || !isRecord(fact['value'])) continue
          const attributes = fact['value']['attributes']
          if (!Array.isArray(attributes)) continue
          for (const [attributeIndex, rawAttribute] of attributes.entries()) {
            if (!isRecord(rawAttribute) || typeof rawAttribute['attributeId'] !== 'string') continue
            const kind = allowed.get(rawAttribute['attributeId'])
            const value = rawAttribute['value']
            if (kind === undefined || (kind === 'boolean' ? typeof value !== 'boolean' : typeof value !== 'string')) continue
            const normalizedValue = kind === 'boolean' ? value === true : String(value)
            const subject = fact['subjectEntityId']
            const predicate = rawAttribute['attributeId']
            const key = `${subject}\u0000${predicate}`
            const reference = {
              evidenceRef: source.ref, resultDigest: source.resultDigest,
              valuePointer: `/items/${String(itemIndex)}/payload/value/attributes/${String(attributeIndex)}/value`,
              subjectPointer: `/items/${String(itemIndex)}/payload/subjectEntityId`,
            }
            const prior = grouped.get(key)
            if (prior !== undefined) {
              if (prior.kind !== kind || prior.value !== normalizedValue) throw new Error(`published facts conflict for ${predicate}`)
              prior.references.push(reference)
            } else grouped.set(key, { subject, predicate, kind, value: normalizedValue, references: [reference] })
          }
        }
      }
      if (grouped.size === 0) throw new Error('no source-bound published attribute was returned')
      const assertions: VerifiedAssertion[] = [...grouped.values()].map((group) => group.kind === 'boolean'
        ? { assertionId: randomUUID(), kind: 'boolean', subject: group.subject, predicate: group.predicate, value: group.value === true, references: group.references }
        : { assertionId: randomUUID(), kind: group.kind, subject: group.subject, predicate: group.predicate, value: String(group.value), references: group.references })
      const draft = draftFromVerifiedAssertions(request, assertions, ['仅列出当前已发布且身份仍有效的本体属性事实；候选、历史版本与未覆盖的来源不作为答案。'])
      return archiveDraft(draft, { evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobStore }, ctx)
    },
  }
  return {
    profileRef: input.profileRef,
    descriptor: defineQueryTaskDescriptor({
      taskId: PUBLISHED_FACT_TASK_ID, version: '1.0.0', handlerVersion: '1.0.0',
      label: '列出已发布本体事实', description: '从已审核发布且身份仍有效的实体事实中读取属性与来源。', fields: [],
    }),
    draftWriter,
    supportsQuestion: (question) => /(?:已发布|本体|语义|ontology|published)/iu.test(question) && /(?:事实|属性|设施|设备|fact|entity)/iu.test(question),
    async *execute({ gateway, ctx }) {
      yield { type: 'step_started', stepId: 'ontology.published-facts', toolId: 'ontology_lookup' }
      const result = await gateway.invoke({
        callId: randomUUID(), toolId: 'ontology_lookup', arguments: {
          scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
          intent: 'facts', concepts: [{ namespace: input.namespace, conceptId: input.conceptId, definitionVersion: input.definitionRef.version }], limit: 100,
        },
      }, ctx)
      yield { type: 'result', toolId: 'ontology_lookup', result }
    },
  }
}
