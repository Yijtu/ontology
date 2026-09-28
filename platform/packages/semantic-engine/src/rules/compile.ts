import type {
  PublishedRuleVersion,
  RuleExpressionNode,
  RuleProvenanceSpan,
  ScopeRef,
  SemanticFilter,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import { RuleEvaluationError } from './errors'
import type {
  CompiledPublishedRuleInstance,
  PublishedRuleCompilation,
  PublishedRuleSubject,
  RuleCapabilityIssue,
  RuleFact,
  RulePremiseAlternative,
  RulePremiseGroup,
  SupportRule,
} from './types'

export interface PublishedRuleCompilerOptions {
  readonly scopeRef: ScopeRef
  readonly definitionRef: VersionRef
  /** Confirmed entity instances in this read scope; rule.objectId is matched exactly. */
  readonly subjects: readonly PublishedRuleSubject[]
  /** Quantity unit completeness comes from the pinned schema, never guessed by the compiler. */
  readonly completeRangeAttributeIds?: readonly string[]
}

type PredicateFacts = ReadonlyMap<string, readonly RuleFact[]>

const NO_FACTS: PredicateFacts = new Map()

/**
 * Legacy compiler retained for callers that need the original one-rule interface. New published
 * reads should use compilePublishedRuleInstances, which binds facts to one entity and preserves
 * exceptions and per-rule capability issues.
 */
export function supportRuleFromPublishedRule(
  rule: PublishedRuleVersion,
  facts: readonly RuleFact[],
): SupportRule {
  if (rule.exceptions.length > 0) {
    throw new RuleEvaluationError(
      'UNSUPPORTED_NEGATION',
      `legacy helper cannot preserve the attached exceptions for ${rule.ruleId}; use compilePublishedRuleInstances`,
    )
  }
  const premiseAttributeIds = expressionAttributeIds(rule.expression)
  const relevantFacts = facts.filter(
    (fact) =>
      premiseAttributeIds.has(fact.attributeId ?? fact.predicate) &&
      (fact.objectId === undefined || fact.objectId === rule.objectId) &&
      fact.subject.length > 0,
  )
  const subjectIds = new Set(relevantFacts.map((fact) => fact.subject))
  if (subjectIds.size > 1) {
    throw new RuleEvaluationError(
      'INVALID_ARGUMENT',
      `legacy helper cannot safely instantiate ${rule.ruleId} for multiple subjects; use compilePublishedRuleInstances`,
    )
  }
  const [subjectId] = subjectIds
  const scopedFacts =
    subjectId === undefined
      ? []
      : relevantFacts.filter((fact) => fact.subject === subjectId && (fact.objectId === undefined || fact.objectId === rule.objectId))
  const groups = compileNode(rule.expression, predicateFactsOf(scopedFacts), rule.ruleId, false, new Set())
  return {
    ruleRef: legacyRuleRef(rule),
    ruleId: rule.ruleId,
    premiseGroups: groups,
    conclusion: { propositionKey: rule.objectId, predicate: rule.objectId, value: true },
  }
}

/**
 * Compile each published rule for each confirmed subject of its declared object type. A bad rule
 * becomes a typed issue on that rule/subject; other instances remain available for evaluation.
 * The synthetic conclusion key names rule applicability, not an industry action or business fact.
 */
export function compilePublishedRuleInstances(
  rules: readonly PublishedRuleVersion[],
  facts: readonly RuleFact[],
  options: PublishedRuleCompilerOptions,
): PublishedRuleCompilation {
  const instances: CompiledPublishedRuleInstance[] = []
  const issues: RuleCapabilityIssue[] = []
  const subjects = dedupeSubjects(options.subjects)
  const completeRangeAttributeIds = new Set(options.completeRangeAttributeIds ?? [])
  const factsByInstance = new Map<string, Map<string, RuleFact[]>>()
  for (const fact of facts) {
    const instanceKey = factInstanceKey(fact.subject, fact.objectId, fact.schemaRef)
    let byPredicate = factsByInstance.get(instanceKey)
    if (byPredicate === undefined) {
      byPredicate = new Map()
      factsByInstance.set(instanceKey, byPredicate)
    }
    const predicateFacts = byPredicate.get(fact.predicate)
    if (predicateFacts === undefined) byPredicate.set(fact.predicate, [fact])
    else predicateFacts.push(fact)
  }

  for (const rule of [...rules].sort((left, right) =>
    `${left.ruleId}@${left.version}:${left.ruleVersionId}`.localeCompare(`${right.ruleId}@${right.version}:${right.ruleVersionId}`),
  )) {
    const sourceSpans = spansOf(rule.expression, rule.exceptions.map((exception) => exception.condition))
    let ruleRef: VersionRef
    try {
      ruleRef = publishedRuleRef(rule)
    } catch (error) {
      if (!(error instanceof RuleEvaluationError)) throw error
      issues.push({
        ruleId: rule.ruleId,
        ruleVersionId: rule.ruleVersionId,
        publishedRevision: rule.version,
        objectId: rule.objectId,
        code: error.code,
        message: error.message,
        sourceSpans,
      })
      continue
    }
    const applicableSubjects = subjects.filter((subject) => subject.objectId === rule.objectId)
    if (applicableSubjects.length === 0) {
      try {
        compileNode(rule.expression, NO_FACTS, rule.ruleId, true, completeRangeAttributeIds)
        for (const exception of rule.exceptions) {
          const groups = compileNode(exception.condition, NO_FACTS, `${rule.ruleId}:exception:${exception.exceptionId}`, true, completeRangeAttributeIds)
          if (groups.length !== 1 || groups[0]?.polarity === 'negative') {
            throw new RuleEvaluationError(
              'UNSUPPORTED_NEGATION',
              `exception ${exception.exceptionId} must be one explicit comparison, range or same-condition any`,
            )
          }
        }
      } catch (error) {
        if (!(error instanceof RuleEvaluationError)) throw error
        issues.push({
          ruleId: rule.ruleId,
          ruleVersionId: rule.ruleVersionId,
          publishedRevision: rule.version,
          ruleRef,
          objectId: rule.objectId,
          code: error.code,
          message: error.message,
          sourceSpans,
        })
      }
      continue
    }
    for (const subject of applicableSubjects) {
      const scopedFacts = factsByInstance.get(
        factInstanceKey(subject.subjectEntityId, subject.objectId, options.definitionRef),
      ) ?? NO_FACTS
      const instanceIdentity = {
        tenantId: options.scopeRef.tenantId,
        spaceId: options.scopeRef.spaceId,
        definitionRef: options.definitionRef,
        ruleRef,
        objectId: rule.objectId,
        subjectEntityId: subject.subjectEntityId,
      }
      const instanceKey = `rule-instance:${sha256DigestOf(instanceIdentity)}`
      const applicabilityKey = `rule-applicability:${sha256DigestOf(instanceIdentity)}`
      const sourceSpans = spansOf(rule.expression, rule.exceptions.map((exception) => exception.condition))
      try {
        const conditionGroups = compileNode(
          rule.expression,
          scopedFacts,
          instanceKey,
          true,
          completeRangeAttributeIds,
        )
        const conditionGroupIds = conditionGroups.map((group) => group.groupId)
        const premiseGroups: RulePremiseGroup[] = [...conditionGroups]
        const exceptions: { exceptionId: string; groupIds: string[] }[] = []
        for (const exception of [...rule.exceptions].sort((left, right) => left.exceptionId.localeCompare(right.exceptionId))) {
          const exceptionGroups = compileNode(
            exception.condition,
            scopedFacts,
            `${instanceKey}:exception:${exception.exceptionId}`,
            true,
            completeRangeAttributeIds,
          )
          if (exceptionGroups.length !== 1 || exceptionGroups[0]?.polarity === 'negative') {
            throw new RuleEvaluationError(
              'UNSUPPORTED_NEGATION',
              `exception ${exception.exceptionId} must be one explicit comparison, range or same-condition any`,
            )
          }
          const exceptionGroup = exceptionGroups[0]
          if (exceptionGroup === undefined) {
            throw new RuleEvaluationError('UNSUPPORTED_NEGATION', `exception ${exception.exceptionId} is empty`)
          }
          const completeRange = completeRangeAttributeIds.has(exceptionGroup.filter.fieldRef)
          const groupId = `${instanceKey}:exception:${exception.exceptionId}`
          premiseGroups.push({
            ...exceptionGroup,
            groupId,
            polarity: 'negative',
            explicitObservation: true,
            ...(completeRange ? { completeRange: true } : {}),
          })
          exceptions.push({ exceptionId: exception.exceptionId, groupIds: [groupId] })
        }

        const metadata = {
          ruleId: rule.ruleId,
          ruleVersionId: rule.ruleVersionId,
          publishedRevision: rule.version,
          ruleRef,
          scopeRef: options.scopeRef,
          definitionRef: options.definitionRef,
          instanceKey,
          objectId: rule.objectId,
          subjectEntityId: subject.subjectEntityId,
          propositionKey: applicabilityKey,
          predicate: 'rule.applicability',
          conditionGroupIds,
          exceptions,
          sourceSpans,
        } as const
        const supportRule: SupportRule = {
          ruleRef,
          ruleId: instanceKey,
          premiseGroups,
          conclusion: { propositionKey: applicabilityKey, predicate: 'rule.applicability', value: true },
          publishedInstance: metadata,
        }
        instances.push({
          supportRule,
          ruleRef,
          ruleId: rule.ruleId,
          ruleVersionId: rule.ruleVersionId,
          publishedRevision: rule.version,
          instanceKey,
          objectId: rule.objectId,
          subjectEntityId: subject.subjectEntityId,
          propositionKey: applicabilityKey,
          predicate: 'rule.applicability',
        })
      } catch (error) {
        if (!(error instanceof RuleEvaluationError)) throw error
        issues.push({
          ruleId: rule.ruleId,
          ruleVersionId: rule.ruleVersionId,
          publishedRevision: rule.version,
          ruleRef,
          objectId: rule.objectId,
          subjectEntityId: subject.subjectEntityId,
          code: error.code,
          message: error.message,
          sourceSpans,
        })
      }
    }
  }

  return {
    instances: instances.sort((left, right) => left.instanceKey.localeCompare(right.instanceKey)),
    issues: issues.sort((left, right) =>
      `${left.ruleId}@${left.subjectEntityId ?? ''}`.localeCompare(`${right.ruleId}@${right.subjectEntityId ?? ''}`),
    ),
  }
}

function dedupeSubjects(subjects: readonly PublishedRuleSubject[]): PublishedRuleSubject[] {
  const byKey = new Map<string, PublishedRuleSubject>()
  for (const subject of subjects) byKey.set(`${subject.objectId}\u0000${subject.subjectEntityId}`, subject)
  return [...byKey.values()].sort((left, right) =>
    left.objectId.localeCompare(right.objectId) || left.subjectEntityId.localeCompare(right.subjectEntityId),
  )
}

function publishedRuleRef(rule: PublishedRuleVersion): VersionRef {
  return { id: rule.ruleVersionId, version: semverRevision(rule.version), digest: sha256DigestOf(rule) }
}

function legacyRuleRef(rule: PublishedRuleVersion): VersionRef {
  return { id: rule.ruleId, version: semverRevision(rule.version), digest: sha256DigestOf(rule) }
}

function semverRevision(revision: string): string {
  if (!/^(?:0|[1-9]\d*)$/.test(revision)) {
    throw new RuleEvaluationError(
      'INVALID_RULE',
      `published rule revision ${revision} is not a canonical non-negative integer and cannot be serialized as SemVer`,
    )
  }
  return `${revision}.0.0`
}

function expressionAttributeIds(expression: RuleExpressionNode): Set<string> {
  const attributes = new Set<string>()
  const visit = (node: RuleExpressionNode): void => {
    switch (node.op) {
      case 'compare':
      case 'range':
        attributes.add(node.attributeId)
        break
      case 'all':
      case 'any':
        node.operands.forEach(visit)
        break
      case 'not':
        visit(node.operand)
        break
      case 'relation':
        break
      default:
        break
    }
  }
  visit(expression)
  return attributes
}

function factInstanceKey(subjectId: string, objectId: string | undefined, schemaRef: VersionRef | undefined): string {
  return JSON.stringify([
    subjectId,
    objectId ?? null,
    schemaRef?.id ?? null,
    schemaRef?.version ?? null,
    schemaRef?.digest ?? null,
  ])
}

function predicateFactsOf(facts: readonly RuleFact[]): PredicateFacts {
  const byPredicate = new Map<string, RuleFact[]>()
  for (const fact of facts) {
    const bucket = byPredicate.get(fact.predicate)
    if (bucket === undefined) byPredicate.set(fact.predicate, [fact])
    else bucket.push(fact)
  }
  return byPredicate
}

function alternativesFor(attributeId: string, facts: PredicateFacts): RulePremiseAlternative[] {
  const alternatives = (facts.get(attributeId) ?? [])
    .map((fact) => ({ alternativeId: fact.assertionId, assertionId: fact.assertionId }))
  if (alternatives.length > 0) return alternatives
  const placeholder = `unmatched:${attributeId}`
  return [{ alternativeId: placeholder, assertionId: placeholder }]
}

function leafGroup(
  attributeId: string,
  filter: SemanticFilter,
  facts: PredicateFacts,
  groupId: string,
  unitCode?: string,
): RulePremiseGroup {
  return {
    groupId,
    filter,
    alternatives: alternativesFor(attributeId, facts),
    ...(unitCode === undefined ? {} : { unitCode }),
  }
}

function compileNode(
  node: RuleExpressionNode,
  facts: PredicateFacts,
  prefix: string,
  allowExplicitNot: boolean,
  completeRangeAttributeIds: ReadonlySet<string>,
): RulePremiseGroup[] {
  switch (node.op) {
    case 'compare':
      return [
        leafGroup(
          node.attributeId,
          { fieldRef: node.attributeId, op: node.operator, values: [node.value] },
          facts,
          `${prefix}:${node.attributeId}`,
          node.unitCode,
        ),
      ]
    case 'range': {
      const fieldRef = node.attributeId
      let filter: SemanticFilter
      if (node.min !== undefined && node.max !== undefined) {
        filter = { fieldRef, op: 'between', values: [node.min, node.max] }
      } else if (node.min !== undefined) {
        filter = { fieldRef, op: 'gte', values: [node.min] }
      } else if (node.max !== undefined) {
        filter = { fieldRef, op: 'lte', values: [node.max] }
      } else {
        throw new RuleEvaluationError('UNSUPPORTED_FILTER', `range of ${fieldRef} declares neither a minimum nor a maximum`)
      }
      return [leafGroup(fieldRef, filter, facts, `${prefix}:${fieldRef}`, node.unitCode)]
    }
    case 'all':
      return node.operands.flatMap((operand, index) =>
        compileNode(operand, facts, `${prefix}.${String(index)}`, allowExplicitNot, completeRangeAttributeIds),
      )
    case 'any': {
      const lowered = node.operands.map((operand, index) =>
        compileNode(operand, facts, `${prefix}.${String(index)}`, allowExplicitNot, completeRangeAttributeIds),
      )
      const single = lowered.map((groups) => {
        const first = groups[0]
        if (first === undefined || groups.length !== 1 || first.polarity === 'negative') {
          throw new RuleEvaluationError(
            'UNSUPPORTED_FILTER',
            `any operand of ${prefix} is not a single positive comparison and cannot be merged into one OR group`,
          )
        }
        return first
      })
      const [head, ...rest] = single
      if (head === undefined) throw new RuleEvaluationError('UNSUPPORTED_FILTER', `any of ${prefix} has no operand`)
      const signature = JSON.stringify({ filter: head.filter, unitCode: head.unitCode ?? null })
      for (const group of rest) {
        if (JSON.stringify({ filter: group.filter, unitCode: group.unitCode ?? null }) !== signature) {
          throw new RuleEvaluationError(
            'UNSUPPORTED_FILTER',
            `any of ${prefix} mixes conditions that one equivalent-source OR group cannot express`,
          )
        }
      }
      const alternatives = new Map<string, RulePremiseAlternative>()
      for (const group of single) {
        for (const alternative of group.alternatives) alternatives.set(alternative.alternativeId, alternative)
      }
      return [
        {
          groupId: `${prefix}:any`,
          filter: head.filter,
          ...(head.unitCode === undefined ? {} : { unitCode: head.unitCode }),
          alternatives: [...alternatives.values()].sort((left, right) => left.alternativeId.localeCompare(right.alternativeId)),
        },
      ]
    }
    case 'not': {
      if (!allowExplicitNot) {
        throw new RuleEvaluationError(
          'UNSUPPORTED_NEGATION',
          `rule ${prefix} uses an explicit negation the compatibility compiler cannot represent`,
        )
      }
      const operandGroups = compileNode(node.operand, facts, `${prefix}:not`, false, completeRangeAttributeIds)
      const group = operandGroups[0]
      if (operandGroups.length !== 1 || group === undefined || group.polarity === 'negative') {
        throw new RuleEvaluationError(
          'UNSUPPORTED_NEGATION',
          `not at ${prefix} must cover one observed comparison, range or same-condition any`,
        )
      }
      const completeRange = completeRangeAttributeIds.has(group.filter.fieldRef)
      return [
        {
          ...group,
          groupId: `${prefix}:not`,
          polarity: 'negative',
          explicitObservation: true,
          ...(completeRange ? { completeRange: true } : {}),
        },
      ]
    }
    case 'relation':
      throw new RuleEvaluationError(
        'UNSUPPORTED_FILTER',
        `rule ${prefix} uses a relation premise the declarative subset cannot represent`,
      )
    default:
      throw new RuleEvaluationError('UNSUPPORTED_FILTER', `rule ${prefix} uses an unknown expression node`)
  }
}

function spansOf(
  expression: RuleExpressionNode,
  exceptionExpressions: readonly RuleExpressionNode[],
): RuleProvenanceSpan[] {
  const spans: RuleProvenanceSpan[] = []
  const visit = (node: RuleExpressionNode): void => {
    spans.push(...node.spans)
    switch (node.op) {
      case 'all':
      case 'any':
        node.operands.forEach(visit)
        break
      case 'not':
        visit(node.operand)
        break
      case 'compare':
      case 'range':
      case 'relation':
        break
      default:
        break
    }
  }
  visit(expression)
  exceptionExpressions.forEach(visit)
  const unique = new Map<string, RuleProvenanceSpan>()
  for (const span of spans) unique.set(`${span.parseId}:${span.chunkId}:${span.quoteDigest}`, span)
  return [...unique.values()].sort((left, right) =>
    `${left.parseId}:${left.chunkId}:${left.quoteDigest}`.localeCompare(
      `${right.parseId}:${right.chunkId}:${right.quoteDigest}`,
    ),
  )
}
