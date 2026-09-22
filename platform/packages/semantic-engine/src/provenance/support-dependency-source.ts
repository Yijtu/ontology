import type {
  EvidenceDependencyEdge,
  EvidenceRecord,
  PublishedRuleVersion,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { RuleEvaluationError, RuleEvaluator } from '../rules'
import type { RuleConclusionResult, RuleFact, SupportRule } from '../rules'
import { ruleFactsFromStatements, supportRuleFromPublishedRule } from '../rules'
import type { PublishedSemanticReadView } from '../materialization'

/**
 * Evidence dependencies derived from the real compact support DAG (SPEC D5/D4, US-022,
 * FR-30).
 *
 * An evidence item carries two kinds of real dependency:
 *
 *  - **lineage** — the evidence-to-evidence edges already recorded on its envelope; and
 *  - **support** — the premises of the compact rule support DAG (LOCAL-032) that produced a
 *    rule-derivation evidence, resolved to the evidence ids that published the supporting
 *    facts.
 *
 * The ontology *type* graph (objects and `RelationDefinition`s) is a different graph: a
 * type-level relation between concepts is not evidence that one conclusion rests on another.
 * This source never reads a `SemanticDefinitionVersion`, and the support DAG compiler rejects
 * a `relation` premise, so a schema relation can never surface as an evidence dependency
 * (SPEC D4, §9).
 */

const PROJECTION_REF: VersionRef = {
  id: 'projection.provenance',
  version: '1.0.0',
  digest: `sha256:${'0'.repeat(64)}`,
}

const DEFAULT_PAGE_SIZE = 1_000

export interface SupportEvidenceDependencySourceDependencies {
  /** The official published read view (LOCAL-031); never the candidate store. */
  readonly published: PublishedSemanticReadView
  readonly evaluator?: RuleEvaluator
  readonly pageSize?: number
}

function compareRevision(left: RevisionString, right: RevisionString): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left < right ? -1 : left > right ? 1 : 0
}

function latestRules(
  versions: readonly PublishedRuleVersion[],
  facts: readonly RuleFact[],
): SupportRule[] {
  const latest = new Map<string, PublishedRuleVersion>()
  for (const version of versions) {
    const existing = latest.get(version.ruleId)
    if (existing === undefined || compareRevision(version.version, existing.version) > 0) {
      latest.set(version.ruleId, version)
    }
  }
  const rules: SupportRule[] = []
  for (const version of [...latest.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId))) {
    try {
      rules.push(supportRuleFromPublishedRule(version, facts))
    } catch (error) {
      // A rule outside the declarative subset (for example a `relation` premise) has no
      // support DAG and therefore contributes no evidence dependency; it is skipped rather
      // than weakening the traversal into a permissive one.
      if (!(error instanceof RuleEvaluationError)) throw error
    }
  }
  return rules
}

export class SupportEvidenceDependencySource {
  readonly #published: PublishedSemanticReadView
  readonly #evaluator: RuleEvaluator
  readonly #pageSize: number

  constructor(dependencies: SupportEvidenceDependencySourceDependencies) {
    this.#published = dependencies.published
    this.#evaluator = dependencies.evaluator ?? new RuleEvaluator()
    this.#pageSize = dependencies.pageSize ?? DEFAULT_PAGE_SIZE
  }

  async dependenciesOf(
    scopeRef: ScopeRef,
    evidence: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<readonly EvidenceDependencyEdge[]> {
    const envelope = evidence.envelope
    const root = evidence.evidenceRef.id
    const edges: EvidenceDependencyEdge[] = envelope.dependencies.map((dependency) => ({
      fromEvidenceId: root,
      toEvidenceId: dependency.evidenceRef.id,
      relation: dependency.relation,
      origin: 'lineage',
      ...(dependency.premiseGroup === undefined ? {} : { premiseGroup: dependency.premiseGroup }),
    }))
    const ruleRef = envelope.producedBy.ruleRef
    if (ruleRef === undefined) return edges

    const support = await this.#supportEdges(scopeRef, root, ruleRef, envelope.recordedSeq, envelope.validity?.validFrom ?? envelope.observedAt, ctx)
    return [...edges, ...support]
  }

  async #supportEdges(
    scopeRef: ScopeRef,
    root: Uuid,
    ruleRef: VersionRef,
    recordedSeq: RevisionString | undefined,
    validAt: string,
    ctx: ToolContext,
  ): Promise<EvidenceDependencyEdge[]> {
    const statements = await this.#published.listStatements(scopeRef, { limit: this.#pageSize }, ctx)
    const facts = ruleFactsFromStatements(statements)
    const versions = await this.#published.listRuleVersions(scopeRef, { limit: this.#pageSize }, ctx)
    const rules = latestRules(versions, facts)
    if (rules.length === 0) return []

    let conclusions: readonly RuleConclusionResult[]
    try {
      const result = this.#evaluator.evaluate({
        scopeRef,
        request: {
          scopeRef,
          projectionRef: PROJECTION_REF,
          ...(recordedSeq === undefined ? {} : { asOfRecordedSeq: recordedSeq }),
          validAt,
        },
        facts,
        rules,
      })
      conclusions = result.conclusions
    } catch (error) {
      if (!(error instanceof RuleEvaluationError)) throw error
      return []
    }

    const target = conclusions.find((conclusion) =>
      conclusion.ruleRefs.some((ref) => ref.id === ruleRef.id && ref.version === ruleRef.version),
    )
    if (target === undefined) return []

    const evidenceByStatement = new Map<string, readonly Uuid[]>()
    for (const statement of statements) {
      const ids = statement.sourceRefs.filter((ref) => ref.kind === 'evidence').map((ref) => ref.id)
      if (ids.length > 0) evidenceByStatement.set(statement.statementId, ids)
    }
    const rule = rules.find((candidate) => candidate.ruleId === ruleRef.id)

    const edges: EvidenceDependencyEdge[] = []
    for (const group of target.satisfiedBy) {
      const premiseGroup = rule?.premiseGroups.find((candidate) => candidate.groupId === group.groupId)
      for (const alternativeId of group.alternativeIds) {
        const alternative = premiseGroup?.alternatives.find(
          (candidate) => candidate.alternativeId === alternativeId,
        )
        const assertionId = alternative?.assertionId ?? alternativeId
        for (const evidenceId of evidenceByStatement.get(assertionId) ?? []) {
          edges.push({
            fromEvidenceId: root,
            toEvidenceId: evidenceId,
            relation: 'derives_from',
            origin: 'support',
            premiseGroup: group.groupId,
          })
        }
      }
    }
    return edges
  }
}
