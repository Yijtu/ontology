import type {
  CandidateAttributeValue,
  CandidateIssue,
  CandidateKind,
  CandidateRecord,
  CandidateReviewRecord,
  CandidateState,
  DocumentSpan,
  ExtractionInputVersion,
  IdentityDecisionKind,
  IdentityEntityRecord,
  JobAttemptState,
  JobErrorInfo,
  JobStageCounts,
  PipelineStage,
  PublishedStatement,
  RevisionString,
  RunnableJobStage,
  SemanticPublicationVersion,
  StatementRevisionKind,
  StatementRevisionRecord,
  VersionRef,
} from '@ontology/contracts'

/**
 * Wire shapes for the ingestion-job and candidate-review surfaces (C6). These mirror the
 * server projections the browser receives over HTTP; the web app deliberately does not
 * import a server package, so the shapes are declared here instead of re-exported.
 *
 * The distinction that matters most: `counts.processed` is the number of items a stage
 * handled, which is **not** the number of published statements. The UI keeps the two apart.
 */

export interface JobAttemptView {
  readonly attemptId: string
  readonly attemptNumber: number
  readonly state: JobAttemptState
  readonly stage: PipelineStage
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly abandonedReason?: string
  readonly error?: JobErrorInfo
}

export interface JobPublicationView {
  readonly publicationId: string
  readonly versionRef: VersionRef
  readonly publishedAt: string
}

export interface JobView {
  readonly jobId: string
  readonly kind: 'ingestion' | 'simulation'
  readonly stage: PipelineStage
  readonly pipelineVersion: string
  readonly sourceRef: string
  readonly documentRef?: string
  readonly datasetRef?: string
  readonly counts: JobStageCounts
  readonly attemptCount: number
  readonly abandonedAttemptCount: number
  readonly revision: RevisionString
  readonly createdAt: string
  readonly updatedAt: string
  readonly nextAttemptAt: string
  readonly failedStage?: PipelineStage
  readonly lastError?: JobErrorInfo
  readonly publication?: JobPublicationView
  readonly attempts: readonly JobAttemptView[]
}

export interface CreateJobResponse {
  readonly jobId: string
  readonly stage: PipelineStage
  readonly jobUrl: string
}

export interface RetryJobResponse {
  readonly jobId: string
  readonly stage: PipelineStage
  readonly attemptCount: number
}

export interface CreateIngestionRequest {
  readonly sourceRef: string
  readonly documentRef: string
  readonly pipelineVersion: string
}

export interface RetryJobRequest {
  readonly failedStage: RunnableJobStage
  readonly expectedRevision: RevisionString
}

export interface CandidateSummary {
  readonly candidateId: string
  readonly jobId: string
  readonly kind: CandidateKind
  readonly state: CandidateState
  readonly recordedAt: string
  readonly objectId?: string
  readonly relationId?: string
  readonly ruleId?: string
}

export interface CandidateFilter {
  readonly jobId?: string
  readonly state?: CandidateState
  readonly kind?: CandidateKind
  readonly limit?: number
}

interface CandidateDetailCommon {
  readonly candidateId: string
  readonly jobId: string
  readonly state: CandidateState
  readonly deterministic: boolean
  readonly recordedAt: string
  readonly issues: readonly CandidateIssue[]
  readonly sourceSpans: readonly CandidateRecord['sourceSpans'][number][]
  readonly inputVersion: ExtractionInputVersion
  readonly decisionRevision: RevisionString
}

type RelationCandidate = Extract<CandidateRecord, { readonly kind: 'relation' }>
type RuleCandidate = Extract<CandidateRecord, { readonly kind: 'rule' }>
type RuleUnhandledCandidate = Extract<CandidateRecord, { readonly kind: 'rule_unhandled' }>

export interface EntityCandidateDetail extends CandidateDetailCommon {
  readonly kind: 'entity'
  readonly objectId: string
  readonly identityScopeId?: string
  readonly nativeId?: string
  readonly attributes: readonly CandidateAttributeValue[]
}

export interface RelationCandidateDetail extends CandidateDetailCommon {
  readonly kind: 'relation'
  readonly relationId: string
  readonly from: RelationCandidate['from']
  readonly to: RelationCandidate['to']
}

export interface RuleCandidateDetail extends CandidateDetailCommon {
  readonly kind: 'rule'
  readonly ruleId: string
  readonly objectId: string
  readonly severity: RuleCandidate['severity']
  readonly impact: RuleCandidate['impact']
  readonly reviewRequirement: RuleCandidate['reviewRequirement']
  readonly expression: RuleCandidate['expression']
  readonly exceptions: RuleCandidate['exceptions']
  readonly conflicts: RuleCandidate['conflicts']
}

export interface RuleUnhandledCandidateDetail extends CandidateDetailCommon {
  readonly kind: 'rule_unhandled'
  readonly ruleId?: string
  readonly reason: RuleUnhandledCandidate['reason']
  readonly detail: string
  readonly rawExpression: string
}

export type CandidateDetailView =
  | EntityCandidateDetail
  | RelationCandidateDetail
  | RuleCandidateDetail
  | RuleUnhandledCandidateDetail

export type CandidateSpanSource =
  | {
      readonly status: 'resolved'
      readonly chunkId: string
      readonly text: string
      readonly textDigest: string
      readonly locator: DocumentSpan['locator']
      readonly spanKind: DocumentSpan['spanKind']
      readonly precision: 'exact' | 'approximate'
      readonly truncated: boolean
    }
  | { readonly status: 'missing'; readonly chunkId: string; readonly reason: string }
  | { readonly status: 'mismatch'; readonly chunkId: string; readonly reason: string }

export interface CandidateSourceView {
  readonly candidateId: string
  readonly missingSource: boolean
  readonly spans: readonly CandidateSpanSource[]
}

/**
 * The reviewer-facing result of one identity decision. The service type lives in
 * `@ontology/semantic-engine`; the browser only sees this HTTP projection, so it is
 * declared here rather than imported from a server package.
 */
export interface IdentityDecisionView {
  readonly decisionId: string
  readonly candidateId: string
  readonly kind: IdentityDecisionKind
  readonly revision: RevisionString
  readonly objectId: string
  readonly identityScopeId: string
  readonly targetEntityId?: string
  readonly separatedCandidateIds?: readonly string[]
  readonly supersedesRevision?: RevisionString
  readonly entity?: IdentityEntityRecord
  readonly invalidationOutboxId?: string
  readonly recordedAt: string
}

export interface IdentityDecisionRequest {
  readonly kind: IdentityDecisionKind
  readonly expectedRevision: RevisionString
  readonly targetEntityId?: string
  readonly justification?: string
  readonly strongIdentityValue?: string
}

export interface CandidateReviewRequest {
  readonly decision: 'approve' | 'reject'
  readonly reason: string
  readonly expectedRevision: RevisionString
}

export interface PublishSemanticsRequest {
  readonly approvedCandidateRefs: readonly { readonly candidateId: string; readonly kind: CandidateKind }[]
  readonly schemaRef: VersionRef
  readonly expectedRevision: RevisionString
}

export interface StatementRevisionRequest {
  readonly kind: StatementRevisionKind
  readonly reason: string
  readonly correctedValue?: Readonly<Record<string, unknown>>
  readonly expectedRevision: RevisionString
}

export type { CandidateReviewRecord, PublishedStatement, SemanticPublicationVersion, StatementRevisionRecord }
