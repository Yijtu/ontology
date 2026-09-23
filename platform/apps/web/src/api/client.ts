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
  ProvenanceEvidenceView,
  PublishedAnswer,
  ResourceRef,
  ProfileSpec,
  ProfileVersionRecord,
  RevisionString,
  Sha256Digest,
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

/** Local energy preview only: integrity-checked details linked to a published plan answer. */
export interface LocalPlanDetailView {
  readonly runId: string
  readonly answerId: string
  readonly sourceEvidenceRef: ResourceRef
  readonly resultRef: ResourceRef
  readonly dataMode: 'simulation'
  readonly optimality: 'best_of_tested_candidates'
  readonly selectedStrategy: string
  readonly candidateTotalCost: number
  readonly baselineTotalCost: number
  readonly currency: string
  readonly reserveSatisfied: boolean
  readonly intervals: readonly {
    readonly slotIndex: number
    readonly startUtc: string
    readonly endUtc: string
    readonly chargeKw: number
    readonly dischargeKw: number
    readonly energyStartKwh: number
    readonly energyEndKwh: number
  }[]
  readonly reserveMargins: readonly {
    readonly windowStartSlot: number
    readonly windowEndSlot: number
    readonly reserveKwh: number
    readonly marginKwh: number
    readonly satisfied: boolean
  }[]
  readonly assumptions: readonly string[]
}

export interface ComponentFilter {
  readonly kind?: ComponentKind
  readonly lifecycleState?: ModuleLifecycleState
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

  /** Read a simulation trajectory only after its verified answer has been published. */
  getLocalPlan(runId: string): Promise<LocalPlanDetailView> {
    return this.#request<LocalPlanDetailView>('GET', `/api/v1/runs/${encodeURIComponent(runId)}/plan`)
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
