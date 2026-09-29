import type { DecisionQuestion } from '@ontology/contracts'
import type { JevActualState } from '../types'
import { JevAdapterError } from '../errors'

/**
 * @internal Official TypeSafe System One request/response types. They stay inside this
 * adapter; platform contracts remain provider-neutral.
 */
export type JevWireQuestion = JevWireChoiceQuestion | JevWireScoreQuestion | JevWireNoulQuestion

export interface JevWireChoiceQuestion {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<string, string>>
}

export interface JevWireScoreQuestion {
  readonly type: 'score'
  readonly instructions: {
    readonly question: string
    readonly candidate: { readonly id: string; readonly label: string }
    readonly scale: { readonly min: number; readonly max: number }
  }
  readonly criteria: readonly string[]
}

export interface JevWireNoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
}

export interface JevWireRequest {
  readonly model: string
  readonly state: JevActualState
  readonly questions: Readonly<Record<string, JevWireQuestion>>
}

export interface JevWireBinding {
  readonly wireQuestionId: string
  readonly question: DecisionQuestion
  /** Present for expanded per-candidate System One Score questions. */
  readonly scoreOptionId?: string
  readonly scoreCriteria: readonly string[]
}

export interface JevWirePlan {
  readonly request: JevWireRequest
  readonly bindings: readonly JevWireBinding[]
}

export interface JevWireChoiceAnswer {
  readonly type: 'choice'
  readonly choice: string
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
}

export interface JevWireScoreAnswer {
  readonly type: 'score'
  readonly score: number
  readonly legend: Readonly<Record<string, string>>
  readonly probabilities: Readonly<Record<string, number>>
  readonly confidence: number
}

export interface JevWireNoulAnswer {
  readonly type: 'noul'
  readonly noul: number
}

export type JevWireAnswer = JevWireChoiceAnswer | JevWireScoreAnswer | JevWireNoulAnswer

export interface JevWireUsage {
  readonly input_tokens: number
  readonly output_tokens: number
}

export interface JevWireResponse {
  readonly model: string
  readonly answers: Readonly<Record<string, JevWireAnswer>>
  readonly usage: JevWireUsage
}

export type JevWireDecode =
  | { readonly kind: 'ok'; readonly response: JevWireResponse }
  | {
      readonly kind: 'malformed'
      readonly detail: string
      /** Preserved when the provider returned trustworthy complete usage with bad answers. */
      readonly usage?: JevWireUsage
      readonly model?: string
    }

const MAX_SCORE_LEVELS = 10
const MAX_WIRE_QUESTIONS = 256

export function buildJevWireRequest(
  vendorModel: string,
  state: JevActualState,
  questions: readonly DecisionQuestion[],
): JevWirePlan {
  const wireQuestions: Record<string, JevWireQuestion> = {}
  const bindings: JevWireBinding[] = []
  for (const [questionIndex, question] of questions.entries()) {
    switch (question.type) {
      case 'choice': {
        wireQuestions[question.questionId] = {
          type: 'choice',
          instructions: question.prompt,
          criteria: Object.fromEntries(question.options.map((option) => [option.optionId, option.label])),
        }
        bindings.push({
          wireQuestionId: question.questionId,
          question,
          scoreCriteria: [],
        })
        break
      }
      case 'score': {
        if (!Number.isFinite(question.scale.max - question.scale.min) || question.scale.max <= question.scale.min) {
          throw invalidRequest('a System One score requires a finite, increasing platform scale')
        }
        const criteria = scoreCriteria(question.scale.min, question.scale.max)
        for (const [optionIndex, option] of question.options.entries()) {
          const wireQuestionId = `q${String(questionIndex)}_option${String(optionIndex)}`
          wireQuestions[wireQuestionId] = {
            type: 'score',
            instructions: {
              question: question.prompt,
              candidate: { id: option.optionId, label: option.label },
              scale: { min: question.scale.min, max: question.scale.max },
            },
            criteria,
          }
          bindings.push({ wireQuestionId, question, scoreOptionId: option.optionId, scoreCriteria: criteria })
        }
        break
      }
      case 'noul':
        wireQuestions[question.questionId] = {
          type: 'noul',
          instructions: question.prompt,
        }
        bindings.push({
          wireQuestionId: question.questionId,
          question,
          scoreCriteria: [],
        })
        break
    }
    if (Object.keys(wireQuestions).length > MAX_WIRE_QUESTIONS) {
      throw invalidRequest('the expanded System One request exceeds 256 questions')
    }
  }
  return { request: { model: vendorModel, state, questions: wireQuestions }, bindings }
}

