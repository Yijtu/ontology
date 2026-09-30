import { AnswerStoreError, isToolContext } from '@ontology/contracts'
import type {
  AnswerStorePort,
  PublishedAnswer,
  RecordAnswerInput,
  RunStore,
  ScopeRef,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { WorkflowControllerError } from './errors'

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new WorkflowControllerError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/**
 * Reference answer store for unit tests and local composition. It mirrors the real adapter's
 * atomicity contract: the run state and revision are re-read in the same call as the insert,
 * so a run cancelled between verification and publication can never leave an answer row.
 * It is append-only per run: a repeated record of the same run returns the stored answer.
 */
export class InMemoryAnswerStore implements AnswerStorePort {
  readonly #runs: RunStore
  readonly #answers = new Map<string, PublishedAnswer>()
  readonly #answersById = new Map<string, PublishedAnswer>()

  constructor(runs: RunStore) {
    this.#runs = runs
  }

  async record(input: RecordAnswerInput, ctx: ToolContext): Promise<PublishedAnswer> {
    if (input.answer.body === undefined && input.answer.v3Body === undefined) {
      throw new AnswerStoreError('ANSWER_BODY_REQUIRED', 'new answer publications must persist the verified body')
    }
    const scopeRef = scopeOf(ctx)
    const key = `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000${input.answer.runId}`
    const existing = this.#answers.get(key)
    if (existing !== undefined) {
      if (existing.contentHash !== input.answer.contentHash || existing.draftId !== input.answer.draftId || canonical(existing.body) !== canonical(input.answer.body) || canonical(existing.v3Body) !== canonical(input.answer.v3Body)) {
        throw new AnswerStoreError('ANSWER_IDEMPOTENCY_CONFLICT', `run ${input.answer.runId} already has a different immutable answer`)
      }
      return clone(existing)
    }

    const run = await this.#runs.getRun(scopeRef, input.answer.runId, ctx)
    if (run === undefined) {
      throw new AnswerStoreError('RUN_NOT_PUBLISHABLE', 'the run is not visible in this scope')
    }
    if (run.state !== input.expectedRunState || run.revision !== input.expectedRunRevision) {
      throw new AnswerStoreError(
        'RUN_NOT_PUBLISHABLE',
        `run ${input.answer.runId} is ${run.state} at revision ${run.revision} and is not publishable`,
      )
    }
    this.#answers.set(key, clone(input.answer))
    this.#answersById.set(`${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000${input.answer.answerId}`, clone(input.answer))
    return clone(input.answer)
  }

  findByRun(runId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined> {
    const scopeRef = scopeOf(ctx)
    const found = this.#answers.get(`${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000${runId}`)
    return Promise.resolve(found === undefined ? undefined : clone(found))
  }

  findByAnswer(answerId: Uuid, ctx: ToolContext): Promise<PublishedAnswer | undefined> {
    const scopeRef = scopeOf(ctx)
    const found = this.#answersById.get(`${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000${answerId}`)
    return Promise.resolve(found === undefined ? undefined : clone(found))
  }
}
