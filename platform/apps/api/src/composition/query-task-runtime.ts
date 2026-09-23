import { randomUUID } from 'node:crypto'
import type { RuntimeAdapter, RuntimeCancelReceipt, RuntimeDependencies, RuntimeEvent, RuntimeInput, ResumeInput } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { QueryTaskRegistry, RunTaskAssignments } from './query-tasks'

function eventBase(runId: string, sequence: number) { return { runId, eventId: randomUUID(), sequence, occurredAt: new Date().toISOString() } }

/** Generic bounded runtime: deployment task registrations own every actual query/compute call. */
export class QueryTaskRuntime implements RuntimeAdapter {
  readonly manifest = {
    kind: 'runtime' as const, id: 'runtime-registered-tasks', version: '1.0.0',
    digest: sha256DigestOf('runtime-registered-tasks@1.0.0'),
    contractRange: { min: '1.0.0' }, provides: [], requires: [],
    entrypointRef: { kind: 'package' as const, ref: '@ontology/app-api/query-task-runtime' }, trustStatus: 'local_dev' as const,
  }
  readonly #tasks: QueryTaskRegistry
  readonly #assignments: RunTaskAssignments
  constructor(tasks: QueryTaskRegistry, assignments: RunTaskAssignments) { this.#tasks = tasks; this.#assignments = assignments }

  async *start(input: RuntimeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent> {
    const task = this.#tasks.resolvePinned(input.resolvedProfileRef, input.confirmedContext['taskId'], input.confirmedContext['taskRef'])
    if (task === undefined) {
      yield { type: 'failed', ...eventBase(input.runId, 1), error: { code: 'UNSUPPORTED_QUERY', message: 'the selected profile has no registered task for this run', retryable: false } }
      return
    }
    if (!task.supportsQuestion(input.question)) {
      yield { type: 'failed', ...eventBase(input.runId, 1), error: { code: 'UNSUPPORTED_QUERY', message: 'the selected task does not support this question; choose a matching registered task or clarify the request', retryable: false } }
      return
    }
    this.#assignments.set(input.runId, task)
    let taskInput: Readonly<Record<string, unknown>>
    try { taskInput = this.#tasks.validateInput(task, input.confirmedContext['taskInput'] ?? {}) }
    catch (error) {
      yield { type: 'failed', ...eventBase(input.runId, 1), error: { code: 'INVALID_ARGUMENT', message: error instanceof Error ? error.message : 'task inputs are invalid', retryable: false } }
      return
    }
    let sequence = 0
    let evidenceCount = 0
    try {
      for await (const taskEvent of task.execute({ question: input.question, taskInput, gateway: deps.gateway, ctx: deps.ctx })) {
        sequence += 1
        if (taskEvent.type === 'step_started') {
          yield { type: 'step_started', ...eventBase(input.runId, sequence), stepId: taskEvent.stepId, toolId: taskEvent.toolId, attempt: 1 }
          continue
        }
        if (taskEvent.type === 'failed') {
          yield { type: 'failed', ...eventBase(input.runId, sequence), error: taskEvent.error }
          return
        }
        const result = taskEvent.result
        if (result.status === 'error') {
          yield { type: 'failed', ...eventBase(input.runId, sequence), error: result.error ?? { code: 'SOURCE_UNAVAILABLE', message: 'the registered task source failed', retryable: true } }
          return
        }
        if (result.status === 'empty') {
          yield { type: 'failed', ...eventBase(input.runId, sequence), error: { code: 'INSUFFICIENT_DATA', message: 'no source rows or spans support this task; no ordinary answer was published', retryable: false } }
          return
        }
        if (result.status === 'partial' || result.coverage.truncated) {
          yield { type: 'failed', ...eventBase(input.runId, sequence), error: { code: 'RESULT_TOO_LARGE', message: 'the task source result is incomplete; no complete answer was published', retryable: false } }
          return
        }
        if (result.evidenceRefs.length === 0) {
          yield { type: 'failed', ...eventBase(input.runId, sequence), error: { code: 'EVIDENCE_PERSIST_FAILED', message: 'the task result has no persisted evidence', retryable: false } }
          return
        }
        evidenceCount += result.evidenceRefs.length
        yield { type: 'evidence_added', ...eventBase(input.runId, sequence), evidenceRefs: result.evidenceRefs }
      }
    } catch {
      sequence += 1
      yield { type: 'failed', ...eventBase(input.runId, sequence), error: { code: 'SOURCE_UNAVAILABLE', message: 'registered task execution failed; see the redacted server trace', retryable: true } }
      return
    }
    if (evidenceCount === 0) {
      yield { type: 'failed', ...eventBase(input.runId, sequence + 1), error: { code: 'INSUFFICIENT_DATA', message: 'registered task produced no evidence-backed result', retryable: false } }
      return
    }
    yield { type: 'collection_complete', ...eventBase(input.runId, sequence + 1), draftAllowed: true, evidenceCount }
  }

  resume(input: ResumeInput): AsyncIterable<RuntimeEvent> { return this.#failure(input.runId) }
  async *#failure(runId: string): AsyncIterable<RuntimeEvent> { yield { type: 'failed', ...eventBase(runId, 1), error: { code: 'CHECKPOINT_INCOMPATIBLE', message: 'registered task runtime does not restore cross-turn checkpoints', retryable: false } } }
  cancel(runId: string): Promise<RuntimeCancelReceipt> { return Promise.resolve({ runId, status: 'already_terminal', acceptedAt: new Date().toISOString(), abandonedAttempts: [] }) }
}
