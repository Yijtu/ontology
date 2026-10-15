import type { ComputeOperationHandler, ComputeOperationRequest, ComputeOperationResult, ComputeSourceObservation, ComputationData, DataQueryOutput, Sha256Digest, VersionRef } from '@ontology/contracts'
import { ComputeExecutionError } from './errors'
import { aggregate, decodeInput } from './example-aggregation'

export const EXAMPLE_OPERATION_REF = { id: 'example.compute.aggregate', version: '1' }
const EXAMPLE_SOURCE_REF = { namespace: 'example', sourceId: 'compute' }
export const EXAMPLE_INPUT_SCHEMA_VERSION = 'example-compute-input@1'
export const EXAMPLE_RESULT_MEDIA_TYPE = 'application/vnd.ontology.example-compute-result+json'

export function exampleAlgorithmRef(handlerDigest: Sha256Digest): VersionRef {
  return { id: 'example.aggregate', version: '1.0.0', digest: handlerDigest }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

export function createHandlers(handlerDigest: Sha256Digest): readonly ComputeOperationHandler[] {
  const handler: ComputeOperationHandler = {
    operationRef: EXAMPLE_OPERATION_REF,
    async execute(request: ComputeOperationRequest): Promise<ComputeOperationResult> {
      const ref = request.inputRefs[0]
      if (ref === undefined) {
        throw new ComputeExecutionError(
          'COMPUTE_INPUT_MISSING',
          'the example operation requires at least one approved input reference',
        )
      }
      const bytes = await request.readInput.read({ approvedInputRefs: [ref] }, request.ctx)
      const { rows } = decodeInput(bytes)
      const aggregation = aggregate(rows)
      const stored = await request.artifacts.putBytes(
        {
          scopeRef: { tenantId: request.ctx.principal.tenantId, spaceId: request.ctx.allowedResources.spaceId },
          content: new TextEncoder().encode(
            canonicalJson({ operationRef: request.operationRef, metrics: aggregation.metrics }),
          ),
          mediaType: EXAMPLE_RESULT_MEDIA_TYPE,
        },
        request.ctx,
      )
      const source: ComputeSourceObservation = {
        sourceRef: EXAMPLE_SOURCE_REF,
        schemaVersion: EXAMPLE_INPUT_SCHEMA_VERSION,
        consistency: 'immutable',
        resultDigest: stored.blobRef.digest,
      }
      const computation: ComputationData = {
        operationRef: request.operationRef,
        resultRef: stored.blobRef,
        algorithmVersion: exampleAlgorithmRef(handlerDigest),
        metrics: aggregation.metrics,
        domainStatus: aggregation.domainStatus,
      }
      const payload: DataQueryOutput = { resultKind: 'computation', computation }
      return {
        payload,
        status: 'ok',
        coverage: {
          returned: aggregation.returned,
          truncated: false,
          completeness: aggregation.completeness,
        },
        sources: [source],
        domainStatus: aggregation.domainStatus,
        dataMode: 'synthetic',
        evidenceKind: 'computation',
      }
    },
  }
  return [handler]
}
