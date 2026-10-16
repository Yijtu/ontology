import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ExecutionModelBindingService,
  ExecutionToolBindingService,
  ModelAssignmentService,
  ModelConnectionService,
  ModelSelectionService,
  ToolAssignmentService,
  ToolConnectionService,
  ToolSelectionService,
} from '@ontology/application'
import { createCoreSearchBinding } from '@ontology/app-api'
import type { GenerationPort, ImmutableArtifactWriter, ModelConnectionDescriptor, ModelExecutionConnectionSnapshot, ToolConnectionDescriptor, ToolContext, ToolTargetScope } from '@ontology/contracts'
import {
  assertModelExecutionSnapshotShape,
  assertToolExecutionSnapshotShape,
  ModelSelectionError,
  SecretValue,
  ToolConnectionError,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '@ontology/core'
import {
  createExecutionModelBindingRuntime,
  createExecutionModelCapabilities,
  modelConnectionComponentRef,
} from '../../apps/api/src/composition/core-execution-model-binding'
import { budgetHarness, generationRequest, recordingEvidence, staticSecretResolver } from './model-company-fixtures'
import {
  TEST_SCOPE,
  adminContext,
  InMemoryCredentialCustodian,
  InMemoryExecutionBindingStore,
  InMemoryExecutionConnectionSnapshotStore,
  InMemoryModelAssignmentStore,
  InMemoryModelConnectionStore,
  RecordingTargetDirectory,
} from './model-settings-fixtures'
import {
  InMemoryExecutionToolBindingStore,
  InMemoryToolAssignmentStore,
  InMemoryToolConnectionStore,
  InMemoryToolCredentialCustodian,
} from './tool-settings-fixtures'

const SPACE: ToolTargetScope = { kind: 'space' }
const EXECUTION = '33333333-3333-4333-8333-333333333333'
const OTHER_EXECUTION = '44444444-4444-4444-8444-444444444444'

const artifacts = {
  putBytes: async () => {
    throw new Error('the search binding test never archives bytes')
  },
} as unknown as ImmutableArtifactWriter

function compat(overrides: Partial<ToolConnectionDescriptor> = {}): ToolConnectionDescriptor {
  return {
    name: '兼容网关',
    adapterType: 'http_compat',
    capabilities: ['web_search'],
    enabled: true,
    endpoint: 'https://search.old.example.com/v1/search',
    ...overrides,
  }
}

function modelDescriptor(overrides: Partial<ModelConnectionDescriptor> = {}): ModelConnectionDescriptor {
  return {
    name: '主生成模型',
    adapterType: 'company_generation',
    protocol: 'openai_compatible',
    capabilities: ['generation', 'research'],
    enabled: true,
    baseUrl: 'https://models.old.example.com',
    endpoint: '/v1/chat/completions',
    platformModelId: 'company-generation',
    providerModelName: 'gpt-company',
    ...overrides,
  }
}

/** A `fetch` that records every URL and answers 500 so no live service is required. */
function recordingFetch(): { readonly urls: string[]; readonly fetchImpl: typeof fetch } {
  const urls: string[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input))
    return new Response('', { status: 500 })
  }) as typeof fetch
  return { urls, fetchImpl }
}

async function generateOnce(port: GenerationPort, modelId: string, ctx: ToolContext): Promise<void> {
  const request = generationRequest({ modelRef: { modelId, version: '1.0.0' } })
  for await (const _event of port.generate(request, ctx)) { void _event }
}

function toolHarness() {
  const connections = new InMemoryToolConnectionStore()
  const assignments = new InMemoryToolAssignmentStore()
  const custodian = new InMemoryToolCredentialCustodian()
  const bindings = new InMemoryExecutionToolBindingStore()
  const snapshots = new InMemoryExecutionConnectionSnapshotStore()
  const targets = new RecordingTargetDirectory()
  const selection = new ToolSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionToolBindingService({ bindings, resolver: selection, connections, snapshots })
  const legacyBindingService = new ExecutionToolBindingService({ bindings, resolver: selection, connections })
  const connectionService = new ToolConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ToolAssignmentService({ assignments, connections, targets })
  return { connections, assignments, custodian, bindings, snapshots, selection, bindingService, legacyBindingService, connectionService, assignmentService, targets }
}

