import type { Sha256Digest, Uuid } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * Deterministic content hash of an answer draft. The draft writer and the verifier both use
 * it, so the verifier can recompute the hash from the draft body and reject a tampered draft
 * instead of trusting the writer's claim.
 *
 * The structured claims are part of the hash (D7.4): revising any claim changes the draft
 * hash, so a verdict produced for an older draft can never be reused for the revision. The
 * `claims` parameter defaults to the empty list so a legacy block-only draft hashes exactly
 * as before.
 */
export function answerDraftContentHash(
  runId: Uuid,
  blocks: readonly unknown[],
  evidenceManifestHash: Sha256Digest,
  claims: readonly unknown[] = [],
): Sha256Digest {
  return sha256DigestOf(canonicalJson({ runId, blocks, evidenceManifestHash, claims }))
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
