import type {
  PublishedRuleVersion,
  PublishedExecutableRule,
  RuleExpressionNode,
  RuleProvenanceSpan,
  ScopeRef,
  SemanticFilter,
  SemanticDefinitionVersion,
  VersionRef,
  RuleDependencyReference,
} from '@ontology/contracts'
import { assertRuleDependencyShape, relationPremisesFromDefinition } from '@ontology/contracts'
import { validateRuleSupport } from './support'
import { sha256DigestOf } from '../definitions/canonical'
import { RuleEvaluationError } from './errors'
import { publishedRuleRef, publishedRuleDependencyRef, publishedRuleConsequenceKey, publishedRuleApplicabilityKey } from './dependencies'
import { isRuleDecimalValue, isRuleScalarDecimalValue } from './values'
import { validateRuleConclusionBinding } from '@ontology/core'
import { projectIndustrySchema } from '../definitions/industry-schema'
import type {
  CompiledPublishedRuleInstance,
  PublishedRuleCompilation,
  PublishedRuleSubject,
  RuleCapabilityIssue,
  RuleConditionPlan,
  RuleFact,
  RulePremiseAlternative,
  RulePremiseGroup,
  RuleRelationReadCompleteness,
  SupportRule,
} from './types'

interface CompiledCondition {
  readonly groups: RulePremiseGroup[]
  readonly plan: RuleConditionPlan
}

export interface PublishedRuleCompilerOptions {
  readonly projectId?: string
  readonly scopeRef: ScopeRef
  readonly definitionRef: VersionRef
  /** Confirmed entity instances in this read scope; rule.objectId is matched exactly. */
  readonly subjects: readonly PublishedRuleSubject[]
  /** Quantity unit completeness comes from the pinned schema, never guessed by the compiler. */
  readonly completeRangeAttributeIds?: readonly string[]
  /** Immutable authoritative definition, whose ref must exactly match definitionRef. */
  readonly definition?: SemanticDefinitionVersion
  /** Complete closed-world relation coverage is an explicit proof, never inferred from pagination. */
  readonly relationCompleteness?: readonly RuleRelationReadCompleteness[]
}

type PredicateFacts = ReadonlyMap<string, readonly RuleFact[]>

interface RelationCompilationContext {
  readonly subject: PublishedRuleSubject
  readonly attributeFactsByInstance: ReadonlyMap<string, PredicateFacts>
  readonly relationFactsByInstance: ReadonlyMap<string, PredicateFacts>
  readonly declarations: ReturnType<typeof relationPremisesFromDefinition>
  readonly definitionRef: VersionRef
  readonly scopeRef: ScopeRef
  readonly completeness: readonly RuleRelationReadCompleteness[]
}

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
  if ((rule.ruleDependencies?.length ?? 0) > 0 || (rule.dependencyRefs?.length ?? 0) > 0) {
    throw new RuleEvaluationError('INVALID_RULE', 'legacy helper cannot preserve fixed published dependency/entity scope; use compilePublishedRuleInstances')
  }
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
  const compiled = compileNode(rule.expression, predicateFactsOf(scopedFacts), rule.ruleId, false, new Set())
  return {
    ruleRef: legacyRuleRef(rule),
    ruleId: rule.ruleId,
    premiseGroups: compiled.groups,
    condition: compiled.plan,
    conclusion: { propositionKey: rule.objectId, predicate: rule.objectId, value: true },
  }
}

/**
 * Compile each published rule for each confirmed subject of its declared object type. A bad rule
 * becomes a typed issue on that rule/subject; other instances remain available for evaluation.
 * The synthetic conclusion key names rule applicability, not an industry action or business fact.
 */
