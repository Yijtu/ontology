import { createHash } from 'node:crypto'
import {
  ProjectDatasetError,
  ProjectReadinessStoreError,
  assertProjectDatasetSnapshotShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  AttributeValueType,
  IndustryObjectSchema,
  IndustrySchema,
  IndustrySchemaSource,
  ProjectDatasetColumn,
  ProjectDatasetCoverage,
  ProjectDatasetQueryPort,
  ProjectDatasetQueryResult,
  ProjectDatasetSnapshot,
  ProjectDatasetSnapshotBody,
  ProjectDatasetStageInput,
  ProjectDatasetWriterPort,
  ProjectPublishedDatasetSource,
  ProjectMappingStore,
  ProjectReadinessStore,
  ProjectRecordStore,
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
  /** Legacy constructors may omit the source, but materialisation then fails explicitly. */
  readonly publishedSource?: ProjectPublishedDatasetSource
  readonly records?: ProjectRecordStore
  readonly mappings?: ProjectMappingStore
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
 * Freeze official published project facts into an independent, immutable business projection.
 * Physical project records supply provenance only through the published-source port. Snapshot
 * identity binds scope, project revision, definition/mappings, fact recorded point and sources.
 * No missing/failed readiness target may substitute a startup example or a newer dataset.
 */
export class ProjectDataMaterializationService {
  readonly #projects: ProjectDataMaterializationDependencies['projects']
  readonly #publishedSource: ProjectPublishedDatasetSource | undefined
  readonly #readiness: ProjectReadinessStore
  readonly #schemaSource: IndustrySchemaSource
  readonly #writer: ProjectDatasetWriterPort
  readonly #query: ProjectDatasetQueryPort
  readonly #now: () => string

  constructor(dependencies: ProjectDataMaterializationDependencies) {
    this.#projects = dependencies.projects
    this.#publishedSource = dependencies.publishedSource
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

    const priorActivation = await this.#readiness.getProjection(scopeRef, revision.ref, 'dataset', ctx)
    // Reserve the next generation before building. Equal-generation competing targets still
    // lose the store's CAS; a late build cannot step past a newer source revocation.
    const activationFence = priorActivation === undefined ? revision.ref.revision : String(BigInt(priorActivation.fenceRevision) + 1n)
    const columns = columnsOf(object)
    if (this.#publishedSource === undefined) {
      throw new ProjectDatasetError('INPUT_NOT_READY', 'the official published project fact source is not mounted')
    }
    const published = await this.#publishedSource.read(scopeRef, revision, input.objectId, ctx)
    const { rows, coverage } = published
    if (coverage.completeness !== 'complete' && input.allowPartial !== true) {
      throw new ProjectDatasetError('INPUT_NOT_READY', 'the official published fact projection is incomplete')
    }
    const canonicalDigest = sha256DigestOf(
      canonicalJson({
        objectId: object.objectId,
        columns,
        rows: rows.map((row) => ({ recordId: row.recordId, values: row.values })),
      }),
    )
    const schemaDigest = sha256DigestOf(canonicalJson(columns))
    const snapshotDigest = sha256DigestOf(canonicalJson({ scopeRef, projectRevisionRef: revision.ref, definitionRef: revision.definitionRef,
      mappingRefs: revision.mappingRefs, factRecordedPoint: published.factRecordedPoint, sourceDigest: published.sourceDigest, canonicalDigest }))
    const snapshotId = deterministicUuid(snapshotDigest)
    const snapshotRef = {
      id: snapshotId,
      version: `1.0.${revision.ref.revision}` as Semver,
      digest: snapshotDigest,
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
      projectRevisionRef: revision.ref,
      factRecordedPoint: published.factRecordedPoint,
      sourceDigest: published.sourceDigest,
    }
    assertProjectDatasetSnapshotShape({ ref: snapshotRef, body })

    const meta = {
      idempotencyKey: input.idempotencyKey ?? `dataset:${snapshotId}`,
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

    try {
      const current = await this.#publishedSource.read(scopeRef, revision, input.objectId, ctx)
      if (current.sourceDigest !== published.sourceDigest) {
        throw new ProjectDatasetError('INPUT_NOT_READY', 'the official published sources changed during projection creation')
      }
      await this.#activate(scopeRef, revision, snapshotRef, coverage, snapshotDigest, input.objectId, published.sourceDigest, published.factRecordedPoint, activationFence, ctx)
    } catch (error) {
      if (staged.created) await this.#writer.discardSnapshot(scopeRef, snapshotRef, ctx)
      throw error
    }
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
   * Resolve an exact historical snapshot through its immutable activation receipt. The mutable
   * current target belongs to admission/queryActive; it cannot revoke an earlier authorized
   * historical recorded point merely because another snapshot becomes current.
   */
  async query(input: ProjectDatasetQueryInput, ctx: ToolContext): Promise<ProjectDatasetQueryResult> {
    const scopeRef = scopeOf(ctx)
    const revision = await this.#projects.getRevision(scopeRef, input.projectRevisionRef.projectId, input.projectRevisionRef.revision, ctx)
    const receipt = await this.#query.getActivation(scopeRef, input.snapshotRef, ctx)
    if (revision === undefined || revision.ref.digest !== input.projectRevisionRef.digest || receipt === undefined ||
      receipt.scopeRef.tenantId !== scopeRef.tenantId || receipt.scopeRef.spaceId !== scopeRef.spaceId ||
      receipt.projectRevisionRef.projectId !== input.projectRevisionRef.projectId || receipt.projectRevisionRef.revision !== input.projectRevisionRef.revision || receipt.projectRevisionRef.digest !== input.projectRevisionRef.digest ||
      receipt.snapshotRef.id !== input.snapshotRef.id || receipt.snapshotRef.version !== input.snapshotRef.version || receipt.snapshotRef.digest !== input.snapshotRef.digest) {
      throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the exact historical dataset has no immutable scoped activation receipt')
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

  async #activate(
    scopeRef: ScopeRef,
    revision: ProjectRevision,
    snapshotRef: ProjectDatasetSnapshot['ref'],
    coverage: ProjectDatasetCoverage,
    canonicalDigest: Sha256Digest,
    objectId: string,
    sourceDigest: Sha256Digest,
    factRecordedPoint: { readonly semantic: string; readonly identity: string },
    activationFence: string,
    ctx: ToolContext,
  ): Promise<void> {
    try {
      const activated = await this.#readiness.upsertProjection(
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
          fenceRevision: activationFence,
          idempotencyKey: `dataset:${revision.ref.projectId}:${revision.ref.revision}:${snapshotRef.id}`,
          requestDigest: sha256DigestOf(canonicalJson({ projectRevisionRef: revision.ref, targetRef: snapshotRef })),
          actor: 'project-data-materializer',
          recordedAt: this.#now(),
        },
        ctx,
      )
      const proof = activated.projection
      if (proof.state !== 'ready' || proof.targetRef.id !== snapshotRef.id || proof.targetRef.version !== snapshotRef.version || proof.targetDigest !== snapshotRef.digest) throw new ProjectDatasetError('SNAPSHOT_UNAVAILABLE', 'the readiness store did not activate this exact snapshot')
      await this.#writer.recordActivation(scopeRef, { schemaVersion: 'project-dataset-activation@1', scopeRef, projectRevisionRef: revision.ref,
        snapshotRef, objectId, sourceDigest, factRecordedPoint, activatedAt: this.#now() }, ctx)
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
