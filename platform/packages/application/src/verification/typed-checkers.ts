import type {
  ResourceRef,
  Rfc3339UtcTimestamp,
  VerifiedAssertion,
  VerificationFinding,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '@ontology/core'
import type { ResolvedEvidence } from './hard-checks'
import { sourceValidityFinding } from './hard-checks'
import { resolveJsonPointer } from './pointers'

/**
 * Per-evidence-kind hard checks for the typed, non-numeric assertions (SPEC v0.3a
 * execution-evidence §EX-7.2).
 *
 * Each checker is a pure function over one assertion kind and the exact archived evidence the
 * verifier resolved from the run's evidence manifest. A result payload is untrusted archived
 * bytes, so every field a checker reads is runtime-validated here; a malformed artifact is an
 * explicit located failure, never a silent pass. The four axes the issue names are:
 *
 *  - rule judgement (+ its premises and axis), recomputed from the archived
 *    `rule-computation-artifact@1` rather than trusting a model boolean;
 *  - relation navigation endpoints/version, recomputed from the real published edge;
 *  - structured-query cells, where the row/column binding must agree with the value;
 *  - document/source citations, where the exact locator/digest chain must resolve.
 */

type Assertion = VerifiedAssertion
type AssertionBinding = Assertion['references'][number]
type RuleAssertion = Extract<Assertion, { readonly kind: 'rule_judgement' }>
type RelationAssertion = Extract<Assertion, { readonly kind: 'relation_ref' }>
type QuoteAssertion = Extract<Assertion, { readonly kind: 'document_quote' }>

const RULE_COMPUTATION_SCHEMA = 'rule-computation-artifact@1'
const RULE_DERIVATION_SUPPORT_SCHEMA = 'rule-derivation-support-payload@1'

type RuleVerdict = 'true' | 'false' | 'unknown' | 'conflict'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isVersionRef(value: unknown): value is VersionRef {
  if (!isRecord(value)) return false
  return (
    typeof value['id'] === 'string' &&
    value['id'].length > 0 &&
    typeof value['version'] === 'string' &&
    /^\d+\.\d+\.\d+$/u.test(value['version']) &&
    typeof value['digest'] === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value['digest'])
  )
}

export function sameVersionRef(left: unknown, right: unknown): boolean {
  return (
    isVersionRef(left) &&
    isVersionRef(right) &&
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  )
}

export function sameResourceRef(left: unknown, right: ResourceRef): boolean {
  if (!isRecord(left)) return false
  return (
    left['id'] === right.id &&
    left['version'] === right.version &&
    left['digest'] === right.digest &&
    left['kind'] === right.kind
  )
}

