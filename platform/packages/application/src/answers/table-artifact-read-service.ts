import {
  TableArtifactReadError,
  assertTableArtifactManifestShape,
  assertTableArtifactPageBodyShape,
  decodeTableReadCursor,
  encodeTableReadCursor,
  isTablePageReadRequest,
  isToolContext,
  sha256OfCanonical,
  tableArtifactContentDigest,
  tablePageCoverageDigest,
  tableReadCursorDigest,
} from '@ontology/contracts'
import type {
  ArchivedTableArtifactManifest,
  ScopeRef,
  TableArtifactManifest,
  TableArtifactPage,
  TableArtifactPageStore,
  TablePageDescriptor,
  TablePageReadRequest,
  TablePageReadView,
  TableReadCursor,
  TableReadProgress,
  TableReadProgressStore,
  ToolContext,
  VerifiedTableManifestSource,
} from '@ontology/contracts'

export interface TableArtifactReadServiceDependencies {
  readonly manifests: VerifiedTableManifestSource
  readonly pages: TableArtifactPageStore
  readonly progress: TableReadProgressStore
}

interface RequestedPosition {
  readonly pageIndex: number
  readonly lastRowKey?: string
  /** The exact cursor consumed by this request, if any. */
  readonly cursor?: TableReadCursor
}

function scopeRefOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new TableArtifactReadError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new TableArtifactReadError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function scopeDigestOf(scopeRef: ScopeRef): string {
  return sha256OfCanonical({ tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId })
}

function pageDescriptorAt(manifest: TableArtifactManifest, pageIndex: number): TablePageDescriptor {
  const descriptor = manifest.pages.find((page) => page.pageIndex === pageIndex)
  if (descriptor === undefined) {
    throw new TableArtifactReadError('PAGE_NOT_FOUND', `table ${manifest.tableId} has no page ${pageIndex}`)
  }
  return descriptor
}

/**
 * The paginated, fixed-revision reader for formal tables (SPEC v0.3a execution-evidence
 * §EX-7.1, §EX-9). It reads one page of one archived table manifest and never the "latest"
 * dataset: the manifest ref/digest is fixed by the answer, and the cursor is bound to that
 * exact digest and the tenant/space scope.
 *
 * The checks are the whole point of the node:
 *
 *  - A cursor minted for another scope is refused as `SCOPE_MISMATCH`; a cursor for a
 *    different result revision (a rebuild activated a new generation) is refused as
 *    `TABLE_REVISION_CHANGED` instead of silently concatenating two revisions.
 *  - The persisted page-tab progress must advance by exactly one page. A duplicate cursor
 *    (`CURSOR_REPLAY`), a backward cursor (`CURSOR_BACKWARD`) or a skipped page
 *    (`CURSOR_GAP`) is refused, so a client can never build a "concatenated" view out of
 *    overlapping or out-of-order reads.
 *  - The decoded page is re-verified against its descriptor: artifact digest, column
 *    identity, strictly ascending stable row keys, no duplicate/missing row, exact counts
 *    and page-coverage digest. An unverified or corrupt page is never rendered.
 */
export class TableArtifactReadService {
  readonly #manifests: VerifiedTableManifestSource
  readonly #pages: TableArtifactPageStore
  readonly #progress: TableReadProgressStore

  constructor(dependencies: TableArtifactReadServiceDependencies) {
    this.#manifests = dependencies.manifests
    this.#pages = dependencies.pages
    this.#progress = dependencies.progress
  }

  async readPage(request: TablePageReadRequest, ctx: ToolContext): Promise<TablePageReadView> {
    if (!isTablePageReadRequest(request)) {
      throw new TableArtifactReadError('INVALID_ARGUMENT', 'the table page read request is malformed')
    }
    const scopeRef = scopeRefOf(ctx)
    const scopeDigest = scopeDigestOf(scopeRef)

    const archived = await this.#manifests.resolve(scopeRef, request.answerId, request.tableId, ctx)
    if (archived === undefined) {
      throw new TableArtifactReadError(
        'TABLE_NOT_FOUND',
        `no published table ${request.tableId} for answer ${request.answerId} in this scope`,
      )
    }
    assertTableArtifactManifestShape(archived.manifest)
    if (archived.verificationReceiptRef === undefined) {
      throw new TableArtifactReadError(
        'TABLE_UNVERIFIED',
        `table ${request.tableId} has no table-verification receipt and cannot be rendered as a formal table`,
      )
    }
    const manifest = archived.manifest
    const pageCount = manifest.pages.length

    const requested = this.#resolveRequestedPosition(request, archived, scopeDigest)
    const pageIndex = requested.pageIndex

    if (pageIndex >= pageCount) {
      throw new TableArtifactReadError('PAGE_NOT_FOUND', `table ${manifest.tableId} has no page ${pageIndex}`)
    }
    this.#checkBoundary(manifest, requested)
    const consumption = await this.#checkProgress(scopeRef, request, requested, ctx)

    const descriptor = pageDescriptorAt(manifest, pageIndex)
    const page = await this.#pages.getPage(scopeRef, descriptor.artifactRef, ctx)
    if (page === undefined) {
      throw new TableArtifactReadError('PAGE_NOT_FOUND', `page ${pageIndex} artifact is missing in this scope`)
    }
    this.#verifyPage(manifest, descriptor, page)
    // Only after the page is proven do we advance the page tab, so a corrupt page cannot
    // burn the client's cursor and lock it out of a retry.
    await this.#commitProgress(scopeRef, request, requested.pageIndex, consumption, ctx)

    const nextCursor = this.#nextCursor(request, archived, scopeDigest, descriptor, pageIndex, pageCount)

    return {
      answerId: request.answerId,
      tableId: request.tableId,
      resultManifestRef: archived.ref,
      resultManifestDigest: archived.ref.digest,
      tableVerificationReceiptRef: archived.verificationReceiptRef,
      pageIndex,
      pageCount,
      totalRows: manifest.totalRows,
      columns: manifest.columns,
      rows: page.body.rows,
      coverage: page.body.coverage,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      complete: manifest.complete,
    }
  }

