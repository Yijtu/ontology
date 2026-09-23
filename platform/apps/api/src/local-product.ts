import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { SchemaObject } from 'ajv'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, ControlPostgresRepository, PostgresAnswerStore, PostgresBudgetLedgerStore, PostgresEvidenceStore, PostgresRunStore, PostgresWorkflowStore } from '@ontology/adapter-control-postgres'
import { WorkflowController, RunPhaseDriver, RunService, AnswerPublicationService, DraftVerificationService, RestrictedLimitedAnswerComposer, createRunCheckpointPort } from '@ontology/application'
import type { RunProfileBinding } from '@ontology/application'
import { SCHEMA_DOCUMENTS } from '@ontology/contracts'
import type { AnswerDraft, DraftClaim, DecisionPort, GenerationPort, ResolvedProfile, ResourceRef, RuntimeAdapter, RuntimeDependencies, RuntimeEvent, RuntimeInput, ResumeInput, RuntimeCancelReceipt, SemanticQueryPlan, ToolContext, VersionRef } from '@ontology/contracts'
import { BudgetService, sha256DigestOf } from '@ontology/core'
import { ENERGY_OPERATION_REGISTRY, encodeEnergyOperationInput } from '@ontology/extension-home-energy'
import { DataQueryHandler } from '@ontology/tool-services'
import type { ToolSchemaValidator } from '@ontology/tool-services'
import { createApiServer } from './http/app'
import { registerLocalPlanDetailRoute } from './http/local-plan-detail'
import { createBlobArtifactWriter, createToolGatewayComposition } from './composition/tool-gateway'
import type { AuthenticatedRequest } from './http/server'
import { createLocalStructuredProfiles } from './composition/registered-source-profiles'
import { createEnergyComputeConfig } from './composition/energy-compute'
import { buildSyntheticScenarioInput } from './composition/home-energy-scenario'
import type { DraftWriterPort } from '@ontology/contracts'
import { answerDraftContentHash } from '@ontology/application'

const runtimeRef: VersionRef = { id: 'runtime-local-simulation', version: '1.0.0', digest: sha256DigestOf('runtime-local-simulation@1.0.0') }
const policyRef: VersionRef = { id: 'policy-local-demo', version: '1.0.0', digest: sha256DigestOf('policy-local-demo@1.0.0') }
const industryRef: VersionRef = { id: 'home-energy-preview', version: '0.1.0', digest: sha256DigestOf('home-energy-preview@0.1.0') }

function schemaValidator(): ToolSchemaValidator {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true, validateFormats: true })
  addFormats(ajv)
  for (const schema of SCHEMA_DOCUMENTS) ajv.addSchema(schema as SchemaObject)
  const issues = (validate: ReturnType<typeof ajv.compile>) => (validate.errors ?? []).map((error) => ({ pointer: error.instancePath, reason: error.message ?? 'invalid' }))
  return {
    validateRef(ref, value) {
      const validate = ajv.getSchema(ref)
      return validate === undefined ? { valid: false, issues: [{ pointer: '', reason: `unknown schema ${ref}` }] } : { valid: validate(value) === true, issues: issues(validate) }
    },
    validateInline(schema, value) {
      try { const validate = ajv.compile(schema as SchemaObject); return { valid: validate(value) === true, issues: issues(validate) } }
      catch (error) { return { valid: false, issues: [{ pointer: '', reason: error instanceof Error ? error.message : 'invalid inline schema' }] } }
    },
  }
}

function withEnergyCompute(base: ResolvedProfile): ResolvedProfile {
  const computeBindings = ENERGY_OPERATION_REGISTRY.operations.map((operation) => ({
    operationRef: operation.operationRef, handlerRef: operation.handlerRef,
    inputSchemaRef: { id: `${operation.operationRef.id}.input`, version: '1.0.0', digest: operation.inputSchemaDigest },
    outputSchemaRef: { id: `${operation.operationRef.id}.output`, version: '1.0.0', digest: operation.outputSchemaDigest },
    readOnly: true as const, enabled: true, limits: operation.limits,
  }))
  const snapshotHash = sha256DigestOf(`${base.snapshotHash}:${computeBindings.map((binding) => `${binding.operationRef.id}@${binding.operationRef.version}:${binding.inputSchemaRef.digest}`).join(',')}`)
  return { ...base, computeBindings, snapshotHash }
}

