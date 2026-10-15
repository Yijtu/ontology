import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ExecutionModelBindingService, InMemoryRunStore, ModelAssignmentService, ModelConnectionService, ModelSelectionService, RunService } from '@ontology/application'
import type { RunModelBinder, RunModelBindingInput, RunProfileBinder, RunProfileBinding } from '@ontology/application'
import type {
  BudgetLedgerPort,
  ExecutionModelBinding,
  ModelConnectionDescriptor,
  ResourceRef,
  SecretValue as SecretValueType,
  ToolContext,
} from '@ontology/contracts'
import { ModelSelectionError, SecretValue } from '@ontology/contracts'
import {
  catalogueModelComponentRecords,
  createCatalogueModelSecretResolver,
  createExecutionModelBindingRuntime,
  createExecutionModelCapabilities,
  createRunModelBinder,
  modelConnectionComponentRef,
  modelConnectionSecretRef,
} from '../../apps/api/src/composition/core-execution-model-binding'
import {
  TEST_SCOPE,
  adminContext,
  editorContext,
  InMemoryCredentialCustodian,
  InMemoryExecutionBindingStore,
  InMemoryModelAssignmentStore,
  InMemoryModelConnectionStore,
  RecordingProbe,
  RecordingTargetDirectory,
} from './model-settings-fixtures'
import { RUN_A, RecordingControlRepository, fixedClock, toolContext } from './component-registry-fixtures'
import { SCOPE_A } from './profile-resolver-fixtures'

const EXECUTION = '33333333-3333-4333-8333-333333333333'
const OTHER_EXECUTION = '44444444-4444-4444-8444-444444444444'
const DIGEST = `sha256:${'a'.repeat(64)}`

function descriptor(overrides: Partial<ModelConnectionDescriptor> = {}): ModelConnectionDescriptor {
  return {
    name: '主生成模型',
    adapterType: 'company_generation',
    protocol: 'openai_compatible',
    capabilities: ['generation', 'research'],
    enabled: true,
    baseUrl: 'https://models.example.com',
    endpoint: '/v1/chat/completions',
    platformModelId: 'company-generation',
    providerModelName: 'gpt-company',
    ...overrides,
  }
}

function jevDescriptor(overrides: Partial<ModelConnectionDescriptor> = {}): ModelConnectionDescriptor {
  return {
    name: 'JEV 决策模型',
    adapterType: 'jev',
    protocol: 'jev',
    capabilities: ['decision_jev'],
    enabled: true,
    baseUrl: 'https://jev.example.com',
    endpoint: '/v1/systemone',
    platformModelId: 'jev-decision',
    providerModelName: 'jev-1',
    ...overrides,
  }
}

function harness() {
  const connections = new InMemoryModelConnectionStore()
  const assignments = new InMemoryModelAssignmentStore()
  const custodian = new InMemoryCredentialCustodian()
  const bindings = new InMemoryExecutionBindingStore()
  const targets = new RecordingTargetDirectory()
  const probe = new RecordingProbe(custodian)
  const connectionService = new ModelConnectionService({ connections, credentials: custodian, assignments, probe })
  const assignmentService = new ModelAssignmentService({ assignments, connections, targets })
  const selectionService = new ModelSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionModelBindingService({ bindings, resolver: selectionService, connections })
  return { connections, assignments, custodian, bindings, targets, probe, connectionService, assignmentService, selectionService, bindingService }
}

async function createGeneration(h: ReturnType<typeof harness>, name: string): Promise<{ connectionId: string; revision: string }> {
  const created = await h.connectionService.create({
    descriptor: descriptor({ name }),
    idempotencyKey: `create-${name}-${randomUUID().slice(0, 8)}`,
    credential: new SecretValue('sk-execution'),
  }, adminContext())
  return { connectionId: created.connectionId, revision: created.revision }
}

