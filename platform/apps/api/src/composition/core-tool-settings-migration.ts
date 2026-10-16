import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONTRACT_VERSION, SecretValue, createToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import type { ToolAssignmentService, ToolConnectionService } from '@ontology/application'
import { envVarNameOf } from './secret-resolver'

const BASE_URL_SETTING = 'CORE_WEB_SEARCH_BASE_URL'
const ENDPOINT_SETTING = 'CORE_WEB_SEARCH_ENDPOINT'
const API_KEY_SETTING = 'CORE_WEB_SEARCH_API_KEY'
const SECRET_REF_SETTING = 'CORE_WEB_SEARCH_SECRET_REF'

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

  constructor(input: {
    readonly connections: ToolConnectionService
    readonly assignments: ToolAssignmentService
    readonly scopeRef: ScopeRef
    readonly objectDirectory: string
    readonly environment: Readonly<Record<string, string | undefined>>
  }) {
    this.#connections = input.connections
    this.#assignments = input.assignments
    this.#scopeRef = input.scopeRef
    this.#markerPath = join(
      input.objectDirectory, '.core-settings', input.scopeRef.tenantId, input.scopeRef.spaceId,
      'tool-connections-migrated.flag',
    )
    this.#env = input.environment
  }

  /** True once the one-time bridge to the tool-connection catalogue has run for this scope. */
  async isMigrated(): Promise<boolean> {
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

    await this.#connections.create({
      connectionId,
      idempotencyKey: `migrate-web-search:${scopeRef.tenantId}:${scopeRef.spaceId}:v1`,
      descriptor: {
        name: '兼容网关',
        adapterType: 'http_compat',
        capabilities: ['web_search'],
        enabled: true,
        endpoint: compatAddress(baseUrl, this.#env[ENDPOINT_SETTING]?.trim()),
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
    await mkdir(dirname(this.#markerPath), { recursive: true, mode: 0o700 })
    await writeFile(this.#markerPath, JSON.stringify({ migratedAt: new Date().toISOString() }), { flag: 'w', mode: 0o600 })
  }
}

/**
 * The tool descriptor carries one `endpoint`; combine the legacy base URL and path into the full
 * service address. A malformed base URL is kept verbatim (the UI can repair it) rather than failing
 * host startup.
 */
function compatAddress(baseUrl: string, path: string | undefined): string {
  if (path === undefined || path.length === 0) return baseUrl
  try {
    return new URL(path, baseUrl).toString()
  } catch {
    return baseUrl
  }
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
