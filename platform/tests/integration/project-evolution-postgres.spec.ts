import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FileSystemObjectStore, LocalImmutableBlobStore, PostgresArtifactRegistry } from '@ontology/adapter-blob-local'
import { ControlPostgresDatabase, PostgresProjectEvolutionStore, PostgresRunExecutionBindingStore, PostgresPublishedTaskBindingStore } from '@ontology/adapter-control-postgres'
import { PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { DuckDbProjectDatasetAdapter } from '@ontology/adapter-data-duckdb'
import { PostgresProjectDatasetAdapter } from '@ontology/adapter-data-postgres'
import { projectEvolutionImpacts, sha256DigestOf, ProjectService } from '@ontology/application'
import { createApiServer, createBlobArtifactWriter, createCoreProjectQueryWorkflow, createInstanceIdentityWorkflow, createProjectEvolutionWorkflow } from '@ontology/app-api'
import { ProjectEvolutionOutboxConsumer } from '@ontology/app-worker'
import { InMemoryIdentityIndexReader, definitionVersionDigest, projectIndustrySchema, ProjectSemanticQueryService, projectSnapshotMappingRef } from '@ontology/semantic-engine'
import type { DefinitionRevisionStrategyKind, PackAsset, ProjectDatasetQueryPort, ProjectDatasetWriterPort, SemanticDefinitionVersion } from '@ontology/contracts'
import { createToolContext, projectDatasetSourceRef } from '@ontology/contracts'
import { createJobScope, startJobDatabase } from './job-postgres-harness'
import type { JobDbHarness } from './job-postgres-harness'
import { seedIdentityProject } from './instance-identity-fixtures'
import { relationDefinition } from '../unit/rule-relation-fixtures'
import { toolContext } from '../unit/component-registry-fixtures'
import { projectQueryPublicationFixture } from './project-query-publication-fixtures'
let harness: JobDbHarness, db: ControlPostgresDatabase, structured: PostgresStructuredIngestionStore, registry: PostgresArtifactRegistry, blobs: LocalImmutableBlobStore
let directory = ''
beforeAll(async () => {
    harness = await startJobDatabase()
    db = new ControlPostgresDatabase({
        connectionString: harness.appUrl, maxPoolSize: 8
    })
    structured = new PostgresStructuredIngestionStore({
        connectionString: harness.appUrl, maxPoolSize: 2
    })
    registry = new PostgresArtifactRegistry({
        connectionString: harness.appUrl, maxPoolSize: 2
    })
    directory = await mkdtemp(join(tmpdir(), 'project-evolution-'))
    const objects = new FileSystemObjectStore(directory)
    await objects.init()
    blobs = new LocalImmutableBlobStore({
        objectStore: objects, registry
    })
}, 300000)
afterAll(async () => {
    await structured?.close()
    await registry?.close()
    await db?.close()
    if (directory !== '')
        await rm(directory, {
            recursive: true, force: true
        })
    await harness?.stop()
})
async function fixture(label: string, strategy: DefinitionRevisionStrategyKind = 'new_version', changeRelation = false, invalidReading = false, multiObject = false) {
    const scoped = await createJobScope(harness.adminClient, label), scope = scoped.scopeRef
    const ctx = createToolContext({
        ...toolContext(scope.tenantId, scope.spaceId, ['platform-admin', 'profile-editor', 'operator', 'semantic-reviewer', 'semantic-publisher']), deadline: new Date(Date.now() + 600000).toISOString()
    })
    const projectId = randomUUID(), definition = relationDefinition(scope)
    const nextBody = {
        ...definition, version: '2.0.0', definitionId: strategy === 'keep_independent' ? 'independent-definition' : definition.definitionId, ref: {
            ...definition.ref, id: strategy === 'keep_independent' ? 'independent-definition' : definition.ref.id, version: '2.0.0'
        }, attributes: [...definition.attributes, {
                kind: 'attribute' as const, namespace: definition.namespace, standardProvenance: [], id: 'reading', objectId: 'meter', valueType: 'number' as const, cardinality: {
                    min: 1, max: 1
                }
            }], relations: changeRelation ? definition.relations.map((relation) => ({
            ...relation, fromObjectId: 'meter'
        })) : definition.relations
    }
    const next: SemanticDefinitionVersion = {
        ...nextBody, ref: {
            ...nextBody.ref, digest: definitionVersionDigest(nextBody)
        }
    }
    await seedIdentityProject(harness.adminClient, scope, projectId, definition.ref)
    const p = projectQueryPublicationFixture({
        db, blobs, structured, scope, ctx, projectId, definition, additionalDefinitions: [next]
    })
    let source = await p.importCsv('meter', `device,power,on,reading\nM-1,12.000000000000001,true,${invalidReading ? 'not-a-number' : '9007199254740993'}\nM-2,0.000000000000001,false,-0.123456789012\n`, ['meter_id', 'power', 'active', ''], {
        power: 'kW'
    })
    const site = multiObject ? await p.importCsv('site', 'site_code\nS-1\n', ['site_id']) : undefined
    if (site !== undefined)
        source = await p.restage(source)
    await p.approveAndPublish(source)
    if (site !== undefined)
        await p.approveAndPublish(site)
    // Controlled immutable catalogue fixture. Source rows, reviews, identities, facts and snapshots are real PG.
    const pack: PackAsset = {
        ref: {
            id: strategy === 'keep_independent' ? 'independent-pack' : 'evolution-pack', version: '2.0.0', digest: next.ref.digest
        }, manifest: {
            namespace: next.namespace, maturity: 'stable', standardProvenance: [], definitionsRef: next.ref, identityPolicyRef: next.ref, rulePolicyRef: next.ref, queryTemplatesRef: next.ref, requiredCapabilities: [], testSuiteRef: next.ref
        }, testSuite: {
            ref: next.ref, cases: []
        }
    }
    const entries = [...source.mapping.entries, {
            fieldRef: 'reading', header: 'reading', headerDigest: sha256DigestOf('reading'), columnIndex: 3
        }]
    const start = {
        expectedRevision: multiObject ? '3' : '2', industryPackRef: pack.ref, strategy: {
            kind: strategy, reason: 'human chose explicit ontology evolution', ...(strategy === 'retire_previous' ? {
                supersedesRef: definition.ref
            } : {})
        }, remappings: [{
                mappingRef: source.mapping.ref, documentId: source.documentId, objectId: 'meter', entries
            }, ...(site === undefined ? [] : [{
                    mappingRef: site.mapping.ref, documentId: site.documentId, objectId: 'site', entries: site.mapping.entries
                }])], maxRecords: multiObject ? 3 : 2, maxAttempts: 2
    }
    const identity = createInstanceIdentityWorkflow({
        service: p.instanceService, projects: p.projects, projectDocuments: p.documents, candidates: p.candidates, identityStore: p.identities, schemaSource: p.schemas, identityMappingRef: definition.ref, index: new InMemoryIdentityIndexReader([])
    })
    const evolve = (backend: ProjectDatasetQueryPort & ProjectDatasetWriterPort, instances = identity, inputWriter = createBlobArtifactWriter(blobs)) => {
        const store = new PostgresProjectEvolutionStore(db)
        const { service, dataset } = createProjectEvolutionWorkflow({
            projects: p.projects, store, mappings: p.mappings, records: p.records, mappingService: p.mappingService, documents: p.documents, catalogue: {
                listEntries: async () => [], findPack: async () => pack
            }, schemas: p.schemas, jobs: p.jobs, facts: p.workflow.materialization, candidates: p.candidates, publications: p.publications, publishedSource: p.publishedSource, readiness: p.readiness, dataset: {
                writer: backend, query: backend
            }, input: {
                writer: inputWriter, reader: {
                    read: async (request, ctx) => blobs.readAuthorized({
                        scopeRef: {
                            tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId
                        }, blobRef: request.approvedInputRefs[0]!
                    }, ctx)
                }, instances: p.instances
            }, instances
        })
        return {
            service, store, dataset
        }
    }
    const humanReview = async (ids: readonly string[]) => {
        for (const id of ids) {
            const candidate = await p.candidates.getCandidate(scope, id, ctx)
            if (candidate?.kind !== 'entity')
                throw new Error('rebuilt entity missing')
            const record = await p.instances.getRecord(scope, projectId, id, ctx)
            if (record === undefined)
                throw new Error('pending human record missing')
            const confirmed = await p.instanceService.confirmFields(scope, projectId, id, {
                expectedRevision: record.recordRevision, decisions: record.fields.map((f) => ({
                    fieldId: f.fieldId, decision: 'confirm'
                })), idempotencyKey: `evolve-fields-${id}`
            }, ctx)
            await identity.adjudicateIdentity(scope, projectId, id, {
                expectedRevision: confirmed.record.recordRevision, kind: 'create', reason: 'human checked the new definition identity', idempotencyKey: `evolve-identity-${id}`
            }, ctx)
            await p.workflow.publication.reviewCandidate({
                candidateId: id, expectedRevision: '0', decision: 'approve', reason: 'human reviewed every original field including the new attribute'
            }, ctx)
        }
        await p.workflow.publication.publish({
            approvedCandidateRefs: ids.map((candidateId) => ({
                kind: 'entity' as const, candidateId
            })), schemaRef: next.ref, expectedRevision: await p.publications.latestPublicationRevision(scope, ctx), idempotencyKey: `evolve-publication-${projectId}`
        }, ctx)
    }
    return {
        ...p, scope, ctx, projectId, source, site, next, pack, start, evolve, humanReview
    }
}
describe('explicit ontology evolution over actual original sources and human facts (PostgreSQL)', () => {
    it('keeps a genuine same-content reapproval readable both between approved-input archive/CAS and after ready', async () => {
        const p = await fixture('evolve-reapprove'), backend = new DuckDbProjectDatasetAdapter(), writer = createBlobArtifactWriter(blobs)
        let selected: readonly string[] = []
        let raced = false
        const reapprove = async (reason: string) => {
            for (const candidateId of selected)
                await p.workflow.publication.reviewCandidate({
                    candidateId, expectedRevision: await p.publications.latestReviewRevision(p.scope, candidateId, p.ctx), decision: 'approve', reason
                }, p.ctx)
        }
        const inputWriter = {
            putBytes: async (...args: Parameters<typeof writer.putBytes>) => {
                const result = await writer.putBytes(...args)
                const body: unknown = JSON.parse(new TextDecoder().decode(args[0].content))
                if (!raced && typeof body === 'object' && body !== null && 'schemaVersion' in body && body.schemaVersion === 'project-input-snapshot@1') {
                    raced = true
                    await reapprove('human reaffirmed unchanged content after actual input artifact write')
                }
                return result
            }
        }
        try {
            const { service, dataset } = p.evolve(backend, undefined, inputWriter)
            await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const plan = await service.start(p.projectId, p.start, `reapprove-${randomUUID()}`, p.ctx), pending = await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)
            selected = pending.candidateIds
            await p.humanReview(selected)
            const ready = await service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)
            expect(raced).toBe(true)
            const revision = await p.projects.getRevision(p.scope, p.projectId, ready.plan.targetRevisionRef.revision, p.ctx)
            if (revision === undefined)
                throw new Error('activated revision missing')
            expect(await service.resolveApprovedInput(p.scope, revision, p.ctx)).toEqual(ready.inputSnapshotRef)
            await reapprove('human reaffirmed the same content after the project was already ready')
            expect(await service.resolveApprovedInput(p.scope, revision, p.ctx)).toEqual(ready.inputSnapshotRef)
            await p.workflow.publication.reviewCandidate({
                candidateId: selected[0]!, expectedRevision: await p.publications.latestReviewRevision(p.scope, selected[0]!, p.ctx), decision: 'reject', reason: 'human explicitly revoked this candidate'
            }, p.ctx)
            await expect(service.resolveApprovedInput(p.scope, revision, p.ctx)).rejects.toMatchObject({
                code: 'READINESS_CONFLICT'
            })
        }
        finally {
            backend.close()
        }
    }, 120000)
    it('rebuilds two objects from their own originals and keeps both exact new object snapshots queryable', async () => {
        const p = await fixture('evolve-multiple-objects', 'new_version', false, false, true), backend = new DuckDbProjectDatasetAdapter()
        try {
            const { service, dataset } = p.evolve(backend)
            await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const plan = await service.start(p.projectId, p.start, `multi-object-${randomUUID()}`, p.ctx), staged = await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)
            expect(staged).toMatchObject({
                recordOperations: 3, batches: 2
            })
            expect(staged.candidateIds).toHaveLength(3)
            await p.humanReview(staged.candidateIds)
            const activated = await service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)
            expect(activated.snapshots?.map((snapshot) => snapshot.objectId)).toEqual(['meter', 'site'])
            const meters = await dataset.queryActive({
                projectId: p.projectId, objectId: 'meter'
            }, p.ctx), sites = await dataset.queryActive({
                projectId: p.projectId, objectId: 'site'
            }, p.ctx)
            expect(meters.rows.map((row) => row.values['reading']?.value).sort()).toEqual(['-0.123456789012', '9007199254740993'])
            expect(sites.rows.map((row) => row.values['site_id']?.value)).toEqual(['S-1'])
            expect(meters.snapshotRef).not.toEqual(sites.snapshotRef)
            const revision = await p.projects.getRevision(p.scope, p.projectId, plan.plan.targetRevisionRef.revision, p.ctx)
            const resolver = createCoreProjectQueryWorkflow({
                query: backend, publishedSource: p.publishedSource, projects: p.projects, readiness: p.readiness, executionBindings: new PostgresRunExecutionBindingStore(db), taskBindings: new PostgresPublishedTaskBindingStore(db), definition: async (_scope, ref) => [p.definition, p.next].find((definition) => definition.ref.digest === ref.digest), evolution: service
            })
            expect(await resolver.resolveForCreation(p.scope, revision!, {
                objectId: 'meter'
            }, p.ctx)).toEqual(meters.snapshotRef)
            expect(await resolver.resolveForCreation(p.scope, revision!, {
                objectId: 'site'
            }, p.ctx)).toEqual(sites.snapshotRef)
        }
        finally {
            backend.close()
        }
    }, 120000)
    it('fences every original optional-field statement after staging and refuses publication/CAS after withdrawal', async () => {
        const p = await fixture('evolve-optional-withdraw'), backend = new DuckDbProjectDatasetAdapter()
        try {
            const { service, dataset } = p.evolve(backend), old = await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const oldRows = await dataset.query({
                projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef!
            }, p.ctx)
            const field = oldRows.rows[0]?.sources.find((source) => source.fieldId === 'power')
            if (field?.statementId === undefined)
                throw new Error('actual optional-field source statement missing')
            const plan = await service.start(p.projectId, p.start, `optional-withdraw-${randomUUID()}`, p.ctx)
            expect(plan.plan.sources.flatMap((source) => source.previousStatements).some((pin) => pin.statementId === field.statementId && pin.version === field.statementVersion)).toBe(true)
            const staged = await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)
            await p.humanReview(staged.candidateIds)
            await p.workflow.publication.reviseStatement({
                statementId: field.statementId, kind: 'retraction', expectedRevision: field.statementVersion!, idempotencyKey: `optional-field-withdraw-${p.projectId}`, reason: 'human withdrew the source of the optional power field after staging'
            }, p.ctx)
            await expect(service.assertActiveRebuild(p.scope, old.projectRevisionRef, p.ctx)).rejects.toMatchObject({
                code: 'SOURCE_UNREADABLE'
            })
            await expect(service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)).rejects.toMatchObject({
                code: 'SOURCE_UNREADABLE'
            })
            expect((await p.projects.getProject(p.scope, p.projectId, p.ctx))?.activeRevision).toBe(old.projectRevisionRef.revision)
            expect((await dataset.query({
                projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef!
            }, p.ctx)).rows).toEqual(oldRows.rows)
        }
        finally {
            backend.close()
        }
    }, 120000)
    it.each(['duckdb', 'postgres'] as const)('reextracts an originally unmapped attribute, activates %s and preserves exact old recorded snapshots', async (backendKind) => {
        const p = await fixture(`evolve-${backendKind}`)
        const backend = backendKind === 'duckdb' ? new DuckDbProjectDatasetAdapter() : new PostgresProjectDatasetAdapter({
            connectionString: harness.adminUrl, schema: `evolution_${randomUUID().replaceAll('-', '')}`
        })
        try {
            const { service, store, dataset } = p.evolve(backend)
            const old = await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const oldRows = await dataset.query({
                projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef!
            }, p.ctx)
            const key = `evolution-${randomUUID()}`
            let plan
            if (backendKind === 'duckdb') {
                const app = createApiServer({
                    authenticate: () => ({
                        principal: p.ctx.principal, spaceId: p.scope.spaceId
                    }), projects: {
                        service: new ProjectService({
                            projects: p.projects, readiness: p.readiness, jobs: p.jobs, catalogue: {
                                listEntries: async () => [], findPack: async () => p.pack
                            }, evolutionPolicy: 'staged_only'
                        }), evolution: service
                    }
                })
                try {
                    await app.ready()
                    const blocked = await app.inject({
                        method: 'POST', url: `/api/v1/projects/${p.projectId}/pack-mounts`, headers: {
                            'if-match': '2', 'idempotency-key': `legacy-${key}`
                        }, payload: {
                            industryPackRef: p.pack.ref, reason: 'instant legacy switch'
                        }
                    })
                    expect(blocked.statusCode).toBe(400)
                    const { expectedRevision, ...body } = p.start
                    const absent = await app.inject({
                        method: 'POST', url: `/api/v1/projects/${p.projectId}/evolve`, headers: {
                            'idempotency-key': key
                        }, payload: body
                    })
                    expect(absent.statusCode).toBe(428)
                    const accepted = await app.inject({
                        method: 'POST', url: `/api/v1/projects/${p.projectId}/evolve`, headers: {
                            'if-match': expectedRevision, 'idempotency-key': key
                        }, payload: body
                    })
                    expect(accepted.statusCode).toBe(202)
                    const foreignApproval = await app.inject({
                        method: 'POST', url: `/api/v1/projects/${p.projectId}/evolutions`, headers: {
                            'if-match': '2', 'idempotency-key': key
                        }, payload: {
                            ...body, approved: true, actor: 'forged'
                        }
                    })
                    expect(foreignApproval.statusCode).toBe(400)
                    plan = await service.start(p.projectId, p.start, key, p.ctx)
                }
                finally {
                    await app.close()
                }
            }
            else
                plan = await service.start(p.projectId, p.start, key, p.ctx)
            expect(plan.plan.impacts).toContainEqual({
                kind: 'attribute', logicalId: 'meter.reading', change: 'added', handling: 'reextract_review'
            })
            expect(await service.start(p.projectId, p.start, key, p.ctx)).toEqual(plan)
            await expect(service.start(p.projectId, {
                ...p.start, maxRecords: 3
            }, key, p.ctx)).rejects.toMatchObject({
                code: 'IDEMPOTENCY_CONFLICT'
            })
            expect(await p.projects.getProject(p.scope, p.projectId, p.ctx)).toMatchObject({
                headRevision: '3', activeRevision: '2'
            })
            const message = (await p.jobs.listPendingOutbox(p.scope, 250, new Date().toISOString(), p.ctx)).find((entry) => entry.topic === 'project.evolution.requested' && entry.jobId === plan.plan.jobId)
            if (message === undefined)
                throw new Error('the atomic evolution outbox was not stored')
            await new ProjectEvolutionOutboxConsumer(service).consume(message, p.ctx)
            const staged = await service.get(p.projectId, plan.plan.evolutionId, p.ctx)
            expect(staged).toMatchObject({
                state: 'awaiting_review', attempts: 1, recordOperations: 2, batches: 1
            })
            expect(staged.candidateIds).toHaveLength(2)
            expect(await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)).toEqual(staged)
            expect((await dataset.queryActive({
                projectId: p.projectId, objectId: 'meter'
            }, p.ctx)).rows).toEqual(oldRows.rows)
            const resolver = createCoreProjectQueryWorkflow({
                query: backend, publishedSource: p.publishedSource, projects: p.projects, readiness: p.readiness, executionBindings: new PostgresRunExecutionBindingStore(db), taskBindings: new PostgresPublishedTaskBindingStore(db), definition: async (_s, ref) => [p.definition, p.next].find((d) => d.ref.digest === ref.digest), evolution: service
            })
            const oldRevision = await p.projects.getRevision(p.scope, p.projectId, '2', p.ctx)
            expect(await resolver.resolveForCreation(p.scope, oldRevision!, {
                objectId: 'meter'
            }, p.ctx)).toEqual(old.snapshotRef)
            await expect(service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)).rejects.toMatchObject({
                code: 'INPUT_NOT_READY'
            })
            const candidate = await p.candidates.getCandidate(p.scope, staged.candidateIds[0]!, p.ctx)
            if (candidate?.kind !== 'entity')
                throw new Error('rebuilt entity missing')
            expect(candidate.attributes.find((a) => a.attributeId === 'reading')?.decimal).toMatch(/9007199254740993|-0.123456789012/)
            await p.humanReview(staged.candidateIds)
            const ready = await service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)
            expect(ready.state).toBe('ready')
            expect(await p.projects.getProject(p.scope, p.projectId, p.ctx)).toMatchObject({
                headRevision: '3', activeRevision: '3'
            })
            const current = await dataset.queryActive({
                projectId: p.projectId, objectId: 'meter'
            }, p.ctx)
            expect(current.rows.map((r) => r.values['reading']?.value).sort()).toEqual(['-0.123456789012', '9007199254740993'])
            expect(current.rows.flatMap((r) => r.sources).filter((s) => s.fieldId === 'reading').every((s) => s.documentRef.digest === p.source.mapping.originalRef.digest && s.locator.kind === 'table_cell' && s.locator.column === 4)).toBe(true)
            const descriptor = await backend.describeSnapshot(p.scope, current.snapshotRef, p.ctx)
            if (descriptor === undefined)
                throw new Error('the new native query descriptor is missing')
            const sqlCtx = createToolContext({
                ...p.ctx, allowedResources: {
                    ...p.ctx.allowedResources, sourceRefs: [projectDatasetSourceRef(current.snapshotRef.id)], maxRows: 1000
                }
            })
            const queried = await new ProjectSemanticQueryService({
                query: backend
            }).execute({
                descriptor, plan: {
                    mode: 'semantic', concepts: ['meter'], fields: ['meter_id', 'reading'], links: [], filters: [{
                            fieldRef: 'reading', op: 'gte', values: ['9007199254740993']
                        }], orderBy: [{
                            fieldRef: 'meter_id', direction: 'asc'
                        }], limit: 100, mappingVersion: projectSnapshotMappingRef({
                        descriptor
                    })
                }, limits: {
                    maxRows: 100, maxBytes: 1048576, maxDurationMs: 30000
                }
            }, sqlCtx)
            expect(queried.rows.map((row) => row.values)).toEqual([['M-1', backendKind === 'duckdb' ? '9007199254740993.000000000000' : '9007199254740993']])
            expect(queried.columns[1]?.unit).toBeUndefined()
            const newRevision = await p.projects.getRevision(p.scope, p.projectId, '3', p.ctx)
            expect(await resolver.resolveForCreation(p.scope, newRevision!, {
                objectId: 'meter'
            }, p.ctx)).toEqual(current.snapshotRef)
            expect((await dataset.query({
                projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef!
            }, p.ctx)).rows).toEqual(oldRows.rows)
            expect(await backend.getActivation(p.scope, old.snapshotRef!, p.ctx)).toMatchObject({
                factRecordedPoint: expect.any(Object), projectRevisionRef: old.projectRevisionRef
            })
            expect(await store.get(p.scope, p.projectId, plan.plan.evolutionId, p.ctx)).toEqual(ready)
        }
        finally {
            await backend.close()
        }
    }, 120000)
    it.each(['keep_independent', 'retire_previous'] as const)('%s preserves activation history and explicitly changes current visibility', async (strategy) => {
        const p = await fixture(`evolve-policy-${strategy}`, strategy), backend = new DuckDbProjectDatasetAdapter()
        try {
            const { service, dataset } = p.evolve(backend)
            const old = await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const plan = await service.start(p.projectId, p.start, `policy-${randomUUID()}`, p.ctx)
            const staged = await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)
            await p.humanReview(staged.candidateIds)
            await service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)
            expect((await dataset.query({
                projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef!
            }, p.ctx)).rows).toHaveLength(2)
            expect((await p.readiness.getProjection(p.scope, old.projectRevisionRef, 'dataset', p.ctx))?.state).toBe(strategy === 'retire_previous' ? 'revoked' : 'ready')
            if (strategy === 'retire_previous')
                await expect(dataset.queryActive({
                    projectId: p.projectId, revision: '2'
                }, p.ctx)).rejects.toMatchObject({
                    code: 'SNAPSHOT_UNAVAILABLE'
                })
        }
        finally {
            backend.close()
        }
    }, 120000)
    it('bounds budget/retries/concurrent starts, rejects withdrawn sources and prevents cancelled late attempts from activating', async () => {
        const p = await fixture('evolve-failures'), backend = new DuckDbProjectDatasetAdapter()
        try {
            const { service, store, dataset } = p.evolve(backend)
            await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            await expect(service.start(p.projectId, {
                ...p.start, maxRecords: 1
            }, `budget-${randomUUID()}`, p.ctx)).rejects.toMatchObject({
                code: 'INVALID_ARGUMENT'
            })
            const attempts = await Promise.allSettled([service.start(p.projectId, p.start, `concurrent-a-${randomUUID()}`, p.ctx), service.start(p.projectId, p.start, `concurrent-b-${randomUUID()}`, p.ctx)])
            expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
            const selected = attempts.find((r) => r.status === 'fulfilled')
            if (selected?.status !== 'fulfilled')
                throw new Error('no accepted evolution')
            const plan = selected.value
            const claimed = await store.claim(p.scope, p.projectId, plan.plan.evolutionId, p.ctx)
            expect(claimed).toBeDefined()
            await store.checkpoint(p.scope, claimed!, 'failed', [], 'CONTROLLED_FAILURE', p.ctx)
            await service.retry(p.projectId, plan.plan.evolutionId, p.ctx)
            const second = await store.claim(p.scope, p.projectId, plan.plan.evolutionId, p.ctx)
            expect(second).toMatchObject({
                attempts: 2, recordOperations: 4, batches: 2
            })
            await store.checkpoint(p.scope, second!, 'failed', [], 'CONTROLLED_FAILURE', p.ctx)
            await expect(service.retry(p.projectId, plan.plan.evolutionId, p.ctx)).rejects.toMatchObject({
                code: 'VERSION_CONFLICT'
            })
            await service.cancel(p.projectId, plan.plan.evolutionId, p.ctx)
            await expect(store.checkpoint(p.scope, second!, 'awaiting_review', [], undefined, p.ctx)).rejects.toMatchObject({
                code: 'VERSION_CONFLICT'
            })
            await expect(service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)).rejects.toMatchObject({
                code: 'READINESS_CONFLICT'
            })
            expect(await p.projects.getProject(p.scope, p.projectId, p.ctx)).toMatchObject({
                activeRevision: '2', stagingWritable: false
            })
            await p.documents.reviseDocument(p.scope, p.projectId, {
                documentId: p.source.documentId, op: 'retract', reason: 'human withdrew original during rebuild', actor: p.ctx.principal.subjectId, recordedAt: new Date().toISOString()
            }, p.ctx)
            await expect(service.assertActiveRebuild(p.scope, plan.plan.previousRevisionRef, p.ctx)).rejects.toMatchObject({
                code: 'SOURCE_UNREADABLE'
            })
            await expect(service.start(p.projectId, {
                ...p.start, expectedRevision: '3'
            }, `withdrawn-${randomUUID()}`, p.ctx)).rejects.toMatchObject({
                code: 'SOURCE_UNREADABLE'
            })
        }
        finally {
            backend.close()
        }
    }, 120000)
    it('lists identity, type, unit and relation changes as explicit human work', async () => {
        const p = await fixture('evolve-impacts')
        const before = projectIndustrySchema(p.definition), after = projectIndustrySchema(p.next)
        const changed = {
            ...after, objects: after.objects.map((o) => o.objectId !== 'meter' ? o : {
                ...o, identityScopeId: 'new-scope', attributes: o.attributes.map((a) => a.attributeId !== 'power' ? a : {
                    ...a, valueType: 'number' as const, unitCode: 'W', dimension: 'changed-dimension'
                })
            }), relations: after.relations.map((r) => ({
                ...r, toObjectId: 'site'
            }))
        }
        const impacts = projectEvolutionImpacts(before, changed)
        expect(impacts).toEqual(expect.arrayContaining([expect.objectContaining({
                kind: 'identity'
            }), expect.objectContaining({
                kind: 'type'
            }), expect.objectContaining({
                kind: 'unit'
            }), expect.objectContaining({
                kind: 'relation', handling: 'human_relation'
            })]))
    }, 120000)
    it('keeps an unmigratable required field explicitly needs_human without approving or activating it', async () => {
        const p = await fixture('evolve-unmigratable', 'new_version', false, true), backend = new DuckDbProjectDatasetAdapter()
        try {
            const { service, dataset } = p.evolve(backend)
            await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const plan = await service.start(p.projectId, p.start, `unmigratable-${randomUUID()}`, p.ctx)
            const pending = await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)
            expect(pending).toMatchObject({
                state: 'needs_human', error: 'INVALID_ARGUMENT', candidateIds: []
            })
            expect((await dataset.queryActive({
                projectId: p.projectId, objectId: 'meter'
            }, p.ctx)).rows).toHaveLength(2)
            await expect(service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)).rejects.toMatchObject({
                code: 'READINESS_CONFLICT'
            })
            await service.retry(p.projectId, plan.plan.evolutionId, p.ctx)
            expect((await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)).recordOperations).toBe(4)
        }
        finally {
            backend.close()
        }
    }, 120000)
    it('does not reextract a withdrawn fact row as a new support from the same original bytes', async () => {
        const p = await fixture('evolve-withdrawn-row'), backend = new DuckDbProjectDatasetAdapter()
        try {
            const withdrawn = p.source.entities.find((candidate) => candidate.attributes.some((a) => a.attributeId === 'meter_id' && a.value === 'M-1'))
            if (withdrawn === undefined)
                throw new Error('original row missing')
            await p.workflow.publication.reviseStatement({
                statementId: withdrawn.candidateId, kind: 'retraction', expectedRevision: '1', idempotencyKey: `evolve-original-withdraw-${p.projectId}`, reason: 'human withdrew this original row'
            }, p.ctx)
            const { service, dataset } = p.evolve(backend)
            const old = await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const plan = await service.start(p.projectId, p.start, `withdrawn-row-${randomUUID()}`, p.ctx)
            expect(plan.plan.sources[0]).toMatchObject({
                expectedRecords: 1, rawRecordCount: 2
            })
            const staged = await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)
            expect(staged.candidateIds).toHaveLength(1)
            await p.humanReview(staged.candidateIds)
            await service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)
            const current = await dataset.queryActive({
                projectId: p.projectId, objectId: 'meter'
            }, p.ctx)
            expect(current.rows.map((r) => r.values['meter_id']?.value)).toEqual(['M-2'])
            expect((await dataset.query({
                projectRevisionRef: old.projectRevisionRef, snapshotRef: old.snapshotRef!
            }, p.ctx)).rows).toHaveLength(1)
            expect((await p.publications.getStatement(p.scope, withdrawn.candidateId, p.ctx))?.status).toBe('retracted')
        }
        finally {
            backend.close()
        }
    }, 120000)
    it('requires real human relation publication before a relation change can activate', async () => {
        const p = await fixture('evolve-relation', 'new_version', true), backend = new DuckDbProjectDatasetAdapter()
        try {
            const { service, dataset } = p.evolve(backend)
            await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const plan = await service.start(p.projectId, p.start, `relation-evolve-${randomUUID()}`, p.ctx), staged = await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)
            await p.humanReview(staged.candidateIds)
            await expect(service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)).rejects.toMatchObject({
                code: 'READINESS_CONFLICT', reasons: ['meter_of']
            })
            const relation = await p.workflow.materialization.stageRelation(p.projectId, {
                relationId: 'meter_of', fromCandidateId: staged.candidateIds[0]!, toCandidateId: staged.candidateIds[1]!
            }, p.ctx)
            await expect(service.activate(p.projectId, plan.plan.evolutionId, [relation.candidateId], p.ctx)).rejects.toMatchObject({
                code: 'READINESS_CONFLICT'
            })
            await p.workflow.publication.reviewCandidate({
                candidateId: relation.candidateId, expectedRevision: '0', decision: 'approve', reason: 'human reviewed new typed relation endpoints'
            }, p.ctx)
            await p.workflow.publication.publish({
                approvedCandidateRefs: [relation], schemaRef: p.next.ref, expectedRevision: await p.publications.latestPublicationRevision(p.scope, p.ctx), idempotencyKey: `evolve-relation-publish-${p.projectId}`
            }, p.ctx)
            expect((await service.activate(p.projectId, plan.plan.evolutionId, [relation.candidateId], p.ctx)).state).toBe('ready')
        }
        finally {
            backend.close()
        }
    }, 120000)
    it('refuses actual staged projection completion after cancellation at the commit boundary', async () => {
        const p = await fixture('evolve-late-cancel')
        let pause = false, release: () => void = () => {
        }, staged: () => void = () => {
        }
        const stagedSignal = new Promise<void>((resolve) => {
            staged = resolve
        }), continueSignal = new Promise<void>((resolve) => {
            release = resolve
        })
        class PausedBackend extends DuckDbProjectDatasetAdapter {
            override async stageSnapshot(...args: Parameters<DuckDbProjectDatasetAdapter['stageSnapshot']>) {
                const result = await super.stageSnapshot(...args)
                if (pause) {
                    staged()
                    await continueSignal
                }
                return result
            }
        }
        const backend = new PausedBackend()
        try {
            const { service, dataset } = p.evolve(backend)
            const old = await dataset.materialize(p.projectId, {
                objectId: 'meter'
            }, p.ctx)
            const plan = await service.start(p.projectId, p.start, `late-cancel-${randomUUID()}`, p.ctx), pending = await service.rebuild(p.projectId, plan.plan.evolutionId, p.ctx)
            await p.humanReview(pending.candidateIds)
            pause = true
            const activation = service.activate(p.projectId, plan.plan.evolutionId, [], p.ctx)
            const rejected = expect(activation).rejects.toMatchObject({
                code: 'MATERIALIZATION_MISMATCH'
            })
            await stagedSignal
            await service.cancel(p.projectId, plan.plan.evolutionId, p.ctx)
            release()
            await rejected
            expect((await service.get(p.projectId, plan.plan.evolutionId, p.ctx)).state).toBe('cancelled')
            expect(await p.projects.getProject(p.scope, p.projectId, p.ctx)).toMatchObject({
                activeRevision: old.projectRevisionRef.revision, stagingWritable: false
            })
            expect((await dataset.queryActive({
                projectId: p.projectId, objectId: 'meter'
            }, p.ctx)).snapshotRef).toEqual(old.snapshotRef)
            expect((await p.readiness.getProjection(p.scope, plan.plan.targetRevisionRef, 'dataset', p.ctx))?.state).not.toBe('ready')
        }
        finally {
            release()
            backend.close()
        }
    }, 120000)
})
