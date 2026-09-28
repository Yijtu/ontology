import type { DomainResultStatus, Sha256Digest } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import { RuleEvaluationError } from './errors'
import { conclusionQualifiedKey, factQualifiedKey } from './proposition'
import { assertSupportedFilter, evaluateFilter, isRuleDecimalValue } from './values'
import type {
  RuleAssertionValue,
  RuleConclusionResult,
  RuleConflictResult,
  RuleEvaluationInput,
  RuleEvaluationResult,
  RuleFact,
  RuleFactRef,
  RuleApplicabilityResult,
  RuleConditionState,
  RuleExceptionState,
  RulePremiseAlternative,
  RulePremiseGroup,
  RuleSatisfiedBy,
  SupportGraph,
  SupportGroupNode,
  SupportLeafNode,
  SupportNode,
  SupportNodeState,
  SupportRule,
  SupportRuleNode,
} from './types'

/** The outcome of one premise alternative or group. */
type Outcome = SupportNodeState

/** Why a logical assertion has no single active fact at the requested view. */
type ResolutionReason = 'active' | 'retracted' | 'not_visible' | 'not_covered' | 'conflict'

interface LogicalResolution {
  readonly reason: ResolutionReason
  readonly predicate: string
  readonly active?: RuleFact
  /** A visible latest tombstone or out-of-range version that explains an unknown premise. */
  readonly latest?: RuleFact
  /** The contradictory versions of one logical assertion, present only for `conflict`. */
  readonly conflicting?: readonly RuleFact[]
}

interface RuleOutcome {
  readonly state: Outcome
  readonly value?: RuleAssertionValue
  readonly satisfiedBy: readonly RuleSatisfiedBy[]
  readonly factRefs: readonly RuleFactRef[]
  readonly groupNodes: readonly SupportGroupNode[]
  readonly leafNodes: readonly SupportLeafNode[]
  readonly groupStates: ReadonlyMap<string, Outcome>
  readonly groupFactRefs: ReadonlyMap<string, readonly RuleFactRef[]>
  readonly observedFactRefs: readonly RuleFactRef[]
}

interface EvaluationState {
  readonly activeByLogical: ReadonlyMap<string, LogicalResolution>
  readonly factsById: ReadonlyMap<string, RuleFact>
  readonly conflictedAssertions: ReadonlySet<string>
  readonly derived: Map<string, readonly RuleOutcome[]>
  readonly leaves: Map<string, SupportLeafNode>
  readonly groups: Map<string, SupportGroupNode>
  readonly rules: Map<string, SupportRuleNode>
  readonly conclusions: Map<string, { state: Outcome; ruleNodeIds: Set<string> }>
}

const REFUTED_VALUE = false

function covers(fact: RuleFact, validAt: string | undefined): boolean {
  if (validAt === undefined) return true
  if (fact.validity.validFrom > validAt) return false
  const validTo = fact.validity.validTo
  return validTo === undefined || validAt < validTo
}

function recordedSeqOf(fact: RuleFact): number {
  const parsed = Number(fact.recordedSeq)
  return Number.isFinite(parsed) ? parsed : 0
}

function latestFact(facts: readonly RuleFact[]): RuleFact | undefined {
  let latest: RuleFact | undefined
  for (const fact of facts) {
    if (latest === undefined || recordedSeqOf(fact) > recordedSeqOf(latest)) latest = fact
  }
  return latest
}

function resolveLogicalAssertions(
  facts: readonly RuleFact[],
  asOfRecordedSeq: string | undefined,
  validAt: string | undefined,
): Map<string, LogicalResolution> {
  const byLogical = new Map<string, RuleFact[]>()
  for (const fact of facts) {
    const bucket = byLogical.get(fact.logicalAssertionId)
    if (bucket === undefined) byLogical.set(fact.logicalAssertionId, [fact])
    else bucket.push(fact)
  }
  const asOf = asOfRecordedSeq === undefined ? undefined : Number(asOfRecordedSeq)
  const resolved = new Map<string, LogicalResolution>()
  for (const [logicalId, versions] of byLogical) {
    const predicate = versions[0]?.predicate ?? logicalId
    const visible =
      asOf === undefined || !Number.isFinite(asOf)
        ? versions
        : versions.filter((fact) => recordedSeqOf(fact) <= asOf)
    if (visible.length === 0) {
      resolved.set(logicalId, { reason: 'not_visible', predicate })
      continue
    }
    const covering = visible.filter((fact) => covers(fact, validAt))
    if (covering.length === 0) {
      const latest = latestFact(visible)
      resolved.set(logicalId, {
        reason: latest?.op === 'retract' ? 'retracted' : 'not_covered',
        predicate,
        ...(latest === undefined ? {} : { latest }),
      })
      continue
    }
    const latest = latestFact(covering)
    if (latest === undefined || latest.op === 'retract') {
      resolved.set(logicalId, { reason: 'retracted', predicate, ...(latest === undefined ? {} : { latest }) })
      continue
    }
    if (latest.op === 'correct') {
      resolved.set(logicalId, { reason: 'active', predicate, active: latest })
      continue
    }
    // Latest is a plain assertion. Two independent assertions of the same logical proposition
    // that disagree are a single-valued conflict, not a "latest wins" overwrite (D5).
    const asserted = covering.filter((fact) => fact.op !== 'retract')
    if (distinctValues(asserted).length > 1) {
      resolved.set(logicalId, { reason: 'conflict', predicate, conflicting: asserted })
      continue
    }
    resolved.set(logicalId, { reason: 'active', predicate, active: latest })
  }
  return resolved
}

