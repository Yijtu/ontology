import type {
  AggregationKind,
  ComparisonOperator,
  ScalarValue,
  SemanticFilter,
  SemanticQueryPlan,
  SourceObjectRef,
  SourceRef,
} from '@ontology/contracts'
import { SemanticMappingError } from './errors'
import {
  canonicalColumnTypeOf,
  type CompilationBudget,
  type CompiledExpression,
  type CompiledJoin,
  type CompiledOrder,
  type CompiledPredicate,
  type CompiledProjection,
  type CompiledQuery,
  type CompiledSource,
  type FieldMapping,
  type LinkMapping,
  type ObjectMapping,
  type SemanticMapping,
} from './types'

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Physical identifiers may only come from the confirmed mapping, and must be plain names. */
export function assertSafeIdentifier(value: string, what: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new SemanticMappingError(
      'IDENTIFIER_NOT_FROM_MAPPING',
      `${what} "${value}" is not a plain identifier and cannot come from the confirmed mapping`,
    )
  }
}

function sourceKey(sourceRef: SourceRef): string {
  return `${sourceRef.namespace}\u0000${sourceRef.sourceId}`
}

function sameVersionRef(
  left: { readonly id: string; readonly version: string; readonly digest: string },
  right: { readonly id: string; readonly version: string; readonly digest: string },
): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

interface IndexedObject {
  readonly mapping: ObjectMapping
  readonly fields: ReadonlyMap<string, FieldMapping>
}

interface MappingIndex {
  readonly mapping: SemanticMapping
  readonly objects: ReadonlyMap<string, IndexedObject>
  readonly links: ReadonlyMap<string, LinkMapping>
}

/**
 * Build a validated index of one confirmed mapping. Every physical identifier is checked
 * once here, so a malformed mapping is rejected before any SQL is planned.
 */
export function buildMappingIndex(mapping: SemanticMapping): MappingIndex {
  const objects = new Map<string, IndexedObject>()
  for (const object of mapping.objects) {
    assertSafeIdentifier(object.schema, 'mapping schema')
    assertSafeIdentifier(object.relation, 'mapping relation')
    const fields = new Map<string, FieldMapping>()
    for (const field of object.fields) {
      assertSafeIdentifier(field.column, `mapping column for ${field.fieldRef}`)
      if (field.unitFactor !== undefined && !(field.unitFactor > 0)) {
        throw new SemanticMappingError(
          'INVALID_MAPPING',
          `field ${field.fieldRef} declares a non-positive unitFactor`,
        )
      }
      fields.set(field.fieldRef, field)
    }
    objects.set(object.conceptId, { mapping: object, fields })
  }
  const links = new Map<string, LinkMapping>()
  for (const link of mapping.links) {
    assertSafeIdentifier(link.fromColumn, `link ${link.linkId} fromColumn`)
    assertSafeIdentifier(link.toColumn, `link ${link.linkId} toColumn`)
    links.set(link.linkId, link)
  }
  return { mapping, objects, links }
}

interface ResolvedField {
  readonly object: ObjectMapping
  readonly field: FieldMapping
}

function resolveField(
  index: MappingIndex,
  sources: readonly { readonly alias: string; readonly object: ObjectMapping }[],
  fieldRef: string,
): { readonly source: { readonly alias: string; readonly object: ObjectMapping }; readonly resolved: ResolvedField } {
  const matches = sources.filter((source) => index.objects.get(source.object.conceptId)?.fields.has(fieldRef))
  const first = matches[0]
  if (first === undefined) {
    throw new SemanticMappingError('UNMAPPED_FIELD', `field ${fieldRef} is not covered by the confirmed mapping`)
  }
  if (matches.length > 1) {
    throw new SemanticMappingError(
      'AMBIGUOUS_FIELD',
      `field ${fieldRef} is declared by more than one concept in this query`,
    )
  }
  const field = index.objects.get(first.object.conceptId)?.fields.get(fieldRef)
  if (field === undefined) {
    throw new SemanticMappingError('UNMAPPED_FIELD', `field ${fieldRef} is not covered by the confirmed mapping`)
  }
  return { source: first, resolved: { object: first.object, field } }
}

