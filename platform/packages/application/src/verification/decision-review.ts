import type {
  DecisionQuestion,
  DecisionResult,
  DraftClaim,
  Sha256Digest,
  Uuid,
  VerificationFinding,
  VerificationPolicy,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * The policy-driven JEV semantic review (D7.4, C2, ADR-09).
 *
 * The decision port only answers fixed `choice` questions with a preserved option set and a
 * probability distribution. This module builds those questions from a fixed option set and
 * maps the selected option id back to a semantic finding. It never reads an explanation,
 * reason or any other prose from a `DecisionResult`: the type has no such field, and the only
 * strings this module consumes are the fixed option ids.
 */

export const SEMANTIC_SUPPORTED = 'supported'
export const SEMANTIC_UNSUPPORTED = 'unsupported'
export const SEMANTIC_INSUFFICIENT = 'insufficient'

const SEMANTIC_OPTIONS = Object.freeze([
  { optionId: SEMANTIC_SUPPORTED, label: 'supported' },
  { optionId: SEMANTIC_UNSUPPORTED, label: 'unsupported' },
  { optionId: SEMANTIC_INSUFFICIENT, label: 'insufficient' },
])

export function semanticOptionSetHash(): Sha256Digest {
  return sha256DigestOf(canonicalJson(SEMANTIC_OPTIONS))
}

export function buildSemanticQuestion(
  claim: DraftClaim,
  policy: VerificationPolicy,
  newId: () => Uuid,
): DecisionQuestion {
  return {
    questionId: newId(),
    type: 'choice',
    prompt: `Is the structured claim ${claim.claimId} supported by the evidence bound to it?`,
    options: SEMANTIC_OPTIONS.map((option) => ({ optionId: option.optionId, label: option.label })),
    optionSetHash: semanticOptionSetHash(),
    definitionVersion: policy.decisionDefinitionVersion,
  }
}

export type SemanticOutcome =
  | { readonly kind: 'supported' }
  | { readonly kind: 'finding'; readonly finding: VerificationFinding }
  | { readonly kind: 'unavailable'; readonly reason: 'fallback' | 'no_selection' }

/**
 * Map one fixed-shape decision result to a semantic outcome. Only `selectedOptionId` and the
 * presence of `fallback` are inspected; `distribution`, `confidence` and any other numeric
 * fields are deliberately ignored so a high score can never override a hard failure.
 */
export function interpretSemanticResult(result: DecisionResult, claimId: Uuid): SemanticOutcome {
  if (result.fallback !== undefined) return { kind: 'unavailable', reason: 'fallback' }
  switch (result.selectedOptionId) {
    case SEMANTIC_SUPPORTED:
      return { kind: 'supported' }
    case SEMANTIC_UNSUPPORTED:
      return {
        kind: 'finding',
        finding: { code: 'semantic_unsupported', axis: 'semantic', claimId },
      }
    case SEMANTIC_INSUFFICIENT:
      return {
        kind: 'finding',
        finding: { code: 'semantic_insufficient', axis: 'semantic', claimId },
      }
    default:
      return { kind: 'unavailable', reason: 'no_selection' }
  }
}
