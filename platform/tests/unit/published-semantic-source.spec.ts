import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  IdentityPublishedBindingSnapshot,
  PublishedRuleVersion,
  PublishedStatement,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import {
  PublishedSemanticSource,
  RuleEvaluator,
} from '@ontology/semantic-engine'
import type { PublishedSemanticReadView } from '@ontology/semantic-engine'
import { toolContext } from './component-registry-fixtures'

const scopeRef: ScopeRef = {
  tenantId: '11111111-2222-4333-8444-555555555555',
  spaceId: '99999999-8888-4777-8666-555555555555',
}
const ctx = toolContext(scopeRef.tenantId, scopeRef.spaceId, ['platform-admin'])
const schemaRef: VersionRef = {
  id: 'schema.facility',
  version: '1.0.0',
  digest: `sha256:${'a'.repeat(64)}`,
}

function statement(overrides: Partial<PublishedStatement> = {}): PublishedStatement {
  const statementId = randomUUID()
  return {
    statementId,
    propositionKey: `${statementId}.attributes`,
    kind: 'entity',
    objectId: 'facility',
    subjectEntityId: `entity:${statementId}`,
    predicate: 'facility',
    value: { attributes: [{ attributeId: 'inspection_due', value: true }] },
    recordedAt: '2026-09-20T00:00:00Z',
    sourceCandidateId: randomUUID(),
    sourceRefs: [],
    publicationId: randomUUID(),
    version: '1',
    status: 'active',
    ...overrides,
  }
}

function rule(publicationId: string): PublishedRuleVersion {
  return {
    ruleVersionId: randomUUID(),
    ruleId: 'facility.maintenance',
    version: '1',
    objectId: 'facility',
    severity: 'soft',
    impact: 'low',
    expression: {
      op: 'compare',
      attributeId: 'inspection_due',
      operator: 'eq',
      value: true,
      spans: [],
    },
    exceptions: [],
    recordedAt: '2026-09-20T00:00:00Z',
    sourceCandidateId: randomUUID(),
    publicationId,
  }
}

class ReadView implements PublishedSemanticReadView {
  readonly #statements: readonly PublishedStatement[]
  readonly #rules: readonly PublishedRuleVersion[]
  readonly #publicationIds: ReadonlySet<string>

  constructor(statements: readonly PublishedStatement[], rules: readonly PublishedRuleVersion[] = []) {
    this.#statements = statements
    this.#rules = rules
    this.#publicationIds = new Set([
      ...statements.map((row) => row.publicationId),
      ...rules.map((row) => row.publicationId),
    ])
  }

  async latestReadRevision(_scope: ScopeRef, _ctx: ToolContext): Promise<string> {
    void _scope
    void _ctx
    return '1'
  }

  async getPublication(_scope: ScopeRef, publicationId: string, _ctx: ToolContext): Promise<{ readonly schemaRef: VersionRef } | undefined> {
    void _scope
    void _ctx
    return this.#publicationIds.has(publicationId) ? { schemaRef: { ...schemaRef } } : undefined
  }

  async listStatements(
    _scope: ScopeRef,
    filter: { readonly afterStatementId?: string; readonly limit?: number },
    _ctx: ToolContext,
  ): Promise<PublishedStatement[]> {
    void _scope
    void _ctx
    return this.#statements
      .filter((row) => filter.afterStatementId === undefined || row.statementId > filter.afterStatementId)
      .sort((left, right) => left.statementId.localeCompare(right.statementId))
      .slice(0, filter.limit ?? 1_000)
  }

  async listRuleVersions(
    _scope: ScopeRef,
    filter: { readonly afterRule?: { readonly ruleId: string; readonly version: string }; readonly limit?: number },
    _ctx: ToolContext,
  ): Promise<PublishedRuleVersion[]> {
    void _scope
    void _ctx
    return this.#rules
      .filter((row) => filter.afterRule === undefined || row.ruleId > filter.afterRule.ruleId ||
        (row.ruleId === filter.afterRule.ruleId && BigInt(row.version) > BigInt(filter.afterRule.version)))
      .sort((left, right) => {
        const idOrder = left.ruleId.localeCompare(right.ruleId)
        if (idOrder !== 0) return idOrder
        const leftVersion = BigInt(left.version)
        const rightVersion = BigInt(right.version)
        return leftVersion < rightVersion ? -1 : leftVersion > rightVersion ? 1 : 0
      })
      .slice(0, filter.limit ?? 1_000)
  }
}

function identityStore(entitiesByCandidate: ReadonlyMap<string, string>) {
  return {
    async latestReadRevision(_scope: ScopeRef, _ctx: ToolContext): Promise<string> {
      void _scope
      void _ctx
      return '1'
    },
    async readPublishedBindings(
      _scope: ScopeRef,
      candidateIds: readonly string[],
      _ctx: ToolContext,
    ): Promise<IdentityPublishedBindingSnapshot> {
      void _scope
      void _ctx
      return {
        readRevision: '1',
        complete: true,
        bindings: candidateIds.map((candidateId) => {
          const entityId = entitiesByCandidate.get(candidateId)
          return {
            candidateId,
            openAssertions: entityId === undefined ? [] : [{
              assertionId: randomUUID(),
              candidateId,
              entityId,
              objectId: 'facility',
              identityScopeId: 'facility_identity',
              decisionId: randomUUID(),
              validFrom: '2026-09-20T00:00:00Z',
              recordedAt: '2026-09-20T00:00:00Z',
            }],
            cannotLinkEntityIds: [],
          }
        }),
      }
    },
  }
}