function distinctValues(facts: readonly RuleFact[]): RuleAssertionValue[] {
  const seen = new Map<string, RuleAssertionValue>()
  for (const fact of facts) {
    if (fact.value === undefined) continue
    const key = JSON.stringify(fact.value)
    if (!seen.has(key)) seen.set(key, fact.value)
  }
  return [...seen.values()]
}

function conflictOf(qualifiedKey: string, facts: readonly RuleFact[]): RuleConflictResult {
  return {
    propositionKey: facts[0]?.predicate ?? qualifiedKey,
    qualifiedPropositionKey: qualifiedKey,
    assertionIds: facts.map((fact) => fact.assertionId).sort(),
    values: distinctValues(facts).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  }
}

function detectConflicts(
  resolved: ReadonlyMap<string, LogicalResolution>,
  scopeRef: RuleEvaluationInput['scopeRef'],
): RuleConflictResult[] {
  const conflicts = new Map<string, RuleConflictResult>()
  // A single logical assertion that received two disagreeing assertions.
  for (const resolution of resolved.values()) {
    const conflicting = resolution.conflicting
    const first = conflicting?.[0]
    if (resolution.reason !== 'conflict' || conflicting === undefined || first === undefined) continue
    const key = factQualifiedKey(first, scopeRef)
    conflicts.set(key, conflictOf(key, conflicting))
  }
  // Independent logical assertions that assert the same qualified proposition differently.
  const grouped = new Map<string, RuleFact[]>()
  for (const resolution of resolved.values()) {
    if (resolution.active === undefined) continue
    const key = factQualifiedKey(resolution.active, scopeRef)
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [resolution.active])
    else bucket.push(resolution.active)
  }
  for (const [qualifiedKey, group] of grouped) {
    if (conflicts.has(qualifiedKey)) continue
    if (distinctValues(group).length <= 1) continue
    conflicts.set(qualifiedKey, conflictOf(qualifiedKey, group))
  }
  return [...conflicts.values()].sort((left, right) => left.propositionKey.localeCompare(right.propositionKey))
}

function factRefOf(fact: RuleFact): RuleFactRef {
  return {
    assertionId: fact.assertionId,
    logicalAssertionId: fact.logicalAssertionId,
    recordedSeq: fact.recordedSeq,
    digest: sha256DigestOf({
      assertionId: fact.assertionId,
      logicalAssertionId: fact.logicalAssertionId,
      recordedSeq: fact.recordedSeq,
      predicate: fact.predicate,
      value: fact.value ?? null,
      validity: fact.validity,
      sourceStatementId: fact.sourceStatementId ?? null,
      sourceRefs: fact.sourceRefs ?? [],
      schemaRef: fact.schemaRef ?? null,
    }),
    ...(fact.sourceStatementId === undefined ? {} : { sourceStatementId: fact.sourceStatementId }),
    ...(fact.sourceRefs === undefined ? {} : { sourceRefs: fact.sourceRefs }),
  }
}

function validateRule(rule: SupportRule): void {
  if (rule.premiseGroups.length === 0) {
    throw new RuleEvaluationError('INVALID_RULE', `rule ${rule.ruleId} has no premise group`)
  }
  const groupIds = new Set<string>()
  for (const group of rule.premiseGroups) {
    if (groupIds.has(group.groupId)) {
      throw new RuleEvaluationError('INVALID_RULE', `rule ${rule.ruleId} repeats premise group ${group.groupId}`)
    }
    groupIds.add(group.groupId)
    if (group.alternatives.length === 0) {
      throw new RuleEvaluationError('INVALID_RULE', `premise group ${group.groupId} has no alternative`)
    }
    if (
      (group.polarity ?? 'positive') === 'negative' &&
      group.completeRange !== true &&
      group.explicitObservation !== true
    ) {
      throw new RuleEvaluationError(
        'UNSUPPORTED_NEGATION',
        `premise group ${group.groupId} negates a condition without an explicit observation or complete range`,
      )
    }
    if (group.unitCode !== undefined && group.unitCode.length === 0) {
      throw new RuleEvaluationError('INVALID_RULE', `premise group ${group.groupId} has an empty unitCode`)
    }
    assertSupportedFilter(group.filter, `premise group ${group.groupId}`)
    const alternativeIds = new Set<string>()
    for (const alternative of group.alternatives) {
      if (alternativeIds.has(alternative.alternativeId)) {
        throw new RuleEvaluationError(
          'INVALID_RULE',
          `premise group ${group.groupId} repeats alternative ${alternative.alternativeId}`,
        )
      }
      alternativeIds.add(alternative.alternativeId)
      const hasAssertion = alternative.assertionId !== undefined
      const hasProposition = alternative.propositionKey !== undefined
      if (hasAssertion === hasProposition) {
        throw new RuleEvaluationError(
          'INVALID_RULE',
          `alternative ${alternative.alternativeId} must name exactly one of assertionId or propositionKey`,
        )
      }
    }
  }
}

