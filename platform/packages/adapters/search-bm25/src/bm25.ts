import { sha256DigestOf } from '@ontology/core'
import type { Sha256Digest } from '@ontology/contracts'

/**
 * A genuine BM25 implementation (Okapi BM25) used for keyword document ranking
 * (SPEC ADR-07, C4). The scoring, the tokenizer and the index digest are all pure
 * functions, so a query is reproducible from the indexed corpus alone.
 *
 * `k1`/`b` are the standard saturation and length-normalisation constants. They
 * are exported so a test can assert the exact expected ordering rather than
 * re-deriving the implementation it is meant to check.
 */
export const BM25_K1 = 1.2
export const BM25_B = 0.75

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu
const HAN_RUN = /^[\p{Script=Han}]+$/u

/**
 * Lower-case Unicode word tokenization. A run of Han characters is emitted as
 * individual characters because those scripts do not delimit words with spaces;
 * every other letter/number run is one token. The result is deterministic and
 * does not depend on locale or a dictionary.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0]
    if (HAN_RUN.test(token)) {
      for (const character of token) tokens.push(character)
    } else {
      tokens.push(token.toLowerCase())
    }
  }
  return tokens
}

/** Term frequency per distinct token, in first-seen order. */
export function termFrequencies(tokens: readonly string[]): Map<string, number> {
  const frequencies = new Map<string, number>()
  for (const token of tokens) {
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
  }
  return frequencies
}

/** Okapi BM25 inverse document frequency with the standard +0.5 smoothing. */
export function bm25Idf(docCount: number, documentFrequency: number): number {
  if (docCount <= 0 || documentFrequency <= 0) return 0
  return Math.log(1 + (docCount - documentFrequency + 0.5) / (documentFrequency + 0.5))
}

/**
 * One BM25 term contribution. `avgDocLength === 0` (an empty corpus) yields 0
 * instead of a division by zero; a document that does not contain the term is 0.
 */
export function bm25TermScore(
  termFrequency: number,
  docLength: number,
  avgDocLength: number,
  idf: number,
  k1: number = BM25_K1,
  b: number = BM25_B,
): number {
  if (termFrequency <= 0 || idf <= 0) return 0
  const denominator =
    termFrequency + k1 * (1 - b + b * (avgDocLength === 0 ? 0 : docLength / avgDocLength))
  if (denominator <= 0) return 0
  return idf * ((termFrequency * (k1 + 1)) / denominator)
}

/** The per-document facts the index digest is computed over. */
export interface IndexDigestDocument {
  readonly chunkId: string
  readonly documentDigest: Sha256Digest
  readonly textDigest: Sha256Digest
  readonly length: number
  readonly termFrequencies: ReadonlyMap<string, number>
}

/**
 * Content digest of one index generation. It is computed from a deterministic
 * canonical rendering: documents sorted by chunk id and each document's terms
 * sorted lexicographically, so the same corpus always produces the same digest
 * regardless of insertion order. A changed corpus produces a different digest,
 * which is what stops a rebuild from being confused with the version it replaces.
 */
export function canonicalIndexDigest(
  collectionRef: string,
  documents: readonly IndexDigestDocument[],
): Sha256Digest {
  const sortedDocuments = [...documents]
    .sort((left, right) => (left.chunkId < right.chunkId ? -1 : left.chunkId > right.chunkId ? 1 : 0))
    .map((document) => {
      const terms = [...document.termFrequencies.entries()].sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      )
      return [
        document.chunkId,
        document.documentDigest,
        document.textDigest,
        document.length,
        terms,
      ] as const
    })
  return sha256DigestOf(JSON.stringify({ collectionRef, documents: sortedDocuments }))
}
