import { describe, expect, it } from 'vitest'
import {
  ExecutionModelBindingService,
  ModelAssignmentService,
  ModelConnectionService,
  ModelSelectionService,
} from '@ontology/application'
import { ModelSelectionError, SecretValue } from '@ontology/contracts'
import type { ModelConnectionDescriptor, ModelTargetScope } from '@ontology/contracts'
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
  const bindingService = new ExecutionModelBindingService({ bindings, resolver: selectionService })
  return { connections, assignments, custodian, bindings, targets, probe, connectionService, assignmentService, selectionService, bindingService }
}

const WORKSPACE: ModelTargetScope = { kind: 'industry_workspace', workspaceId: '22222222-2222-4222-8222-222222222222' }

describe('ModelConnectionService credentials', () => {
  it('never echoes an API key in a view, summary or test result', async () => {
    const h = harness()
    const admin = adminContext()
    const created = await h.connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'create-key-0001',
      credential: new SecretValue('sk-super-secret-value'),
    }, admin)

    expect(JSON.stringify(created)).not.toContain('sk-super-secret-value')
    expect(created.credentialState).toBe('present')
    expect(await h.connections.getCredentialRef(TEST_SCOPE, created.connectionId)).toBeDefined()

    const result = await h.connectionService.testStored(created.connectionId, admin)
    expect(result.credentialConfigured).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sk-super-secret-value')
    expect(h.probe.calls[0]?.credentialRef).toBeDefined()

    const view = await h.connectionService.get(created.connectionId, admin)
    expect(JSON.stringify(view)).not.toContain('sk-super-secret-value')
    expect(view?.testSummary?.status).toBe('passed')
    expect(view?.testSummary?.revision).toBe(view?.revision)
  })

  it('copies only non-sensitive fields: new id, disabled, no credential', async () => {
    const h = harness()
    const admin = adminContext()
    const source = await h.connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'create-key-0002',
      credential: new SecretValue('sk-source-secret'),
    }, admin)
    const copy = await h.connectionService.copy({
      sourceConnectionId: source.connectionId,
      name: '副本',
      idempotencyKey: 'copy-key-0002',
    }, admin)

    expect(copy.connectionId).not.toBe(source.connectionId)
    expect(copy.enabled).toBe(false)
    expect(copy.name).toBe('副本')
    expect(copy.credentialState).toBe('missing')
    expect(await h.connections.getCredentialRef(TEST_SCOPE, copy.connectionId)).toBeUndefined()
  })

  it('enforces CAS on edit and requires a re-entered key when the address changes', async () => {
    const h = harness()
    const admin = adminContext()
    const created = await h.connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'create-key-0003',
      credential: new SecretValue('sk-address-secret'),
    }, admin)

    await expect(h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: descriptor(),
      expectedRevision: '999',
      idempotencyKey: 'update-key-0003',
    }, admin)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    await expect(h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: descriptor({ baseUrl: 'https://other.example.com' }),
      expectedRevision: created.revision,
      idempotencyKey: 'update-key-0004',
    }, admin)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    const updated = await h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: descriptor({ baseUrl: 'https://other.example.com' }),
      expectedRevision: created.revision,
      idempotencyKey: 'update-key-0005',
      credential: new SecretValue('sk-address-secret-2'),
    }, admin)
    expect(updated.credentialState).toBe('present')
    expect(BigInt(updated.revision)).toBeGreaterThan(BigInt(created.revision))
  })

  it('refuses to delete a connection still named by an assignment', async () => {
    const h = harness()
    const admin = adminContext()
    const connection = await h.connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'create-key-0006',
      credential: new SecretValue('sk-in-use'),
    }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: connection.connectionId },
      capabilitySelections: [],
    }, admin)

    await expect(h.connectionService.remove(connection.connectionId, admin))
      .rejects.toMatchObject({ code: 'MODEL_IN_USE' })

    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'disabled' },
      capabilitySelections: [],
      expectedRevision: '1',
    }, admin)
    await h.connectionService.remove(connection.connectionId, admin)
    expect(await h.connectionService.get(connection.connectionId, admin)).toBeUndefined()
  })

  it('discards a draft credential after testing it', async () => {
    const h = harness()
    await h.connectionService.testDraft({
      descriptor: descriptor(),
      credential: new SecretValue('sk-draft-secret'),
    }, adminContext())
    expect(h.custodian.values.size).toBe(0)
    expect(h.custodian.active.size).toBe(0)
  })
})

