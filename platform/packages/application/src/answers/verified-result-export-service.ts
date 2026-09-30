import {
  VERIFIED_RESULT_EXPORT_SCHEMA_VERSION,
  isToolContext,
  tableManifestContentDigest,
} from '@ontology/contracts'
import type {
  AnswerDraftV3Body,
  ClaimResultBinding,
  AssertionEvidenceBinding,
  PublishedAnswer,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  TypedResultManifest,
  VerifiedResultExport,
  VerifiedResultExportSource,
  VerifiedResultExportTable,
  VerifiedTableManifestSource,
} from '@ontology/contracts'
import { VerifiedResultReadError } from './verified-result-read-service'
import type { PublishedAnswerReadPort, VerifiedResultReadService } from './verified-result-read-service'

/**
 * Structured JSON export of a verified result (SPEC v0.3a execution-evidence §EX-9,
 * asset-data-ui §9.2/§9.3, issue V03-041 / #214, A.US-014.AC-03 / A.FR-22).
 *
 * The export is built from the *same* digest-verified read the verified page uses
 * (`VerifiedResultReadService.getVerifiedAnswer`): the exact published answer and the exact
 * archived `typed-result-manifest@1` it pins. It therefore carries the same content hash,
 * result-manifest ref/digest, table descriptors and table-verification receipts, and a caller
 * who cannot read the verified page cannot export it. There is no separate "latest" path.
 *
 * The source index is derived only from the hash-bound claims/assertions of the exported
 * answer version; the exporter never invents a source and never widens permission.
 */

/** The run-scoped answer lookup the export needs (satisfied by `AnswerStorePort`). */
export interface PublishedAnswerRunPort extends PublishedAnswerReadPort {
  findByRun(runId: string, ctx: ToolContext): Promise<PublishedAnswer | undefined>
}

export interface VerifiedResultExportDependencies {
  readonly reads: VerifiedResultReadService
  readonly answers: PublishedAnswerRunPort
  readonly tables: VerifiedTableManifestSource
  readonly now?: () => string
}

export class VerifiedResultExportError extends Error {
  readonly code: 'ANSWER_NOT_FOUND' | 'RESULT_NOT_AVAILABLE'
  readonly httpStatus = 404

  constructor(code: 'ANSWER_NOT_FOUND' | 'RESULT_NOT_AVAILABLE', message: string) {
    super(message)
    this.name = 'VerifiedResultExportError'
    this.code = code
  }
}

function scopeRefOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new VerifiedResultReadError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

export class VerifiedResultExportService {
  readonly #reads: VerifiedResultReadService
  readonly #answers: PublishedAnswerRunPort
  readonly #tables: VerifiedTableManifestSource
  readonly #now: () => string

  constructor(dependencies: VerifiedResultExportDependencies) {
    this.#reads = dependencies.reads
    this.#answers = dependencies.answers
    this.#tables = dependencies.tables
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  /** Export the verified result of one run by its logical key (the run id). */
  async exportByRun(runId: string, ctx: ToolContext): Promise<VerifiedResultExport> {
    const answer = await this.#answers.findByRun(runId, ctx)
    if (answer === undefined) {
      throw new VerifiedResultExportError('ANSWER_NOT_FOUND', `no published answer for run ${runId} is visible in this scope`)
    }
    return this.exportAnswer(answer.answerId, ctx)
  }

  /** Export one exact verified answer version. */
  async exportAnswer(answerId: string, ctx: ToolContext): Promise<VerifiedResultExport> {
    const scopeRef = scopeRefOf(ctx)
    // Reuses the page read, so the export cannot reflect an unverified or swapped manifest.
    const { answer, manifest } = await this.#reads.getVerifiedAnswer(answerId, ctx)
    const body = answer.v3Body
    if (body === undefined) {
      // Unreachable: getVerifiedAnswer refuses an answer without a @3 body.
      throw new VerifiedResultExportError('RESULT_NOT_AVAILABLE', `answer ${answerId} has no typed-result body`)
    }
    const tables = await this.#buildTables(scopeRef, answerId, manifest, ctx)
    return {
      schemaVersion: VERIFIED_RESULT_EXPORT_SCHEMA_VERSION,
      exportedAt: this.#now(),
      status: {
        publicationKind: answer.publicationKind,
        domainStatus: manifest.domainStatus,
        dataMode: manifest.dataMode,
        currentValidity: this.#validityOf(answer),
        coverage: manifest.coverage,
        limitations: manifest.limitations,
      },
      versions: {
        answerId: answer.answerId,
        runId: answer.runId,
        contentHash: answer.contentHash,
        verificationId: answer.verificationId,
        resultManifestRef: body.resultManifestRef,
        resultManifestDigest: body.resultManifestDigest,
        executionBindingRef: body.executionBindingRef,
        finalizationReceiptRef: body.finalizationReceiptRef,
        finalizationReceiptDigest: body.finalizationReceiptDigest,
      },
      tables,
      sourceIndex: buildSourceIndex(body),
    }
  }

  #validityOf(answer: PublishedAnswer): VerifiedResultExport['status']['currentValidity'] {
    if (answer.publicationKind === 'history_limited' && answer.asOf !== undefined) {
      return { state: 'superseded', reason: `history-limited result published at ${answer.asOf}` }
    }
    return { state: 'current' }
  }

