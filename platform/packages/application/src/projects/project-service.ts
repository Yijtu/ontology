import {
  EMPTY_JOB_COUNTS,
  JobStoreError,
  PROJECT_READINESS_KINDS,
  ProjectReadinessStoreError,
  ProjectStoreError,
  assertProjectRevisionShape,
  isToolContext,
} from '@ontology/contracts'
import type {
  CapabilityBlocker,
  IndustryPackCatalogue,
  JobStore,
  MappingRef,
  PackAsset,
  NewLogicalJobRecord,
  NewOutboxMessage,
  ProjectReadinessKind,
  ProjectReadinessState,
  ProjectReadinessStore,
  ProjectRecord,
  ProjectRevision,
  ProjectRevisionBody,
  ProjectRevisionRef,
  ProjectState,
  ProjectStore,
  ReadinessError,
  ReadinessProjection,
  ReadinessTargetRef,
  ResourceRef,
  RevisionString,
  ResolvedProfileRef,
  Rfc3339UtcTimestamp,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { ProjectError } from './errors'

/**
 * The outbox topics the project surface emits. The create/append transaction already commits
 * the project head and the immutable revision atomically; the message lets a materialisation or
 * index consumer pick the revision up without a second state table.
 */
export const PROJECT_CREATED_TOPIC = 'project.created'
export const PROJECT_REVISION_APPENDED_TOPIC = 'project.revision.appended'

const PROJECT_EDITOR_ROLES: readonly string[] = ['platform-admin', 'profile-editor']
const READINESS_OPERATOR_ROLES: readonly string[] = ['platform-admin', 'operator']
const FIRST_REVISION: RevisionString = '1'
const ANCHOR_SOURCE_REF = 'project-anchor'
const ANCHOR_DOCUMENT_REF = 'project-anchor'
const ANCHOR_PIPELINE_VERSION = '1.0.0'
const ANCHOR_IDEMPOTENCY_KEY = 'project-anchor'

export interface CreateProjectInput {
  readonly title: string
  /** The exact published pack version the project is created against. */
  readonly industryPackRef: VersionRef
  /** The server-resolved profile the project's data bindings use. */
  readonly profileRef: ResolvedProfileRef
  /** Non-empty mapping set the project input is read through. */
  readonly mappingRefs: readonly MappingRef[]
  readonly documentSetRef: ResourceRef
  readonly semanticPublicationRefs?: readonly VersionRef[]
  readonly sourceVisibilityEpoch?: RevisionString
}

/**
 * One immutable project revision append. `undefined` on a field means "carry the previous
 * revision's pin forward"; supplying one pins a new value and (for the industry pack) re-derives
 * the definition reference from the published pack manifest rather than trusting a client.
 */
export interface EvolveProjectRevisionInput {
  /** `undefined` means the If-Match header was absent; the call is rejected with 428. */
  readonly expectedRevision: RevisionString | undefined
  readonly reason: string
  readonly industryPackRef?: VersionRef
  readonly profileRef?: ResolvedProfileRef
  readonly mappingRefs?: readonly MappingRef[]
  readonly documentSetRef?: ResourceRef
  readonly approvedInputRef?: ResourceRef
  readonly datasetSnapshotRef?: ResourceRef
  readonly documentIndexRef?: ResourceRef
  readonly semanticPublicationRefs?: readonly VersionRef[]
  readonly sourceVisibilityEpoch?: RevisionString
}

export interface MountPackVersionInput {
  readonly expectedRevision: RevisionString | undefined
  readonly industryPackRef: VersionRef
  readonly reason: string
  readonly profileRef?: ResolvedProfileRef
  readonly mappingRefs?: readonly MappingRef[]
  readonly documentSetRef?: ResourceRef
}

export interface ProjectWriteView {
  readonly project: ProjectRecord
  readonly revision: ProjectRevision
  readonly created: boolean
}

/** One project revision append with the localised field list that changed and its readiness impact. */
export interface ProjectEvolutionView {
  readonly project: ProjectRecord
  readonly revision: ProjectRevision
  readonly previousRevision: ProjectRevision
  readonly changes: readonly string[]
  /** Readiness projections whose target this change invalidates and must be rebuilt. */
  readonly readinessInvalidated: readonly ProjectReadinessKind[]
  readonly created: boolean
}

export interface ProjectRevisionView {
  readonly revision: ProjectRevision
  readonly readiness: readonly ReadinessProjection[]
  /** True when the revision is not the current project head. */
  readonly historical: boolean
  readonly active: boolean
  readonly staging: boolean
}

/** Readiness of one revision for a declared set of projections, with fixable blockers. */
export interface ProjectReadinessView {
  readonly projectRevisionRef: ProjectRevisionRef
  readonly projections: readonly ReadinessProjection[]
  readonly requiredReadiness: readonly ProjectReadinessKind[]
  readonly ready: boolean
  readonly blockers: readonly CapabilityBlocker[]
}

export interface RecordProjectReadinessInput {
  readonly revision: RevisionString
  readonly kind: ProjectReadinessKind
  readonly targetRef: ReadinessTargetRef
  readonly state: ProjectReadinessState
  readonly completeness: ReadinessProjection['completeness']
  readonly expectedCount: number
  readonly processedCount: number
  readonly failedCount: number
  readonly targetDigest: Sha256Digest
  readonly receiptRef?: ResourceRef
  readonly fenceRevision: RevisionString
  readonly jobId?: Uuid
  readonly error?: ReadinessError
}

export interface ProjectServiceDependencies {
  readonly projects: ProjectStore
  readonly readiness: ProjectReadinessStore
  /** Used only to anchor the transactional outbox FK; no project job is executed here. */
  readonly jobs: JobStore
  /** The published-pack read port; a project can only mount an exact published version. */
  readonly catalogue: IndustryPackCatalogue
  /** Configured evolution hosts forbid legacy instant definition switches, including empty projects. */
  readonly evolutionPolicy?: 'staged_only'
  readonly newId?: () => string
  readonly now?: () => string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ProjectError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ProjectError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function assertEditor(ctx: ToolContext): void {
  if (PROJECT_EDITOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new ProjectError('FORBIDDEN', 'only a profile-editor or platform-admin may manage customer projects')
}

function assertReadinessOperator(ctx: ToolContext): void {
  if (READINESS_OPERATOR_ROLES.some((role) => ctx.principal.roles.includes(role))) return
  throw new ProjectError('FORBIDDEN', 'only an operator may record project readiness')
}

function requireIdempotencyKey(key: string): string {
  if (typeof key !== 'string' || key.length < 8 || key.length > 256) {
    throw new ProjectError('INVALID_ARGUMENT', 'Idempotency-Key must be a string between 8 and 256 characters')
  }
  return key
}

function requireRevision(revision: RevisionString | undefined): RevisionString {
  if (revision === undefined) {
    throw new ProjectError('REVISION_REQUIRED', 'an If-Match revision is required to append a project revision')
  }
  return revision
}

function requireNonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProjectError('INVALID_ARGUMENT', `${field} must be a non-empty string`)
  }
  return value
}

function mapStoreError(error: unknown): never {
  if (error instanceof ProjectStoreError) {
    switch (error.code) {
      case 'SCOPE_MISMATCH':
        throw new ProjectError('SCOPE_MISMATCH', error.message, { cause: error })
      case 'PROJECT_NOT_FOUND':
        throw new ProjectError('PROJECT_NOT_FOUND', error.message, { cause: error })
      case 'REVISION_NOT_FOUND':
        throw new ProjectError('REVISION_NOT_FOUND', error.message, { cause: error })
      case 'VERSION_CONFLICT':
        throw new ProjectError('VERSION_CONFLICT', error.message, { cause: error })
      case 'IDEMPOTENCY_CONFLICT':
        throw new ProjectError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
      case 'REVISION_INVALID':
      case 'INVALID_REVISION':
      case 'INVALID_CONFIRMATION':
        throw new ProjectError('INVALID_ARGUMENT', error.message, { cause: error })
    }
  }
  if (error instanceof ProjectReadinessStoreError) {
    switch (error.code) {
      case 'SCOPE_MISMATCH':
        throw new ProjectError('SCOPE_MISMATCH', error.message, { cause: error })
      case 'IDEMPOTENCY_CONFLICT':
        throw new ProjectError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
      case 'FENCE_STALE':
        throw new ProjectError('READINESS_CONFLICT', error.message, { cause: error })
      case 'INVALID_PROJECTION':
        throw new ProjectError('INVALID_ARGUMENT', error.message, { cause: error })
    }
  }
  if (error instanceof JobStoreError) {
    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      throw new ProjectError('IDEMPOTENCY_CONFLICT', error.message, { cause: error })
    }
    throw new ProjectError('INVALID_ARGUMENT', error.message, { cause: error })
  }
  throw error
}