describe('ModelAssignmentService validation', () => {
  it('rejects a JEV connection for a generation default and a generation adapter for JEV', async () => {
    const h = harness()
    const admin = adminContext()
    const jev = await h.connectionService.create({ descriptor: jevDescriptor(), idempotencyKey: 'jev-key-0001' }, admin)
    const gen = await h.connectionService.create({ descriptor: descriptor(), idempotencyKey: 'gen-key-0001' }, admin)

    await expect(h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: jev.connectionId },
      capabilitySelections: [],
    }, admin)).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_MISMATCH' })

    await expect(h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'disabled' },
      capabilitySelections: [{ capability: 'decision_jev', selection: { kind: 'connection', connectionId: gen.connectionId } }],
    }, admin)).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_MISMATCH' })

    const ok = await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: gen.connectionId },
      capabilitySelections: [{ capability: 'decision_jev', selection: { kind: 'connection', connectionId: jev.connectionId } }],
    }, admin)
    expect(ok.revision).toBe('1')
  })

  it('requires the platform-admin role for the space default but allows an editor to override an object', async () => {
    const h = harness()
    await expect(h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'disabled' },
      capabilitySelections: [],
    }, editorContext())).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })

    h.targets.allowed.add('industry_workspace:22222222-2222-4222-8222-222222222222')
    const set = await h.assignmentService.put({
      scope: WORKSPACE,
      defaultSelection: { kind: 'disabled' },
      capabilitySelections: [],
    }, editorContext())
    expect(set.scope).toEqual(WORKSPACE)
  })

  it('refuses a workspace target that is not proven to belong to the scope', async () => {
    const h = harness()
    await expect(h.assignmentService.put({
      scope: WORKSPACE,
      defaultSelection: { kind: 'disabled' },
      capabilitySelections: [],
    }, adminContext())).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })
})

describe('ModelSelectionService resolution', () => {
  async function setup() {
    const h = harness()
    const admin = adminContext()
    const gen = await h.connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'resolve-gen-0001',
      credential: new SecretValue('sk-resolve'),
    }, admin)
    return { h, admin, gen }
  }

  it('resolves the space default and reports the assignment revision', async () => {
    const { h, admin, gen } = await setup()
    const set = await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: gen.connectionId },
      capabilitySelections: [],
    }, admin)
    const selection = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, capability: 'generation' }, admin)
    expect(selection.state).toBe('available')
    expect(selection.resolvedFrom).toBe('space_default')
    expect(selection.connectionId).toBe(gen.connectionId)
    expect(selection.assignmentRevision).toBe(set.revision)
  })

  it('lets an object capability override beat the space default and inherit fall through', async () => {
    const { h, admin, gen } = await setup()
    const other = await h.connectionService.create({
      descriptor: descriptor({ name: '工作区模型' }),
      idempotencyKey: 'resolve-gen-0002',
      credential: new SecretValue('sk-resolve-2'),
    }, admin)
    h.targets.allowed.add('industry_workspace:22222222-2222-4222-8222-222222222222')
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: gen.connectionId },
      capabilitySelections: [],
    }, admin)
    await h.assignmentService.put({
      scope: WORKSPACE,
      defaultSelection: { kind: 'inherit' },
      capabilitySelections: [{ capability: 'generation', selection: { kind: 'connection', connectionId: other.connectionId } }],
    }, admin)

    const overridden = await h.selectionService.resolve(TEST_SCOPE, { scope: WORKSPACE, capability: 'generation' }, admin)
    expect(overridden.resolvedFrom).toBe('object_capability')
    expect(overridden.connectionId).toBe(other.connectionId)

    const inherited = await h.selectionService.resolve(TEST_SCOPE, { scope: WORKSPACE, capability: 'research' }, admin)
    expect(inherited.resolvedFrom).toBe('space_default')
    expect(inherited.connectionId).toBe(gen.connectionId)
  })

  it('terminates on disabled and reports a blocked reason without falling to another vendor', async () => {
    const { h, admin, gen } = await setup()
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: gen.connectionId },
      capabilitySelections: [],
    }, admin)
    h.targets.allowed.add('industry_workspace:22222222-2222-4222-8222-222222222222')
    await h.assignmentService.put({
      scope: WORKSPACE,
      defaultSelection: { kind: 'inherit' },
      capabilitySelections: [{ capability: 'generation', selection: { kind: 'disabled' } }],
    }, admin)
    const disabled = await h.selectionService.resolve(TEST_SCOPE, { scope: WORKSPACE, capability: 'generation' }, admin)
    expect(disabled.state).toBe('disabled')
    expect(disabled.blockedReason).toBe('MODEL_DISABLED')
    expect(disabled.connectionId).toBeUndefined()

    // Clearing the credential blocks a named connection rather than retargeting the space default.
    await h.connectionService.setCredential({ connectionId: gen.connectionId, action: 'clear' }, admin)
    const blocked = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, capability: 'generation' }, admin)
    expect(blocked.state).toBe('blocked')
    expect(blocked.blockedReason).toBe('CREDENTIAL_MISSING')
    expect(blocked.connectionId).toBe(gen.connectionId)
  })

  it('reports unconfigured when no layer names a connection', async () => {
    const h = harness()
    const selection = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, capability: 'generation' }, adminContext())
    expect(selection.state).toBe('unconfigured')
    expect(selection.resolvedFrom).toBe('unconfigured')
    expect(selection.blockedReason).toBe('MODEL_NOT_CONFIGURED')
  })
})

