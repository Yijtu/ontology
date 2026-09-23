import type {
  DraftClaim,
  EvidenceRecord,
  Rfc3339UtcTimestamp,
  Uuid,
  VerificationFinding,
} from '@ontology/contracts'
import { resolveJsonPointer } from './pointers'

/**
 * The programmatic hard checks (D7.4: 硬检查失败优先于模型评分).
 *
 * They are pure functions over the draft's structured claims and the evidence the verifier
 * resolved from the real archive. Every failure names the claim, the field and (when it came
 * from a binding) the evidence and JSON pointer, so an injected unsupported conclusion is
 * located to the specific problem instead of a generic "verification failed".
 */

/** One evidence result the verifier loaded for a claim binding. */
export interface ResolvedEvidence {
  readonly record: EvidenceRecord
  /** The parsed archived result payload; absent when it could not be read/parsed. */
  readonly payload?: unknown
  readonly unreadable: boolean
}

export interface HardCheckOutcome {
  readonly findings: readonly VerificationFinding[]
  readonly supportedClaimIds: readonly Uuid[]
}

/** SQL NUMERIC/DECIMAL values are archived as exact strings by both query adapters. */
function canonicalDecimal(value: string): string | undefined {
  if (value.length > 256) return undefined
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/.exec(value)
  if (match === null) return undefined
  const fraction = match[3] ?? ''
  const allDigits = `${match[2]}${fraction}`.replace(/^0+/u, '')
  if (allDigits === '') return '0'
  const significant = allDigits.replace(/0+$/u, '')
  const trailingZeros = allDigits.length - significant.length
  const exponent = Number(match[4] ?? '0') - fraction.length + trailingZeros
  return `${match[1] === '-' ? '-' : ''}${significant}e${String(exponent)}`
}

function sameNumericValue(observed: unknown, claimed: number): boolean {
  if (!Number.isFinite(claimed)) return false
  if (typeof observed === 'number') return Number.isFinite(observed) && observed === claimed
  if (typeof observed !== 'string') return false
  const source = canonicalDecimal(observed)
  const assertion = canonicalDecimal(String(claimed))
  return source !== undefined && source === assertion
}

export function checkClaims(
  claims: readonly DraftClaim[],
  resolved: ReadonlyMap<string, ResolvedEvidence>,
  now: Rfc3339UtcTimestamp,
): HardCheckOutcome {
  const findings: VerificationFinding[] = []
  const supportedClaimIds: Uuid[] = []

  for (const claim of claims) {
    const claimFindings: VerificationFinding[] = []
    if (claim.references.length === 0) {
      claimFindings.push({ code: 'unbound_claim', axis: 'hard', claimId: claim.claimId })
    }
    for (const binding of claim.references) {
      const evidence = resolved.get(binding.evidenceRef.id)
      if (evidence === undefined) {
        claimFindings.push({
          code: 'evidence_not_found',
          axis: 'hard',
          claimId: claim.claimId,
          evidenceRef: binding.evidenceRef,
        })
        continue
      }
      if (evidence.record.envelope.resultDigest !== binding.resultDigest) {
        claimFindings.push({
          code: 'result_digest_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          evidenceRef: binding.evidenceRef,
          expected: evidence.record.envelope.resultDigest,
          actual: binding.resultDigest,
        })
      }
      if (evidence.unreadable || evidence.payload === undefined) {
        claimFindings.push({
          code: 'result_unreadable',
          axis: 'hard',
          claimId: claim.claimId,
          evidenceRef: binding.evidenceRef,
        })
        continue
      }

      const payload = evidence.payload
      const value = resolveJsonPointer(payload, binding.valuePointer)
      if (!value.found || (typeof value.value !== 'number' && typeof value.value !== 'string')) {
        claimFindings.push({
          code: 'number_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          field: 'value',
          evidenceRef: binding.evidenceRef,
          pointer: binding.valuePointer,
          expected: 'absent',
          actual: String(claim.value.value),
        })
      } else if (!sameNumericValue(value.value, claim.value.value)) {
        claimFindings.push({
          code: 'number_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          field: 'value',
          evidenceRef: binding.evidenceRef,
          pointer: binding.valuePointer,
          expected: String(value.value),
          actual: String(claim.value.value),
        })
      }

      const unit = resolveJsonPointer(payload, binding.unitPointer)
      if (!unit.found || typeof unit.value !== 'string') {
        claimFindings.push({
          code: 'unit_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          field: 'unit',
          evidenceRef: binding.evidenceRef,
          pointer: binding.unitPointer,
          expected: 'absent',
          actual: claim.value.unit,
        })
      } else if (unit.value !== claim.value.unit) {
        claimFindings.push({
          code: 'unit_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          field: 'unit',
          evidenceRef: binding.evidenceRef,
          pointer: binding.unitPointer,
          expected: unit.value,
          actual: claim.value.unit,
        })
      }

      const subject = resolveJsonPointer(payload, binding.subjectPointer)
      if (!subject.found || typeof subject.value !== 'string') {
        claimFindings.push({
          code: 'subject_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          field: 'subject',
          evidenceRef: binding.evidenceRef,
          pointer: binding.subjectPointer,
          expected: 'absent',
          actual: claim.subject,
        })
      } else if (subject.value !== claim.subject) {
        claimFindings.push({
          code: 'subject_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          field: 'subject',
          evidenceRef: binding.evidenceRef,
          pointer: binding.subjectPointer,
          expected: subject.value,
          actual: claim.subject,
        })
      }

      if (claim.time.asOf !== undefined && binding.timePointer === undefined) {
        claimFindings.push({
          code: 'time_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          field: 'time',
          evidenceRef: binding.evidenceRef,
          expected: 'a bound source time pointer',
          actual: claim.time.asOf,
        })
      } else if (binding.timePointer !== undefined && claim.time.asOf !== undefined) {
        const time = resolveJsonPointer(payload, binding.timePointer)
        if (!time.found || time.value !== claim.time.asOf) {
          claimFindings.push({
            code: 'time_mismatch',
            axis: 'hard',
            claimId: claim.claimId,
            field: 'time',
            evidenceRef: binding.evidenceRef,
            pointer: binding.timePointer,
            expected: typeof time.value === 'string' ? time.value : 'absent',
            actual: claim.time.asOf,
          })
        }
      }

      const validTo = evidence.record.envelope.validity?.validTo
      if (validTo !== undefined && Date.parse(now) >= Date.parse(validTo)) {
        claimFindings.push({
          code: 'stale_source',
          axis: 'hard',
          claimId: claim.claimId,
          evidenceRef: binding.evidenceRef,
          expected: validTo,
        })
      }
    }

    if (claimFindings.length === 0) {
      supportedClaimIds.push(claim.claimId)
    } else {
      findings.push(...claimFindings)
    }
  }

  return { findings: sortFindings(findings), supportedClaimIds }
}

/** Deterministic ordering so a verdict and its explanations are reproducible. */
export function sortFindings(findings: readonly VerificationFinding[]): VerificationFinding[] {
  return [...findings].sort(
    (left, right) =>
      (left.claimId ?? '').localeCompare(right.claimId ?? '') ||
      left.code.localeCompare(right.code) ||
      (left.field ?? '').localeCompare(right.field ?? '') ||
      (left.evidenceRef?.id ?? '').localeCompare(right.evidenceRef?.id ?? ''),
  )
}
