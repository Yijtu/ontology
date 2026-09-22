import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  resourceKindForPurpose,
} from '@ontology/adapter-blob-local'
import type {
  ArtifactBlobRecord,
  ArtifactReferenceRecord,
  ArtifactReferenceView,
  ArtifactRegistry,
  BlobScope,
  RecordArtifactReferenceInput,
  RecordArtifactReferenceResult,
} from '@ontology/adapter-blob-local'
import {
  createApiServer,
  createBlobArtifactWriter,
  createEnergySimulationSurface,
  createScopedBlobReader,
  createSimulationExecutionSurface,
  RunProgressService,
} from '@ontology/app-api'
import type {
  AnswerReader,
  AuthenticatedRequest,
  EvidenceReadSurface,
  ExecutionSurface,
  HistoryReadSurface,
  SimulationSurface,
} from '@ontology/app-api'
import {
  InMemoryComponentRegistryStore,
  InMemoryIndustryManifestSource,
  InMemoryProfileStore,
  InMemoryRunStore,
  InMemorySourceStore,
  InMemoryWorkflowStore,
  ProfileResolver,
  RunService,
  SourceRegistry,
} from '@ontology/application'
import type {
  CreateRunInput,
  CreateRunResult,
  ProfileSpecValidator,
  RunProfileBinder,
  RunProfileBinding,
  RunServiceDependencies,
} from '@ontology/application'
import { BudgetService, InMemoryBudgetLedgerStore } from '@ontology/core'
import { SCHEMA_DOCUMENTS, SecretValue, createToolContext } from '@ontology/contracts'
import type {
  Capability,
  ComponentKind,
  ComponentRegistrationRecordInput,
  ComponentRegistryStore,
  ComponentVersionRecord,
  ControlAppendEventRequest,
  ControlAppendEventResponse,
  ControlRepository,
  IndustryManifest,
  LogicalRole,
  MappingRef,
  OperationRegistry,
  ProfileRef,
  ProfileSpec,
  ProjectionState,
  PublishedAnswer,
  ResourceRef,
  RevisionString,
  RunState,
  ScopeRef,
  SecretResolver,
  SourceProbeAdapter,
  SourceProbeAdapterResolver,
  SourceProbeObservation,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { ENERGY_OPERATION_REGISTRY, createEnergyComputeHandlers } from '@ontology/extension-home-energy'
import type { SimulationJobPort } from '@ontology/extension-home-energy'
import { WorkbenchClient } from '@ontology/app-web/client'
import type { RunEventStreamFactory } from '@ontology/app-web/client'

/**
 * Shared workbench fixture. It builds a real Fastify API over in-memory stores so both the
 * jsdom component tests and the browser E2E test drive the actual HTTP surface — not a
 * hand-written fake — and it never imports a server test helper that needs `import.meta.url`
 * file resolution (the jsdom environment rewrites it to an http URL).
 */

export const SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}
export const PROFILE: ProfileRef = { id: 'home-energy-demo', version: '1.0.0' }
export const PROFILE_V2: ProfileRef = { id: 'home-energy-demo', version: '1.1.0' }
export const SENTINEL_SECRET = 'super-secret-token-DO-NOT-LEAK-3f9a'
export const ALL_ROLES = 'platform-admin,profile-editor,data-editor,business-user,scoped-reader'

function digest(seed: string): string {
  const code = seed.codePointAt(0) ?? 97
  return `sha256:${((code % 16).toString(16)).repeat(64)}`
}

export const INDUSTRY_REF: VersionRef = { id: 'home-energy', version: '0.1.0', digest: digest('a') }
export const RUNTIME_REF: VersionRef = { id: 'runtime-template', version: '1.0.0', digest: digest('b') }
export const POLICY_REF: VersionRef = { id: 'policy-default', version: '1.0.0', digest: digest('c') }
export const GENERATION_MODEL_REF: VersionRef = { id: 'company-llm', version: '1.0.0', digest: digest('d') }
export const DECISION_MODEL_REF: VersionRef = { id: 'company-jev', version: '1.0.0', digest: digest('e') }
export const COMPUTE_HANDLER_REF: VersionRef = {
  id: 'extension-home-energy',
  version: '1.0.0',
  digest: digest('f'),
}
export const TELEMETRY_ADAPTER_REF: VersionRef = { id: 'data-duckdb', version: '1.0.0', digest: digest('3') }

