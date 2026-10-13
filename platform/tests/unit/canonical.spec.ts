import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson, digestOfCanonical } from '@ontology/core'

const bytesOrder = (keys: readonly string[]): readonly string[] =>
  [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

describe('kernel canonical JSON', () => {
  it('orders object keys by UTF-16 code unit, never by locale', () => {
    const keys = ['a_b', 'aB', 'ab', 'A', 'b', '_x', 'Z', 'a-b', 'a.b', 'a1']
    const value = Object.fromEntries(keys.map((key) => [key, true]))
    const expected = `{${bytesOrder(keys).map((key) => `${JSON.stringify(key)}:true`).join(',')}}`
    expect(canonicalJson(value)).toBe(expected)
  })

  it('is independent of property insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('drops undefined object entries but keeps array order and undefined array slots', () => {
    expect(canonicalJson({ a: undefined, b: [1, 2] })).toBe('{"b":[1,2]}')
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJson(undefined)).toBe('null')
  })

  it('digestOfCanonical is exactly the sha256 of the canonical JSON', () => {
    const value = { z: 1, a: { y: 2, b: 3 }, list: [1, 'x', true] }
    expect(digestOfCanonical(value)).toBe(
      `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`,
    )
  })
})
