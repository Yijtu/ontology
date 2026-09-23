import type {
  BudgetLedgerPort,
  GenerationCompleted,
  GenerationRole,
  ResourceRef,
  SecretResolver,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'

/**
 * Host-injected dependencies and public configuration for the company generation
 * adapter (SPEC C2, §4.2). Everything here is expressed in canonical contracts; the
 * vendor request/response/stream shapes stay inside `src/vendor` and never appear in
 * this public surface.
 */

/**
 * Result of validating a structured generation candidate against its published schema.
 * The schema registry (and therefore the validator) belongs to the host; the adapter
 * only asks whether the candidate it streamed is acceptable.
 */
export interface CandidateValidationResult {
  readonly valid: boolean
  /** JSON-pointer style messages; only meaningful when `valid` is false. */
  readonly errors?: readonly string[]
}

/** Resolves a `responseSchemaRef` to a validator owned by the schema registry. */
export interface ResponseSchemaValidator {
  validate(
    responseSchemaRef: VersionRef,
    candidate: unknown,
    ctx: ToolContext,
  ): Promise<CandidateValidationResult>
}

/**
 * What a successful model call produced, before it is settled. The model output is
 * recorded as `model_output` evidence (untrusted data, never a published answer) so a
 * `completed` settlement always names persisted evidence (SPEC §8, C4).
 */
export interface ModelCallEvidenceRequest {
  readonly runId: Uuid
  readonly role: GenerationRole
  readonly outputDigest: Sha256Digest
  readonly stopReason: GenerationCompleted['stopReason']
}

export interface ModelCallEvidenceRecorder {
  record(request: ModelCallEvidenceRequest, ctx: ToolContext): Promise<ResourceRef>
}

/**
 * Structured log record. The adapter never puts a resolved secret into `message` or
 * `fields`; every value it logs is already classified and scrubbed.
 */
export interface ModelAdapterLogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly fields?: Readonly<Record<string, unknown>>
}

export type ModelAdapterLogger = (record: ModelAdapterLogRecord) => void

/**
 * Maps a platform model id to the vendor's own model identifier. The platform model id
 * in `GenerationRequest.modelRef` is never sent on the wire.
 */
export interface CompanyModelBinding {
  readonly vendorModel: string
}

/**
 * Wire protocol a configured company gateway speaks. It selects the decode codec only;
 * the emitted `GenerationEvent`s keep the same meaning either way (SPEC C2, §4.2).
 *
 *   - `private`: the gateway's own `{ type: ... }` chunk protocol (the original path);
 *   - `openai-compatible`: `chat/completions` streaming — `data: {...}` chunks, text and
 *     fragmented tool-call deltas, `finish_reason`, `usage`, terminated by `data: [DONE]`.
 */
export type CompanyModelProtocol = 'private' | 'openai-compatible'

export interface CompanyGenerationAdapterConfig {
  /** Base URL of the company generation API, e.g. `http://127.0.0.1:0`. */
  readonly baseUrl: string
  /** Stream path; defaults to `/v1/generate`. */
  readonly endpoint?: string
  /**
   * Wire protocol the gateway speaks. Defaults to `private` so an existing deployment is
   * unchanged; an OpenAI-compatible gateway must opt in explicitly.
   */
  readonly protocol?: CompanyModelProtocol
  /** Opaque server-side reference; resolved per call through the injected resolver. */
  readonly secretRef: string
  readonly models: Readonly<Record<string, CompanyModelBinding>>
  readonly secrets: SecretResolver
  readonly budget: BudgetLedgerPort
  /** The run's single shared ledger (SPEC D7.2). Retries never open a second one. */
  readonly ledgerId: Uuid
  readonly evidence: ModelCallEvidenceRecorder
  readonly schemaValidator?: ResponseSchemaValidator
  readonly log?: ModelAdapterLogger
  /** Total attempts per generate call, including the first. Defaults to 3 (1 + 2). */
  readonly maxAttempts?: number
  /** Additional per-request cap; the run deadline still wins when it is earlier. */
  readonly requestTimeoutMs?: number
  /** Run cancellation signal, injected by the controller/host (C2 RuntimeDependencies.signal). */
  readonly signal?: AbortSignal
  /** Backoff before a retry when the provider did not send `Retry-After`. Defaults to 200ms. */
  readonly retryBaseDelayMs?: number
  /** Id source, injected so a call's reservation keys are reproducible in tests. */
  readonly newId?: () => string
  readonly fetchImpl?: typeof fetch
}
