import { isToolContext } from '@ontology/contracts'
import type {
  DirectSqlQueryPlan,
  SemanticFilter,
  SemanticQueryPlan,
  SourceObjectRef,
  StructuredQueryExecuteRequest,
  StructuredQueryExecuteResponse,
  ToolContext,
} from '@ontology/contracts'
import { compileSemanticQuery, renderCompiledQuery, isSemanticMappingError } from '../mapping'
import { IdentityRecallError } from './errors'
import type {
  IdentityIndexEntry,
  IdentityIndexPage,
  IdentityIndexProfile,
  IdentityIndexQuery,
  IdentityIndexReader,
  IdentityIndexMatch,
  StructuredIdentityIndexReaderDependencies,
} from './types'

const DEFAULT_QUERY_TIMEOUT_MS = 30_000

function scopeRefOf(ctx: ToolContext): { readonly tenantId: string; readonly spaceId: string } {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 't'
}

function addEq(filters: SemanticFilter[], fieldRef: string, value: string | boolean): void {
  filters.push({ fieldRef, op: 'eq', values: [value] })
}

/**
 * Build the confirmed-mapping filters for one recall layer. Every filter value is bound;
 * identifiers come only from the confirmed mapping (INV-03). The valid-time interval is
 * half-open `[validFrom, validTo)` and is expressed with two comparisons, so a historical
 * alias is matched at the requested `validAt` without an OR branch.
 */
function matchFilters(profile: IdentityIndexProfile, match: IdentityIndexMatch): SemanticFilter[] {
  const { fields } = profile
  const filters: SemanticFilter[] = []
  switch (match.kind) {
    case 'strong_identifier':
      addEq(filters, fields.nativeId, match.nativeId)
      break
    case 'confirmed_alias':
      addEq(filters, fields.aliasNormalized, match.normalizedAlias)
      addEq(filters, fields.aliasConfirmed, true)
      if (match.validAt !== undefined) {
        filters.push({ fieldRef: fields.aliasValidFrom, op: 'lte', values: [match.validAt] })
        filters.push({ fieldRef: fields.aliasValidTo, op: 'gt', values: [match.validAt] })
      }
      break
    case 'context':
      if (match.normalizedName !== undefined) addEq(filters, fields.normalizedName, match.normalizedName)
      if (match.entityType !== undefined) addEq(filters, fields.entityType, match.entityType)
      if (match.site !== undefined) addEq(filters, fields.site, match.site)
      if (match.validAt !== undefined) {
        filters.push({ fieldRef: fields.validFrom, op: 'lte', values: [match.validAt] })
        filters.push({ fieldRef: fields.validTo, op: 'gt', values: [match.validAt] })
      }
      break
  }
  return filters
}

function buildPlan(profile: IdentityIndexProfile, query: IdentityIndexQuery): SemanticQueryPlan {
  const { fields } = profile
  const filters: SemanticFilter[] = [
    { fieldRef: fields.objectId, op: 'eq', values: [query.objectId] },
    { fieldRef: fields.identityScopeId, op: 'eq', values: [query.identityScopeId] },
    { fieldRef: fields.tenantId, op: 'eq', values: [query.tenantId] },
    { fieldRef: fields.spaceId, op: 'eq', values: [query.spaceId] },
  ]
  for (const { dimension, value } of query.scopeDimensions) {
    const fieldRef = profile.dimensionFieldRefs[dimension]
    if (fieldRef === undefined) {
      throw new IdentityRecallError(
        'UNMAPPED_SCOPE_DIMENSION',
        `identity scope dimension "${dimension}" has no confirmed field mapping and cannot be enforced`,
      )
    }
    addEq(filters, fieldRef, value)
  }
  filters.push(...matchFilters(profile, query.match))

  const projectionRefs = new Set<string>([
    fields.entityId,
    fields.objectId,
    fields.identityScopeId,
    fields.nativeId,
    fields.displayName,
    fields.normalizedName,
    fields.alias,
    fields.aliasNormalized,
    fields.aliasConfirmed,
    fields.aliasValidFrom,
    fields.aliasValidTo,
    fields.site,
    fields.entityType,
    fields.validFrom,
    fields.validTo,
    ...Object.values(profile.dimensionFieldRefs),
  ])

  return {
    mode: 'semantic',
    concepts: [profile.conceptId],
    fields: [...projectionRefs],
    links: [],
    filters,
    orderBy: [],
    // One extra row lets the adapter report truncation instead of silently capping the
    // page: a bounded page that could not hold every match must be marked truncated.
    limit: query.limit + 1,
    mappingVersion: profile.mappingRef,
  }
}

