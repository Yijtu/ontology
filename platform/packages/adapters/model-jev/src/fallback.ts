import type { DecisionFallback, DecisionQuestion, DecisionResult, PlatformError } from '@ontology/contracts'
import { EMPTY_OPTION_SET_HASH } from './constants'
import { JevAdapterError } from './errors'
import type { GenerativeClassificationOutput } from './types'

/**
 * Explicit degradation results (SPEC C2). A fallback result is always marked with a
 * `DecisionFallback`, never carries a fabricated `confidence` and never dresses a
 * fallback score up as a calibrated probability.
 */

export function optionSetHashOf(question: DecisionQuestion): string {
  return question.type === 'noul' ? EMPTY_OPTION_SET_HASH : question.optionSetHash
}

export function degradeToClarification(
  questions: readonly DecisionQuestion[],
  fallbackReason: string,
  originalFailure: PlatformError,
): readonly DecisionResult[] {
  return questions.map((question) => ({
    questionId: question.questionId,
    questionType: question.type,
    definitionVersion: question.definitionVersion,
    optionSetHash: optionSetHashOf(question),
    fallback: { fallback: 'clarify', fallbackReason, originalFailure },
  }))
}

/**
 * A deterministic, declared fallback. It is deliberately not a probability judgement:
 * `choice` selects the first declared option in order and `score` gives every option the
 * declared scale floor. Neither carries `confidence`, and both are marked as a fallback.
 */
export function degradeToDeterministic(
  questions: readonly DecisionQuestion[],
  fallbackReason: string,
  originalFailure: PlatformError,
): readonly DecisionResult[] {
  return questions.map((question) => {
    const fallback: DecisionFallback = {
      fallback: 'deterministic',
      fallbackReason,
      originalFailure,
    }
    switch (question.type) {
      case 'choice': {
        const first = question.options[0]
        return {
          questionId: question.questionId,
          questionType: 'choice',
          definitionVersion: question.definitionVersion,
          optionSetHash: question.optionSetHash,
          ...(first === undefined ? {} : { selectedOptionId: first.optionId }),
          fallback,
        }
      }
      case 'score':
        return {
          questionId: question.questionId,
          questionType: 'score',
          definitionVersion: question.definitionVersion,
          optionSetHash: question.optionSetHash,
          scores: question.options.map((option) => ({
            optionId: option.optionId,
            score: question.scale.min,
          })),
          fallback,
        }
      case 'noul':
        return {
          questionId: question.questionId,
          questionType: 'noul',
          definitionVersion: question.definitionVersion,
          optionSetHash: EMPTY_OPTION_SET_HASH,
          fallback,
        }
    }
  })
}

/**
 * Map a generative-classification fallback output onto a marked `DecisionResult`. The
 * classifier's self-reported score is carried in `scores`, never in `distribution` or
 * `confidence`, so it cannot be mistaken for an equally calibrated probability.
 */
export function degradeToGenerativeClassification(
  question: DecisionQuestion,
  output: GenerativeClassificationOutput,
  fallbackReason: string,
  originalFailure: PlatformError,
): DecisionResult {
  const fallback: DecisionFallback = {
    fallback: 'generative_classification',
    fallbackReason,
    originalFailure,
  }
  const base = {
    questionId: question.questionId,
    questionType: question.type,
    definitionVersion: question.definitionVersion,
    optionSetHash: optionSetHashOf(question),
    fallback,
  }
  switch (question.type) {
    case 'choice': {
      if (output.selectedOptionId === undefined) {
        throw new JevAdapterError(
          'INVALID_SCHEMA',
          'the generative classification fallback did not return a selected option',
        )
      }
      if (!question.options.some((option) => option.optionId === output.selectedOptionId)) {
        throw new JevAdapterError(
          'INVALID_SCHEMA',
          'the generative classification fallback selected an option outside the question option set',
        )
      }
      return { ...base, selectedOptionId: output.selectedOptionId }
    }
    case 'score': {
      const scores = output.scores ?? []
      const byOption = new Map(scores.map((score) => [score.optionId, score.score]))
      const normalised = question.options.map((option) => {
        const score = byOption.get(option.optionId)
        if (score === undefined) {
          throw new JevAdapterError(
            'INVALID_SCHEMA',
            `the generative classification fallback did not score option ${option.optionId}`,
          )
        }
        return { optionId: option.optionId, score }
      })
      return { ...base, scores: normalised }
    }
    case 'noul':
      return base
  }
}
