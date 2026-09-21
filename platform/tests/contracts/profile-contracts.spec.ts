import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import type Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import {
  findEmbeddedSecretViolations,
  preflightProfile,
  type Capability,
  type ComponentManifest,
  type ComponentVersionRecord,
  type IndustryManifest,
  type ProfileSpec,
  type ResolvedCapability,
} from '@ontology/contracts'
import { createAjv, expectInvalid, expectValid, platformRoot, readFixture, validator } from './helpers'

let ajv: Ajv2020
const v = (defName: string): ValidateFunction => validator(ajv, 'industry.schema.json', defName)

const DIGEST = `sha256:${'b'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'c'.repeat(64)}`

const industryManifest = (): IndustryManifest =>
  readFixture('industry-pack.home-energy.json') as IndustryManifest

const capability = (
  name: string,
  version: string,
  sourceComponentRef: ComponentVersionRecord['manifestRef'],
): ResolvedCapability => ({
  name,
  version,
  limits: { maxRows: 100, maxBytes: 1024, maxDurationMs: 1000 },
  consistency: 'repeatable_read',
  cancellation: 'supported',
  pagination: 'cursor',
  supportedDataTypes: ['string', 'integer'],
  sourceComponentRef,
})

const providedCapability = (name: string, version: string): Capability => ({
  name,
  version,
  limits: { maxRows: 100, maxBytes: 1024, maxDurationMs: 1000 },
  consistency: 'repeatable_read',
  cancellation: 'supported',
  pagination: 'cursor',
  supportedDataTypes: ['string'],
})

const component = (
  id: string,
  version: string,
  lifecycleState: ComponentVersionRecord['lifecycleState'],
  capabilityNames: readonly string[],
): ComponentVersionRecord => {
  const manifest: ComponentManifest = {
    kind: 'data_backend',
    id,
    version,
    digest: DIGEST,
    contractRange: { min: '1.0.0', max: '2.0.0' },
    provides: capabilityNames.map((name) => providedCapability(name, version)),
    requires: [],
    entrypointRef: { kind: 'package', ref: id },
    trustStatus: 'local_dev',
  }
  return {
    manifestRef: { id, version, digest: DIGEST },
    manifest,
    lifecycleState,
    registeredAt: '2026-09-21T00:00:00Z',
  }
}

const profile = (): ProfileSpec => ({
  industryRef: { id: 'home-energy', version: '0.1.0', digest: DIGEST },
  mappingRefs: [
    {
      id: 'home-energy.mapping.ha-anker',
      version: '1.0.0',
      digest: DIGEST,
      role: 'telemetry',
      sourceObjectRef: {
        sourceRef: { namespace: 'ha-anker', sourceId: 'sensor.battery_soc' },
        objectPath: 'states.sensor_battery_soc',
      },
    },
    {
      id: 'home-energy.mapping.catalog',
      version: '1.0.0',
      digest: DIGEST,
      role: 'catalog',
      sourceObjectRef: {
        sourceRef: { namespace: 'control-postgres', sourceId: 'public.device_catalog' },
        objectPath: 'public.device_catalog',
      },
    },
    {
      id: 'home-energy.mapping.documents',
      version: '1.0.0',
      digest: DIGEST,
      role: 'documents',
      sourceObjectRef: {
        sourceRef: { namespace: 'control-postgres', sourceId: 'public.documents' },
        objectPath: 'public.documents',
      },
    },
  ],
  runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
  backendBindings: {
    catalog: {
      role: 'catalog',
      adapterRef: { id: 'data-postgres', version: '1.0.0', digest: DIGEST },
      mappingRef: 'home-energy.mapping.catalog',
    },
    documents: {
      role: 'documents',
      adapterRef: { id: 'search-bm25', version: '1.0.0', digest: DIGEST },
      mappingRef: 'home-energy.mapping.documents',
    },
    telemetry: {
      role: 'telemetry',
      adapterRef: { id: 'data-duckdb', version: '1.0.0', digest: DIGEST },
      mappingRef: 'home-energy.mapping.ha-anker',
    },
  },
  modelBindings: {
    generation: {
      role: 'generation',
      modelRef: { id: 'company-llm', version: '1.0.0', digest: DIGEST },
      fallbackPolicy: 'reject',
      enabled: true,
    },
    decision: {
      role: 'decision',
      modelRef: { id: 'company-jev', version: '1.0.0', digest: DIGEST },
      fallbackPolicy: 'deterministic',
      enabled: false,
    },
  },
  toolBindings: [
    { toolId: 'ontology_lookup', enabled: true },
    { toolId: 'data_query', enabled: true, maxCallsPerRun: 8 },
    { toolId: 'document_search', enabled: true },
    { toolId: 'web_search', enabled: false },
  ],
  computeBindings: [
    {
      operationRef: { id: 'home-energy.plan', version: '1' },
      handlerRef: { id: 'extension-home-energy', version: '1.0.0', digest: DIGEST },
      inputSchemaRef: { id: 'home-energy.plan.input', version: '1.0.0', digest: DIGEST },
      outputSchemaRef: { id: 'home-energy.plan.output', version: '1.0.0', digest: DIGEST },
      readOnly: true,
      enabled: true,
      limits: { maxRows: 96, maxBytes: 1048576, maxDurationMs: 2000, maxConcurrency: 1 },
    },
    {
      operationRef: { id: 'home-energy.simulate', version: '1' },
      handlerRef: { id: 'extension-home-energy', version: '1.0.0', digest: DIGEST },
      inputSchemaRef: { id: 'home-energy.simulate.input', version: '1.0.0', digest: DIGEST },
      outputSchemaRef: { id: 'home-energy.simulate.output', version: '1.0.0', digest: DIGEST },
      readOnly: true,
      enabled: true,
      limits: { maxRows: 96, maxBytes: 1048576, maxDurationMs: 2000, maxConcurrency: 1 },
    },
  ],
  policyRef: { id: 'policy-default', version: '1.0.0', digest: DIGEST },
})

