import type {
  PublishedRuleFilter,
  PublishedRuleVersion,
  PublishedStatement,
  PublishedStatementFilter,
  RevisionString,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'
import type { SupportRule } from '../rules'
import { ruleFactsFromStatements, supportRuleFromPublishedRule } from '../rules'
import type { DependencyEntityBinding } from './dependency-index'
import type { MaterializationPublishedSource, PublishedSemanticData } from './types'

/**
 * The narrow published read view the source needs. `SemanticPublicationStore` (LOCAL-031)
 * satisfies it structurally, so the production composition passes the real store and the source
 * never imports an adapter.
 */
export interface PublishedSemanticReadView {
  listStatements(
    scopeRef: ScopeRef,
    filter: PublishedStatementFilter,
    ctx: ToolContext,
  ): Promise<PublishedStatement[]>
  listRuleVersions(
    scopeRef: ScopeRef,
    filter: PublishedRuleFilter,
    ctx: ToolContext,
  ): Promise<PublishedRuleVersion[]>
}

const DEFAULT_PAGE_SIZE = 1_000

function compareRevision(left: RevisionString, right: RevisionString): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Adapt the official published read view into the evaluator's fact/rule model (SPEC D5, C3/C4).
 *
 * Published rule versions are deduplicated by `ruleId` keeping the newest version, so a revised
 * rule is evaluated once. Facts keep the exact published `recordedSeq` (`version`) and status, so
 * a retracted statement becomes a tombstone and a correction is a new version of the same
 * logical assertion.
 */
export class PublishedSemanticSource implements MaterializationPublishedSource {
  readonly #readView: PublishedSemanticReadView
  readonly #pageSize: number

  constructor(readView: PublishedSemanticReadView, pageSize = DEFAULT_PAGE_SIZE) {
    this.#readView = readView
    this.#pageSize = pageSize
  }

  async load(scopeRef: ScopeRef, ctx: ToolContext): Promise<PublishedSemanticData> {
    const statements = await this.#readView.listStatements(scopeRef, { limit: this.#pageSize }, ctx)
    const facts = ruleFactsFromStatements(statements)
    const versions = await this.#readView.listRuleVersions(scopeRef, { limit: this.#pageSize }, ctx)
    const latestByRule = new Map<string, PublishedRuleVersion>()
    for (const version of versions) {
      const existing = latestByRule.get(version.ruleId)
      if (existing === undefined || compareRevision(version.version, existing.version) > 0) {
        latestByRule.set(version.ruleId, version)
      }
    }
    const rules: SupportRule[] = [...latestByRule.values()]
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId))
      .map((version) => supportRuleFromPublishedRule(version, facts))
    const entityBindings: DependencyEntityBinding[] = []
    for (const statement of statements) {
      if (statement.subjectEntityId === undefined) continue
      entityBindings.push({ entityId: statement.subjectEntityId, logicalAssertionId: statement.statementId })
    }
    return { facts, rules, entityBindings }
  }
}
