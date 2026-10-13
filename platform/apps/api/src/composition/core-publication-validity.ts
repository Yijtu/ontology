import { defaultPublicationEvidenceValidators, PublicationValidityEngine, ruleDerivationValidator } from '@ontology/application'
import type {
  PublicationEvidenceValidation,
  PublicationEvidenceValidationInput,
  PublicationEvidenceValidator,
} from '@ontology/application'
import { canonicalJson } from '@ontology/tool-services'
import type { PostgresEvidenceStore } from '@ontology/adapter-control-postgres'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { OntologyFactPage } from '@ontology/semantic-engine'
import type {
  InputValidityPort,
  PublicationValidityPort,
  PublicationValidityRequest,
  PublicationValidityReport,
  RulePremiseReplayPort,
  ScopeRef,
  TableVerificationReceiptStore,
  TaskPolicyReportStore,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { CorePublishedFactsProvider } from './core-facts-providers'
import { CoreRelationsTaskHandler } from './core-relations-task-handler'
import { isRecord, sameResourceRef } from './core-composition-shared'

/** Core publication-validity ports: evidence visibility and the per-evidence-kind re-check engine. */

export class CoreInputValidity implements InputValidityPort {
  readonly #evidence: PostgresEvidenceStore
  readonly #scopeRef: ScopeRef

  constructor(evidence: PostgresEvidenceStore, scopeRef: ScopeRef) {
    this.#evidence = evidence
    this.#scopeRef = scopeRef
  }

  async validate(entries: Parameters<InputValidityPort['validate']>[0], ctx: ToolContext) {
    const staleEntries: { readonly entryId: Uuid; readonly reason: string }[] = []
    for (const entry of entries) {
      if (entry.kind !== 'evidence' || entry.ref === undefined) continue
      const record = await this.#evidence.get(this.#scopeRef, entry.ref.id, ctx)
      if (record === undefined || !sameResourceRef(record.evidenceRef, entry.ref)) {
        staleEntries.push({ entryId: entry.entryId, reason: 'evidence_not_visible' })
      }
    }
    return { valid: staleEntries.length === 0, staleEntries }
  }
}

/**
 * `observation` publication validity for the Core path. A published-fact page is revalidated
 * against the current published view; any other observation payload (a relation edge or table
 * result) is left to the generic observation rule, so the gate no longer blindly rejects — or
 * blindly accepts — a non-fact evidence shape as if it were a fact page.
 */
export class CoreObservationPublicationValidator implements PublicationEvidenceValidator {
  readonly evidenceKind = 'observation' as const
  readonly #facts: CorePublishedFactsProvider
  readonly #scopeRef: ScopeRef
  readonly #relations: CoreRelationsTaskHandler | undefined

  constructor(input: { readonly facts: CorePublishedFactsProvider; readonly scopeRef: ScopeRef; readonly relations?: CoreRelationsTaskHandler }) {
    this.#facts = input.facts
    this.#scopeRef = input.scopeRef
    this.#relations = input.relations
  }

  async validate({ record, payload, ctx }: PublicationEvidenceValidationInput): Promise<PublicationEvidenceValidation> {
    if (isRecord(payload) && payload['resultKind'] === 'relations') {
      try { return this.#relations !== undefined && await this.#relations.verify(payload, ctx) ? { state: 'current' } : { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['published project relations changed or cannot be re-read'] } } catch { return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['published project relations cannot be re-read'] } }
    }
    if (!isRecord(payload) || !Array.isArray(payload['items'])) return { state: 'current' }
    const items = payload['items']
    const factItems = items.filter((item) => isRecord(item) && item['kind'] === 'fact')
    if (factItems.length === 0 || factItems.length !== items.length) return { state: 'current' }
    const first = factItems[0]
    if (!isRecord(first) || !isRecord(first['conceptRef']) || typeof first['conceptRef']['namespace'] !== 'string') {
      return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['fact evidence has no exact concept namespace'] }
    }
    const namespace = first['conceptRef']['namespace']
    const concepts: { namespace: string; conceptId: string; definitionVersion?: string }[] = []
    for (const item of factItems) {
      if (!isRecord(item) || !isRecord(item['conceptRef']) || typeof item['conceptRef']['conceptId'] !== 'string' || item['conceptRef']['namespace'] !== namespace) {
        return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['fact evidence mixed concept namespaces or lacked a typed concept reference'] }
      }
      const definitionVersion = item['conceptRef']['definitionVersion']
      concepts.push({
        namespace,
        conceptId: item['conceptRef']['conceptId'],
        ...(typeof definitionVersion === 'string' ? { definitionVersion } : {}),
      })
    }
    let page: OntologyFactPage
    try {
      page = await this.#facts.listFacts({
        scopeRef: this.#scopeRef,
        concepts: [...new Map(concepts.map((concept) => [concept.conceptId, concept])).values()],
        entityRefs: [],
        limit: 10_000,
        validAt: record.envelope.observedAt,
      }, ctx)
    } catch {
      return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['published fact evidence could not be revalidated against its source'] }
    }
    if (!page.covered || page.nextCursor !== null) {
      return { state: 'stale', details: ['published fact evidence no longer has a complete source view'] }
    }
    const current = page.facts.map((fact) => ({
      kind: 'fact',
      ref: fact.factRef,
      conceptRef: fact.conceptRef,
      ...(fact.label === undefined ? {} : { label: fact.label }),
      ...(fact.validity === undefined ? {} : { validity: fact.validity }),
      ...(fact.payload === undefined ? {} : { payload: fact.payload }),
    })).sort((left, right) => left.ref.id.localeCompare(right.ref.id))
    const previous = factItems.map((item) => item).sort((left, right) => {
      const leftRef = isRecord(left) && isRecord(left['ref']) && typeof left['ref']['id'] === 'string' ? left['ref']['id'] : ''
      const rightRef = isRecord(right) && isRecord(right['ref']) && typeof right['ref']['id'] === 'string' ? right['ref']['id'] : ''
      return leftRef.localeCompare(rightRef)
    })
    if (canonicalJson(current) !== canonicalJson(previous)) {
      return { state: 'stale', details: ['published facts changed after the evidence was collected'] }
    }
    return { state: 'current' }
  }
}

