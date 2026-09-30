import { isToolContext } from '@ontology/contracts'
import type {
  BlobPort,
  DependencyGraphView,
  DependencyNodeView,
  DependencySupportCoverage,
  DependencySupportResolutionEntry,
  DependencyTraversalRequest,
  EvidenceDependencyEdge,
  EvidenceDependencyReadResult,
  EvidenceDependencySupportReadStatus,
  EvidenceExportArtifact,
  EvidenceExportView,
  EvidenceReadQuery,
  EvidenceRecord,
  EvidenceStorePort,
  ProvenanceEvidenceView,
  ProvenancePremiseGroupView,
  ProvenanceSpecificationSpanView,
  ProvenanceSupportAxisCoverage,
  ProvenanceSupportResolution,
  ProvenanceSourceView,
  ResourceRef,
  ScopeRef,
  SourceReReadability,
  ToolContext,
  Uuid,
} from '@ontology/contracts'
import type { AuthorizedArtifactReader } from '../provenance-service'
import { ProvenanceReadError } from './errors'
import { decodeCursor, encodeCursor } from './cursor'

/**
 * The real evidence-dependency source.
 *
 * An implementation returns the evidence lineage recorded on the envelope and the premises of
 * the compact rule support DAG the evidence was derived from. It must never return a
 * schema/type relation: the ontology type graph and the evidence support graph are distinct,
 * and a type-level relation is not evidence that one conclusion rests on another (SPEC D4,
 * §9; US-022). The `origin` on every edge makes the distinction observable to the caller.
 */
export interface EvidenceDependencySource {
  dependenciesOf(
    scopeRef: ScopeRef,
    evidence: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<readonly EvidenceDependencyEdge[]>
  /** Optional completeness-aware method; legacy edge-only sources remain usable but unknown. */
  dependenciesWithResolutionOf?(
    scopeRef: ScopeRef,
    evidence: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<EvidenceDependencyReadResult>
}

export interface ProvenanceReadServiceDependencies {
  readonly evidence: EvidenceStorePort
  readonly blobs: BlobPort
  readonly dependencies: EvidenceDependencySource
  /** Authorized byte read for a controlled export; absent means export is not configured. */
  readonly reader?: AuthorizedArtifactReader
  /** Ceiling for a dependency traversal; a larger request is clamped, never rejected. */
  readonly maxDependencyDepth?: number
  /** Ceiling for one dependency/history page; a larger request is clamped. */
  readonly maxPageSize?: number
}

const DEFAULT_MAX_DEPENDENCY_DEPTH = 4
const DEFAULT_MAX_PAGE_SIZE = 200
const DEFAULT_DEPENDENCY_PAGE_SIZE = 50

interface DependencyCursorPayload {
  readonly queue: readonly { readonly evidenceId: Uuid; readonly depth: number }[]
  readonly visited: readonly Uuid[]
}

interface DependencyReadResult {
  readonly edges: readonly EvidenceDependencyEdge[]
  readonly supportResolution: ProvenanceSupportResolution
  readonly factSupport: ProvenanceSupportAxisCoverage
  readonly policy?: ProvenanceSupportAxisCoverage
  readonly policySpans?: readonly ProvenanceSpecificationSpanView[]
}

function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx)) {
    throw new ProvenanceReadError('SCOPE_MISMATCH', 'a host-minted trusted tool context is required')
  }
  const tenantId = ctx.principal.tenantId
  const spaceId = ctx.allowedResources.spaceId
  if (ctx.allowedResources.tenantId !== tenantId) {
    throw new ProvenanceReadError('SCOPE_MISMATCH', 'trusted context carries inconsistent tenant scope')
  }
  return { tenantId, spaceId }
}

function compareRevision(left: string, right: string): number {
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber
  return left < right ? -1 : left > right ? 1 : 0
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  if (floored < min) return min
  return floored > max ? max : floored
}

