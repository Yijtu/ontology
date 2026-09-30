import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject, ValidateFunction } from 'ajv'
import type { FastifyInstance } from 'fastify'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { DATA_DUCKDB_ADAPTER_REF, DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import {
  ControlPostgresDatabase,
  ControlPostgresRepository,
  PostgresAnswerStore,
  PostgresAssetCandidateStore,
  PostgresAssetWorkspaceStore,
  PostgresBudgetLedgerStore,
  PostgresCandidateStore,
  PostgresComponentRegistryStore,
  PostgresDecisionStateReferenceStore,
  PostgresDefinitionEditingStore,
  PostgresEvidenceStore,
  PostgresIdentityDecisionStore,
  PostgresIndustryValidationReportStore,
  PostgresInstanceReviewStore,
  PostgresJobStore,
  PostgresMaterializationStore,
  PostgresProfileStore,
  PostgresProjectDocumentStore,
  PostgresProjectMappingStore,
  PostgresProjectReadinessStore,
  PostgresProjectRecordStore,
  PostgresProjectStore,
  PostgresPublishedPackAssetStore,
  PostgresRuleActionCandidateStore,
  PostgresRunStore,
  PostgresSemanticDefinitionStore,
  PostgresSemanticPublicationStore,
  PostgresSyntheticExampleSetStore,
  PostgresWorkflowDispatchStore,
  PostgresWorkflowStore,
} from '@ontology/adapter-control-postgres'
import {
  DocumentSpanReader,
  LocalDocumentExtractionService,
  LocalStructuredIngestionService,
  PostgresDocumentParseStore,
  PostgresStructuredIngestionStore,
  StructuredDocumentParser,
} from '@ontology/adapter-extraction-document'
import { Bm25DocumentSearchService, PostgresKeywordIndexStore, ProjectDocumentIndexService, createBm25DocumentSearchToolHandler } from '@ontology/adapter-search-bm25'
import { TemplateRuntimeAdapter, TemplateRuntimeError } from '@ontology/adapter-runtime-template'
import type { TemplatePlanResolver } from '@ontology/adapter-runtime-template'
import {
  AnswerPublicationService,
  CandidateValidationStageHandler,
  ComponentRegistry,
  CompositeReviewableCandidateReader,
  DefinitionCandidateEditingService,
  DefinitionCandidateGenerationService,
  DraftVerificationService,
  ExtractionPipeline,
  EXTRACTION_RESPONSE_SCHEMA_REF,
  ExtractionStageHandler,
  InMemoryIndustryManifestSource,
  InMemoryIndustrySchemaSource,
  IndustryAssetPublicationService,
  IndustryPackExportService,
  IndustryPackUpgradeService,
  IndustryValidationService,
  IndustryWorkspaceService,
  INDUSTRY_WORKSPACE_CREATED_TOPIC,
  INDUSTRY_WORKSPACE_DRAFT_APPENDED_TOPIC,
  InstanceReviewService,
  PACK_PUBLISHED_TOPIC,
  JobService,
  JobWorker,
  OutboxDispatcher,
  PROJECT_CREATED_TOPIC,
  PROJECT_REVISION_APPENDED_TOPIC,
  ProjectMappingService,
  ProjectService,
  ProfileResolver,
  RestrictedLimitedAnswerComposer,
  RuleActionCandidateService,
  SourceRegistry,
  RunPhaseDriver,
  RunService,
  StaticDefinitionTerminologySource,
  StoreBackedIndustryManifestSource,
  StoreBackedIndustryPackCatalogue,
  StructuredExtractionService,
  StructuredExtractionStageHandler,
  SyntheticExampleService,
  TBOX_RESPONSE_SCHEMA_REF,
  WorkflowController,
  createRunCheckpointPort,
  encodeDocumentIngestionRef,
  mapNativeEntities,
  parseDefinitionCandidateOutput,
  parseModelCandidates,
  ReviewHandoffStageHandler,
} from '@ontology/application'
import type { ManifestValidator, MountedDefinitionTerminology, OutboxConsumer, ProfileSpecValidator, RunProfileBinder } from '@ontology/application'
import type {
  ActionCapabilityBindingInput,
  CandidateStore,
  ComponentKind,
  ComponentManifest,
  ComponentRegistrationRecordInput,
  ComponentVersionRecord,
  DocumentParserPort,
  GenerationPort,
  IndustryManifestSource,
  IndustrySchema,
  IndustryWorkspaceStore,
  InputValidityPort,
  OperationRegistry,
  OutboxMessageRecord,
  ProfileRef,
  ProfileSpec,
  ProjectStore,
  PublicationValidityPort,
  PublicationValidityReport,
  PublicationValidityRequest,
  QueryColumn,
  ResourceRef,
  RuntimeCapabilityFactoryPort,
  RuntimeCapabilitySet,
  RuntimeSelectorPort,
  ScalarValue,
  ScopeRef,
  ScopedArtifactReader,
  SourceRef,
  SupportedDataType,
  ToolContext,
  Uuid,
  VersionRef,
  WorkflowDispatchFence,
  RuntimeCapabilityContext,
} from '@ontology/contracts'
import { DEFAULT_VERIFICATION_POLICY, SCHEMA_DOCUMENTS, TOOL_CATALOGUE, createToolContext } from '@ontology/contracts'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import { createRequestToolContext, createToolGatewayComposition, ForbiddenError, InvalidRequestFieldError } from '@ontology/app-api'
import type { CoreApiDependencies } from '../core-main'
import { FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator, IdentityDecisionService, IncrementalMaterializer, InMemorySemanticMappingRegistry, OntologyLookupService, PublishedFactsReferenceProvider, PublishedSemanticSource, SemanticDefinitionService, SemanticPublicationService } from '@ontology/semantic-engine'
import type {
  MaterializationPublishedSource,
  OntologyFactPage,
  OntologyFactQuery,
  OntologyFactReferenceProvider,
  PublishedSemanticData,
} from '@ontology/semantic-engine'
import { DataQueryHandler, OntologyLookupHandler, canonicalJson } from '@ontology/tool-services'
import type { ToolSchemaValidator } from '@ontology/tool-services'
import { controlRecordSequence, JobWorkerLoop, MaterializationOutboxConsumer, TopicOutboxConsumerRouter, WorkflowDispatchWorker, createIngestionHandlerRegistry } from '@ontology/app-worker'
import { PublishedFactsDraftWriter } from './published-facts-draft'
import { CoreFactsPlanError, createCoreFactsPlan } from './core-facts-plan'
import { createStaticProbeAdapterResolver, createPostgresSourceStore } from './source-registry'
import { createEnvSecretResolver } from './secret-resolver'
import { createPostgresProvenanceRead } from './provenance-read'
import { createCoreModelCapabilityFactory } from './core-model-capabilities'
import { createCoreModelEvidenceRecorders } from './model-evidence'
import { createCoreDecisionStateRefProvider } from './decision-state-reference'
import { createCoreJevActualStateResolver } from './jev-actual-state'
import { RunProgressService } from '../http/run-progress'
import type { CoreExampleScenario, LoadedCoreExamples } from './core-example-loader'
import type { RequestAuthenticator } from '../http/shared'

const CONTRACT_SCHEMA_BASE = 'https://ontology.local/schema'
const COMPONENT_VERSION = '1.0.0'
const CORE_POLICY_REF: VersionRef = {
  id: 'core-local-policy',
  version: COMPONENT_VERSION,
  digest: sha256DigestOf('core-local-policy@1.0.0'),
}
const WORKER_RUN_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const MAX_IMPORTED_BYTES = 1_048_576
const FACTS_SOURCE_REF: SourceRef = { namespace: 'ontology-core-local', sourceId: 'published-semantic-read' }

function stableUuid(seed: string): Uuid {
  const chars = [...createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32)]
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function scenarioComponentRecords(scenarios: readonly CoreExampleScenario[], now: string): ComponentVersionRecord[] {
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
  return [...records.values()]
}

async function registerComponents(
  store: PostgresComponentRegistryStore,
  records: readonly ComponentVersionRecord[],
  scopeRef: ScopeRef,
  ctx: ToolContext,
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
    await store.insertVersion(scopeRef, componentRegistrationInput(record, record.registeredAt), ctx)
  }
}

function industrySourceFor(scenarios: readonly CoreExampleScenario[]): IndustryManifestSource {
  return new InMemoryIndustryManifestSource(scenarios.map((scenario) => ({
    ref: componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest),
    manifest: scenario.industryManifest,
  })))
}

async function registerProfiles(
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

function schemaSourceFor(scenarios: readonly CoreExampleScenario[]): InMemoryIndustrySchemaSource {
  return new InMemoryIndustrySchemaSource(scenarios.map((scenario) => ({
    ref: scenario.definitionRef,
    schema: scenario.industrySchema,
  })))
}

function noModelError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: 'CAPABILITY_NOT_CONFIGURED' })
}

function disabledDecision() {
  return {
    decide: async () => { throw noModelError('the JEV decision model is not configured') },
  }
}

function operationRegistry(): OperationRegistry {
  return {
    namespace: 'core-local',
    registryVersion: COMPONENT_VERSION,
    registryDigest: sha256DigestOf('core-local-operations@1.0.0'),
    operations: [],
  }
}

