import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryRunStore, RunService, RunServiceError, parseCreateRunRequest } from '@ontology/application'
import type { RunExecutionBinder, RunProfileBinder, RunProfileBinding } from '@ontology/application'
import type {
  ProfileRef,
  ResourceRef,
  RunExecutionBinding,
  RunExecutionRequest,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { RUN_A, RecordingControlRepository, fixedClock, toolContext } from './component-registry-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'

const DIGEST = `sha256:${'a'.repeat(64)}`
const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const RUNTIME_REF: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: DIGEST }
const PROJECT_ID = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const INPUT_REF: ResourceRef = { id: PROJECT_ID, version: '1.0.0', digest: DIGEST, kind: 'artifact' }
const EXECUTION_BINDING_REF: ResourceRef = { id: RUN_A, version: '1.0.0', digest: DIGEST, kind: 'plan' }

const executionRequest: RunExecutionRequest = {
  mode: 'task',
  projectRevisionRef: { projectId: PROJECT_ID, revision: '2', digest: DIGEST },
  inputSnapshotRef: INPUT_REF,
  inputSnapshotDigest: DIGEST,
  taskBindingRef: { id: 'task.demo.count', version: '1.0.0', digest: DIGEST },
  parameters: { windowDays: 30 },
}

function executionBinding(): RunExecutionBinding {
  return {
    schemaVersion: 'run-execution-binding@1',
    runId: RUN_A,
    request: executionRequest,
    resolvedProfileRef: { id: PROFILE_REF.id, version: PROFILE_REF.version, snapshotHash: DIGEST },
    runtimeRef: RUNTIME_REF,
    allowedTaskBindingRefs: [{ id: 'task.demo.count', version: '1.0.0', digest: DIGEST }],
    inputManifestDigestAtCreation: DIGEST,
    effectiveLimitsRef: { id: 'core-limits', version: '1.0.0', digest: DIGEST },
    effectiveTime: { validAt: '2026-09-21T00:00:00Z', asOfRecordedSeq: '5' },
  }
}

class FakeProfileBinder implements RunProfileBinder {
  async bindProfileForRun(): Promise<RunProfileBinding> {
    return {
      profileRef: PROFILE_REF,
      resolvedProfileHash: DIGEST,
      resolvedProfileRef: { id: PROFILE_REF.id, version: PROFILE_REF.version, snapshotHash: DIGEST },
      runtimeRef: RUNTIME_REF,
    }
  }
}

class FakeExecutionBinder implements RunExecutionBinder {
  readonly calls: { readonly runId: string; readonly mode: string }[] = []
  async bindExecution(input: { runId: string; request: RunExecutionRequest }): Promise<{
    executionBindingRef: ResourceRef
    binding: RunExecutionBinding
  }> {
    this.calls.push({ runId: input.runId, mode: input.request.mode })
    return { executionBindingRef: EXECUTION_BINDING_REF, binding: executionBinding() }
  }
}

function makeService(execution?: RunExecutionBinder) {
  const store = new InMemoryRunStore()
  const service = new RunService({
    store,
    control: new RecordingControlRepository(),
    profiles: new FakeProfileBinder(),
    ...(execution === undefined ? {} : { execution }),
    now: fixedClock(),
    newId: () => randomUUID(),
  })
  return { service, store }
}

function createInput(execution?: RunExecutionRequest) {
  return {
    runId: RUN_A,
    profileRef: PROFILE_REF,
    question: 'run the bound task',
    context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
    preferences: { route: 'auto' as const, allowWeb: false },
    idempotencyKey: 'idem-task-0001',
    ...(execution === undefined ? {} : { execution }),
  }
}

const OWNER_A: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', RUN_A)

async function expectError(run: () => Promise<unknown>): Promise<RunServiceError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof RunServiceError) return error
    throw error
  }
  throw new Error('expected a RunServiceError')
}

describe('RunService optional task execution binding', () => {
  it('resolves and pins the execution binding when the request carries a task', async () => {
    const execution = new FakeExecutionBinder()
    const { service } = makeService(execution)
    const result = await service.createRun(createInput(executionRequest), OWNER_A)
    expect(result.reused).toBe(false)
    expect(result.executionBindingRef).toEqual(EXECUTION_BINDING_REF)
    expect(execution.calls).toEqual([{ runId: RUN_A, mode: 'task' }])

    const view = await service.getRun(RUN_A, OWNER_A)
    expect(view.executionBindingRef).toEqual(EXECUTION_BINDING_REF)
  })

  it('replays the same run and binding for a repeated idempotency key', async () => {
    const execution = new FakeExecutionBinder()
    const { service } = makeService(execution)
    await service.createRun(createInput(executionRequest), OWNER_A)
    const replay = await service.createRun(createInput(executionRequest), OWNER_A)
    expect(replay.reused).toBe(true)
    expect(replay.executionBindingRef).toEqual(EXECUTION_BINDING_REF)
    expect(execution.calls).toHaveLength(1)
  })

  it('treats a different task under the same idempotency key as a conflict', async () => {
    const { service } = makeService(new FakeExecutionBinder())
    await service.createRun(createInput(executionRequest), OWNER_A)
    const error = await expectError(() =>
      service.createRun(createInput({ ...executionRequest, parameters: { windowDays: 90 } }), OWNER_A),
    )
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('rejects a task request when the host has no execution binder', async () => {
    const { service } = makeService()
    const error = await expectError(() => service.createRun(createInput(executionRequest), OWNER_A))
    expect(error.code).toBe('CAPABILITY_NOT_CONFIGURED')
  })

  it('keeps the existing question path working without a binding', async () => {
    const { service } = makeService()
    const result = await service.createRun(createInput(), OWNER_A)
    expect(result.reused).toBe(false)
    expect(result.executionBindingRef).toBeUndefined()
  })
})

describe('parseCreateRunRequest task parsing', () => {
  const base = {
    profileRef: PROFILE_REF,
    question: 'q',
    context: { timeZone: 'Asia/Shanghai' },
    preferences: { route: 'auto' as const, allowWeb: false },
  } as const

  it('parses a valid task binding', () => {
    const parsed = parseCreateRunRequest({ ...base, task: executionRequest })
    expect(parsed.execution).toEqual(executionRequest)
  })

  it('leaves the execution undefined when no task is present', () => {
    expect(parseCreateRunRequest({ ...base }).execution).toBeUndefined()
  })

  it('rejects a malformed task binding', () => {
    expect(() => parseCreateRunRequest({ ...base, task: { mode: 'task' } })).toThrow(RunServiceError)
  })
})
