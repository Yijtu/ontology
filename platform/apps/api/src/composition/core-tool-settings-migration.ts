import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONTRACT_VERSION, SecretValue, createToolContext } from '@ontology/contracts'
import type {
  ScopeRef,
  ToolArchiveLimits,
  ToolContext,
  ToolSearchStrategy,
  ToolSettingsMigrationStore,
} from '@ontology/contracts'
import type { ToolAssignmentService, ToolConnectionService } from '@ontology/application'
import { envVarNameOf } from './secret-resolver'

const BASE_URL_SETTING = 'CORE_WEB_SEARCH_BASE_URL'
const ENDPOINT_SETTING = 'CORE_WEB_SEARCH_ENDPOINT'
const API_KEY_SETTING = 'CORE_WEB_SEARCH_API_KEY'
const SECRET_REF_SETTING = 'CORE_WEB_SEARCH_SECRET_REF'
const MAX_TIMEOUT_SETTING = 'CORE_WEB_SEARCH_MAX_TIMEOUT_MS'
const MAX_BYTES_SETTING = 'CORE_WEB_SEARCH_MAX_BYTES'
/** The durable migration record key; one import per scope, independent of any local marker. */
export const WEB_SEARCH_MIGRATION_KEY = 'web-search-compat-import:v1'

/**
 * One-time bridge from the legacy `CORE_WEB_SEARCH_*` deployment environment to the tool-connection
 * catalogue (design §9, §10).
 *
 * It is idempotent and resumable: the connection id, idempotency key and per-tool selection are
 * deterministic, so a re-run reuses what already exists instead of duplicating it, and a completion
 * marker stops a later run from overwriting subsequent UI edits. Once the marker is written the
 * environment is no longer a second source of truth — the catalogue owns the selection. When no
 * base URL is configured nothing is imported and `web_search` stays unconfigured (fixable in the
 * UI), never a fabricated capability.
 *
 * The legacy API key is read here exactly once and moved into credential custody; it never enters a
 * domain entity. The imported connection is the keyless "compat gateway" adapter, so an old
 * deployment without a key still resolves as usable.
 */
export class CoreToolSettingsMigration {
  readonly #connections: ToolConnectionService
  readonly #assignments: ToolAssignmentService
  readonly #scopeRef: ScopeRef
  readonly #markerPath: string
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #migrationStore: ToolSettingsMigrationStore | undefined

