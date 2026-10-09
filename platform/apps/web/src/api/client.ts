import { parseExecutionPreview } from './execution-preview'
import type { ExecutionPreviewView } from './execution-preview'
import { parseWorkspaceAuthoring, parseWorkspaceCorpus, parseWorkspaceSource } from './workspace-authoring'
import type { WorkspaceAuthoringContext, WorkspaceSourceCatalogue, WorkspaceSourceView } from './workspace-authoring'
import type {
  ActiveProfileRecord,
  AssetCandidateBatch,
  AssetCandidateVersion,
  CapabilityRequirement,
  ComponentKind,
  ComponentVersionRecord,
  DefinitionCompatibilityReport,
  DefinitionEditAdjudication,
  DefinitionEditingResult,
  DefinitionValidationReport,
  DependencyGraphView,
  DependencyTraversalRequest,
  DeploymentEnvironment,
  EvidenceReadQuery,
  LogicalRole,
  MappingRef,
  ModuleLifecycleState,
  ObjectHistoryQuery,
  ObjectHistoryView,
  PreflightResult,
  ProfileRef,
  ProfileSpec,
  ProvenanceEvidenceView,
  PublishedAnswer,
  ProfileVersionRecord,
  ResourceRef,
  RevisionString,
  RuleActionCandidateVersion,
  Sha256Digest,
  SourceRef,
  SourceObjectRef,
  SourceBindingRecord,
  SourceKind,
  SourceProbeJobRecord,
  UnsupportedDefinitionRule,
  VersionRef,
} from '@ontology/contracts'
import { ApiError, toApiFailure } from './errors'
import { isProvenanceView, readAnswerSource } from './source-views'
import type { AnswerSourceView, SavedCellSelector } from './source-views'
import {
  asExecutionRecord,
  asScenarioDescriptor,
  asSimulationDetail,
  asSimulationRecord,
} from './energy'
import type {
  CreateScenarioRequest,
  ExecutionRecordView,
  RequestExecutionRequest,
  RequestSimulationInput,
  ScenarioDescriptor,
  SimulationDetailView,
  SimulationRecordView,
} from './energy'
import { dependencyQuery, optionalTimeQuery } from './provenance'
import type { DependencyPage, HistoryPage } from './provenance'
import { isResultHistoryView, isTablePageReadView, isVerifiedResultExport, isVerifiedResultView } from './results'
import type {
  ResultHistoryView,
  VerifiedResultExport,
  VerifiedResultView,
  VerifiedTablePageView,
} from './results'
import { defaultRunEventStreamFactory, isRunState } from './query'
import type {
  CancelRunRequest,
  CreateRunRequest,
  CreateRunView,
  QueryRunView,
  RespondToClarificationRequest,
  RunAnswerResult,
  RunEventHandlers,
  RunEventStream,
  RunEventStreamFactory,
  RunScopeView,
} from './query'
import type {
  CandidateDetailView,
  CandidateFilter,
  CandidateReviewRecord,
  CandidateReviewRequest,
  CandidateSourceView,
  CandidateSummary,
  CreateIngestionRequest,
  CreateJobResponse,
  IdentityDecisionRequest,
  IdentityDecisionView,
  JobView,
  PublishSemanticsRequest,
  PublishedStatement,
  RetryJobRequest,
  RetryJobResponse,
  SemanticPublicationVersion,
  StatementRevisionRecord,
  StatementRevisionRequest,
} from './review'
import {
  isAssetDraftVersion,
  isIndustryWorkspace,
  isIndustryWorkspaceWriteView,
} from './workspaces'
import type {
  AppendIndustryWorkspaceDraftRequest,
  CreateIndustryWorkspaceRequest,
  EditIndustryWorkspaceRequest,
  IndustryWorkspaceListFilter,
  IndustryWorkspaceWriteView,
} from './workspaces'
import type { AssetDraftVersion, IndustryWorkspace } from '@ontology/contracts'
import { definitionGuard } from './definitions'
import type {
  ActionCandidateDraft,
  DefinitionCandidateFilter,
  EditActionCandidateRequest,
  EditDefinitionCandidateRequest,
  EditRuleCandidateRequest,
  EnableRuleActionCandidateRequest,
  KeepDefinitionsSeparateRequest,
  MergeDefinitionCandidatesRequest,
  RecordUnsupportedRuleRequest,
  RejectDefinitionCandidateRequest,
  RuleActionCandidateFilter,
  RuleActionCandidateView,
  RuleCandidateDraft,
  ValidateDefinitionsRequest,
} from './definitions'
import {
  isInstanceConfirmationEvent,
  isInstanceConfirmationOutcome,
  isInstanceRecordView,
} from './instances'
import type {
  ConfirmInstanceFieldsRequest,
  CreateInstanceRecordRequest,
  EditInstanceFieldRequest,
  InstanceConfirmationEvent,
  InstanceConfirmationOutcomeView,
  InstanceIdentityDecisionRequest,
  InstanceRecordFilter,
  InstanceRevisionRequest,
} from './instances'
import type { InstanceRecordView, ProjectRecord, ProjectState } from '@ontology/contracts'
import {
  isIndustryPackSummary,
  isImportMappingVersion,
  isMappingPreview,
  isProjectDatasetStatus,
  isProjectDocumentIndexStatus,
  isProjectEvolutionView,
  isProjectReadinessView,
  isProjectRecord,
  isProjectRecordPageView,
  isProjectRevision,
  isProjectRevisionView,
} from './projects'
import type {
  ColumnMappingRequestView,
  CreateProjectRequest,
  IndustryPackSummary,
  MountProjectPackRequest,
  ProjectDatasetStatusView,
  ProjectDocumentIndexStatusView,
  ProjectEvolutionView,
  ProjectReadinessView,
  ProjectRecordPageView,
  ProjectRevisionView,
} from './projects'
import type { ImportMappingVersion, MappingPreview, ProjectRecordVersion, ProjectRevision } from '@ontology/contracts'
import {
  isIndustryValidationReportView,
  isPackCapabilityStatusView,
  isPackExportBundleView,
  isPublishedPackResult,
  isSyntheticExampleSetView,
} from './package-publication'
import type {
  IndustryValidationReportView,
  PackExportBundleView,
  PublishedPackResultView,
  PublishPackRequest,
  RunValidationRequest,
  SyntheticExampleSetView,
} from './package-publication'

export { ApiError } from './errors'
export {
  PUBLIC_SSE_EVENTS,
  defaultRunEventStreamFactory,
  isPublicSseEvent,
  parseRunEventData,
} from './query'
export type {
  CancelRunRequest,
  CreateRunRequest,
  CreateRunView,
  DegradationView,
  QueryRunView,
  RespondToClarificationRequest,
  RunAnswerResult,
  RunEvent,
  RunEventHandlers,
  RunEventStream,
  RunEventStreamFactory,
  RunProgressView,
  RunScopeView,
} from './query'
export type {
  CandidateDetailView,
  CandidateFilter,
  CandidateReviewRecord,
  CandidateReviewRequest,
  CandidateSourceView,
  CandidateSpanSource,
  CandidateSummary,
  CreateIngestionRequest,
  CreateJobResponse,
  EntityCandidateDetail,
  IdentityDecisionRequest,
  IdentityDecisionView,
  JobAttemptView,
  JobPublicationView,
  JobView,
  PublishSemanticsRequest,
  PublishedStatement,
  RelationCandidateDetail,
  RetryJobRequest,
  RetryJobResponse,
  RuleCandidateDetail,
  RuleUnhandledCandidateDetail,
  SemanticPublicationVersion,
  StatementRevisionRecord,
  StatementRevisionRequest,
} from './review'

/**
 * The workbench HTTP client. It is the only place the browser app touches the backend:
 * every call goes through `fetch` against the public C6 routes, and nothing server-side is
 * imported. Secret material is never part of a request or response: a source carries an
 * opaque `secretRef`, and the API never echoes a resolved value.
 */
export interface WorkbenchClientOptions {
  /** Absolute API origin. Empty means same-origin (the production host proxies `/api`). */
  readonly baseUrl: string
  readonly fetchImpl?: typeof fetch
  readonly newId?: () => string
  /** Opens the run event stream. Defaults to a real `EventSource` in the browser. */
  readonly eventStreamFactory?: RunEventStreamFactory
}

export interface PublishProfileRequest {
  readonly profileRef: ProfileRef
  readonly spec: ProfileSpec
  readonly environment: DeploymentEnvironment
}

export interface ActivateProfileRequest {
  readonly profileRef: ProfileRef
  readonly snapshotHash: Sha256Digest
  /** `null` means "no active version expected yet" (first activation); omitted means no If-Match. */
  readonly expectedRevision?: RevisionString | null
}

export interface RegisterSourceRequest {
  readonly kind: SourceKind
  readonly role: LogicalRole
  readonly adapterRef: VersionRef
  readonly secretRef: string
  readonly mappingRef?: MappingRef
  readonly capabilityVersion?: string
}