  #resolveRequestedPosition(
    request: TablePageReadRequest,
    archived: ArchivedTableArtifactManifest,
    scopeDigest: string,
  ): RequestedPosition {
    if (request.cursor === undefined) {
      return { pageIndex: 0 }
    }
    const cursor = decodeTableReadCursor(request.cursor)
    if (cursor.scopeDigest !== scopeDigest) {
      throw new TableArtifactReadError('SCOPE_MISMATCH', 'the cursor was minted in another tenant/space scope')
    }
    if (
      cursor.answerId !== request.answerId ||
      cursor.tableId !== request.tableId ||
      cursor.resultManifestRef.id !== archived.ref.id ||
      cursor.resultManifestDigest !== archived.ref.digest
    ) {
      throw new TableArtifactReadError(
        'TABLE_REVISION_CHANGED',
        'the cursor points at a different result revision than the currently verified table',
      )
    }
    return cursor.lastRowKey === undefined
      ? { pageIndex: cursor.pageIndex, cursor }
      : { pageIndex: cursor.pageIndex, lastRowKey: cursor.lastRowKey, cursor }
  }

  #checkBoundary(manifest: TableArtifactManifest, requested: RequestedPosition): void {
    if (requested.pageIndex === 0) {
      if (requested.lastRowKey !== undefined) {
        throw new TableArtifactReadError('CURSOR_INVALID', 'the first page cursor must not carry a boundary row key')
      }
      return
    }
    if (requested.lastRowKey === undefined) {
      throw new TableArtifactReadError('CURSOR_INVALID', 'a cursor beyond the first page must carry its boundary row key')
    }
    const previous = manifest.pages.find((page) => page.pageIndex === requested.pageIndex - 1)
    if (previous === undefined || previous.lastRowKey !== requested.lastRowKey) {
      throw new TableArtifactReadError(
        'CURSOR_BACKWARD',
        'the cursor boundary row key does not continue the fixed page sequence',
      )
    }
  }

  async #checkProgress(
    scopeRef: ScopeRef,
    request: TablePageReadRequest,
    requested: RequestedPosition,
    ctx: ToolContext,
  ): Promise<{ readonly digest: string; readonly existing?: TableReadProgress }> {
    const progress = await this.#progress.get(scopeRef, request.answerId, request.tableId, ctx)
    const expectedNext = progress === undefined ? 0 : progress.highestServedPageIndex + 1
    if (requested.pageIndex > expectedNext) {
      throw new TableArtifactReadError('CURSOR_GAP', 'a page cannot be read before its predecessor was served')
    }
    if (progress !== undefined) {
      if (requested.pageIndex < progress.highestServedPageIndex) {
        throw new TableArtifactReadError('CURSOR_BACKWARD', 'the cursor points behind the served page tab')
      }
      if (requested.pageIndex === progress.highestServedPageIndex) {
        throw new TableArtifactReadError('CURSOR_REPLAY', 'the cursor page was already served')
      }
    }
    const digest =
      requested.cursor === undefined
        ? sha256OfCanonical({ initial: true, answerId: request.answerId, tableId: request.tableId, pageIndex: 0 })
        : tableReadCursorDigest(requested.cursor)
    if (progress !== undefined && progress.consumedCursorDigests.includes(digest)) {
      throw new TableArtifactReadError('CURSOR_REPLAY', 'the cursor was already consumed')
    }
    return progress === undefined ? { digest } : { digest, existing: progress }
  }

  async #commitProgress(
    scopeRef: ScopeRef,
    request: TablePageReadRequest,
    pageIndex: number,
    consumption: { readonly digest: string; readonly existing?: TableReadProgress },
    ctx: ToolContext,
  ): Promise<void> {
    const nextProgress: TableReadProgress = {
      highestServedPageIndex: pageIndex,
      consumedCursorDigests:
        consumption.existing === undefined
          ? [consumption.digest]
          : [...consumption.existing.consumedCursorDigests, consumption.digest],
    }
    await this.#progress.save(scopeRef, request.answerId, request.tableId, nextProgress, ctx)
  }

  #verifyPage(manifest: TableArtifactManifest, descriptor: TablePageDescriptor, page: TableArtifactPage): void {
    assertTableArtifactPageBodyShape(page.body)
    const body = page.body
    if (page.ref.id !== descriptor.artifactRef.id || page.ref.digest !== descriptor.artifactDigest) {
      throw new TableArtifactReadError('PAGE_DIGEST_MISMATCH', 'the archived page ref does not match its descriptor')
    }
    if (tableArtifactContentDigest(body) !== descriptor.artifactDigest) {
      throw new TableArtifactReadError('PAGE_DIGEST_MISMATCH', 'the page content digest does not match the descriptor')
    }
    if (tablePageCoverageDigest(body) !== descriptor.pageCoverageDigest) {
      throw new TableArtifactReadError('PAGE_DIGEST_MISMATCH', 'the page coverage digest does not match the descriptor')
    }
    if (body.tableId !== manifest.tableId || body.pageIndex !== descriptor.pageIndex) {
      throw new TableArtifactReadError('PAGE_DIGEST_MISMATCH', 'the page belongs to a different table/page index')
    }
    if (
      body.outputSchemaRef.id !== manifest.outputSchemaRef.id ||
      body.outputSchemaRef.version !== manifest.outputSchemaRef.version
    ) {
      throw new TableArtifactReadError('PAGE_DIGEST_MISMATCH', 'the page output schema does not match the manifest')
    }
    const manifestColumns = manifest.columns.map((column) => column.columnRef)
    if (
      body.columnRefs.length !== manifestColumns.length ||
      body.columnRefs.some((columnRef, index) => columnRef !== manifestColumns[index])
    ) {
      throw new TableArtifactReadError('PAGE_ROW_ORDER_VIOLATION', 'the page column identity does not match the manifest')
    }
    if (body.rows.length !== descriptor.rowCount) {
      throw new TableArtifactReadError('PAGE_ROW_ORDER_VIOLATION', 'the page row count does not match the descriptor')
    }

    const seen = new Set<string>()
    let previousKey: string | undefined
    for (const row of body.rows) {
      if (seen.has(row.rowKey)) {
        throw new TableArtifactReadError(
          'PAGE_ROW_ORDER_VIOLATION',
          `duplicate row key ${row.rowKey} on page ${descriptor.pageIndex}`,
        )
      }
      seen.add(row.rowKey)
      if (previousKey !== undefined && row.rowKey <= previousKey) {
        throw new TableArtifactReadError(
          'PAGE_ROW_ORDER_VIOLATION',
          `row keys must be strictly ascending; ${row.rowKey} follows ${previousKey}`,
        )
      }
      previousKey = row.rowKey

      for (const columnRef of manifestColumns) {
        if (!(columnRef in row.cells)) {
          throw new TableArtifactReadError(
            'PAGE_ROW_ORDER_VIOLATION',
            `row ${row.rowKey} is missing column ${columnRef}`,
          )
        }
      }
      if (row.bindings.some((binding) => binding.rowKey !== row.rowKey)) {
        throw new TableArtifactReadError('PAGE_ROW_ORDER_VIOLATION', `a cell binding of row ${row.rowKey} points at another row`)
      }
      if (row.bindings.some((binding) => !manifestColumns.includes(binding.columnRef))) {
        throw new TableArtifactReadError('PAGE_ROW_ORDER_VIOLATION', `row ${row.rowKey} binds an unknown column`)
      }
      const boundColumns = new Set(row.bindings.map((binding) => binding.columnRef))
      if (boundColumns.size !== manifestColumns.length) {
        throw new TableArtifactReadError(
          'PAGE_ROW_ORDER_VIOLATION',
          `row ${row.rowKey} does not bind every column exactly once`,
        )
      }
    }
    if (
      body.rows[0]?.rowKey !== descriptor.firstRowKey ||
      body.rows[body.rows.length - 1]?.rowKey !== descriptor.lastRowKey
    ) {
      throw new TableArtifactReadError('PAGE_ROW_ORDER_VIOLATION', 'the page boundary row keys do not match the descriptor')
    }
    if (descriptor.pageIndex > 0) {
      const previous = manifest.pages.find((page) => page.pageIndex === descriptor.pageIndex - 1)
      if (previous !== undefined && descriptor.firstRowKey <= previous.lastRowKey) {
        throw new TableArtifactReadError('PAGE_ROW_ORDER_VIOLATION', 'page boundaries overlap or are out of order')
      }
    }
  }

  #nextCursor(
    request: TablePageReadRequest,
    archived: ArchivedTableArtifactManifest,
    scopeDigest: string,
    descriptor: TablePageDescriptor,
    pageIndex: number,
    pageCount: number,
  ): string | undefined {
    if (pageIndex + 1 >= pageCount) return undefined
    const cursor: TableReadCursor = {
      version: 1,
      answerId: request.answerId,
      tableId: request.tableId,
      resultManifestRef: archived.ref,
      resultManifestDigest: archived.ref.digest,
      scopeDigest,
      pageIndex: pageIndex + 1,
      lastRowKey: descriptor.lastRowKey,
    }
    return encodeTableReadCursor(cursor)
  }
}
