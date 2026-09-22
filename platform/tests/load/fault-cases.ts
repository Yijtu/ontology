import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createToolContext } from '@ontology/contracts'
import type {
  AnswerVerifierPort,
  MaterializationChange,
  NewOutboxMessage,
  PlanSpec,
  ProfileRef,
  PublicationValidityPort,
  PublicationValidityReport,
  PublishedRuleVersion,
  PublishedStatement,
  PublishSemanticPublicationInput,
  ResourceRef,
  RuntimeAdapter,
  RuntimeCapabilityFactoryPort,
  RuntimeCapabilitySet,
  RuntimeSelectorPort,
  ToolContext,
  Uuid,
  VerificationResult,
  VerifierRequest,
  VersionRef,
} from '@ontology/contracts'
import {
  IncrementalMaterializer,
  PublishedSemanticSource,
  sha256DigestOf,
} from '@ontology/semantic-engine'
import {
  AnswerPublicationService,
  InMemoryVerificationStore,
  InMemoryWorkflowStore,
  JobService,
  JobWorker,
  RestrictedAnswerVerifier,
  RestrictedDraftWriter,
  RestrictedLimitedAnswerComposer,
  RunPhaseDriver,
  RunService,
  StaticInputValidity,
  WorkflowController,
  createRunCheckpointPort,
} from '@ontology/application'
import type { RunProfileBinder, RunProfileBinding } from '@ontology/application'
import { ControlPostgresRepository, PostgresJobStore } from '@ontology/adapter-control-postgres'
import { TemplateRuntimeAdapter } from '@ontology/adapter-runtime-template'
import { connectStdioToolClient } from '@ontology/adapter-transport-mcp'
import type { OutboundMcpToolClient, RemoteToolMapping } from '@ontology/adapter-transport-mcp'
import {
  createBlobArtifactWriter,
  createEnergyComputeConfig,
  createSimulationJobPort,
  createToolGatewayComposition,
} from '@ontology/app-api'
import { SimulationStageHandler, createSimulationRunGuard, createWorkerStageRegistry } from '@ontology/app-worker'
import {
  ENERGY_OPERATION_INPUT_MEDIA_TYPE,
  SimulationExecutionService,
  encodeEnergyOperationInput,
  energyOperationRef,
} from '@ontology/extension-home-energy'
import type { EnergyOperationInput } from '@ontology/extension-home-energy'
import { ToolGatewayError } from '@ontology/tool-services'
import type { RunToolBinding, ToolExecutionOutcome, ToolExecutionRequest, ToolHandler } from '@ontology/tool-services'
import { ManualClock, newJobInput, pipelineHandlers } from '../unit/job-fixtures'
import { createMcpSchemaValidator } from '../fixtures/mcp/validator'
import {
  dataQueryDefinition,
  documentSearchDefinition,
  ontologyLookupDefinition,
  webSearchDefinition,
} from '../fixtures/mcp/platform-session'
import {
  RecordingHandler,
  canonicalToolValidator,
  fullProfile,
  observation,
  operationRegistry,
} from '../unit/tool-gateway-fixtures'
import { StaticPlanResolver, forbiddenGeneration, publishedPlan, runtimeManifest } from '../unit/template-runtime-fixtures'
import { forbiddenDecision } from '../unit/pi-runtime-fixtures'
import { planFor, planningRequest } from '../fixtures/home-energy'
import type { FaultCaseResult } from './report'
import { createLoadScope } from './load-environment'
import type { LoadEnvironment, LoadScope } from './load-environment'

/**
 * The six reproducible fault cases (SPEC V5, D5–D7).
 *
 * Every case drives the real service against the real PostgreSQL container / real stdio MCP
 * child. The only controlled substitute anywhere in this file is the model decision port; no
 * fault case mocks the budget ledger, the job store, the materialisation store, the workflow
 * controller or the transport.
 */

const NOW = '2026-09-21T00:00:00Z'
const DIGEST = `sha256:${'a'.repeat(64)}`
const PLATFORM_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURE_SERVER = fileURLToPath(new URL('../fixtures/mcp/fixture-remote-server.ts', import.meta.url))

function ok(caseId: string, description: string, expected: string, observed: string, detail: string): FaultCaseResult {
  return { caseId, description, expectedOutcome: expected, observedOutcome: observed, passed: true, detail }
}