function isDependencyCursor(value: unknown): value is DependencyCursorPayload {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { readonly queue?: unknown; readonly visited?: unknown }
  if (!Array.isArray(candidate.queue) || !Array.isArray(candidate.visited)) return false
  const queueOk = candidate.queue.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const item = entry as { readonly evidenceId?: unknown; readonly depth?: unknown }
    return typeof item.evidenceId === 'string' && typeof item.depth === 'number'
  })
  return queueOk && candidate.visited.every((entry) => typeof entry === 'string')
}

/**
 * Read-only provenance service (SPEC C3.1/C6, D3, US-017/US-022, FR-19/FR-20/FR-30).
 *
 * It resolves an evidence item into an explicit, authorized provenance view — its rule, its
 * premise groups, its source snapshots and whether the original source is re-readable — and a
 * bounded, honest dependency traversal. Every artifact read goes through the injected
 * `BlobPort`, which verifies the content digest and returns the same typed "not found" for a
 * missing object and an unauthorized one, so a corrupt or missing artifact yields
 * `unverifiable` instead of a silent empty result.
 */
export class ProvenanceReadService {
  readonly #evidence: EvidenceStorePort
  readonly #blobs: BlobPort
  readonly #dependencies: EvidenceDependencySource
  readonly #reader: AuthorizedArtifactReader | undefined
  readonly #maxDepth: number
  readonly #maxPageSize: number

  constructor(dependencies: ProvenanceReadServiceDependencies) {
    this.#evidence = dependencies.evidence
    this.#blobs = dependencies.blobs
    this.#dependencies = dependencies.dependencies
    this.#reader = dependencies.reader
    this.#maxDepth = dependencies.maxDependencyDepth ?? DEFAULT_MAX_DEPENDENCY_DEPTH
    this.#maxPageSize = dependencies.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE
  }

  /** `GET /evidence/{id}`: the authorized provenance view of one evidence item. */
  async getEvidence(
    evidenceId: Uuid,
    query: EvidenceReadQuery,
    ctx: ToolContext,
  ): Promise<ProvenanceEvidenceView> {
    const scopeRef = scopeOf(ctx)
    const record = await this.#load(scopeRef, evidenceId, ctx)
    const recordedSeq = record.envelope.recordedSeq
    if (
      query.asOf !== undefined &&
      recordedSeq !== undefined &&
      compareRevision(recordedSeq, query.asOf) > 0
    ) {
      // The evidence had not been recorded at the requested system version; it is not visible.
      throw new ProvenanceReadError(
        'EVIDENCE_NOT_FOUND',
        `evidence ${evidenceId} was not recorded at asOf ${query.asOf}`,
      )
    }

    const dependencyRead = await this.#readDependencies(scopeRef, record, ctx)
    const edges = dependencyRead.edges
    const isRule = record.envelope.producedBy.ruleRef !== undefined
    const { sources, artifactFailed } = await this.#resolveSources(scopeRef, record, ctx)
    const archivedResult = await this.#verifyArtifact(scopeRef, record.envelope.payloadRef, ctx)
    const integrityVerified =
      record.envelope.integrity.algorithm === 'sha256' &&
      record.envelope.integrity.digest === record.envelopeDigest

    const failureReason = this.#failureReason(integrityVerified, artifactFailed, archivedResult)
    const outcome = failureReason === undefined ? 'verifiable' : 'unverifiable'
    const ruleRef = record.envelope.producedBy.ruleRef

    return {
      evidenceId: record.evidenceRef.id,
      outcome,
      ...(failureReason === undefined ? {} : { reason: failureReason }),
      kind: record.envelope.kind,
      dataMode: record.envelope.dataMode,
      scopeRef: record.envelope.scopeRef,
      producedBy: record.envelope.producedBy,
      observedAt: record.envelope.observedAt,
      recordedAt: record.recordedAt,
      revision: record.revision,
      resultDigest: record.envelope.resultDigest,
      integrityVerified,
      ruleRefs: ruleRef === undefined ? [] : [ruleRef],
      supportResolution: dependencyRead.supportResolution,
      ...(isRule
        ? {
            factSupport: dependencyRead.factSupport,
            specification: {
              coverage: dependencyRead.policy ?? {
                complete: false,
                reason: 'the dependency source did not report specification-text coverage',
              },
              spans: dependencyRead.policySpans ?? [],
            },
          }
        : {}),
      premiseGroups: groupPremises(edges),
      sources,
      ...(archivedResult === undefined ? {} : { archivedResult }),
      originalSourceReReadable: sources.every((source) => source.reReadability !== 'unverifiable'),
      dependencies: edges,
      ...(query.asOf === undefined ? {} : { asOf: query.asOf }),
      ...(query.validAt === undefined ? {} : { validAt: query.validAt }),
    }
  }

