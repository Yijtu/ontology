import { randomUUID } from 'node:crypto'
import { canonicalJson } from '@ontology/tool-services'
import { sha256DigestOf } from '@ontology/core'
import { InMemoryIndustryManifestSource } from '@ontology/application'
import type { ProfileResolver } from '@ontology/application'
import { DATA_DUCKDB_ADAPTER_REF } from '@ontology/adapter-data-duckdb'
import type { PostgresComponentRegistryStore } from '@ontology/adapter-control-postgres'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { createToolContext, TOOL_CATALOGUE } from '@ontology/contracts'
import type {
  ComponentKind,
  ComponentManifest,
  ComponentRegistrationRecordInput,
  ComponentVersionRecord,
  IndustryManifestSource,
  ModelBinding,
  ProfileRef,
  ProfileSpec,
  ResolvedCapability,
  ResourceRef,
  ScopeRef,
  SourceRef,
  ToolBinding,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { CORE_POLICY_REF, WORKER_RUN_ID } from './core-constants'
import { capability, componentRef } from './core-component-ref'
import { CoreCapabilityError } from './core-errors'
import { sameVersionRef, sourceKey } from './core-composition-shared'
import type { CoreComputeRegistration } from './core-compute-registration'
import type { CoreExampleScenario } from './core-example-loader'
import type { CoreModelComponentRefs } from './core-template-plan-resolver'

/** Component/profile registration and the profile rig the sample deployment mounts. */

export function modelComponentRefsOf(
  env: Readonly<Record<string, string | undefined>>,
  capabilities: { readonly generationEnabled: boolean; readonly decisionEnabled: boolean },
): CoreModelComponentRefs {
  const generationId = env['CORE_COMPANY_MODEL_PLATFORM_ID']
  const decisionId = env['CORE_JEV_PLATFORM_MODEL_ID']
  return {
    ...(capabilities.generationEnabled && generationId !== undefined
      ? { generation: componentRef('generation', generationId, {
          role: 'generation',
          platformModelId: generationId,
          vendorModel: env['CORE_COMPANY_MODEL_VENDOR_MODEL'],
          protocol: env['CORE_COMPANY_MODEL_PROTOCOL'],
        }) }
      : {}),
    ...(capabilities.decisionEnabled && decisionId !== undefined
      ? { decision: componentRef('decision', decisionId, {
          role: 'decision',
          platformModelId: decisionId,
          vendorModel: env['CORE_JEV_VENDOR_MODEL'],
        }) }
      : {}),
  }
}

export function scenarioComponentRecords(
  scenarios: readonly CoreExampleScenario[],
  now: string,
  compute: CoreComputeRegistration,
  modelRefs: CoreModelComponentRefs = {},
): ComponentVersionRecord[] {
  const records = new Map<string, ComponentVersionRecord>()
  const add = (record: ComponentVersionRecord): void => {
    records.set(`${record.manifest.kind}\u0000${record.manifest.id}\u0000${record.manifest.version}`, record)
  }
  for (const scenario of scenarios) {
    const industryRef = componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest)
    add(componentRecord({
      kind: 'industry_pack',
      ref: industryRef,
      capabilityNames: ['industry.semantics'],
      namespace: scenario.namespace,
      entrypoint: 'declarative-industry-manifest',
      now,
    }))
  }
  add(componentRecord({
    kind: 'runtime',
    ref: componentRef('runtime', 'runtime-template', 'template-runtime@1.0.0'),
    capabilityNames: ['agent_runtime'],
    entrypoint: '@ontology/adapter-runtime-template',
    now,
  }))
  // The real Pi Agent Core runtime, registered alongside the Template executor so a profile
  // can pin either. It declares the same `agent_runtime` capability; the resolved profile and
  // the one gateway decide what it may actually do.
  add(componentRecord({
    kind: 'runtime',
    ref: componentRef('runtime', 'runtime-pi', 'pi-runtime@1.0.0'),
    capabilityNames: ['agent_runtime'],
    entrypoint: '@ontology/adapter-runtime-pi',
    now,
  }))
  add(componentRecord({
    kind: 'data_backend',
    ref: DATA_DUCKDB_ADAPTER_REF,
    capabilityNames: ['structured_query'],
    entrypoint: '@ontology/adapter-data-duckdb',
    now,
  }))
  add(componentRecord({
    kind: 'document_backend',
    ref: componentRef('document_backend', 'search-bm25', 'postgres-bm25@1.0.0'),
    capabilityNames: ['document_search'],
    entrypoint: '@ontology/adapter-search-bm25',
    now,
  }))
  for (const entry of compute.operations) {
    add(componentRecord({ kind: 'compute_extension', ref: entry.operation.handlerRef, capabilityNames: ['registered_compute'],
      entrypoint: entry.entrypoint, now }))
  }
  if (modelRefs.generation !== undefined) {
    add(componentRecord({
      kind: 'generation',
      ref: modelRefs.generation,
      capabilityNames: ['model.generation'],
      entrypoint: '@ontology/adapter-model-company',
      now,
    }))
  }
  if (modelRefs.decision !== undefined) {
    add(componentRecord({
      kind: 'decision',
      ref: modelRefs.decision,
      capabilityNames: ['model.decision'],
      entrypoint: '@ontology/adapter-model-jev',
      now,
    }))
  }
  return [...records.values()]
}