function schemasByScenario(scenarios: readonly CoreExampleScenario[]): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(scenarios.map((scenario) => [
    scenario.scenarioId,
    scenario.industrySchema.objects.flatMap((object) => object.attributes.map((attribute) => `facts:${attribute.attributeId}`)),
  ]))
}

function sourceKey(sourceRef: SourceRef): string {
  return `${sourceRef.namespace}\u0000${sourceRef.sourceId}`
}

function parseJsonRecordBlocks(text: string, label: string): Record<string, ScalarValue>[] {
  const records: Record<string, ScalarValue>[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === undefined) continue
    if (start < 0) {
      if (character === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') depth -= 1
    if (depth !== 0) continue
    const encoded = text.slice(start, index + 1)
    let parsed: unknown
    try {
      parsed = JSON.parse(encoded)
    } catch (error) {
      throw new Error(`${label} contains an invalid JSON object`, { cause: error })
    }
    if (!isRecord(parsed)) throw new Error(`${label} must contain JSON objects`)
    const record: Record<string, ScalarValue> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(`${label} has a non-scalar value for ${key}`)
      }
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} has a non-finite value for ${key}`)
      record[key] = value
    }
    records.push(record)
    start = -1
    depth = 0
  }
  if (start >= 0 || records.length === 0) throw new Error(`${label} must contain one or more complete JSON records`)
  return records
}

function columnType(values: readonly ScalarValue[]): { readonly type: QueryColumn['type']; readonly physicalType: string } {
  const populated = values.filter((value) => value !== null)
  if (populated.length === 0) return { type: 'string', physicalType: 'VARCHAR' }
  if (populated.every((value) => typeof value === 'boolean')) return { type: 'boolean', physicalType: 'BOOLEAN' }
  if (populated.every((value) => typeof value === 'number')) {
    const integral = populated.every((value) => typeof value === 'number' && Number.isSafeInteger(value))
    return integral ? { type: 'integer', physicalType: 'BIGINT' } : { type: 'decimal', physicalType: 'DECIMAL(38,10)' }
  }
  if (populated.every((value) => typeof value === 'string')) {
    const timestamps = populated.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value))
    return timestamps ? { type: 'timestamp', physicalType: 'TIMESTAMP' } : { type: 'string', physicalType: 'VARCHAR' }
  }
  return { type: 'json', physicalType: 'JSON' }
}

export async function createDuckDbSnapshot(scenarios: readonly CoreExampleScenario[]): Promise<DuckDbQueryAdapter> {
  const recordsBySource = new Map<string, Record<string, ScalarValue>[]>()
  for (const scenario of scenarios) {
    for (const source of scenario.rawSources) {
      recordsBySource.set(sourceKey(source.sourceRef), parseJsonRecordBlocks(await readFile(source.path, 'utf8'), source.path))
    }
  }

  const registered: RegisteredRelation[] = []
  const rowsByRelation = new Map<string, readonly (readonly ScalarValue[])[]>()
  const registeredByRelation = new Map<string, RegisteredRelation>()
  for (const scenario of scenarios) {
    for (const loaded of scenario.physicalMappings) {
      for (const object of loaded.mapping.objects) {
        const sourceRecords = recordsBySource.get(sourceKey(object.sourceObjectRef.sourceRef))
        if (sourceRecords === undefined) throw new Error(`no loaded raw source for mapping ${loaded.ref.id}`)
        const columns = [...new Set(object.fields.map((field) => field.column))]
        if (columns.length === 0) throw new Error(`mapping ${loaded.ref.id} has no readable fields`)
        const valuesByColumn = new Map(columns.map((column) => [
          column,
          sourceRecords.map((record) => record[column] ?? null),
        ]))
        const physicalTypes: Record<string, string> = {}
        const queryColumns = columns.map((name) => {
          const resolved = columnType(valuesByColumn.get(name) ?? [])
          physicalTypes[name] = resolved.physicalType
          return { name, type: resolved.type }
        })
        const relation = `${object.schema}.${object.relation}`
        const registeredRelation: RegisteredRelation = {
          relation,
          objectRef: object.sourceObjectRef,
          schemaRevision: loaded.ref.digest,
          columns: queryColumns,
          physicalTypes,
        }
        const rows = sourceRecords.map((record) => columns.map((column) => record[column] ?? null))
        const prior = registeredByRelation.get(relation)
        if (prior !== undefined) {
          const priorRows = rowsByRelation.get(relation)
          if (
            sourceKey(prior.objectRef.sourceRef) !== sourceKey(registeredRelation.objectRef.sourceRef) ||
            prior.objectRef.objectPath !== registeredRelation.objectRef.objectPath ||
            canonicalJson(prior.columns) !== canonicalJson(registeredRelation.columns) ||
            canonicalJson(priorRows) !== canonicalJson(rows)
          ) {
            throw new Error(`physical relation ${relation} has conflicting schemas or raw source contents across mappings`)
          }
          continue
        }
        registeredByRelation.set(relation, registeredRelation)
        registered.push(registeredRelation)
        rowsByRelation.set(relation, rows)
      }
    }
  }

  const adapter = new DuckDbQueryAdapter({
    relations: registered,
    catalogSchemaRevision: 'core-example-snapshot@1',
    consistency: 'immutable',
    defaultLimits: { maxRows: 1_000, maxBytes: 1_048_576, maxDurationMs: 10_000 },
  })
  try {
    await adapter.start()
    for (const [relation, rows] of rowsByRelation) await adapter.materialiseRelation(relation, rows)
    return adapter
  } catch (error) {
    adapter.close()
    throw error
  }
}

class CorePublishedFactsProvider implements OntologyFactReferenceProvider {
  readonly #providers: ReadonlyMap<string, PublishedFactsReferenceProvider>

  constructor(providers: readonly { readonly namespace: string; readonly provider: PublishedFactsReferenceProvider }[]) {
    this.#providers = new Map(providers.map((entry) => [entry.namespace, entry.provider]))
  }

  async listFacts(query: OntologyFactQuery, ctx: ToolContext): Promise<OntologyFactPage> {
    const namespaces = [...new Set(query.concepts.map((concept) => concept.namespace))]
    if (namespaces.length !== 1) return { facts: [], nextCursor: null, covered: false, issues: ['one exact deployment namespace is required'] }
    const provider = this.#providers.get(namespaces[0] ?? '')
    if (provider === undefined) return { facts: [], nextCursor: null, covered: false, issues: ['the requested namespace has no published facts provider'] }
    return provider.listFacts(query, ctx)
  }
}

class CoreMultiSchemaPublishedSource implements MaterializationPublishedSource {
  readonly #sources: readonly MaterializationPublishedSource[]

  constructor(sources: readonly MaterializationPublishedSource[]) {
    this.#sources = sources
  }

  async load(scopeRef: ScopeRef, ctx: ToolContext): Promise<PublishedSemanticData> {
    const parts = await Promise.all(this.#sources.map((source) => source.load(scopeRef, ctx)))
    const firstRevision = parts[0]?.readRevision
    const sameRevision = firstRevision !== undefined && parts.every((part) =>
      part.readRevision?.semantic === firstRevision.semantic && part.readRevision.identity === firstRevision.identity,
    )
    const issues = parts.flatMap((part) => part.issues ?? [])
    if (!sameRevision) issues.push({ code: 'READ_REVISION_CHANGED', message: 'scenario snapshots did not share one semantic and identity revision vector' })
    return {
      facts: parts.flatMap((part) => part.facts),
      rules: parts.flatMap((part) => part.rules),
      entityBindings: parts.flatMap((part) => part.entityBindings),
      ...(sameRevision && firstRevision !== undefined ? { readRevision: firstRevision } : {}),
      historicalAsOfSupported: false,
      complete: sameRevision && parts.every((part) => part.complete === true),
      ...(parts.some((part) => part.identityBindings !== undefined)
        ? { identityBindings: parts.flatMap((part) => part.identityBindings ?? []) }
        : {}),
      ...(parts.some((part) => part.ruleIssues !== undefined)
        ? { ruleIssues: parts.flatMap((part) => part.ruleIssues ?? []) }
        : {}),
      ...(parts.some((part) => part.attributeIssues !== undefined)
        ? { attributeIssues: parts.flatMap((part) => part.attributeIssues ?? []) }
        : {}),
      ...(issues.length > 0 ? { issues } : {}),
    }
  }
}

function workerContext(
  scopeRef: ScopeRef,
  sourceRefs: readonly SourceRef[] = [],
  runId = WORKER_RUN_ID,
  resolvedProfileHash = sha256DigestOf('core-worker-profile'),
  clock: () => Date = () => new Date(),
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
      collectionRefs: [],
      domains: [],
      maxRows: 1_000,
    },
    traceId: `core-worker:${randomUUID()}`,
  })
}

class CoreFactsPlanResolver implements TemplatePlanResolver {
  readonly #runs: RunService
  readonly #profiles: ProfileResolver
  readonly #scenarios: readonly CoreExampleScenario[]

  constructor(runs: RunService, profiles: ProfileResolver, scenarios: readonly CoreExampleScenario[]) {
    this.#runs = runs
    this.#profiles = profiles
    this.#scenarios = scenarios
  }

  async resolve(planRef: ResourceRef | undefined, ctx: ToolContext) {
    const run = await this.#runs.getRun(ctx.runId, ctx)
    const { scenario, resolved, snapshotHash } = await resolveScenarioProfile(
      this.#profiles,
      this.#scenarios,
      run.profileRef,
      { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
      ctx,
      run.resolvedProfileHash,
    )
    if (!resolved.toolBindings.some((binding) => binding.toolId === 'ontology_lookup' && binding.enabled)) {
      throw new CoreCapabilityError('this profile does not enable ontology_lookup for facts tasks')
    }
    const plan = createCoreFactsPlan({
      scenario,
      runProfileRef: run.profileRef,
      resolvedProfileHash: snapshotHash,
      mappingRefs: resolved.mappingRefs,
      definitionRef: scenario.definitionRef,
      scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
      question: run.questionRewrite?.rewrittenQuestion ?? run.question,
    })
    if (planRef !== undefined && !sameResourceRef(planRef, plan.planRef)) {
      throw new TemplateRuntimeError('INVALID_PLAN', 'the checkpoint plan does not match this run’s immutable profile and facts request')
    }
    return { planRef: plan.planRef, spec: plan }
  }
}

const DISABLED_GENERATION: GenerationPort = {
  async *generate() {
    throw new CoreCapabilityError('the generative extraction model is not configured')
  },
}

export class CoreCapabilityError extends Error {
  readonly code = 'CAPABILITY_NOT_CONFIGURED'
  readonly httpStatus = 409

  constructor(message: string) {
    super(message)
    this.name = 'CoreCapabilityError'
  }
}

class CoreFactsRequestError extends Error {
  readonly code: string
  readonly httpStatus = 422

  constructor(error: CoreFactsPlanError) {
    super(error.message)
    this.name = 'CoreFactsRequestError'
    this.code = error.code
  }
}

function validateCoreFactsRequest(input: Parameters<typeof createCoreFactsPlan>[0]): void {
  try {
    createCoreFactsPlan(input)
  } catch (error) {
    if (error instanceof CoreFactsPlanError) throw new CoreFactsRequestError(error)
    throw error
  }
}

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: true })
  addFormats(ajv)
  for (const document of SCHEMA_DOCUMENTS) ajv.addSchema(document as SchemaObject)
  return ajv
}

function profileValidator(ajv: Ajv2020): ProfileSpecValidator {
  const validate = ajv.getSchema(`${CONTRACT_SCHEMA_BASE}/industry.schema.json#/$defs/ProfileSpec`)
  if (validate === undefined) throw new Error('the canonical ProfileSpec schema is unavailable')
  return (spec: unknown) => validate(spec)
    ? { valid: true, issues: [] }
    : {
        valid: false,
        issues: (validate.errors ?? []).map((error) => ({
          pointer: error.instancePath === '' ? '$' : error.instancePath,
          message: error.message ?? 'invalid',
        })),
      }
}

