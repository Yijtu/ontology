import { EnergyInputError } from './errors'
import type {
  CoverageConflict,
  CoverageDeclaration,
  CoveragePlan,
  RedundantMeasurementPoint,
} from './types'

/**
 * Measurement-point coverage (SPEC E2/E3, E-02).
 *
 * A parent meter and its sub-circuits measure the same physical load at different levels. Summing
 * them as if they were independent loads double counts. The coverage resolver makes the boundary
 * explicit: a selected point whose declared ancestor is also selected is `redundant` (covered by
 * that ancestor), and only `additive` points may be summed. Two selected points that claim the
 * *same* coverage are an unresolvable conflict and are refused instead of silently guessed.
 */

function ancestorsOf(
  declaration: CoverageDeclaration,
  byCoverageRef: ReadonlyMap<string, CoverageDeclaration>,
): readonly string[] {
  const chain: string[] = []
  let parent = declaration.parentCoverageRef
  const seen = new Set<string>([declaration.coverageRef])
  while (parent !== undefined) {
    if (seen.has(parent)) break
    seen.add(parent)
    const parentDeclaration = byCoverageRef.get(parent)
    if (parentDeclaration === undefined) break
    chain.push(parentDeclaration.measurementPointRef)
    parent = parentDeclaration.parentCoverageRef
  }
  return chain
}

export function resolveCoverage(
  declarations: readonly CoverageDeclaration[],
  selected: readonly string[],
): CoveragePlan {
  const byMeasurementPoint = new Map<string, CoverageDeclaration>()
  const byCoverageRef = new Map<string, CoverageDeclaration>()
  for (const declaration of declarations) {
    byMeasurementPoint.set(declaration.measurementPointRef, declaration)
    byCoverageRef.set(declaration.coverageRef, declaration)
  }
  const selectedSet = new Set(selected)

  const additive: string[] = []
  const redundant: RedundantMeasurementPoint[] = []

  for (const measurementPointRef of selected) {
    const declaration = byMeasurementPoint.get(measurementPointRef)
    if (declaration === undefined) {
      // No declared coverage: the point stands on its own, it is not silently dropped.
      additive.push(measurementPointRef)
      continue
    }
    const ancestor = ancestorsOf(declaration, byCoverageRef).find((candidate) =>
      selectedSet.has(candidate),
    )
    if (ancestor === undefined) {
      additive.push(measurementPointRef)
    } else {
      redundant.push({ measurementPointRef, coveredBy: ancestor, reason: 'covered_by_parent' })
    }
  }

  const byCoverage = new Map<string, string[]>()
  for (const measurementPointRef of selected) {
    const declaration = byMeasurementPoint.get(measurementPointRef)
    if (declaration === undefined) continue
    const existing = byCoverage.get(declaration.coverageRef)
    if (existing === undefined) {
      byCoverage.set(declaration.coverageRef, [measurementPointRef])
    } else {
      existing.push(measurementPointRef)
    }
  }
  const conflicts: CoverageConflict[] = []
  for (const [coverageRef, measurementPointRefs] of byCoverage) {
    if (measurementPointRefs.length > 1) {
      conflicts.push({ coverageRef, measurementPointRefs: [...measurementPointRefs].sort() })
    }
  }

  additive.sort()
  redundant.sort((left, right) => left.measurementPointRef.localeCompare(right.measurementPointRef))
  conflicts.sort((left, right) => left.coverageRef.localeCompare(right.coverageRef))

  return { additive, redundant, conflicts }
}

/** Refuse an ambiguous coverage selection; a clear parent/sub-circuit pair is allowed. */
export function assertNonOverlappingCoverage(plan: CoveragePlan): void {
  if (plan.conflicts.length === 0) return
  const detail = plan.conflicts
    .map((conflict) => `${conflict.coverageRef}=[${conflict.measurementPointRefs.join(', ')}]`)
    .join('; ')
  throw new EnergyInputError(
    'COVERAGE_CONFLICT',
    `measurement points claim the same coverage and cannot be summed: ${detail}`,
  )
}
