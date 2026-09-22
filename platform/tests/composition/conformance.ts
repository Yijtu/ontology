import type { QueryColumn, ToolCall, ToolResult, ToolResultStatus } from '@ontology/contracts'
import { logicalEvidenceDigest } from '@ontology/tool-services'

/**
 * The shared contract suite for the replaceability matrix (V2 X01–X08, C5).
 *
 * Every combination under test (two runtimes, two SQL backends, two transports) is asked
 * the same questions through the same `ToolContractTarget` seam. The suite normalises each
 * `ToolResult` to a backend-independent observation and compares observations field by
 * field. Only the differences listed in `ALLOWED_FORMATTING_DIFFERENCES`
 * (tests/composition/not-configured.ts) may vary; authorization, error, canonical data and
 * logical evidence must be identical.
 */

export interface ToolContractTarget {
  readonly label: string
  invoke(call: ToolCall): Promise<ToolResult>
}

export interface ConformanceObservation {
  readonly status: ToolResultStatus
  readonly errorCode: string | undefined
  readonly domainStatus: string | undefined
  readonly columns: readonly QueryColumn[] | undefined
  readonly rows: readonly (readonly unknown[])[] | undefined
  readonly evidenceCount: number
  readonly logicalEvidenceDigest: string
  readonly coverageReturned: number
  readonly coverageTruncated: boolean
  readonly snapshotConsistency: string | undefined
}

export interface ConformanceMismatch {
  readonly field: string
  readonly left: unknown
  readonly right: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function tableOf(inlineData: ToolResult['inlineData']): { columns?: unknown; rows?: unknown } {
  if (!isRecord(inlineData)) return {}
  const table = inlineData['table']
  if (!isRecord(table)) return {}
  return { columns: table['columns'], rows: table['rows'] }
}

function columnsOf(inlineData: ToolResult['inlineData']): readonly QueryColumn[] | undefined {
  const { columns } = tableOf(inlineData)
  if (!Array.isArray(columns)) return undefined
  const out: QueryColumn[] = []
  for (const column of columns) {
    if (!isRecord(column) || typeof column['name'] !== 'string' || typeof column['type'] !== 'string') {
      return undefined
    }
    out.push({ name: column['name'], type: column['type'] as QueryColumn['type'] })
  }
  return out
}

function rowsOf(inlineData: ToolResult['inlineData']): readonly (readonly unknown[])[] | undefined {
  const { rows } = tableOf(inlineData)
  if (!Array.isArray(rows)) return undefined
  const out: (readonly unknown[])[] = []
  for (const row of rows) {
    if (!Array.isArray(row)) return undefined
    out.push(row)
  }
  return out
}

/** Project a `ToolResult` to the backend-independent facts the contract suite compares. */
export function observeToolResult(result: ToolResult): ConformanceObservation {
  return {
    status: result.status,
    errorCode: result.error?.code,
    domainStatus: result.domainStatus,
    columns: columnsOf(result.inlineData),
    rows: rowsOf(result.inlineData),
    evidenceCount: result.evidenceRefs.length,
    logicalEvidenceDigest: logicalEvidenceDigest(result),
    coverageReturned: result.coverage.returned,
    coverageTruncated: result.coverage.truncated,
    snapshotConsistency: result.sourceSnapshots[0]?.consistency,
  }
}

/**
 * Compare two observations. Returns the mismatching fields (empty means the two targets
 * agree on every contract-relevant fact). Deliberately excludes volatile fields so the
 * documented formatting differences never appear here.
 *
 * `ignore` lets a combination exclude a field whose difference is genuinely
 * backend-specific and documented, e.g. the logical evidence digest when each mapping
 * binds a different physical source.
 */
export function compareObservations(
  left: ConformanceObservation,
  right: ConformanceObservation,
  ignore: readonly (keyof ConformanceObservation)[] = [],
): readonly ConformanceMismatch[] {
  const mismatches: ConformanceMismatch[] = []
  const check = (field: keyof ConformanceObservation): void => {
    if (ignore.includes(field)) return
    const a = left[field]
    const b = right[field]
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ field, left: a, right: b })
  }
  check('status')
  check('errorCode')
  check('domainStatus')
  check('columns')
  check('rows')
  check('evidenceCount')
  check('logicalEvidenceDigest')
  check('coverageReturned')
  check('coverageTruncated')
  check('snapshotConsistency')
  return mismatches
}

export interface ConformanceCase {
  readonly caseId: string
  /** `authorized` success, `forbidden` denial, `malformed` argument error or `empty` result. */
  readonly kind: 'authorized' | 'forbidden' | 'malformed' | 'empty'
  readonly buildCall: (callId: string) => ToolCall
}

export type ConformanceRun = ReadonlyMap<string, ConformanceObservation>

/** Run every canonical case against one target, keyed by case id. */
export async function runContractSuite(
  target: ToolContractTarget,
  cases: readonly ConformanceCase[],
  newCallId: () => string,
): Promise<ConformanceRun> {
  const run = new Map<string, ConformanceObservation>()
  for (const testCase of cases) {
    const result = await target.invoke(testCase.buildCall(newCallId()))
    run.set(testCase.caseId, observeToolResult(result))
  }
  return run
}

/** The mismatches across two full runs, tagged with the case id that produced them. */
export function compareRuns(
  left: ConformanceRun,
  right: ConformanceRun,
): readonly { readonly caseId: string; readonly mismatches: readonly ConformanceMismatch[] }[] {
  const differences: { caseId: string; mismatches: readonly ConformanceMismatch[] }[] = []
  for (const [caseId, leftObservation] of left) {
    const rightObservation = right.get(caseId)
    if (rightObservation === undefined) {
      differences.push({ caseId, mismatches: [{ field: 'presence', left: 'present', right: 'missing' }] })
      continue
    }
    const mismatches = compareObservations(leftObservation, rightObservation)
    if (mismatches.length > 0) differences.push({ caseId, mismatches })
  }
  return differences
}