function confirmedIdentityRows(rows: readonly PublishedStatement[]): Map<string, string> {
  return new Map(rows.map((row) => [row.sourceCandidateId, row.subjectEntityId ?? '']))
}

describe('PublishedSemanticSource', () => {
  it('deduplicates equal schema pins by full version identity across publications', async () => {
    const first = statement()
    const second = statement({ publicationId: randomUUID() })
    const source = new PublishedSemanticSource(new ReadView([first, second]), {
      identity: identityStore(confirmedIdentityRows([first, second])),
    })

    const data = await source.load(scopeRef, ctx)

    expect(data.definitionRef).toEqual(schemaRef)
    expect(data.facts).toHaveLength(2)
    expect(data.issues?.some((issue) => issue.code === 'DEFINITION_PIN_REQUIRED')).toBe(false)
    expect(data.complete).toBe(true)
  })

  it('keeps one unknown rule instance for an entity with no attributes', async () => {
    const row = statement({ value: { attributes: [] } })
    const publishedRule = rule(row.publicationId)
    const source = new PublishedSemanticSource(new ReadView([row], [publishedRule]), {
      identity: identityStore(confirmedIdentityRows([row])),
    })

    const data = await source.load(scopeRef, ctx)
    const evaluated = new RuleEvaluator().evaluate({
      scopeRef,
      request: { scopeRef, projectionRef: schemaRef, validAt: '2026-09-28T00:00:00Z' },
      definitionRef: schemaRef,
      facts: data.facts,
      rules: data.rules,
    })

    expect(data.facts).toEqual([])
    expect(data.rules).toHaveLength(1)
    expect(evaluated.applicabilities).toHaveLength(1)
    expect(evaluated.applicabilities[0]?.state).toBe('unknown')
  })

  it('marks a published statement with an unconfirmed identity incomplete and excludes it from support', async () => {
    const row = statement()
    const publishedRule = rule(row.publicationId)
    const source = new PublishedSemanticSource(new ReadView([row], [publishedRule]), {
      identity: identityStore(new Map()),
    })

    const data = await source.load(scopeRef, ctx)
    const evaluated = new RuleEvaluator().evaluate({
      scopeRef,
      request: { scopeRef, projectionRef: schemaRef, validAt: '2026-09-28T00:00:00Z' },
      definitionRef: schemaRef,
      facts: data.facts,
      rules: data.rules,
    })

    expect(data.complete).toBe(false)
    expect(data.facts).toEqual([])
    expect(data.issues?.some((issue) => issue.code === 'PUBLISHED_IDENTITY_UNCONFIRMED')).toBe(true)
    expect(data.rules).toHaveLength(1)
    expect(evaluated.applicabilities[0]?.state).toBe('unknown')
  })

  it('keeps business conclusions unknown when the published rule is not applicable', async () => {
    const row = statement({ value: { attributes: [{ attributeId: 'inspection_due', value: false }] } })
    const publishedRule = {
      ...rule(row.publicationId),
      conclusion: { predicate: 'inspection_due', value: true },
    }
    const source = new PublishedSemanticSource(new ReadView([row], [publishedRule]), {
      identity: identityStore(confirmedIdentityRows([row])),
    })

    const data = await source.load(scopeRef, ctx)
    const evaluated = new RuleEvaluator().evaluate({
      scopeRef,
      request: { scopeRef, projectionRef: schemaRef, validAt: '2026-09-28T00:00:00Z' },
      definitionRef: schemaRef,
      facts: data.facts,
      rules: data.rules,
    })
    const businessConclusion = evaluated.conclusions.find((entry) => entry.predicate === 'inspection_due')

    expect(data.rules).toHaveLength(2)
    expect(evaluated.applicabilities).toHaveLength(1)
    expect(evaluated.applicabilities[0]?.state).toBe('not_applicable')
    expect(businessConclusion?.domainStatus).toBe('unknown')
    expect(businessConclusion?.value).toBeUndefined()
  })

  it('emits the reviewed business conclusion only when its explicit premise is supported', async () => {
    const row = statement({ value: { attributes: [{ attributeId: 'inspection_due', value: true }] } })
    const publishedRule = {
      ...rule(row.publicationId),
      conclusion: { predicate: 'inspection_due', value: true },
    }
    const source = new PublishedSemanticSource(new ReadView([row], [publishedRule]), {
      identity: identityStore(confirmedIdentityRows([row])),
    })

    const data = await source.load(scopeRef, ctx)
    const evaluated = new RuleEvaluator().evaluate({
      scopeRef,
      request: { scopeRef, projectionRef: schemaRef, validAt: '2026-09-28T00:00:00Z' },
      definitionRef: schemaRef,
      facts: data.facts,
      rules: data.rules,
    })
    const businessConclusion = evaluated.conclusions.find((entry) => entry.predicate === 'inspection_due')

    expect(evaluated.applicabilities).toHaveLength(1)
    expect(evaluated.applicabilities[0]?.state).toBe('applicable')
    expect(businessConclusion).toMatchObject({ predicate: 'inspection_due', domainStatus: 'known', value: true })
  })
})
