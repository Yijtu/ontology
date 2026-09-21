import type {
  CapabilityRequirement,
  LogicalRole,
  MappingRef,
  SecretResolver,
  SecretValue,
  SourceProbeAdapter,
  SourceProbeAdapterResolver,
  SourceProbeObservation,
  SourceProbeRequest,
  VersionRef,
} from '@ontology/contracts'
import { SecretValue as SecretValueClass } from '@ontology/contracts'

export {
  SCOPE_A,
  SCOPE_B,
  TENANT_A,
  TENANT_B,
  fixedClock,
  toolContext,
} from './profile-resolver-fixtures'
export { RecordingControlRepository } from './component-registry-fixtures'

/** A distinctive sentinel so a leak is unambiguous in any serialized output. */
export const SENTINEL_SECRET = 'super-secret-token-DO-NOT-LEAK-3f9a'

export const TELEMETRY_ADAPTER_REF: VersionRef = {
  id: 'data-duckdb',
  version: '1.0.0',
  digest: `sha256:${'3'.repeat(64)}`,
}
export const DOCUMENTS_ADAPTER_REF: VersionRef = {
  id: 'search-bm25',
  version: '1.0.0',
  digest: `sha256:${'2'.repeat(64)}`,
}
export const CATALOG_ADAPTER_REF: VersionRef = {
  id: 'data-postgres',
  version: '1.0.0',
  digest: `sha256:${'1'.repeat(64)}`,
}

export function mappingRef(role: LogicalRole, digestSeed: string, version = '1.0.0'): MappingRef {
  const code = digestSeed.codePointAt(0) ?? 97
  return {
    id: `home-energy.mapping.${role}`,
    version,
    digest: `sha256:${((code % 16).toString(16)).repeat(64)}`,
    role,
    sourceObjectRef: {
      sourceRef: { namespace: 'control-postgres', sourceId: `public.${role}_objects` },
      objectPath: `public.${role}_objects`,
    },
  }
}

export function capabilityRequirement(name: string, min = '1.0.0'): CapabilityRequirement {
  return { name, versionRange: { min } }
}

export function sampleObservation(
  adapterRef: VersionRef,
  overrides?: Partial<SourceProbeObservation>,
): SourceProbeObservation {
  const base: SourceProbeObservation = {
    adapterRef,
    catalog: {
      resources: [
        {
          objectRef: {
            sourceRef: { namespace: 'control-postgres', sourceId: 'public.device_catalog' },
            objectPath: 'public.device_catalog',
          },
          schemaRevision: 'rev-1',
          columns: [{ name: 'device_id', type: 'string' }],
        },
      ],
      schemaRevision: 'rev-1',
    },
    pagination: { kind: 'cursor', pagesFetched: 2, exhausted: true },
    cancellation: { support: 'supported', attempted: true },
    snapshot: { consistency: 'repeatable_read', schemaRevision: 'rev-1' },
    limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 5000 },
    supportedDataTypes: ['string', 'integer', 'timestamp'],
    capabilities: [{ name: 'telemetry_read', version: '1.0.0' }],
  }
  return { ...base, ...overrides }
}

export interface ControlledAdapterOptions {
  readonly adapterRef: VersionRef
  readonly observation?: Partial<SourceProbeObservation>
  /** Throw from `probe`. A string is rendered as an Error message. */
  readonly failWith?: string | Error
}

/**
 * Controlled probe target. It records every call so a test can prove the registry actually
 * exercised the adapter (and with the resolved secret), and it can be made to fail or to
 * return an internally inconsistent observation.
 */
export class ControlledProbeAdapter implements SourceProbeAdapter {
  readonly adapterRef: VersionRef
  readonly calls: SourceProbeRequest[] = []
  readonly #observation: Partial<SourceProbeObservation> | undefined
  readonly #failure: string | Error | undefined

  constructor(options: ControlledAdapterOptions) {
    this.adapterRef = options.adapterRef
    this.#observation = options.observation
    this.#failure = options.failWith
  }

  async probe(request: SourceProbeRequest): Promise<SourceProbeObservation> {
    this.calls.push(request)
    if (this.#failure !== undefined) {
      throw this.#failure instanceof Error ? this.#failure : new Error(this.#failure)
    }
    return sampleObservation(this.adapterRef, this.#observation)
  }
}

/** Resolver over an explicit adapter list; an unknown ref does not resolve. */
export class StaticProbeAdapterResolver implements SourceProbeAdapterResolver {
  readonly #byRef: Map<string, SourceProbeAdapter>

  constructor(adapters: readonly SourceProbeAdapter[]) {
    this.#byRef = new Map(adapters.map((adapter) => [adapterKey(adapter.adapterRef), adapter]))
  }

  resolve(adapterRef: VersionRef): Promise<SourceProbeAdapter | undefined> {
    return Promise.resolve(this.#byRef.get(adapterKey(adapterRef)))
  }
}

function adapterKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

/** Always resolves the sentinel. Records the refs it was asked for. */
export class SentinelSecretResolver implements SecretResolver {
  readonly refs: string[] = []

  resolve(secretRef: string): Promise<SecretValue> {
    this.refs.push(secretRef)
    return Promise.resolve(new SecretValueClass(SENTINEL_SECRET))
  }
}

/** Deterministic UUID factory so a test can assert exact ids. */
export function sequentialIds(prefix = '99999999'): () => string {
  let counter = 0
  return () => {
    counter += 1
    const tail = counter.toString(16).padStart(12, '0')
    return `${prefix}-0000-4000-8000-${tail}`
  }
}
