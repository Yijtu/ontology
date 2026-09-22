import type {
  ConsistencyLevel,
  QueryColumn,
  SchemaVersion,
  SourceObjectRef,
} from '@ontology/contracts'

/**
 * A relation the adapter is allowed to read. `relation` is the logical name the SQL
 * subset may reference; `objectRef` is the physical source object it maps to. The
 * sandbox allowlist is exactly this set — a query naming anything else is rejected
 * before the engine is touched (SPEC C3: "可访问对象白名单").
 */
export interface RegisteredRelation {
  readonly relation: string
  readonly objectRef: SourceObjectRef
  readonly schemaRevision: SchemaVersion
  readonly columns: readonly QueryColumn[]
  /**
   * Adapter-local materialisation hint (column name → DuckDB type) for imported
   * snapshots that need an exact physical type (e.g. `DECIMAL(18,4)`). It never reaches
   * the contracts; the catalog still reports the canonical `QueryColumn.type`.
   */
  readonly physicalTypes?: Readonly<Record<string, string>>
}

export interface DuckDbAdapterLimits {
  readonly maxRows: number
  readonly maxBytes: number
  readonly maxDurationMs: number
}

export interface DuckDbAdapterConfig {
  readonly relations: readonly RegisteredRelation[]
  /** Schema revision reported by the catalog and recorded on every snapshot. */
  readonly catalogSchemaRevision: SchemaVersion
  /** `:memory:` by default; a file path is opened read-only. */
  readonly instancePath?: string
  /**
   * Consistency the adapter reports. An imported snapshot materialised in memory is
   * `immutable`; a file-backed read-only instance is also `immutable`; anything else
   * degrades to `repeatable_read`, which is what the per-query read-only transaction
   * actually provides. A backend never invents a cross-store atomic version.
   */
  readonly consistency?: ConsistencyLevel
  readonly defaultLimits?: Partial<DuckDbAdapterLimits>
  /** Table functions explicitly enabled by configuration. Empty by default. */
  readonly allowedTableFunctions?: readonly string[]
  readonly now?: () => string
}

export const DEFAULT_DUCKDB_LIMITS: DuckDbAdapterLimits = {
  maxRows: 1000,
  maxBytes: 1_048_576,
  maxDurationMs: 10_000,
}

/** Case-insensitive lookup of the declared relations, tolerating a `main.` qualifier. */
export class RelationRegistry {
  readonly #byName: ReadonlyMap<string, RegisteredRelation>

  constructor(relations: readonly RegisteredRelation[]) {
    const byName = new Map<string, RegisteredRelation>()
    for (const relation of relations) {
      byName.set(relation.relation.toLowerCase(), relation)
    }
    this.#byName = byName
  }

  get size(): number {
    return this.#byName.size
  }

  list(): RegisteredRelation[] {
    return [...this.#byName.values()]
  }

  resolve(name: string): RegisteredRelation | undefined {
    const lower = name.toLowerCase()
    const direct = this.#byName.get(lower)
    if (direct !== undefined) return direct
    const dot = lower.indexOf('.')
    if (dot > 0 && lower.slice(0, dot) === 'main') {
      return this.#byName.get(lower.slice(dot + 1))
    }
    return undefined
  }
}