const cloneProfile = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(profile())) as Record<string, unknown>

const availableCapabilities = (): ResolvedCapability[] => [
  capability('structured_query', '1.2.0', { id: 'data-postgres', version: '1.2.0', digest: OTHER_DIGEST }),
  capability('document_search', '1.0.0', { id: 'search-bm25', version: '1.0.0', digest: OTHER_DIGEST }),
  capability('telemetry_read', '1.5.0', { id: 'data-duckdb', version: '1.5.0', digest: OTHER_DIGEST }),
  capability('compute.home-energy.plan', '1.0.0', {
    id: 'extension-home-energy',
    version: '1.0.0',
    digest: OTHER_DIGEST,
  }),
]

const components = (): ComponentVersionRecord[] => [
  component('data-postgres', '1.2.0', 'active', ['structured_query']),
  component('search-bm25', '1.0.0', 'active', ['document_search']),
  component('data-duckdb', '1.5.0', 'active', ['telemetry_read']),
  component('extension-home-energy', '1.0.0', 'active', ['compute.home-energy.plan']),
]

const preflight = (overrides: {
  readonly profile?: ProfileSpec
  readonly manifest?: IndustryManifest
  readonly capabilities?: readonly ResolvedCapability[]
  readonly components?: readonly ComponentVersionRecord[]
} = {}) =>
  preflightProfile({
    profileRef: { id: 'home-energy-demo', version: '1.0.0' },
    profile: overrides.profile ?? profile(),
    industryManifest: overrides.manifest ?? industryManifest(),
    components: overrides.components ?? components(),
    availableCapabilities: overrides.capabilities ?? availableCapabilities(),
    outputVersion: '1.0.0',
    outputDigest: DIGEST,
    snapshotHash: OTHER_DIGEST,
    checkedAt: '2026-09-21T00:00:00Z',
    resolvedAt: '2026-09-21T00:00:00Z',
  })

beforeAll(() => {
  ajv = createAjv()
})

