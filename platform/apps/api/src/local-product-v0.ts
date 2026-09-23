import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject } from 'ajv'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, ControlPostgresRepository, PostgresAnswerStore, PostgresBudgetLedgerStore, PostgresRunStore, PostgresWorkflowStore } from '@ontology/adapter-control-postgres'
import { AnswerPublicationService, DraftVerificationService, RestrictedLimitedAnswerComposer, RunPhaseDriver, RunService, RunServiceError, WorkflowController, createRunCheckpointPort } from '@ontology/application'
import type { RunProfileBinding } from '@ontology/application'
import { SCHEMA_DOCUMENTS } from '@ontology/contracts'
import type { DecisionPort, GenerationPort, ProfileRef, ToolContext, VersionRef } from '@ontology/contracts'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import { ENERGY_OPERATION_REGISTRY, createEnergyComputeHandlers, decodeEnergyOperationInput } from '@ontology/extension-home-energy'
import { createEnergyComputeConfig, createScopedBlobReader } from './composition/energy-compute'
import { createEnergySimulationSurface } from './composition/energy-simulation'
import { createPostgresSimulationRecordStore } from './composition/postgres-energy-simulation-store'
import { createVirtualSolixExecutionSurface } from './composition/virtual-solix-execution'
import { recoverLegacyVirtualSolixState } from './composition/recover-virtual-solix-state'
import { INITIAL_BATTERY_ENERGY_KWH, BATTERY_CAPACITY_KWH, DEFAULT_SCENARIO_START_UTC } from './composition/home-energy-scenario'
import { createPostgresEnergyPlanVersionStore } from './composition/energy-plan-version-store'
import type { ExecutionSurface, VirtualBatteryStateView } from './composition/energy-simulation'
import { createLocalProductDeployment, LocalTaskContextError } from './composition/local-product-deployment'
import { createLocalStructuredProfiles } from './composition/registered-source-profiles'
import { createLocalTransportProfile } from './composition/registered-transport-profile'
import { createLocalOperatorSqlProfile, OPERATOR_SQL_SOURCE } from './composition/registered-operator-sql'
import { ensureOperatorFacilityDefinition } from './composition/operator-definition'
import { createLocalCandidateLifecycle } from './composition/local-candidate-lifecycle'
import { QueryTaskRuntime } from './composition/query-task-runtime'
import { RunTaskAssignments, RegisteredTaskDraftWriter } from './composition/query-tasks'
import { createBlobArtifactWriter, createToolGatewayComposition } from './composition/tool-gateway'
import { createApiServer } from './http/app'
import type { AuthenticatedRequest } from './http/server'
import { registerLocalDocumentImportRoute } from './http/local-documents'
import { readLocalPlanDetail, registerLocalPlanDetailRoute } from './http/local-plan-detail'
import { registerEnergyPlanVersionRoutes } from './http/energy-plan-versions'
import { EnergyPlanVersionError } from './composition/energy-plan-version-store'
import { registerLocalCandidateRoutes } from './http/local-candidates'
import { registerSimulationRoutes } from './http/simulations'
import { createRequestToolContext } from './http/context'
import { CapabilityNotConfiguredError } from './http/shared'

const runtimeRef: VersionRef = { id: 'runtime-registered-tasks', version: '1.0.0', digest: sha256DigestOf('runtime-registered-tasks@1.0.0') }
const policyRef: VersionRef = { id: 'policy-local-demo', version: '1.0.0', digest: sha256DigestOf('policy-local-demo@1.0.0') }
const industryRef: VersionRef = { id: 'local-profile-fixtures', version: '1.0.0', digest: sha256DigestOf('local-profile-fixtures@1.0.0') }
function sameResourceRef(left: import('@ontology/contracts').ResourceRef, right: import('@ontology/contracts').ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

function schemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: true })
  addFormats(ajv)
  for (const schema of SCHEMA_DOCUMENTS) ajv.addSchema(schema as SchemaObject)
  const issues = (validate: ReturnType<typeof ajv.compile>) => (validate.errors ?? []).map((error) => ({ pointer: error.instancePath, reason: error.message ?? 'invalid' }))
  return {
    validateRef(ref: string, value: unknown) { const validate = ajv.getSchema(ref); return validate === undefined ? { valid: false, issues: [{ pointer: '', reason: `unknown schema ${ref}` }] } : { valid: validate(value) === true, issues: issues(validate) } },
    validateInline(schema: unknown, value: unknown) { try { const validate = ajv.compile(schema as SchemaObject); return { valid: validate(value) === true, issues: issues(validate) } } catch { return { valid: false, issues: [{ pointer: '', reason: 'invalid inline schema' }] } } },
  }
}

