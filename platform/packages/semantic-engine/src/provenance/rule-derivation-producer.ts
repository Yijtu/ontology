import { createHash, randomUUID } from 'node:crypto'
import type {
  CandidateRecord,
  CandidateStore,
  DataMode,
  DocumentParseStore,
  DocumentSpanReaderPort,
  EvidenceEnvelope,
  EvidenceRecord,
  EvidenceStorePort,
  ImmutableArtifactWriter,
  MaterializationStore,
  ProjectionSlice,
  ReadSpanResponse,
  ResourceRef,
  RevisionString,
  RuleComputationArtifact,
  RuleComputationFactRef,
  RuleProvenanceSpan,
  Semver,
  ScopeRef,
  SourceSnapshot,
  TextCandidateSourceSpan,
  ToolContext,
  Uuid,
  VersionRef,
} from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import { compareUtcInstants, sameUtcInstant } from './instant'
import {
  digestIsSelfConsistent,
  isRuleComputationArtifact,
  materializedRuleSupportFactGroupsOf,
} from './materialized-support-reader'
import type {
  RuleDerivationSourceEvidenceMapping,
  RuleDerivationSupportPayload,
  RulePolicySourceEvidenceMapping,
  RulePolicySpanArchiveBinding,
  RuleSourceSpanArchiveBinding,
} from './support-payload'

const DEFAULT_MAX_SLICES = 10_000
const MAX_SOURCE_EVIDENCE_REFS = 256
const MAX_POLICY_SPANS = 256
const EVIDENCE_READ_CONCURRENCY = 4
const MAX_RULE_SUPPORT_PAYLOAD_BYTES = 1_048_576
const MAX_ARCHIVED_SOURCE_SPAN_BYTES = 128 * 1024
const MAX_SOURCE_BINDING_BYTES = 64 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type RuleDerivationEvidenceProducerErrorCode =
  | 'INVALID_REQUEST'
  | 'MATERIALIZED_SLICE_READ_INCOMPLETE'
  | 'MATERIALIZED_ARTIFACT_NOT_FOUND'
  | 'MATERIALIZED_ARTIFACT_AMBIGUOUS'
  | 'MATERIALIZED_ARTIFACT_INVALID'
  | 'ARTIFACT_ARCHIVE_FAILED'
  | 'ARTIFACT_PAYLOAD_TOO_LARGE'
  | 'SOURCE_PARSE_UNAVAILABLE'
  | 'EVIDENCE_PERSIST_FAILED'

export class RuleDerivationEvidenceProducerError extends Error {
  readonly code: RuleDerivationEvidenceProducerErrorCode

  constructor(code: RuleDerivationEvidenceProducerErrorCode, message: string, options?: ErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RuleDerivationEvidenceProducerError'
    this.code = code
  }
}

export interface MaterializedRuleDerivationEvidenceProducerDependencies {
  /** Append-only materialization slices; current publication heads are never consulted. */
  readonly materialization: Pick<MaterializationStore, 'readSlices'>
  readonly evidence: Pick<EvidenceStorePort, 'get' | 'record'>
  readonly artifacts: ImmutableArtifactWriter
  /** Optional bridge from the published sourceCandidateId back to its immutable extraction candidate. */
  readonly candidates?: Pick<CandidateStore, 'getCandidate'>
  /** Resolves a logical document-version pin to the scoped parse and its actual original blob ref. */
  readonly documentParses?: Pick<DocumentParseStore, 'findParseByDigest' | 'getParse'>
  /** Optional authorized source-span reader. Raw chunk refs remain incomplete without this port. */
  readonly documentSpans?: DocumentSpanReaderPort
  readonly componentRef: VersionRef
  readonly maxSlices?: number
  readonly newId?: () => Uuid
}

export interface RecordMaterializedRuleDerivationEvidenceInput {
  readonly scopeRef: ScopeRef
  readonly ruleRef: VersionRef
  readonly definitionRef: VersionRef
  readonly objectId: string
  readonly subjectEntityId: string
  /** Must be the exact evaluation validAt stored on the selected computation artifact. */
  readonly validAt: string
  /** Must be the exact global recorded sequence stored on the selected computation artifact. */
  readonly asOfRecordedSeq: RevisionString
  readonly observedAt: string
  readonly sourceSnapshots: readonly SourceSnapshot[]
  readonly dataMode: DataMode
}

interface MaterializedCandidate {
  readonly slice: ProjectionSlice
  readonly artifact: RuleComputationArtifact
}

function sameVersion(left: VersionRef, right: VersionRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest
}