function columnExpression(alias: string, field: FieldMapping): CompiledExpression {
  return { kind: 'column', column: { alias, column: field.column } }
}

function projectionExpression(alias: string, field: FieldMapping): CompiledExpression {
  const column = columnExpression(alias, field)
  if (field.valueMap !== undefined && field.valueMap.length > 0) {
    // An absent physical code is unknown, never a canonical false/string. Unknown non-null
    // codes also remain SQL NULL so a boolean cast cannot turn them into a business value.
    return { kind: 'mapped', operand: column, map: field.valueMap, fallback: null }
  }
  if (field.unitFactor !== undefined && field.unitFactor !== 1) {
    return { kind: 'scaled', operand: column, factor: field.unitFactor }
  }
  return column
}

function physicalFilterValues(field: FieldMapping, values: readonly ScalarValue[]): ScalarValue[] {
  const map = field.valueMap
  if (map === undefined || map.length === 0) return [...values]
  return values.map((value) => {
    const entry = map.find((candidate) => candidate.canonical === value)
    if (entry === undefined) {
      throw new SemanticMappingError(
        'INVALID_FILTER_VALUE',
        `filter value ${JSON.stringify(value)} is not a canonical value of ${field.fieldRef}`,
      )
    }
    return entry.physical
  })
}

function assertFilterArity(op: ComparisonOperator, count: number, fieldRef: string): void {
  const expected: Partial<Record<ComparisonOperator, number>> = {
    eq: 1,
    ne: 1,
    lt: 1,
    lte: 1,
    gt: 1,
    gte: 1,
    between: 2,
    is_null: 0,
    is_not_null: 0,
  }
  if (op === 'in') {
    if (count < 1) {
      throw new SemanticMappingError('INVALID_QUERY_PLAN', `filter on ${fieldRef} with "in" needs at least one value`)
    }
    return
  }
  const wanted = expected[op]
  if (wanted !== undefined && count !== wanted) {
    throw new SemanticMappingError(
      'INVALID_QUERY_PLAN',
      `filter on ${fieldRef} with "${op}" needs exactly ${String(wanted)} value(s)`,
    )
  }
}

function compileFilter(
  index: MappingIndex,
  sources: readonly { readonly alias: string; readonly object: ObjectMapping }[],
  filter: SemanticFilter,
): CompiledPredicate {
  const { source, resolved } = resolveField(index, sources, filter.fieldRef)
  assertFilterArity(filter.op, filter.values.length, filter.fieldRef)
  const column = columnExpression(source.alias, resolved.field)
  const isEncodingFilter = resolved.field.valueMap !== undefined && resolved.field.valueMap.length > 0
  const expression: CompiledExpression = isEncodingFilter
    ? column
    : resolved.field.unitFactor !== undefined && resolved.field.unitFactor !== 1
      ? { kind: 'scaled', operand: column, factor: resolved.field.unitFactor }
      : column
  const values = physicalFilterValues(resolved.field, filter.values)
  return { expression, op: filter.op, values }
}

function unionFindConnect(
  concepts: readonly string[],
  links: readonly LinkMapping[],
): boolean {
  const parent = new Map<string, string>()
  const find = (node: string): string => {
    let current = node
    while (parent.get(current) !== undefined && parent.get(current) !== current) {
      current = parent.get(current) ?? current
    }
    return current
  }
  const union = (left: string, right: string): void => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot)
  }
  for (const concept of concepts) parent.set(concept, concept)
  for (const link of links) {
    if (parent.has(link.fromConceptId) && parent.has(link.toConceptId)) {
      union(link.fromConceptId, link.toConceptId)
    }
  }
  const roots = new Set(concepts.map((concept) => find(concept)))
  return roots.size === 1
}