const BACKEND_REFS = {
  catalog: { id: 'data-postgres', version: '1.0.0', digest: digest('1') },
  documents: { id: 'search-bm25', version: '1.0.0', digest: digest('2') },
  telemetry: TELEMETRY_ADAPTER_REF,
} as const

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

function componentRecord(
  kind: ComponentKind,
  id: string,
  version: string,
  provides: readonly { readonly name: string; readonly version: string }[],
  componentDigest = digest(id),
): ComponentVersionRecord {
  return {
    manifestRef: { id, version, digest: componentDigest },
    manifest: {
      kind,
      id,
      version,
      digest: componentDigest,
      contractRange: { min: '1.0.0', max: '2.0.0' },
      provides: provides.map((entry) => capability(entry.name, entry.version)),
      requires: [],
      entrypointRef: { kind: 'package', ref: id },
      trustStatus: 'local_dev',
    },
    lifecycleState: 'active',
    registeredAt: '2026-09-21T00:00:00Z',
  }
}

export function registeredComponents(): ComponentVersionRecord[] {
  return [
    componentRecord('industry_pack', 'home-energy', '0.1.0', [{ name: 'industry.semantics', version: '0.1.0' }], INDUSTRY_REF.digest),
    componentRecord('data_backend', 'data-postgres', '1.0.0', [{ name: 'structured_query', version: '1.0.0' }], BACKEND_REFS.catalog.digest),
    componentRecord('document_backend', 'search-bm25', '1.0.0', [{ name: 'document_search', version: '1.0.0' }], BACKEND_REFS.documents.digest),
    componentRecord('data_backend', 'data-duckdb', '1.0.0', [{ name: 'telemetry_read', version: '1.0.0' }], BACKEND_REFS.telemetry.digest),
    componentRecord('compute_extension', 'extension-home-energy', '1.0.0', [
      { name: 'compute.home-energy.plan', version: '1.0.0' },
    ], COMPUTE_HANDLER_REF.digest),
    componentRecord('runtime', 'runtime-template', '1.0.0', [{ name: 'agent_runtime', version: '1.0.0' }], RUNTIME_REF.digest),
    componentRecord('generation', 'company-llm', '1.0.0', [{ name: 'generation.text', version: '1.0.0' }], GENERATION_MODEL_REF.digest),
  ]
}

export function industryManifest(): IndustryManifest {
  return {
    namespace: 'home-energy',
    maturity: 'preview',
    standardProvenance: [
      {
        standardRef: { id: 'iec-61968', version: '1.0.0', digest: digest('9') },
        provenanceKind: 'international_standard',
      },
    ],
    definitionsRef: { id: 'home-energy.definitions', version: '0.1.0', digest: digest('g') },
    identityPolicyRef: { id: 'home-energy.identity', version: '0.1.0', digest: digest('h') },
    rulePolicyRef: { id: 'home-energy.rules', version: '0.1.0', digest: digest('i') },
    queryTemplatesRef: { id: 'home-energy.templates', version: '0.1.0', digest: digest('j') },
    requiredCapabilities: [
      { name: 'structured_query', versionRange: { min: '1.0.0', max: '2.0.0' } },
      { name: 'document_search', versionRange: { min: '1.0.0' } },
      { name: 'telemetry_read', versionRange: { min: '1.0.0', max: '2.0.0' } },
      { name: 'compute.home-energy.plan', versionRange: { min: '1.0.0', max: '2.0.0' } },
    ],
    testSuiteRef: { id: 'home-energy.tests', version: '0.1.0', digest: digest('k') },
  }
}

export function mappingRef(role: LogicalRole): MappingRef {
  return {
    id: `home-energy.mapping.${role}`,
    version: '1.0.0',
    digest: digest(role),
    role,
    sourceObjectRef: {
      sourceRef: { namespace: 'control-postgres', sourceId: `public.${role}_objects` },
      objectPath: `public.${role}_objects`,
    },
  }
}

