import type {
  ResourceRef,
  ScopeRef,
  Sha256Digest,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { isToolContext } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import type { MaterializationPublishedSource, PublishedSemanticData } from '../materialization/types'
import type { RuleFact } from '../rules'
import type { OntologyFactPage, OntologyFactQuery, OntologyFactReference, OntologyFactReferenceProvider } from './lookup'
import { SemanticMappingError } from './errors'

export interface PublishedFactsReferenceProviderOptions {
  /** The same scope-pinned reader used by materialization; never a raw candidate store. */
  readonly source: MaterializationPublishedSource
  readonly namespace: string
  /** Exact schema pin chosen by the host/run, not selected by latest version. */
  readonly definitionRef: VersionRef
  /** Injectable wall clock for the default current valid-time view. */
  readonly now?: () => string
}

interface PublishedFactsCursor {
  readonly version: 1
  readonly queryDigest: Sha256Digest
  readonly readRevision: { readonly semantic: string; readonly identity: string }
  readonly afterKey: string
  readonly validAt: string
}

function sameVersion(left: VersionRef | undefined, right: VersionRef): boolean {
  return left !== undefined && left.id === right.id && left.version === right.version && left.digest === right.digest
}

function revisionVersion(revision: string): VersionRef['version'] | undefined {
  if (!/^(?:0|[1-9]\d*)$/.test(revision)) return undefined
  return `${revision}.0.0` as VersionRef['version']
}

function compareReadRevision(
  left: PublishedFactsCursor['readRevision'],
  right: PublishedFactsCursor['readRevision'] | undefined,
): boolean {
  return right !== undefined && left.semantic === right.semantic && left.identity === right.identity
}

function canonicalConcepts(concepts: OntologyFactQuery['concepts']): unknown {
  return concepts
    .map((concept) => ({
      namespace: concept.namespace,
      conceptId: concept.conceptId,
      definitionVersion: concept.definitionVersion ?? null,
    }))
    .sort((left, right) =>
      `${left.namespace}\u0000${left.conceptId}\u0000${left.definitionVersion ?? ''}`.localeCompare(
        `${right.namespace}\u0000${right.conceptId}\u0000${right.definitionVersion ?? ''}`,
      ),
    )
}

function canonicalResources(refs: readonly ResourceRef[]): unknown {
  return refs
    .map((ref) => ({ id: ref.id, version: ref.version, digest: ref.digest, kind: ref.kind }))
    .sort((left, right) => `${left.kind}\u0000${left.id}\u0000${left.version}\u0000${left.digest}`.localeCompare(
      `${right.kind}\u0000${right.id}\u0000${right.version}\u0000${right.digest}`,
    ))
}

function factKey(fact: RuleFact): string {
  return JSON.stringify([fact.subject, fact.predicate, fact.assertionId, fact.recordedSeq])
}

function cursorOf(value: unknown): PublishedFactsCursor | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value) return undefined
    const parsed: unknown = JSON.parse(decoded)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    const record = parsed as Record<string, unknown>
    const revision = record['readRevision']
    if (typeof revision !== 'object' || revision === null || Array.isArray(revision)) return undefined
    const revisionRecord = revision as Record<string, unknown>
    if (
      record['version'] !== 1 ||
      typeof record['queryDigest'] !== 'string' ||
      typeof record['afterKey'] !== 'string' ||
      typeof record['validAt'] !== 'string' ||
      typeof revisionRecord['semantic'] !== 'string' ||
      typeof revisionRecord['identity'] !== 'string'
    ) return undefined
    return {
      version: 1,
      queryDigest: record['queryDigest'] as Sha256Digest,
      readRevision: {
        semantic: revisionRecord['semantic'],
        identity: revisionRecord['identity'],
      },
      afterKey: record['afterKey'],
      validAt: record['validAt'],
    }
  } catch {
    return undefined
  }
}

