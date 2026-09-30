import { createHash } from 'node:crypto'
import type { OpaqueCursor, Sha256Digest } from './generated/contracts'
import { TableArtifactReadError, isTableReadCursor } from './typed-results'
import type { TableArtifactManifest, TableArtifactPageBody, TableReadCursor } from './typed-results'

/**
 * Runtime SHA-256 digests and opaque cursor encoding for the typed-result contracts (SPEC v0.3a
 * execution-evidence §EX-7.1, §EX-9; issue V03-032 / #203).
 *
 * These helpers are the *only* place in `@ontology/contracts` that touches `node:crypto` (and
 * Node's `Buffer`). They are split out of `typed-results.ts` so the browser bundle can import
 * the barrel without pulling `node:crypto`: the browser-facing entry point (`index.browser.ts`)
 * re-exports the data types, ports and runtime guards, and only the Node entry point
 * (`index.ts`) additionally re-exports this module. The web app renders verified results from
 * the server's projection and never computes a canonical digest itself.
 */

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

export function sha256OfCanonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`
}

/**
 * The content digest of a table page artifact. It canonicalizes key order, so a page that
 * round-tripped through JSONB storage still recomputes to the same digest. Writers MUST set
 * `TablePageDescriptor.artifactDigest` and the page `ResourceRef.digest` to this value.
 */
export function tableArtifactContentDigest(body: TableArtifactPageBody): Sha256Digest {
  return sha256OfCanonical({
    schemaVersion: body.schemaVersion,
    tableId: body.tableId,
    outputSchemaRef: body.outputSchemaRef,
    pageIndex: body.pageIndex,
    columnRefs: body.columnRefs,
    rowKeyOrder: body.rowKeyOrder,
    rows: body.rows,
    coverage: body.coverage,
  })
}

/**
 * The coverage digest of one page. It binds the ordered row keys and the page coverage, so a
 * reader can prove the page it read is the page the table-verification receipt checked.
 */
export function tablePageCoverageDigest(body: TableArtifactPageBody): Sha256Digest {
  return sha256OfCanonical({
    tableId: body.tableId,
    pageIndex: body.pageIndex,
    rowKeys: body.rows.map((row) => row.rowKey),
    coverage: body.coverage,
  })
}

/**
 * The content digest of a table manifest. A verified manifest ref must carry this digest, so
 * a manifest whose descriptor/pages/bindings were tampered with no longer matches its ref and
 * the hard verifier refuses it before reading a single page.
 */
export function tableManifestContentDigest(manifest: TableArtifactManifest): Sha256Digest {
  return sha256OfCanonical({
    schemaVersion: manifest.schemaVersion,
    tableId: manifest.tableId,
    outputSchemaRef: manifest.outputSchemaRef,
    columns: manifest.columns,
    totalRows: manifest.totalRows,
    rowKeyOrder: manifest.rowKeyOrder,
    pages: manifest.pages,
    coverage: manifest.coverage,
    complete: manifest.complete,
  })
}

/** The digest of one cursor's binding; the progress ledger records which digests were served. */
export function tableReadCursorDigest(cursor: TableReadCursor): Sha256Digest {
  return sha256OfCanonical(cursor)
}

export function encodeTableReadCursor(cursor: TableReadCursor): OpaqueCursor {
  if (!isTableReadCursor(cursor)) {
    throw new TableArtifactReadError('CURSOR_INVALID', 'cannot encode a malformed table read cursor')
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeTableReadCursor(value: OpaqueCursor): TableReadCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch (error) {
    throw new TableArtifactReadError('CURSOR_INVALID', 'the cursor is not a valid opaque cursor', {
      cause: error,
    })
  }
  if (!isTableReadCursor(parsed)) {
    throw new TableArtifactReadError('CURSOR_INVALID', 'the cursor does not match table-read-cursor@1')
  }
  return parsed
}