/**
 * Order rules so a rule that references another rule's conclusion is evaluated after it. A
 * dependency cycle (including self-support) is rejected: a cyclic justification must never be
 * allowed to manufacture support for itself (D5).
 */
function topologicalOrder(rules: readonly SupportRule[]): SupportRule[] {
  const byRuleId = new Map<string, SupportRule>()
  const byConclusion = new Map<string, string[]>()
  for (const rule of rules) {
    byRuleId.set(rule.ruleId, rule)
    const owners = byConclusion.get(rule.conclusion.propositionKey)
    if (owners === undefined) byConclusion.set(rule.conclusion.propositionKey, [rule.ruleId])
    else owners.push(rule.ruleId)
  }

  const dependencies = new Map<string, Set<string>>()
  const dependents = new Map<string, Set<string>>()
  for (const rule of rules) {
    const deps = new Set<string>()
    for (const group of rule.premiseGroups) {
      for (const alternative of group.alternatives) {
        if (alternative.propositionKey === undefined) continue
        for (const owner of byConclusion.get(alternative.propositionKey) ?? []) deps.add(owner)
      }
    }
    dependencies.set(rule.ruleId, deps)
    for (const dep of deps) {
      const bucket = dependents.get(dep)
      if (bucket === undefined) dependents.set(dep, new Set([rule.ruleId]))
      else bucket.add(rule.ruleId)
    }
  }

  const indegree = new Map<string, number>()
  for (const rule of rules) indegree.set(rule.ruleId, dependencies.get(rule.ruleId)?.size ?? 0)
  const queue = rules
    .filter((rule) => (indegree.get(rule.ruleId) ?? 0) === 0)
    .map((rule) => rule.ruleId)
    .sort()
  const ordered: SupportRule[] = []
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    const rule = byRuleId.get(next)
    if (rule !== undefined) ordered.push(rule)
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        queue.push(dependent)
        queue.sort()
      }
    }
  }
  if (ordered.length !== rules.length) {
    const cycle = rules
      .map((rule) => rule.ruleId)
      .filter((ruleId) => !ordered.some((rule) => rule.ruleId === ruleId))
      .sort()
    throw new RuleEvaluationError(
      'CYCLE_DETECTED',
      `rule dependency cycle among: ${cycle.join(', ')}`,
    )
  }
  return ordered
}

function evaluateAlternative(
  alternative: RulePremiseAlternative,
  group: RulePremiseGroup,
  state: EvaluationState,
): { outcome: Outcome; value?: RuleAssertionValue; leaf?: SupportLeafNode; factRefs?: readonly RuleFactRef[] } {
  if (alternative.assertionId !== undefined) {
    const fact = state.factsById.get(alternative.assertionId)
    if (fact === undefined) {
      if (
        group.polarity === 'negative' &&
        group.completeRange === true &&
        alternative.assertionId.startsWith('unmatched:')
      ) {
        return { outcome: 'refuted' }
      }
      return { outcome: 'unknown' }
    }
    const resolution = state.activeByLogical.get(fact.logicalAssertionId)
    if (resolution?.reason === 'conflict' || state.conflictedAssertions.has(fact.assertionId)) {
      return {
        outcome: 'conflict',
        factRefs: (resolution?.conflicting ?? [fact]).map(factRefOf),
        leaf: {
          kind: 'fact',
          nodeId: `fact:${fact.logicalAssertionId}`,
          label: fact.logicalAssertionId,
          state: 'conflict',
        },
      }
    }
    const active = resolution?.active
    if (active === undefined) {
      return resolution?.latest === undefined
        ? { outcome: 'unknown' }
        : { outcome: 'unknown', factRefs: [factRefOf(resolution.latest)] }
    }
    const value = active.value
    const factRefs = [factRefOf(active)]
    if (value === undefined) return { outcome: 'unknown', factRefs, leaf: {
      kind: 'fact',
      nodeId: `fact:${active.logicalAssertionId}`,
      label: active.logicalAssertionId,
      state: 'unknown',
    } }
    const match = matchValue(group, value)
    const leaf: SupportLeafNode = {
      kind: 'fact',
      nodeId: `fact:${active.logicalAssertionId}`,
      label: active.logicalAssertionId,
      state: match === undefined ? 'unknown' : match ? 'satisfied' : 'refuted',
      value,
    }
    return { outcome: leaf.state, value, leaf, factRefs }
  }

  const propositionKey = alternative.propositionKey
  if (propositionKey === undefined) return { outcome: 'unknown' }
  const results = state.derived.get(propositionKey) ?? []
  const combined = combineRuleOutcomes(results)
  const factRefs = dedupeFactRefs(results.flatMap((result) => result.observedFactRefs))
  const leaf: SupportLeafNode = {
    kind: 'fact',
    nodeId: `derived:${propositionKey}`,
    label: propositionKey,
    state: combined.state,
    ...(combined.value === undefined ? {} : { value: combined.value }),
  }
  if (combined.state === 'conflict') return { outcome: 'conflict', leaf }
  if (combined.state === 'unknown' || combined.value === undefined) return { outcome: 'unknown', leaf }
  const match = matchValue(group, combined.value)
  const outcome: Outcome = match === undefined ? 'unknown' : match ? 'satisfied' : 'refuted'
  return { outcome, value: combined.value, leaf, factRefs }
}