/** The public run fields the workbench displays. The run record itself lives in the API. */
export interface BoundRunView {
  readonly runId: string
  readonly state: string
  readonly revision: RevisionString
  readonly ownerSubjectId: string
  readonly profileRef: ProfileRef
  readonly resolvedProfileHash: Sha256Digest
}

export interface ComponentFilter {
  readonly kind?: ComponentKind
  readonly lifecycleState?: ModuleLifecycleState
}

export interface CoreDeploymentScenario {
  readonly scenarioId: string
  /** The mounted source-pack id selected by this profile's current industry pin. */
  readonly sourceScenarioId?: string
  readonly label: string
  readonly profileRef: ProfileRef
  readonly environment: DeploymentEnvironment
  readonly baseProfileSpec?: ProfileSpec
  readonly namespace: string
  readonly definitionRef: VersionRef
  readonly availableTasks: readonly string[]
  readonly mappingRefs: readonly VersionRef[]
  readonly rawSourceRefs: readonly SourceRef[]
}

export interface CoreDeploymentInfo {
  readonly classification: string
  readonly scenarios: readonly CoreDeploymentScenario[]
  readonly operatorEnabled: boolean
  readonly models: { readonly generation: boolean; readonly decision: boolean }
}

export interface CoreImportRequest {
  readonly scenarioId: string
  readonly sourceId: string
  readonly content: string
}

export interface CoreImportResult {
  readonly jobId: string
  readonly stage: string
  readonly scenarioId: string
  readonly sourceRef: SourceRef
}

export interface RequestOptions {
  readonly body?: unknown
  readonly idempotencyKey?: string
  readonly ifMatch?: string
  readonly signal?: AbortSignal
}

