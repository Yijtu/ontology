import { createHash } from 'node:crypto'
import { PostgresComputeInvocationStore, PostgresComputeOutputBindingsStore, PostgresComputeResultArtifactStore } from '@ontology/adapter-control-postgres'
import { DocumentSpanReader, StructuredClauseSourceReader, StructuredPremiseSourceReader } from '@ontology/adapter-extraction-document'
import { Bm25DocumentSearchService, ProjectDocumentIndexService } from '@ontology/adapter-search-bm25'
import { ArchivedRulePremiseReplayVerifier, InMemorySemanticMappingRegistry, MaterializedRuleDerivationEvidenceProducer, OntologyLookupService, PublishedFactsReferenceProvider, PublishedSemanticSource } from '@ontology/semantic-engine'
import { DataQueryHandler, OntologyLookupHandler, RegisteredComputeExecutionService, ToolGatewayError, canonicalJson } from '@ontology/tool-services'
import type { ToolHandler } from '@ontology/tool-services'
import type { ScopedArtifactReader } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type { CoreLocalCompositionOptions } from './core-local-composition'
import type { assembleInfrastructure } from './core-assembly-infrastructure'
import { createAjv, taskParameterValidator, toolSchemaValidator } from './core-validators'
import { createDuckDbSnapshot } from './core-duckdb-snapshot'
import { createBlobArtifactWriter, createToolGatewayComposition } from './tool-gateway'
import { createCoreProjectQueryWorkflow } from './core-project-query-handler'
import { CoreMultiSchemaPublishedSource, CorePublishedFactsProvider } from './core-facts-providers'
import { CoreSemanticTaskResolver, createCoreSemanticTaskSource } from './core-semantic-task-resolver'
import { CoreRelationsTaskHandler } from './core-relations-task-handler'
import { createCoreOntologyLookupHandler } from './core-rule-judgement-handler'
import { createCoreDocumentSearchHandler } from './core-document-search-handler'
import { createCoreStructuredImportWorkflow } from './core-structured-import-service'
import { componentRef } from './core-component-ref'
import { scenarioForIndustryRef } from './core-component-registration'
import { FACTS_SOURCE_REF } from './core-constants'
import { CoreCapabilityError } from './core-errors'
import { isRecord, sameVersionRef } from './core-composition-shared'

/**
 * Phase B: the read/answer pipeline. It mounts the semantic mapping registry, the DuckDB
 * synthetic snapshot, the published facts/lookup/rule-derivation path, the registered-compute
 * execution and the one tool gateway. Everything it needs comes from Phase A's state; it only
 * returns the new ports (plus `projectQuery`, whose registered-compute closure needs the compute
 * artifacts created here).
 */
