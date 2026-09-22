import { isToolContext } from '@ontology/contracts'
import type {
  HistoricalAssertionView,
  ObjectHistoryQuery,
  ObjectHistoryView,
  PublishedStatement,
  PublishedStatementFilter,
  ScopeRef,
  SemanticPublicationVersion,
  StatementRevisionRecord,
  ToolContext,
  ToolCoverage,
} from '@ontology/contracts'
import { HistoryReadError } from './errors'
import { decodeCursor, encodeCursor } from './cursor'

/**
 * The narrow published read view the history service needs. `SemanticPublicationStore`
 * (LOCAL-031) satisfies it structurally, so the production composition passes the real store
 * and the service never imports an adapter.
 */
export interface ObjectHistoryReadView {
  listStatements(
    scopeRef: ScopeRef,
    filter: PublishedStatementFilter,
    ctx: ToolContext,
  ): Promise<PublishedStatement[]>
  listStatementRevisions(
    scopeRef: ScopeRef,
    statementId: string,
    ctx: ToolContext,
  ): Promise<StatementRevisionRecord[]>
  /**
   * The immutable publications, so the original version-1 statement can be replayed even after
   * the current projection was corrected or retracted. `published_statements` holds only the
   * current head; the original version lives in the publication that created it.
   */
  listPublications(
    scopeRef: ScopeRef,
    limit: number,
    ctx: ToolContext,
  ): Promise<SemanticPublicationVersion[]>
}

export interface HistoryReadServiceDependencies {
  readonly store: ObjectHistoryReadView
  /** Ceiling for one page; a larger request is clamped. */
  readonly maxPageSize?: number
  /** Ceiling for the statements scanned for one object. */
  readonly maxStatements?: number
}

const DEFAULT_MAX_PAGE_SIZE = 200
const DEFAULT_PAGE_SIZE = 100
const DEFAULT_MAX_STATEMENTS = 1_000

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new HistoryReadError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new HistoryReadError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  if (floored < min) return min
  return floored > max ? max : floored
}

function covers(validFrom: string | undefined, validTo: string | undefined, validAt: string): boolean {
  if (validFrom !== undefined && validFrom > validAt) return false
  return validTo === undefined || validAt < validTo
}

function compareVersions(left: string, right: string): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left < right ? -1 : left > right ? 1 : 0
}

function fromStatement(statement: PublishedStatement): HistoricalAssertionView {
  return {
    statementId: statement.statementId,
    propositionKey: statement.propositionKey,
    predicate: statement.predicate,
    kind: statement.kind,
    ...(statement.objectId === undefined ? {} : { objectId: statement.objectId }),
    ...(statement.relationId === undefined ? {} : { relationId: statement.relationId }),
    ...(statement.subjectEntityId === undefined ? {} : { subjectEntityId: statement.subjectEntityId }),
    version: statement.version,
    status: statement.status,
    value: statement.value,
    ...(statement.unitCode === undefined ? {} : { unitCode: statement.unitCode }),
    ...(statement.validFrom === undefined ? {} : { validFrom: statement.validFrom }),
    ...(statement.validTo === undefined ? {} : { validTo: statement.validTo }),
    recordedAt: statement.recordedAt,
    sourceRefs: statement.sourceRefs,
  }
}

function fromRevision(
  statement: PublishedStatement,
  revision: StatementRevisionRecord,
): HistoricalAssertionView {
  const validFrom = revision.validFrom ?? statement.validFrom
  const validTo = revision.validTo ?? statement.validTo
  return {
    statementId: statement.statementId,
    propositionKey: statement.propositionKey,
    predicate: statement.predicate,
    kind: statement.kind,
    ...(statement.objectId === undefined ? {} : { objectId: statement.objectId }),
    ...(statement.relationId === undefined ? {} : { relationId: statement.relationId }),
    ...(statement.subjectEntityId === undefined ? {} : { subjectEntityId: statement.subjectEntityId }),
    version: revision.version,
    status: revision.kind === 'retraction' ? 'retracted' : 'active',
    value: revision.correctedValue ?? statement.value,
    ...(statement.unitCode === undefined ? {} : { unitCode: statement.unitCode }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validTo === undefined ? {} : { validTo }),
    recordedAt: revision.recordedAt,
    revisionKind: revision.kind,
    revisionReason: revision.reason,
    ...(revision.supersedesVersion === undefined
      ? {}
      : { supersedesVersion: revision.supersedesVersion }),
    sourceRefs: statement.sourceRefs,
  }
}

