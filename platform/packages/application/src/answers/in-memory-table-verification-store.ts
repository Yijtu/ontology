import { assertTableVerificationReceiptShape, isToolContext, sha256OfCanonical } from '@ontology/contracts'
import type {
  ArchivedTableVerificationReceipt,
  NonEmptyString,
  ResourceRef,
  ScopeRef,
  TableVerificationProgress,
  TableVerificationProgressStore,
  TableVerificationReceipt,
  TableVerificationReceiptStore,
  ToolContext,
} from '@ontology/contracts'

function scopeKey(scopeRef: ScopeRef): string {
  return `${scopeRef.tenantId}|${scopeRef.spaceId}`
}

function refKey(ref: ResourceRef): string {
  return `${ref.id}|${ref.version}|${ref.digest}`
}

function assertTrustedScope(scopeRef: ScopeRef, ctx: ToolContext): void {
  if (!isToolContext(ctx)) {
    throw new Error('a host-minted trusted tool context is required')
  }
  if (
    ctx.principal.tenantId !== scopeRef.tenantId ||
    ctx.allowedResources.tenantId !== scopeRef.tenantId ||
    ctx.allowedResources.spaceId !== scopeRef.spaceId
  ) {
    throw new Error('request scope does not match the trusted principal scope')
  }
}

/**
 * In-memory implementation of the table-verification receipt and progress stores.
 *
 * It exists for unit tests and local development and is the reference for the real adapter:
 * the receipt body is re-hashed on write so a caller cannot store a receipt that does not
 * match its ref digest, and progress is keyed by the fixed manifest ref so a resumed run can
 * never continue another revision's work.
 */
export class InMemoryTableVerificationStore
  implements TableVerificationReceiptStore, TableVerificationProgressStore
{
  readonly #receipts = new Map<string, ArchivedTableVerificationReceipt>()
  readonly #progress = new Map<string, TableVerificationProgress>()

  async putReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    receipt: TableVerificationReceipt,
    ctx: ToolContext,
  ): Promise<void> {
    assertTrustedScope(scopeRef, ctx)
    assertTableVerificationReceiptShape(receipt)
    const digest = sha256OfCanonical(receipt)
    if (receiptRef.digest !== digest) {
      throw new Error(`receipt ref digest ${receiptRef.digest} does not match its content digest ${digest}`)
    }
    this.#receipts.set(`${scopeKey(scopeRef)}|${refKey(receiptRef)}`, { ref: receiptRef, receipt })
  }

  async getReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTableVerificationReceipt | undefined> {
    assertTrustedScope(scopeRef, ctx)
    return this.#receipts.get(`${scopeKey(scopeRef)}|${refKey(receiptRef)}`)
  }

  async getProgress(
    scopeRef: ScopeRef,
    manifestRef: ResourceRef,
    tableId: NonEmptyString,
    ctx: ToolContext,
  ): Promise<TableVerificationProgress | undefined> {
    assertTrustedScope(scopeRef, ctx)
    return this.#progress.get(`${scopeKey(scopeRef)}|${refKey(manifestRef)}|${tableId}`)
  }

  async saveProgress(
    scopeRef: ScopeRef,
    manifestRef: ResourceRef,
    tableId: NonEmptyString,
    progress: TableVerificationProgress,
    ctx: ToolContext,
  ): Promise<void> {
    assertTrustedScope(scopeRef, ctx)
    this.#progress.set(`${scopeKey(scopeRef)}|${refKey(manifestRef)}|${tableId}`, progress)
  }
}
