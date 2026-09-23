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
import { ENERGY_OPERATION_REGISTRY } from '@ontology/extension-home-energy'
import { createEnergyComputeConfig } from './composition/energy-compute'
import { createLocalProductDeployment } from './composition/local-product-deployment'
import { createLocalStructuredProfiles } from './composition/registered-source-profiles'
import { createLocalTransportProfile } from './composition/registered-transport-profile'
import { QueryTaskRuntime } from './composition/query-task-runtime'
import { RunTaskAssignments, RegisteredTaskDraftWriter } from './composition/query-tasks'
import { createBlobArtifactWriter, createToolGatewayComposition } from './composition/tool-gateway'
import { createApiServer } from './http/app'
import type { AuthenticatedRequest } from './http/server'
import { registerLocalDocumentImportRoute } from './http/local-documents'
import { registerLocalPlanDetailRoute } from './http/local-plan-detail'

const runtimeRef: VersionRef = { id: 'runtime-registered-tasks', version: '1.0.0', digest: sha256DigestOf('runtime-registered-tasks@1.0.0') }
const policyRef: VersionRef = { id: 'policy-local-demo', version: '1.0.0', digest: sha256DigestOf('policy-local-demo@1.0.0') }
const industryRef: VersionRef = { id: 'local-profile-fixtures', version: '1.0.0', digest: sha256DigestOf('local-profile-fixtures@1.0.0') }

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
  const energy = await createLocalStructuredProfiles({ tenantId, spaceId, runtimeRef, policyRef, industryRef })
  const transport = await createLocalTransportProfile({ tenantId, spaceId, runtimeRef, policyRef, industryRef: { id: 'transport-government-local', version: '1.0.0', digest: sha256DigestOf('transport-government-local@1.0.0') } })
  const evidence = new (await import('@ontology/adapter-control-postgres')).PostgresEvidenceStore(database)
  const deployment = await createLocalProductDeployment({ tenantId, spaceId, database, connectionString, blobs, artifacts, evidence, validator, compute: createEnergyComputeConfig({ blobStore: blobs, validator }), energy, transport })
  const gateway = createToolGatewayComposition({ database, blobStore: blobs, budget, validator, handlers: deployment.handlers })
  const assignments = new RunTaskAssignments()
  const runtime = new QueryTaskRuntime(deployment.tasks, assignments)

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
    if (selected === undefined || selected.profileRef.version !== profileRef.version) throw new Error(`unknown local profile ${profileRef.id}@${profileRef.version}`)
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
      principal: { tenantId, subjectId: operator ? 'local-operator' : 'local-business-user', roles: operator ? ['business-user', 'data-editor'] : ['business-user'], scopes: ['tool:invoke'], authEpoch: 1 },
      spaceId, allowedDomains: [], allowedResourceKinds: ['artifact', 'dataset', 'document', 'evidence'],
      allowedSourceRefs: deployment.profiles.flatMap((profile) => profile.sourceRefs), allowedCollectionRefs: deployment.profiles.flatMap((profile) => profile.collectionRefs), maxRows: 100,
    }
  }
  const progress = {
    scopeForProfile: async (ref: ProfileRef, ctx: ToolContext) => {
      const selected = deployment.profileById.get(ref.id)
      if (selected === undefined || selected.profileRef.version !== ref.version) throw new Error(`unknown local profile ${ref.id}@${ref.version}`)
      const canImportDocuments = ctx.principal.roles.includes('data-editor') || ctx.principal.roles.includes('platform-admin')
      return { profileRef: ref, resolvedProfileHash: selected.resolvedProfile.snapshotHash, webSearchEnabled: false, toolIds: selected.resolvedProfile.toolBindings.filter((binding) => binding.enabled).map((binding) => binding.toolId), allowedDomains: [], explicitDegradations: selected.resolvedProfile.explicitDegradations.map((item) => ({ capability: item.capability, reason: item.reason, fallback: item.fallback })), tasks: deployment.tasks.list(ref), operatorActions: canImportDocuments ? deployment.operatorActions.get(ref.id) ?? [] : [] }
    },
    progressForRun: async (subject: { profileRef: ProfileRef }, ctx: ToolContext) => ({ scope: await progress.scopeForProfile(subject.profileRef, ctx) }),
  }
  const app = createApiServer({ authenticate, logger: true, runs: {
    service: runService, workflow: controller, progress,
    prepareRunContext: async (profileRef, context) => {
      try { return deployment.prepareTaskContext(profileRef, context) }
      catch { throw new RunServiceError('INVALID_ARGUMENT', 'taskId and taskInput must match a registered task in the selected profile') }
    },
    resolveToolAccess: async (profileRef) => {
      const selected = deployment.profileById.get(profileRef.id)
      if (selected === undefined || selected.profileRef.version !== profileRef.version) throw new Error('unknown local profile')
      return { sourceRefs: selected.sourceRefs, resourceKinds: selected.resourceKinds, collectionRefs: selected.collectionRefs, maxRows: selected.maxRows }
    },
  } })
  registerLocalDocumentImportRoute(app, { authenticate, documents: deployment.documents })
  registerLocalPlanDetailRoute(app, { authenticate, getAnswer: (runId, ctx) => controller.getAnswer(runId, ctx), evidence, blobs })
  await app.listen({ host: '127.0.0.1', port: Number(process.env['PORT'] ?? 3000) })
  const address = app.server.address()
  const port = typeof address === 'object' && address !== null ? address.port : Number(process.env['PORT'] ?? 3000)
  return { origin: `http://127.0.0.1:${port}`, close: async () => { await app.close(); await deployment.close(); await registry.close(); await database.close() } }
}
