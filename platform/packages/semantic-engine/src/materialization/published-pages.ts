import type {
  PublishedRuleFilter,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementFilter,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import type { PublishedSemanticReadView } from './published-source'

const DEFAULT_PAGE_SIZE = 1_000
const DEFAULT_MAX_RECORDS = 100_000

/** A stable-view scan fails explicitly on pagination errors or configured size limits. */
export class IncompletePublishedReadError extends Error {
  readonly code = 'INCOMPLETE_PUBLISHED_READ'

  constructor(message: string) {
    super(message)
    this.name = 'IncompletePublishedReadError'
  }
}

export interface PublishedPageLimits {
  readonly pageSize?: number
  readonly maxRecords?: number
}

function scanLimits(limits: PublishedPageLimits): { pageSize: number; maxRecords: number } {
  const pageSize = limits.pageSize ?? DEFAULT_PAGE_SIZE
  const maxRecords = limits.maxRecords ?? DEFAULT_MAX_RECORDS
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new IncompletePublishedReadError('pageSize and maxRecords must be positive safe integers')
  }
  return { pageSize, maxRecords }
}

async function scanPages<T, Cursor>(
  kind: string,
  fetchPage: (after: Cursor | undefined, limit: number) => Promise<readonly T[]>,
  cursorOf: (record: T) => Cursor,
  isAfter: (next: Cursor, previous: Cursor) => boolean,
  limits: PublishedPageLimits,
): Promise<T[]> {
  const { pageSize, maxRecords } = scanLimits(limits)
  const records: T[] = []
  let cursor: Cursor | undefined
  for (;;) {
    // When exactly at the cap, one extra row distinguishes complete from truncated.
    const limit = Math.min(pageSize, Math.max(1, maxRecords - records.length))
    const page = await fetchPage(cursor, limit)
    if (page.length > limit) {
      throw new IncompletePublishedReadError(`${kind} source exceeded its requested page size`)
    }
    for (const record of page) {
      if (records.length >= maxRecords) {
        throw new IncompletePublishedReadError(`${kind} scan exceeded ${String(maxRecords)} records`)
      }
      const next = cursorOf(record)
      if (cursor !== undefined && !isAfter(next, cursor)) {
        throw new IncompletePublishedReadError(`${kind} source did not advance its keyset cursor`)
      }
      records.push(record)
      cursor = next
    }
    if (page.length < limit) return records
  }
}

/** Read every bounded statement page. The caller must pin a snapshot when writers run concurrently. */
export function readAllPublishedStatements(
  published: PublishedSemanticReadView,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  filter: Omit<PublishedStatementFilter, 'limit' | 'afterStatementId'> = {},
  limits: PublishedPageLimits = {},
): Promise<PublishedStatement[]> {
  return scanPages<PublishedStatement, string>(
    'statement',
    (after, limit) => published.listStatements(scopeRef, {
      ...filter,
      limit,
      ...(after === undefined ? {} : { afterStatementId: after }),
    }, ctx),
    (record) => record.statementId,
    (next, previous) => next > previous,
    limits,
  )
}

interface RuleCursor {
  readonly ruleId: string
  readonly version: string
}

function ruleCursorIsAfter(next: RuleCursor, previous: RuleCursor): boolean {
  return next.ruleId > previous.ruleId ||
    (next.ruleId === previous.ruleId && BigInt(next.version) > BigInt(previous.version))
}

/** Read every bounded rule-version page; concurrent writers require a pinned snapshot. */
export function readAllPublishedRules(
  published: PublishedSemanticReadView,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  filter: Omit<PublishedRuleFilter, 'limit' | 'afterRule'> = {},
  limits: PublishedPageLimits = {},
): Promise<PublishedRuleVersion[]> {
  return scanPages<PublishedRuleVersion, RuleCursor>(
    'rule',
    (after, limit) => published.listRuleVersions(scopeRef, {
      ...filter,
      limit,
      ...(after === undefined ? {} : { afterRule: after }),
    }, ctx),
    (record) => ({ ruleId: record.ruleId, version: record.version }),
    ruleCursorIsAfter,
    limits,
  )
}
