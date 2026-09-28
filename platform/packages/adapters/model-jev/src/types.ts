import type {
  BudgetLedgerPort,
  DecisionOption,
  DecisionQuestion,
  DecisionQuestionType,
  ModelRef,
  ResourceRef,
  SecretResolver,
  Sha256Digest,
  Semver,
  ToolContext,
  Uuid,
} from '@ontology/contracts'

/**
 * Host-injected dependencies and public configuration for the JEV decision adapter
 * (SPEC C2, ADR-09). Everything here is expressed in canonical contracts; the vendor
 * request/response shapes stay inside `src/vendor` and never appear in this surface.
 */

/**
 * The profile's declared fallback for an unavailable or low-confidence decision
 * (mirrors `ModelBinding.fallbackPolicy`). `reject` surfaces the classified failure
 * instead of producing a fallback result.
 */
export type JevFallbackPolicy = 'deterministic' | 'generative_classification' | 'clarify' | 'reject'

/** One decision question's persisted record: options, probabilities, scores and version. */
export interface DecisionEvidenceResult {
  readonly questionId: Uuid
  readonly questionType: DecisionQuestionType
  readonly prompt: string
  readonly definitionVersion: Semver
  readonly optionSetHash: Sha256Digest
  readonly options: readonly DecisionOption[]
  readonly selectedOptionId?: string
  readonly probabilities?: readonly { readonly optionId: string; readonly probability: number }[]
  readonly scores?: readonly { readonly optionId: string; readonly score: number; readonly confidence?: number }[]
  readonly confidence?: number
  /** System One Noul P(yes); deliberately distinct from confidence. */
  readonly probability?: number
}

/**
 * What a decision call produced, before it is settled. The provider-reported model
 * version and the per-question option set/probabilities/confidence are recorded as
 * untrusted `model_output` evidence (never a published answer), so a `completed`
 * settlement always names persisted evidence (SPEC §8, C4).
 */
export interface DecisionEvidenceRequest {
  readonly runId: Uuid
  readonly modelRef: ModelRef
  readonly modelVersion?: string
  readonly stateRef: ResourceRef
  readonly outcome: 'calibrated' | 'fallback'
  readonly fallbackReason?: string
  readonly results: readonly DecisionEvidenceResult[]
}

export interface DecisionEvidenceRecorder {
  record(request: DecisionEvidenceRequest, ctx: ToolContext): Promise<ResourceRef>
}

/**
 * The explicitly labelled generative-classification fallback. The host injects the
 * generation capability; this adapter never imports the generation adapter and never
 * dresses a classification up as a calibrated probability. Its output is validated
 * against the question option set and re-marked as a fallback.
 */
export interface GenerativeClassificationRequest {
  readonly question: DecisionQuestion
  readonly stateRef: ResourceRef
  readonly modelRef: ModelRef
}

export interface GenerativeClassificationOutput {
  readonly selectedOptionId?: string
  /** Self-reported scores. They are never surfaced as a calibrated probability. */
  readonly scores?: readonly { readonly optionId: string; readonly score: number }[]
}

export interface GenerativeClassificationFallback {
  classify(
    request: GenerativeClassificationRequest,
    ctx: ToolContext,
  ): Promise<GenerativeClassificationOutput>
}

/** Structured log record; the adapter never puts a resolved secret into a log line. */
export interface JevAdapterLogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly fields?: Readonly<Record<string, unknown>>
}

export type JevAdapterLogger = (record: JevAdapterLogRecord) => void

/**
 * Maps a platform model id to the vendor's own model identifier. The platform model id
 * in `DecisionRequest.modelRef` is never sent on the wire.
 */
export interface JevModelBinding {
  readonly vendorModel: string
  /** Per-binding override of the profile's fallback policy. */
  readonly fallbackPolicy?: JevFallbackPolicy
}

