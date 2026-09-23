import type {
  DraftRepairFeedback,
  VerificationFinding,
  VerificationResult,
} from '@ontology/contracts'

/**
 * Build the located feedback a bounded repair draft draws on (FR-29, D7.4).
 *
 * The verifier's own `findings` are preferred: each one names the claim, field, evidence and
 * JSON pointer that failed. When a verifier returns only `failedChecks` codes (no located
 * finding), the codes are carried through as code-only feedback rather than dropped or
 * invented. The output never contains draft prose, so feeding it to the draft writer cannot
 * leak the draft, and it is passed only to the in-process `DraftWriterPort`.
 */
export function repairFeedbackOf(verification: VerificationResult): DraftRepairFeedback[] {
  const findings = verification.findings ?? []
  if (findings.length > 0) return findings.map(toFeedback)
  return verification.failedChecks.map((code) => ({ code }))
}

function toFeedback(finding: VerificationFinding): DraftRepairFeedback {
  return {
    code: finding.code,
    axis: finding.axis,
    ...(finding.claimId === undefined ? {} : { claimId: finding.claimId }),
    ...(finding.field === undefined ? {} : { field: finding.field }),
    ...(finding.evidenceRef === undefined ? {} : { evidenceRef: finding.evidenceRef }),
    ...(finding.pointer === undefined ? {} : { pointer: finding.pointer }),
    ...(finding.expected === undefined ? {} : { expected: finding.expected }),
    ...(finding.actual === undefined ? {} : { actual: finding.actual }),
  }
}
