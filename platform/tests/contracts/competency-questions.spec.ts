import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assertCompetencyQuestionSet, requireExternalCompetencyGold,
} from '@ontology/contracts'
import type { CompetencyQuestionSet } from '@ontology/contracts'
import { validateDefinitionVersion, definitionVersionDigest } from '@ontology/semantic-engine'
import { loadCompetencyQuestions, competencyQuestionBoundary } from '../fixtures/competency-questions/loader'
import { COMPETENCY_ASSETS, CQ_ADDITIONAL_SOURCES, byteDigest, competencyDigest, competencyFixtureDocument } from '../fixtures/competency-questions/assets'

const boundary = competencyQuestionBoundary()
const sets = loadCompetencyQuestions()
const first = sets[0]!
function reject(mutator: (value: CompetencyQuestionSet) => void, code = 'INVALID_DECLARATION', rehash = true) {
  const value = structuredClone(first)
  mutator(value)
  if (rehash) value.ref.digest = competencyDigest(value.body)
  expect(() => assertCompetencyQuestionSet(value, boundary)).toThrowError(expect.objectContaining({ code }))
}

describe('versioned independent competency declarations', () => {
  it('loads two immutable synthetic industries and at least twelve independently authored gold cases', () => {
    expect(sets).toHaveLength(2)
    expect(sets.reduce((count, set) => count + set.body.questions.length, 0)).toBeGreaterThanOrEqual(12)
    expect(sets.map((set) => set.body.industryId)).toEqual(['transport-synthetic', 'industrial-synthetic'])
    for (const set of sets) {
      assertCompetencyQuestionSet(set, boundary, set.ref)
      expect(set.body.execution).toBe('not_run')
      expect(set.body.classification).toBe('synthetic_demo_not_an_industry_standard')
      for (const question of set.body.questions) {
        expect(question.goldOrigin).toBe('authored_oracle')
        expect(question.derivation.trim().length).toBeGreaterThan(20)
      }
    }
    expect(loadCompetencyQuestions()).toEqual(sets)
  })

  it('pins actual authored definition/rule assets without evaluating gold', () => {
    for (const assets of Object.values(COMPETENCY_ASSETS)) {
      for (const definition of assets.definitions) {
        expect(definitionVersionDigest(definition.draft)).toBe(definition.ref.digest)
        expect(validateDefinitionVersion(definition.draft)).toEqual([])
      }
      for (const rule of assets.rules) expect(competencyDigest({ declaration: rule.declaration, source: rule.source })).toBe(rule.ref.digest)
    }
  })

  it('checks original LF bytes and every exact quote range instead of normalizing into a passing pin', () => {
    for (const [index, industry] of (['transport', 'industrial'] as const).entries()) {
      const bytes = readFileSync(new URL(`../fixtures/competency-questions/${industry}.source.txt`, import.meta.url))
      expect(bytes.includes(13)).toBe(false)
      expect(byteDigest(bytes)).toBe(COMPETENCY_ASSETS[industry].document.ref.digest)
      const originals = [{ ref: COMPETENCY_ASSETS[industry].document.ref, bytes }, ...CQ_ADDITIONAL_SOURCES.filter((source) => source.industry === industry).map((source) => ({ ref: source.document.ref, bytes: readFileSync(new URL(`../fixtures/competency-questions/${source.filename}`, import.meta.url)) }))]
      for (const question of sets[index]!.body.questions) for (const location of question.requiredSources) {
        const actual = originals.find((original) => original.ref.digest === location.sourceRef.digest && original.ref.id === location.sourceRef.id)?.bytes
        expect(actual).toBeDefined()
        expect(location.offsetUnit).toBe('utf8_byte')
        expect(byteDigest(actual!.subarray(location.startOffset, location.endOffset))).toBe(location.quoteDigest)
      }
    }
  })

  it('uses the same UTF-8 byte offsets for non-ASCII source authoring and read-back', () => {
    const doc = competencyFixtureDocument('unicode', '说明：计费金额为12.50元。尾部。')
    const quote = '计费金额为12.50元'
    const location = doc.location(quote)
    const bytes = Buffer.from(doc.text, 'utf8')
    expect(location.startOffset).toBe(Buffer.byteLength('说明：', 'utf8'))
    expect(bytes.subarray(location.startOffset, location.endOffset).toString('utf8')).toBe(quote)
    expect(byteDigest(bytes.subarray(location.startOffset, location.endOffset))).toBe(location.quoteDigest)
  })

  it('contains literal business expectations for exact sums, all four states, exceptions, history, withdrawal and versions', () => {
    const questions = sets.flatMap((set) => set.body.questions)
    expect(questions.find((question) => question.questionId === 'transport-sum')?.expected).toEqual({ kind: 'value', value: { amount: '17.5', unit: 'm' } })
    expect(questions.find((question) => question.questionId === 'industrial-sum')?.expected).toEqual({ kind: 'value', value: { amount: '150', unit: 'h' } })
    const states = questions.flatMap((question) => question.expected.kind === 'rule' ? [question.expected.conditionState] : [])
    expect(new Set(states)).toEqual(new Set(['true', 'false', 'unknown', 'conflict']))
    expect(questions.find((question) => question.questionId === 'transport-exception')?.expected).toEqual({ kind: 'rule', conditionState: 'true', applicability: 'not_applicable', propositionState: 'unknown' })
    expect(questions.find((question) => question.questionId === 'industrial-one-withdrawal')?.expected).toMatchObject({ conditionState: 'true' })
    expect(questions.find((question) => question.questionId === 'industrial-last-withdrawal')?.expected).toMatchObject({ conditionState: 'unknown' })
    expect(questions.find((question) => question.questionId === 'industrial-historical')?.expected).toMatchObject({ conditionState: 'true' })
    expect(questions.find((question) => question.questionId === 'industrial-version-one-denial')?.expected).toEqual({ kind: 'refusal', reason: 'definition_version_mismatch' })
  })

  it('preserves cross-project denial inputs without silently rewriting them into the authorized project', () => {
    const denial = first.body.questions.find((question) => question.questionId === 'transport-project-denial')!
    expect(denial.intent.projectId).not.toBe(denial.input.projectId)
    expect(denial.expected).toEqual({ kind: 'refusal', reason: 'cross_project' })
  })
  it('declares actual relation and finite registered compute tasks independently of SQL quantity sums', () => {
    const questions = sets.flatMap((set) => set.body.questions)
    expect(questions.filter((question) => question.intent.kind === 'registered_compute')).toHaveLength(2)
    expect(questions.filter((question) => question.intent.kind === 'relation')).toHaveLength(2)
    expect(questions.find((question) => question.questionId === 'transport-registered-compute')?.expected).toEqual({ kind: 'value', value: { amount: '17.5', unit: 'each' } })
    expect(questions.find((question) => question.questionId === 'industrial-registered-compute')?.expected).toEqual({ kind: 'value', value: { amount: '39', currency: 'CNY' } })
    expect(questions.find((question) => question.questionId === 'transport-sum')?.taskKind).toBe('structured_query')
    expect(questions.find((question) => question.questionId === 'industrial-one-withdrawal')?.input.structuredSources?.map((source) => source.sourceRef.id)).toContain('cq.industrial.alarm.source')
  })
  it.each(['operation', 'metric', 'source'])('rejects unregistered or unpinned compute selector (%s)', (change) => {
    reject((value) => {
      const question = value.body.questions.find((item) => item.intent.kind === 'registered_compute')!
      if (question.intent.kind !== 'registered_compute') throw new Error('missing compute question')
      if (change === 'operation') Object.assign(question.intent.operationRef, { id: 'arbitrary.eval' })
      if (change === 'metric') Object.assign(question.intent, { metric: '/customer/private-price' })
      if (change === 'source') question.intent.inputSourceRef = { ...question.intent.inputSourceRef, version: '99.0.0' }
    }, change === 'source' ? 'UNKNOWN_PIN' : 'INVALID_DECLARATION')
  })

  it('rejects changes under an unchanged envelope digest and a wrong requested pin', () => {
    reject((value) => { value.body.questions[0]!.question = 'changed declaration' }, 'DIGEST_MISMATCH', false)
    expect(() => assertCompetencyQuestionSet(first, boundary, { ...first.ref, version: '2.0.0' })).toThrowError(expect.objectContaining({ code: 'DIGEST_MISMATCH' }))
  })
  it('rejects unknown definition/rule pins and undeclared capabilities after a valid body rehash', () => {
    reject((value) => { value.body.questions[0]!.definitionRef.digest = `sha256:${'f'.repeat(64)}` }, 'UNKNOWN_PIN')
    reject((value) => { value.body.questions[0]!.ruleRefs.push({ id: 'fake-rule', version: '1.0.0', digest: `sha256:${'f'.repeat(64)}` }) }, 'UNKNOWN_PIN')
    reject((value) => { value.body.questions[0]!.requiredCapabilities.push('arbitrary_eval') }, 'UNDECLARED_CAPABILITY')
  })
  it('rejects contradictory task kinds, duplicate IDs and a rule intent with no pinned rule', () => {
    reject((value) => { value.body.questions[0]!.taskKind = 'compute' })
    reject((value) => { value.body.questions[1]!.questionId = value.body.questions[0]!.questionId })
    reject((value) => { value.body.questions.find((question) => question.intent.kind === 'rule')!.ruleRefs = [] }, 'UNKNOWN_PIN')
  })
  it.each(['observation', 'relation'] as const)('rejects unknown input %s source pins', (kind) => {
    const value = structuredClone(first)
    const question = kind === 'observation' ? value.body.questions[0]! : value.body.questions.find((item) => item.input.relations.length > 0)!
    const location = kind === 'observation' ? question.input.observations[0]!.source : question.input.relations[0]!.source
    location.sourceRef = { ...location.sourceRef, version: '99.0.0' }
    value.ref.digest = competencyDigest(value.body)
    expect(() => assertCompetencyQuestionSet(value, boundary)).toThrowError(expect.objectContaining({ code: 'UNKNOWN_PIN' }))
  })
  it.each([0, -1])('rejects empty/reversed source ranges (%s)', (delta) => {
    reject((value) => { const location = value.body.questions[0]!.requiredSources[0]!; location.endOffset = location.startOffset + delta })
  })
  it('rejects an input location omitted from required evidence', () => {
    reject((value) => { value.body.questions.find((question) => question.questionId === 'transport-sum')!.requiredSources.shift() }, 'UNKNOWN_PIN')
  })
  it.each(['missing_attribute', 'missing_rule', 'conflicting_selector', 'sql', 'script'])('rejects non-executable or executable-payload selector: %s', (mutation) => {
    reject((value) => {
      const question = mutation === 'missing_rule' ? value.body.questions.find((item) => item.intent.kind === 'rule')! : value.body.questions[0]!
      if (mutation.startsWith('missing')) Object.assign(question, { intent: Object.fromEntries(Object.entries(question.intent).filter(([key]) => key !== (mutation === 'missing_rule' ? 'ruleId' : 'attributeId'))) })
      else Object.assign(question.intent, mutation === 'conflicting_selector' ? { ruleId: 'extra' } : mutation === 'sql' ? { sql: 'SELECT private_price FROM customer_table' } : { script: 'eval(payload)' })
    })
  })
  it('cannot declare customer facts, generated gold or an execution receipt as verified', () => {
    reject((value) => { Object.assign(value.body.questions[0]!.input, { dataMode: 'observed' }) })
    reject((value) => { Object.assign(value.body.questions[0]!, { goldOrigin: 'implementation_output' }) })
    reject((value) => { Object.assign(value.body, { execution: 'passed' }) })
    reject((value) => { Object.assign(value.body.externalGold, { acceptance: 'verified' }) })
    reject((value) => { value.body.questions[0]!.question = 'Authorization: Bearer test-only-prohibited-credential' })
  })
  it('keeps real human quote resources explicitly unavailable and unverified', () => {
    for (const set of sets) {
      expect(set.body.externalGold).toEqual({ status: 'missing_resources', acceptance: 'unverified', missingResources: ['authorised_quote_inputs', 'human_quote_gold', 'customer_compute_binding'] })
      expect(() => requireExternalCompetencyGold(set)).toThrowError(expect.objectContaining({ code: 'EXTERNAL_GOLD_UNAVAILABLE' }))
    }
  })
})
