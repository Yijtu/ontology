const UTC_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/

/** Compare normalized RFC3339 UTC instants without discarding sub-millisecond precision. */
export function compareUtcInstants(left: string, right: string): number | undefined {
  const leftMatch = UTC_INSTANT.exec(left)
  const rightMatch = UTC_INSTANT.exec(right)
  if (leftMatch === null || rightMatch === null) return undefined
  const leftBase = leftMatch[1]
  const rightBase = rightMatch[1]
  if (leftBase === undefined || rightBase === undefined) return undefined
  if (leftBase !== rightBase) return leftBase < rightBase ? -1 : 1
  const leftFraction = (leftMatch[2] ?? '').padEnd(9, '0')
  const rightFraction = (rightMatch[2] ?? '').padEnd(9, '0')
  return leftFraction < rightFraction ? -1 : leftFraction > rightFraction ? 1 : 0
}

export function sameUtcInstant(left: string, right: string): boolean {
  return compareUtcInstants(left, right) === 0
}
