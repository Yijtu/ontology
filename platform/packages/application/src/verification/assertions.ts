import type { ResourceRef, ToolContext, Uuid, VerifiedAssertion, VerificationFinding } from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type { ResolvedEvidence } from './hard-checks'
import { fieldBindingMatches } from './hard-checks'

export interface AssertionCheckOutcome {
  readonly findings: readonly VerificationFinding[]
  readonly supportedAssertionIds: readonly Uuid[]
}

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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate.id === expected.id && candidate.version === expected.version && candidate.digest === expected.digest && candidate.kind === expected.kind
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

function sameRecord(value: unknown, expected: Readonly<Record<string, unknown>>): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && canonical(value) === canonical(expected)
}

function valueMatches(assertion: VerifiedAssertion, payload: unknown, pointer: string): boolean {
  const actual = valueAt(payload, pointer)
  switch (assertion.kind) {
    case 'string':
    case 'enum': return actual === assertion.value
    case 'boolean': return actual === assertion.value
    case 'entity_ref': return sameRef(actual, assertion.value)
    case 'relation_ref': return sameRecord(actual, { type: assertion.value.type, from: assertion.value.from, to: assertion.value.to })
    case 'document_quote': return actual === assertion.quote
    case 'artifact_summary': return actual === assertion.summary
    // C2 supplies the deterministic computation artifact contract before rule judgements can pass.
    case 'rule_judgement': return false
  }
}

function finding(assertion: VerifiedAssertion, reference?: VerifiedAssertion['references'][number], code: VerificationFinding['code'] = 'assertion_mismatch'): VerificationFinding {
  return {
    code,
    axis: 'hard',
    field: assertion.predicate,
    assertionId: assertion.assertionId,
    ...(reference === undefined ? {} : { evidenceRef: reference.evidenceRef, pointer: reference.valuePointer }),
  }
}

/** Deterministic checks for all non-numeric assertions; a model score cannot override a finding. */
export function checkVerifiedAssertions(
  assertions: readonly VerifiedAssertion[],
  resolved: ReadonlyMap<string, ResolvedEvidence>,
  ctx: ToolContext,
  requireFieldBinding = false,
): AssertionCheckOutcome {
  void ctx
  const findings: VerificationFinding[] = []
  const supportedAssertionIds: Uuid[] = []
  for (const assertion of assertions) {
    const assertionFindings: VerificationFinding[] = []
    if (assertion.references.length === 0) assertionFindings.push(finding(assertion))
    for (const reference of assertion.references) {
      if (assertion.kind === 'rule_judgement') {
        assertionFindings.push(finding(assertion, reference))
        continue
      }
      const located = resolved.get(reference.evidenceRef.id)
      if (located === undefined || located.unreadable || located.payload === undefined) {
        assertionFindings.push({ ...finding(assertion, reference), code: 'result_unreadable' })
        continue
      }
      if (!sameRef(located.record.evidenceRef, reference.evidenceRef)) {
        assertionFindings.push({ ...finding(assertion, reference), code: 'evidence_reference_mismatch' })
        continue
      }
      if (located.record.envelope.resultDigest !== reference.resultDigest) {
        assertionFindings.push({ ...finding(assertion, reference), code: 'result_digest_mismatch', expected: located.record.envelope.resultDigest, actual: reference.resultDigest })
        continue
      }
      if (requireFieldBinding && assertion.kind !== 'document_quote' && assertion.kind !== 'artifact_summary' && !fieldBindingMatches(located.payload, reference, assertion.predicate)) {
        assertionFindings.push({ ...finding(assertion, reference), code: 'predicate_mismatch' })
      }
      if (!valueMatches(assertion, located.payload, reference.valuePointer)) {
        assertionFindings.push(finding(assertion, reference, assertion.kind === 'document_quote' ? 'document_quote_mismatch' : 'assertion_mismatch'))
        continue
      }
      if (valueAt(located.payload, reference.subjectPointer) !== assertion.subject) {
        assertionFindings.push(finding(assertion, reference))
        continue
      }
      if (assertion.kind === 'document_quote') {
        const quoteDigest = sha256DigestOf(assertion.quote)
        const document = reference.documentPointer === undefined ? undefined : valueAt(located.payload, reference.documentPointer)
        const locator = reference.locatorPointer === undefined ? undefined : valueAt(located.payload, reference.locatorPointer)
        const textDigest = reference.textDigestPointer === undefined ? undefined : valueAt(located.payload, reference.textDigestPointer)
        const storedQuoteDigest = reference.quoteDigestPointer === undefined ? undefined : valueAt(located.payload, reference.quoteDigestPointer)
        if (assertion.precision !== 'exact' || quoteDigest !== assertion.quoteDigest || textDigest !== assertion.textDigest || storedQuoteDigest !== assertion.quoteDigest || reference.documentPointer === undefined || !sameRef(document, assertion.documentRef) || reference.locatorPointer === undefined || !sameRecord(locator, assertion.locator)) {
          assertionFindings.push(finding(assertion, reference, 'document_quote_mismatch'))
        }
      }
      if (assertion.kind === 'artifact_summary') {
        const artifact = reference.documentPointer === undefined ? undefined : valueAt(located.payload, reference.documentPointer)
        if (reference.documentPointer === undefined || !sameRef(artifact, assertion.artifactRef)) assertionFindings.push(finding(assertion, reference))
      }
    }
    if (assertionFindings.length === 0) supportedAssertionIds.push(assertion.assertionId)
    findings.push(...assertionFindings)
  }
  return { findings, supportedAssertionIds }
}
