import { exampleComputeArtifact } from './example-compute-artifact'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_POSTGRES_ADAPTER_REF, PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import type { PostgresProjectDatasetConfig } from '@ontology/adapter-data-postgres'
import { createCoreProjectQueryWorkflow } from './core-project-query-handler'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject, ValidateFunction } from 'ajv'
import type { FastifyInstance } from 'fastify'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { DATA_DUCKDB_ADAPTER_REF, DuckDbProjectDatasetAdapter, DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
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
  PostgresComputeOutputBindingsStore,
  PostgresComputeInvocationStore,
  PostgresComputeResultArtifactStore,
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
  PostgresProjectEvolutionStore,
  PostgresProjectMappingStore,
  PostgresProjectReadinessStore,
  PostgresProjectRecordStore,
  PostgresProjectStore,
  PostgresPublishedPackAssetStore,
  PostgresPublishedTaskBindingStore,
  PostgresRuleActionCandidateStore,
  PostgresRuleActionGenerationStore,
  PostgresRunExecutionBindingStore,
  PostgresRunStore,
  PostgresSemanticDefinitionStore,
  PostgresTaskInputSnapshotStore,
  PostgresSemanticPublicationStore,
  PostgresSyntheticExampleSetStore,
  PostgresTableArtifactStore,
  PostgresTableVerificationStore,
  PostgresTaskFinalizationReceiptStore,
  PostgresTaskPolicyReportStore,
  PostgresWorkflowDispatchStore,
  PostgresWorkflowStore,
} from '@ontology/adapter-control-postgres'
import {
  ArtifactGroundingDocumentSetReader,
  ParsedSourceGroundingReader,
  DocumentSpanReader,
  LocalDocumentExtractionService,
  LocalStructuredIngestionService,
  PostgresDocumentParseStore,
  PostgresStructuredIngestionStore,
  StructuredDocumentParser,
  StructuredPremiseSourceReader,
} from '@ontology/adapter-extraction-document'
import { Bm25DocumentSearchService, PostgresKeywordIndexStore, ProjectDocumentIndexService } from '@ontology/adapter-search-bm25'
import { PiRuntimeAdapter } from '@ontology/adapter-runtime-pi'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
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
  InMemoryIndustryPackCatalogue,
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
  ProjectDataMaterializationService,
  ProjectMappingService,
  ProjectService,
  ProfileResolver,
  PublicationValidityEngine,
  PublishedPackRuleDeclarationReader,
  RestrictedLimitedAnswerComposer,
  ResultHistoryService,
  RuleActionCandidateService,
  RuleActionCandidateGenerationService, RULE_ACTION_RESPONSE_SCHEMA_REF, parseRuleActionCandidateOutput,
  RunTypedResultContextSource,
  VerifiedResultExportService,
  TableArtifactReadService,
  TableHardVerificationService,
  VerifiedResultReadService,
  defaultPublicationEvidenceValidators,
  ruleDerivationValidator,
  SourceRegistry,
  RunExecutionPreflightService,
  RunPhaseDriver,
  RunService,
  RunServiceError,
  createSourceGroundingService,
  createDynamicDefinitionTerminologySource,
  StoreBackedIndustryManifestSource,
  StoreBackedIndustryPackCatalogue,
  StructuredExtractionService,
  StructuredExtractionStageHandler,
  SyntheticExampleService,
  TBOX_RESPONSE_SCHEMA_REF,
  TypedEvidenceDraftWriter,
  WorkflowController,
  createRunCheckpointPort,
  encodeDocumentIngestionRef,
  encodeStructuredExtractionRef,
  mapNativeEntities,
  parseDefinitionCandidateOutput,
  parseModelCandidates,
  ReviewHandoffStageHandler,
  readWorkspacePublicationSourceDrafts,
} from '@ontology/application'
import type { DefinitionTerminologySource, ManifestValidator, OutboxConsumer, ProfileSpecValidator, PublicationEvidenceValidation, PublicationEvidenceValidationInput, PublicationEvidenceValidator, RunProfileBinder, TaskParameterValidator } from '@ontology/application'
import type {
  ActionCapabilityBindingInput,
  CandidateStore,
  ComponentKind,
  ComponentManifest,
  ComponentRegistrationRecordInput,
  ComponentVersionRecord,
  ComputeBinding,
  DocumentParserPort,
  GenerationPort,
  IndustrySchemaSource,
  IdentityDecisionStore,
  IndustryManifestSource,
  IndustryWorkspaceStore,
  InputValidityPort,
  ModelBinding,
  OperationRegistry,
  OutboxMessageRecord,
  ProfileRef,
  ProfileSpec,
  ProjectStore,
  PublicationValidityPort,
  PublishedRuleDeclarationReader,
  PublicationValidityReport,
  PublicationValidityRequest,
  QueryColumn,
  RelationNavigationRequest,
  ResolvedCapability,
  ResourceRef,
  RunExecutionRequest,
  RuntimeAdapter,
  RuntimeCapabilityFactoryPort,
  RuntimeCapabilitySet,
  RuntimeSelectorPort,
  ScalarValue,
  ScopeRef,
  ScopedArtifactReader,
  SemanticPublicationStore,
  SourceRef,
  SupportedDataType,
  TableVerificationReceiptStore,
  TaskPolicyReportStore,
  ToolContext,
  Uuid,
  VersionRef,
  VerifiedTableManifestSource,
  WorkflowDispatchFence,
  RuntimeCapabilityContext,
} from '@ontology/contracts'
import { DEFAULT_VERIFICATION_POLICY, RelationNavigationError, SCHEMA_DOCUMENTS, TOOL_CATALOGUE, createToolContext, projectCollectionRef } from '@ontology/contracts'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import { createRequestToolContext, createToolGatewayComposition, ForbiddenError, InvalidRequestFieldError } from '@ontology/app-api'
import type { CoreApiDependencies } from '../core-main'
import { ArchivedRulePremiseReplayVerifier, FiniteGrammarRuleSupportValidator, FiniteGrammarSyntheticEvaluator, IdentityDecisionService, IncrementalMaterializer, InMemorySemanticMappingRegistry, MaterializedRuleDerivationEvidenceProducer, OntologyLookupService, PublishedFactsReferenceProvider, PublishedRelationNavigator, PublishedSemanticSource, PublishedProjectDatasetSource, SemanticDefinitionService, definitionVersionDigest, projectIndustrySchema } from '@ontology/semantic-engine'
import type {
  MaterializationPublishedSource,
  OntologyFactPage,
  OntologyFactQuery,
  OntologyFactReferenceProvider,
  PublishedSemanticData,
} from '@ontology/semantic-engine'
import { DataQueryHandler, EXAMPLE_COMPUTE_DATA_SCHEMA, EXAMPLE_OPERATION_REF, OntologyLookupHandler, RegisteredComputeExecutionService, canonicalJson, createExampleComputeHandlers, exampleRegisteredOperation } from '@ontology/tool-services'
import type { ToolSchemaValidator } from '@ontology/tool-services'
import { controlRecordSequence, JobWorkerLoop, MaterializationOutboxConsumer, ProjectEvolutionOutboxConsumer, TopicOutboxConsumerRouter, WorkflowDispatchWorker, createIngestionHandlerRegistry } from '@ontology/app-worker'
import { createCoreApprovedInput } from './core-approved-input'
import { createCoreRunRequestResolver } from './core-run-request'
import { createCoreInstanceIdentity } from './core-instance-identity'
import { createCoreProjectApi } from './core-project-api'
import { createProjectEvolutionWorkflow } from './project-evolution'
import { createCoreAuthoring } from './core-authoring'
import { createCompetencyQuestionWorkflow } from './competency-questions'
import { createCompetencyValidationTargetReader } from './competency-validation-target'
import { createNormalCoreCompetencyExecution } from './core-competency-execution'
import { createCoreExecutionPreview } from './core-execution-preview'
import { createBusinessMaterializationConsumer, createCompetencyPreviewOutboxConsumer } from './core-business-materialization'
import { createCoreSourceViewReader } from './core-source-view'
import { createCoreDefinitionLabelReader } from './core-definition-labels'
import { createCoreProjectComputeInput } from './core-project-compute-input'
import { createCorePackExecutionProfiles } from './core-pack-execution-profiles'
import { createCoreVerifiedTableSource } from './core-verified-tables'
import { createCoreTableResults } from './core-table-results'
import { createCoreProjectSemanticReadiness } from './core-project-semantic-readiness'
import { registerCoreSourceViewRoutes } from '../http/core-source-views'
import { createProjectFactWorkflow } from './project-facts'
import { CoreFactsPlanError, createCoreFactsPlan } from './core-facts-plan'
import { mountCoreTaskBindings } from './core-task-bindings'
import { createBlobArtifactWriter } from './tool-gateway'
import { registerProjectImportRoute } from '../http/project-imports'
import { createStaticProbeAdapterResolver, createPostgresSourceStore } from './source-registry'
import { createEnvSecretResolver } from './secret-resolver'
import { createPostgresProvenanceRead } from './provenance-read'
import { createCoreModelCapabilityFactory } from './core-model-capabilities'
import { createCoreDocumentSearchHandler } from './core-document-search-handler'
import { createCoreStructuredImportWorkflow } from './core-structured-import-service'
import { createCoreOntologyLookupHandler } from './core-rule-judgement-handler'
import { CoreSemanticTaskResolver, createCoreSemanticTaskSource } from './core-semantic-task-resolver'
import { CoreRelationsTaskHandler } from './core-relations-task-handler'
import { CoreProjectSemanticPartitions } from './core-project-semantic-partitions'
import { createCoreModelEvidenceRecorders } from './model-evidence'
import { createCoreDecisionStateRefProvider } from './decision-state-reference'
import { PostgresCorePlanReceiptStore } from './core-plan-receipts'
import { CoreTemplatePlanResolver } from './core-template-plan-resolver'
import type { CoreModelComponentRefs } from './core-template-plan-resolver'
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

