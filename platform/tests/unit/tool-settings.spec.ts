import { describe, expect, it } from 'vitest'
import {
  ExecutionToolBindingService,
  ToolAssignmentService,
  ToolConnectionService,
  ToolSelectionService,
} from '@ontology/application'
import { SecretValue, ToolConnectionError } from '@ontology/contracts'
import type { ToolConnectionDescriptor, ToolTargetScope } from '@ontology/contracts'
import {
  TEST_SCOPE,
  adminContext,
  context,
  editorContext,
  InMemoryExecutionToolBindingStore,
  InMemoryToolAssignmentStore,
  InMemoryToolConnectionStore,
  InMemoryToolCredentialCustodian,
  RecordingTargetDirectory,
  RecordingToolProbe,
} from './tool-settings-fixtures'

function descriptor(overrides: Partial<ToolConnectionDescriptor> = {}): ToolConnectionDescriptor {
  return {
    name: '兼容网关',
    adapterType: 'http_compat',
    capabilities: ['web_search'],
    enabled: true,
    endpoint: 'https://search.example.com/v1/search',
    ...overrides,
  }
}

function tavilyDescriptor(overrides: Partial<ToolConnectionDescriptor> = {}): ToolConnectionDescriptor {
  return {
    name: 'Tavily 搜索',
    adapterType: 'native_tavily',
    capabilities: ['web_search'],
    enabled: true,
    endpoint: 'https://api.tavily.com/search',
    ...overrides,
  }
}

function harness() {
  const connections = new InMemoryToolConnectionStore()
  const assignments = new InMemoryToolAssignmentStore()
  const custodian = new InMemoryToolCredentialCustodian()
  const bindings = new InMemoryExecutionToolBindingStore()
  const targets = new RecordingTargetDirectory()
  const probe = new RecordingToolProbe(custodian)
  const connectionService = new ToolConnectionService({ connections, credentials: custodian, assignments, probe })
  const assignmentService = new ToolAssignmentService({ assignments, connections, targets })
  const selectionService = new ToolSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionToolBindingService({ bindings, resolver: selectionService, connections })
  return { connections, assignments, custodian, bindings, targets, probe, connectionService, assignmentService, selectionService, bindingService }
}

const WORKSPACE: ToolTargetScope = { kind: 'industry_workspace', workspaceId: '22222222-2222-4222-8222-222222222222' }