/**
 * On-demand historical assertions for one object (SPEC D3.1, C6 `GET /objects/{id}/history`,
 * US-017, FR-19/FR-20).
 *
 * It returns the immutable assertion versions — the current head plus every correction and
 * retraction record — so a caller can replay the state at a `recordedAt` system version or a
 * `validAt` business instant. The current projection can be updated, but the earlier versions
 * are never erased. The page is bounded and explicitly marked truncated.
 */
export class HistoryReadService {
  readonly #store: ObjectHistoryReadView
  readonly #maxPageSize: number
  readonly #maxStatements: number

  constructor(dependencies: HistoryReadServiceDependencies) {
    this.#store = dependencies.store
    this.#maxPageSize = dependencies.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE
    this.#maxStatements = dependencies.maxStatements ?? DEFAULT_MAX_STATEMENTS
  }

  async getObjectHistory(
    objectId: string,
    query: ObjectHistoryQuery,
    ctx: ToolContext,
  ): Promise<ObjectHistoryView> {
    const scopeRef = scopeOf(ctx)
    if (objectId.trim().length === 0) {
      throw new HistoryReadError('INVALID_ARGUMENT', 'objectId must be a non-empty id')
    }
    const limit = clampInteger(query.limit, DEFAULT_PAGE_SIZE, 1, this.#maxPageSize)
    const offset = query.cursor === undefined ? 0 : decodeHistoryCursor(query.cursor)

    const statements = await this.#store.listStatements(
      scopeRef,
      { objectId, limit: this.#maxStatements },
      ctx,
    )
    const baseByStatement = await this.#loadBaseVersions(scopeRef, statements, ctx)
    const versions: HistoricalAssertionView[] = []
    for (const statement of statements) {
      const byVersion = new Map<string, HistoricalAssertionView>()
      // The current head, then the original version-1 statement from its publication, then
      // every immutable revision. A later write wins the same version key, so a correction is
      // reported with its revision reason and the base version is preserved beside it.
      byVersion.set(statement.version, fromStatement(statement))
      const base = baseByStatement.get(statement.statementId)
      if (base !== undefined) byVersion.set(base.version, fromStatement(base))
      const revisions = await this.#store.listStatementRevisions(scopeRef, statement.statementId, ctx)
      for (const revision of revisions) byVersion.set(revision.version, fromRevision(statement, revision))
      versions.push(...byVersion.values())
    }

    const filtered = versions
      .filter((version) => query.recordedAt === undefined || version.recordedAt <= query.recordedAt)
      .filter(
        (version) => query.validAt === undefined || covers(version.validFrom, version.validTo, query.validAt),
      )
      .sort(
        (left, right) =>
          left.recordedAt.localeCompare(right.recordedAt) ||
          compareVersions(left.version, right.version) ||
          left.statementId.localeCompare(right.statementId),
      )

    const page = filtered.slice(offset, offset + limit)
    const truncated = offset + page.length < filtered.length
    const nextCursor = truncated ? encodeCursor({ offset: offset + page.length }) : undefined
    const coverage: ToolCoverage = {
      returned: page.length,
      knownTotal: filtered.length,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      truncated,
    }
    return {
      objectId,
      ...(query.recordedAt === undefined ? {} : { recordedAt: query.recordedAt }),
      ...(query.validAt === undefined ? {} : { validAt: query.validAt }),
      assertions: page,
      coverage,
    }
  }

  /**
   * The original version-1 statement of each head, recovered from the publication that created
   * it. The current projection overwrites the head, so this is what lets history replay the
   * state before a correction or retraction without rewriting any immutable record.
   */
  async #loadBaseVersions(
    scopeRef: ScopeRef,
    statements: readonly PublishedStatement[],
    ctx: ToolContext,
  ): Promise<Map<string, PublishedStatement>> {
    const wanted = new Set(statements.map((statement) => statement.statementId))
    const base = new Map<string, PublishedStatement>()
    if (wanted.size === 0) return base
    const publications = await this.#store.listPublications(scopeRef, this.#maxStatements, ctx)
    for (const publication of publications) {
      for (const statement of publication.statements) {
        if (!wanted.has(statement.statementId)) continue
        if (base.has(statement.statementId)) continue
        base.set(statement.statementId, statement)
      }
    }
    return base
  }
}

function decodeHistoryCursor(cursor: string): number {
  const decoded = decodeCursor(cursor)
  if (typeof decoded !== 'object' || decoded === null) {
    throw new HistoryReadError('INVALID_CURSOR', 'the history cursor is not a valid page state')
  }
  const offset = (decoded as { readonly offset?: unknown }).offset
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
    throw new HistoryReadError('INVALID_CURSOR', 'the history cursor is not a valid page state')
  }
  return offset
}