function eventBase(runId: string, sequence: number) { return { runId, eventId: randomUUID(), sequence, occurredAt: new Date().toISOString() } }

/** Local fixed-plan runtime: it invokes only the profile-registered compute operation through the real tool gateway. */
class LocalEnergyRuntime implements RuntimeAdapter {
  readonly manifest = { kind: 'runtime' as const, id: runtimeRef.id, version: runtimeRef.version, digest: runtimeRef.digest, contractRange: { min: '1.0.0' }, provides: [], requires: [], entrypointRef: { kind: 'package' as const, ref: '@ontology/app-api/local-product' }, trustStatus: 'local_dev' as const }
  readonly #inputs: Map<string, ResourceRef>
  readonly #plans: Map<string, SemanticQueryPlan>
  constructor(inputs: Map<string, ResourceRef>, plans: Map<string, SemanticQueryPlan>) { this.#inputs = inputs; this.#plans = plans }
  async *start(input: RuntimeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent> {
    const socIntent = /(?:\bSOC\b|荷电状态|电量百分比|剩余电量)/i.test(input.question)
    const planIntent = /(?:安排|制定|计划|调度|充放电|charge|discharge|plan)/i.test(input.question) && /(?:备电|储能|电池|光伏|电费|家庭能源|energy|battery)/i.test(input.question)
    if (!socIntent && !planIntent) {
      yield { type: 'failed', ...eventBase(input.runId, 1), error: { code: 'UNSUPPORTED_QUERY', message: '本地 profile 仅回答家庭储能计划与费用仿真问题', retryable: false } }
      return
    }
    const semanticPlan = this.#plans.get(input.runId)
    if (semanticPlan === undefined) { yield { type: 'failed', ...eventBase(input.runId, 1), error: { code: 'CAPABILITY_NOT_CONFIGURED', message: '所选 profile 没有注册 SOC 查询映射', retryable: false } }; return }
    const operation = ENERGY_OPERATION_REGISTRY.operations.find((item) => item.operationRef.id === 'home-energy.plan')
    if (operation === undefined) throw new Error('registered energy planning operation is missing')
    const syntheticInput = this.#inputs.get(input.runId)
    if (planIntent && syntheticInput === undefined) { yield { type: 'failed', ...eventBase(input.runId, 1), error: { code: 'INSUFFICIENT_DATA', message: '合成仿真输入未就绪', retryable: false } }; return }
    yield { type: 'step_started', ...eventBase(input.runId, 1), stepId: 'query-site-soc', toolId: 'data_query', attempt: 1 }
    const socResult = await deps.gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'query', mode: 'semantic', queryPlan: semanticPlan } }, deps.ctx)
    if (socResult.status === 'error' || socResult.status === 'empty' || socResult.evidenceRefs.length === 0) {
      yield { type: 'failed', ...eventBase(input.runId, 2), error: socResult.error ?? { code: 'INSUFFICIENT_DATA', message: '该站点没有可核验的 SOC 读数；未改用其他站点或默认值。', retryable: false } }; return
    }
    yield { type: 'evidence_added', ...eventBase(input.runId, 2), evidenceRefs: socResult.evidenceRefs }
    if (!planIntent) {
      yield { type: 'collection_complete', ...eventBase(input.runId, 3), draftAllowed: true, evidenceCount: socResult.evidenceRefs.length }
      return
    }
    yield { type: 'step_started', ...eventBase(input.runId, 3), stepId: 'simulate-home-energy', toolId: 'data_query', attempt: 1 }
    const result = await deps.gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: {
      kind: 'compute', operationRef: operation.operationRef, inputSchemaDigest: operation.inputSchemaDigest,
      inputRefs: [syntheticInput], parameters: { strategyWhitelist: ['self_consumption', 'reserve_first', 'price_window'] }, dataMode: 'simulation',
    } }, deps.ctx)
    if (result.status === 'error' || result.evidenceRefs.length === 0 || result.domainStatus !== 'known') {
      const code = result.error?.code ?? (result.domainStatus === 'conflict' ? 'DATA_CONFLICT' : 'INSUFFICIENT_DATA')
      const message = result.domainStatus === 'infeasible'
        ? '合成设备参数与备电约束下没有可行计划；没有发布普通答案。'
        : result.domainStatus === 'unknown'
          ? '仿真输入不足，无法确定候选计划。'
          : '仿真没有可核验来源。'
      yield { type: 'failed', ...eventBase(input.runId, 4), error: result.error ?? { code, message, retryable: false } }; return
    }
    yield { type: 'evidence_added', ...eventBase(input.runId, 4), evidenceRefs: result.evidenceRefs }
    yield { type: 'collection_complete', ...eventBase(input.runId, 5), draftAllowed: true, evidenceCount: socResult.evidenceRefs.length + result.evidenceRefs.length }
  }
  resume(input: ResumeInput, deps: RuntimeDependencies): AsyncIterable<RuntimeEvent> { void deps; return this.#resumeFailure(input.runId) }
  async *#resumeFailure(runId: string): AsyncIterable<RuntimeEvent> { yield { type: 'failed', ...eventBase(runId, 1), error: { code: 'CHECKPOINT_INCOMPATIBLE', message: 'local simulation runtime does not support checkpoint restore', retryable: false } } }
  cancel(runId: string, reason: string): Promise<RuntimeCancelReceipt> { void reason; return Promise.resolve({ runId, status: 'already_terminal', acceptedAt: new Date().toISOString(), abandonedAttempts: [] }) }
}

