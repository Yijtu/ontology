import { ToolConnectionError } from '@ontology/contracts'
import type {
  ExecutionToolBinding,
  ImmutableArtifactWriter,
  ScopeRef,
  SecretValue,
  ToolConnectionAdminView,
  ToolConnectionDescriptor,
  ToolConnectionErrorCode,
  ToolConnectionStore,
  ToolContext,
  ToolCredentialCustodian,
  ToolExecutionSnapshotStore,
  ToolTargetScope,
  Uuid,
  WebSearchProvider,
} from '@ontology/contracts'
import { WebPageSnapshotArchiver, createWebSearchProviderFromConnection } from '@ontology/adapter-search-web'
import type { ExecutionToolBindingService } from '@ontology/application'
import { toolDescriptorOf, toolDescriptorOfSnapshot } from '@ontology/application'
import { canonicalJson, sha256DigestOf } from '@ontology/core'

/** The model-visible tool a research run reads public pages through. A tool, never a model. */
export const SEARCH_TOOL_ID = 'web_search' as const

/**
 * Why a run cannot reach its bound public search. Every reason is explicit; the caller reports a
 * blocked capability rather than falling through to another connection (design §9: 选定连接失效
 * 不自动切换, 不静默回退).
 */
export type ToolSearchBlockedReason = ToolConnectionErrorCode | 'ADAPTER_UNSUPPORTED'

/** The resolved, pinned search tool of one run: an available provider or an explicit block. */
export type ToolSearchResolution =
  | {
      readonly state: 'available'
      readonly binding: ExecutionToolBinding
      readonly connection: ToolConnectionAdminView
      readonly provider: WebSearchProvider
    }
  | { readonly state: 'blocked'; readonly reason: ToolSearchBlockedReason; readonly message: string }

/**
 * The allowed-domain intersection (design §6/§9): the deployment/space authorization policy
 * intersected with the domains the user chose. A user domain is kept only when it is inside an
 * authorized domain (equal to it or a subdomain of it); the effective set can never be wider than
 * the policy. An absent policy is "no deployment restriction", so the user selection stands.
 */
