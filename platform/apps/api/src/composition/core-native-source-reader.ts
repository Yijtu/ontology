import { isStructuredParseSelection, sha256OfCanonical } from '@ontology/contracts'
import type { ResourceRef, ScopeRef, StructuredIngestionStore, StructuredParseOptions, StructuredRecordEntry, ToolContext } from '@ontology/contracts'
import { STRUCTURED_PARSER_ID, STRUCTURED_PARSER_VERSION, StructuredDocumentParser, reconcileStructuredResult } from '@ontology/adapter-extraction-document'

const equal = (left: unknown, right: unknown) => sha256OfCanonical(left) === sha256OfCanonical(right)
function requireNative(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

/** A cache is constructed for exactly one request, never shared across readers/scopes. */
export function createRequestNativeSourceReader(input: {
  readonly scope: ScopeRef
  readonly ctx: ToolContext
  readonly signal: AbortSignal
  readonly ingestion: Pick<StructuredIngestionStore, 'findParseByDigest' | 'listRecords'>
  readonly readBytes: (ref: ResourceRef, cap: number) => Promise<Uint8Array>
  readonly check: () => void
}) {
  const check = () => { input.signal.throwIfAborted(); input.check() }
  const source = async (originalRef: ResourceRef, parserVersion: string, parseId: string, selection: Omit<StructuredParseOptions, 'mediaType'>) => {
    check()
    requireNative(isStructuredParseSelection(selection), 'the actual native selection is required')
    const native = await input.ingestion.findParseByDigest(input.scope, originalRef.digest, parserVersion, input.ctx)
    requireNative(native !== undefined && native.parseId === parseId && equal(native.originalRef, originalRef) && native.parserId === STRUCTURED_PARSER_ID && native.parserVersion === STRUCTURED_PARSER_VERSION, 'the actual native parser identity differs from its original')
    requireNative(native.parseOptions === undefined || equal(native.parseOptions, selection), 'the native selection differs from the captured parser selection')
    const parsed = new StructuredDocumentParser().parse(await input.readBytes(originalRef, 8 * 1_048_576), { ...selection, mediaType: native.originalMediaType })
    check()
    requireNative(parsed.status !== 'rejected' && parsed.format === native.format && equal(parsed.coverage, native.coverage), 'the original bytes cannot reproduce their actual captured native parse')
    const expected = new Map(reconcileStructuredResult(parsed, input.scope, originalRef.digest).entries.map((entry) => [entry.recordId, entry]))
    const actual = new Map<string, StructuredRecordEntry>()
    let cursor: string | undefined
    const cursors = new Set<string>()
    do {
      check()
      const page = await input.ingestion.listRecords(input.scope, parseId, { limit: 200, ...(cursor === undefined ? {} : { cursor }) }, input.ctx)
      requireNative(actual.size + page.records.length <= 10_000 && page.total === native.coverage.parsedUnits, 'the actual native inventory exceeds its finite bound or coverage')
      for (const entry of page.records) {
        requireNative(!actual.has(entry.recordId) && equal(expected.get(entry.recordId), entry), 'the stored native row differs from the original immutable selection')
        actual.set(entry.recordId, entry)
      }
      cursor = page.nextCursor
      requireNative(cursor === undefined || !cursors.has(cursor), 'the original row cursor did not advance')
      if (cursor !== undefined) cursors.add(cursor)
    } while (cursor !== undefined)
    requireNative(actual.size === expected.size, 'the original selection has incomplete stored native rows')
    check()
    return { native, parsed, entries: actual }
  }
  const cache = new Map<string, ReturnType<typeof source>>()
  const read = async (originalRef: ResourceRef, parserVersion: string, parseId: string, recordId: string, rowDigest: string, selection: Omit<StructuredParseOptions, 'mediaType'>, immutablePin: unknown) => {
    check()
    const key = sha256OfCanonical({ scope: input.scope, originalRef, parserVersion, parseId, selection, immutablePin })
    let pending = cache.get(key)
    if (pending === undefined) { pending = source(originalRef, parserVersion, parseId, selection); cache.set(key, pending) }
    const captured = await pending
    check()
    const entry = captured.entries.get(recordId)
    requireNative(entry !== undefined && entry.state === 'parsed' && entry.rowDigest === rowDigest, 'the actual original row fingerprint differs from its saved source')
    const selected = captured.parsed.tables.flatMap((table) => table.rows.map((row) => ({ table, row }))).find(({ row }) => equal(row.locator, entry.locator))
    const json = captured.parsed.records.find((row) => equal(row.locator, entry.locator))
    const cells = selected?.row.cells ?? json?.cells
    requireNative(cells !== undefined && cells.length > 0 && cells.length <= 128, 'the original row has no bounded real cells')
    return { native: captured.native, entry, cells, columns: selected?.table.columns ?? [] }
  }
  return { read }
}
export type RequestNativeSourceReader = ReturnType<typeof createRequestNativeSourceReader>
