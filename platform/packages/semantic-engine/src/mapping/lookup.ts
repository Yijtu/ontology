import { compareSemver, isToolContext } from '@ontology/contracts'
import type {
  CompletenessStatus,
  OntologyConceptRef,
  OntologyLookupInput,
  OntologyLookupItem,
  OntologyLookupOutput,
  ResourceRef,
  ScopeRef,
  SemanticDefinitionVersion,
  Semver,
  Sha256Digest,
  TimeContext,
  ToolContext,
  VersionRef,
  ValidityInterval,
} from '@ontology/contracts'
import type { SemanticDefinitionService } from '../definitions/service'
import { SemanticMappingError } from './errors'
import type { SemanticMappingRegistry } from './types'

/**
 * Local, bounded ontology lookup (SPEC C4). It answers with the definitions/mappings/
 * facts visible in the trusted scope, and it is explicit about what it did not cover:
 *
 *  - results are paginated (opaque cursor) and the caller can tell a truncated page from a
 *    complete one;
 *  - a concept that has no definition, no mapping or no fact reference is reported as a
 *    gap, never fabricated;
 *  - a type/definition is returned with `kind: 'definition'`/`'relation'`/`'rule'`, a
 *    source-object reference with `kind: 'mapping'`, and only real instance references with
 *    `kind: 'fact'`. A schema path is never presented as an instance fact;
 *  - nothing is ever published. The service only reads.
 */

const UNPUBLISHED_REF: VersionRef = {
  id: 'semantic.definitions',
  version: '0.0.0',
  digest: `sha256:${'0'.repeat(64)}` as Sha256Digest,
}

const DEFAULT_PAGE_SIZE = 50
const DEFAULT_MAX_PAGE_SIZE = 200

export interface OntologyFactReference {
  readonly factRef: VersionRef
  readonly conceptRef: OntologyConceptRef
  readonly label?: string
  readonly validity?: ValidityInterval
  readonly payload?: unknown
}

export interface OntologyFactQuery {
  readonly scopeRef: ScopeRef
  readonly concepts: readonly OntologyConceptRef[]
  readonly entityRefs: readonly ResourceRef[]
  readonly cursor?: string
  readonly limit: number
  readonly timeContext?: TimeContext
  /** Valid-time-only filter; this is distinct from a recorded-time asOf snapshot. */
  readonly validAt?: string
}

export interface OntologyFactPage {
  readonly facts: readonly OntologyFactReference[]
  readonly nextCursor: string | null
  /** True only when the provider actually searched the covered fact set. */
  readonly covered: boolean
  /** The pinned schema used to interpret facts; a fact ref is never a schema ref. */
  readonly definitionRef?: VersionRef
  /** Reasons a provider could not cover the complete requested fact set. */
  readonly issues?: readonly string[]
}

/**
 * The fact-reference source. It is injected so extraction (LOCAL-027/028) can provide real
 * references later; when it is absent the lookup reports facts as uncovered rather than
 * mislabelling definitions as facts.
 */
export interface OntologyFactReferenceProvider {
  listFacts(query: OntologyFactQuery, ctx: ToolContext): Promise<OntologyFactPage>
}

export interface OntologyLookupDependencies {
  readonly definitions: SemanticDefinitionService
  readonly mappings?: SemanticMappingRegistry
  readonly facts?: OntologyFactReferenceProvider
  readonly pageSize?: number
  readonly maxPageSize?: number
}

export interface OntologyLookupPage {
  readonly output: OntologyLookupOutput
  readonly nextCursor: string | null
  readonly completeness: CompletenessStatus
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const offset = (parsed as { o?: unknown }).o
      if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) return offset
    }
  } catch {
    return 0
  }
  return 0
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function conceptKey(concept: OntologyConceptRef): string {
  return `${concept.namespace}/${concept.conceptId}${concept.definitionVersion === undefined ? '' : `@${concept.definitionVersion}`}`
}

function itemSortKey(item: OntologyLookupItem): string {
  return `${item.kind}\u0000${item.ref.id}\u0000${item.ref.version}\u0000${item.label ?? ''}`
}

function versionCoversConcept(version: SemanticDefinitionVersion, conceptId: string): boolean {
  return (
    version.objects.some((object) => object.id === conceptId) ||
    version.attributes.some((attribute) => attribute.id === conceptId || attribute.objectId === conceptId) ||
    version.relations.some(
      (relation) => relation.id === conceptId || relation.fromObjectId === conceptId || relation.toObjectId === conceptId,
    ) ||
    version.ruleConstraints.some((rule) => rule.id === conceptId || rule.objectId === conceptId)
  )
}

