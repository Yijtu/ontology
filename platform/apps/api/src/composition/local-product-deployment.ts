import type { ProfileRef, ResolvedProfile, ResourceKind, SourceRef, VersionRef } from '@ontology/contracts'
import type { EvidenceStorePort, ImmutableArtifactWriter } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import { ENERGY_OPERATION_REGISTRY } from '@ontology/extension-home-energy'
import { InMemorySemanticMappingRegistry } from '@ontology/semantic-engine'
import type { SemanticMapping } from '@ontology/semantic-engine'
import { DataQueryHandler } from '@ontology/tool-services'
import type { DataQueryComputeConfig, ToolHandler } from '@ontology/tool-services'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import { ENERGY_OPERATION_INPUT_MEDIA_TYPE, decodeEnergyOperationInput, encodeEnergyOperationInput } from '@ontology/extension-home-energy'
import { buildSyntheticScenarioInput } from './home-energy-scenario'
import { createRequestToolContext } from '../http/context'
import type { LocalStructuredProfiles } from './registered-source-profiles'
import type { LocalTransportProfile } from './registered-transport-profile'
import type { LocalOperatorSqlProfile } from './registered-operator-sql'
import { OPERATOR_SQL_NAMESPACE } from './registered-operator-sql'
import { createPublishedOntologyCapability } from './published-ontology'
import { createLocalDocumentProfile, LOCAL_CANDIDATE_DOCUMENT_PROFILE } from './registered-document-profile'
import { LocalDocumentCapability } from './local-documents'
import { ProfileQueryPort, type RegisteredQueryPortBinding } from './profile-query-port'
import { QueryTaskRegistry, type OperatorActionDescriptor, type RegisteredQueryTask } from './query-tasks'
import { createHomeEnergyTasks } from '../scenarios/home-energy-tasks'
import { createTransportInspectionTask } from '../scenarios/transport-task'
import { createDocumentQuoteTask } from '../scenarios/document-quote-task'
import { createPublishedFactTask } from '../scenarios/published-fact-task'
import type { LocalDocumentImportResult } from './local-documents'

export interface ProductProfile {
  readonly profileRef: ProfileRef
  readonly resolvedProfile: ResolvedProfile
  readonly sourceRefs: readonly SourceRef[]
  readonly resourceKinds: readonly ResourceKind[]
  readonly collectionRefs: readonly string[]
  readonly maxRows: number
  readonly webSearchEnabled: false
}

export interface LocalProductDeployment {
  readonly profiles: readonly ProductProfile[]
  readonly profileById: ReadonlyMap<string, ProductProfile>
  readonly tasks: QueryTaskRegistry
  readonly query: ProfileQueryPort
  readonly handlers: readonly ToolHandler[]
  readonly documents: LocalDocumentCapability
  readonly candidateDocuments: LocalDocumentCapability
  readonly operatorActions: ReadonlyMap<string, readonly OperatorActionDescriptor[]>
  readonly operatorSql: LocalOperatorSqlProfile | undefined
  close(): Promise<void>
  prepareTaskContext(profileRef: ProfileRef, context: import('@ontology/contracts').CreateRunContext): Promise<import('@ontology/contracts').CreateRunContext>
  operatorImport(profileRef: ProfileRef, input: { readonly title: string; readonly content: string; readonly mediaType?: 'text/plain' | 'text/markdown' }, ctx: import('@ontology/contracts').ToolContext): Promise<LocalDocumentImportResult>
}

/** An operator-supplied task/scenario input failed preflight; backend read failures stay unexpected. */
export class LocalTaskContextError extends Error {
  constructor(message: string) { super(message); this.name = 'LocalTaskContextError' }
}

function versionProfile(profile: ResolvedProfile, tasks: readonly RegisteredQueryTask[]): ResolvedProfile {
  const refs = tasks.map((task) => task.descriptor.taskRef).sort((left, right) => left.id.localeCompare(right.id))
  const snapshotHash = sha256DigestOf(`${profile.snapshotHash}:${refs.map((ref) => `${ref.id}@${ref.version}:${ref.digest}`).join('|')}`)
  return { ...profile, snapshotHash, resolvedVersions: [...profile.resolvedVersions, ...refs] }
}

