import type {
  DecisionQuestion,
  DecisionResult,
  DecisionScore,
  ProbabilityDistribution,
} from '@ontology/contracts'
import { EMPTY_OPTION_SET_HASH, PROBABILITY_SUM_EPSILON } from './constants'
import { JevAdapterError } from './errors'
import type { JevWireDistribution, JevWireResponse, JevWireResult, JevWireScore } from './vendor/jev-wire'

/**
 * Strict validation of a decoded JEV response against the questions that were asked
 * (SPEC C2). Every failure is an explicit typed error: an out-of-range or non-normalised
 * probability, a missing option, an option outside the question's set, an unknown
 * question type and a malformed response are all rejected — never silently accepted or
 * default-filled.
 */
export type JevValidationOutcome =
  | {
      readonly kind: 'ok'
      readonly results: readonly DecisionResult[]
      readonly modelVersion: string
    }
  | { readonly kind: 'error'; readonly error: JevAdapterError }

export function validateJevResponse(
  questions: readonly DecisionQuestion[],
  response: JevWireResponse,
  redact: (text: string) => string,
): JevValidationOutcome {
  const byQuestionId = new Map<string, JevWireResult>()
  for (const result of response.results) {
    if (byQuestionId.has(result.question_id)) {
      return fail(`the JEV response answered question ${redact(result.question_id)} more than once`)
    }
    byQuestionId.set(result.question_id, result)
  }

  const known = new Set(questions.map((question) => question.questionId))
  for (const result of response.results) {
    if (!known.has(result.question_id)) {
      return fail(`the JEV response returned an unasked question ${redact(result.question_id)}`)
    }
  }

  const results: DecisionResult[] = []
  for (const question of questions) {
    const result = byQuestionId.get(question.questionId)
    if (result === undefined) {
      return fail(`the JEV response did not answer question ${question.questionId}`)
    }
    const validated = validateResult(question, result, redact)
    if ('error' in validated) return { kind: 'error', error: validated.error }
    results.push(validated.result)
  }

  return { kind: 'ok', results, modelVersion: response.model_version }
}

function validateResult(
  question: DecisionQuestion,
  result: JevWireResult,
  redact: (text: string) => string,
): { readonly result: DecisionResult } | { readonly error: JevAdapterError } {
  const label = `question ${question.questionId}`
  if (!isQuestionType(result.question_type)) {
    return { error: invalidSchema(`${label} reported an unknown question type ${redact(result.question_type)}`) }
  }
  if (result.question_type !== question.type) {
    return {
      error: invalidSchema(
        `${label} was asked as ${question.type} but answered as ${result.question_type}`,
      ),
    }
  }
  if (result.definition_version !== question.definitionVersion) {
    return {
      error: invalidSchema(
        `${label} answered definition version ${redact(result.definition_version)} instead of ${question.definitionVersion}`,
      ),
    }
  }

  switch (question.type) {
    case 'choice':
      return validateChoice(question, result, label, redact)
    case 'score':
      return validateScore(question, result, label, redact)
    case 'noul':
      return validateNoul(question, result, label)
  }
}

function validateChoice(
  question: Extract<DecisionQuestion, { type: 'choice' }>,
  result: JevWireResult,
  label: string,
  redact: (text: string) => string,
): { readonly result: DecisionResult } | { readonly error: JevAdapterError } {
  if (result.option_set_hash !== question.optionSetHash) {
    return { error: invalidSchema(`${label} answered a different option set hash`) }
  }
  if (result.scores !== undefined) {
    return { error: invalidSchema(`${label} is a choice question and must not carry scores`) }
  }
  if (result.distribution === undefined) {
    return { error: invalidSchema(`${label} did not carry a probability distribution`) }
  }
  const distribution = normaliseDistribution(question, result.distribution, label, redact)
  if ('error' in distribution) return distribution

  let selectedOptionId: string | undefined
  if (result.selected_option_id !== undefined) {
    if (!question.options.some((option) => option.optionId === result.selected_option_id)) {
      return {
        error: invalidSchema(
          `${label} selected option ${redact(result.selected_option_id)} outside the question option set`,
        ),
      }
    }
    selectedOptionId = result.selected_option_id
  }
  const confidence = readConfidence(result.confidence, `${label} confidence`)
  if (confidence !== undefined && 'error' in confidence) return { error: confidence.error }

  return {
    result: {
      questionId: question.questionId,
      questionType: 'choice',
      definitionVersion: question.definitionVersion,
      optionSetHash: question.optionSetHash,
      ...(selectedOptionId === undefined ? {} : { selectedOptionId }),
      distribution: distribution.distribution,
      ...(confidence === undefined || 'error' in confidence
        ? {}
        : { confidence: confidence.value }),
    },
  }
}

function validateScore(
  question: Extract<DecisionQuestion, { type: 'score' }>,
  result: JevWireResult,
  label: string,
  redact: (text: string) => string,
): { readonly result: DecisionResult } | { readonly error: JevAdapterError } {
  if (result.option_set_hash !== question.optionSetHash) {
    return { error: invalidSchema(`${label} answered a different option set hash`) }
  }
  if (result.distribution !== undefined) {
    return { error: invalidSchema(`${label} is a score question and must not carry a distribution`) }
  }
  if (result.scores === undefined) {
    return { error: invalidSchema(`${label} did not carry scores`) }
  }
  const scores = normaliseScores(question, result.scores, label, redact)
  if ('error' in scores) return scores

  const confidence = readConfidence(result.confidence, `${label} confidence`)
  if (confidence !== undefined && 'error' in confidence) return { error: confidence.error }

  return {
    result: {
      questionId: question.questionId,
      questionType: 'score',
      definitionVersion: question.definitionVersion,
      optionSetHash: question.optionSetHash,
      scores: scores.scores,
      ...(confidence === undefined || 'error' in confidence
        ? {}
        : { confidence: confidence.value }),
    },
  }
}