export class OntologyLookupService {
  readonly #definitions: SemanticDefinitionService
  readonly #mappings: SemanticMappingRegistry | undefined
  readonly #facts: OntologyFactReferenceProvider | undefined
  readonly #pageSize: number
  readonly #maxPageSize: number

  constructor(dependencies: OntologyLookupDependencies) {
    this.#definitions = dependencies.definitions
    this.#mappings = dependencies.mappings
    this.#facts = dependencies.facts
    this.#pageSize = dependencies.pageSize ?? DEFAULT_PAGE_SIZE
    this.#maxPageSize = dependencies.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE
  }

  async lookup(input: OntologyLookupInput, ctx: ToolContext): Promise<OntologyLookupPage> {
    this.#assertScope(input.scopeRef, ctx)
    const limit = Math.min(Math.max(input.limit ?? this.#pageSize, 1), this.#maxPageSize)
    const concepts = input.concepts ?? []
    const entityRefs = input.entityRefs ?? []

    if (input.intent === 'facts') {
      const facts = await this.#factItems(
        input.scopeRef,
        concepts,
        entityRefs,
        input.timeContext,
        input.cursor,
        limit,
        ctx,
      )
      const nextCursor = facts.nextCursor
      const completeness: CompletenessStatus =
        !facts.covered
          ? 'unknown'
          : nextCursor !== null
            ? 'partial'
            : facts.gaps.length > 0 && facts.items.length === 0
              ? 'unknown'
              : 'complete'
      const definitionVersion = facts.primaryRef ?? (await this.#fallbackRef(input.scopeRef, concepts, ctx))
      return {
        output: {
          items: facts.items,
          gaps: facts.gaps,
          definitionVersion,
          autoPublished: false,
        },
        nextCursor,
        completeness,
      }
    }

    const offset = decodeCursor(input.cursor)

    const items: OntologyLookupItem[] = []
    const gaps: string[] = []
    let primaryRef: VersionRef | undefined

    if (input.intent === 'resolve') {
      const resolved = await this.#resolveItems(input.scopeRef, concepts, ctx)
      items.push(...resolved.items)
      gaps.push(...resolved.gaps)
      primaryRef = resolved.primaryRef
      if (entityRefs.length > 0) {
        gaps.push(`entity_resolution_uncovered:${String(entityRefs.length)} reference(s) have no instance mapping`)
      }
    } else {
      const resolved = await this.#definitionItems(input.scopeRef, concepts, input.intent, ctx)
      items.push(...resolved.items)
      gaps.push(...resolved.gaps)
      primaryRef = resolved.primaryRef
    }

    items.sort((left, right) => {
      const a = itemSortKey(left)
      const b = itemSortKey(right)
      return a < b ? -1 : a > b ? 1 : 0
    })

    const page = items.slice(offset, offset + limit)
    const nextCursor = offset + page.length < items.length ? encodeCursor(offset + page.length) : null
    const definitionVersion = primaryRef ?? (await this.#fallbackRef(input.scopeRef, concepts, ctx))
    const completeness: CompletenessStatus =
      nextCursor !== null
        ? 'partial'
        : gaps.length > 0 && page.length === 0
          ? 'unknown'
          : 'complete'

    return {
      output: {
        items: page,
        gaps,
        definitionVersion,
        autoPublished: false,
      },
      nextCursor,
      completeness,
    }
  }

  async #definitionItems(
    scopeRef: ScopeRef,
    concepts: readonly OntologyConceptRef[],
    intent: 'definitions' | 'relations' | 'rules',
    ctx: ToolContext,
  ): Promise<{ items: OntologyLookupItem[]; gaps: string[]; primaryRef: VersionRef | undefined }> {
    const items: OntologyLookupItem[] = []
    const gaps: string[] = []
    let primaryRef: VersionRef | undefined

    const namespaces = unique(concepts.map((concept) => concept.namespace))
    const allVersions = await this.#definitions.listVersions(scopeRef, {}, ctx)
    const targetNamespaces = namespaces.length > 0 ? namespaces : unique(allVersions.map((version) => version.namespace))

    for (const namespace of targetNamespaces) {
      const versions = allVersions.filter((version) => version.namespace === namespace)
      if (versions.length === 0) {
        gaps.push(`no_definition_version:${namespace}`)
        continue
      }
      const requested = concepts.filter((concept) => concept.namespace === namespace)
      const selected = this.#selectVersions(versions, requested)
      const selectedRefs = new Set(selected.map((version) => version.version))
      for (const concept of requested) {
        if (concept.definitionVersion !== undefined && !selectedRefs.has(concept.definitionVersion)) {
          gaps.push(`definition_version_uncovered:${conceptKey(concept)}`)
        }
      }
      for (const version of selected) {
        const requestedIds = new Set(requested.map((concept) => concept.conceptId))
        const matched = this.#versionItems(version, requestedIds)
        for (const concept of requested) {
          if (!matched.seen.has(concept.conceptId)) {
            gaps.push(`concept_uncovered:${conceptKey(concept)}`)
          }
        }
        items.push(...matched.items)
        if (primaryRef === undefined) primaryRef = version.ref
      }
    }

    if (intent === 'relations') {
      return { items: items.filter((item) => item.kind === 'relation'), gaps, primaryRef }
    }
    if (intent === 'rules') {
      return { items: items.filter((item) => item.kind === 'rule'), gaps, primaryRef }
    }
    return { items: items.filter((item) => item.kind === 'definition'), gaps, primaryRef }
  }

  #versionItems(
    version: SemanticDefinitionVersion,
    requestedIds: ReadonlySet<string>,
  ): { items: OntologyLookupItem[]; seen: Set<string> } {
    const items: OntologyLookupItem[] = []
    const seen = new Set<string>()
    const wants = (conceptId: string): boolean => requestedIds.size === 0 || requestedIds.has(conceptId)
    const conceptRefOf = (conceptId: string): OntologyConceptRef => ({
      namespace: version.namespace,
      conceptId,
      definitionVersion: version.version,
    })

    for (const object of version.objects) {
      if (!wants(object.id)) continue
      seen.add(object.id)
      items.push({
        kind: 'definition',
        ref: version.ref,
        conceptRef: conceptRefOf(object.id),
        label: object.displayName,
        payload: object,
      })
    }
    for (const attribute of version.attributes) {
      if (!wants(attribute.objectId) && !wants(attribute.id)) continue
      seen.add(attribute.objectId)
      items.push({
        kind: 'definition',
        ref: version.ref,
        conceptRef: conceptRefOf(attribute.id),
        label: attribute.id,
        payload: attribute,
      })
    }
    for (const relation of version.relations) {
      if (!wants(relation.fromObjectId) && !wants(relation.toObjectId) && !wants(relation.id)) continue
      seen.add(relation.fromObjectId)
      seen.add(relation.toObjectId)
      items.push({
        kind: 'relation',
        ref: version.ref,
        conceptRef: conceptRefOf(relation.id),
        label: relation.id,
        payload: relation,
      })
    }
    for (const rule of version.ruleConstraints) {
      if (!wants(rule.objectId) && !wants(rule.id)) continue
      seen.add(rule.objectId)
      items.push({
        kind: 'rule',
        ref: version.ref,
        conceptRef: conceptRefOf(rule.id),
        label: rule.id,
        payload: rule,
      })
    }
    return { items, seen }
  }

  #selectVersions(
    versions: readonly SemanticDefinitionVersion[],
    requested: readonly OntologyConceptRef[],
  ): SemanticDefinitionVersion[] {
    const sorted = [...versions].sort((left, right) => -compareSemver(left.version, right.version))
    const pinned = unique(
      requested
        .map((concept) => concept.definitionVersion)
        .filter((value): value is Semver => value !== undefined),
    )
    if (pinned.length > 0) {
      return sorted.filter((version) => pinned.includes(version.version))
    }
    const requestedIds = new Set(requested.map((concept) => concept.conceptId))
    if (requestedIds.size > 0) {
      // Select every visible version that actually declares one of the requested concepts,
      // so a core and an extension version are both read instead of only the newest.
      const covering = sorted.filter((version) =>
        [...requestedIds].some((conceptId) => versionCoversConcept(version, conceptId)),
      )
      if (covering.length > 0) return covering
    }
    const newest = sorted[0]
    return newest === undefined ? [] : [newest]
  }

