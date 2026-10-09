import { randomUUID } from 'node:crypto'
import type { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import {
  PostgresCandidateStore, PostgresIdentityDecisionStore, PostgresInstanceReviewStore, PostgresJobStore,
  PostgresProjectDocumentStore, PostgresProjectMappingStore, PostgresProjectReadinessStore,
  PostgresProjectRecordStore, PostgresProjectStore, PostgresSemanticPublicationStore,
} from '@ontology/adapter-control-postgres'
import type { ControlPostgresDatabase } from '@ontology/adapter-control-postgres'
import { LocalStructuredIngestionService, StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import type { PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import { InMemoryIndustrySchemaSource, InstanceReviewService, JobService, ProjectMappingService, ProjectService, encodeStructuredExtractionRef } from '@ontology/application'
import { createInstanceIdentityWorkflow, createProjectFactWorkflow } from '@ontology/app-api'
import { InMemoryIdentityIndexReader, PublishedProjectDatasetSource, projectIndustrySchema } from '@ontology/semantic-engine'
import type { ColumnMappingEntry, EntityCandidate, ResourceRef, ScopeRef, SemanticDefinitionVersion, ToolContext } from '@ontology/contracts'

/** Real stored import, human fields/identity, review ledger and fenced PG publication. */
export function projectQueryPublicationFixture(input: {
  db: ControlPostgresDatabase; blobs: LocalImmutableBlobStore; structured: PostgresStructuredIngestionStore;
  scope: ScopeRef; ctx: ToolContext; projectId: string; definition: SemanticDefinitionVersion;
  additionalDefinitions?: readonly SemanticDefinitionVersion[];
}) {
  const { db, blobs, structured, scope, ctx, projectId, definition } = input
  const projects = new PostgresProjectStore(db)
  const mappings = new PostgresProjectMappingStore(db)
  const records = new PostgresProjectRecordStore(db)
  const documents = new PostgresProjectDocumentStore(db)
  const identities = new PostgresIdentityDecisionStore(db)
  const candidates = new PostgresCandidateStore(db)
  const instances = new PostgresInstanceReviewStore(db)
  const publications = new PostgresSemanticPublicationStore(db)
  const readiness = new PostgresProjectReadinessStore(db)
  const jobs = new PostgresJobStore(db)
  const sourceJobs = new Map<string, string>()
  const schemas = new InMemoryIndustrySchemaSource([definition,...input.additionalDefinitions ?? []].map((value)=>({ref:value.ref,schema:projectIndustrySchema(value)})))
  const originals = { read: async (request: { approvedInputRefs: readonly ResourceRef[] }, context: ToolContext) => {
    const ref = request.approvedInputRefs[0]
    if (ref === undefined) throw new Error('the import has no original')
    return blobs.readAuthorized({ scopeRef: scope, blobRef: ref }, context)
  } }
  const mappingService = new ProjectMappingService({ projects, revisions: projects, mappings, records, ingestion: structured, originals, parser: new StructuredDocumentParser(), schemaSource: schemas })
  const instanceService = new InstanceReviewService({ store: instances })
  const workflow = createProjectFactWorkflow({ materialization: { projects, mappings, records, projectDocuments: documents, ingestion: structured, candidates, schemaSource: schemas, jobs,
    resolveSourceJob: async (_scope, parseId) => sourceJobs.get(parseId) }, publication: { store: publications, identity: identities }, instanceRecords: instances })
  const identity = createInstanceIdentityWorkflow({ service: instanceService, projects, projectDocuments: documents, candidates, identityStore: identities,
    schemaSource: schemas, identityMappingRef: definition.ref, index: new InMemoryIdentityIndexReader([]) })
  const projectService = new ProjectService({ projects, readiness, jobs, catalogue: { listEntries: async () => [], findPack: async () => undefined } })
  let readDefinition = definition
  const publishedSource = new PublishedProjectDatasetSource({ publications, identity: identities, records, mappings, projectDocuments: documents,
    definition: async (_scope, ref) => ref.digest === readDefinition.ref.digest ? readDefinition : input.additionalDefinitions?.find((value)=>value.ref.digest===ref.digest) })

  const importCsv = async (objectId: string, csv: string, fieldIds: readonly string[], units: Readonly<Record<string, string | { readonly source: string; readonly canonical: string; readonly numerator: string; readonly denominator: string }>> = {}) => {
    const bytes = new TextEncoder().encode(csv)
    const staged = await blobs.stage(bytes, { scopeRef: scope }, ctx)
    const original = await blobs.publish({ scopeRef: scope, contentDigest: staged.contentDigest, byteSize: staged.byteSize, mediaType: 'text/csv', purpose: 'document' }, ctx)
    const parsed = await new LocalStructuredIngestionService({ blobs, store: structured }).parse({ scopeRef: scope, originalRef: original.blobRef, options: { headerRow: 1 } }, ctx)
    const jobId = randomUUID()
    await new JobService({ store: jobs }).createJob({ jobId, kind: 'ingestion', sourceRef: 'project-query-test', documentRef: encodeStructuredExtractionRef({ kind: 'structured_extraction', parseId: parsed.parse.parseId, parserVersion: parsed.parse.parserVersion,
      definitionRef: definition.ref, format: 'csv', originalRef: original.blobRef, originalMediaType: 'text/csv', options: { headerRow: 1 } }), pipelineVersion: '1.0.0', idempotencyKey: `query-job-${jobId}` }, ctx)
    sourceJobs.set(parsed.parse.parseId, jobId)
    const table = new StructuredDocumentParser().parse(bytes, { mediaType: 'text/csv', headerRow: 1 }).tables[0]
    if (table === undefined) throw new Error('the query CSV did not produce a table')
    const entries: ColumnMappingEntry[] = table.columns.flatMap((column, index) => {
      const fieldRef = fieldIds[index]
      if (fieldRef === undefined) throw new Error('a query column has no declared field')
      if (fieldRef === '') return []
      const unit = units[fieldRef]
      return [{ fieldRef, header: column.header, headerDigest: column.headerDigest, columnIndex: index,
        ...(unit === undefined ? {} : typeof unit === 'string' ? { sourceUnitCode: unit, canonicalUnitCode: unit } : { sourceUnitCode: unit.source, canonicalUnitCode: unit.canonical, unitConversion: { fromUnitCode: unit.source, toUnitCode: unit.canonical, numerator: unit.numerator, denominator: unit.denominator } }) }]
    })
    const confirmation = await mappingService.confirmMapping(projectId, { format: 'csv', parseId: parsed.parse.parseId, originalRef: original.blobRef, originalMediaType: 'text/csv', options: { headerRow: 1 }, objectId, entries }, `query-map-${jobId}`, ctx.principal.subjectId, ctx)
    const documentId = randomUUID()
    await documents.registerDocument(scope, projectId, { documentId, documentRef: original.blobRef, documentDigest: original.blobRef.digest, parseId: parsed.parse.parseId,
      parseRef: { id: parsed.parse.parseId, version: '1.0.0', digest: original.blobRef.digest, kind: 'artifact' }, textDigest: original.blobRef.digest, precision: 'exact', actor: ctx.principal.subjectId, recordedAt: new Date().toISOString() }, ctx)
    const project = await projects.getProject(scope, projectId, ctx)
    if (project === undefined) throw new Error('the query project is missing')
    const previous = await projects.getRevision(scope, projectId, project.headRevision, ctx)
    if (previous === undefined) throw new Error('the query project revision is missing')
    await projectService.appendRevision(projectId, { expectedRevision: previous.ref.revision, reason: 'human confirmed query import mapping', mappingRefs: [...previous.mappingRefs, confirmation.mapping.ref] }, `query-mount-${jobId}`, ctx.principal.subjectId, ctx)
    const bound = await mappingService.bindRecords(projectId, { parseId: parsed.parse.parseId, mappingId: confirmation.mapping.mappingId, mappingVersion: confirmation.mapping.version }, `query-bind-${jobId}`, ctx.principal.subjectId, ctx)
    const entities: EntityCandidate[] = []
    const batches = Array.from({ length: Math.ceil(bound.records.length / 200) }, (_unused, index) => bound.records.slice(index * 200, (index + 1) * 200))
    for (let offset = 0; offset < batches.length; offset += 3) {
      const staged = await Promise.all(batches.slice(offset, offset + 3).map((batch) => workflow.materialization.stageRecords(projectId, { documentId,
        recordRefs: batch.map((record) => ({ recordId: record.recordId, revision: record.revision })) }, ctx)))
      for (const batch of staged) entities.push(...batch)
    }
    return { entities, documentId, mapping: confirmation.mapping, records: bound.records }
  }
  const restage = async (source: Awaited<ReturnType<typeof importCsv>>) => {
    const entities: EntityCandidate[] = []
    for (let offset = 0; offset < source.records.length; offset += 200) entities.push(...await workflow.materialization.stageRecords(projectId, { documentId: source.documentId,
      recordRefs: source.records.slice(offset, offset + 200).map((record) => ({ recordId: record.recordId, revision: record.revision })) }, ctx))
    return { ...source, entities }
  }
  const approveAndPublish = async (source: Awaited<ReturnType<typeof importCsv>>) => {
    const confirm = async (candidate: EntityCandidate): Promise<void> => {
      const created = await identity.createRecord(scope, projectId, { candidateId: candidate.candidateId, documentId: source.documentId, relations: [], idempotencyKey: `query-instance-${candidate.candidateId}` }, ctx)
      const confirmed = await instanceService.confirmFields(scope, projectId, candidate.candidateId, { expectedRevision: created.record.recordRevision,
        decisions: created.record.fields.map((field) => ({ fieldId: field.fieldId, decision: 'confirm' })), idempotencyKey: `query-fields-${candidate.candidateId}` }, ctx)
      await identity.adjudicateIdentity(scope, projectId, candidate.candidateId, { expectedRevision: confirmed.record.recordRevision, kind: 'create', reason: 'human verified exact query row', idempotencyKey: `query-identity-${candidate.candidateId}` }, ctx)
      await workflow.publication.reviewCandidate({ candidateId: candidate.candidateId, expectedRevision: '0', decision: 'approve', reason: 'human reviewed exact mapped query cells' }, ctx)
    }
    // Independent rows retain the same human decisions and PG fences under bounded concurrency.
    for (let offset = 0; offset < source.entities.length; offset += 3) {
      await Promise.all(source.entities.slice(offset, offset + 3).map(confirm))
    }
    const results = []
    for (let offset = 0; offset < source.entities.length; offset += 200) {
      results.push(await workflow.publication.publish({ approvedCandidateRefs: source.entities.slice(offset, offset + 200), schemaRef: definition.ref,
        expectedRevision: await publications.latestPublicationRevision(scope, ctx), idempotencyKey: `query-publish-${source.documentId}-${String(offset)}` }, ctx))
    }
    return results
  }
  return { projects, mappings, records, documents, identities, publications, readiness, schemas, workflow, publishedSource, definition, importCsv, restage, approveAndPublish, candidates, instances, instanceService, mappingService, jobs, identity, replaceReadDefinition: (value: SemanticDefinitionVersion) => { readDefinition = value } }
}
