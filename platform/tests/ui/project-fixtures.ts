import { createHash, randomUUID } from 'node:crypto'
import { createApiServer } from '@ontology/app-api'
import type { AuthenticatedRequest, ProjectDocumentService } from '@ontology/app-api'
import {
  InMemoryIndustryPackCatalogue,
  InMemoryJobStore,
  InMemoryProjectReadinessStore,
  JobService,
  ProjectDataMaterializationService,
  ProjectMappingService,
  ProjectService,
} from '@ontology/application'
import { InMemoryStructuredIngestionStore, StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import {
  ProjectReadinessStoreError,
  ProjectStoreError,
  createToolContext,
  isToolContext,
} from '@ontology/contracts'
import type {
  AppendProjectRecordResult,
  AppendProjectRevisionInput,
  CreateProjectInput as StoreCreateProjectInput,
  CreateProjectInput,
  FieldConfirmationEventRecord,
  ImportMappingVersion,
  IndustryPackCatalogue,
  IndustrySchema,
  IndustrySchemaSource,
  InsertMappingResult,
  NewProjectRecordVersion,
  PackAsset,
  ProjectDatasetQueryPort,
  ProjectDatasetQueryRequest,
  ProjectDatasetQueryResult,
  ProjectDatasetRef,
  ProjectDatasetSnapshot,
  ProjectDatasetStageInput,
  ProjectDatasetStageResult,
  ProjectDatasetWriterPort,
  ProjectDocumentIndexStatus,
  ProjectListFilter,
  ProjectMappingStore,
  ProjectMappingWriteMeta,
  ProjectReadinessStore,
  ProjectRecord,
  ProjectRecordPage,
  ProjectRecordQuery,
  ProjectRecordStore,
  ProjectRecordVersion,
  ProjectRevision,
  ProjectStore,
  ProjectWriteResult,
  ResourceKind,
  ResourceRef,
  ScopeRef,
  ScopedArtifactReader,
  ScopedArtifactReaderRequest,
  StructuredParseRecord,
  StructuredRecordEntry,
  ToolContext,
  ToolCoverage,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { WorkbenchClient } from '@ontology/app-web/client'

/**
 * Test-only harness for the public project workspace (V03-020). It wires the real merged
 * `ProjectService` / `ProjectMappingService` / `ProjectDataMaterializationService` onto in-memory
 * stores and a real Fastify host, so the browser E2E drives the actual HTTP surface — project
 * create/list, pack mount, mapping preview/confirm, record binding/paging, readiness and dataset
 * status — rather than a hand-written fake. The structured parser is the real adapter parser over
 * the immutable original, so a mapping preview/confirm reads true lexical values and locators.
 */

export const PROJECT_SCOPE: ScopeRef = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  spaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
}

export const PROJECT_ALL_ROLES =
  'platform-admin,profile-editor,data-editor,semantic-reviewer,business-user,scoped-reader'

export const PROJECT_FIXTURE = {
  packId: 'demo.bridge-pack',
  packVersion: '1.0.0',
  packV2Version: '1.1.0',
  csv: 'name,capacity_kwh,status\n桥架A,12.5,active\n桥架B,3,retired\n桥架C,8.25,active\n桥架D,7.5,active\n',
  parseId: 'aaaaaaaa-0000-4000-8000-000000000001',
  documentId: 'aaaaaaaa-0000-4000-8000-000000000002',
  originalId: 'aaaaaaaa-0000-4000-8000-000000000003',
  parseRefId: 'aaaaaaaa-0000-4000-8000-000000000004',
} as const

const DEFINITION_REF: VersionRef = {
  id: 'demo.bridge-pack-definition',
  version: '1.0.0',
  digest: `sha256:${'d'.repeat(64)}`,
}

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function digestOfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function digestOfText(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

function resourceRef(id: string, digest: string, kind: ResourceKind = 'artifact'): ResourceRef {
  return { id, version: '1.0.0', digest, kind }
}

function packAsset(version: string, seed: string, definitionSeed: string): PackAsset {
  const ref: VersionRef = { id: PROJECT_FIXTURE.packId, version, digest: sha(seed) }
  return {
    ref,
    manifest: {
      namespace: 'demo.bridge-pack',
      maturity: 'stable',
      standardProvenance: [
        { standardRef: { id: 'standard', version: '1.0.0', digest: sha('b') }, provenanceKind: 'industry_standard' },
      ],
      definitionsRef: { id: 'demo.bridge-pack-definition', version, digest: sha(definitionSeed) },
      identityPolicyRef: { id: 'demo.identity', version: '1.0.0', digest: sha('c') },
      rulePolicyRef: { id: 'demo.rule', version: '1.0.0', digest: sha('e') },
      queryTemplatesRef: { id: 'demo.query', version: '1.0.0', digest: sha('f') },
      requiredCapabilities: [{ name: 'structured_query', versionRange: { min: '0.2.0' } }],
      testSuiteRef: { id: 'demo.suite', version: '1.0.0', digest: sha('g') },
    },
    testSuite: { ref: { id: 'demo.suite', version: '1.0.0', digest: sha('g') }, cases: [] },
  }
}

function industrySchema(): IndustrySchema {
  return {
    namespace: 'demo.bridge-pack',
    definitionRef: DEFINITION_REF,
    objects: [
      {
        objectId: 'device',
        displayName: '设备',
        identityScopeId: 'device-scope',
        attributes: [
          { attributeId: 'name', valueType: 'string', minCardinality: 1, maxCardinality: 1, identityKey: true },
          { attributeId: 'capacity', valueType: 'quantity', minCardinality: 0, maxCardinality: 1, identityKey: false, unitCode: 'kWh', dimension: 'energy' },
          { attributeId: 'status', valueType: 'enum', minCardinality: 0, maxCardinality: 1, identityKey: false, enumValues: ['active', 'retired'] },
        ],
      },
    ],
    relations: [],
    identityScopes: [{ identityScopeId: 'device-scope', objectId: 'device', scopeDimensions: [], identityAttributeIds: ['name'] }],
  }
}

interface StoredMappingReplay {
  readonly requestDigest: string
  readonly mapping: ImportMappingVersion
}

class InMemoryProjectMappingStore implements ProjectMappingStore {
  readonly #mappings = new Map<string, ImportMappingVersion[]>()
  readonly #idempotency = new Map<string, StoredMappingReplay>()

  #trust(scopeRef: ScopeRef, ctx: ToolContext): void {
    if (!isToolContext(ctx)) throw new ProjectStoreError('SCOPE_MISMATCH', 'trusted context required')
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ProjectStoreError('SCOPE_MISMATCH', 'scope mismatch')
    }
  }

  #key(scopeRef: ScopeRef, projectId: Uuid): string {
    return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000${projectId}`
  }

  async insertMapping(
    scopeRef: ScopeRef,
    mapping: ImportMappingVersion,
    meta: ProjectMappingWriteMeta,
    ctx: ToolContext,
  ): Promise<InsertMappingResult> {
    this.#trust(scopeRef, ctx)
    const idemKey = `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000${meta.idempotencyKey}`
    const replay = this.#idempotency.get(idemKey)
    if (replay !== undefined) {
      if (replay.requestDigest !== meta.requestDigest) {
        throw new ProjectStoreError('IDEMPOTENCY_CONFLICT', 'idempotency payload changed')
      }
      return { mapping: structuredClone(replay.mapping), created: false }
    }
    const key = this.#key(scopeRef, mapping.projectId)
    const list = this.#mappings.get(key) ?? []
    list.push(structuredClone(mapping))
    this.#mappings.set(key, list)
    this.#idempotency.set(idemKey, { requestDigest: meta.requestDigest, mapping: structuredClone(mapping) })
    return { mapping: structuredClone(mapping), created: true }
  }

  async getMapping(
    scopeRef: ScopeRef,
    projectId: Uuid,
    mappingId: Uuid,
    version: string,
    ctx: ToolContext,
  ): Promise<ImportMappingVersion | undefined> {
    this.#trust(scopeRef, ctx)
    const found = (this.#mappings.get(this.#key(scopeRef, projectId)) ?? []).find(
      (mapping) => mapping.mappingId === mappingId && mapping.version === version,
    )
    return found === undefined ? undefined : structuredClone(found)
  }

  async listMappings(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<ImportMappingVersion[]> {
    this.#trust(scopeRef, ctx)
    return (this.#mappings.get(this.#key(scopeRef, projectId)) ?? []).map((mapping) => structuredClone(mapping))
  }

  async latestVersion(scopeRef: ScopeRef, projectId: Uuid, mappingId: Uuid, ctx: ToolContext): Promise<string | undefined> {
    this.#trust(scopeRef, ctx)
    const versions = (this.#mappings.get(this.#key(scopeRef, projectId)) ?? [])
      .filter((mapping) => mapping.mappingId === mappingId)
      .map((mapping) => mapping.version)
    if (versions.length === 0) return undefined
    return versions.sort((left, right) => {
      const [la = '0', lb = '0', lc = '0'] = left.split('.')
      const [ra = '0', rb = '0', rc = '0'] = right.split('.')
      return Number(la) - Number(ra) || Number(lb) - Number(rb) || Number(lc) - Number(rc)
    })[versions.length - 1]
  }
}

class InMemoryProjectRecordStore implements ProjectRecordStore {
  readonly #records = new Map<string, ProjectRecordVersion[]>()

  #trust(scopeRef: ScopeRef, ctx: ToolContext): void {
    if (!isToolContext(ctx)) throw new ProjectStoreError('SCOPE_MISMATCH', 'trusted context required')
    if (scopeRef.tenantId !== ctx.principal.tenantId || scopeRef.spaceId !== ctx.allowedResources.spaceId) {
      throw new ProjectStoreError('SCOPE_MISMATCH', 'scope mismatch')
    }
  }

  #key(scopeRef: ScopeRef, projectId: Uuid): string {
    return `${scopeRef.tenantId}\u0000${scopeRef.spaceId}\u0000${projectId}`
  }

  async appendRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    records: readonly NewProjectRecordVersion[],
    meta: ProjectMappingWriteMeta,
    ctx: ToolContext,
  ): Promise<AppendProjectRecordResult> {
    this.#trust(scopeRef, ctx)
    void meta
    const key = this.#key(scopeRef, projectId)
    const stored = this.#records.get(key) ?? []
    const results: ProjectRecordVersion[] = []
    let created = false
    for (const next of records) {
      const prior = stored.find(
        (record) => record.recordId === next.recordId && record.contentDigest === next.contentDigest,
      )
      if (prior !== undefined) {
        results.push(prior)
        continue
      }
      const revision = String(stored.filter((record) => record.recordId === next.recordId).length + 1)
      const body: ProjectRecordVersion = { ...next, revision }
      stored.push(body)
      results.push(body)
      created = true
    }
    this.#records.set(key, stored)
    return { records: structuredClone(results), created }
  }

  async listRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    query: ProjectRecordQuery,
    ctx: ToolContext,
  ): Promise<ProjectRecordPage> {
    this.#trust(scopeRef, ctx)
    const all = [...(this.#records.get(this.#key(scopeRef, projectId)) ?? [])]
      .filter((record) => query.objectId === undefined || record.objectId === query.objectId)
      .filter((record) => query.status === undefined || record.status === query.status)
      .sort((left, right) => (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0))
    const after = query.cursor === undefined ? -1 : Number.parseInt(query.cursor, 10)
    const remaining = all.filter((_, index) => index > after)
    const limit = query.limit ?? 100
    const slice = remaining.slice(0, limit)
    const lastIndex = after + slice.length
    const nextCursor = remaining.length > limit ? String(lastIndex) : undefined
    return {
      records: structuredClone(slice),
      total: all.length,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  }

  async getRecord(
    scopeRef: ScopeRef,
    projectId: Uuid,
    recordId: Uuid,
    ctx: ToolContext,
  ): Promise<ProjectRecordVersion | undefined> {
    this.#trust(scopeRef, ctx)
    const found = (this.#records.get(this.#key(scopeRef, projectId)) ?? []).find((record) => record.recordId === recordId)
    return found === undefined ? undefined : structuredClone(found)
  }
}

/** The in-memory ProjectStore from the V03-016 unit suite, kept scope/CAS-faithful. */
export class InMemoryProjectStore implements ProjectStore {
  readonly #projects = new Map<string, ProjectRecord>()
  readonly #revisions = new Map<string, ProjectRevision[]>()
  readonly #createKeys = new Map<string, { digest: string; ref: string }>()
  readonly #appendKeys = new Map<string, { digest: string; ref: string }>()

  #scope(ref: ScopeRef): string {
    return `${ref.tenantId}\u0000${ref.spaceId}`
  }

  #projectKey(ref: ScopeRef, projectId: Uuid): string {
    return `${this.#scope(ref)}\u0000${projectId}`
  }

  #assertTrusted(ref: ScopeRef, ctx: ToolContext): void {
    if (!isToolContext(ctx)) throw new ProjectStoreError('SCOPE_MISMATCH', 'trusted context required')
    if (ref.tenantId !== ctx.principal.tenantId || ref.spaceId !== ctx.allowedResources.spaceId) {
      throw new ProjectStoreError('SCOPE_MISMATCH', 'scope mismatch')
    }
  }

  async createProject(
    input: StoreCreateProjectInput,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<ProjectWriteResult> {
    this.#assertTrusted(scopeRef, ctx)
    const key = `${this.#scope(scopeRef)}\u0000${input.idempotencyKey}`
    const replay = this.#createKeys.get(key)
    if (replay !== undefined) {
      if (replay.digest !== input.requestDigest) {
        throw new ProjectStoreError('IDEMPOTENCY_CONFLICT', 'idempotency payload changed')
      }
      const existing = this.#projects.get(replay.ref)
      const revision = this.#revisions.get(replay.ref)?.[0]
      if (existing === undefined || revision === undefined) throw new ProjectStoreError('PROJECT_NOT_FOUND', 'missing')
      return { project: structuredClone(existing), revision: structuredClone(revision), created: false }
    }
    const projectKey = this.#projectKey(scopeRef, input.projectId)
    const project: ProjectRecord = {
      projectId: input.projectId,
      title: input.title,
      headRevision: '1',
      state: input.state ?? 'draft',
      createdBy: input.actor,
      createdAt: input.recordedAt,
      updatedAt: input.recordedAt,
    }
    this.#projects.set(projectKey, project)
    this.#revisions.set(projectKey, [structuredClone(input.firstRevision)])
    this.#createKeys.set(key, { digest: input.requestDigest, ref: projectKey })
    return { project: structuredClone(project), revision: structuredClone(input.firstRevision), created: true }
  }

  async getProject(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<ProjectRecord | undefined> {
    this.#assertTrusted(scopeRef, ctx)
    const project = this.#projects.get(this.#projectKey(scopeRef, projectId))
    return project === undefined ? undefined : structuredClone(project)
  }

  async listProjects(scopeRef: ScopeRef, filter: ProjectListFilter, ctx: ToolContext): Promise<ProjectRecord[]> {
    this.#assertTrusted(scopeRef, ctx)
    const prefix = `${this.#scope(scopeRef)}\u0000`
    return [...this.#projects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, project]) => project)
      .filter((project) => filter.state === undefined || project.state === filter.state)
      .map((project) => structuredClone(project))
  }

  async getRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    revision: string,
    ctx: ToolContext,
  ): Promise<ProjectRevision | undefined> {
    this.#assertTrusted(scopeRef, ctx)
    const found = (this.#revisions.get(this.#projectKey(scopeRef, projectId)) ?? []).find(
      (entry) => entry.ref.revision === revision,
    )
    return found === undefined ? undefined : structuredClone(found)
  }

  async listRevisions(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<ProjectRevision[]> {
    this.#assertTrusted(scopeRef, ctx)
    return (this.#revisions.get(this.#projectKey(scopeRef, projectId)) ?? []).map((entry) => structuredClone(entry))
  }

  async appendRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    input: AppendProjectRevisionInput,
    ctx: ToolContext,
  ): Promise<ProjectWriteResult> {
    this.#assertTrusted(scopeRef, ctx)
    const key = `${this.#scope(scopeRef)}\u0000${input.idempotencyKey}`
    const replay = this.#appendKeys.get(key)
    if (replay !== undefined) {
      if (replay.digest !== input.requestDigest) {
        throw new ProjectStoreError('IDEMPOTENCY_CONFLICT', 'idempotency payload changed')
      }
      const project = this.#projects.get(replay.ref)
      const revision = this.#revisions.get(replay.ref)?.find((entry) => entry.ref.revision === input.revision.ref.revision)
      if (project === undefined || revision === undefined) throw new ProjectStoreError('REVISION_NOT_FOUND', 'missing')
      return { project: structuredClone(project), revision: structuredClone(revision), created: false }
    }
    const projectKey = this.#projectKey(scopeRef, projectId)
    const project = this.#projects.get(projectKey)
    if (project === undefined) throw new ProjectStoreError('PROJECT_NOT_FOUND', 'project missing')
    if (project.headRevision !== input.expectedRevision) {
      throw new ProjectStoreError('VERSION_CONFLICT', 'stale expected revision')
    }
    const next = (BigInt(project.headRevision) + 1n).toString()
    if (input.revision.ref.revision !== next) throw new ProjectStoreError('INVALID_REVISION', `expected ${next}`)
    const updated: ProjectRecord = { ...project, headRevision: next, updatedAt: input.recordedAt }
    this.#projects.set(projectKey, updated)
    const revisions = this.#revisions.get(projectKey) ?? []
    revisions.push(structuredClone(input.revision))
    this.#revisions.set(projectKey, revisions)
    this.#appendKeys.set(key, { digest: input.requestDigest, ref: projectKey })
    return { project: structuredClone(updated), revision: structuredClone(input.revision), created: true }
  }

  async appendFieldConfirmation(): Promise<FieldConfirmationEventRecord> {
    throw new Error('field confirmations are out of scope for the project workspace harness')
  }

  async listFieldConfirmations(): Promise<FieldConfirmationEventRecord[]> {
    return []
  }
}

class InMemoryIndustrySchemaSource implements IndustrySchemaSource {
  readonly #schemas = new Map<string, IndustrySchema>()

  register(schema: IndustrySchema): void {
    this.#schemas.set(`${schema.definitionRef.id}@${schema.definitionRef.version}`, structuredClone(schema))
  }

  async getSchema(_scopeRef: ScopeRef, definitionRef: VersionRef, ctx: ToolContext): Promise<IndustrySchema | undefined> {
    if (!isToolContext(ctx)) throw new ProjectStoreError('SCOPE_MISMATCH', 'trusted context required')
    const found = this.#schemas.get(`${definitionRef.id}@${definitionRef.version}`)
    return found === undefined ? undefined : structuredClone(found)
  }
}

class InMemoryArtifactReader implements ScopedArtifactReader {
  readonly #bytes = new Map<string, Uint8Array>()

  register(digest: string, bytes: Uint8Array): void {
    this.#bytes.set(digest, bytes)
  }

  async read(request: ScopedArtifactReaderRequest, ctx: ToolContext): Promise<Uint8Array> {
    if (!isToolContext(ctx)) throw new ProjectStoreError('SCOPE_MISMATCH', 'trusted context required')
    for (const ref of request.approvedInputRefs) {
      const bytes = this.#bytes.get(ref.digest)
      if (bytes !== undefined) return bytes
    }
    throw new ProjectStoreError('REVISION_NOT_FOUND', 'the immutable original is not registered in this harness scope')
  }
}

interface StoredSnapshot {
  readonly ref: ProjectDatasetRef
  readonly snapshot: ProjectDatasetSnapshot['body']
}

class InMemoryDatasetWriter implements ProjectDatasetWriterPort {
  readonly backend = 'memory'
  readonly #snapshots = new Map<string, StoredSnapshot>()

  snapshot(digest: string): StoredSnapshot | undefined {
    return this.#snapshots.get(digest)
  }

  async stageSnapshot(
    _scopeRef: ScopeRef,
    input: ProjectDatasetStageInput,
  ): Promise<ProjectDatasetStageResult> {
    this.#snapshots.set(input.snapshotRef.digest, { ref: input.snapshotRef, snapshot: structuredClone(input.body) })
    return {
      snapshotRef: input.snapshotRef,
      rowCount: input.body.rows.length,
      schemaDigest: input.schemaDigest,
      canonicalDigest: input.canonicalDigest,
      created: true,
    }
  }

  async discardSnapshot(_scopeRef: ScopeRef, snapshotRef: ProjectDatasetRef): Promise<void> {
    this.#snapshots.delete(snapshotRef.digest)
  }
}

class InMemoryDatasetQuery implements ProjectDatasetQueryPort {
  readonly #writer: InMemoryDatasetWriter

  constructor(writer: InMemoryDatasetWriter) {
    this.#writer = writer
  }

  async querySnapshot(
    _scopeRef: ScopeRef,
    request: ProjectDatasetQueryRequest,
  ): Promise<ProjectDatasetQueryResult> {
    const stored = this.#writer.snapshot(request.snapshotRef.digest)
    if (stored === undefined) throw new ProjectStoreError('REVISION_NOT_FOUND', 'the dataset snapshot is not staged')
    const coverage: ToolCoverage = {
      returned: stored.snapshot.rows.length,
      knownTotal: stored.snapshot.rows.length,
      truncated: false,
      completeness: 'complete',
    }
    return {
      snapshotRef: stored.ref,
      columns: stored.snapshot.columns,
      rows: stored.snapshot.rows,
      coverage,
    }
  }
}

/** Minimal in-memory project-document coordinator: membership import + index status. */
class InMemoryProjectDocumentService implements ProjectDocumentService {
  readonly #status = new Map<string, ProjectDocumentIndexStatus>()

  #current(projectId: string): ProjectDocumentIndexStatus {
    return this.#status.get(projectId) ?? {
      projectId,
      collectionRef: `project:${projectId}`,
      state: 'pending',
      visibilityEpoch: '1',
      membershipRevision: '0',
      documentCount: 0,
      sourceDocumentCount: 0,
      completeness: 'unknown',
      reason: '尚无已导入的项目资料',
      retryable: true,
    }
  }

  async importDocument(projectId: string): Promise<ProjectDocumentIndexStatus> {
    const previous = this.#current(projectId)
    const next: ProjectDocumentIndexStatus = {
      ...previous,
      state: 'stale',
      visibilityEpoch: String(BigInt(previous.visibilityEpoch) + 1n),
      membershipRevision: String(BigInt(previous.membershipRevision) + 1n),
      sourceDocumentCount: previous.sourceDocumentCount + 1,
      completeness: 'partial',
      reason: '资料已导入，文档索引待构建',
      retryable: true,
    }
    this.#status.set(projectId, next)
    return next
  }

  async reviseDocument(projectId: string): Promise<ProjectDocumentIndexStatus> {
    const previous = this.#current(projectId)
    const next: ProjectDocumentIndexStatus = {
      ...previous,
      state: 'stale',
      visibilityEpoch: String(BigInt(previous.visibilityEpoch) + 1n),
      reason: '资料修订，文档索引待重建',
      retryable: true,
    }
    this.#status.set(projectId, next)
    return next
  }

  async buildIndex(projectId: string): Promise<ProjectDocumentIndexStatus> {
    const previous = this.#current(projectId)
    const next: ProjectDocumentIndexStatus = {
      projectId: previous.projectId,
      collectionRef: previous.collectionRef,
      state: 'ready',
      visibilityEpoch: previous.visibilityEpoch,
      membershipRevision: previous.membershipRevision,
      indexEpoch: previous.visibilityEpoch,
      generation: '1',
      documentCount: previous.sourceDocumentCount * 3,
      sourceDocumentCount: previous.sourceDocumentCount,
      completeness: 'complete',
      retryable: false,
    }
    this.#status.set(projectId, next)
    return next
  }

  async getStatus(projectId: string): Promise<ProjectDocumentIndexStatus> {
    return this.#current(projectId)
  }

  async search(): Promise<never> {
    throw new Error('project document search is out of scope for the project workspace harness')
  }
}

