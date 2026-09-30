import type {
  Sha256Digest,
  StructuredCell,
  StructuredColumn,
  StructuredParseCaps,
  StructuredParseIssue,
  StructuredParseOptions,
  StructuredRow,
  StructuredSheetInfo,
  StructuredTable,
  TableCellSourceLocator,
  TableRowSourceLocator,
} from '@ontology/contracts'
import { identityNormalizationMapRef, sha256DigestOfText } from './bytes'
import { booleanCell, dateCell, emptyCell, errorCell, formulaCell, numberCell, textCell } from './cells'
import { enforceCellBytes } from './caps'
import { StructuredParseError } from './errors'
import type { FormatParseResult } from './internal'
import { columnLabel } from './internal'
import { scanXml } from './xml'
import type { ZipArchive } from './zip'
import { openZip, readZipText } from './zip'

const WORKBOOK_PART = 'xl/workbook.xml'
const WORKBOOK_RELS_PART = 'xl/_rels/workbook.xml.rels'
const SHARED_STRINGS_PART = 'xl/sharedStrings.xml'

type CellType = 'n' | 's' | 'str' | 'b' | 'e' | 'd' | 'inline' | 'empty'

interface RawCell {
  readonly column: number
  readonly row: number
  readonly address: string
  readonly type: CellType
  readonly rawV: string
  readonly inlineText: string
  readonly formula?: string
}

interface SheetDefinition {
  readonly sheetId: string
  readonly name: string
  readonly hidden: boolean
  readonly target: string
}

interface WorkbookMeta {
  readonly sheets: readonly SheetDefinition[]
  readonly sharedStrings: readonly string[]
}

function splitAddress(address: string): { column: number; row: number } | undefined {
  const match = /^([A-Za-z]+)(\d+)$/.exec(address)
  if (match === null) return undefined
  const letters = match[1] ?? ''
  const digits = match[2] ?? ''
  let column = 0
  for (const letter of letters.toUpperCase()) {
    column = column * 26 + (letter.charCodeAt(0) - 64)
  }
  return { column, row: Number.parseInt(digits, 10) }
}

function attrsOf(token: { attrs: ReadonlyMap<string, string> }, name: string): string | undefined {
  return token.attrs.get(name)
}

function relIdOf(attrs: ReadonlyMap<string, string>): string | undefined {
  for (const [key, value] of attrs) {
    if (key === 'r:id' || key === 'id' || key.endsWith(':id')) return value
  }
  return undefined
}

function normalizeTarget(target: string): string {
  let normalized = target.replace(/\\/g, '/')
  if (normalized.startsWith('/')) normalized = normalized.slice(1)
  else normalized = `xl/${normalized}`
  const parts: string[] = []
  for (const segment of normalized.split('/')) {
    if (segment === '..') parts.pop()
    else if (segment !== '.' && segment.length > 0) parts.push(segment)
  }
  return parts.join('/')
}

function parseWorkbook(archive: ZipArchive): WorkbookMeta {
  const workbookXml = readZipText(archive, WORKBOOK_PART)
  if (workbookXml === undefined) {
    throw new StructuredParseError('MALFORMED_XLSX', 'the workbook part xl/workbook.xml is missing')
  }
  const relsXml = readZipText(archive, WORKBOOK_RELS_PART) ?? ''
  const relationshipTargets = new Map<string, string>()
  for (const token of scanXml(relsXml)) {
    if (token.kind !== 'start' || token.localName !== 'Relationship') continue
    const id = attrsOf(token, 'Id')
    const target = attrsOf(token, 'Target')
    const type = attrsOf(token, 'Type') ?? ''
    if (id !== undefined && target !== undefined && type.endsWith('/worksheet')) {
      relationshipTargets.set(id, normalizeTarget(target))
    }
  }

  const sheets: SheetDefinition[] = []
  for (const token of scanXml(workbookXml)) {
    if (token.kind !== 'start' || token.localName !== 'sheet') continue
    const name = attrsOf(token, 'name') ?? ''
    const sheetId = attrsOf(token, 'sheetId') ?? ''
    const relId = relIdOf(token.attrs)
    const state = attrsOf(token, 'state') ?? 'visible'
    const target = relId === undefined ? undefined : relationshipTargets.get(relId)
    if (target === undefined) {
      throw new StructuredParseError('MALFORMED_XLSX', `sheet ${name || sheetId} has no relationship target`)
    }
    sheets.push({ sheetId, name, hidden: state !== 'visible', target })
  }
  if (sheets.length === 0) {
    throw new StructuredParseError('MALFORMED_XLSX', 'the workbook declares no sheets')
  }

  const sharedStrings: string[] = []
  const sharedXml = readZipText(archive, SHARED_STRINGS_PART)
  if (sharedXml !== undefined) {
    let current: string | undefined
    let inText = false
    for (const token of scanXml(sharedXml)) {
      if (token.kind === 'start') {
        if (token.localName === 'si') current = ''
        else if (token.localName === 't' && current !== undefined) inText = true
      } else if (token.kind === 'text') {
        if (inText && current !== undefined) current += token.value
      } else if (token.kind === 'end') {
        if (token.localName === 't') inText = false
        else if (token.localName === 'si') {
          sharedStrings.push(current ?? '')
          current = undefined
        }
      }
    }
  }

  return { sheets, sharedStrings }
}

