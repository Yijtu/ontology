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
import type { LocalStructuredProfiles } from './registered-source-profiles'
import type { LocalTransportProfile } from './registered-transport-profile'
import type { LocalOperatorSqlProfile } from './registered-operator-sql'
import { createLocalDocumentProfile, LOCAL_CANDIDATE_DOCUMENT_PROFILE } from './registered-document-profile'
import { LocalDocumentCapability } from './local-documents'
import { ProfileQueryPort, type RegisteredQueryPortBinding } from './profile-query-port'
import { QueryTaskRegistry, type OperatorActionDescriptor, type RegisteredQueryTask } from './query-tasks'
import { createHomeEnergyTasks } from '../scenarios/home-energy-tasks'
import { createTransportInspectionTask } from '../scenarios/transport-task'
import { createDocumentQuoteTask } from '../scenarios/document-quote-task'
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
  prepareTaskContext(profileRef: ProfileRef, context: import('@ontology/contracts').CreateRunContext): import('@ontology/contracts').CreateRunContext
  operatorImport(profileRef: ProfileRef, input: { readonly title: string; readonly content: string; readonly mediaType?: 'text/plain' | 'text/markdown' }, ctx: import('@ontology/contracts').ToolContext): Promise<LocalDocumentImportResult>
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
  const energyTasks = createHomeEnergyTasks({ profiles: energySourceProfiles, artifacts: input.artifacts, evidence: input.evidence, blobStore: input.blobs })
  const transportTask = createTransportInspectionTask({ source: input.transport, evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobs })
  const operatorSqlTask = input.operatorSql === undefined ? undefined : createTransportInspectionTask({ source: input.operatorSql, evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobs })
  const documentProfile = createLocalDocumentProfile({
    runtimeRef: input.energy.profiles[0]?.resolvedProfile.runtimeRef ?? input.transport.resolvedProfile.runtimeRef,
    policyRef: input.energy.profiles[0]?.resolvedProfile.policyRef ?? input.transport.resolvedProfile.policyRef,
    tenantId: input.tenantId,
    spaceId: input.spaceId,
  })
  const documentTask = createDocumentQuoteTask({ profileRef: documentProfile.profileRef, documents, evidence: input.evidence, artifacts: input.artifacts, blobStore: input.blobs })
  const tasks = new QueryTaskRegistry([...energyTasks, transportTask, ...(operatorSqlTask === undefined ? [] : [operatorSqlTask]), documentTask])

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
  if (input.operatorSql !== undefined && operatorSqlTask !== undefined) {
    profiles.push(profileRecord(input.operatorSql.profileRef, versionProfile(input.operatorSql.resolvedProfile, [operatorSqlTask]), input.operatorSql.sourceRefs, ['artifact', 'dataset', 'evidence'], [], input.operatorSql.maxRows))
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
  const handlers = [dataQuery, documents.searchHandler]
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
    prepareTaskContext(profileRef, context) { return tasks.prepareRunContext(profileRef, context) },
    async operatorImport(profileRef, payload, ctx) {
      if (profileRef.id !== documentProfile.profileRef.id || profileRef.version !== documentProfile.profileRef.version) throw new Error('document import is not enabled in the selected profile')
      return documents.importMarkdown(payload, ctx)
    },
    async close() { await Promise.all([documents.close(), candidateDocuments.close(), input.transport.close(), ...(input.operatorSql === undefined ? [] : [input.operatorSql.close()])]); input.energy.close() },
  }
}
