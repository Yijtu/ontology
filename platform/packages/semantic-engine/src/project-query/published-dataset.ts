import {
  ProjectDatasetError, assertProjectFactInputShape, isRecord, isToolContext,
} from '@ontology/contracts'
import type {
  IdentityDecisionStore, ProjectDatasetCell, ProjectDatasetFieldSource, ProjectDatasetRow,
  ProjectMappingStore, ProjectPublishedDataset, ProjectPublishedDatasetSource, ProjectRecordStore, ProjectDocumentStore,
  ProjectRevision, PublishedStatement, ScopeRef, SemanticDefinitionVersion, ToolContext, VersionRef,
} from '@ontology/contracts'
import { PublishedSemanticSource } from '../materialization/published-source'
import type { PublishedSemanticReadView } from '../materialization/published-source'
import { stableStringify, sha256DigestOf } from '../definitions/canonical'
import { definitionVersionDigest } from '../definitions/validate'
import { isRuleDecimalValue, isRuleScalarDecimalValue } from '../rules/values'
import type { RuleFact } from '../rules/types'

export interface PublishedProjectDatasetSourceOptions {
  readonly publications: PublishedSemanticReadView
  readonly identity: Pick<IdentityDecisionStore, 'latestReadRevision' | 'readPublishedBindings'>
  readonly records: Pick<ProjectRecordStore, 'getRecord' | 'listRecords'>
  readonly mappings: Pick<ProjectMappingStore, 'getMapping'>
  readonly projectDocuments: Pick<ProjectDocumentStore, 'getMembership' | 'getVisibility'>
  readonly definition: (scope: ScopeRef, ref: VersionRef, ctx: ToolContext) => Promise<SemanticDefinitionVersion | undefined>
}

function sameRef(a: VersionRef, b: VersionRef): boolean {
  return a.id === b.id && a.version === b.version && a.digest === b.digest
}

/** Query values are projected exclusively by the official, identity-checked published reader. */
export class PublishedProjectDatasetSource implements ProjectPublishedDatasetSource {
  constructor(private readonly options: PublishedProjectDatasetSourceOptions) {}