export interface JevAdapterConfig {
  /** Base URL of the JEV API, e.g. `http://127.0.0.1:0`. */
  readonly baseUrl: string
  /** Optional endpoint override; defaults to the official `/v1/systemone`. */
  readonly endpoint?: string
  /** Opaque server-side reference; resolved per call through the injected resolver. */
  readonly secretRef: string
  readonly models: Readonly<Record<string, JevModelBinding>>
  /**
   * Host-authorized resolver for the immutable state referenced by each DecisionRequest.
   * Without it, the official System One call stops with an explicit typed capability error;
   * the adapter never sends a reference in place of actual state.
   */
  readonly stateResolver?: JevActualStateResolver
  /** Maximum canonical UTF-8 state size sent to TypeSafe. Defaults to 65536 bytes. */
  readonly maxStateBytes?: number
  /** Maximum JSON values (including containers) in the resolved state. Defaults to 1000. */
  readonly maxStateRecords?: number
  /** Profile-declared fallback used when JEV is unavailable or confidence is too low. */
  readonly fallbackPolicy: JevFallbackPolicy
  readonly secrets: SecretResolver
  readonly budget: BudgetLedgerPort
  /** The run's single shared ledger (SPEC D7.2). Retries never open a second one. */
  readonly ledgerId: Uuid
  readonly evidence: DecisionEvidenceRecorder
  /** Required when the fallback policy is `generative_classification`. */
  readonly generativeClassification?: GenerativeClassificationFallback
  /** Degrade when choice/score confidence is below this value. Noul P(yes) is not confidence. */
  readonly minConfidence?: number
  /** Token allowance reserved before a decision call. Defaults to 256. */
  readonly estimatedTokens?: number
  readonly log?: JevAdapterLogger
  /** Total attempts per decide call, including the first. Defaults to 3 (1 + 2). */
  readonly maxAttempts?: number
  /** Additional per-request cap; the run deadline still wins when it is earlier. */
  readonly requestTimeoutMs?: number
  /** Run cancellation signal, injected by the controller/host. */
  readonly signal?: AbortSignal
  /** Backoff before a retry when the provider did not send `Retry-After`. Defaults to 200ms. */
  readonly retryBaseDelayMs?: number
  /** Id source, injected so a call's reservation keys are reproducible in tests. */
  readonly newId?: () => string
  readonly fetchImpl?: typeof fetch
}

export type JevActualState =
  | null
  | boolean
  | number
  | string
  | readonly JevActualState[]
  | { readonly [key: string]: JevActualState }

export interface JevActualStateResolutionInput {
  readonly stateRef: ResourceRef
  readonly maxBytes: number
  readonly maxRecords: number
  readonly signal?: AbortSignal
}

export interface JevActualStateResolution {
  /** Actual question context, candidates, confirmed semantics and relevant evidence. */
  readonly state: JevActualState
  /** Must name exactly the immutable snapshot requested by stateRef. */
  readonly resolvedRef: ResourceRef
  /** False/partial states are never sent to the provider. */
  readonly complete: true
}

export interface JevActualStateResolver {
  /**
   * Resolve through host-owned authorization using the supplied trusted ToolContext.
   * The adapter additionally verifies snapshot identity, JSON shape, size and digest.
   */
  resolve(
    input: JevActualStateResolutionInput,
    ctx: ToolContext,
  ): Promise<JevActualStateResolution>
}

export type JevStateResolutionErrorCode =
  | 'NOT_CONFIGURED'
  | 'NOT_FOUND'
  | 'SCOPE_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'DIGEST_MISMATCH'
  | 'INCOMPLETE'
  | 'TOO_LARGE'
  | 'INVALID_STATE'
  | 'UNAVAILABLE'
  | 'CANCELLED'

/** Fixed, typed state-resolution failure; messages must never contain resolved state. */
export class JevStateResolutionError extends Error {
  readonly code: JevStateResolutionErrorCode

  constructor(code: JevStateResolutionErrorCode) {
    super(`JEV state resolution failed: ${code.toLowerCase()}`)
    this.name = 'JevStateResolutionError'
    this.code = code
  }
}

/** Measured usage of a decision call. `usageUnknown` marks a partial report. */
export interface JevUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly usageUnknown?: boolean
}