function defaultId(): string {
  const cryptoApi: Crypto | undefined = globalThis.crypto
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `idem-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffff).toString(16)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProfileRef(value: unknown): value is ProfileRef {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['version'] === 'string'
}

function isVersionRef(value: unknown): value is VersionRef {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['version'] === 'string' && typeof value['digest'] === 'string'
}

function isSourceRef(value: unknown): value is SourceRef {
  return isRecord(value) && typeof value['namespace'] === 'string' && typeof value['sourceId'] === 'string'
}

function isSourceObjectRef(value: unknown): value is SourceObjectRef {
  return isRecord(value) && isSourceRef(value['sourceRef']) && typeof value['objectPath'] === 'string'
}

function isMappingRef(value: unknown): value is MappingRef {
  return isVersionRef(value) && isRecord(value) &&
    (value['role'] === 'telemetry' || value['role'] === 'catalog' || value['role'] === 'documents') &&
    isSourceObjectRef(value['sourceObjectRef'])
}

function isBackendBinding(value: unknown): boolean {
  return isRecord(value) &&
    (value['role'] === 'telemetry' || value['role'] === 'catalog' || value['role'] === 'documents') &&
    isVersionRef(value['adapterRef']) &&
    (value['mappingRef'] === undefined || typeof value['mappingRef'] === 'string') &&
    (value['capabilityNames'] === undefined || (Array.isArray(value['capabilityNames']) && value['capabilityNames'].every((name) => typeof name === 'string')))
}

function isModelBinding(value: unknown): boolean {
  return isRecord(value) &&
    (value['role'] === 'generation' || value['role'] === 'decision') &&
    isVersionRef(value['modelRef']) && typeof value['enabled'] === 'boolean' &&
    (value['fallbackPolicy'] === 'deterministic' || value['fallbackPolicy'] === 'generative_classification' ||
      value['fallbackPolicy'] === 'clarify' || value['fallbackPolicy'] === 'reject')
}

function isToolBinding(value: unknown): boolean {
  return isRecord(value) && typeof value['toolId'] === 'string' && typeof value['enabled'] === 'boolean' &&
    (value['policyRef'] === undefined || typeof value['policyRef'] === 'string') &&
    (value['maxCallsPerRun'] === undefined || (Number.isSafeInteger(value['maxCallsPerRun']) && Number(value['maxCallsPerRun']) > 0))
}

function isProfileSpec(value: unknown): value is ProfileSpec {
  return isRecord(value) && isVersionRef(value['industryRef']) &&
    Array.isArray(value['mappingRefs']) && value['mappingRefs'].every(isMappingRef) &&
    isVersionRef(value['runtimeRef']) && isRecord(value['backendBindings']) &&
    Object.values(value['backendBindings']).every(isBackendBinding) && isRecord(value['modelBindings']) &&
    Object.values(value['modelBindings']).every(isModelBinding) && Array.isArray(value['toolBindings']) &&
    value['toolBindings'].every(isToolBinding) && Array.isArray(value['computeBindings']) &&
    value['computeBindings'].every((binding) => isRecord(binding) && binding['readOnly'] === true &&
      typeof binding['enabled'] === 'boolean' && isVersionRef(binding['handlerRef']) &&
      isVersionRef(binding['inputSchemaRef']) && isVersionRef(binding['outputSchemaRef'])) && isVersionRef(value['policyRef'])
}

function isDeploymentEnvironment(value: unknown): value is DeploymentEnvironment {
  return value === 'local_dev' || value === 'ci' || value === 'staging' || value === 'production'
}

function parseCoreDeployment(value: unknown): CoreDeploymentInfo {
  if (!isRecord(value) || typeof value['classification'] !== 'string' || typeof value['operatorEnabled'] !== 'boolean' || !Array.isArray(value['scenarios'])) {
    throw malformedResponse('/api/v1/core/deployment', 'the deployment response is missing its scenario list')
  }
  if (!isRecord(value['models']) || typeof value['models']['generation'] !== 'boolean' || typeof value['models']['decision'] !== 'boolean') {
    throw malformedResponse('/api/v1/core/deployment', 'the deployment response has an unknown model status')
  }
  const scenarios: CoreDeploymentScenario[] = value['scenarios'].map((candidate, index) => {
    if (!isRecord(candidate) ||
      typeof candidate['scenarioId'] !== 'string' || candidate['scenarioId'].length === 0 ||
      (candidate['sourceScenarioId'] !== undefined && (typeof candidate['sourceScenarioId'] !== 'string' || candidate['sourceScenarioId'].length === 0)) ||
      typeof candidate['label'] !== 'string' || candidate['label'].length === 0 ||
      typeof candidate['namespace'] !== 'string' || candidate['namespace'].length === 0 ||
      !isProfileRef(candidate['profileRef']) || !isDeploymentEnvironment(candidate['environment']) ||
      (candidate['baseProfileSpec'] !== undefined && !isProfileSpec(candidate['baseProfileSpec'])) || !isVersionRef(candidate['definitionRef']) ||
      !Array.isArray(candidate['availableTasks']) || !candidate['availableTasks'].every((task) => typeof task === 'string') ||
      !Array.isArray(candidate['mappingRefs']) || !candidate['mappingRefs'].every(isVersionRef) ||
      !Array.isArray(candidate['rawSourceRefs']) || !candidate['rawSourceRefs'].every(isSourceRef)) {
      throw malformedResponse('/api/v1/core/deployment', `scenario ${index} has an invalid shape`)
    }
    return {
      scenarioId: candidate['scenarioId'],
      ...(typeof candidate['sourceScenarioId'] === 'string' ? { sourceScenarioId: candidate['sourceScenarioId'] } : {}),
      label: candidate['label'],
      profileRef: candidate['profileRef'],
      environment: candidate['environment'],
      namespace: candidate['namespace'],
      definitionRef: candidate['definitionRef'],
      availableTasks: candidate['availableTasks'],
      mappingRefs: candidate['mappingRefs'],
      rawSourceRefs: candidate['rawSourceRefs'],
      ...(candidate['baseProfileSpec'] === undefined ? {} : { baseProfileSpec: candidate['baseProfileSpec'] }),
    }
  })
  return {
    classification: value['classification'],
    scenarios,
    operatorEnabled: value['operatorEnabled'],
    models: { generation: value['models']['generation'], decision: value['models']['decision'] },
  }
}

function dataOf<T>(body: unknown, path: string): T {
  if (!isRecord(body) || !('data' in body)) {
    throw new ApiError(500, {
      code: 'MALFORMED_ENVELOPE',
      message: `the response for ${path} did not carry a data envelope`,
      retryable: false,
      reasons: [],
      missingCapabilities: [],
    })
  }
  return body['data'] as T
}

/**
 * A server response whose envelope was well-formed but whose typed body the UI cannot safely
 * display. Rendering a guessed shape would risk showing an unlabelled or unverified number, so
 * this is an explicit failure instead.
 */
function malformedResponse(path: string, detail: string): ApiError {
  return new ApiError(500, {
    code: 'MALFORMED_RESPONSE',
    message: `${detail} (${path})`,
    retryable: false,
    reasons: [],
    missingCapabilities: [],
  })
}

export class WorkbenchClient {
  readonly #baseUrl: string
  readonly #fetch: typeof fetch
  readonly #newId: () => string
  readonly #eventStream: RunEventStreamFactory

  constructor(options: WorkbenchClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '')
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
    this.#newId = options.newId ?? defaultId
    this.#eventStream = options.eventStreamFactory ?? defaultRunEventStreamFactory
  }

  getCoreDeployment(): Promise<CoreDeploymentInfo> {
    return this.#request<unknown>('GET', '/api/v1/core/deployment').then(parseCoreDeployment)
  }

  createCoreImport(request: CoreImportRequest): Promise<CoreImportResult> {
    return this.#request<CoreImportResult>('POST', '/api/v1/core/imports', {
      body: request,
      idempotencyKey: this.#newId(),
    })
  }

  listComponents(filter: ComponentFilter = {}): Promise<ComponentVersionRecord[]> {
    const query = new URLSearchParams()
    if (filter.kind !== undefined) query.set('kind', filter.kind)
    if (filter.lifecycleState !== undefined) query.set('lifecycleState', filter.lifecycleState)
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    return this.#request<{ components: ComponentVersionRecord[] }>('GET', `/api/v1/components${suffix}`).then(
      (data) => data.components,
    )
  }

  publishProfile(request: PublishProfileRequest): Promise<ProfileVersionRecord> {
    return this.#request<ProfileVersionRecord>('POST', '/api/v1/profiles', {
      body: request,
      idempotencyKey: this.#newId(),
    })
  }

  preflightProfile(profileRef: ProfileRef): Promise<PreflightResult> {
    return this.#request<PreflightResult>(
      'POST',
      `/api/v1/profiles/${encodeURIComponent(profileRef.id)}/preflight`,
      { body: { version: profileRef.version } },
    )
  }

  getActiveProfile(profileId: string): Promise<ActiveProfileRecord | undefined> {
    return this.#request<{ readonly active: ActiveProfileRecord | null }>(
      'GET',
      `/api/v1/profiles/${encodeURIComponent(profileId)}/active`,
    ).then((data) => data.active ?? undefined)
  }

  activateProfile(request: ActivateProfileRequest): Promise<ActiveProfileRecord> {
    const expected = request.expectedRevision
    return this.#request<ActiveProfileRecord>(
      'POST',
      `/api/v1/profiles/${encodeURIComponent(request.profileRef.id)}/activate`,
      {
        body: { version: request.profileRef.version, snapshotHash: request.snapshotHash },
        ...(expected === undefined ? {} : { ifMatch: expected === null ? '*' : expected }),
      },
    )
  }

  listSources(): Promise<SourceBindingRecord[]> {
    return this.#request<{ sources: SourceBindingRecord[] }>('GET', '/api/v1/sources').then(
      (data) => data.sources,
    )
  }

  registerSource(request: RegisterSourceRequest): Promise<SourceBindingRecord> {
    return this.#request<SourceBindingRecord>('POST', '/api/v1/sources', {
      body: request,
      idempotencyKey: this.#newId(),
    })
  }

  probeSource(
    sourceId: string,
    capabilities?: readonly CapabilityRequirement[],
  ): Promise<SourceProbeJobRecord> {
    return this.#request<SourceProbeJobRecord>(
      'POST',
      `/api/v1/sources/${encodeURIComponent(sourceId)}/probe`,
      { body: capabilities === undefined ? {} : { capabilities } },
    )
  }

  getRun(runId: string): Promise<QueryRunView> {
    return this.#request<QueryRunView>('GET', `/api/v1/runs/${encodeURIComponent(runId)}`)
  }

  /** Resolve the scenario scope for a profile so the ask form offers only what it allows. */
  getRunScope(profileRef: ProfileRef): Promise<RunScopeView> {
    const query = new URLSearchParams({ profileId: profileRef.id, version: profileRef.version })
    return this.#request<RunScopeView>('GET', `/api/v1/runs/scope?${query.toString()}`)
  }

  createRun(request: CreateRunRequest, idempotencyKey?: string): Promise<CreateRunView> {
    return this.#request<CreateRunView>('POST', '/api/v1/runs', {
      body: request,
      idempotencyKey: idempotencyKey ?? this.#newId(),
    })
  }

  respondToClarification(
    runId: string,
    request: RespondToClarificationRequest,
  ): Promise<{ readonly runId: string; readonly state: string; readonly revision: RevisionString }> {
    return this.#request('POST', `/api/v1/runs/${encodeURIComponent(runId)}/responses`, {
      body: {
        clarificationId: request.clarificationId,
        typedResponse: request.typedResponse,
        expectedRevision: request.expectedRevision,
      },
      ifMatch: request.expectedRevision,
    })
  }

  cancelRun(
    runId: string,
    request: CancelRunRequest,
  ): Promise<{ readonly runId: string; readonly state: string; readonly revision: RevisionString }> {
    return this.#request('POST', `/api/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      body: { reason: request.reason, expectedRevision: request.expectedRevision },
      ifMatch: request.expectedRevision,
    })
  }

  /**
   * Read the verified answer. A 202 (in progress) and a 404 (terminal without a verified
   * answer) are explicit results, not thrown errors, and are never rendered as an answer.
   */
  async getAnswer(runId: string): Promise<RunAnswerResult> {
    const response = await this.#fetch(
      `${this.#baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/answer`,
      { method: 'GET', headers: { accept: 'application/json' } },
    )
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (response.status === 202) {
      const data = isRecord(parsed) && isRecord(parsed['data']) ? parsed['data'] : {}
      const state = data['state']
      return { kind: 'in_progress', state: isRunState(state) ? state : 'collecting' }
    }
    if (response.status === 404) {
      const error = isRecord(parsed) && isRecord(parsed['error']) ? parsed['error'] : {}
      return {
        kind: 'unavailable',
        code: typeof error['code'] === 'string' ? error['code'] : 'ANSWER_NOT_AVAILABLE',
        message:
          typeof error['message'] === 'string'
            ? error['message']
            : 'the run has no verified answer',
      }
    }
    if (!response.ok) {
      throw new ApiError(response.status, toApiFailure(response.status, parsed))
    }
    return { kind: 'published', answer: dataOf<PublishedAnswer>(parsed, `/api/v1/runs/${runId}/answer`) }
  }

  /**
   * `GET /answers/{answerId}/result`: the verified typed-result projection of one published
   * answer. It never returns raw compute JSON; a non-verified shape is a malformed response.
   */
  getVerifiedResult(answerId: string): Promise<VerifiedResultView> {
    const path = `/api/v1/answers/${encodeURIComponent(answerId)}/result`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isVerifiedResultView(data)) {
        throw malformedResponse(path, 'the verified result view was not recognised')
      }
      return data
    })
  }

  /**
   * `GET /answers/{answerId}/tables/{tableId}`: one page of one fixed verified table revision.
   * The cursor binds the answer/table/digest/scope, so a rebuild cannot silently concatenate
   * two revisions. An unverified table must never be rendered, so a missing receipt is a 4xx.
   */
  getAnswerTablePage(
    answerId: string,
    tableId: string,
    cursor?: string,
  ): Promise<VerifiedTablePageView> {
    const query = new URLSearchParams()
    if (cursor !== undefined) query.set('cursor', cursor)
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    const path = `/api/v1/answers/${encodeURIComponent(answerId)}/tables/${encodeURIComponent(tableId)}${suffix}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isTablePageReadView(data)) {
        throw malformedResponse(path, 'the verified table page was not recognised')
      }
      return data
    })
  }

  /**
   * `GET /runs/{runId}/answer/history`: the immutable result revisions grouped by the run's
   * project. Each entry is a published version; older ones are labelled `history` and the exact
   * version this run published is `fixed_version`, so a readback is never confused with a recompute.
   */
  getResultHistory(runId: string): Promise<ResultHistoryView> {
    const path = `/api/v1/runs/${encodeURIComponent(runId)}/answer/history`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isResultHistoryView(data)) {
        throw malformedResponse(path, 'the result history view was not recognised')
      }
      return data
    })
  }

  /**
   * `GET /runs/{runId}/answer/export?format=json`: the structured JSON export of the exact
   * verified version the run published. A format the core surface does not serve is refused by
   * the server (the professional XLSX template is registered by the scenario).
   */
  exportVerifiedResult(runId: string): Promise<VerifiedResultExport> {
    const path = `/api/v1/runs/${encodeURIComponent(runId)}/answer/export?format=json`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isVerifiedResultExport(data)) {
        throw malformedResponse(path, 'the verified result export was not recognised')
      }
      return data
    })
  }

  /** Subscribe to the run's persisted public events. Unknown event names are dropped. */
  openRunEvents(
    runId: string,
    lastEventId: string | undefined,
    handlers: RunEventHandlers,
  ): RunEventStream {
    const url = `${this.#baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/events`
    return this.#eventStream(url, lastEventId, handlers)
  }

  createIngestion(request: CreateIngestionRequest): Promise<CreateJobResponse> {
    return this.#request<CreateJobResponse>('POST', '/api/v1/ingestions', {
      body: request,
      idempotencyKey: this.#newId(),
    })
  }

  getJob(jobId: string): Promise<JobView> {
    return this.#request<JobView>('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}`)
  }

  retryJob(jobId: string, request: RetryJobRequest): Promise<RetryJobResponse> {
    return this.#request<RetryJobResponse>('POST', `/api/v1/jobs/${encodeURIComponent(jobId)}/retry`, {
      body: { failedStage: request.failedStage, expectedRevision: request.expectedRevision },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    })
  }

  /** `GET /industry-workspaces`: the workspace list visible in the trusted scope. */
  listIndustryWorkspaces(filter: IndustryWorkspaceListFilter = {}): Promise<IndustryWorkspace[]> {
    const query = new URLSearchParams()
    if (filter.state !== undefined) query.set('state', filter.state)
    if (filter.limit !== undefined) query.set('pageSize', String(filter.limit))
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    const path = `/api/v1/industry-workspaces${suffix}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (
        !isRecord(data) ||
        !Array.isArray(data['workspaces']) ||
        !data['workspaces'].every(isIndustryWorkspace)
      ) {
        throw malformedResponse(path, 'the industry workspace list was not recognised')
      }
      return data['workspaces']
    })
  }

  getIndustryWorkspace(workspaceId: string): Promise<IndustryWorkspace> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !isIndustryWorkspace(data['workspace'])) {
        throw malformedResponse(path, 'the industry workspace was not recognised')
      }
      return data['workspace']
    })
  }

  /** Normal host creates the actual empty corpus; the browser supplies only business boundary. */
  bootstrapIndustryWorkspace(request: Omit<CreateIndustryWorkspaceRequest, 'documentSetRef'>, options: RequestOptions = {}): Promise<{ readonly workspace: IndustryWorkspace; readonly draft: AssetDraftVersion }> {
    return this.#request<unknown>('POST', '/api/v1/core/workspace-bootstrap', { ...options, body: request, idempotencyKey: options.idempotencyKey ?? this.#newId() }).then((value) => {
      if (!isRecord(value) || !isIndustryWorkspace(value['workspace']) || !isAssetDraftVersion(value['draft']) || value['draft'].workspaceId !== value['workspace'].workspaceId) throw malformedResponse('/api/v1/core/workspace-bootstrap', 'actual workspace/corpus pins were not recognised')
      return { workspace: value['workspace'], draft: value['draft'] }
    })
  }

  getWorkspaceSources(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceSourceCatalogue> {
    return this.#request<unknown>('GET', `/api/v1/core/workspaces/${encodeURIComponent(workspaceId)}/sources`, { ...(signal === undefined ? {} : { signal }) }).then(parseWorkspaceCorpus)
  }

  uploadWorkspaceSource(workspaceId: string, request: { readonly name: string; readonly mediaType: string; readonly contentEncoding: 'base64'; readonly content: string; readonly options?: { readonly headerRow?: number; readonly dataStartRow?: number; readonly sheetId?: string; readonly sheetName?: string } }, options: RequestOptions): Promise<{ readonly workspace: IndustryWorkspace; readonly draft: AssetDraftVersion; readonly source: WorkspaceSourceView }> {
    const path = `/api/v1/core/workspaces/${encodeURIComponent(workspaceId)}/sources`
    return this.#request<unknown>('POST', path, { ...options, body: request }).then((value) => {
      if (!isRecord(value) || !isIndustryWorkspace(value['workspace']) || !isAssetDraftVersion(value['draft']) || value['draft'].workspaceId !== value['workspace'].workspaceId || value['draft'].revision !== value['workspace'].headRevision) throw malformedResponse(path, 'actual uploaded source/corpus pins were not recognised')
      return { workspace: value['workspace'], draft: value['draft'], source: parseWorkspaceSource(value['source']) }
    })
  }

  getWorkspaceAuthoringContext(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceAuthoringContext> {
    return this.#request<unknown>('GET', `/api/v1/core/workspaces/${encodeURIComponent(workspaceId)}/authoring-context`, { ...(signal === undefined ? {} : { signal }) }).then(parseWorkspaceAuthoring)
  }

  /** `POST /industry-workspaces`: create the workspace head plus its first immutable draft. */
  createIndustryWorkspace(request: CreateIndustryWorkspaceRequest): Promise<IndustryWorkspaceWriteView> {
    const path = '/api/v1/industry-workspaces'
    return this.#request<unknown>('POST', path, {
      body: request,
      idempotencyKey: this.#newId(),
    }).then((data) => {
      if (!isIndustryWorkspaceWriteView(data)) {
        throw malformedResponse(path, 'the created industry workspace was not recognised')
      }
      return data
    })
  }

  /** `PATCH /industry-workspaces/:id`: edit the name/boundary via If-Match CAS. */
  editIndustryWorkspace(
    workspaceId: string,
    request: EditIndustryWorkspaceRequest,
  ): Promise<IndustryWorkspaceWriteView> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}`
    return this.#request<unknown>('PATCH', path, {
      body: {
        reason: request.reason,
        ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
        ...(request.boundary === undefined ? {} : { boundary: request.boundary }),
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => {
      if (!isIndustryWorkspaceWriteView(data)) {
        throw malformedResponse(path, 'the edited industry workspace was not recognised')
      }
      return data
    })
  }

  /** `POST /industry-workspaces/:id/draft-operations`: append a draft with a new source set. */
  appendIndustryWorkspaceDraft(
    workspaceId: string,
    request: AppendIndustryWorkspaceDraftRequest,
  ): Promise<IndustryWorkspaceWriteView> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/draft-operations`
    return this.#request<unknown>('POST', path, {
      body: {
        operation: 'edit',
        reason: request.reason,
        documentSetRef: request.documentSetRef,
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => {
      if (!isIndustryWorkspaceWriteView(data)) {
        throw malformedResponse(path, 'the appended industry workspace draft was not recognised')
      }
      return data
    })
  }

  listIndustryWorkspaceDrafts(workspaceId: string): Promise<AssetDraftVersion[]> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/drafts`
    return this.#request<unknown>('GET', path).then((data) => {
      if (
        !isRecord(data) ||
        !Array.isArray(data['drafts']) ||
        !data['drafts'].every(isAssetDraftVersion)
      ) {
        throw malformedResponse(path, 'the industry workspace drafts were not recognised')
      }
      return data['drafts']
    })
  }

  getIndustryWorkspaceDraft(workspaceId: string, revision: string): Promise<AssetDraftVersion> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/drafts/${encodeURIComponent(revision)}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !isAssetDraftVersion(data['draft'])) {
        throw malformedResponse(path, 'the industry workspace draft was not recognised')
      }
      return data['draft']
    })
  }

  /** `GET /industry-workspaces/:id/candidates`: the definition (TBox) candidates in scope. */
  listDefinitionCandidates(
    workspaceId: string,
    filter: DefinitionCandidateFilter = {},
  ): Promise<AssetCandidateVersion[]> {
    const query = new URLSearchParams()
    if (filter.kind !== undefined) query.set('kind', filter.kind)
    if (filter.state !== undefined) query.set('state', filter.state)
    if (filter.limit !== undefined) query.set('pageSize', String(filter.limit))
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/candidates${suffix}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (
        !isRecord(data) ||
        !Array.isArray(data['candidates']) ||
        !data['candidates'].every(definitionGuard.assetCandidateVersion)
      ) {
        throw malformedResponse(path, 'the definition candidate list was not recognised')
      }
      return data['candidates']
    })
  }

  /** `GET /industry-workspaces/:id/generations`: the immutable generation batches. */
  listDefinitionGenerationBatches(workspaceId: string): Promise<AssetCandidateBatch[]> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/generations`
    return this.#request<unknown>('GET', path).then((data) => {
      if (
        !isRecord(data) ||
        !Array.isArray(data['batches']) ||
        !data['batches'].every(definitionGuard.assetCandidateBatch)
      ) {
        throw malformedResponse(path, 'the definition generation batch list was not recognised')
      }
      return data['batches']
    })
  }

  /** `GET /industry-workspaces/:id/definition-adjudications`: the human edit decisions. */
  listDefinitionAdjudications(workspaceId: string): Promise<DefinitionEditAdjudication[]> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/definition-adjudications`
    return this.#request<unknown>('GET', path).then((data) => {
      if (
        !isRecord(data) ||
        !Array.isArray(data['adjudications']) ||
        !data['adjudications'].every(definitionGuard.definitionEditAdjudication)
      ) {
        throw malformedResponse(path, 'the definition adjudication list was not recognised')
      }
      return data['adjudications']
    })
  }

  /** `POST /industry-workspaces/:id/candidates/:candidateId/edits`: append a revised candidate. */
  editDefinitionCandidate(
    workspaceId: string,
    candidateId: string,
    request: EditDefinitionCandidateRequest,
  ): Promise<DefinitionEditingResult> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/candidates/${encodeURIComponent(candidateId)}/edits`
    return this.#request<unknown>('POST', path, {
      body: { payload: request.payload, reason: request.reason },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readDefinitionEditingResult(path, data))
  }

  /** `POST /industry-workspaces/:id/candidate-merges`: merge synonymous definitions. */
  mergeDefinitionCandidates(
    workspaceId: string,
    request: MergeDefinitionCandidatesRequest,
  ): Promise<DefinitionEditingResult> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/candidate-merges`
    return this.#request<unknown>('POST', path, {
      body: {
        candidateIds: request.candidateIds,
        mergedPayload: request.mergedPayload,
        reason: request.reason,
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readDefinitionEditingResult(path, data))
  }

  /** `POST /industry-workspaces/:id/candidate-decisions/keep-separate`: keep same-name terms apart. */
  keepDefinitionCandidatesSeparate(
    workspaceId: string,
    request: KeepDefinitionsSeparateRequest,
  ): Promise<DefinitionEditingResult> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/candidate-decisions/keep-separate`
    return this.#request<unknown>('POST', path, {
      body: { candidateIds: request.candidateIds, reason: request.reason },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readDefinitionEditingResult(path, data))
  }

  /** `POST /industry-workspaces/:id/candidates/:candidateId/rejections`: reject a candidate. */
  rejectDefinitionCandidate(
    workspaceId: string,
    candidateId: string,
    request: RejectDefinitionCandidateRequest,
  ): Promise<DefinitionEditingResult> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/candidates/${encodeURIComponent(candidateId)}/rejections`
    return this.#request<unknown>('POST', path, {
      body: { reason: request.reason },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readDefinitionEditingResult(path, data))
  }

  /** `POST /industry-workspaces/:id/definition-validations`: the publication validation report. */
  validateDefinitions(
    workspaceId: string,
    request: ValidateDefinitionsRequest,
  ): Promise<DefinitionValidationReport> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/definition-validations`
    return this.#request<unknown>('POST', path, {
      body: {
        revision: request.revision,
        ...(request.strategy === undefined ? {} : { strategy: request.strategy }),
      },
    }).then((data) => {
      if (!isRecord(data) || !definitionGuard.definitionValidationReport(data['report'])) {
        throw malformedResponse(path, 'the definition validation report was not recognised')
      }
      return data['report']
    })
  }

  /** `GET /industry-workspaces/:id/definition-compatibility`: the diff against the published pack. */
  getDefinitionCompatibility(
    workspaceId: string,
    revision: string,
  ): Promise<DefinitionCompatibilityReport> {
    const query = new URLSearchParams({ revision })
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/definition-compatibility?${query.toString()}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !definitionGuard.definitionCompatibilityReport(data['report'])) {
        throw malformedResponse(path, 'the definition compatibility report was not recognised')
      }
      return data['report']
    })
  }

  /** `GET /industry-workspaces/:id/unsupported-rules`: rules preserved as non-executable. */
  listUnsupportedRules(workspaceId: string): Promise<UnsupportedDefinitionRule[]> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/unsupported-rules`
    return this.#request<unknown>('GET', path).then((data) => {
      if (
        !isRecord(data) ||
        !Array.isArray(data['rules']) ||
        !data['rules'].every(definitionGuard.unsupportedDefinitionRule)
      ) {
        throw malformedResponse(path, 'the unsupported rule list was not recognised')
      }
      return data['rules']
    })
  }

  /** `POST /industry-workspaces/:id/unsupported-rules`: keep an unsupported rule non-executable. */
  recordUnsupportedRule(
    workspaceId: string,
    request: RecordUnsupportedRuleRequest,
  ): Promise<UnsupportedDefinitionRule> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/unsupported-rules`
    return this.#request<unknown>('POST', path, {
      body: {
        ruleId: request.ruleId,
        reason: request.reason,
        rawForm: request.rawForm,
        ...(request.sourceCandidateId === undefined ? {} : { sourceCandidateId: request.sourceCandidateId }),
      },
      idempotencyKey: this.#newId(),
    }).then((data) => {
      if (!isRecord(data) || !definitionGuard.unsupportedDefinitionRule(data['rule'])) {
        throw malformedResponse(path, 'the recorded unsupported rule was not recognised')
      }
      return data['rule']
    })
  }

  /** `GET /industry-workspaces/:id/rule-action-candidates`: rule/action candidates in scope. */
  listRuleActionCandidates(
    workspaceId: string,
    filter: RuleActionCandidateFilter = {},
  ): Promise<RuleActionCandidateVersion[]> {
    const query = new URLSearchParams()
    if (filter.kind !== undefined) query.set('kind', filter.kind)
    if (filter.lifecycle !== undefined) query.set('lifecycle', filter.lifecycle)
    if (filter.limit !== undefined) query.set('pageSize', String(filter.limit))
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/rule-action-candidates${suffix}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (
        !isRecord(data) ||
        !Array.isArray(data['candidates']) ||
        !data['candidates'].every(definitionGuard.ruleActionCandidateVersion)
      ) {
        throw malformedResponse(path, 'the rule/action candidate list was not recognised')
      }
      return data['candidates']
    })
  }

  /** `POST /industry-workspaces/:id/rule-action-candidates/:candidateId/edits`: revise a rule. */
  editRuleCandidate(
    workspaceId: string,
    candidateId: string,
    request: EditRuleCandidateRequest,
  ): Promise<RuleActionCandidateVersion> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/rule-action-candidates/${encodeURIComponent(candidateId)}/edits`
    return this.#request<unknown>('POST', path, {
      body: {
        rule: request.rule satisfies RuleCandidateDraft,
        reason: request.reason,
        sourceRefs: request.sourceRefs ?? [],
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readRuleActionCandidate(path, data))
  }

  /** `POST /industry-workspaces/:id/rule-action-candidates/:candidateId/edits`: revise an action. */
  editActionCandidate(
    workspaceId: string,
    candidateId: string,
    request: EditActionCandidateRequest,
  ): Promise<RuleActionCandidateVersion> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/rule-action-candidates/${encodeURIComponent(candidateId)}/edits`
    return this.#request<unknown>('POST', path, {
      body: {
        action: request.action satisfies ActionCandidateDraft,
        reason: request.reason,
        sourceRefs: request.sourceRefs ?? [],
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readRuleActionCandidate(path, data))
  }

  /** `POST /industry-workspaces/:id/rule-action-candidates/:candidateId/enable`: enable if executable. */
  enableRuleActionCandidate(
    workspaceId: string,
    candidateId: string,
    request: EnableRuleActionCandidateRequest,
  ): Promise<RuleActionCandidateView> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/rule-action-candidates/${encodeURIComponent(candidateId)}/enable`
    return this.#request<unknown>('POST', path, {
      body: {},
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => {
      if (!definitionGuard.candidateLifecycleView(data)) {
        throw malformedResponse(path, 'the rule/action lifecycle view was not recognised')
      }
      return data
    })
  }

  private readDefinitionEditingResult(path: string, data: unknown): DefinitionEditingResult {
    if (!definitionGuard.definitionEditingResult(data)) {
      throw malformedResponse(path, 'the definition editing result was not recognised')
    }
    return data
  }

  private readRuleActionCandidate(path: string, data: unknown): RuleActionCandidateVersion {
    if (!isRecord(data) || !definitionGuard.ruleActionCandidateVersion(data['candidate'])) {
      throw malformedResponse(path, 'the rule/action candidate revision was not recognised')
    }
    return data['candidate']
  }

  private instanceRecordPath(projectId: string, recordId: string, suffix = ''): string {
    return `/api/v1/projects/${encodeURIComponent(projectId)}/instance-records/${encodeURIComponent(recordId)}${suffix}`
  }

  private readInstanceRecord(path: string, data: unknown): InstanceRecordView {
    if (!isRecord(data) || !isInstanceRecordView(data['record'])) {
      throw malformedResponse(path, 'the instance record was not recognised')
    }
    return data['record']
  }

  /** `GET /projects/:id/instance-records`: the instance records visible in the trusted scope. */
  listInstanceRecords(projectId: string, filter: InstanceRecordFilter = {}): Promise<InstanceRecordView[]> {
    const query = new URLSearchParams()
    if (filter.status !== undefined) query.set('status', filter.status)
    if (filter.publicationState !== undefined) query.set('publicationState', filter.publicationState)
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/instance-records${suffix}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !Array.isArray(data['records']) || !data['records'].every(isInstanceRecordView)) {
        throw malformedResponse(path, 'the instance record list was not recognised')
      }
      return data['records']
    })
  }

  getInstanceRecord(projectId: string, recordId: string): Promise<InstanceRecordView> {
    const path = this.instanceRecordPath(projectId, recordId)
    return this.#request<unknown>('GET', path).then((data) => this.readInstanceRecord(path, data))
  }

  listInstanceConfirmations(projectId: string, recordId: string): Promise<InstanceConfirmationEvent[]> {
    const path = this.instanceRecordPath(projectId, recordId, '/confirmations')
    return this.#request<unknown>('GET', path).then((data) => {
      if (
        !isRecord(data) ||
        !Array.isArray(data['confirmations']) ||
        !data['confirmations'].every(isInstanceConfirmationEvent)
      ) {
        throw malformedResponse(path, 'the instance confirmation history was not recognised')
      }
      return data['confirmations']
    })
  }

  createInstanceRecord(
    projectId: string,
    request: CreateInstanceRecordRequest,
    idempotencyKey?: string,
  ): Promise<InstanceRecordView> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/instance-records`
    return this.#request<unknown>('POST', path, {
      body: request,
      idempotencyKey: idempotencyKey ?? this.#newId(),
    }).then((data) => this.readInstanceRecord(path, data))
  }

  editInstanceField(
    projectId: string,
    recordId: string,
    request: EditInstanceFieldRequest,
  ): Promise<InstanceRecordView> {
    const path = this.instanceRecordPath(projectId, recordId, '/field-edits')
    return this.#request<unknown>('POST', path, {
      body: {
        fieldId: request.fieldId,
        ...(request.rawValue === undefined ? {} : { rawValue: request.rawValue }),
        ...(request.normalizedValue === undefined ? {} : { normalizedValue: request.normalizedValue }),
        reason: request.reason,
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readInstanceRecord(path, data))
  }

  confirmInstanceFields(
    projectId: string,
    recordId: string,
    request: ConfirmInstanceFieldsRequest,
  ): Promise<InstanceConfirmationOutcomeView> {
    const path = this.instanceRecordPath(projectId, recordId, '/field-confirmations')
    return this.#request<unknown>('POST', path, {
      body: { decisions: request.decisions },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => {
      if (!isInstanceConfirmationOutcome(data)) {
        throw malformedResponse(path, 'the field confirmation outcome was not recognised')
      }
      return data
    })
  }

  adjudicateInstanceIdentity(
    projectId: string,
    recordId: string,
    request: InstanceIdentityDecisionRequest,
  ): Promise<InstanceRecordView> {
    const path = this.instanceRecordPath(projectId, recordId, '/identity-decisions')
    return this.#request<unknown>('POST', path, {
      body: {
        kind: request.kind,
        ...(request.targetEntityId === undefined ? {} : { targetEntityId: request.targetEntityId }),
        reason: request.reason,
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readInstanceRecord(path, data))
  }

  approveInstanceRecord(
    projectId: string,
    recordId: string,
    request: InstanceRevisionRequest,
  ): Promise<InstanceRecordView> {
    const path = this.instanceRecordPath(projectId, recordId, '/approve')
    return this.#request<unknown>('POST', path, {
      body: {},
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readInstanceRecord(path, data))
  }

  publishInstanceRecord(
    projectId: string,
    recordId: string,
    request: InstanceRevisionRequest,
  ): Promise<InstanceRecordView> {
    const path = this.instanceRecordPath(projectId, recordId, '/publish')
    return this.#request<unknown>('POST', path, {
      body: {},
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => this.readInstanceRecord(path, data))
  }

  listCandidates(filter: CandidateFilter = {}): Promise<CandidateSummary[]> {    const query = new URLSearchParams()
    if (filter.jobId !== undefined) query.set('jobId', filter.jobId)
    if (filter.state !== undefined) query.set('state', filter.state)
    if (filter.kind !== undefined) query.set('kind', filter.kind)
    if (filter.limit !== undefined) query.set('limit', String(filter.limit))
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    return this.#request<{ candidates: CandidateSummary[] }>('GET', `/api/v1/candidates${suffix}`).then(
      (data) => data.candidates,
    )
  }

  getCandidate(candidateId: string): Promise<CandidateDetailView> {
    return this.#request<{ candidate: CandidateDetailView }>(
      'GET',
      `/api/v1/candidates/${encodeURIComponent(candidateId)}`,
    ).then((data) => data.candidate)
  }

  getCandidateSource(candidateId: string): Promise<CandidateSourceView> {
    return this.#request<CandidateSourceView>(
      'GET',
      `/api/v1/candidates/${encodeURIComponent(candidateId)}/source`,
    )
  }

  listCandidateDecisions(candidateId: string): Promise<IdentityDecisionView[]> {
    return this.#request<{ decisions: IdentityDecisionView[] }>(
      'GET',
      `/api/v1/candidates/${encodeURIComponent(candidateId)}/decisions`,
    ).then((data) => data.decisions)
  }

  decideCandidate(candidateId: string, request: IdentityDecisionRequest): Promise<IdentityDecisionView> {
    return this.#request<IdentityDecisionView>(
      'POST',
      `/api/v1/candidates/${encodeURIComponent(candidateId)}/decision`,
      {
        body: {
          kind: request.kind,
          expectedRevision: request.expectedRevision,
          ...(request.targetEntityId === undefined ? {} : { targetEntityId: request.targetEntityId }),
          ...(request.justification === undefined ? {} : { justification: request.justification }),
          ...(request.strongIdentityValue === undefined
            ? {}
            : { strongIdentity: { kind: 'native_id', value: request.strongIdentityValue } }),
        },
        ifMatch: request.expectedRevision,
      },
    )
  }

  listCandidateReviews(candidateId: string): Promise<CandidateReviewRecord[]> {
    return this.#request<{ reviews: CandidateReviewRecord[] }>(
      'GET',
      `/api/v1/candidates/${encodeURIComponent(candidateId)}/reviews`,
    ).then((data) => data.reviews)
  }

  reviewCandidate(candidateId: string, request: CandidateReviewRequest): Promise<CandidateReviewRecord> {
    return this.#request<CandidateReviewRecord>(
      'POST',
      `/api/v1/candidates/${encodeURIComponent(candidateId)}/reviews`,
      {
        body: { decision: request.decision, reason: request.reason },
        ifMatch: request.expectedRevision,
      },
    )
  }

  listPublications(): Promise<SemanticPublicationVersion[]> {
    return this.#request<{ publications: SemanticPublicationVersion[] }>(
      'GET',
      '/api/v1/semantic-publications',
    ).then((data) => data.publications)
  }

  publishSemantics(request: PublishSemanticsRequest): Promise<SemanticPublicationVersion> {
    return this.#request<SemanticPublicationVersion>('POST', '/api/v1/semantic-publications', {
      body: {
        approvedCandidateRefs: request.approvedCandidateRefs,
        schemaRef: request.schemaRef,
        expectedRevision: request.expectedRevision,
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    })
  }

  getStatement(statementId: string): Promise<PublishedStatement> {
    return this.#request<PublishedStatement>('GET', `/api/v1/statements/${encodeURIComponent(statementId)}`)
  }

  listStatementRevisions(statementId: string): Promise<StatementRevisionRecord[]> {
    return this.#request<{ revisions: StatementRevisionRecord[] }>(
      'GET',
      `/api/v1/statements/${encodeURIComponent(statementId)}/revisions`,
    ).then((data) => data.revisions)
  }

  reviseStatement(statementId: string, request: StatementRevisionRequest): Promise<StatementRevisionRecord> {
    return this.#request<StatementRevisionRecord>(
      'POST',
      `/api/v1/statements/${encodeURIComponent(statementId)}/revisions`,
      {
        body: {
          kind: request.kind,
          reason: request.reason,
          ...(request.correctedValue === undefined ? {} : { correctedValue: request.correctedValue }),
        },
        ifMatch: request.expectedRevision,
        idempotencyKey: this.#newId(),
      },
    )
  }

  /** `GET /evidence/{id}`: the authorized provenance view of one evidence item. */
  getEvidence(evidenceId: string, query: EvidenceReadQuery = {}): Promise<ProvenanceEvidenceView> {
    const path = `/api/v1/evidence/${encodeURIComponent(evidenceId)}${optionalTimeQuery(query)}`
    return this.#request<unknown>(
      'GET',
      path,
    ).then((view) => { if (!isProvenanceView(view) || view.evidenceId !== evidenceId) throw malformedResponse(path, 'the evidence view was not recognised'); return view })
  }

  getAnswerSource(answer: PublishedAnswer, evidenceRef: ResourceRef, signal?: AbortSignal, selector?: SavedCellSelector): Promise<AnswerSourceView> {
    return readAnswerSource(this, answer, evidenceRef, signal, selector)
  }

  /**
   * `GET /evidence/{id}/dependencies`: one bounded page of the real evidence dependency graph.
   * `nextCursor` is the envelope's `meta.nextCursor`; `graph.coverage.truncated` marks an
   * incomplete traversal that must not be presented as completeness.
   */
  getEvidenceDependencies(
    evidenceId: string,
    traversal: DependencyTraversalRequest,
  ): Promise<DependencyPage> {
    return this.#requestWithMeta<DependencyGraphView>(
      `/api/v1/evidence/${encodeURIComponent(evidenceId)}/dependencies?${dependencyQuery(traversal)}`,
    ).then(({ data, nextCursor }) => ({ graph: data, nextCursor }))
  }

  /** `GET /objects/{id}/history`: one bounded page of immutable assertion versions. */
  getObjectHistory(objectId: string, query: ObjectHistoryQuery = {}): Promise<HistoryPage> {
    return this.#requestWithMeta<ObjectHistoryView>(
      `/api/v1/objects/${encodeURIComponent(objectId)}/history${optionalTimeQuery(query)}`,
    ).then(({ data, nextCursor }) => ({ view: data, nextCursor }))
  }

  /**
   * `POST /simulations/inputs`: archive a synthetic scenario from the operator's two intents and
   * return its descriptor (opaque `inputRef` plus unit/time/sampling/mode labels).
   */
  buildEnergyScenario(request: CreateScenarioRequest): Promise<ScenarioDescriptor> {
    const path = '/api/v1/simulations/inputs'
    return this.#request<unknown>('POST', path, { body: request, idempotencyKey: this.#newId() }).then(
      (data) => {
        const scenario = asScenarioDescriptor(data)
        if (scenario === undefined) throw malformedResponse(path, 'the scenario descriptor was not recognised')
        return scenario
      },
    )
  }

  /** `POST /simulations`: run a registered operation over approved input refs. */
  requestSimulation(request: RequestSimulationInput): Promise<SimulationRecordView> {
    const path = '/api/v1/simulations'
    return this.#request<unknown>('POST', path, { body: request, idempotencyKey: this.#newId() }).then(
      (data) => {
        const record = asSimulationRecord(data)
        if (record === undefined) throw malformedResponse(path, 'the simulation record was not recognised')
        return record
      },
    )
  }

  /** `GET /simulations/{id}`: the typed result, its scenario labels and the integrity outcome. */
  getSimulation(simulationId: string): Promise<SimulationDetailView> {
    const path = `/api/v1/simulations/${encodeURIComponent(simulationId)}`
    return this.#request<unknown>('GET', path).then((data) => {
      const detail = asSimulationDetail(data)
      if (detail === undefined) throw malformedResponse(path, 'the simulation detail was not recognised')
      return detail
    })
  }

  /**
   * `POST /executions`: schedule a simulation execution. A `mode=live` request is refused by the
   * server with `CAPABILITY_NOT_CONFIGURED`; the UI surfaces that as an explicit failure and never
   * as a completed execution.
   */
  requestExecution(request: RequestExecutionRequest): Promise<ExecutionRecordView> {
    const path = '/api/v1/executions'
    return this.#request<unknown>('POST', path, { body: request, idempotencyKey: this.#newId() }).then(
      (data) => {
        const record = asExecutionRecord(data)
        if (record === undefined) throw malformedResponse(path, 'the execution record was not recognised')
        return record
      },
    )
  }

  /** `GET /industry-packs`: the published pack versions a project can be created against. */
  listIndustryPacks(): Promise<IndustryPackSummary[]> {
    const path = '/api/v1/industry-packs'
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !Array.isArray(data['packs']) || !data['packs'].every(isIndustryPackSummary)) {
        throw malformedResponse(path, 'the industry pack list was not recognised')
      }
      return data['packs']
    })
  }

  /** `GET /projects`: the customer projects visible in the trusted scope. */
  listProjects(filter: { readonly state?: ProjectState; readonly limit?: number } = {}): Promise<ProjectRecord[]> {
    const query = new URLSearchParams()
    if (filter.state !== undefined) query.set('state', filter.state)
    if (filter.limit !== undefined) query.set('pageSize', String(filter.limit))
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    const path = `/api/v1/projects${suffix}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !Array.isArray(data['projects']) || !data['projects'].every(isProjectRecord)) {
        throw malformedResponse(path, 'the project list was not recognised')
      }
      return data['projects']
    })
  }

  /** `POST /projects`: create a project against an exact published pack version. */
  createProject(request: CreateProjectRequest): Promise<{ readonly project: ProjectRecord; readonly revision: ProjectRevision }> {
    const path = '/api/v1/projects'
    return this.#request<unknown>('POST', path, { body: request, idempotencyKey: this.#newId() }).then((data) => {
      if (!isRecord(data) || !isProjectRecord(data['project']) || !isProjectRevision(data['revision'])) {
        throw malformedResponse(path, 'the created project was not recognised')
      }
      return { project: data['project'], revision: data['revision'] }
    })
  }

  getProject(projectId: string): Promise<ProjectRecord> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !isProjectRecord(data['project'])) {
        throw malformedResponse(path, 'the project was not recognised')
      }
      return data['project']
    })
  }

  listProjectRevisions(projectId: string): Promise<ProjectRevision[]> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/revisions`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !Array.isArray(data['revisions']) || !data['revisions'].every(isProjectRevision)) {
        throw malformedResponse(path, 'the project revision list was not recognised')
      }
      return data['revisions']
    })
  }

  getProjectRevisionView(projectId: string, revision: string): Promise<ProjectRevisionView> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/revisions/${encodeURIComponent(revision)}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isProjectRevisionView(data)) {
        throw malformedResponse(path, 'the project revision view was not recognised')
      }
      return data
    })
  }

  /** `GET /projects/:id/readiness`: semantic/query/index projections with fixable blockers. */
  getProjectReadiness(
    projectId: string,
    revision?: string,
    required?: readonly string[],
  ): Promise<ProjectReadinessView> {
    const query = new URLSearchParams()
    if (revision !== undefined) query.set('revision', revision)
    if (required !== undefined && required.length > 0) query.set('required', required.join(','))
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/readiness${suffix}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isProjectReadinessView(data)) {
        throw malformedResponse(path, 'the project readiness view was not recognised')
      }
      return data
    })
  }

  /** `POST /projects/:id/pack-mounts`: mount an exact published pack version as a new revision. */
  mountProjectPack(projectId: string, request: MountProjectPackRequest): Promise<ProjectEvolutionView> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/pack-mounts`
    return this.#request<unknown>('POST', path, {
      body: {
        industryPackRef: request.industryPackRef,
        reason: request.reason,
        ...(request.profileRef === undefined ? {} : { profileRef: request.profileRef }),
        ...(request.mappingRefs === undefined ? {} : { mappingRefs: request.mappingRefs }),
        ...(request.documentSetRef === undefined ? {} : { documentSetRef: request.documentSetRef }),
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: this.#newId(),
    }).then((data) => {
      if (!isProjectEvolutionView(data)) {
        throw malformedResponse(path, 'the mounted project revision was not recognised')
      }
      return data
    })
  }

  /**
   * `GET /industry-workspaces/:id/synthetic-example-sets`: the isolation-marked counter-example
   * sets the sandbox holds. Every returned set keeps its `synthetic` marker; a set that lost it is
   * an explicit malformed response rather than a silently trusted counter-example.
   */
  listSyntheticExampleSets(workspaceId: string): Promise<SyntheticExampleSetView[]> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/synthetic-example-sets`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !Array.isArray(data['exampleSets']) || !data['exampleSets'].every(isSyntheticExampleSetView)) {
        throw malformedResponse(path, 'the synthetic example set list was not recognised')
      }
      return data['exampleSets']
    })
  }

  prepareExecutionPreview(workspaceId: string, exampleSetId: string, options: RequestOptions): Promise<ExecutionPreviewView> {
    return this.#request<unknown>('POST', `/api/v1/core/workspaces/${encodeURIComponent(workspaceId)}/execution-preview`, { ...options, body: { exampleSetId } }).then(parseExecutionPreview)
  }
  getExecutionPreview(workspaceId: string, signal?: AbortSignal): Promise<ExecutionPreviewView> {
    return this.#request<unknown>('GET', `/api/v1/core/workspaces/${encodeURIComponent(workspaceId)}/execution-preview`, { ...(signal === undefined ? {} : { signal }) }).then(parseExecutionPreview)
  }

  /** `POST /industry-workspaces/:id/validations`: run the synthetic validation over a draft. */
  createSyntheticValidation(
    workspaceId: string,
    request: RunValidationRequest,
    options: Pick<RequestOptions, 'signal' | 'idempotencyKey'> = {},
  ): Promise<IndustryValidationReportView> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/validations`
    return this.#request<unknown>('POST', path, {
      body: { exampleSetId: request.exampleSetId, ...(request.competencyQuestionRef === undefined ? {} : { competencyQuestionRef: request.competencyQuestionRef }), ...(request.strategy === undefined ? {} : { strategy: request.strategy }) },
      ...(request.expectedRevision === undefined ? {} : { ifMatch: request.expectedRevision }),
      idempotencyKey: options.idempotencyKey ?? this.#newId(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }).then((data) => this.readValidationReport(path, data))
  }

  /** `GET /industry-workspaces/:id/validations/:validationId`: one immutable report. */
  getValidation(workspaceId: string, validationId: string): Promise<IndustryValidationReportView> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/validations/${encodeURIComponent(validationId)}`
    return this.#request<unknown>('GET', path).then((data) => this.readValidationReport(path, data))
  }

  /**
   * `POST /industry-workspaces/:id/publications`: publish an immutable pack from a reviewed draft.
   * The server refuses a blocked semantic surface, and refuses a not-fully-executable deployment
   * surface when `requireDeploymentExecutable` is set. The two surfaces come back independently.
   */
  publishPack(workspaceId: string, request: PublishPackRequest, options: Pick<RequestOptions, 'signal' | 'idempotencyKey'> = {}): Promise<PublishedPackResultView> {
    const path = `/api/v1/industry-workspaces/${encodeURIComponent(workspaceId)}/publications`
    return this.#request<unknown>('POST', path, {
      body: {
        packId: request.packId,
        version: request.version,
        validationId: request.validationId,
        ...(request.strategy === undefined ? {} : { strategy: request.strategy }),
        ...(request.requireDeploymentExecutable ? { requireDeploymentExecutable: true } : {}),
      },
      ifMatch: request.expectedRevision,
      idempotencyKey: options.idempotencyKey ?? this.#newId(),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }).then((data) => {
      if (!isRecord(data) || !isVersionRef(data['packRef']) || !isPackCapabilityStatusView(data['capabilityStatus'])) {
        throw malformedResponse(path, 'the published pack result was not recognised')
      }
      const pack = data['pack']
      if (!isRecord(pack) || typeof pack['revision'] !== 'string' || typeof pack['publishedAt'] !== 'string') {
        throw malformedResponse(path, 'the published pack asset was not recognised')
      }
      const result: PublishedPackResultView = {
        packRef: data['packRef'],
        capabilities: data['capabilityStatus'],
        revision: pack['revision'],
        publishedAt: pack['publishedAt'],
      }
      if (!isPublishedPackResult(result)) throw malformedResponse(path, 'the published pack result was not recognised')
      return result
    })
  }

  /** `GET /industry-packs/:packId/export`: the declaration-only immutable export of one version. */
  exportIndustryPack(packId: string, version: string): Promise<PackExportBundleView> {
    const query = new URLSearchParams({ version })
    const path = `/api/v1/industry-packs/${encodeURIComponent(packId)}/export?${query.toString()}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isPackExportBundleView(data)) {
        throw malformedResponse(path, 'the industry pack export bundle was not recognised')
      }
      return data
    })
  }

  private readValidationReport(path: string, data: unknown): IndustryValidationReportView {
    if (!isRecord(data) || !isIndustryValidationReportView(data['validation'])) {
      throw malformedResponse(path, 'the industry validation report was not recognised')
    }
    return data['validation']
  }

  listProjectMappings(projectId: string): Promise<ImportMappingVersion[]> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/mappings`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !Array.isArray(data['mappings']) || !data['mappings'].every(isImportMappingVersion)) {
        throw malformedResponse(path, 'the project mapping list was not recognised')
      }
      return data['mappings']
    })
  }

  previewProjectMapping(projectId: string, request: ColumnMappingRequestView): Promise<MappingPreview> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/mappings/preview`
    return this.#request<unknown>('POST', path, { body: request }).then((data) => {
      if (!isRecord(data) || !isMappingPreview(data['preview'])) {
        throw malformedResponse(path, 'the mapping preview was not recognised')
      }
      return data['preview']
    })
  }

  confirmProjectMapping(
    projectId: string,
    request: ColumnMappingRequestView,
    idempotencyKey?: string,
  ): Promise<{ readonly mapping: ImportMappingVersion; readonly preview: MappingPreview }> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/mappings`
    return this.#request<unknown>('POST', path, { body: request, idempotencyKey: idempotencyKey ?? this.#newId() }).then((data) => {
      if (!isRecord(data) || !isImportMappingVersion(data['mapping']) || !isMappingPreview(data['preview'])) {
        throw malformedResponse(path, 'the confirmed mapping was not recognised')
      }
      return { mapping: data['mapping'], preview: data['preview'] }
    })
  }

  listProjectRecords(
    projectId: string,
    filter: { readonly objectId?: string; readonly status?: string; readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<ProjectRecordPageView> {
    const query = new URLSearchParams()
    if (filter.objectId !== undefined) query.set('objectId', filter.objectId)
    if (filter.status !== undefined) query.set('status', filter.status)
    if (filter.cursor !== undefined) query.set('cursor', filter.cursor)
    if (filter.limit !== undefined) query.set('pageSize', String(filter.limit))
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : ''
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/records${suffix}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isProjectRecordPageView(data)) {
        throw malformedResponse(path, 'the project record page was not recognised')
      }
      return {
        records: data.records,
        total: data.total,
        ...(typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}),
      }
    })
  }

  /** `POST /projects/:id/records`: bind the confirmed mapping's parsed rows into project records. */
  bindProjectRecords(
    projectId: string,
    request: { readonly parseId: string; readonly mappingId: string; readonly mappingVersion: string },
    idempotencyKey?: string,
  ): Promise<{ readonly records: readonly ProjectRecordVersion[]; readonly created: boolean }> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/records`
    return this.#request<unknown>('POST', path, { body: request, idempotencyKey: idempotencyKey ?? this.#newId() }).then((data) => {
      if (!isRecord(data) || !Array.isArray(data['records']) || typeof data['created'] !== 'boolean') {
        throw malformedResponse(path, 'the bound project records were not recognised')
      }
      return { records: data['records'], created: data['created'] }
    })
  }

  getProjectDatasetStatus(projectId: string, objectId: string): Promise<ProjectDatasetStatusView> {
    const query = new URLSearchParams({ objectId })
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/dataset/status?${query.toString()}`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !isProjectDatasetStatus(data['status'])) {
        throw malformedResponse(path, 'the project dataset status was not recognised')
      }
      return data['status']
    })
  }

  materializeProjectDataset(
    projectId: string,
    request: { readonly objectId: string; readonly revision?: string; readonly allowPartial?: boolean },
    idempotencyKey?: string,
  ): Promise<ProjectDatasetStatusView> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/dataset-snapshots`
    return this.#request<unknown>('POST', path, { body: request, idempotencyKey: idempotencyKey ?? this.#newId() }).then((data) => {
      if (!isRecord(data) || !isProjectDatasetStatus(data['status'])) {
        throw malformedResponse(path, 'the materialised project dataset was not recognised')
      }
      return data['status']
    })
  }

  getProjectDocumentIndex(projectId: string): Promise<ProjectDocumentIndexStatusView> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/document-index`
    return this.#request<unknown>('GET', path).then((data) => {
      if (!isRecord(data) || !isProjectDocumentIndexStatus(data['status'])) {
        throw malformedResponse(path, 'the project document index status was not recognised')
      }
      return data['status']
    })
  }

  buildProjectDocumentIndex(projectId: string, idempotencyKey?: string): Promise<ProjectDocumentIndexStatusView> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/document-index`
    return this.#request<unknown>('POST', path, { body: {}, idempotencyKey: idempotencyKey ?? this.#newId() }).then((data) => {
      if (!isRecord(data) || !isProjectDocumentIndexStatus(data['status'])) {
        throw malformedResponse(path, 'the built project document index was not recognised')
      }
      return data['status']
    })
  }

  importProjectDocumentMembership(
    projectId: string,
    request: {
      readonly documentId?: string
      readonly documentRef: ResourceRef
      readonly parseRef: ResourceRef
      readonly parseId: string
      readonly reason?: string
    },
  ): Promise<ProjectDocumentIndexStatusView> {
    const path = `/api/v1/projects/${encodeURIComponent(projectId)}/document-memberships`
    return this.#request<unknown>('POST', path, { body: request, idempotencyKey: this.#newId() }).then((data) => {
      if (!isRecord(data) || !isProjectDocumentIndexStatus(data['status'])) {
        throw malformedResponse(path, 'the imported project document was not recognised')
      }
      return data['status']
    })
  }

  async #requestWithMeta<T>(path: string, signal?: AbortSignal): Promise<{ data: T; nextCursor: string | undefined }> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      throw new ApiError(response.status, toApiFailure(response.status, parsed))
    }
    const data = dataOf<T>(parsed, path)
    const meta = isRecord(parsed) && isRecord(parsed['meta']) ? parsed['meta'] : undefined
    const nextCursor =
      meta !== undefined && typeof meta['nextCursor'] === 'string' ? meta['nextCursor'] : undefined
    return { data, nextCursor }
  }

  newRequestKey(): string { return this.#newId() }

  /** Shared authenticated transport. Domain callers must validate the returned wire body. */
  requestJson<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    return this.#request<T>(method, path, options)
  }

  requestBytes<T = unknown>(method: string, path: string, bytes: Uint8Array, options: Omit<RequestOptions, 'body'> & {
    readonly mediaType: string
  }): Promise<T> {
    return this.#request<T>(method, path, options, bytes)
  }

  async #request<T>(method: string, path: string, options: RequestOptions = {}, bytes?: Uint8Array): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (bytes !== undefined && 'mediaType' in options && typeof options.mediaType === 'string') {
      headers['content-type'] = 'application/octet-stream'
      headers['x-source-media-type'] = options.mediaType
    }
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(bytes === undefined ? {} : { body: new Blob([new Uint8Array(bytes)]) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      throw new ApiError(response.status, toApiFailure(response.status, parsed))
    }
    return dataOf<T>(parsed, path)
  }
}
