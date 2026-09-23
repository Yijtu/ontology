import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  PublishedRuleFilter,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementFilter,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import {
  IncompletePublishedReadError,
  PublishedSemanticSource,
  readAllPublishedRules,
  readAllPublishedStatements,
} from '@ontology/semantic-engine'
import type { PublishedSemanticReadView } from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

const scope: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
const ctx: ToolContext = toolContext(scope.tenantId, scope.spaceId, ['scoped-reader'], 'reader', randomUUID())
const recordedAt = '2026-09-21T00:00:00Z'

function statement(index: number, publicationId = 'pub-a'): PublishedStatement {
  return {
    statementId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    propositionKey: `site-${index}`,
    kind: 'entity',
    subjectEntityId: `site-${index}`,
    predicate: 'site.active',
    value: { value: true },
    recordedAt,
    sourceCandidateId: randomUUID(),
    sourceRefs: [],
    publicationId,
    version: '1',
    status: 'active',
  }
}

function rule(ruleId: string, version: string, publicationId = 'pub-a'): PublishedRuleVersion {
  return {
    ruleVersionId: randomUUID(),
    ruleId,
    version,
    objectId: 'site.active',
    severity: 'soft',
    impact: 'low',
    expression: { op: 'compare', attributeId: 'site.active', operator: 'eq', value: true, spans: [] },
    exceptions: [],
    recordedAt,
    sourceCandidateId: randomUUID(),
    publicationId,
  }
}

class PagedReadView implements PublishedSemanticReadView {
  readonly statements: readonly PublishedStatement[]
  readonly rules: readonly PublishedRuleVersion[]
  readonly statementCalls: PublishedStatementFilter[] = []
  readonly ruleCalls: PublishedRuleFilter[] = []

  constructor(statements: readonly PublishedStatement[], rules: readonly PublishedRuleVersion[] = []) {
    this.statements = statements
    this.rules = rules
  }

  async listStatements(_scopeRef: ScopeRef, filter: PublishedStatementFilter): Promise<PublishedStatement[]> {
    this.statementCalls.push(filter)
    return this.statements
      .filter((item) => filter.publicationId === undefined || item.publicationId === filter.publicationId)
      .filter((item) => filter.afterStatementId === undefined || item.statementId > filter.afterStatementId)
      .slice(0, filter.limit ?? 1_000)
  }

  async listRuleVersions(_scopeRef: ScopeRef, filter: PublishedRuleFilter): Promise<PublishedRuleVersion[]> {
    this.ruleCalls.push(filter)
    return this.rules
      .filter((item) => filter.publicationId === undefined || item.publicationId === filter.publicationId)
      .filter((item) => filter.afterRule === undefined || item.ruleId > filter.afterRule.ruleId ||
        (item.ruleId === filter.afterRule.ruleId && BigInt(item.version) > BigInt(filter.afterRule.version)))
      .slice(0, filter.limit ?? 1_000)
  }
}

describe('complete published keyset scans', () => {
  it('loads a materialization source with 1,001 facts rather than returning a silent first page', async () => {
    const view = new PagedReadView(Array.from({ length: 1_001 }, (_, index) => statement(index)))
    const loaded = await new PublishedSemanticSource(view, 128).load(scope, ctx)
    expect(loaded.facts).toHaveLength(1_001)
    expect(loaded.facts.at(-1)?.subject).toBe('site-1000')
    expect(view.statementCalls.length).toBeGreaterThan(1)
    expect(view.statementCalls[1]?.afterStatementId).toBe(view.statements[127]?.statementId)
  })

  it('keeps the publication filter and includes later rule versions across a page boundary', async () => {
    const view = new PagedReadView([statement(0, 'pub-a'), statement(1, 'pub-b')], [
      rule('rule.a', '1'), rule('rule.a', '2'), rule('rule.b', '1'), rule('rule.c', '1', 'pub-b'),
    ])
    const statements = await readAllPublishedStatements(view, scope, ctx, { publicationId: 'pub-a' }, { pageSize: 1 })
    const rules = await readAllPublishedRules(view, scope, ctx, { publicationId: 'pub-a' }, { pageSize: 2 })
    expect(statements.map((item) => item.propositionKey)).toEqual(['site-0'])
    expect(rules.map((item) => `${item.ruleId}@${item.version}`)).toEqual(['rule.a@1', 'rule.a@2', 'rule.b@1'])
    expect(view.ruleCalls[1]?.afterRule).toEqual({ ruleId: 'rule.a', version: '2' })
    expect(view.ruleCalls.every((call) => call.publicationId === 'pub-a')).toBe(true)
  })

  it('fails explicitly at the budget and if a source repeats a full page', async () => {
    const view = new PagedReadView([statement(0), statement(1), statement(2)])
    await expect(readAllPublishedStatements(view, scope, ctx, {}, { pageSize: 2, maxRecords: 2 }))
      .rejects.toBeInstanceOf(IncompletePublishedReadError)
    const repeating: PublishedSemanticReadView = {
      listStatements: async () => [statement(0)],
      listRuleVersions: async () => [],
    }
    await expect(readAllPublishedStatements(repeating, scope, ctx, {}, { pageSize: 1, maxRecords: 3 }))
      .rejects.toMatchObject({ code: 'INCOMPLETE_PUBLISHED_READ' })
  })
})