function failed(
  caseId: string,
  description: string,
  expected: string,
  observed: string,
  detail: string,
): FaultCaseResult {
  return { caseId, description, expectedOutcome: expected, observedOutcome: observed, passed: false, detail }
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

function loadContext(runId: string, tenantId: string, spaceId: string): ToolContext {
  return createToolContext({
    principal: {
      tenantId,
      subjectId: 'load-harness',
      roles: ['business-user', 'data-editor', 'platform-admin'],
      scopes: ['tool:invoke'],
      authEpoch: 1,
    },
    runId,
    resolvedProfileHash: DIGEST,
    policyVersion: '0.2.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: randomUUID(),
      runId,
      grantedAt: NOW,
      expiresAt: '2030-01-01T00:00:00Z',
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
    traceId: `trace-load-${runId.slice(0, 8)}`,
  })
}

// ---------------------------------------------------------------------------
// 1. Concurrent budget contention
// ---------------------------------------------------------------------------

export async function concurrentBudgetContention(env: LoadEnvironment): Promise<FaultCaseResult> {
  const scope = await createLoadScope(env, 'fault-budget')
  const ledgerId = randomUUID()
  const runId = randomUUID()
  await env.budget.openLedger(
    { ledgerId, kind: 'run', overrideLimits: { maxToolCalls: 8 }, runId },
    scope.ctx,
  )
  const outcomes = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      env.budget.reserve(
        { ledgerId, idempotencyKey: `load-budget-${String(index).padStart(4, '0')}` },
        scope.ctx,
      ),
    ),
  )
  const granted = outcomes.filter((outcome) => outcome.granted)
  const denied = outcomes.filter((outcome) => !outcome.granted)
  const allExhausted = denied.every((outcome) => outcome.denial?.code === 'BUDGET_EXHAUSTED')
  const observed = `granted=${String(granted.length)} denied=${String(denied.length)} allBudgetExhausted=${String(allExhausted)}`
  const description = '24 concurrent reservations contend for 8 tool-call slots on one real ledger'
  const expected = 'exactly 8 granted, 16 denied with BUDGET_EXHAUSTED, ledger not oversubscribed'
  if (granted.length === 8 && denied.length === 16 && allExhausted) {
    return ok('concurrent-budget-contention', description, expected, observed, 'the real PostgreSQL reservation is atomic')
  }
  return failed('concurrent-budget-contention', description, expected, observed, 'the ledger oversubscribed or denied for the wrong reason')
}

// ---------------------------------------------------------------------------
// 2. Worker interruption (lease reclaim) — exactly-once publication
// ---------------------------------------------------------------------------

/** Fails once, after the store method committed, to simulate a worker crash. */
class FaultInjectingJobStore extends PostgresJobStore {
  failNextPublish = false

  override async publishJob(
    ...args: Parameters<PostgresJobStore['publishJob']>
  ): ReturnType<PostgresJobStore['publishJob']> {
    const result = await super.publishJob(...args)
    if (this.failNextPublish) {
      this.failNextPublish = false
      throw new Error('simulated crash after publication commit')
    }
    return result
  }
}

