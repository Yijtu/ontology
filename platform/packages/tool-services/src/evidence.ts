import { sha256DigestOf } from '@ontology/core'
import type { Sha256Digest, ToolResult } from '@ontology/contracts'
import { canonicalJson } from './types'

/**
 * A transport-independent digest of a tool result's logical evidence semantics (C5).
 *
 * C5 requires the same source snapshots and computation inputs to produce the same
 * logical evidence digest on the local and MCP paths, while execution attempt ids,
 * evidence ids and run UUIDs may differ. The gateway's persisted `EvidenceEnvelope`
 * digest deliberately covers volatile bookkeeping (ids, `observedAt`, `readAt`), so it
 * is not comparable across runs. This projection keeps only the deterministic facts:
 * the outcome status, the schema reference, coverage, the domain status, the inline
 * payload, the archived result digest and each source snapshot's identity, schema
 * version, consistency and result digest. Volatile fields (`callId`, usage timing,
 * `readAt`/`asOf`, `archivedResultRef` and evidence/run ids) are excluded.
 */
export function logicalEvidenceDigest(result: ToolResult): Sha256Digest {
  const projection = {
    status: result.status,
    schemaRef: result.schemaRef,
    coverage: result.coverage,
    ...(result.domainStatus === undefined ? {} : { domainStatus: result.domainStatus }),
    ...(result.dataRef === undefined ? {} : { resultDigest: result.dataRef.digest }),
    ...(result.inlineData === undefined ? {} : { inlineData: result.inlineData }),
    evidenceCount: result.evidenceRefs.length,
    sourceSnapshots: result.sourceSnapshots.map((snapshot) => ({
      sourceRef: snapshot.sourceRef,
      schemaVersion: snapshot.schemaVersion,
      consistency: snapshot.consistency,
      resultDigest: snapshot.resultDigest,
      ...(snapshot.watermark === undefined ? {} : { watermark: snapshot.watermark }),
    })),
  }
  return sha256DigestOf(canonicalJson(projection))
}
