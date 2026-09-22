import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import {
  FileSystemObjectStore,
  LocalImmutableBlobStore,
  PostgresArtifactRegistry,
} from '@ontology/adapter-blob-local'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAnswerStore,
  PostgresBudgetLedgerStore,
  PostgresCandidateStore,
  PostgresComponentRegistryStore,
  PostgresEvidenceStore,
  PostgresIdentityDecisionStore,
  PostgresJobStore,
  PostgresProfileStore,
  PostgresRunStore,
  PostgresSemanticDefinitionStore,
  PostgresSemanticPublicationStore,
  PostgresSourceStore,
  runControlMigrations,
} from '@ontology/adapter-control-postgres'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import {
  LocalDocumentExtractionService,
  PostgresDocumentParseStore,
} from '@ontology/adapter-extraction-document'
import { PiRuntimeAdapter } from '@ontology/adapter-runtime-pi'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import {
  AnswerPublicationService,
  CandidateValidationStageHandler,
  ExtractionPipeline,
  ExtractionStageHandler,
  InMemoryIndustrySchemaSource,
  InMemoryVerificationStore,
  InMemoryWorkflowStore,
  JobService,
  JobWorker,
  ProfileResolver,
  RestrictedAnswerVerifier,
  RestrictedDraftWriter,
  RestrictedLimitedAnswerComposer,
  ReviewHandoffStageHandler,
  RunPhaseDriver,
  RunService,
  SourceRegistry,
  StaticInputValidity,
  WorkflowController,
  createRunCheckpointPort,
} from '@ontology/application'
import type { ProfileSpecValidator, RunProfileBinder } from '@ontology/application'
import { createApiServer, createToolGatewayComposition, RunProgressService } from '@ontology/app-api'
import type { AuthenticatedRequest } from '@ontology/app-api'
import { createIngestionHandlerRegistry } from '@ontology/app-worker'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import { raceWithAbort } from '@ontology/tool-services'
import type { ToolExecutionOutcome, ToolExecutionRequest } from '@ontology/tool-services'
import {
  SecretValue,
  createToolContext,
  isToolContext,
} from '@ontology/contracts'
import type {
  ComponentRegistrationRecordInput,
  ComponentVersionRecord,
  EvidenceStorePort,
  GenerationPort,
  IndustryManifestSource,
  OperationRegistry,
  ProfileRef,
  PublicationBlockReason,
  PublicationValidityPort,
  PublicationValidityReport,
  PublicationValidityRequest,
  ResourceRef,
  ResolvedProfile,
  RunState,
  RuntimeAdapter,
  RuntimeCapabilityFactoryPort,
  RuntimeCapabilitySet,
  RuntimeSelectorPort,
  ScopeRef,
  SecretResolver,
  SourceProbeAdapter,
  SourceProbeAdapterResolver,
  SourceProbeObservation,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { ProvenanceReadService } from '@ontology/provenance'
import {
  HistoryReadService,
  IdentityDecisionService,
  SemanticDefinitionService,
  SemanticPublicationService,
  SupportEvidenceDependencySource,
  projectIndustrySchema,
} from '@ontology/semantic-engine'
import { startPostgresContainer } from '../../integration/postgres-container'
import type { PostgresContainer } from '../../integration/postgres-container'
import {
  CountingGenerationPort,
  MODEL_REF,
  generationResponse,
} from '../../unit/extraction-fixtures'
import {
  forbiddenGeneration,
  publishedPlan,
  runtimeManifest,
  StaticPlanResolver,
} from '../../unit/template-runtime-fixtures'
import {
  ScriptedGeneration,
  completedEvent,
  events,
  forbiddenDecision,
  piConfig,
  toolCallDelta,
} from '../../unit/pi-runtime-fixtures'
import {
  RecordingHandler,
  canonicalToolValidator,
  fullProfile,
  observation,
  operationRegistry,
} from '../../unit/tool-gateway-fixtures'
import { sampleCoreDraft } from '../../unit/semantic-definition-fixtures'
import {
  INDUSTRY_REF,
  PROFILE,
  TELEMETRY_ADAPTER_REF,
  industryManifest,
  profileValidator,
  registeredComponents,
} from '../../ui/workbench-fixtures'
import type { VerificationArtifactStore } from '@ontology/application'

/**
 * LOCAL-054 cross-layer acceptance environment.
 *
 * One real PostgreSQL container, one tenant/space, the real control stores, the real
 * content-addressed blob store, the real semantic engine, the real job worker (with a
 * deterministic model double for extraction), the real workflow controller and the real
 * Fastify HTTP host. Every layer the acceptance suite asserts is the production class; the
 * only substitutes are the generation/decision model ports (deterministic, no paid call) and
 * the scripted `ontology_lookup`/`document_search` handlers that stand in for an external
 * warehouse. They are marked explicitly in the delivery report.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/control', import.meta.url))

export const ACCEPTANCE_TENANT = randomUUID()
export const ACCEPTANCE_SPACE = randomUUID()
export const OTHER_TENANT = randomUUID()
export const OTHER_SPACE = randomUUID()

export const TEMPLATE_RUN = '11111111-aaaa-4aaa-8aaa-0000000000a1'
export const PI_RUN = '11111111-aaaa-4aaa-8aaa-0000000000a2'
export const RETRACTION_RUN = '11111111-aaaa-4aaa-8aaa-0000000000a3'

export const PI_PROFILE: ProfileRef = { id: 'home-energy-pi-demo', version: '1.0.0' }
export const PI_RUNTIME_REF: VersionRef = {
  id: 'runtime-pi',
  version: '1.0.0',
  digest: sha256DigestOf('runtime-pi-component'),
}

export const ALL_ACCEPTANCE_ROLES =
  'platform-admin,profile-editor,data-editor,business-user,scoped-reader,semantic-reviewer,semantic-publisher'

const ACCURATE_PAYLOAD = {
  entities: [
    {
      objectId: 'device',
      attributes: [
        { attributeId: 'device_native_id', value: 'D-1' },
        { attributeId: 'device_name', value: 'Charger D-1' },
        { attributeId: 'device_kind', value: 'charger' },
        { attributeId: 'rated_power', value: 7.2, unitCode: 'kW' },
      ],
    },
    { objectId: 'meter', attributes: [{ attributeId: 'meter_native_id', value: 'M-1' }] },
  ],
  relations: [
    {
      relationId: 'meter_monitors_device',
      from: { objectId: 'meter', entityIndex: 1 },
      to: { objectId: 'device', entityIndex: 0 },
    },
  ],
}

/** The claim-bindable fields a lookup result carries, so a draft claim can bind to it. */
export const LOOKUP_RESULT = {
  items: [
    { kind: 'definition', ref: { id: 'backup', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }, label: 'backup' },
  ],
  gaps: [],
  definitionVersion: { id: 'home-energy-definitions', version: '0.1.0', digest: `sha256:${'b'.repeat(64)}` },
  autoPublished: false,
  subject: 'site-demo-a',
  value: 12.5,
  unit: 'kWh',
  time: '2026-09-20T00:00:00Z',
} as const

export interface AcceptanceScope {
  readonly tenantId: string
  readonly spaceId: string
  readonly scopeRef: ScopeRef
  readonly ctx: ToolContext
}

function connectionStringFor(url: string, user: string, password: string): string {
  const base = new URL(url)
  const port = base.port === '' ? '' : `:${base.port}`
  const database = base.pathname.replace(/^\//, '') || 'postgres'
  return `${base.protocol}//${encodeURIComponent(user)}:${encodeURIComponent(password)}@${base.hostname}${port}/${database}`
}

function scopeFor(tenantId: string, spaceId: string, subject: string): AcceptanceScope {
  return {
    tenantId,
    spaceId,
    scopeRef: { tenantId, spaceId },
    ctx: createToolContext({
      principal: { tenantId, subjectId: subject, roles: ALL_ACCEPTANCE_ROLES.split(','), scopes: [], authEpoch: 1 },
      runId: randomUUID(),
      resolvedProfileHash: sha256DigestOf(`profile:${tenantId}:${spaceId}`),
      policyVersion: '0.2.0',
      deadline: '2099-01-01T00:00:00Z',
      budgetReservation: {
        reservationId: randomUUID(),
        runId: randomUUID(),
        grantedAt: '2026-09-21T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      },
      allowedResources: {
        tenantId,
        spaceId,
        resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
        sourceRefs: [],
        collectionRefs: ['home-energy/manuals'],
        domains: [],
        maxRows: 1000,
      },
      traceId: 'trace-acceptance',
    }),
  }
}

/** The trusted context a run's runtime and gateway use; scope comes from the seeded tenant/space. */
export function runContext(runId: Uuid, scope: AcceptanceScope): ToolContext {
  return createToolContext({
    principal: {
      tenantId: scope.tenantId,
      subjectId: 'acceptance-owner',
      roles: ['business-user'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: sha256DigestOf(`run:${runId}`),
    policyVersion: '0.2.0',
    deadline: '2099-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId,
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2099-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: scope.tenantId,
      spaceId: scope.spaceId,
      resourceKinds: ['artifact', 'dataset', 'evidence', 'document'],
      sourceRefs: [{ namespace: 'ha-anker', sourceId: 'warehouse' }],
      collectionRefs: ['home-energy/manuals'],
      domains: ['example.com'],
      maxRows: 1000,
    },
    traceId: `trace-run-${runId}`,
  })
}

export function lookupHandler(): RecordingHandler {
  return new RecordingHandler('ontology_lookup', {
    payload: LOOKUP_RESULT,
    status: 'ok',
    coverage: { returned: 1, truncated: false },
    sources: [observation()],
  })
}

export function searchHandler(): RecordingHandler {
  return new RecordingHandler('document_search', {
    payload: {
      spans: [],
      scoreKind: 'bm25',
      indexVersion: {
        indexRef: { id: 'home-energy-index', version: '1.0.0', digest: `sha256:${'c'.repeat(64)}` },
        generation: 1,
        builtAt: '2026-09-21T00:00:00Z',
      },
      completeness: 'complete',
    },
    status: 'empty',
    coverage: { returned: 0, truncated: false },
    sources: [observation()],
  })
}

class AcceptanceSecretResolver implements SecretResolver {
  resolve(): Promise<SecretValue> {
    return Promise.resolve(new SecretValue('secret://acceptance/telemetry'))
  }
}

class AcceptanceProbeAdapter implements SourceProbeAdapter {
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
      pagination: { kind: 'cursor', pagesFetched: 1, exhausted: true },
      cancellation: { support: 'supported', attempted: true },
      snapshot: { consistency: 'repeatable_read', schemaRevision: 'rev-1' },
      limits: { maxRows: 1000, maxBytes: 1_048_576, maxDurationMs: 5000 },
      supportedDataTypes: ['string', 'integer', 'timestamp'],
      capabilities: [{ name: 'telemetry_read', version: '1.0.0' }],
    })
  }
}

function piComponentRecord(): ComponentVersionRecord {
  return {
    manifestRef: { id: PI_RUNTIME_REF.id, version: PI_RUNTIME_REF.version, digest: PI_RUNTIME_REF.digest },
    manifest: {
      kind: 'runtime',
      id: PI_RUNTIME_REF.id,
      version: PI_RUNTIME_REF.version,
      digest: PI_RUNTIME_REF.digest,
      contractRange: { min: '1.0.0', max: '2.0.0' },
      provides: [
        {
          name: 'agent_runtime',
          version: '1.0.0',
          limits: { maxRows: 100, maxBytes: 1024, maxDurationMs: 1000 },
          consistency: 'repeatable_read',
          cancellation: 'supported',
          pagination: 'cursor',
          supportedDataTypes: ['string', 'integer'],
        },
      ],
      requires: [],
      entrypointRef: { kind: 'package', ref: '@ontology/adapter-runtime-pi' },
      trustStatus: 'local_dev',
    },
    lifecycleState: 'active',
    registeredAt: '2026-09-21T00:00:00Z',
  }
}

async function seedComponents(
  store: PostgresComponentRegistryStore,
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
      audit: {
        fromState: null,
        toState: record.lifecycleState,
        digest: record.manifestRef.digest,
        payloadDigest: sha256DigestOf(`payload:${record.manifestRef.id}`),
        idempotencyKey: `seed:${record.manifest.kind}:${record.manifestRef.id}:${record.manifestRef.version}`,
        occurredAt: record.registeredAt,
        actor: 'acceptance-seed',
      },
    }
    await store.insertVersion(scopeRef, input, ctx)
  }
}

