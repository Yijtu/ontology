import { describe, expect, it } from 'vitest'
import {
  ExecutionToolBindingService,
  ToolAssignmentService,
  ToolConnectionService,
  ToolSelectionService,
} from '@ontology/application'
import { createCoreResearchPreflight, createCoreSearchBinding, intersectAllowedDomains } from '@ontology/app-api'
import type { ImmutableArtifactWriter, ToolConnectionDescriptor, ToolTargetScope } from '@ontology/contracts'
import {
  TEST_SCOPE,
  adminContext,
  InMemoryExecutionToolBindingStore,
  InMemoryToolAssignmentStore,
  InMemoryToolConnectionStore,
  InMemoryToolCredentialCustodian,
  RecordingTargetDirectory,
} from './tool-settings-fixtures'

const SPACE: ToolTargetScope = { kind: 'space' }
const WORKSPACE = '22222222-2222-4222-8222-222222222222'
const RUN = '33333333-3333-4333-8333-333333333333'

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
    endpoint: 'https://search.example.com/v1/search',
    ...overrides,
  }
}

function harness() {
  const connections = new InMemoryToolConnectionStore()
  const assignments = new InMemoryToolAssignmentStore()
  const custodian = new InMemoryToolCredentialCustodian()
  const bindings = new InMemoryExecutionToolBindingStore()
  const targets = new RecordingTargetDirectory()
  const selection = new ToolSelectionService({ assignments, connections, targets })
  const bindingService = new ExecutionToolBindingService({ bindings, resolver: selection, connections })
  const connectionService = new ToolConnectionService({ connections, credentials: custodian, assignments })
  const assignmentService = new ToolAssignmentService({ assignments, connections, targets })
  return { connections, assignments, custodian, bindings, selection, bindingService, connectionService, assignmentService, targets }
}

describe('intersectAllowedDomains (deployment policy ∩ user selection)', () => {
  it('keeps only user domains inside the authorized policy and never widens it', () => {
    expect(intersectAllowedDomains(['example.com'], ['example.com', 'evil.test'])).toEqual(['example.com'])
    expect(intersectAllowedDomains(['example.com'], ['docs.example.com'])).toEqual(['docs.example.com'])
    expect(intersectAllowedDomains(['example.com'], ['example.com.evil.test'])).toEqual([])
  })

  it('uses the user selection when there is no deployment restriction', () => {
    expect(intersectAllowedDomains(undefined, ['a.example', 'b.example'])).toEqual(['a.example', 'b.example'])
    expect(intersectAllowedDomains([], ['a.example'])).toEqual(['a.example'])
  })
})

describe('createCoreSearchBinding wires the actual bound search into a run', () => {
  it('resolves and pins the space-selected connection and builds a real provider', async () => {
    const h = harness()
    const admin = adminContext()
    const created = await h.connectionService.create({ descriptor: compat(), idempotencyKey: 'search-bind-0001' }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: created.connectionId }, toolSelections: [] }, admin)

    const binding = createCoreSearchBinding({
      bindings: h.bindingService,
      connections: h.connections,
      credentials: h.custodian,
      scopeRef: TEST_SCOPE,
      artifacts,
      targetScope: SPACE,
    })
    const resolved = await binding.resolveForRun(RUN, admin)
    expect(resolved.state).toBe('available')
    if (resolved.state !== 'available') return
    expect(resolved.connection.connectionId).toBe(created.connectionId)
    expect(resolved.binding.connectionId).toBe(created.connectionId)
    expect(resolved.provider.providerRef.id).toBe('web-search.http')

    // A retry reads the pinned binding back unchanged instead of re-resolving.
    expect(await h.bindings.getBinding(TEST_SCOPE, RUN, 'web_search')).toEqual(resolved.binding)
  })

  it('blocks (never falls through) when the pinned connection is later disabled', async () => {
    const h = harness()
    const admin = adminContext()
    const created = await h.connectionService.create({ descriptor: compat(), idempotencyKey: 'search-bind-0002' }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: created.connectionId }, toolSelections: [] }, admin)
    const binding = createCoreSearchBinding({ bindings: h.bindingService, connections: h.connections, credentials: h.custodian, scopeRef: TEST_SCOPE, artifacts, targetScope: SPACE })
    expect((await binding.resolveForRun(RUN, admin)).state).toBe('available')

    await h.connectionService.update({
      connectionId: created.connectionId,
      descriptor: compat({ enabled: false }),
      expectedRevision: created.revision,
      idempotencyKey: 'search-bind-disable',
    }, admin)

    const blocked = await binding.resolveForRun(RUN, admin)
    expect(blocked.state).toBe('blocked')
    if (blocked.state !== 'blocked') return
    expect(blocked.reason).toBe('TOOL_BINDING_REVOKED')
  })

  it('reports CREDENTIAL_MISSING for a native connection without a credential', async () => {
    const h = harness()
    const admin = adminContext()
    const created = await h.connectionService.create({
      descriptor: compat({ adapterType: 'native_tavily', endpoint: 'https://api.tavily.com/search' }),
      idempotencyKey: 'search-bind-0003',
    }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: created.connectionId }, toolSelections: [] }, admin)
    const binding = createCoreSearchBinding({ bindings: h.bindingService, connections: h.connections, credentials: h.custodian, scopeRef: TEST_SCOPE, artifacts, targetScope: SPACE })
    const blocked = await binding.resolveForRun(RUN, admin)
    expect(blocked.state).toBe('blocked')
    if (blocked.state !== 'blocked') return
    expect(blocked.reason).toBe('CREDENTIAL_MISSING')
  })

  it('reports TOOL_NOT_CONFIGURED when no search connection is assigned', async () => {
    const h = harness()
    const admin = adminContext()
    const binding = createCoreSearchBinding({ bindings: h.bindingService, connections: h.connections, credentials: h.custodian, scopeRef: TEST_SCOPE, artifacts, targetScope: SPACE })
    const blocked = await binding.resolveForRun(RUN, admin)
    expect(blocked.state).toBe('blocked')
    if (blocked.state !== 'blocked') return
    expect(blocked.reason).toBe('TOOL_NOT_CONFIGURED')
  })
})