function matchValue(group: RulePremiseGroup, value: RuleAssertionValue): boolean | undefined {
  if (group.unitCode !== undefined) {
    if (!isRuleDecimalValue(value) || value.unit !== group.unitCode) return undefined
  }
  return evaluateFilter(group.filter, value)
}

function combineRuleOutcomes(results: readonly RuleOutcome[]): {
  state: Outcome
  value?: RuleAssertionValue
} {
  if (results.length === 0) return { state: 'unknown' }
  if (results.some((result) => result.state === 'satisfied')) {
    const values = new Set<string>()
    let value: RuleAssertionValue | undefined
    for (const result of results) {
      if (result.state !== 'satisfied' || result.value === undefined) continue
      const key = JSON.stringify(result.value)
      if (!values.has(key)) {
        values.add(key)
        value = value === undefined ? result.value : value
      }
    }
    if (values.size > 1) return { state: 'conflict' }
    return value === undefined ? { state: 'satisfied' } : { state: 'satisfied', value }
  }
  if (results.some((result) => result.state === 'conflict')) return { state: 'conflict' }
  if (results.some((result) => result.state === 'refuted')) return { state: 'refuted' }
  return { state: 'unknown' }
}

function evaluateGroup(
  rule: SupportRule,
  group: RulePremiseGroup,
  state: EvaluationState,
): {
  state: Outcome
  satisfiedAlternativeIds: string[]
  groupNode: SupportGroupNode
  leaves: SupportLeafNode[]
  factRefs: readonly RuleFactRef[]
} {
  const polarity = group.polarity ?? 'positive'
  const leaves: SupportLeafNode[] = []
  const factRefs: RuleFactRef[] = []
  const alternativeNodeIds: string[] = []
  const satisfiedAlternativeIds: string[] = []
  let anySatisfied = false
  let anyRefuted = false
  let anyConflict = false
  let allRefuted = true

  for (const alternative of group.alternatives) {
    const evaluated = evaluateAlternative(alternative, group, state)
    factRefs.push(...(evaluated.factRefs ?? []))
    if (evaluated.leaf !== undefined) leaves.push(evaluated.leaf)
    alternativeNodeIds.push(evaluated.leaf?.nodeId ?? `fact:${alternative.assertionId ?? alternative.alternativeId}`)
    if (evaluated.outcome === 'satisfied') {
      anySatisfied = true
      satisfiedAlternativeIds.push(alternative.alternativeId)
    }
    if (evaluated.outcome === 'refuted') anyRefuted = true
    else allRefuted = false
    if (evaluated.outcome === 'conflict') anyConflict = true
  }

  let outcome: Outcome
  if (polarity === 'negative') {
    if (anyConflict) outcome = 'conflict'
    else if (anySatisfied) outcome = 'refuted'
    else if (allRefuted) outcome = 'satisfied'
    else outcome = 'unknown'
  } else if (anyConflict) {
    outcome = 'conflict'
  } else if (anySatisfied) {
    outcome = 'satisfied'
  } else if (anyRefuted) {
    outcome = 'refuted'
  } else {
    outcome = 'unknown'
  }

  const groupNode: SupportGroupNode = {
    kind: 'group',
    nodeId: `group:${rule.ruleId}:${group.groupId}`,
    groupId: group.groupId,
    state: outcome,
    alternativeNodeIds: [...new Set(alternativeNodeIds)].sort(),
  }
  return {
    state: outcome,
    satisfiedAlternativeIds: outcome === 'satisfied' ? satisfiedAlternativeIds.sort() : [],
    groupNode,
    leaves,
    factRefs: dedupeFactRefs(factRefs),
  }
}

