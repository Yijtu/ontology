import type { QueryResultRow } from 'pg'
import {
  assertTableVerificationProgressShape,
  assertTableVerificationReceiptShape,
  isToolContext,
  sha256OfCanonical,
} from '@ontology/contracts'
import type {
  ArchivedTableVerificationReceipt,
  NonEmptyString,
  ResourceRef,
  ScopeRef,
  TableVerificationBatchRecord,
  TableVerificationProgress,
  TableVerificationProgressStore,
  TableVerificationReceipt,
  TableVerificationReceiptStore,
  ToolContext,
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

interface ReceiptRow extends QueryResultRow {
  receipt: TableVerificationReceipt
}

interface ProgressRow extends QueryResultRow {
  total_rows: number
  checked_rows: number
  checked_cells: number
  next_page_index: number
  next_row_in_page: number
  bound_subjects: string[]
  batches: TableVerificationBatchRecord[]
  checks_digest: string
  updated_at: string
}

/**
 * Real PostgreSQL store for the batched table-verification receipts and their recovery
 * progress (SPEC v0.3a §EX-7.1, issue V03-033).
 *
 * The receipt body is runtime-validated and re-hashed against its ref digest before insert,
 * so a corrupt or forged receipt can never be archived under a valid-looking ref. Progress is
 * keyed by the exact fixed manifest ref, so a resumed verification can never continue another
 * revision's work.
 */
export class PostgresTableVerificationStore
  implements TableVerificationReceiptStore, TableVerificationProgressStore
{
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    receipt: TableVerificationReceipt,
    ctx: ToolContext,
  ): Promise<void> {
    assertTableVerificationReceiptShape(receipt)
    const digest = sha256OfCanonical(receipt)
    if (receiptRef.digest !== digest) {
      throw new ControlStorageError(
        'UNIQUE_VIOLATION',
        `receipt ref digest ${receiptRef.digest} does not match its content digest ${digest}`,
      )
    }
    await withScope(this.#database, scopeRef, ctx, async (query) => {
      const inserted = await query.query(
        `INSERT INTO agent_platform.table_verification_receipts
           (tenant_id, space_id, receipt_id, version, digest, manifest_id, manifest_version,
            manifest_digest, table_id, draft_hash, receipt, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, receipt_id, version, digest) DO NOTHING
         RETURNING receipt_id`,
        [
          receiptRef.id,
          receiptRef.version,
          receiptRef.digest,
          receipt.resultManifestRef.id,
          receipt.resultManifestRef.version,
          receipt.resultManifestDigest,
          receipt.tableId,
          receipt.draftHash,
          JSON.stringify(receipt),
          new Date().toISOString(),
        ],
      )
      if (inserted.rows.length > 0) return
      const existing = await query.query<ReceiptRow & { same_content: boolean }>(
        `SELECT (receipt = $4::jsonb) AS same_content
           FROM agent_platform.table_verification_receipts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND receipt_id = $1 AND version = $2 AND digest = $3`,
        [receiptRef.id, receiptRef.version, receiptRef.digest, JSON.stringify(receipt)],
      )
      if (existing.rows[0]?.same_content !== true) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `table verification receipt ${receiptRef.id} already exists with different content`,
        )
      }
    })
  }

  async getReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTableVerificationReceipt | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<ReceiptRow>(
        `SELECT receipt FROM agent_platform.table_verification_receipts
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND receipt_id = $1 AND version = $2 AND digest = $3`,
        [receiptRef.id, receiptRef.version, receiptRef.digest],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      assertTableVerificationReceiptShape(row.receipt)
      if (sha256OfCanonical(row.receipt) !== receiptRef.digest) {
        throw new ControlStorageError('UNIQUE_VIOLATION', `receipt ${receiptRef.id} does not hash to its ref digest`)
      }
      return { ref: receiptRef, receipt: row.receipt }
    })
  }

  async getProgress(
    scopeRef: ScopeRef,
    manifestRef: ResourceRef,
    tableId: NonEmptyString,
    ctx: ToolContext,
  ): Promise<TableVerificationProgress | undefined> {
    return withScope(this.#database, scopeRef, ctx, async (query) => {
      const result = await query.query<ProgressRow>(
        `SELECT total_rows, checked_rows, checked_cells, next_page_index, next_row_in_page,
                bound_subjects, batches,
                checks_digest,
                to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
           FROM agent_platform.table_verification_progress
          WHERE tenant_id = current_setting('app.tenant_id')::uuid
            AND space_id = current_setting('app.space_id')::uuid
            AND manifest_id = $1 AND manifest_version = $2 AND manifest_digest = $3 AND table_id = $4`,
        [manifestRef.id, manifestRef.version, manifestRef.digest, tableId],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      const progress: TableVerificationProgress = {
        schemaVersion: 'table-verification-progress@1',
        resultManifestRef: manifestRef,
        resultManifestDigest: manifestRef.digest,
        tableId,
        totalRows: row.total_rows,
        checkedRows: row.checked_rows,
        checkedCells: row.checked_cells,
        nextPageIndex: row.next_page_index,
        nextRowInPage: row.next_row_in_page,
        boundSubjects: row.bound_subjects,
        batches: row.batches,
        checksDigest: row.checks_digest,
        updatedAt: row.updated_at,
      }
      assertTableVerificationProgressShape(progress)
      return progress
    })
  }

  async saveProgress(
    scopeRef: ScopeRef,
    manifestRef: ResourceRef,
    tableId: NonEmptyString,
    progress: TableVerificationProgress,
    ctx: ToolContext,
  ): Promise<void> {
    assertTableVerificationProgressShape(progress)
    await withScope(this.#database, scopeRef, ctx, async (query) => {
      await query.query(
        `INSERT INTO agent_platform.table_verification_progress
           (tenant_id, space_id, manifest_id, manifest_version, manifest_digest, table_id,
            total_rows, checked_rows, checked_cells, next_page_index, next_row_in_page,
            bound_subjects, batches, checks_digest, updated_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, manifest_id, manifest_version, manifest_digest, table_id)
         DO UPDATE SET
           total_rows = EXCLUDED.total_rows,
           checked_rows = EXCLUDED.checked_rows,
           checked_cells = EXCLUDED.checked_cells,
           next_page_index = GREATEST(
             agent_platform.table_verification_progress.next_page_index,
             EXCLUDED.next_page_index
           ),
           next_row_in_page = EXCLUDED.next_row_in_page,
           bound_subjects = EXCLUDED.bound_subjects,
           batches = EXCLUDED.batches,
           checks_digest = EXCLUDED.checks_digest,
           updated_at = EXCLUDED.updated_at`,
        [
          manifestRef.id,
          manifestRef.version,
          manifestRef.digest,
          tableId,
          progress.totalRows,
          progress.checkedRows,
          progress.checkedCells,
          progress.nextPageIndex,
          progress.nextRowInPage,
          JSON.stringify(progress.boundSubjects),
          JSON.stringify(progress.batches),
          progress.checksDigest,
          new Date().toISOString(),
        ],
      )
    })
  }
}