function profileRecord(profileRef: ProfileRef, resolvedProfile: ResolvedProfile, sourceRefs: readonly SourceRef[], resourceKinds: readonly ResourceKind[], collectionRefs: readonly string[], maxRows: number): ProductProfile {
  return { profileRef, resolvedProfile, sourceRefs, resourceKinds, collectionRefs, maxRows, webSearchEnabled: false }
}

export async function createLocalProductDeployment(input: {
  readonly tenantId: string
  readonly spaceId: string
  readonly database: ControlPostgresDatabase
  readonly connectionString: string
  readonly blobs: LocalImmutableBlobStore
  readonly artifacts: ImmutableArtifactWriter
  readonly evidence: EvidenceStorePort
  readonly validator: import('@ontology/tool-services').ToolSchemaValidator
  readonly compute: DataQueryComputeConfig
  readonly energy: LocalStructuredProfiles
  readonly getVirtualState: (ctx: import('@ontology/contracts').ToolContext) => Promise<import('./energy-simulation').VirtualBatteryStateView>
  readonly transport: LocalTransportProfile
  readonly operatorSql?: LocalOperatorSqlProfile
}): Promise<LocalProductDeployment> {
  const documents = new LocalDocumentCapability({ connectionString: input.connectionString, blobs: input.blobs })
  const candidateDocuments = new LocalDocumentCapability({
    connectionString: input.connectionString, blobs: input.blobs,
    collectionRef: 'local-candidate-records', sourceRef: { namespace: 'local-operator-documents', sourceId: 'uploaded-native-records' },
  })
  const wide = input.energy.profiles.find((profile) => profile.profileRef.id === 'home-energy-demo-wide')
  if (wide === undefined) throw new Error('the wide energy source profile is not registered')
  const energySourceProfiles = [...input.energy.profiles, { ...wide, profileRef: { id: 'home-energy-demo', version: wide.profileRef.version } }]
  const energyTasks = createHomeEnergyTasks({ profiles: energySourceProfiles, artifacts: input.artifacts, evidence: input.evidence, blobStore: input.blobs, getVirtualState: input.getVirtualState })
  const transportTask = createTransportInspectionTask({ source: input.transport, evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobs })
  const operatorSqlTask = input.operatorSql === undefined ? undefined : createTransportInspectionTask({ source: input.operatorSql, evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobs })
  const ontology = input.operatorSql === undefined ? undefined : createPublishedOntologyCapability({
    database: input.database, namespace: OPERATOR_SQL_NAMESPACE,
    definitionRef: input.operatorSql.resolvedProfile.industryRef, allowedConceptIds: ['road_facility'],
  })
  const publishedFactTask = input.operatorSql === undefined ? undefined : createPublishedFactTask({
    profileRef: input.operatorSql.profileRef, namespace: OPERATOR_SQL_NAMESPACE, conceptId: 'road_facility',
    definitionRef: input.operatorSql.resolvedProfile.industryRef,
    attributes: [
      { id: 'facility_key', kind: 'string' }, { id: 'facility_name', kind: 'string' },
      { id: 'district', kind: 'string' }, { id: 'inspection_state', kind: 'enum' },
    ],
    evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobs,
  })
  const documentProfile = createLocalDocumentProfile({
    runtimeRef: input.energy.profiles[0]?.resolvedProfile.runtimeRef ?? input.transport.resolvedProfile.runtimeRef,
    policyRef: input.energy.profiles[0]?.resolvedProfile.policyRef ?? input.transport.resolvedProfile.policyRef,
    tenantId: input.tenantId,
    spaceId: input.spaceId,
  })
  const documentTask = createDocumentQuoteTask({ profileRef: documentProfile.profileRef, documents, evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobs })
  const tasks = new QueryTaskRegistry([...energyTasks, transportTask, ...(operatorSqlTask === undefined ? [] : [operatorSqlTask]), ...(publishedFactTask === undefined ? [] : [publishedFactTask]), documentTask])

  const profiles: ProductProfile[] = []
  for (const profile of input.energy.profiles) {
    const registered = energyTasks.filter((task) => task.profileRef.id === profile.profileRef.id)
    const resolvedProfile = versionProfile({ ...profile.resolvedProfile, computeBindings: ENERGY_OPERATION_REGISTRY.operations.map((operation) => ({
      operationRef: operation.operationRef, handlerRef: operation.handlerRef,
      inputSchemaRef: { id: `${operation.operationRef.id}.input`, version: '1.0.0', digest: operation.inputSchemaDigest },
      outputSchemaRef: { id: `${operation.operationRef.id}.output`, version: '1.0.0', digest: operation.outputSchemaDigest },
      readOnly: true as const, enabled: true, limits: operation.limits,
    })) }, registered)
    profiles.push(profileRecord(profile.profileRef, resolvedProfile, profile.sourceRefs, ['artifact', 'dataset', 'evidence'], [], Math.min(profile.maxRows, 100)))
  }
  const legacyAliasTasks = energyTasks.filter((task) => task.profileRef.id === 'home-energy-demo')
  const aliasedWide = profiles.find((profile) => profile.profileRef.id === 'home-energy-demo-wide')
  if (aliasedWide !== undefined && legacyAliasTasks.length > 0) {
    profiles.push(profileRecord({ id: 'home-energy-demo', version: aliasedWide.profileRef.version }, versionProfile(aliasedWide.resolvedProfile, legacyAliasTasks), aliasedWide.sourceRefs, aliasedWide.resourceKinds, aliasedWide.collectionRefs, aliasedWide.maxRows))
  }
  const transportTasks = [transportTask]
  profiles.push(profileRecord(input.transport.profileRef, versionProfile(input.transport.resolvedProfile, transportTasks), input.transport.sourceRefs, ['artifact', 'dataset', 'evidence'], [], 100))
  if (input.operatorSql !== undefined && operatorSqlTask !== undefined && publishedFactTask !== undefined && ontology !== undefined) {
    const resolvedProfile: ResolvedProfile = {
      ...input.operatorSql.resolvedProfile,
      toolBindings: [...input.operatorSql.resolvedProfile.toolBindings, { toolId: 'ontology_lookup', enabled: true, maxCallsPerRun: 2 }],
      snapshotHash: sha256DigestOf(`${input.operatorSql.resolvedProfile.snapshotHash}:${ontology.sourceRef.namespace}:${ontology.sourceRef.sourceId}`),
    }
    profiles.push(profileRecord(input.operatorSql.profileRef, versionProfile(resolvedProfile, [operatorSqlTask, publishedFactTask]), [...input.operatorSql.sourceRefs, ontology.sourceRef], ['artifact', 'dataset', 'evidence'], [], input.operatorSql.maxRows))
  }
  const documentTasks = [documentTask]
  profiles.push(profileRecord(documentProfile.profileRef, versionProfile(documentProfile.resolvedProfile, documentTasks), [documentProfile.sourceRef], ['artifact', 'document', 'evidence'], [documentProfile.collectionRef], 10))
  const candidateDocumentProfile = createLocalDocumentProfile({
    runtimeRef: documentProfile.resolvedProfile.runtimeRef, policyRef: documentProfile.resolvedProfile.policyRef,
    tenantId: input.tenantId, spaceId: input.spaceId, profileRef: LOCAL_CANDIDATE_DOCUMENT_PROFILE,
    sourceRef: { namespace: 'local-operator-documents', sourceId: 'uploaded-native-records' }, collectionRef: 'local-candidate-records', enableSearch: false,
  })
  profiles.push(profileRecord(candidateDocumentProfile.profileRef, versionProfile(candidateDocumentProfile.resolvedProfile, []), [candidateDocumentProfile.sourceRef], ['artifact', 'document', 'evidence'], [candidateDocumentProfile.collectionRef], 10))
  const profileById = new Map(profiles.map((profile) => [profile.profileRef.id, profile]))

  const allMappings: SemanticMapping[] = [...input.energy.mappings.list(), ...input.transport.mappings.list(), ...(input.operatorSql?.mappings.list() ?? [])]
  const mappings = new InMemorySemanticMappingRegistry(allMappings)
  const mappingObjects = (refs: readonly VersionRef[]) => refs.flatMap((ref) => mappings.resolve(ref)?.objects.map((object) => object.sourceObjectRef) ?? [])
  const queryBindings: RegisteredQueryPortBinding[] = [
    {
      adapter: input.energy.query,
      mappingRefs: input.energy.profiles.flatMap((profile) => profile.resolvedProfile.mappingRefs),
      objects: input.energy.profiles.flatMap((profile) => mappingObjects(profile.resolvedProfile.mappingRefs)),
    },
    { adapter: input.transport.query, mappingRefs: input.transport.resolvedProfile.mappingRefs, objects: mappingObjects(input.transport.resolvedProfile.mappingRefs) },
    ...(input.operatorSql === undefined ? [] : [{ adapter: input.operatorSql.query, mappingRefs: input.operatorSql.resolvedProfile.mappingRefs, objects: mappingObjects(input.operatorSql.resolvedProfile.mappingRefs) }]),
  ]
  const query = new ProfileQueryPort(queryBindings, mappings)
  const dataQuery = new DataQueryHandler({ query, mappings, compute: input.compute })
  const handlers = [dataQuery, documents.searchHandler, ...(ontology === undefined ? [] : [ontology.handler])]
  const documentImportAction: OperatorActionDescriptor = {
    actionId: 'documents.import-markdown', label: '导入一份受控政策文档', method: 'POST', path: '/api/v1/operator/documents',
    fields: [
      { name: 'title', label: '文档标题', kind: 'text', required: true, maxLength: 200 },
      { name: 'content', label: 'Markdown/文本正文', kind: 'text', control: 'textarea', required: true, maxLength: 256 * 1024 },
      { name: 'mediaType', label: '内容类型', kind: 'enum', required: true, options: ['text/markdown', 'text/plain'], defaultValue: 'text/markdown' },
    ],
  }
  const candidateDocumentImportAction: OperatorActionDescriptor = { ...documentImportAction, actionId: 'documents.import-candidate-records', label: '导入一份受控候选记录 JSON 文档', path: '/api/v1/operator/candidate-documents' }
  const operatorActions = new Map<string, readonly OperatorActionDescriptor[]>([[documentProfile.profileRef.id, [documentImportAction]], [candidateDocumentProfile.profileRef.id, [candidateDocumentImportAction]]])
  return {
    profiles, profileById, tasks, query, handlers, documents, candidateDocuments, operatorActions, operatorSql: input.operatorSql,
    async prepareTaskContext(profileRef, context) {
      let prepared
      try { prepared = tasks.prepareRunContext(profileRef, context) }
      catch { throw new LocalTaskContextError('taskId and taskInput must match a registered task in the selected profile') }
      if (context.taskId !== 'energy.plan-candidate') return prepared
      const registered = tasks.resolve(profileRef, 'energy.plan-candidate')
      if (registered === undefined) throw new LocalTaskContextError('energy plan task is not registered for this profile')
      const taskInput = { ...(prepared.taskInput ?? {}) } as Record<string, unknown>
      const principal = { tenantId: input.tenantId, subjectId: 'local-energy-scenario-preflight', roles: ['business-user'], scopes: ['tool:invoke'], authEpoch: 1 }
      const stateContext = createRequestToolContext({ principal, spaceId: input.spaceId, runId: globalThis.crypto.randomUUID(), traceId: 'energy-scenario-preflight', allowedResourceKinds: ['artifact', 'dataset', 'evidence', 'plan'], allowedSourceRefs: profiles.flatMap((profile) => profile.sourceRefs), maxRows: 100 })
      const state = await input.getVirtualState(stateContext)
      const backup = taskInput['backupRequirementKwh']
      const reserveWindowStartSlot = taskInput['reserveWindowStartSlot'] ?? 0
      const weather = taskInput['weatherScenario']
      if (typeof backup !== 'number' || typeof reserveWindowStartSlot !== 'number' || typeof weather !== 'string') throw new LocalTaskContextError('energy plan task is missing reserve window or weather inputs')
      taskInput['reserveWindowStartSlot'] = reserveWindowStartSlot
      if (taskInput['siteRef'] === undefined) taskInput['siteRef'] = 'virtual-solix-1'
      let scenarioInput: ReturnType<typeof buildSyntheticScenarioInput>
      if (typeof taskInput['scenarioRef'] !== 'string' || taskInput['scenarioRef'].trim().length === 0) {
        scenarioInput = buildSyntheticScenarioInput({ backupRequirementKwh: backup, reserveWindowStartSlot, weatherScenario: weather as import('./home-energy-scenario').WeatherScenario }, state)
        const stored = await input.artifacts.putBytes({ scopeRef: { tenantId: input.tenantId, spaceId: input.spaceId }, content: encodeEnergyOperationInput(scenarioInput), mediaType: ENERGY_OPERATION_INPUT_MEDIA_TYPE }, stateContext)
        taskInput['scenarioRef'] = JSON.stringify(stored.blobRef)
      } else {
        if (typeof taskInput['scenarioRef'] !== 'string') throw new LocalTaskContextError('scenarioRef must be an immutable resource reference')
        try {
          const ref = JSON.parse(taskInput['scenarioRef']) as import('@ontology/contracts').ResourceRef
          if (ref.kind !== 'artifact') throw new Error('bad kind')
          scenarioInput = decodeEnergyOperationInput(await input.blobs.readAuthorized({ scopeRef: { tenantId: input.tenantId, spaceId: input.spaceId }, blobRef: ref }, stateContext))
        } catch { throw new LocalTaskContextError('scenarioRef is unavailable or invalid in this tenant and space') }
      }
      const scenarioRevision = Number(scenarioInput.assumptions.find((item) => item.startsWith('state_revision='))?.slice('state_revision='.length) ?? 'NaN')
      const stateRefText = scenarioInput.assumptions.find((item) => item.startsWith('state_ref='))?.slice('state_ref='.length)
      let stateRefDigest: string | undefined
      if (stateRefText !== undefined) {
        try {
          const ref: unknown = JSON.parse(stateRefText)
          if (typeof ref !== 'object' || ref === null || !('digest' in ref) || typeof ref.digest !== 'string') throw new Error('invalid state ref')
          stateRefDigest = ref.digest
        } catch { throw new LocalTaskContextError('scenarioRef carries an invalid state reference') }
      }
      if (scenarioRevision !== state.revision || scenarioInput.battery.initialEnergyKwh !== state.energyKwh || scenarioInput.reserves[0]?.reserveEnergyKwh !== backup || (scenarioInput.reserves[0]?.windowStartSlot ?? 0) !== reserveWindowStartSlot || !scenarioInput.assumptions.includes(`weather_scenario=${weather}`) || stateRefDigest !== state.stateRef?.digest) throw new LocalTaskContextError('scenarioRef is stale or does not match the current Virtual SOLIX state, ReserveSOC window, and weather')
      if (state.parentPlanRef === undefined) delete taskInput['parentPlanRef']
      else taskInput['parentPlanRef'] = JSON.stringify(state.parentPlanRef)
      const taskInputDigest = sha256DigestOf(JSON.stringify(
        registered.descriptor.fields
          .map((field) => [field.name, taskInput[field.name] ?? null] as const)
          .sort(([left], [right]) => left.localeCompare(right)),
      ))
      return { ...prepared, taskInput, taskInputDigest }
    },
    async operatorImport(profileRef, payload, ctx) {
      if (profileRef.id !== documentProfile.profileRef.id || profileRef.version !== documentProfile.profileRef.version) throw new Error('document import is not enabled in the selected profile')
      return documents.importMarkdown(payload, ctx)
    },
    async close() { await Promise.all([documents.close(), candidateDocuments.close(), input.transport.close(), ...(input.operatorSql === undefined ? [] : [input.operatorSql.close()])]); input.energy.close() },
  }
}