function evaluateRule(rule: SupportRule, state: EvaluationState): RuleOutcome {
  const groupNodes: SupportGroupNode[] = []
  const leaves: SupportLeafNode[] = []
  const satisfiedBy: RuleSatisfiedBy[] = []
  const factRefs: RuleFactRef[] = []
  const observedFactRefs: RuleFactRef[] = []
  const groupStates = new Map<string, Outcome>()
  const groupFactRefs = new Map<string, readonly RuleFactRef[]>()
  let anyConflict = false
  let anyRefuted = false
  let anyUnknown = false

  for (const group of rule.premiseGroups) {
    const evaluated = evaluateGroup(rule, group, state)
    groupNodes.push(evaluated.groupNode)
    leaves.push(...evaluated.leaves)
    groupStates.set(group.groupId, evaluated.state)
    groupFactRefs.set(group.groupId, evaluated.factRefs)
    observedFactRefs.push(...evaluated.factRefs)
    if (evaluated.state === 'conflict') anyConflict = true
    else if (evaluated.state === 'refuted') anyRefuted = true
    else if (evaluated.state === 'unknown') anyUnknown = true
    if (evaluated.state === 'satisfied') {
      satisfiedBy.push({
        groupId: group.groupId,
        alternativeIds: evaluated.satisfiedAlternativeIds,
      })
      for (const alternative of group.alternatives) {
        if (!evaluated.satisfiedAlternativeIds.includes(alternative.alternativeId)) continue
        if (alternative.assertionId === undefined) continue
        const fact = state.factsById.get(alternative.assertionId)
        if (fact === undefined) continue
        const active = state.activeByLogical.get(fact.logicalAssertionId)?.active
        if (active !== undefined) factRefs.push(factRefOf(active))
      }
    }
  }

  let outcome: Outcome
  if (anyConflict) outcome = 'conflict'
  else if (anyRefuted) outcome = 'refuted'
  else if (anyUnknown) outcome = 'unknown'
  else outcome = 'satisfied'

  const result: RuleOutcome = {
    state: outcome,
    satisfiedBy: satisfiedBy.sort((left, right) => left.groupId.localeCompare(right.groupId)),
    factRefs: dedupeFactRefs(factRefs),
    groupNodes,
    leafNodes: dedupeLeaves(leaves),
    groupStates,
    groupFactRefs,
    observedFactRefs: dedupeFactRefs(observedFactRefs),
  }
  if (outcome === 'satisfied') {
    const declared = rule.conclusion.value
    if (declared !== undefined) return { ...result, value: declared }
    const supporting = result.factRefs
      .map((ref) => state.factsById.get(ref.assertionId)?.value)
      .filter((value): value is RuleAssertionValue => value !== undefined)
    const values = distinctValuesFrom(supporting)
    if (values.length === 1 && values[0] !== undefined) return { ...result, value: values[0] }
    if (values.length > 1) return { ...result, state: 'conflict' }
    return result
  }
  if (outcome === 'refuted') return { ...result, value: REFUTED_VALUE }
  return result
}

function dedupeFactRefs(refs: readonly RuleFactRef[]): RuleFactRef[] {
  const seen = new Map<string, RuleFactRef>()
  for (const ref of refs) {
    if (!seen.has(ref.assertionId)) seen.set(ref.assertionId, ref)
  }
  return [...seen.values()].sort((left, right) => left.assertionId.localeCompare(right.assertionId))
}

function dedupeLeaves(leaves: readonly SupportLeafNode[]): SupportLeafNode[] {
  const seen = new Map<string, SupportLeafNode>()
  for (const leaf of leaves) {
    if (!seen.has(leaf.nodeId)) seen.set(leaf.nodeId, leaf)
  }
  return [...seen.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId))
}

function distinctValuesFrom(values: readonly RuleAssertionValue[]): RuleAssertionValue[] {
  const seen = new Map<string, RuleAssertionValue>()
  for (const value of values) {
    const key = JSON.stringify(value)
    if (!seen.has(key)) seen.set(key, value)
  }
  return [...seen.values()]
}

function combineConclusion(
  outcomes: readonly RuleOutcome[],
  conflictedPredicate: boolean,
): { state: Outcome; value?: RuleAssertionValue } {
  if (conflictedPredicate) return { state: 'conflict' }
  if (outcomes.some((outcome) => outcome.state === 'satisfied')) {
    const values = distinctValuesFrom(
      outcomes
        .filter((outcome) => outcome.state === 'satisfied')
        .map((outcome) => outcome.value)
        .filter((value): value is RuleAssertionValue => value !== undefined),
    )
    if (values.length > 1) return { state: 'conflict' }
    if (values.length === 1 && values[0] !== undefined) return { state: 'satisfied', value: values[0] }
    return { state: 'satisfied' }
  }
  if (outcomes.some((outcome) => outcome.state === 'conflict')) return { state: 'conflict' }
  if (outcomes.some((outcome) => outcome.state === 'refuted')) return { state: 'refuted', value: REFUTED_VALUE }
  return { state: 'unknown' }
}

function statusOf(state: Outcome): DomainResultStatus {
  if (state === 'satisfied' || state === 'refuted') return 'known'
  if (state === 'conflict') return 'conflict'
  return 'unknown'
}

function buildSupportGraph(state: EvaluationState): SupportGraph {
  const nodes: SupportNode[] = [
    ...state.leaves.values(),
    ...state.groups.values(),
    ...state.rules.values(),
    ...[...state.conclusions.entries()].map(
      ([propositionKey, conclusion]): SupportNode => ({
        kind: 'conclusion',
        nodeId: `conclusion:${propositionKey}`,
        propositionKey,
        state: conclusion.state,
        ruleNodeIds: [...conclusion.ruleNodeIds].sort(),
      }),
    ),
  ]
  nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId))
  const conclusionNodeIds = [...state.conclusions.keys()].map((key) => `conclusion:${key}`).sort()
  return { nodes, conclusionNodeIds }
}

