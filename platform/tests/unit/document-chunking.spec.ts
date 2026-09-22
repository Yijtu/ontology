import { describe, expect, it } from 'vitest'
import {
  buildChunkRecords,
  chunkLines,
  truncatedChunkIdsOf,
} from '@ontology/adapter-extraction-document'
import type { StructuralLine } from '@ontology/adapter-extraction-document'

function line(
  text: string,
  startOffset: number,
  options?: { readonly headingLevel?: number; readonly page?: number },
): StructuralLine {
  return {
    text,
    page: options?.page ?? 1,
    startOffset,
    endOffset: startOffset + text.length,
    ...(options?.headingLevel === undefined ? {} : { headingLevel: options.headingLevel }),
  }
}

describe('structure-aware chunking', () => {
  it('keeps a clause attached to its condition and exception', () => {
    const lines: StructuralLine[] = [
      line('PAYMENT TERMS', 0, { headingLevel: 1 }),
      line('2.1 Fees are due within 30 days of the invoice date.', 14),
      line('Condition: only when the customer account is active.', 66),
      line('Exception: force majeure outages are excluded.', 120),
      line('2.2 Late payments accrue interest.', 164),
    ]

    const chunks = chunkLines(lines, { offsetUnit: 'byte', approximatePages: new Set() })

    expect(chunks.map((chunk) => chunk.chunkKind)).toEqual(['section', 'clause', 'clause'])
    const clause = chunks[1]
    expect(clause?.text).toBe(
      [
        '2.1 Fees are due within 30 days of the invoice date.',
        'Condition: only when the customer account is active.',
        'Exception: force majeure outages are excluded.',
      ].join('\n'),
    )
    expect(clause?.conditions).toEqual(['Condition: only when the customer account is active.'])
    expect(clause?.exceptions).toEqual(['Exception: force majeure outages are excluded.'])
    // The clause was not split away from the qualifiers that govern it.
    expect(clause?.heading).toBe('PAYMENT TERMS')
    expect(chunks.filter((chunk) => chunk.chunkKind === 'clause')).toHaveLength(2)
    // The span covers the whole block, so reading it back returns the same text.
    expect(clause?.startOffset).toBe(14)
    expect(clause?.endOffset).toBe(120 + 'Exception: force majeure outages are excluded.'.length)
  })

  it('keeps a table attached to its caption and header row', () => {
    const lines: StructuralLine[] = [
      line('Table 1: Rate schedule', 0),
      line('Tier A | 0.10 | 100', 24),
      line('Tier B | 0.20 | 250', 44),
      line('Tier C | 0.35 | 500', 64),
    ]

    const chunks = chunkLines(lines, { offsetUnit: 'byte', approximatePages: new Set() })

    expect(chunks).toHaveLength(1)
    const table = chunks[0]
    expect(table?.chunkKind).toBe('table')
    expect(table?.caption).toBe('Table 1: Rate schedule')
    expect(table?.tableHeader).toBe('Tier A | 0.10 | 100')
    expect(table?.text).toBe(
      ['Table 1: Rate schedule', 'Tier A | 0.10 | 100', 'Tier B | 0.20 | 250', 'Tier C | 0.35 | 500'].join(
        '\n',
      ),
    )
  })

  it('does not treat a caption without rows as a table', () => {
    const lines: StructuralLine[] = [
      line('Table 1: a caption with no rows follows', 0),
      line('This is an ordinary paragraph.', 39),
    ]

    const chunks = chunkLines(lines, { offsetUnit: 'byte', approximatePages: new Set() })

    expect(chunks.map((chunk) => chunk.chunkKind)).toEqual(['paragraph'])
  })

  it('marks every chunk on an OCR page as approximate', () => {
    const lines: StructuralLine[] = [
      line('1.1 Recovered clause text.', 0, { page: 2 }),
      line('Condition: only when scanned.', 27, { page: 2 }),
    ]

    const chunks = chunkLines(lines, { offsetUnit: 'character', approximatePages: new Set([2]) })

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.precision).toBe('approximate')
  })

  it('keeps a numbered sub-clause with its parent body instead of splitting mid-clause', () => {
    const lines: StructuralLine[] = [
      line('4.1 The supplier shall deliver the goods.', 0),
      line('Delivery must occur before the agreed date.', 43),
      line('4.2 Risk passes on delivery.', 88),
    ]

    const chunks = chunkLines(lines, { offsetUnit: 'byte', approximatePages: new Set() })

    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.text).toBe(
      ['4.1 The supplier shall deliver the goods.', 'Delivery must occur before the agreed date.'].join(
        '\n',
      ),
    )
    expect(chunks[1]?.text).toBe('4.2 Risk passes on delivery.')
  })
})

describe('truncation lineage', () => {
  const PARSE_ID = '11111111-1111-4111-8111-111111111111'

  function recordsFor(
    lines: readonly StructuralLine[],
  ): ReturnType<typeof buildChunkRecords> {
    const drafts = chunkLines(lines, { offsetUnit: 'character', approximatePages: new Set() })
    return buildChunkRecords(drafts, { parseId: PARSE_ID, offsetUnit: 'character' })
  }

  function page(pageNumber: number): {
    page: number
    startOffset: number
    endOffset: number
    approximate: boolean
  } {
    return { page: pageNumber, startOffset: 0, endOffset: 1, approximate: false }
  }

  it('marks the last chunk before a skipped page and the first chunk after it', () => {
    const chunks = recordsFor([
      line('1. A clause on the first page.', 0, { page: 1 }),
      line('2. A clause on the third page.', 32, { page: 3 }),
    ])
    expect(chunks).toHaveLength(2)

    const ids = truncatedChunkIdsOf(chunks, [page(1), page(3)], 3)

    // Page 2 was skipped: both neighbours of the gap may be missing continuation text.
    expect(ids).toEqual([chunks[0]?.chunkId, chunks[1]?.chunkId])
  })

  it('marks only the final chunk when the parse budget cuts the document short', () => {
    const chunks = recordsFor([
      line('1. A clause on the first page.', 0, { page: 1 }),
      line('2. A clause on the second page.', 32, { page: 2 }),
    ])

    const ids = truncatedChunkIdsOf(chunks, [page(1)], 2)

    expect(ids).toEqual([chunks[0]?.chunkId])
  })

  it('yields no ids when every page of the document was captured', () => {
    const chunks = recordsFor([
      line('1. A clause on the first page.', 0, { page: 1 }),
      line('2. A clause on the second page.', 32, { page: 2 }),
    ])

    expect(truncatedChunkIdsOf(chunks, [page(1), page(2)], 2)).toEqual([])
  })
})