function sameRecord(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function finding(
  assertion: Assertion,
  reference: AssertionBinding | undefined,
  code: VerificationFinding['code'],
  extra: Partial<VerificationFinding> = {},
): VerificationFinding {
  return {
    code,
    axis: 'hard',
    field: assertion.predicate,
    assertionId: assertion.assertionId,
    ...(reference === undefined ? {} : { evidenceRef: reference.evidenceRef, pointer: reference.valuePointer }),
    ...extra,
  }
}

/** Resolve the archived rule computation artifact from a support payload or the artifact itself. */
function asRuleComputationArtifact(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (value['schemaVersion'] === RULE_COMPUTATION_SCHEMA) return value
  if (value['schemaVersion'] === RULE_DERIVATION_SUPPORT_SCHEMA) {
    const inner = value['artifact']
    if (isRecord(inner) && inner['schemaVersion'] === RULE_COMPUTATION_SCHEMA) return inner
  }
  return undefined
}

type RuleConditionState = 'true' | 'false' | 'unknown' | 'conflict'
type RuleApplicabilityState = 'applicable' | 'not_applicable' | 'unknown' | 'conflict'

function isConditionState(value: unknown): value is RuleConditionState {
  return value === 'true' || value === 'false' || value === 'unknown' || value === 'conflict'
}

/**
 * Independently recompute the aggregate applicability from the archived condition state and
 * the attached exception states (SPEC EX-4.1 four-state truth table). The archive's own
 * `applicability.state` is never trusted on its own: an exception that fired (or conflicts)
 * must make the rule not-applicable (or conflicting), and a definite applicability may not
 * rest on an unknown exception.
 */
function recomputeApplicabilityState(artifact: Record<string, unknown>): RuleApplicabilityState | undefined {
  const applicability = artifact['applicability']
  if (!isRecord(applicability)) return undefined
  const conditionState = applicability['conditionState']
  if (!isConditionState(conditionState)) return undefined
  const exceptionStates = applicability['exceptionStates']
  if (!Array.isArray(exceptionStates)) return undefined
  const states: RuleConditionState[] = []
  for (const exception of exceptionStates) {
    if (!isRecord(exception) || !isConditionState(exception['state'])) return undefined
    states.push(exception['state'])
  }
  if (conditionState === 'conflict' || states.includes('conflict')) return 'conflict'
  if (states.includes('true')) return 'not_applicable'
  if (conditionState === 'false') return 'not_applicable'
  if (conditionState === 'unknown' || states.includes('unknown')) return 'unknown'
  return 'applicable'
}

function applicabilityVerdict(artifact: Record<string, unknown>): RuleVerdict | undefined {
  const applicability = artifact['applicability']
  if (!isRecord(applicability)) return undefined
  const state = applicability['state']
  const positiveSupport = applicability['positiveSupport']
  switch (state) {
    case 'applicable':
      return positiveSupport === true ? 'true' : 'unknown'
    case 'not_applicable':
      return 'false'
    case 'unknown':
      return 'unknown'
    case 'conflict':
      return 'conflict'
    default:
      return undefined
  }
}

function propositionVerdict(artifact: Record<string, unknown>): RuleVerdict | undefined {
  const applicability = artifact['applicability']
  if (!isRecord(applicability)) return undefined
  const state = applicability['state']
  if (state === 'conflict') return 'conflict'
  if (state !== 'applicable') return 'unknown'
  const conclusion = artifact['businessConclusion']
  if (!isRecord(conclusion)) return 'unknown'
  const value = conclusion['value']
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return typeof value === 'undefined' ? 'unknown' : 'true'
}

function expectedRuleVerdict(
  artifact: Record<string, unknown>,
  axis: 'applicability' | 'business_proposition',
): RuleVerdict | undefined {
  return axis === 'business_proposition' ? propositionVerdict(artifact) : applicabilityVerdict(artifact)
}

/**
 * Verify one rule judgement against its archived computation artifact. It checks that the
 * artifact is the exact rule version, subject and computation the assertion names, that every
 * premise the verdict depends on is an authorised/readable evidence ref, that the computation
 * is complete, and that the asserted four-state verdict recomputes from the artifact. A wrong
 * verdict is a located hard finding regardless of any model probability.
 */
export function verifyRuleJudgement(
  assertion: RuleAssertion,
  resolved: ReadonlyMap<string, ResolvedEvidence>,
  now: Rfc3339UtcTimestamp,
): VerificationFinding[] {
  const findings: VerificationFinding[] = []
  if (assertion.references.length === 0) findings.push(finding(assertion, undefined, 'unbound_claim'))

  for (const premiseRef of assertion.premiseRefs) {
    const premise = resolved.get(premiseRef.id)
    if (premise === undefined || premise.unreadable || premise.payload === undefined) {
      findings.push(finding(assertion, undefined, 'rule_premise_missing', { evidenceRef: premiseRef }))
    }
  }

  for (const reference of assertion.references) {
    const located = resolved.get(reference.evidenceRef.id)
    if (located === undefined) {
      findings.push(finding(assertion, reference, 'evidence_not_found'))
      continue
    }
    if (!sameResourceRef(located.record.evidenceRef, reference.evidenceRef)) {
      findings.push(finding(assertion, reference, 'evidence_reference_mismatch'))
      continue
    }
    if (located.record.envelope.resultDigest !== reference.resultDigest) {
      findings.push(finding(assertion, reference, 'result_digest_mismatch', {
        expected: located.record.envelope.resultDigest,
        actual: reference.resultDigest,
      }))
      continue
    }
    if (located.unreadable || located.payload === undefined) {
      findings.push(finding(assertion, reference, 'result_unreadable'))
      continue
    }
    if (located.record.envelope.kind !== 'rule_derivation') {
      findings.push(finding(assertion, reference, 'rule_judgement_mismatch', { field: 'computation' }))
      continue
    }
    const validityFinding = sourceValidityFinding(located.record, assertion.asOf ?? now, {
      assertionId: assertion.assertionId,
      evidenceRef: reference.evidenceRef,
    })
    if (validityFinding !== undefined) {
      findings.push(validityFinding)
      continue
    }

    const pointer = reference.rulePointer ?? reference.computationPointer ?? ''
    const candidate = resolveJsonPointer(located.payload, pointer)
    const artifact = candidate.found ? asRuleComputationArtifact(candidate.value) : undefined
    if (artifact === undefined) {
      findings.push(finding(assertion, reference, 'rule_judgement_mismatch', { field: 'computation', pointer }))
      continue
    }
    if (!sameVersionRef(artifact['ruleRef'], assertion.ruleRef)) {
      findings.push(finding(assertion, reference, 'rule_judgement_mismatch', { field: 'ruleRef' }))
      continue
    }
    const artifactSubject = artifact['subjectEntityId']
    if (typeof artifactSubject === 'string' && artifactSubject !== assertion.subject) {
      findings.push(finding(assertion, reference, 'subject_mismatch', {
        field: 'subject',
        expected: artifactSubject,
        actual: assertion.subject,
      }))
      continue
    }
    const recomputedState = recomputeApplicabilityState(artifact)
    const applicability = artifact['applicability']
    const archivedState = isRecord(applicability) ? applicability['state'] : undefined
    if (recomputedState === undefined || recomputedState !== archivedState) {
      findings.push(finding(assertion, reference, 'rule_judgement_mismatch', {
        field: 'applicability',
        expected: recomputedState ?? 'computable condition/exception states',
        actual: typeof archivedState === 'string' ? archivedState : 'absent',
      }))
      continue
    }
    if (artifact['complete'] !== true) {
      findings.push(finding(assertion, reference, 'rule_premise_missing', { field: 'complete' }))
      continue
    }
    if (assertion.computationDigest !== undefined) {
      const artifactDigest = artifact['computationDigest']
      if (artifactDigest !== assertion.computationDigest) {
        findings.push(finding(assertion, reference, 'rule_judgement_mismatch', {
          field: 'computationDigest',
          expected: typeof artifactDigest === 'string' ? artifactDigest : 'absent',
          actual: assertion.computationDigest,
        }))
        continue
      }
    }

    const expected = expectedRuleVerdict(artifact, assertion.judgementAxis ?? 'applicability')
    if (expected === undefined) {
      findings.push(finding(assertion, reference, 'rule_judgement_mismatch', { field: 'applicability' }))
      continue
    }
    if (expected !== assertion.value) {
      findings.push(finding(assertion, reference, 'rule_judgement_mismatch', {
        field: 'verdict',
        expected,
        actual: assertion.value,
      }))
      continue
    }
    if (assertion.asOf !== undefined && reference.timePointer !== undefined) {
      const observed = resolveJsonPointer(located.payload, reference.timePointer)
      if (!observed.found || observed.value !== assertion.asOf) {
        findings.push(finding(assertion, reference, 'time_mismatch', {
          field: 'time',
          expected: typeof observed.value === 'string' ? observed.value : 'absent',
          actual: assertion.asOf,
        }))
      }
    }
  }
  return findings
}

/**
 * Verify one relation assertion against the real published edge it cites. Endpoints, direction,
 * the relation id and the pinned definition/statement version must all match; a swapped
 * endpoint or a drifted version is a located failure, never an invisible error.
 */
export function verifyRelationEdge(
  assertion: RelationAssertion,
  reference: AssertionBinding,
  payload: unknown,
): VerificationFinding[] {
  const pointer = reference.relationPointer ?? reference.valuePointer
  const resolved = resolveJsonPointer(payload, pointer)
  if (!resolved.found || !isRecord(resolved.value)) {
    return [finding(assertion, reference, 'relation_endpoint_mismatch', { pointer, expected: 'a published relation edge' })]
  }
  const hop = resolved.value
  const findings: VerificationFinding[] = []

  const fromId = hop['fromEntityId']
  const toId = hop['toEntityId']
  const fromRef = hop['fromRef']
  const toRef = hop['toRef']
  const relationId = hop['relationId']

  if (relationId !== assertion.value.type) {
    findings.push(finding(assertion, reference, 'relation_endpoint_mismatch', {
      field: 'type',
      expected: assertion.value.type,
      actual: typeof relationId === 'string' ? relationId : 'absent',
    }))
  }
  const hasFrom = typeof fromId === 'string' || isRecord(fromRef)
  const hasTo = typeof toId === 'string' || isRecord(toRef)
  if (!hasFrom || !hasTo) {
    findings.push(finding(assertion, reference, 'relation_endpoint_mismatch', { pointer, expected: 'both endpoints' }))
    return findings
  }
  if ((typeof fromId === 'string' && fromId !== assertion.value.from.id) ||
      (isRecord(fromRef) && !sameResourceRef(fromRef, assertion.value.from))) {
    findings.push(finding(assertion, reference, 'relation_endpoint_mismatch', {
      field: 'from',
      expected: assertion.value.from.id,
      actual: typeof fromId === 'string' ? fromId : 'mismatched ref',
    }))
  }
  if ((typeof toId === 'string' && toId !== assertion.value.to.id) ||
      (isRecord(toRef) && !sameResourceRef(toRef, assertion.value.to))) {
    findings.push(finding(assertion, reference, 'relation_endpoint_mismatch', {
      field: 'to',
      expected: assertion.value.to.id,
      actual: typeof toId === 'string' ? toId : 'mismatched ref',
    }))
  }
  if (assertion.definitionRef !== undefined && !sameVersionRef(hop['definitionRef'], assertion.definitionRef)) {
    findings.push(finding(assertion, reference, 'relation_version_mismatch', { field: 'definitionRef' }))
  }
  if (assertion.statementId !== undefined && hop['statementId'] !== assertion.statementId) {
    findings.push(finding(assertion, reference, 'relation_version_mismatch', { field: 'statementId' }))
  }
  if (assertion.statementVersion !== undefined && hop['statementVersion'] !== assertion.statementVersion) {
    findings.push(finding(assertion, reference, 'relation_version_mismatch', { field: 'statementVersion' }))
  }
  return findings
}

/**
 * Verify one exact document citation. The quoted bytes, the archived quote/text digests, the
 * document ref and the locator must all resolve to the same immutable span; an approximate
 * locator can never satisfy an exact quote, and a different document carrying the same text is
 * not a substitute. A resolution failure distinguishes a mismatch from missing evidence.
 */
export function verifyDocumentCitation(
  assertion: QuoteAssertion,
  reference: AssertionBinding,
  located: ResolvedEvidence,
): VerificationFinding[] {
  const payload = located.payload
  if (payload === undefined) return [finding(assertion, reference, 'result_unreadable')]
  const findings: VerificationFinding[] = []
  if (located.record.envelope.kind !== 'document_span') {
    findings.push(finding(assertion, reference, 'citation_locator_mismatch', { field: 'kind' }))
  }
  const quoteDigest = sha256DigestOf(assertion.quote)
  const archivedQuote = resolveJsonPointer(payload, reference.valuePointer).value
  const document = reference.documentPointer === undefined ? undefined : resolveJsonPointer(payload, reference.documentPointer).value
  const locator = reference.locatorPointer === undefined ? undefined : resolveJsonPointer(payload, reference.locatorPointer).value
  const textDigest = reference.textDigestPointer === undefined ? undefined : resolveJsonPointer(payload, reference.textDigestPointer).value
  const storedQuoteDigest = reference.quoteDigestPointer === undefined ? undefined : resolveJsonPointer(payload, reference.quoteDigestPointer).value

  if (
    assertion.precision !== 'exact' ||
    archivedQuote !== assertion.quote ||
    quoteDigest !== assertion.quoteDigest ||
    textDigest !== assertion.textDigest ||
    storedQuoteDigest !== assertion.quoteDigest
  ) {
    findings.push(finding(assertion, reference, 'document_quote_mismatch', { field: 'quote' }))
  }
  if (
    reference.documentPointer === undefined ||
    !sameResourceRef(document, assertion.documentRef) ||
    reference.locatorPointer === undefined ||
    !sameRecord(locator, assertion.locator)
  ) {
    findings.push(finding(assertion, reference, 'citation_locator_mismatch', { pointer: reference.locatorPointer ?? reference.valuePointer }))
  }
  if (assertion.documentVersionRef !== undefined) {
    const version = reference.documentVersionPointer === undefined ? undefined : resolveJsonPointer(payload, reference.documentVersionPointer).value
    if (version === undefined || !sameResourceRef(version, assertion.documentVersionRef)) {
      findings.push(finding(assertion, reference, 'citation_locator_mismatch', { field: 'documentVersion' }))
    }
  }
  return findings
}

/** Assertion kinds whose value must be resolved through a table cell/field binding. */
export function isFieldBoundAssertionKind(kind: Assertion['kind']): boolean {
  return kind !== 'document_quote' && kind !== 'artifact_summary' && kind !== 'rule_judgement' && kind !== 'relation_ref'
}