export function sampleProfileSpec(overrides?: Partial<ProfileSpec>): ProfileSpec {
  const base: ProfileSpec = {
    industryRef: INDUSTRY_REF,
    mappingRefs: [mappingRef('catalog'), mappingRef('documents'), mappingRef('telemetry')],
    runtimeRef: RUNTIME_REF,
    backendBindings: {
      catalog: { role: 'catalog', adapterRef: BACKEND_REFS.catalog, mappingRef: 'home-energy.mapping.catalog' },
      documents: {
        role: 'documents',
        adapterRef: BACKEND_REFS.documents,
        mappingRef: 'home-energy.mapping.documents',
      },
      telemetry: {
        role: 'telemetry',
        adapterRef: BACKEND_REFS.telemetry,
        mappingRef: 'home-energy.mapping.telemetry',
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
        inputSchemaRef: { id: 'home-energy.plan.input', version: '1.0.0', digest: digest('l') },
        outputSchemaRef: { id: 'home-energy.plan.output', version: '1.0.0', digest: digest('m') },
        readOnly: true,
        enabled: true,
        limits: { maxRows: 96, maxBytes: 1048576, maxDurationMs: 2000, maxConcurrency: 1 },
      },
    ],
    policyRef: POLICY_REF,
  }
  return { ...base, ...overrides }
}

/** The canonical ProfileSpec validator built from the published schema bundle (no filesystem). */
export function profileValidator(): ProfileSpecValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: true })
  addFormats(ajv)
  for (const document of SCHEMA_DOCUMENTS) ajv.addSchema(document)
  const validate = ajv.getSchema('https://ontology.local/schema/industry.schema.json#/$defs/ProfileSpec')
  if (validate === undefined) throw new Error('the ProfileSpec validator was not registered')
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

class RecordingControl implements ControlRepository {
  readonly appended: string[] = []
  transaction(): Promise<void> {
    return Promise.reject(new Error('transaction is not used by the workbench fixture'))
  }
  readProjection(): Promise<ProjectionState> {
    return Promise.reject(new Error('readProjection is not used by the workbench fixture'))
  }
  appendEvent(request: ControlAppendEventRequest): Promise<ControlAppendEventResponse> {
    this.appended.push(`${request.streamRef}:${request.idempotencyKey}`)
    return Promise.resolve({ recordedSeq: String(this.appended.length), appended: true })
  }
}

class SentinelSecretResolver implements SecretResolver {
  resolve(): Promise<SecretValue> {
    return Promise.resolve(new SecretValue(SENTINEL_SECRET))
  }
}

class TelemetryProbeAdapter implements SourceProbeAdapter {
  readonly adapterRef = TELEMETRY_ADAPTER_REF
  probe(): Promise<SourceProbeObservation> {
    return Promise.resolve({
      adapterRef: TELEMETRY_ADAPTER_REF,
      catalog: {
        resources: [
          {
            objectRef: {
              sourceRef: { namespace: 'control-postgres', sourceId: 'public.telemetry' },
              objectPath: 'public.telemetry',
            },
            schemaRevision: 'rev-1',
            columns: [{ name: 'ts', type: 'timestamp' }],
          },
        ],
        schemaRevision: 'rev-1',
      },
      pagination: { kind: 'cursor', pagesFetched: 2, exhausted: true },
      cancellation: { support: 'supported', attempted: true },
      snapshot: { consistency: 'repeatable_read', schemaRevision: 'rev-1' },
      limits: { maxRows: 1000, maxBytes: 1048576, maxDurationMs: 5000 },
      supportedDataTypes: ['string', 'integer', 'timestamp'],
      capabilities: [{ name: 'telemetry_read', version: '1.0.0' }],
    })
  }
}

function sequentialIds(prefix: string): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `${prefix}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`
  }
}