export function compilePublishedRuleInstances(
  rules: readonly PublishedExecutableRule[],
  facts: readonly RuleFact[],
  options: PublishedRuleCompilerOptions,
): PublishedRuleCompilation {
  const instances: CompiledPublishedRuleInstance[] = []
  const issues: RuleCapabilityIssue[] = []
  const dependencyRules: SupportRule[] = []
  const subjects = dedupeSubjects(options.subjects.filter((subject) => subject.projectId === options.projectId))
  const dependencyLookups = new Map<string, Map<string, readonly string[]>>()
  for (const rule of rules) {
    if (rule.projectId !== options.projectId) continue
    let lookup = dependencyLookups.get(rule.objectId)
    if (lookup === undefined) { lookup = new Map(); dependencyLookups.set(rule.objectId, lookup) }
    lookup.set(rule.ruleId, rule.ruleDependencies ?? [])
  }
  const completeRangeAttributeIds = new Set(options.completeRangeAttributeIds ?? [])
  const factsByInstance = new Map<string, Map<string, RuleFact[]>>()
  const relationFactsByInstance = new Map<string, Map<string, RuleFact[]>>()
  for (const fact of facts) {
    if (fact.projectId !== options.projectId) continue
    const instanceKey = factInstanceKey(fact.subject, fact.objectId, fact.schemaRef)
    const index = fact.relation === undefined ? factsByInstance : relationFactsByInstance
    let byPredicate = index.get(instanceKey)
    if (byPredicate === undefined) {
      byPredicate = new Map()
      index.set(instanceKey, byPredicate)
    }
    const predicateFacts = byPredicate.get(fact.predicate)
    if (predicateFacts === undefined) byPredicate.set(fact.predicate, [fact])
    else predicateFacts.push(fact)
  }

  for (const rule of [...rules].sort((left, right) =>
    `${left.ruleId}@${left.version}:${left.ruleVersionId}`.localeCompare(`${right.ruleId}@${right.version}:${right.ruleVersionId}`),
  )) {
    if (rule.projectId !== options.projectId) continue
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
    const declarations = options.definition !== undefined &&
      options.definition.scopeRef.tenantId === options.scopeRef.tenantId && options.definition.scopeRef.spaceId === options.scopeRef.spaceId &&
      factInstanceKey('', '', options.definition.ref) === factInstanceKey('', '', options.definitionRef)
      ? relationPremisesFromDefinition(options.definition, rule.expression).filter((declaration) => declaration.fromObjectId === rule.objectId) : []
    const support = validateRuleSupport({ ruleId: rule.ruleId, condition: rule.expression, exceptions: rule.exceptions, relationPremises: declarations,
      ruleDependencies: rule.ruleDependencies ?? [], dependencyLookup: dependencyLookups.get(rule.objectId) ?? new Map() })
    if (!support.executable) {
      issues.push({ ruleId: rule.ruleId, ruleVersionId: rule.ruleVersionId, publishedRevision: rule.version, ruleRef, objectId: rule.objectId, code: support.findings.some((finding) => finding.code === 'RULE_DEPENDENCY_CYCLE') ? 'CYCLE_DETECTED' : support.findings.some((finding) => finding.code === 'RULE_DEPENDENCY_DEPTH') ? 'DEPENDENCY_DEPTH_EXCEEDED' : support.findings.some((finding) => finding.code === 'UNSUPPORTED_NEGATION' || finding.code === 'UNSUPPORTED_EXCEPTION') ? 'UNSUPPORTED_NEGATION' : 'UNSUPPORTED_FILTER', message: support.findings.map((finding) => finding.message).join('; '), sourceSpans })
      continue
    }
    let refs: readonly RuleDependencyReference[]
    try {
      if ([rule.validFrom, rule.validTo].some((value) => value !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value)))) ||
        rule.validFrom !== undefined && rule.validTo !== undefined && Date.parse(rule.validTo) <= Date.parse(rule.validFrom)) throw new RuleEvaluationError('INVALID_RULE', 'published rule validity must be a nonempty UTC interval')
      refs = checkedDependencies(rule, rules, options)
    } catch (error) {
      if (!(error instanceof RuleEvaluationError)) throw error
      issues.push({ ruleId: rule.ruleId, ruleVersionId: rule.ruleVersionId, publishedRevision: rule.version, ruleRef, objectId: rule.objectId, code: error.code, message: error.message, sourceSpans })
      continue
    }
    const applicableSubjects = subjects.filter((subject) => subject.objectId === rule.objectId && subject.projectId === options.projectId)
    for (const ref of refs) {
      if (!rules.some((upstream) => upstream.projectId === options.projectId && upstream.ruleId === ref.ruleId && sameRef(publishedRuleRef(upstream), ref.ruleRef))) {
        issues.push({ ruleId: rule.ruleId, ruleVersionId: rule.ruleVersionId, publishedRevision: rule.version, ruleRef, objectId: rule.objectId, code: 'UNRESOLVED_DEPENDENCY', message: `fixed upstream ${ref.ruleId}@${ref.ruleRef.version} is no longer current; retain unknown support`, sourceSpans })
      }
    }
    if (applicableSubjects.length === 0) {
      try {
        compileNode(rule.expression, NO_FACTS, rule.ruleId, true, completeRangeAttributeIds, {
          subject: { subjectEntityId: '', objectId: rule.objectId }, attributeFactsByInstance: factsByInstance, relationFactsByInstance,
          declarations, definitionRef: options.definitionRef, scopeRef: options.scopeRef, completeness: [],
        })
        for (const exception of rule.exceptions) {
          const compiled = compileNode(exception.condition, NO_FACTS, `${rule.ruleId}:exception:${exception.exceptionId}`, true, completeRangeAttributeIds)
          if (compiled.groups.length !== 1 || compiled.groups[0]?.polarity === 'negative') {
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
        ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      }
      const instanceKey = `rule-instance:${sha256DigestOf(instanceIdentity)}`
      const applicabilityKey = publishedRuleApplicabilityKey(instanceIdentity)
      const sourceSpans = spansOf(rule.expression, rule.exceptions.map((exception) => exception.condition))
      try {
        const compiledCondition = compileNode(
          rule.expression,
          scopedFacts,
          instanceKey,
          true,
          completeRangeAttributeIds,
          { subject, attributeFactsByInstance: factsByInstance, relationFactsByInstance, declarations, definitionRef: options.definitionRef, scopeRef: options.scopeRef, completeness: options.relationCompleteness ?? [] },
        )
        const conditionGroups = bindDependencyGroups(compiledCondition.groups, refs, subject.subjectEntityId)
        const conditionGroupIds = conditionGroups.map((group) => group.groupId)
        const premiseGroups: RulePremiseGroup[] = [...conditionGroups]
        const exceptions: { exceptionId: string; groupIds: string[] }[] = []
        for (const exception of [...rule.exceptions].sort((left, right) => left.exceptionId.localeCompare(right.exceptionId))) {
          const compiledException = compileNode(
            exception.condition,
            scopedFacts,
            `${instanceKey}:exception:${exception.exceptionId}`,
            true,
            completeRangeAttributeIds,
          )
          const exceptionGroups = bindDependencyGroups(compiledException.groups, refs, subject.subjectEntityId)
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
          ...(rule.validFrom === undefined ? {} : { validFrom: new Date(rule.validFrom).toISOString() }),
          ...(rule.validTo === undefined ? {} : { validTo: new Date(rule.validTo).toISOString() }),
          ...('publishedPackRef' in rule ? { publishedPackRef: rule.publishedPackRef } : {}),
          ...(refs.length === 0 ? {} : { dependencyRefs: refs }),
          ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
        } as const
        const supportRule: SupportRule = {
          ruleRef,
          ruleId: instanceKey,
          premiseGroups,
          condition: compiledCondition.plan,
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
        if (validConclusion(rule, options) && rule.conclusion !== undefined) {
          const ref = publishedRuleDependencyRef(rule, options.scopeRef, options.definitionRef)
          dependencyRules.push({ ...supportRule, ruleId: `${instanceKey}:dependency-consequence`,
            publishedInstance: { ...metadata, emitApplicabilityArtifact: false },
            conclusion: { propositionKey: publishedRuleConsequenceKey(ref, subject.subjectEntityId), predicate: ref.predicate, value: rule.conclusion.value } })
        }
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
    dependencyRules: dependencyRules.sort((left, right) => left.ruleId.localeCompare(right.ruleId)),
    issues: issues.sort((left, right) =>
      `${left.ruleId}@${left.subjectEntityId ?? ''}`.localeCompare(`${right.ruleId}@${right.subjectEntityId ?? ''}`),
    ),
  }
}

function dedupeSubjects(subjects: readonly PublishedRuleSubject[]): PublishedRuleSubject[] {
  const byKey = new Map<string, PublishedRuleSubject>()
  for (const subject of subjects) byKey.set(`${subject.projectId ?? ''}\u0000${subject.objectId}\u0000${subject.subjectEntityId}`, subject)
  return [...byKey.values()].sort((left, right) =>
    left.objectId.localeCompare(right.objectId) || left.subjectEntityId.localeCompare(right.subjectEntityId),
  )
}

function sameRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function validConclusion(rule: PublishedExecutableRule, options?: PublishedRuleCompilerOptions): boolean {
  const binding = rule.conclusion
  if (binding !== undefined && options?.definition !== undefined && validateRuleConclusionBinding(binding, rule.objectId, projectIndustrySchema(options.definition)).reason !== undefined) return false
  return binding !== undefined && typeof binding.predicate === 'string' && binding.predicate.length > 0 &&
    (typeof binding.value === 'boolean' || typeof binding.value === 'string' || isRuleDecimalValue(binding.value) || isRuleScalarDecimalValue(binding.value))
}

function checkedDependencies(rule: PublishedExecutableRule, rules: readonly PublishedExecutableRule[], options: PublishedRuleCompilerOptions): readonly RuleDependencyReference[] {
  const refs = rule.dependencyRefs ?? []
  try { assertRuleDependencyShape(rule.ruleDependencies ?? [], refs) } catch (error) {
    throw new RuleEvaluationError('INVALID_RULE', `rule ${rule.ruleId} has no exact dependency pins`, { cause: error })
  }
  const attributes = expressionAttributeIds(rule.expression)
  for (const exception of rule.exceptions) for (const id of expressionAttributeIds(exception.condition)) attributes.add(id)
  for (const ref of refs) {
    if (ref.scopeRef.tenantId !== options.scopeRef.tenantId || ref.scopeRef.spaceId !== options.scopeRef.spaceId ||
      !sameRef(ref.definitionRef, options.definitionRef) || ref.objectId !== rule.objectId || ref.projectId !== options.projectId) {
      throw new RuleEvaluationError('SCOPE_MISMATCH', `dependency ${ref.ruleId} must bind the same project, object and definition`)
    }
    if (!attributes.has(ref.predicate)) throw new RuleEvaluationError('INVALID_RULE', `dependency ${ref.ruleId} is not consumed by the preserved condition`)
    if ('publishedPackRef' in rule ? ref.publishedPackRef !== undefined && !sameRef(ref.publishedPackRef, rule.publishedPackRef) : ref.publishedPackRef !== undefined) {
      throw new RuleEvaluationError('INVALID_RULE', 'dependencies must bind one exact publication origin and version')
    }
    const upstream = rules.find((candidate) => candidate.ruleVersionId === ref.ruleRef.id && candidate.projectId === options.projectId)
    if (upstream !== undefined && ('publishedPackRef' in rule ? !('publishedPackRef' in upstream) || !sameRef(rule.publishedPackRef, upstream.publishedPackRef) : 'publishedPackRef' in upstream)) {
      throw new RuleEvaluationError('INVALID_RULE', 'upstream dependency must retain the same exact publication origin/version')
    }
    if (upstream !== undefined && sameRef(publishedRuleRef(upstream), ref.ruleRef) &&
      (upstream.ruleId !== ref.ruleId || upstream.objectId !== ref.objectId || upstream.conclusion?.predicate !== ref.predicate || !validConclusion(upstream))) {
      throw new RuleEvaluationError('INVALID_RULE', `dependency ${ref.ruleId} does not name its reviewed consequence`)
    }
  }
  return 'publishedPackRef' in rule ? refs.map((ref) => ({ ...ref, publishedPackRef: rule.publishedPackRef })) : refs
}

function bindDependencyGroups(groups: readonly RulePremiseGroup[], refs: readonly RuleDependencyReference[], subjectId: string): RulePremiseGroup[] {
  return groups.map((group) => {
    const dependencies = refs.filter((ref) => ref.predicate === group.filter.fieldRef)
    if (dependencies.length === 0 || group.relation !== undefined) return group
    if (group.polarity === 'negative') throw new RuleEvaluationError('UNSUPPORTED_NEGATION', 'a derived dependency cannot be negated as an explicit observation')
    return { ...group, alternatives: dependencies.map((ref) => ({ alternativeId: `${ref.ruleId}:${ref.ruleRef.id}`, propositionKey: publishedRuleConsequenceKey(ref, subjectId) })) }
  })
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
  relationContext?: RelationCompilationContext,
): CompiledCondition {
  switch (node.op) {
    case 'compare': {
      const group = leafGroup(
        node.attributeId,
        { fieldRef: node.attributeId, op: node.operator, values: [node.value] },
        facts,
        `${prefix}:${node.attributeId}`,
        node.unitCode,
      )
      return { groups: [group], plan: { kind: 'leaf', leaf: group.groupId } }
    }
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
      const group = leafGroup(fieldRef, filter, facts, `${prefix}:${fieldRef}`, node.unitCode)
      return { groups: [group], plan: { kind: 'leaf', leaf: group.groupId } }
    }
    case 'all': {
      const children = node.operands.map((operand, index) =>
        compileNode(operand, facts, `${prefix}.${String(index)}`, allowExplicitNot, completeRangeAttributeIds, relationContext),
      )
      return {
        groups: children.flatMap((child) => child.groups),
        plan: { kind: 'all', children: children.map((child) => child.plan) },
      }
    }
    case 'any': {
      // A genuine different-condition OR: every branch keeps its own groups and sub-plan. Two
      // different conditions are never merged into one same-filter equivalent-source group.
      const children = node.operands.map((operand, index) =>
        compileNode(operand, facts, `${prefix}.${String(index)}`, allowExplicitNot, completeRangeAttributeIds, relationContext),
      )
      return {
        groups: children.flatMap((child) => child.groups),
        plan: { kind: 'any', children: children.map((child) => child.plan) },
      }
    }
    case 'not': {
      if (!allowExplicitNot) {
        throw new RuleEvaluationError(
          'UNSUPPORTED_NEGATION',
          `rule ${prefix} uses an explicit negation the compatibility compiler cannot represent`,
        )
      }
      const operand = compileNode(node.operand, facts, `${prefix}:not`, false, completeRangeAttributeIds)
      const group = operand.groups[0]
      if (operand.groups.length !== 1 || group === undefined || group.polarity === 'negative') {
        throw new RuleEvaluationError(
          'UNSUPPORTED_NEGATION',
          `not at ${prefix} must cover one observed comparison, range or same-condition any`,
        )
      }
      const completeRange = completeRangeAttributeIds.has(group.filter.fieldRef)
      const negative: RulePremiseGroup = {
        ...group,
        groupId: `${prefix}:not`,
        polarity: 'negative',
        explicitObservation: true,
        ...(completeRange ? { completeRange: true } : {}),
      }
      return { groups: [negative], plan: { kind: 'leaf', leaf: negative.groupId } }
    }
    case 'relation': {
      const declaration = relationContext?.declarations.find((entry) => entry.relationId === node.relationId)
      if (declaration === undefined || relationContext === undefined) {
        throw new RuleEvaluationError('UNSUPPORTED_FILTER', `relation ${node.relationId} needs the pinned definition and scoped published edges`)
      }
      const edges = relationContext.relationFactsByInstance.get(factInstanceKey(relationContext.subject.subjectEntityId, declaration.fromObjectId, relationContext.definitionRef))?.get(node.relationId) ?? []
      const targets = new Map<string, CompiledCondition>()
      const branches = edges.filter((fact) =>
        fact.relation?.relationId === node.relationId && fact.subject === relationContext.subject.subjectEntityId &&
        fact.objectId === declaration.fromObjectId && fact.relation.targetObjectId === declaration.toObjectId &&
        factInstanceKey('', '', fact.schemaRef) === factInstanceKey('', '', relationContext.definitionRef),
      ).map((edge) => {
        const targetFacts = edge.relation?.targetEntityId === undefined ? NO_FACTS : relationContext.attributeFactsByInstance.get(factInstanceKey(edge.relation.targetEntityId, declaration.toObjectId, relationContext.definitionRef)) ?? NO_FACTS
        const targetId = edge.relation?.targetEntityId ?? `unresolved:${edge.assertionId}`
        let target = targets.get(targetId)
        if (target === undefined && declaration.targetCondition !== undefined) {
          target = compileNode(declaration.targetCondition, targetFacts, `${prefix}:target:${targetId}`, false, completeRangeAttributeIds)
          targets.set(targetId, target)
        }
        return {
          edge: { alternativeId: edge.assertionId, assertionId: edge.assertionId },
          endpointResolved: edge.relation?.endpointResolved === true,
          ...(target === undefined ? {} : { targetKey: targetId }),
        }
      })
      const targetGroups = [...targets.values()].flatMap((target) => target.groups)
      const targetConditions = [...targets].map(([targetKey, target]) => ({ targetKey, groupIds: target.groups.map((group) => group.groupId), condition: target.plan }))
      const alternatives = [...branches.map((branch) => branch.edge), ...targetGroups.flatMap((group) => group.alternatives)]
      const proof = relationContext.completeness.find((entry) =>
        entry.scopeRef.tenantId === relationContext.scopeRef.tenantId && entry.scopeRef.spaceId === relationContext.scopeRef.spaceId &&
        entry.subjectEntityId === relationContext.subject.subjectEntityId && entry.relationId === node.relationId &&
        factInstanceKey('', '', entry.definitionRef) === factInstanceKey('', '', relationContext.definitionRef))
      const group: RulePremiseGroup = {
        groupId: `${prefix}:relation:${node.relationId}`,
        filter: { fieldRef: node.relationId, op: 'eq', values: [true] },
        alternatives: alternatives.length === 0 ? [{ alternativeId: `unmatched:relation:${node.relationId}`, assertionId: `unmatched:relation:${node.relationId}` }] : [...new Map(alternatives.map((alternative) => [alternative.alternativeId, alternative])).values()],
        relation: { relationId: node.relationId, ...(proof === undefined ? {} : { completeness: { validAt: proof.validAt, asOfRecordedSeq: proof.asOfRecordedSeq } }), targetGroups, targetConditions, branches },
      }
      return { groups: [group], plan: { kind: 'leaf', leaf: group.groupId } }
    }
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
        break
      case 'relation':
        if (node.targetCondition !== undefined) visit(node.targetCondition)
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
