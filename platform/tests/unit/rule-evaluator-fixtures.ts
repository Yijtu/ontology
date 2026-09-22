import type { ControlReadProjectionRequest } from '@ontology/contracts'
import type { RuleEvaluationInput, RuleFact, SupportRule } from '@ontology/semantic-engine'
import type { SemanticFixture } from '../fixtures/semantic/loader'

/**
 * Adapt a LOCAL-048 spec-driven fixture into the LOCAL-032 evaluator input. The fixture stays
 * the gold corpus: this adapter only re-shapes declarations, it never derives an expected value.
 */
export function ruleFactsFromFixture(fixture: SemanticFixture): RuleFact[] {
  return fixture.assertions.map((assertion) => ({
    assertionId: assertion.assertionId,
    logicalAssertionId: assertion.logicalAssertionId,
    recordedSeq: assertion.recordedSeq,
    op: assertion.op,
    subject: assertion.subject,
    predicate: assertion.predicate,
    validity: assertion.validity,
    sourceRef: assertion.sourceRef,
    ...(assertion.value === undefined ? {} : { value: assertion.value }),
    ...(assertion.evidenceId === undefined ? {} : { evidenceId: assertion.evidenceId }),
  }))
}

export function supportRulesFromFixture(fixture: SemanticFixture): SupportRule[] {
  return fixture.rules.map((rule) => ({
    ruleRef: rule.ruleRef,
    ruleId: rule.ruleId,
    premiseGroups: rule.premiseGroups.map((group) => ({
      groupId: group.groupId,
      filter: group.filter,
      alternatives: group.alternatives.map((alternative) => ({
        alternativeId: alternative.alternativeId,
        assertionId: alternative.assertionId,
      })),
    })),
    conclusion: {
      propositionKey: rule.conclusion.propositionKey,
      ...(rule.conclusion.predicate === undefined ? {} : { predicate: rule.conclusion.predicate }),
      ...(rule.conclusion.value === undefined ? {} : { value: rule.conclusion.value }),
    },
  }))
}

export function ruleInputFromFixture(
  fixture: SemanticFixture,
  request: ControlReadProjectionRequest,
): RuleEvaluationInput {
  return {
    scopeRef: fixture.scopeRef,
    request,
    facts: ruleFactsFromFixture(fixture),
    rules: supportRulesFromFixture(fixture),
  }
}