/**
 * Core publication validity: a per-evidence-kind engine (V03-035 / #206) that re-checks the
 * revision, digest and current visibility of every dependency of the verified draft (facts,
 * relation/table observations, rule derivations, computations, document spans and their
 * transitive support), plus any formal-table verification receipts. Only the same verified
 * version can publish; a later edit or retraction blocks, and a stale-but-intact support is
 * published only with an explicit `asOf`.
 */
export class CorePublicationValidity implements PublicationValidityPort {
  readonly #engine: PublicationValidityEngine

  constructor(input: {
    readonly evidence: PostgresEvidenceStore
    readonly artifacts: LocalImmutableBlobStore
    readonly facts: CorePublishedFactsProvider
    readonly scopeRef: ScopeRef
    readonly tables?: TableVerificationReceiptStore
    readonly policies?: TaskPolicyReportStore
    readonly rulePremises?: RulePremiseReplayPort
    readonly documentSources?: PublicationEvidenceValidator
    readonly relations?: CoreRelationsTaskHandler
  }) {
    this.#engine = new PublicationValidityEngine({
      evidence: input.evidence,
      artifacts: input.artifacts,
      validators: [
        ...defaultPublicationEvidenceValidators(),
        new CoreObservationPublicationValidator({ facts: input.facts, scopeRef: input.scopeRef, ...(input.relations === undefined ? {} : { relations: input.relations }) }),
        ruleDerivationValidator(input.rulePremises),
        ...(input.documentSources === undefined ? [] : [input.documentSources]),
      ],
      ...(input.tables === undefined ? {} : { tables: input.tables }),
      ...(input.policies === undefined ? {} : { policies: input.policies }),
    })
  }

  check(request: PublicationValidityRequest, ctx: ToolContext): Promise<PublicationValidityReport> {
    return this.#engine.check(request, ctx)
  }
}