function validateNoul(
  question: Extract<DecisionQuestion, { type: 'noul' }>,
  result: JevWireResult,
  label: string,
): { readonly result: DecisionResult } | { readonly error: JevAdapterError } {
  if (result.distribution !== undefined || result.scores !== undefined) {
    return { error: invalidSchema(`${label} is a noul question and has no option set or scores`) }
  }
  if (result.selected_option_id !== undefined) {
    return { error: invalidSchema(`${label} is a noul question and must not select an option`) }
  }
  const confidence = readConfidence(result.confidence, `${label} confidence`)
  if (confidence !== undefined && 'error' in confidence) return { error: confidence.error }
  return {
    result: {
      questionId: question.questionId,
      questionType: 'noul',
      definitionVersion: question.definitionVersion,
      optionSetHash: EMPTY_OPTION_SET_HASH,
      ...(confidence === undefined || 'error' in confidence
        ? {}
        : { confidence: confidence.value }),
    },
  }
}

function normaliseDistribution(
  question: Extract<DecisionQuestion, { type: 'choice' }>,
  distribution: JevWireDistribution,
  label: string,
  redact: (text: string) => string,
): { readonly distribution: ProbabilityDistribution } | { readonly error: JevAdapterError } {
  if (distribution.option_set_hash !== question.optionSetHash) {
    return { error: invalidSchema(`${label} distribution carries a different option set hash`) }
  }
  const entries = new Map<string, number>()
  for (const entry of distribution.entries) {
    if (entries.has(entry.option_id)) {
      return { error: invalidSchema(`${label} distribution repeats option ${redact(entry.option_id)}`) }
    }
    if (entry.probability < 0 || entry.probability > 1) {
      return {
        error: invalidSchema(
          `${label} probability for ${redact(entry.option_id)} is outside [0, 1]`,
        ),
      }
    }
    entries.set(entry.option_id, entry.probability)
  }

  const normalised: { optionId: string; probability: number }[] = []
  let sum = 0
  for (const option of question.options) {
    const probability = entries.get(option.optionId)
    if (probability === undefined) {
      return { error: invalidSchema(`${label} distribution is missing option ${option.optionId}`) }
    }
    entries.delete(option.optionId)
    sum += probability
    normalised.push({ optionId: option.optionId, probability })
  }
  if (entries.size > 0) {
    const extra = entries.keys().next().value
    return {
      error: invalidSchema(
        `${label} distribution contains option ${redact(extra ?? '')} outside the question option set`,
      ),
    }
  }
  if (Math.abs(sum - 1) > PROBABILITY_SUM_EPSILON) {
    return {
      error: invalidSchema(`${label} probabilities are not normalised (sum=${String(sum)})`),
    }
  }
  return {
    distribution: { optionSetHash: question.optionSetHash, entries: normalised },
  }
}

function normaliseScores(
  question: Extract<DecisionQuestion, { type: 'score' }>,
  scores: readonly JevWireScore[],
  label: string,
  redact: (text: string) => string,
): { readonly scores: DecisionScore[] } | { readonly error: JevAdapterError } {
  const byOption = new Map<string, JevWireScore>()
  for (const score of scores) {
    if (byOption.has(score.option_id)) {
      return { error: invalidSchema(`${label} scores repeat option ${redact(score.option_id)}`) }
    }
    if (score.score < question.scale.min || score.score > question.scale.max) {
      return {
        error: invalidSchema(
          `${label} score for ${redact(score.option_id)} is outside [${String(question.scale.min)}, ${String(question.scale.max)}]`,
        ),
      }
    }
    byOption.set(score.option_id, score)
  }

  const normalised: DecisionScore[] = []
  for (const option of question.options) {
    const score = byOption.get(option.optionId)
    if (score === undefined) {
      return { error: invalidSchema(`${label} scores are missing option ${option.optionId}`) }
    }
    byOption.delete(option.optionId)
    const confidence = readConfidence(score.confidence, `${label} score confidence`)
    if (confidence !== undefined && 'error' in confidence) return { error: confidence.error }
    normalised.push({
      optionId: option.optionId,
      score: score.score,
      ...(confidence === undefined || 'error' in confidence
        ? {}
        : { confidence: confidence.value }),
    })
  }
  if (byOption.size > 0) {
    const extra = byOption.keys().next().value
    return {
      error: invalidSchema(
        `${label} scores contain option ${redact(extra ?? '')} outside the question option set`,
      ),
    }
  }
  return { scores: normalised }
}

type ConfidenceRead =
  | { readonly value: number }
  | { readonly error: JevAdapterError }
  | undefined

function readConfidence(value: number | undefined, label: string): ConfidenceRead {
  if (value === undefined) return undefined
  if (value < 0 || value > 1) {
    return { error: invalidSchema(`${label} is outside [0, 1]`) }
  }
  return { value }
}

function isQuestionType(value: string): value is 'choice' | 'score' | 'noul' {
  return value === 'choice' || value === 'score' || value === 'noul'
}

function fail(message: string): JevValidationOutcome {
  return { kind: 'error', error: invalidSchema(message) }
}

function invalidSchema(message: string): JevAdapterError {
  return new JevAdapterError('INVALID_SCHEMA', message)
}
