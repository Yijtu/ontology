import {
  isToolContext,
  isTypedResultManifest,
  tableManifestContentDigest,
} from '@ontology/contracts'
import type {
  DataMode,
  DomainResultStatus,
  PublishedAnswer,
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  TableArtifactManifest,
  TableColumnDescriptor,
  ToolContext,
  ToolCoverage,
  TypedResultManifest,
  Uuid,
  VerifiedTableManifestSource,
} from '@ontology/contracts'
import { typedResultManifestContentDigest } from './typed-result-manifest'
import type { TypedDraftArtifactStore } from './typed-draft-writer'

/**
 * The authorized typed-result projection the browser workbench renders (SPEC v0.3a
 * execution-evidence §EX-7.1/§EX-9; issue V03-032 / #203, V03-040 / #212).
 *
 * The projection never exposes raw compute JSON or an unverified artifact. It is built from
 * the exact published answer and the exact archived `typed-result-manifest@1` the answer pins
 * by ref and digest: the manifest is re-read through the scoped immutable artifact reader and
 * its content digest is recomputed, so a tampered or swapped manifest is refused instead of
 * projected. Every table summary carries the table-verification receipt ref only when the
 * archived verified manifest actually matches the table the typed manifest declares, so a
 * reader can never render a table as formal unless it was earned.
 *
 * The shape mirrors the data-only `VerifiedResultView` the web client validates at the wire
 * boundary; declaring it here keeps `apps/web` a pure consumer of `@ontology/contracts`.
 */

/** The narrow published-answer reader the projection needs (satisfied by `AnswerStorePort`). */
export interface PublishedAnswerReadPort {
  findByAnswer(answerId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined>
}

/** One table projection. `verificationReceiptRef` is absent for an unverified/raw table. */
export interface VerifiedTableSummary {
  readonly tableId: string
  readonly totalRows: number
  readonly columns: readonly TableColumnDescriptor[]
  readonly complete: boolean
  readonly verificationReceiptRef?: ResourceRef
}

/** The authorized, data-only projection of a verified `typed-result-manifest@1`. */
export interface VerifiedResultView {
  readonly answerId: string
  readonly runId: string
  readonly contentHash: Sha256Digest
  readonly verificationId: string
  readonly resultManifestRef: ResourceRef
  readonly resultManifestDigest: Sha256Digest
  readonly publicationKind: 'verified' | 'history_limited'
  readonly coverage: ToolCoverage
  readonly domainStatus: DomainResultStatus
  readonly dataMode: DataMode
  readonly tables: readonly VerifiedTableSummary[]
  readonly limitations: readonly string[]
  readonly currentValidity: {
    readonly state: 'current' | 'superseded' | 'withdrawn' | 'unverifiable'
    readonly reason?: string
  }
}

export type VerifiedResultReadErrorCode =
  | 'SCOPE_MISMATCH'
  | 'ANSWER_NOT_FOUND'
  | 'RESULT_NOT_AVAILABLE'
  | 'RESULT_MANIFEST_UNREADABLE'
  | 'RESULT_MANIFEST_DIGEST_MISMATCH'

const ERROR_HTTP_STATUS: Readonly<Record<VerifiedResultReadErrorCode, number>> = {
  SCOPE_MISMATCH: 403,
  ANSWER_NOT_FOUND: 404,
  RESULT_NOT_AVAILABLE: 404,
  RESULT_MANIFEST_UNREADABLE: 422,
  RESULT_MANIFEST_DIGEST_MISMATCH: 422,
}

/** A classified failure for the typed-result read surface; the HTTP boundary renders its code. */
export class VerifiedResultReadError extends Error {
  readonly code: VerifiedResultReadErrorCode
  readonly httpStatus: number

