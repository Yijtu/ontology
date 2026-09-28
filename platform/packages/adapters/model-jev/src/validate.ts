import type {
  DecisionQuestion,
  DecisionResult,
  DecisionScore,
} from '@ontology/contracts'
import { EMPTY_OPTION_SET_HASH, PROBABILITY_SUM_EPSILON } from './constants'
import { JevAdapterError } from './errors'
import type { JevWireAnswer, JevWireBinding, JevWireResponse } from './vendor/jev-wire'

const SCORE_MEAN_EPSILON = 1e-3

/**
 * Validate a System One response against the exact request plan. System One's option sets,
 * question ids, score levels and definition versions are mapped back to the local platform
 * contract; the vendor is never trusted to return our hashes or versions.
 */
export type JevValidationOutcome =
  | {
      readonly kind: 'ok'
      readonly results: readonly DecisionResult[]
      readonly modelVersion: string
    }
  | { readonly kind: 'error'; readonly error: JevAdapterError }

export function validateJevResponse(
  bindings: readonly JevWireBinding[],
  response: JevWireResponse,
): JevValidationOutcome {
  const expected = new Set(bindings.map((binding) => binding.wireQuestionId))
  for (const wireQuestionId of Object.keys(response.answers)) {
    if (!expected.has(wireQuestionId)) {
      return fail('the JEV response returned an unasked question id')
    }
  }

  const byQuestion = new Map<string, DecisionResult>()
  const scoreGroups = new Map<string, { readonly question: Extract<DecisionQuestion, { type: 'score' }>; scores: DecisionScore[] }>()
  for (const binding of bindings) {
    const answer = response.answers[binding.wireQuestionId]
    if (answer === undefined) {
      return fail(`the JEV response did not answer question ${binding.question.questionId}`)
    }
    const validated = validateAnswer(binding, answer)
    if ('error' in validated) return { kind: 'error', error: validated.error }
    if (validated.questionType !== 'score') {
      byQuestion.set(binding.question.questionId, validated.result)
      continue
    }
    if (binding.question.type !== 'score') return fail('a non-score request produced an expanded score answer')
    const group = scoreGroups.get(binding.question.questionId) ?? { question: binding.question, scores: [] }
    scoreGroups.set(binding.question.questionId, group)
    group.scores.push(validated.score)
  }

  const results: DecisionResult[] = []
  const questionIds = new Set(bindings.map((binding) => binding.question.questionId))
  for (const questionId of questionIds) {
    const result = byQuestion.get(questionId)
    if (result !== undefined) {
      results.push(result)
      continue
    }
    const group = scoreGroups.get(questionId)
    if (group === undefined || group.scores.length !== group.question.options.length) {
      return fail(`the JEV response did not complete score question ${questionId}`)
    }
    const expectedIds = new Set(group.question.options.map((option) => option.optionId))
    if (
      group.scores.length !== expectedIds.size ||
      group.scores.some((score) => !expectedIds.has(score.optionId))
    ) {
      return fail(`the JEV response repeated or changed a candidate for question ${questionId}`)
    }
    results.push({
      questionId,
      questionType: 'score',
      definitionVersion: group.question.definitionVersion,
      optionSetHash: group.question.optionSetHash,
      scores: group.scores,
    })
  }
  return { kind: 'ok', results, modelVersion: response.model }
}

function validateAnswer(
  binding: JevWireBinding,
  answer: JevWireAnswer,
): ValidatedWireResult | { readonly error: JevAdapterError } {
  const question = binding.question
  switch (question.type) {
    case 'choice':
      if (answer.type !== 'choice') return { error: invalidSchema(`question ${question.questionId} was not answered as choice`) }
      return validateChoice(question, answer)
    case 'score':
      if (answer.type !== 'score') return { error: invalidSchema(`question ${question.questionId} was not answered as score`) }
      return validateScore(question, binding, answer)
    case 'noul':
      if (answer.type !== 'noul') return { error: invalidSchema(`question ${question.questionId} was not answered as noul`) }
      return validateNoul(question, answer.noul)
  }
}

type ValidatedWireResult =
  | { readonly questionType: 'choice'; readonly result: DecisionResult }
  | { readonly questionType: 'score'; readonly score: DecisionScore }
  | { readonly questionType: 'noul'; readonly result: DecisionResult }