function scopeMatches(left: ScopeRef, right: ScopeRef): boolean {
  return left.tenantId === right.tenantId && left.spaceId === right.spaceId
}

function sliceCovers(slice: ProjectionSlice, validAt: string): boolean {
  const afterStart = compareUtcInstants(slice.validity.validFrom, validAt)
  const beforeEnd = slice.validity.validTo === undefined ? -1 : compareUtcInstants(validAt, slice.validity.validTo)
  return afterStart !== undefined && afterStart <= 0 &&
    (slice.validity.validTo === undefined || (beforeEnd !== undefined && beforeEnd < 0))
}

function artifactMatches(
  artifact: RuleComputationArtifact,
  input: RecordMaterializedRuleDerivationEvidenceInput,
): boolean {
  return scopeMatches(artifact.scopeRef, input.scopeRef) &&
    sameVersion(artifact.ruleRef, input.ruleRef) &&
    sameVersion(artifact.definitionRef, input.definitionRef) &&
    artifact.objectId === input.objectId &&
    artifact.subjectEntityId === input.subjectEntityId &&
    artifact.validAt !== undefined && sameUtcInstant(artifact.validAt, input.validAt) &&
    artifact.asOfRecordedSeq === input.asOfRecordedSeq
}

function uniqueCandidate(candidates: readonly MaterializedCandidate[]): MaterializedCandidate {
  const byInstance = new Map<string, MaterializedCandidate>()
  for (const candidate of candidates) {
    const instanceKey = candidate.artifact.instanceKey
    const existing = byInstance.get(instanceKey)
    if (existing === undefined) {
      byInstance.set(instanceKey, candidate)
      continue
    }
    if (sha256DigestOf(existing.artifact) !== sha256DigestOf(candidate.artifact)) {
      throw new RuleDerivationEvidenceProducerError(
        'MATERIALIZED_ARTIFACT_AMBIGUOUS',
        `materialized instance ${instanceKey} has conflicting artifacts at the requested bitemporal point`,
      )
    }
  }
  if (byInstance.size === 0) {
    throw new RuleDerivationEvidenceProducerError(
      'MATERIALIZED_ARTIFACT_NOT_FOUND',
      'no exact materialized rule artifact matches the requested entity and bitemporal point',
    )
  }
  if (byInstance.size !== 1) {
    throw new RuleDerivationEvidenceProducerError(
      'MATERIALIZED_ARTIFACT_AMBIGUOUS',
      'more than one entity-qualified materialized rule artifact matches the request',
    )
  }
  const selected = [...byInstance.values()][0]
  if (selected === undefined) {
    throw new RuleDerivationEvidenceProducerError('MATERIALIZED_ARTIFACT_NOT_FOUND', 'the selected artifact disappeared')
  }
  return selected
}

function sourceRefsOf(artifact: RuleComputationArtifact): ResourceRef[] {
  return [
    ...artifact.factRefs.flatMap((fact) => fact.sourceRefs ?? []),
    ...artifact.applicability.exceptionStates.flatMap((exception) =>
      exception.factRefs.flatMap((fact) => fact.sourceRefs ?? []),
    ),
  ]
}

function sameResourceRef(left: ResourceRef, right: ResourceRef): boolean {
  return left.id === right.id && left.version === right.version && left.digest === right.digest && left.kind === right.kind
}

function sha256OfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function refIdentity(ref: ResourceRef): string {
  return JSON.stringify([ref.id, ref.version, ref.digest, ref.kind])
}

function sameScopeRef(left: ScopeRef, right: ScopeRef): boolean {
  return left.tenantId === right.tenantId && left.spaceId === right.spaceId
}

function documentCandidateMatches(
  candidate: CandidateRecord,
  artifact: RuleComputationArtifact,
  sourceRef: ResourceRef,
  sourceStatementId: string,
): { readonly documentVersionRef: ResourceRef; readonly span: TextCandidateSourceSpan } | undefined {
  if (candidate.kind !== 'entity' || candidate.candidateId !== sourceStatementId ||
      candidate.objectId !== artifact.objectId ||
      !sameVersion(candidate.inputVersion.definitionRef, artifact.definitionRef) ||
      candidate.inputVersion.documentVersionRef === undefined ||
      candidate.inputVersion.documentVersionRef.kind !== 'document' ||
      candidate.inputVersion.parserVersion !== sourceRef.version || sourceRef.kind !== 'chunk') return undefined
  const spans = candidate.sourceSpans.filter((span): span is TextCandidateSourceSpan =>
    span.kind !== 'structured' && span.parseId === candidate.inputVersion.parseId && span.chunkId === sourceRef.id &&
    span.quoteDigest === sourceRef.digest && span.textDigest === sourceRef.digest,
  )
  if (spans.length !== 1) return undefined
  const span = spans[0]
  if (span === undefined) return undefined
  return { documentVersionRef: candidate.inputVersion.documentVersionRef, span }
}