describe('ToolConnectionService credentials', () => {
  it('never echoes an API key and reports the search and archive items separately', async () => {
    const h = harness()
    const admin = adminContext()
    const created = await h.connectionService.create({
      descriptor: tavilyDescriptor(),
      idempotencyKey: 'tool-create-0001',
      credential: new SecretValue('tvly-super-secret'),
    }, admin)

    expect(JSON.stringify(created)).not.toContain('tvly-super-secret')
    expect(created.credentialState).toBe('present')
    expect(await h.connections.getCredentialRef(TEST_SCOPE, created.connectionId)).toBeDefined()

    h.probe.search = { status: 'passed', latencyMs: 5 }
    h.probe.archive = { status: 'failed', reason: 'page_not_readable' }
    const result = await h.connectionService.testStored(created.connectionId, admin)
    expect(result.credentialConfigured).toBe(true)
    expect(result.search.status).toBe('passed')
    expect(result.archive.status).toBe('failed')
    expect(JSON.stringify(result)).not.toContain('tvly-super-secret')

    const view = await h.connectionService.get(created.connectionId, admin)
    expect(view?.probeSummary?.search.status).toBe('passed')
    expect(view?.probeSummary?.connectionRevision).toBe(view?.revision)
  })

  it('copies only non-sensitive fields: new id, disabled, no credential', async () => {
    const h = harness()
    const admin = adminContext()
    const source = await h.connectionService.create({
      descriptor: tavilyDescriptor(),
      idempotencyKey: 'tool-copy-source',
      credential: new SecretValue('tvly-source'),
    }, admin)
    const copy = await h.connectionService.copy({
      sourceConnectionId: source.connectionId,
      name: '副本',
      idempotencyKey: 'tool-copy-key',
    }, admin)

    expect(copy.connectionId).not.toBe(source.connectionId)
    expect(copy.enabled).toBe(false)
    expect(copy.credentialState).toBe('missing')
    expect(await h.connections.getCredentialRef(TEST_SCOPE, copy.connectionId)).toBeUndefined()
  })

  it('enforces CAS on edit and requires a re-entered key when the address changes', async () => {
    const h = harness()
    const admin = adminContext()
    const created = await h.connectionService.create({
      descriptor: tavilyDescriptor(),
      idempotencyKey: 'tool-cas-create',
      credential: new SecretValue('tvly-address'),
    }, admin)

    await expect(h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: tavilyDescriptor(),
      expectedRevision: '999',
      idempotencyKey: 'tool-cas-update-1',
    }, admin)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    await expect(h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: tavilyDescriptor({ endpoint: 'https://other.example.com/search' }),
      expectedRevision: created.revision,
      idempotencyKey: 'tool-cas-update-2',
    }, admin)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })

    const updated = await h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: tavilyDescriptor({ endpoint: 'https://other.example.com/search' }),
      expectedRevision: created.revision,
      idempotencyKey: 'tool-cas-update-3',
      credential: new SecretValue('tvly-address-2'),
    }, admin)
    expect(updated.credentialState).toBe('present')
    expect(BigInt(updated.revision)).toBeGreaterThan(BigInt(created.revision))
  })

  it('refuses a capability the adapter cannot serve, so a search service never becomes a data tool', async () => {
    const h = harness()
    await expect(h.connectionService.create({
      descriptor: tavilyDescriptor({ capabilities: ['data_query'] }),
      idempotencyKey: 'tool-adapter-mismatch',
    }, adminContext())).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_MISMATCH' })
  })

  it('refuses to delete a connection still named by a per-tool assignment', async () => {
    const h = harness()
    const admin = adminContext()
    const connection = await h.connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'tool-in-use-create',
    }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: connection.connectionId } }],
    }, admin)

    await expect(h.connectionService.remove(connection.connectionId, admin))
      .rejects.toMatchObject({ code: 'TOOL_IN_USE' })

    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'disabled' } }],
      expectedRevision: '1',
    }, admin)
    await h.connectionService.remove(connection.connectionId, admin)
    expect(await h.connectionService.get(connection.connectionId, admin)).toBeUndefined()
  })

  it('discards a draft credential after testing it', async () => {
    const h = harness()
    await h.connectionService.testDraft({
      descriptor: tavilyDescriptor(),
      credential: new SecretValue('tvly-draft'),
    }, adminContext())
    expect(h.custodian.values.size).toBe(0)
    expect(h.custodian.active.size).toBe(0)
  })

  it('drops a stale probe summary that does not match the current revision', async () => {
    const h = harness()
    const admin = adminContext()
    const created = await h.connectionService.create({
      descriptor: tavilyDescriptor(),
      idempotencyKey: 'tool-stale-probe',
      credential: new SecretValue('tvly-stale'),
    }, admin)
    await h.connectionService.testStored(created.connectionId, admin)

    const key = `${TEST_SCOPE.tenantId}:${TEST_SCOPE.spaceId}:${created.connectionId}`
    const row = h.connections.rows.get(key)
    expect(row).toBeDefined()
    if (row !== undefined) {
      h.connections.rows.set(key, { ...row, view: { ...row.view, revision: '99' } })
    }
    const view = await h.connectionService.get(created.connectionId, admin)
    expect(view?.revision).toBe('99')
    expect(view?.probeSummary).toBeUndefined()
  })
})

describe('ToolAssignmentService validation', () => {
  it('rejects a tool selection whose connection cannot serve that tool', async () => {
    const h = harness()
    const admin = adminContext()
    const connection = await h.connectionService.create({ descriptor: descriptor(), idempotencyKey: 'tool-assign-1' }, admin)

    await expect(h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'data_query', selection: { kind: 'connection', connectionId: connection.connectionId } }],
    }, admin)).rejects.toMatchObject({ code: 'TOOL_CAPABILITY_MISMATCH' })

    const ok = await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: connection.connectionId } }],
    }, admin)
    expect(ok.revision).toBe('1')
    expect(ok.defaultSelection.kind).toBe('inherit')
  })

  it('requires the platform-admin role for the space default but allows an editor to override an object', async () => {
    const h = harness()
    await expect(h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [],
    }, editorContext())).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })

    h.targets.allowed.add('industry_workspace:22222222-2222-4222-8222-222222222222')
    const set = await h.assignmentService.put({
      scope: WORKSPACE,
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'disabled' } }],
    }, editorContext())
    expect(set.scope).toEqual(WORKSPACE)
  })

  it('refuses a workspace target that is not proven to belong to the scope', async () => {
    const h = harness()
    await expect(h.assignmentService.put({
      scope: WORKSPACE,
      defaultSelection: { kind: 'inherit' },
      toolSelections: [],
    }, adminContext())).rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })

  it('rejects a non-editor without the platform-admin role', async () => {
    const h = harness()
    await expect(h.assignmentService.get({ kind: 'space' }, context(TEST_SCOPE, ['researcher'], 'researcher')))
      .rejects.toMatchObject({ code: 'SCOPE_MISMATCH' })
  })
})

