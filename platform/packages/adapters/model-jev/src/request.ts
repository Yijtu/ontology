import type {
  ChoiceQuestion,
  DecisionOption,
  DecisionQuestion,
  DecisionRequest,
  ModelRef,
  NoulQuestion,
  ResourceKind,
  ResourceRef,
  ScoreQuestion,
  VersionRef,
} from '@ontology/contracts'
import { JevAdapterError } from './errors'

/**
 * Runtime validation of an inbound `DecisionRequest` (AGENTS.md: boundary data is
 * validated at runtime, not by a TypeScript assertion). The question type is a closed
 * set — anything outside choice/score/noul is rejected explicitly, never coerced.
 */
export function assertDecisionRequest(value: unknown): DecisionRequest {
  if (!isRecord(value)) throw invalid('the decision request must be an object')
  const stateRef = readStateRef(value['stateRef'])
  const modelRef = readModelRef(value['modelRef'])
  const rawQuestions = value['questions']
  if (!Array.isArray(rawQuestions) || rawQuestions.length < 1 || rawQuestions.length > 32) {
    throw invalid('a decision request requires between 1 and 32 questions')
  }
  const questions = rawQuestions.map((question, index) => readQuestion(question, index))
  const ids = new Set(questions.map((question) => question.questionId))
  if (ids.size !== questions.length) {
    throw invalid('decision question ids must be unique within a request')
  }
  return { stateRef, questions, modelRef }
}

function readStateRef(value: unknown): ResourceRef {
  if (!isRecord(value)) throw invalid('stateRef must be an object')
  const id = nonEmpty(value['id'])
  const version = nonEmpty(value['version'])
  const digest = nonEmpty(value['digest'])
  const kind = value['kind']
  if (id === undefined || version === undefined || digest === undefined) {
    throw invalid('stateRef requires non-empty id, version and digest')
  }
  if (!isResourceKind(kind)) {
    throw invalid('stateRef/kind is not a declared resource kind')
  }
  return { id, version, digest, kind }
}

const RESOURCE_KINDS: ReadonlySet<string> = new Set([
  'profile',
  'run',
  'evidence',
  'draft',
  'verification',
  'answer',
  'artifact',
  'document',
  'chunk',
  'plan',
  'simulation',
  'computation',
  'dataset',
  'checkpoint',
  'tool_result',
  'job',
  'source',
])

function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && RESOURCE_KINDS.has(value)
}

function readModelRef(value: unknown): ModelRef {
  if (!isRecord(value)) throw invalid('modelRef must be an object')
  const modelId = nonEmpty(value['modelId'])
  const version = nonEmpty(value['version'])
  if (modelId === undefined || version === undefined) {
    throw invalid('modelRef requires a non-empty modelId and version')
  }
  const provider = nonEmpty(value['provider'])
  return {
    modelId,
    version,
    ...(provider === undefined ? {} : { provider }),
  }
}

function readQuestion(value: unknown, index: number): DecisionQuestion {
  if (!isRecord(value)) throw invalid(`question ${String(index)} must be an object`)
  const pointer = `/questions/${String(index)}`
  const questionId = nonEmpty(value['questionId'])
  const type = value['type']
  const prompt = nonEmpty(value['prompt'])
  const definitionVersion = nonEmpty(value['definitionVersion'])
  if (questionId === undefined) throw invalid(`${pointer}/questionId must be a non-empty string`)
  if (prompt === undefined) throw invalid(`${pointer}/prompt must be a non-empty string`)
  if (definitionVersion === undefined) {
    throw invalid(`${pointer}/definitionVersion must be a non-empty string`)
  }
  switch (type) {
    case 'choice':
      return readChoice(value, pointer, questionId, prompt, definitionVersion)
    case 'score':
      return readScore(value, pointer, questionId, prompt, definitionVersion)
    case 'noul':
      return readNoul(value, pointer, questionId, prompt, definitionVersion)
    default:
      throw invalid(
        `${pointer}/type must be one of choice, score or noul`,
        [{ pointer: `${pointer}/type`, reason: 'unknown decision question type' }],
      )
  }
}

function readChoice(
  value: Record<string, unknown>,
  pointer: string,
  questionId: string,
  prompt: string,
  definitionVersion: string,
): ChoiceQuestion {
  const options = readOptions(value['options'], pointer, 2)
  const optionSetHash = nonEmpty(value['optionSetHash'])
  if (optionSetHash === undefined) {
    throw invalid(`${pointer}/optionSetHash must be a non-empty string`)
  }
  return { questionId, type: 'choice', prompt, options, optionSetHash, definitionVersion }
}

function readScore(
  value: Record<string, unknown>,
  pointer: string,
  questionId: string,
  prompt: string,
  definitionVersion: string,
): ScoreQuestion {
  const options = readOptions(value['options'], pointer, 1)
  const optionSetHash = nonEmpty(value['optionSetHash'])
  if (optionSetHash === undefined) {
    throw invalid(`${pointer}/optionSetHash must be a non-empty string`)
  }
  const rubricRef = readVersionRef(value['rubricRef'], `${pointer}/rubricRef`)
  const rawScale = value['scale']
  if (!isRecord(rawScale)) throw invalid(`${pointer}/scale must be an object`)
  const min = finiteNumber(rawScale['min'])
  const max = finiteNumber(rawScale['max'])
  if (min === undefined || max === undefined) {
    throw invalid(`${pointer}/scale requires numeric min and max`)
  }
  if (min > max) throw invalid(`${pointer}/scale min must not exceed max`)
  return {
    questionId,
    type: 'score',
    prompt,
    options,
    rubricRef,
    scale: { min, max },
    optionSetHash,
    definitionVersion,
  }
}

function readNoul(
  value: Record<string, unknown>,
  pointer: string,
  questionId: string,
  prompt: string,
  definitionVersion: string,
): NoulQuestion {
  if (value['options'] !== undefined) {
    throw invalid(`${pointer}/options must be absent for a noul question`)
  }
  return { questionId, type: 'noul', prompt, definitionVersion }
}

function readOptions(value: unknown, pointer: string, minItems: number): DecisionOption[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > 64) {
    throw invalid(`${pointer}/options must contain between ${String(minItems)} and 64 entries`)
  }
  const options: DecisionOption[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index]
    if (!isRecord(raw)) throw invalid(`${pointer}/options/${String(index)} must be an object`)
    const optionId = nonEmpty(raw['optionId'])
    const label = nonEmpty(raw['label'])
    if (optionId === undefined || label === undefined) {
      throw invalid(`${pointer}/options/${String(index)} requires non-empty optionId and label`)
    }
    if (seen.has(optionId)) {
      throw invalid(`${pointer}/options/${String(index)} duplicates optionId ${optionId}`)
    }
    seen.add(optionId)
    options.push({ optionId, label })
  }
  return options
}

function readVersionRef(value: unknown, pointer: string): VersionRef {
  if (!isRecord(value)) throw invalid(`${pointer} must be an object`)
  const id = nonEmpty(value['id'])
  const version = nonEmpty(value['version'])
  const digest = nonEmpty(value['digest'])
  if (id === undefined || version === undefined || digest === undefined) {
    throw invalid(`${pointer} requires non-empty id, version and digest`)
  }
  return { id, version, digest }
}

function invalid(message: string, fieldErrors?: readonly { pointer: string; reason: string }[]): JevAdapterError {
  return new JevAdapterError(
    'INVALID_ARGUMENT',
    message,
    fieldErrors === undefined ? undefined : { fieldErrors: [...fieldErrors] },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
