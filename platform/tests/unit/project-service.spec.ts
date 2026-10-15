import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryIndustryPackCatalogue, InMemoryJobStore, InMemoryProjectReadinessStore, ProjectService } from '@ontology/application'
import {
  ProjectStoreError,
  isToolContext,
} from '@ontology/contracts'
import type {
  AppendProjectRevisionInput,
  CreateProjectInput as StoreCreateProjectInput,
  FieldConfirmationEventRecord,
  MappingRef,
  PackAsset,
  ProjectListFilter,
  ProjectRecord,
  ProjectRevision,
  ProjectStore,
  ProjectWriteResult,
  ResourceRef,
  RevisionString,
  ScopeRef,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { toolContext } from './component-registry-fixtures'

const TENANT = '11111111-1111-4111-8111-111111111111'
const SPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222'
const OTHER_SPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const RECORDED_AT = '2026-09-30T00:00:00Z'

function sha(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`
}

function versionRef(id: string, seed: string): VersionRef {
  return { id, version: '1.0.0', digest: sha(seed) }
}

function resourceRef(id: string): ResourceRef {
  return { id, version: '1.0.0', digest: sha('a'), kind: 'artifact' }
}

function mappingRef(id: string): MappingRef {
  return {
    id,
    version: '1.0.0',
    digest: sha('c'),
    role: 'catalog',
    sourceObjectRef: { sourceRef: { namespace: 'test', sourceId: 'src-1' }, objectPath: 'records' },
  }
}

function packAsset(packId: string, version: string, seed: string): PackAsset {
  const ref: VersionRef = { id: packId, version, digest: sha(seed) }
  return {
    ref,
    manifest: {
      namespace: `demo.${packId}`,
      maturity: 'stable',
      standardProvenance: [
        { standardRef: versionRef('standard', 'b'), provenanceKind: 'industry_standard' },
      ],
      definitionsRef: versionRef(`${packId}-definition`, seed),
      identityPolicyRef: versionRef(`${packId}-identity`, 'd'),
      rulePolicyRef: versionRef(`${packId}-rule`, 'e'),
      queryTemplatesRef: versionRef(`${packId}-query`, 'f'),
      requiredCapabilities: [{ name: 'structured_query', versionRange: { min: '0.2.0' } }],
      testSuiteRef: versionRef(`${packId}-suite`, 'g'),
    },
    testSuite: { ref: versionRef(`${packId}-suite`, 'g'), cases: [] },
  }
}

/** A compact in-memory ProjectStore: append-only revisions and a CAS head. */
class InMemoryProjectStore implements ProjectStore {
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
    const projectId = input.projectId
    const projectKey = this.#projectKey(scopeRef, projectId)
    const project: ProjectRecord = {
      projectId,
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
    revision: RevisionString,
    ctx: ToolContext,
  ): Promise<ProjectRevision | undefined> {
    this.#assertTrusted(scopeRef, ctx)
    const revisions = this.#revisions.get(this.#projectKey(scopeRef, projectId)) ?? []
    const found = revisions.find((entry) => entry.ref.revision === revision)
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
    if (input.revision.ref.revision !== next) {
      throw new ProjectStoreError('INVALID_REVISION', `expected ${next}`)
    }
    const updated: ProjectRecord = { ...project, headRevision: next, updatedAt: input.recordedAt }
    this.#projects.set(projectKey, updated)
    const revisions = this.#revisions.get(projectKey) ?? []
    revisions.push(structuredClone(input.revision))
    this.#revisions.set(projectKey, revisions)
    this.#appendKeys.set(key, { digest: input.requestDigest, ref: projectKey })
    return { project: structuredClone(updated), revision: structuredClone(input.revision), created: true }
  }

  async appendFieldConfirmation(): Promise<FieldConfirmationEventRecord> {
    throw new Error('field confirmations are out of scope for this suite')
  }

  async listFieldConfirmations(): Promise<FieldConfirmationEventRecord[]> {
    return []
  }
}

interface Harness {
  readonly service: ProjectService
  readonly catalogue: InMemoryIndustryPackCatalogue
  readonly readiness: InMemoryProjectReadinessStore
  readonly projects: ProjectStore
}

function harness(): Harness {
  const catalogue = new InMemoryIndustryPackCatalogue()
  const projects = new InMemoryProjectStore()
  const readiness = new InMemoryProjectReadinessStore()
  const service = new ProjectService({
    projects,
    readiness,
    jobs: new InMemoryJobStore(),
    catalogue,
    newId: () => randomUUID(),
    now: () => RECORDED_AT,
  })
  return { service, catalogue, readiness, projects }
}

const ctx = toolContext(TENANT, SPACE, ['platform-admin'])
const otherCtx = toolContext(OTHER_TENANT, OTHER_SPACE, ['platform-admin'])

function createInput(packRef: VersionRef): Parameters<ProjectService['createProject']>[0] {
  return {
    title: 'Bridge costing project',
    industryPackRef: packRef,
    profileRef: { id: 'profile-1', version: '1.0.0', snapshotHash: sha('f') },
    mappingRefs: [mappingRef('mapping-1')],
    documentSetRef: resourceRef(randomUUID()),
  }
}

async function createWithPack(h: Harness, pack: PackAsset): Promise<{ projectId: Uuid; revision: ProjectRevision }> {
  h.catalogue.registerPack(pack)
  const result = await h.service.createProject(createInput(pack.ref), `key-${randomUUID()}`, 'tester', ctx)
  return { projectId: result.project.projectId, revision: result.revision }
}

describe('ProjectService (unit)', () => {
  it('binds the exact published pack and never auto-switches to a newer version', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    const v2 = packAsset('demo-pack', '1.1.0', '2')
    const { projectId, revision } = await createWithPack(h, v1)
    expect(revision.industryPackRef.digest).toBe(v1.ref.digest)
    expect(revision.definitionRef.digest).toBe(v1.manifest.definitionsRef.digest)

    // A newer industry version becomes available but the pinned project is untouched.
    h.catalogue.registerPack(v2)
    const project = await h.service.getProject(projectId, ctx)
    expect(project.headRevision).toBe('1')
    const stored = await h.service.getRevisionView(projectId, '1', ctx)
    expect(stored.revision.industryPackRef.version).toBe('1.0.0')
  })

  it('mounts a published pack version as a new immutable revision and keeps the old one readable', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    const v2 = packAsset('demo-pack', '1.1.0', '2')
    const { projectId } = await createWithPack(h, v1)
    h.catalogue.registerPack(v2)

    const mounted = await h.service.mountPackVersion(
      projectId,
      { expectedRevision: '1', industryPackRef: v2.ref, reason: 'switch to 1.1.0' },
      `mount-${randomUUID()}`,
      'editor',
      ctx,
    )
    expect(mounted.revision.ref.revision).toBe('2')
    expect(mounted.changes).toContain('industryPackRef')
    expect(mounted.changes).toContain('definitionRef')
    expect(mounted.readinessInvalidated).toContain('published_semantics')

    const oldRevision = await h.service.getRevisionView(projectId, '1', ctx)
    expect(oldRevision.revision.industryPackRef.version).toBe('1.0.0')
    expect(oldRevision.historical).toBe(true)
    const newRevision = await h.service.getRevisionView(projectId, '2', ctx)
    expect(newRevision.revision.industryPackRef.version).toBe('1.1.0')
    expect(newRevision.historical).toBe(false)
  })

  it('rejects mounting a pack version that is not published in scope', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    const { projectId } = await createWithPack(h, v1)
    const unpublished = packAsset('demo-pack', '2.0.0', '9')
    await expect(
      h.service.mountPackVersion(
        projectId,
        { expectedRevision: '1', industryPackRef: unpublished.ref, reason: 'unknown pack' },
        `mount-${randomUUID()}`,
        'editor',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'PACK_NOT_PUBLISHED' })
  })

  it('reports a not-synced project as not queryable and clears only when the projection is ready', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    const { projectId } = await createWithPack(h, v1)

    const initial = await h.service.evaluateTaskReadiness(projectId, undefined, ['dataset'], ctx)
    expect(initial.ready).toBe(false)
    expect(initial.blockers).toMatchObject([{ code: 'READINESS_NOT_BUILT', readinessKind: 'dataset', retryable: true }])

    await h.service.recordReadiness(
      projectId,
      {
        revision: '1',
        kind: 'dataset',
        targetRef: resourceRef(randomUUID()),
        state: 'pending',
        completeness: 'unknown',
        expectedCount: 10,
        processedCount: 0,
        failedCount: 0,
        targetDigest: sha('1'),
        fenceRevision: '2',
      },
      `readiness-${randomUUID()}`,
      'operator',
      ctx,
    )
    const pending = await h.service.evaluateTaskReadiness(projectId, undefined, ['dataset'], ctx)
    expect(pending.ready).toBe(false)
    expect(pending.blockers).toMatchObject([{ code: 'READINESS_PENDING', readinessKind: 'dataset' }])

    await h.service.recordReadiness(
      projectId,
      {
        revision: '1',
        kind: 'dataset',
        targetRef: resourceRef(randomUUID()),
        state: 'ready',
        completeness: 'complete',
        expectedCount: 10,
        processedCount: 10,
        failedCount: 0,
        targetDigest: sha('1'),
        fenceRevision: '2',
      },
      `readiness-${randomUUID()}`,
      'operator',
      ctx,
    )
    const ready = await h.service.evaluateTaskReadiness(projectId, undefined, ['dataset'], ctx)
    expect(ready.ready).toBe(true)
    expect(ready.blockers).toHaveLength(0)

    // The general readiness surface still reports the unbuilt semantic/index projections.
    const all = await h.service.getReadiness(projectId, '1', undefined, ctx)
    expect(all.ready).toBe(false)
    expect(all.blockers.map((blocker) => blocker.readinessKind)).toEqual(['document_index', 'published_semantics'])
  })

  it('refuses a stale readiness fence so a late build cannot reactivate a revoked projection', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    const { projectId } = await createWithPack(h, v1)
    const record = (state: 'ready' | 'revoked', fence: string) =>
      h.service.recordReadiness(
        projectId,
        {
          revision: '1',
          kind: 'document_index',
          targetRef: resourceRef(randomUUID()),
          state,
          completeness: state === 'ready' ? 'complete' : 'unknown',
          expectedCount: 3,
          processedCount: state === 'ready' ? 3 : 0,
          failedCount: 0,
          targetDigest: sha('3'),
          fenceRevision: fence,
        },
        `readiness-${randomUUID()}`,
        'operator',
        ctx,
      )
    await record('ready', '5')
    await record('revoked', '6')
    await expect(record('ready', '5')).rejects.toMatchObject({ code: 'READINESS_CONFLICT' })
    const view = await h.service.evaluateTaskReadiness(projectId, '1', ['document_index'], ctx)
    expect(view.ready).toBe(false)
    expect(view.blockers).toMatchObject([{ code: 'READINESS_REVOKED', retryable: false }])
  })

  it('rejects a stale CAS append and keeps the project scoped', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    const { projectId } = await createWithPack(h, v1)
    await expect(
      h.service.appendRevision(
        projectId,
        { expectedRevision: '0', reason: 'stale' },
        `append-${randomUUID()}`,
        'editor',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })

    await expect(h.service.getProject(projectId, otherCtx)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    await expect(
      h.service.mountPackVersion(
        projectId,
        { expectedRevision: '1', industryPackRef: v1.ref, reason: 'cross scope' },
        `mount-${randomUUID()}`,
        'editor',
        otherCtx,
      ),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })

  it('requires an If-Match revision to append', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    const { projectId } = await createWithPack(h, v1)
    await expect(
      h.service.appendRevision(
        projectId,
        { expectedRevision: undefined, reason: 'no etag' },
        `append-${randomUUID()}`,
        'editor',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'REVISION_REQUIRED' })
  })

  it('forbids a principal without an editor role from creating a project', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    h.catalogue.registerPack(v1)
    const business = toolContext(TENANT, SPACE, ['business-user'])
    await expect(
      h.service.createProject(createInput(v1.ref), `key-${randomUUID()}`, 'business', business),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('does not persist the mutation when the store rejects it', async () => {
    const h = harness()
    const v1 = packAsset('demo-pack', '1.0.0', '1')
    const { projectId } = await createWithPack(h, v1)
    const revisionsBefore = await h.service.listRevisions(projectId, ctx)
    expect(revisionsBefore.map((entry) => entry.ref.revision)).toEqual(['1'])
    await expect(
      h.service.appendRevision(
        projectId,
        { expectedRevision: '0', reason: 'stale' },
        `append-${randomUUID()}`,
        'editor',
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' })
    const revisionsAfter = await h.service.listRevisions(projectId, ctx)
    expect(revisionsAfter.map((entry) => entry.ref.revision)).toEqual(['1'])
  })
})
