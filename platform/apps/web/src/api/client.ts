import type {
  ActiveProfileRecord,
  CapabilityRequirement,
  ComponentKind,
  ComponentVersionRecord,
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
  RevisionString,
  Sha256Digest,
  SourceRef,
  SourceObjectRef,
  SourceBindingRecord,
  SourceKind,
  SourceProbeJobRecord,
  VersionRef,
} from '@ontology/contracts'
import { ApiError, toApiFailure } from './errors'
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
  readonly models: 'disabled' | 'requested_but_not_connected'
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

interface RequestOptions {
  readonly body?: unknown
  readonly idempotencyKey?: string
  readonly ifMatch?: string
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
  if (value['models'] !== 'disabled' && value['models'] !== 'requested_but_not_connected') {
    throw malformedResponse('/api/v1/core/deployment', 'the deployment response has an unknown model status')
  }
  const scenarios: CoreDeploymentScenario[] = value['scenarios'].map((candidate, index) => {
    if (!isRecord(candidate) ||
      typeof candidate['scenarioId'] !== 'string' || candidate['scenarioId'].length === 0 ||
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
  return { classification: value['classification'], scenarios, operatorEnabled: value['operatorEnabled'], models: value['models'] }
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

  createRun(request: CreateRunRequest): Promise<CreateRunView> {
    return this.#request<CreateRunView>('POST', '/api/v1/runs', {
      body: request,
      idempotencyKey: this.#newId(),
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

  listCandidates(filter: CandidateFilter = {}): Promise<CandidateSummary[]> {
    const query = new URLSearchParams()
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
    return this.#request<ProvenanceEvidenceView>(
      'GET',
      `/api/v1/evidence/${encodeURIComponent(evidenceId)}${optionalTimeQuery(query)}`,
    )
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

  async #requestWithMeta<T>(path: string): Promise<{ data: T; nextCursor: string | undefined }> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
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

  async #request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey
    if (options.ifMatch !== undefined) headers['if-match'] = options.ifMatch

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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