function canonicalInput(input: RuleEvaluationInput): unknown {
  const facts = [...input.facts]
    .sort((left, right) =>
      left.logicalAssertionId.localeCompare(right.logicalAssertionId) ||
      left.recordedSeq.localeCompare(right.recordedSeq) ||
      left.assertionId.localeCompare(right.assertionId),
    )
    .map((fact) => ({ ...fact }))
  const rules = [...input.rules]
    .sort((left, right) => left.ruleId.localeCompare(right.ruleId))
    .map((rule) => ({
      ...rule,
      premiseGroups: [...rule.premiseGroups]
        .sort((left, right) => left.groupId.localeCompare(right.groupId))
        .map((group) => ({
          ...group,
          alternatives: [...group.alternatives].sort((left, right) =>
            left.alternativeId.localeCompare(right.alternativeId),
          ),
        })),
    }))
  return {
    scopeRef: input.scopeRef,
    request: input.request,
    definitionRef: input.definitionRef ?? null,
    complete: input.complete ?? false,
    facts,
    rules,
  }
}

function conditionStateOf(outcome: Outcome): RuleConditionState {
  if (outcome === 'satisfied') return 'true'
  if (outcome === 'refuted') return 'false'
  return outcome
}

function andConditionStates(states: readonly RuleConditionState[]): RuleConditionState {
  if (states.includes('false')) return 'false'
  if (states.includes('conflict')) return 'conflict'
  if (states.includes('unknown')) return 'unknown'
  return 'true'
}

function negateConditionState(state: RuleConditionState): RuleConditionState {
  if (state === 'true') return 'false'
  if (state === 'false') return 'true'
  return state
}

function applicabilityFor(
  rule: SupportRule,
  outcome: RuleOutcome,
  input: RuleEvaluationInput,
  inputDigest: Sha256Digest,
): RuleApplicabilityResult | undefined {
  const metadata = rule.publishedInstance
  if (metadata === undefined) return undefined
  if (
    metadata.scopeRef.tenantId !== input.scopeRef.tenantId ||
    metadata.scopeRef.spaceId !== input.scopeRef.spaceId
  ) {
    throw new RuleEvaluationError('SCOPE_MISMATCH', `published rule instance ${metadata.instanceKey} belongs to another scope`)
  }
  if (
    input.definitionRef === undefined ||
    input.definitionRef.id !== metadata.definitionRef.id ||
    input.definitionRef.version !== metadata.definitionRef.version ||
    input.definitionRef.digest !== metadata.definitionRef.digest
  ) {
    throw new RuleEvaluationError('INVALID_ARGUMENT', `published rule instance ${metadata.instanceKey} is not evaluated against its pinned definitionRef`)
  }

  const conditionState = andConditionStates(
    metadata.conditionGroupIds.map((groupId) => conditionStateOf(outcome.groupStates.get(groupId) ?? 'unknown')),
  )
  const exceptionStates: RuleExceptionState[] = metadata.exceptions.map((exception) => {
    const states = exception.groupIds.map((groupId) =>
      negateConditionState(conditionStateOf(outcome.groupStates.get(groupId) ?? 'unknown')),
    )
    const state = andConditionStates(states)
    const factRefs = dedupeFactRefs(exception.groupIds.flatMap((groupId) => outcome.groupFactRefs.get(groupId) ?? []))
    return { exceptionId: exception.exceptionId, state, factRefs }
  })
  let state: RuleApplicabilityResult['state']
  if (conditionState === 'false' || exceptionStates.some((exception) => exception.state === 'true')) {
    state = 'not_applicable'
  } else if (conditionState === 'conflict' || exceptionStates.some((exception) => exception.state === 'conflict')) {
    state = 'conflict'
  } else if (conditionState === 'unknown' || exceptionStates.some((exception) => exception.state === 'unknown')) {
    state = 'unknown'
  } else {
    state = 'applicable'
  }

  const factRefs = dedupeFactRefs(outcome.observedFactRefs)
  const sourceStatementIds = [...new Set(factRefs.map((ref) => ref.sourceStatementId).filter((id): id is string => id !== undefined))].sort()
  const applicability = {
    state,
    conditionState,
    exceptionStates,
    positiveSupport: state === 'applicable',
  }
  return {
    scopeRef: input.scopeRef,
    definitionRef: metadata.definitionRef,
    ruleRef: metadata.ruleRef,
    ruleId: metadata.ruleId,
    ruleVersionId: metadata.ruleVersionId,
    publishedRevision: metadata.publishedRevision,
    instanceKey: metadata.instanceKey,
    objectId: metadata.objectId,
    subjectEntityId: metadata.subjectEntityId,
    propositionKey: metadata.propositionKey,
    predicate: metadata.predicate,
    ...(input.request.validAt === undefined ? {} : { validAt: input.request.validAt }),
    ...(input.request.asOfRecordedSeq === undefined ? {} : { asOfRecordedSeq: input.request.asOfRecordedSeq }),
    ...applicability,
    factRefs,
    sourceStatementIds,
    inputDigest,
    computationDigest: sha256DigestOf({
      inputDigest,
      ruleRef: metadata.ruleRef,
      instanceKey: metadata.instanceKey,
      validAt: input.request.validAt ?? null,
      asOfRecordedSeq: input.request.asOfRecordedSeq ?? null,
      applicability,
      factRefs,
    }),
    sourceSpans: metadata.sourceSpans,
    complete: input.complete ?? false,
  }
}

