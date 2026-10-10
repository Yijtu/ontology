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

function lookupKey(scopeRef: ScopeRef, input: { readonly resultManifestRef: ResourceRef; readonly draftHash: string; readonly tableId: string }): string {
  return `${scopeKey(scopeRef)}|${sha256OfCanonical(input)}`
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
  readonly #byTableDraft = new Map<string, Set<string>>()
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
    const key = `${scopeKey(scopeRef)}|${refKey(receiptRef)}`
    this.#receipts.set(key, { ref: receiptRef, receipt })
    const lookup = lookupKey(scopeRef, { resultManifestRef: receipt.resultManifestRef, draftHash: receipt.draftHash, tableId: receipt.tableId })
    const refs = this.#byTableDraft.get(lookup) ?? new Set<string>()
    refs.add(key)
    this.#byTableDraft.set(lookup, refs)
  }

  async getReceipt(
    scopeRef: ScopeRef,
    receiptRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ArchivedTableVerificationReceipt | undefined> {
    assertTrustedScope(scopeRef, ctx)
    return this.#receipts.get(`${scopeKey(scopeRef)}|${refKey(receiptRef)}`)
  }

  async findReceipt(
    scopeRef: ScopeRef,
    input: { readonly resultManifestRef: ResourceRef; readonly draftHash: string; readonly tableId: NonEmptyString },
    ctx: ToolContext,
  ): Promise<ArchivedTableVerificationReceipt | undefined> {
    assertTrustedScope(scopeRef, ctx)
    let result: ArchivedTableVerificationReceipt | undefined
    for (const key of this.#byTableDraft.get(lookupKey(scopeRef, input)) ?? []) {
      const value = this.#receipts.get(key)
      if (value === undefined) throw new Error('the exact receipt index points at unavailable content')
      assertTableVerificationReceiptShape(value.receipt)
      if (sha256OfCanonical(value.receipt) !== value.ref.digest || value.receipt.resultManifestDigest !== input.resultManifestRef.digest) throw new Error('the actual saved table receipt does not match its digest pins')
      if (result !== undefined && (sha256OfCanonical(result.receipt) !== value.ref.digest || result.ref.digest !== value.ref.digest)) throw new Error('the same table/draft receipt lookup has conflicting immutable bodies')
      if (result === undefined || refKey(value.ref) < refKey(result.ref)) result = value
    }
    return result === undefined ? undefined : structuredClone(result)
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
