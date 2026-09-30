import { isToolContext } from '@ontology/contracts'
import type {
  IdentityDecisionStore,
  PublishedStatement,
  RelationNavigationHop,
  RelationNavigationPath,
  RelationNavigationRequest,
  RelationNavigationResult,
  ResourceRef,
  RevisionString,
  ScopeRef,
  SemanticPublicationStore,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import { RelationNavigationError, isRelationNavigationRequest } from '@ontology/contracts'

/**
 * Bounded navigation over ACTUAL published relation statements (SPEC v0.3a execution-evidence
 * EX-4.3, issue V03-027 / #195; A.US-008.AC-02, A.FR-14).
 *
 * The navigator reads only published, active relation statements (`kind: 'relation'`) whose
 * endpoints resolve to confirmed entities through the identity decision store. A physical
 * mapping/JOIN or a provenance/evidence edge is never an entity relation and is never walked.
 *
 * Every traversal is bounded: at most three hops, a bounded scan, fan-out, entity set and path
 * count. Any bound, staleness or mismatch produces an explicit gap and a `partial`/`unknown`
 * completeness — the navigator never claims a complete, unique answer it did not verify. A
 * cyclic expansion (an edge back to an entity already on the path) is refused explicitly.
 */

const PAGE_SIZE = 100
const MAX_SCANNED = 1_000
const MAX_HOPS = 3
const MAX_PATHS = 32
const MAX_FANOUT = 64
const MAX_ENTITIES = 256

/** The publication reads the navigator needs; the semantic publication store satisfies it. */
export type RelationNavigationPublicationPort = Pick<
  SemanticPublicationStore,
  'listStatements' | 'getPublication' | 'getStatement' | 'latestPublicationRevision'
>

/** The identity reads the navigator needs; the identity decision store satisfies it. */
export type RelationNavigationIdentityPort = Pick<
  IdentityDecisionStore,
  'getEntity' | 'readPublishedBindings'
>

/** The declared endpoint object types of one relation in the pinned definition. */
export interface RelationNavigationTarget {
  readonly fromObjectId: string
  readonly toObjectId: string
}

export interface PublishedRelationNavigatorOptions {
  readonly publications: RelationNavigationPublicationPort
  readonly identity: RelationNavigationIdentityPort
  /** The pinned definition version every traversed relation statement must be published against. */
  readonly definitionRef: VersionRef
  /** Relation ids the pinned definition/profile enables; a path outside it is refused. */
  readonly allowedRelationIds: readonly string[]
  /**
   * The schema-declared endpoint objects of each relation. When present, an edge whose
   * endpoints are not the declared from/to objects is refused instead of being walked as if a
   * field lookup were an entity relation.
   */
  readonly relationTargets?: ReadonlyMap<string, RelationNavigationTarget>
  readonly now?: () => number
}

interface RawEndpoint {
  readonly candidateId: string
  readonly objectId: string
}

interface CandidateEdge {
  readonly statementId: string
  readonly statementVersion: RevisionString
  readonly publicationId: string
  readonly relationId: string
  readonly definitionRef: VersionRef
  readonly fromCandidateId: string
  readonly toCandidateId: string
  readonly fromObjectId: string
  readonly toObjectId: string
  readonly sourceRefs: readonly ResourceRef[]
}

interface ResolvedEdge extends CandidateEdge {
  readonly fromEntityId: string
  readonly toEntityId: string
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) {
    throw new RelationNavigationError('FORBIDDEN', 'a trusted, consistent tenant context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function endpointOf(value: unknown): RawEndpoint | undefined {
  if (!isRecord(value)) return undefined
  const candidateId = value['candidateId']
  const objectId = value['objectId']
  if (typeof candidateId !== 'string' || candidateId.length === 0) return undefined
  if (typeof objectId !== 'string' || objectId.length === 0) return undefined
  return { candidateId, objectId }
}

function covers(statement: PublishedStatement, validAt: number): boolean {
  const validFrom = statement.validFrom === undefined ? undefined : Date.parse(statement.validFrom)
  const validTo = statement.validTo === undefined ? undefined : Date.parse(statement.validTo)
  if (validFrom !== undefined && validFrom > validAt) return false
  return validTo === undefined || validAt < validTo
}

function sameVersionRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

/**
 * A reusable, dependency-injected navigator. It holds no global mutable state and reads only
 * the injected ports, so it can be exercised with a fake port in a unit test and with the real
 * Postgres stores in the default host without changing this class.
 */
export class PublishedRelationNavigator {
  readonly #publications: RelationNavigationPublicationPort
  readonly #identity: RelationNavigationIdentityPort
  readonly #definitionRef: VersionRef
  readonly #allowedRelationIds: ReadonlySet<string>
  readonly #relationTargets: ReadonlyMap<string, RelationNavigationTarget>
  readonly #now: () => number

  constructor(options: PublishedRelationNavigatorOptions) {
    this.#publications = options.publications
    this.#identity = options.identity
    this.#definitionRef = options.definitionRef
    this.#allowedRelationIds = new Set(options.allowedRelationIds)
    this.#relationTargets = options.relationTargets ?? new Map()
    this.#now = options.now ?? (() => Date.now())
  }

  async navigate(request: RelationNavigationRequest, ctx: ToolContext): Promise<RelationNavigationResult> {
    const scopeRef = scopeOf(ctx)
    if (!isRelationNavigationRequest(request)) {
      throw new RelationNavigationError(
        'INVALID_ARGUMENT',
        `relation navigation needs a start entity, 1–${String(MAX_HOPS)} relation ids and a UTC validAt`,
      )
    }
    if (request.relationIds.length > MAX_HOPS) {
      throw new RelationNavigationError('INVALID_ARGUMENT', `relation navigation is bounded to ${String(MAX_HOPS)} hops`)
    }
    if (request.relationIds.some((relationId) => !this.#allowedRelationIds.has(relationId))) {
      throw new RelationNavigationError('FORBIDDEN', 'the relation path is not enabled by the pinned definition/profile')
    }
    const maxPaths = request.maxPaths ?? 16
    if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > MAX_PATHS) {
      throw new RelationNavigationError('INVALID_ARGUMENT', `maxPaths must be between 1 and ${String(MAX_PATHS)}`)
    }
    const validAt = Date.parse(request.validAt)
    const checkDeadline = (): void => {
      if (request.signal?.aborted === true || this.#now() >= Date.parse(ctx.deadline)) {
        throw new RelationNavigationError('DEADLINE_EXCEEDED', 'relation navigation was cancelled or exceeded its deadline')
      }
    }
    checkDeadline()

    const start = await this.#identity.getEntity(scopeRef, request.startEntityId, ctx)
    const publicationRevision = await this.#publications.latestPublicationRevision(scopeRef, ctx)
    if (start === undefined || start.state === 'retired') {
      return {
        startEntityId: request.startEntityId,
        paths: [],
        visitedEntityIds: [],
        relationVersionIds: [],
        completeness: 'unknown',
        gaps: ['START_ENTITY_NOT_FOUND'],
        scannedStatements: 0,
        publicationRevision,
      }
    }

    const gaps = new Set<string>()
    const candidateEdges: CandidateEdge[] = []
    const candidateIds = new Set<string>()
    const publicationMatches = new Map<string, boolean>()
    const entityVersions = new Map<string, string>([[start.entityId, start.revision]])
    let scanned = 0
    let partial = false
    let cursor: string | undefined

    while (true) {
      checkDeadline()
      const page = await this.#publications.listStatements(
        scopeRef,
        {
          status: 'active',
          ...(cursor === undefined ? {} : { afterStatementId: cursor }),
          limit: Math.min(PAGE_SIZE, MAX_SCANNED - scanned + 1),
        },
        ctx,
      )
      if (page.length === 0) break
      for (const statement of page) {
        if (scanned === MAX_SCANNED) {
          partial = true
          gaps.add('STATEMENT_SCAN_LIMIT')
          break
        }
        scanned += 1
        if (statement.kind !== 'relation') continue
        const relationId = statement.relationId
        if (relationId === undefined || !request.relationIds.includes(relationId)) continue
        if (!covers(statement, validAt)) continue
        const from = endpointOf(statement.value['from'])
        const to = endpointOf(statement.value['to'])
        if (from === undefined || to === undefined) {
          gaps.add('RELATION_ENDPOINT_UNGROUNDED')
          continue
        }
        const target = this.#relationTargets.get(relationId)
        if (target !== undefined && (from.objectId !== target.fromObjectId || to.objectId !== target.toObjectId)) {
          gaps.add('RELATION_TARGET_MISMATCH')
          continue
        }
        let pinned = publicationMatches.get(statement.publicationId)
        if (pinned === undefined) {
          const publication = await this.#publications.getPublication(scopeRef, statement.publicationId, ctx)
          pinned = publication !== undefined && sameVersionRef(publication.schemaRef, this.#definitionRef)
          publicationMatches.set(statement.publicationId, pinned)
        }
        if (!pinned) {
          gaps.add('RELATION_DEFINITION_MISMATCH')
          continue
        }
        candidateEdges.push({
          statementId: statement.statementId,
          statementVersion: statement.version,
          publicationId: statement.publicationId,
          relationId,
          definitionRef: this.#definitionRef,
          fromCandidateId: from.candidateId,
          toCandidateId: to.candidateId,
          fromObjectId: from.objectId,
          toObjectId: to.objectId,
          sourceRefs: statement.sourceRefs,
        })
        candidateIds.add(from.candidateId)
        candidateIds.add(to.candidateId)
      }
      if (partial || page.length < PAGE_SIZE) break
      const last = page.at(-1)
      if (last === undefined || last.statementId === cursor) {
        partial = true
        gaps.add('PAGINATION_STALLED')
        break
      }
      cursor = last.statementId
    }

    const bindings = await this.#identity.readPublishedBindings(scopeRef, [...candidateIds], ctx)
    if (!bindings.complete) {
      partial = true
      gaps.add('IDENTITY_BINDING_LIMIT')
    }
    const bindingByCandidate = new Map(bindings.bindings.map((binding) => [binding.candidateId, binding]))
    const resolved = new Map<string, string>()
    const resolveCandidate = (candidateId: string): string | undefined => {
      const cached = resolved.get(candidateId)
      if (cached !== undefined) return cached
      const binding = bindingByCandidate.get(candidateId)
      if (binding === undefined) return undefined
      const open = binding.openAssertions
      if (open.length !== 1) return undefined
      const entityId = open[0]?.entityId
      if (entityId === undefined) return undefined
      if (binding.cannotLinkEntityIds.includes(entityId)) return undefined
      resolved.set(candidateId, entityId)
      return entityId
    }

    const edges: ResolvedEdge[] = []
    for (const edge of candidateEdges) {
      const fromEntityId = resolveCandidate(edge.fromCandidateId)
      const toEntityId = resolveCandidate(edge.toCandidateId)
      if (fromEntityId === undefined || toEntityId === undefined) {
        gaps.add('RELATION_IDENTITY_STALE')
        continue
      }
      let endpointValid = true
      for (const entityId of [fromEntityId, toEntityId]) {
        if (entityVersions.has(entityId)) continue
        if (entityVersions.size === MAX_ENTITIES) {
          partial = true
          gaps.add('ENTITY_SCAN_LIMIT')
          endpointValid = false
          break
        }
        const entity = await this.#identity.getEntity(scopeRef, entityId, ctx)
        if (entity === undefined || entity.state === 'retired') {
          gaps.add('RELATION_ENTITY_UNAVAILABLE')
          endpointValid = false
          break
        }
        entityVersions.set(entityId, entity.revision)
      }
      if (!endpointValid) continue
      edges.push({ ...edge, fromEntityId, toEntityId })
    }
    edges.sort((left, right) => left.statementId.localeCompare(right.statementId))

    // Bounded, ordered breadth-first expansion along the requested relation path. A cyclic
    // expansion (an edge to an entity already on the path) is refused, never followed.
    let frontier: RelationNavigationPath[] = [{ startEntityId: request.startEntityId, endEntityId: request.startEntityId, hops: [] }]
    for (const relationId of request.relationIds) {
      const next: RelationNavigationPath[] = []
      for (const path of frontier) {
        checkDeadline()
        const trail = new Set(path.hops.flatMap((hop) => [hop.fromEntityId, hop.toEntityId]))
        trail.add(path.startEntityId)
        const matches = edges.filter(
          (edge) => edge.fromEntityId === path.endEntityId && edge.relationId === relationId,
        )
        if (matches.length > MAX_FANOUT) {
          partial = true
          gaps.add('RELATION_FANOUT_LIMIT')
        }
        for (const edge of matches.slice(0, MAX_FANOUT)) {
          if (trail.has(edge.toEntityId)) {
            gaps.add('RELATION_CYCLE_REFUSED')
            continue
          }
          if (next.length === maxPaths) {
            partial = true
            gaps.add('PATH_LIMIT')
            break
          }
          next.push({ startEntityId: path.startEntityId, endEntityId: edge.toEntityId, hops: [...path.hops, hopOf(edge)] })
        }
      }
      frontier = next
      if (frontier.length === 0) break
    }

    const after = await this.#publications.latestPublicationRevision(scopeRef, ctx)
    if (after !== publicationRevision) {
      return {
        startEntityId: request.startEntityId,
        paths: [],
        visitedEntityIds: [...entityVersions.keys()].sort(),
        relationVersionIds: [],
        completeness: 'unknown',
        gaps: ['PUBLICATION_CHANGED_DURING_READ'],
        scannedStatements: scanned,
        publicationRevision: after,
      }
    }
    for (const [entityId, revision] of entityVersions) {
      const current = await this.#identity.getEntity(scopeRef, entityId, ctx)
      if (current?.revision !== revision) {
        return {
          startEntityId: request.startEntityId,
          paths: [],
          visitedEntityIds: [...entityVersions.keys()].sort(),
          relationVersionIds: [],
          completeness: 'unknown',
          gaps: ['IDENTITY_CHANGED_DURING_READ'],
          scannedStatements: scanned,
          publicationRevision,
        }
      }
    }
    for (const path of frontier) {
      for (const hop of path.hops) {
        const current = await this.#publications.getStatement(scopeRef, hop.statementId, ctx)
        if (current?.status !== 'active' || current.version !== hop.statementVersion) {
          return {
            startEntityId: request.startEntityId,
            paths: [],
            visitedEntityIds: [...entityVersions.keys()].sort(),
            relationVersionIds: [],
            completeness: 'unknown',
            gaps: ['RELATION_CHANGED_DURING_READ'],
            scannedStatements: scanned,
            publicationRevision,
          }
        }
      }
    }

    if (frontier.length === 0) gaps.add('NO_CONFIRMED_PATH')
    const relationVersionIds = [...new Set(frontier.flatMap((path) => path.hops.map((hop) => `${hop.statementId}@${hop.statementVersion}`)))].sort()
    const completeness = partial || gaps.size > 0 ? (frontier.length === 0 ? 'unknown' : 'partial') : 'complete'
    return {
      startEntityId: request.startEntityId,
      paths: frontier,
      visitedEntityIds: [...entityVersions.keys()].sort(),
      relationVersionIds,
      completeness,
      gaps: [...gaps].sort(),
      scannedStatements: scanned,
      publicationRevision,
    }
  }
}

function hopOf(edge: ResolvedEdge): RelationNavigationHop {
  return {
    statementId: edge.statementId,
    statementVersion: edge.statementVersion,
    publicationId: edge.publicationId,
    relationId: edge.relationId,
    definitionRef: edge.definitionRef,
    fromEntityId: edge.fromEntityId,
    toEntityId: edge.toEntityId,
    fromCandidateId: edge.fromCandidateId,
    toCandidateId: edge.toCandidateId,
    sourceRefs: edge.sourceRefs,
  }
}