function encodeCursor(cursor: PublishedFactsCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function includesConcept(fact: RuleFact, concepts: readonly OntologyFactQuery['concepts'][number][]): boolean {
  if (concepts.length === 0) return true
  const attributeId = fact.attributeId ?? fact.predicate
  return concepts.some((concept) => concept.conceptId === attributeId || concept.conceptId === fact.objectId)
}

function includesEntity(fact: RuleFact, entityRefs: readonly ResourceRef[]): boolean {
  return entityRefs.length === 0 || entityRefs.some((ref) => ref.id === fact.subject)
}

function issuesFor(snapshot: PublishedSemanticData): string[] {
  return [
    ...(snapshot.issues ?? []).map((issue) => `${issue.code}: ${issue.message}`),
    ...(snapshot.attributeIssues ?? []).map((issue) => `${issue.code}: ${issue.message}`),
  ]
}

function sourceFactReference(
  fact: RuleFact,
  scopeRef: ScopeRef,
  definitionRef: VersionRef,
  namespace: string,
): OntologyFactReference | undefined {
  if (
    fact.sourceStatementId === undefined ||
    fact.subject.length === 0 ||
    fact.objectId === undefined ||
    !sameVersion(fact.schemaRef, definitionRef) ||
    fact.value === undefined
  ) return undefined
  const version = revisionVersion(fact.recordedSeq)
  if (version === undefined) return undefined
  const attributeId = fact.attributeId ?? fact.predicate
  return {
    factRef: {
      id: fact.assertionId,
      version,
      digest: sha256DigestOf({ scopeRef, definitionRef, fact }),
    },
    conceptRef: {
      namespace,
      conceptId: attributeId,
      definitionVersion: definitionRef.version,
    },
    label: attributeId,
    validity: { ...fact.validity },
    payload: {
      subjectEntityId: fact.subject,
      objectId: fact.objectId,
      attributeId,
      predicate: fact.predicate,
      value: fact.value,
      ...(typeof fact.value === 'object' ? { unitCode: fact.value.unit } : {}),
      schemaRef: fact.schemaRef,
      validity: { ...fact.validity },
      recordedSeq: fact.recordedSeq,
      assertionId: fact.assertionId,
      logicalAssertionId: fact.logicalAssertionId,
      sourceStatementId: fact.sourceStatementId,
      sourceRefs: fact.sourceRefs ?? [],
    },
  }
}

function unsupportedCoverageReason(query: OntologyFactQuery, sourceFacts: readonly RuleFact[]): string | undefined {
  const concepts = query.concepts
  if (concepts.length === 0) {
    return 'the published fact source covers entity attributes only; relation and derived facts are not included'
  }
  const ids = new Set(sourceFacts.map((fact) => fact.attributeId ?? fact.predicate))
  const objectIds = new Set(sourceFacts.map((fact) => fact.objectId).filter((value): value is string => value !== undefined))
  const exactAttributeQuery = concepts.every((concept) => ids.has(concept.conceptId) && !objectIds.has(concept.conceptId))
  return exactAttributeQuery
    ? undefined
    : 'the requested concept is not verified as an attribute in this published snapshot; relation and derived facts are not covered'
}

/**
 * Read-only bridge from the scope-pinned published fact projection into ontology_lookup.
 * This returns only source-backed published facts; it never presents a schema definition or a
 * rule conclusion as an entity instance.
 */
export class PublishedFactsReferenceProvider implements OntologyFactReferenceProvider {
  readonly #source: MaterializationPublishedSource
  readonly #namespace: string
  readonly #definitionRef: VersionRef
  readonly #now: () => string

  constructor(options: PublishedFactsReferenceProviderOptions) {
    this.#source = options.source
    this.#namespace = options.namespace
    this.#definitionRef = options.definitionRef
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async listFacts(query: OntologyFactQuery, ctx: ToolContext): Promise<OntologyFactPage> {
    this.#assertScope(query.scopeRef, ctx)
    const empty = (issues: readonly string[], definitionRef = this.#definitionRef): OntologyFactPage => ({
      facts: [],
      nextCursor: null,
      covered: false,
      definitionRef,
      issues,
    })

    if (query.timeContext?.asOf !== undefined) {
      return empty(['historical asOf is unsupported by the latest-head published fact reader; no current-head fallback is used'])
    }
    const currentCursor = query.cursor === undefined ? undefined : cursorOf(query.cursor)
    if (query.cursor !== undefined && currentCursor === undefined) return empty(['fact cursor is malformed'])
    const requestedValidAt = query.validAt ?? query.timeContext?.validAt
    const effectiveValidAt = currentCursor?.validAt ?? requestedValidAt ?? this.#now()
    if (!Number.isFinite(Date.parse(effectiveValidAt))) return empty(['validAt is not a valid timestamp'])
    if (currentCursor !== undefined && requestedValidAt !== undefined && requestedValidAt !== currentCursor.validAt) {
      return empty(['validAt does not match the time pinned by the fact cursor'])
    }
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 10_000) {
      return empty(['fact page limit is outside the bounded range'])
    }
    if (query.concepts.some((concept) => concept.definitionVersion !== undefined && concept.definitionVersion !== this.#definitionRef.version)) {
      return empty(['requested concept definition version does not match the provider pin'])
    }

    let snapshot: PublishedSemanticData
    try {
      snapshot = await this.#source.load(query.scopeRef, ctx)
    } catch (error) {
      return empty([error instanceof Error ? error.message : 'published fact source did not complete a stable read'])
    }
    const issues = issuesFor(snapshot)
    if (snapshot.complete !== true) {
      return empty(issues.length > 0 ? issues : ['published fact source did not complete its bounded stable read'])
    }
    if (snapshot.readRevision === undefined) {
      return empty(['published fact source does not expose a monotonic revision vector'])
    }
    if (snapshot.definitionRef !== undefined && !sameVersion(snapshot.definitionRef, this.#definitionRef)) {
      return empty(['published fact source definition pin does not match the provider definition pin'])
    }
    const sourceAttributeIssues = (snapshot.attributeIssues ?? []).filter((issue) => issue.code !== 'DUPLICATE_ATTRIBUTE_ID')
    if (sourceAttributeIssues.length > 0) {
      return empty(sourceAttributeIssues.map((issue) => `${issue.code}: ${issue.message}`))
    }

    const namespaceConcepts = query.concepts.filter((concept) => concept.namespace === this.#namespace)
    const foreignConcepts = query.concepts.filter((concept) => concept.namespace !== this.#namespace)
    const scopedSourceFacts = snapshot.facts.filter(
      (fact) => fact.op !== 'retract' && fact.subject.length > 0 && fact.objectId !== undefined,
    )
    const relationAndDerivedGap = unsupportedCoverageReason({ ...query, concepts: namespaceConcepts }, scopedSourceFacts)
    const baseQueryDigest = sha256DigestOf({
      scopeRef: query.scopeRef,
      namespace: this.#namespace,
      definitionRef: this.#definitionRef,
      concepts: canonicalConcepts(query.concepts),
      entityRefs: canonicalResources(query.entityRefs),
      validAt: effectiveValidAt,
      timeContext: query.timeContext ?? null,
    })
    if (currentCursor !== undefined) {
      if (!compareReadRevision(currentCursor.readRevision, snapshot.readRevision)) {
        return empty(['published or identity read revision changed between fact pages'])
      }
      if (currentCursor.queryDigest !== baseQueryDigest) {
        return empty(['fact cursor is bound to a different scope, definition, entity/concept filter or time range'])
      }
    }

    if (foreignConcepts.length > 0) {
      return empty(['one or more concepts use a namespace not covered by this published fact provider'])
    }
    const validAt = effectiveValidAt
    const filtered: RuleFact[] = []
    for (const fact of scopedSourceFacts) {
      if (!includesConcept(fact, namespaceConcepts)) continue
      if (!includesEntity(fact, query.entityRefs)) continue
      const temporal = validAt === undefined ? true : validAtFact(fact, validAt)
      if (temporal === undefined) return empty(['a published fact has malformed validity timestamps'])
      if (temporal) filtered.push(fact)
    }
    filtered.sort((left, right) => factKey(left).localeCompare(factKey(right)))
    const seenKeys = new Set<string>()
    for (const fact of filtered) {
      const key = factKey(fact)
      if (seenKeys.has(key)) return empty(['published facts contain a repeated or non-monotonic fact key'])
      seenKeys.add(key)
    }

    if (currentCursor !== undefined) {
      const anchor = filtered.findIndex((fact) => factKey(fact) === currentCursor.afterKey)
      if (anchor < 0) return empty(['fact cursor anchor is absent from the pinned query result'])
      const next = filtered.slice(anchor + 1, anchor + 1 + query.limit)
      const references = next.map((fact) => sourceFactReference(fact, query.scopeRef, this.#definitionRef, this.#namespace))
      if (references.some((ref) => ref === undefined)) return empty(['a published attribute fact lacks an exact source/version reference'])
      const facts = references.filter((ref): ref is OntologyFactReference => ref !== undefined)
      const hasMore = anchor + 1 + facts.length < filtered.length
      const last = next.at(-1)
      const nextCursor = hasMore && last !== undefined
        ? encodeCursor({
            version: 1,
            queryDigest: baseQueryDigest,
            readRevision: snapshot.readRevision,
            afterKey: factKey(last),
            validAt: effectiveValidAt,
          })
        : null
      return {
        facts,
        nextCursor,
        covered: relationAndDerivedGap === undefined,
        definitionRef: this.#definitionRef,
        ...(relationAndDerivedGap === undefined ? {} : { issues: [relationAndDerivedGap] }),
      }
    }

    const first = filtered.slice(0, query.limit)
    const references = first.map((fact) => sourceFactReference(fact, query.scopeRef, this.#definitionRef, this.#namespace))
    if (references.some((ref) => ref === undefined)) return empty(['a published attribute fact lacks an exact source/version reference'])
    const facts = references.filter((ref): ref is OntologyFactReference => ref !== undefined)
    const hasMore = facts.length < filtered.length
    const last = first.at(-1)
    const firstNextCursor = hasMore && last !== undefined
      ? encodeCursor({
          version: 1,
          queryDigest: baseQueryDigest,
          readRevision: snapshot.readRevision,
          afterKey: factKey(last),
          validAt: effectiveValidAt,
        })
      : null
    const unsupportedIssues = [
      ...(relationAndDerivedGap === undefined ? [] : [relationAndDerivedGap]),
      ...(namespaceConcepts.length === 0 && query.concepts.length > 0 ? ['no requested concept belongs to this fact namespace'] : []),
    ]
    return {
      facts,
      nextCursor: firstNextCursor,
      covered: unsupportedIssues.length === 0,
      definitionRef: this.#definitionRef,
      ...(unsupportedIssues.length === 0 ? {} : { issues: unsupportedIssues }),
    }
  }

  #assertScope(scopeRef: ScopeRef, ctx: ToolContext): void {
    if (!isToolContext(ctx)) {
      throw new SemanticMappingError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (ctx.allowedResources.tenantId !== tenantId || scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
      throw new SemanticMappingError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
  }
}

function validAtFact(fact: RuleFact, validAt: string): boolean | undefined {
  const at = Date.parse(validAt)
  const from = Date.parse(fact.validity.validFrom)
  const to = fact.validity.validTo === undefined ? undefined : Date.parse(fact.validity.validTo)
  if (!Number.isFinite(at) || !Number.isFinite(from) || (to !== undefined && !Number.isFinite(to))) return undefined
  return from <= at && (to === undefined || at < to)
}
