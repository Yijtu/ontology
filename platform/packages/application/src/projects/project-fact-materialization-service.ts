import { isToolContext } from '@ontology/contracts'
import type {
  CandidateAttributeValue, CandidateRecord, CandidateStore, EntityCandidate,
  IndustrySchemaSource, JobStore, ProjectDocumentStore, ProjectFactSourcePin,
  ProjectMappingStore, ProjectRecordStore, ProjectStore, RelationCandidate, ScopeRef,
  StageProjectFactsRequest, StructuredIngestionStore, ToolContext, Uuid, VersionRef,
} from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../extraction/canonical'
import { validateEntity } from '../extraction/schema-validation'
import { decodeStructuredExtractionRef } from '../jobs/structured-ingestion-ref'
import { applyExactFactor, isDecimalString } from './decimal'
import { ProjectError } from './errors'

export const PROJECT_FACT_BATCH_LIMIT = 200

export interface ProjectFactMaterializationDependencies {
  readonly projects: Pick<ProjectStore, 'getProject' | 'getRevision'>
  readonly mappings: Pick<ProjectMappingStore, 'getMapping'>
  readonly records: Pick<ProjectRecordStore, 'getRecord'>
  readonly projectDocuments: Pick<ProjectDocumentStore, 'getMembership' | 'getVisibility'>
  readonly ingestion: Pick<StructuredIngestionStore, 'findParseByDigest'>
  readonly candidates: CandidateStore
  readonly schemaSource: IndustrySchemaSource
  readonly jobs: Pick<JobStore, 'getJob'>
  /** Host lookup over its ingestion jobs; never a request-selected job or source proof. */
  readonly resolveSourceJob: (scope: ScopeRef, parseId: Uuid, ctx: ToolContext) => Promise<Uuid | undefined>
  readonly now?: () => string
}

function sameRef(a: VersionRef, b: VersionRef): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) {
    throw new ProjectError('SCOPE_MISMATCH', 'a consistent host-minted context is required')
  }
  if (!ctx.principal.roles.some((role) => role === 'platform-admin' || role === 'profile-editor')) {
    throw new ProjectError('FORBIDDEN', 'staging mapped facts requires a mapping editor')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function interval(input: Pick<StageProjectFactsRequest, 'validFrom' | 'validTo'>) {
  for (const value of [input.validFrom, input.validTo]) {
    if (value !== undefined && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) || Number.isNaN(Date.parse(value)))) {
      throw new ProjectError('INVALID_ARGUMENT', 'business valid times must be UTC timestamps')
    }
  }
  if (input.validFrom !== undefined && input.validTo !== undefined && Date.parse(input.validTo) <= Date.parse(input.validFrom)) {
    throw new ProjectError('INVALID_ARGUMENT', 'business valid interval must be nonempty')
  }
  return {
    ...(input.validFrom === undefined ? {} : { validFrom: input.validFrom }),
    ...(input.validTo === undefined ? {} : { validTo: input.validTo }),
  }
}

/**
 * Maps immutable control staging records into the existing candidate store. It never
 * writes semantic truth or grants a review/identity decision. The ordinary instance
 * confirmation and semantic publication services consume the returned candidate ids.
 */
export class ProjectFactMaterializationService {
  readonly #deps: ProjectFactMaterializationDependencies

