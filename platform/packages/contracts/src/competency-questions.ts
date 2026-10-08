import type {
  CompetencyQuestionSet, CompetencyQuestionSetBody, ResourceRef, ScopeRef, Sha256Digest, VersionRef,
} from './generated/contracts'
import type { ToolContext } from './trusted'
import { findEmbeddedSecretViolations } from './industry-packs'

export const COMPETENCY_QUESTION_SCHEMA_ID = 'https://ontology.local/schema/competency-questions.schema.json#/$defs/CompetencyQuestionSet' as const

/** Compile the canonical schema in the host; contracts contain no validator framework or I/O. */
export interface CompetencyQuestionBoundary {
  readonly schemaId: typeof COMPETENCY_QUESTION_SCHEMA_ID
  readonly validate: (value: unknown) => value is CompetencyQuestionSet
  readonly digestBody: (body: CompetencyQuestionSetBody) => Sha256Digest
}

export type CompetencyQuestionErrorCode = 'INVALID_DECLARATION' | 'DIGEST_MISMATCH' | 'UNKNOWN_PIN' | 'UNDECLARED_CAPABILITY' | 'EXTERNAL_GOLD_UNAVAILABLE'

export class CompetencyQuestionError extends Error {
  constructor(readonly code: CompetencyQuestionErrorCode, message: string) { super(message); this.name = 'CompetencyQuestionError' }
}

function sameRef(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

/** Schema, envelope digest and inventory pins all precede use of gold or generation context. */
export function assertCompetencyQuestionSet(
  value: unknown,
  boundary: CompetencyQuestionBoundary,
  expectedRef?: VersionRef,
): asserts value is CompetencyQuestionSet {
  if (boundary.schemaId !== COMPETENCY_QUESTION_SCHEMA_ID || !boundary.validate(value)) {
    throw new CompetencyQuestionError('INVALID_DECLARATION', 'competency questions must match the canonical declaration schema')
  }
  if (findEmbeddedSecretViolations(value).length > 0) throw new CompetencyQuestionError('INVALID_DECLARATION', 'competency declarations cannot contain credentials or embedded secrets')
  if (boundary.digestBody(value.body) !== value.ref.digest || (expectedRef !== undefined && !sameRef(value.ref, expectedRef))) {
    throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency declaration content or requested version pin does not match')
  }
  const ids = new Set<string>()
  const allowed = new Set(value.body.allowedCapabilities)
  for (const question of value.body.questions) {
    if (ids.has(question.questionId)) throw new CompetencyQuestionError('INVALID_DECLARATION', 'question IDs must be unique inside a version')
    ids.add(question.questionId)
    const taskKind = question.intent.kind === 'attribute' ? 'published_facts' : question.intent.kind === 'quantity_sum' ? 'structured_query'
      : question.intent.kind === 'rule' ? 'rule_judgement' : 'relations'
    if (question.taskKind !== taskKind) throw new CompetencyQuestionError('INVALID_DECLARATION', 'task kind must match the structured intent')
    if (question.intent.kind === 'rule' && question.ruleRefs.length === 0) throw new CompetencyQuestionError('UNKNOWN_PIN', 'rule judgement requires a pinned rule declaration')
    if (!value.body.definitionRefs.some((ref) => sameRef(ref, question.definitionRef)) ||
        question.ruleRefs.some((ref) => !value.body.ruleRefs.some((known) => sameRef(known, ref))) ||
        question.requiredSources.some((location) => !value.body.sourceRefs.some((ref) => sameRef(ref, location.sourceRef)))) {
      throw new CompetencyQuestionError('UNKNOWN_PIN', 'question references an undeclared definition, rule or source version')
    }
    if (question.requiredCapabilities.some((capability) => !allowed.has(capability))) {
      throw new CompetencyQuestionError('UNDECLARED_CAPABILITY', 'question requires a capability outside the declaration allowlist')
    }
    const locations = [...question.requiredSources, ...question.input.observations.map((fact) => fact.source),
      ...question.input.relations.map((relation) => relation.source)]
    for (const location of locations) {
      if (location.endOffset <= location.startOffset) throw new CompetencyQuestionError('INVALID_DECLARATION', 'source locations require a nonempty forward range')
      if (!value.body.sourceRefs.some((known) => sameRef(known, location.sourceRef))) {
        throw new CompetencyQuestionError('UNKNOWN_PIN', 'input refers to an undeclared source version')
      }
      if (!question.requiredSources.some((required) => sameRef(required.sourceRef, location.sourceRef) &&
          required.startOffset === location.startOffset && required.endOffset === location.endOffset && required.quoteDigest === location.quoteDigest)) {
        throw new CompetencyQuestionError('UNKNOWN_PIN', 'input source location is not declared among the question evidence requirements')
      }
    }
  }
}

/** Approval comes from the scoped artifact/review host, never a boolean in the declaration. */
export interface ApprovedCompetencyQuestionReader {
  readApproved(scope: ScopeRef, ref: VersionRef, ctx: ToolContext): Promise<CompetencyQuestionSet | undefined>
}

/** Real quote gold is a separately authorised resource; a synthetic fixture cannot fill this slot. */
export interface ExternalCompetencyGoldReader {
  readApproved(scope: ScopeRef, quoteGoldRef: ResourceRef, humanReviewRef: ResourceRef, ctx: ToolContext): Promise<unknown | undefined>
}

export function requireExternalCompetencyGold(set: CompetencyQuestionSet): { quoteGoldRef: ResourceRef; humanReviewRef: ResourceRef } {
  if (set.body.externalGold.status !== 'available') {
    throw new CompetencyQuestionError('EXTERNAL_GOLD_UNAVAILABLE', 'authorised real quote inputs, human gold and customer binding are not available; external acceptance is unverified')
  }
  return { quoteGoldRef: set.body.externalGold.quoteGoldRef, humanReviewRef: set.body.externalGold.humanReviewRef }
}
