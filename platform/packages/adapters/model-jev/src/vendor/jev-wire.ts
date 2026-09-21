import type { DecisionQuestion, ResourceRef } from '@ontology/contracts'

/**
 * @internal JEV-API wire shapes.
 *
 * These are the vendor's own request/response types. They are deliberately NOT exported
 * from the package root: the adapter converts them into canonical `DecisionResult`s at
 * the boundary, so no vendor type ever becomes a platform contract or reaches
 * `contracts`/`core` (SPEC §4.2, INV-01/02).
 *
 * The field names intentionally follow the vendor's snake_case protocol and differ from
 * the canonical contract names; that difference is what the conversion layer absorbs.
 * A JEV result is a probability judgement, never generated text or code.
 */

export interface JevWireOption {
  readonly option_id: string
  readonly label: string
}

export interface JevWireChoiceQuestion {
  readonly question_id: string
  readonly type: 'choice'
  readonly prompt: string
  readonly options: readonly JevWireOption[]
  readonly option_set_hash: string
  readonly definition_version: string
}

export interface JevWireScoreQuestion {
  readonly question_id: string
  readonly type: 'score'
  readonly prompt: string
  readonly options: readonly JevWireOption[]
  readonly rubric_ref: { readonly id: string; readonly version: string; readonly digest: string }
  readonly scale: { readonly min: number; readonly max: number }
  readonly option_set_hash: string
  readonly definition_version: string
}

export interface JevWireNoulQuestion {
  readonly question_id: string
  readonly type: 'noul'
  readonly prompt: string
  readonly definition_version: string
}

export type JevWireQuestion =
  | JevWireChoiceQuestion
  | JevWireScoreQuestion
  | JevWireNoulQuestion

export interface JevWireStateRef {
  readonly id: string
  readonly version: string
  readonly digest: string
  readonly kind: string
}

export interface JevWireRequest {
  readonly model: string
  readonly state_ref: JevWireStateRef
  readonly questions: readonly JevWireQuestion[]
}

export interface JevWireProbabilityEntry {
  readonly option_id: string
  readonly probability: number
}

export interface JevWireDistribution {
  readonly option_set_hash: string
  readonly entries: readonly JevWireProbabilityEntry[]
}

export interface JevWireScore {
  readonly option_id: string
  readonly score: number
  readonly confidence?: number
}

export interface JevWireResult {
  readonly question_id: string
  readonly question_type: string
  readonly definition_version: string
  readonly option_set_hash: string
  readonly selected_option_id?: string
  readonly distribution?: JevWireDistribution
  readonly scores?: readonly JevWireScore[]
  readonly confidence?: number
}

export interface JevWireUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
}

export interface JevWireResponse {
  readonly model_version: string
  readonly results: readonly JevWireResult[]
  readonly usage?: JevWireUsage
}

export type JevWireDecode =
  | { readonly kind: 'ok'; readonly response: JevWireResponse }
  | { readonly kind: 'malformed'; readonly detail: string }

export function buildJevWireRequest(
  vendorModel: string,
  stateRef: ResourceRef,
  questions: readonly DecisionQuestion[],
): JevWireRequest {
  return {
    model: vendorModel,
    state_ref: {
      id: stateRef.id,
      version: stateRef.version,
      digest: stateRef.digest,
      kind: stateRef.kind,
    },
    questions: questions.map(toWireQuestion),
  }
}