function manifestValidator(ajv: Ajv2020): ManifestValidator {
  const validate = ajv.getSchema(`${CONTRACT_SCHEMA_BASE}/component.schema.json#/$defs/ComponentManifest`)
  if (validate === undefined) throw new Error('the canonical ComponentManifest schema is unavailable')
  return (manifest: unknown) => validate(manifest)
    ? { valid: true, issues: [] }
    : {
        valid: false,
        issues: (validate.errors ?? []).map((error) => ({
          pointer: error.instancePath === '' ? '$' : error.instancePath,
          message: error.message ?? 'invalid',
        })),
      }
}

function terminologyOf(schema: IndustrySchema): MountedDefinitionTerminology {
  const attributes = schema.objects.flatMap((object) => object.attributes.map((attribute) => ({
    logicalId: attribute.attributeId,
    objectLogicalId: object.objectId,
    valueType: attribute.valueType,
    ...(attribute.unitCode === undefined ? {} : { unitCode: attribute.unitCode }),
    ...(attribute.dimension === undefined ? {} : { dimension: attribute.dimension }),
  })))
  const displayNames: Record<string, string> = {}
  for (const object of schema.objects) {
    displayNames[object.objectId] = object.displayName
    for (const attribute of object.attributes) displayNames[attribute.attributeId] = attribute.attributeId
  }
  for (const relation of schema.relations) displayNames[relation.relationId] = relation.relationId
  return {
    objectLogicalIds: schema.objects.map((object) => object.objectId),
    attributeLogicalIds: attributes.map((attribute) => attribute.logicalId),
    relationLogicalIds: schema.relations.map((relation) => relation.relationId),
    attributes,
    displayNames,
  }
}

/** Project the mounted industry packs into the professional terminology a workspace may build on. */
function terminologySourceFor(scenarios: readonly CoreExampleScenario[]): StaticDefinitionTerminologySource {
  return new StaticDefinitionTerminologySource(scenarios.map((scenario) => ({
    definitionRef: componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest),
    terminology: terminologyOf(scenario.industrySchema),
  })))
}

function toolSchemaValidator(ajv: Ajv2020): ToolSchemaValidator {
  const byRef = new Map<string, ValidateFunction>()
  return {
    validateRef(ref, value) {
      let validate = byRef.get(ref)
      if (validate === undefined) {
        validate = ajv.getSchema(ref)
        if (validate === undefined) throw new Error(`unknown canonical tool schema ref: ${ref}`)
        byRef.set(ref, validate)
      }
      return validate(value)
        ? { valid: true, issues: [] }
        : { valid: false, issues: (validate.errors ?? []).map((error) => ({ pointer: error.instancePath, reason: error.message ?? 'invalid' })) }
    },
    validateInline(schema, value) {
      const validate = ajv.compile(schema as SchemaObject)
      return validate(value)
        ? { valid: true, issues: [] }
        : { valid: false, issues: (validate.errors ?? []).map((error) => ({ pointer: error.instancePath, reason: error.message ?? 'invalid' })) }
    },
  }
}

function componentRef(kind: ComponentKind, id: string, digestSeed: unknown): VersionRef {
  return { id, version: COMPONENT_VERSION, digest: sha256DigestOf(canonicalJson({ kind, id, digestSeed })) }
}

function capability(name: string) {
  const supportedDataTypes: SupportedDataType[] = ['string', 'integer', 'decimal', 'boolean', 'timestamp', 'json']
  return {
    name,
    version: COMPONENT_VERSION,
    limits: { maxRows: 1_000, maxBytes: 1_048_576, maxDurationMs: 10_000, maxConcurrency: 1 },
    consistency: 'repeatable_read' as const,
    cancellation: 'supported' as const,
    pagination: 'cursor' as const,
    supportedDataTypes,
  }
}

