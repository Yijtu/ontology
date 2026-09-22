import type { Rfc3339UtcTimestamp, TelemetryQuality } from '@ontology/contracts'
import type { MeterResetPolicy } from './types'

/**
 * Cumulative meter handling (SPEC E2/E4, E-03).
 *
 * A cumulative energy register reports a monotonically non-decreasing total. Per-slot energy is
 * the difference between consecutive reads. Two cases must never be flattened into zero:
 *
 *   - a **reset/rollover**, where the register moves backwards. The interval is marked `reset`
 *     with an undefined amount (or, under the explicit `count_since_reset` policy, the register's
 *     current value — never a negative and never a silent zero);
 *   - a **missing/unknown** sample, which stays `missing`/`unknown` with an undefined amount.
 *
 * A gap also breaks the baseline: the first read after a missing slot is unknown, because the
 * consumption across the gap cannot be attributed to a single slot. Only a genuine, non-negative
 * difference between two consecutive, known reads produces a numeric amount.
 */

export type CumulativeIntervalStatus = 'ok' | 'reset' | 'missing' | 'unknown'

/** One slot's register reading. `value === undefined` means the sample was missing. */
export interface CumulativeReading {
  readonly value?: number
  readonly quality: TelemetryQuality
}

export interface SlotBounds {
  readonly startUtc: Rfc3339UtcTimestamp
  readonly endUtc: Rfc3339UtcTimestamp
}

export interface CumulativeInterval {
  readonly slotIndex: number
  readonly startUtc: Rfc3339UtcTimestamp
  readonly endUtc: Rfc3339UtcTimestamp
  readonly value?: number
  readonly quality: TelemetryQuality
  readonly status: CumulativeIntervalStatus
  readonly fromKwh?: number
  readonly toKwh?: number
}

export interface CumulativeSeriesResult {
  readonly intervals: readonly CumulativeInterval[]
  readonly resetCount: number
  readonly missingCount: number
}

const QUALITY_SEVERITY: Readonly<Record<TelemetryQuality, number>> = {
  good: 0,
  estimated: 1,
  suspect: 2,
  missing: 3,
  unknown: 4,
}

function worstQuality(a: TelemetryQuality, b: TelemetryQuality): TelemetryQuality {
  return QUALITY_SEVERITY[a] >= QUALITY_SEVERITY[b] ? a : b
}

function isUnknown(quality: TelemetryQuality): boolean {
  return quality === 'missing' || quality === 'unknown'
}

function missingStatus(reading: CumulativeReading | undefined): CumulativeIntervalStatus {
  if (reading === undefined) return 'missing'
  if (reading.quality === 'missing') return 'missing'
  if (reading.quality === 'unknown') return 'unknown'
  return reading.value === undefined ? 'missing' : 'ok'
}

export function computeCumulativeIntervals(
  readings: readonly (CumulativeReading | undefined)[],
  slotBounds: readonly SlotBounds[],
  policy: MeterResetPolicy,
): CumulativeSeriesResult {
  const intervals: CumulativeInterval[] = []
  let resetCount = 0
  let missingCount = 0

  for (let slotIndex = 0; slotIndex < slotBounds.length; slotIndex += 1) {
    const bounds = slotBounds[slotIndex]
    if (bounds === undefined) continue
    const current = readings[slotIndex]
    const previous = slotIndex === 0 ? undefined : readings[slotIndex - 1]
    const base = { slotIndex, startUtc: bounds.startUtc, endUtc: bounds.endUtc }

    if (current === undefined) {
      intervals.push({ ...base, status: 'missing', quality: 'missing' })
      missingCount += 1
      continue
    }
    if (slotIndex === 0) {
      // The opening register read has no baseline: the first interval is unknown, not zero.
      intervals.push({ ...base, status: 'unknown', quality: current.quality })
      missingCount += 1
      continue
    }

    const currentStatus = missingStatus(current)
    const previousStatus = missingStatus(previous)
    if (isUnknown(current.quality) || isUnknown(previous?.quality ?? 'missing') || current.value === undefined || previous?.value === undefined) {
      const status: CumulativeIntervalStatus = isUnknown(current.quality)
        ? currentStatus
        : isUnknown(previous?.quality ?? 'missing')
          ? previousStatus
          : 'missing'
      intervals.push({
        ...base,
        status,
        quality: worstQuality(current.quality, previous?.quality ?? 'missing'),
      })
      missingCount += 1
      continue
    }

    const fromKwh = previous.value
    const toKwh = current.value
    if (toKwh < fromKwh) {
      resetCount += 1
      if (policy === 'count_since_reset') {
        intervals.push({ ...base, status: 'reset', quality: current.quality, value: toKwh, fromKwh, toKwh })
      } else {
        intervals.push({ ...base, status: 'reset', quality: current.quality, fromKwh, toKwh })
      }
      continue
    }

    intervals.push({
      ...base,
      status: 'ok',
      quality: worstQuality(current.quality, previous.quality),
      value: toKwh - fromKwh,
      fromKwh,
      toKwh,
    })
  }

  return { intervals, resetCount, missingCount }
}