class EvidenceInputValidity {
  readonly #evidence: PostgresEvidenceStore
  constructor(evidence: PostgresEvidenceStore) { this.#evidence = evidence }
  async validate(entries: import('@ontology/contracts').WorkflowInputEntry[], ctx: ToolContext) {
    const staleEntries: { entryId: string; reason: string }[] = []
    for (const entry of entries) {
      if (entry.kind !== 'evidence' || entry.ref === undefined) continue
      const record = await this.#evidence.get({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, entry.ref.id, ctx)
      if (record === undefined || record.envelope.integrity.digest !== entry.ref.digest) staleEntries.push({ entryId: entry.entryId, reason: 'the referenced evidence is missing or has changed' })
    }
    return { valid: staleEntries.length === 0, staleEntries }
  }
}

function claimFromMetric(options: { evidenceRef: DraftClaim['references'][number]['evidenceRef']; resultDigest: string; key: string; value: number; unit: string; subject: string }): DraftClaim {
  return { claimId: randomUUID(), subject: options.subject, predicate: options.key, value: { value: options.value, unit: options.unit }, time: {}, kind: 'computation', references: [{ evidenceRef: options.evidenceRef, resultDigest: options.resultDigest, valuePointer: `/computation/metrics/${options.key}`, unitPointer: `/computation/metrics/units/${options.key}`, subjectPointer: '/computation/operationRef/id' }] }
}

class EnergyDraftWriter implements DraftWriterPort {
  readonly #evidence: PostgresEvidenceStore
  readonly #blobs: LocalImmutableBlobStore
  constructor(evidence: PostgresEvidenceStore, blobs: LocalImmutableBlobStore) { this.#evidence = evidence; this.#blobs = blobs }
  async writeDraft(request: Parameters<DraftWriterPort['writeDraft']>[0], ctx: ToolContext) {
    const entries = request.inputManifest.entries.filter((entry) => entry.kind === 'evidence' && entry.ref !== undefined)
    if (entries.length === 0) throw new Error('运行没有可引用证据')
    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const claims: DraftClaim[] = []
    for (const entry of entries) {
      const ref = entry.ref
      if (ref === undefined) continue
      const record = await this.#evidence.get(scope, ref.id, ctx)
      if (record?.envelope.payloadRef === undefined) throw new Error('evidence payload is unavailable')
      const bytes = await this.#blobs.readAuthorized({ scopeRef: scope, blobRef: record.envelope.payloadRef }, ctx)
      const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (typeof payload !== 'object' || payload === null) throw new Error('evidence payload is malformed')
      if ('table' in payload && typeof payload.table === 'object' && payload.table !== null && 'columns' in payload.table && Array.isArray(payload.table.columns) && 'rows' in payload.table && Array.isArray(payload.table.rows)) {
        const columns = payload.table.columns as { readonly name?: unknown; readonly unit?: unknown; readonly semanticFieldRef?: unknown }[]
        const rows = payload.table.rows as unknown[][]
        const siteIndex = columns.findIndex((column) => column.semanticFieldRef === 'site_ref' || column.name === 'site_ref')
        const valueIndex = columns.findIndex((column) => column.semanticFieldRef === 'soc_percent' || column.name === 'soc_percent')
        const row = rows[0]
        const subject = siteIndex < 0 ? undefined : row?.[siteIndex]
        const rawValue = valueIndex < 0 ? undefined : row?.[valueIndex]
        const value = typeof rawValue === 'number' ? rawValue : typeof rawValue === 'string' && /^\d+(?:\.\d+)?$/u.test(rawValue) ? Number(rawValue) : undefined
        const unit = valueIndex < 0 ? undefined : columns[valueIndex]?.unit
        if (typeof subject === 'string' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 && typeof unit === 'string' && row !== undefined) {
          const claimId = randomUUID()
          claims.push({
            claimId, subject, predicate: 'soc_percent', value: { value, unit }, time: {}, kind: 'observation',
            references: [{ evidenceRef: ref, resultDigest: record.envelope.resultDigest, valuePointer: `/table/rows/0/${String(valueIndex)}`, unitPointer: `/table/columns/${String(valueIndex)}/unit`, subjectPointer: `/table/rows/0/${String(siteIndex)}` }],
          })
        }
      }
      if ('computation' in payload && typeof payload.computation === 'object' && payload.computation !== null && 'metrics' in payload.computation && typeof payload.computation.metrics === 'object' && payload.computation.metrics !== null) {
        const data = payload.computation.metrics as Record<string, unknown>
        const cost = data['candidate_total_cost'], baseline = data['baseline_total_cost'], terminal = data['terminal_energy_kwh'], reserve = data['reserve_satisfied']
        if (typeof cost !== 'number' || typeof baseline !== 'number' || typeof terminal !== 'number' || typeof reserve !== 'number') throw new Error('仿真缺少可核验的计划指标')
        claims.push(
          claimFromMetric({ evidenceRef: ref, resultDigest: record.envelope.resultDigest, key: 'candidate_total_cost', value: cost, unit: 'CNY', subject: 'home-energy.plan' }),
          claimFromMetric({ evidenceRef: ref, resultDigest: record.envelope.resultDigest, key: 'baseline_total_cost', value: baseline, unit: 'CNY', subject: 'home-energy.plan' }),
          claimFromMetric({ evidenceRef: ref, resultDigest: record.envelope.resultDigest, key: 'terminal_energy_kwh', value: terminal, unit: 'kWh', subject: 'home-energy.plan' }),
          claimFromMetric({ evidenceRef: ref, resultDigest: record.envelope.resultDigest, key: 'reserve_satisfied', value: reserve, unit: 'boolean', subject: 'home-energy.plan' }),
        )
      }
    }
    if (!claims.some((claim) => claim.predicate === 'soc_percent')) throw new Error('运行意图需要 SOC 支撑，但运行证据中没有可核验的站点 SOC 聚合行')
    if (claims.length === 0) throw new Error('evidence did not contain a supported SOC reading or simulation summary')
    const blocks = claims.map((claim) => ({ kind: 'claim', claimId: claim.claimId }))
    const limitations = ['本地受控演示；DuckDB 来源为合成数据；SOC 查询使用 profile 指定的宽表或显式长表预处理映射。', ...(claims.some((claim) => claim.predicate === 'candidate_total_cost') ? ['计划仅为已测试候选，不是全局最优；不会连接或控制真实设备。完整 SOC 时间轨迹与逐时段动作明细 renderer 尚未交付。'] : [])]
    const draft: AnswerDraft = { draftId: randomUUID(), runId: request.runId, blocks, claims, evidenceManifestHash: request.inputManifest.digest, contentHash: answerDraftContentHash(request.runId, blocks, request.inputManifest.digest, claims), limitations, producedInPhase: 'drafting', createdAt: new Date().toISOString() }
    return { draft, evidenceRefs: entries.flatMap((entry) => entry.ref === undefined ? [] : [entry.ref]) }
  }
}

/** Assemble the local, loopback-only product slice on the durable PostgreSQL control store. */
export async function startLocalProduct(): Promise<{ close(): Promise<void>; origin: string }> {
  const tenantId = process.env['ONTOLOGY_TENANT_ID'] ?? '10000000-0000-4000-8000-000000000001'
  const spaceId = process.env['ONTOLOGY_SPACE_ID'] ?? '20000000-0000-4000-8000-000000000001'
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) throw new Error('DATABASE_URL must point to the ontology_app PostgreSQL role; apply migrations first')
  const database = new ControlPostgresDatabase({ connectionString, maxPoolSize: 10 })
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
  const validator = schemaValidator()
  const compute = createEnergyComputeConfig({ blobStore: blobs, validator })
  const sourceProfiles = await createLocalStructuredProfiles({ tenantId, spaceId, runtimeRef, policyRef, industryRef })
  const configuredProfiles = sourceProfiles.profiles.map((profile) => ({ ...profile, resolvedProfile: withEnergyCompute(profile.resolvedProfile) }))
  const wideProfile = configuredProfiles.find((profile) => profile.profileRef.id === 'home-energy-demo-wide')
  if (wideProfile === undefined) throw new Error('the wide synthetic profile was not registered')
  const profiles = [...configuredProfiles, { ...wideProfile, profileRef: { id: 'home-energy-demo', version: '1.0.0' } }]
  const profileById = new Map(profiles.map((profile) => [profile.profileRef.id, profile]))
  const query = new DataQueryHandler({ query: sourceProfiles.query, mappings: sourceProfiles.mappings, compute })
  const gateway = createToolGatewayComposition({ database, blobStore: blobs, budget, validator, handlers: [query] })
  const profileHash = (id: string) => profileById.get(id)?.resolvedProfile.snapshotHash ?? ''
  await database.withIdentityScope({ tenantId, spaceId }, async (client) => {
    for (const { profileRef, resolvedProfile } of profiles) {
      const id = profileRef.id
      const hash = resolvedProfile.snapshotHash
      const versionDigest = sha256DigestOf(`${id}.profile-spec@1.0.0`)
      await client.query(
        `INSERT INTO agent_platform.profile_versions
          (tenant_id,space_id,profile_id,version,digest,environment,spec,created_at,created_by)
         VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,'1.0.0',$2,'local_dev','{}'::jsonb,now(),'local-product')
         ON CONFLICT (tenant_id,space_id,profile_id,version) DO NOTHING`,
        [id, versionDigest],
      )
      await client.query(
        `INSERT INTO agent_platform.resolved_profiles
          (tenant_id,space_id,profile_id,version,snapshot_hash,output_version,output_digest,resolved_profile,checked_at,resolved_at)
         VALUES (current_setting('app.tenant_id')::uuid,current_setting('app.space_id')::uuid,$1,'1.0.0',$2,'1.0.0',$2,$3::jsonb,now(),now())
         ON CONFLICT (tenant_id,space_id,profile_id,version,snapshot_hash) DO NOTHING`,
        [id, hash, JSON.stringify(resolvedProfile)],
      )
    }
  })
  const runService = new RunService({ store, control, profiles: { bindProfileForRun: async (profileRef, scope, ctx): Promise<RunProfileBinding> => {
    void scope; void ctx
    const selected = profileById.get(profileRef.id)
    if (selected === undefined || profileRef.version !== selected.profileRef.version) throw new Error(`unknown local profile ${profileRef.id}@${profileRef.version}`)
    const snapshotHash = selected.resolvedProfile.snapshotHash
    return { profileRef, resolvedProfileHash: snapshotHash, resolvedProfileRef: { id: profileRef.id, version: profileRef.version, snapshotHash }, runtimeRef }
  } } })
  const phase = new RunPhaseDriver({ store, control })
  const inputs = new Map<string, ResourceRef>()
  const plans = new Map<string, SemanticQueryPlan>()
  const runtime = new LocalEnergyRuntime(inputs, plans)
  const controller = new WorkflowController({
    runs: runService, phase, budget, manifests: workflowStore, runtimes: { select: async (ref) => ref.id === runtimeRef.id ? runtime : (() => { throw new Error('runtime not registered') })() },
    capabilities: { forRun: async (run, ctx) => {
      const persisted = await store.getRun({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, run.runId, ctx)
      const requestedBackup = persisted?.context['backupRequirementKwh']
      const requestedWeather = persisted?.context['weatherScenario']
      const profileId = run.resolvedProfileRef.id
      const selected = profileById.get(profileId)
      if (selected === undefined) throw new Error(`no registered structured source profile for ${profileId}`)
      plans.set(run.runId, selected.planForSite(persisted?.context.siteRef ?? 'synthetic-home-1'))
      const planIntent = /(充放电|备电|电费|计划|调度|charge|discharge|backup|plan)/i.test(persisted?.question ?? '')
      if (planIntent) {
        if (typeof requestedBackup !== 'number' || !Number.isFinite(requestedBackup) || requestedBackup < 0 || requestedBackup > 50) throw new Error('备电保留量必须在 0 到 50 kWh 之间')
        if (requestedWeather !== 'sunny' && requestedWeather !== 'overcast' && requestedWeather !== 'storm') throw new Error('天气场景必须是 sunny、overcast 或 storm')
        const input = buildSyntheticScenarioInput({ backupRequirementKwh: requestedBackup, weatherScenario: requestedWeather })
        const stored = await artifacts.putBytes({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, content: encodeEnergyOperationInput(input), mediaType: 'application/vnd.ontology.energy-input-snapshot+json' }, ctx)
        inputs.set(run.runId, stored.blobRef)
      }
      const generation: GenerationPort = { async *generate() { throw new Error('the fixed local plan does not call a generation model') } }
      const decision: DecisionPort = { decide: async () => { throw new Error('decision model is not configured') } }
      return { gateway: gateway.forRun({ runId: run.runId, ledgerId: run.budgetLedgerId, resolvedProfile: selected.resolvedProfile, operations: ENERGY_OPERATION_REGISTRY }), generation, decision, checkpoints: createRunCheckpointPort(store) }
    } },
    draftWriter: new EnergyDraftWriter(gateway.evidence, blobs), limited: new RestrictedLimitedAnswerComposer(),
    verifier: new DraftVerificationService({ evidence: gateway.evidence, artifacts: blobs, policy: { policyVersion: 'local-energy-hard-checks@1', templateVersion: 'restricted-explanation-templates@1', semanticReview: 'disabled', onJevUnavailable: 'deterministic', decisionDefinitionVersion: '1.0.0', maxClaims: 8 } }),
    verifications: workflowStore,
    publisher: new AnswerPublicationService({ runs: store, answers: new PostgresAnswerStore(database), verifications: workflowStore, manifests: workflowStore, validity: { check: async (request, ctx) => {
      for (const ref of request.evidenceRefs) {
        const record = await gateway.evidence.get({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, ref.id, ctx)
        if (record === undefined || record.envelope.integrity.digest !== ref.digest || record.envelope.payloadRef === undefined) return { publishable: false, blockedReasons: ['evidence_unverifiable'], historyLimited: false, details: ['verified source evidence is no longer readable'] }
        try {
          const readable = await blobs.getAuthorized({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }, blobRef: record.envelope.payloadRef }, ctx)
          if (!readable.integrityVerified) return { publishable: false, blockedReasons: ['evidence_unverifiable'], historyLimited: false, details: ['evidence payload integrity could not be verified'] }
        } catch {
          return { publishable: false, blockedReasons: ['evidence_unverifiable'], historyLimited: false, details: ['evidence payload is unavailable in this scope'] }
        }
      }
      return { publishable: true, blockedReasons: [], historyLimited: false, details: [] }
    } } }),
    validity: new EvidenceInputValidity(gateway.evidence),
  })
  const tenant = tenantId, space = spaceId
  const authenticate = (request: { headers: Record<string, string | string[] | undefined>; ip: string }): AuthenticatedRequest | undefined => {
    const address = request.ip
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return undefined
    return { principal: { tenantId: tenant, subjectId: 'local-dev', roles: ['business-user'], scopes: ['tool:invoke'], authEpoch: 1 }, spaceId: space, allowedDomains: [], allowedResourceKinds: ['artifact', 'dataset', 'evidence'], allowedSourceRefs: [{ namespace: 'home-energy.synthetic', sourceId: 'ui-scenario' }, { namespace: 'home-energy', sourceId: 'compute' }], maxRows: 96 }
  }
  const progress = {
    scopeForProfile: async (ref: { id: string; version: string }) => {
      if (!profileById.has(ref.id) || ref.version !== '1.0.0') throw new Error(`unknown local profile ${ref.id}@${ref.version}`)
      return { profileRef: ref, resolvedProfileHash: profileHash(ref.id), webSearchEnabled: false, toolIds: ['data_query'] as const, allowedDomains: [], explicitDegradations: [] }
    },
    progressForRun: async (subject: { profileRef: { id: string; version: string } }) => ({ scope: { profileRef: subject.profileRef, resolvedProfileHash: profileHash(subject.profileRef.id), webSearchEnabled: false, toolIds: ['data_query'] as const, allowedDomains: [], explicitDegradations: [] } }),
  }
  const app = createApiServer({ authenticate, logger: true, runs: {
    service: runService, workflow: controller, progress,
    resolveToolAccess: async (profileRef) => {
      if (profileRef.version !== profileById.get(profileRef.id)?.profileRef.version) throw new Error(`unknown local profile ${profileRef.id}@${profileRef.version}`)
      const selected = profileById.get(profileRef.id)
      const sourceAccess = selected === undefined ? undefined : sourceProfiles.resolveToolAccess(selected.profileRef)
      if (sourceAccess === undefined) throw new Error(`the profile ${profileRef.id} has no registered source authorization`)
      return {
        sourceRefs: [
          ...sourceAccess.sourceRefs,
          { namespace: 'home-energy.synthetic', sourceId: 'ui-scenario' },
          { namespace: 'home-energy', sourceId: 'compute' },
        ],
        resourceKinds: ['artifact', 'dataset', 'evidence'],
        maxRows: Math.min(sourceAccess.maxRows, 96),
      }
    },
  } })
  registerLocalPlanDetailRoute(app, {
    authenticate,
    getAnswer: (runId, ctx) => controller.getAnswer(runId, ctx),
    evidence: gateway.evidence,
    blobs,
  })
  await app.listen({ host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3000) })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : Number(process.env['PORT'] ?? 3000)
  return { origin: `http://127.0.0.1:${port}`, close: async () => { await app.close(); sourceProfiles.close(); await registry.close(); await database.close() } }
}