describe('ToolSelectionService resolution', () => {
  async function setup() {
    const h = harness()
    const admin = adminContext()
    const connection = await h.connectionService.create({
      descriptor: descriptor(),
      idempotencyKey: 'tool-resolve-1',
    }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: connection.connectionId } }],
    }, admin)
    return { h, admin, connection }
  }

  it('resolves the space tool selection and reports the assignment revision', async () => {
    const { h, admin, connection } = await setup()
    const selection = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(selection.state).toBe('available')
    expect(selection.resolvedFrom).toBe('space_tool')
    expect(selection.connectionId).toBe(connection.connectionId)
    expect(selection.assignmentRevision).toBe('1')
  })

  it('lets an object tool override beat the space tool selection', async () => {
    const { h, admin, connection } = await setup()
    const other = await h.connectionService.create({ descriptor: descriptor({ name: '工作区搜索' }), idempotencyKey: 'tool-resolve-2' }, admin)
    h.targets.allowed.add('industry_workspace:22222222-2222-4222-8222-222222222222')
    await h.assignmentService.put({
      scope: WORKSPACE,
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: other.connectionId } }],
    }, admin)

    const overridden = await h.selectionService.resolve(TEST_SCOPE, { scope: WORKSPACE, toolId: 'web_search' }, admin)
    expect(overridden.resolvedFrom).toBe('object_tool')
    expect(overridden.connectionId).toBe(other.connectionId)

    const spaceOnly = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(spaceOnly.connectionId).toBe(connection.connectionId)
  })

  it('terminates on disabled and blocks a named-but-broken connection without switching vendor', async () => {
    const h = harness()
    const admin = adminContext()
    const tavily = await h.connectionService.create({
      descriptor: tavilyDescriptor(),
      idempotencyKey: 'tool-resolve-broken',
      credential: new SecretValue('tvly-resolve'),
    }, admin)
    const fallback = await h.connectionService.create({ descriptor: descriptor(), idempotencyKey: 'tool-resolve-fallback' }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: fallback.connectionId },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: tavily.connectionId } }],
    }, admin)

    // Clearing the pinned credential blocks the tool; it never falls through to the space default.
    await h.connectionService.setCredential({ connectionId: tavily.connectionId, action: 'clear' }, admin)
    const blocked = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(blocked.state).toBe('blocked')
    expect(blocked.blockedReason).toBe('CREDENTIAL_MISSING')
    expect(blocked.connectionId).toBe(tavily.connectionId)
    expect(blocked.connectionId).not.toBe(fallback.connectionId)

    // Disabling the pinned connection disables the tool.
    await h.connectionService.setCredential({ connectionId: tavily.connectionId, action: 'set', secret: new SecretValue('tvly-again') }, admin)
    await h.connectionService.update({
      connectionId: tavily.connectionId,
      descriptor: tavilyDescriptor({ enabled: false }),
      expectedRevision: (await h.connectionService.get(tavily.connectionId, admin))?.revision ?? '0',
      idempotencyKey: 'tool-resolve-disable',
    }, admin)
    const disabled = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(disabled.state).toBe('blocked')
    expect(disabled.blockedReason).toBe('TOOL_DISABLED')
  })

  it('reports unconfigured when no layer names a connection', async () => {
    const h = harness()
    const selection = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, adminContext())
    expect(selection.state).toBe('unconfigured')
    expect(selection.resolvedFrom).toBe('unconfigured')
    expect(selection.blockedReason).toBe('TOOL_NOT_CONFIGURED')
  })

  it('treats a keyless compat gateway as usable but blocks a keyless native service', async () => {
    const h = harness()
    const admin = adminContext()
    const compat = await h.connectionService.create({ descriptor: descriptor(), idempotencyKey: 'tool-keyless-compat' }, admin)
    const tavily = await h.connectionService.create({ descriptor: tavilyDescriptor(), idempotencyKey: 'tool-keyless-tavily' }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: compat.connectionId },
      toolSelections: [],
    }, admin)
    const compatSelection = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(compatSelection.state).toBe('available')
    expect(compatSelection.resolvedFrom).toBe('space_default')

    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'connection', connectionId: tavily.connectionId },
      toolSelections: [],
      expectedRevision: '1',
    }, admin)
    const tavilySelection = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(tavilySelection.state).toBe('blocked')
    expect(tavilySelection.blockedReason).toBe('CREDENTIAL_MISSING')
  })
})

