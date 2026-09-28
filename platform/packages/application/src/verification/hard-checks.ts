import type {
  DraftClaim,
  EvidenceRecord,
  ResourceRef,
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

/** Canonical exact decimal form. It never rounds through IEEE-754. */
function canonicalDecimal(value: string): string | undefined {
  if (value.length === 0 || value.length > 64) return undefined
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/u.exec(value)
  if (match === null) return undefined
  const fraction = match[3] ?? ''
  const allDigits = `${match[2]}${fraction}`.replace(/^0+/u, '')
  if (allDigits === '') return '0'
  const significant = allDigits.replace(/0+$/u, '')
  const trailingZeros = allDigits.length - significant.length
  const scale = fraction.length - trailingZeros
  return `${match[1] === '-' ? '-' : ''}${significant}e${String(-scale)}`
}

function numericText(value: unknown): string | undefined {
  if (typeof value === 'string') return canonicalDecimal(value)
  if (typeof value === 'number' && Number.isFinite(value)) return canonicalDecimal(String(value))
  return undefined
}

function sameNumericValue(observed: unknown, claimed: number | string): boolean {
  const actual = numericText(observed)
  const expected = numericText(claimed)
  return actual !== undefined && expected !== undefined && actual === expected
}

function sameResourceRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

interface QueryCellLocation { readonly row: number; readonly column: number }

function indexOf(pointerPart: string | undefined): number | undefined {
  if (pointerPart === undefined || !/^(0|[1-9]\d*)$/u.test(pointerPart)) return undefined
  const value = Number(pointerPart)
  return Number.isSafeInteger(value) ? value : undefined
}

function queryCellLocation(pointer: string): QueryCellLocation | undefined {
  const parts = pointer.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (parts.length !== 4 || parts[0] !== 'table' || parts[1] !== 'rows') return undefined
  const row = indexOf(parts[2])
  const column = indexOf(parts[3])
  return row === undefined || column === undefined ? undefined : { row, column }
}

function sameRow(left: string, right: string): boolean {
  const leftCell = queryCellLocation(left)
  const rightCell = queryCellLocation(right)
  return leftCell !== undefined && rightCell !== undefined && leftCell.row === rightCell.row
}

function fieldReferenceAt(payload: unknown, pointer: string): string | undefined {
  const location = pointer.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
  if (location.length !== 3 || location[0] !== 'table' || location[1] !== 'columns' || indexOf(location[2]) === undefined) return undefined
  const column = resolveJsonPointer(payload, pointer)
  if (!column.found || typeof column.value !== 'object' || column.value === null || Array.isArray(column.value)) return undefined
  const row = column.value as Record<string, unknown>
  return typeof row.semanticFieldRef === 'string' ? row.semanticFieldRef : typeof row.name === 'string' ? row.name : undefined
}

interface ResultFieldBinding {
  readonly valuePointer: string
  readonly fieldRefPointer?: string
  readonly unitPointer?: string
  readonly subjectPointer: string
  readonly timePointer?: string
}

export function fieldBindingMatches(
  payload: unknown,
  binding: ResultFieldBinding,
  predicate: string,
): boolean {
  if (binding.fieldRefPointer === undefined) return false
  const cell = queryCellLocation(binding.valuePointer)
  const field = fieldReferenceAt(payload, binding.fieldRefPointer)
  const columnPointer = `/table/columns/${String(cell?.column ?? -1)}`
  return cell !== undefined && field === predicate && binding.fieldRefPointer === columnPointer &&
    (binding.unitPointer === undefined || binding.unitPointer === `${columnPointer}/unit`) &&
    sameRow(binding.valuePointer, binding.subjectPointer) &&
    (binding.timePointer === undefined || sameRow(binding.valuePointer, binding.timePointer))
}

export function checkClaims(
  claims: readonly DraftClaim[],
  resolved: ReadonlyMap<string, ResolvedEvidence>,
  now: Rfc3339UtcTimestamp,
  requireFieldBinding = false,
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
      if (!sameResourceRef(evidence.record.evidenceRef, binding.evidenceRef)) {
        claimFindings.push({
          code: 'evidence_reference_mismatch',
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
      if (requireFieldBinding && !fieldBindingMatches(payload, binding, claim.predicate)) {
        claimFindings.push({
          code: 'predicate_mismatch',
          axis: 'hard',
          claimId: claim.claimId,
          field: 'predicate',
          evidenceRef: binding.evidenceRef,
          pointer: binding.fieldRefPointer ?? binding.valuePointer,
          expected: claim.predicate,
        })
      }
      const value = resolveJsonPointer(payload, binding.valuePointer)
      if (!value.found || numericText(value.value) === undefined) {
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