async function setSpaceCapability(h: ReturnType<typeof harness>, capability: 'generation' | 'research' | 'decision_jev', connectionId: string): Promise<void> {
  const current = await h.assignments.getAssignmentSet(TEST_SCOPE, { kind: 'space' })
  const others = (current?.capabilitySelections ?? []).filter((entry) => entry.capability !== capability)
  await h.assignmentService.put({
    scope: { kind: 'space' },
    defaultSelection: current?.defaultSelection ?? { kind: 'inherit' },
    capabilitySelections: [...others, { capability, selection: { kind: 'connection', connectionId } }],
    ...(current === undefined ? {} : { expectedRevision: current.revision }),
  }, adminContext())
}

const budgetStub: BudgetLedgerPort = {
  async openLedger() { throw new Error('not used') },
  async reserve() { throw new Error('not used') },
  async recordIntent() { throw new Error('not used') },
  async settle() { throw new Error('not used') },
  async remaining() { throw new Error('not used') },
}

const resource = (id: string): ResourceRef => ({ id, version: '1.0.0', digest: DIGEST, kind: 'evidence' })

describe('execution model binding: new execution hot-switch, in-flight fixed', () => {
  it('binds once and reads the same binding back after the space default changes', async () => {
    const h = harness()
    const first = await createGeneration(h, 'first')
    await setSpaceCapability(h, 'generation', first.connectionId)

    const bound = await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, adminContext())
    expect(bound.connectionId).toBe(first.connectionId)
    expect(bound.connectionRevision).toBe(first.revision)

    // The space default now points at a different connection. An in-flight execution must not move.
    const second = await createGeneration(h, 'second')
    await setSpaceCapability(h, 'generation', second.connectionId)
    const resume = await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, adminContext())
    expect(resume).toEqual(bound)
    expect(resume.connectionId).toBe(first.connectionId)

    // A brand-new execution picks up the new selection.
    const fresh = await h.bindingService.ensureBinding({ executionId: OTHER_EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, adminContext())
    expect(fresh.connectionId).toBe(second.connectionId)
  })

  it('binds the project target, never the producing workspace', async () => {
    const h = harness()
    h.targets.allowed.add('project:22222222-2222-4222-8222-222222222222')
    const gen = await createGeneration(h, 'project')
    await h.assignments.putAssignmentSet(TEST_SCOPE, {
      set: {
        schemaVersion: 'model-assignment-set@1',
        scope: { kind: 'project', projectId: '22222222-2222-4222-8222-222222222222' },
        defaultSelection: { kind: 'connection', connectionId: gen.connectionId },
        capabilitySelections: [],
        revision: '0',
        updatedAt: '2026-10-15T00:00:00Z',
      },
    })
    const bound = await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'project', projectId: '22222222-2222-4222-8222-222222222222' }, capability: 'generation' }, adminContext())
    expect(bound.connectionId).toBe(gen.connectionId)
  })
})