function componentRecord(input: {
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

function profileSpecFor(scenario: CoreExampleScenario, dataBackendRef: VersionRef): ProfileSpec {
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
    toolBindings: TOOL_CATALOGUE.map((tool) => ({
      toolId: tool.toolId,
      enabled: tool.toolId === 'ontology_lookup',
      ...(tool.toolId === 'ontology_lookup' ? { maxCallsPerRun: 4 } : {}),
    })),
    computeBindings: [],
    policyRef: CORE_POLICY_REF,
  }
}

function componentRegistrationInput(record: ComponentVersionRecord, now: string): ComponentRegistrationRecordInput {
  return {
    record,
    artifactRef: {
      id: stableUuid(`component-artifact:${record.manifest.kind}:${record.manifest.id}:${record.manifest.version}`),
      version: record.manifest.version,
      digest: record.manifest.digest,
      kind: 'artifact',
    },
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

function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function scenarioForIndustryRef(
  scenarios: readonly CoreExampleScenario[],
  industryRef: VersionRef,
): CoreExampleScenario | undefined {
  return scenarios.find((scenario) => sameVersionRef(
    industryRef,
    componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest),
  ))
}

async function resolveScenarioProfile(
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

export interface CoreLocalCompositionOptions {
  readonly databaseUrl: string
  readonly objectDirectory: string
  readonly scopeRef: ScopeRef
  readonly examples: LoadedCoreExamples
  readonly allowLocalOperator?: boolean
  readonly modelsEnabled?: boolean
  readonly jevEnabled?: boolean
  /** Server-side model configuration. The browser process never receives this object. */
  readonly modelEnvironment?: Readonly<Record<string, string | undefined>>
  /** Injectable host clock for deadline/recovery verification; production defaults to wall time. */
  readonly clock?: () => Date
  /** Test/host observer. The default logs no payload text. */
  readonly onWorkerError?: (error: unknown) => void
  readonly logger?: boolean
}

export interface CoreLocalComposition {
  readonly dependencies: CoreApiDependencies
  close(): Promise<void>
}

function sameResourceRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function registerCoreImportRoute(input: {
  readonly app: FastifyInstance
  readonly authenticate: RequestAuthenticator
  readonly scopeRef: ScopeRef
  readonly examples: LoadedCoreExamples
  readonly service: JobService
  readonly objectStore: FileSystemObjectStore
  readonly registry: PostgresArtifactRegistry
  readonly generationEnabled: boolean
}): void {
  input.app.post('/api/v1/core/imports', async (request, reply) => {
    const auth = input.authenticate(request)
    if (auth === undefined) return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'loopback development authentication is required', retryable: false } })
    if (!auth.principal.roles.includes('data-editor') && !auth.principal.roles.includes('platform-admin')) {
      throw new ForbiddenError('raw document import requires the explicit local operator role')
    }
    if (!isRecord(request.body)) throw new InvalidRequestFieldError('the request body must be a JSON object')
    const scenarioId = request.body['scenarioId']
    const sourceId = request.body['sourceId']
    const content = request.body['content']
    if (typeof scenarioId !== 'string' || typeof sourceId !== 'string' || typeof content !== 'string') {
      throw new InvalidRequestFieldError('scenarioId, sourceId and content are required strings')
    }
    const scenario = input.examples.scenarios.find((entry) => entry.scenarioId === scenarioId)
    if (scenario === undefined) throw new InvalidRequestFieldError('scenarioId is not mounted by this deployment')
    const source = scenario.rawSources.find((entry) => entry.sourceRef.sourceId === sourceId)
    if (source === undefined) throw new InvalidRequestFieldError('sourceId is not a declared raw source for this scenario')
    const bytes = new TextEncoder().encode(content)
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMPORTED_BYTES) {
      throw new InvalidRequestFieldError(`content must be between 1 byte and ${String(MAX_IMPORTED_BYTES)} bytes`)
    }
    let records: Record<string, ScalarValue>[]
    try {
      records = parseJsonRecordBlocks(content, 'import content')
    } catch {
      if (!input.generationEnabled) {
        throw new CoreCapabilityError('this local profile accepts native JSON records only; generative extraction is not configured')
      }
      records = []
    }
    const nativeRows = records.filter((record) => mapNativeEntities(scenario.industrySchema, record).length > 0)
    if ((records.length === 0 || nativeRows.length !== records.length) && !input.generationEnabled) {
      throw new CoreCapabilityError('this local profile accepts native JSON records only; generative extraction is not configured')
    }

    const requestId = request.headers['idempotency-key']
    const idempotencyKey = Array.isArray(requestId) ? requestId[0] : requestId
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 256) {
      throw new InvalidRequestFieldError('Idempotency-Key must be between 8 and 256 characters')
    }
    const rawKey = `${input.scopeRef.tenantId}:${input.scopeRef.spaceId}:${sourceKey(source.sourceRef)}:${sha256DigestOf(content)}:${idempotencyKey}`
    const jobId = globalThis.crypto.randomUUID()
    const ctx = createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId: request.id,
      runId: jobId,
    })
    const deterministicBlobs = new LocalImmutableBlobStore({
      objectStore: input.objectStore,
      registry: input.registry,
      idFactory: () => stableUuid(`import-blob:${rawKey}`),
    })
    const staged = await deterministicBlobs.stage(bytes, { scopeRef: input.scopeRef }, ctx)
    const original = await deterministicBlobs.publish({
      scopeRef: input.scopeRef,
      contentDigest: staged.contentDigest,
      mediaType: source.mediaType,
      byteSize: staged.byteSize,
      purpose: 'document',
      origin: { sourceRef: source.sourceRef, scenarioId, importKey: idempotencyKey },
    }, ctx)
    const documentVersionRef: ResourceRef = {
      id: stableUuid(`document-version:${rawKey}`),
      version: COMPONENT_VERSION,
      digest: staged.contentDigest,
      kind: 'document',
    }
    const documentRef = encodeDocumentIngestionRef({
      kind: 'document_ingestion',
      originalRef: original.blobRef,
      parserVersion: COMPONENT_VERSION,
      definitionRef: scenario.definitionRef,
      documentVersionRef,
    })
    const created = await input.service.createJob({
      jobId,
      kind: 'ingestion',
      sourceRef: `${source.sourceRef.namespace}/${source.sourceRef.sourceId}`,
      documentRef,
      pipelineVersion: COMPONENT_VERSION,
      idempotencyKey,
    }, ctx)
    return reply.status(202).send({
      data: { jobId: created.jobId, stage: created.stage, scenarioId, sourceRef: source.sourceRef },
      meta: { traceId: request.id, revision: created.revision },
    })
  })
}

class CoreInputValidity implements InputValidityPort {
  readonly #evidence: PostgresEvidenceStore
  readonly #scopeRef: ScopeRef

  constructor(evidence: PostgresEvidenceStore, scopeRef: ScopeRef) {
    this.#evidence = evidence
    this.#scopeRef = scopeRef
  }

  async validate(entries: Parameters<InputValidityPort['validate']>[0], ctx: ToolContext) {
    const staleEntries: { readonly entryId: Uuid; readonly reason: string }[] = []
    for (const entry of entries) {
      if (entry.kind !== 'evidence' || entry.ref === undefined) continue
      const record = await this.#evidence.get(this.#scopeRef, entry.ref.id, ctx)
      if (record === undefined || !sameResourceRef(record.evidenceRef, entry.ref)) {
        staleEntries.push({ entryId: entry.entryId, reason: 'evidence_not_visible' })
      }
    }
    return { valid: staleEntries.length === 0, staleEntries }
  }
}

class CorePublicationValidity implements PublicationValidityPort {
  readonly #evidence: PostgresEvidenceStore
  readonly #artifacts: LocalImmutableBlobStore
  readonly #facts: CorePublishedFactsProvider
  readonly #scopeRef: ScopeRef

  constructor(input: {
    readonly evidence: PostgresEvidenceStore
    readonly artifacts: LocalImmutableBlobStore
    readonly facts: CorePublishedFactsProvider
    readonly scopeRef: ScopeRef
  }) {
    this.#evidence = input.evidence
    this.#artifacts = input.artifacts
    this.#facts = input.facts
    this.#scopeRef = input.scopeRef
  }

  async check(request: PublicationValidityRequest, ctx: ToolContext): Promise<PublicationValidityReport> {
    const details: string[] = []
    const blockedReasons: PublicationValidityReport['blockedReasons'][number][] = []
    for (const evidenceRef of request.evidenceRefs) {
      const record = await this.#evidence.get(this.#scopeRef, evidenceRef.id, ctx)
      if (record === undefined || !sameResourceRef(record.evidenceRef, evidenceRef)) {
        blockedReasons.push('evidence_retracted')
        details.push(`evidence ${evidenceRef.id} is no longer visible`)
        continue
      }
      const payloadRef = record.envelope.payloadRef
      if (payloadRef === undefined) {
        blockedReasons.push('evidence_unverifiable')
        details.push(`evidence ${evidenceRef.id} has no immutable result payload`)
        continue
      }
      try {
        const authorized = await this.#artifacts.getAuthorized({ scopeRef: this.#scopeRef, blobRef: payloadRef }, ctx)
        if (!authorized.integrityVerified) throw new Error('blob integrity was not verified')
        const bytes = await this.#artifacts.readAuthorized({ scopeRef: this.#scopeRef, blobRef: payloadRef }, ctx)
        const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (!isRecord(payload) || !Array.isArray(payload['items'])) throw new Error('evidence payload is not an ontology lookup result')
        const items = payload['items']
        const factItems = items.filter((item) => isRecord(item) && item['kind'] === 'fact')
        if (factItems.length !== items.length || factItems.length === 0) throw new Error('evidence does not contain only published facts')
        const first = factItems[0]
        if (!isRecord(first) || !isRecord(first['conceptRef']) || typeof first['conceptRef']['namespace'] !== 'string') {
          throw new Error('fact evidence has no exact concept namespace')
        }
        const namespace = first['conceptRef']['namespace']
        const concepts: { namespace: string; conceptId: string; definitionVersion?: string }[] = []
        for (const item of factItems) {
          if (!isRecord(item) || !isRecord(item['conceptRef']) || typeof item['conceptRef']['conceptId'] !== 'string' || item['conceptRef']['namespace'] !== namespace) {
            throw new Error('fact evidence mixed concept namespaces or lacked a typed concept reference')
          }
          const definitionVersion = item['conceptRef']['definitionVersion']
          concepts.push({
            namespace,
            conceptId: item['conceptRef']['conceptId'],
            ...(typeof definitionVersion === 'string' ? { definitionVersion } : {}),
          })
        }
        const page = await this.#facts.listFacts({
          scopeRef: this.#scopeRef,
          concepts: [...new Map(concepts.map((concept) => [concept.conceptId, concept])).values()],
          entityRefs: [],
          limit: 10_000,
          validAt: record.envelope.observedAt,
        }, ctx)
        if (!page.covered || page.nextCursor !== null) {
          blockedReasons.push('data_stale')
          details.push(`published fact evidence ${evidenceRef.id} no longer has a complete source view`)
          continue
        }
        const current = page.facts.map((fact) => ({
          kind: 'fact',
          ref: fact.factRef,
          conceptRef: fact.conceptRef,
          ...(fact.label === undefined ? {} : { label: fact.label }),
          ...(fact.validity === undefined ? {} : { validity: fact.validity }),
          ...(fact.payload === undefined ? {} : { payload: fact.payload }),
        })).sort((left, right) => left.ref.id.localeCompare(right.ref.id))
        const previous = factItems.map((item) => item).sort((left, right) => {
          const leftRef = isRecord(left) && isRecord(left['ref']) && typeof left['ref']['id'] === 'string' ? left['ref']['id'] : ''
          const rightRef = isRecord(right) && isRecord(right['ref']) && typeof right['ref']['id'] === 'string' ? right['ref']['id'] : ''
          return leftRef.localeCompare(rightRef)
        })
        if (canonicalJson(current) !== canonicalJson(previous)) {
          blockedReasons.push('data_stale')
          details.push(`published facts changed after evidence ${evidenceRef.id} was collected`)
        }
      } catch {
        blockedReasons.push('evidence_unverifiable')
        details.push(`evidence ${evidenceRef.id} could not be revalidated against its source`)
      }
    }
    const unique = [...new Set(blockedReasons)]
    return { publishable: unique.length === 0, blockedReasons: unique, historyLimited: false, details }
  }
}

