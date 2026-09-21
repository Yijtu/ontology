import type { ContractRange, Semver } from './generated/contracts'

/**
 * Minimal semver comparison used to resolve `ContractRange` (C1 preflight).
 *
 * The platform pins artifacts by exact `Semver` and resolves them against a half-open
 * `[min, max)` range. That ordering cannot be expressed in JSON Schema, so it is enforced
 * here: an unparseable version or a range whose `max` is not strictly greater than `min`
 * is rejected instead of being treated as an empty intersection.
 */
export interface ParsedSemver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: readonly string[]
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

export function tryParseSemver(value: string): ParsedSemver | undefined {
  const match = SEMVER_PATTERN.exec(value)
  if (match === null) return undefined
  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) return undefined
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  }
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // A version without a prerelease has higher precedence than one with it.
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue

    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/** Total precedence order for two valid semver strings. Throws on malformed input. */
export function compareSemver(a: string, b: string): number {
  const left = tryParseSemver(a)
  const right = tryParseSemver(b)
  if (left === undefined) throw new Error(`not a semver version: ${a}`)
  if (right === undefined) throw new Error(`not a semver version: ${b}`)

  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * A contract range is valid when both bounds parse and `max` is strictly greater than
 * `min`. `[1.2.0, 1.2.0)` would silently match nothing, so it is rejected rather than
 * letting preflight report every capability as missing for the wrong reason.
 */
export function isValidContractRange(range: ContractRange): boolean {
  if (tryParseSemver(range.min) === undefined) return false
  if (range.max === undefined) return true
  if (tryParseSemver(range.max) === undefined) return false
  return compareSemver(range.max, range.min) > 0
}

/** True when `version` is inside the half-open contract range `[min, max)`. */
export function satisfiesContractRange(range: ContractRange, version: Semver): boolean {
  if (!isValidContractRange(range)) return false
  if (tryParseSemver(version) === undefined) return false
  if (compareSemver(version, range.min) < 0) return false
  if (range.max !== undefined && compareSemver(version, range.max) >= 0) return false
  return true
}