export async function registerComponents(
  store: PostgresComponentRegistryStore,
  records: readonly ComponentVersionRecord[],
  compute: CoreComputeRegistration,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  blobs: LocalImmutableBlobStore,
): Promise<void> {
  for (const record of records) {
    const existing = await store.findVersion(
      { kind: record.manifest.kind, id: record.manifest.id, version: record.manifest.version },
      scopeRef,
      ctx,
    )
    if (existing !== undefined) {
      if (existing.manifest.digest !== record.manifest.digest) {
        throw new Error(`a different immutable component is already registered: ${record.manifest.kind}/${record.manifest.id}@${record.manifest.version}`)
      }
      continue
    }
    const entry = record.manifest.kind === 'compute_extension' && record.manifest.entrypointRef.kind === 'package'
      ? compute.operations.find((candidate) => candidate.entrypoint === record.manifest.entrypointRef.ref)
      : undefined
    if (entry !== undefined && !sameVersionRef(record.manifestRef, entry.operation.handlerRef)) throw new CoreCapabilityError('the compute extension does not pin the verified registered build artifact')
    const bytes = entry === undefined ? new TextEncoder().encode(canonicalJson({ schemaVersion: 'core-host-component@1', manifest: record.manifest })) : entry.readArtifact()
    const staged = await blobs.stage(bytes, { scopeRef }, ctx)
    const artifact = await blobs.putImmutable({ scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: entry === undefined ? 'application/vnd.ontology.host-component+json' : entry.artifactMediaType }, ctx)
    await store.insertVersion(scopeRef, componentRegistrationInput(record, record.registeredAt, artifact.blobRef), ctx)
  }
}

export function industrySourceFor(scenarios: readonly CoreExampleScenario[]): IndustryManifestSource {
  return new InMemoryIndustryManifestSource(scenarios.map((scenario) => ({
    ref: componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest),
    manifest: scenario.industryManifest,
  })))
}

export async function registerProfiles(
  resolver: ProfileResolver,
  scenarios: readonly CoreExampleScenario[],
  scopeRef: ScopeRef,
  profileContext: ToolContext,
  profileSpecsByScenario: Readonly<Record<string, ProfileSpec>>,
): Promise<void> {
  for (const scenario of scenarios) {
    const spec = profileSpecsByScenario[scenario.scenarioId]
    if (spec === undefined) throw new Error(`Core profile spec is missing for ${scenario.scenarioId}`)
    await resolver.publish({ scopeRef, profileRef: scenario.profileRef, spec, environment: 'local_dev' }, profileContext)
    const preflight = await resolver.preflight({ scopeRef, profileRef: scenario.profileRef }, profileContext)
    if (preflight.status !== 'resolved' || preflight.resolvedProfile === undefined) {
      const missing = preflight.missingCapabilities?.map((entry) => entry.name).join(', ') ?? ''
      const incompatible = preflight.incompatibleReasons?.join('; ') ?? ''
      throw new Error(`Core profile ${scenario.profileRef.id}@${scenario.profileRef.version} is not runnable: ${missing}${incompatible}`)
    }
    const current = await resolver.getActiveProfile(scopeRef, scenario.profileRef.id, profileContext)
    if (current === undefined) {
      await resolver.activate({
        scopeRef,
        profileRef: scenario.profileRef,
        snapshotHash: preflight.resolvedProfile.snapshotHash,
        expectedRevision: null,
      }, profileContext)
    }
  }
}