export function bodyToRevision(body: ProjectRevisionBody): ProjectRevision {
  const digest = sha256DigestOf(canonicalJson(body))
  return {
    ref: { projectId: body.projectId, revision: body.revision, digest },
    industryPackRef: body.industryPackRef,
    definitionRef: body.definitionRef,
    mappingRefs: body.mappingRefs,
    profileRef: body.profileRef,
    documentSetRef: body.documentSetRef,
    ...(body.approvedInputRef === undefined ? {} : { approvedInputRef: body.approvedInputRef }),
    ...(body.datasetSnapshotRef === undefined ? {} : { datasetSnapshotRef: body.datasetSnapshotRef }),
    ...(body.documentIndexRef === undefined ? {} : { documentIndexRef: body.documentIndexRef }),
    semanticPublicationRefs: body.semanticPublicationRefs,
    sourceVisibilityEpoch: body.sourceVisibilityEpoch,
    changeReason: body.changeReason,
  }
}

const PIN_FIELDS = [
  'industryPackRef',
  'definitionRef',
  'mappingRefs',
  'profileRef',
  'documentSetRef',
  'approvedInputRef',
  'datasetSnapshotRef',
  'documentIndexRef',
  'semanticPublicationRefs',
  'sourceVisibilityEpoch',
] as const