describe('execution model binding: no-model startup stays explicit', () => {
  it('refuses to bind an unconfigured capability with a stable reason', async () => {
    const h = harness()
    await expect(h.bindingService.bind({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, adminContext()))
      .rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
  })

  it('reports a missing binding explicitly when the fence is asked to assert usability', async () => {
    const h = harness()
    await expect(h.bindingService.assertUsable(EXECUTION, 'generation', adminContext()))
      .rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' })
    expect(await h.bindingService.isUsable(EXECUTION, 'generation', adminContext())).toBe(false)
  })
})

describe('execution model binding: revocation fence', () => {
  it('blocks a disabled pinned connection and never falls through to another model', async () => {
    const h = harness()
    const gen = await createGeneration(h, 'fence')
    await setSpaceCapability(h, 'generation', gen.connectionId)
    const bound = await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, adminContext())
    const current = await h.connections.getConnection(TEST_SCOPE, gen.connectionId)
    expect(current).toBeDefined()

    await h.connections.putConnection(TEST_SCOPE, {
      connectionId: gen.connectionId,
      descriptor: descriptor({ name: 'fence', enabled: false }),
      expectedRevision: current!.revision,
      idempotencyKey: 'disable-fence-0001',
    })

    expect(await h.bindingService.isUsable(EXECUTION, 'generation', adminContext())).toBe(false)
    await expect(h.bindingService.assertUsable(EXECUTION, 'generation', adminContext()))
      .rejects.toMatchObject({ code: 'MODEL_BINDING_REVOKED' })
    // The binding itself is immutable, unrevoked evidence of what the execution pinned.
    expect(await h.bindingService.readBack(EXECUTION, 'generation', adminContext())).toEqual(bound)

    // A different, still-usable connection exists, but the revoked execution must not switch to it.
    const other = await createGeneration(h, 'fallback')
    await setSpaceCapability(h, 'generation', other.connectionId)
    expect(await h.bindingService.isUsable(EXECUTION, 'generation', adminContext())).toBe(false)
  })

  it('blocks a cleared credential on the pinned connection', async () => {
    const h = harness()
    const gen = await createGeneration(h, 'clear')
    await setSpaceCapability(h, 'generation', gen.connectionId)
    await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, adminContext())
    await h.connections.setCredential(TEST_SCOPE, { connectionId: gen.connectionId, change: { action: 'clear' } })
    expect(await h.bindingService.isUsable(EXECUTION, 'generation', adminContext())).toBe(false)
    await expect(h.bindingService.assertUsable(EXECUTION, 'generation', adminContext()))
      .rejects.toMatchObject({ code: 'MODEL_BINDING_REVOKED' })
  })
})

