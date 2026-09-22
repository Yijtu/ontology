import type { Sha256Digest, Uuid } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * Deterministic content hash of an answer draft. The restricted draft writer and the
 * restricted verifier both use it, so the verifier can recompute the hash from the draft
 * body and reject a tampered draft instead of trusting the writer's claim.
 */
export function answerDraftContentHash(
  runId: Uuid,
  blocks: readonly unknown[],
  evidenceManifestHash: Sha256Digest,
): Sha256Digest {
  return sha256DigestOf(canonicalJson({ runId, blocks, evidenceManifestHash }))
}

/** Deterministic digest of an input manifest, independent of its revision counter. */
export function inputManifestDigest(
  runId: Uuid,
  entries: readonly { readonly entryId: Uuid; readonly kind: string; readonly ref?: unknown }[],
): Sha256Digest {
  return sha256DigestOf(
    canonicalJson({
      runId,
      entries: entries.map((entry) => ({
        entryId: entry.entryId,
        kind: entry.kind,
        ref: entry.ref ?? null,
      })),
    }),
  )
}
