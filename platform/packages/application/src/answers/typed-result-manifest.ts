import { assertTypedResultManifestShape } from '@ontology/contracts'
import type { Sha256Digest, TypedResultManifest } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * Deterministic content digest of a `typed-result-manifest@1` (SPEC v0.3a execution-evidence
 * §EX-7.1). The manifest is archived as an immutable artifact keyed by this digest, and the
 * `answer-draft@3` body pins it by ref/digest; the verifier and the publication gate both
 * recompute it from the archived body, so a tampered manifest no longer matches its ref and
 * the answer cannot be published.
 *
 * The digest deliberately covers the manifest body only: it never references the later
 * `answer-draft@3` or its verification/table receipts, so no manifest↔answer digest cycle can
 * form.
 */
export function typedResultManifestContentDigest(manifest: TypedResultManifest): Sha256Digest {
  assertTypedResultManifestShape(manifest)
  return sha256DigestOf(
    canonicalJson({
      schemaVersion: manifest.schemaVersion,
      executionBindingRef: manifest.executionBindingRef,
      taskBindingRef: manifest.taskBindingRef,
      resultKind: manifest.resultKind,
      outputSchemaRef: manifest.outputSchemaRef,
      inputSnapshotRef: manifest.inputSnapshotRef,
      outputDigest: manifest.outputDigest,
      tables: manifest.tables,
      limitations: manifest.limitations,
      coverage: manifest.coverage,
      domainStatus: manifest.domainStatus,
      dataMode: manifest.dataMode,
    }),
  )
}
