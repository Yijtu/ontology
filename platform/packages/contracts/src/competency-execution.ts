import type {
  CompetencyExpectation, CompetencyQuestion, CompetencyQuestionSetBody, CompetencySourceLocation,
  ResourceRef, ScopeRef, Sha256Digest, VersionRef,
} from './generated/contracts'
import type { ReviewableCandidateReader } from './candidate-review'
import type { ToolContext } from './trusted'
import type { DefinitionApprovalPin } from './definition-editing'
import type { RuleActionPublicationPin } from './synthetic-validation'

/** Canonical body bytes are the reviewable artifact, independently of a transport envelope. */
export const COMPETENCY_BODY_MEDIA_TYPE = 'application/vnd.ontology.competency-question-body+json' as const

export interface CompetencyArtifactLookup {
  findBodyArtifact(scope: ScopeRef, id: string, ctx: ToolContext): Promise<ResourceRef | undefined>
}

export interface CompetencyQuestionReviewReader extends ReviewableCandidateReader {
  readBody(scope: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<CompetencyQuestionSetBody | undefined>
}

export interface CompetencyValidationTarget {
  readonly workspaceId: string
  readonly revision: string
  readonly definitionApprovalPins: readonly DefinitionApprovalPin[]
  readonly ruleActionPins: readonly RuleActionPublicationPin[]
}

/** Gold and derivation are deliberately absent from the execution boundary. */
export interface CompetencyExecutionRequest {
  readonly validationTarget?: CompetencyValidationTarget
  readonly questionId: string
  readonly questionSetRef: VersionRef
  readonly inputDigest: Sha256Digest
  readonly definitionRef: VersionRef
  readonly ruleRefs: readonly VersionRef[]
  readonly input: CompetencyQuestion['input']
  readonly intent: CompetencyQuestion['intent']
  readonly requiredCapabilities: readonly string[]
  readonly requiredSources: readonly CompetencySourceLocation[]
}

export type CompetencyExecutionResult =
  | { readonly status: 'executed'; readonly actual: CompetencyExpectation; readonly inputDigest: Sha256Digest;
      readonly validationTargetDigest?: Sha256Digest;
      readonly definitionRef: VersionRef; readonly ruleRefs: readonly VersionRef[];
      readonly artifactRefs: readonly ResourceRef[]; readonly sources: readonly CompetencySourceLocation[] }
  | { readonly status: 'not_yet_executable'; readonly reason: string }

export interface CompetencyExecutionPort {
  execute(request: CompetencyExecutionRequest, ctx: ToolContext, signal: AbortSignal): Promise<CompetencyExecutionResult>
}

export interface CompetencySourceReader {
  /** Hosts independently authorize original immutable bytes in the exact scope. */
  readSource(scope: ScopeRef, ref: VersionRef, ctx: ToolContext, signal: AbortSignal): Promise<Uint8Array | undefined>
}

export interface CompetencyQuestionResult {
  readonly questionId: string
  readonly question: string
  readonly taskKind: CompetencyQuestion['taskKind']
  readonly definitionRef: VersionRef
  readonly ruleRefs: readonly VersionRef[]
  readonly requiredCapabilities: readonly string[]
  readonly requiredSources: readonly CompetencySourceLocation[]
  readonly inputDigest: Sha256Digest
  readonly expected: CompetencyExpectation
  readonly actual?: CompetencyExpectation
  readonly status: 'passed' | 'failed' | 'not_yet_executable'
  readonly reason?: string
  readonly sourceCoverage: { readonly required: number; readonly verified: number; readonly complete: boolean }
  readonly artifactRefs: readonly ResourceRef[]
}

export interface CompetencyRunReport {
  readonly validationTarget?: CompetencyValidationTarget
  readonly questionSetRef: VersionRef
  readonly dataMode: 'synthetic'
  readonly definitionRefs: readonly VersionRef[]
  readonly ruleRefs: readonly VersionRef[]
  readonly sourceRefs: readonly VersionRef[]
  readonly results: readonly CompetencyQuestionResult[]
  readonly passed: boolean
  readonly contentDigest: Sha256Digest
  readonly externalAcceptance: { readonly customerQuote: 'unverified'; readonly liveModelQuality: 'unverified' }
}
