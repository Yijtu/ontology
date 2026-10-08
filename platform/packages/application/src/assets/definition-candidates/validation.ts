import type {
  AssetCandidateIssue,
  AssetCandidateVersion,
  DefinitionAffectedDefinition,
  DefinitionAffectedRole,
  DefinitionCandidatePayload,
  DefinitionChange,
  DefinitionCompatibilityReport,
  DefinitionRevisionStrategy,
  DefinitionValidationFinding,
  DefinitionValidationReport,
  IndustryAttributeValueType,
  RevisionString,
  SemanticDefinitionRecord,
  UnsupportedDefinitionRule,
  Uuid,
} from '@ontology/contracts'
import type { MountedAttributeTerm, MountedDefinitionTerminology } from './terminology'

/**
 * Pure definition projection, validation and compatibility logic (SPEC v0.3a §3.1/§3.3/§4,
 * issue V03-009 / #183). Kept free of I/O so the same rules run in unit tests, the service and
 * a future validation stage. An unsupported rule is preserved as a non-executable finding,
 * never dropped; a duplicate identifier, dangling endpoint, wrong unit or illegal
 * type/cardinality is a blocker that prevents publication.
 */

export const HARD_DEFINITION_ISSUES: readonly AssetCandidateIssue['code'][] = [
  'KIND_NOT_ALLOWED',
  'LOGICAL_ID_COLLISION',
  'ENDPOINT_UNRESOLVED',
  'UNIT_CONFLICT',
  'INVALID_CARDINALITY',
  'INVALID_IDENTITY',
]

export function compareDefinitionCandidates(left: AssetCandidateVersion, right: AssetCandidateVersion): number {
  if (left.recordedAt !== right.recordedAt) return left.recordedAt < right.recordedAt ? -1 : 1
  return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0
}

/**
 * The current definition projection: the head of every replacement chain, excluding rejected
 * candidates. Generation and editing append immutable revisions, so a later revision
 * supersedes an earlier one without deleting it; validation must look only at the head.
 */
export function currentDefinitionProjection(
  candidates: readonly AssetCandidateVersion[],
): AssetCandidateVersion[] {
  const replaced = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.replacesCandidateId !== undefined) replaced.add(candidate.replacesCandidateId)
  }
  return candidates
    .filter((candidate) => candidate.state !== 'rejected' && !replaced.has(candidate.candidateId))
    .sort(compareDefinitionCandidates)
}

export interface DefinitionValidationContext {
  readonly workspaceId: Uuid
  readonly revision: RevisionString
  readonly terminology: MountedDefinitionTerminology
  readonly compatibility: DefinitionCompatibilityReport
  readonly strategy?: DefinitionRevisionStrategy
  readonly unsupportedRules?: readonly UnsupportedDefinitionRule[]
  /** Only publication validation enforces the revision-strategy requirement. */
  readonly enforceRevisionStrategy?: boolean
}

/** Shared strategy validation for editing validation and the final publication gate. */
export function definitionRevisionStrategyProblem(strategy: DefinitionRevisionStrategy | undefined, publishedRef: DefinitionCompatibilityReport['publishedRef']): string | undefined {
  if (strategy === undefined) return undefined
  if (!['new_version', 'keep_independent', 'retire_previous'].includes(strategy.kind) ||
      typeof strategy.reason !== 'string' || strategy.reason.trim().length === 0) return 'revision strategy needs a supported kind and a reason'
  if (strategy.kind === 'retire_previous' && (strategy.supersedesRef === undefined || publishedRef === undefined)) return 'retirement must pin the published predecessor'
  const ref = strategy.supersedesRef
  if (ref !== undefined && (ref.id !== publishedRef?.id || ref.version !== publishedRef.version || ref.digest !== publishedRef.digest)) return 'revision strategy pins a different published predecessor'
  return undefined
}

function blocker(
  finding: Omit<DefinitionValidationFinding, 'severity'>,
): DefinitionValidationFinding {
  return { ...finding, severity: 'blocker' }
}

function warning(
  finding: Omit<DefinitionValidationFinding, 'severity'>,
): DefinitionValidationFinding {
  return { ...finding, severity: 'warning' }
}

interface ProjectionIndex {
  readonly byLogicalId: Map<string, AssetCandidateVersion>
  readonly duplicates: Map<string, AssetCandidateVersion[]>
  readonly objects: Set<string>
  readonly attributes: Map<string, { objectLogicalId: string; payload: DefinitionCandidatePayload }>
}