function assertBudget(
  plan: SemanticQueryPlan,
  sources: readonly { readonly object: ObjectMapping }[],
  joins: readonly CompiledJoin[],
  index: MappingIndex,
  projectionCount: number,
  budget: CompilationBudget,
): void {
  if (!Number.isInteger(plan.limit) || plan.limit < 1) {
    throw new SemanticMappingError('INVALID_QUERY_PLAN', 'a semantic query plan requires a positive integer limit')
  }
  if (plan.limit > budget.maxRows) {
    throw new SemanticMappingError(
      'BUDGET_EXCEEDED',
      `the plan requests ${String(plan.limit)} rows, above the ${String(budget.maxRows)} row budget`,
    )
  }

  let estimatedRows = 0
  for (const source of sources) estimatedRows = Math.max(estimatedRows, source.object.estimatedRows)

  for (const join of joins) {
    const link = index.links.get(join.linkId)
    if (link === undefined) {
      throw new SemanticMappingError('UNMAPPED_LINK', `link ${join.linkId} disappeared during compilation`)
    }
    if (link.scope.maxFanout > budget.maxJoinFanout) {
      throw new SemanticMappingError(
        'BUDGET_EXCEEDED',
        `join ${link.linkId} may fan out to ${String(link.scope.maxFanout)} rows per input, above the ${String(budget.maxJoinFanout)} fanout budget`,
      )
    }
    const from = index.objects.get(link.fromConceptId)?.mapping.estimatedRows ?? 0
    const to = index.objects.get(link.toConceptId)?.mapping.estimatedRows ?? 0
    estimatedRows = Math.max(estimatedRows, Math.max(from, to) * link.scope.maxFanout)
  }

  const bytesPerRow = budget.estimatedBytesPerRow ?? 64
  const transferRows = estimatedRows > 0 ? Math.min(plan.limit, estimatedRows) : plan.limit
  const transferBytes = transferRows * Math.max(projectionCount, 1) * bytesPerRow
  if (transferBytes > budget.maxBytes) {
    throw new SemanticMappingError(
      'BUDGET_EXCEEDED',
      `the projected transfer is about ${String(transferBytes)} bytes, above the ${String(budget.maxBytes)} byte budget`,
    )
  }
}

const SUPPORTED_AGGREGATES: ReadonlySet<AggregationKind> = new Set([
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'count_distinct',
])

function aggregateProjection(
  alias: string,
  field: FieldMapping,
  kind: AggregationKind,
): CompiledProjection {
  if (!SUPPORTED_AGGREGATES.has(kind)) {
    throw new SemanticMappingError(
      'UNSUPPORTED_AGGREGATION',
      `aggregation "${kind}" is not part of the supported dialect-neutral subset`,
    )
  }
  const isCounting = kind === 'count' || kind === 'count_distinct'
  if (field.exactDecimal === true && kind === 'avg') {
    throw new SemanticMappingError('UNSUPPORTED_AGGREGATION', 'exact project decimal averages require a declared rounding contract')
  }
  if (!isCounting && field.valueMap !== undefined && field.valueMap.length > 0) {
    throw new SemanticMappingError(
      'UNSUPPORTED_AGGREGATION',
      `field ${field.fieldRef} has a value encoding and cannot be aggregated with "${kind}"`,
    )
  }
  const base: CompiledExpression = { kind: 'aggregate', fn: kind, operand: columnExpression(alias, field) }
  const expression: CompiledExpression =
    field.unitFactor !== undefined && field.unitFactor !== 1 && !isCounting
      ? { kind: 'scaled', operand: base, factor: field.unitFactor }
      : base
  return {
    fieldRef: field.fieldRef,
    expression,
    columnType: isCounting ? 'integer' : canonicalColumnTypeOf(field.valueType),
    ...(field.exactDecimal === true && !isCounting ? { exactDecimal: true } : {}),
  }
}

function plainProjection(alias: string, field: FieldMapping): CompiledProjection {
  return {
    fieldRef: field.fieldRef,
    expression: projectionExpression(alias, field),
    columnType: canonicalColumnTypeOf(field.valueType),
    ...(field.exactDecimal === true ? { exactDecimal: true } : {}),
    ...(field.unit === undefined ? {} : { unit: field.unit.unitCode }),
  }
}

export interface CompileOptions {
  readonly budget: CompilationBudget
}

/**
 * Compile a semantic `QueryPlan` against one confirmed mapping into a dialect-neutral
 * query. The function is pure and synchronous: it never opens a connection, never calls a
 * model and never starts a planner. Identifiers come only from the mapping; filter values
 * stay bound parameters.
 *
 * Order of checks matters: cardinality/transfer volume is checked first, then a
 * cross-source join is refused because a single backend query cannot preserve its scope.
 * An over-budget cross-source join is therefore refused as `BUDGET_EXCEEDED`, never
 * executed as an unbounded pull.
 */