describe('ExecutionModelBindingService', () => {
  it('pins the resolved version and reads it back unchanged', async () => {
    const h = harness()
    const admin = adminContext()
    const gen = await h.connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'bind-gen-0001',
      credential: new SecretValue('sk-bind'),
    }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: gen.connectionId },
      capabilitySelections: [],
    }, admin)

    const binding = await h.bindingService.bind({
      executionId: '33333333-3333-4333-8333-333333333333',
      scope: { kind: 'space' },
      capability: 'generation',
    }, admin)
    expect(binding.connectionId).toBe(gen.connectionId)
    expect(binding.connectionRevision).toBe(gen.revision)
    expect(JSON.stringify(binding)).not.toContain('sk-bind')

    const readBack = await h.bindingService.readBack('33333333-3333-4333-8333-333333333333', 'generation', admin)
    expect(readBack).toEqual(binding)
  })

  it('refuses to bind when the capability is unconfigured', async () => {
    const h = harness()
    await expect(h.bindingService.bind({
      executionId: '44444444-4444-4444-8444-444444444444',
      scope: { kind: 'space' },
      capability: 'generation',
    }, adminContext())).rejects.toBeInstanceOf(ModelSelectionError)
  })
})

describe('model catalogue isolation (N13 high-risk)', () => {
  const WORKSPACE_B: ModelTargetScope = { kind: 'industry_workspace', workspaceId: '33333333-3333-4333-8333-333333333333' }

  it('does not use an override of one industry workspace when resolving for another', async () => {
    const h = harness()
    const admin = adminContext()
    h.targets.allowed.add('industry_workspace:22222222-2222-4222-8222-222222222222')
    h.targets.allowed.add('industry_workspace:33333333-3333-4333-8333-333333333333')
    const space = await h.connectionService.create({ descriptor: descriptor({ name: '空间默认' }), idempotencyKey: 'iso-a-space', credential: new SecretValue('sk-space') }, admin)
    const workspaceA = await h.connectionService.create({ descriptor: descriptor({ name: '工作区 A 专用' }), idempotencyKey: 'iso-a-workspace', credential: new SecretValue('sk-workspace-a') }, admin)
    await h.assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'connection', connectionId: space.connectionId }, capabilitySelections: [] }, admin)
    await h.assignmentService.put({ scope: WORKSPACE, defaultSelection: { kind: 'connection', connectionId: workspaceA.connectionId }, capabilitySelections: [] }, admin)

    const forA = await h.selectionService.resolve(TEST_SCOPE, { scope: WORKSPACE, capability: 'generation' }, admin)
    expect(forA.resolvedFrom).toBe('object_default')
    expect(forA.connectionId).toBe(workspaceA.connectionId)

    // Workspace B inherits the space default; it never sees workspace A's override.
    const forB = await h.selectionService.resolve(TEST_SCOPE, { scope: WORKSPACE_B, capability: 'generation' }, admin)
    expect(forB.resolvedFrom).toBe('space_default')
    expect(forB.connectionId).toBe(space.connectionId)
    expect(forB.connectionId).not.toBe(workspaceA.connectionId)
  })

  it('keeps two same-named connections distinct by id, not by name', async () => {
    const h = harness()
    const admin = adminContext()
    const first = await h.connectionService.create({ descriptor: descriptor({ name: '相同名称', providerModelName: 'vendor-first' }), idempotencyKey: 'same-name-first', credential: new SecretValue('sk-first') }, admin)
    const second = await h.connectionService.create({ descriptor: descriptor({ name: '相同名称', providerModelName: 'vendor-second' }), idempotencyKey: 'same-name-second', credential: new SecretValue('sk-second') }, admin)
    expect(first.connectionId).not.toBe(second.connectionId)

    await h.assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'connection', connectionId: second.connectionId }, capabilitySelections: [] }, admin)
    const bound = await h.bindingService.ensureBinding({ executionId: '55555555-5555-4555-8555-555555555555', scope: { kind: 'space' }, capability: 'generation' }, admin)
    expect(bound.connectionId).toBe(second.connectionId)
    expect(bound.connectionRevision).toBe(second.revision)

    // Clearing the same-named twin's credential does not disturb the bound execution.
    await h.connectionService.setCredential({ connectionId: first.connectionId, action: 'clear' }, admin)
    expect(await h.bindingService.isUsable('55555555-5555-4555-8555-555555555555', 'generation', admin)).toBe(true)
    // Deleting the unused twin leaves the assigned connection resolvable.
    await h.connectionService.remove(first.connectionId, admin)
    const stillResolved = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, capability: 'generation' }, admin)
    expect(stillResolved.connectionId).toBe(second.connectionId)
  })
})