interface WorksheetData {
  readonly cells: ReadonlyMap<number, ReadonlyMap<number, RawCell>>
  readonly declaredRows: ReadonlySet<number>
  readonly hiddenRows: ReadonlySet<number>
  readonly hiddenColumns: ReadonlySet<number>
  readonly merges: readonly string[]
}

function parseWorksheet(archive: ZipArchive, target: string, caps: StructuredParseCaps): WorksheetData {
  const xml = readZipText(archive, target)
  if (xml === undefined) {
    throw new StructuredParseError('MALFORMED_XLSX', `the worksheet part ${target} is missing`)
  }

  const cells = new Map<number, Map<number, RawCell>>()
  const declaredRows = new Set<number>()
  const hiddenRows = new Set<number>()
  const hiddenColumns = new Set<number>()
  const merges: string[] = []

  let rowNumber = 0
  let rowHidden = false
  let currentCell: {
    column: number
    row: number
    address: string
    type: CellType
    v: string
    inline: string
    formula?: string
  } | undefined
  let leaf: 'v' | 'f' | 't' | undefined
  let inInline = false

  const storeCell = (cell: NonNullable<typeof currentCell>): void => {
    const rowMap = cells.get(cell.row) ?? new Map<number, RawCell>()
    rowMap.set(cell.column, {
      column: cell.column,
      row: cell.row,
      address: cell.address,
      type: cell.type,
      rawV: cell.v,
      inlineText: cell.inline,
      ...(cell.formula === undefined ? {} : { formula: cell.formula }),
    })
    cells.set(cell.row, rowMap)
  }

  for (const token of scanXml(xml)) {
    if (token.kind === 'text') {
      if (leaf === 'v' && currentCell !== undefined) currentCell.v += token.value
      else if (leaf === 'f' && currentCell !== undefined) currentCell.formula = (currentCell.formula ?? '') + token.value
      else if (leaf === 't' && currentCell !== undefined) currentCell.inline += token.value
      continue
    }
    if (token.kind === 'start') {
      switch (token.localName) {
        case 'row': {
          const r = attrsOf(token, 'r')
          rowNumber = r === undefined ? rowNumber + 1 : Number.parseInt(r, 10)
          rowHidden = (attrsOf(token, 'hidden') ?? '') === '1'
          declaredRows.add(rowNumber)
          if (rowHidden) hiddenRows.add(rowNumber)
          if (token.selfClosing) {
            rowHidden = false
          }
          break
        }
        case 'c': {
          const address = attrsOf(token, 'r') ?? ''
          const split = splitAddress(address)
          const column = split?.column ?? 0
          const row = split?.row ?? rowNumber
          const t = attrsOf(token, 't') ?? 'n'
          const type: CellType =
            t === 's' || t === 'str' || t === 'b' || t === 'e' || t === 'd' || t === 'inlineStr'
              ? t === 'inlineStr'
                ? 'inline'
                : t
              : 'n'
          currentCell = { column, row, address, type, v: '', inline: '' }
          if (token.selfClosing) {
            storeCell(currentCell)
            currentCell = undefined
          }
          break
        }
        case 'v':
          if (currentCell !== undefined) {
            leaf = 'v'
            if (token.selfClosing) leaf = undefined
          }
          break
        case 'f':
          if (currentCell !== undefined) {
            leaf = 'f'
            if (token.selfClosing) {
              currentCell.formula = currentCell.formula ?? ''
              leaf = undefined
            }
          }
          break
        case 't':
          if (inInline && currentCell !== undefined) leaf = 't'
          break
        case 'is':
          inInline = true
          break
        case 'mergeCell': {
          const ref = attrsOf(token, 'ref')
          if (ref !== undefined) merges.push(ref)
          break
        }
        case 'col': {
          const hidden = (attrsOf(token, 'hidden') ?? '') === '1'
          if (hidden) {
            const min = Number.parseInt(attrsOf(token, 'min') ?? '0', 10)
            const max = Number.parseInt(attrsOf(token, 'max') ?? '0', 10)
            if (min >= 1 && max >= min && max - min < caps.maxColumns) {
              for (let column = min; column <= max; column += 1) hiddenColumns.add(column)
            }
          }
          break
        }
        default:
          break
      }
      continue
    }
    // end token
    switch (token.localName) {
      case 'v':
        leaf = undefined
        break
      case 'f':
        leaf = undefined
        break
      case 't':
        leaf = undefined
        break
      case 'is':
        inInline = false
        break
      case 'c':
        if (currentCell !== undefined) {
          storeCell(currentCell)
          currentCell = undefined
        }
        break
      default:
        break
    }
  }

  return { cells, declaredRows, hiddenRows, hiddenColumns, merges }
}

