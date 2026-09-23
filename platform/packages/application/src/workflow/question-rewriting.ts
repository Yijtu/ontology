import type {
  ConfirmedContext,
  GenerationPort,
  GenerationRequest,
  ModelRef,
  PlatformError,
  QuestionRewrite,
  ResourceRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

/**
 * Bounded question-rewriting pre-step (SPEC D7.1, ADR-14).
 *
 * It is an explicit, bounded workflow step that runs **before** SQL generation: it
 * disambiguates the question, fills in confirmed context and makes the scope and caliber
 * explicit, then hands the rewritten question to the existing router. It reuses the
 * injected `GenerationPort` — it adds no model port and no public tool — and it never
 * starts a competing loop.
 *
 * Three invariants are enforced here and proven by the test suite:
 *
 * - **Clarify, never guess.** When the question is ambiguous or the scope is insufficient,
 *   the model must return a `clarify` outcome; the router then takes the existing
 *   `clarification_requested` path. A missing value is never defaulted.
 * - **Shared budget.** Every attempt (including a retry after a malformed output) is one
 *   `generate` call, so the existing generation adapter reserves/settles it against the
 *   run's one ledger. The rewriter opens no ledger and resets nothing.
 * - **Explicit failure.** A malformed output or an unavailable model yields a classified
 *   failure; the original question is never returned as a successful rewrite.
 */

/** The rewrite-step contract version recorded on every `QuestionRewrite`. */
export const QUESTION_REWRITE_VERSION = '1.0.0'

const REWRITE_MAX_TOKENS = 512
const DEFAULT_MAX_ATTEMPTS = 2

const REWRITE_SYSTEM_PROMPT = [
  'You rewrite a business question before it is turned into SQL.',
  'Return ONE JSON object and nothing else.',
  'If the question is clear enough to query, return:',
  '{"status":"rewritten","question":"<the rewritten question>"}',
  'Resolve pronouns from the confirmed context, make entities, units and the time window explicit, and keep the original intent.',
  'If the question is ambiguous or the scope/口径 is insufficient to query, do NOT guess: return:',
  '{"status":"clarify","reason":"<what is missing or conflicting>"}',
  'Never invent a value, a time window or a unit that was not given.',
].join('\n')

export interface QuestionRewriteRequest {
  readonly runId: Uuid
  readonly question: string
  readonly context: ConfirmedContext
  readonly evidenceRefs: readonly ResourceRef[]
}

/**
 * The explicit outcome of the bounded rewrite step. `clarify` is a genuine ambiguity the
 * router resolves with the user; `failed` is a classified failure (never a pass-through).
 */
export type QuestionRewriteOutcome =
  | { readonly status: 'rewritten'; readonly rewrite: QuestionRewrite }
  | { readonly status: 'clarify'; readonly reason: string }
  | { readonly status: 'failed'; readonly error: PlatformError }

/**
 * The rewrite step contract. It is a bounded workflow step, not a model port: it takes the
 * already-injected `GenerationPort` at construction and exposes one deterministic operation.
 */
export interface QuestionRewriter {
  rewrite(request: QuestionRewriteRequest, ctx: ToolContext): Promise<QuestionRewriteOutcome>
}

export interface BoundedQuestionRewriterDependencies {
  /** The run's already-injected generation port; the adapter owns its budget settlement. */
  readonly generation: GenerationPort
  readonly modelRef: ModelRef
  /** Bounded retries for a malformed rewrite output; never an unbounded loop. */
  readonly maxAttempts?: number
  readonly now?: () => string
  readonly newId?: () => string
}

export class BoundedQuestionRewriter implements QuestionRewriter {
  readonly #generation: GenerationPort
  readonly #modelRef: ModelRef
  readonly #maxAttempts: number
  readonly #now: () => string
  readonly #newId: () => string

  constructor(dependencies: BoundedQuestionRewriterDependencies) {
    this.#generation = dependencies.generation
    this.#modelRef = dependencies.modelRef
    this.#maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.#now = dependencies.now ?? (() => new Date().toISOString())
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async rewrite(
    request: QuestionRewriteRequest,
    ctx: ToolContext,
  ): Promise<QuestionRewriteOutcome> {
    let lastError: PlatformError | undefined
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      const outcome = await this.#attempt(request, ctx)
      if (outcome.status !== 'failed') return outcome
      lastError = outcome.error
      // A transport/model failure is already retried inside the generation adapter and is
      // terminal here; only a malformed rewrite output is worth one bounded re-ask.
      if (outcome.error.code !== 'INVALID_SCHEMA') break
    }
    return {
      status: 'failed',
      error:
        lastError ?? {
          code: 'INTERNAL_ERROR',
          message: 'the question rewrite produced no outcome',
          retryable: false,
        },
    }
  }

  async #attempt(
    request: QuestionRewriteRequest,
    ctx: ToolContext,
  ): Promise<QuestionRewriteOutcome> {
    const generationRequest: GenerationRequest = {
      role: 'planner',
      messages: [
        { role: 'system', content: REWRITE_SYSTEM_PROMPT },
        { role: 'user', content: request.question },
      ],
      evidenceRefs: [...request.evidenceRefs],
      toolSchemas: [],
      modelRef: this.#modelRef,
      outputLimit: { maxTokens: REWRITE_MAX_TOKENS },
    }

    let text = ''
    try {
      for await (const event of this.#generation.generate(generationRequest, ctx)) {
        if (event.type === 'text_delta') {
          text += event.text
        } else if (event.type === 'error') {
          return { status: 'failed', error: event.error }
        }
      }
    } catch (error) {
      return {
        status: 'failed',
        error: {
          code: 'MODEL_UNAVAILABLE',
          message: `the question rewrite model call failed: ${messageOf(error)}`,
          retryable: true,
        },
      }
    }

    const parsed = parseQuestionRewrite(text)
    if (parsed === undefined) {
      return {
        status: 'failed',
        error: {
          code: 'INVALID_SCHEMA',
          message: 'the rewrite output was not a valid structured rewrite or clarification',
          retryable: true,
        },
      }
    }
    if (parsed.status === 'clarify') {
      return { status: 'clarify', reason: parsed.reason }
    }
    return { status: 'rewritten', rewrite: this.#record(request, parsed.question) }
  }

  #record(request: QuestionRewriteRequest, rewrittenQuestion: string): QuestionRewrite {
    return {
      rewriteId: this.#newId(),
      runId: request.runId,
      version: QUESTION_REWRITE_VERSION,
      originalQuestion: request.question,
      originalDigest: sha256DigestOf(canonicalJson({ question: request.question })),
      rewrittenQuestion,
      rewrittenDigest: sha256DigestOf(canonicalJson({ question: rewrittenQuestion })),
      inputRefs: [...request.evidenceRefs],
      modelRef: this.#modelRef,
      recordedAt: this.#now(),
    }
  }
}

type ParsedRewrite =
  | { readonly status: 'rewritten'; readonly question: string }
  | { readonly status: 'clarify'; readonly reason: string }

/**
 * Validate the model's structured rewrite at runtime instead of trusting it: a malformed
 * or empty candidate yields `undefined`, so the caller records an explicit failure rather
 * than routing an unvalidated question.
 */
export function parseQuestionRewrite(text: string): ParsedRewrite | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const candidate = parsed as Record<string, unknown>
  if (candidate.status === 'rewritten') {
    const question = candidate.question
    if (typeof question !== 'string' || question.trim().length === 0) return undefined
    return { status: 'rewritten', question }
  }
  if (candidate.status === 'clarify') {
    const reason = candidate.reason
    if (typeof reason !== 'string' || reason.trim().length === 0) return undefined
    return { status: 'clarify', reason }
  }
  return undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown failure'
}