/**
 * A handler that never completes its backend work, so the only way it can finish is the
 * propagated deadline. It uses the documented adapter cancellation contract
 * (`raceWithAbort`), which is what a real remote adapter must do, so the gateway's own
 * deadline enforcement is what produces the typed `DEADLINE_EXCEEDED` failure.
 */
class TimeoutHandler extends RecordingHandler {
  constructor() {
    super('ontology_lookup', {
      payload: LOOKUP_RESULT,
      status: 'ok',
      coverage: { returned: 1, truncated: false },
      sources: [observation()],
    })
  }

  override execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    return raceWithAbort(
      new Promise<ToolExecutionOutcome>(() => undefined),
      request.signal,
      'the tool call exceeded its propagated deadline',
    )
  }
}

export function timeoutHandler(): RecordingHandler {
  return new TimeoutHandler()
}

/**
 * The real post-verification validity check: it re-reads each evidence row from the real
 * archive and re-verifies its archived payload through the real blob store, so a retracted
 * basis or an unreadable artifact blocks publication instead of being assumed valid.
 */
class AcceptancePublicationValidity implements PublicationValidityPort {
  constructor(
    private readonly evidence: EvidenceStorePort,
    private readonly blob: LocalImmutableBlobStore,
    private readonly scopeRef: ScopeRef,
  ) {}

