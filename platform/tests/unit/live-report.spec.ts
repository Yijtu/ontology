import { describe, expect, it } from 'vitest'
import {
  formatCall,
  latencySummaryOf,
  parseModelMapEntries,
  presenceOf,
  preview,
  redactValues,
  selectModelMapping,
  summarizeReport,
} from '../evaluation/live/live-report'
import type { LiveCallRecord } from '../evaluation/live/live-report'

const FAKE_KEY = 'sk-fake-live-validation-DO-NOT-LEAK-1234'

function call(overrides: Partial<LiveCallRecord>): LiveCallRecord {
  return {
    name: 'natural_language',
    port: 'generation',
    outcome: 'validated',
    modelRef: 'company-llm',
    vendorModel: 'vendor-llm',
    endpointPath: '/v1/generate',
    latencyMs: 10,
    attempts: 1,
    retryObserved: false,
    notes: [],
    ...overrides,
  }
}

describe('presenceOf', () => {
  it('reports names and presence/emptiness without any value', () => {
    const presence = presenceOf({ A: 'value', B: '' }, ['A', 'B', 'C'])
    expect(presence).toEqual([
      { name: 'A', present: true, empty: false },
      { name: 'B', present: true, empty: true },
      { name: 'C', present: false, empty: true },
    ])
    expect(JSON.stringify(presence)).not.toContain('value')
  })
})

describe('parseModelMapEntries / selectModelMapping', () => {
  it('parses a single k=v pair and both role interpretations', () => {
    const entries = parseModelMapEntries('vendor-llm=platform-llm')
    expect(entries).toEqual([{ left: 'vendor-llm', right: 'platform-llm' }])
    expect(selectModelMapping(entries, 'vendor-first')).toEqual({
      vendorModel: 'vendor-llm',
      platformModelId: 'platform-llm',
    })
    expect(selectModelMapping(entries, 'platform-first')).toEqual({
      platformModelId: 'vendor-llm',
      vendorModel: 'platform-llm',
    })
  })

  it('parses a JSON object and a comma-separated list', () => {
    expect(parseModelMapEntries('{"a":"b"}')).toEqual([{ left: 'a', right: 'b' }])
    expect(parseModelMapEntries('a=b, c=d')).toEqual([
      { left: 'a', right: 'b' },
      { left: 'c', right: 'd' },
    ])
  })

  it('returns no mapping for empty or malformed input', () => {
    expect(parseModelMapEntries(undefined)).toEqual([])
    expect(parseModelMapEntries('')).toEqual([])
    expect(selectModelMapping([], 'vendor-first')).toBeUndefined()
  })
})

describe('redactValues / preview', () => {
  it('replaces every occurrence of a non-empty value and ignores empty ones', () => {
    expect(redactValues(`Bearer ${FAKE_KEY}`, [FAKE_KEY, ''])).toBe('Bearer [redacted]')
  })

  it('caps a preview', () => {
    expect(preview('x'.repeat(10), 4)).toBe('xxxx…')
    expect(preview('short', 10)).toBe('short')
  })
})

describe('summarizeReport / latencySummaryOf / formatCall', () => {
  it('counts each outcome and summarizes latency', () => {
    const calls = [
      call({ outcome: 'validated' }),
      call({ outcome: 'blocked', blockedReason: 'missing endpoint' }),
      call({ outcome: 'error', errorCode: 'RATE_LIMITED', errorMessage: 'slow down' }),
    ]
    expect(summarizeReport(calls)).toEqual({ validated: 1, blocked: 1, error: 1 })
    const summary = latencySummaryOf(calls)
    expect(summary.samples).toBe(3)
    expect(summary.p50Ms).toBe(10)
  })

  it('renders each outcome', () => {
    expect(formatCall(call({ latencyMs: 42 }))).toContain('[validated]')
    expect(formatCall(call({ outcome: 'blocked', blockedReason: 'missing endpoint' }))).toContain(
      'reason=missing endpoint',
    )
    expect(
      formatCall(call({ outcome: 'error', errorCode: 'MODEL_UNAVAILABLE', errorMessage: 'provider unreachable' })),
    ).toContain('MODEL_UNAVAILABLE')
  })
})
