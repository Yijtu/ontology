import { isToolContext } from '@ontology/contracts'
import type {
  ScopeRef,
  Sha256Digest,
  StructuredCell,
  StructuredDocumentParserPort,
  StructuredFormat,
  StructuredIngestionPort,
  StructuredIngestionRequest,
  StructuredIngestionResult,
  StructuredIngestionStore,
  StructuredParseResult,
  StructuredRecordCounts,
  StructuredRecordEntry,
  StructuredRecordState,
  StructuredRow,
  ToolContext,
} from '@ontology/contracts'
import type { DocumentArtifactStore } from '../types'
import { deterministicUuid, sha256DigestOfText } from '../hashing'
import { STRUCTURED_PARSER_ID, STRUCTURED_PARSER_VERSION, StructuredDocumentParser } from './index'
import { StructuredIngestionError } from './ingest-errors'

export interface LocalStructuredIngestionDependencies {
  readonly blobs: DocumentArtifactStore
  readonly store: StructuredIngestionStore
  /** The pure parser; defaults to the committed `StructuredDocumentParser`. */
  readonly parser?: StructuredDocumentParserPort
  readonly now?: () => string
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/

function resolveScope(scopeRef: ScopeRef, ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new StructuredIngestionError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new StructuredIngestionError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
    throw new StructuredIngestionError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
  return { tenantId, spaceId }
}

function validateRequest(request: StructuredIngestionRequest): void {
  if (request.originalRef.id.length === 0) {
    throw new StructuredIngestionError('INVALID_REQUEST', 'originalRef.id must be a non-empty id')
  }
  if (!SHA256_DIGEST.test(request.originalRef.digest)) {
    throw new StructuredIngestionError(
      'INVALID_REQUEST',
      'originalRef.digest must be a sha256 digest of the form sha256:<64 lowercase hex>',
    )
  }
}

/** A row is `failed` on a source error cell and `pending` when a formula has no cached value. */
function stateOfCells(cells: readonly StructuredCell[]): StructuredRecordState {
  if (cells.some((cell) => cell.kind === 'error')) return 'failed'
  if (cells.some((cell) => cell.kind === 'formula' && cell.cachedRaw === undefined)) return 'pending'
  return 'parsed'
}

function errorCellOf(cells: readonly StructuredCell[]): StructuredCell | undefined {
  return cells.find((cell) => cell.kind === 'error')
}

function recordIdOf(scope: ScopeRef, originalDigest: Sha256Digest, sourceRowKey: string): string {
  return deterministicUuid([scope.tenantId, scope.spaceId, originalDigest, sourceRowKey].join('|'))
}

function entryFromRow(
  scope: ScopeRef,
  format: StructuredFormat,
  originalDigest: Sha256Digest,
  sheetKey: string,
  row: StructuredRow,
): StructuredRecordEntry {
  const state = stateOfCells(row.cells)
  const errorCell = errorCellOf(row.cells)
  const sourceRowKey = `${format}:${sheetKey}:row:${row.row}`
  // The values are hashed for change detection but never copied into the control database.
  const rowDigest = sha256DigestOfText(
    JSON.stringify({ sourceRowKey, cells: row.cells.map((cell) => [cell.raw, cell.kind]) }),
  )
  return {
    recordId: recordIdOf(scope, originalDigest, sourceRowKey),
    sourceRowKey,
    recordIndex: row.recordIndex,
    row: row.row,
    state,
    locator: row.locator,
    rowDigest,
    columnCount: row.cells.length,
    ...(state === 'failed' && errorCell !== undefined
      ? {
          error: {
            code: 'CELL_ERROR',
            message: 'the source cell is an error value',
            locator: errorCell.locator,
          },
        }
      : {}),
  }
}

/** Reconcile the pure parser result into durable, located row entries and counters. */
export function reconcileStructuredResult(
  result: StructuredParseResult,
  scope: ScopeRef,
  originalDigest: Sha256Digest,
): { readonly entries: readonly StructuredRecordEntry[]; readonly counts: StructuredRecordCounts } {
  const entries: StructuredRecordEntry[] = []
  for (const table of result.tables) {
    const sheetKey = table.sheetId ?? table.sheetName ?? 'sheet'
    for (const row of table.rows) {
      entries.push(entryFromRow(scope, table.format, originalDigest, sheetKey, row))
    }
  }
  for (const record of result.records) {
    const state = stateOfCells(record.cells)
    const errorCell = errorCellOf(record.cells)
    const sourceRowKey = `${result.format}:${record.recordRef}`
    entries.push({
      recordId: recordIdOf(scope, originalDigest, sourceRowKey),
      sourceRowKey,
      recordIndex: record.recordIndex,
      row: record.recordIndex,
      state,
      locator: record.locator,
      rowDigest: sha256DigestOfText(
        JSON.stringify({ sourceRowKey, cells: record.cells.map((cell) => [cell.raw, cell.kind]) }),
      ),
      columnCount: record.cells.length,
      ...(state === 'failed' && errorCell !== undefined
        ? {
            error: {
              code: 'CELL_ERROR',
              message: 'the source cell is an error value',
              locator: errorCell.locator,
            },
          }
        : {}),
    })
  }

  let succeeded = 0
  let pendingRows = 0
  let failed = 0
  for (const entry of entries) {
    if (entry.state === 'parsed') succeeded += 1
    else if (entry.state === 'pending') pendingRows += 1
    else if (entry.state === 'failed') failed += 1
  }
  const counts: StructuredRecordCounts = {
    // Truncated (skipped) units have no materialized row; they stay pending and are never
    // counted as success (SPEC D4.1/§9).
    total: result.coverage.totalUnits,
    succeeded,
    pending: pendingRows + result.coverage.skippedUnits,
    failed,
    skipped: 0,
  }
  // Every unit is accounted for exactly once: parsed units are materialized and truncated units
  // stay pending. An inconsistency here would misreport coverage, so it is refused rather than
  // stored (SPEC D4.1/§9).
  if (counts.total !== counts.succeeded + counts.pending + counts.failed + counts.skipped) {
    throw new StructuredIngestionError(
      'PARSE_STORE_FAILED',
      'the structured parse coverage does not reconcile with the located rows',
    )
  }
  return { entries, counts }
}

/**
 * Structured ingestion (SPEC v0.3 A §5). Reads an immutable original through the blob port,
 * runs the pure structured parser and persists the parse run plus the reconciled rows. It is
 * idempotent on `(scope, original digest, parser version)`: a duplicate upload or a
 * crash-reclaimed attempt converges on one logical parse with stable record identities.
 *
 * A rejected parse (unsupported structure, hard cap, encoding/archive error) raises with the
 * parser diagnostics, so the worker records an honest failure and never a partial "success".
 */
export class LocalStructuredIngestionService implements StructuredIngestionPort {
  readonly #blobs: DocumentArtifactStore
  readonly #store: StructuredIngestionStore
  readonly #parser: StructuredDocumentParserPort
  readonly #now: () => string

