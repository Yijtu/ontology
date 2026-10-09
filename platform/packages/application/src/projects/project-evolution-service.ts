import { createHash } from 'node:crypto'
import { EMPTY_JOB_COUNTS, PROJECT_EVOLUTION_TOPIC, ProjectStoreError, isToolContext, isUuid, isVersionRef, isRevisionString, isDefinitionRevisionStrategy, assertProjectEvolutionPlan } from '@ontology/contracts'
import type { CandidateStore, DefinitionRevisionStrategy, IndustryPackCatalogue, IndustrySchema, IndustrySchemaSource, JobStore, ProjectDocumentStore, ProjectEvolutionImpact, ProjectEvolutionPlan, ProjectEvolutionRecord, ProjectEvolutionSnapshot, ProjectRevision, ProjectEvolutionRemap, ProjectEvolutionStore, ProjectMappingStore, ProjectPublishedDatasetSource, ProjectReadinessStore, ProjectRevisionRef, ProjectStore, ScopeRef, SemanticPublicationStore, ToolContext, VersionRef } from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import { bodyToRevision } from './project-service'
import { ProjectError } from './errors'
import { decodeStructuredExtractionRef, encodeStructuredExtractionRef } from '../jobs/structured-ingestion-ref'
import type { ProjectMappingService } from './project-mapping-service'
import type { ProjectFactMaterializationService } from './project-fact-materialization-service'
import type { ProjectDataMaterializationService } from './project-materialization-service'
import { ProjectEvolutionInputService } from './project-evolution-input'
import type { ProjectEvolutionInputDependencies } from './project-evolution-input'
import { resolvedProfileDigest } from '../profiles/canonical'
import type { ProfileStore, ProjectRecordStore, ResolvedProfileRef, ResourceRef } from '@ontology/contracts'
export interface StartProjectEvolutionInput {
    readonly expectedRevision: string | undefined
    readonly industryPackRef: VersionRef
    readonly strategy: DefinitionRevisionStrategy
    readonly remappings: readonly ProjectEvolutionRemap[]
    readonly maxRecords: number
    readonly maxAttempts: number
    readonly profileRef?: ResolvedProfileRef
}
export interface ProjectEvolutionDependencies {
    readonly previousInput?: {
        archive(scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext): Promise<ResourceRef>
        validate(scope: ScopeRef, revision: ProjectRevision, ref: ResourceRef, ctx: ToolContext): Promise<ResourceRef>
    }
    readonly projects: ProjectStore
    readonly store: ProjectEvolutionStore
    readonly mappings: ProjectMappingStore
    readonly mappingService: ProjectMappingService
    readonly documents: Pick<ProjectDocumentStore, 'getMembership' | 'getVisibility'>
    readonly catalogue: IndustryPackCatalogue
    readonly schemas: IndustrySchemaSource
    readonly jobs: JobStore
    readonly facts: ProjectFactMaterializationService
    readonly candidates: Pick<CandidateStore, 'getCandidate'>
    readonly publications: Pick<SemanticPublicationStore, 'getStatement' | 'latestReadRevision' | 'latestReviewRevision' | 'getReview'>
    readonly publishedSource: ProjectPublishedDatasetSource
    readonly readiness: ProjectReadinessStore
    readonly dataset: ProjectDataMaterializationService
    readonly records: Pick<ProjectRecordStore, 'listRecords'>
    readonly input: Pick<ProjectEvolutionInputDependencies, 'writer' | 'reader' | 'instances'>
    readonly profiles?: Pick<ProfileStore, 'findResolvedProfile'>
    /** Creates pending records through the existing authoritative identity workflow. */
    readonly instances: {
        createRecord(scope: ScopeRef, projectId: string, input: {
            candidateId: string
            documentId: string
            relations: readonly [
            ]
            idempotencyKey: string
        }, ctx: ToolContext): Promise<unknown>
    }
    readonly now?: () => string
}
function scopeOf(ctx: ToolContext): ScopeRef {
    if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId)
        throw new ProjectError('SCOPE_MISMATCH', 'trusted scope is required')
    return {
        tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId
    }
}
function editor(ctx: ToolContext) {
    if (!ctx.principal.roles.some((r) => ['platform-admin', 'profile-editor'].includes(r)))
        throw new ProjectError('FORBIDDEN', 'an editor must choose the evolution strategy')
}
function uuid(seed: string) {
    const h = createHash('sha256').update(seed).digest('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}
function same(a: unknown, b: unknown) {
    return canonicalJson(a) === canonicalJson(b)
}
function storeFailure(error: unknown): never {
    if (error instanceof ProjectStoreError) {
        switch (error.code) {
            case 'REVISION_INVALID':
            case 'INVALID_REVISION':
            case 'INVALID_CONFIRMATION': throw new ProjectError('INVALID_ARGUMENT', error.message, {
                cause: error
            })
            default: throw new ProjectError(error.code, error.message, {
                cause: error
            })
        }
    }
    throw error
}
/** Full schema impact list. No type/unit/identity or relation change is silently inferred. */
export function projectEvolutionImpacts(before: IndustrySchema, after: IndustrySchema): ProjectEvolutionImpact[] {
    const impacts: ProjectEvolutionImpact[] = []
    const add = (kind: ProjectEvolutionImpact['kind'], logicalId: string, change: ProjectEvolutionImpact['change']) => impacts.push({
        kind, logicalId, change, handling: change === 'removed' ? 'retire' : kind === 'relation' ? 'human_relation' : 'reextract_review'
    })
    for (const id of new Set([...before.objects, ...after.objects].map((o) => o.objectId))) {
        const a = before.objects.find((o) => o.objectId === id), b = after.objects.find((o) => o.objectId === id)
        if (a === undefined || b === undefined) {
            add('object', id, a === undefined ? 'added' : 'removed')
            continue
        }
        if (a.identityScopeId !== b.identityScopeId || !same(before.identityScopes.filter((s) => s.objectId === id), after.identityScopes.filter((s) => s.objectId === id)))
            add('identity', id, 'changed')
        for (const field of new Set([...a.attributes, ...b.attributes].map((f) => f.attributeId))) {
            const x = a.attributes.find((f) => f.attributeId === field), y = b.attributes.find((f) => f.attributeId === field)
            if (x === undefined || y === undefined)
                add('attribute', `${id}.${field}`, x === undefined ? 'added' : 'removed')
            else if (!same(x, y)) {
                add('attribute', `${id}.${field}`, 'changed')
                if (x.valueType !== y.valueType)
                    add('type', `${id}.${field}`, 'changed')
                if (x.unitCode !== y.unitCode || x.dimension !== y.dimension)
                    add('unit', `${id}.${field}`, 'changed')
                if (x.identityKey !== y.identityKey)
                    add('identity', `${id}.${field}`, 'changed')
            }
        }
    }
    for (const id of new Set([...before.relations, ...after.relations].map((r) => r.relationId))) {
        const a = before.relations.find((r) => r.relationId === id), b = after.relations.find((r) => r.relationId === id)
        if (!same(a ?? null, b ?? null))
            add('relation', id, a === undefined ? 'added' : b === undefined ? 'removed' : 'changed')
    }
    return impacts
}
/** Explicit, bounded rebuild. Old receipts remain immutable; only the final CAS changes visibility. */
export class ProjectEvolutionService {
    readonly #now: () => string
    readonly #inputs: ProjectEvolutionInputService
    constructor(private readonly deps: ProjectEvolutionDependencies) {
        this.#now = deps.now ?? (() => new Date().toISOString())
        this.#inputs = new ProjectEvolutionInputService({
            ...deps.input, dataset: deps.dataset, candidates: deps.candidates, reviews: deps.publications, records: deps.records
        })
    }
    async start(projectId: string, input: StartProjectEvolutionInput, key: string, ctx: ToolContext): Promise<ProjectEvolutionRecord> {
        editor(ctx)
        const scope = scopeOf(ctx)
        if (input.expectedRevision === undefined)
            throw new ProjectError('REVISION_REQUIRED', 'an If-Match revision is required for evolution')
        if (!isUuid(projectId) || typeof key !== 'string' || key.length < 8 || key.length > 180 || !isRevisionString(input.expectedRevision) || !isVersionRef(input.industryPackRef) || !isDefinitionRevisionStrategy(input.strategy) || !Number.isInteger(input.maxRecords) || input.maxRecords < 1 || input.maxRecords > 20000 || !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 3 || !Array.isArray(input.remappings) || input.remappings.length === 0 || input.remappings.length > 10)
            throw new ProjectError('INVALID_ARGUMENT', 'explicit strategy, If-Match and bounded remappings/record/attempt budgets are required')
        const digest = sha256DigestOf(canonicalJson({
            projectId, input
        }))
        const replay = await this.deps.store.findByKey(scope, projectId, key, ctx)
        if (replay !== undefined) {
            if (replay.plan.requestDigest !== digest)
                throw new ProjectError('IDEMPOTENCY_CONFLICT', 'the evolution key has different input')
            return replay
        }
        const project = await this.deps.projects.getProject(scope, projectId, ctx)
        if (project === undefined || project.state === 'archived')
            throw new ProjectError('PROJECT_NOT_FOUND', 'an existing project is required')
        if (project.headRevision !== input.expectedRevision)
            throw new ProjectError('VERSION_CONFLICT', 'the project head changed')
        const previous = await this.deps.projects.getRevision(scope, projectId, project.activeRevision ?? project.headRevision, ctx)
        const pack = await this.deps.catalogue.findPack(input.industryPackRef.id, input.industryPackRef.version, scope, ctx)
        if (previous === undefined || pack === undefined || !same(pack.ref, input.industryPackRef))
            throw new ProjectError('PACK_NOT_PUBLISHED', 'the exact published target pack is required')
        if (same(previous.definitionRef, pack.manifest.definitionsRef))
            throw new ProjectError('INVALID_ARGUMENT', 'evolution requires a different immutable definition')
        if (input.strategy.kind === 'retire_previous' && !same(input.strategy.supersedesRef, previous.definitionRef))
            throw new ProjectError('INVALID_ARGUMENT', 'retire_previous must name the exact previous definition')
        if (input.strategy.kind === 'keep_independent' && previous.definitionRef.id === pack.manifest.definitionsRef.id)
            throw new ProjectError('INVALID_ARGUMENT', 'keep_independent needs an independent definition identity')
        const before = await this.deps.schemas.getSchema(scope, previous.definitionRef, ctx), after = await this.deps.schemas.getSchema(scope, pack.manifest.definitionsRef, ctx)
        if (before === undefined || after === undefined || !same(before.definitionRef, previous.definitionRef) || !same(after.definitionRef, pack.manifest.definitionsRef))
            throw new ProjectError('INVALID_ARGUMENT', 'both exact definition schemas must be available')
        let profileRef = previous.profileRef
        if (this.deps.profiles !== undefined || input.profileRef !== undefined) {
            if (this.deps.profiles === undefined || input.profileRef === undefined)
                throw new ProjectError('READINESS_CONFLICT', 'a server-resolved compatible target profile is required')
            const resolved = await this.deps.profiles.findResolvedProfile(input.profileRef, input.profileRef.snapshotHash, scope, ctx)
            if (resolved === undefined || resolved.snapshotHash !== input.profileRef.snapshotHash || resolvedProfileDigest(resolved.profileRef, resolved.resolved) !== resolved.snapshotHash || !same(resolved.resolved.industryRef, pack.ref))
                throw new ProjectError('READINESS_CONFLICT', 'the actual resolved profile does not pin this exact published target pack')
            profileRef = input.profileRef
        }
        const visibility = await this.deps.documents.getVisibility(scope, projectId, ctx)
        if (visibility === undefined)
            throw new ProjectError('SOURCE_UNREADABLE', 'original project source visibility is required')
        const sources: ProjectEvolutionPlan['sources'][number][] = []
        const actualOldMappings = await this.deps.mappings.listMappings(scope, projectId, ctx)
        const mounted = actualOldMappings.filter((m) => previous.mappingRefs.some((r) => same(r, m.ref)))
        if (mounted.length !== input.remappings.length || new Set(input.remappings.map((r) => canonicalJson(r.mappingRef))).size !== mounted.length || mounted.some((m) => !input.remappings.some((r) => same(r.mappingRef, m.ref))))
            throw new ProjectError('INVALID_ARGUMENT', 'every mounted original mapping must be explicitly handled exactly once')
        let total = 0
        for (const remap of input.remappings) {
            const original = mounted.find((m) => same(m.ref, remap.mappingRef))
            const member = await this.deps.documents.getMembership(scope, projectId, remap.documentId, ctx)
            if (original === undefined || member?.state !== 'active' || member.parseId !== original.parseId || !same(member.documentRef, original.originalRef))
                throw new ProjectError('SOURCE_UNREADABLE', 'remapping must use its exact active original source')
            const oldFacts = await this.deps.publishedSource.read(scope, previous, original.objectId, ctx)
            const oldRows = oldFacts.rows.filter((row) => row.sources.some((source) => same(source.factSource?.mappingRef, original.ref)))
            if (oldRows.length === 0)
                throw new ProjectError('SOURCE_UNREADABLE', 'this mapping has no current reviewed original records to evolve')
            const statementVersions = new Map<string, string>()
            for (const field of oldRows.flatMap((row) => row.sources).filter((source) => same(source.factSource?.mappingRef, original.ref))) {
                if (field.statementId === undefined || field.statementVersion === undefined || statementVersions.has(field.statementId) && statementVersions.get(field.statementId) !== field.statementVersion)
                    throw new ProjectError('SOURCE_UNREADABLE', 'the complete original fact recorded point is unavailable or conflicting')
                statementVersions.set(field.statementId, field.statementVersion)
            }
            if (statementVersions.size > 20000)
                throw new ProjectError('INVALID_ARGUMENT', 'the original statement-set fence exceeds its bounded cap')
            const previousStatements = [...statementVersions].map(([statementId, version]) => ({
                statementId, version
            }))
            const oldReadiness = await this.deps.readiness.getProjection(scope, previous.ref, 'dataset', ctx)
            if (oldReadiness?.state === 'ready' && 'kind' in oldReadiness.targetRef) {
                const receipt = await this.deps.dataset.activationReceipt(oldReadiness.targetRef, ctx)
                if (receipt?.objectId === original.objectId && receipt.sourceDigest !== oldFacts.sourceDigest)
                    throw new ProjectError('READINESS_CONFLICT', 'rebuild the old current projection after withdrawal/correction before evolving')
            }
            const oldPin = oldFacts.rows.flatMap((r) => r.sources).find((s) => same(s.factSource?.mappingRef, original.ref))?.factSource
            const oldCandidate = oldPin === undefined ? undefined : await this.deps.candidates.getCandidate(scope, oldPin.entityCandidateId, ctx)
            const oldJob = oldCandidate === undefined ? undefined : await this.deps.jobs.getJob(scope, oldCandidate.jobId, ctx)
            if (oldJob === undefined || oldJob.documentRef === undefined || oldJob.kind !== 'ingestion' && !(oldJob.kind === 'dataset_materialization' && oldJob.sourceRef === `project-evolution-source:${projectId}`))
                throw new ProjectError('SOURCE_UNREADABLE', 'the original published extraction job is unavailable')
            const oldInput = decodeStructuredExtractionRef(oldJob.documentRef)
            if (oldInput.parseId !== original.parseId || !same(oldInput.originalRef, original.originalRef) || !same(oldInput.definitionRef, previous.definitionRef))
                throw new ProjectError('SOURCE_UNREADABLE', 'the original job pins differ')
            const proposedSourceJobId = uuid(`evolve-source-job:${scope.tenantId}:${scope.spaceId}:${projectId}:${key}:${original.mappingId}`)
            const documentRef = encodeStructuredExtractionRef({
                ...oldInput, definitionRef: after.definitionRef
            })
            const sourceJob = await this.deps.jobs.insertJob(scope, {
                jobId: proposedSourceJobId, kind: 'dataset_materialization', sourceRef: `project-evolution-source:${projectId}`, documentRef, pipelineVersion: oldJob.pipelineVersion, idempotencyKey: `evolve-source:${proposedSourceJobId}`, inputDigest: sha256DigestOf(canonicalJson({
                    documentRef, pipelineVersion: oldJob.pipelineVersion, sourceRef: `project-evolution-source:${projectId}`
                })), counts: EMPTY_JOB_COUNTS, createdAt: this.#now(), createdBy: ctx.principal.subjectId
            }, ctx)
            const sourceJobId = sourceJob.job.jobId
            const prepared = await this.deps.mappingService.prepareEvolutionMapping(projectId, after.definitionRef, {
                format: original.format, parseId: original.parseId, originalRef: original.originalRef, originalMediaType: original.originalMediaType, options: original.options, objectId: remap.objectId, entries: remap.entries, ...(original.sheetId === undefined ? {} : {
                    sheetId: original.sheetId
                }), ...(original.sheetName === undefined ? {} : {
                    sheetName: original.sheetName
                })
            }, uuid(`${scope.tenantId}:${scope.spaceId}:${projectId}:${key}:${original.mappingId}`), `evolve-map:${uuid(`${scope.tenantId}:${scope.spaceId}:${projectId}:${key}:${original.mappingId}`)}`, ctx)
            total += prepared.preview.rowCount
            if (total > input.maxRecords || prepared.preview.rowCount === 0)
                throw new ProjectError('INVALID_ARGUMENT', 'original re-extraction exceeds the declared record budget')
            sources.push({
                documentId: member.documentId, membershipRevision: member.membershipRevision, visibilityEpoch: visibility.epoch, originalRef: original.originalRef, parseId: original.parseId, previousMappingRef: original.ref, mappingRef: prepared.mapping.ref, objectId: remap.objectId, expectedRecords: oldRows.length, rawRecordCount: prepared.preview.rowCount, recordIds: oldRows.map((row) => row.recordId), previousStatements, sourceJobId
            })
        }
        const previousInputRef = await this.deps.previousInput?.archive(scope, previous, ctx)
        const revision = bodyToRevision({
            schemaVersion: 'project-revision@1', projectId, revision: String(BigInt(project.headRevision) + 1n), industryPackRef: pack.ref, definitionRef: after.definitionRef, mappingRefs: [...previous.mappingRefs.filter((ref) => !mounted.some((mapping) => same(ref, mapping.ref))), ...sources.map((s) => s.mappingRef)], profileRef, documentSetRef: previous.documentSetRef, semanticPublicationRefs: [], sourceVisibilityEpoch: visibility.epoch, changeReason: input.strategy.reason
        })
        const jobId = uuid(`evolution-job:${scope.tenantId}:${scope.spaceId}:${projectId}:${key}`)
        const plan: ProjectEvolutionPlan = {
            ...(previousInputRef === undefined ? {} : { previousInputRef }),
            evolutionId: uuid(`evolution:${scope.tenantId}:${scope.spaceId}:${projectId}:${key}`), jobId, previousRevisionRef: previous.ref, targetRevisionRef: revision.ref, strategy: input.strategy, impacts: projectEvolutionImpacts(before, after), sources, maxAttempts: input.maxAttempts, maxRecordOperations: input.maxRecords * input.maxAttempts, maxBatches: sources.reduce((n, s) => n + Math.ceil(s.expectedRecords / 200), 0) * input.maxAttempts, requestDigest: digest
        }
        assertProjectEvolutionPlan(plan)
        const at = this.#now()
        await this.deps.jobs.insertJob(scope, {
            jobId, kind: 'dataset_materialization', sourceRef: `project-evolution:${projectId}`, datasetRef: `project-evolution:${plan.evolutionId}`, pipelineVersion: '1.0.0', idempotencyKey: `evolution:${plan.evolutionId}`, inputDigest: sha256DigestOf(canonicalJson({
                requestDigest: digest, datasetRef: `project-evolution:${plan.evolutionId}`, pipelineVersion: '1.0.0'
            })), counts: EMPTY_JOB_COUNTS, createdAt: at, createdBy: ctx.principal.subjectId
        }, ctx)
        await this.deps.projects.appendRevision(scope, projectId, {
            expectedRevision: project.headRevision, revision, evolution: plan, idempotencyKey: key, requestDigest: digest, actor: ctx.principal.subjectId, recordedAt: at, outboxJobId: jobId, outbox: {
                outboxId: uuid(`outbox:${plan.evolutionId}`), topic: PROJECT_EVOLUTION_TOPIC, payload: {
                    projectId, evolutionId: plan.evolutionId
                }, idempotencyKey: `evolve:${plan.evolutionId}`, availableAt: at, createdAt: at
            }
        }, ctx).catch(storeFailure)
        return this.get(projectId, plan.evolutionId, ctx)
    }
    async get(projectId: string, id: string, ctx: ToolContext) {
        const record = await this.deps.store.get(scopeOf(ctx), projectId, id, ctx)
        if (record === undefined)
            throw new ProjectError('REVISION_NOT_FOUND', 'the evolution is unavailable')
        return record
    }
    async #sourcePins(scope: ScopeRef, projectId: string, id: string, ctx: ToolContext) {
        try {
            await this.deps.store.assertSources(scope, projectId, id, ctx)
        }
        catch (error) {
            if (error instanceof ProjectStoreError && error.code === 'VERSION_CONFLICT')
                throw new ProjectError('SOURCE_UNREADABLE', error.message, {
                    cause: error
                })
            throw error
        }
    }
    async #pins(record: ProjectEvolutionRecord, ctx: ToolContext) {
        if (Date.parse(ctx.deadline) <= Date.parse(this.#now()))
            throw new ProjectError('READINESS_CONFLICT', 'the evolution deadline expired')
        const scope = scopeOf(ctx), p = record.plan
        const current = await this.deps.projects.getProject(scope, p.targetRevisionRef.projectId, ctx)
        const active = await this.get(p.targetRevisionRef.projectId, p.evolutionId, ctx)
        if (current?.headRevision !== p.targetRevisionRef.revision || current.stagingWritable === false || active.state === 'cancelled' || active.revision !== record.revision)
            throw new ProjectError('VERSION_CONFLICT', 'the evolution was cancelled or superseded')
        await this.#sourcePins(scope, p.targetRevisionRef.projectId, p.evolutionId, ctx)
    }
    /** At-least-once worker entry. Originals are reparsed; no human approval is performed here. */
    async rebuild(projectId: string, id: string, ctx: ToolContext): Promise<ProjectEvolutionRecord> {
        editor(ctx)
        const scope = scopeOf(ctx), claimed = await this.deps.store.claim(scope, projectId, id, ctx).catch(storeFailure)
        if (claimed === undefined)
            return this.get(projectId, id, ctx)
        const ids: string[] = []
        try {
            await this.#pins(claimed, ctx)
            for (const source of claimed.plan.sources) {
                const bound = await this.deps.mappingService.bindRecords(projectId, {
                    parseId: source.parseId, mappingId: source.mappingRef.id, mappingVersion: source.mappingRef.version, maxRecords: source.rawRecordCount
                }, `evolve-bind:${id}:${source.mappingRef.id}`, ctx.principal.subjectId, ctx)
                if (bound.records.length !== source.rawRecordCount)
                    throw new ProjectError('SOURCE_UNREADABLE', 'the original row coverage changed')
                const selectedIds = new Set(source.recordIds)
                const selected = bound.records.filter((record) => selectedIds.has(record.recordId))
                if (selected.length !== source.expectedRecords)
                    throw new ProjectError('SOURCE_UNREADABLE', 'the reviewed original row selection changed')
                for (let offset = 0; offset < selected.length; offset += 200) {
                    await this.#pins(claimed, ctx)
                    const candidates = await this.deps.facts.stageEvolutionRecords(projectId, {
                        documentId: source.documentId, recordRefs: selected.slice(offset, offset + 200).map((r) => ({
                            recordId: r.recordId, revision: r.revision
                        }))
                    }, source.sourceJobId, ctx)
                    for (const candidate of candidates) {
                        await this.deps.instances.createRecord(scope, projectId, {
                            candidateId: candidate.candidateId, documentId: source.documentId, relations: [], idempotencyKey: `evolution-instance:${candidate.candidateId}`
                        }, ctx)
                        ids.push(candidate.candidateId)
                    }
                }
            }
            await this.#pins(claimed, ctx)
            return await this.deps.store.checkpoint(scope, claimed, 'awaiting_review', ids, undefined, ctx)
        }
        catch (error) {
            const current = await this.get(projectId, id, ctx)
            if (current.state === 'cancelled' || current.revision !== claimed.revision)
                return current
            if (error instanceof ProjectError && error.code === 'INVALID_ARGUMENT')
                return this.deps.store.checkpoint(scope, claimed, 'needs_human', ids, error.code, ctx)
            await this.deps.store.checkpoint(scope, claimed, 'failed', ids, error instanceof ProjectError || error instanceof ProjectStoreError ? error.code : 'REBUILD_FAILED', ctx)
            throw error
        }
    }
    /** Human invokes after normal field/identity/ledger publication. Stored facts are the proof. */
    async activate(projectId: string, id: string, relationCandidateIds: readonly string[], ctx: ToolContext): Promise<ProjectEvolutionRecord> {
        editor(ctx)
        const scope = scopeOf(ctx), record = await this.get(projectId, id, ctx)
        if (record.state === 'ready')
            return record
        if (record.state !== 'awaiting_review')
            throw new ProjectError('READINESS_CONFLICT', 'the evolution is not awaiting human review')
        await this.#pins(record, ctx)
        const p = record.plan, revision = await this.deps.projects.getRevision(scope, projectId, p.targetRevisionRef.revision, ctx)
        if (revision === undefined || revision.ref.digest !== p.targetRevisionRef.digest)
            throw new ProjectError('VERSION_CONFLICT', 'the target revision differs')
        if (relationCandidateIds.length > 200 || new Set(relationCandidateIds).size !== relationCandidateIds.length)
            throw new ProjectError('INVALID_ARGUMENT', 'relation review selectors exceed the bounded batch')
        const resolved = new Set<string>()
        for (const candidateId of relationCandidateIds) {
            const candidate = await this.deps.candidates.getCandidate(scope, candidateId, ctx), statement = await this.deps.publications.getStatement(scope, candidateId, ctx)
            if (candidate?.kind !== 'relation' || statement?.status !== 'active' || statement.sourceCandidateId !== candidateId || candidate.inputVersion.projectFact?.sources.some((s) => !same(s.projectRevisionRef, p.targetRevisionRef)) !== false)
                throw new ProjectError('READINESS_CONFLICT', 'relation changes need their actual reviewed and published target relation')
            resolved.add(candidate.relationId)
        }
        const unresolved = p.impacts.filter((i) => i.handling === 'human_relation' && !resolved.has(i.logicalId))
        if (unresolved.length > 0)
            throw new ProjectError('READINESS_CONFLICT', 'relation changes remain explicitly pending human resolution', {
                reasons: unresolved.map((i) => i.logicalId)
            })
        const snapshots: ProjectEvolutionSnapshot[] = []
        for (const objectId of new Set(p.sources.map((source) => source.objectId))) {
            const official = await this.deps.publishedSource.read(scope, revision, objectId, ctx)
            const rows = new Map(official.rows.map((row) => [row.recordId, row]))
            const expected = new Set<string>()
            for (const candidateId of record.candidateIds) {
                const candidate = await this.deps.candidates.getCandidate(scope, candidateId, ctx)
                if (candidate?.kind !== 'entity')
                    throw new ProjectError('READINESS_CONFLICT', 'every rebuilt entity must exist')
                if (candidate.objectId !== objectId)
                    continue
                const statement = await this.deps.publications.getStatement(scope, candidateId, ctx), pin = candidate.inputVersion.projectFact?.sources[0]
                if (pin === undefined || !same(pin.projectRevisionRef, p.targetRevisionRef) || statement?.status !== 'active' || statement.sourceCandidateId !== candidateId)
                    throw new ProjectError('READINESS_CONFLICT', 'every rebuilt candidate needs actual human-reviewed published facts')
                const row = rows.get(pin.recordId)
                if (row === undefined || candidate.attributes.some((attribute) => row.values[attribute.attributeId] === undefined))
                    throw new ProjectError('READINESS_CONFLICT', 'a rebuilt field is not queryable from official facts')
                expected.add(pin.recordId)
            }
            if (expected.size !== p.sources.filter((source) => source.objectId === objectId).reduce((n, source) => n + source.expectedRecords, 0) || official.rows.length !== expected.size || official.coverage.completeness !== 'complete')
                throw new ProjectError('READINESS_CONFLICT', 'the complete original re-extraction coverage has not been reviewed/published')
            await this.#pins(record, ctx)
            const snapshot = await this.deps.dataset.materialize(projectId, {
                objectId, revision: revision.ref.revision
            }, ctx)
            if (snapshot.snapshotRef === undefined)
                throw new ProjectError('READINESS_CONFLICT', 'the target snapshot is unavailable')
            const receipt = await this.deps.dataset.activationReceipt(snapshot.snapshotRef, ctx)
            if (receipt === undefined || !same(receipt.projectRevisionRef, revision.ref) || receipt.objectId !== objectId || receipt.sourceDigest !== official.sourceDigest)
                throw new ProjectError('READINESS_CONFLICT', 'the actual exact activated snapshot proof differs from the reviewed facts')
            snapshots.push({
                objectId, snapshotRef: snapshot.snapshotRef, sourceDigest: receipt.sourceDigest, factRecordedPoint: receipt.factRecordedPoint
            })
        }
        const expected = p.sources.reduce((n, source) => n + source.expectedRecords, 0)
        const snapshotDigest = sha256DigestOf(canonicalJson(snapshots))
        await this.deps.readiness.upsertProjection(scope, {
            projectRevisionRef: revision.ref, kind: 'published_semantics', targetRef: revision.definitionRef, state: 'ready', completeness: 'complete', expectedCount: expected, processedCount: expected, failedCount: 0, targetDigest: revision.definitionRef.digest, fenceRevision: revision.ref.revision, jobId: p.jobId, idempotencyKey: `evolution-facts:${id}:${snapshotDigest}`, requestDigest: sha256DigestOf(canonicalJson({
                plan: p, snapshots
            })), actor: ctx.principal.subjectId, recordedAt: this.#now()
        }, ctx)
        await this.#pins(record, ctx)
        const inputSnapshotRef = await this.#inputs.archive(scope, record, snapshots, revision.definitionRef, [...revision.mappingRefs], ctx)
        await this.#pins(record, ctx)
        return this.deps.store.activate(scope, record, snapshots, inputSnapshotRef, ctx).catch(storeFailure)
    }
    async cancel(projectId: string, id: string, ctx: ToolContext) {
        editor(ctx)
        return this.deps.store.cancel(scopeOf(ctx), projectId, id, ctx).catch(storeFailure)
    }
    async retry(projectId: string, id: string, ctx: ToolContext) {
        editor(ctx)
        return this.deps.store.retry(scopeOf(ctx), projectId, id, ctx).catch(storeFailure)
    }
    /** Current admission during rebuild verifies exact live originals, never reconstructs old facts. */
    async assertActiveRebuild(scope: ScopeRef, revision: ProjectRevisionRef, ctx: ToolContext): Promise<boolean> {
        const record = await this.deps.store.activeRebuild(scope, revision.projectId, ctx)
        if (record === undefined || !same(record.plan.previousRevisionRef, revision))
            return false
        await this.#sourcePins(scope, revision.projectId, record.plan.evolutionId, ctx)
        return true
    }
    async resolveActiveSnapshot(scope: ScopeRef, revision: ProjectRevisionRef, objectId: string, ctx: ToolContext) {
        const record = await this.deps.store.activeRebuild(scope, revision.projectId, ctx)
        return record?.state === 'ready' && same(record.plan.targetRevisionRef, revision) ? record.snapshots?.find((snapshot) => snapshot.objectId === objectId)?.snapshotRef : undefined
    }
    /** Current task admission verifies the real approved row and human confirmation artifacts. */
    async resolveApprovedInput(scope: ScopeRef, revision: ProjectRevision, ctx: ToolContext): Promise<ResourceRef | undefined> {
        const current = await this.deps.projects.getProject(scope, revision.ref.projectId, ctx)
        const record = await this.deps.store.activeRebuild(scope, revision.ref.projectId, ctx)
        if (record !== undefined && record.plan.previousInputRef !== undefined && this.deps.previousInput !== undefined &&
            (current?.activeRevision ?? current?.headRevision) === revision.ref.revision && current?.headRevision === record.plan.targetRevisionRef.revision && same(record.plan.previousRevisionRef, revision.ref)) {
            await this.#sourcePins(scope, revision.ref.projectId, record.plan.evolutionId, ctx)
            const ref = await this.deps.previousInput.validate(scope, revision, record.plan.previousInputRef, ctx)
            if (!same(await this.deps.projects.getProject(scope, revision.ref.projectId, ctx), current) || !same(await this.deps.store.activeRebuild(scope, revision.ref.projectId, ctx), record)) throw new ProjectError('READINESS_CONFLICT', 'the old-active staging input receipt changed during validation')
            await this.#sourcePins(scope, revision.ref.projectId, record.plan.evolutionId, ctx)
            return ref
        }
        if (record?.state !== 'ready' || (current?.activeRevision ?? current?.headRevision) !== revision.ref.revision || !same(record.plan.targetRevisionRef, revision.ref))
            return undefined
        for (const snapshot of record.snapshots ?? []) {
            const official = await this.deps.publishedSource.read(scope, revision, snapshot.objectId, ctx)
            if (official.sourceDigest !== snapshot.sourceDigest)
                throw new ProjectError('READINESS_CONFLICT', 'the evolved official source changed since input approval')
        }
        return this.#inputs.validate(scope, record, revision.definitionRef, [...revision.mappingRefs], ctx)
    }
}
