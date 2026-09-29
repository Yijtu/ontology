import type {
  DecisionQuestion,
  DecisionResult,
  DraftClaim,
  ResourceRef,
  Sha256Digest,
  Uuid,
  VerifiedAssertion,
  VerificationFinding,
  VerificationPolicy,
  WorkflowInputManifest,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import type { ResolvedEvidence } from './hard-checks'

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

export interface SemanticDecisionStateInput {
  readonly runId: Uuid
  readonly resolvedProfileHash: Sha256Digest
  readonly question: string
  readonly draftHash: Sha256Digest
  readonly inputManifest: WorkflowInputManifest
  readonly claims: readonly DraftClaim[]
  readonly assertions: readonly VerifiedAssertion[]
  readonly evidence: ReadonlyMap<string, ResolvedEvidence>
}

interface SemanticEvidenceState {
  readonly ref: ResourceRef
  readonly availability: 'not_in_manifest' | 'not_available' | 'reference_mismatch' | 'unreadable' | 'readable'
  readonly envelope?: ResolvedEvidence['record']['envelope']
  readonly payload?: unknown
}

export function semanticOptionSetHash(): Sha256Digest {
  return sha256DigestOf(canonicalJson(SEMANTIC_OPTIONS))
}

/**
 * Assemble a complete description of the verification decision state from the original
 * question, draft-bound typed claims/assertions, manifest identity and the evidence bytes
 * the hard-check pass already read. Missing evidence is represented explicitly; it is never
 * silently omitted or described as readable.
 */
export function buildSemanticDecisionState(input: SemanticDecisionStateInput): Readonly<Record<string, unknown>> {
  const refs = new Map<string, ResourceRef>()
  for (const claim of input.claims) {
    for (const binding of claim.references) refs.set(referenceKey(binding.evidenceRef), binding.evidenceRef)
  }
  for (const assertion of input.assertions) {
    for (const binding of assertion.references) refs.set(referenceKey(binding.evidenceRef), binding.evidenceRef)
    if (assertion.kind === 'rule_judgement') {
      for (const ref of assertion.premiseRefs) refs.set(referenceKey(ref), ref)
    }
  }

  const evidence: SemanticEvidenceState[] = [...refs.values()]
    .sort((left, right) => referenceKey(left).localeCompare(referenceKey(right)))
    .map((ref) => {
      const inManifest = input.inputManifest.entries.some(
        (entry) => entry.kind === 'evidence' && entry.ref !== undefined && sameRef(entry.ref, ref),
      )
      if (!inManifest) return { ref, availability: 'not_in_manifest' }
      const resolved = input.evidence.get(ref.id)
      if (resolved === undefined) return { ref, availability: 'not_available' }
      if (!sameRef(resolved.record.evidenceRef, ref)) {
        return { ref, availability: 'reference_mismatch' }
      }
      if (resolved.unreadable || resolved.payload === undefined) {
        return { ref, availability: 'unreadable', envelope: resolved.record.envelope }
      }
      return {
        ref,
        availability: 'readable',
        envelope: resolved.record.envelope,
        payload: resolved.payload,
      }
    })

  return {
    schemaVersion: 'verification-semantic-state@1',
    runId: input.runId,
    resolvedProfileHash: input.resolvedProfileHash,
    question: input.question,
    draftHash: input.draftHash,
    inputManifest: {
      manifestId: input.inputManifest.manifestId,
      revision: input.inputManifest.revision,
      digest: input.inputManifest.digest,
    },
    claims: input.claims,
    assertions: input.assertions,
    evidence,
    evidenceCoverage: {
      complete: evidence.length > 0 && evidence.every((entry) => entry.availability === 'readable'),
      referenceCount: evidence.length,
      readableCount: evidence.filter((entry) => entry.availability === 'readable').length,
    },
  }
}

function referenceKey(ref: ResourceRef): string {
  return `${ref.id}\u0000${ref.version}\u0000${ref.digest}\u0000${ref.kind}`
}

function sameRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
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