  /**
   * `GET /evidence/{id}/dependencies`: a bounded traversal of the real evidence dependency
   * graph. `direction`, `depth` and the page size are enforced, and a traversal that stops
   * early is explicitly marked `coverage.truncated` so the caller cannot conclude completeness
   * or non-existence (SPEC §8/§9, C4).
   */
  async getDependencies(
    evidenceId: Uuid,
    traversal: DependencyTraversalRequest,
    ctx: ToolContext,
  ): Promise<DependencyGraphView> {
    const scopeRef = scopeOf(ctx)
    if (traversal.direction !== 'inbound' && traversal.direction !== 'outbound') {
      throw new ProvenanceReadError('INVALID_ARGUMENT', 'direction must be inbound or outbound')
    }
    const maxDepth = clampInteger(traversal.depth, 1, 0, this.#maxDepth)
    const pageSize = clampInteger(traversal.limit, DEFAULT_DEPENDENCY_PAGE_SIZE, 1, this.#maxPageSize)
    const root = await this.#load(scopeRef, evidenceId, ctx)

    const decoded = traversal.cursor === undefined ? undefined : decodeCursor(traversal.cursor)
    if (decoded !== undefined && !isDependencyCursor(decoded)) {
      throw new ProvenanceReadError('INVALID_CURSOR', 'the dependency cursor is not a valid traversal state')
    }
    const queue: { evidenceId: Uuid; depth: number }[] =
      decoded === undefined ? [{ evidenceId: root.evidenceRef.id, depth: 0 }] : [...decoded.queue]
    const visited = new Set<Uuid>(decoded === undefined ? [root.evidenceRef.id] : decoded.visited)

    const inbound = traversal.direction === 'inbound'
    const reverse = inbound ? await this.#reverseIndex(scopeRef, root, ctx) : undefined

    const nodes: DependencyNodeView[] = []
    const edges: EvidenceDependencyEdge[] = []
    const supportEntries: DependencySupportResolutionEntry[] = [...(reverse?.supportResolutions ?? [])]
    if (decoded !== undefined && !inbound) {
      // The cursor stores traversal position, not prior support proofs. Stay conservative on
      // later pages instead of allowing a page-local complete result to hide an earlier gap.
      supportEntries.push(supportEntry(root.evidenceRef.id, {
        state: 'unknown',
        complete: false,
        reason: 'continuation cursor does not carry earlier support-resolution results',
      }))
    }
    let truncated = false

    while (queue.length > 0) {
      if (nodes.length >= pageSize) {
        truncated = true
        break
      }
      const current = queue.shift()
      if (current === undefined) break
      const record = await this.#evidence.get(scopeRef, current.evidenceId, ctx)
      if (record === undefined) {
        nodes.push({ evidenceId: current.evidenceId, depth: current.depth, outcome: 'unverifiable' })
        supportEntries.push(supportEntry(current.evidenceId, {
          state: 'unavailable',
          complete: false,
          reason: 'the evidence record for this graph node is unavailable',
        }))
        continue
      }
      nodes.push({
        evidenceId: current.evidenceId,
        depth: current.depth,
        outcome: 'verifiable',
        kind: record.envelope.kind,
      })
      let discovered: readonly EvidenceDependencyEdge[]
      if (inbound) {
        discovered = reverse?.index.get(current.evidenceId) ?? []
      } else {
        const dependencyRead = await this.#readDependencies(scopeRef, record, ctx)
        discovered = dependencyRead.edges
        supportEntries.push(supportEntry(current.evidenceId, dependencyRead.supportResolution))
      }
      if (current.depth >= maxDepth) continue
      for (const edge of discovered) {
        edges.push(edge)
        const next = inbound ? edge.fromEvidenceId : edge.toEvidenceId
        if (visited.has(next)) continue
        visited.add(next)
        queue.push({ evidenceId: next, depth: current.depth + 1 })
      }
    }

    const nextCursor = truncated
      ? encodeCursor({ queue, visited: [...visited] } satisfies DependencyCursorPayload)
      : undefined
    const coverage: DependencyGraphView['coverage'] = {
      returned: nodes.length,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      truncated,
      support: supportCoverageOf(supportEntries),
    }
    return {
      rootEvidenceId: root.evidenceRef.id,
      direction: traversal.direction,
      depth: maxDepth,
      nodes,
      edges: dedupeEdges(edges),
      coverage,
    }
  }

  /**
   * Controlled export: the provenance view plus the verified bytes of every artifact it
   * references. A missing or corrupt artifact makes the outcome `unverifiable` and contributes
   * no bytes — an export never fabricates a successful bundle (C3.1/§8).
   */
  async exportEvidence(
    evidenceId: Uuid,
    query: EvidenceReadQuery,
    ctx: ToolContext,
  ): Promise<EvidenceExportView> {
    const scopeRef = scopeOf(ctx)
    const view = await this.getEvidence(evidenceId, query, ctx)
    const record = await this.#load(scopeRef, evidenceId, ctx)
    const refs = new Map<string, ResourceRef>()
    if (record.envelope.payloadRef !== undefined) refs.set(record.envelope.payloadRef.id, record.envelope.payloadRef)
    for (const snapshot of record.envelope.sourceSnapshots) {
      const ref = snapshot.archivedResultRef
      if (ref !== undefined) refs.set(ref.id, ref)
    }
    if (refs.size > 0 && this.#reader === undefined) {
      throw new ProvenanceReadError(
        'ARTIFACT_READER_NOT_CONFIGURED',
        'a controlled export requires an authorized artifact reader',
      )
    }
    const artifacts: EvidenceExportArtifact[] = []
    for (const ref of refs.values()) {
      const artifact = await this.#readArtifact(scopeRef, ref, ctx)
      if (artifact !== undefined) artifacts.push(artifact)
    }
    return { view, artifacts }
  }

  async #load(scopeRef: ScopeRef, evidenceId: Uuid, ctx: ToolContext): Promise<EvidenceRecord> {
    if (evidenceId.length === 0) {
      throw new ProvenanceReadError('INVALID_ARGUMENT', 'evidenceId must be a non-empty id')
    }
    const record = await this.#evidence.get(scopeRef, evidenceId, ctx)
    if (record === undefined) {
      // A missing record and an out-of-scope record are the same answer, so a cross-tenant
      // caller cannot learn whether the evidence exists (C6, D3.2).
      throw new ProvenanceReadError(
        'EVIDENCE_NOT_FOUND',
        `no authorized evidence ${evidenceId} in the requested scope`,
      )
    }
    return record
  }

  async #readDependencies(
    scopeRef: ScopeRef,
    record: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<DependencyReadResult> {
    const detailedReader = this.#dependencies.dependenciesWithResolutionOf
    if (detailedReader !== undefined) {
      const result = await detailedReader.call(this.#dependencies, scopeRef, record, ctx)
      const supportResolution = normalizedSupportResolution(result.supportResolution)
      return {
        edges: result.edges,
        supportResolution,
        factSupport: axisCoverageOf(supportResolution),
        ...(result.supportResolution.policy === undefined ? {} : { policy: result.supportResolution.policy }),
        ...(result.supportResolution.policySpans === undefined ? {} : { policySpans: result.supportResolution.policySpans }),
      }
    }

    const edges = await this.#dependencies.dependenciesOf(scopeRef, record, ctx)
    if (record.envelope.producedBy.ruleRef === undefined) {
      return {
        edges,
        supportResolution: { state: 'not_rule', complete: true },
        factSupport: { complete: true },
      }
    }
    const supportResolution: ProvenanceSupportResolution = {
      state: 'unknown',
      complete: false,
      reason: 'the dependency source does not report whether rule-support resolution was complete',
    }
    return { edges, supportResolution, factSupport: axisCoverageOf(supportResolution) }
  }

  async #resolveSources(
    scopeRef: ScopeRef,
    record: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<{ sources: ProvenanceSourceView[]; artifactFailed: boolean }> {
    const sources: ProvenanceSourceView[] = []
    let artifactFailed = false
    for (const snapshot of record.envelope.sourceSnapshots) {
      let reReadability: SourceReReadability
      let reason: string | undefined
      if (snapshot.archivedResultRef !== undefined) {
        const verified = await this.#verifyArtifact(scopeRef, snapshot.archivedResultRef, ctx)
        if (verified?.verified === true) {
          reReadability = 'archived_snapshot_only'
          reason = 'the original source is not guaranteed re-readable; the archived snapshot was verified'
        } else {
          reReadability = 'unverifiable'
          reason = 'the archived snapshot is missing or failed its digest check'
          artifactFailed = true
        }
      } else if (snapshot.consistency === 'immutable') {
        reReadability = 're_readable'
      } else {
        reReadability = 'unverifiable'
        reason = 'the source is not immutable and no archived snapshot exists'
      }
      sources.push({
        sourceRef: snapshot.sourceRef,
        schemaVersion: snapshot.schemaVersion,
        readAt: snapshot.readAt,
        ...(snapshot.asOf === undefined ? {} : { asOf: snapshot.asOf }),
        ...(snapshot.watermark === undefined ? {} : { watermark: snapshot.watermark }),
        consistency: snapshot.consistency,
        resultDigest: snapshot.resultDigest,
        ...(snapshot.archivedResultRef === undefined ? {} : { archivedResultRef: snapshot.archivedResultRef }),
        reReadability,
        ...(reason === undefined ? {} : { reason }),
      })
    }
    return { sources, artifactFailed }
  }

  async #verifyArtifact(
    scopeRef: ScopeRef,
    ref: ResourceRef | undefined,
    ctx: ToolContext,
  ): Promise<{ ref: ResourceRef; verified: boolean } | undefined> {
    if (ref === undefined) return undefined
    try {
      const authorized = await this.#blobs.getAuthorized({ scopeRef, blobRef: ref }, ctx)
      return { ref, verified: authorized.integrityVerified === true }
    } catch {
      // A missing object, an integrity mismatch and an unauthorized reference all resolve to
      // the same "not verifiable" answer; the blob port already hides which one it was.
      return { ref, verified: false }
    }
  }

  async #readArtifact(
    scopeRef: ScopeRef,
    ref: ResourceRef,
    ctx: ToolContext,
  ): Promise<EvidenceExportArtifact | undefined> {
    if (this.#reader === undefined) return undefined
    try {
      const authorized = await this.#blobs.getAuthorized({ scopeRef, blobRef: ref }, ctx)
      const bytes = await this.#reader.readAuthorized({ scopeRef, blobRef: ref }, ctx)
      return {
        ref,
        mediaType: authorized.mediaType,
        byteSize: authorized.byteSize,
        contentDigest: authorized.contentDigest,
        contentBase64: Buffer.from(bytes).toString('base64'),
      }
    } catch {
      return undefined
    }
  }

  /**
   * Build the reverse (inbound) adjacency from the evidence of the root's run. The run's
   * evidence set is bounded by the run's tool budget, so this never scans the whole archive.
   */
  async #reverseIndex(
    scopeRef: ScopeRef,
    root: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<{
    readonly index: Map<Uuid, EvidenceDependencyEdge[]>
    readonly supportResolutions: readonly DependencySupportResolutionEntry[]
  }> {
    const index = new Map<Uuid, EvidenceDependencyEdge[]>()
    const supportResolutions: DependencySupportResolutionEntry[] = []
    const runId = root.envelope.producedBy.runId
    if (runId === undefined) {
      return {
        index,
        supportResolutions: [supportEntry(root.evidenceRef.id, {
          state: 'unavailable',
          complete: false,
          reason: 'inbound traversal cannot enumerate candidate evidence without a run id',
        })],
      }
    }
    const runEvidence = await this.#evidence.listByRun(scopeRef, runId, ctx)
    for (const candidate of runEvidence) {
      const dependencyRead = await this.#readDependencies(scopeRef, candidate, ctx)
      supportResolutions.push(supportEntry(candidate.evidenceRef.id, dependencyRead.supportResolution))
      for (const edge of dependencyRead.edges) {
        const bucket = index.get(edge.toEvidenceId)
        if (bucket === undefined) index.set(edge.toEvidenceId, [edge])
        else bucket.push(edge)
      }
    }
    return { index, supportResolutions }
  }

  #failureReason(
    integrityVerified: boolean,
    artifactFailed: boolean,
    archivedResult: { readonly ref: ResourceRef; readonly verified: boolean } | undefined,
  ): string | undefined {
    if (!integrityVerified) return 'the evidence envelope integrity digest does not match'
    if (artifactFailed) return 'an archived source snapshot is missing or corrupt'
    if (archivedResult !== undefined && !archivedResult.verified) {
      return 'the archived evidence payload is missing or corrupt'
    }
    return undefined
  }
}

