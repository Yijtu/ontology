import type {
  DocumentSpan,
  EvidenceDependencyEdge,
  EvidenceRecord,
  ResourceRef,
  RevisionString,
  ScopeRef,
  Semver,
  Sha256Digest,
  SpanPrecision,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import type { PublishedSemanticReadView } from '../materialization'
import type { RuleEvaluator } from '../rules'
import { sameUtcInstant } from './instant'

/**
 * Whether one support axis of a rule derivation was fully resolved. Fact premises and the
 * reviewed specification text are reported separately: a complete fact support graph never
 * implies the original policy text was located, and a missing policy span never silently
 * degrades the fact-premise graph into a false "no support" answer.
 */
export interface RuleSupportAxisCoverage {
  readonly complete: boolean
  readonly reason?: string
}

/**
 * One resolved specification (policy) source span of a published rule. It carries the exact
 * parse/chunk identity, locator, span kind, precision and quote digest of the AST provenance
 * span plus the real immutable document refs and the archived `document_span` evidence that the
 * producer verified against them.
 */
export interface PublishedRulePolicySpan {
  readonly parseId: Uuid
  readonly chunkId: Uuid
  readonly locator: DocumentSpan['locator']
  readonly spanKind: DocumentSpan['spanKind']
  readonly precision: SpanPrecision
  readonly quoteDigest: Sha256Digest
  readonly documentRef: ResourceRef
  readonly documentVersionRef: ResourceRef
  readonly parserVersion: Semver
  readonly evidenceRef: ResourceRef
}

/**
 * One premise group from an immutable, instance-qualified rule support record.
 *
 * The reader must return only alternatives that actually participated in the rule's positive
 * support. Each fact is explicitly marked as an entity attribute so a relation assertion can
 * never be mistaken for evidence of an attribute premise.
 */
export interface PublishedRuleSupportGroup {
  readonly groupId: string
  readonly facts: readonly {
    readonly kind: 'entity_attribute' | 'relation'
    readonly assertionId: string
    readonly logicalAssertionId: string
    readonly sourceStatementId: string
    readonly subjectEntityId: string
    readonly objectId: string
    readonly schemaRef: VersionRef
    readonly sourceRefs: readonly ResourceRef[]
  }[]
}

/**
 * Immutable support resolution for one published rule instance at one exact bitemporal point.
 * The reader should be backed by persisted materialization/support data, never latest mutable
 * publication heads. Multiple instances are returned as separate candidates so this class can
 * fail closed when the root evidence does not identify which entity was evaluated.
 */
export interface PublishedRuleSupportInstance {
  readonly scopeRef: ScopeRef
  readonly definitionRef: VersionRef
  readonly ruleRef: VersionRef
  readonly instanceKey: string
  readonly objectId: string
  readonly subjectEntityId: string
  readonly validAt: string
  readonly asOfRecordedSeq: RevisionString
  readonly applicability: {
    readonly state: 'applicable' | 'not_applicable' | 'unknown' | 'conflict'
    readonly positiveSupport: boolean
  }
  /** Fact-premise completeness. Specification text has its own coverage below. */
  readonly complete: boolean
  readonly premiseGroups: readonly PublishedRuleSupportGroup[]
  /** Converted, verified specification spans of this rule instance; absent on older readers. */
  readonly policySpans?: readonly PublishedRulePolicySpan[]
  /** Per-axis coverage: fact premises and the reviewed specification text are independent. */
  readonly coverage?: {
    readonly facts: RuleSupportAxisCoverage
    readonly policy: RuleSupportAxisCoverage
  }
}

export type PublishedRuleSupportResolution =
  | {
      readonly state: 'resolved'
      readonly instanceKey: string
      readonly objectId: string
      readonly subjectEntityId: string
      readonly premiseGroups: readonly PublishedRuleSupportGroup[]
      /** Specification-text coverage, separate from the fact-premise resolution above. */
      readonly policy: RuleSupportAxisCoverage
      readonly policySpans: readonly PublishedRulePolicySpan[]
    }
  | {
      readonly state: 'ambiguous' | 'unavailable' | 'incomplete' | 'not_applicable' | 'unknown' | 'conflict'
      readonly reason: string
    }

/** Optional read port for immutable, per-instance support records. */
export interface PublishedRuleSupportReader {
  readCandidates(
    scopeRef: ScopeRef,
    request: {
      readonly ruleRef: VersionRef
      readonly validAt: string
      readonly asOfRecordedSeq: RevisionString
      /** Exact root evidence identity, used to join an archived immutable derivation payload. */
      readonly evidenceRef: ResourceRef
      /** Optional immutable payload locator from that root envelope. */
      readonly payloadRef?: ResourceRef
    },
    ctx: ToolContext,
  ): Promise<{
    /** False means the reader could not prove that every candidate was returned. */
    readonly complete: boolean
    readonly candidates: readonly PublishedRuleSupportInstance[]
  }>
}

export interface SupportEvidenceDependencySourceDependencies {
  /** Retained for composition compatibility; mutable published heads are never used as support. */
  readonly published: PublishedSemanticReadView
  readonly supportReader?: PublishedRuleSupportReader
  /** Retained as an accepted legacy option; the evaluator is deliberately not used as a fallback. */
  readonly evaluator?: RuleEvaluator
  /** Retained as an accepted legacy option; immutable support reads are bounded by the reader. */
  readonly pageSize?: number
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.tenantId === right.tenantId && left.spaceId === right.spaceId
}

function sameVersion(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function evidenceIdsOf(refs: readonly ResourceRef[]): Uuid[] {
  return [...new Set(refs
    .filter((ref): ref is ResourceRef & { readonly kind: 'evidence' } => ref.kind === 'evidence')
    .map((ref) => ref.id))]
}

function sameFactInstance(
  fact: PublishedRuleSupportGroup['facts'][number],
  instance: PublishedRuleSupportInstance,
): boolean {
  return fact.kind === 'entity_attribute' &&
    fact.subjectEntityId === instance.subjectEntityId &&
    fact.objectId === instance.objectId &&
    sameVersion(fact.schemaRef, instance.definitionRef) &&
    fact.assertionId.length > 0 &&
    fact.logicalAssertionId.length > 0 &&
    fact.sourceStatementId.length > 0
}

/**
 * Evidence dependencies derived from immutable lineage and an optional exact rule support
 * record (SPEC D5/D4, US-022, FR-30). Ontology type relations are not evidence dependencies.
 */
export class SupportEvidenceDependencySource {
  readonly #supportReader: PublishedRuleSupportReader | undefined

  constructor(dependencies: SupportEvidenceDependencySourceDependencies) {
    // `published` is intentionally not retained. Recomputing against current publication rows
    // can select a different entity instance or present-day fact version than the evidence saw.
    this.#supportReader = dependencies.supportReader
  }

  /**
   * Return both immutable envelope lineage and the status of support resolution. Callers that
   * need to report coverage should consume `supportResolution`; an empty support edge list by
   * itself does not mean a complete support DAG was reconstructed.
   */
  async dependenciesWithResolutionOf(
    scopeRef: ScopeRef,
    evidence: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<{
    readonly edges: readonly EvidenceDependencyEdge[]
    readonly supportResolution: PublishedRuleSupportResolution | { readonly state: 'not_rule' }
  }> {
    const envelope = evidence.envelope
    const root = evidence.evidenceRef.id
    const lineage = envelope.dependencies.map((dependency) => ({
      fromEvidenceId: root,
      toEvidenceId: dependency.evidenceRef.id,
      relation: dependency.relation,
      origin: 'lineage' as const,
      ...(dependency.premiseGroup === undefined ? {} : { premiseGroup: dependency.premiseGroup }),
    }))
    const ruleRef = envelope.producedBy.ruleRef
    if (ruleRef === undefined) return { edges: lineage, supportResolution: { state: 'not_rule' } }

    const support = await this.#supportEdges(scopeRef, evidence, ctx)
    return { edges: [...lineage, ...support.edges], supportResolution: support.resolution }
  }

  /** Compatibility method used by the provenance traversal port. */
  async dependenciesOf(
    scopeRef: ScopeRef,
    evidence: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<readonly EvidenceDependencyEdge[]> {
    const result = await this.dependenciesWithResolutionOf(scopeRef, evidence, ctx)
    return result.edges
  }

  async #supportEdges(
    scopeRef: ScopeRef,
    evidence: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<{
    readonly edges: EvidenceDependencyEdge[]
    readonly resolution: PublishedRuleSupportResolution
  }> {
    const envelope = evidence.envelope
    const ruleRef = envelope.producedBy.ruleRef
    if (ruleRef === undefined) return { edges: [], resolution: { state: 'unavailable', reason: 'evidence has no ruleRef' } }
    if (!sameScope(scopeRef, envelope.scopeRef)) {
      return { edges: [], resolution: { state: 'unavailable', reason: 'evidence scope does not match the requested scope' } }
    }
    if (envelope.recordedSeq === undefined) {
      return { edges: [], resolution: { state: 'unavailable', reason: 'evidence has no immutable recorded sequence for support lookup' } }
    }
    if (this.#supportReader === undefined) {
      return { edges: [], resolution: { state: 'unavailable', reason: 'immutable per-instance support reader is not configured' } }
    }

    const validAt = envelope.validity?.validFrom ?? envelope.observedAt
    const read = await this.#supportReader.readCandidates(
      scopeRef,
      {
        ruleRef,
        validAt,
        asOfRecordedSeq: envelope.recordedSeq,
        evidenceRef: evidence.evidenceRef,
        ...(envelope.payloadRef === undefined ? {} : { payloadRef: envelope.payloadRef }),
      },
      ctx,
    )
    if (!read.complete) {
      return { edges: [], resolution: { state: 'incomplete', reason: 'immutable support lookup was not complete' } }
    }
    const exactCandidates = read.candidates.filter((candidate) =>
      sameScope(candidate.scopeRef, scopeRef) &&
      sameVersion(candidate.ruleRef, ruleRef) &&
      sameUtcInstant(candidate.validAt, validAt) &&
      candidate.asOfRecordedSeq === envelope.recordedSeq,
    )
    if (exactCandidates.length === 0) {
      return { edges: [], resolution: { state: 'unavailable', reason: 'no immutable support instance matches this rule and bitemporal point' } }
    }
    if (exactCandidates.length !== 1) {
      return { edges: [], resolution: { state: 'ambiguous', reason: 'multiple entity instances match the evidence rule and bitemporal point' } }
    }
    const instance = exactCandidates[0]
    if (instance === undefined || !instance.complete) {
      return { edges: [], resolution: { state: 'incomplete', reason: 'the matching immutable support instance is incomplete' } }
    }
    if (instance.applicability.state === 'not_applicable') {
      return { edges: [], resolution: { state: 'not_applicable', reason: 'the rule instance did not provide positive support' } }
    }
    if (instance.applicability.state === 'unknown' || instance.applicability.state === 'conflict') {
      return { edges: [], resolution: { state: instance.applicability.state, reason: `the rule instance applicability is ${instance.applicability.state}` } }
    }
    if (!instance.applicability.positiveSupport) {
      return { edges: [], resolution: { state: 'incomplete', reason: 'the rule instance is marked applicable without positive support' } }
    }
    if (instance.instanceKey.length === 0 || instance.objectId.length === 0 || instance.subjectEntityId.length === 0) {
      return { edges: [], resolution: { state: 'incomplete', reason: 'the matching support instance lacks its entity-qualified identity' } }
    }

    const root = evidence.evidenceRef.id
    const edges: EvidenceDependencyEdge[] = []
    const edgeKeys = new Set<string>()
    for (const group of instance.premiseGroups) {
      if (group.groupId.length === 0) {
        return { edges: [], resolution: { state: 'incomplete', reason: 'a support premise group has no stable id' } }
      }
      for (const fact of group.facts) {
        if (!sameFactInstance(fact, instance)) {
          return { edges: [], resolution: { state: 'incomplete', reason: 'a premise fact does not match the resolved entity, object, or definition instance' } }
        }
        for (const evidenceId of evidenceIdsOf(fact.sourceRefs)) {
          if (evidenceId === root) continue
          const key = `${group.groupId}\u0000${evidenceId}`
          if (edgeKeys.has(key)) continue
          edgeKeys.add(key)
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
    const policySpans = instance.policySpans ?? []
    const policy = instance.coverage?.policy ?? {
      complete: false,
      reason: 'the support reader did not report specification-text coverage',
    }
    return {
      edges,
      resolution: {
        state: 'resolved',
        instanceKey: instance.instanceKey,
        objectId: instance.objectId,
        subjectEntityId: instance.subjectEntityId,
        premiseGroups: instance.premiseGroups,
        policy,
        policySpans,
      },
    }
  }
}