describe('createCoreResearchPreflight names the real recipient and effective scope', () => {
  it('reports the available recipient and the intersected domains', async () => {
    const h = harness()
    const admin = adminContext()
    h.targets.allowed.add(`industry_workspace:${WORKSPACE}`)
    const created = await h.connectionService.create({ descriptor: compat(), idempotencyKey: 'search-preflight-01' }, admin)
    await h.assignmentService.put({ scope: SPACE, defaultSelection: { kind: 'connection', connectionId: created.connectionId }, toolSelections: [] }, admin)
    const preflight = createCoreResearchPreflight({
      selection: h.selection,
      scopeRef: TEST_SCOPE,
      systemContext: () => admin,
      deploymentDomains: () => ['example.com'],
      now: () => '2026-10-16T00:00:00Z',
    })
    const result = await preflight.preflight({
      workspaceId: WORKSPACE,
      requestedDomains: ['example.com', 'not-allowed.test'],
      limits: { sourceLimit: 5, candidateLimit: 5, deadline: '2026-10-16T01:00:00Z' },
      policyRef: { id: 'p', version: '1.0.0', digest: 'sha256:' + '0'.repeat(64) },
      budgetRef: { id: 'b', version: '1.0.0', digest: 'sha256:' + '0'.repeat(64) },
      requesterRoles: ['researcher'],
    })
    expect(result.recipient.state).toBe('available')
    expect(result.recipient.connectionId).toBe(created.connectionId)
    expect(result.recipient.connectionName).toBe('兼容网关')
    expect(result.effectiveDomains).toEqual(['example.com'])
    expect(result.blocked).toHaveLength(0)
    expect(result.authorization.roles).toEqual(['researcher'])
  })

  it('returns a stable unconfigured block instead of a fabricated ready state', async () => {
    const h = harness()
    const admin = adminContext()
    h.targets.allowed.add(`industry_workspace:${WORKSPACE}`)
    const preflight = createCoreResearchPreflight({ selection: h.selection, scopeRef: TEST_SCOPE, systemContext: () => admin, now: () => '2026-10-16T00:00:00Z' })
    const result = await preflight.preflight({
      workspaceId: WORKSPACE,
      requestedDomains: ['example.com'],
      limits: { sourceLimit: 5, candidateLimit: 5, deadline: '2026-10-16T01:00:00Z' },
      policyRef: { id: 'p', version: '1.0.0', digest: 'sha256:' + '0'.repeat(64) },
      budgetRef: { id: 'b', version: '1.0.0', digest: 'sha256:' + '0'.repeat(64) },
      requesterRoles: ['researcher'],
    })
    expect(result.recipient.state).toBe('unconfigured')
    expect(result.blocked.map((entry) => entry.code)).toContain('TOOL_NOT_CONFIGURED')
  })
})