describe('ProfileSpec binds every capability kind by reference (US-002, FR-2, FR-3)', () => {
  it('accepts one profile binding SQL, documents, telemetry, model, runtime and compute at once', () => {
    const spec = profile()
    expectValid(v('ProfileSpec'), spec, 'five-kind profile')
    expect(Object.keys(spec.backendBindings).sort()).toEqual(['catalog', 'documents', 'telemetry'])
    expect(Object.keys(spec.modelBindings).sort()).toEqual(['decision', 'generation'])
    expect(spec.runtimeRef.id).toBe('runtime-template')
    expect(spec.computeBindings).toHaveLength(2)
  })

  it('stores references only: no secret or URL appears anywhere in the profile', () => {
    expect(findEmbeddedSecretViolations(profile())).toEqual([])
  })

  it('rejects a profile that drops a required binding', () => {
    for (const field of [
      'industryRef',
      'mappingRefs',
      'runtimeRef',
      'backendBindings',
      'modelBindings',
      'toolBindings',
      'computeBindings',
      'policyRef',
    ]) {
      const spec = cloneProfile()
      delete spec[field]
      expectInvalid(v('ProfileSpec'), spec, `missing ${field}`)
    }
    expectInvalid(v('ProfileSpec'), { ...cloneProfile(), mappingRefs: [] }, 'empty mapping refs')
  })

  it('rejects a secret or an unknown field smuggled into the profile', () => {
    expectInvalid(
      v('ProfileSpec'),
      { ...cloneProfile(), credentials: { password: 'p' } },
      'inline credential',
    )
    expectInvalid(v('ProfileSpec'), { ...cloneProfile(), secretRef: 'vault://x' }, 'unknown secret ref field')
  })

  it('rejects a backend binding keyed by anything other than a logical role', () => {
    const spec = cloneProfile()
    spec.backendBindings = {
      'postgres://user@host/db': {
        role: 'catalog',
        adapterRef: { id: 'data-postgres', version: '1.0.0', digest: DIGEST },
      },
    }
    expectInvalid(v('ProfileSpec'), spec, 'URL used as a logical role')
  })

  it('rejects physical addressing inside a backend binding', () => {
    for (const extra of ['url', 'table', 'column', 'objectPath']) {
      const spec = cloneProfile()
      spec.backendBindings = {
        catalog: {
          role: 'catalog',
          adapterRef: { id: 'data-postgres', version: '1.0.0', digest: DIGEST },
          [extra]: 'public.device_catalog',
        },
      }
      expectInvalid(v('ProfileSpec'), spec, `backend binding with ${extra}`)
    }
  })

  it('pins the exact model version and rejects an unpinned or unknown model binding', () => {
    const noModel = cloneProfile()
    delete noModel.modelBindings
    expectInvalid(v('ProfileSpec'), noModel, 'missing model bindings')

    const unpinned = cloneProfile()
    unpinned.modelBindings = {
      generation: { role: 'generation', modelRef: { id: 'company-llm' }, fallbackPolicy: 'reject', enabled: true },
    }
    expectInvalid(v('ProfileSpec'), unpinned, 'model ref without version or digest')

    const unknownFallback = cloneProfile()
    unknownFallback.modelBindings = {
      generation: {
        role: 'generation',
        modelRef: { id: 'company-llm', version: '1.0.0', digest: DIGEST },
        fallbackPolicy: 'pretend_calibrated',
        enabled: true,
      },
    }
    expectInvalid(v('ProfileSpec'), unknownFallback, 'unknown fallback policy')
  })

  it('binds a declared operation to a trusted handler and rejects a package path', () => {
    const spec = cloneProfile()
    spec.computeBindings = [
      {
        operationRef: { id: 'home-energy.plan', version: '1' },
        handlerRef: { id: 'extension-home-energy', version: '1.0.0', digest: DIGEST },
        inputSchemaRef: { id: 'in', version: '1.0.0', digest: DIGEST },
        outputSchemaRef: { id: 'out', version: '1.0.0', digest: DIGEST },
        readOnly: true,
        enabled: true,
        limits: { maxRows: 1, maxBytes: 1, maxDurationMs: 1 },
      },
    ]
    expectValid(v('ProfileSpec'), spec, 'registered operation binding')

    for (const extra of ['packagePath', 'handler', 'module', 'code', 'eval']) {
      const leaked = cloneProfile()
      leaked.computeBindings = [
        {
          operationRef: { id: 'home-energy.plan', version: '1' },
          handlerRef: { id: 'extension-home-energy', version: '1.0.0', digest: DIGEST },
          inputSchemaRef: { id: 'in', version: '1.0.0', digest: DIGEST },
          outputSchemaRef: { id: 'out', version: '1.0.0', digest: DIGEST },
          readOnly: true,
          enabled: true,
          limits: { maxRows: 1, maxBytes: 1, maxDurationMs: 1 },
          [extra]: '../../home-energy/src/index.ts',
        },
      ]
      expectInvalid(v('ProfileSpec'), leaked, `compute binding with ${extra}`)
    }

    const writable = cloneProfile()
    writable.computeBindings = [
      {
        operationRef: { id: 'home-energy.plan', version: '1' },
        handlerRef: { id: 'extension-home-energy', version: '1.0.0', digest: DIGEST },
        inputSchemaRef: { id: 'in', version: '1.0.0', digest: DIGEST },
        outputSchemaRef: { id: 'out', version: '1.0.0', digest: DIGEST },
        readOnly: false,
        enabled: true,
        limits: { maxRows: 1, maxBytes: 1, maxDurationMs: 1 },
      },
    ]
    expectInvalid(v('ProfileSpec'), writable, 'compute binding that is not read-only')
  })
})

