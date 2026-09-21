import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  Capability,
  ComponentKind,
  ComponentRegistrationRecordInput,
  ComponentRegistryStore,
  ComponentVersionRecord,
  IndustryManifest,
  MappingRef,
  ProfileSpec,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type { ComponentLifecycleAudit } from '@ontology/contracts'
import type { ProfileSpecValidator } from '@ontology/application'
import { createAjv, validator } from '../contracts/helpers'

export {
  TENANT_A,
  TENANT_B,
  SPACE_A,
  SPACE_B,
  RUN_A,
  fixedClock,
  toolContext,
} from './component-registry-fixtures'

export const SCOPE_A: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
export const SCOPE_B: ScopeRef = {
  tenantId: '22222222-2222-4222-8222-222222222222',
  spaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
}

function digestOf(seed: string): string {
  const code = seed.codePointAt(0) ?? 97
  return `sha256:${((code % 16).toString(16)).repeat(64)}`
}

export const INDUSTRY_REF: VersionRef = {
  id: 'home-energy',
  version: '0.1.0',
  digest: digestOf('a'),
}

export const RUNTIME_REF: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: digestOf('b') }
export const POLICY_REF: VersionRef = { id: 'policy-default', version: '1.0.0', digest: digestOf('c') }
export const GENERATION_MODEL_REF: VersionRef = {
  id: 'company-llm',
  version: '1.0.0',
  digest: digestOf('d'),
}
export const DECISION_MODEL_REF: VersionRef = {
  id: 'company-jev',
  version: '1.0.0',
  digest: digestOf('e'),
}
export const COMPUTE_HANDLER_REF: VersionRef = {
  id: 'extension-home-energy',
  version: '1.0.0',
  digest: digestOf('f'),
}

export const BACKEND_REFS: Readonly<Record<'catalog' | 'documents' | 'telemetry', VersionRef>> = {
  catalog: { id: 'data-postgres', version: '1.0.0', digest: digestOf('1') },
  documents: { id: 'search-bm25', version: '1.0.0', digest: digestOf('2') },
  telemetry: { id: 'data-duckdb', version: '1.0.0', digest: digestOf('3') },
}

export function homeEnergyIndustryManifest(): IndustryManifest {
  const path = fileURLToPath(
    new URL('../contracts/fixtures/industry-pack.home-energy.json', import.meta.url),
  )
  return JSON.parse(readFileSync(path, 'utf8')) as IndustryManifest
}

/**
 * The canonical ProfileSpec validator, built from the same schema bundle the platform
 * publishes. The resolver receives it by injection and never imports a schema library.
 */
export function canonicalProfileValidator(): ProfileSpecValidator {
  const ajv = createAjv()
  const validate = validator(ajv, 'industry.schema.json', 'ProfileSpec')
  return (spec: unknown) => {
    if (validate(spec)) return { valid: true, issues: [] }
    return {
      valid: false,
      issues: (validate.errors ?? []).map((error) => ({
        pointer: error.instancePath === '' ? '$' : error.instancePath,
        message: error.message ?? 'invalid',
      })),
    }
  }
}

function capability(name: string, version: string): Capability {
  return {
    name,
    version,
    limits: { maxRows: 100, maxBytes: 1024, maxDurationMs: 1000 },
    consistency: 'repeatable_read',
    cancellation: 'supported',
    pagination: 'cursor',
    supportedDataTypes: ['string', 'integer'],
  }
}

export function componentRecord(input: {
  readonly kind: ComponentKind
  readonly id: string
  readonly version: string
  readonly digest: string
  readonly provides: readonly { readonly name: string; readonly version: string }[]
  readonly lifecycleState?: ComponentVersionRecord['lifecycleState']
  readonly trustStatus?: ComponentVersionRecord['manifest']['trustStatus']
}): ComponentVersionRecord {
  return {
    manifestRef: { id: input.id, version: input.version, digest: input.digest },
    manifest: {
      kind: input.kind,
      id: input.id,
      version: input.version,
      digest: input.digest,
      contractRange: { min: '1.0.0', max: '2.0.0' },
      provides: input.provides.map((entry) => capability(entry.name, entry.version)),
      requires: [],
      entrypointRef: { kind: 'package', ref: input.id },
      trustStatus: input.trustStatus ?? 'local_dev',
    },
    lifecycleState: input.lifecycleState ?? 'active',
    registeredAt: '2026-09-21T00:00:00Z',
  }
}