export function intersectAllowedDomains(
  deploymentDomains: readonly string[] | undefined,
  userDomains: readonly string[],
): readonly string[] {
  const normalize = (domain: string): string => domain.trim().toLowerCase()
  const user = [...new Set(userDomains.map(normalize).filter((domain) => domain.length > 0))]
  if (deploymentDomains === undefined || deploymentDomains.length === 0) return user
  const policy = [...new Set(deploymentDomains.map(normalize).filter((domain) => domain.length > 0))]
  return user.filter((domain) =>
    policy.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`)),
  )
}

function blockedFromError(error: unknown): ToolSearchResolution {
  if (error instanceof ToolConnectionError) {
    return { state: 'blocked', reason: error.code, message: error.message }
  }
  return {
    state: 'blocked',
    reason: 'STORE_FAILED',
    message: error instanceof Error ? error.message : 'the bound search tool could not be resolved',
  }
}

/**
 * A binding created before execution-config snapshots existed (or whose snapshot row is missing or
 * digest-mismatched) cannot be restored to its pinned config, so it is blocked instead of being run
 * on today's descriptor (S02, design §9: 配置撤销/运行版本不兼容 | 明确阻断原因).
 */
function incomplete(runId: Uuid): ToolSearchResolution {
  return {
    state: 'blocked',
    reason: 'TOOL_BINDING_INCOMPLETE',
    message: `execution ${runId} pinned a ${SEARCH_TOOL_ID} revision whose config snapshot is unavailable; it must not run on the current descriptor`,
  }
}

export interface CoreSearchBindingDependencies {
  /** Pins the search connection to an execution exactly once, then reads it back unchanged. */
  readonly bindings: ExecutionToolBindingService
  readonly connections: ToolConnectionStore
  readonly credentials: ToolCredentialCustodian
  /**
   * The immutable execution-config snapshots (S02). When mounted, the run is built from the pinned
   * snapshot, never from today's catalogue row, and a binding that carries no snapshot is a stable
   * `TOOL_BINDING_INCOMPLETE` block rather than a silent fall-through to the current descriptor.
   */
  readonly snapshots?: ToolExecutionSnapshotStore
  /** The trusted scope the catalogue is read from. Never a request body value. */
  readonly scopeRef: ScopeRef
  /** Archives the actual page bytes through the same immutable writer the run gateway uses. */
  readonly artifacts: ImmutableArtifactWriter
  /** The assignment target the effective `web_search` selection is resolved at. */
  readonly targetScope: ToolTargetScope
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
}

export interface CoreSearchBinding {
  /**
   * Resolve (and pin on first use) the run's public search. The binding never silently switches: a
   * named-but-disabled/revoked connection and a missing credential are returned as a stable block.
   */
  resolveForRun(runId: Uuid, ctx: ToolContext): Promise<ToolSearchResolution>
}

/**
 * Wire the effective `web_search` tool connection into the actual run gateway (design §4/§9).
 *
 * The selection is resolved through the same resolution order the AI settings use, pinned to the
 * execution via `ExecutionToolBinding`, and only then turned into a provider. A retry, resume or
 * parallel attempt reads the stored binding back, so a later default change can never retarget an
 * in-flight run.
 */
export function createCoreSearchBinding(dependencies: CoreSearchBindingDependencies): CoreSearchBinding {
  const now = dependencies.now
  const fetchImpl = dependencies.fetchImpl

  const credentialFor = async (connectionId: Uuid, ctx: ToolContext): Promise<SecretValue | undefined> => {
    const ref = await dependencies.connections.getCredentialRef(dependencies.scopeRef, connectionId, ctx)
    if (ref === undefined) return undefined
    return dependencies.credentials.resolve(dependencies.scopeRef, ref, ctx)
  }

  return {
    async resolveForRun(runId: Uuid, ctx: ToolContext): Promise<ToolSearchResolution> {
      let binding: ExecutionToolBinding
      try {
        binding = await dependencies.bindings.ensureBinding(
          { executionId: runId, scope: dependencies.targetScope, toolId: SEARCH_TOOL_ID },
          ctx,
        )
      } catch (error) {
        return blockedFromError(error)
      }
      // The revocation fence: a connection that was disabled, cleared of its credential or stripped
      // of the capability after the binding is a stable block, never a fall-through to another.
      try {
        await dependencies.bindings.assertUsable(runId, SEARCH_TOOL_ID, ctx)
      } catch (error) {
        return blockedFromError(error)
      }
      const connectionId = binding.connectionId
      if (connectionId === undefined) {
        return { state: 'blocked', reason: 'TOOL_NOT_CONFIGURED', message: `the pinned ${SEARCH_TOOL_ID} connection is missing` }
      }
      const connection = await dependencies.connections.getConnection(dependencies.scopeRef, connectionId, ctx)
      if (connection === undefined) {
        return { state: 'blocked', reason: 'TOOL_NOT_CONFIGURED', message: `the pinned ${SEARCH_TOOL_ID} connection is no longer visible in this scope` }
      }
      // Build the provider from the pinned snapshot (S02), never from today's catalogue row. The
      // catalogue above was consulted only for the revoke/disable/permission fence. A binding that
      // carries no snapshot was created before snapshots existed: it must be blocked rather than run
      // on the current descriptor, which could be a different service address.
      let descriptor: ToolConnectionDescriptor
      const snapshots = dependencies.snapshots
      if (snapshots !== undefined) {
        const revision = binding.connectionRevision
        if (binding.snapshotRef === undefined || revision === undefined) {
          return incomplete(runId)
        }
        const snapshot = await snapshots.getToolSnapshot(dependencies.scopeRef, connectionId, revision, ctx)
        if (snapshot === undefined || sha256DigestOf(canonicalJson(snapshot)) !== binding.snapshotRef.digest) {
          return incomplete(runId)
        }
        descriptor = toolDescriptorOfSnapshot(snapshot)
      } else {
        descriptor = toolDescriptorOf(connection)
      }
      const archiver = new WebPageSnapshotArchiver({
        artifacts: dependencies.artifacts,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(now === undefined ? {} : { now }),
      })
      const credential = await credentialFor(connection.connectionId, ctx)
      const provider = createWebSearchProviderFromConnection({
        descriptor,
        ...(credential === undefined ? {} : { credential }),
        snapshotArchive: archiver,
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(now === undefined ? {} : { now }),
      })
      if (provider === undefined) {
        const reason: ToolSearchBlockedReason =
          connection.adapterType === 'native_tavily' ? 'CREDENTIAL_MISSING' : 'ADAPTER_UNSUPPORTED'
        return {
          state: 'blocked',
          reason,
          message: reason === 'CREDENTIAL_MISSING'
            ? `the pinned ${SEARCH_TOOL_ID} connection has no credential to authenticate with`
            : `the pinned ${connection.adapterType} connection has no usable service address`,
        }
      }
      return { state: 'available', binding, connection, provider }
    },
  }
}