export function toolContext(roles: readonly string[], subjectId = 'ui-fixture'): ToolContext {
  return createToolContext({
    principal: {
      tenantId: SCOPE.tenantId,
      subjectId,
      roles: [...roles],
      scopes: [],
      authEpoch: 1,
    },
    runId: '33333333-3333-4333-8333-333333333333',
    resolvedProfileHash: digest('a'),
    policyVersion: '0.2.0',
    deadline: '2026-09-21T00:10:00Z',
    budgetReservation: {
      reservationId: '55555555-5555-4555-8555-555555555555',
      runId: '33333333-3333-4333-8333-333333333333',
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2026-09-21T00:10:00Z',
    },
    allowedResources: {
      tenantId: SCOPE.tenantId,
      spaceId: SCOPE.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-ui-fixture',
  })
}

async function seedComponents(
  store: ComponentRegistryStore,
  records: readonly ComponentVersionRecord[],
): Promise<void> {
  const ctx = toolContext(['platform-admin'])
  for (const record of records) {
    const input: ComponentRegistrationRecordInput = {
      record,
      artifactRef: {
        id: `${record.manifestRef.id}-artifact`,
        version: record.manifestRef.version,
        digest: record.manifestRef.digest,
        kind: 'artifact',
      },
      audit: {
        fromState: null,
        toState: record.lifecycleState,
        digest: record.manifestRef.digest,
        payloadDigest: digest('0'),
        idempotencyKey: `seed:${record.manifest.kind}:${record.manifestRef.id}:${record.manifestRef.version}`,
        occurredAt: record.registeredAt,
        actor: 'seed',
      },
    }
    await store.insertVersion(SCOPE, input, ctx)
  }
}

/** Header-driven authenticator for the jsdom tests, which can set headers per request. */
export function headerAuthenticator(request: {
  headers: Record<string, string | string[] | undefined>
}): AuthenticatedRequest | undefined {
  const rawSubject = request.headers['x-test-subject']
  const subject = Array.isArray(rawSubject) ? rawSubject[0] : rawSubject
  if (typeof subject !== 'string' || subject.length === 0) return undefined
  const rawRoles = request.headers['x-test-roles']
  const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
  const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : []
  return {
    principal: { tenantId: SCOPE.tenantId, subjectId: subject, roles, scopes: [], authEpoch: 1 },
    spaceId: SCOPE.spaceId,
  }
}

/**
 * Fixed-principal authenticator for the browser E2E harness. A browser cannot attach test
 * headers, so the harness mints one trusted principal. This is test-only and the harness
 * binds to 127.0.0.1 only; production uses verified OIDC and never a fixed principal
 * (SPEC §3).
 */
export function loopbackTestAuthenticator(): AuthenticatedRequest {
  return {
    principal: {
      tenantId: SCOPE.tenantId,
      subjectId: 'e2e-owner',
      roles: ['platform-admin', 'profile-editor', 'data-editor', 'business-user', 'scoped-reader'],
      scopes: [],
      authEpoch: 1,
    },
    spaceId: SCOPE.spaceId,
  }
}

const HARNESS_NOW = '2026-09-21T00:00:00Z'

/**
 * A minimal in-memory artifact registry behind the real on-disk object store, so the UI tests
 * drive the real blob-local write/read path without a database. The integration suite uses the
 * real PostgreSQL registry instead; this keeps the browser/jsdom path free of Docker.
 */
class MemoryArtifactRegistry implements ArtifactRegistry {
  readonly #blobs = new Map<string, ArtifactBlobRecord>()
  readonly #refs = new Map<string, ArtifactReferenceRecord>()

  async recordReference(input: RecordArtifactReferenceInput): Promise<RecordArtifactReferenceResult> {
    const refKey = `${input.scope.tenantId}:${input.scope.spaceId}:${input.blobRefId}`
    const blobKey = `${input.scope.tenantId}:${input.scope.spaceId}:${input.contentDigest}`
    const deduplicated = this.#refs.has(refKey)
    const blob = this.#blobs.get(blobKey) ?? {
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      contentDigest: input.contentDigest,
      mediaType: input.mediaType,
      byteSize: input.byteSize,
      objectKey: input.objectKey,
      lineageId: '77777777-2222-4333-8444-555555555555',
      createdAt: HARNESS_NOW,
    }
    this.#blobs.set(blobKey, blob)
    const reference: ArtifactReferenceRecord = {
      tenantId: input.scope.tenantId,
      spaceId: input.scope.spaceId,
      blobRefId: input.blobRefId,
      contentDigest: input.contentDigest,
      purpose: input.purpose,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.tenantAuthorizedRef === undefined ? {} : { tenantAuthorizedRef: input.tenantAuthorizedRef }),
      origin: input.origin ?? {},
      createdAt: HARNESS_NOW,
    }
    this.#refs.set(refKey, reference)
    return {
      blobRef: {
        id: input.blobRefId,
        version: '1.0.0',
        digest: input.contentDigest,
        kind: resourceKindForPurpose(input.purpose),
      },
      lineageId: blob.lineageId,
      deduplicated,
      reference,
    }
  }

  async findReference(scope: BlobScope, blobRefId: string): Promise<ArtifactReferenceView | undefined> {
    const reference = this.#refs.get(`${scope.tenantId}:${scope.spaceId}:${blobRefId}`)
    if (reference === undefined) return undefined
    const blob = this.#blobs.get(`${scope.tenantId}:${scope.spaceId}:${reference.contentDigest}`)
    if (blob === undefined) return undefined
    return { reference, blob }
  }

  async listOrigins(scope: BlobScope, contentDigest: string): Promise<readonly ArtifactReferenceRecord[]> {
    return [...this.#refs.values()].filter(
      (reference) =>
        reference.tenantId === scope.tenantId &&
        reference.spaceId === scope.spaceId &&
        reference.contentDigest === contentDigest,
    )
  }

  async close(): Promise<void> {}
}