function modelComponentRefsOf(
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

function scenarioComponentRecords(
  scenarios: readonly CoreExampleScenario[],
  now: string,
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
  const computeOperation = exampleRegisteredOperation(exampleComputeArtifact)
  add(componentRecord({ kind: 'compute_extension',ref: computeOperation.handlerRef,capabilityNames: ['registered_compute'],
    entrypoint: '@ontology/tool-services/compute/example-artifact',now }))
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

async function registerComponents(
  store: PostgresComponentRegistryStore,
  records: readonly ComponentVersionRecord[],
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
    const operation = record.manifest.kind === 'compute_extension' && record.manifest.entrypointRef.kind === 'package' && record.manifest.entrypointRef.ref === '@ontology/tool-services/compute/example-artifact' ? exampleRegisteredOperation(exampleComputeArtifact) : undefined
    if (operation !== undefined && !sameVersionRef(record.manifestRef,operation.handlerRef)) throw new CoreCapabilityError('the compute extension does not pin the verified registered build artifact')
    const bytes = operation === undefined ? new TextEncoder().encode(canonicalJson({ schemaVersion: 'core-host-component@1', manifest: record.manifest })) : exampleComputeArtifact.readArtifact()
    const staged = await blobs.stage(bytes, { scopeRef }, ctx)
    const artifact = await blobs.putImmutable({ scopeRef, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: operation === undefined ? 'application/vnd.ontology.host-component+json' : 'text/javascript' }, ctx)
    await store.insertVersion(scopeRef, componentRegistrationInput(record, record.registeredAt, artifact.blobRef), ctx)
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

function noModelError(message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code: 'CAPABILITY_NOT_CONFIGURED' })
}

function disabledDecision() {
  return {
    decide: async () => { throw noModelError('the JEV decision model is not configured') },
  }
}

/**
 * The registered operations the Core host can execute (ADR-11, SPEC v0.3a §EX-6). The neutral,
 * synthetic example operation is registered exactly like an industry operation: its whole record
 * (handler/schema/limits pins) is what a compute task binding pins, and nothing in the generic
 * Core branches on an industry name.
 */
function operationRegistry(): OperationRegistry {
  const operations = [exampleRegisteredOperation(exampleComputeArtifact)]
  return {
    namespace: 'core-local',
    registryVersion: COMPONENT_VERSION,
    registryDigest: sha256DigestOf(canonicalJson(operations)),
    operations,
  }
}

/** The profile compute binding that enables the registered example operation for a run. */
function exampleComputeBinding(): ComputeBinding {
  const operation = exampleRegisteredOperation(exampleComputeArtifact)
  return {
    operationRef: operation.operationRef,
    handlerRef: operation.handlerRef,
    inputSchemaRef: {
      id: `${operation.operationRef.id}.input`,
      version: COMPONENT_VERSION,
      digest: operation.inputSchemaDigest,
    },
    outputSchemaRef: {
      id: `${operation.operationRef.id}.output`,
      version: COMPONENT_VERSION,
      digest: operation.outputSchemaDigest,
    },
    readOnly: true,
    enabled: true,
    limits: operation.limits,
  }
}

const CORE_EFFECTIVE_LIMITS_REF: VersionRef = {
  id: 'core-local-effective-limits',
  version: COMPONENT_VERSION,
  digest: sha256DigestOf('core-local-effective-limits@1.0.0'),
}

/**
 * The result format the Core host can render and finalize: a `typed-result-manifest@1`. A
 * published task binding whose `resultSchemaRef` is not this registered format is reported as
 * not available by preflight, so no run can claim a formal result the host cannot produce.
 */
export const CORE_TYPED_RESULT_SCHEMA_REF: VersionRef = {
  id: 'typed-result-manifest',
  version: '1.0.0',
  digest: sha256DigestOf('typed-result-manifest@1'),
}

/** Project the registered components' declared capabilities into the exact deployment capability set. */
function resolvedCapabilitiesFrom(records: readonly ComponentVersionRecord[]): ResolvedCapability[] {
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

function taskParameterValidator(ajv: Ajv2020): TaskParameterValidator {
  return {
    validate(schema, value) {
      const validate = ajv.compile(schema as SchemaObject)
      return validate(value)
        ? { valid: true, issues: [] }
        : {
            valid: false,
            issues: (validate.errors ?? []).map(
              (error) => `${error.instancePath === '' ? '$' : error.instancePath} ${error.message ?? 'is invalid'}`,
            ),
          }
    },
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
      partitions: parts,
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

/** Project the mounted industry packs into the professional terminology a workspace may build on. */
function terminologySourceFor(
  scenarios: readonly CoreExampleScenario[],
  publishedPacks: PostgresPublishedPackAssetStore,
  definitions: PostgresSemanticDefinitionStore,
  registry: PostgresComponentRegistryStore,
): DefinitionTerminologySource {
  const staticCatalogue = new InMemoryIndustryPackCatalogue()
  for (const scenario of scenarios) staticCatalogue.registerPack({
    // Preserve the same pin registered into the component registry and mounted profiles.
    ref: componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest),
    manifest: scenario.industryManifest,
    testSuite: scenario.testSuite,
  })
  return createDynamicDefinitionTerminologySource({
    catalogue: new StoreBackedIndustryPackCatalogue({ store: publishedPacks, fallback: staticCatalogue }),
    definitions,
    registry,
    publishedPacks,
  })
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
    // The four public tools: published facts/rules read through ontology_lookup, structured
    // query and registered compute through data_query, and document Q&A through
    // document_search. `web_search` stays disabled unless a deployment explicitly enables it.
    toolBindings: TOOL_CATALOGUE.map((tool) => ({
      toolId: tool.toolId,
      enabled: tool.toolId === 'ontology_lookup' || tool.toolId === 'data_query' || tool.toolId === 'document_search',
      ...(tool.toolId === 'ontology_lookup' ? { maxCallsPerRun: 4 } : {}),
    })),
    computeBindings: [exampleComputeBinding()],
    policyRef: CORE_POLICY_REF,
  }
}

function componentRegistrationInput(record: ComponentVersionRecord, now: string, artifactRef: ResourceRef): ComponentRegistrationRecordInput {
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

function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

/** A full-reference key, so a runtime selector cannot match a same-id sibling of another version/digest. */
function versionRefKey(ref: VersionRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

function profileModelBindingEnabled(
  binding: ModelBinding | undefined,
  availableRef: VersionRef | undefined,
): boolean {
  return binding?.enabled === true && availableRef !== undefined && sameVersionRef(binding.modelRef, availableRef)
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
  /** Explicit independent business database writer/query credentials; omitted uses rebuildable DuckDB. */
  readonly projectDataset?: PostgresProjectDatasetConfig
  /** Narrow active-snapshot guard; full evolution composition is owned by the deployment. */
  readonly projectEvolution?: import('@ontology/application').ProjectEvolutionService
  /** Narrow optional leaf; broad production mounting is owned by the deployment factory. */
  readonly projectStructuredImports?: typeof createCoreStructuredImportWorkflow
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

function readRelationNavigationRequest(value: unknown): RelationNavigationRequest | undefined {
  if (!isRecord(value)) return undefined
  const startEntityId = value['startEntityId']
  const validAt = value['validAt']
  const rawRelationIds = value['relationIds']
  const maxPaths = value['maxPaths']
  if (typeof startEntityId !== 'string' || typeof validAt !== 'string' || !Array.isArray(rawRelationIds)) {
    return undefined
  }
  const relationIds: string[] = []
  for (const relationId of rawRelationIds) {
    if (typeof relationId !== 'string') return undefined
    relationIds.push(relationId)
  }
  return {
    startEntityId,
    relationIds,
    validAt,
    ...(typeof maxPaths === 'number' ? { maxPaths } : {}),
  }
}

/**
 * Read-only loopback route for bounded published-relation navigation (V03-027 / #195,
 * A.US-008.AC-02, A.FR-14). It is not a model tool: the canonical catalogue is the closed set
 * of four model tools, so navigation is exposed to the host as an explicit service surface
 * instead of widening the model's tool authority. The route mints a trusted context from the
 * server-side authentication result and reads only the caller's scope.
 */
function registerCoreRelationNavigationRoute(input: {
  readonly app: FastifyInstance
  readonly authenticate: RequestAuthenticator
  readonly examples: LoadedCoreExamples
  readonly publications: SemanticPublicationStore
  readonly identity: IdentityDecisionStore
}): void {
  input.app.post('/api/v1/core/relations/navigate', async (request, reply) => {
    const auth = input.authenticate(request)
    if (auth === undefined) {
      return reply.status(401).send({ error: { code: 'UNAUTHENTICATED', message: 'loopback development authentication is required', retryable: false } })
    }
    const navigation = readRelationNavigationRequest(request.body)
    if (navigation === undefined) {
      throw new InvalidRequestFieldError('startEntityId, validAt and a relationIds array of strings are required')
    }
    const scenarioId = isRecord(request.body) ? request.body['scenarioId'] : undefined
    if (typeof scenarioId !== 'string') throw new InvalidRequestFieldError('scenarioId is required')
    const scenario = input.examples.scenarios.find((entry) => entry.scenarioId === scenarioId)
    if (scenario === undefined) throw new InvalidRequestFieldError('scenarioId is not mounted by this deployment')
    const navigator = new PublishedRelationNavigator({
      publications: input.publications,
      identity: input.identity,
      definitionRef: scenario.definitionRef,
      allowedRelationIds: scenario.industrySchema.relations.map((relation) => relation.relationId),
      relationTargets: new Map(
        scenario.industrySchema.relations.map((relation) => [
          relation.relationId,
          { fromObjectId: relation.fromObjectId, toObjectId: relation.toObjectId },
        ]),
      ),
    })
    const ctx = createRequestToolContext({
      principal: auth.principal,
      spaceId: auth.spaceId,
      traceId: request.id,
      runId: globalThis.crypto.randomUUID(),
    })
    try {
      const result = await navigator.navigate(navigation, ctx)
      return reply.status(200).send({ data: result, meta: { traceId: request.id } })
    } catch (error) {
      if (error instanceof RelationNavigationError) {
        if (error.code === 'FORBIDDEN') throw new ForbiddenError(error.message)
        throw new InvalidRequestFieldError(error.message)
      }
      throw error
    }
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

/**
 * `observation` publication validity for the Core path. A published-fact page is revalidated
 * against the current published view; any other observation payload (a relation edge or table
 * result) is left to the generic observation rule, so the gate no longer blindly rejects — or
 * blindly accepts — a non-fact evidence shape as if it were a fact page.
 */
class CoreObservationPublicationValidator implements PublicationEvidenceValidator {
  readonly evidenceKind = 'observation' as const
  readonly #facts: CorePublishedFactsProvider
  readonly #scopeRef: ScopeRef
  readonly #relations: CoreRelationsTaskHandler | undefined

  constructor(input: { readonly facts: CorePublishedFactsProvider; readonly scopeRef: ScopeRef; readonly relations?: CoreRelationsTaskHandler }) {
    this.#facts = input.facts
    this.#scopeRef = input.scopeRef
    this.#relations = input.relations
  }

  async validate({ record, payload, ctx }: PublicationEvidenceValidationInput): Promise<PublicationEvidenceValidation> {
    if (isRecord(payload) && payload['resultKind'] === 'relations') {
      try { return this.#relations !== undefined && await this.#relations.verify(payload, ctx) ? { state: 'current' } : { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['published project relations changed or cannot be re-read'] } } catch { return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['published project relations cannot be re-read'] } }
    }
    if (!isRecord(payload) || !Array.isArray(payload['items'])) return { state: 'current' }
    const items = payload['items']
    const factItems = items.filter((item) => isRecord(item) && item['kind'] === 'fact')
    if (factItems.length === 0 || factItems.length !== items.length) return { state: 'current' }
    const first = factItems[0]
    if (!isRecord(first) || !isRecord(first['conceptRef']) || typeof first['conceptRef']['namespace'] !== 'string') {
      return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['fact evidence has no exact concept namespace'] }
    }
    const namespace = first['conceptRef']['namespace']
    const concepts: { namespace: string; conceptId: string; definitionVersion?: string }[] = []
    for (const item of factItems) {
      if (!isRecord(item) || !isRecord(item['conceptRef']) || typeof item['conceptRef']['conceptId'] !== 'string' || item['conceptRef']['namespace'] !== namespace) {
        return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['fact evidence mixed concept namespaces or lacked a typed concept reference'] }
      }
      const definitionVersion = item['conceptRef']['definitionVersion']
      concepts.push({
        namespace,
        conceptId: item['conceptRef']['conceptId'],
        ...(typeof definitionVersion === 'string' ? { definitionVersion } : {}),
      })
    }
    let page: OntologyFactPage
    try {
      page = await this.#facts.listFacts({
        scopeRef: this.#scopeRef,
        concepts: [...new Map(concepts.map((concept) => [concept.conceptId, concept])).values()],
        entityRefs: [],
        limit: 10_000,
        validAt: record.envelope.observedAt,
      }, ctx)
    } catch {
      return { state: 'blocked', reasons: ['evidence_unverifiable'], details: ['published fact evidence could not be revalidated against its source'] }
    }
    if (!page.covered || page.nextCursor !== null) {
      return { state: 'stale', details: ['published fact evidence no longer has a complete source view'] }
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
      return { state: 'stale', details: ['published facts changed after the evidence was collected'] }
    }
    return { state: 'current' }
  }
}

/**
 * Core publication validity: a per-evidence-kind engine (V03-035 / #206) that re-checks the
 * revision, digest and current visibility of every dependency of the verified draft (facts,
 * relation/table observations, rule derivations, computations, document spans and their
 * transitive support), plus any formal-table verification receipts. Only the same verified
 * version can publish; a later edit or retraction blocks, and a stale-but-intact support is
 * published only with an explicit `asOf`.
 */
class CorePublicationValidity implements PublicationValidityPort {
  readonly #engine: PublicationValidityEngine

  constructor(input: {
    readonly evidence: PostgresEvidenceStore
    readonly artifacts: LocalImmutableBlobStore
    readonly facts: CorePublishedFactsProvider
    readonly scopeRef: ScopeRef
    readonly tables?: TableVerificationReceiptStore
    readonly policies?: TaskPolicyReportStore
    readonly rulePremises?: import('@ontology/contracts').RulePremiseReplayPort
    readonly documentSources?: import('@ontology/application').PublicationEvidenceValidator
    readonly relations?: CoreRelationsTaskHandler
  }) {
    this.#engine = new PublicationValidityEngine({
      evidence: input.evidence,
      artifacts: input.artifacts,
      validators: [
        ...defaultPublicationEvidenceValidators(),
        new CoreObservationPublicationValidator({ facts: input.facts, scopeRef: input.scopeRef, ...(input.relations === undefined ? {} : { relations: input.relations }) }),
        ruleDerivationValidator(input.rulePremises),
        ...(input.documentSources === undefined ? [] : [input.documentSources]),
      ],
      ...(input.tables === undefined ? {} : { tables: input.tables }),
      ...(input.policies === undefined ? {} : { policies: input.policies }),
    })
  }

  check(request: PublicationValidityRequest, ctx: ToolContext): Promise<PublicationValidityReport> {
    return this.#engine.check(request, ctx)
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
    const ruleActionGenerationStore = new PostgresRuleActionGenerationStore(database)
    const definitionEditingStore = new PostgresDefinitionEditingStore(database)
    const instanceReviewStore = new PostgresInstanceReviewStore(database)
    const syntheticExampleSetStore = new PostgresSyntheticExampleSetStore(database)
    const validationReportStore = new PostgresIndustryValidationReportStore(database)
    const scopedOriginals: ScopedArtifactReader = { read: (request, ctx) => {
      const target = request.approvedInputRefs[0]
      if (request.approvedInputRefs.length !== 1 || target === undefined) throw new InvalidRequestFieldError('exactly one scoped immutable reference is required')
      return blobStore.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: target }, ctx)
    } }
    const publishedPackStore = new PostgresPublishedPackAssetStore(database, { competencyBodies: scopedOriginals })
    const projectStore = new PostgresProjectStore(database, { excludeSyntheticValidationProjects: true,requirePublishedInputEvolution: true })
    const projectReadinessStore = new PostgresProjectReadinessStore(database)
    const projectMappingStore = new PostgresProjectMappingStore(database)
    const projectDocumentStore = new PostgresProjectDocumentStore(database)
    const projectRecordStore = new PostgresProjectRecordStore(database)
    const taskBindingStore = new PostgresPublishedTaskBindingStore(database)
    const taskInputSnapshotStore = new PostgresTaskInputSnapshotStore(database)
    const runExecutionBindingStore = new PostgresRunExecutionBindingStore(database)
    const taskFinalizationReceiptStore = new PostgresTaskFinalizationReceiptStore(database)
    const identityStore = new PostgresIdentityDecisionStore(database)
    const publicationStore = new PostgresSemanticPublicationStore(database, { excludeSyntheticValidationProjects: true })
    const definitionStore = new PostgresSemanticDefinitionStore(database)
    const publishedPackRules: { current?: PublishedRuleDeclarationReader } = {}
    const packRuleReader: PublishedRuleDeclarationReader = { read: (...args) => {
      if (publishedPackRules.current === undefined) throw new CoreCapabilityError('the actual published pack rule reader is not initialized')
      return publishedPackRules.current.read(...args)
    } }
    const workflowStore = new PostgresWorkflowStore(database)
    const planReceiptStore = new PostgresCorePlanReceiptStore(database)
    const evidenceStore = new PostgresEvidenceStore(database)
    const materializationStore = new PostgresMaterializationStore(database)
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
        if (sameVersionRef(schemaRef, RULE_ACTION_RESPONSE_SCHEMA_REF)) {
          try { parseRuleActionCandidateOutput(canonicalJson(candidate)); return { valid: true } }
          catch { return { valid: false, errors: ['rule/action response did not match the registered generator contract'] } }
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
    const schemaSource: IndustrySchemaSource = { getSchema: async (scope, ref, ctx) => {
      const version = await definitionStore.findVersionByRef(scope, ref, ctx)
      if (version !== undefined && definitionVersionDigest(version) !== ref.digest) throw new CoreCapabilityError('the stored definition declaration failed its exact immutable body digest')
      return version === undefined ? undefined : projectIndustrySchema(version)
    } }
    const semanticDefinitions = new SemanticDefinitionService({ control, store: definitionStore })
    const projectDatasetAdapter = options.projectDataset === undefined
      ? new DuckDbProjectDatasetAdapter({ instancePath: join(options.objectDirectory, 'project-dataset.duckdb') })
      : new PostgresProjectDatasetAdapter(options.projectDataset)
    cleanup.unshift(async () => { await projectDatasetAdapter.close() })
    const publishedProjectDatasetSource = new PublishedProjectDatasetSource({ publications: publicationStore, identity: identityStore,
      records: projectRecordStore, mappings: projectMappingStore, projectDocuments: projectDocumentStore,
      definition: async (scope, ref, ctx) => definitionStore.findVersionByRef(scope, ref, ctx),
    })
    let projectEvolution = options.projectEvolution
    const normalApprovedInputs: { current?: ReturnType<typeof createCoreApprovedInput> } = {}
    const evolutionGuard = { assertActiveRebuild: (scope: ScopeRef, revision: import('@ontology/contracts').ProjectRevisionRef, ctx: ToolContext) => projectEvolution?.assertActiveRebuild(scope, revision, ctx) ?? Promise.resolve(false), resolveActiveSnapshot: (scope: ScopeRef, revision: import('@ontology/contracts').ProjectRevisionRef, objectId: string, ctx: ToolContext) => projectEvolution?.resolveActiveSnapshot(scope, revision, objectId, ctx) ?? Promise.resolve(undefined) }
    const projectDatasetService = new ProjectDataMaterializationService({
      projects: projectStore,
      publishedSource: publishedProjectDatasetSource,
      readiness: projectReadinessStore,
      schemaSource,
      writer: projectDatasetAdapter,
      query: projectDatasetAdapter,
      evolution: evolutionGuard,
    })
    const projectQuery = createCoreProjectQueryWorkflow({ query: projectDatasetAdapter, publishedSource: publishedProjectDatasetSource,
      projects: projectStore, readiness: projectReadinessStore, executionBindings: runExecutionBindingStore, taskBindings: taskBindingStore,
      executeRegisteredCompute: async (request, binding, execution) => {
        const service = registeredComputeExecution
        const args = request.arguments
        const parameters = args['parameters']
        const operationRef = binding.operationRef
        if (execution.request.mode !== 'task' || binding.registeredOperationDigest === undefined || operationRef === undefined ||
          !isRecord(parameters) || canonicalJson(args['operationRef']) !== canonicalJson(operationRef) ||
          args['inputSchemaDigest'] !== operationRegistry().operations.find((operation) => canonicalJson(operation.operationRef) === canonicalJson(operationRef))?.inputSchemaDigest ||
          canonicalJson(args['inputRefs']) !== canonicalJson([execution.request.inputSnapshotRef]) || canonicalJson(parameters) !== canonicalJson(execution.request.parameters)) {
          throw new CoreCapabilityError('the registered computation differs from its exact saved task, operation or fixed input pins')
        }
        const parameterBytes = new TextEncoder().encode(canonicalJson(parameters))
        const parameterArtifact = await computeArtifacts.putBytes({ scopeRef: { tenantId: request.ctx.principal.tenantId, spaceId: request.ctx.allowedResources.spaceId },
          content: parameterBytes, mediaType: 'application/json' }, request.ctx)
        const parameterDigest = sha256DigestOf(canonicalJson(parameters))
        if (parameterArtifact.contentDigest !== parameterDigest) throw new CoreCapabilityError('the registered computation parameter archive failed its canonical body digest')
        const result = await service.execute({ taskBindingRef: binding.taskBindingRef, operationRef, registeredOperationDigest: binding.registeredOperationDigest,
          inputSnapshotRef: execution.request.inputSnapshotRef, inputSnapshotDigest: execution.request.inputSnapshotDigest,
          parametersRef: parameterArtifact.blobRef, parametersDigest: parameterDigest, parameters,
          inputRefs: [execution.request.inputSnapshotRef], requiredInputRefs: [execution.request.inputSnapshotRef],
          deadline: request.deadline, signal: request.signal }, request.ctx)
        const wrapperRef = result.invocation.resultRef
        if (wrapperRef === undefined) throw new CoreCapabilityError('the registered computation has no archived result wrapper')
        let payload = result.payload
        if (payload === undefined) {
          const bytes = await blobStore.readAuthorized({ scopeRef: { tenantId: request.ctx.principal.tenantId, spaceId: request.ctx.allowedResources.spaceId }, blobRef: result.artifact.outputArtifactRef }, request.ctx)
          if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== result.artifact.outputDigest) throw new CoreCapabilityError('the reused computation output failed its exact archived digest')
          const output: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
          if (!isRecord(output) || !isRecord(output['metrics'])) throw new CoreCapabilityError('the reused computation output has no typed metrics')
          payload = { resultKind: 'computation', computation: { operationRef: result.artifact.operationRef, resultRef: result.artifact.outputArtifactRef,
            algorithmVersion: result.artifact.algorithmVersion, metrics: output['metrics'], domainStatus: result.artifact.domainStatus } }
        }
        return { payload, status: result.artifact.coverage.truncated ? 'partial' : result.artifact.coverage.returned === 0 ? 'empty' : 'ok',
          coverage: result.artifact.coverage, sources: result.artifact.sourceSnapshots.map((source) => ({ sourceRef: source.sourceRef, schemaVersion: source.schemaVersion,
            consistency: source.consistency, resultDigest: source.resultDigest, ...(source.asOf === undefined ? {} : { asOf: source.asOf }), ...(source.watermark === undefined ? {} : { watermark: source.watermark }) })), domainStatus: result.artifact.domainStatus,
          usage: { rows: result.artifact.coverage.returned }, dataMode: result.artifact.dataMode, evidenceKind: 'computation' }
      },
      definition: async (scope, ref, ctx) => definitionStore.findVersionByRef(scope, ref, ctx),
      evolution: evolutionGuard,
    })
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

    const coreModelRefs = modelComponentRefsOf(modelEnvironment, modelCapabilities)
    const componentRecords = [...scenarioComponentRecords(options.examples.scenarios, new Date().toISOString(), coreModelRefs),
      componentRecord({ kind: 'compute_extension', ref: componentRef('compute_extension', 'core-rule-derivation-producer', 'rule-derivation-producer@1.0.0'), capabilityNames: ['evidence.rule_derivation'], entrypoint: '@ontology/semantic-engine', now: hostClock().toISOString() }),
      ...(options.projectDataset === undefined ? [] : [componentRecord({ kind: 'data_backend', ref: DATA_POSTGRES_ADAPTER_REF, capabilityNames: ['structured_query'], entrypoint: '@ontology/adapter-data-postgres', now: hostClock().toISOString() })]),
    ]
    const bootstrapProfileSpecsByScenario = Object.fromEntries(options.examples.scenarios.map((scenario) => [
      scenario.scenarioId,
      profileSpecFor(scenario, DATA_DUCKDB_ADAPTER_REF),
    ]))
    await registerComponents(componentStore, componentRecords, scopeRef, profileContext, blobStore)
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
    // Mount the runnable task bindings for every scenario (SPEC v0.3a §EX-2.1): structured
    // query, document Q&A, rule judgement, registered compute and the legacy published-facts
    // path. They are declarative records; a normal `POST /runs` task request selects one.
    await mountCoreTaskBindings(taskBindingStore, options.examples.scenarios, scopeRef, profileContext)

    const mappings = new InMemorySemanticMappingRegistry(options.examples.scenarios.flatMap((scenario) =>
      scenario.physicalMappings.map((mapping) => mapping.mapping),
    ))
    const duckDb = await createDuckDbSnapshot(options.examples.scenarios)
    cleanup.unshift(async () => duckDb.close())
    const structuredImports = (options.projectStructuredImports ?? createCoreStructuredImportWorkflow)({ blobs: blobStore, parses: parseStore, ingestion: structuredStore, projects: projectStore,
      documents: projectDocumentStore, indexStore: keywordIndexStore, readiness: projectReadinessStore, executionBindings: runExecutionBindingStore, mappings: projectMappingStore })
    const documentSpanReader = structuredImports?.spanReader ?? new DocumentSpanReader({ blobs: blobStore, store: parseStore })
    const documentSearch = new Bm25DocumentSearchService({ indexStore: keywordIndexStore, spanReader: documentSpanReader })
    const projectDocumentIndexService = structuredImports?.index ?? new ProjectDocumentIndexService({
      store: projectDocumentStore,
      parseStore,
      indexStore: keywordIndexStore,
      spanReader: documentSpanReader,
      projects: projectStore,
      readiness: projectReadinessStore,
    })
    const publishedSourceList = await Promise.all(options.examples.scenarios.map(async (scenario) => {
      const definition = await semanticDefinitions.getVersion({ scopeRef, namespace: scenario.namespace, definitionId: scenario.definitionRef.id, version: scenario.definitionRef.version }, profileContext)
      if (!sameVersionRef(definition.ref, scenario.definitionRef)) throw new Error('the mounted source definition differs from the actual published version')
      return new PublishedSemanticSource(publicationStore, { identity: identityStore, definition })
    }))
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
    // The run-scoped rule-derivation evidence step (V03-028/029): the producer reads the exact
    // append-only materialized instance, bridges its premise/policy spans and records the
    // `rule_derivation` support payload under the run's own trusted context. It is reached only
    // through the fixed `rule_judgement` plan's `ontology_lookup(intent=rules)` step.
    const structuredPremiseSources = new StructuredPremiseSourceReader({ artifacts: blobStore, mappings: projectMappingStore, ingestion: structuredStore })
    const rulePremiseVerifier = new ArchivedRulePremiseReplayVerifier({ materialization: materializationStore, publications: publicationStore, evidence: evidenceStore, artifacts: blobStore,
      projects: projectStore, projectDocuments: projectDocumentStore, records: projectRecordStore,
      candidates: candidateStore, identity: identityStore, documentParses: parseStore, documentSpans: documentSpanReader, structuredSources: structuredPremiseSources, publishedRules: packRuleReader })
    const ruleDerivationProducer = new MaterializedRuleDerivationEvidenceProducer({
      materialization: materializationStore,
      evidence: evidenceStore,
      artifacts: createBlobArtifactWriter(blobStore),
      candidates: candidateStore,
      documentParses: parseStore,
      documentSpans: documentSpanReader,
      structuredSources: structuredPremiseSources,
      componentRef: componentRef('compute_extension', 'core-rule-derivation-producer', 'rule-derivation-producer@1.0.0'),
    })
    const semanticTasks = new CoreSemanticTaskResolver({
      projects: projectStore, taskBindings: taskBindingStore, materialization: materializationStore,
      source: createCoreSemanticTaskSource(publicationStore, { identity: identityStore }, { reader: packRuleReader, applies: async (revision, scope, ctx) => {
        const asset = await publishedPackStore.findPack(scope, revision.industryPackRef.id, revision.industryPackRef.version, ctx)
        if (asset === undefined) {
          const scenario = scenarioForIndustryRef(options.examples.scenarios, revision.industryPackRef)
          if (scenario !== undefined && sameVersionRef(scenario.definitionRef, revision.definitionRef)) return false
          const registered = await componentStore.findVersion({ kind: 'industry_pack', id: revision.industryPackRef.id, version: revision.industryPackRef.version }, scope, ctx)
          if (registered?.manifest.entrypointRef.kind === 'package' && registered.manifest.entrypointRef.ref === 'declarative-industry-manifest') throw new CoreCapabilityError('the registered declaration-pack loader has no actual immutable published pack')
          return false
        }
        if (!sameVersionRef(asset.packRef, revision.industryPackRef) || !sameVersionRef(asset.definitionRef, revision.definitionRef)) throw new CoreCapabilityError('the actual stored pack differs from the fixed project pack or definition')
        return true
      } }),
      definition: async (scope, ref, ctx) => definitionStore.findVersionByRef(scope, ref, ctx),
      operations: operationRegistry(), parameters: taskParameterValidator(createAjv()),
      computeInputAvailable: async (execution, revision, binding, ctx) => {
        if (revision.approvedInputRef !== undefined && sameVersionRef(execution.request.inputSnapshotRef, revision.approvedInputRef)) return true
        const snapshot = await taskInputSnapshotStore.getSnapshot(scopeRef, execution.request.inputSnapshotRef, ctx)
        const operation = binding.operationRef === undefined ? undefined : operationRegistry().operations.find((operation) => operation.operationRef.id === binding.operationRef?.id && operation.operationRef.version === binding.operationRef.version)
        return snapshot?.body.producedBy === 'core-approved-project-compute-input@1' && operation !== undefined && canonicalJson(operation.operationRef) === canonicalJson(EXAMPLE_OPERATION_REF) && snapshot.body.inputSchemaRef.digest === sha256DigestOf(canonicalJson(EXAMPLE_COMPUTE_DATA_SCHEMA)) && canonicalJson(snapshot.body.projectRevisionRef) === canonicalJson(revision.ref) && snapshot.body.baseInputRef !== undefined && snapshot.body.dependencies.some((ref) => sameVersionRef(ref,snapshot.body.inputSchemaRef))
      },
    })
    const relationsTask = new CoreRelationsTaskHandler({ executions: runExecutionBindingStore, selectors: semanticTasks, publications: publicationStore, identity: identityStore })
    const ontologyLookupHandler = createCoreOntologyLookupHandler({
      lookup: lookupHandler,
      producer: ruleDerivationProducer,
      sourceRef: { namespace: 'ontology-core-local', sourceId: 'materialized-rule-derivation' },
      relations: relationsTask,
      authorizeRule: async (request, ctx) => {
        const archived = await runExecutionBindingStore.getBindingByRun(scopeRef, ctx.runId, ctx)
        return archived !== undefined && semanticTasks.authorizeRule(request, archived.binding, ctx)
      },
    })
    // The registered-compute path (ADR-11, SPEC v0.3a §EX-6): the handler runs the registered
    // neutral example operation through the same bounded helpers the gateway uses. A handler
    // reaches only the fixed approved input refs through a scoped reader; the operation is
    // selected by its registered ref, never by model input.
    const computeArtifacts = createBlobArtifactWriter(blobStore)
    const computeReader: ScopedArtifactReader = {
      read: (request, ctx) => {
        const target = request.approvedInputRefs[0]
        if (target === undefined) throw new Error('the compute request carried no approved input reference')
        return blobStore.readAuthorized(
          { scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: target },
          ctx,
        )
      },
    }
    const computeResultStore = new PostgresComputeResultArtifactStore(database)
    const computeOutputBindingsStore = new PostgresComputeOutputBindingsStore(database)
    const computeInvocationStore = new PostgresComputeInvocationStore(database)
    const registeredComputeExecution = new RegisteredComputeExecutionService({ operations: operationRegistry(), handlers: createExampleComputeHandlers(exampleComputeArtifact),
      artifacts: computeArtifacts, reader: computeReader, validator: toolSchemaValidator(createAjv()), invocations: computeInvocationStore,
      outputBindings: computeOutputBindingsStore, resultArtifacts: computeResultStore })
    const dataQueryHandler = new DataQueryHandler({
      query: duckDb,
      catalog: duckDb,
      mappings,
      consistency: 'immutable',
      dataMode: 'synthetic',
      catalogSourceRef: { namespace: 'ontology-core-local', sourceId: 'duckdb-synthetic-snapshot' },
      compute: {
        registry: operationRegistry(),
        handlers: createExampleComputeHandlers(exampleComputeArtifact),
        artifacts: computeArtifacts,
        reader: computeReader,
        validator: toolSchemaValidator(createAjv()),
      },
    })
    const documentSearchHandler = structuredImports?.handler ?? createCoreDocumentSearchHandler({
      service: documentSearch,
      spanReader: documentSpanReader,
      dataMode: 'observed',
    })
    const gatewayComposition = createToolGatewayComposition({
      database,
      blobStore,
      budget,
      validator: toolSchemaValidator(createAjv()),
      handlers: [ontologyLookupHandler, projectQuery.handler(dataQueryHandler), documentSearchHandler],
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
    const executionPreflight = new RunExecutionPreflightService({
      projects: projectStore,
      taskBindings: taskBindingStore,
      inputSnapshots: taskInputSnapshotStore,
      runExecutionBindings: runExecutionBindingStore,
      readiness: projectReadinessStore,
      operations: operationRegistry(),
      availableCapabilities: resolvedCapabilitiesFrom(componentRecords),
      supportedResultSchemaRefs: [CORE_TYPED_RESULT_SCHEMA_REF],
      effectiveLimitsRef: CORE_EFFECTIVE_LIMITS_REF,
      parameters: taskParameterValidator(createAjv()),
      projectQuerySnapshot: projectQuery.resolveForCreation,
      ...(structuredImports === undefined ? {} : { projectDocumentIndexSnapshot: structuredImports.resolveForCreation }),
      questionQuerySnapshot: projectQuery.resolveQuestionForCreation,
      projectApprovedInput: async (scope: ScopeRef, revision: import('@ontology/contracts').ProjectRevision, ctx: ToolContext) => (await projectEvolution?.resolveApprovedInput(scope, revision, ctx)) ?? await normalApprovedInputs.current?.resolve(scope, revision, ctx),
    })
    const runs = new RunService({
      store: runStore,
      control,
      profiles: runProfileBinder,
      execution: executionPreflight,
    })
    const phase = new RunPhaseDriver({ store: runStore, control })
    const dispatchFences = new Map<Uuid, WorkflowDispatchFence>()
    // Both real runtimes are assembled here at the normal Core entry: the deterministic
    // Template executor (fixed/known-step paths) and the dynamic Pi runtime (bounded
    // "query insufficient → supplement → complete" collection). A run selects exactly one
    // by the runtime pinned in its resolved profile; the selector never chooses for it, and
    // both adapters share the same gateway, resolved profile and single budget ledger.
    const runtimeRecords = componentRecords.filter((record) => record.manifest.kind === 'runtime')
    const templateRuntimeRecord = runtimeRecords.find((record) => record.manifest.id === 'runtime-template')
    if (templateRuntimeRecord === undefined) throw new Error('Core template runtime component is not registered')
    const piRuntimeRecord = runtimeRecords.find((record) => record.manifest.id === 'runtime-pi')
    if (piRuntimeRecord === undefined) throw new Error('Core Pi runtime component is not registered')
    const planResolver = new CoreTemplatePlanResolver({
      runs,
      profiles: profileResolver,
      manifests: workflowStore,
      receipts: planReceiptStore,
      semanticDefinitions,
      mappings,
      scenarios: options.examples.scenarios,
      scopeRef,
      modelRefs: coreModelRefs,
      taskBindings: taskBindingStore,
      executionBindings: runExecutionBindingStore,
      operations: operationRegistry(),
      decisionStateRefProvider,
      projectQueryDescriptor: projectQuery.resolveExecution,
      semanticTasks,
      isRouteClarificationReceiptApproved: (input, ctx) => decisionStateReferences.isApproved(scopeRef, input, ctx),
    })
    const templateRuntime = new TemplateRuntimeAdapter({ manifest: templateRuntimeRecord.manifest, plans: planResolver })
    // The Pi adapter is the same class the conformance suite exercises: it exposes only the
    // canonical four model tools and every proposal is authorized and executed by the run's
    // gateway. Its generation model reference matches the registered Core generation
    // component, so a profile that binds generation drives the real model port; when no
    // generation model is configured the capability factory still hands it the disabled
    // port, and the run fails explicitly instead of fabricating an answer.
    const piRuntime = new PiRuntimeAdapter({
      manifest: piRuntimeRecord.manifest,
      toolIds: TOOL_CATALOGUE.map((tool) => tool.toolId),
      modelRef: {
        modelId: coreModelRefs.generation?.id ?? 'model-not-configured',
        version: COMPONENT_VERSION,
        provider: 'ontology',
      },
      generationRole: 'planner',
    })
    const runtimeAdapterByRef = new Map<string, RuntimeAdapter>([
      [versionRefKey(templateRuntimeRecord.manifestRef), templateRuntime],
      [versionRefKey(piRuntimeRecord.manifestRef), piRuntime],
    ])
    const runAllowedCollectionRefs = async (runId: Uuid, ctx: ToolContext): Promise<readonly string[]> => {
      const archived = await runExecutionBindingStore.getBindingByRun(scopeRef, runId, ctx)
      const request = archived?.binding.request
      if (request === undefined) return []
      if (request.mode === 'question') {
        const bindings = await Promise.all(archived!.binding.allowedTaskBindingRefs.map((ref) => taskBindingStore.getBinding(scopeRef, ref, ctx)))
        return bindings.some((binding) => binding?.kind === 'document_qa') ? [projectCollectionRef(request.projectRevisionRef.projectId)] : []
      }
      const binding = await taskBindingStore.getBinding(scopeRef, request.taskBindingRef, ctx)
      // A document-QA run may search only its own pinned project's host-minted collection.
      return binding?.kind === 'document_qa'
        ? [projectCollectionRef(request.projectRevisionRef.projectId)]
        : []
    }
    const termLabels = createCoreDefinitionLabelReader({ packs: publishedPackStore, candidates: assetCandidateStore,ruleActions: ruleActionCandidateStore })
    const authoring = createCoreAuthoring({ blobs: blobStore, registry: artifactRegistry, objectStore, workspaces: workspaceStore, jobs: jobStore, parses: parseStore, structured: structuredStore, operations: operationRegistry(), models: modelCapabilities, terminology: { getTerminology: (...args) => terminology.getTerminology(...args) }, termLabels })
    const tableArtifactStore = new PostgresTableArtifactStore(database, { writer: gatewayComposition.artifacts, reader: scopedOriginals })
    const tableVerificationStore = new PostgresTableVerificationStore(database)
    const tableSchema = SCHEMA_DOCUMENTS.find((schema) => schema['$id'] === 'https://ontology.local/schema/tools.schema.json')
    if (tableSchema === undefined) throw new CoreCapabilityError('the actual canonical query output schema is unavailable')
    const tableSchemaRef = await authoring.stableWrite(`core-data-query-output-schema:${sha256DigestOf(canonicalJson(tableSchema))}`,new TextEncoder().encode(canonicalJson(tableSchema)),'application/schema+json','artifact',profileContext)
    const tableResults = createCoreTableResults({ evidence: evidenceStore,artifacts: blobStore,pages: tableArtifactStore,manifests: tableArtifactStore,receipts: tableVerificationStore,finalizationReceipts: taskFinalizationReceiptStore,
      columnLabels: async (input,ctx) => {
        const trustedScope = { tenantId: ctx.principal.tenantId,spaceId: ctx.allowedResources.spaceId }
        const saved = await runExecutionBindingStore.getBindingByRun(trustedScope,input.runId,ctx)
        if (saved === undefined || canonicalJson(saved.ref) !== canonicalJson(input.executionBindingRef)) throw new CoreCapabilityError('column names require this exact saved run execution binding')
        const request = saved.binding.request, revision = await projectStore.getRevision(trustedScope,request.projectRevisionRef.projectId,request.projectRevisionRef.revision,ctx)
        if (revision === undefined || canonicalJson(revision.ref) !== canonicalJson(request.projectRevisionRef)) throw new CoreCapabilityError('column names require the exact fixed published project definition')
        const selection = request.mode === 'task' ? request : await planReceiptStore.selectedTaskForRun(trustedScope,ctx)
        const labels = await termLabels(trustedScope,revision.industryPackRef,revision.definitionRef,ctx)
        return Object.fromEntries(labels?.attributes.filter((attribute) => attribute.objectId === selection?.parameters['objectId']).map((attribute) => [attribute.attributeId,attribute.displayName]) ?? [])
      },
      writer: { putBytes: async (input,ctx) => { const digest = `sha256:${createHash('sha256').update(input.content).digest('hex')}` as const
        const ref = await authoring.stableWrite(`table-artifact:${digest}`,input.content,input.mediaType,'artifact',ctx)
        return { blobRef: ref,contentDigest: digest,integrity: { algorithm: 'sha256',digest,verifiedAt: hostClock().toISOString() } } } },
      findArtifact: (_scope,digest,ctx) => authoring.findStableArtifact(`table-artifact:${digest}`,ctx),tableOutputSchema: { ref: tableSchemaRef,body: tableSchema },
      verifier: new TableHardVerificationService({ pages: tableArtifactStore,receipts: tableVerificationStore,progress: tableVerificationStore,artifacts: blobStore,evidence: evidenceStore }) })
    const draftVerifier = new DraftVerificationService({ evidence: evidenceStore,artifacts: blobStore,rulePremises: rulePremiseVerifier,decisionStateRefProvider,
      policy: { ...DEFAULT_VERIFICATION_POLICY,semanticReview: 'disabled' } })
    const controllerDependencies = {
      runs,
      phase,
      budget,
      manifests: workflowStore,
      runtimes: {
        select: async (runtimeRef: VersionRef) => {
          const adapter = runtimeAdapterByRef.get(versionRefKey(runtimeRef))
          if (adapter === undefined) {
            throw new CoreCapabilityError(`this local deployment does not register runtime ${runtimeRef.id}@${runtimeRef.version}`)
          }
          return adapter
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
          const generationBound = profileModelBindingEnabled(resolved.resolved.modelBindings['generation'], coreModelRefs.generation)
          const decisionBound = profileModelBindingEnabled(resolved.resolved.modelBindings['decision'], coreModelRefs.decision)
          const modelExecution = modelCapabilities.forExecution({
            ledgerId: binding.budgetLedgerId,
            signal: binding.signal,
          })
          return {
            gateway,
            generation: generationBound ? modelExecution.generation ?? DISABLED_GENERATION : DISABLED_GENERATION,
            decision: decisionBound ? modelExecution.decision ?? disabledDecision() : disabledDecision(),
            checkpoints: createRunCheckpointPort(runStore),
          } satisfies RuntimeCapabilitySet
        },
      } satisfies RuntimeCapabilityFactoryPort,
      draftWriter: new TypedEvidenceDraftWriter({
        evidence: evidenceStore,
        artifacts: blobStore,
        // A task-bound run resolves its archived typed result manifest and finalization receipt
        // through the real execution/published-task bindings, so the production path emits an
        // `answer-draft@3`; a legacy run without an execution binding stays on `@2`.
        typedResult: new RunTypedResultContextSource({
          runs: runStore,
          executionBindings: runExecutionBindingStore,
          taskBindings: taskBindingStore,
          manifests: workflowStore,
          evidence: evidenceStore,
          artifacts: blobStore,
          artifactWriter: gatewayComposition.artifacts,
          receipts: taskFinalizationReceiptStore,
          questionTaskSelection: (ctx) => planReceiptStore.selectedTaskForRun(scopeRef, ctx),
          tables: tableResults.build,
        }),
      }),
      limited: new RestrictedLimitedAnswerComposer(),
      verifier: { verify: async (request: Parameters<DraftVerificationService['verify']>[0],ctx: ToolContext) => { await tableResults.verify(request.draft,ctx); return draftVerifier.verify(request,ctx) } },
      verifications: workflowStore,
      publisher: new AnswerPublicationService({
        runs: runStore,
        answers: answerStore,
        verifications: workflowStore,
        manifests: workflowStore,
        tableVerifications: tableResults.requirements,
        registerTables: tableResults.register,
        validity: new CorePublicationValidity({
          rulePremises: rulePremiseVerifier,
          ...(structuredImports === undefined ? {} : { documentSources: structuredImports.publicationValidator }),
          relations: relationsTask,
          evidence: evidenceStore,
          artifacts: blobStore,
          facts,
          scopeRef,
          tables: tableVerificationStore,
          policies: new PostgresTaskPolicyReportStore(database),
        }),
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
        const profile = await profileResolver.getResolvedProfile({ scopeRef, profileRef: run.profileRef, snapshotHash: run.resolvedProfileHash }, runContext)
        const scenario = scenarioForIndustryRef(options.examples.scenarios, profile.resolved.industryRef)
        const archived = await runExecutionBindingStore.getBindingByRun(scopeRef, runId, runContext)
        if (scenario === undefined && archived === undefined) throw new CoreCapabilityError('the profile needs an actual archived project execution binding')
        const snapshotRef = archived?.binding.projectDatasetSnapshotRef
        const sources = snapshotRef === undefined ? scenario === undefined ? [] : sourceRefsOf(scenario) : [projectQuery.sourceRef(snapshotRef.id)]
        return workerContext(scopeRef, sources, runId, run.resolvedProfileHash, hostClock, await runAllowedCollectionRefs(runId, runContext))
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
    const materializer = new IncrementalMaterializer({ publishedSource: new CoreProjectSemanticPartitions(multiSchemaSource, semanticTasks, async (scope, ctx) => {
      const projects = [...await projectStore.listProjects(scope, { state: 'draft', limit: 33 }, ctx), ...await projectStore.listProjects(scope, { state: 'active', limit: 33 }, ctx)]
      if (projects.length > 32) throw new CoreCapabilityError('the actual current project partition inventory exceeds 32 projects')
      const revisions = []
      for (const project of projects) {
        const revision = await projectStore.getRevision(scope, project.projectId, project.activeRevision ?? project.headRevision, ctx)
        if (revision === undefined) throw new CoreCapabilityError('the current project partition revision is unavailable')
        revisions.push(revision)
      }
      return revisions
    }), materialization: materializationStore })
    const materializationConsumer = new MaterializationOutboxConsumer({
      materializer,
      publications: publicationStore,
      sequence: controlRecordSequence(control, 'semantic.core-local-materialization'),
      outbox: jobStore,
      materialization: materializationStore,
    })
    const outboxConsumer = new TopicOutboxConsumerRouter(
      [
        createBusinessMaterializationConsumer({ inner: materializationConsumer, publications: publicationStore, projects: projectStore, candidates: candidateStore, identity: identityStore,
          afterBusinessMaterialization: createCoreProjectSemanticReadiness({ projects: projectStore,readiness: projectReadinessStore,profiles: profileResolver,selectors: semanticTasks,materialization: materializationStore,publications: publicationStore,identity: identityStore,authoring,now: () => hostClock().toISOString() }) }),
        createCompetencyPreviewOutboxConsumer({ projects: projectStore, jobs: jobStore }),
        new CoreFactsOutboxFallback(candidateStore, scopeRef),
        new IndustryWorkspaceOutboxConsumer(workspaceStore, scopeRef),
        new PackPublicationOutboxConsumer(publishedPackStore, scopeRef),
        new ProjectRevisionOutboxConsumer(projectStore, scopeRef),
        new ProjectEvolutionOutboxConsumer({ rebuild: (...args) => {
          if (projectEvolution === undefined) throw new CoreCapabilityError('the actual project evolution workflow is not initialized')
          return projectEvolution.rebuild(...args)
        } }),
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

    const runValidation = async (
      submission: { readonly profileRef: ProfileRef; readonly question: string; readonly scopeRef: ScopeRef; readonly task?: RunExecutionRequest },
      ctx: ToolContext,
    ) => {
      // A fixed task run resolves its own deterministic plan and its own input/approved refs
      // through the run execution binding; its capability/readiness preflight already ran in
      // `RunExecutionPreflightService`, so it must not be forced through the ordinary NL
      // generation/data_query admission. The legacy `facts:` path keeps its dedicated check.
      if (submission.task !== undefined && submission.task.mode === 'task') return
      if (submission.task?.mode === 'question') {
        const binding = await profileResolver.bindRunProfile(submission.profileRef, submission.scopeRef, ctx)
        const actual = await profileResolver.getResolvedProfile({ scopeRef: submission.scopeRef, profileRef: submission.profileRef, snapshotHash: binding.resolvedProfileHash }, ctx)
        if (!profileModelBindingEnabled(actual.resolved.modelBindings['generation'], coreModelRefs.generation)) throw new CoreCapabilityError('natural-language task selection is not configured for this actual project profile')
        if (!actual.resolved.toolBindings.some((tool) => tool.enabled && ['ontology_lookup', 'data_query', 'document_search'].includes(tool.toolId))) throw new CoreCapabilityError('this actual project profile has no enabled supported data tool')
        return
      }
      const { scenario, resolved, snapshotHash } = await resolveScenarioProfile(
        profileResolver,
        options.examples.scenarios,
        submission.profileRef,
        submission.scopeRef,
        ctx,
      )
      if (submission.question.trim().startsWith('facts:')) {
        if (!resolved.toolBindings.some((binding) => binding.toolId === 'ontology_lookup' && binding.enabled)) {
          throw new CoreCapabilityError('this profile does not enable ontology_lookup for registered facts tasks')
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
        return
      }
      if (!resolved.toolBindings.some((binding) => binding.toolId === 'data_query' && binding.enabled)) {
        throw new CoreCapabilityError('ordinary natural-language queries require data_query to be enabled in the resolved profile')
      }
      if (!modelCapabilities.generationEnabled || !profileModelBindingEnabled(resolved.modelBindings['generation'], coreModelRefs.generation)) {
        throw new CoreCapabilityError('ordinary natural-language queries require a configured generation model bound by the resolved profile')
      }
      const catalog = resolved.backendBindings['catalog']
      if (catalog === undefined || !sameVersionRef(catalog.adapterRef, DATA_DUCKDB_ADAPTER_REF) || resolved.mappingRefs.length === 0) {
        throw new CoreCapabilityError('ordinary semantic queries require the run profile’s mounted read-only catalog mapping')
      }
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
      const snapshotHash = active?.snapshotHash ?? (await profileResolver.bindRunProfile(profileRef, scopeRef, profileContext)).resolvedProfileHash
      const resolvedRecord = await profileResolver.getResolvedProfile({ scopeRef, profileRef, snapshotHash }, profileContext)
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
        models: {
          generation: profileModelBindingEnabled(resolvedRecord.resolved.modelBindings['generation'], coreModelRefs.generation),
          decision: profileModelBindingEnabled(resolvedRecord.resolved.modelBindings['decision'], coreModelRefs.decision),
        },
      }
    }

    const competencyQuestions = createCompetencyQuestionWorkflow({ blobs: blobStore, registry: artifactRegistry, reviews: publicationStore })
    const reviewableCandidates = new CompositeReviewableCandidateReader({
      competencyQuestions: competencyQuestions.service,
      definition: assetCandidateStore,
      instance: candidateStore,
      ruleActions: ruleActionCandidateStore,
    })
    publishedPackRules.current = new PublishedPackRuleDeclarationReader({ packs: publishedPackStore, registry: componentStore, definitions: definitionStore,
      candidates: ruleActionCandidateStore, reviews: publicationStore, reviewableCandidates, projects: projectStore })
    const projectFacts = createProjectFactWorkflow({
      materialization: { projects: projectStore, mappings: projectMappingStore, records: projectRecordStore,
        projectDocuments: projectDocumentStore, ingestion: structuredStore, candidates: candidateStore, schemaSource, jobs: jobStore,
        resolveSourceJob: async (scope, parseId, ctx, definitionRef) => {
          const parse = await structuredStore.getParse(scope, parseId, ctx)
          if (parse === undefined || parse.parseOptions === undefined) return undefined
          const documentRef = encodeStructuredExtractionRef({ kind: 'structured_extraction', parseId, parserVersion: parse.parserVersion,
            definitionRef, format: parse.format, originalRef: parse.originalRef, originalMediaType: parse.originalMediaType, options: parse.parseOptions })
          const job = await new JobService({ store: jobStore }).createJob({ jobId: randomUUID(), kind: 'ingestion',
            sourceRef: parse.originalRef.id, documentRef, pipelineVersion: '1.0.0', initialStage: 'awaiting_review',
            initialCounts: { total: parse.counts.total, processed: parse.counts.succeeded, failed: parse.counts.failed, skipped: parse.counts.skipped }, idempotencyKey: `core-fact-source:${parseId}:${definitionRef.digest}` }, ctx)
          return job.jobId
        } },
      publication: { store: publicationStore, identity: identityStore, reviewableCandidates }, instanceRecords: instanceReviewStore,
    })
    const semanticPublication = projectFacts.publication
    const identityService = new IdentityDecisionService({ store: identityStore, candidates: candidateStore, schemaSource })

    const terminology = terminologySourceFor(options.examples.scenarios, publishedPackStore, definitionStore, componentStore)
    const ruleSupport = new FiniteGrammarRuleSupportValidator()
    const sourceGrounding = createSourceGroundingService({ workspaces: workspaceStore,
      documentSets: new ArtifactGroundingDocumentSetReader(blobStore),
      reader: new ParsedSourceGroundingReader({ blobs: blobStore, documents: parseStore, tables: structuredStore }) })
    const generationForRun = async ({ ctx, signal }: { readonly ctx: ToolContext; readonly signal: AbortSignal }): Promise<GenerationPort | undefined> => {
      if (!modelCapabilities.generationEnabled) return undefined
      signal.throwIfAborted()
      const ledger = await budget.openLedger({ ledgerId: randomUUID(), kind: 'background', runId: ctx.runId }, ctx)
      signal.throwIfAborted()
      return modelCapabilities.forExecution({ ledgerId: ledger.ledgerId, signal }).generation
    }
    const actionBindingContext = (): ActionCapabilityBindingInput => ({ registry: operationRegistry(), availableCapabilities: ['agent_runtime', 'structured_query', 'document_search', 'industry.semantics'], recordedAt: hostClock().toISOString() })
    const ruleActionCandidateService = new RuleActionCandidateService({
      workspaces: workspaceStore,
      candidates: ruleActionCandidateStore,
      support: ruleSupport,
    })
    const definitionGenerationService = new DefinitionCandidateGenerationService({
      sourceGrounding,
      competencyQuestions: competencyQuestions.service,
      workspaces: workspaceStore,
      candidates: assetCandidateStore,
      terminology,
      generationForRun,
      modelRef: {
        modelId: options.modelsEnabled === true ? modelEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID'] ?? 'model-not-configured' : 'model-not-configured',
        version: COMPONENT_VERSION,
      },
      outputLimit: { maxTokens: 16_384 },
    })
    const ruleActionGenerationService = new RuleActionCandidateGenerationService({
      workspaces: workspaceStore, definitionCandidates: assetCandidateStore, candidates: ruleActionCandidateStore,
      batches: ruleActionGenerationStore, service: ruleActionCandidateService, terminology, sourceGrounding,
      generationForRun, bindingContext: actionBindingContext,
      modelRef: { modelId: modelEnvironment['CORE_COMPANY_MODEL_PLATFORM_ID'] ?? 'model-not-configured', version: COMPONENT_VERSION }, outputLimit: { maxTokens: 16_384 },
    })
    const definitionEditingService = new DefinitionCandidateEditingService({
      publishedPacks: publishedPackStore,
      reviewableCandidates,
      reviews: publicationStore,
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
    const competencyTarget = createCompetencyValidationTargetReader({ workspaces: workspaceStore, definitionCandidates: assetCandidateStore,
      ruleActions: ruleActionCandidateStore, ruleGeneration: ruleActionGenerationStore, reviews: publicationStore, reviewableCandidates,
      definitions: definitionStore, candidates: candidateStore, grounding: sourceGrounding, publishedRules: packRuleReader, packs: publishedPackStore,
      sourceDraft: async (scope, workspaceId, current, ctx, signal) => (await readWorkspacePublicationSourceDrafts({ workspaces: workspaceStore, packs: publishedPackStore, definitions: assetCandidateStore, ruleActions: ruleActionCandidateStore }, scope, workspaceId, current, ctx, signal)).at(-1) })
    let executionPreview: ReturnType<typeof createCoreExecutionPreview> | undefined
    const competencyRunner = createNormalCoreCompetencyExecution({ database, blobs: blobStore, parses: parseStore, structured: structuredStore,
      query: projectDatasetAdapter, producerComponentRef: componentRef('compute_extension', 'core-rule-derivation-producer', 'rule-derivation-producer@1.0.0'),
      binding: async (request, ctx) => executionPreview?.bindingFor(request, ctx), target: competencyTarget, publishedRules: packRuleReader, packs: publishedPackStore,
      questions: competencyQuestions, profiles: profileStore, budget, operations: operationRegistry(), artifacts: gatewayComposition.artifacts, reader: scopedOriginals,
      gateway: ({ runId, ledgerId, resolved }) => gatewayComposition.forRun({ runId, ledgerId, resolvedProfile: resolved, operations: operationRegistry() }),
    })
    const industryValidationService = new IndustryValidationService({
      requireCompetencyQuestions: true,
      competencyRunner,
      workspaces: workspaceStore,
      exampleSets: syntheticExampleSetStore,
      reports: validationReportStore,
      definitions: definitionEditingService,
      ruleActions: ruleActionCandidateStore,
      support: ruleSupport,
      evaluator: new FiniteGrammarSyntheticEvaluator(),
    })
    const industryAssetPublicationService = new IndustryAssetPublicationService({
      requireCompetencyQuestions: true,
      competencyQuestions: competencyQuestions.service,
      reviewableCandidates,
      reviews: publicationStore,
      workspaces: workspaceStore,
      validations: validationReportStore,
      definitionCandidates: assetCandidateStore,
      ruleActions: ruleActionCandidateStore,
      syntheticSets: syntheticExampleSetStore,
      definitions: definitionStore,
      store: publishedPackStore,
    })
    const staticPackCatalogue = new InMemoryIndustryPackCatalogue()
    for (const scenario of options.examples.scenarios) staticPackCatalogue.registerPack({ ref: componentRef('industry_pack', scenario.industryManifest.namespace, scenario.industryManifest), manifest: scenario.industryManifest, testSuite: scenario.testSuite })
    const packCatalogue = new StoreBackedIndustryPackCatalogue({ store: publishedPackStore, fallback: staticPackCatalogue })
    const componentRegistry = new ComponentRegistry({
      control,
      store: componentStore,
      artifacts: blobStore,
      validator: manifestValidator(createAjv()),
    })
    const previewHost = options.examples.scenarios[0]
    const packExecutionProfiles = previewHost === undefined ? undefined : createCorePackExecutionProfiles({ packs: publishedPackStore, definitions: definitionStore,
      components: componentRegistry, profiles: profileResolver, authoring, executionProfileRef: previewHost.profileRef,
      dataBackendRef: options.projectDataset === undefined ? DATA_DUCKDB_ADAPTER_REF : DATA_POSTGRES_ADAPTER_REF, semanticCapability: capability('semantic_read') })
    if (packExecutionProfiles !== undefined) executionPreview = createCoreExecutionPreview({ workspaces: workspaceStore, definitions: definitionStore,
      terms: assetCandidateStore, actions: ruleActionCandidateStore, reviews: publicationStore, reviewable: reviewableCandidates,
      validation: industryValidationService, publication: industryAssetPublicationService, packs: publishedPackStore,
      executionProfiles: packExecutionProfiles, rules: packRuleReader, authoring, actionContext: actionBindingContext, reader: scopedOriginals, validateTarget: competencyTarget, termLabels })
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
      evolutionPolicy: 'staged_only',
      projects: projectStore,
      readiness: projectReadinessStore,
      jobs: jobStore,
      catalogue: packCatalogue,
    })
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
    const instanceIdentity = createCoreInstanceIdentity({ projects: projectStore, documents: projectDocumentStore, candidates: candidateStore, identities: identityStore, instances: instanceReviewStore, schemas: schemaSource, reader: scopedOriginals })
    const projectEvolutionStore = new PostgresProjectEvolutionStore(database)
    normalApprovedInputs.current = createCoreApprovedInput({ projects: projectStore, documents: projectDocumentStore, records: projectRecordStore,evolutions: projectEvolutionStore,identity: identityStore,mappings: projectMappingStore,
      instances: instanceReviewStore, candidates: candidateStore, reviews: publicationStore, reviewable: reviewableCandidates,
      schemas: schemaSource, source: publishedProjectDatasetSource, reader: scopedOriginals, authoring })
    const approvedInputs = normalApprovedInputs.current
    const resolveApprovedInput = async (scope: ScopeRef, revision: import('@ontology/contracts').ProjectRevision, ctx: ToolContext, signal: AbortSignal) => {
      const evolved = await projectEvolution?.resolveApprovedInput(scope, revision, ctx)
      if (signal.aborted) throw new RunServiceError('DEADLINE_EXCEEDED', 'the normal run input validation was cancelled', { cause: signal.reason })
      return evolved ?? approvedInputs.resolve(scope, revision, ctx, signal)
    }
    const prepareComputeInput = createCoreProjectComputeInput({ blobs: blobStore, authoring, snapshots: taskInputSnapshotStore,
      schemas: schemaSource, operations: operationRegistry(), validator: taskParameterValidator(createAjv()), validateBase: resolveApprovedInput })
    projectEvolution ??= createProjectEvolutionWorkflow({ projects: projectStore, store: projectEvolutionStore, mappings: projectMappingStore,
      mappingService: projectMappingService, documents: projectDocumentStore, catalogue: packCatalogue, schemas: schemaSource, jobs: jobStore,
      facts: projectFacts.materialization, candidates: candidateStore, publications: publicationStore, publishedSource: publishedProjectDatasetSource,
      readiness: projectReadinessStore, records: projectRecordStore, profiles: profileStore,
      input: { writer: gatewayComposition.artifacts, reader: scopedOriginals, instances: instanceReviewStore },
      instances: { createRecord: (scope, projectId, input, ctx) => instanceIdentity.identity.createRecord(scope, projectId, input, ctx) },
      dataset: { writer: projectDatasetAdapter, query: projectDatasetAdapter },
      previousInput: { archive: (scope, revision, ctx) => approvedInputs.resolve(scope, revision, ctx),
        validate: (scope, revision, ref, ctx,plan) => approvedInputs.validateCaptured(scope, revision, ref, ctx,undefined,plan) },
      targetIdentityMapping: (_scope,projectId,definitionRef,ctx) => projectApi.targetIdentityMapping(projectId,definitionRef,ctx),
    }).service
    const projectApi = createCoreProjectApi({ projects: projectStore, documents: projectDocumentStore, jobs: jobStore, readiness: projectReadinessStore,
      catalogue: packCatalogue, profiles: profileResolver, schemas: schemaSource, tasks: taskBindingStore, operations: operationRegistry(),
      availableCapabilities: resolvedCapabilitiesFrom(componentRecords), resultSchemaRef: CORE_TYPED_RESULT_SCHEMA_REF,
      blobs: blobStore, parses: parseStore, structured: structuredStore, authoring, identity: instanceIdentity, facts: projectFacts.materialization, evolutions: projectEvolutionStore, selectors: semanticTasks, termLabels, computeInputConfigured: true, publications: publicationStore, documentSetFor: structuredImports.documentSet })
    const resolveRunRequest = createCoreRunRequestResolver({ projects: projectStore, runs: runStore, bindings: runExecutionBindingStore, tasks: taskBindingStore,
      inputs: { ...approvedInputs, resolve: (scope, revision, ctx, signal) => resolveApprovedInput(scope, revision, ctx, signal ?? new AbortController().signal) },
      prepareComputeInput, authoring, reader: scopedOriginals, now: () => hostClock().toISOString() })
    const projectStructuredImportService = structuredImports.imports
    // A manifest is only served as *verified* when the table-verification receipt it names
    // actually exists. Otherwise the reader refuses to render it as a formal table
    // (TABLE_UNVERIFIED) instead of trusting the stored ref alone.
    const verifiedTableManifests: VerifiedTableManifestSource = createCoreVerifiedTableSource({ answers: answerStore, runs: runStore,
      tables: tableArtifactStore, receipts: tableVerificationStore, blobs: blobStore })
    const sourceViews = createCoreSourceViewReader({ answers: answerStore, evidence: evidenceStore, runs: runStore, manifests: workflowStore,
      executionBindings: runExecutionBindingStore, blobs: blobStore, parses: parseStore, ingestion: structuredStore, projects: projectStore,
      documents: projectDocumentStore, instances: instanceReviewStore, candidates: candidateStore, records: projectRecordStore, mappings: projectMappingStore,
      datasets: projectDatasetAdapter, publications: publicationStore, computeInvocations: computeInvocationStore, computeResults: computeResultStore, computeBindings: computeOutputBindingsStore,
      tasks: taskBindingStore, taskInputs: taskInputSnapshotStore, verifiedTables: verifiedTableManifests, tablePages: tableArtifactStore, tableReceipts: tableVerificationStore,
      provenance: provenanceRead.provenance,
      publishedRuleReplay: () => new ArchivedRulePremiseReplayVerifier({ materialization: materializationStore, publications: publicationStore,
        evidence: evidenceStore, artifacts: blobStore, projects: projectStore, projectDocuments: projectDocumentStore, records: projectRecordStore,
        candidates: candidateStore, identity: identityStore, documentParses: parseStore, documentSpans: documentSpanReader,
        structuredSources: structuredPremiseSources, publishedRules: packRuleReader, readMode: 'published_snapshot' }),
    })
    const tableArtifactReadService = new TableArtifactReadService({
      manifests: verifiedTableManifests,
      pages: tableArtifactStore,
      progress: tableArtifactStore,
    })
    const verifiedResultReadService = new VerifiedResultReadService({
      answers: answerStore,
      results: {
        getAuthorized: (request, ctx) => blobStore.getAuthorized(request, ctx),
        readAuthorized: (request, ctx) => blobStore.readAuthorized(request, ctx),
      },
      tables: verifiedTableManifests,
    })
    // Verified JSON export (V03-041) reuses the same digest-verified read as the verified page,
    // so an export can never reflect an unverified or swapped manifest.
    const verifiedResultExportService = new VerifiedResultExportService({
      reads: verifiedResultReadService,
      answers: answerStore,
      tables: verifiedTableManifests,
    })
    // Result revision history (V03-041): the run's own fixed version plus prior answers for the
    // same project revision lineage, read from the append-only answer store.
    const resultHistoryService = new ResultHistoryService({
      answers: answerStore,
      bindings: runExecutionBindingStore,
      history: answerStore,
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
          resolveRequest: resolveRunRequest,
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
        answers: {
          reader: controller,
          result: verifiedResultReadService,
          tables: tableArtifactReadService,
          exporter: verifiedResultExportService,
          history: resultHistoryService,
        },
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
        ruleActionCandidates: { service: ruleActionCandidateService, generation: ruleActionGenerationService, bindingContext: actionBindingContext },
        competencyQuestions: { service: competencyQuestions.service, uploadSource: competencyQuestions.uploadSource },
        instanceReviews: { service: instanceReviewService, identity: instanceIdentity.identity, identityContext: instanceIdentity.identityContext },
        projects: { service: projectService, mappings: projectMappingService, afterMappingConfirmed: projectApi.afterMappingConfirmed, dataset: projectDatasetService, evolution: projectEvolution },
        projectDocuments: { service: projectDocumentIndexService },
        syntheticValidation: {
          exampleService: syntheticExampleService,
          validationService: industryValidationService,
          bindingContext: actionBindingContext,
        },
      },
      registerRoutes: (api, authenticate) => {
        authoring.register(api, authenticate)
        projectApi.register(api, authenticate)
        executionPreview?.register(api, authenticate)
        packExecutionProfiles?.register(api, authenticate)
        registerCoreSourceViewRoutes(api, { reader: sourceViews, authenticate, contextFor: (auth, traceId) => createRequestToolContext({ ...auth, traceId, runId: randomUUID() }) })
        registerCoreImportRoute({
          app: api,
          authenticate,
          scopeRef,
          examples: options.examples,
          service: jobService,
          objectStore,
          registry: artifactRegistry,
          generationEnabled: modelCapabilities.generationEnabled,
        })
        registerCoreRelationNavigationRoute({
          app: api,
          authenticate,
          examples: options.examples,
          publications: publicationStore,
          identity: identityStore,
        })
        registerProjectImportRoute(api, {
          authenticate,
          scopeRef,
          service: projectStructuredImportService,
        })
      },
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }

    // Start recovery only after every normal source, input and evolution port is mounted.
    jobLoopAbort = new AbortController()
    jobLoopPromise = jobLoop.start(jobLoopAbort.signal)
    dispatchAbort = new AbortController()
    dispatchWorkerPromise = workflowDispatchWorker.run(dispatchAbort.signal)
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
