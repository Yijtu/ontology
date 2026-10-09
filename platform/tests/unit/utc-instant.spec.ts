import { describe, expect, it } from 'vitest'
import { sameUtcInstant, compareUtcInstants } from '@ontology/semantic-engine'

describe('exact UTC identity used by archived competency artifacts', () => {
  it('accepts equivalent UTC representations without discarding fractional precision', () => {
    expect(sameUtcInstant('2026-10-08T00:00:00Z', '2026-10-08T00:00:00.000Z')).toBe(true)
    expect(sameUtcInstant('2026-10-08T00:00:00.1Z', '2026-10-08T00:00:00.100000000Z')).toBe(true)
    expect(sameUtcInstant('2026-10-08T00:00:00.000000001Z', '2026-10-08T00:00:00.000000002Z')).toBe(false)
    expect(sameUtcInstant('2026-10-08T00:00:00Z', '2026-10-08T00:00:00.000000001Z')).toBe(false)
    expect(compareUtcInstants('2026-10-08T00:00:00.000000001Z', '2026-10-08T00:00:00.000000002Z')).toBe(-1)
    expect(compareUtcInstants('2026-10-08T00:00:00.000000002Z', '2026-10-08T00:00:00.000000001Z')).toBe(1)
  })
  it('rejects unsupported and malformed timestamp representations', () => {
    for (const value of ['not-an-instant', '2026-10-08T00:00:00+00:00', '2026-10-08T00:00:00.0000000001Z', '2026-10-08T00:00:00.Z']) {
      expect(sameUtcInstant(value, value)).toBe(false)
    }
  })
})