describe('execution model binding: composition wire-up', () => {
  async function wired(descriptorOverride: ModelConnectionDescriptor) {
    const h = harness()
    const created = await h.connectionService.create({ descriptor: descriptorOverride, idempotencyKey: `wired-${randomUUID().slice(0, 8)}`, credential: new SecretValue('sk-wired') }, adminContext())
    const connection = await h.connections.getConnection(TEST_SCOPE, created.connectionId)
    if (connection === undefined) throw new Error('missing connection')
    const capability = connection.capabilities[0] ?? 'generation'
    await setSpaceCapability(h, capability, created.connectionId)
    const bound = await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability }, adminContext())
    return { h, connection, bound }
  }

  it('produces a generation port only for a generation connection', async () => {
    const { connection, bound } = await wired(descriptor())
    const capabilities = createExecutionModelCapabilities({
      binding: bound,
      connection,
      dependencies: { budget: budgetStub, generationEvidence: { async record() { return resource('gen-evidence') } }, jevFallbackPolicy: 'reject' },
      secrets: { async resolve() { throw new Error('not used') } },
      context: { ledgerId: randomUUID(), signal: new AbortController().signal },
    })
    expect(capabilities.generation).toBeDefined()
    expect(capabilities.decision).toBeUndefined()
  })

  it('produces a decision port only for a JEV connection', async () => {
    const { connection, bound } = await wired(jevDescriptor())
    const capabilities = createExecutionModelCapabilities({
      binding: bound,
      connection,
      dependencies: { budget: budgetStub, decisionEvidence: { async record() { return resource('dec-evidence') } }, jevFallbackPolicy: 'clarify' },
      secrets: { async resolve() { throw new Error('not used') } },
      context: { ledgerId: randomUUID(), signal: new AbortController().signal },
    })
    expect(capabilities.decision).toBeDefined()
    expect(capabilities.generation).toBeUndefined()
  })

  it('keeps the binding component ref identical to the registered connection component ref', async () => {
    const { connection, bound } = await wired(descriptor())
    expect(bound.componentRef).toEqual(modelConnectionComponentRef(connection))
  })

  it('registers catalogue connections as components that match their bindings', async () => {
    const h = harness()
    const gen = await createGeneration(h, 'component')
    const jev = await h.connectionService.create({ descriptor: jevDescriptor(), idempotencyKey: 'component-jev-01', credential: new SecretValue('sk-jev') }, adminContext())
    const genView = await h.connections.getConnection(TEST_SCOPE, gen.connectionId)
    const jevView = await h.connections.getConnection(TEST_SCOPE, jev.connectionId)
    if (genView === undefined || jevView === undefined) throw new Error('missing connection')
    const records = catalogueModelComponentRecords([genView, jevView], '2026-10-15T00:00:00Z')
    expect(records.map((record) => record.manifest.kind).sort()).toEqual(['decision', 'generation'])
    expect(records.find((record) => record.manifest.kind === 'generation')?.manifestRef).toEqual(modelConnectionComponentRef(genView))
    expect(records.find((record) => record.manifest.kind === 'decision')?.manifestRef).toEqual(modelConnectionComponentRef(jevView))
  })

  it('exposes a catalogue secret resolver that never returns a value for an unknown ref', async () => {
    const h = harness()
    const created = await h.connectionService.create({ descriptor: descriptor(), idempotencyKey: 'sec-0001', credential: new SecretValue('sk-secret-value') }, adminContext())
    const resolver = createCatalogueModelSecretResolver({ connections: h.connections, credentials: h.custodian, scopeRef: TEST_SCOPE })
    const value: SecretValueType = await resolver.resolve(modelConnectionSecretRef(created.connectionId), adminContext())
    expect(value.reveal()).toBe('sk-secret-value')
    expect(`${value}`).not.toContain('sk-secret-value')
    await expect(resolver.resolve('not-a-connection-ref', adminContext())).rejects.toBeInstanceOf(ModelSelectionError)
  })

  it('fails closed at run time: absent, ready and blocked are distinguished', async () => {
    const h = harness()
    const runtime = createExecutionModelBindingRuntime({
      scopeRef: TEST_SCOPE,
      bindings: h.bindings,
      connections: h.connections,
      credentials: h.custodian,
      isUsable: (executionId, capability, ctx) => h.bindingService.isUsable(executionId, capability, ctx),
      capabilityDependencies: { budget: budgetStub, generationEvidence: { async record() { return resource('gen') } }, jevFallbackPolicy: 'reject' },
    })
    const context = { ledgerId: randomUUID(), signal: new AbortController().signal, ctx: adminContext() }

    // No binding at all: the legacy environment path stays in charge.
    const absent = await runtime.capabilitiesForExecution({ executionId: EXECUTION, ...context })
    expect(absent.generation).toBeUndefined()
    expect(absent.generationBlocked).toBe(false)

    const gen = await createGeneration(h, 'runtime')
    await setSpaceCapability(h, 'generation', gen.connectionId)
    await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, adminContext())
    const ready = await runtime.capabilitiesForExecution({ executionId: EXECUTION, ...context })
    expect(ready.generation).toBeDefined()
    expect(ready.generationBlocked).toBe(false)

    const current = await h.connections.getConnection(TEST_SCOPE, gen.connectionId)
    await h.connections.putConnection(TEST_SCOPE, { connectionId: gen.connectionId, descriptor: descriptor({ enabled: false }), expectedRevision: current!.revision, idempotencyKey: 'runtime-disable-01' })
    const blocked = await runtime.capabilitiesForExecution({ executionId: EXECUTION, ...context })
    expect(blocked.generation).toBeUndefined()
    expect(blocked.generationBlocked).toBe(true)
  })
})

