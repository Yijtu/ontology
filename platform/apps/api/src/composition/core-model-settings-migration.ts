import { createHash } from 'node:crypto'
import { CONTRACT_VERSION, SecretValue, createToolContext } from '@ontology/contracts'
import type { ScopeRef, ToolContext } from '@ontology/contracts'
import type { ModelAssignmentService, ModelConnectionService } from '@ontology/application'
import type { CoreLocalModelSettings } from './core-local-model-settings'
import { envVarNameOf } from './secret-resolver'

/** The status the legacy `/core/model-settings` surface reports once the catalogue owns the truth. */
export const MODEL_SETTINGS_MIGRATED = 'MODEL_SETTINGS_MIGRATED'

/**
 * One-time bridge from the single legacy generation configuration to the multi-model catalogue
 * (design §5.3). It is idempotent and resumable: connection/assignment ids and idempotency keys are
 * deterministic, so a re-run reuses what already exists instead of duplicating it, and a completion
 * marker stops a later run from overwriting subsequent user edits.
 *
 * The legacy API key is read here exactly once and moved into credential custody; it never enters a
 * domain entity. JEV keeps its own adapter type and does not share the generation credential.
 */
export class CoreModelSettingsMigration {
  readonly #settings: CoreLocalModelSettings
  readonly #connections: ModelConnectionService
  readonly #assignments: ModelAssignmentService
  readonly #env: Readonly<Record<string, string | undefined>>

  constructor(input: {
    readonly settings: CoreLocalModelSettings
    readonly connections: ModelConnectionService
    readonly assignments: ModelAssignmentService
    readonly environment: Readonly<Record<string, string | undefined>>
  }) {
    this.#settings = input.settings
    this.#connections = input.connections
    this.#assignments = input.assignments
    this.#env = input.environment
  }

  isMigrated(): Promise<boolean> {
    return this.#settings.isMigrated()
  }

  async migrate(): Promise<void> {
    if (await this.#settings.isMigrated()) return
    const scopeRef = this.#settings.scopeRef
    const ctx = systemContext(scopeRef)
    const snapshot = await this.#settings.readForMigration()
    const legacy = snapshot.settings

    const generationId = deterministicUuid(`model-connection:generation:${scopeRef.tenantId}:${scopeRef.spaceId}`)
    await this.#connections.create({
      connectionId: generationId,
      idempotencyKey: `migrate-generation:${scopeRef.tenantId}:${scopeRef.spaceId}:v1`,
      descriptor: {
        name: '原生成模型',
        adapterType: 'company_generation',
        protocol: legacy.protocol === 'private' ? 'private' : 'openai_compatible',
        capabilities: ['generation', 'research'],
        enabled: legacy.enabled,
        platformModelId: legacy.platformModelId || 'company-generation',
        providerModelName: legacy.vendorModel || 'migrated-generation',
        ...(legacy.baseUrl === '' ? {} : { baseUrl: legacy.baseUrl }),
        ...(legacy.endpoint === '' ? {} : { endpoint: legacy.endpoint }),
      },
      ...(legacy.apiKey === '' ? {} : { credential: new SecretValue(legacy.apiKey) }),
    }, ctx)

    const defaultSelection = legacy.enabled
      ? { kind: 'connection' as const, connectionId: generationId }
      : { kind: 'disabled' as const }
    const capabilitySelections: { capability: 'decision_jev'; selection: { kind: 'connection'; connectionId: string } }[] = []

    const jev = this.#jevConfiguration()
    if (jev !== undefined) {
      const jevId = deterministicUuid(`model-connection:jev:${scopeRef.tenantId}:${scopeRef.spaceId}`)
      await this.#connections.create({
        connectionId: jevId,
        idempotencyKey: `migrate-jev:${scopeRef.tenantId}:${scopeRef.spaceId}:v1`,
        descriptor: {
          name: '原决策 JEV 模型',
          adapterType: 'jev',
          protocol: 'jev',
          capabilities: ['decision_jev'],
          enabled: true,
          platformModelId: jev.platformModelId,
          providerModelName: jev.vendorModel,
          ...(jev.baseUrl === '' ? {} : { baseUrl: jev.baseUrl }),
          ...(jev.endpoint === '' ? {} : { endpoint: jev.endpoint }),
        },
        ...(jev.apiKey === '' ? {} : { credential: new SecretValue(jev.apiKey) }),
      }, ctx)
      capabilitySelections.push({ capability: 'decision_jev', selection: { kind: 'connection', connectionId: jevId } })
    }

    // A resumed run that already wrote the space default must not overwrite it.
    const existing = await this.#assignments.get({ kind: 'space' }, ctx)
    if (existing === undefined) {
      await this.#assignments.put({
        scope: { kind: 'space' },
        defaultSelection,
        capabilitySelections,
      }, ctx)
    }
    // Switch the single source of truth, then clear the legacy plaintext credential.
    if (snapshot.fileExists) await this.#settings.clearStoredCredentialForMigration()
    await this.#settings.markMigrated()
  }

  #jevConfiguration(): { baseUrl: string; endpoint: string; platformModelId: string; vendorModel: string; apiKey: string } | undefined {
    if (this.#env['CORE_ENABLE_JEV'] !== 'true') return undefined
    const baseUrl = this.#env['CORE_JEV_BASE_URL'] ?? ''
    const platformModelId = this.#env['CORE_JEV_PLATFORM_MODEL_ID'] ?? ''
    const vendorModel = this.#env['CORE_JEV_VENDOR_MODEL'] ?? ''
    if (baseUrl === '' || platformModelId === '' || vendorModel === '') return undefined
    let apiKey = ''
    try { apiKey = this.#env[envVarNameOf(this.#env['CORE_JEV_SECRET_REF'] ?? 'CORE_JEV_API_KEY')] ?? '' } catch { apiKey = '' }
    return {
      baseUrl,
      endpoint: this.#env['CORE_JEV_ENDPOINT'] ?? '',
      platformModelId,
      vendorModel,
      apiKey,
    }
  }
}

/** Deterministic UUID (RFC 4122 v5-shaped) so a repeated migration reuses the same ids. */
function deterministicUuid(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** A server-minted admin context for the one-time migration; never derived from a request. */
function systemContext(scopeRef: ScopeRef): ToolContext {
  const grantedAt = new Date()
  const expiresAt = new Date(grantedAt.getTime() + 5 * 60 * 1000)
  const runId = deterministicUuid(`migration-run:${scopeRef.tenantId}:${scopeRef.spaceId}`)
  return createToolContext({
    principal: {
      tenantId: scopeRef.tenantId,
      subjectId: 'model-settings-migration',
      roles: ['platform-admin'],
      scopes: [],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: `sha256:${'0'.repeat(64)}`,
    policyVersion: CONTRACT_VERSION,
    deadline: expiresAt.toISOString(),
    budgetReservation: {
      reservationId: deterministicUuid(`migration-budget:${scopeRef.tenantId}:${scopeRef.spaceId}`),
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
    traceId: `model-settings-migration:${scopeRef.spaceId}`,
  })
}
