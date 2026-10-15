import { readFile } from 'node:fs/promises'
import { DuckDbQueryAdapter } from '@ontology/adapter-data-duckdb'
import type { RegisteredRelation } from '@ontology/adapter-data-duckdb'
import type { QueryColumn, ScalarValue } from '@ontology/contracts'
import { canonicalJson } from '@ontology/tool-services'
import { sourceKey } from './core-composition-shared'
import { parseJsonRecordBlocks } from './core-json-records'
import type { CoreExampleScenario } from './core-example-loader'

function columnType(values: readonly ScalarValue[]): { readonly type: QueryColumn['type']; readonly physicalType: string } {
  const populated = values.filter((value) => value !== null)
  if (populated.length === 0) return { type: 'string', physicalType: 'VARCHAR' }
  if (populated.every((value) => typeof value === 'boolean')) return { type: 'boolean', physicalType: 'BOOLEAN' }
  if (populated.every((value) => typeof value === 'number')) {
    const integral = populated.every((value) => typeof value === 'number' && Number.isSafeInteger(value))
    return integral ? { type: 'integer', physicalType: 'BIGINT' } : { type: 'decimal', physicalType: 'DECIMAL(38,10)' }
  }
  if (populated.every((value) => typeof value === 'string')) {
    const timestamps = populated.every((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value))
    return timestamps ? { type: 'timestamp', physicalType: 'TIMESTAMP' } : { type: 'string', physicalType: 'VARCHAR' }
  }
  return { type: 'json', physicalType: 'JSON' }
}

/** Build the bounded in-memory DuckDB snapshot the sample deployment serves synthetic queries from. */
export async function createDuckDbSnapshot(scenarios: readonly CoreExampleScenario[]): Promise<DuckDbQueryAdapter> {
  const recordsBySource = new Map<string, Record<string, ScalarValue>[]>()
  for (const scenario of scenarios) {
    for (const source of scenario.rawSources) {
      recordsBySource.set(sourceKey(source.sourceRef), parseJsonRecordBlocks(await readFile(source.path, 'utf8'), source.path))
    }
  }

  const registered: RegisteredRelation[] = []
  const rowsByRelation = new Map<string, readonly (readonly ScalarValue[])[]>()
  const registeredByRelation = new Map<string, RegisteredRelation>()
  for (const scenario of scenarios) {
    for (const loaded of scenario.physicalMappings) {
      for (const object of loaded.mapping.objects) {
        const sourceRecords = recordsBySource.get(sourceKey(object.sourceObjectRef.sourceRef))
        if (sourceRecords === undefined) throw new Error(`no loaded raw source for mapping ${loaded.ref.id}`)
        const columns = [...new Set(object.fields.map((field) => field.column))]
        if (columns.length === 0) throw new Error(`mapping ${loaded.ref.id} has no readable fields`)
        const valuesByColumn = new Map(columns.map((column) => [
          column,
          sourceRecords.map((record) => record[column] ?? null),
        ]))
        const physicalTypes: Record<string, string> = {}
        const queryColumns = columns.map((name) => {
          const resolved = columnType(valuesByColumn.get(name) ?? [])
          physicalTypes[name] = resolved.physicalType
          return { name, type: resolved.type }
        })
        const relation = `${object.schema}.${object.relation}`
        const registeredRelation: RegisteredRelation = {
          relation,
          objectRef: object.sourceObjectRef,
          schemaRevision: loaded.ref.digest,
          columns: queryColumns,
          physicalTypes,
        }
        const rows = sourceRecords.map((record) => columns.map((column) => record[column] ?? null))
        const prior = registeredByRelation.get(relation)
        if (prior !== undefined) {
          const priorRows = rowsByRelation.get(relation)
          if (
            sourceKey(prior.objectRef.sourceRef) !== sourceKey(registeredRelation.objectRef.sourceRef) ||
            prior.objectRef.objectPath !== registeredRelation.objectRef.objectPath ||
            canonicalJson(prior.columns) !== canonicalJson(registeredRelation.columns) ||
            canonicalJson(priorRows) !== canonicalJson(rows)
          ) {
            throw new Error(`physical relation ${relation} has conflicting schemas or raw source contents across mappings`)
          }
          continue
        }
        registeredByRelation.set(relation, registeredRelation)
        registered.push(registeredRelation)
        rowsByRelation.set(relation, rows)
      }
    }
  }

  const adapter = new DuckDbQueryAdapter({
    relations: registered,
    catalogSchemaRevision: 'core-example-snapshot@1',
    consistency: 'immutable',
    defaultLimits: { maxRows: 1_000, maxBytes: 1_048_576, maxDurationMs: 10_000 },
  })
  try {
    await adapter.start()
    for (const [relation, rows] of rowsByRelation) await adapter.materialiseRelation(relation, rows)
    return adapter
  } catch (error) {
    adapter.close()
    throw error
  }
}
