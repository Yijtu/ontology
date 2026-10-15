import type { QueryResultRow } from 'pg'
import { assertTaskFinalizationReceiptShape, isToolContext } from '@ontology/contracts'
import { ControlStorageError } from './errors'
import type {
  ArchivedTaskFinalizationReceipt,
  ResourceRef,
  ScopeRef,
  TaskFinalizationReceipt,
  TaskFinalizationReceiptStore,
  ToolContext,
} from '@ontology/contracts'
import { ControlPostgresDatabase } from './database'

interface ScopedQuery {
  query<Row extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number }>
}

interface ReceiptRow extends QueryResultRow {
  receipt: TaskFinalizationReceipt
  same_content?: boolean
}

/**
 * Real PostgreSQL implementation of the immutable finalization receipt store (SPEC v0.3a
 * §EX-6.1). A receipt is immutable per exact ref digest; the receipt references the result
 * and reports but is never referenced by them, so archiving it cannot create a cycle.
 */
export class PostgresTaskFinalizationReceiptStore implements TaskFinalizationReceiptStore {
  readonly #database: ControlPostgresDatabase

  constructor(database: ControlPostgresDatabase) {
    this.#database = database
  }

  async putReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    receipt: TaskFinalizationReceipt,
    ctx: ToolContext,
  ): Promise<void> {
    assertTaskFinalizationReceiptShape(receipt)
    await this.#withScope(scopeRef, ctx, async (query) => {
      const inserted = await query.query<ReceiptRow>(
        `INSERT INTO agent_platform.task_finalization_receipts
           (tenant_id, space_id, receipt_id, version, digest, task_binding_id, task_binding_version, task_binding_digest, manifest_digest, receipt, recorded_at)
         VALUES (
           current_setting('app.tenant_id')::uuid,
           current_setting('app.space_id')::uuid,
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz
         )
         ON CONFLICT (tenant_id, space_id, receipt_id, version, digest) DO NOTHING
         RETURNING receipt`,
        [
          receiptRef.id,
          receiptRef.version,
          receiptRef.digest,
          receipt.taskBindingRef.id,
          receipt.taskBindingRef.version,
          receipt.taskBindingRef.digest,
          receipt.typedResultManifestDigest,
          JSON.stringify(receipt),
          new Date().toISOString(),
        ],
      )
      if (inserted.rows[0] !== undefined) return
      const existing = await query.query<ReceiptRow>(
        `SELECT receipt, (receipt = $4::jsonb) AS same_content
           FROM agent_platform.task_finalization_receipts
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND receipt_id = $1 AND version = $2 AND digest = $3`,
        [receiptRef.id, receiptRef.version, receiptRef.digest, JSON.stringify(receipt)],
      )
      const row = existing.rows[0]
      if (row === undefined || row.same_content !== true) {
        throw new ControlStorageError(
          'UNIQUE_VIOLATION',
          `finalization receipt ${receiptRef.id} already exists with different content`,
        )
      }
    })
  }

  async getReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTaskFinalizationReceipt | undefined> {
    return this.#withScope(scopeRef, ctx, async (query) => {
      const result = await query.query<ReceiptRow>(
        `SELECT receipt FROM agent_platform.task_finalization_receipts
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND space_id = current_setting('app.space_id')::uuid
             AND receipt_id = $1 AND version = $2 AND digest = $3`,
        [receiptRef.id, receiptRef.version, receiptRef.digest],
      )
      const row = result.rows[0]
      if (row === undefined) return undefined
      assertTaskFinalizationReceiptShape(row.receipt)
      return { ref: receiptRef, receipt: row.receipt }
    })
  }

  async #withScope<T>(
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
    return this.#database.withIdentityScope(
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
}
