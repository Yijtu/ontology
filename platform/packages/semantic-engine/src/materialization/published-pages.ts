import type {
  PublishedRuleFilter,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementFilter,
  RevisionString,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import type { PublishedSemanticReadView } from './published-source'

const DEFAULT_PAGE_SIZE = 1_000
const DEFAULT_MAX_RECORDS = 100_000

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

export interface StablePublishedSnapshot {
  readonly statements: readonly PublishedStatement[]
  readonly rules: readonly PublishedRuleVersion[]
  readonly readRevision: { readonly semantic: RevisionString; readonly identity: RevisionString }
}

export interface StablePublishedRead<T> {
  readonly value: T
  readonly readRevision: { readonly semantic: RevisionString; readonly identity: RevisionString }
}

function limitsOf(limits: PublishedPageLimits): { pageSize: number; maxRecords: number } {
  const pageSize = limits.pageSize ?? DEFAULT_PAGE_SIZE
  const maxRecords = limits.maxRecords ?? DEFAULT_MAX_RECORDS
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10_000 ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1) {
    throw new IncompletePublishedReadError('published page limits must be positive safe integers within bounds')
  }
  return { pageSize, maxRecords }
}

async function scanPages<T, Cursor>(input: {
  readonly kind: string
  readonly fetch: (cursor: Cursor | undefined, limit: number) => Promise<readonly T[]>
  readonly cursorOf: (item: T) => Cursor
  readonly isAfter: (next: Cursor, previous: Cursor) => boolean
  readonly limits: PublishedPageLimits
}): Promise<T[]> {
  const { pageSize, maxRecords } = limitsOf(input.limits)
  const records: T[] = []
  let cursor: Cursor | undefined
  for (;;) {
    const remaining = maxRecords - records.length
    if (remaining === 0) {
      // An extra keyset fetch distinguishes an exactly complete cap from truncation.
      const extra = await input.fetch(cursor, 1)
      if (extra.length > 0) throw new IncompletePublishedReadError(`${input.kind} scan exceeded the configured ${String(maxRecords)} record cap`)
      return records
    }
    const limit = Math.min(pageSize, remaining)
    const page = await input.fetch(cursor, limit)
    if (page.length > limit) throw new IncompletePublishedReadError(`${input.kind} source exceeded its requested page size`)
    for (const item of page) {
      const next = input.cursorOf(item)
      if (cursor !== undefined && !input.isAfter(next, cursor)) {
        throw new IncompletePublishedReadError(`${input.kind} source repeated or reversed its keyset cursor`)
      }
      records.push(item)
      cursor = next
    }
    if (page.length < limit) return records
  }
}

function compareRuleCursor(left: { ruleId: string; version: RevisionString }, right: { ruleId: string; version: RevisionString }): boolean {
  if (left.ruleId !== right.ruleId) return left.ruleId > right.ruleId
  return BigInt(left.version) > BigInt(right.version)
}

export function readAllPublishedStatements(
  view: PublishedSemanticReadView,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  filter: Omit<PublishedStatementFilter, 'limit' | 'afterStatementId'> = {},
  limits: PublishedPageLimits = {},
): Promise<PublishedStatement[]> {
  return scanPages<PublishedStatement, string>({
    kind: 'published statement',
    fetch: (afterStatementId, limit) => view.listStatements(scopeRef, {
      ...filter,
      limit,
      ...(afterStatementId === undefined ? {} : { afterStatementId }),
    }, ctx),
    cursorOf: (statement) => statement.statementId,
    isAfter: (next, previous) => next > previous,
    limits,
  })
}

export function readAllPublishedRules(
  view: PublishedSemanticReadView,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  filter: Omit<PublishedRuleFilter, 'limit' | 'afterRule'> = {},
  limits: PublishedPageLimits = {},
): Promise<PublishedRuleVersion[]> {
  return scanPages<PublishedRuleVersion, { readonly ruleId: string; readonly version: RevisionString }>({
    kind: 'published rule',
    fetch: (afterRule, limit) => view.listRuleVersions(scopeRef, {
      ...filter,
      limit,
      ...(afterRule === undefined ? {} : { afterRule }),
    }, ctx),
    cursorOf: (rule) => ({ ruleId: rule.ruleId, version: rule.version }),
    isAfter: compareRuleCursor,
    limits,
  })
}

/**
 * Read every statement and rule page under one revision-before/after fence. A page sequence
 * is rejected as incomplete if any publication, correction, retraction, or identity write
 * changes either monotonic scope revision while it is in flight.
 */
export async function readStablePublishedSnapshot(
  view: PublishedSemanticReadView,
  readIdentityRevision: () => Promise<RevisionString>,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  limits: PublishedPageLimits = {},
): Promise<StablePublishedSnapshot> {
  const snapshot = await readAtStableRevision(view, readIdentityRevision, scopeRef, ctx, async () => {
    const [statements, rules] = await Promise.all([
      readAllPublishedStatements(view, scopeRef, ctx, {}, limits),
      readAllPublishedRules(view, scopeRef, ctx, {}, limits),
    ])
    return { statements, rules }
  })
  return {
    statements: snapshot.value.statements,
    rules: snapshot.value.rules,
    readRevision: snapshot.readRevision,
  }
}

/** Run page/header/identity reads between the same scope-wide revision fence. */
export async function readAtStableRevision<T>(
  view: PublishedSemanticReadView,
  readIdentityRevision: () => Promise<RevisionString>,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  read: () => Promise<T>,
): Promise<StablePublishedRead<T>> {
  const before = {
    semantic: await view.latestReadRevision(scopeRef, ctx),
    identity: await readIdentityRevision(),
  }
  const value = await read()
  const after = {
    semantic: await view.latestReadRevision(scopeRef, ctx),
    identity: await readIdentityRevision(),
  }
  if (before.semantic !== after.semantic || before.identity !== after.identity) {
    throw new IncompletePublishedReadError('published or identity read revision changed during pagination; retry the full scan')
  }
  return { value, readRevision: before }
}