export async function assembleQueryPipeline(state: Awaited<ReturnType<typeof assembleInfrastructure>>, options: CoreLocalCompositionOptions) {
  const {
    cleanup, database, blobStore, parseStore, structuredStore, keywordIndexStore, examples, compute, scopeRef, profileContext,
    projectStore, projectDocumentStore, projectReadinessStore, projectMappingStore, projectRecordStore, runExecutionBindingStore,
    publicationStore, identityStore, evidenceStore, candidateStore, materializationStore, definitionStore, taskBindingStore,
    taskInputSnapshotStore, componentStore, publishedPackStore, packRuleReader, semanticDefinitions, projectDatasetAdapter,
    publishedProjectDatasetSource, evolutionGuard, budget,
  } = state

  const mappings = new InMemorySemanticMappingRegistry(examples.scenarios.flatMap((scenario) =>
    scenario.physicalMappings.map((mapping) => mapping.mapping),
  ))
  const duckDb = await createDuckDbSnapshot(examples.scenarios)
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
  const publishedSourceList = await Promise.all(examples.scenarios.map(async (scenario) => {
    const definition = await semanticDefinitions.getVersion({ scopeRef, namespace: scenario.namespace, definitionId: scenario.definitionRef.id, version: scenario.definitionRef.version }, profileContext)
    if (!sameVersionRef(definition.ref, scenario.definitionRef)) throw new Error('the mounted source definition differs from the actual published version')
    return new PublishedSemanticSource(publicationStore, { identity: identityStore, definition, cacheStableReads: true })
  }))
  const multiSchemaSource = new CoreMultiSchemaPublishedSource(publishedSourceList)
  const factsProviders = examples.scenarios.map((scenario, index) => ({
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
  const structuredClauseSources = new StructuredClauseSourceReader({ artifacts: blobStore, ingestion: structuredStore })
  const rulePremiseVerifier = new ArchivedRulePremiseReplayVerifier({ materialization: materializationStore, publications: publicationStore, evidence: evidenceStore, artifacts: blobStore,
    projects: projectStore, projectDocuments: projectDocumentStore, records: projectRecordStore,
    candidates: candidateStore, identity: identityStore, documentParses: parseStore, documentSpans: documentSpanReader, structuredSources: structuredPremiseSources, structuredClauses: structuredClauseSources, publishedRules: packRuleReader })
  const ruleDerivationProducer = new MaterializedRuleDerivationEvidenceProducer({
    materialization: materializationStore,
    evidence: evidenceStore,
    artifacts: createBlobArtifactWriter(blobStore),
    candidates: candidateStore,
    documentParses: parseStore,
    documentSpans: documentSpanReader,
    structuredSources: structuredPremiseSources,
    structuredClauses: structuredClauseSources,
    componentRef: componentRef('compute_extension', 'core-rule-derivation-producer', 'rule-derivation-producer@1.0.0'),
  })
  const semanticTasks = new CoreSemanticTaskResolver({
    projects: projectStore, taskBindings: taskBindingStore, materialization: materializationStore,
    source: createCoreSemanticTaskSource(publicationStore, { identity: identityStore }, { reader: packRuleReader, applies: async (revision, scope, ctx) => {
      const asset = await publishedPackStore.findPack(scope, revision.industryPackRef.id, revision.industryPackRef.version, ctx)
      if (asset === undefined) {
        const scenario = scenarioForIndustryRef(examples.scenarios, revision.industryPackRef)
        if (scenario !== undefined && sameVersionRef(scenario.definitionRef, revision.definitionRef)) return false
        const registered = await componentStore.findVersion({ kind: 'industry_pack', id: revision.industryPackRef.id, version: revision.industryPackRef.version }, scope, ctx)
        if (registered?.manifest.entrypointRef.kind === 'package' && registered.manifest.entrypointRef.ref === 'declarative-industry-manifest') throw new CoreCapabilityError('the registered declaration-pack loader has no actual immutable published pack')
        return false
      }
      if (!sameVersionRef(asset.packRef, revision.industryPackRef) || !sameVersionRef(asset.definitionRef, revision.definitionRef)) throw new CoreCapabilityError('the actual stored pack differs from the fixed project pack or definition')
      return true
    } }),
    definition: async (scope, ref, ctx) => definitionStore.findVersionByRef(scope, ref, ctx),
    operations: compute.registry, parameters: taskParameterValidator(createAjv()),
    computeInputAvailable: async (execution, revision, binding, ctx) => {
      if (revision.approvedInputRef !== undefined && sameVersionRef(execution.request.inputSnapshotRef, revision.approvedInputRef)) return true
      const snapshot = await taskInputSnapshotStore.getSnapshot(scopeRef, execution.request.inputSnapshotRef, ctx)
      const operation = binding.operationRef === undefined ? undefined : compute.registry.operations.find((operation) => operation.operationRef.id === binding.operationRef?.id && operation.operationRef.version === binding.operationRef.version)
      return snapshot?.body.producedBy === 'core-approved-project-compute-input@1' && operation !== undefined && canonicalJson(operation.operationRef) === canonicalJson(compute.approvedInput.operationRef) && snapshot.body.inputSchemaRef.digest === sha256DigestOf(canonicalJson(compute.approvedInput.dataSchema)) && canonicalJson(snapshot.body.projectRevisionRef) === canonicalJson(revision.ref) && snapshot.body.baseInputRef !== undefined && snapshot.body.dependencies.some((ref) => sameVersionRef(ref,snapshot.body.inputSchemaRef))
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
  const registeredComputeExecution = new RegisteredComputeExecutionService({ operations: compute.registry, handlers: compute.handlers,
    artifacts: computeArtifacts, reader: computeReader, validator: toolSchemaValidator(createAjv()), invocations: computeInvocationStore,
    outputBindings: computeOutputBindingsStore, resultArtifacts: computeResultStore })
  const projectQuery = createCoreProjectQueryWorkflow({ query: projectDatasetAdapter, publishedSource: publishedProjectDatasetSource,
    projects: projectStore, readiness: projectReadinessStore, executionBindings: runExecutionBindingStore, taskBindings: taskBindingStore,
    executeRegisteredCompute: async (request, binding, execution) => {
      const service = registeredComputeExecution
      const args = request.arguments
      const parameters = args['parameters']
      const operationRef = binding.operationRef
      if (execution.request.mode !== 'task' || binding.registeredOperationDigest === undefined || operationRef === undefined ||
        !isRecord(parameters) || canonicalJson(args['operationRef']) !== canonicalJson(operationRef) ||
        args['inputSchemaDigest'] !== compute.registry.operations.find((operation) => canonicalJson(operation.operationRef) === canonicalJson(operationRef))?.inputSchemaDigest ||
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
  const dataQueryHandler = new DataQueryHandler({
    query: duckDb,
    catalog: duckDb,
    mappings,
    consistency: 'immutable',
    dataMode: 'synthetic',
    catalogSourceRef: { namespace: 'ontology-core-local', sourceId: 'duckdb-synthetic-snapshot' },
    compute: {
      registry: compute.registry,
      handlers: compute.handlers,
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
  // A query without a fixed archived execution binding falls back to the synthetic DuckDB
  // snapshot ONLY when the sample example assembly actually mounted one. A zero-scenario or
  // real-deployment kernel has no synthetic backend, so the fallback is an explicit
  // CAPABILITY_NOT_CONFIGURED rather than a silent synthetic read.
  const syntheticQueryFallback: ToolHandler = examples.scenarios.length > 0
    ? dataQueryHandler
    : { toolId: 'data_query', async execute() { throw new ToolGatewayError('TOOL_NOT_ENABLED', 'this kernel deployment has no synthetic data query backend; bind a real project dataset') } }
  const gatewayComposition = createToolGatewayComposition({
    database,
    blobStore,
    budget,
    validator: toolSchemaValidator(createAjv()),
    handlers: [ontologyLookupHandler, projectQuery.handler(syntheticQueryFallback), documentSearchHandler],
  })

  return {
    mappings, duckDb, structuredImports, documentSpanReader, documentSearch, projectDocumentIndexService, publishedSourceList,
    multiSchemaSource, factsProviders, facts, lookup, lookupHandler, structuredPremiseSources, structuredClauseSources, rulePremiseVerifier,
    ruleDerivationProducer, semanticTasks, relationsTask, ontologyLookupHandler, computeArtifacts, computeReader,
    computeResultStore, computeOutputBindingsStore, computeInvocationStore, registeredComputeExecution, projectQuery,
    dataQueryHandler, documentSearchHandler, syntheticQueryFallback, gatewayComposition,
  }
}