function refutedPublishedOutcomeAsUnknown(outcome: RuleOutcome): RuleOutcome {
  return {
    state: 'unknown',
    satisfiedBy: outcome.satisfiedBy,
    factRefs: outcome.factRefs,
    groupNodes: outcome.groupNodes,
    leafNodes: outcome.leafNodes,
    groupStates: outcome.groupStates,
    groupFactRefs: outcome.groupFactRefs,
    observedFactRefs: outcome.observedFactRefs,
  }
}

/**
 * Deterministic, acyclic rule evaluator over versioned facts and support rules (SPEC D5/D5.1,
 * US-016, FR-18). It has no dependencies: the caller loads the pinned facts and rules and
 * decides whether the result is persisted or answered on demand. Unknown and conflict are never
 * coerced to true, and an unsupported or cyclic rule is rejected with a typed error.
 */
export class RuleEvaluator {
  evaluate(input: RuleEvaluationInput): RuleEvaluationResult {
    if (
      input.scopeRef.tenantId !== input.request.scopeRef.tenantId ||
      input.scopeRef.spaceId !== input.request.scopeRef.spaceId
    ) {
      throw new RuleEvaluationError('SCOPE_MISMATCH', 'request scope does not match the evaluation scope')
    }
    const ruleIds = new Set<string>()
    for (const rule of input.rules) {
      if (ruleIds.has(rule.ruleId)) {
        throw new RuleEvaluationError('INVALID_RULE', `duplicate ruleId ${rule.ruleId}`)
      }
      ruleIds.add(rule.ruleId)
      validateRule(rule)
    }
    const orderedRules = topologicalOrder(input.rules)

    const activeByLogical = resolveLogicalAssertions(
      input.facts,
      input.request.asOfRecordedSeq,
      input.request.validAt,
    )
    const factsById = new Map<string, RuleFact>()
    for (const fact of input.facts) {
      if (!factsById.has(fact.assertionId)) factsById.set(fact.assertionId, fact)
    }
    const conflicts = detectConflicts(activeByLogical, input.scopeRef)
    const conflictedPredicates = new Set(conflicts.map((conflict) => conflict.propositionKey))
    const conflictedAssertions = new Set(conflicts.flatMap((conflict) => conflict.assertionIds))

    const state: EvaluationState = {
      activeByLogical,
      factsById,
      conflictedAssertions,
      derived: new Map(),
      leaves: new Map(),
      groups: new Map(),
      rules: new Map(),
      conclusions: new Map(),
    }

    const outcomesByConclusion = new Map<string, RuleOutcome[]>()
    const inputDigest = sha256DigestOf(canonicalInput(input))
    const applicabilities: RuleApplicabilityResult[] = []
    for (const rule of orderedRules) {
      const outcome = evaluateRule(rule, state)
      const applicability = applicabilityFor(rule, outcome, input, inputDigest)
      if (applicability !== undefined) applicabilities.push(applicability)
      for (const leaf of outcome.leafNodes) state.leaves.set(leaf.nodeId, leaf)
      for (const group of outcome.groupNodes) state.groups.set(group.nodeId, group)
      state.rules.set(`rule:${rule.ruleId}`, {
        kind: 'rule',
        nodeId: `rule:${rule.ruleId}`,
        ruleId: rule.publishedInstance?.ruleId ?? rule.ruleId,
        ruleRef: rule.ruleRef,
        state: outcome.state,
        groupNodeIds: outcome.groupNodes.map((group) => group.nodeId).sort(),
      })
      const propositionOutcome =
        rule.publishedInstance !== undefined && outcome.state === 'refuted'
          ? refutedPublishedOutcomeAsUnknown(outcome)
          : outcome
      const existing = outcomesByConclusion.get(rule.conclusion.propositionKey)
      if (existing === undefined) outcomesByConclusion.set(rule.conclusion.propositionKey, [propositionOutcome])
      else existing.push(propositionOutcome)
      state.derived.set(rule.conclusion.propositionKey, outcomesByConclusion.get(rule.conclusion.propositionKey) ?? [])
    }

    const conclusions: RuleConclusionResult[] = []
    const referencedAssertions = collectReferencedAssertions(input.rules)
    for (const [propositionKey, outcomes] of [...outcomesByConclusion.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const rule = orderedRules.find((candidate) => candidate.conclusion.propositionKey === propositionKey)
      if (rule === undefined) continue
      const predicate = rule.conclusion.predicate ?? propositionKey
      const combined = combineConclusion(outcomes, conflictedPredicates.has(predicate))
      const supportNodeId = `conclusion:${propositionKey}`
      const ruleRefs = dedupeVersionRefs(
        orderedRules
          .filter((candidate) => candidate.conclusion.propositionKey === propositionKey)
          .map((candidate) => candidate.ruleRef),
      )
      const satisfiedBy = combined.state === 'satisfied'
        ? mergeSatisfiedBy(outcomes.filter((outcome) => outcome.state === 'satisfied'))
        : []
      const factRefs = combined.state === 'satisfied'
        ? dedupeFactRefs(outcomes.filter((outcome) => outcome.state === 'satisfied').flatMap((outcome) => outcome.factRefs))
        : []
      const conclusion: RuleConclusionResult = {
        propositionKey,
        qualifiedPropositionKey: conclusionQualifiedKey(predicate, input.request, input.definitionRef),
        predicate,
        domainStatus: statusOf(combined.state),
        satisfiedBy,
        ruleRefs,
        factRefs,
        supportNodeId,
        ...(combined.value === undefined ? {} : { value: combined.value }),
      }
      conclusions.push(conclusion)
      state.conclusions.set(propositionKey, {
        state: combined.state,
        ruleNodeIds: new Set(
          orderedRules
            .filter((candidate) => candidate.conclusion.propositionKey === propositionKey)
            .map((candidate) => `rule:${candidate.ruleId}`),
        ),
      })
    }

    const gaps = buildGaps(orderedRules, outcomesByConclusion, activeByLogical, referencedAssertions, input)
    const supports = buildSupportGraph(state)
    return {
      scopeRef: input.scopeRef,
      request: input.request,
      ...(input.definitionRef === undefined ? {} : { definitionRef: input.definitionRef }),
      conclusions,
      applicabilities: applicabilities.sort((left, right) => left.instanceKey.localeCompare(right.instanceKey)),
      gaps,
      conflicts,
      supports,
      inputDigest,
    }
  }
}

function mergeSatisfiedBy(outcomes: readonly RuleOutcome[]): RuleSatisfiedBy[] {
  const merged = new Map<string, Set<string>>()
  for (const outcome of outcomes) {
    for (const entry of outcome.satisfiedBy) {
      const bucket = merged.get(entry.groupId)
      if (bucket === undefined) merged.set(entry.groupId, new Set(entry.alternativeIds))
      else for (const id of entry.alternativeIds) bucket.add(id)
    }
  }
  return [...merged.entries()]
    .map(([groupId, alternativeIds]) => ({ groupId, alternativeIds: [...alternativeIds].sort() }))
    .sort((left, right) => left.groupId.localeCompare(right.groupId))
}

function dedupeVersionRefs(refs: readonly { id: string; version: string; digest: Sha256Digest }[]): {
  id: string
  version: string
  digest: Sha256Digest
}[] {
  const seen = new Map<string, { id: string; version: string; digest: Sha256Digest }>()
  for (const ref of refs) {
    const key = `${ref.id}@${ref.version}`
    if (!seen.has(key)) seen.set(key, ref)
  }
  return [...seen.values()].sort((left, right) => `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`))
}

