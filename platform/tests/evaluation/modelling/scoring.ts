import type { EvalFamily, ExpectedError, ExpectedEvaluation, ReferenceItem } from './fixed-set'

/**
 * Independent scoring of an observed candidate set against the authored oracle (V03-046).
 *
 * It compares by an implementation-neutral key and a small set of semantic fields, so the
 * result is a review classification — matched / missing / wrong / unexpected — and never a
 * re-derivation of the pipeline. The same function scores a controlled transcript and an
 * operator-supplied real-model transcript, which keeps the two reports comparable while the
 * readiness report still keeps them separate.
 */

export interface ObservedItem {
  readonly key: string
  readonly fields: Readonly<Record<string, string>>
}

export type ScoringError = ExpectedError

export interface CaseEvaluation {
  readonly caseId: string
  readonly family: EvalFamily
  readonly matched: readonly string[]
  readonly missing: readonly string[]
  readonly errors: readonly ScoringError[]
  readonly unexpected: readonly string[]
  readonly disambiguation: readonly string[]
  readonly requiredCorrections: readonly string[]
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function deriveCorrections(
  errors: readonly ScoringError[],
  missing: readonly string[],
  unexpected: readonly string[],
  disambiguation: readonly string[],
): string[] {
  const corrections: string[] = []
  for (const error of errors) {
    corrections.push(`correct ${error.key}.${error.field}: expected ${error.expected}, observed ${error.observed}`)
  }
  for (const key of missing) corrections.push(`provide ${key}`)
  for (const key of unexpected) corrections.push(`review ${key}: not in the reference`)
  for (const item of disambiguation) corrections.push(`resolve ${item}`)
  return sorted([...new Set(corrections)])
}

export function scoreAgainstReference(
  reference: readonly ReferenceItem[],
  observed: readonly ObservedItem[],
  disambiguation: readonly string[],
): Omit<CaseEvaluation, 'caseId' | 'family'> {
  const observedByKey = new Map<string, ObservedItem>()
  for (const item of observed) {
    if (!observedByKey.has(item.key)) observedByKey.set(item.key, item)
  }
  const referenceKeys = new Set(reference.map((item) => item.key))

  const matched: string[] = []
  const missing: string[] = []
  const errors: ScoringError[] = []
  for (const item of [...reference].sort((left, right) => (left.key < right.key ? -1 : 1))) {
    const found = observedByKey.get(item.key)
    if (found === undefined) {
      missing.push(item.key)
      continue
    }
    let wrong = false
    for (const field of Object.keys(item.fields).sort()) {
      const expected = item.fields[field] ?? ''
      const actual = found.fields[field] ?? ''
      if (actual !== expected) {
        errors.push({ key: item.key, field, expected, observed: actual })
        wrong = true
      }
    }
    if (!wrong) matched.push(item.key)
  }
  errors.sort((left, right) => {
    if (left.key !== right.key) return left.key < right.key ? -1 : 1
    return left.field < right.field ? -1 : left.field > right.field ? 1 : 0
  })

  const unexpected = sorted([...observedByKey.keys()].filter((key) => !referenceKeys.has(key)))
  const disambiguationSorted = sorted([...new Set(disambiguation)])

  return {
    matched: sorted(matched),
    missing: sorted(missing),
    errors,
    unexpected,
    disambiguation: disambiguationSorted,
    requiredCorrections: deriveCorrections(errors, missing, unexpected, disambiguationSorted),
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameErrors(left: readonly ScoringError[], right: readonly ExpectedError[]): boolean {
  return (
    left.length === right.length &&
    left.every((error, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        error.key === other.key &&
        error.field === other.field &&
        error.expected === other.expected &&
        error.observed === other.observed
      )
    })
  )
}

/** Whether a scored evaluation is exactly the independently authored expectation. */
export function evaluationMatchesExpected(
  evaluation: Omit<CaseEvaluation, 'caseId' | 'family'>,
  expected: ExpectedEvaluation,
): boolean {
  return (
    sameStringArray(evaluation.matched, expected.matched) &&
    sameStringArray(evaluation.missing, expected.missing) &&
    sameErrors(evaluation.errors, expected.errors) &&
    sameStringArray(evaluation.unexpected, expected.unexpected) &&
    sameStringArray(evaluation.disambiguation, expected.disambiguation) &&
    sameStringArray(evaluation.requiredCorrections, expected.requiredCorrections)
  )
}