function sharedStringAt(index: string, sharedStrings: readonly string[]): string {
  const parsed = Number.parseInt(index, 10)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed >= sharedStrings.length) {
    throw new StructuredParseError('MALFORMED_XLSX', `shared string index ${index} is out of range`)
  }
  return sharedStrings[parsed] ?? ''
}

function cellToStructured(
  cell: RawCell | undefined,
  locator: TableCellSourceLocator,
  sharedStrings: readonly string[],
  caps: StructuredParseCaps,
): StructuredCell {
  if (cell === undefined || (cell.type === 'empty' && cell.formula === undefined && cell.rawV === '')) {
    return emptyCell(locator)
  }
  if (cell.formula !== undefined) {
    const cached =
      cell.type === 's'
        ? sharedStringAt(cell.rawV, sharedStrings)
        : cell.type === 'inline'
          ? cell.inlineText
          : cell.rawV
    return formulaCell(cell.formula, cached.length === 0 ? undefined : cached, locator)
  }
  switch (cell.type) {
    case 's': {
      const text = sharedStringAt(cell.rawV, sharedStrings)
      enforceCellBytes(new TextEncoder().encode(text).byteLength, caps)
      return textCell(text, locator)
    }
    case 'inline':
      enforceCellBytes(new TextEncoder().encode(cell.inlineText).byteLength, caps)
      return textCell(cell.inlineText, locator)
    case 'str':
      enforceCellBytes(new TextEncoder().encode(cell.rawV).byteLength, caps)
      return textCell(cell.rawV, locator)
    case 'b':
      return booleanCell(cell.rawV === '1' || cell.rawV === 'true' || cell.rawV === 'TRUE', cell.rawV, locator)
    case 'e':
      return errorCell(cell.rawV, locator)
    case 'd':
      return dateCell(cell.rawV, locator)
    case 'n':
    case 'empty': {
      if (cell.rawV.length === 0) return emptyCell(locator)
      enforceCellBytes(new TextEncoder().encode(cell.rawV).byteLength, caps)
      return numberCell(cell.rawV, locator)
    }
  }
}

function headerText(cell: RawCell | undefined, sharedStrings: readonly string[]): string {
  if (cell === undefined) return ''
  if (cell.formula !== undefined) {
    if (cell.type === 's') return sharedStringAt(cell.rawV, sharedStrings)
    if (cell.type === 'inline') return cell.inlineText
    return cell.rawV
  }
  if (cell.type === 's') return sharedStringAt(cell.rawV, sharedStrings)
  if (cell.type === 'inline') return cell.inlineText
  return cell.rawV
}

function mergeRows(ref: string): { minRow: number; maxRow: number } | undefined {
  const parts = ref.split(':')
  const start = splitAddress(parts[0] ?? '')
  const end = splitAddress(parts[parts.length - 1] ?? '')
  if (start === undefined || end === undefined) return undefined
  return { minRow: Math.min(start.row, end.row), maxRow: Math.max(start.row, end.row) }
}