  async #resolveItems(
    scopeRef: ScopeRef,
    concepts: readonly OntologyConceptRef[],
    ctx: ToolContext,
  ): Promise<{ items: OntologyLookupItem[]; gaps: string[]; primaryRef: VersionRef | undefined }> {
    const items: OntologyLookupItem[] = []
    const gaps: string[] = []
    const allVersions = await this.#definitions.listVersions(scopeRef, {}, ctx)
    const newestDefinition = [...allVersions].sort((left, right) => -compareSemver(left.version, right.version))[0]
    const primaryRef = newestDefinition?.ref
    const registry = this.#mappings
    if (registry === undefined) {
      for (const concept of concepts) gaps.push(`mapping_uncovered:${conceptKey(concept)}`)
      return { items, gaps, primaryRef }
    }
    const targetConcepts =
      concepts.length > 0
        ? concepts
        : unique(
            allVersions.flatMap((version) => version.objects.map((object) => ({
              namespace: version.namespace,
              conceptId: object.id,
            }))),
          )
    for (const concept of targetConcepts) {
      const mapping = registry
        .list()
        .find((candidate) => candidate.objects.some((object) => object.conceptId === concept.conceptId))
      if (mapping === undefined) {
        gaps.push(`mapping_uncovered:${conceptKey(concept)}`)
        continue
      }
      const object = mapping.objects.find((candidate) => candidate.conceptId === concept.conceptId)
      items.push({
        kind: 'mapping',
        ref: mapping.mappingRef,
        conceptRef: concept,
        label: object?.sourceObjectRef.objectPath ?? concept.conceptId,
        payload: {
          mappingRef: mapping.mappingRef,
          dialect: mapping.dialect,
          ...(object === undefined ? {} : { sourceObjectRef: object.sourceObjectRef }),
        },
      })
    }
    return { items, gaps, primaryRef }
  }

  async #factItems(
    scopeRef: ScopeRef,
    concepts: readonly OntologyConceptRef[],
    entityRefs: readonly ResourceRef[],
    timeContext: TimeContext | undefined,
    cursor: string | undefined,
    limit: number,
    ctx: ToolContext,
  ): Promise<{
    items: OntologyLookupItem[]
    gaps: string[]
    primaryRef: VersionRef | undefined
    nextCursor: string | null
    covered: boolean
  }> {
    const provider = this.#facts
    if (provider === undefined) {
      return {
        items: [],
        gaps: ['facts_uncovered:no fact reference provider is configured'],
        primaryRef: undefined,
        nextCursor: null,
        covered: false,
      }
    }
    const page = await provider.listFacts(
      {
        scopeRef,
        concepts,
        entityRefs,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
        ...(timeContext?.validAt === undefined ? {} : { validAt: timeContext.validAt }),
        ...(timeContext === undefined ? {} : { timeContext }),
      },
      ctx,
    )
    const malformedPage =
      page.facts.length > limit ||
      (cursor !== undefined && page.nextCursor === cursor)
    const items: OntologyLookupItem[] = page.facts.map((fact) => ({
      kind: 'fact',
      ref: fact.factRef,
      conceptRef: fact.conceptRef,
      ...(fact.label === undefined ? {} : { label: fact.label }),
      ...(fact.validity === undefined ? {} : { validity: fact.validity }),
      ...(fact.payload === undefined ? {} : { payload: fact.payload }),
    }))
    const gaps: string[] = []
    if (!page.covered || malformedPage) gaps.push('facts_uncovered:the provider did not complete a stable fact page')
    for (const issue of page.issues ?? []) gaps.push(`facts_uncovered:${issue}`)
    if (items.length === 0 && page.covered && !malformedPage) gaps.push('facts_uncovered:no matching fact reference was found')
    return {
      items: malformedPage ? [] : items,
      gaps,
      primaryRef: page.definitionRef ?? page.facts[0]?.factRef,
      nextCursor: malformedPage ? null : page.nextCursor,
      covered: page.covered && !malformedPage,
    }
  }

  async #fallbackRef(
    scopeRef: ScopeRef,
    concepts: readonly OntologyConceptRef[],
    ctx: ToolContext,
  ): Promise<VersionRef> {
    const versions = await this.#definitions.listVersions(scopeRef, {}, ctx)
    if (versions.length === 0) return UNPUBLISHED_REF
    const namespace = concepts[0]?.namespace
    const candidates = namespace === undefined ? versions : versions.filter((v) => v.namespace === namespace)
    const pool = candidates.length === 0 ? versions : candidates
    const newest = [...pool].sort((left, right) => -compareSemver(left.version, right.version))[0]
    return newest?.ref ?? UNPUBLISHED_REF
  }

  #assertScope(scopeRef: ScopeRef, ctx: ToolContext): void {
    if (!isToolContext(ctx)) {
      throw new SemanticMappingError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const tenantId = ctx.principal.tenantId
    const spaceId = ctx.allowedResources.spaceId
    if (ctx.allowedResources.tenantId !== tenantId) {
      throw new SemanticMappingError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
    }
    if (scopeRef.tenantId !== tenantId || scopeRef.spaceId !== spaceId) {
      throw new SemanticMappingError('SCOPE_MISMATCH', 'request scope does not match the trusted principal scope')
    }
  }
}
