import { sourceTrustTierGroundsPublication } from '@ontology/contracts'
import type {
  AssetCandidateIssue,
  AssetCandidateState,
  AssetCandidateVersion,
  CandidateSourceSpan,
  DefinitionCandidateConflict,
  DefinitionCandidateInputDraftRef,
  DefinitionCandidatePayload,
  ResourceRef,
  Rfc3339UtcTimestamp,
  SourceTrustTier,
  Uuid,
} from '@ontology/contracts'
import { candidateIdFor, canonicalJson, sha256DigestOf } from '../../extraction/canonical'
import { definitionGeneratedContentDigest } from '../candidate-content-digests'
import type { DraftDefinitionCandidate } from './model-output'
import type { MountedDefinitionTerminology } from './terminology'

/**
 * The shared per-candidate build step of definition (TBox) candidates (design §5/§7, "抽公共提交
 * 步骤"). Both the model-driven generation service and the controlled `submit_candidates` command
 * persist definition candidates through this one function, so the terminology/endpoint checks, the
 * explicit conflict hints, the provenance/trust state and the content digest cannot drift between
 * the two entry points.
 *
 * A candidate without a read-back source span is stored `pending_confirmation`; a candidate whose
 * selected source is a tier that may not ground publication carries `SOURCE_TRUST_BLOCKED`. Neither
 * is ever dropped, and the model cannot set the state itself.
 */

/** The issues that make a definition candidate a hard failure instead of a reviewable suggestion. */
export const DEFINITION_HARD_ISSUES: readonly AssetCandidateIssue['code'][] = [
  'KIND_NOT_ALLOWED',
  'LOGICAL_ID_COLLISION',
  'ENDPOINT_UNRESOLVED',
  'INVALID_MODEL_OUTPUT',
]

export function payloadOf(draft: DraftDefinitionCandidate, displayName: string): DefinitionCandidatePayload {
  const common = {
    logicalId: draft.logicalId,
    displayName,
    businessMeaning: draft.businessMeaning,
    suggestedReason: draft.suggestedReason,
  }
  if (draft.kind === 'object') {
    return { kind: 'object', ...common, conflicts: [], identityAttributeIds: draft.identityAttributeIds ?? [],
      ...(draft.identityScopeDimensions === undefined ? {} : { identityScopeDimensions: draft.identityScopeDimensions }) }
  }
  if (draft.kind === 'attribute') {
    return {
      kind: 'attribute',
      ...common,
      conflicts: [],
      objectLogicalId: draft.objectLogicalId ?? '',
      valueType: draft.valueType ?? 'string',
      ...(draft.unitCode === undefined ? {} : { unitCode: draft.unitCode }),
      ...(draft.dimension === undefined ? {} : { dimension: draft.dimension }),
      ...(draft.enumValues === undefined ? {} : { enumValues: draft.enumValues }),
      ...(draft.referencesObjectLogicalId === undefined
        ? {}
        : { referencesObjectLogicalId: draft.referencesObjectLogicalId }),
      minCardinality: draft.minCardinality ?? 0,
      maxCardinality: draft.maxCardinality ?? 1,
    }
  }
  return {
    kind: 'relation',
    ...common,
    conflicts: [],
    fromObjectLogicalId: draft.fromObjectLogicalId ?? '',
    toObjectLogicalId: draft.toObjectLogicalId ?? '',
    minCardinality: draft.minCardinality ?? 0,
    maxCardinality: draft.maxCardinality ?? 'unbounded',
  }
}

/** The object logical ids a batch may reference: mounted terms plus objects it itself proposes. */
export function knownObjectsOf(
  terminology: MountedDefinitionTerminology,
  drafts: readonly DraftDefinitionCandidate[],
): Set<string> {
  const known = new Set(terminology.objectLogicalIds)
  for (const draft of drafts) if (draft.kind === 'object') known.add(draft.logicalId)
  return known
}