/** A simulation job port that records nothing durable; the execution surface only needs an id. */
function inMemorySimulationJobs(): SimulationJobPort {
  return {
    async enqueue(input) {
      return { jobId: input.jobId, reused: false }
    },
  }
}

/**
 * Test-only run service that opens the run's one shared budget ledger and saves its manifest
 * when a run is created — the bookkeeping the real `WorkflowController.startRun` performs.
 * The fixture has no runtime adapter, so the UI tests focus on the ask/progress/clarify
 * surface while the real-DB integration suite proves the same budget semantics end to end.
 */
class HarnessRunService extends RunService {
  readonly #onCreated: (runId: string, ctx: ToolContext) => Promise<void>

  constructor(
    dependencies: RunServiceDependencies,
    onCreated: (runId: string, ctx: ToolContext) => Promise<void>,
  ) {
    super(dependencies)
    this.#onCreated = onCreated
  }

  override async createRun(input: CreateRunInput, ctx: ToolContext): Promise<CreateRunResult> {
    const result = await super.createRun(input, ctx)
    if (!result.reused) await this.#onCreated(result.runId, ctx)
    return result
  }
}

/** The answer route reader for the fixture; the verified answer is seeded explicitly. */
class HarnessAnswerReader implements AnswerReader {
  readonly #runs: RunService
  readonly #answers: Map<string, PublishedAnswer>

  constructor(runs: RunService, answers: Map<string, PublishedAnswer>) {
    this.#runs = runs
    this.#answers = answers
  }

  async getRun(
    runId: string,
    ctx: ToolContext,
  ): Promise<{ readonly state: RunState; readonly revision: RevisionString }> {
    const view = await this.#runs.getRun(runId, ctx)
    return { state: view.state, revision: view.revision }
  }

