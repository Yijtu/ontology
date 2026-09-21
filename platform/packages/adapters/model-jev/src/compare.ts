import type { DecisionResult, DecisionScore, Sha256Digest } from '@ontology/contracts'
import { JevAdapterError } from './errors'

/**
 * Cross-type/option-set score comparability (SPEC C2: "跨不同题型/选项集的分数不可直接排名").
 *
 * Scores from a `score` question are only meaningful relative to the rubric, scale and
 * option set they were produced against. A fallback score is a self-reported value, not a
 * calibrated one, so it is not comparable to a calibrated score either. Ranking is
 * therefore gated behind a brand that only `comparableScoreSet` can mint after proving
 * the results share one question type, one option set and no fallback marker.
 */
const COMPARABLE_SCORE_SET: unique symbol = Symbol('@ontology/adapter-model-jev/ComparableScoreSet')

export interface ComparableScoreSet {
  readonly questionType: 'score'
  readonly optionSetHash: Sha256Digest
  readonly scores: readonly DecisionScore[]
  readonly [COMPARABLE_SCORE_SET]: true
}

export interface RankedDecisionScore {
  readonly optionId: string
  readonly score: number
  /** 1 is the highest score. Ties share the same rank. */
  readonly rank: number
}

export function comparableScoreSet(results: readonly DecisionResult[]): ComparableScoreSet {
  const [first, ...rest] = results
  if (first === undefined) {
    throw incomparable('at least one decision result is required to compare scores')
  }
  if (first.fallback !== undefined) {
    throw incomparable('a fallback score is self-reported and is not a calibrated score')
  }
  if (first.questionType !== 'score' || first.scores === undefined) {
    throw incomparable('only calibrated score-question results can be ranked')
  }
  for (const result of rest) {
    if (result.fallback !== undefined) {
      throw incomparable('a fallback score is self-reported and is not a calibrated score')
    }
    if (result.questionType !== 'score' || result.scores === undefined) {
      throw incomparable('scores from different question types are not directly rankable')
    }
    if (result.optionSetHash !== first.optionSetHash) {
      throw incomparable('scores over different option sets are not directly rankable')
    }
  }
  return {
    questionType: 'score',
    optionSetHash: first.optionSetHash,
    scores: first.scores,
    [COMPARABLE_SCORE_SET]: true,
  }
}

export function rankComparableScores(set: ComparableScoreSet): readonly RankedDecisionScore[] {
  const sorted = [...set.scores].sort((left, right) => right.score - left.score)
  const ranked: RankedDecisionScore[] = []
  let rank = 0
  let previous: number | undefined
  for (const entry of sorted) {
    if (previous === undefined || entry.score !== previous) {
      rank += 1
      previous = entry.score
    }
    ranked.push({ optionId: entry.optionId, score: entry.score, rank })
  }
  return ranked
}

function incomparable(message: string): JevAdapterError {
  return new JevAdapterError('INVALID_ARGUMENT', message)
}