  async read(scope: ScopeRef, revision: ProjectRevision, objectId: string, ctx: ToolContext): Promise<ProjectPublishedDataset> {
    if (!isToolContext(ctx) || scope.tenantId !== ctx.principal.tenantId || scope.spaceId !== ctx.allowedResources.spaceId) {
      throw new ProjectDatasetError('SCOPE_MISMATCH', 'the published project query requires its trusted scope')
    }
    const definition = await this.options.definition(scope, revision.definitionRef, ctx)
    if (definition === undefined || !sameRef(definition.ref, revision.definitionRef) ||
      definition.scopeRef.tenantId !== scope.tenantId || definition.scopeRef.spaceId !== scope.spaceId ||
      definitionVersionDigest(definition) !== revision.definitionRef.digest) {
      throw new ProjectDatasetError('INPUT_NOT_READY', 'the exact published project definition is unavailable or changed')
    }
    const statements = new Map<string, PublishedStatement>()
    const published = this.options.publications
    const sourceOptions = { definition, identity: this.options.identity, projectId: revision.ref.projectId, maxRecords: 20_000 }
    const source = new PublishedSemanticSource({
      latestReadRevision: (s, c) => published.latestReadRevision(s, c),
      getPublication: (s, id, c) => published.getPublication(s, id, c),
      listRuleVersions: (s, f, c) => published.listRuleVersions(s, f, c),
      listStatements: async (s, f, c) => {
        const page = await published.listStatements(s, f, c)
        for (const statement of page) statements.set(statement.statementId, statement)
        return page
      },
    }, sourceOptions)
    const official = await source.load(scope, ctx)
    if (official.complete !== true || official.readRevision === undefined || (official.attributeIssues?.length ?? 0) > 0) {
      throw new ProjectDatasetError('INPUT_NOT_READY', 'the official published fact read is incomplete', { reasons: official.issues?.map((issue) => `${issue.code}: ${issue.message}`) ?? [] })
    }
    const rows: ProjectDatasetRow[] = []
    const selected: PublishedStatement[] = []
    const rowIds = new Set<string>()
    const factsByStatement = new Map<string, RuleFact[]>()
    for (const fact of official.facts) {
      if (fact.sourceStatementId === undefined || fact.op === 'retract') continue
      const facts = factsByStatement.get(fact.sourceStatementId) ?? []
      facts.push(fact)
      factsByStatement.set(fact.sourceStatementId, facts)
    }
    const physicalRecords = new Map<string, Awaited<ReturnType<ProjectRecordStore['getRecord']>>>()
    let cursor: string | undefined
    do {
      const page = await this.options.records.listRecords(scope, revision.ref.projectId, { objectId, limit: 250, ...(cursor === undefined ? {} : { cursor }) }, ctx)
      for (const record of page.records) {
        if (physicalRecords.size >= 20_000) throw new ProjectDatasetError('INPUT_NOT_READY', 'the project provenance read exceeds its bounded record cap')
        physicalRecords.set(record.recordId, record)
      }
      if (page.nextCursor === cursor && cursor !== undefined) throw new ProjectDatasetError('INPUT_NOT_READY', 'project provenance paging did not advance')
      cursor = page.nextCursor
    } while (cursor !== undefined)
    const mappingCache = new Map<string, Awaited<ReturnType<ProjectMappingStore['getMapping']>>>()
    const membershipCache = new Map<string, Awaited<ReturnType<ProjectDocumentStore['getMembership']>>>()
    const visibility = await this.options.projectDocuments.getVisibility(scope, revision.ref.projectId, ctx)
    for (const statement of statements.values()) {
      if (statement.kind !== 'entity' || statement.objectId !== objectId || statement.status !== 'active') continue
      const provenance = statement.value['provenance']
      if (!isRecord(provenance)) continue
      assertProjectFactInputShape(provenance)
      const pin = provenance.sources[0]
      if (pin === undefined || pin.projectRevisionRef.projectId !== revision.ref.projectId) continue
      if (pin.projectRevisionRef.revision !== revision.ref.revision || pin.projectRevisionRef.digest !== revision.ref.digest) continue
      if (provenance.sources.length !== 1 || !sameRef(pin.definitionRef, revision.definitionRef) ||
        !revision.mappingRefs.some((ref) => sameRef(ref, pin.mappingRef))) {
        throw new ProjectDatasetError('INPUT_NOT_READY', 'a published fact disagrees with the project definition or mapping pins')
      }
      const facts = factsByStatement.get(statement.statementId) ?? []
      if (facts.length === 0) continue
      // Records recover physical field locators only. They never supply query values.
      const record = physicalRecords.get(pin.recordId)
      const mappingKey = stableStringify(pin.mappingRef)
      if (!mappingCache.has(mappingKey)) mappingCache.set(mappingKey, await this.options.mappings.getMapping(scope, revision.ref.projectId, pin.mappingRef.id, pin.mappingRef.version, ctx))
      const mapping = mappingCache.get(mappingKey)
      if (!membershipCache.has(pin.documentId)) membershipCache.set(pin.documentId, await this.options.projectDocuments.getMembership(scope, revision.ref.projectId, pin.documentId, ctx))
      const membership = membershipCache.get(pin.documentId)
      if (record === undefined || record.revision !== pin.recordRevision || record.contentDigest !== pin.contentDigest || record.sourceDigest !== pin.sourceDigest ||
        mapping === undefined || !sameRef(mapping.ref, pin.mappingRef) || mapping.parseId !== pin.parseId ||
        membership?.state !== 'active' || membership.membershipRevision !== pin.membershipRevision || membership.parseId !== pin.parseId || visibility?.epoch !== pin.visibilityEpoch ||
        !Array.isArray(provenance['sourceSpans'])) {
        throw new ProjectDatasetError('INPUT_NOT_READY', 'the exact published field provenance is unavailable')
      }
      if (sha256DigestOf({ objectId: record.objectId, fields: record.fields, mappingRef: mapping.ref, sourceDigest: record.sourceDigest, sourceRowKey: record.sourceRowKey }) !== record.contentDigest) throw new ProjectDatasetError('INPUT_NOT_READY', 'the published physical row provenance content changed')
      const spans: unknown[] = provenance['sourceSpans']
      const values: Record<string, ProjectDatasetCell> = {}
      const sources: ProjectDatasetFieldSource[] = []
      for (const fact of facts) {
        const value = fact.value
        const field = record.fields.find((field) => field.fieldId === fact.predicate)
        const span = spans.find((span) => isRecord(span) && span['kind'] === 'structured' && span['recordId'] === pin.recordId &&
          span['parseId'] === pin.parseId && span['rowDigest'] === pin.sourceDigest && stableStringify(span['locator']) === stableStringify(field?.locator))
        if (field === undefined || span === undefined || values[fact.predicate] !== undefined) {
          throw new ProjectDatasetError('INPUT_NOT_READY', 'a published value has conflicting values or no exact cell source')
        }
        if (isRuleScalarDecimalValue(value)) values[fact.predicate] = { kind: 'scalar', value: value.amount }
        else if (isRuleDecimalValue(value)) values[fact.predicate] = { kind: 'quantity', value: value.amount, unitCode: value.unit }
        else if (typeof value === 'string' || typeof value === 'boolean') values[fact.predicate] = { kind: 'scalar', value }
        else throw new ProjectDatasetError('INPUT_NOT_READY', 'an official fact has no queryable canonical value')
        sources.push({ fieldId: fact.predicate, documentRef: mapping.originalRef, parseId: pin.parseId, locator: field.locator,
          factSource: pin, statementId: statement.statementId, statementVersion: statement.version, recordedAt: statement.recordedAt, rowDigest: pin.sourceDigest })
      }
      if (rowIds.has(pin.recordId)) throw new ProjectDatasetError('INPUT_NOT_READY', 'multiple published statements compete for one physical project row')
      rowIds.add(pin.recordId)
      rows.push({ recordId: pin.recordId, objectId, sourceRowKey: record.sourceRowKey, values, sources })
      selected.push(statement)
    }
    if (rows.length === 0) throw new ProjectDatasetError('INPUT_NOT_READY', 'no active official facts exist for this exact project revision and object')
    const afterVisibility = await this.options.projectDocuments.getVisibility(scope, revision.ref.projectId, ctx)
    if (afterVisibility?.epoch !== visibility?.epoch) throw new ProjectDatasetError('INPUT_NOT_READY', 'the source visibility changed during the published project read')
    rows.sort((a, b) => a.recordId.localeCompare(b.recordId))
    selected.sort((a, b) => a.statementId.localeCompare(b.statementId))
    return { rows, coverage: { expectedCount: rows.length, processedCount: rows.length, excluded: [], completeness: 'complete' },
      factRecordedPoint: official.readRevision,
      sourceDigest: sha256DigestOf({ scope, projectRevisionRef: revision.ref, definitionRef: definition.ref, statements: selected }) }
  }
}