function rowsToEntries(
  response: StructuredQueryExecuteResponse,
  profile: IdentityIndexProfile,
  query: IdentityIndexQuery,
): IdentityIndexEntry[] {
  const index = new Map<string, number>()
  response.columns.forEach((column, position) => index.set(column.name, position))
  const cell = (row: readonly unknown[], fieldRef: string): unknown => {
    const position = index.get(fieldRef)
    return position === undefined ? undefined : row[position]
  }
  const { fields } = profile
  const entries: IdentityIndexEntry[] = []
  for (const row of response.rows) {
    const entityId = asString(cell(row, fields.entityId))
    const objectId = asString(cell(row, fields.objectId))
    const identityScopeId = asString(cell(row, fields.identityScopeId))
    const displayName = asString(cell(row, fields.displayName))
    const normalizedName = asString(cell(row, fields.normalizedName))
    if (
      entityId === undefined ||
      objectId === undefined ||
      identityScopeId === undefined ||
      displayName === undefined ||
      normalizedName === undefined
    ) {
      throw new IdentityRecallError(
        'INDEX_UNAVAILABLE',
        'the identity index row is missing a required identity field',
      )
    }
    const dimensions: Record<string, string> = {}
    for (const { dimension } of query.scopeDimensions) {
      const fieldRef = profile.dimensionFieldRefs[dimension]
      if (fieldRef === undefined) continue
      const value = asString(cell(row, fieldRef))
      if (value !== undefined) dimensions[dimension] = value
    }
    const nativeId = asString(cell(row, fields.nativeId))
    const alias = asString(cell(row, fields.alias))
    const aliasNormalized = asString(cell(row, fields.aliasNormalized))
    const aliasValidFrom = asString(cell(row, fields.aliasValidFrom))
    const aliasValidTo = asString(cell(row, fields.aliasValidTo))
    const site = asString(cell(row, fields.site))
    const entityType = asString(cell(row, fields.entityType))
    const validFrom = asString(cell(row, fields.validFrom))
    const validTo = asString(cell(row, fields.validTo))
    entries.push({
      tenantId: query.tenantId,
      spaceId: query.spaceId,
      entityId,
      objectId,
      identityScopeId,
      displayName,
      normalizedName,
      aliasConfirmed: asBoolean(cell(row, fields.aliasConfirmed)),
      dimensions,
      ...(nativeId === undefined ? {} : { nativeId }),
      ...(alias === undefined ? {} : { alias }),
      ...(aliasNormalized === undefined ? {} : { aliasNormalized }),
      ...(aliasValidFrom === undefined ? {} : { aliasValidFrom }),
      ...(aliasValidTo === undefined ? {} : { aliasValidTo }),
      ...(site === undefined ? {} : { site }),
      ...(entityType === undefined ? {} : { entityType }),
      ...(validFrom === undefined ? {} : { validFrom }),
      ...(validTo === undefined ? {} : { validTo }),
    })
  }
  return entries
}

/**
 * Production `IdentityIndexReader`: the recall's data access goes through the real C3
 * `StructuredQueryPort` (SPEC C3). It compiles a semantic plan against the confirmed
 * mapping, renders it to a direct read-only plan and executes it in the trusted scope; it
 * imports no database driver. An optional `CatalogPort` check confirms the mapped
 * resources are visible before the query runs.
 */
export class StructuredIdentityIndexReader implements IdentityIndexReader {
  readonly #deps: StructuredIdentityIndexReaderDependencies

  constructor(dependencies: StructuredIdentityIndexReaderDependencies) {
    this.#deps = dependencies
  }

  async query(query: IdentityIndexQuery, ctx: ToolContext): Promise<IdentityIndexPage> {
    if (!isToolContext(ctx)) {
      throw new IdentityRecallError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
    }
    const scope = scopeRefOf(ctx)
    if (query.tenantId !== scope.tenantId || query.spaceId !== scope.spaceId) {
      throw new IdentityRecallError('SCOPE_MISMATCH', 'query scope does not match the trusted principal scope')
    }
    const mapping = this.#deps.mappings.resolve(this.#deps.profile.mappingRef)
    if (mapping === undefined) {
      throw new IdentityRecallError(
        'MAPPING_NOT_FOUND',
        `the pinned identity mapping ${this.#deps.profile.mappingRef.id}@${this.#deps.profile.mappingRef.version} is not available`,
      )
    }

    const plan = buildPlan(this.#deps.profile, query)
    let direct: DirectSqlQueryPlan
    try {
      const compiled = compileSemanticQuery(plan, mapping, { budget: this.#deps.compileBudget })
      const rendered = renderCompiledQuery(compiled)
      direct = {
        mode: 'direct',
        statementKind: 'select',
        sql: rendered.sql,
        parameters: [...rendered.parameters],
        referencedObjects: [...rendered.referencedObjects],
        readOnly: true,
      }
    } catch (error) {
      if (isSemanticMappingError(error)) {
        throw new IdentityRecallError('INVALID_REQUEST', error.message, { cause: error })
      }
      throw error
    }

    const schemaRevision = await this.#assertVisible(scope, mapping.objects.map((object) => object.sourceObjectRef), ctx)
    const request: StructuredQueryExecuteRequest = {
      plan: direct,
      limits: {
        maxRows: Math.max(1, query.limit),
        maxBytes: this.#deps.compileBudget.maxBytes,
        maxDurationMs: DEFAULT_QUERY_TIMEOUT_MS,
      },
      snapshotRequest: { consistency: this.#deps.consistency ?? 'repeatable_read' },
    }
    const response = await this.#deps.query.execute(request, ctx)
    const entries = rowsToEntries(response, this.#deps.profile, query)
    return {
      entries,
      truncated: response.coverage.truncated,
      ...(response.coverage.knownTotal === undefined ? {} : { knownTotal: response.coverage.knownTotal }),
      ...(schemaRevision === undefined ? {} : { schemaRevision }),
      snapshot: response.snapshot,
    }
  }

  async #assertVisible(
    scope: { readonly tenantId: string; readonly spaceId: string },
    objectRefs: readonly SourceObjectRef[],
    ctx: ToolContext,
  ): Promise<string | undefined> {
    const catalog = this.#deps.catalog
    if (catalog === undefined || objectRefs.length === 0) return undefined
    const response = await catalog.describe(
      { scopeRef: { tenantId: scope.tenantId, spaceId: scope.spaceId }, resourceRefs: [...objectRefs] },
      ctx,
    )
    if (response.resources.length === 0) {
      throw new IdentityRecallError(
        'INDEX_NOT_VISIBLE',
        'the identity index resources are not visible in the trusted scope',
      )
    }
    return response.schemaRevision
  }
}