class CoreFactsOutboxFallback implements OutboxConsumer {
  readonly topics = ['extraction.candidates.produced'] as const
  readonly #candidates: CandidateStore
  readonly #scopeRef: ScopeRef

  constructor(candidates: CandidateStore, scopeRef: ScopeRef) {
    this.#candidates = candidates
    this.#scopeRef = scopeRef
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    if (message.topic !== this.topics[0] || !isRecord(message.payload)) throw new Error('unregistered Core outbox topic')
    const candidateCount = message.payload['candidateCount']
    if (message.payload['jobId'] !== message.jobId || typeof candidateCount !== 'number' || !Number.isSafeInteger(candidateCount)) {
      throw new Error('candidate-produced event is malformed')
    }
    const counts = await this.#candidates.countCandidates(this.#scopeRef, message.jobId, ctx)
    if (counts.total !== candidateCount) throw new Error('candidate-produced event does not match durable candidate rows')
  }
}

class UnsupportedOutboxConsumer implements OutboxConsumer {
  consume(message: OutboxMessageRecord, _ctx: ToolContext): Promise<void> {
    void _ctx
    return Promise.reject(new Error(`no Core outbox consumer is registered for ${message.topic}`))
  }
}

/**
 * Acknowledge the industry-workspace lifecycle topics. The workspace write already committed
 * the workspace row and the immutable draft revision in the same transaction as the outbox
 * row, so the consumer only re-verifies that the referenced revision is durably visible
 * before acking; it creates no state and never revives a workspace the source transaction
 * did not commit.
 */
class IndustryWorkspaceOutboxConsumer implements OutboxConsumer {
  readonly topics = [
    INDUSTRY_WORKSPACE_CREATED_TOPIC,
    INDUSTRY_WORKSPACE_DRAFT_APPENDED_TOPIC,
  ] as const
  readonly #store: IndustryWorkspaceStore
  readonly #scopeRef: ScopeRef

  constructor(store: IndustryWorkspaceStore, scopeRef: ScopeRef) {
    this.#store = store
    this.#scopeRef = scopeRef
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    if (!isRecord(message.payload)) throw new Error('industry workspace outbox payload is malformed')
    const workspaceId = message.payload['workspaceId']
    const revision = message.payload['revision']
    if (typeof workspaceId !== 'string' || typeof revision !== 'string') {
      throw new Error('industry workspace outbox payload is malformed')
    }
    const workspace = await this.#store.getWorkspace(this.#scopeRef, workspaceId, ctx)
    if (workspace === undefined) {
      throw new Error('industry workspace outbox references an unknown workspace')
    }
    const draft = await this.#store.getDraft(this.#scopeRef, workspaceId, revision, ctx)
    if (draft === undefined) {
      throw new Error('industry workspace outbox references an unknown draft revision')
    }
  }
}

/**
 * Acknowledge the `asset.pack.published` lifecycle topic. The publication transaction already
 * committed the immutable pack row, the definition version and the outbox row atomically, so the
 * consumer only re-verifies that the referenced pack is durably visible before acking; it creates
 * no state and never revives a publication the source transaction did not commit.
 */
class PackPublicationOutboxConsumer implements OutboxConsumer {
  readonly topics = [PACK_PUBLISHED_TOPIC] as const
  readonly #store: PostgresPublishedPackAssetStore
  readonly #scopeRef: ScopeRef

  constructor(store: PostgresPublishedPackAssetStore, scopeRef: ScopeRef) {
    this.#store = store
    this.#scopeRef = scopeRef
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    if (!isRecord(message.payload)) throw new Error('asset pack publication outbox payload is malformed')
    const packId = message.payload['packId']
    const version = message.payload['version']
    if (typeof packId !== 'string' || typeof version !== 'string') {
      throw new Error('asset pack publication outbox payload is malformed')
    }
    const asset = await this.#store.findPack(this.#scopeRef, packId, version, ctx)
    if (asset === undefined) {
      throw new Error('asset pack publication outbox references an unknown published pack')
    }
  }
}

/**
 * Acknowledge the `project.*` lifecycle topics. The project write already committed the project
 * head and the immutable revision in the same transaction as the outbox row, so the consumer only
 * re-verifies the referenced revision is durably visible before acking; it creates no state.
 */
class ProjectRevisionOutboxConsumer implements OutboxConsumer {
  readonly topics = [PROJECT_CREATED_TOPIC, PROJECT_REVISION_APPENDED_TOPIC] as const
  readonly #store: ProjectStore
  readonly #scopeRef: ScopeRef

  constructor(store: ProjectStore, scopeRef: ScopeRef) {
    this.#store = store
    this.#scopeRef = scopeRef
  }

  async consume(message: OutboxMessageRecord, ctx: ToolContext): Promise<void> {
    if (!isRecord(message.payload)) throw new Error('project outbox payload is malformed')
    const projectId = message.payload['projectId']
    const revision = message.payload['revision']
    if (typeof projectId !== 'string' || typeof revision !== 'string') {
      throw new Error('project outbox payload is malformed')
    }
    const stored = await this.#store.getRevision(this.#scopeRef, projectId, revision, ctx)
    if (stored === undefined) {
      throw new Error('project outbox references an unknown project revision')
    }
  }
}

function sourceRefsOf(scenario: CoreExampleScenario): SourceRef[] {
  const refs = [
    ...scenario.rawSources.map((source) => source.sourceRef),
    scenario.syntheticPolicy.sourceRef,
    ...scenario.physicalMappings.flatMap((mapping) => mapping.mapping.objects.map((object) => object.sourceObjectRef.sourceRef)),
  ]
  return [...new Map(refs.map((ref) => [sourceKey(ref), ref])).values()]
}

