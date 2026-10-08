import type {
  ProjectDatasetFieldSource,
  ProjectDatasetRef,
  ProjectSnapshotQueryDescriptor,
  ProjectSnapshotQueryPort,
  QueryColumn,
  QueryLimits,
  SemanticQueryPlan,
  SourceObjectRef,
  SourceSnapshot,
  StructuredQueryExecuteResponse,
  ToolContext,
  ToolCoverage,
  VersionRef,
} from '@ontology/contracts'
import { assertProjectDatasetFieldSourcesShape } from '@ontology/contracts'
import { compileSemanticQuery } from '../mapping/compile'
import { renderCompiledQuery } from '../mapping/render'
import type { SemanticMapping } from '../mapping/types'
import {
  PROJECT_SNAPSHOT_RECORD_ID_FIELD,
  PROJECT_SNAPSHOT_SOURCES_FIELD,
  buildProjectSnapshotMapping,
} from '../mapping/project-snapshot'
import { isSemanticMappingError } from '../mapping/errors'
import { ProjectSemanticQueryError } from './errors'

/**
 * The assembled "project semantics + SQL query" path (SPEC v0.3a EX-3.1, V03-025).
 *
 * It compiles a semantic query plan against the project's *fixed* dataset snapshot mapping,
 * renders read-only SQL, and executes it through the injected `ProjectSnapshotQueryPort` — the
 * same contract the two real business backends (DuckDB / PostgreSQL) implement. The snapshot is
 * pinned by ref; there is no fallback to the startup demo data or to a newer dataset.
 *
 * The result keeps the row identity and the exact per-row source locators the snapshot recorded,
 * so a caller can trace every returned value back to its original document/parse/cell. The
 * identity and locator columns are projected alongside the requested fields (unless the plan
 * aggregates, in which case the values are grouped and per-row locators no longer apply).
 */

export interface ProjectSnapshotQueryRow {
  /** The canonical snapshot record id, or `''` for a grouped/aggregated row. */
  readonly recordId: string
  /** The requested projected values, in `columns` order and already canonical. */
  readonly values: readonly (string | number | boolean | null)[]
  /** The exact physical source of each value, empty for a grouped/aggregated row. */
  readonly sources: readonly ProjectDatasetFieldSource[]
}

export interface ProjectSnapshotQueryResult {
  readonly mappingRef: VersionRef
  readonly snapshotRef: ProjectDatasetRef
  readonly columns: readonly QueryColumn[]
  readonly rows: readonly ProjectSnapshotQueryRow[]
  readonly coverage: ToolCoverage
  readonly snapshots: readonly SourceSnapshot[]
  readonly warnings: readonly string[]
}

export interface ProjectSemanticQueryRequest {
  readonly descriptor: ProjectSnapshotQueryDescriptor
  readonly plan: SemanticQueryPlan
  readonly limits: QueryLimits
  readonly cursor?: string
}

export interface ProjectSemanticQueryServiceDependencies {
  readonly query: ProjectSnapshotQueryPort
  /** Conservative row bound handed to the compiler's transfer budget. */
  readonly estimatedRows?: number
  readonly maxJoinFanout?: number
  readonly estimatedBytesPerRow?: number
}

const DEFAULT_MAX_JOIN_FANOUT = 100

function parseSources(value: unknown): readonly ProjectDatasetFieldSource[] {
  if (typeof value !== 'string' || value.length === 0) throw new ProjectSemanticQueryError('SNAPSHOT_UNAVAILABLE', 'the fixed project row has no field provenance')
  try {
    const parsed: unknown = JSON.parse(value)
    assertProjectDatasetFieldSourcesShape(parsed)
    return parsed
  } catch (error) {
    throw new ProjectSemanticQueryError('SNAPSHOT_UNAVAILABLE', 'the fixed project row provenance is malformed', { cause: error })
  }
}

function isAggregating(plan: SemanticQueryPlan): boolean {
  return plan.aggregation !== undefined && plan.aggregation.kind !== 'none'
}

function refusalCode(code: string | undefined): ProjectSemanticQueryError['code'] {
  if (code === 'FORBIDDEN') return 'FORBIDDEN'
  if (code === 'SNAPSHOT_UNAVAILABLE') return 'SNAPSHOT_UNAVAILABLE'
  if (code === 'INVALID_ARGUMENT') return 'INVALID_ARGUMENT'
  return 'UNSUPPORTED_QUERY'
}

export class ProjectSemanticQueryService {
  readonly #query: ProjectSnapshotQueryPort
  readonly #estimatedRows: number | undefined
  readonly #maxJoinFanout: number
  readonly #estimatedBytesPerRow: number | undefined

  constructor(dependencies: ProjectSemanticQueryServiceDependencies) {
    this.#query = dependencies.query
    this.#estimatedRows = dependencies.estimatedRows
    this.#maxJoinFanout = dependencies.maxJoinFanout ?? DEFAULT_MAX_JOIN_FANOUT
    this.#estimatedBytesPerRow = dependencies.estimatedBytesPerRow
  }

