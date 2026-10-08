import type { PublishedExecutableRule, RuleDependencyReference, ScopeRef, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import { RuleEvaluationError } from './errors'

/** The immutable published rule pin used by computation and reviewed dependency references. */
export function publishedRuleRef(rule: PublishedExecutableRule): VersionRef {
  if ('publishedPackRef' in rule) return rule.ruleRef
  if (!/^(?:0|[1-9]\d*)$/.test(rule.version)) throw new RuleEvaluationError('INVALID_RULE', 'published rule revision is not canonical')
  return { id: rule.ruleVersionId, version: `${rule.version}.0.0`, digest: sha256DigestOf(rule) }
}

export function publishedRuleConsequenceKey(ref: RuleDependencyReference, subjectEntityId: string): string {
  return `rule-consequence:${sha256DigestOf({ ...ref, subjectEntityId })}`
}

export function publishedRuleDependencyRef(rule: PublishedExecutableRule, scopeRef: ScopeRef, definitionRef: VersionRef): RuleDependencyReference {
  if (rule.conclusion === undefined) throw new RuleEvaluationError('INVALID_RULE', 'a dependency must name an explicitly reviewed business conclusion')
  return { ruleId: rule.ruleId, ruleRef: publishedRuleRef(rule), scopeRef, definitionRef, objectId: rule.objectId, predicate: rule.conclusion.predicate,
    ...(rule.projectId === undefined ? {} : { projectId: rule.projectId }), ...('publishedPackRef' in rule ? { publishedPackRef: rule.publishedPackRef } : {}) }
}
