import { summarizeLatencies } from '../../load/metrics'
import type { LatencySummary } from '../../load/metrics'

/**
 * Live external-condition validation report (LOCAL-051, SPEC §11 / S17).
 *
 * The report exists to keep three outcomes visibly distinct and never conflated:
 *   - `validated`: a fixed request actually reached the real endpoint and produced the
 *     recorded answer / structured fields / tool call / probabilities;
 *   - `blocked`: the external condition was not met (missing endpoint, unreachable host,
 *     rejected credential), recorded with the real reason and no fabricated result;
 *   - `error`: the call reached the endpoint but failed, with the classified code.
 *
 * Deterministic doubles stay the CI path and are reported elsewhere; nothing in this
 * report is produced by a stub. Secret VALUES are never stored: only variable NAMES and
 * their presence/emptiness, and every recorded string is passed through `redactValues`.
 */

export type LiveOutcome = 'validated' | 'blocked' | 'error'

export type ModelMapRole = 'vendor-first' | 'platform-first'

export interface EnvPresence {
  readonly name: string
  readonly present: boolean
  readonly empty: boolean
}

export interface LiveUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly usageUnknown: boolean
}

export interface LiveToolCall {
  readonly callId: string
  readonly toolId: string
  /** `true` when the accumulated `argumentsDelta` parsed as a JSON object. */
  readonly argumentsJsonValid: boolean
  readonly argumentsPreview: string
}

export interface LiveStructuredResult {
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly preview: string
}

export interface LiveCallRecord {
  readonly name: string
  readonly port: 'generation' | 'decision' | 'probe'
  readonly outcome: LiveOutcome
  readonly modelRef: string
  readonly vendorModel: string
  /** Only the path, never a host or a credential. */
  readonly endpointPath: string
  readonly latencyMs: number
  readonly attempts: number
  readonly retryObserved: boolean
  readonly stopReason?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly usage?: LiveUsage
  readonly answer?: string
  readonly modelVersion?: string
  readonly toolCalls?: readonly LiveToolCall[]
  readonly structured?: LiveStructuredResult
  readonly probabilities?: readonly { readonly optionId: string; readonly probability: number }[]
  readonly confidence?: number
  readonly fallbackReason?: string
  readonly blockedReason?: string
  readonly notes: readonly string[]
}

export interface LiveValidationReport {
  readonly generatedAt: string
  readonly nodeVersion: string
  readonly platform: string
  readonly secretsFile: string
  readonly envPresence: readonly EnvPresence[]
  /** Adapter-level `GenerationPort` attempts against the real endpoint. */
  readonly company: readonly LiveCallRecord[]
  /** Raw wire-level validation of the real endpoint's fields (endpoint/model/answer/structured/tool/usage). */
  readonly endpointProbes: readonly LiveCallRecord[]
  readonly jev: LiveCallRecord
  readonly latency: LatencySummary
  readonly summary: {
    readonly validated: number
    readonly blocked: number
    readonly error: number
  }
}

/** Which of the named variables are present/empty. Never returns a value. */
export function presenceOf(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): readonly EnvPresence[] {
  return names.map((name) => {
    const value = env[name]
    return { name, present: value !== undefined, empty: value === undefined || value.length === 0 }
  })
}

/**
 * Parse the vendor→model mapping. Accepts a JSON object or a comma/semicolon separated
 * list of `left=right` pairs. The pair order is resolved by `selectModelMapping`, because
 * the operator controls the variable and the two model ids are otherwise indistinguishable.
 */
export function parseModelMapEntries(raw: string | undefined): readonly { readonly left: string; readonly right: string }[] {
  if (raw === undefined || raw.trim().length === 0) return []
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return []
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
    return Object.entries(parsed).map(([left, right]) => ({ left, right: String(right) }))
  }
  return trimmed
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const index = entry.indexOf('=')
      if (index < 0) return { left: entry, right: entry }
      return { left: entry.slice(0, index).trim(), right: entry.slice(index + 1).trim() }
    })
    .filter((entry) => entry.left.length > 0 && entry.right.length > 0)
}

export function selectModelMapping(
  entries: readonly { readonly left: string; readonly right: string }[],
  role: ModelMapRole,
): { readonly platformModelId: string; readonly vendorModel: string } | undefined {
  const first = entries[0]
  if (first === undefined) return undefined
  return role === 'vendor-first'
    ? { vendorModel: first.left, platformModelId: first.right }
    : { platformModelId: first.left, vendorModel: first.right }
}

/** Replace every non-empty secret value with `[redacted]`. */
export function redactValues(text: string, values: readonly string[]): string {
  let result = text
  for (const value of values) {
    if (value.length === 0) continue
    result = result.split(value).join('[redacted]')
  }
  return result
}

/** Cap a recorded preview so an unexpectedly large answer cannot bloat the report. */
export function preview(text: string, limit = 400): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

export function summarizeReport(
  calls: readonly LiveCallRecord[],
): LiveValidationReport['summary'] {
  return {
    validated: calls.filter((call) => call.outcome === 'validated').length,
    blocked: calls.filter((call) => call.outcome === 'blocked').length,
    error: calls.filter((call) => call.outcome === 'error').length,
  }
}

export function latencySummaryOf(calls: readonly LiveCallRecord[]): LatencySummary {
  return summarizeLatencies(calls.map((call) => call.latencyMs))
}

/** One-line human rendering used by the operator script's stdout summary. */
export function formatCall(call: LiveCallRecord): string {
  const where = `${call.port}:${call.name}`
  const model = call.modelVersion === undefined ? '' : ` modelVersion=${call.modelVersion}`
  if (call.outcome === 'validated') {
    const extra =
      call.probabilities !== undefined
        ? ` probabilities=${call.probabilities.map((entry) => `${entry.optionId}:${entry.probability.toFixed(3)}`).join(',')}${call.confidence === undefined ? '' : ` confidence=${call.confidence.toFixed(3)}`}`
        : ''
    return `[validated] ${where} ${String(call.latencyMs)}ms attempts=${String(call.attempts)} model=${call.vendorModel}${model}${extra}`
  }
  if (call.outcome === 'blocked') {
    return `[blocked]   ${where} reason=${call.blockedReason ?? 'unknown'}`
  }
  return `[error]     ${where} ${call.errorCode ?? 'UNKNOWN'}: ${call.errorMessage ?? ''}`
}