describe('ExecutionToolBindingService', () => {
  it('pins the resolved version and reads it back unchanged', async () => {
    const h = harness()
    const admin = adminContext()
    const connection = await h.connectionService.create({ descriptor: descriptor(), idempotencyKey: 'tool-bind-1' }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: connection.connectionId } }],
    }, admin)

    const binding = await h.bindingService.bind({
      executionId: '33333333-3333-4333-8333-333333333333',
      scope: { kind: 'space' },
      toolId: 'web_search',
    }, admin)
    expect(binding.connectionId).toBe(connection.connectionId)
    expect(binding.connectionRevision).toBe(connection.revision)
    expect(JSON.stringify(binding)).not.toContain('secret')

    const readBack = await h.bindingService.readBack('33333333-3333-4333-8333-333333333333', 'web_search', admin)
    expect(readBack).toEqual(binding)
  })

  it('revokes a pinned tool when its connection is later disabled', async () => {
    const h = harness()
    const admin = adminContext()
    const connection = await h.connectionService.create({
      descriptor: tavilyDescriptor(),
      idempotencyKey: 'tool-bind-revoke',
      credential: new SecretValue('tvly-bind'),
    }, admin)
    await h.assignmentService.put({
      scope: { kind: 'space' },
      defaultSelection: { kind: 'inherit' },
      toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: connection.connectionId } }],
    }, admin)
    const executionId = '44444444-4444-4444-8444-444444444444'
    await h.bindingService.bind({ executionId, scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(await h.bindingService.isUsable(executionId, 'web_search', admin)).toBe(true)

    await h.connectionService.setCredential({ connectionId: connection.connectionId, action: 'clear' }, admin)
    expect(await h.bindingService.isUsable(executionId, 'web_search', admin)).toBe(false)
    await expect(h.bindingService.assertUsable(executionId, 'web_search', admin))
      .rejects.toMatchObject({ code: 'TOOL_BINDING_REVOKED' })
    // The stored binding is untouched by the revocation.
    expect(await h.bindingService.readBack(executionId, 'web_search', admin)).toBeDefined()
  })

  it('refuses to bind when the tool is unconfigured', async () => {
    const h = harness()
    await expect(h.bindingService.bind({
      executionId: '55555555-5555-4555-8555-555555555555',
      scope: { kind: 'space' },
      toolId: 'web_search',
    }, adminContext())).rejects.toBeInstanceOf(ToolConnectionError)
  })
})

describe('tool catalogue isolation (high-risk)', () => {
  const WORKSPACE_B: ToolTargetScope = { kind: 'industry_workspace', workspaceId: '33333333-3333-4333-8333-333333333333' }

  it('does not use an override of one industry workspace when resolving for another', async () => {
    const h = harness()
    const admin = adminContext()
    h.targets.allowed.add('industry_workspace:22222222-2222-4222-8222-222222222222')
    h.targets.allowed.add('industry_workspace:33333333-3333-4333-8333-333333333333')
    const space = await h.connectionService.create({ descriptor: descriptor({ name: '空间搜索' }), idempotencyKey: 'tool-iso-space' }, admin)
    const workspaceA = await h.connectionService.create({ descriptor: descriptor({ name: '工作区 A 搜索' }), idempotencyKey: 'tool-iso-a' }, admin)
    await h.assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'inherit' }, toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: space.connectionId } }] }, admin)
    await h.assignmentService.put({ scope: WORKSPACE, defaultSelection: { kind: 'inherit' }, toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: workspaceA.connectionId } }] }, admin)

    const forA = await h.selectionService.resolve(TEST_SCOPE, { scope: WORKSPACE, toolId: 'web_search' }, admin)
    expect(forA.resolvedFrom).toBe('object_tool')
    expect(forA.connectionId).toBe(workspaceA.connectionId)

    const forB = await h.selectionService.resolve(TEST_SCOPE, { scope: WORKSPACE_B, toolId: 'web_search' }, admin)
    expect(forB.resolvedFrom).toBe('space_tool')
    expect(forB.connectionId).toBe(space.connectionId)
    expect(forB.connectionId).not.toBe(workspaceA.connectionId)
  })

  it('keeps two same-named connections distinct by id, not by name', async () => {
    const h = harness()
    const admin = adminContext()
    const first = await h.connectionService.create({ descriptor: descriptor({ name: '相同名称' }), idempotencyKey: 'tool-same-first' }, admin)
    const second = await h.connectionService.create({ descriptor: descriptor({ name: '相同名称' }), idempotencyKey: 'tool-same-second' }, admin)
    expect(first.connectionId).not.toBe(second.connectionId)

    await h.assignmentService.put({ scope: { kind: 'space' }, defaultSelection: { kind: 'inherit' }, toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId: second.connectionId } }] }, admin)
    const bound = await h.bindingService.ensureBinding({ executionId: '66666666-6666-4666-8666-666666666666', scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(bound.connectionId).toBe(second.connectionId)

    await h.connectionService.remove(first.connectionId, admin)
    const stillResolved = await h.selectionService.resolve(TEST_SCOPE, { scope: { kind: 'space' }, toolId: 'web_search' }, admin)
    expect(stillResolved.connectionId).toBe(second.connectionId)
  })
})