async function countRows(env: LoadEnvironment, table: string, jobId: string): Promise<number> {
  const result = await env.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.${table} WHERE job_id = $1`,
    [jobId],
  )
  return Number(result.rows[0]?.count ?? '0')
}

export async function workerInterruptionLeaseReclaim(env: LoadEnvironment): Promise<FaultCaseResult> {
  const scope = await createLoadScope(env, 'fault-worker')
  const clock = new ManualClock()
  const faultStore = new FaultInjectingJobStore(env.database)
  const service = new JobService({ store: faultStore, now: clock.now, newId: () => randomUUID() })
  const input = newJobInput()
  await service.createJob(input, scope.ctx)

  const handlers = pipelineHandlers({ publish: true })
  const crashingWorker = new JobWorker({
    store: faultStore,
    handlers,
    budget: env.budget,
    now: clock.now,
    newId: () => randomUUID(),
    workerId: 'load-crash-worker',
  })
  faultStore.failNextPublish = true
  let crashed = false
  try {
    await crashingWorker.runOnce(scope.scopeRef, scope.ctx)
  } catch {
    crashed = true
  }

  const afterCrash = await env.jobStore.getJob(scope.scopeRef, input.jobId, scope.ctx)
  const publicationsAfterCrash = await countRows(env, 'job_publications', input.jobId)

  clock.advance(5 * 60_000)
  const recoveringWorker = new JobWorker({
    store: env.jobStore,
    handlers,
    budget: env.budget,
    now: clock.now,
    newId: () => randomUUID(),
    workerId: 'load-recover-worker',
  })
  const result = await recoveringWorker.runOnce(scope.scopeRef, scope.ctx)
  const publicationsAfterRecover = await countRows(env, 'job_publications', input.jobId)
  const attempts = await env.jobStore.listAttempts(scope.scopeRef, input.jobId, scope.ctx)

  const observed = `crashed=${String(crashed)} stageAfterCrash=${afterCrash?.stage ?? 'missing'} publications=${String(publicationsAfterCrash)} reclaimed=${String(result.reclaimedAttemptId !== undefined)} publicationsAfterRecover=${String(publicationsAfterRecover)} attempts=${attempts.map((attempt) => attempt.state).join(',')}`
  const description = 'a worker crashes after the publication commit; the expired lease is reclaimed'
  const expected = 'one publication before and after reclaim; attempt abandoned then succeeded'
  const passed =
    crashed &&
    afterCrash?.stage === 'published' &&
    publicationsAfterCrash === 1 &&
    result.reclaimedAttemptId !== undefined &&
    publicationsAfterRecover === 1 &&
    attempts.map((attempt) => attempt.state).join(',') === 'abandoned,succeeded'
  if (passed) return ok('worker-interruption-lease-reclaim', description, expected, observed, 'reclaim resumed without republishing')
  return failed('worker-interruption-lease-reclaim', description, expected, observed, 'the reclaim republished or did not resume')
}

// ---------------------------------------------------------------------------
// 3. Projection fence — no stale read while a recompute is in flight
// ---------------------------------------------------------------------------

const PROJECTION_REF: VersionRef = { id: 'projection.materialized', version: '1.0.0', digest: DIGEST }
const PREDICATE = 'device.battery_present'
const VALIDITY = { validFrom: '2026-09-21T00:00:00Z', validTo: '2026-09-22T00:00:00Z' }

function sourceRefs(): ResourceRef[] {
  return [{ id: randomUUID(), version: '1.0.0', digest: DIGEST, kind: 'evidence' }]
}

function statementFor(publicationId: Uuid): PublishedStatement {
  return {
    statementId: randomUUID(),
    propositionKey: PREDICATE,
    kind: 'entity',
    subjectEntityId: 'entity.battery',
    predicate: PREDICATE,
    value: { value: true },
    validFrom: VALIDITY.validFrom,
    validTo: VALIDITY.validTo,
    recordedAt: '2026-09-21T06:00:00Z',
    sourceCandidateId: randomUUID(),
    sourceRefs: sourceRefs(),
    publicationId,
    version: '1',
    status: 'active',
  }
}

function ruleVersionFor(publicationId: Uuid): PublishedRuleVersion {
  return {
    ruleVersionId: randomUUID(),
    ruleId: 'rule.battery-present',
    version: '1',
    objectId: PREDICATE,
    severity: 'soft',
    impact: 'low',
    expression: { op: 'compare', attributeId: PREDICATE, operator: 'eq', value: true, spans: [] },
    exceptions: [],
    recordedAt: '2026-09-21T06:00:00Z',
    sourceCandidateId: randomUUID(),
    publicationId,
  }
}

async function insertIngestionJob(env: LoadEnvironment, scope: LoadScope, prefix: string): Promise<Uuid> {
  const jobId = randomUUID()
  await env.adminClient.query(
    `INSERT INTO agent_platform.jobs (
       tenant_id, space_id, job_id, kind, source_ref, document_ref, pipeline_version, stage,
       idempotency_key, input_digest, revision, counts, next_attempt_at, created_at, created_by, updated_at)
     VALUES ($1, $2, $3, 'ingestion', $4, $5, '1.0.0', 'published',
       $6, $7, 1, '{}'::jsonb, now(), now(), $8, now())`,
    [
      scope.tenantId,
      scope.spaceId,
      jobId,
      `${prefix}-source`,
      randomUUID(),
      `${prefix}-${jobId.slice(0, 8)}`,
      sha256DigestOf({ jobId }),
      prefix,
    ],
  )
  return jobId
}

async function publishBundle(
  env: LoadEnvironment,
  scope: LoadScope,
  jobId: Uuid,
  statements: readonly PublishedStatement[],
  ruleVersions: readonly PublishedRuleVersion[],
  key: string,
): Promise<Uuid> {
  const publicationId = randomUUID()
  const expectedRevision = await env.publication.latestPublicationRevision(scope.scopeRef, scope.ctx)
  const message: NewOutboxMessage = {
    outboxId: randomUUID(),
    topic: 'semantic.publication.published',
    payload: { publicationId },
    idempotencyKey: `${key}:outbox`,
    availableAt: '2026-09-21T06:00:00Z',
    createdAt: '2026-09-21T06:00:00Z',
  }
  const input: PublishSemanticPublicationInput = {
    expectedRevision,
    publication: {
      publicationId,
      versionRef: { id: publicationId, version: '1.0.0', digest: DIGEST },
      schemaRef: { id: 'home-energy.core', version: '1.0.0', digest: DIGEST },
      approvedCandidateRefs: [],
      statements: statements.map((statement) => ({ ...statement, publicationId })),
      ruleVersions: ruleVersions.map((rule) => ({ ...rule, publicationId })),
      outboxId: message.outboxId,
      publishedAt: '2026-09-21T06:00:00Z',
      actor: scope.ctx.principal.subjectId,
    },
    idempotencyKey: key,
    requestDigest: DIGEST,
    identityBindings: [],
    outbox: message,
    outboxJobId: jobId,
  }
  await env.publication.publish(scope.scopeRef, input, scope.ctx)
  return publicationId
}

export async function projectionFence(env: LoadEnvironment): Promise<FaultCaseResult> {
  const scope = await createLoadScope(env, 'fault-fence')
  const jobId = await insertIngestionJob(env, scope, 'fence')
  const seedPublication = randomUUID()
  const battery = statementFor(seedPublication)
  await publishBundle(env, scope, jobId, [battery], [ruleVersionFor(seedPublication)], 'fence-seed')

  const materializer = new IncrementalMaterializer({
    publishedSource: new PublishedSemanticSource(env.publication),
    materialization: env.materialization,
  })
  const readRequest = {
    scopeRef: scope.scopeRef,
    projectionRef: PROJECTION_REF,
    asOfRecordedSeq: '9',
    validAt: '2026-09-21T12:00:00Z',
  }
  const seedChange: MaterializationChange = {
    changeId: randomUUID(),
    scopeRef: scope.scopeRef,
    recordedSeq: '1',
    recordedAt: '2026-09-21T06:00:00Z',
    kind: 'assertion_published',
    logicalAssertionId: battery.statementId,
    predicate: PREDICATE,
    validity: VALIDITY,
  }
  await materializer.applyChange(seedChange, scope.ctx)
  const baseline = await materializer.read(readRequest, scope.ctx)

  const retractChange: MaterializationChange = {
    changeId: randomUUID(),
    scopeRef: scope.scopeRef,
    recordedSeq: '2',
    recordedAt: '2026-09-21T07:00:00Z',
    kind: 'assertion_retracted',
    logicalAssertionId: battery.statementId,
    predicate: PREDICATE,
    validity: VALIDITY,
  }
  const ticket = await materializer.beginChange(retractChange, scope.ctx)
  const fenced = await materializer.read(readRequest, scope.ctx)
  // The semantic change really commits to the publication store before the worker recomputes.
  await env.publication.reviseStatement(
    scope.scopeRef,
    {
      expectedRevision: '1',
      revisionId: randomUUID(),
      statementId: battery.statementId,
      kind: 'retraction',
      reason: 'the only supporting source was withdrawn',
      recordedAt: '2026-09-21T07:00:00Z',
      actor: scope.ctx.principal.subjectId,
      outbox: {
        outboxId: randomUUID(),
        topic: 'semantic.statement.retracted',
        payload: {
          statementId: battery.statementId,
          propositionKey: PREDICATE,
          kind: 'retraction',
          revisionId: randomUUID(),
        },
        idempotencyKey: `retract-${battery.statementId}`,
        availableAt: '2026-09-21T07:00:00Z',
        createdAt: '2026-09-21T07:00:00Z',
      },
    },
    scope.ctx,
  )
  await materializer.advance(ticket, scope.ctx)
  const advanced = await materializer.read(readRequest, scope.ctx)
  const conclusion = advanced.conclusions.find((entry) => entry.propositionKey === PREDICATE)

  const observed = `baseline=${baseline.status} affectedRules=${ticket.affectedRuleIds.join(',')} fenced=${fenced.status} blocked=${fenced.blockedPropositionKeys.join(',')} advanced=${advanced.status} conclusion=${conclusion?.domainStatus ?? 'missing'}`
  const description = 'a retraction opens the fence before the worker recomputes; a read during the window is withheld'
  const expected = 'baseline materialized, fenced read returns no stale conclusion, advanced read resolves unknown'
  const passed =
    baseline.status === 'materialized' &&
    ticket.affectedRuleIds.includes('rule.battery-present') &&
    fenced.status === 'fenced' &&
    fenced.conclusions.length === 0 &&
    fenced.blockedPropositionKeys.includes(PREDICATE) &&
    advanced.status === 'materialized' &&
    conclusion?.domainStatus === 'unknown'
  if (passed) return ok('projection-fence', description, expected, observed, 'the fence withheld the stale value')
  return failed('projection-fence', description, expected, observed, 'a stale conclusion was served during the fence window')
}

// ---------------------------------------------------------------------------
// 4. MCP disconnect — possibly-billed remote failure settles as usage_unknown
// ---------------------------------------------------------------------------

/** Wraps an outbound MCP client as a gateway handler so remote failures settle through the platform. */
class RemoteToolHandler implements ToolHandler {
  readonly toolId = 'data_query'
  readonly #ctx: ToolContext
  readonly #client: OutboundMcpToolClient

  constructor(ctx: ToolContext, client: OutboundMcpToolClient) {
    this.#ctx = ctx
    this.#client = client
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionOutcome> {
    const result = await this.#client.invoke(
      { callId: request.callId, toolId: this.toolId, arguments: request.arguments },
      this.#ctx,
    )
    if (result.status === 'error') {
      throw new ToolGatewayError('HANDLER_FAILED', result.error?.message ?? 'the remote tool failed', {
        platformCode: result.error?.code ?? 'INTERNAL_ERROR',
        ...(result.error?.remoteStateUnknown === true ? { remoteStateUnknown: true } : {}),
      })
    }
    return {
      payload: result.inlineData,
      status: result.status === 'partial' ? 'partial' : result.status === 'empty' ? 'empty' : 'ok',
      coverage: result.coverage,
      sources: result.sourceSnapshots.map((snapshot) => ({
        sourceRef: snapshot.sourceRef,
        schemaVersion: snapshot.schemaVersion,
        consistency: snapshot.consistency,
        resultDigest: snapshot.resultDigest,
      })),
      warnings: result.warnings,
    }
  }
}

export async function mcpDisconnect(env: LoadEnvironment): Promise<FaultCaseResult> {
  const scope = await createLoadScope(env, 'fault-mcp')
  const ledgerId = randomUUID()
  const runId = randomUUID()
  const ctx = loadContext(runId, scope.tenantId, scope.spaceId)
  const mappings: readonly RemoteToolMapping[] = [
    { toolId: 'data_query', remoteName: 'data_query', definition: dataQueryDefinition() },
    { toolId: 'ontology_lookup', remoteName: 'ontology_lookup', definition: ontologyLookupDefinition() },
    { toolId: 'document_search', remoteName: 'document_search', definition: documentSearchDefinition() },
    { toolId: 'web_search', remoteName: 'web_search', definition: webSearchDefinition() },
  ]
  const client = await connectStdioToolClient({
    command: process.execPath,
    args: ['--import', 'tsx', FIXTURE_SERVER],
    cwd: PLATFORM_ROOT,
    env: { ...baseEnv(), MCP_FIXTURE_SCENARIO: 'disconnect' },
    stderr: 'pipe',
    mappings,
    validator: createMcpSchemaValidator(),
  })
  try {
    const composition = createToolGatewayComposition({
      database: env.database,
      blobStore: env.blobStore,
      budget: env.budget,
      validator: canonicalToolValidator(),
      handlers: [new RemoteToolHandler(ctx, client)],
    })
    const gateway = composition.forRun({
      runId,
      ledgerId,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    })
    await env.budget.openLedger({ ledgerId, kind: 'run', runId }, ctx)
    const result = await gateway.invoke(
      { callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'describe' } },
      ctx,
    )
    const row = await env.adminClient.query<{ status: string; usage_unknown: boolean }>(
      `SELECT status, usage_unknown FROM agent_platform.budget_reservations
        WHERE tenant_id = $1 AND space_id = $2 AND ledger_id = $3
        ORDER BY granted_at DESC LIMIT 1`,
      [scope.tenantId, scope.spaceId, ledgerId],
    )
    const observed = `status=${result.status} code=${result.error?.code ?? 'none'} remoteStateUnknown=${String(result.error?.remoteStateUnknown ?? false)} ledger=${row.rows[0]?.status ?? 'missing'} usageUnknown=${String(row.rows[0]?.usage_unknown ?? false)}`
    const description = 'a real stdio MCP child exits mid-call; the platform must not report a traceable success'
    const expected = 'SOURCE_UNAVAILABLE with remoteStateUnknown, settled as usage_unknown, no inline data'
    const passed =
      result.status === 'error' &&
      result.error?.code === 'SOURCE_UNAVAILABLE' &&
      result.error?.remoteStateUnknown === true &&
      result.inlineData === undefined &&
      row.rows[0]?.usage_unknown === true
    if (passed) return ok('mcp-disconnect', description, expected, observed, 'the dropped connection was never treated as data')
    return failed('mcp-disconnect', description, expected, observed, 'the disconnect was mishandled')
  } finally {
    await client.close().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// 5. Late cancellation result — a late simulation completion cannot revive a cancelled run
// ---------------------------------------------------------------------------

function operationInput(includePlan: boolean): EnergyOperationInput {
  const request = planningRequest()
  const plan = planFor(request.snapshot.manifest.slotCount)
  return {
    kind: 'home-energy.operation-input',
    version: '1.0.0',
    dataMode: 'synthetic',
    snapshot: request.snapshot,
    topology: request.topology,
    battery: request.battery,
    grid: request.grid,
    load: request.load,
    pv: request.pv,
    tariff: request.tariff,
    reserves: request.reserves,
    tolerance: request.tolerance,
    assumptions: request.assumptions,
    ...(includePlan ? { plan } : {}),
  }
}

const neverBinder: RunProfileBinder = {
  async bindProfileForRun(): Promise<never> {
    throw new Error('the load harness inserts its run directly')
  },
}

/** A real profile binder double that pins the template runtime for the publication-race run. */
const loadBinder: RunProfileBinder = {
  bindProfileForRun(profileRef: ProfileRef): Promise<RunProfileBinding> {
    return Promise.resolve({
      profileRef,
      resolvedProfileHash: DIGEST,
      resolvedProfileRef: { id: profileRef.id, version: profileRef.version, snapshotHash: DIGEST },
      runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
    })
  },
}

export async function lateCancellationResult(env: LoadEnvironment): Promise<FaultCaseResult> {
  const scope = await createLoadScope(env, 'fault-late')
  const profile: ProfileRef = { id: 'load-harness-demo', version: '1.0.0' }
  await env.adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'load-harness')
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.spaceId, profile.id, profile.version, DIGEST],
  )
  await env.adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.spaceId, profile.id, profile.version, DIGEST],
  )
  const control = new ControlPostgresRepository(env.database)
  const runService = new RunService({ store: env.runStore, control, profiles: neverBinder })
  const runId = randomUUID()
  const ctx = loadContext(runId, scope.tenantId, scope.spaceId)
  await env.runStore.insertRun(
    scope.scopeRef,
    {
      runId,
      ownerSubjectId: 'load-harness',
      profileRef: { id: 'load-harness-demo', version: '1.0.0' },
      resolvedProfileHash: DIGEST,
      runtimeRef: { id: 'runtime-template', version: '1.0.0', digest: DIGEST },
      question: 'simulate a plan',
      context: { timeZone: 'UTC' },
      preferences: { route: 'auto', allowWeb: false },
      idempotencyKey: `run-${runId}`,
      requestDigest: DIGEST,
      createdAt: NOW,
    },
    ctx,
  )
  const cancelled = await runService.cancelRun(
    { runId, reason: 'the user cancelled the run', expectedRevision: '1' },
    ctx,
  )

  const compute = createEnergyComputeConfig({ blobStore: env.blobStore, validator: canonicalToolValidator() })
  const writer = createBlobArtifactWriter(env.blobStore)
  const stored = await writer.putBytes(
    {
      scopeRef: scope.scopeRef,
      content: encodeEnergyOperationInput(operationInput(true)),
      mediaType: ENERGY_OPERATION_INPUT_MEDIA_TYPE,
    },
    ctx,
  )
  const jobService = new JobService({ store: new PostgresJobStore(env.database) })
  const execution = new SimulationExecutionService({ jobs: createSimulationJobPort(jobService) })
  const plan = planFor(4)
  const scheduled = await execution.requestExecution(
    {
      operationRef: energyOperationRef('home-energy.simulate'),
      planRef: plan.planRef,
      inputRefs: [stored.blobRef],
      mode: 'simulation',
      runId,
      idempotencyKey: `sim-late-${runId}`,
    },
    ctx,
  )
  const stageRegistry = createWorkerStageRegistry({
    ingestion: { get: () => undefined },
    simulation: new SimulationStageHandler({
      reader: compute.reader,
      artifacts: compute.artifacts,
      operations: compute.registry,
      handlers: compute.handlers,
      runGuard: createSimulationRunGuard(runService),
    }),
  })
  const worker = new JobWorker({
    store: new PostgresJobStore(env.database),
    handlers: stageRegistry,
    budget: env.budget,
  })
  const processed = await worker.runOnce(scope.scopeRef, ctx)
  const finalRun = await runService.getRun(runId, ctx)
  const abandoned = await runService.listAbandonedAttempts(runId, ctx)
  const job = await jobService.getJob(scheduled.executionId, ctx)

  const observed = `cancelled=${cancelled.state} disposition=${processed.disposition} finalRun=${finalRun.state} abandoned=${String(abandoned.length)} jobStage=${job?.stage ?? 'missing'} quarantined=${String((job?.documentRef ?? '').includes('"quarantined":true'))}`
  const description = 'a simulation job completes after the run was cancelled'
  const expected = 'run stays cancelled, one abandoned attempt is recorded, the job result is quarantined'
  const passed =
    cancelled.state === 'cancelled' &&
    processed.disposition === 'stopped' &&
    finalRun.state === 'cancelled' &&
    abandoned.length === 1 &&
    job?.stage === 'awaiting_review' &&
    (job.documentRef ?? '').includes('"quarantined":true')
  if (passed) return ok('late-cancellation-result', description, expected, observed, 'the late result did not revive the run')
  return failed('late-cancellation-result', description, expected, observed, 'a late result changed the cancelled run')
}

// ---------------------------------------------------------------------------
// 6. Publication race — cancel between verification and publication
// ---------------------------------------------------------------------------

/** A real verifier wrapped so the test can cancel the run while verification is in flight. */
class BlockingVerifier implements AnswerVerifierPort {
  readonly #inner = new RestrictedAnswerVerifier()
  #entered: Promise<void>
  #markEntered: () => void = () => undefined
  #gate: Promise<void> | undefined
  #release: (() => void) | undefined

  constructor() {
    this.#entered = new Promise<void>((resolve) => {
      this.#markEntered = resolve
    })
  }

  entered(): Promise<void> {
    return this.#entered
  }

  block(): void {
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve
    })
  }

  release(): void {
    this.#release?.()
    this.#release = undefined
    this.#gate = undefined
  }

  async verify(request: VerifierRequest, ctx: ToolContext): Promise<VerificationResult> {
    this.#markEntered()
    if (this.#gate !== undefined) await this.#gate
    return this.#inner.verify(request, ctx)
  }
}

/** A publication validity double that always passes: this case exercises the run-state gate. */
class AlwaysPublishableValidity implements PublicationValidityPort {
  check(): Promise<PublicationValidityReport> {
    return Promise.resolve({ publishable: true, blockedReasons: [], historyLimited: false, details: [] })
  }
}

class LoadSelector implements RuntimeSelectorPort {
  constructor(private readonly adapter: RuntimeAdapter) {}
  select(): Promise<RuntimeAdapter> {
    return Promise.resolve(this.adapter)
  }
}

class LoadCapabilities implements RuntimeCapabilityFactoryPort {
  constructor(
    private readonly composition: ReturnType<typeof createToolGatewayComposition>,
    private readonly checkpoints: RuntimeCapabilitySet['checkpoints'],
  ) {}

  forRun(context: { readonly runId: Uuid; readonly budgetLedgerId: Uuid }): Promise<RuntimeCapabilitySet> {
    const binding: RunToolBinding = {
      runId: context.runId,
      ledgerId: context.budgetLedgerId,
      resolvedProfile: fullProfile(),
      operations: operationRegistry(),
    }
    return Promise.resolve({
      gateway: this.composition.forRun(binding),
      generation: forbiddenGeneration,
      decision: forbiddenDecision,
      checkpoints: this.checkpoints,
    })
  }
}

function raceplan(scopeRef: { readonly tenantId: string; readonly spaceId: string }): PlanSpec {
  return {
    planRef: { id: 'plan-load', version: '1.0.0', digest: sha256DigestOf('plan-load'), kind: 'plan' },
    steps: [
      {
        stepId: 'lookup',
        toolId: 'ontology_lookup',
        readOnly: true,
        args: [
          { name: 'scopeRef', required: true, source: { kind: 'literal', value: scopeRef } },
          { name: 'intent', required: true, source: { kind: 'literal', value: 'definitions' } },
        ],
        dependsOn: [],
        failureBehaviour: 'abort',
      },
    ],
  }
}

export async function publicationRace(env: LoadEnvironment): Promise<FaultCaseResult> {
  const scope = await createLoadScope(env, 'fault-race')
  const profile: ProfileRef = { id: 'load-harness-demo', version: '1.0.0' }
  await env.adminClient.query(
    `INSERT INTO agent_platform.profile_versions
       (tenant_id, space_id, profile_id, version, digest, environment, spec, created_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 'local_dev', '{}'::jsonb, now(), 'load-harness')
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.spaceId, profile.id, profile.version, DIGEST],
  )
  await env.adminClient.query(
    `INSERT INTO agent_platform.resolved_profiles
       (tenant_id, space_id, profile_id, version, snapshot_hash, output_version, output_digest,
        resolved_profile, checked_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $4, $5, '{}'::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.spaceId, profile.id, profile.version, DIGEST],
  )

  const runId = randomUUID()
  const ctx = loadContext(runId, scope.tenantId, scope.spaceId)
  const control = new ControlPostgresRepository(env.database)

  const composition = createToolGatewayComposition({
    database: env.database,
    blobStore: env.blobStore,
    budget: env.budget,
    validator: canonicalToolValidator(),
    handlers: [
      new RecordingHandler('ontology_lookup', {
        payload: {
          items: [{ kind: 'definition', ref: { id: 'backup', version: '1.0.0', digest: DIGEST }, label: 'backup' }],
          gaps: [],
          definitionVersion: { id: 'home-energy-definitions', version: '0.1.0', digest: DIGEST },
          autoPublished: false,
        },
        status: 'ok',
        coverage: { returned: 1, truncated: false },
        sources: [observation()],
      }),
    ],
  })
  const templateAdapter = new TemplateRuntimeAdapter({
    manifest: runtimeManifest(),
    plans: new StaticPlanResolver(publishedPlan(raceplan(scope.scopeRef))),
  })
  const runs = new RunService({ store: env.runStore, control, profiles: loadBinder })
  const phase = new RunPhaseDriver({ store: env.runStore, control })
  const manifests = new InMemoryWorkflowStore()
  const verifications = new InMemoryVerificationStore()
  const blocking = new BlockingVerifier()
  const publisher = new AnswerPublicationService({
    runs: env.runStore,
    answers: env.answerStore,
    verifications,
    manifests,
    validity: new AlwaysPublishableValidity(),
  })
  const controller = new WorkflowController({
    runs,
    phase,
    budget: env.budget,
    manifests,
    runtimes: new LoadSelector(templateAdapter),
    capabilities: new LoadCapabilities(composition, createRunCheckpointPort(env.runStore)),
    draftWriter: new RestrictedDraftWriter(),
    limited: new RestrictedLimitedAnswerComposer(),
    verifier: blocking,
    verifications,
    publisher,
    validity: new StaticInputValidity(),
  })

  blocking.block()
  const running = controller.startRun(
    {
      runId,
      profileRef: profile,
      question: 'compare tomorrow backup strategies',
      context: { timeZone: 'Asia/Shanghai', siteRef: 'site-demo-a' },
      preferences: { route: 'auto', allowWeb: false },
      idempotencyKey: `load-race-${runId}`,
    },
    ctx,
  )
  await blocking.entered()
  const run = await env.runStore.getRun(scope.scopeRef, runId, ctx)
  if (run === undefined) throw new Error('the race run disappeared')
  await controller.cancel({ runId, reason: 'user cancelled', expectedRevision: run.revision }, ctx)
  blocking.release()

  let rejected = false
  try {
    await running
  } catch (error) {
    rejected =
      error instanceof Error && 'code' in error && (error as { readonly code?: unknown }).code === 'PUBLICATION_REJECTED'
  }
  const answerRow = await env.adminClient.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM agent_platform.answer_publications
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3`,
    [scope.tenantId, scope.spaceId, runId],
  )
  const published = answerRow.rows[0]?.count ?? '0'
  const events = await env.adminClient.query<{ sse_type: string }>(
    `SELECT sse_type FROM agent_platform.run_events
      WHERE tenant_id = $1 AND space_id = $2 AND run_id = $3 ORDER BY sequence`,
    [scope.tenantId, scope.spaceId, runId],
  )
  const hasPublished = events.rows.some((row) => row.sse_type === 'answer.published')

  const observed = `rejected=${String(rejected)} answerRows=${published} answerPublishedEvent=${String(hasPublished)}`
  const description = 'the run is cancelled after verification but before the publication gate'
  const expected = 'PUBLICATION_REJECTED, no answer row and no answer.published event'
  const passed = rejected && published === '0' && !hasPublished
  if (passed) return ok('publication-race', description, expected, observed, 'the atomic publication gate blocked the cancelled run')
  return failed('publication-race', description, expected, observed, 'a cancelled run published an answer')
}