export function checkDefinitionEndpoint(
  issues: AssetCandidateIssue[],
  conflicts: DefinitionCandidateConflict[],
  logicalId: string | undefined,
  field: string,
  ownerLogicalId: string,
  known: ReadonlySet<string>,
): void {
  const value = logicalId ?? ''
  if (known.has(value)) return
  issues.push({
    code: 'ENDPOINT_UNRESOLVED',
    message: `"${ownerLogicalId}" references object "${value}" that is neither mounted nor proposed in this batch`,
    path: `payload.${field}`,
  })
  conflicts.push({
    kind: 'endpoint_unresolved',
    message: `${field} ${value} is unresolved`,
    relatedLogicalIds: [value],
  })
}

export interface DefinitionCandidateEvidence {
  readonly sourceRefs: readonly ResourceRef[]
  readonly sourceSpans: readonly CandidateSourceSpan[]
  /** True when no valid read-back source span was selected. */
  readonly provenanceMissing: boolean
  /** True when the selected source's trust tier may not ground a publishable candidate. */
  readonly trustBlocked: boolean
}

export interface BuildDefinitionCandidateInput {
  readonly workspaceId: Uuid
  readonly batchId: Uuid
  readonly recordedAt: Rfc3339UtcTimestamp
  readonly inputDraftRef: DefinitionCandidateInputDraftRef
  readonly terminology: MountedDefinitionTerminology
  readonly knownObjectIds: ReadonlySet<string>
  readonly logicalIdCounts: ReadonlyMap<string, number>
  /** False when this submission did not allow the draft's kind. */
  readonly kindAllowed: boolean
  readonly draft: DraftDefinitionCandidate
  readonly evidence: DefinitionCandidateEvidence
  readonly generationCallRef?: ResourceRef
  /** The namespace (batch/generation idempotency key) the candidate's idempotency key derives from. */
  readonly idempotencyNamespace: string
  readonly ordinal: number
}

/**
 * Build one validated, immutable definition candidate. The caller resolves the grounding evidence
 * (the model generation path selects a fragment; the submission path resolves authorized evidence)
 * and passes it in; everything else is decided here and can never be overridden by the model.
 */
