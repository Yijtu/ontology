import type {
  ActiveProfileRecord,
  CapabilityRequirement,
  ComponentKind,
  ComponentVersionRecord,
  DeploymentEnvironment,
  LogicalRole,
  MappingRef,
  ModuleLifecycleState,
  PreflightResult,
  ProfileRef,
  ProfileSpec,
  ProfileVersionRecord,
  RevisionString,
  Sha256Digest,
  SourceBindingRecord,
  SourceKind,
  SourceProbeJobRecord,
  VersionRef,
} from '@ontology/contracts'
import { ApiError, toApiFailure } from './errors'

export { ApiError } from './errors'

/**
 * The workbench HTTP client. It is the only place the browser app touches the backend:
 * every call goes through `fetch` against the public C6 routes, and nothing server-side is
 * imported. Secret material is never part of a request or response: a source carries an
 * opaque `secretRef`, and the API never echoes a resolved value.
 */
export interface WorkbenchClientOptions {
  /** Absolute API origin. Empty means same-origin (the production host proxies `/api`). */
  readonly baseUrl: string
  readonly fetchImpl?: typeof fetch
  readonly newId?: () => string
}

export interface PublishProfileRequest {
  readonly profileRef: ProfileRef
  readonly spec: ProfileSpec
  readonly environment: DeploymentEnvironment
}

export interface ActivateProfileRequest {
  readonly profileRef: ProfileRef
  readonly snapshotHash: Sha256Digest
  /** `null` means "no active version expected yet" (first activation); omitted means no If-Match. */
  readonly expectedRevision?: RevisionString | null
}

export interface RegisterSourceRequest {
  readonly kind: SourceKind
  readonly role: LogicalRole
  readonly adapterRef: VersionRef
  readonly secretRef: string
  readonly mappingRef?: MappingRef
  readonly capabilityVersion?: string
}

/** The public run fields the workbench displays. The run record itself lives in the API. */
export interface BoundRunView {
  readonly runId: string
  readonly state: string
  readonly revision: RevisionString
  readonly ownerSubjectId: string
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
}

export interface ComponentFilter {
  readonly kind?: ComponentKind
  readonly lifecycleState?: ModuleLifecycleState
}

interface RequestOptions {
  readonly body?: unknown
  readonly idempotencyKey?: string
  readonly ifMatch?: string
}

function defaultId(): string {
  const cryptoApi: Crypto | undefined = globalThis.crypto
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `idem-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dataOf<T>(body: unknown, path: string): T {
  if (!isRecord(body) || !('data' in body)) {
    throw new ApiError(500, {
      code: 'MALFORMED_ENVELOPE',
      message: `the response for ${path} did not carry a data envelope`,
      retryable: false,
      reasons: [],
      missingCapabilities: [],
    })
  }
  return body['data'] as T
}

export class WorkbenchClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  readonly #newId: () => string

  constructor(options: WorkbenchClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '')
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.#newId = options.newId ?? defaultId
  }

  listComponents(filter: ComponentFilter = {}): Promise<ComponentVersionRecord[]> {
    const query = new URLSearchParams()
    if (filter.kind !== undefined) query.set('kind', filter.kind)
    if (filter.lifecycleState !== undefined) query.set('lifecycleState', filter.lifecycleState)
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    return this.#request<{ components: ComponentVersionRecord[] }>('GET', `/api/v1/components${suffix}`).then(
      (data) => data.components,
    )
  }

  publishProfile(request: PublishProfileRequest): Promise<ProfileVersionRecord> {
    return this.#request<ProfileVersionRecord>('POST', '/api/v1/profiles', {
      body: request,
      idempotencyKey: this.#newId(),
    })
  }

  preflightProfile(profileRef: ProfileRef): Promise<PreflightResult> {
    return this.#request<PreflightResult>(
      'POST',
      `/api/v1/profiles/${encodeURIComponent(profileRef.id)}/preflight`,
      { body: { version: profileRef.version } },
    )
  }

  activateProfile(request: ActivateProfileRequest): Promise<ActiveProfileRecord> {
    const expected = request.expectedRevision
    return this.#request<ActiveProfileRecord>(
      'POST',
      `/api/v1/profiles/${encodeURIComponent(request.profileRef.id)}/activate`,
      {
        body: { version: request.profileRef.version, snapshotHash: request.snapshotHash },
        ...(expected === undefined ? {} : { ifMatch: expected === null ? '*' : expected }),
      },
    )
  }

  listSources(): Promise<SourceBindingRecord[]> {
    return this.#request<{ sources: SourceBindingRecord[] }>('GET', '/api/v1/sources').then(
      (data) => data.sources,
    )
  }

  registerSource(request: RegisterSourceRequest): Promise<SourceBindingRecord> {
    return this.#request<SourceBindingRecord>('POST', '/api/v1/sources', {
      body: request,
      idempotencyKey: this.#newId(),
    })
  }

  probeSource(
    sourceId: string,
    capabilities?: readonly CapabilityRequirement[],
  ): Promise<SourceProbeJobRecord> {
    return this.#request<SourceProbeJobRecord>(
      'POST',
      `/api/v1/sources/${encodeURIComponent(sourceId)}/probe`,
      { body: capabilities === undefined ? {} : { capabilities } },
    )
  }

  getRun(runId: string): Promise<BoundRunView> {
    return this.#request<BoundRunView>('GET', `/api/v1/runs/${encodeURIComponent(runId)}`)
  }

  async #request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      throw new ApiError(response.status, toApiFailure(response.status, parsed))
    }
    return dataOf<T>(parsed, path)
  }
}
