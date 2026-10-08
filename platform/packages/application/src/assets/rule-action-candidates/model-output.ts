import {
  findEmbeddedSecretViolations,
  findIndustryPackViolations,
  assertRuleDependencyCandidateShape,
} from '@ontology/contracts'
import type {
  ActionDeclaration,
  ActionSideEffect,
  CapabilityRequirement,
  OperationRef,
  RuleComparisonOperator,
  RuleConclusionBinding,
  RuleExceptionNode,
  RuleExpressionNode,
  VersionRef,
  RuleDependencyCandidateReference,
} from '@ontology/contracts'
import { RuleActionCandidateError } from './errors'

/**
 * The structured generation response for rule and action candidates (issue V03-010 / #184).
 *
 * The model output is untrusted data (AGENTS §运行、语义与证据), so every field is checked
 * before it becomes a candidate. The original condition and exceptions are preserved verbatim
 * in the returned typed AST; a malformed node is `INVALID_MODEL_OUTPUT` rather than being
 * coerced into a looser rule. Any attempt to smuggle executable code, an arbitrary script, an
 * arbitrary address or a credential is rejected outright, so it can never reach execution.
 */

export interface DraftRuleCandidate {
  readonly dependencyRefs?: readonly RuleDependencyCandidateReference[]
  readonly kind: 'rule'
  readonly ruleId: string
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly objectId: string
  readonly applicabilityNote?: string
  readonly condition: RuleExpressionNode
  readonly exceptions: readonly RuleExceptionNode[]
  readonly conclusion?: RuleConclusionBinding
  readonly ruleDependencies: readonly string[]
  readonly sourceIndex?: number
}

export interface DraftActionCandidate {
  readonly kind: 'action'
  readonly actionId: string
  readonly displayName: string
  readonly businessMeaning: string
  readonly suggestedReason: string
  readonly declaration: ActionDeclaration
  readonly sourceIndex?: number
}

export type DraftRuleActionCandidate = DraftRuleCandidate | DraftActionCandidate

export interface DraftRuleActionCandidates {
  readonly candidates: readonly DraftRuleActionCandidate[]
}

