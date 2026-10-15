import type { MaterializationChange } from '@ontology/contracts'
import type { RuleFact, SupportRule } from '../rules'

/**
 * The dependency index (SPEC D5/D5.1, ADR-13, FR-19).
 *
 * A change must trigger only the *affected* evaluations. The index records what depends on what:
 * a premise predicate points at the rules that read it, a conclusion points at the rules that
 * derive it, a rule points at the rules that reference its conclusion, and an entity points at
 * the rules that read the facts bound to it. A change is resolved to a seed set which is then
 * closed downstream, so a materialisation never replays the whole library.
 */

/** Binds a logical assertion to the canonical entity it belongs to (identity-change trigger). */
export interface DependencyEntityBinding {
  readonly entityId: string
  readonly logicalAssertionId: string
  /** Parent published statement whose revision/retraction invalidates this attribute child. */
  readonly sourceStatementId?: string
  /** Source candidate that supplied the parent statement, used by identity split changes. */
  readonly sourceCandidateId?: string
  /** The projected attribute predicate; dependency-only bindings may have no RuleFact row. */
  readonly predicate?: string
}

export interface DependencyIndexInput {
  readonly facts: readonly RuleFact[]
  readonly rules: readonly SupportRule[]
  /** Optional identity bindings; without them an identity change affects nothing. */
  readonly entityBindings?: readonly DependencyEntityBinding[]
}

function addTo<K>(map: Map<K, Set<string>>, key: K, value: string): void {
  const bucket = map.get(key)
  if (bucket === undefined) map.set(key, new Set([value]))
  else bucket.add(value)
}

function entityPredicateKey(entityId: string, predicate: string): string {
  return `${entityId}\u0000${predicate}`
}

function entityCandidateKey(entityId: string, candidateId: string): string {
  return `${entityId}\u0000${candidateId}`
}

function closure(seeds: ReadonlySet<string>, edges: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const reached = new Set(seeds)
  const queue = [...seeds]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined) break
    for (const next of edges.get(current) ?? []) {
      if (reached.has(next)) continue
      reached.add(next)
      queue.push(next)
    }
  }
  return [...reached].sort()
}

export class MaterializationDependencyIndex {
  readonly #rulesByPredicate: ReadonlyMap<string, ReadonlySet<string>>
  readonly #legacyRulesByPredicate: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesByEntityPredicate: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesByLogical: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesByConclusion: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesByEntity: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesByEntityObject: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesBySourceStatement: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesBySourceCandidate: ReadonlyMap<string, Set<string>>
  readonly #rulesByPublishedRule: ReadonlyMap<string, ReadonlySet<string>>
  /** A rule's prerequisites: the rules whose conclusions its alternatives reference. */
  readonly #ruleDependencies: ReadonlyMap<string, ReadonlySet<string>>
  /** A rule's dependents: the rules that reference the conclusion it derives. */
  readonly #ruleDependents: ReadonlyMap<string, ReadonlySet<string>>
  readonly #conclusionByRule: ReadonlyMap<string, string>