export interface ProjectHarness {
  readonly app: ReturnType<typeof createApiServer>
  readonly client: WorkbenchClient
  readonly baseUrl: string
  readonly csv: string
  readonly parseId: string
  readonly close: () => Promise<void>
}

export function projectTrustedContext(roles: readonly string[], subjectId = 'e2e-owner'): ToolContext {
  return createToolContext({
    principal: { tenantId: PROJECT_SCOPE.tenantId, subjectId, roles: [...roles], scopes: [], authEpoch: 1 },
    runId: '33333333-3333-4333-8333-333333333333',
    resolvedProfileHash: `sha256:${'0'.repeat(64)}`,
    policyVersion: '0.3.0',
    deadline: '2030-01-01T00:00:00Z',
    budgetReservation: {
      reservationId: '55555555-5555-4555-8555-555555555555',
      runId: '33333333-3333-4333-8333-333333333333',
      grantedAt: '2026-09-21T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
    },
    allowedResources: {
      tenantId: PROJECT_SCOPE.tenantId,
      spaceId: PROJECT_SCOPE.spaceId,
      resourceKinds: [],
      sourceRefs: [],
      collectionRefs: [],
      domains: [],
      maxRows: 100,
    },
    traceId: 'trace-project-fixture',
  })
}

export function projectAuthenticator(): AuthenticatedRequest {
  return {
    principal: {
      tenantId: PROJECT_SCOPE.tenantId,
      subjectId: 'e2e-owner',
      roles: PROJECT_ALL_ROLES.split(','),
      scopes: [],
      authEpoch: 1,
    },
    spaceId: PROJECT_SCOPE.spaceId,
  }
}