  /** Build (and return) the immutable mapping for one fixed snapshot descriptor. */
  mappingFor(descriptor: ProjectSnapshotQueryDescriptor): SemanticMapping {
    return buildProjectSnapshotMapping({
      descriptor,
      ...(this.#estimatedRows === undefined ? {} : { estimatedRows: this.#estimatedRows }),
    })
  }

  async execute(
    request: ProjectSemanticQueryRequest,
    ctx: ToolContext,
  ): Promise<ProjectSnapshotQueryResult> {
    const mapping = this.mappingFor(request.descriptor)
    const aggregate = isAggregating(request.plan)
    const projectedFields = aggregate
      ? [...request.plan.fields]
      : [...new Set([
          ...request.plan.fields,
          PROJECT_SNAPSHOT_RECORD_ID_FIELD,
          PROJECT_SNAPSHOT_SOURCES_FIELD,
        ])]
    const plan: SemanticQueryPlan = { ...request.plan, fields: projectedFields,
      orderBy: !aggregate && request.plan.orderBy.length === 0 ? [{ fieldRef: PROJECT_SNAPSHOT_RECORD_ID_FIELD, direction: 'asc' }] : request.plan.orderBy }

    let sql: string
    let parameters: readonly (string | number | boolean | null)[]
    let referencedObjects: readonly SourceObjectRef[]
    try {
      const compiled = compileSemanticQuery(plan, mapping, {
        budget: {
          maxRows: request.limits.maxRows,
          maxBytes: request.limits.maxBytes,
          maxJoinFanout: this.#maxJoinFanout,
          ...(this.#estimatedBytesPerRow === undefined
            ? {}
            : { estimatedBytesPerRow: this.#estimatedBytesPerRow }),
        },
      })
      const rendered = renderCompiledQuery(compiled)
      sql = rendered.sql
      parameters = rendered.parameters
      referencedObjects = rendered.referencedObjects
    } catch (error) {
      if (isSemanticMappingError(error)) {
        throw new ProjectSemanticQueryError('UNSUPPORTED_QUERY', error.message, { cause: error })
      }
      throw error
    }

    const directPlan = {
      mode: 'direct' as const,
      statementKind: 'select' as const,
      sql,
      parameters: [...parameters],
      referencedObjects: [...referencedObjects],
      readOnly: true as const,
    }
    const validation = await this.#query.validate({ plan: directPlan, limits: request.limits }, ctx)
    if (!validation.valid) {
      const reason = validation.rejectedReason
      throw new ProjectSemanticQueryError(
        refusalCode(reason?.code),
        reason?.message ?? 'the generated SQL was refused before execution',
        reason === undefined ? {} : { platformError: reason },
      )
    }
    const checkedPlan = validation.normalizedPlan ?? directPlan
    const response = await this.#query.execute(
      {
        plan: checkedPlan,
        limits: request.limits,
        snapshotRequest: { consistency: 'immutable' },
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      },
      ctx,
    )

    return this.#assemble(mapping.mappingRef, request.descriptor, response, aggregate, [
      ...validation.warnings,
    ])
  }

  #assemble(
    mappingRef: VersionRef,
    descriptor: ProjectSnapshotQueryDescriptor,
    response: StructuredQueryExecuteResponse,
    aggregate: boolean,
    warnings: string[],
  ): ProjectSnapshotQueryResult {
    const fieldByName = new Map(descriptor.columns.map((column) => [column.name, column]))
    const shownColumns: QueryColumn[] = []
    const shownIndices: number[] = []
    let recordIdIndex = -1
    let sourcesIndex = -1
    response.columns.forEach((column, index) => {
      if (!aggregate && column.name === PROJECT_SNAPSHOT_RECORD_ID_FIELD) {
        recordIdIndex = index
        return
      }
      if (!aggregate && column.name === PROJECT_SNAPSHOT_SOURCES_FIELD) {
        sourcesIndex = index
        return
      }
      const declared = fieldByName.get(column.name)
      shownColumns.push({
        name: column.name,
        type: column.type,
        semanticFieldRef: column.name,
        ...(declared?.canonicalUnitCode === undefined ? {} : { unit: declared.canonicalUnitCode }),
      })
      shownIndices.push(index)
    })

    const rows: ProjectSnapshotQueryRow[] = response.rows.map((row) => ({
      recordId: recordIdIndex >= 0 ? String(row[recordIdIndex] ?? '') : '',
      values: shownIndices.map((index) => {
        const value = row[index]
        if (value === null || value === undefined) return null
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          return value
        }
        return String(value)
      }),
      sources: sourcesIndex >= 0 ? parseSources(row[sourcesIndex]) : [],
    }))

    return {
      mappingRef,
      snapshotRef: descriptor.snapshotRef,
      columns: shownColumns,
      rows,
      coverage: response.coverage,
      snapshots: [response.snapshot],
      warnings,
    }
  }
}
