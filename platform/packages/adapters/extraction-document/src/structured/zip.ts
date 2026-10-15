import { inflateRawSync } from 'node:zlib'
import type { StructuredParseCaps } from '@ontology/contracts'
import { decodeUtf8Strict } from './bytes'
import { StructuredParseError } from './errors'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_EOCD_SCAN = 22 + 0xffff

interface ZipEntry {
  readonly name: string
  readonly flags: number
  readonly method: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  )
}

function findEocd(bytes: Uint8Array): number {
  const start = Math.max(0, bytes.length - MAX_EOCD_SCAN)
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (readU32(bytes, i) === EOCD_SIGNATURE) return i
  }
  return -1
}

function readEntries(bytes: Uint8Array, caps: StructuredParseCaps): ZipEntry[] {
  const eocd = findEocd(bytes)
  if (eocd < 0) {
    throw new StructuredParseError('MALFORMED_XLSX', 'the workbook is not a ZIP archive')
  }
  const total = readU16(bytes, eocd + 10)
  const cdOffset = readU32(bytes, eocd + 16)
  if (cdOffset === 0xffffffff || total === 0xffff) {
    throw new StructuredParseError('UNSUPPORTED_ZIP', 'ZIP64 workbooks are not supported')
  }
  if (cdOffset >= bytes.length) {
    throw new StructuredParseError('MALFORMED_XLSX', 'the ZIP central directory is out of range')
  }

  const entries: ZipEntry[] = []
  let inflatedTotal = 0
  let cursor = cdOffset
  for (let index = 0; index < total; index += 1) {
    if (readU32(bytes, cursor) !== CENTRAL_SIGNATURE) {
      throw new StructuredParseError('MALFORMED_XLSX', 'a ZIP central directory entry is malformed')
    }
    const flags = readU16(bytes, cursor + 8)
    const method = readU16(bytes, cursor + 10)
    const compressedSize = readU32(bytes, cursor + 20)
    const uncompressedSize = readU32(bytes, cursor + 24)
    const nameLength = readU16(bytes, cursor + 28)
    const extraLength = readU16(bytes, cursor + 30)
    const commentLength = readU16(bytes, cursor + 32)
    const localOffset = readU32(bytes, cursor + 42)
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)

    let name: string
    try {
      name = decodeUtf8Strict(nameBytes)
    } catch (error) {
      throw new StructuredParseError('MALFORMED_XLSX', 'a ZIP entry name is not valid UTF-8', {
        cause: error,
      })
    }

    if ((flags & 0x1) !== 0) {
      throw new StructuredParseError('ENCRYPTED_WORKBOOK', `the workbook entry ${name} is encrypted`)
    }

    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset })
    if (entries.length > caps.maxZipEntries) {
      throw new StructuredParseError(
        'TOO_MANY_ZIP_ENTRIES',
        `the workbook has more than ${caps.maxZipEntries} ZIP entries`,
      )
    }
    inflatedTotal += uncompressedSize
    if (inflatedTotal > caps.maxExpandedBytes) {
      throw new StructuredParseError(
        'EXPANSION_TOO_LARGE',
        `the workbook expands to more than ${caps.maxExpandedBytes} bytes`,
      )
    }

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function inflateEntry(bytes: Uint8Array, entry: ZipEntry, caps: StructuredParseCaps): Uint8Array {
  if (entry.localOffset + 30 > bytes.length) {
    throw new StructuredParseError('MALFORMED_XLSX', `the local header for ${entry.name} is out of range`)
  }
  if (readU32(bytes, entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new StructuredParseError('MALFORMED_XLSX', `the local header for ${entry.name} is malformed`)
  }
  const nameLength = readU16(bytes, entry.localOffset + 26)
  const extraLength = readU16(bytes, entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > bytes.length) {
    throw new StructuredParseError('MALFORMED_XLSX', `the data for ${entry.name} is out of range`)
  }
  const raw = bytes.subarray(dataStart, dataEnd)
  if (entry.method === 0) {
    if (raw.length !== entry.uncompressedSize) {
      throw new StructuredParseError('MALFORMED_XLSX', `the stored entry ${entry.name} has an inconsistent size`)
    }
    return raw
  }
  if (entry.method !== 8) {
    throw new StructuredParseError('UNSUPPORTED_ZIP', `the entry ${entry.name} uses compression method ${entry.method}`)
  }
  const limit = Math.min(caps.maxExpandedBytes + 1, entry.uncompressedSize + 1)
  let inflated: Buffer
  try {
    inflated = inflateRawSync(raw, { maxOutputLength: limit })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('larger') || message.includes('maxOutputLength') || message.includes('too big')) {
      throw new StructuredParseError('EXPANSION_TOO_LARGE', `the entry ${entry.name} expands beyond its declared size`, {
        cause: error,
      })
    }
    throw new StructuredParseError('MALFORMED_XLSX', `the entry ${entry.name} could not be decompressed`, {
      cause: error,
    })
  }
  if (inflated.length !== entry.uncompressedSize) {
    throw new StructuredParseError('MALFORMED_XLSX', `the entry ${entry.name} decompressed to an unexpected size`)
  }
  return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength)
}

export interface ZipArchive {
  has(name: string): boolean
  read(name: string): Uint8Array | undefined
}

/** A bounded, read-only ZIP archive. Only the entries a parser asks for are inflated. */
export function openZip(bytes: Uint8Array, caps: StructuredParseCaps): ZipArchive {
  const entries = new Map<string, ZipEntry>()
  for (const entry of readEntries(bytes, caps)) {
    entries.set(entry.name, entry)
  }
  return {
    has: (name) => entries.has(name),
    read: (name) => {
      const entry = entries.get(name)
      return entry === undefined ? undefined : inflateEntry(bytes, entry, caps)
    },
  }
}

export function readZipText(archive: ZipArchive, name: string): string | undefined {
  const data = archive.read(name)
  if (data === undefined) return undefined
  try {
    return decodeUtf8Strict(data)
  } catch (error) {
    throw new StructuredParseError('MALFORMED_XLSX', `the part ${name} is not valid UTF-8`, { cause: error })
  }
}

