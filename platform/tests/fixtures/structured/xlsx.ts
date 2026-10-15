import { deflateRawSync } from 'node:zlib'

/**
 * A tiny ZIP writer and XLSX assembler for parser unit tests. It produces real
 * OOXML fixtures in memory (no external spreadsheet library and no dependency on
 * an Excel install), so the XLSX tests exercise the committed archive reader.
 */

export interface ZipEntryInput {
  readonly name: string
  readonly data: string | Uint8Array
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function bytesOf(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data
}

class ByteWriter {
  readonly #bytes: number[] = []

  u16(value: number): void {
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff)
  }

  u32(value: number): void {
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
  }

  raw(bytes: Uint8Array): void {
    for (const byte of bytes) this.#bytes.push(byte)
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes)
  }

  get length(): number {
    return this.#bytes.length
  }
}

export interface BuildZipOptions {
  readonly deflate?: boolean
  readonly encrypted?: readonly string[]
}

export function buildZip(entries: readonly ZipEntryInput[], options: BuildZipOptions = {}): Uint8Array {
  const encrypted = new Set(options.encrypted ?? [])
  const writer = new ByteWriter()
  const central: { name: Uint8Array; method: number; crc: number; comp: number; uncomp: number; offset: number; encrypted: boolean }[] = []

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name)
    const uncompressed = bytesOf(entry.data)
    const method = options.deflate === true ? 8 : 0
    const compressed = method === 8 ? new Uint8Array(deflateRawSync(uncompressed)) : uncompressed
    const crc = crc32(uncompressed)
    const isEncrypted = encrypted.has(entry.name)
    const offset = writer.length

    writer.u32(0x04034b50)
    writer.u16(20)
    writer.u16(isEncrypted ? 0x1 : 0)
    writer.u16(method)
    writer.u16(0)
    writer.u16(0)
    writer.u32(crc)
    writer.u32(compressed.length)
    writer.u32(uncompressed.length)
    writer.u16(nameBytes.length)
    writer.u16(0)
    writer.raw(nameBytes)
    writer.raw(compressed)

    central.push({
      name: nameBytes,
      method,
      crc,
      comp: compressed.length,
      uncomp: uncompressed.length,
      offset,
      encrypted: isEncrypted,
    })
  }

  const centralOffset = writer.length
  for (const entry of central) {
    writer.u32(0x02014b50)
    writer.u16(20)
    writer.u16(20)
    writer.u16(entry.encrypted ? 0x1 : 0)
    writer.u16(entry.method)
    writer.u16(0)
    writer.u16(0)
    writer.u32(entry.crc)
    writer.u32(entry.comp)
    writer.u32(entry.uncomp)
    writer.u16(entry.name.length)
    writer.u16(0)
    writer.u16(0)
    writer.u16(0)
    writer.u16(0)
    writer.u32(0)
    writer.u32(entry.offset)
    writer.raw(entry.name)
  }
  const centralSize = writer.length - centralOffset

  writer.u32(0x06054b50)
  writer.u16(0)
  writer.u16(0)
  writer.u16(central.length)
  writer.u16(central.length)
  writer.u32(centralSize)
  writer.u32(centralOffset)
  writer.u16(0)

  return writer.toBytes()
}

export function cellRef(column: number, row: number): string {
  let label = ''
  let remaining = column
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    remaining = Math.floor((remaining - 1) / 26)
  }
  return `${label}${row}`
}

export interface XlsxOptions {
  readonly sheetXml: string
  readonly sheetName?: string
  readonly sheetId?: string
  readonly sheetTarget?: string
  readonly sharedStrings?: readonly string[]
  readonly deflate?: boolean
  readonly vba?: boolean
  readonly encryptedEntries?: readonly string[]
  readonly extraEntries?: readonly ZipEntryInput[]
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export function buildXlsx(options: XlsxOptions): Uint8Array {
  const sheetName = options.sheetName ?? 'Sheet1'
  const sheetId = options.sheetId ?? '1'
  const sheetTarget = options.sheetTarget ?? 'worksheets/sheet1.xml'
  const workbookXml =
    XML_DECLARATION +
    `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>` +
    `<sheet name="${sheetName}" sheetId="${sheetId}" r:id="rId1"/>` +
    `</sheets></workbook>`
  const relsXml =
    XML_DECLARATION +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="${sheetTarget}"/>` +
    `</Relationships>`

  const sharedStringsXml =
    options.sharedStrings === undefined
      ? undefined
      : XML_DECLARATION +
        `<sst xmlns="${MAIN_NS}" count="${options.sharedStrings.length}" uniqueCount="${options.sharedStrings.length}">` +
        options.sharedStrings.map((value) => `<si><t>${value}</t></si>`).join('') +
        `</sst>`

  const entries: ZipEntryInput[] = [{ name: 'xl/workbook.xml', data: workbookXml }]
  entries.push({ name: 'xl/_rels/workbook.xml.rels', data: relsXml })
  if (sharedStringsXml !== undefined) {
    entries.push({ name: 'xl/sharedStrings.xml', data: sharedStringsXml })
  }
  entries.push({ name: `xl/${sheetTarget}`, data: XML_DECLARATION + options.sheetXml })
  if (options.vba === true) {
    entries.push({ name: 'xl/vbaProject.bin', data: new Uint8Array([1, 2, 3, 4]) })
  }
  if (options.extraEntries !== undefined) entries.push(...options.extraEntries)

  return buildZip(entries, {
    ...(options.deflate === undefined ? {} : { deflate: options.deflate }),
    ...(options.encryptedEntries === undefined ? {} : { encrypted: options.encryptedEntries }),
  })
}

export function sharedStringCell(reference: string, index: number): string {
  return `<c r="${reference}" t="s"><v>${index}</v></c>`
}

export function numberCellXml(reference: string, raw: string): string {
  return `<c r="${reference}"><v>${raw}</v></c>`
}

export function rowXml(row: number, cells: readonly string[], hidden = false): string {
  const hiddenAttr = hidden ? ' hidden="1"' : ''
  return `<row r="${row}"${hiddenAttr}>${cells.join('')}</row>`
}

export function worksheetOf(rows: readonly string[], merges: readonly string[] = []): string {
  const mergeXml =
    merges.length === 0
      ? ''
      : `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
  return `<worksheet xmlns="${MAIN_NS}"><sheetData>${rows.join('')}</sheetData>${mergeXml}</worksheet>`
}