/** Project the registered components' declared capabilities into the exact deployment capability set. */
export function resolvedCapabilitiesFrom(records: readonly ComponentVersionRecord[]): ResolvedCapability[] {
  return records.flatMap((record) =>
    record.manifest.provides.map((declared) => ({
      name: declared.name,
      version: declared.version,
      limits: declared.limits,
      consistency: declared.consistency,
      cancellation: declared.cancellation,
      pagination: declared.pagination,
      supportedDataTypes: [...declared.supportedDataTypes],
      sourceComponentRef: record.manifestRef,
    })),
  )
}

export function schemasByScenario(scenarios: readonly CoreExampleScenario[]): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(scenarios.map((scenario) => [
    scenario.scenarioId,
    scenario.industrySchema.objects.flatMap((object) => object.attributes.map((attribute) => `facts:${attribute.attributeId}`)),
  ]))
}

export function componentRecord(input: {
  readonly kind: ComponentKind
  readonly ref: VersionRef
  readonly capabilityNames: readonly string[]
  readonly namespace?: string
  readonly entrypoint: string
  readonly now: string
}): ComponentVersionRecord {
  const manifest: ComponentManifest = {
    kind: input.kind,
    id: input.ref.id,
    version: input.ref.version,
    digest: input.ref.digest,
    contractRange: { min: '0.2.0', max: '1.0.0' },
    provides: input.capabilityNames.map(capability),
    requires: [],
    entrypointRef: { kind: 'package', ref: input.entrypoint },
    trustStatus: 'local_dev',
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
  }
  return { manifestRef: input.ref, manifest, lifecycleState: 'active', registeredAt: input.now }
}

export function profileSpecFor(scenario: CoreExampleScenario, dataBackendRef: VersionRef, compute: CoreComputeRegistration): ProfileSpec {
  const mappingRefs = scenario.physicalMappings.flatMap((loaded) => {
    const firstObject = loaded.mapping.objects[0]
    if (firstObject === undefined) return []
    return [{ ...loaded.ref, role: 'catalog' as const, sourceObjectRef: firstObject.sourceObjectRef }]
  })
  const firstMapping = mappingRefs[0]
  if (firstMapping === undefined) throw new Error(`scenario ${scenario.scenarioId} has no physical mapping`)
  return {
    industryRef: componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest),
    mappingRefs,
    runtimeRef: componentRef('runtime', 'runtime-template', 'template-runtime@1.0.0'),
    backendBindings: {
      catalog: {
        role: 'catalog',
        adapterRef: dataBackendRef,
        mappingRef: firstMapping.id,
      },
    },
    modelBindings: {},
    // The four public tools: published facts/rules read through ontology_lookup, structured
    // query and registered compute through data_query, and document Q&A through
    // document_search. `web_search` stays disabled unless a deployment explicitly enables it.
    toolBindings: TOOL_CATALOGUE.map((tool) => ({
      toolId: tool.toolId,
      enabled: tool.toolId === 'ontology_lookup' || tool.toolId === 'data_query' || tool.toolId === 'document_search',
      ...(tool.toolId === 'ontology_lookup' ? { maxCallsPerRun: 4 } : {}),
    })),
    computeBindings: [...compute.profileBindings],
    policyRef: CORE_POLICY_REF,
  }
}

export function componentRegistrationInput(record: ComponentVersionRecord, now: string, artifactRef: ResourceRef): ComponentRegistrationRecordInput {
  return {
    record,
    artifactRef,
    audit: {
      fromState: null,
      toState: 'active',
      digest: record.manifest.digest,
      payloadDigest: sha256DigestOf(canonicalJson(record.manifest)),
      idempotencyKey: `core-host-register:${record.manifest.kind}:${record.manifest.id}:${record.manifest.version}`,
      occurredAt: now,
      actor: 'core-local-host',
    },
  }
}

