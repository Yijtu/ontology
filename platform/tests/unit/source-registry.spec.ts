import { describe, expect, it } from 'vitest'
import { SourceRegistry, SourceRegistryError, InMemorySourceStore } from '@ontology/application'
import type { RegisterSourceInput } from '@ontology/application'
import { SecretValue } from '@ontology/contracts'
import type { ProfileRef, SourceProbeAdapter, ToolContext } from '@ontology/contracts'
import {
  CATALOG_ADAPTER_REF,
  DOCUMENTS_ADAPTER_REF,
  SENTINEL_SECRET,
  SCOPE_A,
  SCOPE_B,
  TELEMETRY_ADAPTER_REF,
  ControlledProbeAdapter,
  RecordingControlRepository,
  SentinelSecretResolver,
  StaticProbeAdapterResolver,
  capabilityRequirement,
  fixedClock,
  mappingRef,
  sequentialIds,
  toolContext,
} from './source-registry-fixtures'

const EDITOR = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['data-editor'], 'source-editor')
const VIEWER = toolContext(SCOPE_A.tenantId, SCOPE_A.spaceId, ['business-user'], 'source-viewer')
const EDITOR_B = toolContext(SCOPE_B.tenantId, SCOPE_B.spaceId, ['data-editor'], 'source-editor-b')
const PROFILE_REF: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
const DIGEST_A = `sha256:${'a'.repeat(64)}`
const DIGEST_B = `sha256:${'b'.repeat(64)}`

function buildRegistry(adapters: readonly SourceProbeAdapter[] = []): {
  readonly registry: SourceRegistry
  readonly control: RecordingControlRepository
  readonly secrets: SentinelSecretResolver
} {
  const control = new RecordingControlRepository()
  const secrets = new SentinelSecretResolver()
  const registry = new SourceRegistry({
    control,
    store: new InMemorySourceStore(),
    secrets,
    adapters: new StaticProbeAdapterResolver(adapters),
    now: fixedClock(),
    newId: sequentialIds(),
  })
  return { registry, control, secrets }
}

function telemetryInput(overrides?: Partial<RegisterSourceInput>): RegisterSourceInput {
  return {
    scopeRef: SCOPE_A,
    kind: 'read_only_origin',
    role: 'telemetry',
    adapterRef: TELEMETRY_ADAPTER_REF,
    secretRef: 'secret://vault/telemetry-ro',
    mappingRef: mappingRef('telemetry', 'a'),
    ...overrides,
  }
}

async function capture(run: () => Promise<unknown>): Promise<SourceRegistryError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SourceRegistryError) return error
    throw error
  }
  throw new Error('expected the source call to fail')
}

describe('source registration', () => {
  it('registers a read-only origin and an imported source through the same path without a connection', async () => {
    const { registry } = buildRegistry([])

    const origin = await registry.registerSource(telemetryInput(), EDITOR)
    const imported = await registry.registerSource(
      {
        scopeRef: SCOPE_A,
        kind: 'imported',
        role: 'documents',
        adapterRef: DOCUMENTS_ADAPTER_REF,
        secretRef: 'secret://vault/documents',
        mappingRef: mappingRef('documents', 'b'),
      },
      EDITOR,
    )

    expect(origin.kind).toBe('read_only_origin')
    expect(imported.kind).toBe('imported')
    expect(origin.status).toBe('registered')
    expect(imported.status).toBe('registered')
    expect(await registry.listSources(SCOPE_A, EDITOR)).toHaveLength(2)

    // Registration never probed: with no adapter configured the source is still registered.
    const job = await registry.probeSource({ scopeRef: SCOPE_A, sourceId: origin.sourceId }, EDITOR)
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('CAPABILITY_NOT_CONFIGURED')
  })

  it('records register/probe audit events on the control ledger', async () => {
    const { registry, control } = buildRegistry([
      new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF }),
    ])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)
    await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    const stream = `source:${binding.sourceId}`
    expect(control.appended.filter((event) => event.streamRef === stream)).toHaveLength(2)
  })
})

