import { sha256DigestOf } from '@ontology/core'
import type { Sha256Digest } from '@ontology/contracts'

/**
 * A `noul` question has no option set (SPEC C2), yet `DecisionResult` requires an
 * `optionSetHash`. The adapter canonicalises that to the digest of the empty option set,
 * so a noul result is deterministic and carries no fabricated options.
 */
export const EMPTY_OPTION_SET_HASH: Sha256Digest = sha256DigestOf('[]')

/** Normalised probability distributions are compared with a small tolerance. */
export const PROBABILITY_SUM_EPSILON = 1e-6

export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_RETRY_BASE_DELAY_MS = 200
export const DEFAULT_ESTIMATED_TOKENS = 256