function indexProjection(
  projection: readonly AssetCandidateVersion[],
  terminology: MountedDefinitionTerminology,
): ProjectionIndex {
  const byLogicalId = new Map<string, AssetCandidateVersion>()
  const duplicates = new Map<string, AssetCandidateVersion[]>()
  const objects = new Set<string>(terminology.objectLogicalIds)
  const attributes = new Map<string, { objectLogicalId: string; payload: DefinitionCandidatePayload }>()

  for (const candidate of projection) {
    const existing = byLogicalId.get(candidate.logicalId)
    if (existing === undefined) {
      byLogicalId.set(candidate.logicalId, candidate)
    } else {
      const group = duplicates.get(candidate.logicalId) ?? [existing]
      group.push(candidate)
      duplicates.set(candidate.logicalId, group)
    }
  }
  for (const candidate of projection) {
    if (candidate.payload.kind === 'object') objects.add(candidate.payload.logicalId)
    if (candidate.payload.kind === 'attribute') {
      attributes.set(candidate.payload.logicalId, {
        objectLogicalId: candidate.payload.objectLogicalId,
        payload: candidate.payload,
      })
    }
  }
  for (const attribute of terminology.attributes) {
    if (!attributes.has(attribute.logicalId)) {
      attributes.set(attribute.logicalId, { objectLogicalId: attribute.objectLogicalId, payload: mountAttribute(attribute) })
    }
  }
  return { byLogicalId, duplicates, objects, attributes }
}

function mountAttribute(attribute: MountedAttributeTerm): DefinitionCandidatePayload {
  return {
    kind: 'attribute',
    logicalId: attribute.logicalId,
    displayName: attribute.logicalId,
    businessMeaning: '',
    suggestedReason: '',
    conflicts: [],
    objectLogicalId: attribute.objectLogicalId,
    valueType: attribute.valueType,
    ...(attribute.unitCode === undefined ? {} : { unitCode: attribute.unitCode }),
    ...(attribute.dimension === undefined ? {} : { dimension: attribute.dimension }),
    minCardinality: 0,
    maxCardinality: 'unbounded',
  }
}

function path(suffix: string): string {
  return `payload.${suffix}`
}

/**
 * Validate one definition projection (the current draft set). Returns an explicit, queryable
 * report; a blocker prevents publication instead of being coerced away.
 */
export function validateDefinitionProjection(
  projection: readonly AssetCandidateVersion[],
  context: DefinitionValidationContext,
): DefinitionValidationReport {
  const findings: DefinitionValidationFinding[] = []
  const index = indexProjection(projection, context.terminology)

  for (const [logicalId, group] of index.duplicates) {
    for (const candidate of group) {
      findings.push(
        blocker({
          code: 'DUPLICATE_IDENTIFIER',
          candidateId: candidate.candidateId,
          logicalId,
          path: path('logicalId'),
          message: `logicalId "${logicalId}" is declared by ${String(group.length)} current revisions`,
        }),
      )
    }
  }

  for (const candidate of projection) {
    findings.push(...validateCandidate(candidate, index, context.terminology))
  }

  if (context.enforceRevisionStrategy === true && context.compatibility.requiresRevisionStrategy && context.strategy === undefined) {
    for (const change of context.compatibility.breakingChanges) {
      findings.push(
        blocker({
          code: 'REVISION_STRATEGY_REQUIRED',
          candidateId: projection.find((candidate) => candidate.logicalId === change.logicalId)?.candidateId ?? emptyUuid(),
          logicalId: change.logicalId,
          path: 'compatibility',
          message: `${change.code} is a breaking change and needs an explicit revision strategy: ${change.message}`,
        }),
      )
    }
  }

  if (context.enforceRevisionStrategy === true && definitionRevisionStrategyProblem(context.strategy, context.compatibility.publishedRef) !== undefined) {
    findings.push(blocker({ code: 'REVISION_STRATEGY_INVALID', candidateId: emptyUuid(), logicalId: '',
      path: 'compatibility.strategy', message: 'revision strategy must name a supported kind, a reason and the current published predecessor when superseding' }))
  }

  const blockers = findings.filter((finding) => finding.severity === 'blocker')
  const warnings = findings.filter((finding) => finding.severity === 'warning')
  return {
    workspaceId: context.workspaceId,
    revision: context.revision,
    checkedCandidateIds: projection.map((candidate) => candidate.candidateId),
    blockers,
    warnings,
    nonExecutableRules: context.unsupportedRules ?? [],
    compatibility: context.compatibility,
    publishable: blockers.length === 0,
  }
}

