import type { DraftRule, DraftRuleException, RuleImpact } from '@ontology/contracts'
import { ExtractionError } from './errors'

/**
 * Structured rule drafts from one untrusted generation response (SPEC D4.2, US-013).
 *
 * The structural fields (rule id, applicability object, severity, impact, exception target)
 * are checked strictly; a malformed container fails the stage. The expression body is kept as
 * `unknown` on purpose: an unsupported or cyclic expression must be recorded as an explicit
 * unhandled item with a reason, not silently coerced into a looser rule.
 */

export interface DraftRules {
  readonly rules: readonly DraftRule[]
  readonly exceptions: readonly DraftRuleException[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output field "${field}" must be a non-empty string`)
  }
  return value
}

function requireSeverity(value: unknown, field: string): 'hard' | 'soft' {
  if (value !== 'hard' && value !== 'soft') {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output field "${field}" must be "hard" or "soft"`)
  }
  return value
}

function requireImpact(value: unknown, field: string): RuleImpact {
  if (value !== 'high' && value !== 'low') {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output field "${field}" must be "high" or "low"`)
  }
  return value
}

function parseRule(entry: unknown, index: number): DraftRule {
  if (!isRecord(entry)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output rules[${String(index)}] must be an object`)
  }
  const at = `rules[${String(index)}]`
  if (!('expression' in entry)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${at}.expression is required`)
  }
  const rawExceptions = entry['exceptions'] === undefined ? [] : entry['exceptions']
  if (!Array.isArray(rawExceptions)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${at}.exceptions must be an array`)
  }
  return {
    ruleId: requireString(entry['ruleId'], `${at}.ruleId`),
    objectId: requireString(entry['objectId'], `${at}.objectId`),
    severity: requireSeverity(entry['severity'], `${at}.severity`),
    impact: requireImpact(entry['impact'], `${at}.impact`),
    expression: entry['expression'],
    exceptions: rawExceptions,
  }
}

function parseException(entry: unknown, index: number): DraftRuleException {
  if (!isRecord(entry)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output exceptions[${String(index)}] must be an object`)
  }
  const at = `exceptions[${String(index)}]`
  if (!('condition' in entry)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', `model output ${at}.condition is required`)
  }
  return {
    targetRuleId: requireString(entry['targetRuleId'], `${at}.targetRuleId`),
    condition: entry['condition'],
  }
}

export function parseRuleDrafts(container: Record<string, unknown>): DraftRules {
  const rawRules = container['rules'] === undefined ? [] : container['rules']
  const rawExceptions = container['exceptions'] === undefined ? [] : container['exceptions']
  if (!Array.isArray(rawRules)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', 'model output field "rules" must be an array')
  }
  if (!Array.isArray(rawExceptions)) {
    throw new ExtractionError('INVALID_MODEL_OUTPUT', 'model output field "exceptions" must be an array')
  }
  return {
    rules: rawRules.map(parseRule),
    exceptions: rawExceptions.map(parseException),
  }
}
