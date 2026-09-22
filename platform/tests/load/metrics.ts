import { cpus, totalmem } from 'node:os'

/**
 * Load/evaluation metric primitives (SPEC §9, V6).
 *
 * A rate is always carried with its denominator: a percentage without the population it
 * was computed over is not a reportable number, so the harness never exposes a bare ratio.
 * Percentiles use the nearest-rank definition over the retained samples; the sample count
 * is reported alongside so a P95 over three observations is visibly weak.
 */
export interface Rate {
  readonly numerator: number
  readonly denominator: number
}

export function rate(numerator: number, denominator: number): Rate {
  if (denominator < 0 || numerator < 0 || numerator > denominator) {
    throw new Error(`invalid rate ${String(numerator)}/${String(denominator)}`)
  }
  return { numerator, denominator }
}

export function rateValue(value: Rate): number | undefined {
  return value.denominator === 0 ? undefined : value.numerator / value.denominator
}

export function formatRate(value: Rate): string {
  const ratio = rateValue(value)
  return ratio === undefined ? `${String(value.numerator)}/${String(value.denominator)} (no data)` : `${(ratio * 100).toFixed(1)}% (${String(value.numerator)}/${String(value.denominator)})`
}

export interface LatencySummary {
  readonly samples: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
  readonly minMs: number
  readonly meanMs: number
}

/** Nearest-rank percentile; the sample count is part of the summary, never hidden. */
export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { samples: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, minMs: 0, meanMs: 0 }
  }
  const sorted = [...samples].sort((left, right) => left - right)
  const at = (percentile: number): number => {
    const rank = Math.ceil((percentile / 100) * sorted.length)
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
    return sorted[index] ?? 0
  }
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    samples: sorted.length,
    p50Ms: at(50),
    p95Ms: at(95),
    maxMs: sorted[sorted.length - 1] ?? 0,
    minMs: sorted[0] ?? 0,
    meanMs: total / sorted.length,
  }
}

/** A tiny synchronous recorder: `record` wraps a measured operation and returns its result. */
export class LatencyRecorder {
  readonly #samples: number[] = []

  record<T>(operation: () => T): T {
    const started = performance.now()
    try {
      return operation()
    } finally {
      this.#samples.push(performance.now() - started)
    }
  }

  async recordAsync<T>(operation: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      return await operation()
    } finally {
      this.#samples.push(performance.now() - started)
    }
  }

  push(durationMs: number): void {
    this.#samples.push(durationMs)
  }

  get samples(): readonly number[] {
    return this.#samples
  }

  summary(): LatencySummary {
    return summarizeLatencies(this.#samples)
  }
}

export interface HardwareInfo {
  readonly platform: string
  readonly release: string
  readonly arch: string
  readonly cpuModel: string
  readonly logicalCpus: number
  readonly totalMemoryMiB: number
  readonly nodeVersion: string
}

export function hardwareInfo(): HardwareInfo {
  const first = cpus()[0]
  return {
    platform: process.platform,
    release: process.release?.name ?? 'unknown',
    arch: process.arch,
    cpuModel: first?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
    nodeVersion: process.version,
  }
}

export interface ResourceUsage {
  readonly rssMiB: number
  readonly heapUsedMiB: number
  readonly cpuUserMs: number
  readonly cpuSystemMs: number
}

export function resourceUsage(): ResourceUsage {
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  return {
    rssMiB: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
    heapUsedMiB: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
  }
}

/** Which caches were warm when a measurement ran (SPEC §9 requires the cache state). */
export interface CacheState {
  readonly controlDatabaseWarm: boolean
  readonly localToolCacheWarm: boolean
  readonly notes: string
}

export function cacheState(overrides: Partial<CacheState> = {}): CacheState {
  return {
    controlDatabaseWarm: overrides.controlDatabaseWarm ?? false,
    localToolCacheWarm: overrides.localToolCacheWarm ?? false,
    notes: overrides.notes ?? 'cold process; no cross-run cache carried in',
  }
}