const COMPARISON_OPERATORS: readonly RuleComparisonOperator[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte']
const SIDE_EFFECTS: readonly ActionSideEffect[] = ['none', 'read_only', 'writes', 'external']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): RuleActionCandidateError {
  return new RuleActionCandidateError('INVALID_MODEL_OUTPUT', message)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalid(`model output field "${field}" must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalid(`model output field "${field}" must be a string`)
  return value
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`model output field "${field}" must be a finite number`)
  }
  return value
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw invalid(`model output field "${field}" must be an array of strings`)
  }
  return value
}

function optionalSourceIndex(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalid(`model output field "${field}" must be a non-negative integer source index`)
  }
  return value
}

function parseVersionRef(value: unknown, field: string): VersionRef {
  if (!isRecord(value)) throw invalid(`model output field "${field}" must be a version reference`)
  return {
    id: requireString(value['id'], `${field}.id`),
    version: requireString(value['version'], `${field}.version`),
    digest: requireString(value['digest'], `${field}.digest`),
  }
}

function parseCapabilities(value: unknown, field: string): readonly CapabilityRequirement[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(`model output field "${field}" must be an array`)
  return value.map((entry, index): CapabilityRequirement => {
    if (!isRecord(entry)) throw invalid(`model output field "${field}[${String(index)}]" must be an object`)
    const range = entry['versionRange']
    if (!isRecord(range)) {
      throw invalid(`model output field "${field}[${String(index)}].versionRange" must be an object`)
    }
    const max = range['max']
    return {
      name: requireString(entry['name'], `${field}[${String(index)}].name`),
      versionRange: {
        min: requireString(range['min'], `${field}[${String(index)}].versionRange.min`),
        ...(max === undefined ? {} : { max: requireString(max, `${field}[${String(index)}].versionRange.max`) }),
      },
    }
  })
}

function parseOperationRef(value: unknown, field: string): OperationRef {
  if (!isRecord(value)) throw invalid(`model output field "${field}" must be an operation reference`)
  return {
    id: requireString(value['id'], `${field}.id`),
    version: requireString(value['version'], `${field}.version`),
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Rule expression                                                                            */
/* ----------------------------------------------------------------------------------------- */

function parseValue(value: unknown, field: string): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  throw invalid(`model output field "${field}" must be a string, number or boolean`)
}

export function parseRuleExpression(value: unknown, field: string): RuleExpressionNode {
  if (!isRecord(value)) throw invalid(`model output field "${field}" must be an expression object`)
  const op = value['op']
  switch (op) {
    case 'compare': {
      const operator = value['operator']
      if (typeof operator !== 'string' || !(COMPARISON_OPERATORS as readonly string[]).includes(operator)) {
        throw invalid(`model output field "${field}.operator" must be one of ${COMPARISON_OPERATORS.join(', ')}`)
      }
      const unitCode = optionalString(value['unitCode'], `${field}.unitCode`)
      return {
        op: 'compare',
        attributeId: requireString(value['attributeId'], `${field}.attributeId`),
        operator: operator as RuleComparisonOperator,
        value: parseValue(value['value'], `${field}.value`),
        ...(unitCode === undefined ? {} : { unitCode }),
        spans: [],
      }
    }
    case 'range': {
      const min = optionalNumber(value['min'], `${field}.min`)
      const max = optionalNumber(value['max'], `${field}.max`)
      const unitCode = optionalString(value['unitCode'], `${field}.unitCode`)
      return {
        op: 'range',
        attributeId: requireString(value['attributeId'], `${field}.attributeId`),
        ...(min === undefined ? {} : { min }),
        ...(max === undefined ? {} : { max }),
        ...(unitCode === undefined ? {} : { unitCode }),
        spans: [],
      }
    }
    case 'all':
    case 'any': {
      if (!Array.isArray(value['operands'])) {
        throw invalid(`model output field "${field}.operands" must be an array`)
      }
      const operands = value['operands'].map((operand, index) =>
        parseRuleExpression(operand, `${field}.operands[${String(index)}]`),
      )
      return { op, operands, spans: [] }
    }
    case 'not':
      return { op: 'not', operand: parseRuleExpression(value['operand'], `${field}.operand`), spans: [] }
    case 'relation':
      return { op: 'relation', relationId: requireString(value['relationId'], `${field}.relationId`), ...(value['targetCondition'] === undefined ? {} : { targetCondition: parseRuleExpression(value['targetCondition'], `${field}.targetCondition`) }), spans: [] }
    default:
      throw invalid(`model output field "${field}.op" is not a known expression node`)
  }
}

function parseExceptions(value: unknown, field: string): readonly RuleExceptionNode[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw invalid(`model output field "${field}" must be an array`)
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw invalid(`model output field "${field}[${String(index)}]" must be an object`)
    return {
      exceptionId: requireString(entry['exceptionId'], `${field}[${String(index)}].exceptionId`),
      condition: parseRuleExpression(entry['condition'], `${field}[${String(index)}].condition`),
      spans: [],
    }
  })
}

function parseConclusion(value: unknown, field: string): RuleConclusionBinding | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw invalid(`model output field "${field}" must be an object`)
  const raw = value['value']
  if (isRecord(raw) && typeof raw['amount'] === 'string' && typeof raw['unit'] === 'string') {
    return {
      predicate: requireString(value['predicate'], `${field}.predicate`),
      value: { amount: raw['amount'], unit: raw['unit'] },
    }
  }
  if (typeof raw === 'string' || typeof raw === 'boolean') {
    return { predicate: requireString(value['predicate'], `${field}.predicate`), value: raw }
  }
  throw invalid(`model output field "${field}.value" must be a string, boolean or exact quantity`)
}

function parseRuleCandidate(entry: Record<string, unknown>, field: string): DraftRuleCandidate {
  const dependencies = optionalStringArray(entry['ruleDependencies'], `${field}.ruleDependencies`)
  const refs = entry['dependencyRefs'] ?? []
  if (entry['dependencyRefs'] !== undefined) {
    try { assertRuleDependencyCandidateShape(dependencies, refs) } catch (error) { throw new RuleActionCandidateError('INVALID_MODEL_OUTPUT', 'rule dependencies require fixed finite pins', { cause: error }) }
  }
  const conclusion = parseConclusion(entry['conclusion'], `${field}.conclusion`)
  const sourceIndex = optionalSourceIndex(entry['sourceIndex'], `${field}.sourceIndex`)
  const applicabilityNote = optionalString(entry['applicabilityNote'], `${field}.applicabilityNote`)
  return {
    kind: 'rule',
    ruleId: requireString(entry['ruleId'], `${field}.ruleId`),
    displayName: requireString(entry['displayName'], `${field}.displayName`),
    businessMeaning: requireString(entry['businessMeaning'], `${field}.businessMeaning`),
    suggestedReason: requireString(entry['suggestedReason'], `${field}.suggestedReason`),
    objectId: requireString(entry['objectId'], `${field}.objectId`),
    ...(applicabilityNote === undefined ? {} : { applicabilityNote }),
    condition: parseRuleExpression(entry['condition'], `${field}.condition`),
    exceptions: parseExceptions(entry['exceptions'], `${field}.exceptions`),
    ...(conclusion === undefined ? {} : { conclusion }),
    ruleDependencies: dependencies,
    ...(entry['dependencyRefs'] === undefined ? {} : { dependencyRefs: refs as readonly RuleDependencyCandidateReference[] }),
    ...(sourceIndex === undefined ? {} : { sourceIndex }),
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Action declaration                                                                         */
/* ----------------------------------------------------------------------------------------- */

function parseActionCandidate(entry: Record<string, unknown>, field: string): DraftActionCandidate {
  // Reject any smuggled executable content before the declaration is built.
  const violations = [...findIndustryPackViolations(entry), ...findEmbeddedSecretViolations(entry)]
  if (violations.length > 0) {
    throw new RuleActionCandidateError(
      'ARBITRARY_EXECUTABLE_REJECTED',
      'the action declaration contains executable content, an arbitrary address or a credential',
      { reasons: violations.map((violation) => `${violation.code}@${violation.path}`), retryable: false },
    )
  }
  const readOnly = entry['readOnly']
  if (typeof readOnly !== 'boolean') throw invalid(`model output field "${field}.readOnly" must be a boolean`)
  const sideEffect = entry['sideEffect']
  if (typeof sideEffect !== 'string' || !(SIDE_EFFECTS as readonly string[]).includes(sideEffect)) {
    throw invalid(`model output field "${field}.sideEffect" must be one of ${SIDE_EFFECTS.join(', ')}`)
  }
  const taskBindingRef = entry['taskBindingRef']
  const suggestedOperationRef = entry['suggestedOperationRef']
  const sourceIndex = optionalSourceIndex(entry['sourceIndex'], `${field}.sourceIndex`)
  const actionId = requireString(entry['actionId'], `${field}.actionId`)
  const declaration: ActionDeclaration = {
    actionId,
    displayName: requireString(entry['displayName'], `${field}.displayName`),
    businessMeaning: requireString(entry['businessMeaning'], `${field}.businessMeaning`),
    suggestedReason: requireString(entry['suggestedReason'], `${field}.suggestedReason`),
    inputSchemaRef: parseVersionRef(entry['inputSchemaRef'], `${field}.inputSchemaRef`),
    outputSchemaRef: parseVersionRef(entry['outputSchemaRef'], `${field}.outputSchemaRef`),
    preconditions: optionalStringArray(entry['preconditions'], `${field}.preconditions`),
    requiredCapabilities: parseCapabilities(entry['requiredCapabilities'], `${field}.requiredCapabilities`),
    permissions: optionalStringArray(entry['permissions'], `${field}.permissions`),
    readOnly,
    sideEffect: sideEffect as ActionSideEffect,
    evidenceRequirements: optionalStringArray(entry['evidenceRequirements'], `${field}.evidenceRequirements`),
    ...(taskBindingRef === undefined
      ? {}
      : { taskBindingRef: parseVersionRef(taskBindingRef, `${field}.taskBindingRef`) }),
    ...(suggestedOperationRef === undefined
      ? {}
      : { suggestedOperationRef: parseOperationRef(suggestedOperationRef, `${field}.suggestedOperationRef`) }),
  }
  return {
    kind: 'action',
    actionId,
    displayName: declaration.displayName,
    businessMeaning: declaration.businessMeaning,
    suggestedReason: declaration.suggestedReason,
    declaration,
    ...(sourceIndex === undefined ? {} : { sourceIndex }),
  }
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) throw invalid(`model output field "${field}" must be an array`)
  return value
}

/**
 * Parse the model's rule/action candidate response. A non-JSON body, a missing top-level key or
 * a malformed entry is a classified failure; the original condition and exceptions are kept in
 * the typed AST (an unsupported form is preserved and later reported `not_yet_executable`, not
 * deleted). Executable smuggling is rejected outright.
 */
export function parseRuleActionCandidateOutput(text: string): DraftRuleActionCandidates {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw invalid(`the rule/action candidate response is not valid JSON: ${String((error as Error).message)}`)
  }
  if (!isRecord(parsed)) throw invalid('the rule/action candidate response must be a JSON object')
  const rules = parsed['rules'] === undefined ? [] : requireArray(parsed['rules'], 'rules')
  const actions = parsed['actions'] === undefined ? [] : requireArray(parsed['actions'], 'actions')
  return {
    candidates: [
      ...rules.map((entry, index) => {
        if (!isRecord(entry)) throw invalid(`model output rules[${String(index)}] must be an object`)
        return parseRuleCandidate(entry, `rules[${String(index)}]`)
      }),
      ...actions.map((entry, index) => {
        if (!isRecord(entry)) throw invalid(`model output actions[${String(index)}] must be an object`)
        return parseActionCandidate(entry, `actions[${String(index)}]`)
      }),
    ],
  }
}