  getAnswer(runId: string): Promise<PublishedAnswer | undefined> {
    return Promise.resolve(this.#answers.get(runId))
  }
}

export interface Harness {
  readonly app: ReturnType<typeof createApiServer>
  readonly client: WorkbenchClient
  readonly registry: SourceRegistry
  readonly baseUrl: string
  readonly runService: RunService
  /** A trusted context in the harness scope for driving runs and budget directly. */
  readonly ctx: ToolContext
  readonly seedAnswer: (runId: string, answer: PublishedAnswer) => void
  /** Consume `toolCalls` from the run's shared ledger (real `BudgetService`, in-memory store). */
  readonly consumeBudget: (runId: string, toolCalls: number) => Promise<void>
  /** Present only when the home-energy surface was wired; records any device-driver call. */
  readonly energy: EnergyHarness | undefined
}

export interface EnergyHarness {
  /** Every device request the execution driver observed. It must stay empty. */
  readonly deviceRequests: readonly string[]
}

export interface HarnessOptions {
  readonly roles?: string
  readonly withoutTelemetry?: boolean
  readonly emptyRegistry?: boolean
  readonly seedProfile?: boolean
  /** Use the fixed loopback principal (browser E2E) instead of header-driven identity. */
  readonly fixedPrincipal?: boolean
  /** Override the SSE stream factory (the jsdom tests push frames without a real EventSource). */
  readonly streamFactory?: RunEventStreamFactory
  /** Register the C6 evidence/history routes with a controlled read surface (UI/E2E fixtures). */
  readonly provenance?: {
    readonly evidence: EvidenceReadSurface
    readonly history: HistoryReadSurface
  }
  /** Wire the home-energy simulation surface (real compute handlers + blob-local). */
  readonly energy?: {
    /** Omit the registered operations so a plan request returns CAPABILITY_NOT_CONFIGURED. */
    readonly withoutOperations?: boolean
  }
}

/**
 * Wire the home-energy simulation surface over the real compute handlers and blob-local. The
 * device driver is a recording double: the surface must never call it, so the UI/E2E tests can
 * prove no device request is sent for a simulation or for a refused live request.
 */
async function createEnergyHarness(options: { readonly withoutOperations?: boolean }): Promise<{
  readonly simulations: { readonly service: SimulationSurface; readonly execution: ExecutionSurface }
  readonly harness: EnergyHarness
  readonly cleanup: () => Promise<void>
}> {
  const objectDir = await mkdtemp(join(tmpdir(), 'ui-energy-blob-'))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  const blobStore = new LocalImmutableBlobStore({ objectStore, registry: new MemoryArtifactRegistry() })
  const artifacts = createBlobArtifactWriter(blobStore)
  const reader = createScopedBlobReader(blobStore)
  const operations: OperationRegistry =
    options.withoutOperations === true
      ? { namespace: 'home-energy', registryVersion: '1.0.0', registryDigest: digest('z'), operations: [] }
      : ENERGY_OPERATION_REGISTRY
  const service = createEnergySimulationSurface({
    blobStore,
    artifacts,
    reader,
    operations,
    handlers: createEnergyComputeHandlers(),
  })
  const deviceRequests: string[] = []
  const execution = createSimulationExecutionSurface({
    jobs: inMemorySimulationJobs(),
    deviceDriver: {
      async sendCommand() {
        deviceRequests.push('device')
      },
    },
  })
  return {
    simulations: { service, execution },
    harness: { deviceRequests },
    cleanup: () =>
      rm(objectDir, { recursive: true, force: true }).then(
        () => undefined,
        () => undefined,
      ),
  }
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const components = new InMemoryComponentRegistryStore()
  const profileStore = new InMemoryProfileStore()
  const sourceStore = new InMemorySourceStore()
  const industry = new InMemoryIndustryManifestSource()
  industry.register(INDUSTRY_REF, industryManifest())

  const all = registeredComponents()
  const seeded =
    options.withoutTelemetry === true
      ? all.filter((record) => record.manifestRef.id !== 'data-duckdb')
      : all
  if (options.emptyRegistry !== true) await seedComponents(components, seeded)

  const resolver = new ProfileResolver({
    control: new RecordingControl(),
    store: profileStore,
    registry: components,
    industry,
    validator: profileValidator(),
    now: () => '2026-09-21T00:00:00Z',
  })
  const adapters: SourceProbeAdapterResolver = {
    resolve: (ref) =>
      Promise.resolve(ref.id === TELEMETRY_ADAPTER_REF.id ? new TelemetryProbeAdapter() : undefined),
  }
  const registry = new SourceRegistry({
    control: new RecordingControl(),
    store: sourceStore,
    secrets: new SentinelSecretResolver(),
    adapters,
    now: () => '2026-09-21T00:00:00Z',
    newId: sequentialIds('77777777'),
  })
  const budget = new BudgetService({
    store: new InMemoryBudgetLedgerStore(),
    control: new RecordingControl(),
    now: () => HARNESS_NOW,
    newId: () => randomUUID(),
  })
  const manifests = new InMemoryWorkflowStore()
  const bindings = new Map<string, RunProfileBinding>()
  const binder: RunProfileBinder = {
    bindProfileForRun: async (profileRef, scopeRef, ctx) => {
      const binding = await resolver.bindRunProfile(profileRef, scopeRef, ctx)
      bindings.set(ctx.runId, binding)
      return binding
    },
  }
  const openRunBudget = async (runId: string, ctx: ToolContext): Promise<void> => {
    const binding = bindings.get(runId)
    if (binding === undefined) return
    const ledger = await budget.openLedger({ ledgerId: randomUUID(), kind: 'run', runId }, ctx)
    await manifests.saveRunManifest(
      {
        runId,
        resolvedProfileRef: binding.resolvedProfileRef,
        runtimeRef: binding.runtimeRef,
        budgetLedgerId: ledger.ledgerId,
        inputManifestId: randomUUID(),
        createdAt: HARNESS_NOW,
      },
      ctx,
    )
  }
  const runService = new HarnessRunService(
    {
      store: new InMemoryRunStore(),
      control: new RecordingControl(),
      profiles: binder,
      now: () => HARNESS_NOW,
    },
    openRunBudget,
  )
  const progress = new RunProgressService({ profiles: profileStore, binder, manifests, budget })
  const answers = new Map<string, PublishedAnswer>()
  const energy = options.energy === undefined ? undefined : await createEnergyHarness(options.energy)

  const app = createApiServer({
    authenticate:
      options.fixedPrincipal === true ? loopbackTestAuthenticator : headerAuthenticator,
    runs: { service: runService, progress },
    workbench: { profiles: resolver, sources: registry, components },
    answers: { reader: new HarnessAnswerReader(runService, answers) },
    ...(options.provenance === undefined
      ? {}
      : {
          evidence: { service: options.provenance.evidence },
          history: { service: options.provenance.history },
        }),
    ...(energy === undefined ? {} : { simulations: energy.simulations }),
  })
  if (energy !== undefined) {
    app.addHook('onClose', async () => {
      await energy.cleanup()
    })
  }
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('the API did not bind a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const roles = options.roles ?? ALL_ROLES
  const client = new WorkbenchClient({
    baseUrl,
    fetchImpl: (input, init) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          'x-test-subject': 'ui-owner',
          'x-test-roles': roles,
          'x-test-scope': 'a',
        },
      }),
    ...(options.streamFactory === undefined ? {} : { eventStreamFactory: options.streamFactory }),
  })

  if (options.seedProfile ?? true) {
    await client.publishProfile({ profileRef: PROFILE, spec: sampleProfileSpec(), environment: 'local_dev' })
  }
  if (options.emptyRegistry !== true && options.withoutTelemetry !== true) {
    const binding = await client.registerSource({
      kind: 'read_only_origin',
      role: 'telemetry',
      adapterRef: TELEMETRY_ADAPTER_REF,
      secretRef: 'secret://vault/telemetry',
      mappingRef: mappingRef('telemetry'),
      capabilityVersion: '1.0.0',
    })
    await client.probeSource(binding.sourceId)
  }

  const harnessCtx = toolContext(
    ['business-user', 'scoped-reader'],
    options.fixedPrincipal === true ? 'e2e-owner' : 'ui-owner',
  )
  const consumeBudget = async (runId: string, toolCalls: number): Promise<void> => {
    const manifest = await manifests.getRunManifest(runId, harnessCtx)
    if (manifest === undefined) throw new Error(`run ${runId} has no shared budget ledger`)
    const outcome = await budget.reserve(
      {
        ledgerId: manifest.budgetLedgerId,
        idempotencyKey: `harness-consume-${randomUUID()}`,
        toolCalls,
      },
      harnessCtx,
    )
    if (outcome.reservation === undefined) {
      throw new Error(`the harness budget reservation was denied for run ${runId}`)
    }
    const evidence: ResourceRef = {
      id: randomUUID(),
      version: '1.0.0',
      digest: `sha256:${'e'.repeat(64)}`,
      kind: 'evidence',
    }
    await budget.settle(
      {
        ledgerId: manifest.budgetLedgerId,
        reservationId: outcome.reservation.reservationId,
        status: 'completed',
        usage: { durationMs: 1 },
        evidenceRefs: [evidence],
      },
      harnessCtx,
    )
  }

  return {
    app,
    client,
    registry,
    baseUrl,
    runService,
    ctx: harnessCtx,
    seedAnswer: (runId, answer) => answers.set(runId, answer),
    consumeBudget,
    energy: energy?.harness,
  }
}