function validateCandidate(
  candidate: AssetCandidateVersion,
  index: ProjectionIndex,
  terminology: MountedDefinitionTerminology,
): DefinitionValidationFinding[] {
  const payload = candidate.payload
  const out: DefinitionValidationFinding[] = []
  if (payload.kind === 'object') {
    if (payload.identityAttributeIds.length === 0) {
      out.push(
        warning({
          code: 'INVALID_IDENTITY',
          candidateId: candidate.candidateId,
          logicalId: payload.logicalId,
          path: path('identityAttributeIds'),
          message: `object "${payload.logicalId}" declares no identity attribute`,
        }),
      )
    }
    for (const identityId of payload.identityAttributeIds) {
      const attribute = index.attributes.get(identityId)
      if (attribute === undefined || attribute.payload.kind !== 'attribute') {
        out.push(
          blocker({
            code: 'INVALID_IDENTITY',
            candidateId: candidate.candidateId,
            logicalId: payload.logicalId,
            path: path('identityAttributeIds'),
            message: `identity attribute "${identityId}" does not resolve to a declared attribute`,
          }),
        )
        continue
      }
      if (attribute.objectLogicalId !== payload.logicalId) {
        out.push(
          blocker({
            code: 'INVALID_IDENTITY',
            candidateId: candidate.candidateId,
            logicalId: payload.logicalId,
            path: path('identityAttributeIds'),
            message: `identity attribute "${identityId}" belongs to object "${attribute.objectLogicalId}", not "${payload.logicalId}"`,
          }),
        )
      }
      if (attribute.payload.kind === 'attribute' && !isSingleRequired(attribute.payload)) {
        out.push(
          warning({
            code: 'INVALID_IDENTITY',
            candidateId: candidate.candidateId,
            logicalId: payload.logicalId,
            path: path('identityAttributeIds'),
            message: `identity attribute "${identityId}" should have cardinality 1..1`,
          }),
        )
      }
    }
    return out
  }

  if (payload.kind === 'attribute') {
    if (!index.objects.has(payload.objectLogicalId)) {
      out.push(
        blocker({
          code: 'DANGLING_ENDPOINT',
          candidateId: candidate.candidateId,
          logicalId: payload.logicalId,
          path: path('objectLogicalId'),
          message: `attribute "${payload.logicalId}" belongs to object "${payload.objectLogicalId}" that is neither declared nor mounted`,
        }),
      )
    }
    const mounted = terminology.attributes.find((attribute) => attribute.logicalId === payload.logicalId)
    if (mounted !== undefined && mounted.valueType !== payload.valueType) {
      out.push(
        warning({
          code: 'DEFINITION_CONFLICT',
          candidateId: candidate.candidateId,
          logicalId: payload.logicalId,
          path: path('valueType'),
          message: `attribute "${payload.logicalId}" is mounted as ${mounted.valueType}, not ${payload.valueType}`,
        }),
      )
    }
    out.push(...validateAttributeTypeUnitCardinality(candidate))
    if (payload.referencesObjectLogicalId !== undefined && !index.objects.has(payload.referencesObjectLogicalId)) {
      out.push(
        blocker({
          code: 'DANGLING_ENDPOINT',
          candidateId: candidate.candidateId,
          logicalId: payload.logicalId,
          path: path('referencesObjectLogicalId'),
          message: `attribute "${payload.logicalId}" references object "${payload.referencesObjectLogicalId}" that is neither declared nor mounted`,
        }),
      )
    }
    return out
  }

  if (!index.objects.has(payload.fromObjectLogicalId)) {
    out.push(
      blocker({
        code: 'DANGLING_ENDPOINT',
        candidateId: candidate.candidateId,
        logicalId: payload.logicalId,
        path: path('fromObjectLogicalId'),
        message: `relation "${payload.logicalId}" starts at object "${payload.fromObjectLogicalId}" that is neither declared nor mounted`,
      }),
    )
  }
  if (!index.objects.has(payload.toObjectLogicalId)) {
    out.push(
      blocker({
        code: 'DANGLING_ENDPOINT',
        candidateId: candidate.candidateId,
        logicalId: payload.logicalId,
        path: path('toObjectLogicalId'),
        message: `relation "${payload.logicalId}" ends at object "${payload.toObjectLogicalId}" that is neither declared nor mounted`,
      }),
    )
  }
  if (!validCardinality(payload.minCardinality, payload.maxCardinality)) {
    out.push(
      blocker({
        code: 'INVALID_TYPE_CARDINALITY',
        candidateId: candidate.candidateId,
        logicalId: payload.logicalId,
        path: path('minCardinality'),
        message: `relation "${payload.logicalId}" declares an impossible cardinality ${String(payload.minCardinality)}..${String(payload.maxCardinality)}`,
      }),
    )
  }
  return out
}

