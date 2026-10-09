import { createHash } from 'node:crypto'
import { isRecord, isResourceRef, isUuid, isRevisionString, assertProjectDatasetFieldSourcesShape } from '@ontology/contracts'
import type { ApprovedInputSnapshot, CandidateStore, ImmutableArtifactWriter, InstanceReviewStore, ProjectDatasetReadRow, ProjectEvolutionRecord, ProjectEvolutionSnapshot, ProjectRecordStore, ResourceRef, ScopeRef, ScopedArtifactReader, SemanticPublicationStore, ToolContext } from '@ontology/contracts'
import { canonicalJson } from '../profiles/canonical'
import { ProjectError } from './errors'
import type { ProjectDataMaterializationService } from './project-materialization-service'
export interface ProjectEvolutionInputDependencies {
    readonly writer: ImmutableArtifactWriter
    readonly reader: ScopedArtifactReader
    readonly instances: Pick<InstanceReviewStore, 'getRecord' | 'listConfirmations'>
    readonly candidates: Pick<CandidateStore, 'getCandidate'>
    readonly reviews: Pick<SemanticPublicationStore, 'latestReviewRevision' | 'getReview'>
    readonly dataset: ProjectDataMaterializationService
    readonly records: Pick<ProjectRecordStore, 'listRecords'>
}
const MAX_BYTES = 8 * 1024 * 1024
const PAGE_SIZE = 100
function digest(bytes: Uint8Array) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
function same(a: unknown, b: unknown) {
    return canonicalJson(a) === canonicalJson(b)
}
function invalid(message: string): never {
    throw new ProjectError('READINESS_CONFLICT', message)
}
/** Archives actual official rows and existing human ledger evidence, never staging values. */
export class ProjectEvolutionInputService {
    constructor(private readonly deps: ProjectEvolutionInputDependencies) {
    }
    async #write(scope: ScopeRef, body: unknown, ctx: ToolContext): Promise<ResourceRef> {
        const content = new TextEncoder().encode(canonicalJson(body))
        if (content.byteLength > MAX_BYTES)
            invalid('an approved-input page exceeds its bounded artifact size')
        const written = await this.deps.writer.putBytes({
            scopeRef: scope, content, mediaType: 'application/json'
        }, ctx)
        if (written.contentDigest !== digest(content) || written.blobRef.digest !== written.contentDigest)
            invalid('the archived approved input digest differs')
        return written.blobRef
    }
    async #read(ref: ResourceRef, ctx: ToolContext): Promise<unknown> {
        const bytes = await this.deps.reader.read({
            approvedInputRefs: [ref]
        }, ctx)
        if (bytes.byteLength > MAX_BYTES || digest(bytes) !== ref.digest)
            invalid('the approved-input artifact is missing or changed')
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
        return value
    }
    async #human(scope: ScopeRef, record: ProjectEvolutionRecord, ctx: ToolContext) {
        const rows = []
        for (const candidateId of record.candidateIds) {
            const candidate = await this.deps.candidates.getCandidate(scope, candidateId, ctx)
            const instance = await this.deps.instances.getRecord(scope, record.plan.targetRevisionRef.projectId, candidateId, ctx)
            const revision = await this.deps.reviews.latestReviewRevision(scope, candidateId, ctx)
            const review = await this.deps.reviews.getReview(scope, candidateId, revision, ctx)
            const events = await this.deps.instances.listConfirmations(scope, record.plan.targetRevisionRef.projectId, candidateId, ctx)
            if (candidate?.kind !== 'entity' || instance === undefined || !same(instance.identity.binding?.projectRevisionRef, record.plan.targetRevisionRef) || !['matched', 'created'].includes(instance.identity.state) || instance.identity.matchedEntityId === undefined || review?.decision !== 'approve' || review.contentDigest !== candidate.idempotencyKey || instance.fields.length !== candidate.attributes.length || instance.fields.some((field) => field.status !== 'confirmed' || field.actor === undefined || field.confirmedAt === undefined || !events.some((event) => event.fieldId === field.fieldId && event.confirmationRevision === field.confirmationRevision && event.status === 'confirmed' && event.actor === field.actor)))
                invalid('the approved input lacks actual field, identity or content-pinned human review evidence')
            rows.push({
                candidateId, candidateDigest: candidate.idempotencyKey, recordRevision: instance.recordRevision, fields: instance.fields, identity: instance.identity, confirmationEvents: events, review
            })
        }
        return rows
    }
    async #rows(scope: ScopeRef, record: ProjectEvolutionRecord, snapshots: readonly ProjectEvolutionSnapshot[], ctx: ToolContext) {
        if (scope.tenantId !== ctx.principal.tenantId || scope.spaceId !== ctx.allowedResources.spaceId)
            throw new ProjectError('SCOPE_MISMATCH', 'approved-input rows require the trusted scope')
        const rows: ProjectDatasetReadRow[] = []
        for (const snapshot of snapshots) {
            let cursor: string | undefined
            do {
                const page = await this.deps.dataset.query({
                    projectRevisionRef: record.plan.targetRevisionRef, snapshotRef: snapshot.snapshotRef, objectId: snapshot.objectId, limit: 250, ...(cursor === undefined ? {} : {
                        cursor
                    })
                }, ctx)
                rows.push(...page.rows)
                if (rows.length > 20000 || page.coverage.cursor === cursor && cursor !== undefined)
                    invalid('approved-input paging exceeds its finite bound')
                cursor = page.coverage.cursor
            } while (cursor !== undefined)
            const receipt = await this.deps.dataset.activationReceipt(snapshot.snapshotRef, ctx)
            if (receipt === undefined || !same(receipt.projectRevisionRef, record.plan.targetRevisionRef) || receipt.sourceDigest !== snapshot.sourceDigest || !same(receipt.factRecordedPoint, snapshot.factRecordedPoint))
                invalid('the approved input must use its actual exact activated dataset')
        }
        rows.sort((a, b) => a.recordId.localeCompare(b.recordId))
        if (rows.length !== record.plan.sources.reduce((n, source) => n + source.expectedRecords, 0) || new Set(rows.map((row) => row.recordId)).size !== rows.length)
            invalid('the approved input record coverage differs')
        return rows
    }
    async archive(scope: ScopeRef, record: ProjectEvolutionRecord, snapshots: readonly ProjectEvolutionSnapshot[], definitionRef: ApprovedInputSnapshot['definitionRef'], mappingRefs: ApprovedInputSnapshot['mappingRefs'], ctx: ToolContext): Promise<ResourceRef> {
        const rows = await this.#rows(scope, record, snapshots, ctx), human = await this.#human(scope, record, ctx)
        const pages: ApprovedInputSnapshot['recordPages'] = []
        const confirmationPages: ResourceRef[] = []
        for (let offset = 0; offset < rows.length; offset += PAGE_SIZE) {
            const selected = rows.slice(offset, offset + PAGE_SIZE)
            const ref = await this.#write(scope, {
                schemaVersion: 'project-input-record-page@1', projectRevisionRef: record.plan.targetRevisionRef, definitionRef, mappingRefs, snapshots, records: selected
            }, ctx)
            pages.push({
                ref, rowCount: selected.length, firstRecordId: selected[0]!.recordId, lastRecordId: selected[selected.length - 1]!.recordId
            })
        }
        for (let offset = 0; offset < human.length; offset += PAGE_SIZE)
            confirmationPages.push(await this.#write(scope, {
                schemaVersion: 'project-input-confirmations-page@1', projectRevisionRef: record.plan.targetRevisionRef, confirmations: human.slice(offset, offset + PAGE_SIZE)
            }, ctx))
        const confirmationManifestRef = await this.#write(scope, {
            schemaVersion: 'project-input-confirmations@1', projectRevisionRef: record.plan.targetRevisionRef, snapshots, confirmationPages
        }, ctx)
        const allowed = new Set(rows.map((row) => row.recordId)), excluded: ApprovedInputSnapshot['excluded'] = []
        let cursor: string | undefined
        do {
            const page = await this.deps.records.listRecords(scope, record.plan.targetRevisionRef.projectId, {
                limit: 250, ...(cursor === undefined ? {} : {
                    cursor
                })
            }, ctx)
            for (const physical of page.records)
                if (!allowed.has(physical.recordId) && record.plan.sources.some((source) => source.mappingRef.id === physical.mappingId && source.mappingRef.version === physical.mappingVersion))
                    excluded.push({
                        recordId: physical.recordId, reason: 'not_in_current_published_original_input', actor: ctx.principal.subjectId
                    })
            if (excluded.length + rows.length > 20000 || page.nextCursor === cursor && cursor !== undefined)
                invalid('approved-input exclusions exceed their finite bound')
            cursor = page.nextCursor
        } while (cursor !== undefined)
        if (rows.length + excluded.length !== record.plan.sources.reduce((n, source) => n + source.rawRecordCount, 0))
            invalid('the approved input original/excluded record accounting differs')
        const body: ApprovedInputSnapshot = {
            schemaVersion: 'project-input-snapshot@1', projectId: record.plan.targetRevisionRef.projectId, inputRevision: record.plan.targetRevisionRef.revision, definitionRef, mappingRefs, recordPages: pages, counts: {
                total: rows.length + excluded.length, confirmed: rows.length, approved: rows.length, excluded: excluded.length, pending: 0, failed: 0
            }, excluded, coverage: 'complete', confirmationManifestRef
        }
        return this.#write(scope, body, ctx)
    }
    async validate(scope: ScopeRef, record: ProjectEvolutionRecord, definitionRef: ApprovedInputSnapshot['definitionRef'], mappingRefs: ApprovedInputSnapshot['mappingRefs'], ctx: ToolContext): Promise<ResourceRef> {
        if (record.state !== 'ready' || record.inputSnapshotRef === undefined || record.snapshots === undefined)
            invalid('the evolved input has no immutable activation binding')
        const body = await this.#read(record.inputSnapshotRef, ctx)
        if (!isRecord(body) || body.schemaVersion !== 'project-input-snapshot@1' || body.projectId !== record.plan.targetRevisionRef.projectId || body.inputRevision !== record.plan.targetRevisionRef.revision || !same(body.definitionRef, definitionRef) || !same(body.mappingRefs, mappingRefs) || body.coverage !== 'complete' || !isRecord(body.counts) || !Array.isArray(body.recordPages) || body.recordPages.length > 200 || !isResourceRef(body.confirmationManifestRef))
            invalid('the evolved approved-input manifest pins disagree')
        const actual = await this.#rows(scope, record, record.snapshots, ctx)
        const archived: unknown[] = []
        for (const page of body.recordPages) {
            if (!isRecord(page) || !isResourceRef(page.ref) || typeof page.rowCount !== 'number' || !isUuid(page.firstRecordId) || !isUuid(page.lastRecordId))
                invalid('the approved-input page selector is malformed')
            const value = await this.#read(page.ref, ctx)
            if (!isRecord(value) || !same(value.projectRevisionRef, record.plan.targetRevisionRef) || !same(value.definitionRef, definitionRef) || !same(value.mappingRefs, mappingRefs) || !same(value.snapshots, record.snapshots) || !Array.isArray(value.records) || value.records.length !== page.rowCount)
                invalid('the approved record page differs from its exact activation')
            for (const row of value.records) {
                if (!isRecord(row) || !isUuid(row.recordId) || !Array.isArray(row.sources))
                    invalid('approved rows are malformed')
                assertProjectDatasetFieldSourcesShape(row.sources)
            }
            if (value.records[0]?.recordId !== page.firstRecordId || value.records[value.records.length - 1]?.recordId !== page.lastRecordId)
                invalid('the approved record page boundary differs')
            archived.push(...value.records)
        }
        if (!same(archived, actual) || body.counts.approved !== actual.length || body.counts.confirmed !== actual.length || body.counts.pending !== 0 || body.counts.failed !== 0 || !Array.isArray(body.excluded) || body.counts.excluded !== body.excluded.length || body.counts.total !== actual.length + body.excluded.length)
            invalid('the approved input is not the actual complete official dataset')
        const manifest = await this.#read(body.confirmationManifestRef, ctx)
        if (!isRecord(manifest) || !same(manifest.projectRevisionRef, record.plan.targetRevisionRef) || !same(manifest.snapshots, record.snapshots) || !Array.isArray(manifest.confirmationPages) || manifest.confirmationPages.length > 200 || !manifest.confirmationPages.every(isResourceRef))
            invalid('the human confirmation manifest differs')
        const confirmed: unknown[] = []
        for (const ref of manifest.confirmationPages) {
            const page = await this.#read(ref, ctx)
            if (!isRecord(page) || !same(page.projectRevisionRef, record.plan.targetRevisionRef) || !Array.isArray(page.confirmations))
                invalid('the archived human confirmation page is unavailable')
            confirmed.push(...page.confirmations)
        }
        const currentHuman = await this.#human(scope, record, ctx)
        if (confirmed.length !== currentHuman.length)
            invalid('the actual human confirmation coverage changed')
        for (let index = 0; index < currentHuman.length; index++) {
            const archived = confirmed[index], current = currentHuman[index]!
            if (!isRecord(archived) || archived.candidateId !== current.candidateId || !isRecord(archived.review) || !isRevisionString(archived.review.revision))
                invalid('the frozen human review selector is malformed')
            const frozenReview = await this.deps.reviews.getReview(scope, current.candidateId, archived.review.revision, ctx)
            // A same-content reaffirmation does not change the already approved input. The
            // historical approval must still be real, while #human enforces current approval,
            // fields and identity; none of those source/confirmation checks are relaxed.
            if (frozenReview?.decision !== 'approve' || frozenReview.contentDigest !== current.candidateDigest || !same(archived, {
                ...current, review: frozenReview
            }))
                invalid('the actual human confirmation/review evidence changed')
        }
        return record.inputSnapshotRef
    }
}
