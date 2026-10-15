import { ModelSelectionError, isUuid } from '@ontology/contracts'
import type {
  IndustryWorkspaceStore,
  ModelTargetDirectory,
  ModelTargetScope,
  ProjectStore,
  ScopeRef,
  ToolContext,
} from '@ontology/contracts'

/**
 * Ownership check for an assignment target (design §5.3, §5.6).
 *
 * The target id from a path/query is never trusted. This directory resolves the workspace/project
 * through its scoped store, so an id from another tenant/space is simply not visible and the
 * caller gets `SCOPE_MISMATCH` — not a leak that the object exists. When a store is not wired on
 * this deployment, a non-space target cannot be verified and is refused.
 */
export function createModelTargetDirectory(input: {
  readonly workspaces?: Pick<IndustryWorkspaceStore, 'getWorkspace'>
  readonly projects?: Pick<ProjectStore, 'getProject'>
}): ModelTargetDirectory {
  return {
    async assertTargetInScope(scopeRef: ScopeRef, scope: ModelTargetScope, ctx: ToolContext): Promise<void> {
      if (scope.kind === 'space') return
      if (scope.kind === 'industry_workspace') {
        if (!isUuid(scope.workspaceId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'workspaceId must be a uuid')
        if (input.workspaces === undefined) throw new ModelSelectionError('SCOPE_MISMATCH', 'industry workspaces are not available on this deployment')
        const workspace = await input.workspaces.getWorkspace(scopeRef, scope.workspaceId, ctx)
        if (workspace === undefined) throw new ModelSelectionError('SCOPE_MISMATCH', 'the target workspace is not visible in this scope')
        return
      }
      if (!isUuid(scope.projectId)) throw new ModelSelectionError('INVALID_ARGUMENT', 'projectId must be a uuid')
      if (input.projects === undefined) throw new ModelSelectionError('SCOPE_MISMATCH', 'projects are not available on this deployment')
      const project = await input.projects.getProject(scopeRef, scope.projectId, ctx)
      if (project === undefined) throw new ModelSelectionError('SCOPE_MISMATCH', 'the target project is not visible in this scope')
    },
  }
}