function validateAttributeTypeUnitCardinality(candidate: AssetCandidateVersion): DefinitionValidationFinding[] {
  const payload = candidate.payload
  if (payload.kind !== 'attribute') return []
  const out: DefinitionValidationFinding[] = []
  const valueType = payload.valueType
  if (!validCardinality(payload.minCardinality, payload.maxCardinality)) {
    out.push(
      blocker({
        code: 'INVALID_TYPE_CARDINALITY',
        candidateId: candidate.candidateId,
        logicalId: payload.logicalId,
        path: path('minCardinality'),
        message: `attribute "${payload.logicalId}" declares an impossible cardinality ${String(payload.minCardinality)}..${String(payload.maxCardinality)}`,
      }),
    )
  }
  if (valueType === 'quantity') {
    if (payload.unitCode === undefined || payload.unitCode.length === 0) {
      out.push(
        blocker({
          code: 'UNIT_MISMATCH',
          candidateId: candidate.candidateId,
          logicalId: payload.logicalId,
          path: path('unitCode'),
          message: `quantity attribute "${payload.logicalId}" declares no unit`,
        }),
      )
    }
  } else if (payload.unitCode !== undefined || payload.dimension !== undefined) {
    out.push(
      blocker({
        code: 'UNIT_MISMATCH',
        candidateId: candidate.candidateId,
        logicalId: payload.logicalId,
        path: path('unitCode'),
        message: `${valueType} attribute "${payload.logicalId}" declares a unit that is only valid for a quantity`,
      }),
    )
  }
  if (valueType === 'enum') {
    if (payload.enumValues === undefined || payload.enumValues.length === 0) {
      out.push(
        blocker({
          code: 'INVALID_TYPE_CARDINALITY',
          candidateId: candidate.candidateId,
          logicalId: payload.logicalId,
          path: path('enumValues'),
          message: `enum attribute "${payload.logicalId}" declares no enum values`,
        }),
      )
    }
  } else if (payload.enumValues !== undefined) {
    out.push(
      blocker({
        code: 'INVALID_TYPE_CARDINALITY',
        candidateId: candidate.candidateId,
        logicalId: payload.logicalId,
        path: path('enumValues'),
        message: `${valueType} attribute "${payload.logicalId}" must not declare enum values`,
      }),
    )
  }
  if (valueType === 'reference') {
    if (payload.referencesObjectLogicalId === undefined) {
      out.push(
        blocker({
          code: 'INVALID_TYPE_CARDINALITY',
          candidateId: candidate.candidateId,
          logicalId: payload.logicalId,
          path: path('referencesObjectLogicalId'),
          message: `reference attribute "${payload.logicalId}" declares no target object`,
        }),
      )
    }
  } else if (payload.referencesObjectLogicalId !== undefined) {
    out.push(
      blocker({
        code: 'INVALID_TYPE_CARDINALITY',
        candidateId: candidate.candidateId,
        logicalId: payload.logicalId,
        path: path('referencesObjectLogicalId'),
        message: `${valueType} attribute "${payload.logicalId}" must not declare a reference target`,
      }),
    )
  }
  return out
}

function validCardinality(min: number, max: number | 'unbounded'): boolean {
  if (!Number.isInteger(min) || min < 0) return false
  if (max === 'unbounded') return true
  return Number.isInteger(max) && max >= 0 && min <= max
}

function isSingleRequired(payload: DefinitionCandidatePayload): boolean {
  return (
    payload.kind === 'attribute' &&
    payload.minCardinality === 1 &&
    payload.maxCardinality === 1
  )
}

function emptyUuid(): Uuid {
  return '00000000-0000-4000-8000-000000000000'
}

/* ------------------------------------------------------------------------------------- */
/* Compatibility diff against a published version                                         */
/* ------------------------------------------------------------------------------------- */