function modelHarness() {
  const connections = new InMemoryModelConnectionStore()
  const assignments = new InMemoryModelAssignmentStore()
  const custodian = new InMemoryCredentialCustodian()
  const bindings = new InMemoryExecutionBindingStore()
  const snapshots = new InMemoryExecutionConnectionSnapshotStore()
  const targets = new RecordingTargetDirectory()
  const connectionService = new ModelConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ModelAssignmentService({ assignments, connections, targets })
  const selectionService = new ModelSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionModelBindingService({ bindings, resolver: selectionService, connections, snapshots })
  const legacyBindingService = new ExecutionModelBindingService({ bindings, resolver: selectionService, connections })
  return { connections, assignments, custodian, bindings, snapshots, targets, connectionService, assignmentService, selectionService, bindingService, legacyBindingService }
}

describe('S02 tool execution-config snapshot', () => {
  it('pins a non-secret snapshot and keeps using the old endpoint after the connection is edited', async () => {
    const h = toolHarness()
    const admin = adminContext()
    const created = await h.connectionService.create({ descriptor: compat(), idempotencyKey: 'snap-tool-0001' }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: created.connectionId }, toolSelections: [] }, admin)

    const recording = recordingFetch()
    const binding = createCoreSearchBinding({
      bindings: h.bindingService, connections: h.connections, credentials: h.custodian, snapshots: h.snapshots,
      scopeRef: TEST_SCOPE, artifacts, targetScope: SPACE, fetchImpl: recording.fetchImpl,
    })
    const first = await binding.resolveForRun(EXECUTION, admin)
    expect(first.state).toBe('available')
    if (first.state !== 'available') return
    expect(first.binding.snapshotRef).toBeDefined()
    const snapshot = await h.snapshots.getToolSnapshot(TEST_SCOPE, created.connectionId, created.revision)
    expect(snapshot?.endpoint).toBe('https://search.old.example.com/v1/search')
    expect(JSON.stringify(snapshot)).not.toContain('tvly')

    // The catalogue row moves to a new endpoint. An in-flight execution must not be retargeted.
    await h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: compat({ endpoint: 'https://search.new.example.com/v1/search' }),
      expectedRevision: created.revision,
      idempotencyKey: 'snap-tool-move-01',
    }, admin)

    const resume = await binding.resolveForRun(EXECUTION, admin)
    expect(resume.state).toBe('available')
    if (resume.state !== 'available') return
    const deadline = new Date(Date.now() + 5_000).toISOString()
    await expect(resume.provider.search(
      { query: 'q', allowedDomains: ['example.com'], limit: 1, deadline, signal: new AbortController().signal },
      admin,
    )).rejects.toBeTruthy()
    expect(recording.urls.length).toBeGreaterThan(0)
    expect(recording.urls.every((url) => url.includes('search.old.example.com'))).toBe(true)
    expect(recording.urls.some((url) => url.includes('search.new.example.com'))).toBe(false)
  })

  it('does not move a bound execution when the default assignment changes', async () => {
    const h = toolHarness()
    const admin = adminContext()
    const a = await h.connectionService.create({ descriptor: compat({ name: '甲' }), idempotencyKey: 'snap-tool-0002-a' }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: a.connectionId }, toolSelections: [] }, admin)
    const binding = createCoreSearchBinding({ bindings: h.bindingService, connections: h.connections, credentials: h.custodian, snapshots: h.snapshots, scopeRef: TEST_SCOPE, artifacts, targetScope: SPACE })
    expect((await binding.resolveForRun(EXECUTION, admin)).state).toBe('available')

    const b = await h.connectionService.create({ descriptor: compat({ name: '乙', endpoint: 'https://search.b.example.com/v1/search' }), idempotencyKey: 'snap-tool-0002-b' }, admin)
    const current = await h.assignments.getAssignmentSet(TEST_SCOPE, SPACE)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: b.connectionId }, toolSelections: [], ...(current === undefined ? {} : { expectedRevision: current.revision }) }, admin)

    const resume = await binding.resolveForRun(EXECUTION, admin)
    expect(resume.state).toBe('available')
    if (resume.state !== 'available') return
    expect(resume.binding.connectionId).toBe(a.connectionId)
    expect(resume.connection.connectionId).toBe(a.connectionId)
  })

  it('revokes the pinned connection without falling through to another', async () => {
    const h = toolHarness()
    const admin = adminContext()
    const a = await h.connectionService.create({ descriptor: compat(), idempotencyKey: 'snap-tool-0003-a' }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: a.connectionId }, toolSelections: [] }, admin)
    const binding = createCoreSearchBinding({ bindings: h.bindingService, connections: h.connections, credentials: h.custodian, snapshots: h.snapshots, scopeRef: TEST_SCOPE, artifacts, targetScope: SPACE })
    expect((await binding.resolveForRun(EXECUTION, admin)).state).toBe('available')

    await h.connectionService.update({
      connectionId: a.connectionId, descriptor: compat({ enabled: false }), expectedRevision: a.revision, idempotencyKey: 'snap-tool-revoke',
    }, admin)
    const b = await h.connectionService.create({ descriptor: compat({ name: '回退' }), idempotencyKey: 'snap-tool-0003-b' }, admin)
    const current = await h.assignments.getAssignmentSet(TEST_SCOPE, SPACE)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: b.connectionId }, toolSelections: [], ...(current === undefined ? {} : { expectedRevision: current.revision }) }, admin)

    const blocked = await binding.resolveForRun(EXECUTION, admin)
    expect(blocked.state).toBe('blocked')
    if (blocked.state !== 'blocked') return
    expect(blocked.reason).toBe('TOOL_BINDING_REVOKED')
  })

  it('blocks a legacy revision-only binding instead of running it on today\'s descriptor', async () => {
    const h = toolHarness()
    const admin = adminContext()
    const created = await h.connectionService.create({ descriptor: compat(), idempotencyKey: 'snap-tool-0004' }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: created.connectionId }, toolSelections: [] }, admin)

    // A binding created without a snapshot store (pre-S02) carries no snapshotRef.
    const legacy = await h.legacyBindingService.ensureBinding({ executionId: EXECUTION, scope: SPACE, toolId: 'web_search' }, admin)
    expect(legacy.snapshotRef).toBeUndefined()

    const binding = createCoreSearchBinding({ bindings: h.bindingService, connections: h.connections, credentials: h.custodian, snapshots: h.snapshots, scopeRef: TEST_SCOPE, artifacts, targetScope: SPACE })
    const blocked = await binding.resolveForRun(EXECUTION, admin)
    expect(blocked.state).toBe('blocked')
    if (blocked.state !== 'blocked') return
    expect(blocked.reason).toBe('TOOL_BINDING_INCOMPLETE')

    // A fresh execution is unaffected and binds a snapshot.
    const fresh = await binding.resolveForRun(OTHER_EXECUTION, admin)
    expect(fresh.state).toBe('available')
    if (fresh.state !== 'available') return
    expect(fresh.binding.snapshotRef).toBeDefined()
  })

  it('rejects a credential in a tool snapshot and blocks a digest-mismatched snapshot', async () => {
    expect(() => assertToolExecutionSnapshotShape({
      schemaVersion: 'tool-execution-connection-snapshot@1', connectionId: randomUUID(), connectionRevision: '1',
      name: 'x', adapterType: 'http_compat', capabilities: ['web_search'], enabled: true, apiKey: 'secret',
    })).toThrow(ToolConnectionError)

    const h = toolHarness()
    const admin = adminContext()
    const created = await h.connectionService.create({ descriptor: compat(), idempotencyKey: 'snap-tool-0005' }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: created.connectionId }, toolSelections: [] }, admin)
    const bound = await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: SPACE, toolId: 'web_search' }, admin)
    // Corrupt the stored snapshot so its digest no longer matches the binding's ref.
    const key = `${TEST_SCOPE.tenantId}:${TEST_SCOPE.spaceId}:${created.connectionId}:${created.revision}`
    const original = h.snapshots.toolSnapshots.get(key)
    if (original === undefined) throw new Error('missing snapshot')
    h.snapshots.toolSnapshots.set(key, { ...original, endpoint: 'https://tampered.example.com/v1/search' })
    expect(sha256DigestOf(canonicalJson(h.snapshots.toolSnapshots.get(key)))).not.toBe(bound.snapshotRef?.digest)

    const binding = createCoreSearchBinding({ bindings: h.bindingService, connections: h.connections, credentials: h.custodian, snapshots: h.snapshots, scopeRef: TEST_SCOPE, artifacts, targetScope: SPACE })
    const blocked = await binding.resolveForRun(EXECUTION, admin)
    expect(blocked.state).toBe('blocked')
    if (blocked.state !== 'blocked') return
    expect(blocked.reason).toBe('TOOL_BINDING_INCOMPLETE')
  })
})