describe('trusted capability probe', () => {
  it('exercises the adapter and returns the real supported scope', async () => {
    const adapter = new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF })
    const { registry, secrets } = buildRegistry([adapter])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)

    const job = await registry.probeSource(
      { scopeRef: SCOPE_A, sourceId: binding.sourceId, capabilities: [capabilityRequirement('telemetry_read')] },
      EDITOR,
    )

    expect(job.status).toBe('succeeded')
    expect(job.capabilities).toHaveLength(1)
    const capability = job.capabilities?.[0]
    expect(capability?.name).toBe('telemetry_read')
    expect(capability?.consistency).toBe('repeatable_read')
    expect(capability?.cancellation).toBe('supported')
    expect(capability?.pagination).toBe('cursor')
    expect(capability?.supportedDataTypes).toEqual(['string', 'integer', 'timestamp'])
    expect(capability?.limits.maxRows).toBe(1000)
    expect(job.schemaRevision).toBe('rev-1')

    expect(adapter.calls).toHaveLength(1)
    expect(adapter.calls[0]?.secret.reveal()).toBe(SENTINEL_SECRET)
    expect(secrets.refs).toEqual(['secret://vault/telemetry-ro'])

    const stored = await registry.getSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).toBe('ready')
  })

  it('leaves the source not ready when the adapter throws', async () => {
    const adapter = new ControlledProbeAdapter({
      adapterRef: TELEMETRY_ADAPTER_REF,
      failWith: 'connection refused',
    })
    const { registry } = buildRegistry([adapter])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)

    const job = await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('SOURCE_UNAVAILABLE')

    const stored = await registry.getSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).toBe('failed')
  })

  it('rejects an internally inconsistent observation instead of marking ready', async () => {
    const adapter = new ControlledProbeAdapter({
      adapterRef: TELEMETRY_ADAPTER_REF,
      observation: {
        cancellation: { support: 'supported', attempted: false },
        pagination: { kind: 'cursor', pagesFetched: 0, exhausted: false },
      },
    })
    const { registry } = buildRegistry([adapter])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)

    const job = await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('SOURCE_UNAVAILABLE')
    const stored = await registry.getSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).not.toBe('ready')
  })

  it('fails with CAPABILITY_NOT_CONFIGURED when the requested subset is not supported', async () => {
    const adapter = new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF })
    const { registry } = buildRegistry([adapter])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)

    const job = await registry.probeSource(
      {
        scopeRef: SCOPE_A,
        sourceId: binding.sourceId,
        capabilities: [capabilityRequirement('telemetry_read'), capabilityRequirement('structured_query')],
      },
      EDITOR,
    )
    expect(job.status).toBe('failed')
    expect(job.errorCode).toBe('CAPABILITY_NOT_CONFIGURED')
    expect(job.safeMessage).toContain('structured_query')
    const stored = await registry.getSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    expect(stored.status).not.toBe('ready')
  })

  it('never marks a source ready when the adapter answers for another version', async () => {
    const adapter = new ControlledProbeAdapter({
      adapterRef: TELEMETRY_ADAPTER_REF,
      observation: { adapterRef: DOCUMENTS_ADAPTER_REF },
    })
    const { registry } = buildRegistry([adapter])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)
    const job = await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    expect(job.status).toBe('failed')
  })
})