interface PublishedIndex {
  readonly objects: Map<string, SemanticDefinitionRecord['objects'][number]>
  readonly attributes: Map<string, SemanticDefinitionRecord['attributes'][number]>
  readonly relations: Map<string, SemanticDefinitionRecord['relations'][number]>
  readonly identityByObject: Map<string, readonly string[]>
}

function indexPublished(published: SemanticDefinitionRecord): PublishedIndex {
  const objects = new Map(published.objects.map((object) => [object.id, object]))
  const attributes = new Map(published.attributes.map((attribute) => [attribute.id, attribute]))
  const relations = new Map(published.relations.map((relation) => [relation.id, relation]))
  const identityByObject = new Map(
    published.identityScopes.map((scope) => [scope.objectId, [...scope.identityAttributeIds].sort()]),
  )
  return { objects, attributes, relations, identityByObject }
}

function change(
  entry: Omit<DefinitionChange, 'breaking'> & { readonly breaking: boolean },
): DefinitionChange {
  return entry
}

/**
 * Compare the current projection with the published definition version. A change that could
 * reinterpret or invalidate already published instances is `breaking` and needs an explicit
 * revision strategy before publication; the old run/instance/history is never rewritten.
 */
export function diffDefinitionProjection(
  projection: readonly Pick<AssetCandidateVersion, 'payload' | 'logicalId' | 'kind'>[],
  published: SemanticDefinitionRecord | undefined,
  meta: { readonly workspaceId: Uuid; readonly revision: RevisionString; readonly publishedRef?: DefinitionCompatibilityReport['publishedRef']; readonly strategy?: DefinitionRevisionStrategy },
): DefinitionCompatibilityReport {
  if (published === undefined) {
    return {
      workspaceId: meta.workspaceId,
      revision: meta.revision,
      ...(meta.publishedRef === undefined ? {} : { publishedRef: meta.publishedRef }),
      additions: projection.map((candidate) => ({ code: candidate.kind === 'object' ? 'OBJECT_ADDED' : candidate.kind === 'attribute' ? 'ATTRIBUTE_ADDED' : 'RELATION_ADDED',
        logicalId: candidate.logicalId, kind: candidate.kind, breaking: false, message: `new ${candidate.kind} "${candidate.logicalId}"` })),
      changes: [],
      breakingChanges: [],
      requiresRevisionStrategy: false,
      ...(meta.strategy === undefined ? {} : { strategy: meta.strategy }),
    }
  }
  const index = indexPublished(published)
  const additions: DefinitionChange[] = []
  const changes: DefinitionChange[] = []
  const seen = new Set<string>()

  for (const candidate of projection) {
    const payload = candidate.payload
    seen.add(`${payload.kind}\u0000${payload.logicalId}`)
    if (payload.kind === 'object') {
      const before = index.objects.get(payload.logicalId)
      if (before === undefined) {
        additions.push(change({ code: 'OBJECT_ADDED', logicalId: payload.logicalId, kind: 'object', breaking: false, message: `new object "${payload.logicalId}"` }))
        continue
      }
      const beforeIdentity = index.identityByObject.get(payload.logicalId) ?? []
      const afterIdentity = [...payload.identityAttributeIds].sort()
      if (beforeIdentity.join(',') !== afterIdentity.join(',')) {
        changes.push(change({
          code: 'IDENTITY_CHANGED',
          logicalId: payload.logicalId,
          kind: 'object',
          breaking: true,
          message: `identity attributes of "${payload.logicalId}" changed`,
          before: beforeIdentity.join(','),
          after: afterIdentity.join(','),
        }))
      }
      if (before.displayName !== payload.displayName) {
        changes.push(change({ code: 'OBJECT_CHANGED', logicalId: payload.logicalId, kind: 'object', breaking: false, message: `display name of "${payload.logicalId}" changed` }))
      }
    } else if (payload.kind === 'attribute') {
      const before = index.attributes.get(payload.logicalId)
      if (before === undefined) {
        additions.push(change({ code: 'ATTRIBUTE_ADDED', logicalId: payload.logicalId, kind: 'attribute', breaking: false, message: `new attribute "${payload.logicalId}"` }))
        continue
      }
      if (before.valueType !== payload.valueType) {
        changes.push(change({ code: 'VALUE_TYPE_CHANGED', logicalId: payload.logicalId, kind: 'attribute', breaking: true, message: `value type of "${payload.logicalId}" changed`, before: before.valueType, after: payload.valueType }))
      }
      if ((before.unit?.unitCode ?? undefined) !== payload.unitCode || before.unit?.dimension !== (payload.unitCode === undefined ? undefined : payload.dimension ?? 'unspecified')) {
        changes.push(change({ code: 'UNIT_CHANGED', logicalId: payload.logicalId, kind: 'attribute', breaking: true, message: `unit of "${payload.logicalId}" changed`, ...(before.unit === undefined ? {} : { before: before.unit.unitCode }), ...(payload.unitCode === undefined ? {} : { after: payload.unitCode }) }))
      }
      if (before.objectId !== payload.objectLogicalId) {
        changes.push(change({ code: 'ATTRIBUTE_CHANGED', logicalId: payload.logicalId, kind: 'attribute', breaking: true, message: `owning object of "${payload.logicalId}" changed`, before: before.objectId, after: payload.objectLogicalId }))
      }
      if ((before.referencesObjectId ?? undefined) !== payload.referencesObjectLogicalId) {
        changes.push(change({ code: 'REFERENCE_CHANGED', logicalId: payload.logicalId, kind: 'attribute', breaking: true, message: `reference target of "${payload.logicalId}" changed` }))
      }
      if (narrowed(before, payload)) {
        changes.push(change({ code: 'CARDINALITY_CHANGED', logicalId: payload.logicalId, kind: 'attribute', breaking: true, message: `cardinality of "${payload.logicalId}" narrowed`, before: cardinalityLabel(before.cardinality.min, before.cardinality.max), after: cardinalityLabel(payload.minCardinality, payload.maxCardinality) }))
      }
    } else {
      const before = index.relations.get(payload.logicalId)
      if (before === undefined) {
        additions.push(change({ code: 'RELATION_ADDED', logicalId: payload.logicalId, kind: 'relation', breaking: false, message: `new relation "${payload.logicalId}"` }))
        continue
      }
      if (before.fromObjectId !== payload.fromObjectLogicalId || before.toObjectId !== payload.toObjectLogicalId) {
        changes.push(change({ code: 'RELATION_CHANGED', logicalId: payload.logicalId, kind: 'relation', breaking: true, message: `endpoints of "${payload.logicalId}" changed`, before: `${before.fromObjectId}->${before.toObjectId}`, after: `${payload.fromObjectLogicalId}->${payload.toObjectLogicalId}` }))
      }
      if (narrowed(before, payload)) {
        changes.push(change({ code: 'CARDINALITY_CHANGED', logicalId: payload.logicalId, kind: 'relation', breaking: true, message: `cardinality of "${payload.logicalId}" narrowed` }))
      }
    }
  }

  for (const object of published.objects) {
    if (!seen.has(`object\u0000${object.id}`)) {
      changes.push(change({ code: 'OBJECT_REMOVED', logicalId: object.id, kind: 'object', breaking: true, message: `object "${object.id}" was removed` }))
    }
  }
  for (const attribute of published.attributes) {
    if (!seen.has(`attribute\u0000${attribute.id}`)) {
      changes.push(change({ code: 'ATTRIBUTE_REMOVED', logicalId: attribute.id, kind: 'attribute', breaking: true, message: `attribute "${attribute.id}" was removed` }))
    }
  }
  for (const relation of published.relations) {
    if (!seen.has(`relation\u0000${relation.id}`)) {
      changes.push(change({ code: 'RELATION_REMOVED', logicalId: relation.id, kind: 'relation', breaking: true, message: `relation "${relation.id}" was removed` }))
    }
  }

  const breakingChanges = changes.filter((entry) => entry.breaking)
  return {
    workspaceId: meta.workspaceId,
    revision: meta.revision,
    ...(meta.publishedRef === undefined ? {} : { publishedRef: meta.publishedRef }),
    additions,
    changes,
    breakingChanges,
    requiresRevisionStrategy: breakingChanges.length > 0,
    ...(meta.strategy === undefined ? {} : { strategy: meta.strategy }),
  }
}

