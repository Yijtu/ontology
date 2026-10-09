import {
  isActionCandidateVersion,
  packMaturityLabelOf,
} from '@ontology/contracts'
import type {
  ActionCandidateVersion,
  AssetCandidateVersion,
  AttributeDefinition,
  CapabilityRequirement,
  DefinitionAttributeCandidate,
  DefinitionObjectCandidate,
  DefinitionRelationCandidate,
  IndustryManifest,
  IndustryMaturity,
  IndustryValidationReport,
  IndustryWorkspace,
  ObjectDefinition,
  PackActionDeclarationPin,
  PackAsset,
  PackCapabilityStatus,
  PackSourceIndex,
  PackSourceIndexEntry,
  PackTestCase,
  PackTestSuite,
  PackVersionChange,
  PackVersionChangeScope,
  PackVersionDiff,
  PublishedPackAsset,
  PublishedPackAssetDraft,
  RelationDefinition,
  ResourceRef,
  RuleActionCandidateVersion,
  ScopeRef,
  Semver,
  SemanticDefinitionRecord,
  SemanticDefinitionVersionDraft,
  Sha256Digest,
  StandardProvenance,
  UnitRef,
  VersionRef,
  DefinitionApprovalPin,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../../profiles/canonical'
import { diffDefinitionProjection } from '../definition-candidates/validation'
import { publishedRuleDeclarationsOf } from './publication-pins'

/**
 * Pure assembly of an immutable industry pack from a human-reviewed draft and its validation
 * report (SPEC v0.3a §3.1/§4.2/§6.1, V03-015 / #187).
 *
 * Everything here is deterministic and free of I/O: the same projection, rule/action candidates
 * and validation report always produce the same definition version, source index, capability
 * state and content digest. The service composes these helpers with the persistence ports; the
 * pure functions are the ones unit-tested directly.
 *
 * The assembly never copies a customer value: a definition candidate contributes only its
 * semantic declaration, and the source index stores authorized refs (marked redacted) instead of
 * any full text, physical address or credential (INV-03/ADR-03).
 */

/** The wire version of a dynamically published pack asset. Bump only on an incompatible change. */
export const PACK_PUBLICATION_VERSION = '1.0.0'

/** The fallback capability a semantics-only pack declares when it binds no executable action. */
export const DEFAULT_PACK_CAPABILITY = 'semantic_read'

export function contentDigestOf(value: unknown): Sha256Digest {
  return sha256DigestOf(canonicalJson(value))
}

/** Recompute the immutable publication pin using the same complete semantics as assembly. */
export function publishedPackContentDigest(asset: PublishedPackAsset | PublishedPackAssetDraft): Sha256Digest {
  const action = asset.packAsset.actionDeclarationsRef
  return contentDigestOf({ namespace: asset.namespace, maturity: asset.maturity, manifest: asset.manifest, definitionRef: asset.definitionRef,
    sourceIndexDigest: asset.sourceIndex.digest, capabilities: asset.capabilities, validationId: asset.validationRef.id, validationDigest: asset.validationRef.digest,
    strategy: asset.strategy, approvalPins: asset.approvalPins, ruleActionPins: asset.ruleActionPins, ruleReviewPins: asset.ruleReviewPins ?? [],
    actionDeclarationsRef: action === undefined ? undefined : { id: action.id, version: asset.packRef.version, digest: action.digest } })
}

function artifactRef(id: string, version: Semver, digest: Sha256Digest): VersionRef {
  return { id, version, digest }
}

/* ----------------------------------------------------------------------------------------- */
/* Source index                                                                               */
/* ----------------------------------------------------------------------------------------- */

function sourceRefKey(ref: ResourceRef): string {
  return `${ref.id}@${ref.version}#${ref.digest}`
}

/**
 * Build the authorized/redacted source index of a pack. Candidate source refs are authorized
 * declarations; the confirmed synthetic example set is marked redacted. No customer full text is
 * ever included, so the index never reaches the forbidden-field / credential scanner.
 */
export function buildSourceIndexEntries(args: {
  readonly projection: readonly AssetCandidateVersion[]
  readonly ruleActions: readonly RuleActionCandidateVersion[]
  readonly syntheticExampleRef?: ResourceRef
}): PackSourceIndexEntry[] {
  const entries: PackSourceIndexEntry[] = []
  const seen = new Set<string>()
  const push = (entry: PackSourceIndexEntry): void => {
    const key = `${entry.kind}\u0000${sourceRefKey(entry.ref)}`
    if (seen.has(key)) return
    seen.add(key)
    entries.push(entry)
  }
  for (const candidate of args.projection) {
    for (const ref of candidate.sourceRefs) {
      push({ kind: 'declaration', ref, label: `source for ${candidate.logicalId}`, redacted: false })
    }
  }
  for (const candidate of args.ruleActions) {
    for (const ref of candidate.sourceRefs) {
      push({ kind: 'declaration', ref, label: `source for ${candidate.logicalId}`, redacted: false })
    }
  }
  if (args.syntheticExampleRef !== undefined) {
    push({ kind: 'redacted_source', ref: args.syntheticExampleRef, label: 'synthetic validation sample', redacted: true })
  }
  return entries.sort((left, right) => {
    const leftKey = `${left.kind}\u0000${sourceRefKey(left.ref)}`
    const rightKey = `${right.kind}\u0000${sourceRefKey(right.ref)}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

/** The deterministic digest of a source index; the pack pins it and a reader can re-verify it. */
export function sourceIndexDigest(entries: readonly PackSourceIndexEntry[]): Sha256Digest {
  return contentDigestOf(entries)
}

/* ----------------------------------------------------------------------------------------- */
/* Definition version                                                                         */
/* ----------------------------------------------------------------------------------------- */

function unitOf(payload: DefinitionAttributeCandidate): UnitRef | undefined {
  if (payload.unitCode === undefined) return undefined
  return { unitCode: payload.unitCode, dimension: payload.dimension ?? 'unspecified' }
}

/**
 * Build the immutable definition version from the current definition projection. Object,
 * attribute and relation candidates map one-to-one; each object gains an identity scope from its
 * declared identity attributes. Rule constraints stay in the pinned rule-declaration artifact, so
 * this record never reinterprets the frozen rule AST.
 */
export function buildDefinitionRecord(args: {
  readonly workspace: IndustryWorkspace
  readonly scopeRef: ScopeRef
  readonly definitionId: string
  readonly version: Semver
  readonly baseRef?: VersionRef
  readonly projection: readonly AssetCandidateVersion[]
  readonly standardProvenance: readonly StandardProvenance[]
  readonly publishedAt: string
}): SemanticDefinitionRecord {
  const namespace = args.workspace.namespace
  const objects = args.projection.filter(
    (candidate): candidate is AssetCandidateVersion & { readonly payload: DefinitionObjectCandidate } =>
      candidate.payload.kind === 'object',
  )
  const attributes = args.projection.filter(
    (candidate): candidate is AssetCandidateVersion & { readonly payload: DefinitionAttributeCandidate } =>
      candidate.payload.kind === 'attribute',
  )
  const relations = args.projection.filter(
    (candidate): candidate is AssetCandidateVersion & { readonly payload: DefinitionRelationCandidate } =>
      candidate.payload.kind === 'relation',
  )

  const identityKeys = new Set<string>()
  for (const object of objects) {
    for (const attributeId of object.payload.identityAttributeIds) identityKeys.add(attributeId)
  }

  const objectDefinitions: ObjectDefinition[] = objects
    .map((candidate) => ({
      kind: 'object' as const,
      id: candidate.payload.logicalId,
      namespace,
      displayName: candidate.payload.displayName,
      identityScopeId: `${candidate.payload.logicalId}.identity`,
      standardProvenance: args.standardProvenance,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

  const attributeDefinitions: AttributeDefinition[] = attributes
    .map((candidate) => {
      const payload = candidate.payload
      const unit = unitOf(payload)
      return {
        kind: 'attribute' as const,
        id: payload.logicalId,
        namespace,
        objectId: payload.objectLogicalId,
        valueType: payload.valueType,
        cardinality: { min: payload.minCardinality, max: payload.maxCardinality },
        ...(identityKeys.has(payload.logicalId) ? { identityKey: true } : {}),
        ...(unit === undefined ? {} : { unit }),
        ...(payload.enumValues === undefined ? {} : { enumValues: payload.enumValues }),
        ...(payload.referencesObjectLogicalId === undefined
          ? {}
          : { referencesObjectId: payload.referencesObjectLogicalId }),
        standardProvenance: args.standardProvenance,
      } satisfies AttributeDefinition
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

  const relationDefinitions: RelationDefinition[] = relations
    .map((candidate) => {
      const payload = candidate.payload
      return {
        kind: 'relation' as const,
        id: payload.logicalId,
        namespace,
        fromObjectId: payload.fromObjectLogicalId,
        toObjectId: payload.toObjectLogicalId,
        cardinality: { min: payload.minCardinality, max: payload.maxCardinality },
        standardProvenance: args.standardProvenance,
      } satisfies RelationDefinition
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

  const identityScopes = objects
    .filter((candidate) => candidate.payload.identityAttributeIds.length > 0)
    .map((candidate) => ({
      kind: 'identity_scope' as const,
      id: `${candidate.payload.logicalId}.identity`,
      namespace,
      objectId: candidate.payload.logicalId,
      scopeDimensions: [...(candidate.payload.identityScopeDimensions ?? [])],
      identityAttributeIds: [...candidate.payload.identityAttributeIds],
      standardProvenance: args.standardProvenance,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

  const draft: SemanticDefinitionVersionDraft = {
    scopeRef: args.scopeRef,
    definitionId: args.definitionId,
    version: args.version,
    namespace,
    layer: 'industry_core',
    ...(args.baseRef === undefined ? {} : { baseRef: args.baseRef }),
    standardProvenance: args.standardProvenance,
    objects: objectDefinitions,
    attributes: attributeDefinitions,
    relations: relationDefinitions,
    identityScopes,
    ruleConstraints: [],
  }
  const digest = definitionVersionDigestOf(draft)
  return {
    ref: artifactRef(args.definitionId, args.version, digest),
    publishedAt: args.publishedAt,
    definitionId: args.definitionId,
    version: args.version,
    namespace,
    layer: 'industry_core',
    ...(args.baseRef === undefined ? {} : { baseRef: args.baseRef }),
    standardProvenance: args.standardProvenance,
    objects: objectDefinitions,
    attributes: attributeDefinitions,
    relations: relationDefinitions,
    identityScopes,
    ruleConstraints: [],
  }
}

/** Content digest of a definition version; covers the declaration only, never the scope. */
export function definitionVersionDigestOf(draft: SemanticDefinitionVersionDraft): Sha256Digest {
  return contentDigestOf({
    namespace: draft.namespace,
    layer: draft.layer,
    baseRef: draft.baseRef,
    standardProvenance: draft.standardProvenance,
    objects: draft.objects,
    attributes: draft.attributes,
    relations: draft.relations,
    identityScopes: draft.identityScopes,
    ruleConstraints: draft.ruleConstraints,
  })
}

/* ----------------------------------------------------------------------------------------- */
/* Capability state                                                                           */
/* ----------------------------------------------------------------------------------------- */

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function requiredCapabilityNames(
  ruleActions: readonly RuleActionCandidateVersion[],
  extra: readonly CapabilityRequirement[],
): string[] {
  const names: string[] = []
  for (const candidate of ruleActions) {
    if (!isActionCandidateVersion(candidate)) continue
    for (const requirement of candidate.payload.declaration.requiredCapabilities) names.push(requirement.name)
  }
  for (const requirement of extra) names.push(requirement.name)
  return uniqueSorted(names)
}

/**
 * The two-surface capability state. `semanticPublished` and `deploymentExecutable` come straight
 * from the validation report gates and stay independent; per-action pins record which registered
 * implementation (if any) can run each declaration (SPEC §4.2/P.FR-15).
 */
export function buildCapabilityStatus(args: {
  readonly report: IndustryValidationReport
  readonly ruleActions: readonly RuleActionCandidateVersion[]
  readonly extraRequirements?: readonly CapabilityRequirement[]
}): PackCapabilityStatus {
  const validationByAction = new Map(args.report.actions.map((action) => [action.actionId, action]))
  const actionPins: PackActionDeclarationPin[] = []
  for (const candidate of args.ruleActions) {
    if (!isActionCandidateVersion(candidate)) continue
    const declaration = candidate.payload.declaration
    const result = validationByAction.get(declaration.actionId)
    actionPins.push({
      actionId: declaration.actionId,
      declarationRef: {
        id: candidate.candidateId,
        version: PACK_PUBLICATION_VERSION,
        digest: candidate.contentDigest,
        kind: 'artifact',
      },
      bindingStatus: result?.bindingStatus ?? 'not_executable',
      executable: result?.deploymentExecutable ?? false,
      requiredCapabilities: declaration.requiredCapabilities,
      missingCapabilities: result?.missingCapabilities ?? [],
    })
  }
  actionPins.sort((left, right) => (left.actionId < right.actionId ? -1 : left.actionId > right.actionId ? 1 : 0))
  const missing = new Set<string>()
  for (const action of args.report.actions) for (const name of action.missingCapabilities) missing.add(name)
  return {
    semanticPublished: args.report.semanticPublished.passed,
    deploymentExecutable: args.report.deploymentExecutable.passed,
    requiredCapabilities: requiredCapabilityNames(args.ruleActions, args.extraRequirements ?? []),
    missingCapabilities: uniqueSorted([...missing]),
    actions: actionPins,
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Test suite                                                                                 */
/* ----------------------------------------------------------------------------------------- */

export function buildTestSuite(report: IndustryValidationReport, namespace: string, version: Semver): PackTestSuite {
  const cases: PackTestCase[] = report.competency === undefined ? report.expectationResults
    .map((expectation): PackTestCase => ({
      caseId: expectation.caseId,
      question: expectation.question ?? `验证${expectation.kind === 'rule' ? '规则' : '动作'} ${expectation.targetId} 的声明行为`,
      expectedCapabilities: expectation.kind === 'action' ? [expectation.targetId] : [],
      expectedStatus: expectation.expected === 'executable' ? 'resolved' : 'missing_capabilities',
    }))
    .filter((entry, index, all) => all.findIndex((candidate) => candidate.caseId === entry.caseId) === index)
    .sort((left, right) => (left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0)) : report.competency.results.map((result) => ({
      caseId: result.questionId, question: result.question, expectedCapabilities: result.requiredCapabilities,
      expectedStatus: result.status, competencyQuestionRef: report.competency!.questionSetRef,
      definitionRef: result.definitionRef, ruleRefs: result.ruleRefs,
      sourceRefs: result.requiredSources.map((source) => source.sourceRef).filter((ref, index, all) => all.findIndex((other) => other.id === ref.id && other.version === ref.version && other.digest === ref.digest) === index), required: true,
    }))
  const ref = artifactRef(`${namespace}.test-suite`, version, contentDigestOf(cases))
  return { ref, cases }
}

/* ----------------------------------------------------------------------------------------- */
/* Version diff                                                                               */
/* ----------------------------------------------------------------------------------------- */

function compareRecords(previous: SemanticDefinitionRecord | undefined, next: SemanticDefinitionRecord, scope: PackVersionChangeScope): PackVersionChange[] {
  const projection: Pick<AssetCandidateVersion, 'payload' | 'logicalId' | 'kind'>[] = [
    ...next.objects.map((object) => ({ kind: 'object' as const, logicalId: object.id, displayName: object.displayName,
      identityAttributeIds: next.identityScopes.find((identity) => identity.objectId === object.id)?.identityAttributeIds ?? [],
      identityScopeDimensions: next.identityScopes.find((identity) => identity.objectId === object.id)?.scopeDimensions ?? [] })),
    ...next.attributes.map((attribute) => ({ kind: 'attribute' as const, logicalId: attribute.id, displayName: attribute.id,
      objectLogicalId: attribute.objectId, valueType: attribute.valueType, minCardinality: attribute.cardinality.min,
      maxCardinality: attribute.cardinality.max, ...(attribute.unit === undefined ? {} : { unitCode: attribute.unit.unitCode, dimension: attribute.unit.dimension }),
      ...(attribute.referencesObjectId === undefined ? {} : { referencesObjectLogicalId: attribute.referencesObjectId }) })),
    ...next.relations.map((relation) => ({ kind: 'relation' as const, logicalId: relation.id, displayName: relation.id,
      fromObjectLogicalId: relation.fromObjectId, toObjectLogicalId: relation.toObjectId, minCardinality: relation.cardinality.min, maxCardinality: relation.cardinality.max })),
  ].map((payload) => ({ logicalId: payload.logicalId, kind: payload.kind,
    payload: { ...payload, businessMeaning: '', suggestedReason: '', conflicts: [] } }))
  const diff = diffDefinitionProjection(projection, previous, { workspaceId: '00000000-0000-4000-8000-000000000000', revision: '0' })
  return [...diff.additions, ...diff.changes].map(({ code, kind, ...change }) => { void kind; return { ...change, scope, change: code } })
}

function compareActions(
  previous: readonly PackActionDeclarationPin[] | undefined,
  next: readonly PackActionDeclarationPin[],
): PackVersionChange[] {
  const changes: PackVersionChange[] = []
  if (previous === undefined) return changes
  const before = new Map(previous.map((pin) => [pin.actionId, pin]))
  const seen = new Set<string>()
  for (const pin of next) {
    seen.add(pin.actionId)
    const prior = before.get(pin.actionId)
    if (prior === undefined) {
      changes.push({ scope: 'action', change: 'ACTION_ADDED', logicalId: pin.actionId, breaking: false, message: `new action ${pin.actionId}` })
    } else if (prior.executable !== pin.executable) {
      changes.push({ scope: 'action', change: 'ACTION_EXECUTABILITY_CHANGED', logicalId: pin.actionId, breaking: false, message: `executability of ${pin.actionId} changed`, before: String(prior.executable), after: String(pin.executable) })
    }
  }
  for (const pin of previous) {
    if (!seen.has(pin.actionId)) {
      changes.push({ scope: 'action', change: 'ACTION_REMOVED', logicalId: pin.actionId, breaking: true, message: `action ${pin.actionId} was removed` })
    }
  }
  return changes
}

function compareCapabilities(previous: PackCapabilityStatus | undefined, next: PackCapabilityStatus): PackVersionChange[] {
  if (previous === undefined) return []
  const before = new Set(previous.requiredCapabilities)
  const after = new Set(next.requiredCapabilities)
  const changes: PackVersionChange[] = []
  for (const name of next.requiredCapabilities) {
    if (!before.has(name)) {
      changes.push({ scope: 'capability', change: 'CAPABILITY_ADDED', logicalId: name, breaking: false, message: `capability ${name} is now required` })
    }
  }
  for (const name of previous.requiredCapabilities) {
    if (!after.has(name)) {
      changes.push({ scope: 'capability', change: 'CAPABILITY_REMOVED', logicalId: name, breaking: true, message: `capability ${name} is no longer required` })
    }
  }
  if (previous.deploymentExecutable !== next.deploymentExecutable) {
    changes.push({ scope: 'capability', change: 'EXECUTABILITY_CHANGED', logicalId: 'deployment', breaking: false, message: 'deployment executability changed', before: String(previous.deploymentExecutable), after: String(next.deploymentExecutable) })
  }
  return changes
}

/** Diff the next pack content against the previous published version of the same namespace. */
export function buildVersionDiff(args: {
  readonly fromPackRef?: VersionRef
  readonly toPackRef: VersionRef
  readonly from?: { readonly definition: SemanticDefinitionRecord; readonly asset?: PublishedPackAsset }
  readonly toDefinition: SemanticDefinitionRecord
  readonly toCapabilities: PackCapabilityStatus
}): PackVersionDiff {
  const changes: PackVersionChange[] = [
    ...compareRecords(args.from?.definition, args.toDefinition, 'definition'),
    ...compareActions(args.from?.asset?.capabilities.actions, args.toCapabilities.actions),
    ...compareCapabilities(args.from?.asset?.capabilities, args.toCapabilities),
  ]
  changes.sort((left, right) => {
    const leftKey = `${left.scope}\u0000${left.logicalId}\u0000${left.change}`
    const rightKey = `${right.scope}\u0000${right.logicalId}\u0000${right.change}`
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
  const breakingChanges = changes.filter((change) => change.breaking)
  return {
    ...(args.fromPackRef === undefined ? {} : { fromPackRef: args.fromPackRef }),
    toPackRef: args.toPackRef,
    changes,
    breakingChanges,
    digest: contentDigestOf({ fromPackRef: args.fromPackRef, changes }),
  }
}

/* ----------------------------------------------------------------------------------------- */
/* Full assembly                                                                              */
/* ----------------------------------------------------------------------------------------- */

export interface AssemblePackArgs {
  readonly ruleReviewPins?: readonly DefinitionApprovalPin[]
  readonly workspace: IndustryWorkspace
  readonly scopeRef: ScopeRef
  readonly packId: string
  readonly version: Semver
  readonly definitionId: string
  readonly projection: readonly AssetCandidateVersion[]
  readonly ruleActions: readonly RuleActionCandidateVersion[]
  readonly report: IndustryValidationReport
  readonly syntheticExampleRef?: ResourceRef
  readonly previous?: { readonly definition: SemanticDefinitionRecord; readonly asset?: PublishedPackAsset; readonly packRef?: VersionRef }
  readonly publishedAt: string
  readonly idempotencyKey: string
  readonly actor: string
}

export interface AssembledPack {
  readonly definition: SemanticDefinitionRecord
  readonly asset: PublishedPackAssetDraft
}

/**
 * Assemble a full immutable pack. Ordering matters: the source index digest feeds the definition
 * provenance, and the pack content digest excludes the self-referential `toPackRef` in the diff so
 * the digest is acyclic.
 */
export function assemblePack(args: AssemblePackArgs): AssembledPack {
  const namespace = args.workspace.namespace
  const entries = buildSourceIndexEntries({
    projection: args.projection,
    ruleActions: args.ruleActions,
    ...(args.syntheticExampleRef === undefined ? {} : { syntheticExampleRef: args.syntheticExampleRef }),
  })
  const indexDigest = sourceIndexDigest(entries)
  const provenanceRef = artifactRef(`${namespace}.source-index`, args.version, indexDigest)
  const standardProvenance: StandardProvenance[] = [
    { standardRef: provenanceRef, provenanceKind: 'synthetic_assumption' },
  ]
  const previousRef = args.previous?.packRef ?? args.previous?.asset?.packRef
  const definition = buildDefinitionRecord({
    workspace: args.workspace,
    scopeRef: args.scopeRef,
    definitionId: args.definitionId,
    version: args.version,
    ...(previousRef === undefined ? {} : { baseRef: previousRef }),
    projection: args.projection,
    standardProvenance,
    publishedAt: args.publishedAt,
  })

  const capabilities = buildCapabilityStatus({
    report: args.report,
    ruleActions: args.ruleActions,
  })
  const testSuite = buildTestSuite(args.report, namespace, args.version)

  const requiredCapabilities: CapabilityRequirement[] =
    capabilities.requiredCapabilities.length > 0
      ? capabilities.requiredCapabilities.map((name) => ({ name, versionRange: { min: '1.0.0' } }))
      : [{ name: DEFAULT_PACK_CAPABILITY, versionRange: { min: '1.0.0' } }]

  const identityPolicyRef = artifactRef(
    `${namespace}.identity`,
    args.version,
    contentDigestOf(definition.identityScopes),
  )
  const ruleDeclarations = publishedRuleDeclarationsOf(args.ruleActions, args.ruleReviewPins ?? [])
  const rulePolicyRef = artifactRef(`${namespace}.rules`, args.version, contentDigestOf(ruleDeclarations))
  const queryTemplatesRef = artifactRef(
    `${namespace}.query-templates`,
    args.version,
    contentDigestOf({ objects: definition.objects, attributes: definition.attributes, relations: definition.relations }),
  )

  const manifest: IndustryManifest = {
    namespace,
    maturity: maturityOf(args.report),
    standardProvenance,
    definitionsRef: definition.ref,
    identityPolicyRef,
    rulePolicyRef,
    queryTemplatesRef,
    requiredCapabilities,
    testSuiteRef: testSuite.ref,
  }

  const maturity = manifest.maturity
  const maturityLabel = packMaturityLabelOf(maturity)
  const actionDeclarationsRef = artifactRef(
    `${namespace}.action-declarations`,
    args.version,
    contentDigestOf(capabilities.actions),
  )
  // The content digest excludes the self-referential toPackRef, so the pack reference is acyclic.
  const contentDigest = contentDigestOf({
    namespace,
    maturity,
    manifest,
    definitionRef: definition.ref,
    sourceIndexDigest: indexDigest,
    capabilities,
    validationId: args.report.validationId,
    validationDigest: args.report.contentDigest,
    strategy: args.report.strategy,
    approvalPins: args.report.definition?.approvalPins,
    ruleActionPins: args.report.ruleActionPins,
    ruleReviewPins: args.ruleReviewPins ?? [],
    actionDeclarationsRef,
  })
  const packRef = artifactRef(`${namespace}.${args.packId}`, args.version, contentDigest)
  const sourceIndex: PackSourceIndex = { packRef, entries, digest: indexDigest }
  const diff = buildVersionDiff({
    ...(previousRef === undefined ? {} : { fromPackRef: previousRef }),
    toPackRef: packRef,
    ...(args.previous === undefined
      ? {}
      : { from: { definition: args.previous.definition, ...(args.previous.asset === undefined ? {} : { asset: args.previous.asset }) } }),
    toDefinition: definition,
    toCapabilities: capabilities,
  })

  const validationRef: ResourceRef = {
    id: args.report.validationId,
    version: PACK_PUBLICATION_VERSION,
    digest: args.report.contentDigest,
    kind: 'artifact',
  }
  const packAsset: PackAsset = {
    ref: packRef,
    manifest,
    testSuite,
    sourceIndexRef: { id: sourceIndexRefId(packRef), version: PACK_PUBLICATION_VERSION, digest: indexDigest, kind: 'source' },
    ruleDeclarationsRef: { id: rulePolicyRef.id, version: PACK_PUBLICATION_VERSION, digest: rulePolicyRef.digest, kind: 'artifact' },
    actionDeclarationsRef: {
      id: actionDeclarationsRef.id,
      version: PACK_PUBLICATION_VERSION,
      digest: actionDeclarationsRef.digest,
      kind: 'artifact',
    },
    validationRef,
    ...(args.syntheticExampleRef === undefined ? {} : { syntheticExampleRef: args.syntheticExampleRef }),
  }

  const asset: PublishedPackAssetDraft = {
    ...(args.report.strategy === undefined ? {} : { strategy: args.report.strategy }),
    ...(args.report.definition?.approvalPins === undefined ? {} : { approvalPins: args.report.definition.approvalPins }),
    ...(args.report.ruleActionPins === undefined ? {} : { ruleActionPins: args.report.ruleActionPins }),
    ruleDeclarations,
    ruleReviewPins: args.ruleReviewPins ?? [],
    packRef,
    workspaceId: args.workspace.workspaceId,
    namespace,
    maturity,
    maturityLabel,
    manifest,
    packAsset,
    definitionRef: definition.ref,
    validationRef,
    sourceIndex,
    capabilities,
    diff,
    contentDigest,
    idempotencyKey: args.idempotencyKey,
    actor: args.actor,
  }

  return { definition, asset }
}

function maturityOf(report: IndustryValidationReport): IndustryMaturity {
  if (!report.semanticPublished.passed) return 'planned'
  return report.deploymentExecutable.passed ? 'stable' : 'preview'
}

function sourceIndexRefId(packRef: VersionRef): string {
  return `${packRef.id}.source-index`
}

/** Stable action candidate lookup for a validation report; exported for the service and tests. */
export function actionCandidatesOf(
  candidates: readonly RuleActionCandidateVersion[],
): ActionCandidateVersion[] {
  return candidates.filter(isActionCandidateVersion)
}