export function compileSemanticQuery(
  plan: SemanticQueryPlan,
  mapping: SemanticMapping,
  options: CompileOptions,
): CompiledQuery {
  if (plan.mode !== 'semantic') {
    throw new SemanticMappingError('INVALID_QUERY_PLAN', 'only a semantic query plan can be compiled here')
  }
  if (!sameVersionRef(plan.mappingVersion, mapping.mappingRef)) {
    throw new SemanticMappingError(
      'MAPPING_VERSION_MISMATCH',
      `the plan pins ${plan.mappingVersion.id}@${plan.mappingVersion.version} but the resolved mapping is ${mapping.mappingRef.id}@${mapping.mappingRef.version}`,
    )
  }
  if (plan.concepts.length === 0) {
    throw new SemanticMappingError('INVALID_QUERY_PLAN', 'a semantic query plan requires at least one concept')
  }

  const index = buildMappingIndex(mapping)

  const seenConcepts = new Set<string>()
  const sources: { alias: string; object: ObjectMapping }[] = []
  for (const conceptId of plan.concepts) {
    if (seenConcepts.has(conceptId)) continue
    seenConcepts.add(conceptId)
    const indexed = index.objects.get(conceptId)
    if (indexed === undefined) {
      throw new SemanticMappingError(
        'UNMAPPED_CONCEPT',
        `concept ${conceptId} is not covered by mapping ${mapping.mappingRef.id}@${mapping.mappingRef.version}`,
      )
    }
    sources.push({ alias: `t${String(sources.length)}`, object: indexed.mapping })
  }

  const joins: CompiledJoin[] = []
  const resolvedLinks: LinkMapping[] = []
  const seenLinks = new Set<string>()
  for (const linkId of plan.links) {
    if (seenLinks.has(linkId)) continue
    seenLinks.add(linkId)
    const link = index.links.get(linkId)
    if (link === undefined) {
      throw new SemanticMappingError('UNMAPPED_LINK', `link ${linkId} is not covered by the confirmed mapping`)
    }
    const from = sources.find((source) => source.object.conceptId === link.fromConceptId)
    const to = sources.find((source) => source.object.conceptId === link.toConceptId)
    if (from === undefined || to === undefined) {
      throw new SemanticMappingError(
        'UNMAPPED_CONCEPT',
        `link ${linkId} connects ${link.fromConceptId} and ${link.toConceptId}, which the plan does not both select`,
      )
    }
    const fromField = index.objects.get(link.fromConceptId)?.fields
    const toField = index.objects.get(link.toConceptId)?.fields
    if (!hasColumn(fromField, link.fromColumn) || !hasColumn(toField, link.toColumn)) {
      throw new SemanticMappingError(
        'RELATION_KEY_REQUIRED',
        `link ${linkId} must declare join keys that exist in both endpoint mappings`,
      )
    }
    resolvedLinks.push(link)
    joins.push({
      linkId: link.linkId,
      fromAlias: from.alias,
      toAlias: to.alias,
      fromColumn: link.fromColumn,
      toColumn: link.toColumn,
      joinKind: link.joinKind,
    })
  }

  if (sources.length > 1) {
    if (resolvedLinks.length === 0) {
      throw new SemanticMappingError(
        'JOIN_RELATION_REQUIRED',
        'a query over several concepts needs an explicit declared relation; none was supplied',
      )
    }
    if (!unionFindConnect([...seenConcepts], resolvedLinks)) {
      throw new SemanticMappingError(
        'JOIN_RELATION_REQUIRED',
        'the declared relations do not connect every selected concept',
      )
    }
  }

  const distinctSources = new Set(sources.map((source) => sourceKey(source.object.sourceObjectRef.sourceRef)))

  const aggregation = plan.aggregation
  const useAggregation = aggregation !== undefined && aggregation.kind !== 'none'

  const projectionEstimate =
    useAggregation && aggregation !== undefined
      ? aggregation.groupBy.length + aggregation.fieldRefs.length
      : plan.fields.length

  // Cardinality and transfer volume are checked before any projection is resolved or any
  // SQL is planned; an over-budget join is refused here, never executed as a full pull.
  assertBudget(plan, sources, joins, index, projectionEstimate, options.budget)

  if (distinctSources.size > 1) {
    throw new SemanticMappingError(
      'CROSS_SOURCE_JOIN_REFUSED',
      'a join spanning two sources cannot be executed as one backend query; it must be split, not pulled as a full cross join',
    )
  }

  const projections: CompiledProjection[] = []
  const groupBy: CompiledExpression[] = []
  if (useAggregation && aggregation !== undefined) {
    for (const fieldRef of aggregation.groupBy) {
      const { source, resolved } = resolveField(index, sources, fieldRef)
      const projection = plainProjection(source.alias, resolved.field)
      projections.push(projection)
      groupBy.push(projection.expression)
    }
    for (const fieldRef of aggregation.fieldRefs) {
      const { source, resolved } = resolveField(index, sources, fieldRef)
      projections.push(aggregateProjection(source.alias, resolved.field, aggregation.kind))
    }
    if (projections.length === 0) {
      throw new SemanticMappingError('INVALID_QUERY_PLAN', 'an aggregation query must project at least one field')
    }
  } else {
    for (const fieldRef of plan.fields) {
      const { source, resolved } = resolveField(index, sources, fieldRef)
      projections.push(plainProjection(source.alias, resolved.field))
    }
  }
  if (projections.length === 0) {
    throw new SemanticMappingError('INVALID_QUERY_PLAN', 'a semantic query plan must project at least one field')
  }

  const predicates: CompiledPredicate[] = []
  const timeFieldRef = sources[0]?.object.timeFieldRef
  if (plan.time !== undefined) {
    if (timeFieldRef === undefined) {
      throw new SemanticMappingError(
        'TIME_FIELD_UNMAPPED',
        `the primary concept ${sources[0]?.object.conceptId ?? ''} has no mapped time field for the requested window`,
      )
    }
    const { source, resolved } = resolveField(index, sources, timeFieldRef)
    const column = columnExpression(source.alias, resolved.field)
    predicates.push({ expression: column, op: 'gte', values: [plan.time.start] })
    predicates.push({ expression: column, op: 'lt', values: [plan.time.end] })
  }
  for (const filter of plan.filters) {
    predicates.push(compileFilter(index, sources, filter))
  }

  const projectionByField = new Map(projections.map((projection) => [projection.fieldRef, projection]))
  const orderBy: CompiledOrder[] = []
  for (const order of plan.orderBy) {
    const projection = projectionByField.get(order.fieldRef)
    if (projection === undefined) {
      throw new SemanticMappingError(
        'INVALID_QUERY_PLAN',
        `orderBy field ${order.fieldRef} is not part of the projected fields`,
      )
    }
    orderBy.push({ fieldRef: order.fieldRef, expression: projection.expression, direction: order.direction })
  }

  const compiledSources: CompiledSource[] = sources.map((source) => ({
    alias: source.alias,
    conceptId: source.object.conceptId,
    schema: source.object.schema,
    relation: source.object.relation,
    relationKind: source.object.relationKind,
    sourceObjectRef: source.object.sourceObjectRef,
  }))
  const referencedObjects: SourceObjectRef[] = []
  const seenObjects = new Set<string>()
  for (const source of compiledSources) {
    const key = `${sourceKey(source.sourceObjectRef.sourceRef)}\u0000${source.sourceObjectRef.objectPath}`
    if (seenObjects.has(key)) continue
    seenObjects.add(key)
    referencedObjects.push(source.sourceObjectRef)
  }

  return {
    mappingRef: mapping.mappingRef,
    dialect: mapping.dialect,
    sources: compiledSources,
    joins,
    projections,
    predicates,
    groupBy,
    orderBy,
    limit: plan.limit,
    referencedObjects,
  }
}

function hasColumn(fields: ReadonlyMap<string, FieldMapping> | undefined, column: string): boolean {
  if (fields === undefined) return false
  for (const field of fields.values()) {
    if (field.column === column) return true
  }
  return false
}