  async check(request: PublicationValidityRequest, ctx: ToolContext): Promise<PublicationValidityReport> {
    const reasons: PublicationBlockReason[] = []
    const details: string[] = []
    for (const ref of request.evidenceRefs) {
      const record = await this.evidence.get(this.scopeRef, ref.id, ctx)
      if (record === undefined) {
        reasons.push('evidence_retracted')
        details.push(`evidence ${ref.id} is gone`)
        continue
      }
      const payloadRef = record.envelope.payloadRef
      if (payloadRef === undefined) {
        reasons.push('evidence_unverifiable')
        details.push(`evidence ${ref.id} has no archived payload`)
        continue
      }
      try {
        const authorized = await this.blob.getAuthorized({ scopeRef: this.scopeRef, blobRef: payloadRef }, ctx)
        if (!authorized.integrityVerified) {
          reasons.push('evidence_unverifiable')
          details.push(`evidence ${ref.id} failed integrity verification`)
        }
      } catch {
        reasons.push('evidence_unverifiable')
        details.push(`evidence ${ref.id} could not be re-read`)
      }
    }
    const unique = [...new Set(reasons)]
    return { publishable: unique.length === 0, blockedReasons: unique, historyLimited: false, details }
  }
}

export interface AcceptanceEnvironment {
  readonly container: PostgresContainer | undefined
  readonly adminClient: Client
  readonly appUrl: string
  readonly objectDir: string
  readonly database: ControlPostgresDatabase
  readonly blobStore: LocalImmutableBlobStore
  readonly objectStore: FileSystemObjectStore
  readonly scope: AcceptanceScope
  readonly otherScope: AcceptanceScope
  readonly app: ReturnType<typeof createApiServer>
  readonly profileResolver: ProfileResolver
  readonly sourceRegistry: SourceRegistry
  readonly semanticDefinitions: SemanticDefinitionService
  readonly identityService: IdentityDecisionService
  readonly publicationService: SemanticPublicationService
  readonly candidateStore: PostgresCandidateStore
  readonly publicationStore: PostgresSemanticPublicationStore
  readonly jobService: JobService
  readonly runService: RunService
  readonly controller: WorkflowController
  readonly evidence: PostgresEvidenceStore
  readonly budget: BudgetService
  readonly provenance: ProvenanceReadService
  readonly history: HistoryReadService
  readonly parseStore: PostgresDocumentParseStore
  readonly gateway: ReturnType<typeof createToolGatewayComposition>
  readonly lookup: RecordingHandler
  readonly search: RecordingHandler
  readonly duckdb: DuckDbQueryAdapter
  readonly schemaSource: () => InMemoryIndustrySchemaSource
  readonly definitionRef: () => VersionRef
  readonly worker: (generation?: GenerationPort) => JobWorker
  readonly startTemplateRun: (runId: Uuid) => ReturnType<WorkflowController['startRun']>
  readonly startPiRun: (runId: Uuid) => ReturnType<WorkflowController['startRun']>
  readonly close: () => Promise<void>
}

