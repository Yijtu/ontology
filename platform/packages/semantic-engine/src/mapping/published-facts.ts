import { isToolContext } from '@ontology/contracts'
import type { IdentityDecisionStore, OntologyConceptRef, PublishedStatement, ResourceRef, ScopeRef, SemanticPublicationStore, ToolContext, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import { SemanticMappingError } from './errors'
import type { OntologyFactPage, OntologyFactQuery, OntologyFactReference, OntologyFactReferenceProvider } from './lookup'

const MAX_PAGE = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

function sameVersion(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function scopeOf(query: ScopeRef, ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId || query.tenantId !== ctx.principal.tenantId || query.spaceId !== ctx.allowedResources.spaceId) {
    throw new SemanticMappingError('SCOPE_MISMATCH', 'published fact lookup requires the trusted tenant/space')
  }
  return query
}

function conceptOf(statement: PublishedStatement, namespace: string): OntologyConceptRef | undefined {
  const conceptId = statement.kind === 'entity' ? statement.objectId : statement.relationId
  return conceptId === undefined ? undefined : { namespace, conceptId }
}

/** A bounded current-view provider. Historical `asOf` reads require a separate bitemporal port. */
export class PublishedFactReferenceProvider implements OntologyFactReferenceProvider {
  readonly #publications: SemanticPublicationStore
  readonly #identity: IdentityDecisionStore
  readonly #namespace: string
  readonly #definitionRef: VersionRef
  readonly #allowedConceptIds: ReadonlySet<string>

  constructor(input: { readonly publications: SemanticPublicationStore; readonly identity: IdentityDecisionStore; readonly namespace: string; readonly definitionRef: VersionRef; readonly allowedConceptIds: readonly string[] }) {
    this.#publications = input.publications
    this.#identity = input.identity
    this.#namespace = input.namespace
    this.#definitionRef = input.definitionRef
    this.#allowedConceptIds = new Set(input.allowedConceptIds)
  }

  async listFacts(query: OntologyFactQuery, ctx: ToolContext): Promise<OntologyFactPage> {
    const scope = scopeOf(query.scopeRef, ctx)
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > MAX_PAGE) throw new SemanticMappingError('INVALID_QUERY_PLAN', 'fact page limit must be between 1 and 200')
    if (query.cursor !== undefined && !UUID.test(query.cursor)) throw new SemanticMappingError('INVALID_QUERY_PLAN', 'fact cursor must be a statement id')
    if (query.timeContext !== undefined) return { facts: [], nextCursor: null, covered: false }
    if (query.concepts.some((concept) => concept.namespace !== this.#namespace || !this.#allowedConceptIds.has(concept.conceptId))) {
      return { facts: [], nextCursor: null, covered: false }
    }
    const wanted = new Set(query.concepts.map((concept) => concept.conceptId))
    const entities = new Set(query.entityRefs.map((ref: ResourceRef) => ref.id))
    const revisionBefore = await this.#publications.latestPublicationRevision(scope, ctx)
    const page = await this.#publications.listStatements(scope, {
      status: 'active', ...(query.cursor === undefined ? {} : { afterStatementId: query.cursor }), limit: query.limit + 1,
    }, ctx)
    const visible = page.slice(0, query.limit)
    const publicationCache = new Map<string, boolean>()
    let covered = page.length <= query.limit
    const facts: OntologyFactReference[] = []
    for (const statement of visible) {
      const concept = conceptOf(statement, this.#namespace)
      if (concept === undefined || !this.#allowedConceptIds.has(concept.conceptId) || (wanted.size > 0 && !wanted.has(concept.conceptId))) continue
      if (entities.size > 0) {
        const from = statement.value['fromEntityId']
        const to = statement.value['toEntityId']
        if (!entities.has(statement.subjectEntityId ?? '') && !entities.has(typeof from === 'string' ? from : '') && !entities.has(typeof to === 'string' ? to : '')) continue
      }
      let pinned = publicationCache.get(statement.publicationId)
      if (pinned === undefined) {
        const publication = await this.#publications.getPublication(scope, statement.publicationId, ctx)
        pinned = publication !== undefined && sameVersion(publication.schemaRef, this.#definitionRef)
        publicationCache.set(statement.publicationId, pinned)
      }
      if (!pinned) { covered = false; continue }
      const bindings = statement.kind === 'entity'
        ? [{ candidateId: statement.sourceCandidateId, entityId: statement.subjectEntityId }]
        : [
            { candidateId: statement.value['fromCandidateId'], entityId: statement.value['fromEntityId'] },
            { candidateId: statement.value['toCandidateId'], entityId: statement.value['toEntityId'] },
          ]
      let identityValid = true
      for (const binding of bindings) {
        if (typeof binding.candidateId !== 'string' || typeof binding.entityId !== 'string') { identityValid = false; break }
        const active = await this.#identity.listAssertions(scope, { candidateId: binding.candidateId, openOnly: true, limit: 2 }, ctx)
        const negatives = await this.#identity.listLinkConstraints(scope, binding.candidateId, ctx)
        if (active.length !== 1 || active[0]?.entityId !== binding.entityId || negatives.some((entry) => entry.entityId === binding.entityId)) { identityValid = false; break }
      }
      if (!identityValid) { covered = false; continue }
      facts.push({
        factRef: { id: statement.statementId, version: `${statement.version}.0.0`, digest: sha256DigestOf(statement) },
        conceptRef: concept, label: statement.predicate,
        ...(statement.validFrom === undefined ? {} : { validity: { validFrom: statement.validFrom, ...(statement.validTo === undefined ? {} : { validTo: statement.validTo }) } }),
        payload: {
          statementId: statement.statementId, statementVersion: statement.version, publicationId: statement.publicationId,
          subjectEntityId: statement.subjectEntityId, predicate: statement.predicate, value: statement.value,
          sourceRefs: statement.sourceRefs, recordedAt: statement.recordedAt,
        },
      })
    }
    const revisionAfter = await this.#publications.latestPublicationRevision(scope, ctx)
    if (revisionAfter !== revisionBefore) return { facts: [], nextCursor: null, covered: false }
    const nextCursor = page.length > query.limit ? visible.at(-1)?.statementId ?? null : null
    return { facts, nextCursor, covered }
  }
}