  private constructor(input: DependencyIndexInput) {
    const factsById = new Map<string, RuleFact>()
    const factsByLogicalId = new Map<string, RuleFact[]>()
    for (const fact of input.facts) if (!factsById.has(fact.assertionId)) factsById.set(fact.assertionId, fact)
    for (const fact of input.facts) {
      const bucket = factsByLogicalId.get(fact.logicalAssertionId)
      if (bucket === undefined) factsByLogicalId.set(fact.logicalAssertionId, [fact])
      else bucket.push(fact)
    }

    const rulesByPredicate = new Map<string, Set<string>>()
    const legacyRulesByPredicate = new Map<string, Set<string>>()
    const rulesByEntityPredicate = new Map<string, Set<string>>()
    const rulesByEntity = new Map<string, Set<string>>()
    const rulesByEntityObject = new Map<string, Set<string>>()
    const rulesByLogical = new Map<string, Set<string>>()
    const rulesByConclusion = new Map<string, Set<string>>()
    const rulesByPublishedRule = new Map<string, Set<string>>()
    const ruleDependencies = new Map<string, Set<string>>()
    const ruleDependents = new Map<string, Set<string>>()
    const conclusionByRule = new Map<string, string>()

    for (const rule of input.rules) {
      conclusionByRule.set(rule.ruleId, rule.conclusion.propositionKey)
      addTo(rulesByConclusion, rule.conclusion.propositionKey, rule.ruleId)
      const publishedInstance = rule.publishedInstance
      if (publishedInstance !== undefined) {
        addTo(rulesByPublishedRule, `${publishedInstance.ruleId}\u0000${publishedInstance.objectId}`, rule.ruleId)
        addTo(rulesByEntity, publishedInstance.subjectEntityId, rule.ruleId)
        addTo(rulesByEntityObject, JSON.stringify([publishedInstance.subjectEntityId, publishedInstance.objectId]), rule.ruleId)
        // Keep the invalidation alias even when the pinned upstream version has disappeared.
        for (const dependency of publishedInstance.dependencyRefs ?? []) {
          addTo(rulesByPublishedRule, `${dependency.ruleId}\u0000${dependency.objectId}`, rule.ruleId)
        }
      }
      for (const group of rule.premiseGroups) {
        addTo(rulesByPredicate, group.filter.fieldRef, rule.ruleId)
        if (publishedInstance === undefined) {
          addTo(legacyRulesByPredicate, group.filter.fieldRef, rule.ruleId)
        } else {
          addTo(
            rulesByEntityPredicate,
            entityPredicateKey(publishedInstance.subjectEntityId, group.filter.fieldRef),
            rule.ruleId,
          )
        }
        const relationConditions = new Map(group.relation?.targetConditions.map((target) => [target.targetKey, target]) ?? [])
        const relationTargets = new Map(group.relation?.targetGroups.map((target) => [target.groupId, target]) ?? [])
        for (const branch of group.relation?.branches ?? []) {
          const edge = branch.edge.assertionId === undefined ? undefined : factsById.get(branch.edge.assertionId)
          const targetId = edge?.relation?.targetEntityId
          if (targetId !== undefined) {
            addTo(rulesByEntity, targetId, rule.ruleId)
            if (edge?.relation !== undefined) addTo(rulesByEntityObject, JSON.stringify([targetId, edge.relation.targetObjectId]), rule.ruleId)
            const targetCondition = branch.targetKey === undefined ? undefined : relationConditions.get(branch.targetKey)
            for (const groupId of targetCondition?.groupIds ?? []) {
              const targetGroup = relationTargets.get(groupId)
              if (targetGroup === undefined) continue
              addTo(rulesByEntityPredicate, entityPredicateKey(targetId, targetGroup.filter.fieldRef), rule.ruleId)
              addTo(rulesByPredicate, targetGroup.filter.fieldRef, rule.ruleId)
            }
          }
        }
        for (const alternative of group.alternatives) {
          if (alternative.assertionId !== undefined) {
            const fact = factsById.get(alternative.assertionId)
            if (fact !== undefined) addTo(rulesByLogical, fact.logicalAssertionId, rule.ruleId)
          }
          if (alternative.propositionKey !== undefined) {
            addTo(ruleDependencies, rule.ruleId, alternative.propositionKey)
          }
        }
      }
    }

    // A rule depends on the rules that derive the propositions it references; invert to get
    // downstream dependents for a change-driven closure.
    for (const [ruleId, propositions] of ruleDependencies) {
      for (const proposition of propositions) {
        for (const owner of rulesByConclusion.get(proposition) ?? []) {
          if (owner === ruleId) continue
          addTo(ruleDependents, owner, ruleId)
        }
      }
    }
    // Rewrite the placeholder proposition set into rule ids for the ancestor closure.
    const dependencyRuleIds = new Map<string, Set<string>>()
    for (const [ruleId, propositions] of ruleDependencies) {
      const owners = new Set<string>()
      for (const proposition of propositions) {
        for (const owner of rulesByConclusion.get(proposition) ?? []) owners.add(owner)
      }
      dependencyRuleIds.set(ruleId, owners)
    }

    const rulesBySourceStatement = new Map<string, Set<string>>()
    const rulesBySourceCandidate = new Map<string, Set<string>>()
    for (const binding of input.entityBindings ?? []) {
      for (const ruleId of rulesByLogical.get(binding.logicalAssertionId) ?? []) {
        addTo(rulesByEntity, binding.entityId, ruleId)
      }
      const facts = factsByLogicalId.get(binding.logicalAssertionId) ?? []
      for (const fact of facts) {
        const entityRules = rulesByEntityPredicate.get(entityPredicateKey(binding.entityId, fact.predicate)) ?? []
        for (const ruleId of entityRules) addTo(rulesByEntity, binding.entityId, ruleId)
        for (const ruleId of legacyRulesByPredicate.get(fact.predicate) ?? []) {
          addTo(rulesByEntity, binding.entityId, ruleId)
        }
      }
      if (binding.predicate !== undefined) {
        for (const ruleId of rulesByEntityPredicate.get(entityPredicateKey(binding.entityId, binding.predicate)) ?? []) {
          addTo(rulesByEntity, binding.entityId, ruleId)
        }
        for (const ruleId of legacyRulesByPredicate.get(binding.predicate) ?? []) addTo(rulesByEntity, binding.entityId, ruleId)
      }
      if (binding.sourceStatementId !== undefined) {
        const statementId = binding.sourceStatementId
        for (const fact of facts) {
          for (const ruleId of rulesByEntityPredicate.get(entityPredicateKey(binding.entityId, fact.predicate)) ?? []) {
            addTo(rulesBySourceStatement, statementId, ruleId)
          }
          for (const ruleId of legacyRulesByPredicate.get(fact.predicate) ?? []) addTo(rulesBySourceStatement, statementId, ruleId)
        }
        if (binding.predicate !== undefined) {
          for (const ruleId of rulesByEntityPredicate.get(entityPredicateKey(binding.entityId, binding.predicate)) ?? []) {
            addTo(rulesBySourceStatement, statementId, ruleId)
          }
          for (const ruleId of legacyRulesByPredicate.get(binding.predicate) ?? []) addTo(rulesBySourceStatement, statementId, ruleId)
        }
      }
      if (binding.sourceCandidateId !== undefined) {
        const candidateId = entityCandidateKey(binding.entityId, binding.sourceCandidateId)
        for (const fact of facts) {
          for (const ruleId of rulesByEntityPredicate.get(entityPredicateKey(binding.entityId, fact.predicate)) ?? []) {
            addTo(rulesBySourceCandidate, candidateId, ruleId)
          }
          for (const ruleId of legacyRulesByPredicate.get(fact.predicate) ?? []) addTo(rulesBySourceCandidate, candidateId, ruleId)
        }
        if (binding.predicate !== undefined) {
          for (const ruleId of rulesByEntityPredicate.get(entityPredicateKey(binding.entityId, binding.predicate)) ?? []) {
            addTo(rulesBySourceCandidate, candidateId, ruleId)
          }
          for (const ruleId of legacyRulesByPredicate.get(binding.predicate) ?? []) addTo(rulesBySourceCandidate, candidateId, ruleId)
        }
      }
    }
    // Facts retain their source statement alias even for callers that omit the optional
    // dependency-only bindings. This is the fast path for statementId -> attribute children.
    for (const fact of input.facts) {
      const parentId = fact.sourceStatementId
      if (parentId === undefined) continue
      for (const ruleId of rulesByLogical.get(fact.logicalAssertionId) ?? []) {
        addTo(rulesBySourceStatement, parentId, ruleId)
      }
      for (const ruleId of rulesByEntityPredicate.get(entityPredicateKey(fact.subject, fact.predicate)) ?? []) {
        addTo(rulesBySourceStatement, parentId, ruleId)
      }
      for (const ruleId of legacyRulesByPredicate.get(fact.predicate) ?? []) {
        addTo(rulesBySourceStatement, parentId, ruleId)
      }
    }

    this.#rulesByPredicate = rulesByPredicate
    this.#legacyRulesByPredicate = legacyRulesByPredicate
    this.#rulesByEntityPredicate = rulesByEntityPredicate
    this.#rulesByLogical = rulesByLogical
    this.#rulesByConclusion = rulesByConclusion
    this.#rulesByEntity = rulesByEntity
    this.#rulesByEntityObject = rulesByEntityObject
    this.#rulesBySourceStatement = rulesBySourceStatement
    this.#rulesBySourceCandidate = rulesBySourceCandidate
    this.#rulesByPublishedRule = rulesByPublishedRule
    this.#ruleDependencies = dependencyRuleIds
    this.#ruleDependents = ruleDependents
    this.#conclusionByRule = conclusionByRule
  }