describe('run acceptance fixes the execution model before dispatch', () => {
  const PROFILE_BINDING: RunProfileBinding = {
    profileRef: { id: 'home-energy-demo', version: '1.0.0' },
    resolvedProfileHash: DIGEST,
    resolvedProfileRef: { id: 'home-energy-demo', version: '1.0.0', snapshotHash: DIGEST },
    runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
  }

  class FakeProfileBinder implements RunProfileBinder {
    async bindProfileForRun(): Promise<RunProfileBinding> {
      return PROFILE_BINDING
    }
  }

  class RecordingModelBinder implements RunModelBinder {
    readonly calls: RunModelBindingInput[] = []
    constructor(private readonly delegate?: (input: RunModelBindingInput) => Promise<ExecutionModelBinding | undefined>) {}
    bindModelForRun(input: RunModelBindingInput): Promise<ExecutionModelBinding | undefined> {
      this.calls.push(input)
      return this.delegate === undefined ? Promise.resolve(undefined) : this.delegate(input)
    }
  }

  const owner: ToolContext = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'owner-a', RUN_A)

  it('invokes the model binder exactly once before the run is persisted, and not on idempotent replay', async () => {
    const model = new RecordingModelBinder()
    const service = new RunService({ store: new InMemoryRunStore(), control: new RecordingControlRepository(), profiles: new FakeProfileBinder(), modelBinding: model, now: fixedClock(), newId: () => randomUUID() })
    const input = { runId: RUN_A, profileRef: PROFILE_BINDING.profileRef, question: 'q', context: { timeZone: 'Asia/Shanghai' }, preferences: { route: 'auto' as const, allowWeb: false }, idempotencyKey: 'idem-model-0001' }
    await service.createRun(input, owner)
    expect(model.calls).toHaveLength(1)
    expect(model.calls[0]?.runId).toBe(RUN_A)

    await service.createRun(input, owner)
    expect(model.calls).toHaveLength(1)
  })

  it('surfaces a failed fix instead of creating the run', async () => {
    const model = new RecordingModelBinder(async () => { throw new ModelSelectionError('MODEL_BINDING_REVOKED', 'nope') })
    const store = new InMemoryRunStore()
    const service = new RunService({ store, control: new RecordingControlRepository(), profiles: new FakeProfileBinder(), modelBinding: model, now: fixedClock(), newId: () => randomUUID() })
    await expect(service.createRun({ runId: RUN_A, profileRef: PROFILE_BINDING.profileRef, question: 'q', context: { timeZone: 'Asia/Shanghai' }, preferences: { route: 'auto', allowWeb: false }, idempotencyKey: 'idem-model-0002' }, owner)).rejects.toBeInstanceOf(ModelSelectionError)
  })

  it('binds each available capability from the catalogue under a server context', async () => {
    const h = harness()
    const gen = await createGeneration(h, 'binder')
    const jevCreated = await h.connectionService.create({ descriptor: jevDescriptor(), idempotencyKey: 'binder-jev-01', credential: new SecretValue('sk-jev') }, adminContext())
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: gen.connectionId },
      capabilitySelections: [{ capability: 'decision_jev', selection: { kind: 'connection', connectionId: jevCreated.connectionId } }],
    }, adminContext())

    const binder = createRunModelBinder({ selection: h.selectionService, bindings: h.bindingService, serverContext: () => adminContext() })
    const bound = await binder.bindModelForRun({ runId: EXECUTION, profileBinding: PROFILE_BINDING }, TEST_SCOPE, editorContext())
    expect(bound?.connectionId).toBe(gen.connectionId)
    expect((await h.bindingService.readBack(EXECUTION, 'generation', adminContext()))?.connectionId).toBe(gen.connectionId)
    expect((await h.bindingService.readBack(EXECUTION, 'decision_jev', adminContext()))?.connectionId).toBe(jevCreated.connectionId)
  })

  it('leaves no binding when the catalogue is empty, so deterministic runs still start', async () => {
    const h = harness()
    const binder = createRunModelBinder({ selection: h.selectionService, bindings: h.bindingService, serverContext: () => adminContext() })
    const bound = await binder.bindModelForRun({ runId: EXECUTION, profileBinding: PROFILE_BINDING }, TEST_SCOPE, editorContext())
    expect(bound).toBeUndefined()
    expect(await h.bindingService.readBack(EXECUTION, 'generation', adminContext())).toBeUndefined()
  })
})
