import type { RuleComputationArtifact, RuleConclusionBinding } from '@ontology/contracts'
import type { RuleApplicabilityResult, SupportRule } from '../rules'

function businessBindingFor(
  instanceKey: string,
  rules: readonly SupportRule[],
): RuleConclusionBinding | undefined {
  const rule = rules.find((candidate) => {
    const instance = candidate.publishedInstance
    return instance?.instanceKey === instanceKey &&
      (candidate.conclusion.propositionKey !== instance.propositionKey || candidate.conclusion.predicate !== instance.predicate)
  })
  const predicate = rule?.conclusion.predicate
  const value = rule?.conclusion.value
  return rule !== undefined && predicate !== undefined && value !== undefined
    ? { predicate, value }
    : undefined
}

/** Map evaluator output into the stable contract consumed by evidence and verification. */
export function ruleComputationArtifactOf(
  result: RuleApplicabilityResult,
  rules: readonly SupportRule[],
): RuleComputationArtifact {
  const businessConclusion = businessBindingFor(result.instanceKey, rules)
  return {
    schemaVersion: 'rule-computation-artifact@1',
    scopeRef: result.scopeRef,
    definitionRef: result.definitionRef,
    ruleRef: result.ruleRef,
    ruleId: result.ruleId,
    ruleVersionId: result.ruleVersionId,
    publishedRevision: result.publishedRevision,
    instanceKey: result.instanceKey,
    objectId: result.objectId,
    subjectEntityId: result.subjectEntityId,
    predicate: result.predicate,
    ...(result.validAt === undefined ? {} : { validAt: result.validAt }),
    ...(result.asOfRecordedSeq === undefined ? {} : { asOfRecordedSeq: result.asOfRecordedSeq }),
    applicability: {
      state: result.state,
      conditionState: result.conditionState,
      exceptionStates: result.exceptionStates.map((exception) => ({
        exceptionId: exception.exceptionId,
        state: exception.state,
        factRefs: exception.factRefs.map((fact) => ({ ...fact })),
      })),
      positiveSupport: result.positiveSupport,
    },
    factRefs: result.factRefs.map((fact) => ({ ...fact })),
    sourceStatementIds: [...result.sourceStatementIds],
    ...(businessConclusion === undefined ? {} : { businessConclusion }),
    inputDigest: result.inputDigest,
    computationDigest: result.computationDigest,
    sourceSpans: result.sourceSpans.map((span) => ({ ...span })),
    complete: result.complete,
    ...(result.publishedPackRef === undefined ? {} : { publishedPackRef: result.publishedPackRef }),
    ...(result.dependencyRefs === undefined ? {} : { dependencyRefs: result.dependencyRefs }),
    ...(result.projectId === undefined ? {} : { projectId: result.projectId }),
  }
}

/** One stable artifact per rule instance even while its consequence uses a second support rule. */
export function ruleComputationArtifactsOf(
  results: readonly RuleApplicabilityResult[],
  rules: readonly SupportRule[],
): RuleComputationArtifact[] {
  const byInstance = new Map<string, RuleApplicabilityResult>()
  for (const result of results) byInstance.set(result.instanceKey, result)
  return [...byInstance.values()]
    .map((result) => ruleComputationArtifactOf(result, rules))
    .sort((left, right) => left.instanceKey.localeCompare(right.instanceKey))
}