function changedPins(previous: ProjectRevision, next: ProjectRevision): string[] {
  const changes: string[] = []
  for (const field of PIN_FIELDS) {
    if (canonicalJson(previous[field] ?? null) !== canonicalJson(next[field] ?? null)) changes.push(field)
  }
  return changes
}

const READINESS_BY_PIN: Readonly<Record<(typeof PIN_FIELDS)[number], ProjectReadinessKind>> = {
  industryPackRef: 'published_semantics',
  definitionRef: 'published_semantics',
  semanticPublicationRefs: 'published_semantics',
  mappingRefs: 'dataset',
  documentSetRef: 'dataset',
  approvedInputRef: 'dataset',
  datasetSnapshotRef: 'dataset',
  documentIndexRef: 'document_index',
  profileRef: 'dataset',
  sourceVisibilityEpoch: 'published_semantics',
}

function readinessKindsFor(changes: readonly string[]): ProjectReadinessKind[] {
  const invalidated = new Set<ProjectReadinessKind>()
  for (const change of changes) {
    const kind = READINESS_BY_PIN[change as (typeof PIN_FIELDS)[number]]
    if (kind !== undefined) invalidated.add(kind)
  }
  if (changes.includes('documentSetRef')) invalidated.add('document_index')
  return PROJECT_READINESS_KINDS.filter((kind) => invalidated.has(kind))
}