describe('secret handling', () => {
  it('scrubs the resolved secret from probe error text', async () => {
    const leaking: SourceProbeAdapter = {
      adapterRef: TELEMETRY_ADAPTER_REF,
      probe: (request) => Promise.reject(new Error(`connect failed: password=${request.secret.reveal()}`)),
    }
    const { registry } = buildRegistry([leaking])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)
    const job = await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)

    expect(job.status).toBe('failed')
    expect(job.safeMessage).toContain('[redacted]')
    expect(job.safeMessage).not.toContain(SENTINEL_SECRET)
    expect(JSON.stringify(job)).not.toContain(SENTINEL_SECRET)
  })

  it('keeps the resolved secret out of the configuration export and the model context', async () => {
    const adapter = new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF })
    const { registry } = buildRegistry([adapter])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)
    await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)

    const exported = await registry.exportConfig(SCOPE_A, EDITOR)
    expect(JSON.stringify(exported)).not.toContain(SENTINEL_SECRET)
    expect(JSON.stringify(exported)).toContain('secret://vault/telemetry-ro')
    expect(exported.sources[0]?.secretRef).toBe('secret://vault/telemetry-ro')

    const model = await registry.buildModelContext(SCOPE_A, EDITOR)
    expect(JSON.stringify(model)).not.toContain(SENTINEL_SECRET)
    expect(JSON.stringify(model)).not.toContain('secret://vault/telemetry-ro')
    expect(model.sources[0]?.capabilities).toEqual([{ name: 'telemetry_read', version: '1.0.0' }])
  })

  it('never renders a resolved secret through implicit conversion', () => {
    const secret = new SecretValue(SENTINEL_SECRET)
    expect(String(secret)).toBe('[redacted]')
    expect(JSON.stringify(secret)).toBe('"[redacted]"')
    expect(`${secret}`).toBe('[redacted]')
    expect(secret.reveal()).toBe(SENTINEL_SECRET)
  })

  it('refuses a raw secret value as secretRef', async () => {
    const { registry } = buildRegistry([])
    const error = await capture(() =>
      registry.registerSource(telemetryInput({ secretRef: 'password=hunter2' }), EDITOR),
    )
    expect(error.code).toBe('INVALID_ARGUMENT')
  })
})

describe('identity boundary', () => {
  it('rejects a request scope that differs from the trusted principal', async () => {
    const { registry } = buildRegistry([])
    const error = await capture(() => registry.registerSource(telemetryInput({ scopeRef: SCOPE_B }), EDITOR))
    expect(error.code).toBe('SCOPE_MISMATCH')
    expect(error.httpStatus).toBe(403)
  })

  it('rejects an attempt to smuggle a principal into the request', async () => {
    const { registry } = buildRegistry([])
    const payload: RegisterSourceInput & { principal: unknown } = {
      ...telemetryInput(),
      principal: { tenantId: SCOPE_B.tenantId, roles: ['platform-admin'] },
    }
    const error = await capture(() => registry.registerSource(payload, EDITOR))
    expect(error.code).toBe('INVALID_ARGUMENT')
    expect(error.message).toContain('principal')
  })

  it('requires the data-editor role and refuses an untrusted context', async () => {
    const { registry } = buildRegistry([])
    const forbidden = await capture(() => registry.registerSource(telemetryInput(), VIEWER))
    expect(forbidden.code).toBe('FORBIDDEN')

    const unbranded: ToolContext = {} as ToolContext
    const untrusted = await capture(() => registry.registerSource(telemetryInput(), unbranded))
    expect(untrusted.code).toBe('UNAUTHENTICATED')
  })

  it('keeps sources inside the tenant/space boundary', async () => {
    const { registry } = buildRegistry([])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)
    expect(await registry.listSources(SCOPE_B, EDITOR_B)).toHaveLength(0)
    const crossScope = await capture(() =>
      registry.getSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR_B),
    )
    expect(crossScope.code).toBe('SCOPE_MISMATCH')
  })
})

