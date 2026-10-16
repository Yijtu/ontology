import { describe, expect, it } from 'vitest'
import {
  assertResolvedWorkspaceResearchProfileShape,
  assertWorkspaceResearchProfileSpecShape,
  workspaceResearchProfileRef,
  workspaceIdOfResearchProfileRef,
  draftRevisionOfResearchProfileVersion,
  isWorkspaceResearchProfileRef,
} from '@ontology/contracts'
import type { ResolvedWorkspaceResearchProfile, WorkspaceResearchProfileSpec } from '@ontology/contracts'

const WORKSPACE = '11111111-1111-4111-8111-111111111111'

function spec(): WorkspaceResearchProfileSpec {
  return {
    schemaVersion: 'workspace-research-profile-spec@1',
    workspaceId: WORKSPACE,
    draftRevision: '3',
    draftRef: { id: WORKSPACE, version: '3', digest: `sha256:${'d'.repeat(64)}`, kind: 'draft' },
    runtimeRef: { id: 'runtime-pi', version: 'pi-runtime@1.0.0', digest: `sha256:${'a'.repeat(64)}` },
    modelBindings: {},
    toolBindings: [
      { toolId: 'web_search', enabled: true },
      { toolId: 'document_search', enabled: true },
      { toolId: 'ontology_lookup', enabled: true, maxCallsPerRun: 4 },
      { toolId: 'data_query', enabled: false },
    ],
    computeBindings: [],
    policyRef: { id: 'core-local-policy', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` },
  }
}

describe('workspace-research run config contracts', () => {
  it('accepts a spec that pins the exact workspace and draft revision', () => {
    expect(() => assertWorkspaceResearchProfileSpecShape(spec())).not.toThrow()
  })

  it('accepts a resolved config with versions, degradations and a snapshot hash', () => {
    const resolved: ResolvedWorkspaceResearchProfile = {
      ...spec(),
      resolvedVersions: [spec().runtimeRef],
      explicitDegradations: [],
      snapshotHash: `sha256:${'e'.repeat(64)}`,
      resolvedAt: '2026-10-16T00:00:00.000Z',
    }
    expect(() => assertResolvedWorkspaceResearchProfileShape(resolved)).not.toThrow()
  })

  it('rejects a config whose draft ref names a different workspace or revision', () => {
    const mismatchedWorkspace = { ...spec(), draftRef: { id: '22222222-2222-4222-8222-222222222222', version: '3', digest: `sha256:${'d'.repeat(64)}`, kind: 'draft' } }
    expect(() => assertWorkspaceResearchProfileSpecShape(mismatchedWorkspace)).toThrow(/workspace and draft revision/)
    const mismatchedRevision = { ...spec(), draftRef: { id: WORKSPACE, version: '2', digest: `sha256:${'d'.repeat(64)}`, kind: 'draft' } }
    expect(() => assertWorkspaceResearchProfileSpecShape(mismatchedRevision)).toThrow(/workspace and draft revision/)
  })

  it('rejects a malformed spec (wrong version, missing draft ref)', () => {
    expect(() => assertWorkspaceResearchProfileSpecShape({ ...spec(), schemaVersion: 'other' })).toThrow()
    const noDraft = { ...spec() } as Record<string, unknown>
    delete noDraft['draftRef']
    expect(() => assertWorkspaceResearchProfileSpecShape(noDraft)).toThrow()
  })

  it('round-trips the reserved workspace-research profile ref helpers', () => {
    const ref = workspaceResearchProfileRef(WORKSPACE, '3')
    expect(isWorkspaceResearchProfileRef(ref)).toBe(true)
    expect(workspaceIdOfResearchProfileRef(ref)).toBe(WORKSPACE)
    expect(draftRevisionOfResearchProfileVersion(ref.version)).toBe('3')
    expect(isWorkspaceResearchProfileRef({ id: 'home-energy-demo', version: '1.0.0' })).toBe(false)
  })
})
