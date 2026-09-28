import type {
  ClaimExplanation,
  VerificationFinding,
  VerificationFindingCode,
} from '@ontology/contracts'

/**
 * The restricted explanation registry (D7.4, ADR-09).
 *
 * JEV is a decision port: it returns a selected option and a probability distribution, and it
 * has no field that can carry an explanation. The explanation a caller sees is always authored
 * here, from the finding's `code` and the verifier-computed typed parameters — never from
 * model or JEV text. `explain` therefore takes only a `VerificationFinding`; there is no code
 * path by which a decision response could reach the message.
 */

export const RESTRICTED_TEMPLATE_VERSION = 'restricted-explanation-templates@1'

type Template = (finding: VerificationFinding) => string

function locate(finding: VerificationFinding): string {
  const parts: string[] = []
  if (finding.claimId !== undefined) parts.push(`claim ${finding.claimId}`)
  if (finding.assertionId !== undefined) parts.push(`assertion ${finding.assertionId}`)
  if (finding.field !== undefined) parts.push(`field ${finding.field}`)
  if (finding.evidenceRef !== undefined) parts.push(`evidence ${finding.evidenceRef.id}`)
  if (finding.pointer !== undefined) parts.push(`at ${finding.pointer}`)
  return parts.join(' ')
}

const TEMPLATES: Readonly<Record<VerificationFindingCode, Template>> = Object.freeze({
  draft_hash_mismatch: () =>
    'the draft content hash does not recompute from its blocks, claims and evidence manifest hash',
  evidence_manifest_mismatch: () =>
    'the draft evidence manifest hash does not match the run input manifest digest',
  missing_claims: () =>
    'the draft carries no structured claims, so no statement can be bound to a result',
  claim_limit_exceeded: (finding) =>
    `the draft carries ${finding.actual ?? 'too many'} claims, above the policy limit of ${finding.expected ?? 'the configured maximum'}`,
  unbound_claim: (finding) => `${locate(finding)} has no evidence binding`,
  evidence_not_found: (finding) => `${locate(finding)} was not found in the run's evidence`,
  result_digest_mismatch: (finding) =>
    `${locate(finding)} digest does not match the digest recorded on the evidence`,
  result_unreadable: (finding) =>
    `${locate(finding)} result payload could not be read and verified`,
  number_mismatch: (finding) =>
    `${locate(finding)} declares ${finding.actual ?? 'a value'} but the bound result holds ${finding.expected ?? 'a different value'}`,
  unit_mismatch: (finding) =>
    `${locate(finding)} declares unit ${finding.actual ?? '(none)'} but the bound result holds ${finding.expected ?? '(none)'}`,
  subject_mismatch: (finding) =>
    `${locate(finding)} declares subject ${finding.actual ?? '(none)'} but the bound result holds ${finding.expected ?? '(none)'}`,
  predicate_mismatch: (finding) =>
    `${locate(finding)} does not match the semantic field selected in the bound result`,
  time_mismatch: (finding) =>
    `${locate(finding)} declares time ${finding.actual ?? '(none)'} but the bound result holds ${finding.expected ?? '(none)'}`,
  stale_source: (finding) =>
    `${locate(finding)} cites a source whose validity expired at ${finding.expected ?? 'its validity end'}`,
  semantic_unsupported: (finding) =>
    `${locate(finding)} was judged unsupported by the policy semantic review`,
  semantic_insufficient: (finding) =>
    `${locate(finding)} has insufficient semantic support in the cited evidence`,
  semantic_unavailable: () =>
    'the policy semantic review was unavailable; only the hard checks are reported',
  visible_statement_unbound: (finding) => `${locate(finding)} contains text outside the typed, result-bound answer blocks`,
  assertion_mismatch: (finding) => `${locate(finding)} does not match its bound result`,
  document_quote_mismatch: (finding) => `${locate(finding)} does not match the exact archived document span and digest`,
  evidence_reference_mismatch: (finding) => `${locate(finding)} uses a different evidence version than the archived result`,
  unverified_limitation: (finding) => `${locate(finding)} contains text that is not an approved limitation code`,
})

export class RestrictedExplanationTemplates {
  readonly version = RESTRICTED_TEMPLATE_VERSION

  explain(finding: VerificationFinding): ClaimExplanation {
    const message = TEMPLATES[finding.code](finding)
    return {
      code: finding.code,
      templateId: `${RESTRICTED_TEMPLATE_VERSION}:${finding.code}`,
      message,
      ...(finding.claimId === undefined ? {} : { claimId: finding.claimId }),
      ...(finding.assertionId === undefined ? {} : { assertionId: finding.assertionId }),
      ...(finding.field === undefined ? {} : { field: finding.field }),
      ...(finding.evidenceRef === undefined ? {} : { evidenceRef: finding.evidenceRef }),
    }
  }
}