export function buildDefinitionCandidate(input: BuildDefinitionCandidateInput): AssetCandidateVersion {
  const { draft, terminology } = input
  const issues: AssetCandidateIssue[] = []
  const conflicts: DefinitionCandidateConflict[] = []

  if (!input.kindAllowed) {
    issues.push({
      code: 'KIND_NOT_ALLOWED',
      message: `the model proposed a ${draft.kind} candidate that this submission did not allow`,
      path: 'kind',
    })
  }
  if ((input.logicalIdCounts.get(draft.logicalId) ?? 0) > 1) {
    issues.push({
      code: 'LOGICAL_ID_COLLISION',
      message: `logicalId "${draft.logicalId}" is used by more than one candidate in this batch`,
      path: 'logicalId',
    })
    conflicts.push({
      kind: 'logical_id_collision',
      message: `logicalId "${draft.logicalId}" collides with another candidate`,
      relatedLogicalIds: [draft.logicalId],
    })
  }

  // Professional terminology is taken from the mounted asset when the logical id already exists; a
  // differing model name is a reviewable conflict, not a silent overwrite.
  const mountedName = terminology.displayNames[draft.logicalId]
  if (mountedName !== undefined && mountedName !== draft.displayName) {
    conflicts.push({
      kind: 'terminology_mismatch',
      message: `the mounted asset names "${draft.logicalId}" as "${mountedName}", not "${draft.displayName}"`,
      relatedLogicalIds: [draft.logicalId],
    })
  }
  const displayName = mountedName ?? draft.displayName

  if (draft.kind === 'attribute') {
    checkDefinitionEndpoint(issues, conflicts, draft.objectLogicalId, 'objectLogicalId', draft.logicalId, input.knownObjectIds)
    if (draft.referencesObjectLogicalId !== undefined) {
      checkDefinitionEndpoint(issues, conflicts, draft.referencesObjectLogicalId, 'referencesObjectLogicalId', draft.logicalId, input.knownObjectIds)
    }
    const mountedAttribute = terminology.attributes.find((attribute) => attribute.logicalId === draft.logicalId)
    if (mountedAttribute !== undefined) {
      if (mountedAttribute.valueType !== draft.valueType) {
        issues.push({
          code: 'TERMINOLOGY_MISMATCH',
          message: `attribute "${draft.logicalId}" is mounted as ${mountedAttribute.valueType}, not ${String(draft.valueType)}`,
          path: 'payload.valueType',
        })
        conflicts.push({ kind: 'terminology_mismatch', message: `mounted attribute type is ${mountedAttribute.valueType}`, relatedLogicalIds: [draft.logicalId] })
      }
      const mountedUnit = mountedAttribute.unitCode
      if (mountedUnit !== undefined && draft.unitCode !== undefined && mountedUnit !== draft.unitCode) {
        issues.push({
          code: 'UNIT_CONFLICT',
          message: `attribute "${draft.logicalId}" is mounted with unit ${mountedUnit}, not ${draft.unitCode}`,
          path: 'payload.unitCode',
        })
        conflicts.push({ kind: 'unit_conflict', message: `mounted unit is ${mountedUnit}`, relatedLogicalIds: [draft.logicalId] })
      }
    }
  } else if (draft.kind === 'relation') {
    checkDefinitionEndpoint(issues, conflicts, draft.fromObjectLogicalId, 'fromObjectLogicalId', draft.logicalId, input.knownObjectIds)
    checkDefinitionEndpoint(issues, conflicts, draft.toObjectLogicalId, 'toObjectLogicalId', draft.logicalId, input.knownObjectIds)
  }

  if (input.evidence.provenanceMissing) {
    issues.push({ code: 'MISSING_PROVENANCE', message: 'no valid read-back source fragment was selected; human confirmation is required', path: 'sourceSpans' })
  }
  if (input.evidence.trustBlocked) {
    issues.push({ code: 'SOURCE_TRUST_BLOCKED', message: 'the selected research source may not ground a publishable candidate until a human promotes it', path: 'sourceSpans' })
  }

  const hard = issues.some((issue) => DEFINITION_HARD_ISSUES.includes(issue.code))
  const state: AssetCandidateState = hard ? 'failed'
    : input.evidence.provenanceMissing || input.evidence.trustBlocked ? 'pending_confirmation' : 'produced'
  const pendingConfirmation = input.evidence.provenanceMissing || input.evidence.trustBlocked
  const payload: DefinitionCandidatePayload = { ...payloadOf(draft, displayName), conflicts }
  const contentDigest = definitionGeneratedContentDigest({
    workspaceId: input.workspaceId,
    logicalId: draft.logicalId,
    kind: draft.kind,
    payload,
    inputDraftRef: input.inputDraftRef,
    sourceRefs: input.evidence.sourceRefs,
    sourceSpans: input.evidence.sourceSpans,
    issues,
  })
  const idempotencyKey = sha256DigestOf(canonicalJson({
    idempotencyNamespace: input.idempotencyNamespace,
    logicalId: draft.logicalId,
    ordinal: input.ordinal,
    contentDigest,
  }))
  return {
    candidateId: candidateIdFor(idempotencyKey),
    batchId: input.batchId,
    workspaceId: input.workspaceId,
    logicalId: draft.logicalId,
    domain: 'definition',
    kind: draft.kind,
    payload,
    inputDraftRef: input.inputDraftRef,
    sourceRefs: input.evidence.sourceRefs,
    sourceSpans: input.evidence.sourceSpans,
    state,
    issues,
    pendingConfirmation,
    ...(input.generationCallRef === undefined ? {} : { generationCallRef: input.generationCallRef }),
    contentDigest,
    idempotencyKey,
    recordedAt: input.recordedAt,
  }
}

/** Whether any selected tier can ground a publishable candidate (used by both entry points). */
export function trustTiersGroundPublication(tiers: readonly SourceTrustTier[]): boolean {
  return tiers.length > 0 && tiers.every((tier) => sourceTrustTierGroundsPublication(tier))
}
