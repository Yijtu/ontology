/**
 * Minimal RFC 6901 JSON Pointer resolution.
 *
 * Claim bindings locate the bound value/unit/subject/time inside an archived tool result
 * by pointer, so the verifier reads the result itself instead of trusting a transcribed
 * number. A missing segment is an explicit `found: false`, never a silent `undefined` that
 * could be mistaken for a real null in the payload.
 */
export interface PointerResolution {
  readonly found: boolean
  readonly value?: unknown
}

export function resolveJsonPointer(document: unknown, pointer: string): PointerResolution {
  if (pointer === '') return { found: true, value: document }
  if (!pointer.startsWith('/')) return { found: false }
  const segments = pointer.slice(1).split('/').map(decodeSegment)
  let current: unknown = document
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return { found: false }
      const index = Number(segment)
      if (index >= current.length) return { found: false }
      current = current[index]
      continue
    }
    if (current !== null && typeof current === 'object') {
      const record = current as Record<string, unknown>
      if (!Object.hasOwn(record, segment)) return { found: false }
      current = record[segment]
      continue
    }
    return { found: false }
  }
  return { found: true, value: current }
}

function decodeSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~')
}
