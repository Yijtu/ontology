import { createHash } from 'node:crypto'
import type {
  BlobGetAuthorizedRequest,
  EvidenceStorePort,
  MaterializationStore,
  ProjectionSlice,
  ResourceRef,
  RuleComputationArtifact,
  ScopeRef,
  ToolContext,
  VersionRef,
} from '@ontology/contracts'
import type {
  PublishedRuleSupportGroup,
  PublishedRuleSupportInstance,
  PublishedRuleSupportReader,
} from './support-dependency-source'
import { sha256DigestOf } from '../definitions/canonical'
import { compareUtcInstants, sameUtcInstant } from './instant'

const MAX_SUPPORT_SLICES = 10_000
const MAX_SUPPORT_EVIDENCE_REFS = 256
const SUPPORT_EVIDENCE_READ_CONCURRENCY = 4
const MAX_SUPPORT_PAYLOAD_BYTES = 1_048_576

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

function isConditionState(value: unknown): value is 'true' | 'false' | 'unknown' | 'conflict' {
  return value === 'true' || value === 'false' || value === 'unknown' || value === 'conflict'
}

function isRuleComputationArtifact(value: unknown): value is RuleComputationArtifact {
  if (!isRecord(value) || value['schemaVersion'] !== 'rule-computation-artifact@1') return false
  if (!isScopeRef(value['scopeRef']) || !isVersionRef(value['definitionRef']) || !isVersionRef(value['ruleRef'])) return false
  if (!isString(value['ruleId']) || !isString(value['ruleVersionId']) || !isString(value['publishedRevision'])) return false
  if (!isString(value['instanceKey']) || !isString(value['objectId']) || !isString(value['subjectEntityId']) || !isString(value['predicate'])) return false
  if (!isString(value['validAt']) || !isString(value['asOfRecordedSeq'])) return false
  if (typeof value['complete'] !== 'boolean' || !Array.isArray(value['sourceStatementIds']) || !Array.isArray(value['sourceSpans'])) return false
  if (!value['sourceStatementIds'].every(isString) || !Array.isArray(value['factRefs'])) return false
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

function covers(slice: ProjectionSlice, validAt: string): boolean {
  const from = compareUtcInstants(slice.validity.validFrom, validAt)
  const beforeTo = slice.validity.validTo === undefined ? -1 : compareUtcInstants(validAt, slice.validity.validTo)
  return from !== undefined && from <= 0 && (slice.validity.validTo === undefined || (beforeTo !== undefined && beforeTo < 0))
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

function digestIsSelfConsistent(artifact: RuleComputationArtifact): boolean {
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
  refs: RuleComputationArtifact['factRefs'],
  artifact: RuleComputationArtifact,
): PublishedRuleSupportGroup['facts'][number][] | undefined {
  const facts: PublishedRuleSupportGroup['facts'][number][] = []
  for (const ref of refs) {
    if (ref.sourceStatementId === undefined || ref.sourceStatementId.length === 0) return undefined
    const sourceRefs = [...(ref.sourceRefs ?? [])]
    // The dependency graph is evidence-to-evidence. A raw document/chunk reference is real
    // provenance, but this graph contract cannot traverse it, so do not call that DAG complete.
    if (sourceRefs.length === 0 || sourceRefs.some((sourceRef) => sourceRef.kind !== 'evidence')) return undefined
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

function premiseGroupsOf(
  slice: ProjectionSlice,
  artifact: RuleComputationArtifact,
): readonly PublishedRuleSupportGroup[] | undefined {
  if (artifact.applicability.state !== 'applicable' || !artifact.applicability.positiveSupport) return []
  const byAssertionId = new Map(artifact.factRefs.map((fact) => [fact.assertionId, fact]))
  const groups: PublishedRuleSupportGroup[] = []
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
    const facts = proofFactsOf(refs, artifact)
    if (facts === undefined) return undefined
    groups.push({ groupId: group.groupId, facts })
  }
  return groups.length === 0 ? undefined : groups
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

/**
 * Resolve support from append-only materialized slices. The reader never reloads published
 * heads or recompiles a rule. An archived RuleComputationArtifact payload can identify one
 * entity instance; without it, more than one exact bitemporal instance remains ambiguous.
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

    let complete = true
    const candidatesByIdentity = new Map<string, CandidateWithArtifact>()
    for (const slice of slices) {
      if (!sameScope(slice.scopeRef, scopeRef)) {
        complete = false
        continue
      }
      if (!covers(slice, request.validAt)) continue
      if (!slice.conclusion.ruleRefs.some((ref) => sameVersion(ref, request.ruleRef))) continue
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
    if (request.payloadRef !== undefined) {
      const payloadArtifact = await this.#readPayloadArtifact(scopeRef, request.payloadRef, ctx)
      if (payloadArtifact === 'invalid') return { complete: false, candidates: [] }
      if (payloadArtifact !== undefined && payloadArtifact !== 'oversized') {
        if (!exactCandidate(payloadArtifact, scopeRef, request)) return { complete: false, candidates: [] }
        const matching = candidates.filter((candidate) =>
          candidate.instance.instanceKey === payloadArtifact.instanceKey &&
          sha256DigestOf(candidate.artifact) === sha256DigestOf(payloadArtifact),
        )
        if (matching.length !== 1) return { complete: false, candidates: [] }
        candidates = matching
      }
    }
    if (complete && !(await this.#allEvidenceEnvelopesExist(scopeRef, candidates, ctx))) complete = false
    return { complete, candidates: complete ? candidates.map((candidate) => candidate.instance) : [] }
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
  ): Promise<RuleComputationArtifact | undefined | 'invalid' | 'oversized'> {
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
      if (!isRecord(parsed) || parsed['schemaVersion'] !== 'rule-computation-artifact@1') return undefined
      if (!isRuleComputationArtifact(parsed) || !digestIsSelfConsistent(parsed)) return 'invalid'
      return parsed
    } catch {
      return 'invalid'
    }
  }
}