interface SourceBridgeResult {
  readonly mappings: readonly RuleDerivationSourceEvidenceMapping[]
  readonly limitations: readonly string[]
  readonly mappedKeys: ReadonlySet<string>
}

interface PolicyBridgeResult {
  readonly mappings: readonly RulePolicySourceEvidenceMapping[]
  readonly limitations: readonly string[]
}

interface SupportFactMappingTarget {
  readonly groupId: string
  readonly fact: RuleComputationFactRef
  readonly sourceRef: ResourceRef
}

interface ArchivedSourceMapping {
  readonly evidenceRef: ResourceRef
  readonly documentVersionRef: ResourceRef
  readonly documentRef: ResourceRef
  readonly sourceSpan: TextCandidateSourceSpan
  readonly parserVersion: Semver
}

type ArchivedSourceMappingResult =
  | { readonly ok: true; readonly source: ArchivedSourceMapping }
  | { readonly ok: false; readonly reason: string }

function supportFactMappingTargets(slice: ProjectionSlice, artifact: RuleComputationArtifact): SupportFactMappingTarget[] | undefined {
  const groups = materializedRuleSupportFactGroupsOf(slice, artifact)
  if (groups === undefined) return undefined
  const targets: SupportFactMappingTarget[] = []
  for (const group of groups) {
    for (const fact of group.factRefs) {
      for (const sourceRef of fact.sourceRefs ?? []) {
        if (sourceRef.kind !== 'evidence') targets.push({ groupId: group.groupId, fact, sourceRef })
      }
    }
  }
  return targets
}

async function missingEvidenceRefs(
  evidence: Pick<EvidenceStorePort, 'get'>,
  scopeRef: ScopeRef,
  refs: readonly ResourceRef[],
  ctx: ToolContext,
): Promise<boolean> {
  const unique = new Map<string, ResourceRef>()
  for (const ref of refs) if (ref.kind === 'evidence') {
    unique.set(`${ref.id}\u0000${ref.version}\u0000${ref.digest}\u0000${ref.kind}`, ref)
  }
  const evidenceRefs = [...unique.values()]
  if (evidenceRefs.length > MAX_SOURCE_EVIDENCE_REFS) return true
  for (let offset = 0; offset < evidenceRefs.length; offset += EVIDENCE_READ_CONCURRENCY) {
    const batch = evidenceRefs.slice(offset, offset + EVIDENCE_READ_CONCURRENCY)
    const available = await Promise.all(batch.map(async (ref) => {
      try {
        const record = await evidence.get(scopeRef, ref.id, ctx)
        const actual = record?.evidenceRef
        return actual !== undefined && actual.id === ref.id && actual.version === ref.version &&
          actual.digest === ref.digest && actual.kind === ref.kind
      } catch {
        return false
      }
    }))
    if (available.some((found) => !found)) return true
  }
  return false
}

/**
 * Archives and records only an exact, already-materialized rule instance. It never computes a
 * rule or reads current publication heads. The fact-premise raw refs are bridged through the
 * real candidate → parse → span chain, and the reviewed rule's specification spans are located
 * through the scoped parse record and authorized span reader. The two axes are archived on
 * separate evidence envelopes and separate payload mappings so a complete fact graph is never
 * presented as verified policy text.
 */
export class MaterializedRuleDerivationEvidenceProducer {
  readonly #materialization: Pick<MaterializationStore, 'readSlices'>
  readonly #evidence: Pick<EvidenceStorePort, 'get' | 'record'>
  readonly #artifacts: ImmutableArtifactWriter
  readonly #candidates: Pick<CandidateStore, 'getCandidate'> | undefined
  readonly #documentParses: Pick<DocumentParseStore, 'findParseByDigest' | 'getParse'> | undefined
  readonly #documentSpans: DocumentSpanReaderPort | undefined
  readonly #componentRef: VersionRef
  readonly #maxSlices: number
  readonly #newId: () => Uuid