function blockerFor(
  kind: ProjectReadinessKind,
  revision: RevisionString,
  projection: ReadinessProjection | undefined,
): CapabilityBlocker | undefined {
  if (projection === undefined) {
    return {
      code: 'READINESS_NOT_BUILT',
      message: `${kind} readiness for project revision ${revision} has not been built`,
      retryable: true,
      readinessKind: kind,
    }
  }
  switch (projection.state) {
    case 'ready':
      return undefined
    case 'pending':
      return {
        code: 'READINESS_PENDING',
        message: `${kind} readiness for project revision ${revision} is pending`,
        retryable: true,
        readinessKind: kind,
      }
    case 'building':
      return {
        code: 'READINESS_BUILDING',
        message: `${kind} readiness for project revision ${revision} is being built`,
        retryable: true,
        readinessKind: kind,
      }
    case 'failed':
      return {
        code: 'READINESS_FAILED',
        message: projection.error?.message ?? `${kind} readiness for project revision ${revision} failed`,
        retryable: projection.error?.retryable ?? true,
        readinessKind: kind,
      }
    case 'revoked':
      return {
        code: 'READINESS_REVOKED',
        message: `${kind} readiness for project revision ${revision} was revoked`,
        retryable: false,
        readinessKind: kind,
      }
  }
}

/**
 * The customer-project and version-mounting service (SPEC v0.3a §3.2/§6/§8.1).
 *
 * It owns project-revision identity and digesting on top of the injected `ProjectStore` and reads
 * the independent readiness projections through `ProjectReadinessStore`. Creating a project or
 * mounting a new published pack version appends one immutable revision; a newer industry version
 * is never picked up automatically, so an existing project keeps the exact pack it pinned until an
 * explicit mount forms a new revision. Readiness is reported separately and a project whose
 * required projection is not `ready` is never presented as queryable.
 */
export class ProjectService {
  readonly #projects: ProjectStore
  readonly #readiness: ProjectReadinessStore
  readonly #jobs: JobStore
  readonly #catalogue: IndustryPackCatalogue
  readonly #evolutionPolicy: ProjectServiceDependencies['evolutionPolicy']
  readonly #newId: () => string
  readonly #now: () => string

  constructor(dependencies: ProjectServiceDependencies) {
    this.#projects = dependencies.projects
    this.#readiness = dependencies.readiness
    this.#jobs = dependencies.jobs
    this.#catalogue = dependencies.catalogue
    this.#evolutionPolicy = dependencies.evolutionPolicy
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
    this.#now = dependencies.now ?? (() => new Date().toISOString())
  }