function validateChoice(
  question: Extract<DecisionQuestion, { type: 'choice' }>,
  answer: Extract<JevWireAnswer, { type: 'choice' }>,
): ValidatedWireResult | { readonly error: JevAdapterError } {
  const probabilities = readProbabilityEntries(
    question.options.map((option) => option.optionId),
    answer.probabilities,
    `question ${question.questionId}`,
  )
  if ('error' in probabilities) return probabilities
  const selected = question.options.find((option) => option.optionId === answer.choice)
  if (selected === undefined) {
    return { error: invalidSchema(`question ${question.questionId} selected an unknown option`) }
  }
  const selectedProbability = answer.probabilities[selected.optionId]
  const highest = Math.max(...probabilities.values.map((entry) => entry.probability))
  if (selectedProbability !== highest) {
    return { error: invalidSchema(`question ${question.questionId} choice was not the highest-probability option`) }
  }
  if (!isProbability(answer.confidence)) {
    return { error: invalidSchema(`question ${question.questionId} confidence is outside [0, 1]`) }
  }
  return {
    questionType: 'choice',
    result: {
        questionId: question.questionId,
        questionType: 'choice',
        definitionVersion: question.definitionVersion,
        optionSetHash: question.optionSetHash,
        selectedOptionId: selected.optionId,
        distribution: { optionSetHash: question.optionSetHash, entries: probabilities.values },
        confidence: answer.confidence,
    },
  }
}

function validateScore(
  question: Extract<DecisionQuestion, { type: 'score' }>,
  binding: JevWireBinding,
  answer: Extract<JevWireAnswer, { type: 'score' }>,
): ValidatedWireResult | { readonly error: JevAdapterError } {
  const optionId = binding.scoreOptionId
  const criteria = binding.scoreCriteria
  if (optionId === undefined || criteria.length < 2 || criteria.length > 10) {
    return { error: invalidSchema(`question ${question.questionId} has an invalid score expansion`) }
  }
  const levelIds = criteria.map((_criterion, index) => String(index))
  const probabilities = readProbabilityEntries(levelIds, answer.probabilities, `question ${question.questionId}`)
  if ('error' in probabilities) return probabilities
  const expectedLegend = new Map(criteria.map((criterion, index) => [String(index), criterion]))
  if (Object.keys(answer.legend).length !== expectedLegend.size) {
    return { error: invalidSchema(`question ${question.questionId} returned an incomplete score legend`) }
  }
  for (const [levelId, description] of expectedLegend) {
    if (answer.legend[levelId] !== description) {
      return {
        error: invalidSchema(
          `question ${question.questionId} returned a different score legend at level ${levelId}`,
        ),
      }
    }
  }
  if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > criteria.length - 1) {
    return { error: invalidSchema(`question ${question.questionId} score is outside its ordered rubric`) }
  }
  const expectedMean = probabilities.values.reduce(
    (sum, entry) => sum + Number(entry.optionId) * entry.probability,
    0,
  )
  if (Math.abs(answer.score - expectedMean) > SCORE_MEAN_EPSILON) {
    return { error: invalidSchema(`question ${question.questionId} score did not match its probability-weighted levels`) }
  }
  if (!isProbability(answer.confidence)) {
    return { error: invalidSchema(`question ${question.questionId} confidence is outside [0, 1]`) }
  }
  const mappedScore = question.scale.min +
    (answer.score / (criteria.length - 1)) * (question.scale.max - question.scale.min)
  return {
    questionType: 'score',
    score: { optionId, score: mappedScore, confidence: answer.confidence },
  }
}

function validateNoul(
  question: Extract<DecisionQuestion, { type: 'noul' }>,
  noul: number,
): ValidatedWireResult | { readonly error: JevAdapterError } {
  if (!isProbability(noul)) {
    return { error: invalidSchema(`question ${question.questionId} noul likelihood is outside [0, 1]`) }
  }
  return {
    questionType: 'noul',
    result: {
        questionId: question.questionId,
        questionType: 'noul',
        definitionVersion: question.definitionVersion,
        optionSetHash: EMPTY_OPTION_SET_HASH,
        probability: noul,
    },
  }
}

function readProbabilityEntries(
  expectedIds: readonly string[],
  values: Readonly<Record<string, number>>,
  label: string,
): { readonly values: { readonly optionId: string; readonly probability: number }[] } | { readonly error: JevAdapterError } {
  const keys = Object.keys(values)
  if (keys.length !== expectedIds.length) {
    return { error: invalidSchema(`${label} probability map had the wrong number of options`) }
  }
  const expected = new Set(expectedIds)
  const entries: { optionId: string; probability: number }[] = []
  for (const key of keys) {
    if (!expected.has(key)) {
      return { error: invalidSchema(`${label} returned an unknown probability option`) }
    }
    const probability = values[key]
    if (probability === undefined || !isProbability(probability)) {
      return { error: invalidSchema(`${label} probability is outside [0, 1]`) }
    }
  }
  let sum = 0
  for (const id of expectedIds) {
    const probability = values[id]
    if (probability === undefined) {
      return { error: invalidSchema(`${label} probability map is missing a requested option`) }
    }
    sum += probability
    entries.push({ optionId: id, probability })
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_EPSILON) {
    return { error: invalidSchema(`${label} probabilities are not normalised (sum=${String(sum)})`) }
  }
  return { values: entries }
}

function isProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function fail(message: string): JevValidationOutcome {
  return { kind: 'error', error: invalidSchema(message) }
}

function invalidSchema(message: string): JevAdapterError {
  return new JevAdapterError('INVALID_SCHEMA', message)
}