export function registeredComponents(): ComponentVersionRecord[] {
  return [
    componentRecord({
      kind: 'data_backend',
      id: 'data-postgres',
      version: '1.0.0',
      digest: BACKEND_REFS.catalog.digest,
      provides: [{ name: 'structured_query', version: '1.0.0' }],
    }),
    componentRecord({
      kind: 'document_backend',
      id: 'search-bm25',
      version: '1.0.0',
      digest: BACKEND_REFS.documents.digest,
      provides: [{ name: 'document_search', version: '1.0.0' }],
    }),
    componentRecord({
      kind: 'data_backend',
      id: 'data-duckdb',
      version: '1.0.0',
      digest: BACKEND_REFS.telemetry.digest,
      provides: [{ name: 'telemetry_read', version: '1.0.0' }],
    }),
    componentRecord({
      kind: 'compute_extension',
      id: 'extension-home-energy',
      version: '1.0.0',
      digest: COMPUTE_HANDLER_REF.digest,
      provides: [{ name: 'compute.home-energy.plan', version: '1.0.0' }],
    }),
    componentRecord({
      kind: 'runtime',
      id: 'runtime-template',
      version: '1.0.0',
      digest: RUNTIME_REF.digest,
      provides: [{ name: 'agent_runtime', version: '1.0.0' }],
    }),
    componentRecord({
      kind: 'generation',
      id: 'company-llm',
      version: '1.0.0',
      digest: GENERATION_MODEL_REF.digest,
      provides: [{ name: 'generation.text', version: '1.0.0' }],
    }),
  ]
}

const MAPPING_REFS: MappingRef[] = [
  {
    id: 'home-energy.mapping.ha-anker',
    version: '1.0.0',
    digest: digestOf('4'),
    role: 'telemetry',
    sourceObjectRef: {
      sourceRef: { namespace: 'ha-anker', sourceId: 'sensor.battery_soc' },
      objectPath: 'states.sensor_battery_soc',
    },
  },
  {
    id: 'home-energy.mapping.catalog',
    version: '1.0.0',
    digest: digestOf('5'),
    role: 'catalog',
    sourceObjectRef: {
      sourceRef: { namespace: 'control-postgres', sourceId: 'public.device_catalog' },
      objectPath: 'public.device_catalog',
    },
  },
  {
    id: 'home-energy.mapping.documents',
    version: '1.0.0',
    digest: digestOf('6'),
    role: 'documents',
    sourceObjectRef: {
      sourceRef: { namespace: 'control-postgres', sourceId: 'public.documents' },
      objectPath: 'public.documents',
    },
  },
]

export function sampleProfileSpec(overrides?: Partial<ProfileSpec>): ProfileSpec {
  const base: ProfileSpec = {
    industryRef: INDUSTRY_REF,
    mappingRefs: MAPPING_REFS,
    runtimeRef: RUNTIME_REF,
    backendBindings: {
      catalog: {
        role: 'catalog',
        adapterRef: BACKEND_REFS.catalog,
        mappingRef: 'home-energy.mapping.catalog',
      },
      documents: {
        role: 'documents',
        adapterRef: BACKEND_REFS.documents,
        mappingRef: 'home-energy.mapping.documents',
      },
      telemetry: {
        role: 'telemetry',
        adapterRef: BACKEND_REFS.telemetry,
        mappingRef: 'home-energy.mapping.ha-anker',
      },
    },
    modelBindings: {
      generation: {
        role: 'generation',
        modelRef: GENERATION_MODEL_REF,
        fallbackPolicy: 'reject',
        enabled: true,
      },
      decision: {
        role: 'decision',
        modelRef: DECISION_MODEL_REF,
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
        handlerRef: COMPUTE_HANDLER_REF,
        inputSchemaRef: { id: 'home-energy.plan.input', version: '1.0.0', digest: digestOf('7') },
        outputSchemaRef: { id: 'home-energy.plan.output', version: '1.0.0', digest: digestOf('8') },
        readOnly: true,
        enabled: true,
        limits: { maxRows: 96, maxBytes: 1048576, maxDurationMs: 2000, maxConcurrency: 1 },
      },
      {
        operationRef: { id: 'home-energy.simulate', version: '1' },
        handlerRef: COMPUTE_HANDLER_REF,
        inputSchemaRef: { id: 'home-energy.simulate.input', version: '1.0.0', digest: digestOf('9') },
        outputSchemaRef: { id: 'home-energy.simulate.output', version: '1.0.0', digest: digestOf('a') },
        readOnly: true,
        enabled: true,
        limits: { maxRows: 96, maxBytes: 1048576, maxDurationMs: 2000, maxConcurrency: 1 },
      },
    ],
    policyRef: POLICY_REF,
  }
  return { ...base, ...overrides }
}

export function lifecycleAudit(record: ComponentVersionRecord, actor = 'seed'): ComponentLifecycleAudit {
  return {
    fromState: null,
    toState: record.lifecycleState,
    digest: record.manifestRef.digest,
    payloadDigest: `sha256:${'0'.repeat(64)}`,
    idempotencyKey: `seed:${record.manifest.kind}:${record.manifestRef.id}:${record.manifestRef.version}`,
    occurredAt: record.registeredAt,
    actor,
  }
}

/** Seed the component registry projection directly, as a real deployment would before composition. */
export async function seedComponents(
  store: ComponentRegistryStore,
  records: readonly ComponentVersionRecord[],
  scopeRef: ScopeRef,
  ctx: ToolContext,
): Promise<void> {
  for (const record of records) {
    const input: ComponentRegistrationRecordInput = {
      record,
      artifactRef: {
        id: `${record.manifestRef.id}-artifact`,
        version: record.manifestRef.version,
        digest: record.manifestRef.digest,
        kind: 'artifact',
      },
      audit: lifecycleAudit(record),
    }
    await store.insertVersion(scopeRef, input, ctx)
  }
}
