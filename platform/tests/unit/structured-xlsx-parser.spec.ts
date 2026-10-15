import { describe, expect, it } from 'vitest'
import { StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import type { StructuredCell, StructuredParseOptions, StructuredParseResult } from '@ontology/contracts'
import {
  buildXlsx,
  cellRef,
  numberCellXml,
  rowXml,
  sharedStringCell,
  worksheetOf,
} from '../fixtures/structured/xlsx'

const parser = new StructuredDocumentParser()

const XLSX_MEDIA = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function parseXlsx(bytes: Uint8Array, options: Partial<StructuredParseOptions> = {}): StructuredParseResult {
  return parser.parse(bytes, { mediaType: XLSX_MEDIA, ...options })
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

function simpleWorkbook(deflate = false): Uint8Array {
  const shared = ['Name', 'Qty', 'Active', 'Note', 'Widget', 'hello']
  const rows = [
    rowXml(1, [
      sharedStringCell(cellRef(1, 1), 0),
      sharedStringCell(cellRef(2, 1), 1),
      sharedStringCell(cellRef(3, 1), 2),
      sharedStringCell(cellRef(4, 1), 3),
    ]),
    rowXml(2, [
      sharedStringCell(cellRef(1, 2), 4),
      numberCellXml(cellRef(2, 2), '0.1000000000000000001'),
      `<c r="${cellRef(3, 2)}" t="b"><v>1</v></c>`,
      `<c r="${cellRef(4, 2)}"><f>B2*2</f><v>0.20</v></c>`,
    ]),
    rowXml(3, [sharedStringCell(cellRef(1, 3), 5), numberCellXml(cellRef(2, 3), '5')], true),
  ]
  return buildXlsx({ sheetXml: worksheetOf(rows), sharedStrings: shared, deflate })
}

describe('XLSX parsing with sheet, row and cell provenance', () => {
  it('reads lexical values, shared strings, booleans and formulas with cached values', () => {
    const result = parseXlsx(simpleWorkbook())
    expect(result.format).toBe('xlsx')
    expect(result.status).toBe('complete')

    const parsed = table(result)
    expect(parsed.sheetName).toBe('Sheet1')
    expect(parsed.columns.map((column) => column.header)).toEqual(['Name', 'Qty', 'Active', 'Note'])
    expect(parsed.dataRowCount).toBe(2)

    const name = cell(parsed, 0, 1)
    expect(name.kind).toBe('text')
    expect(name.raw).toBe('Widget')

    const quantity = cell(parsed, 0, 2)
    expect(quantity.kind).toBe('number')
    if (quantity.kind !== 'number') return
    expect(quantity.raw).toBe('0.1000000000000000001')
    expect(quantity.decimal).toBe('0.1000000000000000001')
    expect(quantity.locator.kind).toBe('table_cell')
    if (quantity.locator.kind !== 'table_cell') return
    expect(quantity.locator.format).toBe('xlsx')
    expect(quantity.locator.sheetName).toBe('Sheet1')
    expect(quantity.locator.address).toBe('B2')
    expect(quantity.locator.row).toBe(2)
    expect(quantity.locator.column).toBe(2)

    const active = cell(parsed, 0, 3)
    expect(active.kind).toBe('boolean')
    if (active.kind !== 'boolean') return
    expect(active.value).toBe(true)

    const formula = cell(parsed, 0, 4)
    expect(formula.kind).toBe('formula')
    if (formula.kind !== 'formula') return
    expect(formula.formula).toBe('B2*2')
    expect(formula.cachedRaw).toBe('0.20')
    expect(formula.decimal).toBe('0.20')
  })

  it('parses a deflated workbook the same way as a stored one', () => {
    const result = parseXlsx(simpleWorkbook(true))
    expect(result.status).toBe('complete')
    const quantity = cell(table(result), 0, 2)
    expect(quantity.raw).toBe('0.1000000000000000001')
  })

  it('reports hidden rows instead of silently dropping them', () => {
    const result = parseXlsx(simpleWorkbook())
    const parsed = table(result)
    expect(parsed.hiddenRows).toEqual([3])
    const hiddenRow = parsed.rows[1]
    expect(hiddenRow?.row).toBe(3)
    expect(hiddenRow?.hidden).toBe(true)
    expect(hiddenRow?.cells[0]?.raw).toBe('hello')
  })

  it('lists the workbook sheets and selects by name', () => {
    const bytes = buildXlsx({
      sheetName: 'Data',
      sheetXml: worksheetOf([
        rowXml(1, [sharedStringCell(cellRef(1, 1), 0)]),
        rowXml(2, [numberCellXml(cellRef(1, 2), '7')]),
      ]),
      sharedStrings: ['Value'],
    })
    const result = parseXlsx(bytes, { sheetName: 'Data' })
    expect(result.sheets.map((sheet) => sheet.name)).toEqual(['Data'])
    expect(table(result).rows[0]?.row).toBe(2)
  })

  it('refuses a sheet name that does not exist', () => {
    const result = parseXlsx(simpleWorkbook(), { sheetName: 'Missing' })
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('MISSING_SHEET')
  })

  it('fails a merged header instead of guessing columns', () => {
    const bytes = buildXlsx({
      sheetXml: worksheetOf(
        [rowXml(1, [sharedStringCell(cellRef(1, 1), 0), sharedStringCell(cellRef(2, 1), 1)])],
        ['A1:B1'],
      ),
      sharedStrings: ['A', 'B'],
    })
    const result = parseXlsx(bytes)
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('UNSUPPORTED_MULTI_LEVEL_HEADER')
  })

  it('fails an explicitly blank header cell instead of guessing a column', () => {
    const bytes = buildXlsx({
      sheetXml: worksheetOf([
        rowXml(1, [sharedStringCell(cellRef(1, 1), 0), '<c r="B1"/>', sharedStringCell(cellRef(3, 1), 1)]),
        rowXml(2, [numberCellXml(cellRef(1, 2), '1'), numberCellXml(cellRef(2, 2), '2'), numberCellXml(cellRef(3, 2), '3')]),
      ]),
      sharedStrings: ['A', 'C'],
    })
    const result = parseXlsx(bytes)
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('UNSUPPORTED_MULTI_LEVEL_HEADER')
  })

  it('fails merged data cells', () => {
    const bytes = buildXlsx({
      sheetXml: worksheetOf(
        [
          rowXml(1, [sharedStringCell(cellRef(1, 1), 0), sharedStringCell(cellRef(2, 1), 1)]),
          rowXml(2, [numberCellXml(cellRef(1, 2), '1'), numberCellXml(cellRef(2, 2), '2')]),
        ],
        ['A2:B2'],
      ),
      sharedStrings: ['A', 'B'],
    })
    const result = parseXlsx(bytes)
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('MERGED_CELLS')
  })

  it('refuses a macro-enabled workbook', () => {
    const bytes = buildXlsx({
      sheetXml: worksheetOf([rowXml(1, [sharedStringCell(cellRef(1, 1), 0)])]),
      sharedStrings: ['A'],
      vba: true,
    })
    const result = parseXlsx(bytes)
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('MACRO_ENABLED_WORKBOOK')
  })

  it('refuses an encrypted archive entry', () => {
    const bytes = buildXlsx({
      sheetXml: worksheetOf([rowXml(1, [sharedStringCell(cellRef(1, 1), 0)])]),
      sharedStrings: ['A'],
      encryptedEntries: ['xl/workbook.xml'],
    })
    const result = parseXlsx(bytes)
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('ENCRYPTED_WORKBOOK')
  })

  it('rejects on a row cap breach and supports explicit truncation', () => {
    const bytes = buildXlsx({
      sheetXml: worksheetOf([
        rowXml(1, [sharedStringCell(cellRef(1, 1), 0)]),
        rowXml(2, [numberCellXml(cellRef(1, 2), '1')]),
        rowXml(3, [numberCellXml(cellRef(1, 3), '2')]),
        rowXml(4, [numberCellXml(cellRef(1, 4), '3')]),
      ]),
      sharedStrings: ['Value'],
    })
    expect(parseXlsx(bytes, { caps: { maxRows: 2 } }).diagnostics[0]?.code).toBe('TOO_MANY_ROWS')

    const truncated = parseXlsx(bytes, { caps: { maxRows: 2 }, capBreachMode: 'truncate' })
    expect(truncated.status).toBe('incomplete')
    expect(table(truncated).dataRowCount).toBe(2)
  })

  it('reports declared empty data rows without turning them into records', () => {
    const bytes = buildXlsx({
      sheetXml: worksheetOf([
        rowXml(1, [sharedStringCell(cellRef(1, 1), 0)]),
        rowXml(2, [numberCellXml(cellRef(1, 2), '1')]),
        '<row r="3"/>',
        rowXml(4, [numberCellXml(cellRef(1, 4), '2')]),
      ]),
      sharedStrings: ['Value'],
    })
    const parsed = table(parseXlsx(bytes))
    expect(parsed.emptyRows).toEqual([3])
    expect(parsed.rows.map((row) => row.row)).toEqual([2, 4])
    // Row identity is preserved: the record after the gap still reports row 4.
    expect(parsed.rows[1]?.row).toBe(4)
  })

  it('rejects when the expanded archive exceeds its cap', () => {
    const result = parseXlsx(simpleWorkbook(), { caps: { maxExpandedBytes: 32 } })
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('EXPANSION_TOO_LARGE')
  })
})
