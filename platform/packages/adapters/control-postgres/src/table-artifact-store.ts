import type { QueryResultRow } from 'pg'
import {
  assertTableArtifactManifestShape,
  assertTableArtifactPageBodyShape,
  isToolContext,
  tableArtifactContentDigest,
  tablePageCoverageDigest,
  tableManifestContentDigest,
} from '@ontology/contracts'
import type {
  ArchivedTableArtifactManifest,
  ImmutableArtifactWriter,
  NonEmptyString,
  ResourceRef,
  ScopeRef,
  ScopedArtifactReader,
  TableArtifactManifest,
  TableArtifactManifestStore,
  TableArtifactPage,
  TableArtifactPageBody,
  TableArtifactPageStore,
  TableReadProgress,
  TableReadProgressStore,
  ToolContext,
  Uuid,
  VerifiedTableManifestSource,
} from '@ontology/contracts'
import { ControlStorageError } from './errors'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

async function withScope<T>(
  database: ControlPostgresDatabase,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  run: (query: ScopedQuery) => Promise<T>,
): Promise<T> {
  if (!isToolContext(ctx)) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
    throw new ControlStorageError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
  }
  return database.withIdentityScope(
    { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
    async (client) => {
      await client.query("SELECT set_config('app.trace_id', $1, true)", [ctx.traceId])
      return run({
        query: async <Row extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
          const result = await client.query<Row>(text, values === undefined ? undefined : [...values])
          return { rows: result.rows, rowCount: result.rowCount ?? 0 }
        },
      })
    },
  )
}

interface ManifestRow extends QueryResultRow {
  answer_id: string
  manifest_id: string
  version: string
  digest: string
  verification_receipt_id: string | null
  verification_receipt_version: string | null
  verification_receipt_digest: string | null
  manifest: TableArtifactManifest
}

function archivedFromRow(row: ManifestRow): ArchivedTableArtifactManifest {
  assertTableArtifactManifestShape(row.manifest)
  const receiptColumns = [row.verification_receipt_id, row.verification_receipt_version, row.verification_receipt_digest]
  const hasReceipt = receiptColumns.every((value) => value !== null)
  if (!hasReceipt && receiptColumns.some((value) => value !== null)) {
    throw new ControlStorageError('UNIQUE_VIOLATION', 'the table registration has an incomplete verification receipt reference')
  }
  return {
    answerId: row.answer_id,
    ref: { id: row.manifest_id, version: row.version, digest: row.digest, kind: 'artifact' },
    manifest: row.manifest,
    ...(hasReceipt
      ? {
          verificationReceiptRef: {
            id: row.verification_receipt_id!,
            version: row.verification_receipt_version!,
            digest: row.verification_receipt_digest!,
            kind: 'artifact' as const,
          },
        }
      : {}),
  }
}

interface PageRow extends QueryResultRow {
  content_ref: ResourceRef
}

interface ProgressRow extends QueryResultRow {
  highest_served_page_index: number
  consumed_cursor_digests: string[]
}

/**
 * Real PostgreSQL store for typed result table artifacts (SPEC v0.3a §EX-7.1, §EX-9).
 *
 * The control tables keep only refs/counts/digests; the page bytes (row values and cell
 * bindings) are written to the injected immutable artifact store and addressed by the
 * `content_ref` recorded next to the page metadata. A reader therefore reconstructs a page
 * from the immutable artifact store and re-verifies it against the manifest descriptor,
 * never from a mutable control copy.
 */
