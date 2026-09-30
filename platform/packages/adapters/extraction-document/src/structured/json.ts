import type {
  JsonPointerSourceLocator,
  StructuredCell,
  StructuredParseCaps,
  StructuredParseIssue,
  StructuredParseOptions,
  StructuredRecord,
} from '@ontology/contracts'
import { decodeUtf8Strict, identityNormalizationMapRef } from './bytes'
import { booleanCell, emptyCell, numberCell, textCell } from './cells'
import { enforceCellBytes } from './caps'
import { StructuredParseError } from './errors'
import type { FormatParseResult } from './internal'

type JsonNode =
  | { readonly kind: 'object'; readonly startByte: number; readonly endByte: number; readonly members: readonly JsonMember[] }
  | { readonly kind: 'array'; readonly startByte: number; readonly endByte: number; readonly items: readonly JsonNode[] }
  | { readonly kind: 'string'; readonly startByte: number; readonly endByte: number; readonly value: string }
  | { readonly kind: 'number'; readonly startByte: number; readonly endByte: number; readonly raw: string }
  | { readonly kind: 'boolean'; readonly startByte: number; readonly endByte: number; readonly value: boolean }
  | { readonly kind: 'null'; readonly startByte: number; readonly endByte: number }

interface JsonMember {
  readonly key: string
  readonly pointer: string
  readonly value: JsonNode
}

const STRING_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

const NUMBER_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1')
}

class JsonReader {
  readonly #bytes: Uint8Array
  readonly #caps: StructuredParseCaps
  #pos = 0

  constructor(bytes: Uint8Array, caps: StructuredParseCaps) {
    this.#bytes = bytes
    this.#caps = caps
    this.#skipWhitespace()
  }