  async createProject(
    input: CreateProjectInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<ProjectWriteView> {
    assertEditor(ctx)
    const scopeRef = scopeOf(ctx)
    requireIdempotencyKey(idempotencyKey)
    requireNonEmpty(input.title, 'title')
    if (input.mappingRefs.length === 0) {
      throw new ProjectError('INVALID_ARGUMENT', 'mappingRefs must be a non-empty mapping array')
    }
    const pack = await this.#requirePublishedPack(input.industryPackRef, scopeRef, ctx)
    const definitionRef = pack.manifest.definitionsRef
    const semanticPublicationRefs = input.semanticPublicationRefs ?? [definitionRef]
    const recordedAt = this.#now()
    const projectId = this.#newId()

    const body: ProjectRevisionBody = {
      schemaVersion: 'project-revision@1',
      projectId,
      revision: FIRST_REVISION,
      industryPackRef: input.industryPackRef,
      definitionRef,
      mappingRefs: [...input.mappingRefs],
      profileRef: input.profileRef,
      documentSetRef: input.documentSetRef,
      semanticPublicationRefs: [...semanticPublicationRefs],
      sourceVisibilityEpoch: input.sourceVisibilityEpoch ?? '1',
      changeReason: 'project created',
    }
    const revision = bodyToRevision(body)
    assertProjectRevisionShape(revision)

    const requestDigest = sha256DigestOf(
      canonicalJson({
        title: input.title,
        industryPackRef: input.industryPackRef,
        profileRef: input.profileRef,
        mappingRefs: input.mappingRefs,
        documentSetRef: input.documentSetRef,
        semanticPublicationRefs,
        sourceVisibilityEpoch: body.sourceVisibilityEpoch,
      }),
    )
    const outboxJobId = await this.#ensureAnchorJob(scopeRef, ctx, recordedAt)
    const outbox = this.#outbox(
      PROJECT_CREATED_TOPIC,
      { projectId, revision: FIRST_REVISION },
      `project-created-${projectId}-${FIRST_REVISION}`,
      recordedAt,
    )
    try {
      const result = await this.#projects.createProject(
        {
          projectId,
          title: input.title,
          firstRevision: revision,
          idempotencyKey,
          requestDigest,
          actor,
          recordedAt,
          outbox,
          outboxJobId,
        },
        scopeRef,
        ctx,
      )
      return { project: result.project, revision: result.revision, created: result.created }
    } catch (error) {
      mapStoreError(error)
    }
  }

  async getProject(projectId: Uuid, ctx: ToolContext): Promise<ProjectRecord> {
    return this.#requireProject(scopeOf(ctx), projectId, ctx)
  }

  async listProjects(
    filter: { readonly state?: ProjectState; readonly limit?: number },
    ctx: ToolContext,
  ): Promise<ProjectRecord[]> {
    return this.#projects.listProjects(scopeOf(ctx), filter, ctx).catch(mapStoreError)
  }

  async listRevisions(projectId: Uuid, ctx: ToolContext): Promise<ProjectRevision[]> {
    const scopeRef = scopeOf(ctx)
    await this.#requireProject(scopeRef, projectId, ctx)
    return this.#projects.listRevisions(scopeRef, projectId, ctx).catch(mapStoreError)
  }

  async getRevisionView(
    projectId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<ProjectRevisionView> {
    const scopeRef = scopeOf(ctx)
    const project = await this.#requireProject(scopeRef, projectId, ctx)
    const stored = await this.#requireRevision(scopeRef, projectId, revision, ctx)
    const readiness = await this.#readiness
      .listProjections(scopeRef, stored.ref, ctx)
      .catch(mapStoreError)
    return {
      revision: stored,
      readiness,
      historical: stored.ref.revision !== (project.activeRevision ?? project.headRevision),
      active: stored.ref.revision === (project.activeRevision ?? project.headRevision),
      staging: stored.ref.revision === project.headRevision && project.headRevision !== (project.activeRevision ?? project.headRevision),
    }
  }

  /** `POST /projects/:id/mappings` / pack mount: append one immutable revision on a change. */
  async appendRevision(
    projectId: Uuid,
    input: EvolveProjectRevisionInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<ProjectEvolutionView> {
    return this.#evolve(projectId, input, idempotencyKey, actor, ctx)
  }

  /** Mount a published pack version; the previous revision stays readable and unchanged. */
  async mountPackVersion(
    projectId: Uuid,
    input: MountPackVersionInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<ProjectEvolutionView> {
    return this.#evolve(
      projectId,
      {
        expectedRevision: input.expectedRevision,
        reason: input.reason,
        industryPackRef: input.industryPackRef,
        ...(input.profileRef === undefined ? {} : { profileRef: input.profileRef }),
        ...(input.mappingRefs === undefined ? {} : { mappingRefs: input.mappingRefs }),
        ...(input.documentSetRef === undefined ? {} : { documentSetRef: input.documentSetRef }),
      },
      idempotencyKey,
      actor,
      ctx,
    )
  }

  async getReadiness(
    projectId: Uuid,
    revision: RevisionString | undefined,
    requiredReadiness: readonly ProjectReadinessKind[] | undefined,
    ctx: ToolContext,
  ): Promise<ProjectReadinessView> {
    const scopeRef = scopeOf(ctx)
    const project = await this.#requireProject(scopeRef, projectId, ctx)
    const targetRevision = revision ?? project.activeRevision ?? project.headRevision
    const stored = await this.#requireRevision(scopeRef, projectId, targetRevision, ctx)
    const required = requiredReadiness ?? PROJECT_READINESS_KINDS
    return this.#readinessView(scopeRef, stored, required, ctx)
  }

  async evaluateTaskReadiness(
    projectId: Uuid,
    revision: RevisionString | undefined,
    requiredReadiness: readonly ProjectReadinessKind[],
    ctx: ToolContext,
  ): Promise<ProjectReadinessView> {
    return this.getReadiness(projectId, revision, requiredReadiness, ctx)
  }

  /** The worker write path: CAS-upsert one readiness projection for an exact revision. */
  async recordReadiness(
    projectId: Uuid,
    input: RecordProjectReadinessInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<ReadinessProjection> {
    assertReadinessOperator(ctx)
    const scopeRef = scopeOf(ctx)
    requireIdempotencyKey(idempotencyKey)
    const stored = await this.#requireRevision(scopeRef, projectId, input.revision, ctx)
    const recordedAt = this.#now()
    const requestDigest = sha256DigestOf(
      canonicalJson({
        projectRevisionRef: stored.ref,
        kind: input.kind,
        targetRef: input.targetRef,
        state: input.state,
        completeness: input.completeness,
        expectedCount: input.expectedCount,
        processedCount: input.processedCount,
        failedCount: input.failedCount,
        targetDigest: input.targetDigest,
        fenceRevision: input.fenceRevision,
      }),
    )
    try {
      const result = await this.#readiness.upsertProjection(
        scopeRef,
        {
          projectRevisionRef: stored.ref,
          kind: input.kind,
          targetRef: input.targetRef,
          state: input.state,
          completeness: input.completeness,
          expectedCount: input.expectedCount,
          processedCount: input.processedCount,
          failedCount: input.failedCount,
          targetDigest: input.targetDigest,
          fenceRevision: input.fenceRevision,
          ...(input.receiptRef === undefined ? {} : { receiptRef: input.receiptRef }),
          ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
          ...(input.error === undefined ? {} : { error: input.error }),
          idempotencyKey,
          requestDigest,
          actor,
          recordedAt,
        },
        ctx,
      )
      return result.projection
    } catch (error) {
      mapStoreError(error)
    }
  }

  async #evolve(
    projectId: Uuid,
    input: EvolveProjectRevisionInput,
    idempotencyKey: string,
    actor: string,
    ctx: ToolContext,
  ): Promise<ProjectEvolutionView> {
    assertEditor(ctx)
    const scopeRef = scopeOf(ctx)
    requireIdempotencyKey(idempotencyKey)
    const expectedRevision = requireRevision(input.expectedRevision)
    requireNonEmpty(input.reason, 'reason')

    const project = await this.#requireProject(scopeRef, projectId, ctx)
    const previous = await this.#latestRevision(scopeRef, projectId, ctx)
    const nextRevision = (BigInt(project.headRevision) + 1n).toString()

    let industryPackRef = input.industryPackRef ?? previous.industryPackRef
    let definitionRef = previous.definitionRef
    if (input.industryPackRef !== undefined) {
      const pack = await this.#requirePublishedPack(input.industryPackRef, scopeRef, ctx)
      industryPackRef = input.industryPackRef
      definitionRef = pack.manifest.definitionsRef
    }
    if(this.#evolutionPolicy==='staged_only' && (definitionRef.id!==previous.definitionRef.id || definitionRef.version!==previous.definitionRef.version || definitionRef.digest!==previous.definitionRef.digest)) throw new ProjectError('INVALID_ARGUMENT','definition switches require /projects/:id/evolutions with an explicit strategy and bounded original remappings')
    const mappingRefs = input.mappingRefs ?? previous.mappingRefs
    if (mappingRefs.length === 0) {
      throw new ProjectError('INVALID_ARGUMENT', 'mappingRefs must be a non-empty mapping array')
    }

    const body: ProjectRevisionBody = {
      schemaVersion: 'project-revision@1',
      projectId,
      revision: nextRevision,
      industryPackRef,
      definitionRef,
      mappingRefs: [...mappingRefs],
      profileRef: input.profileRef ?? previous.profileRef,
      documentSetRef: input.documentSetRef ?? previous.documentSetRef,
      ...(input.approvedInputRef === undefined && previous.approvedInputRef === undefined
        ? {}
        : { approvedInputRef: input.approvedInputRef ?? previous.approvedInputRef }),
      ...(input.datasetSnapshotRef === undefined && previous.datasetSnapshotRef === undefined
        ? {}
        : { datasetSnapshotRef: input.datasetSnapshotRef ?? previous.datasetSnapshotRef }),
      ...(input.documentIndexRef === undefined && previous.documentIndexRef === undefined
        ? {}
        : { documentIndexRef: input.documentIndexRef ?? previous.documentIndexRef }),
      semanticPublicationRefs: [...(input.semanticPublicationRefs ?? previous.semanticPublicationRefs)],
      sourceVisibilityEpoch: input.sourceVisibilityEpoch ?? previous.sourceVisibilityEpoch,
      changeReason: input.reason,
    }
    const revision = bodyToRevision(body)
    assertProjectRevisionShape(revision)

    // The request digest is derived from the *request* only, so replaying the same
    // Idempotency-Key after the head advanced still matches the stored row.
    const requestDigest = sha256DigestOf(
      canonicalJson({
        projectId,
        expectedRevision,
        reason: input.reason,
        industryPackRef: input.industryPackRef ?? null,
        profileRef: input.profileRef ?? null,
        mappingRefs: input.mappingRefs ?? null,
        documentSetRef: input.documentSetRef ?? null,
        approvedInputRef: input.approvedInputRef ?? null,
        datasetSnapshotRef: input.datasetSnapshotRef ?? null,
        documentIndexRef: input.documentIndexRef ?? null,
        semanticPublicationRefs: input.semanticPublicationRefs ?? null,
        sourceVisibilityEpoch: input.sourceVisibilityEpoch ?? null,
      }),
    )
    const recordedAt = this.#now()
    const outboxJobId = await this.#ensureAnchorJob(scopeRef, ctx, recordedAt)
    const outbox = this.#outbox(
      PROJECT_REVISION_APPENDED_TOPIC,
      { projectId, revision: nextRevision, reason: input.reason },
      `project-revision-${projectId}-${nextRevision}`,
      recordedAt,
    )
    try {
      const result = await this.#projects.appendRevision(
        scopeRef,
        projectId,
        {
          expectedRevision,
          revision,
          idempotencyKey,
          requestDigest,
          actor,
          recordedAt,
          outbox,
          outboxJobId,
        },
        ctx,
      )
      const changes = changedPins(previous, result.revision)
      return {
        project: result.project,
        revision: result.revision,
        previousRevision: previous,
        changes,
        readinessInvalidated: readinessKindsFor(changes),
        created: result.created,
      }
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === 'VERSION_CONFLICT') {
        const latest = await this.#projects.getProject(scopeRef, projectId, ctx).catch(() => undefined)
        throw new ProjectError('VERSION_CONFLICT', error.message, {
          cause: error,
          reasons: [
            `expectedRevision=${expectedRevision}`,
            `currentRevision=${latest?.headRevision ?? 'unknown'}`,
          ],
        })
      }
      mapStoreError(error)
    }
  }

  async #readinessView(
    scopeRef: ScopeRef,
    revision: ProjectRevision,
    required: readonly ProjectReadinessKind[],
    ctx: ToolContext,
  ): Promise<ProjectReadinessView> {
    const projections = await this.#readiness.listProjections(scopeRef, revision.ref, ctx).catch(mapStoreError)
    const byKind = new Map(projections.map((projection) => [projection.kind, projection]))
    const blockers: CapabilityBlocker[] = []
    for (const kind of required) {
      const blocker = blockerFor(kind, revision.ref.revision, byKind.get(kind))
      if (blocker !== undefined) blockers.push(blocker)
    }
    blockers.sort((left, right) => (left.readinessKind ?? '').localeCompare(right.readinessKind ?? ''))
    return {
      projectRevisionRef: revision.ref,
      projections,
      requiredReadiness: [...required],
      ready: blockers.length === 0,
      blockers,
    }
  }

  async #requirePublishedPack(
    packRef: VersionRef,
    scopeRef: ScopeRef,
    ctx: ToolContext,
  ): Promise<PackAsset> {
    const pack = await this.#catalogue.findPack(packRef.id, packRef.version, scopeRef, ctx).catch(mapStoreError)
    if (pack === undefined || pack.ref.digest !== packRef.digest) {
      throw new ProjectError(
        'PACK_NOT_PUBLISHED',
        `pack ${packRef.id}@${packRef.version}#${packRef.digest} is not published in this scope`,
      )
    }
    return pack
  }

  async #requireProject(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<ProjectRecord> {
    const project = await this.#projects.getProject(scopeRef, projectId, ctx).catch(mapStoreError)
    if (project === undefined) {
      throw new ProjectError('PROJECT_NOT_FOUND', `project ${projectId} is not visible in this scope`)
    }
    return project
  }

  async #requireRevision(
    scopeRef: ScopeRef,
    projectId: Uuid,
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<ProjectRevision> {
    const stored = await this.#projects.getRevision(scopeRef, projectId, revision, ctx).catch(mapStoreError)
    if (stored === undefined) {
      throw new ProjectError('REVISION_NOT_FOUND', `revision ${revision} of project ${projectId} is not visible`)
    }
    return stored
  }

  async #latestRevision(scopeRef: ScopeRef, projectId: Uuid, ctx: ToolContext): Promise<ProjectRevision> {
    const revisions = await this.#projects.listRevisions(scopeRef, projectId, ctx).catch(mapStoreError)
    const latest = revisions[revisions.length - 1]
    if (latest === undefined) {
      throw new ProjectError('REVISION_NOT_FOUND', `project ${projectId} has no revision to append to`)
    }
    return latest
  }

  async #ensureAnchorJob(
    scopeRef: ScopeRef,
    ctx: ToolContext,
    createdAt: Rfc3339UtcTimestamp,
  ): Promise<Uuid> {
    const inputDigest = sha256DigestOf(
      canonicalJson({
        kind: 'ingestion',
        sourceRef: ANCHOR_SOURCE_REF,
        documentRef: ANCHOR_DOCUMENT_REF,
        datasetRef: null,
        pipelineVersion: ANCHOR_PIPELINE_VERSION,
      }),
    )
    const record: NewLogicalJobRecord = {
      jobId: this.#newId(),
      kind: 'ingestion',
      sourceRef: ANCHOR_SOURCE_REF,
      documentRef: ANCHOR_DOCUMENT_REF,
      pipelineVersion: ANCHOR_PIPELINE_VERSION,
      idempotencyKey: ANCHOR_IDEMPOTENCY_KEY,
      inputDigest,
      counts: EMPTY_JOB_COUNTS,
      createdAt,
      createdBy: ctx.principal.subjectId,
    }
    const result = await this.#jobs.insertJob(scopeRef, record, ctx).catch(mapStoreError)
    return result.job.jobId
  }

  #outbox(
    topic: string,
    payload: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
    recordedAt: Rfc3339UtcTimestamp,
  ): NewOutboxMessage {
    return {
      outboxId: this.#newId(),
      topic,
      payload,
      idempotencyKey,
      availableAt: recordedAt,
      createdAt: recordedAt,
    }
  }
}