  static build(input: DependencyIndexInput): MaterializationDependencyIndex {
    return new MaterializationDependencyIndex(input)
  }

  /** The rules whose evaluation could change because of `change`, closed downstream. */
  affectedRuleIds(change: MaterializationChange): readonly string[] {
    const seeds = new Set<string>()
    switch (change.kind) {
      case 'assertion_published':
      case 'assertion_corrected':
      case 'assertion_retracted':
        if (change.subjectEntityId === undefined) {
          for (const ruleId of this.#rulesByPredicate.get(change.predicate) ?? []) seeds.add(ruleId)
        } else {
          for (const ruleId of this.#rulesByEntityPredicate.get(entityPredicateKey(change.subjectEntityId, change.predicate)) ?? []) seeds.add(ruleId)
          for (const ruleId of this.#legacyRulesByPredicate.get(change.predicate) ?? []) seeds.add(ruleId)
        }
        for (const ruleId of this.#rulesByLogical.get(change.logicalAssertionId) ?? []) seeds.add(ruleId)
        for (const ruleId of this.#rulesBySourceStatement.get(change.logicalAssertionId) ?? []) seeds.add(ruleId)
        break
      case 'rule_changed':
        for (const ruleId of this.#rulesByPublishedRule.get(`${change.ruleId}\u0000${change.propositionKey}`) ?? []) seeds.add(ruleId)
        // Preserve the legacy non-published helper semantics used by direct evaluator fixtures.
        if (seeds.size === 0 && this.#conclusionByRule.has(change.ruleId)) seeds.add(change.ruleId)
        for (const ruleId of this.#rulesByConclusion.get(change.propositionKey) ?? []) seeds.add(ruleId)
        break
      case 'identity_changed':
        for (const ruleId of (change.objectId === undefined
          ? this.#rulesByEntity.get(change.entityId)
          : this.#rulesByEntityObject.get(JSON.stringify([change.entityId, change.objectId]))) ?? []) seeds.add(ruleId)
        for (const candidateId of change.separatedCandidateIds) {
          for (const ruleId of this.#rulesBySourceCandidate.get(entityCandidateKey(change.entityId, candidateId)) ?? []) seeds.add(ruleId)
        }
        break
      case 'validity_expired':
        for (const ruleId of this.#rulesByLogical.get(change.logicalAssertionId) ?? []) seeds.add(ruleId)
        for (const ruleId of this.#rulesBySourceStatement.get(change.logicalAssertionId) ?? []) seeds.add(ruleId)
        if (seeds.size === 0) {
          for (const ruleId of this.#rulesByPredicate.get(change.predicate) ?? []) seeds.add(ruleId)
        }
        break
    }
    return closure(seeds, this.#ruleDependents)
  }

  /**
   * The rules that must be evaluated to recompute the affected set. A rule that references
   * another rule's conclusion needs that prerequisite evaluated, so ancestors are added. This is
   * still far smaller than the whole library: unrelated rules are never evaluated.
   */
  evaluationRuleIds(affectedRuleIds: readonly string[]): readonly string[] {
    const needed = new Set(affectedRuleIds)
    // A shared proposition is the OR of all its independent derivations. Recompute siblings and
    // their ancestors as well, even when the changed source only seeded one producer.
    let previousSize = -1
    while (needed.size !== previousSize) {
      previousSize = needed.size
      for (const id of closure(needed, this.#ruleDependencies)) needed.add(id)
      for (const id of [...needed]) {
        const proposition = this.#conclusionByRule.get(id)
        if (proposition !== undefined) for (const owner of this.#rulesByConclusion.get(proposition) ?? []) needed.add(owner)
      }
    }
    return [...needed].sort()
  }

  /** The distinct conclusion propositions the affected rules derive. */
  affectedPropositionKeys(affectedRuleIds: readonly string[]): readonly string[] {
    const propositions = new Set<string>()
    for (const ruleId of affectedRuleIds) {
      const proposition = this.#conclusionByRule.get(ruleId)
      if (proposition !== undefined) propositions.add(proposition)
    }
    return [...propositions].sort()
  }
}
