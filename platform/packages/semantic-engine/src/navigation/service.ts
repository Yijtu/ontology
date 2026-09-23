import { isToolContext } from '@ontology/contracts'
import type { IdentityDecisionStore, PublishedStatement, ScopeRef, SemanticPublicationStore, ToolContext, VersionRef } from '@ontology/contracts'

const PAGE_SIZE = 100
const MAX_SCANNED = 1_000
const MAX_HOPS = 3
const MAX_PATHS = 32
const MAX_FANOUT = 64
const MAX_ENTITIES = 256

export interface RelationHop {
  readonly statementId: string
  readonly statementVersion: string
  readonly publicationId: string
  readonly relationId: string
  readonly fromEntityId: string
  readonly toEntityId: string
  readonly fromCandidateId: string
  readonly toCandidateId: string
  readonly sourceRefs: PublishedStatement['sourceRefs']
}

export interface RelationPath {
  readonly startEntityId: string
  readonly endEntityId: string
  readonly hops: readonly RelationHop[]
}

export interface RelationNavigationRequest {
  readonly startEntityId: string
  /** Exact, ordered relation IDs from a published definition; at most three hops. */
  readonly relationIds: readonly string[]
  readonly validAt: string
  readonly maxPaths?: number
  readonly signal?: AbortSignal
}

export interface RelationNavigationResult {
  readonly paths: readonly RelationPath[]
  readonly completeness: 'complete' | 'partial' | 'unknown'
  readonly gaps: readonly string[]
  readonly scannedStatements: number
  readonly publicationRevision: string
}

export class RelationNavigationError extends Error {
  constructor(readonly code: 'INVALID_ARGUMENT' | 'DEADLINE_EXCEEDED' | 'FORBIDDEN', message: string) {
    super(message)
    this.name = 'RelationNavigationError'
  }
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) {
    throw new RelationNavigationError('FORBIDDEN', 'a trusted, consistent tenant context is required')
  }
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function edgeOf(statement: PublishedStatement): RelationHop | undefined {
  if (statement.kind !== 'relation' || statement.relationId === undefined) return undefined
  const value = statement.value
  const fromEntityId = value['fromEntityId']
  const toEntityId = value['toEntityId']
  const fromCandidateId = value['fromCandidateId']
  const toCandidateId = value['toCandidateId']
  if (typeof fromEntityId !== 'string' || typeof toEntityId !== 'string' || typeof fromCandidateId !== 'string' || typeof toCandidateId !== 'string') return undefined
  if (statement.subjectEntityId !== fromEntityId) return undefined
  return {
    statementId: statement.statementId, statementVersion: statement.version, publicationId: statement.publicationId,
    relationId: statement.relationId, fromEntityId, toEntityId, fromCandidateId, toCandidateId,
    sourceRefs: statement.sourceRefs,
  }
}

/** Reads only published, current relations; candidates and schema paths never become instance edges. */
export class PublishedRelationNavigator {
  readonly #publications: SemanticPublicationStore
  readonly #identity: IdentityDecisionStore
  readonly #definitionRef: VersionRef
  readonly #allowedRelationIds: ReadonlySet<string>
  readonly #now: () => number

  constructor(input: { readonly publications: SemanticPublicationStore; readonly identity: IdentityDecisionStore; readonly definitionRef: VersionRef; readonly allowedRelationIds: readonly string[]; readonly now?: () => number }) {
    this.#publications = input.publications
    this.#identity = input.identity
    this.#definitionRef = input.definitionRef
    this.#allowedRelationIds = new Set(input.allowedRelationIds)
    this.#now = input.now ?? (() => Date.now())
  }