export class PostgresTableArtifactStore
  implements
    TableArtifactManifestStore,
    TableArtifactPageStore,
    TableReadProgressStore,
    VerifiedTableManifestSource
{
  readonly #database: ControlPostgresDatabase
  readonly #writer: ImmutableArtifactWriter
  readonly #reader: ScopedArtifactReader

  constructor(
    database: ControlPostgresDatabase,
    artifacts: { readonly writer: ImmutableArtifactWriter; readonly reader: ScopedArtifactReader },
  ) {
    this.#database = database
    this.#writer = artifacts.writer
    this.#reader = artifacts.reader
  }

  async putManifest(
    scopeRef: ScopeRef,
    answerId: Uuid,
    manifestRef: ResourceRef,
    manifest: TableArtifactManifest,
    verificationReceiptRef: ResourceRef | undefined,
    ctx: ToolContext,
  ): Promise<void> {
    assertTableArtifactManifestShape(manifest)
    if (manifestRef.kind !== 'artifact' || manifestRef.digest !== tableManifestContentDigest(manifest) || (verificationReceiptRef !== undefined && verificationReceiptRef.kind !== 'artifact')) throw new ControlStorageError('UNIQUE_VIOLATION', 'the table registration must retain its actual full manifest and earned receipt references')
    await withScope(this.#database, scopeRef, ctx, async (query) => {
      const inserted = await query.query(
        `INSERT INTO agent_platform.table_result_manifests
           (tenant_id, space_id, manifest_id, version, digest, answer_id, table_id, output_schema_ref,
            total_rows, page_count, complete, verification_receipt_id, verification_receipt_version,
            verification_receipt_digest, manifest, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, manifest_id, version, digest) DO NOTHING
         RETURNING manifest_id`,
        [
          manifestRef.id,
          manifestRef.version,
          manifestRef.digest,
          answerId,
          manifest.tableId,
          JSON.stringify(manifest.outputSchemaRef),
          manifest.totalRows,
          manifest.pages.length,
          manifest.complete,
          verificationReceiptRef?.id ?? null,
          verificationReceiptRef?.version ?? null,
          verificationReceiptRef?.digest ?? null,
          JSON.stringify(manifest),
          new Date().toISOString(),
        ],
      )
      if (inserted.rows.length > 0) return
      const existing = await query.query<ManifestRow & { same_content: boolean }>(
        `SELECT (manifest = $4::jsonb AND answer_id=$5::uuid AND verification_receipt_id IS NOT DISTINCT FROM $6::uuid AND verification_receipt_version IS NOT DISTINCT FROM $7 AND verification_receipt_digest IS NOT DISTINCT FROM $8) AS same_content
           FROM agent_platform.table_result_manifests
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND manifest_id = $1 AND version = $2 AND digest = $3`,
        [manifestRef.id, manifestRef.version, manifestRef.digest, JSON.stringify(manifest), answerId, verificationReceiptRef?.id ?? null, verificationReceiptRef?.version ?? null, verificationReceiptRef?.digest ?? null],
      )
      const row = existing.rows[0]
      if (row === undefined || row.same_content !== true) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `table result manifest ${manifestRef.id} already exists with different content`,
        )
      }
    })
  }

  async getManifest(
    scopeRef: ScopeRef,
    manifestRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTableArtifactManifest | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<ManifestRow>(
        `SELECT answer_id, manifest_id, version, digest, verification_receipt_id, verification_receipt_version,
                verification_receipt_digest, manifest
           FROM agent_platform.table_result_manifests
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND manifest_id = $1 AND version = $2 AND digest = $3`,
        [manifestRef.id, manifestRef.version, manifestRef.digest],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : archivedFromRow(row)
    })
  }

  async resolve(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    ctx: ToolContext,
  ): Promise<ArchivedTableArtifactManifest | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<ManifestRow>(
        `SELECT answer_id, manifest_id, version, digest, verification_receipt_id, verification_receipt_version,
                verification_receipt_digest, manifest
           FROM agent_platform.table_result_manifests
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND answer_id = $1 AND table_id = $2`,
        [answerId, tableId],
      )
      const row = result.rows[0]
      return row === undefined ? undefined : archivedFromRow(row)
    })
  }

  async putPage(
    scopeRef: ScopeRef,
    pageRef: ResourceRef,
    body: TableArtifactPageBody,
    ctx: ToolContext,
  ): Promise<void> {
    assertTableArtifactPageBodyShape(body)
    const contentDigest = tableArtifactContentDigest(body)
    if (pageRef.digest !== contentDigest) {
      throw new ControlStorageError(
        'UNIQUE_VIOLATION',
        `page ref digest ${pageRef.digest} does not match its content digest ${contentDigest}`,
      )
    }
    const content = new TextEncoder().encode(JSON.stringify(body))
    const stored = await this.#writer.putBytes(
      { scopeRef, content, mediaType: 'application/json' },
      ctx,
    )
    await withScope(this.#database, scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.table_artifact_pages
           (tenant_id, space_id, page_id, version, digest, table_id, page_index, row_count,
            first_row_key, last_row_key, coverage_digest, content_ref, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, page_id, version, digest) DO NOTHING`,
        [
          pageRef.id,
          pageRef.version,
          pageRef.digest,
          body.tableId,
          body.pageIndex,
          body.rows.length,
          body.rows[0]?.rowKey ?? '',
          body.rows[body.rows.length - 1]?.rowKey ?? '',
          tablePageCoverageDigest(body),
          JSON.stringify(stored.blobRef),
          new Date().toISOString(),
        ],
      )
    })
  }

  async getPage(
    scopeRef: ScopeRef,
    pageRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<TableArtifactPage | undefined> {
    const contentRef = await withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<PageRow>(
        `SELECT content_ref
           FROM agent_platform.table_artifact_pages
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND page_id = $1 AND version = $2 AND digest = $3`,
        [pageRef.id, pageRef.version, pageRef.digest],
      )
      return result.rows[0]?.content_ref
    })
    if (contentRef === undefined) return undefined
    const bytes = await this.#reader.read({ approvedInputRefs: [contentRef] }, ctx)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    assertTableArtifactPageBodyShape(parsed)
    return { ref: pageRef, body: parsed }
  }

  async get(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    ctx: ToolContext,
  ): Promise<TableReadProgress | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<ProgressRow>(
        `SELECT highest_served_page_index, consumed_cursor_digests
           FROM agent_platform.table_read_progress
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND answer_id = $1 AND table_id = $2`,
        [answerId, tableId],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      return {
        highestServedPageIndex: row.highest_served_page_index,
        consumedCursorDigests: row.consumed_cursor_digests,
      }
    })
  }

  async save(
    scopeRef: ScopeRef,
    answerId: Uuid,
    tableId: NonEmptyString,
    progress: TableReadProgress,
    ctx: ToolContext,
  ): Promise<void> {
    await withScope(this.#database, scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.table_read_progress
           (tenant_id, space_id, answer_id, table_id, highest_served_page_index, consumed_cursor_digests, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4::jsonb, $5::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, answer_id, table_id) DO UPDATE
           SET highest_served_page_index = GREATEST(
                 agent_platform.table_read_progress.highest_served_page_index,
                 EXCLUDED.highest_served_page_index
               ),
               consumed_cursor_digests = EXCLUDED.consumed_cursor_digests,
               updated_at = EXCLUDED.updated_at`,
        [
          answerId,
          tableId,
          progress.highestServedPageIndex,
          JSON.stringify(progress.consumedCursorDigests),
          new Date().toISOString(),
        ],
      )
    })
  }
}