  constructor(dependencies: LocalStructuredIngestionDependencies) {
    this.#blobs = dependencies.blobs
    this.#store = dependencies.store
    this.#parser = dependencies.parser ?? new StructuredDocumentParser()
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async parse(request: StructuredIngestionRequest, ctx: ToolContext): Promise<StructuredIngestionResult> {
    const scope = resolveScope(request.scopeRef, ctx)
    validateRequest(request)
    const parserVersion = request.parserVersion ?? STRUCTURED_PARSER_VERSION

    const existing = await this.#store.findParseByDigest(scope, request.originalRef.digest, parserVersion, ctx)
    if (existing !== undefined) {
      return { parse: existing, reused: true }
    }

    const authorized = await this.#blobs.getAuthorized({ scopeRef: scope, blobRef: request.originalRef }, ctx)
    const bytes = await this.#blobs.readAuthorized({ scopeRef: scope, blobRef: request.originalRef }, ctx)

    const result = this.#parser.parse(bytes, { ...request.options, mediaType: authorized.mediaType })
    if (result.status === 'rejected') {
      const first = result.diagnostics[0]
      throw new StructuredIngestionError(
        'PARSE_REJECTED',
        first === undefined ? 'the structured parse was rejected' : first.message,
        { issues: result.diagnostics },
      )
    }

    const { entries, counts } = reconcileStructuredResult(result, scope, authorized.contentDigest)
    const parseId = deterministicUuid(
      [scope.tenantId, scope.spaceId, authorized.contentDigest, parserVersion].join('|'),
    )
    const record = {
      parseId,
      scopeRef: scope,
      format: result.format,
      originalMediaType: authorized.mediaType,
      originalRef: authorized.blobRef,
      parserId: STRUCTURED_PARSER_ID,
      parserVersion,
      status: result.status,
      coverage: result.coverage,
      counts,
      sheets: result.sheets,
      diagnostics: result.diagnostics,
      ...(request.sourceRef === undefined ? {} : { sourceRef: request.sourceRef }),
      ...(request.documentVersionRef === undefined
        ? {}
        : { documentVersionRef: request.documentVersionRef }),
      createdAt: this.#now(),
    }

    const recorded = await this.#store.recordParse(record, entries, ctx)
    if (!recorded.created) {
      // A concurrent identical parse won the insert; reuse the winner so the caller never sees
      // two logical parses of the same bytes.
      const winner = await this.#store.findParseByDigest(scope, authorized.contentDigest, parserVersion, ctx)
      if (winner === undefined) {
        throw new StructuredIngestionError(
          'PARSE_STORE_FAILED',
          'a concurrent parse was recorded but cannot be read back',
        )
      }
      return { parse: winner, reused: true }
    }
    return { parse: record, reused: false }
  }
}
