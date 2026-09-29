import { randomUUID } from 'node:crypto'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ModelCallEvidenceRecorder } from '@ontology/adapter-model-company'
import type { DecisionEvidenceRecorder } from '@ontology/adapter-model-jev'
import { isToolContext } from '@ontology/contracts'
import type { EvidenceEnvelope, EvidenceProducer, EvidenceStorePort, ResourceRef, ScopeRef, SourceSnapshot, ToolContext, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { canonicalJson } from '@ontology/tool-services'

const COMPONENT_VERSION = '1.0.0'
const MAX_EVIDENCE_PAYLOAD_BYTES = 1_048_576

export interface CoreModelEvidenceRecorderOptions {
  readonly evidence: Pick<EvidenceStorePort, 'record'>
  readonly blobs: Pick<LocalImmutableBlobStore, 'stage' | 'publish'>
  readonly scopeRef: ScopeRef
  readonly now?: () => string
  readonly newId?: () => string
}

/** Persist each adapter-reported output as a scoped immutable model_output envelope. */
export function createCoreModelEvidenceRecorders(options: CoreModelEvidenceRecorderOptions): {
  readonly generation: ModelCallEvidenceRecorder
  readonly decision: DecisionEvidenceRecorder
} {
  const now = options.now ?? (() => new Date().toISOString())
  const newId = options.newId ?? (() => randomUUID())
  const companyRef: VersionRef = {
    id: 'core-company-model-adapter',
    version: COMPONENT_VERSION,
    digest: sha256DigestOf('core-company-model-adapter@1.0.0'),
  }
  const jevRef: VersionRef = {
    id: 'core-jev-model-adapter',
    version: COMPONENT_VERSION,
    digest: sha256DigestOf('core-jev-model-adapter@1.0.0'),
  }

  async function record(input: {
    readonly runId: string
    readonly producer: EvidenceProducer
    readonly resultDigest: string
    readonly payload: unknown
    readonly snapshots: readonly SourceSnapshot[]
    readonly ctx: ToolContext
  }): Promise<ResourceRef> {
    if (
      !isToolContext(input.ctx) ||
      input.runId !== input.ctx.runId ||
      input.ctx.principal.tenantId !== options.scopeRef.tenantId ||
      input.ctx.allowedResources.tenantId !== options.scopeRef.tenantId ||
      input.ctx.allowedResources.spaceId !== options.scopeRef.spaceId
    ) {
      throw new Error('model evidence context must match its canonical run and deployment scope')
    }
    const payloadBytes = new TextEncoder().encode(canonicalJson(input.payload))
    if (payloadBytes.byteLength === 0 || payloadBytes.byteLength > MAX_EVIDENCE_PAYLOAD_BYTES) {
      throw new Error('model evidence payload is outside the bounded archive size')
    }
    const staged = await options.blobs.stage(payloadBytes, { scopeRef: options.scopeRef }, input.ctx)
    const payload = await options.blobs.publish({
      scopeRef: options.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: 'application/json',
      byteSize: staged.byteSize,
      purpose: 'artifact',
      origin: { kind: 'model_output', runId: input.runId },
    }, input.ctx)
    const observedAt = now()
    const body = {
      evidenceId: newId(),
      kind: 'model_output' as const,
      scopeRef: options.scopeRef,
      producedBy: input.producer,
      observedAt,
      sourceSnapshots: [...input.snapshots],
      resultDigest: input.resultDigest,
      dependencies: [],
      dataMode: 'observed' as const,
      payloadRef: payload.blobRef,
    } satisfies Omit<EvidenceEnvelope, 'integrity'>
    const envelope: EvidenceEnvelope = {
      ...body,
      integrity: { algorithm: 'sha256', digest: sha256DigestOf(canonicalJson(body)), verifiedAt: observedAt },
    }
    return (await options.evidence.record(options.scopeRef, envelope, input.ctx)).evidenceRef
  }

  return {
    generation: {
      record: async (request, ctx) => {
        const observedAt = now()
        return record({
          runId: request.runId,
          producer: { componentRef: companyRef, runId: request.runId },
          resultDigest: request.outputDigest,
          payload: {
            schemaVersion: 'core-model-generation-evidence@1',
            role: request.role,
            outputDigest: request.outputDigest,
            stopReason: request.stopReason,
          },
          snapshots: [{
            sourceRef: { namespace: 'core-model', sourceId: 'company-generation' },
            schemaVersion: COMPONENT_VERSION,
            readAt: observedAt,
            consistency: 'read_time',
            resultDigest: request.outputDigest,
          }],
          ctx,
        })
      },
    },
    decision: {
      record: async (request, ctx) => {
        const observedAt = now()
        const resultDigest = sha256DigestOf(canonicalJson({
          modelRef: request.modelRef,
          modelVersion: request.modelVersion,
          stateRef: request.stateRef,
          outcome: request.outcome,
          fallbackReason: request.fallbackReason,
          results: request.results,
        }))
        return record({
          runId: request.runId,
          producer: { componentRef: jevRef, runId: request.runId },
          resultDigest,
          payload: {
            schemaVersion: 'core-model-decision-evidence@1',
            ...request,
          },
          snapshots: [
            {
              sourceRef: { namespace: 'core-decision-state', sourceId: request.stateRef.id },
              schemaVersion: request.stateRef.version,
              readAt: observedAt,
              consistency: 'immutable',
              resultDigest: request.stateRef.digest,
              archivedResultRef: request.stateRef,
            },
            {
              sourceRef: { namespace: 'core-model', sourceId: `jev:${request.modelRef.modelId}` },
              schemaVersion: request.modelRef.version,
              readAt: observedAt,
              consistency: 'read_time',
              resultDigest,
            },
          ],
          ctx,
        })
      },
    },
  }
}
