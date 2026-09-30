import { createHash } from 'node:crypto'
import {
  ProjectDatasetError,
  ProjectReadinessStoreError,
  assertProjectDatasetSnapshotShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  AttributeValueType,
  ImportMappingVersion,
  IndustryObjectSchema,
  IndustrySchema,
  IndustrySchemaSource,
  NormalizedProjectFieldValue,
  ProjectDatasetCell,
  ProjectDatasetColumn,
  ProjectDatasetCoverage,
  ProjectDatasetExclusion,
  ProjectDatasetFieldSource,
  ProjectDatasetQueryPort,
  ProjectDatasetQueryResult,
  ProjectDatasetRow,
  ProjectDatasetSnapshot,
  ProjectDatasetSnapshotBody,
  ProjectDatasetStageInput,
  ProjectDatasetWriterPort,
  ProjectMappingStore,
  ProjectReadinessStore,
  ProjectRecordStore,
  ProjectRecordVersion,
  ProjectRevision,
  ProjectRevisionRef,
  ReadinessProjection,
  ScopeRef,
  Semver,
  Sha256Digest,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'

const MATERIALIZATION_ROLES: readonly string[] = ['platform-admin', 'profile-editor', 'operator']
const RECORD_PAGE_LIMIT = 250
const MAX_DATASET_ROWS = 20_000

export interface MaterializeProjectDatasetInput {
  readonly objectId: string
  /** Defaults to the project head revision; a historical revision may be pinned explicitly. */
  readonly revision?: string
  /** Explicitly allow a confirmed subset; coverage then records every exclusion. */
  readonly allowPartial?: boolean
  readonly idempotencyKey?: string
}

/** One frozen dataset projection version, with the readiness gate resolved for the caller. */
export interface ProjectDatasetStatus {
  readonly projectId: Uuid
  readonly projectRevisionRef: ProjectRevisionRef
  readonly objectId: string
  readonly state: 'pending' | 'building' | 'ready' | 'failed' | 'revoked'
  readonly snapshotRef?: ProjectDatasetSnapshot['ref']
  readonly coverage?: ProjectDatasetCoverage
  readonly completeness: ProjectDatasetCoverage['completeness']
  readonly reason?: string
  readonly retryable: boolean
}

export interface ProjectDatasetQueryInput {
  readonly projectRevisionRef: ProjectRevisionRef
  readonly snapshotRef: ProjectDatasetSnapshot['ref']
  readonly objectId?: string
  readonly limit?: number
  readonly cursor?: string
}

/** Reads whichever snapshot is active for a project revision, without the caller pinning a ref. */
export interface ActiveProjectDatasetQueryInput {
  readonly projectId: Uuid
  readonly revision?: string
  readonly objectId?: string
  readonly limit?: number
  readonly cursor?: string
}

export interface ProjectDataMaterializationDependencies {
  readonly projects: {
    getProject(
      scopeRef: ScopeRef,
      projectId: Uuid,
      ctx: ToolContext,
    ): Promise<{ readonly headRevision: string } | undefined>
    getRevision(
      scopeRef: ScopeRef,
      projectId: Uuid,
      revision: string,
      ctx: ToolContext,
    ): Promise<ProjectRevision | undefined>
  }
  readonly records: ProjectRecordStore
  readonly mappings: ProjectMappingStore
  readonly readiness: ProjectReadinessStore
  readonly schemaSource: IndustrySchemaSource
  readonly writer: ProjectDatasetWriterPort
  readonly query: ProjectDatasetQueryPort
  readonly newId?: () => string
  readonly now?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ProjectDatasetError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ProjectDatasetError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertOperator(ctx: ToolContext): void {
  if (MATERIALIZATION_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new ProjectDatasetError('FORBIDDEN', 'only an operator, profile-editor or platform-admin may materialise a project dataset')
}

/**
 * Derive a stable snapshot identity from the exact frozen content. The same approved rows
 * (regardless of which client column names or units produced them) resolve to the same
 * snapshot id and version, so a re-materialise is idempotent and a changed dataset is a new
 * immutable snapshot.
 */
function deterministicUuid(seed: string): Uuid {
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)
  const joined = hex.join('')
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`
}

function cellOf(value: NormalizedProjectFieldValue): ProjectDatasetCell {
  if (value.kind === 'quantity') {
    return { kind: 'quantity', value: value.value, unitCode: value.unitCode }
  }
  return { kind: 'scalar', value: value.value }
}

function columnsOf(object: IndustryObjectSchema): ProjectDatasetColumn[] {
  return [...object.attributes]
    .map((attribute) => ({
      name: attribute.attributeId,
      valueType: attribute.valueType as AttributeValueType,
      ...(attribute.unitCode === undefined ? {} : { canonicalUnitCode: attribute.unitCode }),
      ...(attribute.dimension === undefined ? {} : { dimension: attribute.dimension }),
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

/**
 * The project-data materialiser (SPEC v0.3a asset-data-ui §3.2/§6.2/§6.3, A.US-006/P.US-013).
 *
 * It freezes the project's *approved* records into a canonical, backend-neutral dataset and
 * writes it through the independent writer port into a business backend. The dataset digest
 * covers only `objectId` + columns + canonical values, so the same business data mapped through
 * different client column names or units is *semantically identical*: same digest, same rows.
 *
 * Activation is gated: the `dataset` readiness projection is upserted `ready` only after the
 * backend re-reported the same row count and digest (coverage validation). A projection that is
 * not `ready`, or a pinned snapshot that is not the active target, is reported
 * `SNAPSHOT_UNAVAILABLE`; a newer dataset is never silently substituted.
 */
export class ProjectDataMaterializationService {
  readonly #projects: ProjectDataMaterializationDependencies['projects']
  readonly #records: ProjectRecordStore
  readonly #mappings: ProjectMappingStore
  readonly #readiness: ProjectReadinessStore
  readonly #schemaSource: IndustrySchemaSource
  readonly #writer: ProjectDatasetWriterPort
  readonly #query: ProjectDatasetQueryPort
  readonly #now: () => string

  constructor(dependencies: ProjectDataMaterializationDependencies) {
    this.#projects = dependencies.projects
    this.#records = dependencies.records
    this.#mappings = dependencies.mappings
    this.#readiness = dependencies.readiness
    this.#schemaSource = dependencies.schemaSource
    this.#writer = dependencies.writer
    this.#query = dependencies.query
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  get backend(): string {
    return this.#writer.backend
  }

  async materialize(
    projectId: Uuid,
    input: MaterializeProjectDatasetInput,
    ctx: ToolContext,
  ): Promise<ProjectDatasetStatus> {
    assertOperator(ctx)
    const scopeRef = scopeOf(ctx)
    const project = await this.#projects.getProject(scopeRef, projectId, ctx)
    if (project === undefined) {
      throw new ProjectDatasetError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in this scope`)
    }
    const revisionNumber = input.revision ?? project.headRevision
    const revision = await this.#projects.getRevision(scopeRef, projectId, revisionNumber, ctx)
    if (revision === undefined) {
      throw new ProjectDatasetError('REVISION_NOT_FOUND', `project ${projectId} has no readable revision ${revisionNumber}`)
    }
    const schema = await this.#requireSchema(scopeRef, revision, ctx)
    const object = schema.objects.find((candidate) => candidate.objectId === input.objectId)
    if (object === undefined) {
      throw new ProjectDatasetError('INVALID_ARGUMENT', `object ${input.objectId} is not declared by the pinned definition`)
    }

    const records = await this.#allRecords(scopeRef, projectId, input.objectId, ctx)
    const columns = columnsOf(object)
    const { rows, excluded } = await this.#project(object, columns, records, scopeRef, ctx)
    if (records.length !== rows.length + excluded.length) {
      throw new ProjectDatasetError('MATERIALIZATION_MISMATCH', 'the projected rows do not reconcile with the read records')
    }
    if (excluded.length > 0 && input.allowPartial !== true) {
      throw new ProjectDatasetError(
        'INPUT_NOT_READY',
        `${excluded.length} record(s) for ${input.objectId} are not field-confirmed; confirm them or pass allowPartial`,
        { reasons: excluded.map((entry) => `${entry.recordId}: ${entry.reason}`) },
      )
    }

    const coverage: ProjectDatasetCoverage = {
      expectedCount: records.length,
      processedCount: rows.length,
      excluded,
      completeness: excluded.length === 0 && rows.length === records.length ? 'complete' : 'partial',
    }
    const canonicalDigest = sha256DigestOf(
      canonicalJson({
        objectId: object.objectId,
        columns,
        rows: rows.map((row) => ({ recordId: row.recordId, values: row.values })),
      }),
    )
    const schemaDigest = sha256DigestOf(canonicalJson(columns))
    const snapshotId = deterministicUuid(`${projectId}\u0000${input.objectId}\u0000${revision.ref.revision}\u0000${canonicalDigest}`)
    const snapshotRef = {
      id: snapshotId,
      version: `1.0.${revision.ref.revision}` as Semver,
      digest: canonicalDigest,
      kind: 'dataset' as const,
    }
    const body: ProjectDatasetSnapshotBody = {
      schemaVersion: 'project-dataset-snapshot@1',
      projectId,
      objectId: input.objectId,
      projectRevision: revision.ref.revision,
      datasetRevision: revision.ref.revision,
      definitionRef: revision.definitionRef,
      mappingRefs: revision.mappingRefs,
      backend: this.#writer.backend,
      columns,
      rows,
      coverage,
      recordedAt: this.#now(),
    }
    assertProjectDatasetSnapshotShape({ ref: snapshotRef, body })

    const meta = {
      idempotencyKey: input.idempotencyKey ?? `dataset:${projectId}:${input.objectId}:${revision.ref.revision}`,
      requestDigest: sha256DigestOf(canonicalJson({ projectId, objectId: input.objectId, revision: revision.ref.revision, canonicalDigest })),
    }
    const stageInput: ProjectDatasetStageInput = { body, snapshotRef, schemaDigest, canonicalDigest, meta }
    const staged = await this.#writer
      .stageSnapshot(scopeRef, stageInput, ctx)
      .catch((error: unknown) => {
        if (error instanceof ProjectDatasetError) throw error
        throw new ProjectDatasetError('BACKEND_UNAVAILABLE', 'the business backend could not stage the dataset snapshot', { cause: error })
      })

    if (
      staged.rowCount !== rows.length ||
      staged.canonicalDigest !== canonicalDigest ||
      staged.schemaDigest !== schemaDigest
    ) {
      await this.#writer.discardSnapshot(scopeRef, snapshotRef, ctx).catch(() => undefined)
      throw new ProjectDatasetError(
        'MATERIALIZATION_MISMATCH',
        `the staged snapshot reported ${staged.rowCount} rows / ${staged.canonicalDigest}, expected ${rows.length} / ${canonicalDigest}`,
      )
    }

    await this.#activate(scopeRef, revision, snapshotRef, coverage, canonicalDigest, ctx)
    return this.#statusFrom(revision.ref, input.objectId, snapshotRef, coverage, 'ready')
  }

  async getStatus(projectId: Uuid, objectId: string, ctx: ToolContext): Promise<ProjectDatasetStatus> {
    const scopeRef = scopeOf(ctx)
    const project = await this.#projects.getProject(scopeRef, projectId, ctx)
    if (project === undefined) {
      throw new ProjectDatasetError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in this scope`)
    }
    const revision = await this.#projects.getRevision(scopeRef, projectId, project.headRevision, ctx)
    if (revision === undefined) {
      throw new ProjectDatasetError('REVISION_NOT_FOUND', `project ${projectId} has no readable head revision`)
    }
    const projection = await this.#readiness.getProjection(scopeRef, revision.ref, 'dataset', ctx)
    return this.#statusFromProjection(revision.ref, objectId, projection)
  }

  /**
   * Resolve one exact pinned dataset snapshot. The gate is the independent `dataset` readiness
   * projection: before activation, or when the pinned snapshot is not the active target, the
   * read is refused with `SNAPSHOT_UNAVAILABLE` rather than falling back to a newer dataset.
   */
  async query(input: ProjectDatasetQueryInput, ctx: ToolContext): Promise<ProjectDatasetQueryResult> {
    const scopeRef = scopeOf(ctx)
    const projection = await this.#readiness.getProjection(scopeRef, input.projectRevisionRef, 'dataset', ctx)
    if (projection === undefined || projection.state !== 'ready') {
      throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the dataset projection is not activated for this project revision')
    }
    if (projection.targetRef.id !== input.snapshotRef.id || projection.targetDigest !== input.snapshotRef.digest) {
      throw new ProjectDatasetError(
        'SNAPSHOT_UNAVAILABLE',
        'the pinned snapshot is not the active dataset for this project revision; re-read readiness instead of a newer dataset',
      )
    }
    return this.#query.querySnapshot(
      scopeRef,
      {
        snapshotRef: input.snapshotRef,
        ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      ctx,
    )
  }

  /**
   * Resolve and read the snapshot that is active for a project revision. This is the path a
   * business action uses to read "this project's actual approved data"; it still refuses with
   * `SNAPSHOT_UNAVAILABLE` when no dataset projection is activated.
   */
  async queryActive(input: ActiveProjectDatasetQueryInput, ctx: ToolContext): Promise<ProjectDatasetQueryResult> {
    const scopeRef = scopeOf(ctx)
    const project = await this.#projects.getProject(scopeRef, input.projectId, ctx)
    if (project === undefined) {
      throw new ProjectDatasetError('PROJECT_NOT_FOUND', `project ${input.projectId} is not visible in this scope`)
    }
    const revisionNumber = input.revision ?? project.headRevision
    const revision = await this.#projects.getRevision(scopeRef, input.projectId, revisionNumber, ctx)
    if (revision === undefined) {
      throw new ProjectDatasetError('REVISION_NOT_FOUND', `project ${input.projectId} has no readable revision ${revisionNumber}`)
    }
    const projection = await this.#readiness.getProjection(scopeRef, revision.ref, 'dataset', ctx)
    const target = projection?.targetRef
    if (projection === undefined || projection.state !== 'ready' || target === undefined || !('kind' in target) || target.kind !== 'dataset') {
      throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'no dataset snapshot is activated for this project revision')
    }
    return this.query(
      {
        projectRevisionRef: revision.ref,
        snapshotRef: target,
        ...(input.objectId === undefined ? {} : { objectId: input.objectId }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      },
      ctx,
    )
  }

  async #allRecords(
    scopeRef: ScopeRef,
    projectId: Uuid,
    objectId: string,
    ctx: ToolContext,
  ): Promise<ProjectRecordVersion[]> {
    const records: ProjectRecordVersion[] = []
    let cursor: string | undefined
    for (;;) {
      const page = await this.#records.listRecords(
        scopeRef,
        projectId,
        { objectId, limit: RECORD_PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) },
        ctx,
      )
      for (const record of page.records) {
        if (records.length >= MAX_DATASET_ROWS) {
          throw new ProjectDatasetError('INVALID_ARGUMENT', `a single dataset materialisation is bounded to ${MAX_DATASET_ROWS} records`)
        }
        records.push(record)
      }
      if (page.nextCursor === undefined) break
      cursor = page.nextCursor
    }
    return records
  }

  async #project(
    object: IndustryObjectSchema,
    columns: readonly ProjectDatasetColumn[],
    records: readonly ProjectRecordVersion[],
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<{ readonly rows: ProjectDatasetRow[]; readonly excluded: ProjectDatasetExclusion[] }> {
    const rows: ProjectDatasetRow[] = []
    const excluded: ProjectDatasetExclusion[] = []
    const mappingCache = new Map<string, ImportMappingVersion | undefined>()
    for (const record of records) {
      if (record.objectId !== object.objectId) continue
      if (record.status !== 'confirmed') {
        excluded.push({ recordId: record.recordId, reason: `status:${record.status}` })
        continue
      }
      const byField = new Map(record.fields.map((field) => [field.fieldId, field]))
      const values: Record<string, ProjectDatasetCell> = {}
      const sources: ProjectDatasetFieldSource[] = []
      let mapping: ImportMappingVersion | undefined | null = null
      for (const column of columns) {
        const field = byField.get(column.name)
        if (field === undefined) continue
        values[column.name] = cellOf(field.normalized)
        if (mapping === null) {
          const key = `${record.mappingId}@${record.mappingVersion}`
          mapping = mappingCache.has(key)
            ? mappingCache.get(key)
            : await this.#mappings.getMapping(scopeRef, record.projectId, record.mappingId, record.mappingVersion, ctx)
          mappingCache.set(key, mapping)
        }
        if (mapping !== undefined) {
          sources.push({
            fieldId: field.fieldId,
            documentRef: mapping.originalRef,
            parseId: mapping.parseId,
            locator: field.locator,
          })
        }
      }
      rows.push({ recordId: record.recordId, objectId: record.objectId, sourceRowKey: record.sourceRowKey, values, sources })
    }
    rows.sort((left, right) => (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0))
    return { rows, excluded }
  }

  async #activate(
    scopeRef: ScopeRef,
    revision: ProjectRevision,
    snapshotRef: ProjectDatasetSnapshot['ref'],
    coverage: ProjectDatasetCoverage,
    canonicalDigest: Sha256Digest,
    ctx: ToolContext,
  ): Promise<void> {
    try {
      await this.#readiness.upsertProjection(
        scopeRef,
        {
          projectRevisionRef: revision.ref,
          kind: 'dataset',
          targetRef: snapshotRef,
          state: 'ready',
          completeness: coverage.completeness,
          expectedCount: coverage.expectedCount,
          processedCount: coverage.processedCount,
          failedCount: coverage.excluded.length,
          targetDigest: canonicalDigest,
          fenceRevision: revision.ref.revision,
          idempotencyKey: `dataset:${revision.ref.projectId}:${revision.ref.revision}:${snapshotRef.id}`,
          requestDigest: sha256DigestOf(canonicalJson({ projectRevisionRef: revision.ref, targetRef: snapshotRef })),
          actor: 'project-data-materializer',
          recordedAt: this.#now(),
        },
        ctx,
      )
    } catch (error) {
      if (error instanceof ProjectReadinessStoreError && error.code === 'FENCE_STALE') {
        throw new ProjectDatasetError('MATERIALIZATION_MISMATCH', 'the project revision advanced while materialising; a newer dataset is already active', { cause: error })
      }
      throw error
    }
  }

  async #requireSchema(scopeRef: ScopeRef, revision: ProjectRevision, ctx: ToolContext): Promise<IndustrySchema> {
    const schema = await this.#schemaSource.getSchema(scopeRef, revision.definitionRef, ctx)
    if (schema === undefined) {
      throw new ProjectDatasetError('INVALID_ARGUMENT', `definition ${revision.definitionRef.id}@${revision.definitionRef.version} is not visible in this scope`)
    }
    return schema
  }

  #statusFrom(
    projectRevisionRef: ProjectRevisionRef,
    objectId: string,
    snapshotRef: ProjectDatasetSnapshot['ref'],
    coverage: ProjectDatasetCoverage,
    state: ProjectDatasetStatus['state'],
  ): ProjectDatasetStatus {
    return {
      projectId: projectRevisionRef.projectId,
      projectRevisionRef,
      objectId,
      state,
      snapshotRef,
      coverage,
      completeness: coverage.completeness,
      retryable: false,
    }
  }

  #statusFromProjection(
    projectRevisionRef: ProjectRevisionRef,
    objectId: string,
    projection: ReadinessProjection | undefined,
  ): ProjectDatasetStatus {
    if (projection === undefined) {
      return {
        projectId: projectRevisionRef.projectId,
        projectRevisionRef,
        objectId,
        state: 'pending',
        completeness: 'unknown',
        reason: 'the project dataset has not been materialised yet',
        retryable: true,
      }
    }
    const target = projection.targetRef
    const snapshotRef = 'kind' in target && target.kind === 'dataset' ? target : undefined
    return {
      projectId: projectRevisionRef.projectId,
      projectRevisionRef,
      objectId,
      state: projection.state,
      ...(snapshotRef === undefined ? {} : { snapshotRef }),
      coverage: {
        expectedCount: projection.expectedCount,
        processedCount: projection.processedCount,
        excluded: [],
        completeness: projection.completeness,
      },
      completeness: projection.completeness,
      ...(projection.error === undefined ? {} : { reason: projection.error.message }),
      retryable: projection.error?.retryable ?? projection.state !== 'ready',
    }
  }
}