function selectSheet(meta: WorkbookMeta, options: StructuredParseOptions): SheetDefinition {
  if (options.sheetName !== undefined) {
    const byName = meta.sheets.find((sheet) => sheet.name === options.sheetName)
    if (byName === undefined) {
      throw new StructuredParseError('MISSING_SHEET', `no sheet named ${options.sheetName} exists`)
    }
    return byName
  }
  if (options.sheetId !== undefined) {
    const byId = meta.sheets.find((sheet) => sheet.sheetId === options.sheetId)
    if (byId === undefined) {
      throw new StructuredParseError('MISSING_SHEET', `no sheet with id ${options.sheetId} exists`)
    }
    return byId
  }
  const first = meta.sheets[0]
  if (first === undefined) throw new StructuredParseError('MALFORMED_XLSX', 'the workbook declares no sheets')
  return first
}

export function parseXlsx(
  bytes: Uint8Array,
  options: StructuredParseOptions,
  caps: StructuredParseCaps,
): FormatParseResult {
  const archive = openZip(bytes, caps)
  if (archive.has('xl/vbaProject.bin')) {
    throw new StructuredParseError('MACRO_ENABLED_WORKBOOK', 'the workbook contains a VBA project')
  }
  const meta = parseWorkbook(archive)
  const sheet = selectSheet(meta, options)
  const worksheet = parseWorksheet(archive, sheet.target, caps)

  const headerRow = options.headerRow ?? 1
  const dataStartRow = options.dataStartRow ?? headerRow + 1
  if (dataStartRow <= headerRow) {
    throw new StructuredParseError('UNSUPPORTED_TABLE_LAYOUT', 'dataStartRow must be after headerRow', {
      row: headerRow,
      sheetName: sheet.name,
    })
  }

  if (worksheet.merges.length > 0) {
    const inHeader = worksheet.merges.some((ref) => {
      const range = mergeRows(ref)
      return range === undefined || range.minRow <= headerRow
    })
    if (inHeader) {
      throw new StructuredParseError(
        'UNSUPPORTED_MULTI_LEVEL_HEADER',
        `sheet ${sheet.name} merges cells in the header; select an explicit range instead of guessing columns`,
        { sheetName: sheet.name, row: headerRow },
      )
    }
    throw new StructuredParseError(
      'MERGED_CELLS',
      `sheet ${sheet.name} contains merged cells that cannot be located as one value`,
      { sheetName: sheet.name },
    )
  }

  const headerCells = worksheet.cells.get(headerRow)
  if (headerCells === undefined || headerCells.size === 0) {
    throw new StructuredParseError('UNSUPPORTED_TABLE_LAYOUT', `sheet ${sheet.name} has no header row ${headerRow}`, {
      sheetName: sheet.name,
      row: headerRow,
    })
  }
  const headerColumns = [...headerCells.keys()].sort((left, right) => left - right)
  const minColumn = headerColumns[0] ?? 1
  const maxHeaderColumn = headerColumns[headerColumns.length - 1] ?? 0
  if (maxHeaderColumn - minColumn + 1 !== headerColumns.length) {
    throw new StructuredParseError(
      'UNSUPPORTED_MULTI_LEVEL_HEADER',
      `sheet ${sheet.name} has blank header cells; select an explicit range instead of guessing columns`,
      { sheetName: sheet.name, row: headerRow },
    )
  }
  if (headerColumns.length > caps.maxColumns) {
    throw new StructuredParseError(
      'TOO_MANY_COLUMNS',
      `sheet ${sheet.name} has ${headerColumns.length} columns, above the ${caps.maxColumns}-column cap`,
      { sheetName: sheet.name },
    )
  }

  const normalizationMapRef = identityNormalizationMapRef(bytes)
  const headerNames = headerColumns.map((column) => headerText(headerCells.get(column), meta.sharedStrings))
  if (headerNames.some((name) => name.trim().length === 0)) {
    throw new StructuredParseError(
      'UNSUPPORTED_MULTI_LEVEL_HEADER',
      `sheet ${sheet.name} has a blank header cell; select an explicit range instead of guessing columns`,
      { sheetName: sheet.name, row: headerRow },
    )
  }
  const columns: StructuredColumn[] = headerColumns.map((column, index) => {
    const header = headerNames[index] ?? ''
    return {
      column,
      index,
      header,
      headerDigest: sha256DigestOfText(header) as Sha256Digest,
      address: `${columnLabel(column)}${headerRow}`,
      hidden: worksheet.hiddenColumns.has(column),
    }
  })

  const allRowNumbers = [...worksheet.cells.keys()].filter((row) => row >= dataStartRow).sort((a, b) => a - b)
  const diagnostics: StructuredParseIssue[] = []
  let status: 'complete' | 'incomplete' = 'complete'
  let skippedUnits = 0
  const skippedReasons: string[] = []
  let effectiveRows = allRowNumbers
  if (allRowNumbers.length > caps.maxRows) {
    if ((options.capBreachMode ?? 'reject') === 'truncate') {
      effectiveRows = allRowNumbers.slice(0, caps.maxRows)
      status = 'incomplete'
      skippedUnits = allRowNumbers.length - effectiveRows.length
      skippedReasons.push(`TOO_MANY_ROWS: ${allRowNumbers.length} > ${caps.maxRows}`)
      diagnostics.push({
        code: 'TOO_MANY_ROWS',
        severity: 'warning',
        message: `parsed the first ${caps.maxRows} of ${allRowNumbers.length} data rows in ${sheet.name}; result is explicitly incomplete`,
        sheetName: sheet.name,
      })
    } else {
      throw new StructuredParseError(
        'TOO_MANY_ROWS',
        `sheet ${sheet.name} has ${allRowNumbers.length} data rows, above the ${caps.maxRows}-row cap`,
        { sheetName: sheet.name },
      )
    }
  }

  const rows: StructuredRow[] = effectiveRows.map((rowNumber, offset) => {
    const rowCells = worksheet.cells.get(rowNumber) ?? new Map<number, RawCell>()
    for (const column of rowCells.keys()) {
      if (column < minColumn || column > maxHeaderColumn) {
        throw new StructuredParseError(
          'UNSUPPORTED_TABLE_LAYOUT',
          `row ${rowNumber} has a value outside the header columns; select an explicit range`,
          { sheetName: sheet.name, row: rowNumber },
        )
      }
    }
    const recordIndex = offset + 1
    const cells: StructuredCell[] = columns.map((column) => {
      const cell = rowCells.get(column.column)
      const address = `${columnLabel(column.column)}${rowNumber}`
      const locator: TableCellSourceLocator = {
        kind: 'table_cell',
        format: 'xlsx',
        sheetId: sheet.sheetId,
        sheetName: sheet.name,
        recordIndex,
        row: rowNumber,
        column: column.column,
        address,
        normalizationMapRef,
      }
      return cellToStructured(cell, locator, meta.sharedStrings, caps)
    })
    const rowLocator: TableRowSourceLocator = {
      kind: 'table_row',
      format: 'xlsx',
      sheetId: sheet.sheetId,
      sheetName: sheet.name,
      recordIndex,
      row: rowNumber,
      columnFrom: minColumn,
      columnTo: maxHeaderColumn,
      normalizationMapRef,
    }
    return {
      recordIndex,
      row: rowNumber,
      hidden: worksheet.hiddenRows.has(rowNumber),
      cells,
      locator: rowLocator,
    }
  })

  const table: StructuredTable = {
    format: 'xlsx',
    sheetId: sheet.sheetId,
    sheetName: sheet.name,
    headerRow,
    columnCount: columns.length,
    dataRowCount: rows.length,
    columns,
    rows,
    hiddenRows: [...worksheet.hiddenRows].filter((row) => row >= dataStartRow).sort((a, b) => a - b),
    hiddenColumns: [...worksheet.hiddenColumns].filter((column) => column >= minColumn && column <= maxHeaderColumn).sort((a, b) => a - b),
    emptyRows: [...worksheet.declaredRows]
      .filter((row) => row >= dataStartRow && !worksheet.cells.has(row))
      .sort((a, b) => a - b),
    merges: [],
  }

  const sheets: StructuredSheetInfo[] = meta.sheets.map((definition) => ({
    sheetId: definition.sheetId,
    name: definition.name,
    hidden: definition.hidden,
    target: definition.target,
  }))

  return {
    tables: [table],
    records: [],
    sheets,
    diagnostics,
    status,
    totalUnits: allRowNumbers.length,
    parsedUnits: rows.length,
    skippedUnits,
    skippedReasons,
    notes: [],
  }
}

