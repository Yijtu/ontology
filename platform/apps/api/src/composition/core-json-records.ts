import type { ScalarValue } from '@ontology/contracts'
import { isRecord } from './core-composition-shared'

/** Split a text blob of concatenated JSON objects into validated scalar records. */
export function parseJsonRecordBlocks(text: string, label: string): Record<string, ScalarValue>[] {
  const records: Record<string, ScalarValue>[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === undefined) continue
    if (start < 0) {
      if (character === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') depth -= 1
    if (depth !== 0) continue
    const encoded = text.slice(start, index + 1)
    let parsed: unknown
    try {
      parsed = JSON.parse(encoded)
    } catch (error) {
      throw new Error(`${label} contains an invalid JSON object`, { cause: error })
    }
    if (!isRecord(parsed)) throw new Error(`${label} must contain JSON objects`)
    const record: Record<string, ScalarValue> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new Error(`${label} has a non-scalar value for ${key}`)
      }
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${label} has a non-finite value for ${key}`)
      record[key] = value
    }
    records.push(record)
    start = -1
    depth = 0
  }
  if (start >= 0 || records.length === 0) throw new Error(`${label} must contain one or more complete JSON records`)
  return records
}
