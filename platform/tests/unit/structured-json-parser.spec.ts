import { describe, expect, it } from 'vitest'
import { StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import type { StructuredCell, StructuredParseOptions, StructuredParseResult } from '@ontology/contracts'

const parser = new StructuredDocumentParser()

function parseJson(text: string, options: Partial<StructuredParseOptions> = {}): StructuredParseResult {
  return parser.parse(new TextEncoder().encode(text), { mediaType: 'application/json', ...options })
}

function record(result: StructuredParseResult, index: number) {
  const value = result.records[index]
  if (value === undefined) throw new Error(`no record ${index}: ${JSON.stringify(result.diagnostics)}`)
  return value
}

function cell(recordValue: ReturnType<typeof record>, index: number): StructuredCell {
  const value = recordValue.cells[index]
  if (value === undefined) throw new Error(`no cell ${index}`)
  return value
}

describe('JSON parsing with JSON Pointer provenance', () => {
  it('parses an array of records and locates each value by pointer and byte range', () => {
    const source = '[{"name":"A","qty":0.10},{"name":"B","qty":2}]'
    const result = parseJson(source)
    expect(result.format).toBe('json')
    expect(result.status).toBe('complete')
    expect(result.records).toHaveLength(2)

    const first = record(result, 0)
    expect(first.recordRef).toBe('/0')
    const quantity = cell(first, 1)
    expect(quantity.kind).toBe('number')
    if (quantity.kind !== 'number') return
    expect(quantity.raw).toBe('0.10')
    expect(quantity.decimal).toBe('0.10')
    expect(quantity.locator.kind).toBe('json_pointer')
    if (quantity.locator.kind !== 'json_pointer') return
    expect(quantity.locator.pointer).toBe('/0/qty')
    const bytes = new TextEncoder().encode(source)
    expect(new TextDecoder().decode(bytes.subarray(quantity.locator.startByte, quantity.locator.endByte))).toBe('0.10')
  })

  it('supports an object with a records array', () => {
    const result = parseJson('{"records":[{"name":"A"}],"meta":{}}')
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.recordRef).toBe('/records/0')
  })

  it('treats a single object as one record', () => {
    const result = parseJson('{"name":"A","qty":1}')
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.recordRef).toBe('')
  })

  it('preserves exponent number tokens without inventing a canonical decimal', () => {
    const result = parseJson('[{"qty":1.0e+3}]')
    const quantity = cell(record(result, 0), 0)
    expect(quantity.kind).toBe('number')
    if (quantity.kind !== 'number') return
    expect(quantity.raw).toBe('1.0e+3')
    expect(quantity.decimal).toBeUndefined()
  })

  it('flattens a nested object into pointer-addressed leaf cells', () => {
    const result = parseJson('[{"a":{"b":1},"c":[true,null]}]')
    const cells = record(result, 0).cells
    const pointers = cells.map((value) => (value.locator.kind === 'json_pointer' ? value.locator.pointer : ''))
    expect(pointers).toEqual(['/0/a/b', '/0/c/0', '/0/c/1'])
    expect(cells[1]?.kind).toBe('boolean')
    expect(cells[2]?.kind).toBe('empty')
    expect(cells[2]?.raw).toBe('')
  })

  it('refuses duplicate keys that cannot be located unambiguously', () => {
    const result = parseJson('{"a":1,"a":2}')
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('DUPLICATE_JSON_KEY')
  })

  it('refuses invalid JSON', () => {
    const result = parseJson('{"a":')
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('INVALID_JSON')
  })

  it('refuses a scalar root that has no records to locate', () => {
    const result = parseJson('42')
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('UNSUPPORTED_TABLE_LAYOUT')
  })

  it('rejects on a record cap breach and supports explicit truncation', () => {
    const source = '[{"v":1},{"v":2},{"v":3}]'
    expect(parseJson(source, { caps: { maxRows: 2 } }).diagnostics[0]?.code).toBe('TOO_MANY_ROWS')

    const truncated = parseJson(source, { caps: { maxRows: 2 }, capBreachMode: 'truncate' })
    expect(truncated.status).toBe('incomplete')
    expect(truncated.records).toHaveLength(2)
    expect(truncated.coverage.completeness).toBe('truncated')
  })

  it('rejects records deeper than the nesting cap', () => {
    const result = parseJson('[{"v":{"a":{"b":{"c":1}}}}]', { caps: { maxDepth: 2 } })
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('NESTING_TOO_DEEP')
  })

  it('rejects a record wider than the column cap', () => {
    const result = parseJson('[{"a":1,"b":2,"c":3}]', { caps: { maxColumns: 2 } })
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('TOO_MANY_COLUMNS')
  })
})