describe('preflight invalidation', () => {
  it('marks a recorded preflight stale when the mapping or capability version changes', async () => {
    const adapter = new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF })
    const { registry } = buildRegistry([adapter])
    const binding = await registry.registerSource(
      telemetryInput({ capabilityVersion: '1.0.0' }),
      EDITOR,
    )
    await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    await registry.recordPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: DIGEST_A, roles: ['telemetry'] },
      EDITOR,
    )

    const fresh = await registry.assessPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: DIGEST_A },
      EDITOR,
    )
    expect(fresh.status).toBe('fresh')

    await registry.reviseSource(
      {
        scopeRef: SCOPE_A,
        sourceId: binding.sourceId,
        version: '1.1.0',
        capabilityVersion: '1.1.0',
        mappingRef: mappingRef('telemetry', 'c', '1.1.0'),
      },
      EDITOR,
    )

    const notReady = await registry.assessPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: DIGEST_A },
      EDITOR,
    )
    expect(notReady.status).toBe('stale')
    if (notReady.status !== 'stale') throw new Error('expected a stale preflight')
    expect(notReady.reasons.some((reason) => reason.includes('not ready'))).toBe(true)

    // Even once the source is probed ready again, the recorded preflight still pins the old
    // mapping/capability version, so it stays stale until it is re-recorded.
    await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)
    const stale = await registry.assessPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: DIGEST_A },
      EDITOR,
    )
    expect(stale.status).toBe('stale')
    if (stale.status !== 'stale') throw new Error('expected a stale preflight')
    expect(stale.reasons.some((reason) => reason.includes('capability version'))).toBe(true)
    expect(stale.reasons.some((reason) => reason.includes('mapping version'))).toBe(true)

    const guard = await capture(() =>
      registry.requireFreshPreflight(
        { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: DIGEST_A },
        EDITOR,
      ),
    )
    expect(guard.code).toBe('PREFLIGHT_STALE')
    expect(guard.httpStatus).toBe(409)
  })

  it('treats a missing preflight record as stale and a re-recorded one as fresh', async () => {
    const adapter = new ControlledProbeAdapter({ adapterRef: TELEMETRY_ADAPTER_REF })
    const { registry } = buildRegistry([adapter])
    const binding = await registry.registerSource(telemetryInput(), EDITOR)
    await registry.probeSource({ scopeRef: SCOPE_A, sourceId: binding.sourceId }, EDITOR)

    const missing = await registry.assessPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: DIGEST_B },
      EDITOR,
    )
    expect(missing.status).toBe('stale')

    await registry.recordPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: DIGEST_B, roles: ['telemetry'] },
      EDITOR,
    )
    const fresh = await registry.assessPreflight(
      { scopeRef: SCOPE_A, profileRef: PROFILE_REF, snapshotHash: DIGEST_B },
      EDITOR,
    )
    expect(fresh.status).toBe('fresh')
  })

  it('probes the catalog and documents roles through the same contract', async () => {
    const catalogAdapter = new ControlledProbeAdapter({
      adapterRef: CATALOG_ADAPTER_REF,
      observation: { capabilities: [{ name: 'structured_query', version: '1.0.0' }] },
    })
    const documentsAdapter = new ControlledProbeAdapter({
      adapterRef: DOCUMENTS_ADAPTER_REF,
      observation: {
        capabilities: [{ name: 'document_search', version: '1.0.0' }],
        pagination: { kind: 'opaque_cursor', pagesFetched: 3, exhausted: false },
      },
    })
    const { registry } = buildRegistry([catalogAdapter, documentsAdapter])
    const catalog = await registry.registerSource(
      {
        scopeRef: SCOPE_A,
        kind: 'read_only_origin',
        role: 'catalog',
        adapterRef: CATALOG_ADAPTER_REF,
        secretRef: 'secret://vault/catalog',
        mappingRef: mappingRef('catalog', 'd'),
      },
      EDITOR,
    )
    const documents = await registry.registerSource(
      {
        scopeRef: SCOPE_A,
        kind: 'imported',
        role: 'documents',
        adapterRef: DOCUMENTS_ADAPTER_REF,
        secretRef: 'secret://vault/documents',
        mappingRef: mappingRef('documents', 'e'),
      },
      EDITOR,
    )
    const catalogJob = await registry.probeSource(
      { scopeRef: SCOPE_A, sourceId: catalog.sourceId, capabilities: [capabilityRequirement('structured_query')] },
      EDITOR,
    )
    const documentsJob = await registry.probeSource(
      { scopeRef: SCOPE_A, sourceId: documents.sourceId, capabilities: [capabilityRequirement('document_search')] },
      EDITOR,
    )
    expect(catalogJob.status).toBe('succeeded')
    expect(documentsJob.status).toBe('succeeded')
    expect(documentsJob.capabilities?.[0]?.pagination).toBe('opaque_cursor')
    expect(await registry.listSources(SCOPE_A, EDITOR)).toHaveLength(2)
  })
})