  constructor(deps: ProjectFactMaterializationDependencies) { this.#deps = deps }

  async stageRecords(projectId: Uuid, request: StageProjectFactsRequest, ctx: ToolContext): Promise<readonly EntityCandidate[]> {
    const scope = scopeOf(ctx)
    if (request.recordRefs.length === 0 || request.recordRefs.length > PROJECT_FACT_BATCH_LIMIT || new Set(request.recordRefs.map((ref) => ref.recordId)).size !== request.recordRefs.length) {
      throw new ProjectError('INVALID_ARGUMENT', `select 1..${PROJECT_FACT_BATCH_LIMIT} distinct record revisions per batch`)
    }
    const valid = interval(request)
    const project = await this.#deps.projects.getProject(scope, projectId, ctx)
    const revision = project === undefined ? undefined : await this.#deps.projects.getRevision(scope, projectId, project.headRevision, ctx)
    const membership = await this.#deps.projectDocuments.getMembership(scope, projectId, request.documentId, ctx)
    const visibility = await this.#deps.projectDocuments.getVisibility(scope, projectId, ctx)
    if (project === undefined || project.state === 'archived' || revision === undefined) throw new ProjectError('PROJECT_NOT_FOUND', 'an active project revision is required')
    if (membership?.state !== 'active' || visibility === undefined) throw new ProjectError('SOURCE_UNREADABLE', 'active project source membership is required')
    const schema = await this.#deps.schemaSource.getSchema(scope, revision.definitionRef, ctx)
    if (schema === undefined || !sameRef(schema.definitionRef, revision.definitionRef)) throw new ProjectError('INVALID_ARGUMENT', 'the exact project definition must be visible')
    const pending: EntityCandidate[] = []
    for (const ref of request.recordRefs) {
      const record = await this.#deps.records.getRecord(scope, projectId, ref.recordId, ctx)
      if (record === undefined || record.revision !== ref.revision) throw new ProjectError('VERSION_CONFLICT', 'the selected record revision is no longer current')
      if (record.status !== 'confirmed' || record.fields.length === 0 || record.fields.some((field) => field.status !== 'confirmed' || field.normalized.kind === 'scalar' && field.normalized.value === null)) throw new ProjectError('INVALID_ARGUMENT', 'every staged mapped field must normalize completely')
      const mapping = await this.#deps.mappings.getMapping(scope, projectId, record.mappingId, record.mappingVersion, ctx)
      if (mapping === undefined || !sameRef(mapping.definitionRef, revision.definitionRef) || !revision.mappingRefs.some((pin) => sameRef(pin, mapping.ref))) throw new ProjectError('VERSION_CONFLICT', 'the exact confirmed mapping must be pinned by the project revision')
      if ((mapping.format !== 'csv' && mapping.format !== 'xlsx') || mapping.parseId !== membership.parseId || !sameRef(mapping.originalRef, membership.documentRef)) throw new ProjectError('SOURCE_UNREADABLE', 'mapping source differs from the active project document')
      const jobId = await this.#deps.resolveSourceJob(scope, mapping.parseId, ctx)
      const job = jobId === undefined ? undefined : await this.#deps.jobs.getJob(scope, jobId, ctx)
      if (job?.documentRef === undefined || job.kind !== 'ingestion') throw new ProjectError('SOURCE_UNREADABLE', 'the host must resolve a durable structured ingestion job')
      const input = decodeStructuredExtractionRef(job.documentRef)
      if (input.parseId !== mapping.parseId || !sameRef(input.originalRef, mapping.originalRef) || !sameRef(input.definitionRef, revision.definitionRef)) throw new ProjectError('SOURCE_UNREADABLE', 'ingestion job does not pin this parse, original and definition')
      const parse = await this.#deps.ingestion.findParseByDigest(scope, mapping.originalRef.digest, input.parserVersion, ctx)
      if (parse?.parseId !== mapping.parseId || parse.status !== 'complete' || parse.coverage.status !== 'complete' || parse.coverage.completeness !== 'complete' || parse.coverage.parsedUnits !== parse.coverage.totalUnits || parse.counts.pending + parse.counts.failed + parse.counts.skipped > 0) throw new ProjectError('SOURCE_UNREADABLE', 'only the exact complete reconciled parse may enter fact review')
      const object = schema.objects.find((entry) => entry.objectId === record.objectId)
      if (object === undefined || mapping.objectId !== record.objectId) throw new ProjectError('INVALID_ARGUMENT', 'mapped object is not declared')
      const attributes: CandidateAttributeValue[] = record.fields.map((field) => {
        const attribute = object.attributes.find((entry) => entry.attributeId === field.fieldId)
        if (attribute === undefined || !mapping.entries.some((entry) => entry.fieldRef === field.fieldId)) throw new ProjectError('INVALID_ARGUMENT', 'unmapped or undeclared field cannot become a fact')
        const normalized = field.normalized
        if (normalized.kind === 'quantity') {
          const value = applyExactFactor(normalized.value, '1', '1')
          if (value === undefined || attribute.valueType !== 'quantity' || normalized.unitCode !== attribute.unitCode) throw new ProjectError('INVALID_ARGUMENT', 'mapped quantity must retain its exact canonical unit/value')
          return { attributeId: field.fieldId, value, decimal: value, unitCode: normalized.unitCode, raw: String(field.raw) }
        }
        if (normalized.value === null) throw new ProjectError('INVALID_ARGUMENT', 'null cannot become a fact')
        // Keep mapped numeric strings exact instead of passing through Number.
        if (attribute.valueType === 'number' && (typeof normalized.value !== 'string' || !isDecimalString(normalized.value))) throw new ProjectError('INVALID_ARGUMENT', 'mapped number must be an exact decimal')
        if (attribute.valueType === 'number' && typeof normalized.value === 'string') {
          const value = applyExactFactor(normalized.value, '1', '1')
          if (value === undefined) throw new ProjectError('INVALID_ARGUMENT', 'mapped number exceeds the exact decimal bounds')
          return { attributeId: field.fieldId, value, decimal: value, raw: String(field.raw) }
        }
        return { attributeId: field.fieldId, value: normalized.value, raw: String(field.raw) }
      })
      const sourceBase = {
        projectRevisionRef: revision.ref, definitionRef: revision.definitionRef, mappingRef: mapping.ref,
        recordId: record.recordId, recordRevision: record.revision, contentDigest: record.contentDigest,
        sourceDigest: record.sourceDigest, sourceRecordedAt: record.recordedAt,
        documentId: membership.documentId, parseId: parse.parseId,
        membershipRevision: membership.membershipRevision, visibilityEpoch: visibility.epoch,
      }
      const key = sha256DigestOf(canonicalJson({ sourceBase, attributes, valid, objectId: object.objectId, identityScopeId: object.identityScopeId, jobId: job.jobId, parserVersion: parse.parserVersion, pipelineVersion: job.pipelineVersion, sourceSpans: record.fields.map((field) => field.locator) }))
      const candidateId = candidateIdFor(key)
      const source: ProjectFactSourcePin = { ...sourceBase, entityCandidateId: candidateId }
      const candidate: EntityCandidate = {
        candidateId, jobId: job.jobId, kind: 'entity', objectId: record.objectId, identityScopeId: object.identityScopeId,
        deterministic: true, state: 'pending_review', issues: [], attributes,
        inputVersion: { definitionRef: revision.definitionRef, parseId: parse.parseId, parserVersion: parse.parserVersion, pipelineVersion: job.pipelineVersion, documentVersionRef: membership.documentRef, projectFact: { sources: [source], ...valid } },
        sourceSpans: record.fields.map((field) => ({ kind: 'structured', parseId: parse.parseId, recordId: record.recordId, sourceRowKey: record.sourceRowKey, locator: field.locator, rowDigest: record.sourceDigest })),
        idempotencyKey: key, recordedAt: this.#deps.now?.() ?? new Date().toISOString(),
      }
      const issues = validateEntity(candidate, schema)
      if (issues.length > 0) throw new ProjectError('INVALID_ARGUMENT', `mapped record is not schema-valid: ${issues.map((entry) => entry.message).join('; ')}`)
      pending.push(candidate)
    }
    // Whole bounded batch validates before any insert; candidate insertion is atomic/idempotent.
    const stored = await this.#deps.candidates.insertCandidates(scope, pending, ctx)
    const result: EntityCandidate[] = []
    for (const id of stored.candidateIds) {
      const candidate = await this.#deps.candidates.getCandidate(scope, id, ctx)
      if (candidate?.kind !== 'entity') throw new ProjectError('INVALID_ARGUMENT', 'stored mapped entity candidate is unreadable')
      result.push(candidate)
    }
    return result
  }

  /** Endpoints are stored entity candidates, never caller-supplied identity/value proof. */
  async stageRelation(projectId: Uuid, request: { readonly relationId: string; readonly fromCandidateId: Uuid; readonly toCandidateId: Uuid }, ctx: ToolContext): Promise<RelationCandidate> {
    const scope = scopeOf(ctx)
    const from = await this.#deps.candidates.getCandidate(scope, request.fromCandidateId, ctx)
    const to = await this.#deps.candidates.getCandidate(scope, request.toCandidateId, ctx)
    const fromSource = from?.inputVersion.projectFact?.sources[0]
    const toSource = to?.inputVersion.projectFact?.sources[0]
    if (from?.kind !== 'entity' || to?.kind !== 'entity' || fromSource?.projectRevisionRef.projectId !== projectId || toSource?.projectRevisionRef.projectId !== projectId || !sameRef(from.inputVersion.definitionRef, to.inputVersion.definitionRef)) throw new ProjectError('INVALID_ARGUMENT', 'relation endpoints require mapped entity candidates in this project/definition')
    const schema = await this.#deps.schemaSource.getSchema(scope, from.inputVersion.definitionRef, ctx)
    const relation = schema?.relations.find((entry) => entry.relationId === request.relationId)
    if (relation?.fromObjectId !== from.objectId || relation.toObjectId !== to.objectId) throw new ProjectError('INVALID_ARGUMENT', 'relation endpoint types differ from the pinned definition')
    const fromValid = from.inputVersion.projectFact
    const toValid = to.inputVersion.projectFact
    const validFrom = [fromValid?.validFrom, toValid?.validFrom].filter((value): value is string => value !== undefined).sort((a, b) => Date.parse(b) - Date.parse(a))[0]
    const validTo = [fromValid?.validTo, toValid?.validTo].filter((value): value is string => value !== undefined).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
    const valid = interval({ ...(validFrom === undefined ? {} : { validFrom }), ...(validTo === undefined ? {} : { validTo }) })
    const inputVersion = { ...from.inputVersion, projectFact: { sources: [fromSource, toSource], ...valid } }
    const sourceSpans = [...from.sourceSpans, ...to.sourceSpans]
    const key = sha256DigestOf(canonicalJson({ relationId: request.relationId, from: { objectId: from.objectId, candidateId: from.candidateId }, to: { objectId: to.objectId, candidateId: to.candidateId }, inputVersion, sourceSpans, jobId: from.jobId }))
    const candidate: RelationCandidate = {
      candidateId: candidateIdFor(key), jobId: from.jobId, kind: 'relation', relationId: request.relationId,
      from: { objectId: from.objectId, candidateId: from.candidateId }, to: { objectId: to.objectId, candidateId: to.candidateId },
      deterministic: true, state: 'pending_review', issues: [], sourceSpans,
      inputVersion,
      idempotencyKey: key, recordedAt: this.#deps.now?.() ?? new Date().toISOString(),
    }
    const inserted = await this.#deps.candidates.insertCandidates(scope, [candidate], ctx)
    const persisted: CandidateRecord | undefined = await this.#deps.candidates.getCandidate(scope, inserted.candidateIds[0] ?? candidate.candidateId, ctx)
    if (persisted?.kind !== 'relation') throw new ProjectError('INVALID_ARGUMENT', 'stored relation is unreadable')
    return persisted
  }
}