function cardinalityLabel(min: number, max: number | 'unbounded'): string {
  return `${String(min)}..${String(max)}`
}

function narrowed(
  before: { readonly cardinality: { readonly min: number; readonly max: number | 'unbounded' } },
  after: { readonly minCardinality: number; readonly maxCardinality: number | 'unbounded' },
): boolean {
  if (after.minCardinality > before.cardinality.min) return true
  if (before.cardinality.max === 'unbounded') return after.maxCardinality !== 'unbounded'
  if (after.maxCardinality === 'unbounded') return false
  return after.maxCardinality < before.cardinality.max
}

/* ------------------------------------------------------------------------------------- */
/* Affected definitions (blast radius of a merge/split/edit)                              */
/* ------------------------------------------------------------------------------------- */

export function computeAffectedDefinitions(
  projection: readonly AssetCandidateVersion[],
  changedLogicalIds: readonly string[],
): DefinitionAffectedDefinition[] {
  const changed = new Set(changedLogicalIds)
  const out: DefinitionAffectedDefinition[] = []
  const seen = new Set<string>()

  const push = (entry: DefinitionAffectedDefinition): void => {
    const key = `${entry.logicalId}\u0000${entry.role}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(entry)
  }

  for (const candidate of projection) {
    const payload = candidate.payload
    if (changed.has(payload.logicalId)) {
      push({
        logicalId: payload.logicalId,
        role: payload.kind as DefinitionAffectedRole,
        relatedCandidateIds: [candidate.candidateId],
        impact: `the ${payload.kind} definition itself changed`,
      })
    }
    if (payload.kind === 'attribute') {
      if (changed.has(payload.objectLogicalId)) {
        push({
          logicalId: payload.objectLogicalId,
          role: 'object',
          relatedCandidateIds: [candidate.candidateId],
          impact: `owns attribute "${payload.logicalId}"`,
        })
      }
      if (payload.referencesObjectLogicalId !== undefined && changed.has(payload.referencesObjectLogicalId)) {
        push({
          logicalId: payload.referencesObjectLogicalId,
          role: 'object',
          relatedCandidateIds: [candidate.candidateId],
          impact: `is referenced by attribute "${payload.logicalId}"`,
        })
      }
    }
    if (payload.kind === 'relation') {
      for (const endpoint of [payload.fromObjectLogicalId, payload.toObjectLogicalId]) {
        if (changed.has(endpoint)) {
          push({
            logicalId: endpoint,
            role: 'object',
            relatedCandidateIds: [candidate.candidateId],
            impact: `is an endpoint of relation "${payload.logicalId}"`,
          })
        }
      }
    }
    if (payload.kind === 'object') {
      for (const identityId of payload.identityAttributeIds) {
        if (changed.has(identityId)) {
          push({
            logicalId: payload.logicalId,
            role: 'identity',
            relatedCandidateIds: [candidate.candidateId],
            impact: `identity attribute "${identityId}" changed`,
          })
        }
      }
    }
  }
  return out
}

/** Map a validation finding onto the persisted candidate issue code. */
export function issueCodeFor(finding: DefinitionValidationFinding): AssetCandidateIssue['code'] {
  switch (finding.code) {
    case 'DUPLICATE_IDENTIFIER':
      return 'LOGICAL_ID_COLLISION'
    case 'DANGLING_ENDPOINT':
      return 'ENDPOINT_UNRESOLVED'
    case 'UNIT_MISMATCH':
      return 'UNIT_CONFLICT'
    case 'INVALID_TYPE_CARDINALITY':
      return 'INVALID_CARDINALITY'
    case 'INVALID_IDENTITY':
      return 'INVALID_IDENTITY'
    case 'DEFINITION_CONFLICT':
      return 'TERMINOLOGY_MISMATCH'
    case 'REVISION_STRATEGY_REQUIRED':
    case 'REVISION_STRATEGY_INVALID':
    case 'CANDIDATE_NOT_APPROVED':
      return 'INVALID_MODEL_OUTPUT'
  }
}

/** Convert validation findings into the persisted, queryable candidate issues. */
export function issuesForCandidate(
  candidateId: Uuid,
  findings: readonly DefinitionValidationFinding[],
): AssetCandidateIssue[] {
  return findings
    .filter((finding) => finding.candidateId === candidateId)
    .map((finding) => ({
      code: issueCodeFor(finding),
      message: finding.message,
      path: finding.path,
    }))
}

/** The `IndustryAttributeValueType` values this validation accepts, for a route boundary. */
export function isDeclaredAttributeValueType(value: unknown): value is IndustryAttributeValueType {
  return (
    value === 'string' ||
    value === 'number' ||
    value === 'boolean' ||
    value === 'timestamp' ||
    value === 'enum' ||
    value === 'quantity' ||
    value === 'reference'
  )
}
