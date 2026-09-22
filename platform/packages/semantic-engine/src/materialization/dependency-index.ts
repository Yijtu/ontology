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
  readonly #rulesByLogical: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesByConclusion: ReadonlyMap<string, ReadonlySet<string>>
  readonly #rulesByEntity: ReadonlyMap<string, ReadonlySet<string>>
  /** A rule's prerequisites: the rules whose conclusions its alternatives reference. */
  readonly #ruleDependencies: ReadonlyMap<string, ReadonlySet<string>>
  /** A rule's dependents: the rules that reference the conclusion it derives. */
  readonly #ruleDependents: ReadonlyMap<string, ReadonlySet<string>>
  readonly #conclusionByRule: ReadonlyMap<string, string>

  private constructor(input: DependencyIndexInput) {
    const factsById = new Map<string, RuleFact>()
    for (const fact of input.facts) if (!factsById.has(fact.assertionId)) factsById.set(fact.assertionId, fact)

    const rulesByPredicate = new Map<string, Set<string>>()
    const rulesByLogical = new Map<string, Set<string>>()
    const rulesByConclusion = new Map<string, Set<string>>()
    const ruleDependencies = new Map<string, Set<string>>()
    const ruleDependents = new Map<string, Set<string>>()
    const conclusionByRule = new Map<string, string>()

    for (const rule of input.rules) {
      conclusionByRule.set(rule.ruleId, rule.conclusion.propositionKey)
      addTo(rulesByConclusion, rule.conclusion.propositionKey, rule.ruleId)
      for (const group of rule.premiseGroups) {
        addTo(rulesByPredicate, group.filter.fieldRef, rule.ruleId)
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

    const rulesByEntity = new Map<string, Set<string>>()
    for (const binding of input.entityBindings ?? []) {
      for (const ruleId of rulesByLogical.get(binding.logicalAssertionId) ?? []) {
        addTo(rulesByEntity, binding.entityId, ruleId)
      }
      for (const fact of input.facts) {
        if (fact.logicalAssertionId !== binding.logicalAssertionId) continue
        for (const ruleId of rulesByPredicate.get(fact.predicate) ?? []) {
          addTo(rulesByEntity, binding.entityId, ruleId)
        }
      }
    }

    this.#rulesByPredicate = rulesByPredicate
    this.#rulesByLogical = rulesByLogical
    this.#rulesByConclusion = rulesByConclusion
    this.#rulesByEntity = rulesByEntity
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
        for (const ruleId of this.#rulesByPredicate.get(change.predicate) ?? []) seeds.add(ruleId)
        for (const ruleId of this.#rulesByLogical.get(change.logicalAssertionId) ?? []) seeds.add(ruleId)
        break
      case 'rule_changed':
        seeds.add(change.ruleId)
        for (const ruleId of this.#rulesByConclusion.get(change.propositionKey) ?? []) seeds.add(ruleId)
        break
      case 'identity_changed':
        for (const ruleId of this.#rulesByEntity.get(change.entityId) ?? []) seeds.add(ruleId)
        break
      case 'validity_expired':
        for (const ruleId of this.#rulesByPredicate.get(change.predicate) ?? []) seeds.add(ruleId)
        for (const ruleId of this.#rulesByLogical.get(change.logicalAssertionId) ?? []) seeds.add(ruleId)
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
    return closure(new Set(affectedRuleIds), this.#ruleDependencies)
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
