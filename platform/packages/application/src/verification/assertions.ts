import type { ResourceRef, ToolContext, VerifiedAssertion, VerificationFinding } from '@ontology/contracts'
import type { ResolvedEvidence } from './hard-checks'
import { sha256DigestOf } from '@ontology/core'

function valueAt(payload: unknown, pointer: string): unknown {
  if (pointer === '') return payload
  if (!pointer.startsWith('/')) return undefined
  let value = payload
  for (const token of pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (typeof value !== 'object' || value === null) return undefined
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/u.test(token)) return undefined
      value = value[Number(token)]
    } else {
      value = Object.hasOwn(value, token) ? (value as Record<string, unknown>)[token] : undefined
    }
  }
  return value
}

function sameRef(value: unknown, expected: ResourceRef): boolean {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return candidate.id === expected.id && candidate.version === expected.version && candidate.digest === expected.digest && candidate.kind === expected.kind
}

function sameRecord(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return canonical(value) === canonical(expected)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function valueMatches(assertion: VerifiedAssertion, payload: unknown, pointer: string): boolean {
  const actual = valueAt(payload, pointer)
  switch (assertion.kind) {
    case 'string':
    case 'enum': return actual === assertion.value
    case 'boolean': return actual === assertion.value
    case 'entity_ref': return sameRef(actual, assertion.value)
    case 'relation_ref': return sameRecord(actual, { type: assertion.value.type, from: assertion.value.from, to: assertion.value.to })
    case 'rule_judgement': return false
    case 'document_quote': return actual === assertion.quote
    case 'artifact_summary': return actual === assertion.summary
  }
}

/** Deterministic checks for non-numeric statements. Quotes are exact byte-derived spans. */
export function checkVerifiedAssertions(
  assertions: readonly VerifiedAssertion[],
  resolved: ReadonlyMap<string, ResolvedEvidence>,
  ctx: ToolContext,
): readonly VerificationFinding[] {
  void ctx
  const findings: VerificationFinding[] = []
  for (const assertion of assertions) {
    if (assertion.references.length === 0) {
      findings.push({ code: assertion.kind === 'document_quote' ? 'document_quote_mismatch' : 'assertion_mismatch', axis: 'hard', field: assertion.predicate, assertionId: assertion.assertionId })
      continue
    }
    for (const reference of assertion.references) {
      if (assertion.kind === 'rule_judgement') {
        findings.push({ code: 'assertion_mismatch', axis: 'hard', field: assertion.predicate, assertionId: assertion.assertionId, evidenceRef: reference.evidenceRef, pointer: reference.rulePointer ?? reference.valuePointer })
        continue
      }
      const located = resolved.get(reference.evidenceRef.id)
      if (located === undefined || located.unreadable || located.payload === undefined) {
        findings.push({ code: 'result_unreadable', axis: 'hard', field: assertion.predicate, assertionId: assertion.assertionId, evidenceRef: reference.evidenceRef, pointer: reference.valuePointer })
        continue
      }
      if (located.record.envelope.resultDigest !== reference.resultDigest) {
        findings.push({ code: 'result_digest_mismatch', axis: 'hard', field: assertion.predicate, assertionId: assertion.assertionId, evidenceRef: reference.evidenceRef, expected: located.record.envelope.resultDigest, actual: reference.resultDigest })
        continue
      }
      if (!valueMatches(assertion, located.payload, reference.valuePointer)) {
        findings.push({ code: assertion.kind === 'document_quote' ? 'document_quote_mismatch' : 'assertion_mismatch', axis: 'hard', field: assertion.predicate, assertionId: assertion.assertionId, evidenceRef: reference.evidenceRef, pointer: reference.valuePointer })
        continue
      }
      if (valueAt(located.payload, reference.subjectPointer) !== assertion.subject) {
        findings.push({ code: 'assertion_mismatch', axis: 'hard', field: assertion.predicate, assertionId: assertion.assertionId, evidenceRef: reference.evidenceRef, pointer: reference.subjectPointer })
        continue
      }
      if (assertion.kind === 'document_quote') {
        const quoteDigest = sha256DigestOf(assertion.quote)
        const document = reference.documentPointer === undefined ? undefined : valueAt(located.payload, reference.documentPointer)
        const locator = reference.locatorPointer === undefined ? undefined : valueAt(located.payload, reference.locatorPointer)
        const textDigest = reference.textDigestPointer === undefined ? undefined : valueAt(located.payload, reference.textDigestPointer)
        const storedQuoteDigest = reference.quoteDigestPointer === undefined ? undefined : valueAt(located.payload, reference.quoteDigestPointer)
        if (assertion.precision !== 'exact' || quoteDigest !== assertion.quoteDigest || quoteDigest !== assertion.textDigest || quoteDigest !== textDigest || quoteDigest !== storedQuoteDigest || reference.documentPointer === undefined || !sameRef(document, assertion.documentRef) || reference.locatorPointer === undefined || !sameRecord(locator, assertion.locator)) {
          findings.push({ code: 'document_quote_mismatch', axis: 'hard', field: assertion.predicate, assertionId: assertion.assertionId, evidenceRef: reference.evidenceRef, pointer: reference.valuePointer })
        }
      }
      if (assertion.kind === 'artifact_summary') {
        const artifact = reference.documentPointer === undefined ? undefined : valueAt(located.payload, reference.documentPointer)
        if (reference.documentPointer === undefined || !sameRef(artifact, assertion.artifactRef)) {
          findings.push({ code: 'assertion_mismatch', axis: 'hard', field: assertion.predicate, assertionId: assertion.assertionId, evidenceRef: reference.evidenceRef, pointer: reference.documentPointer ?? reference.valuePointer })
        }
      }
    }
  }
  return findings
}