  async navigate(request: RelationNavigationRequest, ctx: ToolContext): Promise<RelationNavigationResult> {
    const scope = scopeOf(ctx)
    const validAt = Date.parse(request.validAt)
    if (request.startEntityId.trim().length === 0 || request.relationIds.length < 1 || request.relationIds.length > MAX_HOPS || request.relationIds.some((id) => id.trim().length === 0) || !/Z$/u.test(request.validAt) || !Number.isFinite(validAt)) {
      throw new RelationNavigationError('INVALID_ARGUMENT', 'a start entity, 1–3 relation IDs and validAt are required')
    }
    if (request.relationIds.some((id) => !this.#allowedRelationIds.has(id))) {
      throw new RelationNavigationError('FORBIDDEN', 'the relation path is not enabled by the pinned definition/profile')
    }
    const maxPaths = request.maxPaths ?? 16
    if (!Number.isSafeInteger(maxPaths) || maxPaths < 1 || maxPaths > MAX_PATHS) {
      throw new RelationNavigationError('INVALID_ARGUMENT', `maxPaths must be between 1 and ${String(MAX_PATHS)}`)
    }
    const checkDeadline = () => {
      if (request.signal?.aborted || this.#now() >= Date.parse(ctx.deadline)) throw new RelationNavigationError('DEADLINE_EXCEEDED', 'relation navigation was cancelled or exceeded its deadline')
    }
    checkDeadline()
    const start = await this.#identity.getEntity(scope, request.startEntityId, ctx)
    if (start === undefined || start.state === 'retired') return { paths: [], completeness: 'unknown', gaps: ['START_ENTITY_NOT_FOUND'], scannedStatements: 0, publicationRevision: await this.#publications.latestPublicationRevision(scope, ctx) }
    const publicationRevision = await this.#publications.latestPublicationRevision(scope, ctx)
    const gaps = new Set<string>()
    const publicationMatches = new Map<string, boolean>()
    const entityVersions = new Map<string, string>([[start.entityId, start.revision]])
    const edges: RelationHop[] = []
    let scanned = 0
    let cursor: string | undefined
    let partial = false
    while (true) {
      checkDeadline()
      const page = await this.#publications.listStatements(scope, { status: 'active', ...(cursor === undefined ? {} : { afterStatementId: cursor }), limit: Math.min(PAGE_SIZE, MAX_SCANNED - scanned + 1) }, ctx)
      if (page.length === 0) break
      for (const statement of page) {
        if (scanned === MAX_SCANNED) { partial = true; break }
        scanned += 1
        if (statement.kind !== 'relation' || !request.relationIds.includes(statement.relationId ?? '')) continue
        const fromTime = statement.validFrom === undefined ? undefined : Date.parse(statement.validFrom)
        const toTime = statement.validTo === undefined ? undefined : Date.parse(statement.validTo)
        if ((fromTime !== undefined && !Number.isFinite(fromTime)) || (toTime !== undefined && !Number.isFinite(toTime))) { gaps.add('RELATION_TIME_INVALID'); continue }
        if ((fromTime !== undefined && fromTime > validAt) || (toTime !== undefined && validAt >= toTime)) continue
        const edge = edgeOf(statement)
        if (edge === undefined) { gaps.add('RELATION_ENDPOINT_UNGROUNDED'); continue }
        let pinned = publicationMatches.get(edge.publicationId)
        if (pinned === undefined) {
          const publication = await this.#publications.getPublication(scope, edge.publicationId, ctx)
          pinned = publication?.schemaRef.id === this.#definitionRef.id && publication.schemaRef.version === this.#definitionRef.version && publication.schemaRef.digest === this.#definitionRef.digest
          publicationMatches.set(edge.publicationId, pinned)
        }
        if (!pinned) { gaps.add('RELATION_DEFINITION_MISMATCH'); continue }
        const bindings = await Promise.all([
          this.#identity.listAssertions(scope, { candidateId: edge.fromCandidateId, openOnly: true, limit: 2 }, ctx),
          this.#identity.listAssertions(scope, { candidateId: edge.toCandidateId, openOnly: true, limit: 2 }, ctx),
        ])
        if (bindings[0].length !== 1 || bindings[0][0]?.entityId !== edge.fromEntityId || bindings[1].length !== 1 || bindings[1][0]?.entityId !== edge.toEntityId) {
          gaps.add('RELATION_IDENTITY_STALE')
          continue
        }
        const forbidden = await Promise.all([
          this.#identity.listLinkConstraints(scope, edge.fromCandidateId, ctx),
          this.#identity.listLinkConstraints(scope, edge.toCandidateId, ctx),
        ])
        if (forbidden[0].some((item) => item.entityId === edge.fromEntityId) || forbidden[1].some((item) => item.entityId === edge.toEntityId)) {
          gaps.add('RELATION_IDENTITY_CONFLICT')
          continue
        }
        let endpointValid = true
        for (const entityId of [edge.fromEntityId, edge.toEntityId]) {
          if (entityVersions.has(entityId)) continue
          if (entityVersions.size === MAX_ENTITIES) { partial = true; gaps.add('ENTITY_SCAN_LIMIT'); endpointValid = false; break }
          const entity = await this.#identity.getEntity(scope, entityId, ctx)
          if (entity === undefined || entity.state === 'retired') { gaps.add('RELATION_ENTITY_UNAVAILABLE'); endpointValid = false; break }
          entityVersions.set(entityId, entity.revision)
        }
        if (!endpointValid) continue
        edges.push(edge)
      }
      if (partial || page.length < PAGE_SIZE) break
      const last = page.at(-1)
      if (last === undefined || last.statementId === cursor) { partial = true; gaps.add('PAGINATION_STALLED'); break }
      cursor = last.statementId
    }
    if (partial) gaps.add('STATEMENT_SCAN_LIMIT')
    edges.sort((a, b) => a.statementId.localeCompare(b.statementId))
    let frontier: RelationPath[] = [{ startEntityId: request.startEntityId, endEntityId: request.startEntityId, hops: [] }]
    for (const relationId of request.relationIds) {
      const next: RelationPath[] = []
      for (const path of frontier) {
        checkDeadline()
        const matches = edges.filter((edge) => edge.fromEntityId === path.endEntityId && edge.relationId === relationId)
        if (matches.length > MAX_FANOUT) { partial = true; gaps.add('RELATION_FANOUT_LIMIT') }
        for (const edge of matches.slice(0, MAX_FANOUT)) {
          if (next.length === maxPaths) { partial = true; gaps.add('PATH_LIMIT'); break }
          next.push({ startEntityId: path.startEntityId, endEntityId: edge.toEntityId, hops: [...path.hops, edge] })
        }
      }
      frontier = next
      if (frontier.length === 0) break
    }
    const after = await this.#publications.latestPublicationRevision(scope, ctx)
    if (after !== publicationRevision) return { paths: [], completeness: 'unknown', gaps: ['PUBLICATION_CHANGED_DURING_READ'], scannedStatements: scanned, publicationRevision: after }
    for (const [entityId, revision] of entityVersions) {
      const current = await this.#identity.getEntity(scope, entityId, ctx)
      if (current?.revision !== revision) return { paths: [], completeness: 'unknown', gaps: ['IDENTITY_CHANGED_DURING_READ'], scannedStatements: scanned, publicationRevision }
    }
    for (const path of frontier) {
      for (const edge of path.hops) {
        const current = await this.#publications.getStatement(scope, edge.statementId, ctx)
        if (current?.status !== 'active' || current.version !== edge.statementVersion) {
          return { paths: [], completeness: 'unknown', gaps: ['RELATION_CHANGED_DURING_READ'], scannedStatements: scanned, publicationRevision }
        }
      }
    }
    if (frontier.length === 0) gaps.add('NO_CONFIRMED_PATH')
    return { paths: frontier, completeness: partial ? 'partial' : gaps.size > 0 && frontier.length === 0 ? 'unknown' : 'complete', gaps: [...gaps].sort(), scannedStatements: scanned, publicationRevision }
  }
}
