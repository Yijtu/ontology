import { describe, expect, it } from 'vitest'
import { readRuleJudgementRequest } from '../../apps/api/src/composition/core-rule-judgement-handler'

/**
 * The typed rule-judgement request reader fails closed: a missing, malformed or partial request
 * is refused before the producer is ever reached, so an ordinary `ontology_lookup` call can
 * never be silently reinterpreted as a rule derivation.
 */

const RULE_REF = { id: 'rule-1', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` }
const DEFINITION_REF = { id: 'definition-1', version: '1.0.0', digest: `sha256:${'b'.repeat(64)}` }

function validRequest(): Record<string, unknown> {
  return {
    kind: 'rule_judgement',
    ruleRef: RULE_REF,
    definitionRef: DEFINITION_REF,
    objectId: 'facility',
    subjectEntityId: '11111111-1111-4111-8111-111111111111',
    validAt: '2026-09-30T00:00:00Z',
    asOfRecordedSeq: '1',
  }
}

describe('readRuleJudgementRequest (fail-closed typed request)', () => {
  it('accepts a complete typed request and preserves the bitemporal point', () => {
    expect(readRuleJudgementRequest({ request: validRequest() })).toEqual({
      kind: 'rule_judgement',
      ruleRef: RULE_REF,
      definitionRef: DEFINITION_REF,
      objectId: 'facility',
      subjectEntityId: '11111111-1111-4111-8111-111111111111',
      validAt: '2026-09-30T00:00:00Z',
      asOfRecordedSeq: '1',
    })
  })

  it('returns undefined when there is no request or the kind is not rule_judgement', () => {
    expect(readRuleJudgementRequest({})).toBeUndefined()
    expect(readRuleJudgementRequest({ request: { kind: 'facts' } })).toBeUndefined()
  })

  it('returns undefined when any required field is missing or malformed', () => {
    const missing = validRequest()
    delete missing['validAt']
    expect(readRuleJudgementRequest({ request: missing })).toBeUndefined()

    const badRuleRef = validRequest()
    badRuleRef['ruleRef'] = { id: 'rule-1', version: '1.0.0', digest: 'not-a-digest' }
    expect(readRuleJudgementRequest({ request: badRuleRef })).toBeUndefined()

    const badAxis = validRequest()
    badAxis['judgementAxis'] = 'nonsense'
    expect(readRuleJudgementRequest({ request: badAxis })).toBeUndefined()
  })
})
