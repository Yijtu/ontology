import type { CreateRunContext, PlatformError, ProfileRef, ToolContext, ToolGateway, ToolId, ToolResult, VersionRef } from '@ontology/contracts'
import type { DraftWriterPort, DraftWriterRequest, DraftWriterResult } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export interface QueryTaskField {
  readonly name: string
  readonly label: string
  readonly kind: 'text' | 'number' | 'enum'
  readonly required: boolean
  readonly options?: readonly string[]
  readonly maxLength?: number
  readonly unit?: string
  readonly control?: 'input' | 'textarea'
  readonly minimum?: number
  readonly maximum?: number
  readonly defaultValue?: string | number
}

export interface QueryTaskDescriptor {
  readonly taskId: string
  readonly handlerVersion: string
  readonly operationRefs?: readonly VersionRef[]
  readonly label: string
  readonly description: string
  readonly fields: readonly QueryTaskField[]
  readonly taskRef: VersionRef
}

export function defineQueryTaskDescriptor(input: Omit<QueryTaskDescriptor, 'taskRef'> & { readonly version: string }): QueryTaskDescriptor {
  const { version, ...body } = input
  const taskRef = { id: input.taskId, version, digest: sha256DigestOf(canonical({ ...body, version })) }
  return { ...body, taskRef }
}

export interface OperatorActionDescriptor {
  readonly actionId: string
  readonly label: string
  readonly method: 'POST'
  readonly path: string
  readonly fields: readonly QueryTaskField[]
}

export interface QueryTaskExecutionInput {
  readonly question: string
  readonly taskInput: Readonly<Record<string, unknown>>
  readonly gateway: ToolGateway
  readonly ctx: ToolContext
}

export type QueryTaskExecutionEvent =
  | { readonly type: 'step_started'; readonly stepId: string; readonly toolId: ToolId }
  | { readonly type: 'result'; readonly toolId: ToolId; readonly result: ToolResult }
  | { readonly type: 'failed'; readonly error: PlatformError }

export interface RegisteredQueryTask {
  readonly profileRef: ProfileRef
  readonly descriptor: QueryTaskDescriptor
  supportsQuestion(question: string): boolean
  execute(input: QueryTaskExecutionInput): AsyncIterable<QueryTaskExecutionEvent>
  readonly draftWriter: DraftWriterPort
}

export class RunTaskAssignments {
  readonly #byRun = new Map<string, RegisteredQueryTask>()
  set(runId: string, task: RegisteredQueryTask): void { this.#byRun.set(runId, task) }
  get(runId: string): RegisteredQueryTask | undefined { return this.#byRun.get(runId) }
  delete(runId: string): void { this.#byRun.delete(runId) }
}

/** Delegates drafting to the task registered for this run; it never selects a writer by question text. */
export class RegisteredTaskDraftWriter implements DraftWriterPort {
  readonly #assignments: RunTaskAssignments
  constructor(assignments: RunTaskAssignments) { this.#assignments = assignments }
  writeDraft(request: DraftWriterRequest, ctx: ToolContext): Promise<DraftWriterResult> {
    const task = this.#assignments.get(request.runId)
    if (task === undefined) return Promise.reject(new Error('the run has no pinned task draft writer'))
    return task.draftWriter.writeDraft(request, ctx)
  }
}

/** Deployment-owned tasks are registered by profile; the common runtime only dispatches IDs. */
export class QueryTaskRegistry {
  readonly #tasks: ReadonlyMap<string, RegisteredQueryTask>
  readonly #byProfile: ReadonlyMap<string, readonly RegisteredQueryTask[]>

  constructor(tasks: readonly RegisteredQueryTask[]) {
    const taskMap = new Map<string, RegisteredQueryTask>()
    const profileMap = new Map<string, RegisteredQueryTask[]>()
    for (const task of tasks) {
      const { taskRef, ...descriptor } = task.descriptor
      const expectedDigest = sha256DigestOf(canonical({ ...descriptor, version: taskRef.version }))
      if (expectedDigest !== taskRef.digest) throw new Error(`task descriptor digest does not match its content: ${taskRef.id}@${taskRef.version}`)
      const key = `${task.profileRef.id}@${task.profileRef.version}:${task.descriptor.taskId}`
      if (taskMap.has(key)) throw new Error(`duplicate deployment task registration ${key}`)
      taskMap.set(key, task)
      const profileKey = `${task.profileRef.id}@${task.profileRef.version}`
      const registered = profileMap.get(profileKey) ?? []
      registered.push(task)
      profileMap.set(profileKey, registered)
    }
    this.#tasks = taskMap
    this.#byProfile = profileMap
  }

  list(profileRef: ProfileRef): readonly QueryTaskDescriptor[] {
    return (this.#byProfile.get(`${profileRef.id}@${profileRef.version}`) ?? []).map((task) => task.descriptor)
  }

  resolve(profileRef: ProfileRef, taskId: unknown): RegisteredQueryTask | undefined {
    if (typeof taskId !== 'string') return undefined
    return this.#tasks.get(`${profileRef.id}@${profileRef.version}:${taskId}`)
  }

  resolvePinned(profileRef: ProfileRef, taskId: unknown, taskRef: unknown): RegisteredQueryTask | undefined {
    const task = this.resolve(profileRef, taskId)
    if (task === undefined || typeof taskRef !== 'object' || taskRef === null || Array.isArray(taskRef)) return undefined
    const pin = taskRef as Record<string, unknown>
    return pin['id'] === task.descriptor.taskRef.id && pin['version'] === task.descriptor.taskRef.version && pin['digest'] === task.descriptor.taskRef.digest
      ? task
      : undefined
  }

  validateInput(task: RegisteredQueryTask, value: unknown): Readonly<Record<string, unknown>> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('taskInput must be an object')
    const input = value as Record<string, unknown>
    const allowed = new Set(task.descriptor.fields.map((field) => field.name))
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`task input field ${key} is not registered for this task`)
    for (const field of task.descriptor.fields) {
      const fieldValue = input[field.name]
      if (fieldValue === undefined || fieldValue === null || fieldValue === '') {
        if (field.required) throw new Error(`${field.label} is required`)
        continue
      }
      if (field.kind === 'text' && (typeof fieldValue !== 'string' || fieldValue.trim().length === 0 || (field.maxLength !== undefined && fieldValue.length > field.maxLength))) throw new Error(`${field.label} is invalid`)
      if (field.kind === 'number' && (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue))) throw new Error(`${field.label} must be a finite number`)
      if (field.kind === 'number' && typeof fieldValue === 'number' && ((field.minimum !== undefined && fieldValue < field.minimum) || (field.maximum !== undefined && fieldValue > field.maximum))) throw new Error(`${field.label} is outside its allowed range`)
      if (field.kind === 'enum' && (typeof fieldValue !== 'string' || !(field.options ?? []).includes(fieldValue))) throw new Error(`${field.label} is not an allowed option`)
    }
    return input
  }

  prepareRunContext(profileRef: ProfileRef, context: CreateRunContext): CreateRunContext {
    const task = this.resolve(profileRef, context['taskId'])
    if (task === undefined) throw new Error('taskId is not registered for the selected profile')
    const taskInput = this.validateInput(task, context['taskInput'] ?? {})
    const canonicalInput = task.descriptor.fields
      .map((field) => [field.name, taskInput[field.name] ?? null] as const)
      .sort(([left], [right]) => left.localeCompare(right))
    const taskInputDigest = sha256DigestOf(JSON.stringify(canonicalInput))
    return { ...context, taskRef: task.descriptor.taskRef, taskInput, taskInputDigest }
  }
}