function collectReferencedAssertions(rules: readonly SupportRule[]): Set<string> {
  const referenced = new Set<string>()
  for (const rule of rules) {
    for (const group of rule.premiseGroups) {
      for (const alternative of group.alternatives) {
        if (alternative.assertionId !== undefined) referenced.add(alternative.assertionId)
      }
    }
  }
  return referenced
}

function buildGaps(
  rules: readonly SupportRule[],
  outcomesByConclusion: ReadonlyMap<string, RuleOutcome[]>,
  activeByLogical: ReadonlyMap<string, LogicalResolution>,
  referencedAssertions: ReadonlySet<string>,
  input: RuleEvaluationInput,
): string[] {
  const gaps = new Set<string>()
  const validAt = input.request.validAt ?? 'the requested instant'
  for (const rule of rules) {
    const outcomes = outcomesByConclusion.get(rule.conclusion.propositionKey) ?? []
    for (const outcome of outcomes) {
      for (const group of outcome.groupNodes) {
        if (group.state !== 'unknown') continue
        const premise = rule.premiseGroups.find((candidate) => candidate.groupId === group.groupId)
        const fieldRef = premise?.filter.fieldRef ?? group.groupId
        gaps.add(
          `${rule.conclusion.propositionKey}: no observation matches ${fieldRef} at ${validAt}; keep it unknown`,
        )
      }
    }
  }
  const referencedLogical = new Set<string>()
  for (const fact of input.facts) {
    if (referencedAssertions.has(fact.assertionId)) referencedLogical.add(fact.logicalAssertionId)
  }
  for (const [logicalId, resolution] of activeByLogical) {
    if (
      resolution.reason === 'active' ||
      resolution.reason === 'conflict' ||
      referencedLogical.has(logicalId)
    ) {
      continue
    }
    if (resolution.reason === 'not_visible') {
      gaps.add(
        `${resolution.predicate} is not visible at asOfRecordedSeq ${input.request.asOfRecordedSeq ?? 'the requested version'}`,
      )
    } else if (resolution.reason === 'retracted') {
      gaps.add(`${resolution.predicate} is retracted for the interval at ${validAt}`)
    } else {
      gaps.add(`${resolution.predicate} has no valid assertion at ${validAt} because validity is half-open`)
    }
  }
  return [...gaps].sort()
}