function groupPremises(edges: readonly EvidenceDependencyEdge[]): ProvenancePremiseGroupView[] {
  const groups = new Map<string, Set<Uuid>>()
  for (const edge of edges) {
    if (edge.origin !== 'support' || edge.premiseGroup === undefined) continue
    const bucket = groups.get(edge.premiseGroup)
    if (bucket === undefined) groups.set(edge.premiseGroup, new Set([edge.toEvidenceId]))
    else bucket.add(edge.toEvidenceId)
  }
  return [...groups.entries()]
    .map(([groupId, ids]) => ({ groupId, alternativeEvidenceIds: [...ids].sort() }))
    .sort((left, right) => left.groupId.localeCompare(right.groupId))
}

function dedupeEdges(edges: readonly EvidenceDependencyEdge[]): EvidenceDependencyEdge[] {
  const seen = new Map<string, EvidenceDependencyEdge>()
  for (const edge of edges) {
    const key = `${edge.fromEvidenceId}|${edge.toEvidenceId}|${edge.relation}|${edge.origin}|${edge.premiseGroup ?? ''}`
    if (!seen.has(key)) seen.set(key, edge)
  }
  return [...seen.values()].sort(
    (left, right) =>
      left.fromEvidenceId.localeCompare(right.fromEvidenceId) ||
      left.toEvidenceId.localeCompare(right.toEvidenceId) ||
      left.relation.localeCompare(right.relation),
  )
}

