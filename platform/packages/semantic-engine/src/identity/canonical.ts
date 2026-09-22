/**
 * Text normalisation for identity recall.
 *
 * Normalisation is applied only to a *derived* comparison key. The original observed
 * text is never overwritten: the recall result always carries `observedText` verbatim
 * next to `normalizedText`, so a reviewer can see exactly what was matched (D4.4).
 */

/**
 * Case-folded, NFKC-normalised, whitespace-collapsed comparison key. Unicode NFKC folds
 * compatibility forms (full-width, ligatures) so two spellings of one name compare equal;
 * punctuation is kept, because dropping it would merge distinct identifiers such as
 * `A-1` and `A1`.
 */
export function normalizeIdentityText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim()
}

/**
 * Half-open valid-time containment: `[validFrom, validTo)`. An undefined bound is open on
 * that side. Comparison is on the RFC 3339 UTC instants, which sort lexicographically.
 */
export function containsValidAt(
  validFrom: string | undefined,
  validTo: string | undefined,
  validAt: string | undefined,
): boolean {
  if (validAt === undefined) return true
  if (validFrom !== undefined && validAt < validFrom) return false
  if (validTo !== undefined && validAt >= validTo) return false
  return true
}

/** Distinct values of a normalised field, preserving first-seen order. */
export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
