import { sha256OfCanonical } from '@ontology/contracts'
import type { ResourceRef, ScopeRef, StructuredCandidateSourceSpan, StructuredParseRecord } from '@ontology/contracts'
import { StructuredDocumentParser } from './index'
import { reconcileStructuredResult } from './ingest-service'

/** The exact row fingerprint input: the durable row key plus the original raw tokens and cell kinds. */
export interface ReconciledRow {
  readonly sourceRowKey: string
  readonly rowText: string
}

/**
 * Re-parse one approved structured original, reconcile it to the same record ids, and locate the
 * exact row/cell the span names. Shared by the fact-premise reader and the rule-clause reader so a
 * table row is verified identically wherever it grounds an artifact: the row digest, the durable
 * row key, and the row/cell locator must all round-trip to the original bytes.
 */
export function readReconciledRow(
  parse: StructuredParseRecord,
  originalRef: ResourceRef,
  options: NonNullable<StructuredParseRecord['parseOptions']>,
  bytes: Uint8Array,
  scope: ScopeRef,
  span: StructuredCandidateSourceSpan,
): ReconciledRow | undefined {
  const result = new StructuredDocumentParser().parse(bytes, { ...options, mediaType: parse.originalMediaType })
  if (result.status !== 'complete') return undefined
  const entry = reconcileStructuredResult(result, scope, originalRef.digest).entries.find((row) => row.recordId === span.recordId)
  if (entry === undefined || entry.state !== 'parsed' || entry.rowDigest !== span.rowDigest || entry.sourceRowKey !== span.sourceRowKey) return undefined
  const row = result.tables.flatMap((table) => table.rows).find((row) => row.recordIndex === entry.recordIndex && row.row === entry.row)
  if (row === undefined || ![row.locator, ...row.cells.map((cell) => cell.locator)].some((locator) => sha256OfCanonical(locator) === sha256OfCanonical(span.locator))) return undefined
  return { sourceRowKey: entry.sourceRowKey, rowText: JSON.stringify({ sourceRowKey: entry.sourceRowKey, cells: row.cells.map((cell) => [cell.raw, cell.kind]) }) }
}
