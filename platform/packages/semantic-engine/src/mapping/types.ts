import type {
  AggregationKind,
  AttributeValueType,
  Cardinality,
  ColumnType,
  ComparisonOperator,
  ScalarValue,
  SourceObjectRef,
  UnitCode,
  UnitRef,
  VersionRef,
} from '@ontology/contracts'

/**
 * The confirmed physical mapping (SPEC C1/C3, INV-03).
 *
 * The industry pack owns semantics only: it never carries a physical column name. This
 * module is the deployment-side mapping that translates a logical role/concept/field/link
 * id into a source object, a physical column and a value/unit conversion. A mapping is
 * versioned by `mappingRef`, so a query compiled against one version can never be silently
 * reinterpreted against another.
 *
 * Identifiers (schema, relation, column) may only ever come from here. User or model text
 * is bound as a parameter and is never concatenated into SQL.
 */

/** Backend SQL dialect a mapping targets. Kept to the two real first-phase engines. */
export type MappingDialect = 'postgres' | 'duckdb'

/** One physical → canonical value translation (status/flag encodings). */
export interface ValueMapEntry {
  readonly physical: ScalarValue
  readonly canonical: ScalarValue
}

export interface FieldMapping {
  /** Canonical semantic field id; also the output column alias. */
  readonly fieldRef: string
  /** Physical column name. The only identifier source for a projected field. */
  readonly column: string
  readonly valueType: AttributeValueType
  /** Canonical unit. Required for `quantity`, forbidden otherwise. */
  readonly unit?: UnitRef
  /**
   * Physical units per one canonical unit (physical = canonical × unitFactor), so a
   * projection is `column / unitFactor` and a filter keeps the canonical value as the
   * bound parameter and divides inside SQL. Defaults to 1.
   */
  readonly unitFactor?: number
  /** Physical → canonical encoding map for enums/flags. */
  readonly valueMap?: readonly ValueMapEntry[]
  readonly identityKey?: boolean
  /** A canonical typed project projection must retain its stored decimal precision. */
  readonly exactDecimal?: boolean
}

export interface ObjectMapping {
  /** Canonical concept/object id. */
  readonly conceptId: string
  /** The physical source object this concept reads from. */
  readonly sourceObjectRef: SourceObjectRef
  /** Physical schema. Never exposed to a model. */
  readonly schema: string
  /** Physical relation (table or view). Never exposed to a model. */
  readonly relation: string
  readonly relationKind: 'table' | 'view'
  /** Declared upper bound on the rows this object contributes, used for the budget check. */
  readonly estimatedRows: number
  readonly fields: readonly FieldMapping[]
  /** The field a `time` window is applied to, when the object is temporal. */
  readonly timeFieldRef?: string
}

/** The explicit scope/bound of one link, used before any join is planned. */
export interface LinkScope {
  /** Maximum rows a single `from` row may fan out to on the `to` side. */
  readonly maxFanout: number
}

/**
 * A declared relation between two concepts. The join keys are explicit physical columns
 * from the two endpoint mappings; a join without declared keys is refused, never guessed.
 */
export interface LinkMapping {
  readonly linkId: string
  readonly fromConceptId: string
  readonly toConceptId: string
  readonly fromColumn: string
  readonly toColumn: string
  readonly joinKind: 'inner' | 'left'
  readonly cardinality: Cardinality
  readonly scope: LinkScope
}

export interface SemanticMapping {
  readonly mappingRef: VersionRef
  readonly dialect: MappingDialect
  readonly objects: readonly ObjectMapping[]
  readonly links: readonly LinkMapping[]
}

/** Look up a confirmed mapping by its exact versioned ref. */
export interface SemanticMappingRegistry {
  resolve(mappingRef: VersionRef): SemanticMapping | undefined
  list(): readonly SemanticMapping[]
}

/**
 * Bounds the compiler enforces before it emits any SQL. A query that exceeds a bound is
 * refused (or split by the caller); it is never executed as an unbounded full-table pull.
 */
export interface CompilationBudget {
  readonly maxRows: number
  readonly maxBytes: number
  /** Maximum allowed `LinkScope.maxFanout` for any join in the plan. */
  readonly maxJoinFanout: number
  /** Conservative per-row transfer estimate; defaults to 64 bytes. */
  readonly estimatedBytesPerRow?: number
}

/** A resolved column reference, `alias.column`, both taken from the confirmed mapping. */
export interface CompiledColumnRef {
  readonly alias: string
  readonly column: string
}

export type CompiledExpression =
  | { readonly kind: 'column'; readonly column: CompiledColumnRef }
  | { readonly kind: 'scaled'; readonly operand: CompiledExpression; readonly factor: number }
  | {
      readonly kind: 'mapped'
      readonly operand: CompiledExpression
      readonly map: readonly ValueMapEntry[]
      readonly fallback: ScalarValue
    }
  | {
      readonly kind: 'aggregate'
      readonly fn: AggregationKind
      readonly operand: CompiledExpression
    }

export interface CompiledProjection {
  readonly fieldRef: string
  readonly expression: CompiledExpression
  readonly columnType: ColumnType
  readonly unit?: UnitCode
  readonly exactDecimal?: boolean
}

export interface CompiledPredicate {
  readonly expression: CompiledExpression
  readonly op: ComparisonOperator
  readonly values: readonly ScalarValue[]
}

export interface CompiledJoin {
  readonly linkId: string
  readonly fromAlias: string
  readonly toAlias: string
  readonly fromColumn: string
  readonly toColumn: string
  readonly joinKind: 'inner' | 'left'
}

export interface CompiledSource {
  readonly alias: string
  readonly conceptId: string
  readonly schema: string
  readonly relation: string
  readonly relationKind: 'table' | 'view'
  readonly sourceObjectRef: SourceObjectRef
}

export interface CompiledOrder {
  readonly fieldRef: string
  readonly expression: CompiledExpression
  readonly direction: 'asc' | 'desc'
}

/**
 * A dialect-neutral compiled query. The compiler is pure and never emits dialect text;
 * `renderCompiledQuery` turns this into backend SQL inside the adapter-facing portion.
 */
export interface CompiledQuery {
  readonly mappingRef: VersionRef
  readonly dialect: MappingDialect
  readonly sources: readonly CompiledSource[]
  readonly joins: readonly CompiledJoin[]
  readonly projections: readonly CompiledProjection[]
  readonly predicates: readonly CompiledPredicate[]
  readonly groupBy: readonly CompiledExpression[]
  readonly orderBy: readonly CompiledOrder[]
  readonly limit: number
  readonly referencedObjects: readonly SourceObjectRef[]
}

/** A rendered query: backend SQL plus the ordered bound parameters. */
export interface RenderedQuery {
  readonly sql: string
  readonly parameters: readonly ScalarValue[]
  readonly referencedObjects: readonly SourceObjectRef[]
}

export function canonicalColumnTypeOf(valueType: AttributeValueType): ColumnType {
  switch (valueType) {
    case 'number':
    case 'quantity':
      return 'decimal'
    case 'boolean':
      return 'boolean'
    case 'timestamp':
      return 'timestamp'
    case 'string':
    case 'enum':
    case 'reference':
      return 'string'
  }
}