  constructor(code: VerifiedResultReadErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'VerifiedResultReadError'
    this.code = code
    this.httpStatus = ERROR_HTTP_STATUS[code]
  }
}

export interface VerifiedResultReadServiceDependencies {
  readonly answers: PublishedAnswerReadPort
  /** Scoped immutable read of the archived typed-result manifest bytes. */
  readonly results: TypedDraftArtifactStore
  readonly tables: VerifiedTableManifestSource
}

function scopeRefOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new VerifiedResultReadError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  if (ctx.allowedResources.tenantId !== ctx.principal.tenantId) {
    throw new VerifiedResultReadError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

export class VerifiedResultReadService {
  readonly #answers: PublishedAnswerReadPort
  readonly #results: TypedDraftArtifactStore
  readonly #tables: VerifiedTableManifestSource

  constructor(dependencies: VerifiedResultReadServiceDependencies) {
    this.#answers = dependencies.answers
    this.#results = dependencies.results
    this.#tables = dependencies.tables
  }

  /**
   * The exact published answer and its digest-verified typed result manifest. The scope and
   * manifest-digest checks live in one place so every reader (the page projection and the JSON
   * export) is derived from the same verified artifact and never from a second representation.
   */
  async getVerifiedAnswer(
    answerId: string,
    ctx: ToolContext,
  ): Promise<{ readonly answer: PublishedAnswer; readonly manifest: TypedResultManifest }> {
    const scopeRef = scopeRefOf(ctx)
    const answer = await this.#answers.findByAnswer(answerId, ctx)
    if (answer === undefined) {
      throw new VerifiedResultReadError('ANSWER_NOT_FOUND', `no published answer ${answerId} is visible in this scope`)
    }
    const body = answer.v3Body
    if (body === undefined) {
      throw new VerifiedResultReadError(
        'RESULT_NOT_AVAILABLE',
        `answer ${answerId} has no typed-result (@3) body and cannot be projected`,
      )
    }
    const manifest = await this.#readManifest(scopeRef, body.resultManifestRef, ctx)
    const recomputed = typedResultManifestContentDigest(manifest)
    if (recomputed !== body.resultManifestDigest || recomputed !== body.resultManifestRef.digest) {
      throw new VerifiedResultReadError(
        'RESULT_MANIFEST_DIGEST_MISMATCH',
        `the typed result manifest of answer ${answerId} does not match the digest the answer pins`,
      )
    }
    return { answer, manifest }
  }

  async getResult(answerId: string, ctx: ToolContext): Promise<VerifiedResultView> {
    const scopeRef = scopeRefOf(ctx)
    const { answer, manifest } = await this.getVerifiedAnswer(answerId, ctx)
    const body = answer.v3Body
    if (body === undefined) {
      throw new VerifiedResultReadError(
        'RESULT_NOT_AVAILABLE',
        `answer ${answer.answerId} has no typed-result (@3) body and cannot be projected`,
      )
    }
    const tables = await this.#summarizeTables(scopeRef, answer.answerId, manifest, ctx)
    return {
      answerId: answer.answerId,
      runId: answer.runId,
      contentHash: answer.contentHash,
      verificationId: answer.verificationId,
      resultManifestRef: body.resultManifestRef,
      resultManifestDigest: body.resultManifestDigest,
      publicationKind: answer.publicationKind,
      coverage: manifest.coverage,
      domainStatus: manifest.domainStatus,
      dataMode: manifest.dataMode,
      tables,
      limitations: manifest.limitations,
      currentValidity: validityOf(answer),
    }
  }

  async #readManifest(
    scopeRef: ScopeRef,
    resultManifestRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<TypedResultManifest> {
    const authorized = await this.#results.getAuthorized({ scopeRef, blobRef: resultManifestRef }, ctx)
    if (!authorized.integrityVerified) {
      throw new VerifiedResultReadError(
        'RESULT_MANIFEST_UNREADABLE',
        `the typed result manifest ${resultManifestRef.id} is not integrity-verified`,
      )
    }
    const bytes = await this.#results.readAuthorized({ scopeRef, blobRef: resultManifestRef }, ctx)
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch (error) {
      throw new VerifiedResultReadError(
        'RESULT_MANIFEST_UNREADABLE',
        `the typed result manifest ${resultManifestRef.id} is not valid UTF-8 JSON`,
        { cause: error },
      )
    }
    if (!isTypedResultManifest(parsed)) {
      throw new VerifiedResultReadError(
        'RESULT_MANIFEST_UNREADABLE',
        `the typed result manifest ${resultManifestRef.id} does not match typed-result-manifest@1`,
      )
    }
    return parsed
  }

  async #summarizeTables(
    scopeRef: ScopeRef,
    answerId: Uuid,
    manifest: TypedResultManifest,
    ctx: ToolContext,
  ): Promise<VerifiedTableSummary[]> {
    const summaries: VerifiedTableSummary[] = []
    for (const table of manifest.tables) {
      summaries.push(await this.#summarizeTable(scopeRef, answerId, table, ctx))
    }
    return summaries
  }

  async #summarizeTable(
    scopeRef: ScopeRef,
    answerId: Uuid,
    table: TableArtifactManifest,
    ctx: ToolContext,
  ): Promise<VerifiedTableSummary> {
    const archived = await this.#tables.resolve(scopeRef, answerId, table.tableId, ctx)
    const receiptRef =
      archived !== undefined &&
      archived.verificationReceiptRef !== undefined &&
      tableManifestContentDigest(archived.manifest) === tableManifestContentDigest(table)
        ? archived.verificationReceiptRef
        : undefined
    return {
      tableId: table.tableId,
      totalRows: table.totalRows,
      columns: table.columns,
      complete: table.complete,
      ...(receiptRef === undefined ? {} : { verificationReceiptRef: receiptRef }),
    }
  }
}

/**
 * The read-envelope validity is not persisted with the immutable answer, so a current verified
 * publication projects as `current`. A `history_limited` publication is by definition an older
 * verified content an explicit as-of point, reported as `superseded` with that point so the UI
 * never presents it as the current result.
 */
function validityOf(answer: PublishedAnswer): VerifiedResultView['currentValidity'] {
  if (answer.publicationKind === 'history_limited' && answer.asOf !== undefined) {
    return { state: 'superseded', reason: `history-limited result published at ${answer.asOf}` }
  }
  return { state: 'current' }
}