function asProfileValidator(): ProfileSpecValidator {
  return profileValidator()
}

export async function startAcceptanceEnvironment(): Promise<AcceptanceEnvironment> {
  const provided = process.env.CONTROL_TEST_DATABASE_URL
  const container =
    provided === undefined || provided.length === 0 ? await startPostgresContainer() : undefined
  const adminUrl = container?.adminUrl ?? provided ?? ''

  await runControlMigrations({ connectionString: adminUrl, migrationsDir: MIGRATIONS_DIR })

  const adminClient = new Client({ connectionString: adminUrl })
  await adminClient.connect()
  await adminClient.query(
    `INSERT INTO agent_platform.tenants (tenant_id, slug) VALUES ($1, 'acceptance-tenant'), ($2, 'acceptance-other') ON CONFLICT DO NOTHING`,
    [ACCEPTANCE_TENANT, OTHER_TENANT],
  )
  await adminClient.query(
    `INSERT INTO agent_platform.spaces (tenant_id, space_id, name)
     VALUES ($1, $2, 'acceptance-space'), ($3, $4, 'acceptance-other-space')
     ON CONFLICT DO NOTHING`,
    [ACCEPTANCE_TENANT, ACCEPTANCE_SPACE, OTHER_TENANT, OTHER_SPACE],
  )

  const appPassword = `throwaway_${randomUUID().replaceAll('-', '')}`
  const statement = await adminClient.query<{ statement: string }>(
    "SELECT format('ALTER ROLE ontology_app LOGIN PASSWORD %L', $1::text) AS statement",
    [appPassword],
  )
  const alterStatement = statement.rows[0]?.statement
  if (alterStatement === undefined) throw new Error('could not build the application-role login statement')
  await adminClient.query(alterStatement)
  const appUrl = connectionStringFor(adminUrl, 'ontology_app', appPassword)

  const objectDir = await mkdtemp(join(tmpdir(), `acceptance-blob-${randomBytes(3).toString('hex')}-`))
  const objectStore = new FileSystemObjectStore(objectDir)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString: appUrl, maxPoolSize: 4 })
  const blobStore = new LocalImmutableBlobStore({ objectStore, registry })

  const database = new ControlPostgresDatabase({ connectionString: appUrl, maxPoolSize: 10 })
  const control = new ControlPostgresRepository(database)
  const budget = new BudgetService({
    store: new PostgresBudgetLedgerStore(database),
    control,
    newId: () => randomUUID(),
  })

  const scope = scopeFor(ACCEPTANCE_TENANT, ACCEPTANCE_SPACE, 'acceptance-owner')
  const otherScope = scopeFor(OTHER_TENANT, OTHER_SPACE, 'acceptance-other')

  // --- configuration layer: components, profile resolver, source registry -------------
  const components = new PostgresComponentRegistryStore(database)
  await seedComponents(components, [...registeredComponents(), piComponentRecord()], scope.scopeRef, scope.ctx)

  const manifest = industryManifest()
  const industry: IndustryManifestSource = {
    getManifest: (ref: VersionRef) => Promise.resolve(ref.id === INDUSTRY_REF.id ? manifest : undefined),
  }

  const profileResolver = new ProfileResolver({
    control,
    store: new PostgresProfileStore(database),
    registry: components,
    industry,
    validator: asProfileValidator(),
  })

  const probeAdapter = new AcceptanceProbeAdapter()
  const adapters: SourceProbeAdapterResolver = {
    resolve: (ref) => Promise.resolve(ref.id === probeAdapter.adapterRef.id ? probeAdapter : undefined),
  }
  const sourceRegistry = new SourceRegistry({
    control,
    store: new PostgresSourceStore(database),
    secrets: new AcceptanceSecretResolver(),
    adapters,
    newId: () => randomUUID(),
  })

  // --- semantic layer: definitions, identity decisions, publication -------------------
  const semanticDefinitionStore = new PostgresSemanticDefinitionStore(database)
  const semanticDefinitions = new SemanticDefinitionService({ control, store: semanticDefinitionStore })
  const published = await semanticDefinitions.publish(sampleCoreDraft({ scopeRef: scope.scopeRef }), scope.ctx)
  const schemaSource = (): InMemoryIndustrySchemaSource =>
    new InMemoryIndustrySchemaSource([{ ref: published.ref, schema: projectIndustrySchema(published) }])

  const candidateStore = new PostgresCandidateStore(database)
  const identityStore = new PostgresIdentityDecisionStore(database)
  const publicationStore = new PostgresSemanticPublicationStore(database)
  const identityService = new IdentityDecisionService({
    store: identityStore,
    candidates: candidateStore,
    schemaSource: schemaSource(),
    newId: () => randomUUID(),
  })
  const publicationService = new SemanticPublicationService({
    store: publicationStore,
    candidates: candidateStore,
    schemaSource: schemaSource(),
    identity: identityStore,
    newId: () => randomUUID(),
  })

  // --- job layer: durable ingestion jobs + the real worker ----------------------------
  const jobStore = new PostgresJobStore(database)
  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  const parseStore = new PostgresDocumentParseStore({ connectionString: appUrl, maxPoolSize: 2 })
  const parser = new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore })

  const worker = (generation: GenerationPort = new CountingGenerationPort(generationResponse(ACCURATE_PAYLOAD))): JobWorker => {
    const pipeline = new ExtractionPipeline({
      schemaSource: schemaSource(),
      generation,
      candidates: candidateStore,
      budget,
      modelRef: MODEL_REF,
      outputLimit: { maxTokens: 512 },
    })
    const downstream = [
      new ExtractionStageHandler({ pipeline, parseStore }),
      new CandidateValidationStageHandler({ pipeline, parseStore }),
      new ReviewHandoffStageHandler(),
    ]
    return new JobWorker({
      store: jobStore,
      handlers: createIngestionHandlerRegistry({ parser, downstream }),
      budget,
      workerId: `acceptance-worker-${randomBytes(2).toString('hex')}`,
      newId: () => randomUUID(),
    })
  }

  // --- run layer: real gateway, both runtimes, real controller ------------------------
  const lookup = lookupHandler()
  const search = searchHandler()
  const evidence = new PostgresEvidenceStore(database)
  const gateway = createToolGatewayComposition({
    database,
    blobStore,
    budget,
    validator: canonicalToolValidator(),
    handlers: [lookup, search],
  })
  const runStore = new PostgresRunStore(database)
  const answerStore = new PostgresAnswerStore(database)
  const binder: RunProfileBinder = {
    bindProfileForRun: (profileRef, scopeRef, ctx) => profileResolver.bindRunProfile(profileRef, scopeRef, ctx),
  }
  const runService = new RunService({ store: runStore, control, profiles: binder, newId: () => randomUUID() })
  const phase = new RunPhaseDriver({ store: runStore, control })
  const manifests = new InMemoryWorkflowStore()
  const verifications = new InMemoryVerificationStore()
  const piGenerationByRun = new Map<Uuid, GenerationPort>()
  const capabilities: RuntimeCapabilityFactoryPort = {
    forRun: (context): Promise<RuntimeCapabilitySet> => {
      const resolvedProfile: ResolvedProfile = fullProfile()
      const operations: OperationRegistry = operationRegistry()
      return Promise.resolve({
        gateway: gateway.forRun({
          runId: context.runId,
          ledgerId: context.budgetLedgerId,
          resolvedProfile,
          operations,
        }),
        generation: piGenerationByRun.get(context.runId) ?? forbiddenGeneration,
        decision: forbiddenDecision,
        checkpoints: createRunCheckpointPort(runStore),
      })
    },
  }
  const adaptersById = new Map<string, RuntimeAdapter>([
    [
      'runtime-template',
      new TemplateRuntimeAdapter({
        manifest: runtimeManifest(),
        plans: new StaticPlanResolver(
          publishedPlan({
            planRef: {
              id: 'plan-acceptance',
              version: '1.0.0',
              digest: sha256DigestOf('plan-acceptance'),
              kind: 'plan',
            },
            steps: [
              {
                stepId: 'lookup',
                toolId: 'ontology_lookup',
                readOnly: true,
                args: [
                  { name: 'scopeRef', required: true, source: { kind: 'literal', value: scope.scopeRef } },
                  { name: 'intent', required: true, source: { kind: 'literal', value: 'definitions' } },
                ],
                dependsOn: [],
                failureBehaviour: 'abort',
              },
              {
                stepId: 'search',
                toolId: 'document_search',
                readOnly: true,
                args: [
                  {
                    name: 'query',
                    required: true,
                    source: { kind: 'predecessor', stepId: 'lookup', pointer: '/items/0/label' },
                  },
                  { name: 'allowedCollectionRefs', required: true, source: { kind: 'literal', value: ['home-energy/manuals'] } },
                  { name: 'mode', required: true, source: { kind: 'literal', value: 'keyword' } },
                ],
                dependsOn: ['lookup'],
                failureBehaviour: 'abort',
              },
            ],
          }),
        ),
      }),
    ],
    ['runtime-pi', new PiRuntimeAdapter(piConfig())],
  ])
  const selector: RuntimeSelectorPort = {
    select: (runtimeRef) => {
      const adapter = adaptersById.get(runtimeRef.id)
      if (adapter === undefined) throw new Error(`no runtime adapter registered for ${runtimeRef.id}`)
      return Promise.resolve(adapter)
    },
  }
  const controller = new WorkflowController({
    runs: runService,
    phase,
    budget,
    manifests,
    runtimes: selector,
    capabilities,
    draftWriter: new RestrictedDraftWriter(),
    limited: new RestrictedLimitedAnswerComposer(),
    verifier: new RestrictedAnswerVerifier(),
    verifications,
    publisher: new AnswerPublicationService({
      runs: runStore,
      answers: answerStore,
      verifications,
      manifests,
      validity: new AcceptancePublicationValidity(evidence, blobStore, scope.scopeRef),
    }),
    validity: new StaticInputValidity(),
  })

  // --- provenance / history read side -------------------------------------------------
  const provenance = new ProvenanceReadService({
    evidence,
    blobs: blobStore,
    dependencies: new SupportEvidenceDependencySource({ published: publicationStore }),
    reader: blobStore,
  })
  const history = new HistoryReadService({ store: publicationStore })

  // --- real DuckDB backend for the no-ontology / second-mapping matrix leg -------------
  const readingsRelation: RegisteredRelation = {
    relation: 'energy_readings_c',
    objectRef: { sourceRef: { namespace: 'home-energy', sourceId: 'duckdb-local' }, objectPath: 'energy_readings_c' },
    schemaRevision: '2026-09-01',
    columns: [
      { name: 'reading_id', type: 'string' },
      { name: 'meter_id', type: 'string' },
      { name: 'recorded_at', type: 'timestamp' },
      { name: 'energy_kwh', type: 'decimal' },
      { name: 'status_text', type: 'string' },
    ],
    physicalTypes: { energy_kwh: 'DECIMAL(18,4)', recorded_at: 'TIMESTAMP' },
  }
  const duckdb = new DuckDbQueryAdapter({
    relations: [readingsRelation],
    catalogSchemaRevision: '2026-09-01',
    consistency: 'repeatable_read',
  })
  await duckdb.start()

  // --- HTTP host: one Fastify instance covering every layer ---------------------------
  const authenticate = (request: {
    headers: Record<string, string | string[] | undefined>
  }): AuthenticatedRequest | undefined => {
    const rawScope = request.headers['x-test-scope']
    const isOther = (Array.isArray(rawScope) ? rawScope[0] : rawScope) === 'other'
    const rawRoles = request.headers['x-test-roles']
    const rolesValue = Array.isArray(rawRoles) ? rawRoles[0] : rawRoles
    const roles = typeof rolesValue === 'string' && rolesValue.length > 0 ? rolesValue.split(',') : ALL_ACCEPTANCE_ROLES.split(',')
    return {
      principal: {
        tenantId: isOther ? OTHER_TENANT : ACCEPTANCE_TENANT,
        subjectId: 'acceptance-owner',
        roles,
        scopes: [],
        authEpoch: 1,
      },
      spaceId: isOther ? OTHER_SPACE : ACCEPTANCE_SPACE,
    }
  }

  const progress = new RunProgressService({
    profiles: new PostgresProfileStore(database),
    binder,
    manifests,
    budget,
  })
  const app = createApiServer({
    authenticate,
    runs: { service: runService, progress },
    jobs: { service: jobService },
    workbench: { profiles: profileResolver, sources: sourceRegistry, components },
    decisions: { service: identityService, candidates: candidateStore, documents: parseStore },
    publications: { service: publicationService },
    evidence: { service: provenance },
    history: { service: history },
    answers: { reader: controller },
  })

  const startTemplateRun = (runId: Uuid): ReturnType<WorkflowController['startRun']> =>
    controller.startRun(
      {
        runId,
        profileRef: PROFILE,
        question: '明天备电策略如何安排？',
        context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
        preferences: { route: 'auto', allowWeb: false },
        idempotencyKey: `acceptance-template-${runId}`,
      },
      runContext(runId, scope),
    )

  const startPiRun = (runId: Uuid): ReturnType<WorkflowController['startRun']> => {
    piGenerationByRun.set(
      runId,
      new ScriptedGeneration(
        [
          events(
            toolCallDelta('pi-1', 'ontology_lookup', { scopeRef: scope.scopeRef, intent: 'definitions' }),
            completedEvent('tool_calls'),
          ),
          events(
            toolCallDelta('pi-2', 'document_search', {
              query: 'backup',
              allowedCollectionRefs: ['home-energy/manuals'],
              mode: 'keyword',
            }),
            completedEvent('tool_calls'),
          ),
          events(completedEvent('stop')),
        ],
        { signal: new AbortController().signal },
      ),
    )
    return controller.startRun(
      {
        runId,
        profileRef: PI_PROFILE,
        question: '明天备电策略如何安排？',
        context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
        preferences: { route: 'auto', allowWeb: false },
        idempotencyKey: `acceptance-pi-${runId}`,
      },
      runContext(runId, scope),
    )
  }

  const close = async (): Promise<void> => {
    await app.close().catch(() => undefined)
    duckdb.close()
    await parseStore.close().catch(() => undefined)
    await registry.close().catch(() => undefined)
    await database.close().catch(() => undefined)
    await adminClient.end().catch(() => undefined)
    await rm(objectDir, { recursive: true, force: true }).catch(() => undefined)
    await container?.stop()
  }

  return {
    container,
    adminClient,
    appUrl,
    objectDir,
    database,
    blobStore,
    objectStore,
    scope,
    otherScope,
    app,
    profileResolver,
    sourceRegistry,
    semanticDefinitions,
    identityService,
    publicationService,
    candidateStore,
    publicationStore,
    jobService,
    runService,
    controller,
    evidence,
    budget,
    provenance,
    history,
    parseStore,
    gateway,
    lookup,
    search,
    duckdb,
    schemaSource,
    definitionRef: () => published.ref,
    worker,
    startTemplateRun,
    startPiRun,
    close,
  }
}

export { forbiddenGeneration, sha256DigestOf, isToolContext }
export type { ResourceRef, RunState, VerificationArtifactStore }