  async #buildTables(
    scopeRef: ScopeRef,
    answerId: string,
    manifest: TypedResultManifest,
    ctx: ToolContext,
  ): Promise<VerifiedResultExportTable[]> {
    const tables: VerifiedResultExportTable[] = []
    for (const table of manifest.tables) {
      const archived = await this.#tables.resolve(scopeRef, answerId, table.tableId, ctx)
      const receiptRef =
        archived !== undefined &&
        archived.verificationReceiptRef !== undefined &&
        tableManifestContentDigest(archived.manifest) === tableManifestContentDigest(table)
          ? archived.verificationReceiptRef
          : undefined
      tables.push({
        tableId: table.tableId,
        totalRows: table.totalRows,
        columns: table.columns,
        complete: table.complete,
        manifestRef:
          archived?.ref ?? {
            id: `${answerId}:${table.tableId}`,
            version: '1.0.0',
            digest: tableManifestContentDigest(table),
            kind: 'artifact',
          },
        manifestDigest: tableManifestContentDigest(table),
        pageRefs: table.pages.map((page) => page.artifactRef),
        ...(receiptRef === undefined ? {} : { verificationReceiptRef: receiptRef }),
      })
    }
    return tables
  }
}

interface AccumulatedSource {
  readonly evidenceRef: ResourceRef
  readonly resultDigest: Sha256Digest
  readonly boundBy: Set<'claim' | 'assertion'>
}

function bindingKey(ref: ResourceRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.version}\u0000${ref.digest}`
}

function accumulate(
  index: Map<string, AccumulatedSource>,
  binding: ClaimResultBinding | AssertionEvidenceBinding,
  kind: 'claim' | 'assertion',
): void {
  const key = bindingKey(binding.evidenceRef)
  const existing = index.get(key)
  if (existing === undefined) {
    index.set(key, { evidenceRef: binding.evidenceRef, resultDigest: binding.resultDigest, boundBy: new Set([kind]) })
    return
  }
  existing.boundBy.add(kind)
}

/**
 * Build the source index from the hash-bound body. Two body parts that reference the same
 * evidence result collapse into one entry, and entries are ordered by evidence id so the
 * export is reproducible for one version.
 */
function buildSourceIndex(body: AnswerDraftV3Body): VerifiedResultExportSource[] {
  const index = new Map<string, AccumulatedSource>()
  for (const claim of body.claims) {
    for (const reference of claim.references) accumulate(index, reference, 'claim')
  }
  for (const assertion of body.assertions) {
    for (const reference of assertion.references) accumulate(index, reference, 'assertion')
  }
  return [...index.values()]
    .map((entry) => ({
      evidenceId: entry.evidenceRef.id,
      evidenceRef: entry.evidenceRef,
      resultDigest: entry.resultDigest,
      boundBy: [...entry.boundBy].sort(),
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
}
