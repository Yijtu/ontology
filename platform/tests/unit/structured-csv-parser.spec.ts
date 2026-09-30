import { describe, expect, it } from 'vitest'
import { StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import type { StructuredCell, StructuredParseOptions, StructuredParseResult } from '@ontology/contracts'

const parser = new StructuredDocumentParser()

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function parseCsv(text: string, options: Partial<StructuredParseOptions> = {}): StructuredParseResult {
  return parser.parse(utf8(text), { mediaType: 'text/csv', ...options })
}

function table(result: StructuredParseResult) {
  const first = result.tables[0]
  if (first === undefined) throw new Error(`no table: ${JSON.stringify(result.diagnostics)}`)
  return first
}

function cell(tableResult: ReturnType<typeof table>, rowIndex: number, column: number): StructuredCell {
  const row = tableResult.rows[rowIndex]
  if (row === undefined) throw new Error(`no row ${rowIndex}`)
  const value = row.cells[column - 1]
  if (value === undefined) throw new Error(`no cell ${rowIndex}:${column}`)
  return value
}

describe('CSV parsing with cell provenance', () => {
  it('resolves every cell to an original row, column and byte range', () => {
    const source = 'name,qty\nA,0.10\nB,2\n'
    const result = parseCsv(source)
    expect(result.format).toBe('csv')
    expect(result.status).toBe('complete')
    expect(result.coverage.status).toBe('complete')

    const parsed = table(result)
    expect(parsed.headerRow).toBe(1)
    expect(parsed.columns.map((column) => column.header)).toEqual(['name', 'qty'])
    expect(parsed.dataRowCount).toBe(2)

    const quantity = cell(parsed, 0, 2)
    expect(quantity.kind).toBe('number')
    if (quantity.kind !== 'number') return
    expect(quantity.raw).toBe('0.10')
    expect(quantity.decimal).toBe('0.10')
    expect(quantity.locator.kind).toBe('table_cell')
    if (quantity.locator.kind !== 'table_cell') return
    expect(quantity.locator.format).toBe('csv')
    expect(quantity.locator.row).toBe(2)
    expect(quantity.locator.column).toBe(2)
    expect(quantity.locator.recordIndex).toBe(1)
    expect(quantity.locator.address).toBe('B2')

    const bytes = utf8(source)
    const start = quantity.locator.startByte ?? -1
    const end = quantity.locator.endByte ?? -1
    expect(new TextDecoder().decode(bytes.subarray(start, end))).toBe('0.10')
  })

  it('handles quoted delimiters, escaped quotes and embedded newlines without splitting records', () => {
    const source = 'name,note\n"ACME, Inc.","said ""hi""\nsecond line"\n'
    const result = parseCsv(source)
    expect(result.status).toBe('complete')
    const parsed = table(result)
    expect(parsed.rows).toHaveLength(1)
    const note = cell(parsed, 0, 2)
    expect(note.kind).toBe('text')
    expect(note.raw).toBe('said "hi"\nsecond line')
    // The record starts on physical line 2 even though it spans two lines.
    const name = cell(parsed, 0, 1)
    expect(name.locator.kind).toBe('table_cell')
    if (name.locator.kind !== 'table_cell') return
    expect(name.locator.row).toBe(2)
  })

  it('treats an empty field as missing, never as zero', () => {
    const result = parseCsv('name,qty\nA,\n')
    const quantity = cell(table(result), 0, 2)
    expect(quantity.kind).toBe('empty')
    expect(quantity.raw).toBe('')
  })

  it('preserves a raw numeric token exactly and never coerces it through Number', () => {
    const result = parseCsv('id,amount\n1,0.1000000000000000001\n')
    const amount = cell(table(result), 0, 2)
    expect(amount.kind).toBe('number')
    if (amount.kind !== 'number') return
    expect(amount.raw).toBe('0.1000000000000000001')
    expect(amount.decimal).toBe('0.1000000000000000001')
  })

  it('keeps an exponent token raw and does not invent a canonical decimal', () => {
    const result = parseCsv('v\n1e3\n')
    const value = cell(table(result), 0, 1)
    expect(value.kind).toBe('number')
    if (value.kind !== 'number') return
    expect(value.raw).toBe('1e3')
    expect(value.decimal).toBeUndefined()
  })

  it('refuses invalid UTF-8 instead of replacing bytes', () => {
    const bytes = new Uint8Array([...utf8('name,v\nA,'), 0xff, 0xfe, 0x0a])
    const result = parser.parse(bytes, { mediaType: 'text/csv' })
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('INVALID_UTF8')
  })

  it('refuses a malformed quoted field', () => {
    const result = parseCsv('a,b\n"unterminated,2\n')
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('MALFORMED_CSV')
  })

  it('refuses a blank multi-level header instead of guessing columns', () => {
    const result = parseCsv('name,,qty\nA,ignored,1\n')
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('UNSUPPORTED_MULTI_LEVEL_HEADER')
  })

  it('rejects on a row cap breach', () => {
    const result = parseCsv('v\n1\n2\n3\n', { caps: { maxRows: 2 } })
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('TOO_MANY_ROWS')
    expect(result.tables).toHaveLength(0)
  })

  it('returns an explicit incomplete result only when truncation is requested', () => {
    const result = parseCsv('v\n1\n2\n3\n', { caps: { maxRows: 2 }, capBreachMode: 'truncate' })
    expect(result.status).toBe('incomplete')
    expect(result.coverage.completeness).toBe('truncated')
    expect(result.coverage.skippedUnits).toBe(1)
    expect(result.tables[0]?.dataRowCount).toBe(2)
    expect(result.diagnostics.some((issue) => issue.code === 'TOO_MANY_ROWS')).toBe(true)
  })

  it('rejects on a column cap breach', () => {
    const result = parseCsv('a,b,c\n1,2,3\n', { caps: { maxColumns: 2 } })
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('TOO_MANY_COLUMNS')
  })

  it('rejects on file size and cell size cap breaches', () => {
    const tooLarge = parseCsv('name,v\nA,1\n', { caps: { maxFileBytes: 4 } })
    expect(tooLarge.diagnostics[0]?.code).toBe('FILE_TOO_LARGE')

    const cellTooLarge = parseCsv('name,v\nA,abcd\n', { caps: { maxCellBytes: 2 } })
    expect(cellTooLarge.diagnostics[0]?.code).toBe('CELL_TOO_LARGE')
  })

  it('rejects a data row wider than the header', () => {
    const result = parseCsv('a,b\n1,2,3\n')
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('UNSUPPORTED_TABLE_LAYOUT')
  })
})