export async function startProjectHarness(): Promise<ProjectHarness> {
  const catalogue = new InMemoryIndustryPackCatalogue()
  catalogue.registerPack(packAsset(PROJECT_FIXTURE.packVersion, 'a', 'd'))
  catalogue.registerPack(packAsset('1.1.0', '2', '9'))

  const projects = new InMemoryProjectStore()
  const readiness = new InMemoryProjectReadinessStore()
  const mappings = new InMemoryProjectMappingStore()
  const records = new InMemoryProjectRecordStore()
  const jobStore = new InMemoryJobStore()
  const schemaSource = new InMemoryIndustrySchemaSource()
  schemaSource.register(industrySchema())

  const parser = new StructuredDocumentParser()
  const ingestion = new InMemoryStructuredIngestionStore()
  const originals = new InMemoryArtifactReader()

  const bytes = new TextEncoder().encode(PROJECT_FIXTURE.csv)
  const originalDigest = digestOfBytes(bytes)
  const originalRef = resourceRef(PROJECT_FIXTURE.originalId, originalDigest)
  originals.register(originalDigest, bytes)

  // Seed the real parser's durable parse + reconciled rows so the mapping service can bind them.
  const parsed = parser.parse(bytes, { mediaType: 'text/csv', headerRow: 1 })
  if (parsed.tables.length === 0) throw new Error('the project fixture CSV did not parse into a table')
  const table = parsed.tables[0]
  if (table === undefined) throw new Error('the project fixture CSV produced no table')
  const sheetKey = table.sheetId ?? table.sheetName ?? 'sheet'
  const ctx = projectTrustedContext(['platform-admin', 'profile-editor', 'data-editor'])
  const entries: StructuredRecordEntry[] = table.rows.map((row) => ({
    recordId: randomUUID(),
    sourceRowKey: `csv:${sheetKey}:row:${String(row.row)}`,
    recordIndex: row.recordIndex,
    row: row.row,
    state: 'parsed',
    locator: row.locator,
    rowDigest: digestOfText(JSON.stringify(row.cells.map((cell) => cell.raw))),
    columnCount: row.cells.length,
  }))
  const counts = {
    total: entries.length,
    succeeded: entries.length,
    pending: 0,
    failed: 0,
    skipped: 0,
  }
  const parseRecord: StructuredParseRecord = {
    parseId: PROJECT_FIXTURE.parseId,
    scopeRef: PROJECT_SCOPE,
    format: 'csv',
    originalMediaType: 'text/csv',
    originalRef,
    parserId: 'ontology.structured-parser',
    parserVersion: '1.0.0',
    status: parsed.status,
    coverage: parsed.coverage,
    counts,
    sheets: parsed.sheets,
    diagnostics: parsed.diagnostics,
    createdAt: new Date().toISOString(),
  }
  await ingestion.recordParse(parseRecord, entries, ctx)

  const projectService = new ProjectService({
    projects,
    readiness,
    jobs: jobStore,
    catalogue,
    newId: () => randomUUID(),
    now: () => new Date().toISOString(),
  })
  const mappingService = new ProjectMappingService({
    projects,
    revisions: projects,
    mappings,
    records,
    ingestion,
    schemaSource,
    originals,
    parser,
    newId: () => randomUUID(),
    now: () => new Date().toISOString(),
  })
  const datasetWriter = new InMemoryDatasetWriter()
  const dataset = new ProjectDataMaterializationService({
    projects,
    records,
    mappings,
    readiness,
    schemaSource,
    writer: datasetWriter,
    query: new InMemoryDatasetQuery(datasetWriter),
    now: () => new Date().toISOString(),
  })
  const jobService = new JobService({ store: jobStore, newId: () => randomUUID() })
  const documentService = new InMemoryProjectDocumentService()

  const app = createApiServer({
    authenticate: projectAuthenticator,
    jobs: { service: jobService },
    projects: { service: projectService, mappings: mappingService, dataset },
    projectDocuments: { service: documentService },
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (address === null || typeof address === 'string') throw new Error('the project API did not bind a TCP port')
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    app,
    client: new WorkbenchClient({ baseUrl }),
    baseUrl,
    csv: PROJECT_FIXTURE.csv,
    parseId: PROJECT_FIXTURE.parseId,
    close: async () => {
      await app.close()
      await ingestion.close()
    },
  }
}

export { ProjectReadinessStoreError, digestOfText, resourceRef as projectResourceRef }
export type { CreateProjectInput, IndustryPackCatalogue, ProjectReadinessStore }