export async function createCoreLocalComposition(options: CoreLocalCompositionOptions): Promise<CoreLocalComposition> {
  const database = new ControlPostgresDatabase({
    connectionString: options.databaseUrl,
    maxPoolSize: 16,
    applicationName: 'ontology-core-local-api',
    connectionTimeoutMs: 5_000,
  })
  const cleanup: (() => Promise<void>)[] = [() => database.close()]
  let dispatchAbort: AbortController | undefined
  let jobLoopAbort: AbortController | undefined
  let jobLoop: JobWorkerLoop | undefined
  let jobLoopPromise: Promise<void> | undefined
  let dispatchWorkerPromise: Promise<void> | undefined
  const activeRunIds = new Set<Uuid>()
  let controller: WorkflowController | undefined

  try {
    await database.queryUnscoped('SELECT 1')
    const objectStore = new FileSystemObjectStore(options.objectDirectory)
    await objectStore.init()
    const artifactRegistry = new PostgresArtifactRegistry({ connectionString: options.databaseUrl, maxPoolSize: 8 })
    cleanup.unshift(() => artifactRegistry.close())
    const blobStore = new LocalImmutableBlobStore({ objectStore, registry: artifactRegistry })
    const parseStore = new PostgresDocumentParseStore({
      connectionString: options.databaseUrl,
      maxPoolSize: 8,
      applicationName: 'ontology-core-local-document-parser',
    })
    cleanup.unshift(() => parseStore.close())
    const structuredStore = new PostgresStructuredIngestionStore({
      connectionString: options.databaseUrl,
      maxPoolSize: 4,
      applicationName: 'ontology-core-local-structured-ingestion',
    })
    cleanup.unshift(() => structuredStore.close())
    const keywordIndexStore = new PostgresKeywordIndexStore({
      connectionString: options.databaseUrl,
      maxPoolSize: 8,
      applicationName: 'ontology-core-local-bm25',
    })
    cleanup.unshift(() => keywordIndexStore.close())

    const scopeRef = options.scopeRef
    const hostClock = options.clock ?? (() => new Date())
    const allSourceRefs = [...new Map(options.examples.scenarios.flatMap(sourceRefsOf).map((ref) => [sourceKey(ref), ref])).values()]
    const profileContext = workerContext(scopeRef, allSourceRefs, WORKER_RUN_ID, sha256DigestOf('core-bootstrap-profile'), hostClock)
    const control = new ControlPostgresRepository(database)
    const componentStore = new PostgresComponentRegistryStore(database)
    const profileStore = new PostgresProfileStore(database)
    const runStore = new PostgresRunStore(database)
    const jobStore = new PostgresJobStore(database)
    const workspaceStore = new PostgresAssetWorkspaceStore(database)
    const candidateStore = new PostgresCandidateStore(database)
    const assetCandidateStore = new PostgresAssetCandidateStore(database)
    const ruleActionCandidateStore = new PostgresRuleActionCandidateStore(database)
    const definitionEditingStore = new PostgresDefinitionEditingStore(database)
    const instanceReviewStore = new PostgresInstanceReviewStore(database)
    const syntheticExampleSetStore = new PostgresSyntheticExampleSetStore(database)
    const validationReportStore = new PostgresIndustryValidationReportStore(database)
    const publishedPackStore = new PostgresPublishedPackAssetStore(database)
    const projectStore = new PostgresProjectStore(database)
    const projectReadinessStore = new PostgresProjectReadinessStore(database)
    const projectMappingStore = new PostgresProjectMappingStore(database)
    const projectRecordStore = new PostgresProjectRecordStore(database)
    const identityStore = new PostgresIdentityDecisionStore(database)
    const publicationStore = new PostgresSemanticPublicationStore(database)
    const definitionStore = new PostgresSemanticDefinitionStore(database)
    const workflowStore = new PostgresWorkflowStore(database)
    const evidenceStore = new PostgresEvidenceStore(database)
    const decisionStateReferences = new PostgresDecisionStateReferenceStore(database)
    const answerStore = new PostgresAnswerStore(database, { requireWorkflowDispatchFence: true })
    const dispatchStore = new PostgresWorkflowDispatchStore(database)
    const budget = new BudgetService({ store: new PostgresBudgetLedgerStore(database), control })
    const modelEnvironment: Readonly<Record<string, string | undefined>> = {
      ...(options.modelEnvironment ?? process.env),
      CORE_ENABLE_MODELS: options.modelsEnabled === true ? 'true' : 'false',
      CORE_ENABLE_JEV: options.jevEnabled === true ? 'true' : 'false',
    }
    const modelEvidence = createCoreModelEvidenceRecorders({ evidence: evidenceStore, blobs: blobStore, scopeRef })
    const decisionStateRefProvider = createCoreDecisionStateRefProvider({
      objectStore,
      artifactRegistry,
      references: decisionStateReferences,
      scopeRef,
    })
    const jevStateResolver = createCoreJevActualStateResolver({
      blobStore,
      stateRefAuthorizer: {
        isApproved: (input, ctx) => decisionStateReferences.isApproved(scopeRef, input, ctx),
      },
    })
    const extractionSchemaValidator = {
      async validate(schemaRef: VersionRef, candidate: unknown) {
        if (sameVersionRef(schemaRef, EXTRACTION_RESPONSE_SCHEMA_REF)) {
          try {
            parseModelCandidates(canonicalJson(candidate))
            return { valid: true }
          } catch {
            return { valid: false, errors: ['extraction response did not match the registered candidate contract'] }
          }
        }
        if (sameVersionRef(schemaRef, TBOX_RESPONSE_SCHEMA_REF)) {
          try {
            parseDefinitionCandidateOutput(canonicalJson(candidate))
            return { valid: true }
          } catch {
            return { valid: false, errors: ['definition candidate response did not match the registered generator contract'] }
          }
        }
        return { valid: false, errors: ['unknown model response schema'] }
      },
    }
    const modelCapabilities = createCoreModelCapabilityFactory({
      env: modelEnvironment,
      secrets: createEnvSecretResolver({ env: modelEnvironment }),
      budget,
      generationEvidence: modelEvidence.generation,
      decisionEvidence: modelEvidence.decision,
      decisionStateResolver: jevStateResolver,
      schemaValidator: extractionSchemaValidator,
    })
    const schemaSource = schemaSourceFor(options.examples.scenarios)
    const semanticDefinitions = new SemanticDefinitionService({ control, store: definitionStore })
    const profileValidatorImpl = profileValidator(createAjv())
    const industrySource = new StoreBackedIndustryManifestSource({
      store: publishedPackStore,
      fallback: industrySourceFor(options.examples.scenarios),
    })
    const profileResolver = new ProfileResolver({
      control,
      store: profileStore,
      registry: componentStore,
      industry: industrySource,
      validator: profileValidatorImpl,
    })
    const sources = new SourceRegistry({
      control,
      store: createPostgresSourceStore(database),
      secrets: createEnvSecretResolver(),
      adapters: createStaticProbeAdapterResolver([]),
    })

    const componentRecords = scenarioComponentRecords(options.examples.scenarios, new Date().toISOString())
    const bootstrapProfileSpecsByScenario = Object.fromEntries(options.examples.scenarios.map((scenario) => [
      scenario.scenarioId,
      profileSpecFor(scenario, DATA_DUCKDB_ADAPTER_REF),
    ]))
    await registerComponents(componentStore, componentRecords, scopeRef, profileContext)
    await registerProfiles(profileResolver, options.examples.scenarios, scopeRef, profileContext, bootstrapProfileSpecsByScenario)

    const profileRefsByScenario: Record<string, ProfileRef> = {}
    const profileSpecsByScenario: Record<string, ProfileSpec> = {}
    const availableTasksByScenario: Record<string, readonly string[]> = {}
    for (const mountedScenario of options.examples.scenarios) {
      const active = await profileResolver.getActiveProfile(scopeRef, mountedScenario.profileRef.id, profileContext)
      const activeProfileRef = active?.profileRef ?? mountedScenario.profileRef
      const record = await profileResolver.getProfileVersion({ scopeRef, profileRef: activeProfileRef }, profileContext)
      const selectedScenario = scenarioForIndustryRef(options.examples.scenarios, record.spec.industryRef)
      if (selectedScenario === undefined) {
        throw new CoreCapabilityError(`active profile ${activeProfileRef.id}@${activeProfileRef.version} pins an unmounted industry package`)
      }
      profileRefsByScenario[mountedScenario.scenarioId] = activeProfileRef
      profileSpecsByScenario[mountedScenario.scenarioId] = record.spec
      availableTasksByScenario[mountedScenario.scenarioId] = schemasByScenario([selectedScenario])[selectedScenario.scenarioId] ?? []
    }
    for (const scenario of options.examples.scenarios) {
      const published = await semanticDefinitions.publish(scenario.definitionDraft, profileContext)
      if (published.ref.digest !== scenario.definitionRef.digest) {
        throw new Error(`published definition digest differs from mounted scenario ${scenario.scenarioId}`)
      }
    }

    const mappings = new InMemorySemanticMappingRegistry(options.examples.scenarios.flatMap((scenario) =>
      scenario.physicalMappings.map((mapping) => mapping.mapping),
    ))
    const duckDb = await createDuckDbSnapshot(options.examples.scenarios)
    cleanup.unshift(async () => duckDb.close())
    const documentSpanReader = new DocumentSpanReader({ blobs: blobStore, store: parseStore })
    const documentSearch = new Bm25DocumentSearchService({ indexStore: keywordIndexStore, spanReader: documentSpanReader })
    const projectDocumentStore = new PostgresProjectDocumentStore(database)
    const projectDocumentIndexService = new ProjectDocumentIndexService({
      store: projectDocumentStore,
      parseStore,
      indexStore: keywordIndexStore,
      spanReader: documentSpanReader,
      projects: projectStore,
      readiness: projectReadinessStore,
    })
    const publishedSourceList = options.examples.scenarios.map((scenario) => new PublishedSemanticSource(
      publicationStore,
      { identity: identityStore, definitionRef: scenario.definitionRef },
    ))
    const multiSchemaSource = new CoreMultiSchemaPublishedSource(publishedSourceList)
    const factsProviders = options.examples.scenarios.map((scenario, index) => ({
      namespace: scenario.namespace,
      provider: new PublishedFactsReferenceProvider({
        source: publishedSourceList[index]!,
        namespace: scenario.namespace,
        definitionRef: scenario.definitionRef,
      }),
    }))
    const facts = new CorePublishedFactsProvider(factsProviders)
    const lookup = new OntologyLookupService({ definitions: semanticDefinitions, mappings, facts, pageSize: 50, maxPageSize: 200 })
    const lookupHandler = new OntologyLookupHandler({ lookup, sourceRef: FACTS_SOURCE_REF, dataMode: 'synthetic' })
    const dataQueryHandler = new DataQueryHandler({
      query: duckDb,
      catalog: duckDb,
      mappings,
      consistency: 'immutable',
      dataMode: 'synthetic',
      catalogSourceRef: { namespace: 'ontology-core-local', sourceId: 'duckdb-synthetic-snapshot' },
    })
    const documentSearchHandler = createBm25DocumentSearchToolHandler({ service: documentSearch })
    const gatewayComposition = createToolGatewayComposition({
      database,
      blobStore,
      budget,
      validator: toolSchemaValidator(createAjv()),
      handlers: [lookupHandler, dataQueryHandler, documentSearchHandler],
    })

    const runProfileBinder = {
      bindProfileForRun: (profileRef: ProfileRef, trustedScope: ScopeRef, ctx: ToolContext) =>
        profileResolver.bindRunProfile(profileRef, trustedScope, ctx),
    } satisfies RunProfileBinder
    const runProgress = new RunProgressService({
      profiles: profileStore,
      binder: runProfileBinder,
      manifests: workflowStore,
      budget,
    })
    const runs = new RunService({
      store: runStore,
      control,
      profiles: runProfileBinder,
    })
    const phase = new RunPhaseDriver({ store: runStore, control })
    const dispatchFences = new Map<Uuid, WorkflowDispatchFence>()
    const runtimeRecord = componentRecords.find((record) => record.manifest.kind === 'runtime' && record.manifest.id === 'runtime-template')
    if (runtimeRecord === undefined) throw new Error('Core template runtime component is not registered')
    const runtime = new TemplateRuntimeAdapter({ manifest: runtimeRecord.manifest, plans: new CoreFactsPlanResolver(runs, profileResolver, options.examples.scenarios) })
    const controllerDependencies = {
      runs,
      phase,
      budget,
      manifests: workflowStore,
      runtimes: {
        select: async (runtimeRef: VersionRef) => {
          if (runtimeRef.id !== runtimeRecord.manifestRef.id || runtimeRef.version !== runtimeRecord.manifestRef.version || runtimeRef.digest !== runtimeRecord.manifestRef.digest) {
            throw new CoreCapabilityError('this local deployment registers only runtime-template@1.0.0')
          }
          return runtime
        },
      } satisfies RuntimeSelectorPort,
      capabilities: {
        async forRun(binding: RuntimeCapabilityContext, ctx: ToolContext) {
          if (binding.signal === undefined) {
            throw new CoreCapabilityError('runtime capabilities require the controller execution AbortSignal')
          }
          const run = await runs.getRun(binding.runId, ctx)
          const resolved = await profileResolver.getResolvedProfile({
            scopeRef: { tenantId: scopeRef.tenantId, spaceId: scopeRef.spaceId },
            profileRef: run.profileRef,
            snapshotHash: binding.resolvedProfileRef.snapshotHash,
          }, ctx)
          const gateway = gatewayComposition.forRun({
            runId: binding.runId,
            ledgerId: binding.budgetLedgerId,
            resolvedProfile: resolved.resolved,
            operations: operationRegistry(),
          })
          const modelExecution = modelCapabilities.forExecution({
            ledgerId: binding.budgetLedgerId,
            signal: binding.signal,
          })
          return {
            gateway,
            generation: modelExecution.generation ?? DISABLED_GENERATION,
            decision: modelExecution.decision ?? disabledDecision(),
            checkpoints: createRunCheckpointPort(runStore),
          } satisfies RuntimeCapabilitySet
        },
      } satisfies RuntimeCapabilityFactoryPort,
      draftWriter: new PublishedFactsDraftWriter({ evidence: evidenceStore, artifacts: blobStore }),
      limited: new RestrictedLimitedAnswerComposer(),
      verifier: new DraftVerificationService({
        evidence: evidenceStore,
        artifacts: blobStore,
        decisionStateRefProvider,
        policy: { ...DEFAULT_VERIFICATION_POLICY, semanticReview: 'disabled' },
      }),
      verifications: workflowStore,
      publisher: new AnswerPublicationService({
        runs: runStore,
        answers: answerStore,
        verifications: workflowStore,
        manifests: workflowStore,
        validity: new CorePublicationValidity({ evidence: evidenceStore, artifacts: blobStore, facts, scopeRef }),
      }),
      validity: new CoreInputValidity(evidenceStore, scopeRef),
      publicationFence: async (runId: Uuid) => dispatchFences.get(runId),
    }
    controller = new WorkflowController(controllerDependencies)

    const workerDispatchContextForOperation = () => workerContext(
      scopeRef,
      allSourceRefs,
      WORKER_RUN_ID,
      sha256DigestOf('core-dispatch-worker'),
      hostClock,
    )
    const workflowDispatchWorker = new WorkflowDispatchWorker({
      dispatch: dispatchStore,
      controller,
      dispatchContext: workerDispatchContextForOperation(),
      dispatchContextFactory: workerDispatchContextForOperation,
      contextForRun: async (runId) => {
        const runContext = workerDispatchContextForOperation()
        const run = await runs.getRun(runId, runContext)
        const { scenario } = await resolveScenarioProfile(
          profileResolver,
          options.examples.scenarios,
          run.profileRef,
          scopeRef,
          runContext,
          run.resolvedProfileHash,
        )
        return workerContext(scopeRef, sourceRefsOf(scenario), runId, run.resolvedProfileHash, hostClock)
      },
      onFenceChange(runId, fence) {
        if (fence === undefined) {
          dispatchFences.delete(runId)
          activeRunIds.delete(runId)
        } else {
          dispatchFences.set(runId, fence)
          activeRunIds.add(runId)
        }
      },
      onError(error) {
        options.onWorkerError?.(error)
        process.stderr.write('[core-worker] workflow dispatch cycle failed\n')
      },
    })

    const jobService = new JobService({ store: jobStore })
    const industryWorkspaceService = new IndustryWorkspaceService({ store: workspaceStore, jobs: jobStore })
    const parser: DocumentParserPort = new LocalDocumentExtractionService({ blobs: blobStore, store: parseStore })
    const pipeline = new ExtractionPipeline({
      schemaSource,
      accountingOwner: 'adapter',
      generationForRun: ({ ledgerId, signal }) => modelCapabilities.forExecution({ ledgerId, signal }).generation,
      candidates: candidateStore,
      budget,
      modelRef: {
        modelId: options.modelsEnabled === true ? modelEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID'] ?? 'model-not-configured' : 'model-not-configured',
        version: COMPONENT_VERSION,
      },
      outputLimit: { maxTokens: 2_048 },
    })
    const structuredExtractionService = new StructuredExtractionService({
      schemaSource,
      candidates: candidateStore,
      ingestion: structuredStore,
      originals: {
        read: (request, ctx) => {
          const target = request.approvedInputRefs[0]
          if (target === undefined) throw new Error('the structured extraction request carried no approved input reference')
          return blobStore.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: target }, ctx)
        },
      } satisfies ScopedArtifactReader,
      parser: new StructuredDocumentParser(),
    })
    const handlers = createIngestionHandlerRegistry({
      parser,
      structured: new LocalStructuredIngestionService({ blobs: blobStore, store: structuredStore }),
      structuredExtraction: new StructuredExtractionStageHandler({ extraction: structuredExtractionService }),
      downstream: [
        new ExtractionStageHandler({ pipeline, parseStore }),
        new CandidateValidationStageHandler({ pipeline, parseStore }),
        new ReviewHandoffStageHandler(),
      ],
    })
    const jobWorker = new JobWorker({
      store: jobStore,
      handlers,
      budget,
      workerId: 'core-local-ingestion-worker',
      now: () => hostClock().toISOString(),
      contextForJob: (job) => {
        const scenario = options.examples.scenarios.find((candidate) =>
          candidate.rawSources.some((source) => `${source.sourceRef.namespace}/${source.sourceRef.sourceId}` === job.sourceRef),
        )
        return workerContext(
          scopeRef,
          scenario === undefined ? [] : sourceRefsOf(scenario),
          job.jobId,
          scenario?.definitionRef.digest ?? sha256DigestOf(`unmounted-ingestion-job:${job.jobId}`),
          hostClock,
        )
      },
    })
    const materializationStore = new PostgresMaterializationStore(database)
    const materializer = new IncrementalMaterializer({ publishedSource: multiSchemaSource, materialization: materializationStore })
    const materializationConsumer = new MaterializationOutboxConsumer({
      materializer,
      publications: publicationStore,
      sequence: controlRecordSequence(control, 'semantic.core-local-materialization'),
      outbox: jobStore,
      materialization: materializationStore,
    })
    const outboxConsumer = new TopicOutboxConsumerRouter(
      [
        materializationConsumer,
        new CoreFactsOutboxFallback(candidateStore, scopeRef),
        new IndustryWorkspaceOutboxConsumer(workspaceStore, scopeRef),
        new PackPublicationOutboxConsumer(publishedPackStore, scopeRef),
        new ProjectRevisionOutboxConsumer(projectStore, scopeRef),
      ],
      new UnsupportedOutboxConsumer(),
    )
    const dispatcher = new OutboxDispatcher({ store: jobStore, consumer: outboxConsumer })
    const provenanceRead = createPostgresProvenanceRead({ database, blobStore })
    jobLoop = new JobWorkerLoop({
      worker: jobWorker,
      dispatcher,
      scopes: async () => [{
        scopeRef,
        ctx: workerContext(scopeRef, allSourceRefs, WORKER_RUN_ID, sha256DigestOf('core-ingestion-worker'), hostClock),
      }],
      intervalMs: 250,
      onError(error) {
        options.onWorkerError?.(error)
        process.stderr.write('[core-worker] ingestion/outbox cycle failed\n')
      },
    })
    jobLoopAbort = new AbortController()
    jobLoopPromise = jobLoop.start(jobLoopAbort.signal)
    dispatchAbort = new AbortController()
    dispatchWorkerPromise = workflowDispatchWorker.run(dispatchAbort.signal)

    const runValidation = async (
      submission: { readonly profileRef: ProfileRef; readonly question: string; readonly scopeRef: ScopeRef },
      ctx: ToolContext,
    ) => {
      const { scenario, resolved, snapshotHash } = await resolveScenarioProfile(
        profileResolver,
        options.examples.scenarios,
        submission.profileRef,
        submission.scopeRef,
        ctx,
      )
      if (!resolved.toolBindings.some((binding) => binding.toolId === 'ontology_lookup' && binding.enabled)) {
        throw new CoreCapabilityError('this profile does not enable ontology_lookup for facts tasks')
      }
      validateCoreFactsRequest({
        scenario,
        runProfileRef: submission.profileRef,
        resolvedProfileHash: snapshotHash,
        mappingRefs: resolved.mappingRefs,
        definitionRef: scenario.definitionRef,
        scopeRef: submission.scopeRef,
        question: submission.question,
      })
    }

    const readScenarioProfile = async (scenarioId: string) => {
      const mountedScenario = options.examples.scenarios.find((scenario) => scenario.scenarioId === scenarioId)
      if (mountedScenario === undefined) return undefined
      const active = await profileResolver.getActiveProfile(scopeRef, mountedScenario.profileRef.id, profileContext)
      const profileRef = active?.profileRef ?? mountedScenario.profileRef
      const record = await profileResolver.getProfileVersion({ scopeRef, profileRef }, profileContext)
      const selectedScenario = scenarioForIndustryRef(options.examples.scenarios, record.spec.industryRef)
      if (selectedScenario === undefined) {
        throw new CoreCapabilityError(`active profile ${profileRef.id}@${profileRef.version} pins an unmounted industry package`)
      }
      return {
        profileRef,
        baseProfileSpec: record.spec,
        environment: record.environment,
        availableTasks: schemasByScenario([selectedScenario])[selectedScenario.scenarioId] ?? [],
        definitionRef: selectedScenario.definitionRef,
        namespace: selectedScenario.namespace,
        label: selectedScenario.label,
        sourceScenarioId: selectedScenario.scenarioId,
        mappingRefs: record.spec.mappingRefs,
        rawSourceRefs: selectedScenario.rawSources.map((source) => source.sourceRef),
      }
    }

    const reviewableCandidates = new CompositeReviewableCandidateReader({
      definition: assetCandidateStore,
      instance: candidateStore,
    })
    const semanticPublication = new SemanticPublicationService({
      store: publicationStore,
      candidates: candidateStore,
      schemaSource,
      identity: identityStore,
      reviewableCandidates,
    })
    const identityService = new IdentityDecisionService({ store: identityStore, candidates: candidateStore, schemaSource })

    const terminology = terminologySourceFor(options.examples.scenarios)
    const ruleSupport = new FiniteGrammarRuleSupportValidator()
    const ruleActionCandidateService = new RuleActionCandidateService({
      workspaces: workspaceStore,
      candidates: ruleActionCandidateStore,
      support: ruleSupport,
    })
    const definitionGenerationService = new DefinitionCandidateGenerationService({
      workspaces: workspaceStore,
      candidates: assetCandidateStore,
      terminology,
      generationForRun: async ({ ctx, signal }) => {
        const ledger = await budget.openLedger({ ledgerId: ctx.runId, kind: 'background', runId: ctx.runId }, ctx)
        return modelCapabilities.forExecution({ ledgerId: ledger.ledgerId, signal }).generation
      },
      modelRef: {
        modelId: options.modelsEnabled === true ? modelEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID'] ?? 'model-not-configured' : 'model-not-configured',
        version: COMPONENT_VERSION,
      },
      outputLimit: { maxTokens: 2_048 },
    })
    const definitionEditingService = new DefinitionCandidateEditingService({
      workspaces: workspaceStore,
      candidates: assetCandidateStore,
      terminology,
      editing: definitionEditingStore,
      publishedDefinitions: definitionStore,
      newId: () => randomUUID(),
    })
    const instanceReviewService = new InstanceReviewService({ store: instanceReviewStore })
    const syntheticExampleService = new SyntheticExampleService({
      workspaces: workspaceStore,
      sets: syntheticExampleSetStore,
    })
    const industryValidationService = new IndustryValidationService({
      workspaces: workspaceStore,
      exampleSets: syntheticExampleSetStore,
      reports: validationReportStore,
      definitions: definitionEditingService,
      ruleActions: ruleActionCandidateStore,
      support: ruleSupport,
      evaluator: new FiniteGrammarSyntheticEvaluator(),
    })
    const industryAssetPublicationService = new IndustryAssetPublicationService({
      workspaces: workspaceStore,
      validations: validationReportStore,
      definitionCandidates: assetCandidateStore,
      ruleActions: ruleActionCandidateStore,
      syntheticSets: syntheticExampleSetStore,
      definitions: definitionStore,
      store: publishedPackStore,
    })
    const packCatalogue = new StoreBackedIndustryPackCatalogue({ store: publishedPackStore })
    const componentRegistry = new ComponentRegistry({
      control,
      store: componentStore,
      artifacts: blobStore,
      validator: manifestValidator(createAjv()),
    })
    const packExportService = new IndustryPackExportService({
      catalogue: packCatalogue,
      definitions: definitionStore,
      published: publishedPackStore,
    })
    const packUpgradeService = new IndustryPackUpgradeService({
      profiles: profileResolver,
      profileStore,
      registry: componentRegistry,
      registryStore: componentStore,
    })
    const projectService = new ProjectService({
      projects: projectStore,
      readiness: projectReadinessStore,
      jobs: jobStore,
      catalogue: packCatalogue,
    })
    const scopedOriginals: ScopedArtifactReader = {
      read: (request, ctx) => {
        const target = request.approvedInputRefs[0]
        if (target === undefined) throw new Error('the structured request carried no approved input reference')
        return blobStore.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: target }, ctx)
      },
    }
    const projectMappingService = new ProjectMappingService({
      projects: projectStore,
      revisions: projectStore,
      mappings: projectMappingStore,
      records: projectRecordStore,
      ingestion: structuredStore,
      schemaSource,
      originals: scopedOriginals,
      parser: new StructuredDocumentParser(),
    })
    const actionBindingContext = (): ActionCapabilityBindingInput => ({
      registry: operationRegistry(),
      availableCapabilities: ['agent_runtime', 'structured_query', 'document_search', 'industry.semantics'],
      recordedAt: hostClock().toISOString(),
    })
    const dependencies: CoreApiDependencies = {
      database,
      scopeRef,
      examples: options.examples,
      readScenarioProfile,
      profileRefsByScenario,
      profileSpecsByScenario,
      modelCapabilities: {
        generation: modelCapabilities.generationEnabled,
        decision: modelCapabilities.decisionEnabled,
      },
      availableTasksByScenario,
      allowLocalOperator: options.allowLocalOperator ?? false,
      api: {
        runs: {
          service: runs,
          progress: runProgress,
          submissionMode: 'durable',
          validateSubmission: (input, ctx) => runValidation(input, ctx),
          dispatch: {
            enqueue: async (runId, logicalActionId, ctx) => dispatchStore.enqueue({ runId, logicalActionId }, ctx),
            cancelRun: (runId, ctx) => workflowDispatchWorker.cancelRun(runId, ctx),
          },
        },
        jobs: { service: jobService },
        workbench: { profiles: profileResolver, sources, components: componentStore },
        decisions: { service: identityService, candidates: candidateStore, documents: parseStore },
        publications: { service: semanticPublication },
        industryWorkspaces: { service: industryWorkspaceService },
        answers: { reader: controller },
        evidence: { service: provenanceRead.provenance },
        history: { service: provenanceRead.history },
        packs: {
          catalogue: packCatalogue,
          packExports: packExportService,
          packUpgrades: packUpgradeService,
          publication: industryAssetPublicationService,
        },
        assetCandidates: { generation: definitionGenerationService },
        definitionEditing: { service: definitionEditingService },
        ruleActionCandidates: { service: ruleActionCandidateService, bindingContext: actionBindingContext },
        instanceReviews: { service: instanceReviewService },
        projects: { service: projectService, mappings: projectMappingService },
        projectDocuments: { service: projectDocumentIndexService },
        syntheticValidation: {
          exampleService: syntheticExampleService,
          validationService: industryValidationService,
          bindingContext: actionBindingContext,
        },
      },
      registerRoutes: (api, authenticate) => registerCoreImportRoute({
        app: api,
        authenticate,
        scopeRef,
        examples: options.examples,
        service: jobService,
        objectStore,
        registry: artifactRegistry,
        generationEnabled: modelCapabilities.generationEnabled,
      }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }

    return {
      dependencies,
      async close() {
        await dispatchAbort?.abort()
        jobLoopAbort?.abort()
        jobLoop?.stop()
        for (const runId of activeRunIds) controller?.abortActiveWork(runId, 'Core host is shutting down')
        await Promise.allSettled([
          ...(jobLoopPromise === undefined ? [] : [jobLoopPromise]),
          ...(dispatchWorkerPromise === undefined ? [] : [dispatchWorkerPromise]),
        ])
        duckDb.close()
        for (const close of cleanup) await close().catch(() => undefined)
      },
    }
  } catch (error) {
    dispatchAbort?.abort()
    jobLoop?.stop()
    for (const close of cleanup) await close().catch(() => undefined)
    throw error
  }
}