  constructor(dependencies: MaterializedRuleDerivationEvidenceProducerDependencies) {
    this.#materialization = dependencies.materialization
    this.#evidence = dependencies.evidence
    this.#artifacts = dependencies.artifacts
    this.#candidates = dependencies.candidates
    this.#documentParses = dependencies.documentParses
    this.#documentSpans = dependencies.documentSpans
    this.#componentRef = dependencies.componentRef
    this.#maxSlices = dependencies.maxSlices ?? DEFAULT_MAX_SLICES
    this.#newId = dependencies.newId ?? (() => randomUUID())
  }

  async record(
    input: RecordMaterializedRuleDerivationEvidenceInput,
    ctx: ToolContext,
  ): Promise<EvidenceRecord> {
    if (!Number.isSafeInteger(this.#maxSlices) || this.#maxSlices < 1 ||
        input.objectId.length === 0 || input.subjectEntityId.length === 0 || input.validAt.length === 0) {
      throw new RuleDerivationEvidenceProducerError('INVALID_REQUEST', 'entity, object, validAt and slice bounds must be non-empty')
    }
    const slices = await this.#materialization.readSlices(input.scopeRef, {
      validAt: input.validAt,
      asOfRecordedSeq: input.asOfRecordedSeq,
      limit: this.#maxSlices + 1,
    }, ctx)
    if (slices.length > this.#maxSlices) {
      throw new RuleDerivationEvidenceProducerError('MATERIALIZED_SLICE_READ_INCOMPLETE', 'the bounded materialized slice read exceeded its configured cap')
    }
    const candidates: MaterializedCandidate[] = []
    for (const slice of slices) {
      if (!scopeMatches(slice.scopeRef, input.scopeRef) || !sliceCovers(slice, input.validAt)) continue
      if (slice.recordedSeq !== input.asOfRecordedSeq ||
          !slice.conclusion.ruleRefs.some((ref) => sameVersion(ref, input.ruleRef))) continue
      for (const value of slice.conclusion.ruleArtifacts ?? []) {
        if (!isRuleComputationArtifact(value) || !artifactMatches(value, input)) continue
        if (!value.complete || !digestIsSelfConsistent(value)) {
          throw new RuleDerivationEvidenceProducerError('MATERIALIZED_ARTIFACT_INVALID', 'the exact materialized artifact is incomplete or its computation digest is inconsistent')
        }
        candidates.push({ slice, artifact: value })
      }
    }
    const selected = uniqueCandidate(candidates)
    const artifactRecordedSeq = selected.artifact.asOfRecordedSeq
    if (artifactRecordedSeq === undefined || selected.artifact.validAt === undefined) {
      throw new RuleDerivationEvidenceProducerError('MATERIALIZED_ARTIFACT_INVALID', 'the selected artifact has no exact validAt/recorded sequence pin')
    }

    const refs = sourceRefsOf(selected.artifact)
    const limitations = new Set<string>()
    if (refs.length === 0) limitations.add('the materialized rule artifact has no source ResourceRefs')
    if (selected.artifact.sourceSpans.length === 0) {
      limitations.add('the materialized rule artifact retains no specification source span to locate')
    }
    if (selected.artifact.factRefs.some((fact) => fact.sourceStatementId === undefined) ||
        selected.artifact.applicability.exceptionStates.some((exception) => exception.factRefs.some((fact) => fact.sourceStatementId === undefined))) {
      limitations.add('some materialized premise facts do not retain their parent statement id')
    }

    const bridge = await this.#bridgeSourceEvidenceMappings(input, selected, ctx)
    for (const limitation of bridge.limitations) limitations.add(limitation)
    const policyBridge = await this.#bridgePolicySourceEvidenceMappings(input, selected, ctx)
    for (const limitation of policyBridge.limitations) limitations.add(limitation)

    const supportPayload: RuleDerivationSupportPayload = {
      schemaVersion: 'rule-derivation-support-payload@1',
      artifact: selected.artifact,
      sourceEvidenceMappings: [...bridge.mappings],
      policySourceEvidenceMappings: [...policyBridge.mappings],
    }
    let payload = new TextEncoder().encode(JSON.stringify(supportPayload))
    if (payload.byteLength > MAX_RULE_SUPPORT_PAYLOAD_BYTES) {
      // Keep the instance locator useful where possible, but do not claim raw refs have been
      // bridged when the mapping wrapper itself would exceed the reader's byte cap.
      limitations.add('source evidence mapping wrapper exceeded the 1 MiB archive bound; only the exact materialized artifact was archived')
      payload = new TextEncoder().encode(JSON.stringify(selected.artifact))
    }
    if (payload.byteLength > MAX_RULE_SUPPORT_PAYLOAD_BYTES) {
      throw new RuleDerivationEvidenceProducerError('ARTIFACT_PAYLOAD_TOO_LARGE', 'the exact materialized rule artifact exceeds the 1 MiB provenance payload bound')
    }
    let payloadRef: ResourceRef
    try {
      payloadRef = await this.#archiveArtifact(input.scopeRef, payload, ctx)
    } catch (error) {
      throw new RuleDerivationEvidenceProducerError('ARTIFACT_ARCHIVE_FAILED', 'could not archive the selected rule computation artifact', { cause: error })
    }