function toWireQuestion(question: DecisionQuestion): JevWireQuestion {
  switch (question.type) {
    case 'choice':
      return {
        question_id: question.questionId,
        type: 'choice',
        prompt: question.prompt,
        options: question.options.map((option) => ({
          option_id: option.optionId,
          label: option.label,
        })),
        option_set_hash: question.optionSetHash,
        definition_version: question.definitionVersion,
      }
    case 'score':
      return {
        question_id: question.questionId,
        type: 'score',
        prompt: question.prompt,
        options: question.options.map((option) => ({
          option_id: option.optionId,
          label: option.label,
        })),
        rubric_ref: {
          id: question.rubricRef.id,
          version: question.rubricRef.version,
          digest: question.rubricRef.digest,
        },
        scale: { min: question.scale.min, max: question.scale.max },
        option_set_hash: question.optionSetHash,
        definition_version: question.definitionVersion,
      }
    case 'noul':
      return {
        question_id: question.questionId,
        type: 'noul',
        prompt: question.prompt,
        definition_version: question.definitionVersion,
      }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Decode a JEV response body. `malformed` carries a non-secret detail; the adapter
 * classifies it as an upstream protocol fault rather than silently dropping the result.
 */
export function decodeJevWireResponse(body: unknown): JevWireDecode {
  if (!isRecord(body)) return malformed('the response body was not a JSON object')
  const modelVersion = asString(body['model_version'])
  if (modelVersion === undefined || modelVersion.length === 0) {
    return malformed('the response did not carry a model_version')
  }
  const rawResults = body['results']
  if (!Array.isArray(rawResults)) return malformed('the response did not carry a results array')

  const results: JevWireResult[] = []
  for (const rawResult of rawResults) {
    const result = decodeResult(rawResult)
    if (result === undefined) return malformed('a decision result was structurally malformed')
    results.push(result)
  }

  const usage = decodeUsage(body['usage'])
  if (usage === undefined && body['usage'] !== undefined) {
    return malformed('the response usage block was malformed')
  }
  return {
    kind: 'ok',
    response: {
      model_version: modelVersion,
      results,
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

function decodeResult(value: unknown): JevWireResult | undefined {
  if (!isRecord(value)) return undefined
  const questionId = asString(value['question_id'])
  const questionType = asString(value['question_type'])
  const definitionVersion = asString(value['definition_version'])
  const optionSetHash = asString(value['option_set_hash'])
  if (
    questionId === undefined ||
    questionType === undefined ||
    definitionVersion === undefined ||
    optionSetHash === undefined
  ) {
    return undefined
  }
  const selectedOptionId = asString(value['selected_option_id'])
  if (value['selected_option_id'] !== undefined && selectedOptionId === undefined) return undefined

  const distribution = decodeDistribution(value['distribution'])
  if (value['distribution'] !== undefined && distribution === undefined) return undefined

  const scores = decodeScores(value['scores'])
  if (value['scores'] !== undefined && scores === undefined) return undefined

  const confidence = decodeOptionalNumber(value['confidence'])
  if (value['confidence'] !== undefined && confidence === undefined) return undefined

  return {
    question_id: questionId,
    question_type: questionType,
    definition_version: definitionVersion,
    option_set_hash: optionSetHash,
    ...(selectedOptionId === undefined ? {} : { selected_option_id: selectedOptionId }),
    ...(distribution === undefined ? {} : { distribution }),
    ...(scores === undefined ? {} : { scores }),
    ...(confidence === undefined ? {} : { confidence }),
  }
}

function decodeDistribution(value: unknown): JevWireDistribution | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return undefined
  const optionSetHash = asString(value['option_set_hash'])
  const rawEntries = value['entries']
  if (optionSetHash === undefined || !Array.isArray(rawEntries)) return undefined
  const entries: JevWireProbabilityEntry[] = []
  for (const rawEntry of rawEntries) {
    if (!isRecord(rawEntry)) return undefined
    const optionId = asString(rawEntry['option_id'])
    const probability = asNumber(rawEntry['probability'])
    if (optionId === undefined || probability === undefined) return undefined
    entries.push({ option_id: optionId, probability })
  }
  return { option_set_hash: optionSetHash, entries }
}

function decodeScores(value: unknown): readonly JevWireScore[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const scores: JevWireScore[] = []
  for (const rawScore of value) {
    if (!isRecord(rawScore)) return undefined
    const optionId = asString(rawScore['option_id'])
    const score = asNumber(rawScore['score'])
    if (optionId === undefined || score === undefined) return undefined
    const confidence = decodeOptionalNumber(rawScore['confidence'])
    if (rawScore['confidence'] !== undefined && confidence === undefined) return undefined
    scores.push({
      option_id: optionId,
      score,
      ...(confidence === undefined ? {} : { confidence }),
    })
  }
  return scores
}

function decodeUsage(value: unknown): JevWireUsage | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) return undefined
  const input = decodeOptionalNumber(value['input_tokens'])
  const output = decodeOptionalNumber(value['output_tokens'])
  if (value['input_tokens'] !== undefined && input === undefined) return undefined
  if (value['output_tokens'] !== undefined && output === undefined) return undefined
  return {
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(output === undefined ? {} : { output_tokens: output }),
  }
}

function decodeOptionalNumber(value: unknown): number | undefined {
  return value === undefined ? undefined : asNumber(value)
}

function malformed(detail: string): JevWireDecode {
  return { kind: 'malformed', detail }
}