class LocalEvidenceValidity {
  readonly #evidence: import('@ontology/adapter-control-postgres').PostgresEvidenceStore
  constructor(evidence: import('@ontology/adapter-control-postgres').PostgresEvidenceStore) { this.#evidence = evidence }
  async validate(entries: import('@ontology/contracts').WorkflowInputEntry[], ctx: ToolContext) {
    const staleEntries: { entryId: string; reason: string }[] = []
    for (const entry of entries) {
      if (entry.kind !== 'evidence' || entry.ref === undefined) continue
      const record = await this.#evidence.get({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, entry.ref.id, ctx)
      if (record === undefined || record.envelope.integrity.digest !== entry.ref.digest) staleEntries.push({ entryId: entry.entryId, reason: 'evidence is missing or has changed' })
    }
    return { valid: staleEntries.length === 0, staleEntries }
  }
}

export async function startRegisteredLocalProduct(): Promise<{ close(): Promise<void>; origin: string }> {
  const tenantId = process.env['ONTOLOGY_TENANT_ID'] ?? '10000000-0000-4000-8000-000000000001'
  const spaceId = process.env['ONTOLOGY_SPACE_ID'] ?? '20000000-0000-4000-8000-000000000001'
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) throw new Error('DATABASE_URL must point to the ontology_app PostgreSQL role; apply migrations first')
  const database = new ControlPostgresDatabase({ connectionString, maxPoolSize: 10 })
  await database.withIdentityScope({ tenantId, spaceId }, async (client) => {
    const initial = { energyKwh: INITIAL_BATTERY_ENERGY_KWH, socPercent: INITIAL_BATTERY_ENERGY_KWH / BATTERY_CAPACITY_KWH * 100, revision: 0, updatedAt: new Date().toISOString(), simulatedAt: DEFAULT_SCENARIO_START_UTC, mode: 'simulation', source: 'synthetic-default' }
    await client.query(`INSERT INTO agent_platform.virtual_solix_states (tenant_id,space_id,device_id,revision,state) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,'virtual-solix-1',0,$1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(initial)])
  })
  const planVersionStore = createPostgresEnergyPlanVersionStore(database)
  const control = new ControlPostgresRepository(database)
  const store = new PostgresRunStore(database)
  const workflowStore = new PostgresWorkflowStore(database)
  const budget = new BudgetService({ store: new PostgresBudgetLedgerStore(database), control })
  const root = resolve(process.env['ONTOLOGY_BLOB_DIR'] ?? '.local-data/blobs')
  await mkdir(dirname(root), { recursive: true })
  const objectStore = new FileSystemObjectStore(root)
  await objectStore.init()
  const registry = new PostgresArtifactRegistry({ connectionString, maxPoolSize: 4 })
  const blobs = new LocalImmutableBlobStore({ objectStore, registry })
  const artifacts = createBlobArtifactWriter(blobs)
  const getTrustedVirtualState = async (ctx: ToolContext): Promise<VirtualBatteryStateView> => {
    const row = await database.withIdentityScope({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, async (client) => {
      const result = await client.query<{ state: { energyKwh: number; socPercent: number; revision: number; updatedAt: string; simulatedAt?: string; stateRef?: import('@ontology/contracts').ResourceRef } }>(`SELECT state FROM agent_platform.virtual_solix_states WHERE device_id='virtual-solix-1'`)
      return result.rows[0]?.state
    }, { readOnly: true })
    let state = row ?? { energyKwh: INITIAL_BATTERY_ENERGY_KWH, socPercent: INITIAL_BATTERY_ENERGY_KWH / BATTERY_CAPACITY_KWH * 100, revision: 0, updatedAt: new Date().toISOString(), simulatedAt: DEFAULT_SCENARIO_START_UTC }
    if (state.revision > 0 && state.stateRef === undefined) state = await recoverLegacyVirtualSolixState({ database, blobs, artifacts, state, ctx })
    if (state.stateRef !== undefined) {
      const bytes = await blobs.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: state.stateRef }, ctx)
      const artifact = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
      if (artifact['energyKwh'] !== state.energyKwh || artifact['socPercent'] !== state.socPercent || artifact['revision'] !== state.revision || artifact['simulatedAt'] !== state.simulatedAt) throw new Error('Virtual SOLIX control state and immutable state artifact differ')
    } else if (state.revision !== 0) throw new Error('Virtual SOLIX state has no immutable read-back artifact')
    const parent = await planVersionStore.getSelected('virtual-solix-1', ctx)
    return { deviceId: 'virtual-solix-1', energyKwh: state.energyKwh, capacityKwh: BATTERY_CAPACITY_KWH, socPercent: state.socPercent, revision: state.revision, mode: 'simulation', updatedAt: state.updatedAt, simulatedAt: state.simulatedAt ?? DEFAULT_SCENARIO_START_UTC, ...(state.stateRef === undefined ? {} : { stateRef: state.stateRef }), ...(parent === undefined ? {} : { parentPlanRef: parent.planRef }) }
  }
  const validator = schemaValidator()
  const energy = await createLocalStructuredProfiles({ tenantId, spaceId, runtimeRef, policyRef, industryRef })
  const bootstrapContext = createRequestToolContext({ principal: { tenantId, subjectId: 'local-energy-state-bootstrap', roles: ['business-user'], scopes: ['tool:invoke'], authEpoch: 1 }, spaceId, runId: globalThis.crypto.randomUUID(), traceId: 'local-energy-state-bootstrap', allowedResourceKinds: ['artifact', 'evidence', 'plan'] })
  const bootstrapState = await getTrustedVirtualState(bootstrapContext)
  await energy.updateVirtualSoc(bootstrapState.socPercent, bootstrapState.updatedAt)
  const transport = await createLocalTransportProfile({ tenantId, spaceId, runtimeRef, policyRef, industryRef: { id: 'transport-government-local', version: '1.0.0', digest: sha256DigestOf('transport-government-local@1.0.0') } })
  const evidence = new (await import('@ontology/adapter-control-postgres')).PostgresEvidenceStore(database)
  const operatorSqlUrl = process.env['ONTOLOGY_OPERATOR_SQL_URL']
  let operatorDefinition: Awaited<ReturnType<typeof ensureOperatorFacilityDefinition>> | undefined
  let operatorSql: Awaited<ReturnType<typeof createLocalOperatorSqlProfile>> | undefined
  if (operatorSqlUrl !== undefined && operatorSqlUrl.trim().length > 0) {
    operatorDefinition = await ensureOperatorFacilityDefinition({ database, tenantId, spaceId })
    const principal = { tenantId, subjectId: 'local-product-bootstrap', roles: ['platform-admin'], scopes: ['tool:invoke'], authEpoch: 1 }
    const sqlContext = createRequestToolContext({
      principal, spaceId, runId: globalThis.crypto.randomUUID(), traceId: 'operator-sql-profile-bootstrap',
      allowedResourceKinds: ['artifact', 'dataset', 'evidence'], allowedSourceRefs: [OPERATOR_SQL_SOURCE], maxRows: 250,
    })
    operatorSql = await createLocalOperatorSqlProfile({
      connectionString: operatorSqlUrl,
      ...(process.env['ONTOLOGY_OPERATOR_SQL_SCHEMA'] === undefined ? {} : { schema: process.env['ONTOLOGY_OPERATOR_SQL_SCHEMA'] }),
      ...(process.env['ONTOLOGY_OPERATOR_SQL_RELATION'] === undefined ? {} : { relation: process.env['ONTOLOGY_OPERATOR_SQL_RELATION'] }),
      tenantId, spaceId, runtimeRef, policyRef, industryRef: operatorDefinition.ref, ctx: sqlContext,
    })
  }
  const deployment = await createLocalProductDeployment({ tenantId, spaceId, database, connectionString, blobs, artifacts, evidence, validator, compute: createEnergyComputeConfig({ blobStore: blobs, validator }), energy, getVirtualState: getTrustedVirtualState, transport, ...(operatorSql === undefined ? {} : { operatorSql }) })
  const previousVirtualState = await database.withIdentityScope({ tenantId, spaceId }, async (client) => {
    const result = await client.query<{ state: { socPercent?: number; updatedAt?: string; simulatedAt?: string } }>(`SELECT state FROM agent_platform.virtual_solix_states WHERE device_id='virtual-solix-1'`)
    return result.rows[0]?.state
  }, { readOnly: true })
  if (typeof previousVirtualState?.socPercent === 'number') await energy.updateVirtualSoc(previousVirtualState.socPercent, previousVirtualState.simulatedAt ?? DEFAULT_SCENARIO_START_UTC)
  const gateway = createToolGatewayComposition({ database, blobStore: blobs, budget, validator, handlers: deployment.handlers })
  const assignments = new RunTaskAssignments()
  const runtime = new QueryTaskRuntime(deployment.tasks, assignments)
  const candidateLifecycle = operatorSql === undefined || operatorDefinition === undefined
    ? undefined
    : createLocalCandidateLifecycle({ database, sql: operatorSql, documents: deployment.candidateDocuments, definition: operatorDefinition, budget })

  await database.withIdentityScope({ tenantId, spaceId }, async (client) => {
    for (const profile of deployment.profiles) {
      const id = profile.profileRef.id, hash = profile.resolvedProfile.snapshotHash
      const digest = sha256DigestOf(`${id}.profile-spec@1.0.0`)
      await client.query(`INSERT INTO agent_platform.profile_versions (tenant_id,space_id,profile_id,version,digest,environment,spec,created_at,created_by) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,'1.0.0',$2,'local_dev','{}'::jsonb,now(),'local-product') ON CONFLICT (tenant_id,space_id,profile_id,version) DO NOTHING`, [id, digest])
      await client.query(`INSERT INTO agent_platform.resolved_profiles (tenant_id,space_id,profile_id,version,snapshot_hash,output_version,output_digest,resolved_profile,checked_at,resolved_at) VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,'1.0.0',$2,'1.0.0',$2,$3::jsonb,now(),now()) ON CONFLICT (tenant_id,space_id,profile_id,version,snapshot_hash) DO NOTHING`, [id, hash, JSON.stringify(profile.resolvedProfile)])
    }
  })

  const runService = new RunService({ store, control, profiles: { bindProfileForRun: async (profileRef): Promise<RunProfileBinding> => {
    const selected = deployment.profileById.get(profileRef.id)
    if (selected === undefined || selected.profileRef.version !== profileRef.version) {
      if (profileRef.id === 'operator-sql-facilities' && candidateLifecycle === undefined) throw new RunServiceError('CAPABILITY_NOT_CONFIGURED', 'operator SQL source is not configured')
      throw new RunServiceError('INVALID_ARGUMENT', `unknown local profile ${profileRef.id}@${profileRef.version}`)
    }
    return { profileRef, resolvedProfileHash: selected.resolvedProfile.snapshotHash, resolvedProfileRef: { id: profileRef.id, version: profileRef.version, snapshotHash: selected.resolvedProfile.snapshotHash }, runtimeRef }
  } } })
  const phase = new RunPhaseDriver({ store, control })
  const controller = new WorkflowController({
    runs: runService, phase, budget, manifests: workflowStore,
    runtimes: { select: async (ref) => ref.id === runtime.manifest.id ? runtime : (() => { throw new Error('runtime not registered') })() },
    capabilities: { forRun: async (run) => {
      const selected = deployment.profileById.get(run.resolvedProfileRef.id)
      if (selected === undefined) throw new Error('the run profile is not registered in this deployment')
      const generation: GenerationPort = { async *generate() { throw new Error('no model is configured in the local deterministic deployment') } }
      const decision: DecisionPort = { decide: async () => { throw new Error('no decision model is configured in the local deterministic deployment') } }
      return { gateway: gateway.forRun({ runId: run.runId, ledgerId: run.budgetLedgerId, resolvedProfile: selected.resolvedProfile, operations: ENERGY_OPERATION_REGISTRY }), generation, decision, checkpoints: createRunCheckpointPort(store) }
    } },
    draftWriter: new RegisteredTaskDraftWriter(assignments), limited: new RestrictedLimitedAnswerComposer(),
    verifier: new DraftVerificationService({ evidence, artifacts: blobs, policy: { policyVersion: 'local-typed-assertions@1', templateVersion: 'restricted-explanations@1', semanticReview: 'disabled', onJevUnavailable: 'deterministic', decisionDefinitionVersion: '1.0.0', maxClaims: 12 } }),
    verifications: workflowStore,
    publisher: new AnswerPublicationService({ runs: store, answers: new PostgresAnswerStore(database), verifications: workflowStore, manifests: workflowStore, validity: { check: async (request, ctx) => {
      for (const ref of request.evidenceRefs) {
        const record = await evidence.get({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, ref.id, ctx)
        if (record === undefined || record.envelope.integrity.digest !== ref.digest || record.envelope.payloadRef === undefined) return { publishable: false, blockedReasons: ['evidence_unverifiable'], historyLimited: false, details: ['verified evidence is unavailable'] }
        try { if (!(await blobs.getAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: record.envelope.payloadRef }, ctx)).integrityVerified) return { publishable: false, blockedReasons: ['evidence_unverifiable'], historyLimited: false, details: ['evidence integrity verification failed'] } }
        catch { return { publishable: false, blockedReasons: ['evidence_unverifiable'], historyLimited: false, details: ['verified evidence is unavailable'] } }
      }
      return { publishable: true, blockedReasons: [], historyLimited: false, details: [] }
    } } }), validity: new LocalEvidenceValidity(evidence),
  })

  const operatorToken = process.env['ONTOLOGY_LOCAL_OPERATOR_TOKEN']
  const authenticate = (request: { headers: Record<string, string | string[] | undefined>; ip: string }): AuthenticatedRequest | undefined => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) return undefined
    const rawAuth = request.headers['authorization']
    const token = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth
    const operator = operatorToken !== undefined && token === `Bearer ${operatorToken}`
    return {
      principal: { tenantId, subjectId: operator ? 'local-operator' : 'local-business-user', roles: operator ? ['business-user', 'data-editor', 'semantic-reviewer', 'semantic-publisher'] : ['business-user'], scopes: ['tool:invoke'], authEpoch: 1 },
      spaceId, allowedDomains: [], allowedResourceKinds: ['artifact', 'dataset', 'document', 'evidence'],
      allowedSourceRefs: deployment.profiles.flatMap((profile) => profile.sourceRefs), allowedCollectionRefs: deployment.profiles.flatMap((profile) => profile.collectionRefs), maxRows: 100,
    }
  }
  const progress = {
    scopeForProfile: async (ref: ProfileRef, ctx: ToolContext) => {
      const selected = deployment.profileById.get(ref.id)
      if (selected === undefined || selected.profileRef.version !== ref.version) {
        if (ref.id === 'operator-sql-facilities' && candidateLifecycle === undefined) throw new CapabilityNotConfiguredError('configure ONTOLOGY_OPERATOR_SQL_URL with a read-only role and approved view to use the operator SQL profile')
        throw new RunServiceError('INVALID_ARGUMENT', `unknown local profile ${ref.id}@${ref.version}`)
      }
      const canImportDocuments = ctx.principal.roles.includes('data-editor') || ctx.principal.roles.includes('platform-admin')
      return { profileRef: ref, resolvedProfileHash: selected.resolvedProfile.snapshotHash, webSearchEnabled: false, toolIds: selected.resolvedProfile.toolBindings.filter((binding) => binding.enabled).map((binding) => binding.toolId), allowedDomains: [], explicitDegradations: selected.resolvedProfile.explicitDegradations.map((item) => ({ capability: item.capability, reason: item.reason, fallback: item.fallback })), tasks: deployment.tasks.list(ref), operatorActions: canImportDocuments ? deployment.operatorActions.get(ref.id) ?? [] : [] }
    },
    progressForRun: async (subject: { profileRef: ProfileRef }, ctx: ToolContext) => ({ scope: await progress.scopeForProfile(subject.profileRef, ctx) }),
  }
  const app = createApiServer({ authenticate, logger: process.env['ONTOLOGY_LOCAL_API_LOGGER'] === 'true', runs: {
    service: runService, workflow: controller, progress,
    prepareRunContext: async (profileRef, context) => {
      if (profileRef.id === 'operator-sql-facilities' && candidateLifecycle === undefined) throw new CapabilityNotConfiguredError('configure a server-side read-only SQL URL and approved view before creating runs with the operator SQL profile')
      try { return await deployment.prepareTaskContext(profileRef, context) }
      catch (error) {
        if (error instanceof LocalTaskContextError) throw new RunServiceError('INVALID_ARGUMENT', error.message)
        throw error
      }
    },
    resolveToolAccess: async (profileRef) => {
      const selected = deployment.profileById.get(profileRef.id)
      if (selected === undefined || selected.profileRef.version !== profileRef.version) throw new RunServiceError('INVALID_ARGUMENT', 'the selected profile is not registered')
      return { sourceRefs: selected.sourceRefs, resourceKinds: selected.resourceKinds, collectionRefs: selected.collectionRefs, maxRows: selected.maxRows }
    },
  }, ...(candidateLifecycle === undefined ? {} : {
    jobs: { service: candidateLifecycle.jobs },
    decisions: { service: candidateLifecycle.decisions, candidates: candidateLifecycle.candidates, documents: deployment.candidateDocuments.parseStore },
    publications: { service: candidateLifecycle.publications },
  }) })
  const energySimulations = createEnergySimulationSurface({
    blobStore: blobs, artifacts, reader: createScopedBlobReader(blobs),
    operations: ENERGY_OPERATION_REGISTRY, handlers: createEnergyComputeHandlers(),
    records: createPostgresSimulationRecordStore(database),
  })
  const virtualExecution = createVirtualSolixExecutionSurface({
    database, blobs, artifacts, requireSelectedPlanVersion: true,
    authorizePublishedPlan: async ({ runId, planRef, inputRefs, energyInput }, ctx) => {
      try {
        const run = await runService.getRun(runId, ctx)
        const registeredEnergyProfiles = new Set(['home-energy-demo-wide', 'home-energy-demo-long', 'home-energy-demo'])
        if (!registeredEnergyProfiles.has(run.profileRef.id) || run.context.taskId !== 'energy.plan-candidate' || run.state !== 'published') return false
        if (!deployment.tasks.list(run.profileRef).some((task) => task.taskId === 'energy.plan-candidate')) return false
        const taskInput = run.context.taskInput
        if (typeof taskInput !== 'object' || taskInput === null || Array.isArray(taskInput)) return false
        const task = taskInput as Record<string, unknown>
        const reserve = energyInput.reserves[0]?.reserveEnergyKwh ?? 0
        if (task['siteRef'] !== 'virtual-solix-1' || task['backupRequirementKwh'] !== reserve || task['reserveWindowStartSlot'] !== (energyInput.reserves[0]?.windowStartSlot ?? 0) || typeof task['weatherScenario'] !== 'string' || !energyInput.assumptions.includes(`weather_scenario=${task['weatherScenario']}`)) return false
        if (typeof task['scenarioRef'] !== 'string') return false
        const scenarioRef = JSON.parse(task['scenarioRef']) as import('@ontology/contracts').ResourceRef
        if (scenarioRef.kind !== 'artifact' || inputRefs.length !== 1 || !sameResourceRef(inputRefs[0]!, scenarioRef)) return false
        const selectedPlan = await planVersionStore.getSelected('virtual-solix-1', ctx)
        if (selectedPlan === undefined || !sameResourceRef(selectedPlan.planRef, planRef)) return false
        const answer = await controller.getAnswer(runId, ctx)
        if (answer === undefined || answer.answerId.length === 0) return false
        const claim = answer.claims.find((entry) => entry.predicate === 'candidate_total_cost')
        const evidenceRef = claim?.references[0]?.evidenceRef
        if (evidenceRef === undefined || claim?.references[0]?.resultDigest === undefined) return false
        const evidenceRecord = await evidence.get({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, evidenceRef.id, ctx)
        if (evidenceRecord === undefined || evidenceRecord.evidenceRef.digest !== evidenceRef.digest || evidenceRecord.envelope.resultDigest !== claim.references[0]?.resultDigest || evidenceRecord.envelope.payloadRef === undefined) return false
        const evidenceBlob = evidenceRecord.envelope.payloadRef
        if (!(await blobs.getAuthorized({ scopeRef: { tenantId, spaceId }, blobRef: evidenceBlob }, ctx)).integrityVerified) return false
        const payload = JSON.parse(new TextDecoder().decode(await blobs.readAuthorized({ scopeRef: { tenantId, spaceId }, blobRef: evidenceBlob }, ctx))) as Record<string, unknown>
        const computation = payload['computation'] as Record<string, unknown> | undefined
        const resultRef = computation?.['resultRef'] as import('@ontology/contracts').ResourceRef | undefined
        if (resultRef === undefined || resultRef.kind !== 'artifact' || !(await blobs.getAuthorized({ scopeRef: { tenantId, spaceId }, blobRef: resultRef }, ctx)).integrityVerified) return false
        const planner = JSON.parse(new TextDecoder().decode(await blobs.readAuthorized({ scopeRef: { tenantId, spaceId }, blobRef: resultRef }, ctx))) as Record<string, unknown>
        const selection = planner['selection'] as Record<string, unknown> | undefined
        const selected = selection?.['selectedPlanRef'] as import('@ontology/contracts').ResourceRef | undefined
        const snapshotRef = planner['snapshotRef'] as import('@ontology/contracts').ResourceRef | undefined
        if (planner['status'] !== 'feasible' || selected === undefined || !sameResourceRef(selected, planRef) || snapshotRef === undefined || !sameResourceRef(snapshotRef, energyInput.snapshot.snapshotRef)) return false
        const candidates = planner['candidates']
        if (!Array.isArray(candidates)) return false
        const candidate = candidates.find((entry) => typeof entry === 'object' && entry !== null && 'planRef' in entry && sameResourceRef((entry.planRef as import('@ontology/contracts').ResourceRef), planRef)) as { simulation?: { status?: string; reserveMargins?: readonly { reserveKwh: number }[] } } | undefined
        if (candidate?.simulation?.status !== 'feasible') return false
        const requestedReserves = energyInput.reserves.map((item) => item.reserveEnergyKwh).sort((a, b) => a - b)
        const plannedReserves = (candidate.simulation.reserveMargins ?? []).map((item) => item.reserveKwh).sort((a, b) => a - b)
        if (requestedReserves.length !== plannedReserves.length || requestedReserves.some((value, index) => value !== plannedReserves[index])) return false
        const predicates = new Set(answer.claims.map((entry) => entry.predicate))
        if (!['candidate_total_cost', 'baseline_total_cost', 'terminal_energy_kwh', 'reserve_satisfied'].every((predicate) => predicates.has(predicate))) return false
        return true
      } catch { return false }
    },
  })
  const energyExecution: ExecutionSurface = {
    async getVirtualState(ctx) {
      if (virtualExecution.getVirtualState === undefined) throw new Error('Virtual SOLIX state reader is missing')
      const [state, selected] = await Promise.all([virtualExecution.getVirtualState(ctx), planVersionStore.getSelected('virtual-solix-1', ctx)])
      return { ...state, ...(selected === undefined ? {} : { parentPlanRef: selected.planRef }) }
    },
    getExecution: (id, ctx) => virtualExecution.getExecution?.(id, ctx) ?? Promise.resolve(undefined),
    async requestExecution(request, ctx) {
      const record = await virtualExecution.requestExecution(request, ctx)
      const state = await energyExecution.getVirtualState!(ctx)
      await energy.updateVirtualSoc(state.socPercent, state.updatedAt)
      return record
    },
  }
  registerSimulationRoutes(app, { authenticate, service: energySimulations, execution: energyExecution })
  registerLocalDocumentImportRoute(app, { authenticate, documents: deployment.documents })
  registerLocalDocumentImportRoute(app, { authenticate, documents: deployment.candidateDocuments, path: '/api/v1/operator/candidate-documents' })
  if (candidateLifecycle !== undefined && operatorSql !== undefined) registerLocalCandidateRoutes(app, { authenticate, lifecycle: candidateLifecycle, documents: deployment.candidateDocuments, sql: operatorSql, tenantId, spaceId })
  registerLocalPlanDetailRoute(app, {
    authenticate, getAnswer: (runId, ctx) => controller.getAnswer(runId, ctx), evidence, blobs,
    getParentPlanRef: async (runId, ctx) => {
      const run = await runService.getRun(runId, ctx)
      const taskInput = run.context.taskInput
      if (typeof taskInput !== 'object' || taskInput === null || Array.isArray(taskInput) || typeof (taskInput as Record<string, unknown>)['parentPlanRef'] !== 'string') return undefined
      try { return JSON.parse((taskInput as Record<string, unknown>)['parentPlanRef'] as string) as import('@ontology/contracts').ResourceRef } catch { return undefined }
    },
  })
  registerEnergyPlanVersionRoutes(app, {
    authenticate, store: planVersionStore, getVirtualState: (ctx) => energyExecution.getVirtualState!(ctx),
    resolvePublishedPlan: async (runId, ctx) => {
      const run = await runService.getRun(runId, ctx)
      const energyProfileIds = new Set(['home-energy-demo-wide', 'home-energy-demo-long', 'home-energy-demo'])
      if (run.state !== 'published' || run.context.taskId !== 'energy.plan-candidate' || !energyProfileIds.has(run.profileRef.id)) throw new EnergyPlanVersionError('PLAN_NOT_AVAILABLE', 409, 'only a published energy plan run can be selected')
      const taskInput = run.context.taskInput
      if (typeof taskInput !== 'object' || taskInput === null || Array.isArray(taskInput) || typeof (taskInput as Record<string, unknown>)['scenarioRef'] !== 'string') throw new EnergyPlanVersionError('PLAN_NOT_AVAILABLE', 409, 'published energy run has no scenario artifact reference')
      const scenarioRef = JSON.parse((taskInput as Record<string, unknown>)['scenarioRef'] as string) as import('@ontology/contracts').ResourceRef
      const detail = await readLocalPlanDetail(runId, { getAnswer: (id, context) => controller.getAnswer(id, context), evidence, blobs }, ctx)
      const parentText = (taskInput as Record<string, unknown>)['parentPlanRef']
      let parentPlanRef: import('@ontology/contracts').ResourceRef | undefined
      if (parentText !== undefined) {
        if (typeof parentText !== 'string') throw new EnergyPlanVersionError('PLAN_PARENT_INVALID', 422, 'parent plan reference is malformed')
        try {
          const parsed = JSON.parse(parentText) as import('@ontology/contracts').ResourceRef
          if (parsed.kind !== 'plan' || typeof parsed.id !== 'string' || typeof parsed.version !== 'string' || typeof parsed.digest !== 'string') throw new Error('invalid plan ref')
          parentPlanRef = parsed
        } catch { throw new EnergyPlanVersionError('PLAN_PARENT_INVALID', 422, 'parent plan reference is malformed') }
      }
      const bytes = await blobs.readAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: scenarioRef }, ctx)
      const operationInput = decodeEnergyOperationInput(bytes)
      const task = taskInput as Record<string, unknown>
      const reserve = operationInput.reserves[0]?.reserveEnergyKwh ?? 0
      const initialEnergyKwh = operationInput.battery.initialEnergyKwh
      const capacityKwh = operationInput.battery.energyCapacityKwh
      const initialSocPercent = Number(initialEnergyKwh) / Number(capacityKwh) * 100
      if (task['siteRef'] !== 'virtual-solix-1' || task['backupRequirementKwh'] !== reserve || task['reserveWindowStartSlot'] !== (operationInput.reserves[0]?.windowStartSlot ?? 0) || task['weatherScenario'] !== operationInput.assumptions.find((item) => item.startsWith('weather_scenario='))?.slice('weather_scenario='.length) || detail.inputManifestHash !== operationInput.snapshot.digest || !Number.isFinite(initialEnergyKwh) || !Number.isFinite(capacityKwh) || Number(capacityKwh) <= 0 || !Number.isFinite(detail.initialEnergyKwh) || !Number.isFinite(detail.initialSocPercent) || Math.abs(detail.initialEnergyKwh - Number(initialEnergyKwh)) > 1e-6 || Math.abs(detail.initialSocPercent - initialSocPercent) > 0.01 || detail.stateRevision !== Number(operationInput.assumptions.find((item) => item.startsWith('state_revision='))?.slice('state_revision='.length) ?? 0)) throw new EnergyPlanVersionError('PLAN_EVIDENCE_MISMATCH', 409, 'published plan does not match its archived state/weather/reserve inputs')
      return { detail: { ...detail, ...(parentPlanRef === undefined ? {} : { parentPlanRef }) }, scenarioRef }
    },
  })
  await app.listen({ host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3000) })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : Number(process.env['PORT'] ?? 3000)
  return { origin: `http://127.0.0.1:${port}`, close: async () => { await app.close(); await deployment.close(); await registry.close(); await database.close() } }
}