  #fail(message: string, pointer: string): never {
    throw new StructuredParseError('INVALID_JSON', message, { pointer })
  }

  #skipWhitespace(): void {
    while (this.#pos < this.#bytes.length) {
      const byte = this.#bytes[this.#pos]
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
        this.#pos += 1
      } else {
        return
      }
    }
  }

  #expectEof(pointer: string): void {
    this.#skipWhitespace()
    if (this.#pos !== this.#bytes.length) this.#fail('trailing content after the JSON value', pointer)
  }

  parseRoot(): JsonNode {
    const node = this.parseValue('', 0)
    this.#expectEof('')
    return node
  }

  parseValue(pointer: string, depth: number): JsonNode {
    if (depth > this.#caps.maxDepth) {
      throw new StructuredParseError(
        'NESTING_TOO_DEEP',
        `JSON nesting exceeds the ${this.#caps.maxDepth}-level cap`,
        { pointer },
      )
    }
    const startByte = this.#pos
    const byte = this.#bytes[this.#pos]
    if (byte === undefined) this.#fail('unexpected end of JSON input', pointer)
    if (byte === 0x7b) return this.#parseObject(pointer, depth, startByte)
    if (byte === 0x5b) return this.#parseArray(pointer, depth, startByte)
    if (byte === 0x22) {
      const value = this.#parseString(pointer)
      return { kind: 'string', startByte, endByte: this.#pos, value }
    }
    if (byte === 0x74) return this.#parseLiteral('true', pointer, startByte)
    if (byte === 0x66) return this.#parseLiteral('false', pointer, startByte)
    if (byte === 0x6e) return this.#parseNull(pointer, startByte)
    return this.#parseNumber(pointer, startByte)
  }

  #parseObject(pointer: string, depth: number, startByte: number): JsonNode {
    this.#pos += 1
    const members: JsonMember[] = []
    const seen = new Set<string>()
    this.#skipWhitespace()
    if (this.#bytes[this.#pos] === 0x7d) {
      this.#pos += 1
      return { kind: 'object', startByte, endByte: this.#pos, members }
    }
    for (;;) {
      this.#skipWhitespace()
      if (this.#bytes[this.#pos] !== 0x22) this.#fail('an object key must be a string', pointer)
      const key = this.#parseString(pointer)
      if (seen.has(key)) {
        throw new StructuredParseError(
          'DUPLICATE_JSON_KEY',
          `duplicate object key ${JSON.stringify(key)} cannot be located unambiguously`,
          { pointer: `${pointer}/${escapePointerToken(key)}` },
        )
      }
      seen.add(key)
      this.#skipWhitespace()
      if (this.#bytes[this.#pos] !== 0x3a) this.#fail('an object key must be followed by a colon', pointer)
      this.#pos += 1
      this.#skipWhitespace()
      const childPointer = `${pointer}/${escapePointerToken(key)}`
      const value = this.parseValue(childPointer, depth + 1)
      members.push({ key, pointer: childPointer, value })
      this.#skipWhitespace()
      const delimiter = this.#bytes[this.#pos]
      if (delimiter === 0x2c) {
        this.#pos += 1
        continue
      }
      if (delimiter === 0x7d) {
        this.#pos += 1
        return { kind: 'object', startByte, endByte: this.#pos, members }
      }
      this.#fail('expected a comma or closing brace in the object', pointer)
    }
  }

  #parseArray(pointer: string, depth: number, startByte: number): JsonNode {
    this.#pos += 1
    const items: JsonNode[] = []
    this.#skipWhitespace()
    if (this.#bytes[this.#pos] === 0x5d) {
      this.#pos += 1
      return { kind: 'array', startByte, endByte: this.#pos, items }
    }
    for (;;) {
      this.#skipWhitespace()
      items.push(this.parseValue(`${pointer}/${items.length}`, depth + 1))
      this.#skipWhitespace()
      const delimiter = this.#bytes[this.#pos]
      if (delimiter === 0x2c) {
        this.#pos += 1
        continue
      }
      if (delimiter === 0x5d) {
        this.#pos += 1
        return { kind: 'array', startByte, endByte: this.#pos, items }
      }
      this.#fail('expected a comma or closing bracket in the array', pointer)
    }
  }

  #parseString(pointer: string): string {
    this.#pos += 1
    let value = ''
    let runStart = this.#pos
    while (this.#pos < this.#bytes.length) {
      const byte = this.#bytes[this.#pos]
      if (byte === 0x22) {
        value += this.#decodeRun(runStart, this.#pos, pointer)
        this.#pos += 1
        return value
      }
      if (byte === 0x5c) {
        value += this.#decodeRun(runStart, this.#pos, pointer)
        this.#pos += 1
        value += this.#parseEscape(pointer)
        runStart = this.#pos
        continue
      }
      this.#pos += 1
    }
    this.#fail('unterminated JSON string', pointer)
  }

  #decodeRun(start: number, end: number, pointer: string): string {
    if (end <= start) return ''
    try {
      return decodeUtf8Strict(this.#bytes.subarray(start, end))
    } catch (error) {
      throw new StructuredParseError('INVALID_UTF8', 'a JSON string contains invalid UTF-8', {
        pointer,
        cause: error,
      })
    }
  }

  #parseEscape(pointer: string): string {
    const byte = this.#bytes[this.#pos]
    if (byte === undefined) this.#fail('unterminated escape in a JSON string', pointer)
    const char = String.fromCharCode(byte)
    const simple = STRING_ESCAPES[char]
    if (simple !== undefined) {
      this.#pos += 1
      return simple
    }
    if (char !== 'u') this.#fail(`invalid escape \\${char} in a JSON string`, pointer)
    this.#pos += 1
    let code = this.#readHex4(pointer)
    if (code >= 0xd800 && code <= 0xdbff && this.#bytes[this.#pos] === 0x5c && this.#bytes[this.#pos + 1] === 0x75) {
      const saved = this.#pos
      this.#pos += 2
      const low = this.#readHex4(pointer)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
      } else {
        this.#pos = saved
      }
    }
    return String.fromCodePoint(code)
  }

  #readHex4(pointer: string): number {
    const slice = this.#bytes.subarray(this.#pos, this.#pos + 4)
    if (slice.length !== 4) this.#fail('a \\u escape requires four hex digits', pointer)
    const hex = String.fromCharCode(...slice)
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.#fail('a \\u escape requires four hex digits', pointer)
    this.#pos += 4
    return Number.parseInt(hex, 16)
  }

  #parseLiteral(literal: 'true' | 'false', pointer: string, startByte: number): JsonNode {
    for (let index = 0; index < literal.length; index += 1) {
      if (this.#bytes[this.#pos + index] !== literal.charCodeAt(index)) {
        this.#fail(`expected ${literal}`, pointer)
      }
    }
    this.#pos += literal.length
    return { kind: 'boolean', startByte, endByte: this.#pos, value: literal === 'true' }
  }

  #parseNull(pointer: string, startByte: number): JsonNode {
    if (this.#bytes[this.#pos] !== 0x6e) this.#fail('expected null', pointer)
    for (let index = 0; index < 4; index += 1) {
      if (this.#bytes[this.#pos + index] !== 'null'.charCodeAt(index)) this.#fail('expected null', pointer)
    }
    this.#pos += 4
    return { kind: 'null', startByte, endByte: this.#pos }
  }

  #parseNumber(pointer: string, startByte: number): JsonNode {
    const start = this.#pos
    while (this.#pos < this.#bytes.length) {
      const byte = this.#bytes[this.#pos]
      if (byte === undefined) break
      const isNumberByte =
        (byte >= 0x30 && byte <= 0x39) ||
        byte === 0x2d ||
        byte === 0x2b ||
        byte === 0x2e ||
        byte === 0x65 ||
        byte === 0x45
      if (!isNumberByte) break
      this.#pos += 1
    }
    const raw = String.fromCharCode(...this.#bytes.subarray(start, this.#pos))
    if (raw.length === 0 || !NUMBER_TOKEN.test(raw)) this.#fail(`invalid JSON token "${raw}"`, pointer)
    return { kind: 'number', startByte, endByte: this.#pos, raw }
  }
}

function pointerLocator(
  pointer: string,
  startByte: number,
  endByte: number,
  normalizationMapRef: string,
): JsonPointerSourceLocator {
  return { kind: 'json_pointer', pointer, startByte, endByte, normalizationMapRef }
}

function flattenNode(
  node: JsonNode,
  pointer: string,
  locator: JsonPointerSourceLocator,
  out: StructuredCell[],
  caps: StructuredParseCaps,
): void {
  switch (node.kind) {
    case 'null':
      out.push(emptyCell(locator))
      return
    case 'string':
      enforceCellBytes(new TextEncoder().encode(node.value).byteLength, caps)
      out.push(textCell(node.value, locator))
      return
    case 'number': {
      enforceCellBytes(node.raw.length, caps)
      out.push(numberCell(node.raw, locator))
      return
    }
    case 'boolean':
      out.push(booleanCell(node.value, node.value ? 'true' : 'false', locator))
      return
    case 'array':
      if (node.items.length === 0) {
        out.push(textCell('[]', locator))
        return
      }
      node.items.forEach((item, index) => {
        flattenNode(
          item,
          `${pointer}/${index}`,
          pointerLocator(`${pointer}/${index}`, item.startByte, item.endByte, locator.normalizationMapRef),
          out,
          caps,
        )
      })
      return
    case 'object':
      if (node.members.length === 0) {
        out.push(textCell('{}', locator))
        return
      }
      for (const member of node.members) {
        flattenNode(
          member.value,
          member.pointer,
          pointerLocator(member.pointer, member.value.startByte, member.value.endByte, locator.normalizationMapRef),
          out,
          caps,
        )
      }
      return
  }
}

function recordNodeOf(root: JsonNode): { nodes: readonly JsonNode[]; refs: readonly string[] } {
  if (root.kind === 'array') {
    return {
      nodes: root.items,
      refs: root.items.map((_item, index) => `/${index}`),
    }
  }
  if (root.kind === 'object') {
    const recordsMember = root.members.find((member) => member.key === 'records')
    if (recordsMember !== undefined && recordsMember.value.kind === 'array') {
      return {
        nodes: recordsMember.value.items,
        refs: recordsMember.value.items.map((_item, index) => `${recordsMember.pointer}/${index}`),
      }
    }
    return { nodes: [root], refs: [''] }
  }
  throw new StructuredParseError(
    'UNSUPPORTED_TABLE_LAYOUT',
    'a JSON document must be an object, an array of records or an object with a records array',
  )
}

export function parseJson(
  bytes: Uint8Array,
  options: StructuredParseOptions,
  caps: StructuredParseCaps,
): FormatParseResult {
  const normalizationMapRef = identityNormalizationMapRef(bytes)
  const reader = new JsonReader(bytes, caps)
  const root = reader.parseRoot()

  const selection = recordNodeOf(root)
  const diagnostics: StructuredParseIssue[] = []
  let status: 'complete' | 'incomplete' = 'complete'
  let skippedUnits = 0
  const skippedReasons: string[] = []
  const nodes = selection.nodes
  let effectiveNodes = nodes
  if (nodes.length > caps.maxRows) {
    if ((options.capBreachMode ?? 'reject') === 'truncate') {
      effectiveNodes = nodes.slice(0, caps.maxRows)
      status = 'incomplete'
      skippedUnits = nodes.length - effectiveNodes.length
      skippedReasons.push(`TOO_MANY_ROWS: ${nodes.length} > ${caps.maxRows}`)
      diagnostics.push({
        code: 'TOO_MANY_ROWS',
        severity: 'warning',
        message: `parsed the first ${caps.maxRows} of ${nodes.length} records; result is explicitly incomplete`,
      })
    } else {
      throw new StructuredParseError(
        'TOO_MANY_ROWS',
        `the document has ${nodes.length} records, above the ${caps.maxRows}-row cap`,
      )
    }
  }

  const records: StructuredRecord[] = effectiveNodes.map((node, offset) => {
    const recordRef = selection.refs[offset] ?? `/${offset}`
    const locator = pointerLocator(recordRef, node.startByte, node.endByte, normalizationMapRef)
    const cells: StructuredCell[] = []
    flattenNode(node, recordRef, locator, cells, caps)
    if (cells.length > caps.maxColumns) {
      throw new StructuredParseError(
        'TOO_MANY_COLUMNS',
        `record ${recordRef} has ${cells.length} leaf fields, above the ${caps.maxColumns}-column cap`,
        { pointer: recordRef },
      )
    }
    return { recordIndex: offset + 1, recordRef, locator, cells }
  })

  return {
    tables: [],
    records,
    sheets: [],
    diagnostics,
    status,
    totalUnits: nodes.length,
    parsedUnits: records.length,
    skippedUnits,
    skippedReasons,
    notes: [],
  }
}

export type { JsonNode }