describe('preflight produces a resolved profile or explicit gaps (C1)', () => {
  it('resolves every required capability to an exact version and never drops one', () => {
    const result = preflight()
    expect(result.status).toBe('resolved')
    expect(result.resolvedProfile).toBeDefined()
    const resolved = result.resolvedProfile
    if (resolved === undefined) throw new Error('expected a resolved profile')
    expect(resolved.resolvedCapabilities).toHaveLength(industryManifest().requiredCapabilities.length)
    expect(resolved.explicitDegradations).toEqual([])
    expect(resolved.resolvedVersions.some((ref) => ref.id === 'runtime-template')).toBe(true)
    expectValid(v('ResolvedProfile'), resolved, 'resolved profile')
  })

  it('reports a missing required capability instead of silently intersecting it away', () => {
    const capabilities = availableCapabilities().filter((entry) => entry.name !== 'telemetry_read')
    const result = preflight({ capabilities })
    expect(result.status).toBe('missing_capabilities')
    expect(result.missingCapabilities?.map((entry) => entry.name)).toEqual(['telemetry_read'])
    expect(result.resolvedProfile).toBeUndefined()
  })

  it('rejects an inverted contract range instead of resolving it as empty', () => {
    const manifest: IndustryManifest = {
      ...industryManifest(),
      requiredCapabilities: [
        { name: 'structured_query', versionRange: { min: '2.0.0', max: '1.0.0' } },
      ],
    }
    const result = preflight({ manifest })
    expect(result.status).toBe('incompatible')
    expect(result.incompatibleReasons?.some((reason) => reason.includes('invalid contract range'))).toBe(true)
  })

  it('refuses to activate a bound version that is already retired', () => {
    const retired = component('runtime-template', '1.0.0', 'retired', ['agent_runtime'])
    const result = preflight({ components: [...components(), retired] })
    expect(result.status).toBe('incompatible')
    expect(result.incompatibleReasons?.some((reason) => reason.includes('retired'))).toBe(true)
  })

  it('refuses a binding whose key disagrees with its declared role', () => {
    const spec: ProfileSpec = {
      ...profile(),
      backendBindings: {
        ...profile().backendBindings,
        catalog: {
          role: 'telemetry',
          adapterRef: { id: 'data-postgres', version: '1.0.0', digest: DIGEST },
        },
      },
    }
    const result = preflight({ profile: spec })
    expect(result.status).toBe('incompatible')
    expect(
      result.incompatibleReasons?.some((reason) => reason.includes('does not match declared role')),
    ).toBe(true)
  })

  it('refuses a backend role that has no mapping ref', () => {
    const spec: ProfileSpec = {
      ...profile(),
      mappingRefs: profile().mappingRefs.filter((mapping) => mapping.role !== 'documents'),
    }
    const result = preflight({ profile: spec })
    expect(result.status).toBe('incompatible')
    expect(result.incompatibleReasons?.some((reason) => reason.includes('documents'))).toBe(true)
  })

  it('refuses a declared operation with no enabled compute binding', () => {
    const spec: ProfileSpec = {
      ...profile(),
      computeBindings: profile().computeBindings.map((binding) => ({ ...binding, enabled: false })),
    }
    const result = preflight({ profile: spec })
    expect(result.status).toBe('incompatible')
    expect(result.incompatibleReasons?.some((reason) => reason.includes('no enabled compute binding'))).toBe(true)
  })
})

describe('deployment-profiles/ (SPEC 2.2)', () => {
  const profileDir = join(platformRoot, 'deployment-profiles')
  const files = readdirSync(profileDir).filter((name) => name.endsWith('.json'))

  it('ships at least one profile and every file validates as a DeploymentProfile', () => {
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const document = JSON.parse(readFileSync(join(profileDir, file), 'utf8')) as unknown
      expectValid(v('DeploymentProfile'), document, file)
    }
  })

  it('binds SQL, documents, model, runtime and compute for each profile and stays refs-only', () => {
    for (const file of files) {
      const document = JSON.parse(readFileSync(join(profileDir, file), 'utf8')) as {
        environment: string
        spec: ProfileSpec
      }
      expect(['local_dev', 'ci', 'staging', 'production'], file).toContain(document.environment)
      expect(Object.keys(document.spec.backendBindings).sort(), file).toEqual([
        'catalog',
        'documents',
        'telemetry',
      ])
      expect(Object.keys(document.spec.modelBindings), file).toContain('generation')
      expect(document.spec.runtimeRef.id.length, file).toBeGreaterThan(0)
      expect(document.spec.computeBindings.length, file).toBeGreaterThan(0)
      expect(findEmbeddedSecretViolations(document), file).toEqual([])
    }
  })
})
