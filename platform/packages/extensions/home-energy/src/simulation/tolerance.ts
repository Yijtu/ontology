/**
 * Deterministic numeric helpers for the simulator.
 *
 * Computation stays in IEEE-754 double; rounding is a reporting-layer concern only, applied to
 * computed values before they are placed in the result. There is no `toFixed` locale dependency
 * and no randomness, so the same arithmetic always produces the same bytes.
 */

/** Round a computed value to a fixed number of decimals, deterministically. */
export function round(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** True when `observed` is within `tolerance` of `limit` (inclusive). */
export function withinTolerance(observed: number, limit: number, tolerance: number): boolean {
  return Math.abs(observed - limit) <= tolerance
}

/** True when `value` is finite and lies in the closed interval [low, high] within tolerance. */
export function inRange(value: number, low: number, high: number, tolerance: number): boolean {
  return value >= low - tolerance && value <= high + tolerance
}
