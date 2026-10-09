import { createHash } from 'node:crypto'
import type {
  BlobGetAuthorizedRequest,
  EvidenceStorePort,
  MaterializationStore,
  ProjectionSlice,
  ResourceRef,
  RuleComputationArtifact,
  RuleComputationFactRef,
  RuleProvenanceSpan,
  ScopeRef,
  TextCandidateSourceSpan,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type {
  PublishedRulePolicySpan,
  PublishedRuleSupportGroup,
  PublishedRuleSupportInstance,
  PublishedRuleSupportReader,
  RuleSupportAxisCoverage,
} from './support-dependency-source'
import type {
  RuleDerivationSourceEvidenceMapping,
  RulePolicySourceEvidenceMapping,
  RulePolicySpanArchiveBinding,
  RuleSourceSpanArchiveBinding,
} from './support-payload'
import { sha256DigestOf } from '../definitions/canonical'
import { compareUtcInstants, sameUtcInstant } from './instant'

const MAX_SUPPORT_SLICES = 10_000
const MAX_SUPPORT_EVIDENCE_REFS = 256
const SUPPORT_EVIDENCE_READ_CONCURRENCY = 4
const MAX_SUPPORT_PAYLOAD_BYTES = 1_048_576
const MAX_SOURCE_BINDING_BYTES = 64 * 1024
const MAX_ARCHIVED_SOURCE_SPAN_BYTES = 128 * 1024

/** Minimal authorized byte-read capability for an immutable payload pointer. */
export interface RuleSupportPayloadReader {
  readAuthorized(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Uint8Array>
}

/** Metadata-only authorized lookup, required before reading any optional payload bytes. */
export interface RuleSupportPayloadMetadataReader {
  getAuthorizedMetadata(
    request: BlobGetAuthorizedRequest,
    ctx: ToolContext,
  ): Promise<{
    readonly blobRef: ResourceRef
    readonly contentDigest: string
    readonly mediaType: string
    readonly byteSize: number
  }>
}

export interface MaterializedRuleSupportReaderDependencies {
  /** Append-only projection slices; no publication-head or rule recompilation fallback exists. */
  readonly materialization: Pick<MaterializationStore, 'readSlices'>
  /** Confirms every evidence ref emitted as a graph edge has an authorized archived envelope. */
  readonly evidence: Pick<EvidenceStorePort, 'get'>
  /** Metadata-only authorization is required to bound payload reads before the body is touched. */
  readonly payloadMetadataReader?: RuleSupportPayloadMetadataReader
  readonly payloadReader?: RuleSupportPayloadReader
  readonly maxSlices?: number
}

interface CandidateWithArtifact {
  readonly instance: PublishedRuleSupportInstance
  readonly artifact: RuleComputationArtifact
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isScopeRef(value: unknown): value is ScopeRef {
  return isRecord(value) && isString(value['tenantId']) && isString(value['spaceId'])
}

function isVersionRef(value: unknown): value is VersionRef {
  return isRecord(value) && isString(value['id']) && isString(value['version']) && isString(value['digest'])
}

function isResourceRef(value: unknown): value is ResourceRef {
  if (!isRecord(value) || !isString(value['id']) || !isString(value['version']) || !isString(value['digest'])) return false
  return [
    'profile', 'run', 'evidence', 'draft', 'verification', 'answer', 'artifact', 'document', 'chunk', 'plan',
    'simulation', 'computation', 'dataset', 'checkpoint', 'tool_result', 'job', 'source',
  ].includes(String(value['kind']))
}

function isLocator(value: unknown): value is TextCandidateSourceSpan['locator'] {
  if (!isRecord(value) || !['page', 'offset', 'approximate_locator'].includes(String(value['kind']))) return false
  if (value['page'] !== undefined && (!Number.isSafeInteger(value['page']) || Number(value['page']) < 1)) return false
  if (value['startOffset'] !== undefined && (!Number.isSafeInteger(value['startOffset']) || Number(value['startOffset']) < 0)) return false
  if (value['endOffset'] !== undefined && (!Number.isSafeInteger(value['endOffset']) || Number(value['endOffset']) < 0)) return false
  return value['normalizationMapRef'] === undefined || isString(value['normalizationMapRef'])
}

function isTextCandidateSourceSpan(value: unknown): value is TextCandidateSourceSpan {
  if (!isRecord(value) || !isString(value['parseId']) || !isString(value['chunkId']) ||
      !isString(value['quoteDigest']) || !isString(value['textDigest']) ||
      (value['kind'] !== undefined && value['kind'] !== 'text') ||
      (value['precision'] !== 'exact' && value['precision'] !== 'approximate') ||
      !['verbatim', 'normalized', 'approximate'].includes(String(value['spanKind'])) ||
      !isLocator(value['locator'])) return false
  return true
}

function sourceSpanMatchesRef(value: unknown, ref: ResourceRef): boolean {
  if (isTextCandidateSourceSpan(value)) return value.chunkId === ref.id && value.quoteDigest === ref.digest && value.textDigest === ref.digest
  return isRecord(value) && value['kind'] === 'structured' && isString(value['parseId']) && value['recordId'] === ref.id && value['rowDigest'] === ref.digest &&
    isString(value['sourceRowKey']) && isRecord(value['locator']) && ['table_cell', 'table_row', 'json_pointer'].includes(String(value['locator']['kind']))
}

function isRuleProvenanceSpan(value: unknown): value is RuleProvenanceSpan {
  if (!isRecord(value) || !isString(value['parseId']) || !isString(value['chunkId']) ||
      !isString(value['quoteDigest']) ||
      (value['precision'] !== 'exact' && value['precision'] !== 'approximate') ||
      !['verbatim', 'normalized', 'approximate'].includes(String(value['spanKind'])) ||
      !isLocator(value['locator'])) return false
  return true
}

function isConditionState(value: unknown): value is 'true' | 'false' | 'unknown' | 'conflict' {
  return value === 'true' || value === 'false' || value === 'unknown' || value === 'conflict'
}

export function isRuleComputationArtifact(value: unknown): value is RuleComputationArtifact {
  if (!isRecord(value) || value['schemaVersion'] !== 'rule-computation-artifact@1') return false
  if (!isScopeRef(value['scopeRef']) || !isVersionRef(value['definitionRef']) || !isVersionRef(value['ruleRef'])) return false
  if (!isString(value['ruleId']) || !isString(value['ruleVersionId']) || !isString(value['publishedRevision'])) return false
  if (!isString(value['instanceKey']) || !isString(value['objectId']) || !isString(value['subjectEntityId']) || !isString(value['predicate'])) return false
  if (!isString(value['validAt']) || !isString(value['asOfRecordedSeq'])) return false
  if (typeof value['complete'] !== 'boolean' || !Array.isArray(value['sourceStatementIds']) || !Array.isArray(value['sourceSpans'])) return false
  if (!value['sourceStatementIds'].every(isString) || !value['sourceSpans'].every(isRuleProvenanceSpan) || !Array.isArray(value['factRefs'])) return false
  if (!isRecord(value['applicability'])) return false
  const applicability = value['applicability']
  if (
    (applicability['state'] !== 'applicable' && applicability['state'] !== 'not_applicable' &&
      applicability['state'] !== 'unknown' && applicability['state'] !== 'conflict') ||
    !isConditionState(applicability['conditionState']) ||
    typeof applicability['positiveSupport'] !== 'boolean' ||
    !Array.isArray(applicability['exceptionStates'])
  ) return false
  const validFactRef = (fact: unknown): boolean => {
    if (!isRecord(fact) || !isString(fact['assertionId']) || !isString(fact['logicalAssertionId']) ||
        !isString(fact['recordedSeq']) || !isString(fact['digest'])) return false
    if (fact['sourceStatementId'] !== undefined && !isString(fact['sourceStatementId'])) return false
    return fact['sourceRefs'] === undefined ||
      (Array.isArray(fact['sourceRefs']) && fact['sourceRefs'].every(isResourceRef))
  }
  if (!value['factRefs'].every(validFactRef)) return false
  for (const exception of applicability['exceptionStates']) {
    if (!isRecord(exception) || !isString(exception['exceptionId']) || !isConditionState(exception['state']) ||
        !Array.isArray(exception['factRefs']) || !exception['factRefs'].every(validFactRef)) return false
  }
  return isString(value['inputDigest']) && isString(value['computationDigest'])
}

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return left.tenantId === right.tenantId && left.spaceId === right.spaceId
}

function sameVersion(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function sameResourceRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

function sourceMappingKey(groupId: string, assertionId: string, sourceRef: ResourceRef): string {
  return JSON.stringify([groupId, assertionId, sourceRef.id, sourceRef.version, sourceRef.digest, sourceRef.kind])
}

function policySpanKey(span: Pick<RuleProvenanceSpan, 'parseId' | 'chunkId' | 'quoteDigest'>): string {
  return JSON.stringify([span.parseId, span.chunkId, span.quoteDigest])
}

function covers(slice: ProjectionSlice, validAt: string): boolean {
  const from = compareUtcInstants(slice.validity.validFrom, validAt)
  const beforeTo = slice.validity.validTo === undefined ? -1 : compareUtcInstants(validAt, slice.validity.validTo)
  return from !== undefined && from <= 0 && (slice.validity.validTo === undefined || (beforeTo !== undefined && beforeTo < 0))
}

function recordedSeqRank(seq: string): bigint | undefined {
  return /^[0-9]+$/.test(seq) ? BigInt(seq) : undefined
}

/**
 * Keep only the latest append-only slice per (proposition, validity interval). The store returns
 * every slice at or before `asOfRecordedSeq`; a corrected or retracted interval therefore has
 * several, and only the newest one speaks for it.
 */
function latestSlicesAtPoint(slices: readonly ProjectionSlice[]): ProjectionSlice[] {
  const latest = new Map<string, ProjectionSlice>()
  for (const slice of slices) {
    const key = JSON.stringify([slice.conclusion.propositionKey, slice.validity.validFrom, slice.validity.validTo ?? null])
    const existing = latest.get(key)
    if (existing === undefined) {
      latest.set(key, slice)
      continue
    }
    const rank = recordedSeqRank(slice.recordedSeq)
    const existingRank = recordedSeqRank(existing.recordedSeq)
    const newer = rank === undefined || existingRank === undefined
      ? slice.recordedSeq > existing.recordedSeq
      : rank > existingRank
    if (newer) latest.set(key, slice)
  }
  return [...latest.values()]
}

function exactCandidate(
  artifact: RuleComputationArtifact,
  scopeRef: ScopeRef,
  request: Parameters<PublishedRuleSupportReader['readCandidates']>[1],
): boolean {
  return sameScope(artifact.scopeRef, scopeRef) &&
    sameVersion(artifact.ruleRef, request.ruleRef) &&
    artifact.validAt !== undefined && sameUtcInstant(artifact.validAt, request.validAt) &&
    artifact.asOfRecordedSeq === request.asOfRecordedSeq
}

export function digestIsSelfConsistent(artifact: RuleComputationArtifact): boolean {
  return sha256DigestOf({
    inputDigest: artifact.inputDigest,
    ruleRef: artifact.ruleRef,
    instanceKey: artifact.instanceKey,
    validAt: artifact.validAt ?? null,
    asOfRecordedSeq: artifact.asOfRecordedSeq ?? null,
    applicability: artifact.applicability,
    factRefs: artifact.factRefs,
  }) === artifact.computationDigest
}

function proofFactsOf(
  refs: readonly RuleComputationFactRef[],
  artifact: RuleComputationArtifact,
): PublishedRuleSupportGroup['facts'][number][] | undefined {
  const facts: PublishedRuleSupportGroup['facts'][number][] = []
  for (const ref of refs) {
    if (ref.sourceStatementId === undefined || ref.sourceStatementId.length === 0) return undefined
    const sourceRefs = [...(ref.sourceRefs ?? [])]
    facts.push({
      kind: 'entity_attribute',
      assertionId: ref.assertionId,
      logicalAssertionId: ref.logicalAssertionId,
      sourceStatementId: ref.sourceStatementId,
      subjectEntityId: artifact.subjectEntityId,
      objectId: artifact.objectId,
      schemaRef: artifact.definitionRef,
      sourceRefs,
    })
  }
  return facts
}

export interface MaterializedRuleSupportFactGroup {
  readonly groupId: string
  readonly factRefs: readonly RuleComputationFactRef[]
}

/** Recover exact satisfied alternatives from a persisted projection slice, without recompilation. */
export function materializedRuleSupportFactGroupsOf(
  slice: ProjectionSlice,
  artifact: RuleComputationArtifact,
): readonly MaterializedRuleSupportFactGroup[] | undefined {
  if (artifact.applicability.state !== 'applicable' || !artifact.applicability.positiveSupport) return []
  const byAssertionId = new Map(artifact.factRefs.map((fact) => [fact.assertionId, fact]))
  const groups: MaterializedRuleSupportFactGroup[] = []
  const exceptionPrefix = `${artifact.instanceKey}:exception:`
  for (const group of slice.conclusion.satisfiedBy) {
    let refs: RuleComputationArtifact['factRefs']
    if (group.alternativeIds.length > 0) {
      const matching = group.alternativeIds.map((id) => byAssertionId.get(id))
      if (matching.some((fact) => fact === undefined)) return undefined
      refs = matching.filter((fact): fact is NonNullable<typeof fact> => fact !== undefined)
    } else if (group.groupId.startsWith(exceptionPrefix)) {
      const exceptionId = group.groupId.slice(exceptionPrefix.length)
      const exception = artifact.applicability.exceptionStates.find((candidate) => candidate.exceptionId === exceptionId)
      // An applicable rule has proved each attached exception false. Its observed facts explain
      // that proof; a different state cannot be used to manufacture a support edge.
      if (exception === undefined || exception.state !== 'false') return undefined
      refs = exception.factRefs
    } else {
      // A negated premise outside the attached-exception subset lacks a persisted group-to-fact
      // binding in this artifact contract, so it cannot be reconstructed safely here.
      return undefined
    }
    if (refs.some((ref) => ref.sourceStatementId === undefined || ref.sourceStatementId.length === 0)) return undefined
    groups.push({ groupId: group.groupId, factRefs: refs })
  }
  return groups.length === 0 ? undefined : groups
}

function premiseGroupsOf(
  slice: ProjectionSlice,
  artifact: RuleComputationArtifact,
): readonly PublishedRuleSupportGroup[] | undefined {
  const factGroups = materializedRuleSupportFactGroupsOf(slice, artifact)
  if (factGroups === undefined) return undefined
  const groups: PublishedRuleSupportGroup[] = []
  for (const group of factGroups) {
    const facts = proofFactsOf(group.factRefs, artifact)
    if (facts === undefined) return undefined
    groups.push({ groupId: group.groupId, facts })
  }
  return groups
}

function supportInstanceOf(slice: ProjectionSlice, artifact: RuleComputationArtifact): PublishedRuleSupportInstance | undefined {
  if (!artifact.complete || !digestIsSelfConsistent(artifact)) return undefined
  const premiseGroups = premiseGroupsOf(slice, artifact)
  if (premiseGroups === undefined) return undefined
  return {
    scopeRef: artifact.scopeRef,
    definitionRef: artifact.definitionRef,
    ruleRef: artifact.ruleRef,
    instanceKey: artifact.instanceKey,
    objectId: artifact.objectId,
    subjectEntityId: artifact.subjectEntityId,
    validAt: artifact.validAt ?? '',
    asOfRecordedSeq: artifact.asOfRecordedSeq ?? '',
    applicability: {
      state: artifact.applicability.state,
      positiveSupport: artifact.applicability.positiveSupport,
    },
    complete: artifact.complete,
    premiseGroups,
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

interface ParsedRuleSupportPayload {
  readonly artifact: RuleComputationArtifact
  readonly sourceEvidenceMappings: readonly RuleDerivationSourceEvidenceMapping[]
  readonly policySourceEvidenceMappings: readonly RulePolicySourceEvidenceMapping[]
}

function isSourceEvidenceMapping(value: unknown): value is RuleDerivationSourceEvidenceMapping {
  if (!isRecord(value) || !isString(value['premiseGroup']) || !isString(value['assertionId']) ||
      !isString(value['logicalAssertionId']) || !isString(value['sourceStatementId']) ||
      !isResourceRef(value['sourceRef']) || value['sourceRef'].kind !== 'chunk' ||
      !isResourceRef(value['documentVersionRef']) || value['documentVersionRef'].kind !== 'document' ||
      !isResourceRef(value['documentRef']) || value['documentRef'].kind !== 'document' ||
      value['documentVersionRef'].digest !== value['documentRef'].digest || !isString(value['parserVersion']) ||
      !isResourceRef(value['evidenceRef']) || value['evidenceRef'].kind !== 'evidence' ||
      !sourceSpanMatchesRef(value['sourceSpan'], value['sourceRef'])) return false
  return true
}

function isRuleSourceSpanArchiveBinding(value: unknown): value is RuleSourceSpanArchiveBinding {
  if (!isRecord(value) || value['schemaVersion'] !== 'rule-source-span-binding@1' ||
      !isString(value['premiseGroup']) || !isString(value['assertionId']) ||
      !isString(value['logicalAssertionId']) || !isString(value['sourceStatementId']) ||
      !isResourceRef(value['sourceRef']) || value['sourceRef'].kind !== 'chunk' ||
      !isResourceRef(value['documentVersionRef']) || value['documentVersionRef'].kind !== 'document' ||
      !isResourceRef(value['documentRef']) || value['documentRef'].kind !== 'document' ||
      value['documentVersionRef'].digest !== value['documentRef'].digest ||
      !isString(value['parserVersion']) || !sourceSpanMatchesRef(value['sourceSpan'], value['sourceRef']) ||
      !isResourceRef(value['textArtifactRef']) || value['textArtifactRef'].kind !== 'artifact') return false
  return true
}

function isPolicySourceEvidenceMapping(value: unknown): value is RulePolicySourceEvidenceMapping {
  if (!isRecord(value) || !isRuleProvenanceSpan(value['span']) ||
      !isResourceRef(value['documentVersionRef']) || value['documentVersionRef'].kind !== 'document' ||
      !isResourceRef(value['documentRef']) || value['documentRef'].kind !== 'document' ||
      value['documentVersionRef'].digest !== value['documentRef'].digest || !isString(value['parserVersion']) ||
      !isResourceRef(value['textArtifactRef']) || value['textArtifactRef'].kind !== 'artifact' ||
      !isResourceRef(value['evidenceRef']) || value['evidenceRef'].kind !== 'evidence') return false
  return true
}

function isRulePolicySpanArchiveBinding(value: unknown): value is RulePolicySpanArchiveBinding {
  if (!isRecord(value) || value['schemaVersion'] !== 'rule-policy-span-binding@1' ||
      !isRuleProvenanceSpan(value['span']) ||
      !isResourceRef(value['documentVersionRef']) || value['documentVersionRef'].kind !== 'document' ||
      !isResourceRef(value['documentRef']) || value['documentRef'].kind !== 'document' ||
      value['documentVersionRef'].digest !== value['documentRef'].digest ||
      !isString(value['parserVersion']) ||
      !isResourceRef(value['textArtifactRef']) || value['textArtifactRef'].kind !== 'artifact') return false
  return true
}

function parseRuleSupportPayload(value: unknown): ParsedRuleSupportPayload | undefined | 'invalid' {
  if (isRuleComputationArtifact(value)) {
    return { artifact: value, sourceEvidenceMappings: [], policySourceEvidenceMappings: [] }
  }
  if (!isRecord(value) || value['schemaVersion'] !== 'rule-derivation-support-payload@1') return undefined
  if (!isRuleComputationArtifact(value['artifact']) || !digestIsSelfConsistent(value['artifact']) ||
      !Array.isArray(value['sourceEvidenceMappings']) || !value['sourceEvidenceMappings'].every(isSourceEvidenceMapping)) return 'invalid'
  const policyMappings = value['policySourceEvidenceMappings']
  if (policyMappings !== undefined && (!Array.isArray(policyMappings) || !policyMappings.every(isPolicySourceEvidenceMapping))) {
    return 'invalid'
  }
  return {
    artifact: value['artifact'],
    sourceEvidenceMappings: value['sourceEvidenceMappings'],
    policySourceEvidenceMappings: policyMappings ?? [],
  }
}

/**
 * Resolve support from append-only materialized slices. The reader never reloads published
 * heads or recompiles a rule. An archived support payload can identify one exact entity
 * instance and add verified raw-source and specification-span evidence mappings; without it,
 * more than one exact bitemporal instance remains ambiguous and raw/policy refs stay incomplete.
 */
export class MaterializedRuleSupportReader implements PublishedRuleSupportReader {
  readonly #materialization: Pick<MaterializationStore, 'readSlices'>
  readonly #evidence: Pick<EvidenceStorePort, 'get'>
  readonly #payloadMetadataReader: RuleSupportPayloadMetadataReader | undefined
  readonly #payloadReader: RuleSupportPayloadReader | undefined
  readonly #maxSlices: number

  constructor(dependencies: MaterializedRuleSupportReaderDependencies) {
    this.#materialization = dependencies.materialization
    this.#evidence = dependencies.evidence
    this.#payloadMetadataReader = dependencies.payloadMetadataReader
    this.#payloadReader = dependencies.payloadReader
    this.#maxSlices = dependencies.maxSlices ?? MAX_SUPPORT_SLICES
  }

  async readCandidates(
    scopeRef: ScopeRef,
    request: Parameters<PublishedRuleSupportReader['readCandidates']>[1],
    ctx: ToolContext,
  ): Promise<{ readonly complete: boolean; readonly candidates: readonly PublishedRuleSupportInstance[] }> {
    if (!Number.isSafeInteger(this.#maxSlices) || this.#maxSlices < 1) return { complete: false, candidates: [] }
    const slices = await this.#materialization.readSlices(scopeRef, {
      validAt: request.validAt,
      asOfRecordedSeq: request.asOfRecordedSeq,
      limit: this.#maxSlices + 1,
    }, ctx)
    if (slices.length > this.#maxSlices) return { complete: false, candidates: [] }

    const payload = request.payloadRef === undefined ? undefined : await this.#readPayloadArtifact(scopeRef, request.payloadRef, ctx)
    if (payload === 'invalid') return { complete: false, candidates: [] }
    const pinned = typeof payload === 'object' ? payload.artifact : undefined
    if (pinned !== undefined && (!exactCandidate(pinned, scopeRef, request) || !digestIsSelfConsistent(pinned))) return { complete: false, candidates: [] }
    // The authorized, rehashed payload is only a locator. Actual saved history identifies
    // its proposition ownership; all latest target slices still have to match in full.
    const ownedPropositions = pinned === undefined ? undefined : new Set(slices.filter((slice) =>
      slice.conclusion.ruleArtifacts?.some((artifact) => isRecord(artifact) && artifact['instanceKey'] === pinned.instanceKey),
    ).map((slice) => slice.propositionKey))

    let complete = true
    const candidatesByIdentity = new Map<string, CandidateWithArtifact>()
    // A corrected or retracted interval accrues more than one append-only slice. Only the latest
    // slice at or before the requested recorded sequence may speak for that interval; an older
    // slice is history, not an incomplete candidate set.
    for (const slice of latestSlicesAtPoint(slices)) {
      if (ownedPropositions !== undefined && !ownedPropositions.has(slice.propositionKey)) continue
      if (!sameScope(slice.scopeRef, scopeRef)) {
        complete = false
        continue
      }
      if (!covers(slice, request.validAt)) continue
      if (!slice.conclusion.ruleRefs.some((ref) => sameVersion(ref, request.ruleRef))) {
        if (pinned !== undefined) complete = false
        continue
      }
      const artifacts = slice.conclusion.ruleArtifacts
      if (artifacts === undefined || artifacts.length === 0) {
        complete = false
        continue
      }
      let matchingArtifactFound = false
      for (const candidate of artifacts) {
        if (!isRuleComputationArtifact(candidate)) {
          complete = false
          continue
        }
        if (pinned !== undefined && (candidate.instanceKey !== pinned.instanceKey || candidate.subjectEntityId !== pinned.subjectEntityId || candidate.objectId !== pinned.objectId || candidate.projectId !== pinned.projectId || !sameVersion(candidate.definitionRef, pinned.definitionRef))) continue
        if (!exactCandidate(candidate, scopeRef, request)) continue
        matchingArtifactFound = true
        const instance = supportInstanceOf(slice, candidate)
        if (instance === undefined) {
          complete = false
          continue
        }
        const existing = candidatesByIdentity.get(instance.instanceKey)
        if (existing !== undefined) {
          if (sha256DigestOf(existing.artifact) !== sha256DigestOf(candidate) ||
              sha256DigestOf(existing.instance.premiseGroups) !== sha256DigestOf(instance.premiseGroups)) complete = false
          continue
        }
        candidatesByIdentity.set(instance.instanceKey, { instance, artifact: candidate })
      }
      if (!matchingArtifactFound) complete = false
    }

    let candidates = [...candidatesByIdentity.values()]
    let payloadMappingsApplied = false
    if (request.payloadRef !== undefined) {
      if (payload !== undefined && payload !== 'oversized') {
        const payloadArtifact = payload.artifact
        if (!exactCandidate(payloadArtifact, scopeRef, request)) return { complete: false, candidates: [] }
        const matching = candidates.filter((candidate) =>
          candidate.instance.instanceKey === payloadArtifact.instanceKey &&
          sha256DigestOf(candidate.artifact) === sha256DigestOf(payloadArtifact),
        )
        if (matching.length !== 1) return { complete: false, candidates: [] }
        const selected = matching[0]
        if (selected === undefined) return { complete: false, candidates: [] }
        candidates = [await this.#applyPayloadMappings(
          scopeRef, selected, payload.sourceEvidenceMappings, payload.policySourceEvidenceMappings, ctx,
        )]
        payloadMappingsApplied = true
      }
    }
    // A generic or oversized payload is not an instance locator. Keep exact evidence-only
    // candidates, but raw chunk/document and specification refs without producer mappings stay
    // incomplete on their own axes.
    if (!payloadMappingsApplied && candidates.length > 0) {
      candidates = await Promise.all(candidates.map((candidate) =>
        this.#applyPayloadMappings(scopeRef, candidate, [], [], ctx)))
    }
    if (complete && !(await this.#allEvidenceEnvelopesExist(scopeRef, candidates, ctx))) complete = false
    return { complete, candidates: complete ? candidates.map((candidate) => candidate.instance) : [] }
  }

  async #applyPayloadMappings(
    scopeRef: ScopeRef,
    candidate: CandidateWithArtifact,
    sourceMappings: readonly RuleDerivationSourceEvidenceMapping[],
    policyMappings: readonly RulePolicySourceEvidenceMapping[],
    ctx: ToolContext,
  ): Promise<CandidateWithArtifact> {
    const facts = await this.#mapSourceEvidenceMappings(scopeRef, candidate, sourceMappings, ctx)
    const policy = await this.#mapPolicyEvidenceMappings(scopeRef, facts.artifact, policyMappings, ctx)
    return {
      ...facts,
      instance: {
        ...facts.instance,
        policySpans: policy.spans,
        coverage: {
          facts: { complete: facts.instance.complete },
          policy: policy.coverage,
        },
      },
    }
  }

  async #mapSourceEvidenceMappings(
    scopeRef: ScopeRef,
    candidate: CandidateWithArtifact,
    mappings: readonly RuleDerivationSourceEvidenceMapping[],
    ctx: ToolContext,
  ): Promise<CandidateWithArtifact> {
    const mappingBuckets = new Map<string, RuleDerivationSourceEvidenceMapping[]>()
    for (const mapping of mappings) {
      const key = sourceMappingKey(mapping.premiseGroup, mapping.assertionId, mapping.sourceRef)
      const bucket = mappingBuckets.get(key)
      if (bucket === undefined) mappingBuckets.set(key, [mapping])
      else bucket.push(mapping)
    }
    const usedMappings = new Set<RuleDerivationSourceEvidenceMapping>()
    let complete = candidate.instance.complete
    const premiseGroups: PublishedRuleSupportGroup[] = []
    for (const group of candidate.instance.premiseGroups) {
      const facts: PublishedRuleSupportGroup['facts'][number][] = []
      for (const fact of group.facts) {
        const sourceRefs: ResourceRef[] = []
        for (const sourceRef of fact.sourceRefs) {
          if (sourceRef.kind === 'evidence') {
            sourceRefs.push(sourceRef)
            continue
          }
          const matches = mappingBuckets.get(sourceMappingKey(group.groupId, fact.assertionId, sourceRef)) ?? []
          const mapping = matches[0]
          if (matches.length !== 1 || mapping === undefined ||
               mapping.logicalAssertionId !== fact.logicalAssertionId ||
               mapping.sourceStatementId !== fact.sourceStatementId ||
               mapping.sourceRef.kind !== 'chunk' || mapping.documentVersionRef.kind !== 'document' ||
               mapping.documentRef.kind !== 'document' || mapping.documentVersionRef.digest !== mapping.documentRef.digest ||
               mapping.evidenceRef.kind !== 'evidence' ||
               mapping.parserVersion !== sourceRef.version ||
               !sourceSpanMatchesRef(mapping.sourceSpan, sourceRef) ||
               !(await this.#rawSourceEvidenceMatches(scopeRef, mapping, ctx))) {
            complete = false
            sourceRefs.push(sourceRef)
            continue
          }
          usedMappings.add(mapping)
          sourceRefs.push(mapping.evidenceRef)
        }
        facts.push({ ...fact, sourceRefs })
      }
      premiseGroups.push({ groupId: group.groupId, facts })
    }
    if (usedMappings.size !== mappings.length) complete = false
    return {
      ...candidate,
      instance: { ...candidate.instance, complete, premiseGroups },
    }
  }

  async #mapPolicyEvidenceMappings(
    scopeRef: ScopeRef,
    artifact: RuleComputationArtifact,
    mappings: readonly RulePolicySourceEvidenceMapping[],
    ctx: ToolContext,
  ): Promise<{ readonly spans: readonly PublishedRulePolicySpan[]; readonly coverage: RuleSupportAxisCoverage }> {
    const spans = artifact.sourceSpans
    if (spans.length === 0) {
      return { spans: [], coverage: { complete: false, reason: 'the rule artifact retains no specification source span to locate' } }
    }
    const byKey = new Map<string, RulePolicySourceEvidenceMapping>()
    for (const mapping of mappings) byKey.set(policySpanKey(mapping.span), mapping)
    const resolved: PublishedRulePolicySpan[] = []
    const usedKeys = new Set<string>()
    const reasons: string[] = []
    for (const span of spans) {
      const key = policySpanKey(span)
      const mapping = byKey.get(key)
      if (mapping === undefined) {
        reasons.push(`specification span ${span.chunkId} has no archived evidence mapping`)
        continue
      }
      if (mapping.span.parseId !== span.parseId || mapping.span.chunkId !== span.chunkId ||
          mapping.span.quoteDigest !== span.quoteDigest ||
          mapping.span.spanKind !== span.spanKind || mapping.span.precision !== span.precision ||
          sha256DigestOf(mapping.span.locator) !== sha256DigestOf(span.locator) ||
          mapping.documentVersionRef.kind !== 'document' || mapping.documentRef.kind !== 'document' ||
          mapping.documentVersionRef.digest !== mapping.documentRef.digest ||
          mapping.evidenceRef.kind !== 'evidence' || mapping.textArtifactRef.kind !== 'artifact' ||
          !(await this.#policyEvidenceMatches(scopeRef, mapping, ctx))) {
        reasons.push(`specification span ${span.chunkId} did not verify against its archived evidence`)
        continue
      }
      usedKeys.add(key)
      resolved.push({
        parseId: span.parseId,
        chunkId: span.chunkId,
        locator: span.locator,
        spanKind: span.spanKind,
        precision: span.precision,
        quoteDigest: span.quoteDigest,
        documentRef: mapping.documentRef,
        documentVersionRef: mapping.documentVersionRef,
        parserVersion: mapping.parserVersion,
        evidenceRef: mapping.evidenceRef,
      })
    }
    if (usedKeys.size !== mappings.length) reasons.push('unused specification evidence mapping')
    return {
      spans: resolved,
      coverage: reasons.length === 0 ? { complete: true } : { complete: false, reason: [...new Set(reasons)].sort().join('; ') },
    }
  }

  async #rawSourceEvidenceMatches(
    scopeRef: ScopeRef,
    mapping: RuleDerivationSourceEvidenceMapping,
    ctx: ToolContext,
  ): Promise<boolean> {
    try {
      const record = await this.#evidence.get(scopeRef, mapping.evidenceRef.id, ctx)
      if (record === undefined || !sameResourceRef(record.evidenceRef, mapping.evidenceRef) ||
          !sameScope(record.envelope.scopeRef, scopeRef) || record.envelope.kind !== 'document_span' ||
          record.envelope.resultDigest !== mapping.sourceRef.digest) return false
      const bindingRef = record.envelope.payloadRef
      const sourceSnapshots = record.envelope.sourceSnapshots.filter((snapshot) =>
        snapshot.resultDigest === mapping.sourceRef.digest && snapshot.archivedResultRef?.kind === 'artifact',
      )
      if (bindingRef === undefined || bindingRef.kind !== 'artifact' || sourceSnapshots.length !== 1) return false
      const snapshot = sourceSnapshots[0]
      const textRef = snapshot?.archivedResultRef
      if (snapshot === undefined || textRef === undefined || textRef.kind !== 'artifact') return false
      const bindingBytes = await this.#readBoundedArtifact(scopeRef, bindingRef, MAX_SOURCE_BINDING_BYTES, ctx)
      const textBytes = await this.#readBoundedArtifact(scopeRef, textRef, MAX_ARCHIVED_SOURCE_SPAN_BYTES, ctx)
      if (bindingBytes === undefined || textBytes === undefined ||
          `sha256:${createHash('sha256').update(textBytes).digest('hex')}` !== mapping.sourceRef.digest) return false
      const parsedBinding = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bindingBytes))
      if (!isRuleSourceSpanArchiveBinding(parsedBinding)) return false
      return sameResourceRef(parsedBinding.sourceRef, mapping.sourceRef) &&
        sameResourceRef(parsedBinding.documentVersionRef, mapping.documentVersionRef) &&
        sameResourceRef(parsedBinding.documentRef, mapping.documentRef) &&
        parsedBinding.parserVersion === mapping.parserVersion &&
        parsedBinding.premiseGroup === mapping.premiseGroup &&
        parsedBinding.assertionId === mapping.assertionId &&
        parsedBinding.logicalAssertionId === mapping.logicalAssertionId &&
        parsedBinding.sourceStatementId === mapping.sourceStatementId &&
        sha256DigestOf(parsedBinding.sourceSpan) === sha256DigestOf(mapping.sourceSpan) &&
        sameResourceRef(parsedBinding.textArtifactRef, textRef)
    } catch {
      return false
    }
  }

  async #policyEvidenceMatches(
    scopeRef: ScopeRef,
    mapping: RulePolicySourceEvidenceMapping,
    ctx: ToolContext,
  ): Promise<boolean> {
    try {
      const record = await this.#evidence.get(scopeRef, mapping.evidenceRef.id, ctx)
      if (record === undefined || !sameResourceRef(record.evidenceRef, mapping.evidenceRef) ||
          !sameScope(record.envelope.scopeRef, scopeRef) || record.envelope.kind !== 'document_span' ||
          record.envelope.resultDigest !== mapping.span.quoteDigest) return false
      const bindingRef = record.envelope.payloadRef
      const sourceSnapshots = record.envelope.sourceSnapshots.filter((snapshot) =>
        snapshot.resultDigest === mapping.span.quoteDigest && snapshot.archivedResultRef?.kind === 'artifact',
      )
      if (bindingRef === undefined || bindingRef.kind !== 'artifact' || sourceSnapshots.length !== 1) return false
      const snapshot = sourceSnapshots[0]
      const textRef = snapshot?.archivedResultRef
      if (snapshot === undefined || textRef === undefined || textRef.kind !== 'artifact') return false
      const bindingBytes = await this.#readBoundedArtifact(scopeRef, bindingRef, MAX_SOURCE_BINDING_BYTES, ctx)
      const textBytes = await this.#readBoundedArtifact(scopeRef, textRef, MAX_ARCHIVED_SOURCE_SPAN_BYTES, ctx)
      if (bindingBytes === undefined || textBytes === undefined ||
          `sha256:${createHash('sha256').update(textBytes).digest('hex')}` !== mapping.span.quoteDigest) return false
      const parsedBinding = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bindingBytes))
      if (!isRulePolicySpanArchiveBinding(parsedBinding)) return false
      return sha256DigestOf(parsedBinding.span) === sha256DigestOf(mapping.span) &&
        sameResourceRef(parsedBinding.documentVersionRef, mapping.documentVersionRef) &&
        sameResourceRef(parsedBinding.documentRef, mapping.documentRef) &&
        parsedBinding.parserVersion === mapping.parserVersion &&
        sameResourceRef(parsedBinding.textArtifactRef, textRef)
    } catch {
      return false
    }
  }

  async #readBoundedArtifact(
    scopeRef: ScopeRef,
    blobRef: ResourceRef,
    maxBytes: number,
    ctx: ToolContext,
  ): Promise<Uint8Array | undefined> {
    if (this.#payloadReader === undefined || this.#payloadMetadataReader === undefined) return undefined
    const request: BlobGetAuthorizedRequest = { scopeRef, blobRef }
    const metadata = await this.#payloadMetadataReader.getAuthorizedMetadata(request, ctx)
    if (!sameResourceRef(metadata.blobRef, blobRef) || metadata.contentDigest !== blobRef.digest ||
        !Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 1 || metadata.byteSize > maxBytes) return undefined
    const bytes = await this.#payloadReader.readAuthorized(request, ctx)
    if (bytes.byteLength !== metadata.byteSize || bytes.byteLength > maxBytes ||
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== blobRef.digest) return undefined
    return bytes
  }

  async #allEvidenceEnvelopesExist(
    scopeRef: ScopeRef,
    candidates: readonly CandidateWithArtifact[],
    ctx: ToolContext,
  ): Promise<boolean> {
    const evidenceRefs = new Map<string, ResourceRef>()
    for (const candidate of candidates) {
      for (const group of candidate.instance.premiseGroups) {
        for (const fact of group.facts) {
          for (const ref of fact.sourceRefs) {
            evidenceRefs.set(`${ref.id}\u0000${ref.version}\u0000${ref.digest}\u0000${ref.kind}`, ref)
          }
        }
      }
    }
    const refs = [...evidenceRefs.values()]
    if (refs.length > MAX_SUPPORT_EVIDENCE_REFS) return false
    for (let offset = 0; offset < refs.length; offset += SUPPORT_EVIDENCE_READ_CONCURRENCY) {
      const batch = refs.slice(offset, offset + SUPPORT_EVIDENCE_READ_CONCURRENCY)
      const results = await Promise.all(batch.map(async (ref) => {
        try {
          const record = await this.#evidence.get(scopeRef, ref.id, ctx)
          return record !== undefined && sameResourceRef(record.evidenceRef, ref)
        } catch {
          return false
        }
      }))
      if (results.some((available) => !available)) return false
    }
    return true
  }

  async #readPayloadArtifact(
    scopeRef: ScopeRef,
    payloadRef: ResourceRef,
    ctx: ToolContext,
  ): Promise<ParsedRuleSupportPayload | undefined | 'invalid' | 'oversized'> {
    if (this.#payloadReader === undefined || this.#payloadMetadataReader === undefined) return 'invalid'
    const request: BlobGetAuthorizedRequest = { scopeRef, blobRef: payloadRef }
    try {
      const metadata = await this.#payloadMetadataReader.getAuthorizedMetadata(request, ctx)
      if (!sameResourceRef(metadata.blobRef, payloadRef) || metadata.contentDigest !== payloadRef.digest) return 'invalid'
      const mediaType = metadata.mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
      if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) return undefined
      if (!Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 1) return 'invalid'
      if (metadata.byteSize > MAX_SUPPORT_PAYLOAD_BYTES) return 'oversized'
      const bytes = await this.#payloadReader.readAuthorized(request, ctx)
      if (bytes.byteLength !== metadata.byteSize || bytes.byteLength > MAX_SUPPORT_PAYLOAD_BYTES) return 'invalid'
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      if (digest !== payloadRef.digest) return 'invalid'
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const parsed = parseJson(decoded)
      if (parsed === undefined) return 'invalid'
      return parseRuleSupportPayload(parsed)
    } catch {
      return 'invalid'
    }
  }
}
