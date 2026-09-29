import type {
  MaterializationChange,
  MaterializationStore,
  MaterializedConclusion,
  RuleComputationArtifact,
  IdentityPublishedBinding,
  RevisionString,
  ScopeRef,
  Uuid,
  VersionRef,
  Rfc3339UtcTimestamp,
  ToolContext,
} from '@ontology/contracts'
import type { RuleCapabilityIssue, RuleEvaluator, RuleFact, SupportRule } from '../rules'
import type { DependencyEntityBinding } from './dependency-index'
import type { AttributeProjectionIssue } from '../rules'

/**
 * Incremental materialisation service (SPEC D5/D5.1, ADR-13, US-016/US-017, FR-18/19/20).
 *
 * The service composes the pure `RuleEvaluator` (LOCAL-032) with the published read view
 * (LOCAL-031) and the projection/fence store. It receives every capability by construction
 * injection and never imports an adapter or driver.
 */
/** The pinned facts and rules one materialisation reads. Never the candidate store. */
export interface PublishedSemanticData {
  readonly facts: readonly RuleFact[]
  readonly rules: readonly SupportRule[]
  readonly entityBindings: readonly DependencyEntityBinding[]
  readonly definitionRef?: VersionRef
  readonly readRevision?: { readonly semantic: RevisionString; readonly identity: RevisionString }
  /** True only when facts/rules are versioned well enough to replay arbitrary recorded-time reads. */
  readonly historicalAsOfSupported?: boolean
  readonly identityBindings?: readonly IdentityPublishedBinding[]
  /** True only when the source completed its configured record cap under a stable revision vector. */
  readonly complete?: boolean
  readonly ruleIssues?: readonly RuleCapabilityIssue[]
  readonly attributeIssues?: readonly AttributeProjectionIssue[]
  readonly issues?: readonly { readonly code: string; readonly message: string; readonly subjectEntityId?: string; readonly statementId?: string }[]
}

/**
 * The published read view the materialiser consumes. The production implementation wraps the
 * official `SemanticPublicationStore` (LOCAL-031); a unit test can supply the LOCAL-048 fixtures
 * directly, which preserves the fixture's `op=correct`/`op=retract` event semantics.
 */
export interface MaterializationPublishedSource {
  load(scopeRef: ScopeRef, ctx: ToolContext): Promise<PublishedSemanticData>
}

export interface MaterializationServiceDependencies {
  /** The official published read view of facts and rules; never the candidate store. */
  readonly publishedSource: MaterializationPublishedSource
  /** Fence, dirty flag, projection state and append-only projection slices. */
  readonly materialization: MaterializationStore
  readonly evaluator?: RuleEvaluator
  /**
   * Above this many affected rules a change is conservatively deferred: the whole scope is
   * marked dirty and a scope-wide fence is opened instead of enumerating the fan-out (D5.1).
   */
  readonly maxFanout?: number
  readonly now?: () => string
  readonly newId?: () => string
  /** Test-only seam: run before the advance commit so a fault can leave the fence open. */
  readonly faultInjection?: MaterializationFaultInjection
}

export interface MaterializationFaultInjection {
  readonly beforeCommit?: () => void
}

/** What a change resolved to, after the fence was set but before the projection advanced. */
export interface MaterializationTicket {
  readonly change: MaterializationChange
  readonly fenceId: Uuid
  readonly affectedRuleIds: readonly string[]
  readonly affectedPropositionKeys: readonly string[]
  /** `true` when the fan-out was too large to enumerate and the scope was marked dirty. */
  readonly deferred: boolean
}

export interface MaterializationAdvanceResult {
  readonly scopeRef: ScopeRef
  readonly generation: RevisionString
  /** The rules that were actually evaluated; unrelated rules are never in this set. */
  readonly recomputedRuleIds: readonly string[]
  readonly recomputedPropositionKeys: readonly string[]
  readonly appendedSlices: number
  readonly deferred: boolean
}

export interface MaterializationReadRequest {
  readonly scopeRef: ScopeRef
  readonly projectionRef: VersionRef
  /** Restrict the read to these propositions; `undefined` reads every materialised one. */
  readonly propositionKeys?: readonly string[]
  readonly asOfRecordedSeq?: RevisionString
  readonly validAt?: Rfc3339UtcTimestamp
}

/**
 * `materialized`/`on_demand` carry a current answer; `fenced`/`dirty` mean the affected
 * propositions are withheld rather than served stale (D5.1).
 */
export type MaterializationReadStatus = 'materialized' | 'on_demand' | 'fenced' | 'dirty' | 'history_unavailable'

export interface MaterializationReadResult {
  readonly status: MaterializationReadStatus
  readonly scopeRef: ScopeRef
  readonly generation: RevisionString
  readonly conclusions: readonly MaterializedConclusion[]
  readonly ruleArtifacts?: readonly RuleComputationArtifact[]
  readonly issues?: PublishedSemanticData['issues']
  readonly blockedPropositionKeys: readonly string[]
  readonly reason?: string
}