    if (refs.some((ref) => ref.kind !== 'evidence' && !bridge.mappedKeys.has(refIdentity(ref)))) {
      limitations.add('one or more raw premise refs could not be resolved to authorized archived source evidence; the support graph remains incomplete')
    }
    if (await missingEvidenceRefs(this.#evidence, input.scopeRef, refs, ctx)) {
      limitations.add('one or more premise evidence refs have no matching authorized archived envelope')
    }

    const body: Omit<EvidenceEnvelope, 'integrity'> = {
      evidenceId: this.#newId(),
      kind: 'rule_derivation',
      scopeRef: input.scopeRef,
      producedBy: { componentRef: this.#componentRef, ruleRef: selected.artifact.ruleRef },
      observedAt: input.observedAt,
      recordedSeq: artifactRecordedSeq,
      validity: selected.slice.validity,
      sourceSnapshots: [...input.sourceSnapshots],
      // The evidence envelope's `resultDigest` is the content digest of the archived support
      // payload it pins. That keeps the envelope byte-exact re-verifiable by the publication
      // gate (which re-reads and re-hashes the payload), while the rule computation digest stays
      // inside the archived artifact for the typed verifier to recompute. It never substitutes a
      // mutable publication head.
      resultDigest: payloadRef.digest,
      // Support edges (fact and specification) are derived from the exact materialized support
      // DAG and the archived payload on read. The envelope payload pins the selected instance.
      dependencies: [],
      dataMode: input.dataMode,
      payloadRef,
      ...(limitations.size === 0 ? {} : { limitations: [...limitations].sort() }),
    }
    const envelope: EvidenceEnvelope = {
      ...body,
      integrity: { algorithm: 'sha256', digest: sha256DigestOf(body), verifiedAt: input.observedAt },
    }
    try {
      return await this.#evidence.record(input.scopeRef, envelope, ctx)
    } catch (error) {
      throw new RuleDerivationEvidenceProducerError('EVIDENCE_PERSIST_FAILED', 'could not persist the rule derivation evidence envelope', { cause: error })
    }
  }

  async #bridgeSourceEvidenceMappings(
    input: RecordMaterializedRuleDerivationEvidenceInput,
    selected: MaterializedCandidate,
    ctx: ToolContext,
  ): Promise<SourceBridgeResult> {
    const limitations = new Set<string>()
    const targets = supportFactMappingTargets(selected.slice, selected.artifact)
    if (targets === undefined) {
      return { mappings: [], limitations: ['the persisted support groups cannot be faithfully mapped to the artifact facts'], mappedKeys: new Set() }
    }
    const rawTargets = targets.filter((target) => target.sourceRef.kind !== 'evidence')
    if (rawTargets.length === 0) return { mappings: [], limitations: [], mappedKeys: new Set() }
    if (this.#candidates === undefined || this.#documentParses === undefined || this.#documentSpans === undefined) {
      return {
        mappings: [],
        limitations: ['raw premise refs are retained, but candidate, scoped parse, and authorized document-span readers were not all configured'],
        mappedKeys: new Set(),
      }
    }
    if (rawTargets.length > MAX_SOURCE_EVIDENCE_REFS) {
      return {
        mappings: [],
        limitations: ['raw source span bridge exceeded its 256-reference bound'],
        mappedKeys: new Set(),
      }
    }

    const mappings: RuleDerivationSourceEvidenceMapping[] = []
    const mappedKeys = new Set<string>()
    for (const target of rawTargets) {
      const sourceStatementId = target.fact.sourceStatementId
      if (sourceStatementId === undefined || !UUID_PATTERN.test(sourceStatementId)) {
        limitations.add('a raw source ref has no valid candidate id for exact candidate lookup')
        continue
      }
      const resourceKey = refIdentity(target.sourceRef)
      let cached: ArchivedSourceMapping | undefined
      let stage = 'candidate lookup'
      try {
        const candidate = await this.#candidates.getCandidate(input.scopeRef, sourceStatementId, ctx)
        if (candidate === undefined) {
          limitations.add(`published source candidate ${sourceStatementId} is not available in this scope`)
          continue
        }
        const resolved = documentCandidateMatches(candidate, selected.artifact, target.sourceRef, sourceStatementId)
        if (resolved === undefined) {
          limitations.add(`published source candidate ${sourceStatementId} does not prove the exact raw chunk ref`)
          continue
        }
        stage = 'parse resolution'
        const parse = await this.#documentParses.findParseByDigest(
          input.scopeRef,
          resolved.documentVersionRef.digest,
          candidate.inputVersion.parserVersion,
          ctx,
        )
        if (parse === undefined || !sameScopeRef(parse.scopeRef, input.scopeRef) ||
            parse.parseId !== candidate.inputVersion.parseId ||
            parse.parserVersion !== candidate.inputVersion.parserVersion ||
            parse.documentVersionRef === undefined || !sameResourceRef(parse.documentVersionRef, resolved.documentVersionRef) ||
            parse.originalRef.kind !== 'document' || parse.originalRef.digest !== resolved.documentVersionRef.digest) {
          limitations.add(`scoped parse metadata did not resolve the exact logical document version for candidate ${sourceStatementId}`)
          continue
        }
        stage = 'authorized span read'
        const response = await this.#documentSpans.readSpan({
          // The logical documentVersionRef may have a distinct stable id; the span reader
          // addresses the actual immutable original registered by the parse store.
          documentRef: parse.originalRef,
          locator: resolved.span.locator,
          maxBytes: MAX_ARCHIVED_SOURCE_SPAN_BYTES,
        }, ctx)
        stage = 'source archive and evidence write'
        const archived = await this.#archiveSourceSpan(input, selected, target, sourceStatementId, {
          documentVersionRef: resolved.documentVersionRef,
          documentRef: parse.originalRef,
          sourceSpan: resolved.span,
          parserVersion: candidate.inputVersion.parserVersion,
        }, response, ctx)
        if (!archived.ok) {
          limitations.add(`source span ${target.sourceRef.id} was not bridged: ${archived.reason}`)
          continue
        }
        cached = archived.source
      } catch {
        limitations.add(`source span ${target.sourceRef.id} failed during ${stage}`)
        continue
      }
      if (cached === undefined) continue
      mappings.push({
        premiseGroup: target.groupId,
        assertionId: target.fact.assertionId,
        logicalAssertionId: target.fact.logicalAssertionId,
        sourceStatementId,
        sourceRef: target.sourceRef,
        documentRef: cached.documentRef,
        documentVersionRef: cached.documentVersionRef,
        parserVersion: cached.parserVersion,
        sourceSpan: cached.sourceSpan,
        evidenceRef: cached.evidenceRef,
      })
      mappedKeys.add(resourceKey)
    }
    return { mappings, limitations: [...limitations], mappedKeys }
  }

  async #bridgePolicySourceEvidenceMappings(
    input: RecordMaterializedRuleDerivationEvidenceInput,
    selected: MaterializedCandidate,
    ctx: ToolContext,
  ): Promise<PolicyBridgeResult> {
    const spans = selected.artifact.sourceSpans
    if (spans.length === 0) return { mappings: [], limitations: [] }
    if (spans.length > MAX_POLICY_SPANS) {
      return { mappings: [], limitations: ['the specification span bridge exceeded its 256-span bound'] }
    }
    if (this.#documentParses === undefined || this.#documentSpans === undefined) {
      return {
        mappings: [],
        limitations: ['published rule specification spans are retained, but the scoped parse lookup and authorized document-span reader were not both configured'],
      }
    }
    const mappings: RulePolicySourceEvidenceMapping[] = []
    const limitations = new Set<string>()
    for (const span of spans) {
      let stage = 'scoped parse resolution'
      try {
        const parse = await this.#documentParses.getParse(input.scopeRef, span.parseId, ctx)
        if (parse === undefined || !sameScopeRef(parse.scopeRef, input.scopeRef) || parse.parseId !== span.parseId ||
            parse.documentVersionRef === undefined || parse.documentVersionRef.kind !== 'document' ||
            parse.originalRef.kind !== 'document' || parse.originalRef.digest !== parse.documentVersionRef.digest) {
          limitations.add(`specification span ${span.chunkId} has no scoped parse that resolves its document version`)
          continue
        }
        stage = 'authorized span read'
        const response = await this.#documentSpans.readSpan({
          documentRef: parse.originalRef,
          locator: span.locator,
          maxBytes: MAX_ARCHIVED_SOURCE_SPAN_BYTES,
        }, ctx)
        stage = 'specification text archive'
        const archived = await this.#archivePolicySourceSpan(input, selected, {
          span,
          documentVersionRef: parse.documentVersionRef,
          documentRef: parse.originalRef,
          parserVersion: parse.parserVersion,
        }, response, ctx)
        if (!archived.ok) {
          limitations.add(`specification span ${span.chunkId} was not bridged: ${archived.reason}`)
          continue
        }
        mappings.push(archived.mapping)
      } catch {
        limitations.add(`specification span ${span.chunkId} failed during ${stage}`)
        continue
      }
    }
    return { mappings, limitations: [...limitations] }
  }

  async #archiveArtifact(scopeRef: ScopeRef, bytes: Uint8Array, ctx: ToolContext): Promise<ResourceRef> {
    const digest = sha256OfBytes(bytes)
    const archived = await this.#artifacts.putBytes({ scopeRef, content: bytes, mediaType: 'application/json' }, ctx)
    if (archived.blobRef.kind !== 'artifact' || archived.blobRef.digest !== digest || archived.contentDigest !== digest) {
      throw new Error('artifact writer returned a mismatched content digest or resource ref')
    }
    return archived.blobRef
  }

  async #archiveSourceSpan(
    input: RecordMaterializedRuleDerivationEvidenceInput,
    selected: MaterializedCandidate,
    target: SupportFactMappingTarget,
    sourceStatementId: string,
    source: Omit<ArchivedSourceMapping, 'evidenceRef'>,
    response: ReadSpanResponse,
    ctx: ToolContext,
  ): Promise<ArchivedSourceMappingResult> {
    const sourceRef = target.sourceRef
    if (response.truncated === true || !sameResourceRef(response.documentRef, source.documentRef)) {
      return { ok: false, reason: 'DocumentSpanReader returned a truncated span or a different original document ref' }
    }
    const span = source.sourceSpan
    const bytes = new TextEncoder().encode(response.text)
    const digest = sha256OfBytes(bytes)
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVED_SOURCE_SPAN_BYTES ||
        digest !== sourceRef.digest || response.textDigest !== sourceRef.digest ||
        span.quoteDigest !== sourceRef.digest || span.textDigest !== sourceRef.digest) {
      return { ok: false, reason: 'span bytes, text digest, chunk digest, or 128 KiB bound did not match' }
    }
    const textArtifactRef = await this.#archiveArtifactBytes(input.scopeRef, bytes, 'text/plain', ctx)
    const binding: RuleSourceSpanArchiveBinding = {
      schemaVersion: 'rule-source-span-binding@1',
      premiseGroup: target.groupId,
      assertionId: target.fact.assertionId,
      logicalAssertionId: target.fact.logicalAssertionId,
      sourceStatementId,
      sourceRef,
      documentVersionRef: source.documentVersionRef,
      documentRef: source.documentRef,
      parserVersion: source.parserVersion,
      sourceSpan: span,
      textArtifactRef,
    }
    const recorded = await this.#recordDocumentSpanEvidence({
      input, selected, binding, textArtifactRef, resultDigest: sourceRef.digest,
      response, approximate: span.precision === 'approximate', ctx,
    })
    return recorded.ok ? { ok: true, source: { ...source, evidenceRef: recorded.evidenceRef } } : { ok: false, reason: recorded.reason }
  }

  async #archivePolicySourceSpan(
    input: RecordMaterializedRuleDerivationEvidenceInput,
    selected: MaterializedCandidate,
    source: {
      readonly span: RuleProvenanceSpan
      readonly documentVersionRef: ResourceRef
      readonly documentRef: ResourceRef
      readonly parserVersion: Semver
    },
    response: ReadSpanResponse,
    ctx: ToolContext,
  ): Promise<{ readonly ok: true; readonly mapping: RulePolicySourceEvidenceMapping } | { readonly ok: false; readonly reason: string }> {
    if (response.truncated === true || !sameResourceRef(response.documentRef, source.documentRef)) {
      return { ok: false, reason: 'DocumentSpanReader returned a truncated span or a different original document ref' }
    }
    const bytes = new TextEncoder().encode(response.text)
    const digest = sha256OfBytes(bytes)
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVED_SOURCE_SPAN_BYTES ||
        digest !== source.span.quoteDigest || response.textDigest !== source.span.quoteDigest) {
      return { ok: false, reason: 'span bytes or quoted text digest did not match the published specification span' }
    }
    const textArtifactRef = await this.#archiveArtifactBytes(input.scopeRef, bytes, 'text/plain', ctx)
    const binding: RulePolicySpanArchiveBinding = {
      schemaVersion: 'rule-policy-span-binding@1',
      span: source.span,
      documentVersionRef: source.documentVersionRef,
      documentRef: source.documentRef,
      parserVersion: source.parserVersion,
      textArtifactRef,
    }
    const recorded = await this.#recordDocumentSpanEvidence({
      input, selected, binding, textArtifactRef, resultDigest: source.span.quoteDigest,
      response, approximate: source.span.precision === 'approximate', ctx,
    })
    if (!recorded.ok) return { ok: false, reason: recorded.reason }
    return {
      ok: true,
      mapping: {
        span: source.span,
        documentVersionRef: source.documentVersionRef,
        documentRef: source.documentRef,
        parserVersion: source.parserVersion,
        textArtifactRef,
        evidenceRef: recorded.evidenceRef,
      },
    }
  }

  async #archiveArtifactBytes(
    scopeRef: ScopeRef,
    bytes: Uint8Array,
    mediaType: string,
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    const digest = sha256OfBytes(bytes)
    const archived = await this.#artifacts.putBytes({ scopeRef, content: bytes, mediaType }, ctx)
    if (archived.blobRef.kind !== 'artifact' || archived.blobRef.digest !== digest || archived.contentDigest !== digest) {
      throw new Error('source artifact writer returned a mismatched content digest or resource ref')
    }
    return archived.blobRef
  }

  /**
   * Archive the immutable binding artifact and record the `document_span` envelope that points
   * at it, returning the evidence ref only after the store echoes the exact scoped envelope back.
   */
  async #recordDocumentSpanEvidence(request: {
    readonly input: RecordMaterializedRuleDerivationEvidenceInput
    readonly selected: MaterializedCandidate
    readonly binding: RuleSourceSpanArchiveBinding | RulePolicySpanArchiveBinding
    readonly textArtifactRef: ResourceRef
    readonly resultDigest: string
    readonly response: ReadSpanResponse
    readonly approximate: boolean
    readonly ctx: ToolContext
  }): Promise<{ readonly ok: true; readonly evidenceRef: ResourceRef } | { readonly ok: false; readonly reason: string }> {
    const bindingBytes = new TextEncoder().encode(JSON.stringify(request.binding))
    if (bindingBytes.byteLength > MAX_SOURCE_BINDING_BYTES) return { ok: false, reason: 'source span binding exceeded 64 KiB' }
    let payloadRef: ResourceRef
    try {
      payloadRef = await this.#archiveArtifactBytes(request.input.scopeRef, bindingBytes, 'application/json', request.ctx)
    } catch {
      return { ok: false, reason: 'source binding artifact write failed' }
    }
    const sourceSnapshot: SourceSnapshot = {
      ...request.response.snapshot,
      resultDigest: request.resultDigest,
      archivedResultRef: request.textArtifactRef,
    }
    const body: Omit<EvidenceEnvelope, 'integrity'> = {
      evidenceId: this.#newId(),
      kind: 'document_span',
      scopeRef: request.input.scopeRef,
      producedBy: { componentRef: this.#componentRef },
      observedAt: request.input.observedAt,
      validity: request.selected.slice.validity,
      sourceSnapshots: [sourceSnapshot],
      resultDigest: request.resultDigest,
      dependencies: [],
      dataMode: 'observed',
      payloadRef,
      ...(request.approximate ? { limitations: ['source text was recovered through an approximate span'] } : {}),
    }
    const envelope: EvidenceEnvelope = {
      ...body,
      integrity: { algorithm: 'sha256', digest: sha256DigestOf(body), verifiedAt: request.input.observedAt },
    }
    try {
      const record = await this.#evidence.record(request.input.scopeRef, envelope, request.ctx)
      if (record.evidenceRef.kind !== 'evidence' || record.evidenceRef.id !== envelope.evidenceId ||
          record.envelope.evidenceId !== envelope.evidenceId || !sameScopeRef(record.envelope.scopeRef, request.input.scopeRef) ||
          record.envelope.kind !== 'document_span' || record.envelope.resultDigest !== request.resultDigest ||
          record.envelope.payloadRef === undefined || !sameResourceRef(record.envelope.payloadRef, payloadRef)) {
        return { ok: false, reason: 'the evidence store did not return the exact scoped document-span envelope' }
      }
      return { ok: true, evidenceRef: record.evidenceRef }
    } catch {
      return { ok: false, reason: 'document-span evidence persistence failed' }
    }
  }
}