/** Decode the documented System One response shape, keeping wire ids for later mapping. */
export function decodeJevWireResponse(body: unknown): JevWireDecode {
  if (!isRecord(body)) return malformed('the response body was not a JSON object')
  const usage = decodeUsage(body['usage'])
  if (usage === undefined) return malformed('the response did not carry valid token usage')
  const model = readString(body['model'])
  if (model === undefined || !/^[A-Za-z0-9._:/-]{1,128}$/.test(model)) {
    return malformed('the response did not carry a valid model identifier', usage)
  }
  const answersValue = body['answers']
  if (!isRecord(answersValue)) return malformed('the response did not carry an answers map', usage, model)
  const answers: Record<string, JevWireAnswer> = {}
  for (const [questionId, rawAnswer] of Object.entries(answersValue)) {
    const answer = decodeAnswer(rawAnswer)
    if (answer === undefined) return malformed('an answer entry was malformed', usage, model)
    Object.defineProperty(answers, questionId, { value: answer, enumerable: true })
  }
  return { kind: 'ok', response: { model, answers, usage } }
}

function decodeAnswer(value: unknown): JevWireAnswer | undefined {
  if (!isRecord(value)) return undefined
  switch (value['type']) {
    case 'choice': {
      const choice = readString(value['choice'])
      const probabilities = decodeNumberMap(value['probabilities'])
      const confidence = readNumber(value['confidence'])
      if (choice === undefined || probabilities === undefined || confidence === undefined) return undefined
      return { type: 'choice', choice, probabilities, confidence }
    }
    case 'score': {
      const score = readNumber(value['score'])
      const legend = decodeStringMap(value['legend'])
      const probabilities = decodeNumberMap(value['probabilities'])
      const confidence = readNumber(value['confidence'])
      if (score === undefined || legend === undefined || probabilities === undefined || confidence === undefined) {
        return undefined
      }
      return { type: 'score', score, legend, probabilities, confidence }
    }
    case 'noul': {
      if (Object.keys(value).some((key) => key !== 'type' && key !== 'noul')) return undefined
      const noul = readNumber(value['noul'])
      if (noul === undefined) return undefined
      return { type: 'noul', noul }
    }
    default:
      return undefined
  }
}

function decodeNumberMap(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  const result: Record<string, number> = {}
  for (const [key, item] of entries) {
    const number = readNumber(item)
    if (number === undefined) return undefined
    Object.defineProperty(result, key, { value: number, enumerable: true })
  }
  return result
}

function decodeStringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') return undefined
    Object.defineProperty(result, key, { value: item, enumerable: true })
  }
  return result
}

function decodeUsage(value: unknown): JevWireUsage | undefined {
  if (!isRecord(value)) return undefined
  const inputTokens = readInteger(value['input_tokens'])
  const outputTokens = readInteger(value['output_tokens'])
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return { input_tokens: inputTokens, output_tokens: outputTokens }
}

function scoreCriteria(min: number, max: number): readonly string[] {
  const span = max - min
  const intervals = Math.max(1, Math.min(MAX_SCORE_LEVELS - 1, Math.ceil(span)))
  return Array.from({ length: intervals + 1 }, (_, index) => {
    const value = min + (span * index) / intervals
    return `Level ${String(index)}: score ${formatScaleValue(value)} on the declared rubric scale.`
  })
}

function formatScaleValue(value: number): string {
  return Number(value.toPrecision(12)).toString()
}

function invalidRequest(message: string): JevAdapterError {
  return new JevAdapterError('INVALID_ARGUMENT', message)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(detail: string, usage?: JevWireUsage, model?: string): JevWireDecode {
  return {
    kind: 'malformed',
    detail,
    ...(usage === undefined ? {} : { usage }),
    ...(model === undefined ? {} : { model }),
  }
}