function normalizedSupportResolution(
  status: EvidenceDependencySupportReadStatus,
): ProvenanceSupportResolution {
  const knownComplete = status.state === 'not_rule' || status.state === 'resolved' || status.state === 'not_applicable'
  return {
    state: status.state,
    complete: knownComplete && status.complete !== false,
    ...(status.reason === undefined ? {} : { reason: status.reason }),
  }
}

function axisCoverageOf(resolution: ProvenanceSupportResolution): ProvenanceSupportAxisCoverage {
  return resolution.complete
    ? { complete: true }
    : { complete: false, ...(resolution.reason === undefined ? {} : { reason: resolution.reason }) }
}

function supportEntry(evidenceId: Uuid, resolution: ProvenanceSupportResolution): DependencySupportResolutionEntry {
  return { evidenceId, resolution }
}

function supportCoverageOf(entries: readonly DependencySupportResolutionEntry[]): DependencySupportCoverage {
  const byEvidence = new Map<Uuid, ProvenanceSupportResolution>()
  for (const entry of entries) {
    const previous = byEvidence.get(entry.evidenceId)
    if (previous === undefined || (previous.complete && !entry.resolution.complete)) {
      byEvidence.set(entry.evidenceId, entry.resolution)
    }
  }
  const resolutions = [...byEvidence.entries()]
    .map(([evidenceId, resolution]) => ({ evidenceId, resolution }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
  return {
    complete: resolutions.every((entry) => entry.resolution.complete),
    resolutions,
  }
}
