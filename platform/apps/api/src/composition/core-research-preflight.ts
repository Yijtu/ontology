import { ToolConnectionError } from '@ontology/contracts'
import type {
  EffectiveToolSelection,
  ResearchLimits,
  ResearchPreflight,
  ResearchPreflightBlock,
  ResearchPreflightRecipient,
  ToolContext,
  ToolSelectionResolver,
  ScopeRef,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { intersectAllowedDomains } from './core-tool-search-binding'

/**
 * The research preflight (design §2/§10): what a run *would* use before it is authorized.
 *
 * It reads the effective `web_search` selection through the same resolution the run will use, with a
 * host-minted context (the read is not the requester's write permission), and reports the actual
 * recipient, the deployment ∩ user domain scope, the budget ceilings and every blocking item. It
 * never names a credential — only the connection's non-secret identity/state.
 */
export interface CoreResearchPreflightDependencies {
  readonly selection: ToolSelectionResolver
  readonly scopeRef: ScopeRef
  /** A host-minted context used only to read the effective selection; never the request body. */
  readonly systemContext: () => ToolContext
  /** The deployment/space authorized domain policy; absent is "no deployment restriction". */
  readonly deploymentDomains?: () => readonly string[] | undefined
  readonly now: () => string
}

export interface ResearchPreflightInput {
  readonly workspaceId: Uuid
  readonly requestedDomains: readonly string[]
  readonly limits: ResearchLimits
  readonly policyRef: VersionRef
  readonly budgetRef: VersionRef
  readonly requesterRoles: readonly string[]
}

function recipientOf(selection: EffectiveToolSelection): ResearchPreflightRecipient {
  const summary = selection.connectionSummary
  const base = {
    toolId: 'web_search' as const,
    ...(selection.connectionId === undefined ? {} : { connectionId: selection.connectionId }),
    ...(summary === undefined ? {} : {
      connectionName: summary.name,
      adapterType: summary.adapterType,
      connectionRevision: summary.revision,
    }),
  }
  switch (selection.state) {
    case 'available':
      return { state: 'available', ...base }
    case 'disabled':
      return { state: 'disabled', ...base, blockedReason: selection.blockedReason ?? 'TOOL_DISABLED' }
    case 'unconfigured':
      return { state: 'unconfigured', ...base, blockedReason: selection.blockedReason ?? 'TOOL_NOT_CONFIGURED' }
    case 'blocked':
      return { state: 'blocked', ...base, blockedReason: selection.blockedReason ?? 'TOOL_NOT_CONFIGURED' }
  }
}

const RECIPIENT_BLOCK_MESSAGE: Readonly<Record<string, string>> = {
  TOOL_NOT_CONFIGURED: '尚未配置公共搜索服务，研究无法开始。',
  TOOL_DISABLED: '公共搜索服务已停用，研究无法开始。',
  TOOL_CAPABILITY_MISMATCH: '所选连接不提供网页搜索能力。',
  CREDENTIAL_MISSING: '公共搜索服务的凭据缺失。',
  TOOL_BINDING_REVOKED: '绑定的搜索连接已被撤销。',
  SCOPE_MISMATCH: '当前目标不在可信租户/空间范围内。',
  STORE_FAILED: '读取搜索服务配置失败。',
}

export interface CoreResearchPreflight {
  preflight(input: ResearchPreflightInput): Promise<ResearchPreflight>
}

export function createCoreResearchPreflight(
  dependencies: CoreResearchPreflightDependencies,
): CoreResearchPreflight {
  return {
    async preflight(input: ResearchPreflightInput): Promise<ResearchPreflight> {
      const ctx = dependencies.systemContext()
      const blocked: ResearchPreflightBlock[] = []
      let recipient: ResearchPreflightRecipient
      try {
        const selection = await dependencies.selection.resolve(
          dependencies.scopeRef,
          { scope: { kind: 'industry_workspace', workspaceId: input.workspaceId }, toolId: 'web_search' },
          ctx,
        )
        recipient = recipientOf(selection)
      } catch (error) {
        const reason = error instanceof ToolConnectionError ? error.code : 'STORE_FAILED'
        recipient = { state: 'blocked', toolId: 'web_search', blockedReason: reason }
      }
      if (recipient.state !== 'available') {
        const reason = recipient.blockedReason ?? 'TOOL_NOT_CONFIGURED'
        blocked.push({
          code: reason,
          message: RECIPIENT_BLOCK_MESSAGE[reason] ?? '公共搜索服务不可用，研究无法开始。',
        })
      }
      const deploymentDomains = dependencies.deploymentDomains?.()
      const effectiveDomains = intersectAllowedDomains(deploymentDomains, input.requestedDomains)
      if (input.requestedDomains.length > 0 && effectiveDomains.length === 0) {
        blocked.push({
          code: 'DOMAIN_OUT_OF_POLICY',
          message: '所选域名都不在部署/空间的授权范围内。',
        })
      }
      return {
        schemaVersion: 'research-preflight@1',
        workspaceId: input.workspaceId,
        generatedAt: dependencies.now(),
        recipient,
        requestedDomains: [...input.requestedDomains],
        effectiveDomains,
        limits: input.limits,
        policyRef: input.policyRef,
        budgetRef: input.budgetRef,
        blocked,
        authorization: {
          roles: [...input.requesterRoles],
          deadline: input.limits.deadline,
          note: '本次预检为只读；开始研究时服务端会按此范围与额度固定实际绑定。',
        },
      }
    },
  }
}
