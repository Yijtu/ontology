import { describe, expect, it } from 'vitest'
import { StructuredDocumentParser } from '@ontology/adapter-extraction-document'
import type { StructuredParseResult } from '@ontology/contracts'

const parser = new StructuredDocumentParser()

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

describe('UTF-8 text parsing', () => {
  it('locates every line by exact byte offset', () => {
    const source = 'first\nsecond\n'
    const result = parser.parse(utf8(source), { mediaType: 'text/plain' })
    expect(result.format).toBe('text')
    expect(result.status).toBe('complete')
    expect(result.records.map((record) => record.recordRef)).toEqual(['line:1', 'line:2'])

    const second = result.records[1]
    expect(second?.cells[0]?.raw).toBe('second')
    const locator = second?.cells[0]?.locator
    expect(locator?.kind).toBe('offset')
    if (locator?.kind !== 'offset') return
    expect(new TextDecoder().decode(utf8(source).subarray(locator.startOffset, locator.endOffset))).toBe('second')
  })

  it('does not invent a trailing empty line for a file that ends in a newline', () => {
    const result = parser.parse(utf8('a\nb\n'), { mediaType: 'text/plain' })
    expect(result.records.map((record) => record.recordRef)).toEqual(['line:1', 'line:2'])
    expect(result.records[1]?.cells[0]?.raw).toBe('b')
  })

  it('refuses invalid UTF-8', () => {
    const result = parser.parse(new Uint8Array([0x61, 0xff, 0x0a]), { mediaType: 'text/plain' })
    expect(result.status).toBe('rejected')
    expect(result.diagnostics[0]?.code).toBe('INVALID_UTF8')
  })

  it('rejects on a line cap breach and supports explicit truncation', () => {
    const source = 'a\nb\nc\n'
    expect(parser.parse(utf8(source), { mediaType: 'text/plain', caps: { maxRows: 2 } }).status).toBe('rejected')
    const truncated = parser.parse(utf8(source), {
      mediaType: 'text/plain',
      caps: { maxRows: 2 },
      capBreachMode: 'truncate',
    })
    expect(truncated.status).toBe('incomplete')
    expect(truncated.records).toHaveLength(2)
  })
})

describe('unsupported input is refused explicitly', () => {
  function rejected(mediaType: string, text = 'x'): StructuredParseResult {
    return parser.parse(utf8(text), { mediaType })
  }

  it('refuses a scanned image without pretending it was parsed', () => {
    expect(rejected('image/png').diagnostics[0]?.code).toBe('SCANNED_DOCUMENT')
  })

  it('refuses DWG geometry', () => {
    expect(rejected('application/acad').diagnostics[0]?.code).toBe('UNSUPPORTED_DOCUMENT_GEOMETRY')
  })

  it('refuses a PDF at the structured boundary', () => {
    expect(rejected('application/pdf').diagnostics[0]?.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('refuses an unknown media type', () => {
    expect(rejected('application/octet-stream').diagnostics[0]?.code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('refuses an empty upload', () => {
    expect(parser.parse(new Uint8Array(), { mediaType: 'text/plain' }).diagnostics[0]?.code).toBe('EMPTY_INPUT')
  })
})
