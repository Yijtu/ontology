import type { ResourceRef, Rfc3339UtcTimestamp, ToolContext, Uuid, VerifiedAssertion, VerificationFinding } from '@ontology/contracts'
import type { ResolvedEvidence } from './hard-checks'
import { fieldBindingMatches, rowBindingFinding, sourceValidityFinding } from './hard-checks'
import {
  isFieldBoundAssertionKind,
  verifyDocumentCitation,
  verifyRelationEdge,
  verifyRuleJudgement,
} from './typed-checkers'

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

function valueMatches(assertion: VerifiedAssertion, payload: unknown, pointer: string): boolean {
  const actual = valueAt(payload, pointer)
  switch (assertion.kind) {
    case 'string':
    case 'enum': return actual === assertion.value
    case 'boolean': return actual === assertion.value
    case 'entity_ref': return sameRef(actual, assertion.value)
    // Relation endpoints and document citations are verified by their dedicated typed
    // checkers below (a navigation hop or citation binding is not a single payload value).
    case 'relation_ref': return true
    case 'document_quote': return true
    case 'artifact_summary': return actual === assertion.summary
    // Rule judgements are verified against the archived computation artifact before this point.
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
  now: Rfc3339UtcTimestamp,
  requireFieldBinding = false,
  replayedRules: ReadonlySet<string> = new Set(),
): AssertionCheckOutcome {
  void ctx
  const findings: VerificationFinding[] = []
  const supportedAssertionIds: Uuid[] = []
  for (const assertion of assertions) {
    if (assertion.kind === 'rule_judgement') {
      const ruleFindings = verifyRuleJudgement(assertion, resolved, now, replayedRules)
      if (ruleFindings.length === 0) supportedAssertionIds.push(assertion.assertionId)
      findings.push(...ruleFindings)
      continue
    }
    const assertionFindings: VerificationFinding[] = []
    if (assertion.references.length === 0) assertionFindings.push(finding(assertion))
    for (const reference of assertion.references) {
      const located = resolved.get(reference.evidenceRef.id)
      if (located === undefined) {
        assertionFindings.push({ ...finding(assertion, reference), code: 'evidence_not_found' })
        continue
      }
      if (located.unreadable || located.payload === undefined) {
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
      if (requireFieldBinding && isFieldBoundAssertionKind(assertion.kind)) {
        if (!fieldBindingMatches(located.payload, reference, assertion.predicate)) {
          assertionFindings.push({ ...finding(assertion, reference), code: 'predicate_mismatch' })
        }
        const rowFinding = rowBindingFinding(reference, { assertionId: assertion.assertionId, field: assertion.predicate })
        if (rowFinding !== undefined) assertionFindings.push(rowFinding)
      }
      if (!valueMatches(assertion, located.payload, reference.valuePointer)) {
        assertionFindings.push(finding(assertion, reference, assertion.kind === 'document_quote' ? 'document_quote_mismatch' : 'assertion_mismatch'))
        continue
      }
      if (valueAt(located.payload, reference.subjectPointer) !== assertion.subject) {
        assertionFindings.push(finding(assertion, reference))
        continue
      }
      if (assertion.asOf !== undefined && reference.timePointer === undefined) {
        assertionFindings.push({ ...finding(assertion, reference), code: 'time_mismatch' })
      } else if (assertion.asOf !== undefined && reference.timePointer !== undefined && valueAt(located.payload, reference.timePointer) !== assertion.asOf) {
        assertionFindings.push({ ...finding(assertion, reference), code: 'time_mismatch', pointer: reference.timePointer })
      }
      const validityFinding = sourceValidityFinding(located.record, assertion.asOf ?? now, {
        assertionId: assertion.assertionId,
        evidenceRef: reference.evidenceRef,
      })
      if (validityFinding !== undefined) assertionFindings.push(validityFinding)
      if (assertion.kind === 'relation_ref') {
        assertionFindings.push(...verifyRelationEdge(assertion, reference, located.payload))
      }
      if (assertion.kind === 'document_quote') {
        assertionFindings.push(...verifyDocumentCitation(assertion, reference, located))
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