  constructor(input: {
    readonly connections: ToolConnectionService
    readonly assignments: ToolAssignmentService
    readonly scopeRef: ScopeRef
    readonly objectDirectory: string
    readonly environment: Readonly<Record<string, string | undefined>>
    /**
     * The durable idempotency record (S03). When mounted it is authoritative: a local marker file is
     * not enough, because a lost file would silently re-import the environment after the catalogue
     * was edited. A host without it keeps the legacy local-marker behaviour (unit/test hosts).
     */
    readonly migrationStore?: ToolSettingsMigrationStore
  }) {
    this.#connections = input.connections
    this.#assignments = input.assignments
    this.#scopeRef = input.scopeRef
    this.#markerPath = join(
      input.objectDirectory, '.core-settings', input.scopeRef.tenantId, input.scopeRef.spaceId,
      'tool-connections-migrated.flag',
    )
    this.#env = input.environment
    this.#migrationStore = input.migrationStore
  }

  /** True once the one-time bridge to the tool-connection catalogue has run for this scope. */
  async isMigrated(): Promise<boolean> {
    if (this.#migrationStore !== undefined) {
      const ctx = systemContext(this.#scopeRef)
      return this.#migrationStore.isApplied(this.#scopeRef, WEB_SEARCH_MIGRATION_KEY, ctx)
    }
    try { await stat(this.#markerPath); return true } catch { return false }
  }

  async migrate(): Promise<void> {
    if (await this.isMigrated()) return
    const baseUrl = this.#env[BASE_URL_SETTING]?.trim()
    if (baseUrl !== undefined && baseUrl.length > 0) {
      await this.#importCompatGateway(baseUrl)
    }
    await this.#markMigrated()
  }

  async #importCompatGateway(baseUrl: string): Promise<void> {
    const scopeRef = this.#scopeRef
    const ctx = systemContext(scopeRef)
    const connectionId = deterministicUuid(`tool-connection:web-search:${scopeRef.tenantId}:${scopeRef.spaceId}`)
    const credential = this.#legacyApiKey()

    // The legacy base URL and endpoint path are preserved **separately**: the descriptor keeps the
    // base address and the path/timeout travel in the search strategy, so `connection-provider.ts`
    // does not overwrite the imported path with its `/v1/search` default. The archive byte bound and
    // timeout travel in the archive limits.
    const searchStrategy = searchStrategyOf(this.#env)
    const archiveLimits = archiveLimitsOf(this.#env)
    await this.#connections.create({
      connectionId,
      idempotencyKey: `migrate-web-search:${scopeRef.tenantId}:${scopeRef.spaceId}:v1`,
      descriptor: {
        name: '兼容网关',
        adapterType: 'http_compat',
        capabilities: ['web_search'],
        enabled: true,
        endpoint: baseUrl,
        ...(searchStrategy === undefined ? {} : { searchStrategy }),
        ...(archiveLimits === undefined ? {} : { archiveLimits }),
      },
      ...(credential === undefined ? {} : { credential }),
    }, ctx)

    // A resumed run that already wrote the space default must not overwrite it. The selection is
    // per tool (`web_search`), never a single connection applied to every capability.
    const existing = await this.#assignments.get({ kind: 'space' }, ctx)
    if (existing === undefined) {
      await this.#assignments.put({
        scope: { kind: 'space' },
        defaultSelection: { kind: 'inherit' },
        toolSelections: [{ toolId: 'web_search', selection: { kind: 'connection', connectionId } }],
      }, ctx)
    }
  }

  #legacyApiKey(): SecretValue | undefined {
    const ref = this.#env[SECRET_REF_SETTING]
    let apiKey: string
    try {
      apiKey = this.#env[envVarNameOf(ref ?? API_KEY_SETTING)] ?? ''
    } catch {
      apiKey = ''
    }
    if (apiKey.length === 0) apiKey = this.#env[API_KEY_SETTING] ?? ''
    return apiKey.length === 0 ? undefined : new SecretValue(apiKey)
  }

  async #markMigrated(): Promise<void> {
    const migratedAt = new Date().toISOString()
    if (this.#migrationStore !== undefined) {
      await this.#migrationStore.record(this.#scopeRef, {
        migrationKey: WEB_SEARCH_MIGRATION_KEY,
        detail: { baseUrl: this.#env[BASE_URL_SETTING]?.trim() ?? null, migratedAt },
        migratedAt,
      }, systemContext(this.#scopeRef))
    }
    await mkdir(dirname(this.#markerPath), { recursive: true, mode: 0o700 })
    await writeFile(this.#markerPath, JSON.stringify({ migratedAt }), { flag: 'w', mode: 0o600 })
  }
}

/**
 * The search strategy preserved from the legacy environment: the compat endpoint path and the search
 * timeout. A path is kept verbatim only when present, so an unset path falls back to the adapter's
 * `/v1/search` default without being written into the address.
 */
function searchStrategyOf(env: Readonly<Record<string, string | undefined>>): ToolSearchStrategy | undefined {
  const path = env[ENDPOINT_SETTING]?.trim()
  const maxTimeoutMs = optionalPositiveInteger(env, MAX_TIMEOUT_SETTING)
  if ((path === undefined || path.length === 0) && maxTimeoutMs === undefined) return undefined
  return {
    ...(path === undefined || path.length === 0 ? {} : { compatEndpointPath: path }),
    ...(maxTimeoutMs === undefined ? {} : { maxTimeoutMs }),
  }
}

/** The archive bounds preserved from the legacy environment (byte cap and read timeout). */
function archiveLimitsOf(env: Readonly<Record<string, string | undefined>>): ToolArchiveLimits | undefined {
  const maxBytes = optionalPositiveInteger(env, MAX_BYTES_SETTING)
  const maxTimeoutMs = optionalPositiveInteger(env, MAX_TIMEOUT_SETTING)
  if (maxBytes === undefined && maxTimeoutMs === undefined) return undefined
  return {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxTimeoutMs === undefined ? {} : { maxTimeoutMs }),
  }
}

/** A positive integer setting, or `undefined`; a malformed value fails host startup rather than silently dropping. */
function optionalPositiveInteger(env: Readonly<Record<string, string | undefined>>, setting: string): number | undefined {
  const raw = env[setting]?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  if (!/^[1-9]\d*$/u.test(raw)) throw new Error(`${setting} must be a positive integer`)
  return Number(raw)
}

/** Deterministic UUID (RFC 4122 v5-shaped) so a repeated migration reuses the same ids. */
function deterministicUuid(name: string): string {  const hex = createHash('sha256').update(name).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** A server-minted admin context for the one-time migration; never derived from a request. */
function systemContext(scopeRef: ScopeRef): ToolContext {
  const grantedAt = new Date()
  const expiresAt = new Date(grantedAt.getTime() + 5 * 60 * 1000)
  const runId = deterministicUuid(`tool-migration-run:${scopeRef.tenantId}:${scopeRef.spaceId}`)
  return createToolContext({
    principal: {
      tenantId: scopeRef.tenantId,
      subjectId: 'tool-settings-migration',
      roles: ['platform-admin'],
      scopes: [],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: `sha256:${'0'.repeat(64)}`,
    policyVersion: CONTRACT_VERSION,
    deadline: expiresAt.toISOString(),
    budgetReservation: {
      reservationId: deterministicUuid(`tool-migration-budget:${scopeRef.tenantId}:${scopeRef.spaceId}`),
      runId,
      grantedAt: grantedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
    allowedResources: {
      tenantId: scopeRef.tenantId,
      spaceId: scopeRef.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 0,
    },
    traceId: `tool-settings-migration:${scopeRef.spaceId}`,
  })
}