/**
 * The public data tools a workspace-research run may call (design §5/§8). `web_search` is enabled
 * (the actual provider is pinned per run from the catalogue), `document_search`/`ontology_lookup`
 * let the agent read authorized material and existing definitions. `data_query` stays disabled:
 * a research run has no project mapping or backend. This is a *declared* surface; the gateway and
 * the run's pinned execution bindings still authorize every call.
 */
export function researchToolBindings(): ToolBinding[] {
  return TOOL_CATALOGUE.map((tool) => ({
    toolId: tool.toolId,
    enabled: tool.toolId === 'ontology_lookup' || tool.toolId === 'document_search' || tool.toolId === 'web_search',
    ...(tool.toolId === 'ontology_lookup' ? { maxCallsPerRun: 4 } : {}),
  }))
}

export function profileModelBindingEnabled(  binding: ModelBinding | undefined,
  availableRef: VersionRef | undefined,
): boolean {
  return binding?.enabled === true && availableRef !== undefined && sameVersionRef(binding.modelRef, availableRef)
}

export function scenarioForIndustryRef(
  scenarios: readonly CoreExampleScenario[],
  industryRef: VersionRef,
): CoreExampleScenario | undefined {
  return scenarios.find((scenario) => sameVersionRef(
    industryRef,
    componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest),
  ))
}

export async function resolveScenarioProfile(
  profiles: ProfileResolver,
  scenarios: readonly CoreExampleScenario[],
  profileRef: ProfileRef,
  scopeRef: ScopeRef,
  ctx: ToolContext,
  resolvedProfileHash?: string,
) {
  const snapshotHash = resolvedProfileHash ?? (await profiles.bindRunProfile(profileRef, scopeRef, ctx)).resolvedProfileHash
  const resolvedRecord = await profiles.getResolvedProfile({ scopeRef, profileRef, snapshotHash }, ctx)
  const scenario = scenarioForIndustryRef(scenarios, resolvedRecord.resolved.industryRef)
  if (scenario === undefined) throw new CoreCapabilityError('the profile pins an industry package not mounted by this Core deployment')
  return { scenario, resolved: resolvedRecord.resolved, snapshotHash: resolvedRecord.snapshotHash }
}

export function workerContext(
  scopeRef: ScopeRef,
  sourceRefs: readonly SourceRef[] = [],
  runId = WORKER_RUN_ID,
  resolvedProfileHash = sha256DigestOf('core-worker-profile'),
  clock: () => Date = () => new Date(),
  collectionRefs: readonly string[] = [],
): ToolContext {
  const now = clock()
  const deadline = new Date(now.getTime() + 5 * 60_000)
  return createToolContext({
    principal: {
      tenantId: scopeRef.tenantId,
      subjectId: 'core-local-worker',
      roles: ['platform-admin', 'operator', 'run-controller', 'semantic-publisher', 'semantic-reviewer'],
      scopes: [],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash,
    policyVersion: '0.2.0',
    deadline: deadline.toISOString(),
    budgetReservation: {
      reservationId: randomUUID(),
      runId,
      grantedAt: now.toISOString(),
      expiresAt: deadline.toISOString(),
    },
    allowedResources: {
      tenantId: scopeRef.tenantId,
      spaceId: scopeRef.spaceId,
      resourceKinds: ['artifact', 'document', 'chunk', 'evidence', 'dataset', 'plan', 'job'],
      sourceRefs: sourceRefs.map((sourceRef) => ({ ...sourceRef })),
      collectionRefs: [...collectionRefs],
      domains: [],
      maxRows: 1_000,
    },
    traceId: `core-worker:${randomUUID()}`,
  })
}

/** Every distinct raw source a scenario mounts, de-duplicated by namespace/sourceId. */
export function sourceRefsOf(scenario: CoreExampleScenario): SourceRef[] {
  const refs = [
    ...scenario.rawSources.map((source) => source.sourceRef),
    scenario.syntheticPolicy.sourceRef,
    ...scenario.physicalMappings.flatMap((mapping) => mapping.mapping.objects.map((object) => object.sourceObjectRef.sourceRef)),
  ]
  return [...new Map(refs.map((ref) => [sourceKey(ref), ref])).values()]
}