describe('S02 model execution-config snapshot', () => {
  async function assignGeneration(h: ReturnType<typeof modelHarness>, key: string): Promise<{ connectionId: string; revision: string }> {
    const admin = adminContext()
    const created = await h.connectionService.create({ descriptor: modelDescriptor(), idempotencyKey: key, credential: new SecretValue('sk-model-secret') }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' }, defaultSelection: { kind: 'inherit' },
      capabilitySelections: [{ capability: 'generation', selection: { kind: 'connection', connectionId: created.connectionId } }],
    }, admin)
    return { connectionId: created.connectionId, revision: created.revision }
  }

  function runtimeFor(h: ReturnType<typeof modelHarness>, harness: Awaited<ReturnType<typeof budgetHarness>>, fetchImpl?: typeof fetch) {
    return createExecutionModelBindingRuntime({
      scopeRef: TEST_SCOPE, bindings: h.bindings, connections: h.connections, credentials: h.custodian, snapshots: h.snapshots,
      isUsable: (executionId, capability, ctx) => h.bindingService.isUsable(executionId, capability, ctx),
      capabilityDependencies: {
        budget: harness.budget, generationEvidence: recordingEvidence().recorder, jevFallbackPolicy: 'reject',
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
      },
    })
  }

  it('keeps using the pinned base URL after the connection is edited', async () => {
    const h = modelHarness()
    const admin = adminContext()
    const created = await assignGeneration(h, 'snap-model-0001')
    const bound = await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, admin)
    expect(bound.snapshotRef).toBeDefined()
    const snapshot = await h.snapshots.getModelSnapshot(TEST_SCOPE, created.connectionId, created.revision)
    expect(snapshot?.baseUrl).toBe('https://models.old.example.com')
    expect(JSON.stringify(snapshot)).not.toContain('sk-model-secret')

    await h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: modelDescriptor({ baseUrl: 'https://models.new.example.com' }),
      expectedRevision: created.revision,
      idempotencyKey: 'snap-model-move-01',
      credential: new SecretValue('sk-model-secret-2'),
    }, admin)

    const recording = recordingFetch()
    const harness = await budgetHarness({ maxModelTokens: 10_000 })
    const runtime = runtimeFor(h, harness, recording.fetchImpl)
    const resolved = await runtime.capabilitiesForExecution({ executionId: EXECUTION, ledgerId: harness.ledgerId, signal: new AbortController().signal, ctx: admin })
    expect(resolved.generationBlocked).toBe(false)
    expect(resolved.generation).toBeDefined()
    if (resolved.generation === undefined) return
    await generateOnce(resolved.generation, modelConnectionComponentRef({ connectionId: created.connectionId, revision: created.revision }).id, harness.ctx)
    expect(recording.urls.length).toBeGreaterThan(0)
    expect(recording.urls.every((url) => url.includes('models.old.example.com'))).toBe(true)
    expect(recording.urls.some((url) => url.includes('models.new.example.com'))).toBe(false)
  })

  it('fails closed on revocation and never falls through to another model', async () => {
    const h = modelHarness()
    const admin = adminContext()
    const created = await assignGeneration(h, 'snap-model-0002')
    await h.bindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, admin)
    await h.connections.setCredential(TEST_SCOPE, { connectionId: created.connectionId, change: { action: 'clear' } })

    const harness = await budgetHarness({ maxModelTokens: 10_000 })
    const resolved = await runtimeFor(h, harness).capabilitiesForExecution({ executionId: EXECUTION, ledgerId: harness.ledgerId, signal: new AbortController().signal, ctx: admin })
    expect(resolved.generation).toBeUndefined()
    expect(resolved.generationBlocked).toBe(true)
  })

  it('blocks a legacy revision-only model binding', async () => {
    const h = modelHarness()
    const admin = adminContext()
    await assignGeneration(h, 'snap-model-0003')
    const legacy = await h.legacyBindingService.ensureBinding({ executionId: EXECUTION, scope: { kind: 'space' }, capability: 'generation' }, admin)
    expect(legacy.snapshotRef).toBeUndefined()

    const harness = await budgetHarness({ maxModelTokens: 10_000 })
    const resolved = await runtimeFor(h, harness).capabilitiesForExecution({ executionId: EXECUTION, ledgerId: harness.ledgerId, signal: new AbortController().signal, ctx: admin })
    expect(resolved.generation).toBeUndefined()
    expect(resolved.generationBlocked).toBe(true)
  })

  it('rejects a credential in a model snapshot', () => {
    expect(() => assertModelExecutionSnapshotShape({
      schemaVersion: 'model-execution-connection-snapshot@1', connectionId: randomUUID(), revision: '1',
      adapterType: 'company_generation', protocol: 'openai_compatible', capabilities: ['generation'],
      platformModelId: 'p', providerModelName: 'm', apiKey: 'secret',
    })).toThrow(ModelSelectionError)
  })

  it('builds the generation adapter directly from a pinned snapshot config', async () => {
    const harness = await budgetHarness({ maxModelTokens: 10_000 })
    const recording = recordingFetch()
    const connectionId = randomUUID()
    const snapshot: ModelExecutionConnectionSnapshot = {
      schemaVersion: 'model-execution-connection-snapshot@1', connectionId, revision: '1',
      adapterType: 'company_generation', protocol: 'openai_compatible', capabilities: ['generation'],
      baseUrl: 'https://snapshot-only.example.com', endpoint: '/v1/chat/completions',
      platformModelId: 'company-generation', providerModelName: 'gpt-company',
    }
    const capabilities = createExecutionModelCapabilities({
      binding: {
        schemaVersion: 'execution-model-binding@1', executionId: EXECUTION, capability: 'generation',
        connectionId, connectionRevision: '1',
        modelRef: { modelId: connectionId, version: '1' },
        componentRef: modelConnectionComponentRef({ connectionId, revision: '1' }),
        assignmentRevision: '1', resolvedFrom: 'space_capability', boundAt: '2026-10-16T00:00:00Z',
      },
      connection: snapshot,
      dependencies: { budget: harness.budget, generationEvidence: recordingEvidence().recorder, jevFallbackPolicy: 'reject', fetchImpl: recording.fetchImpl },
      secrets: staticSecretResolver(),
      context: { ledgerId: harness.ledgerId, signal: new AbortController().signal },
    })
    expect(capabilities.generation).toBeDefined()
    if (capabilities.generation === undefined) return
    await generateOnce(capabilities.generation, modelConnectionComponentRef({ connectionId, revision: '1' }).id, harness.ctx)
    expect(recording.urls.some((url) => url.includes('snapshot-only.example.com'))).toBe(true)
  })
})
