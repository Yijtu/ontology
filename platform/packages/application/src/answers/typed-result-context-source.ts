import { isResourceRef } from '@ontology/contracts'
import type {
  DataMode,
  DomainResultStatus,
  EvidenceKind,
  EvidenceRecord,
  EvidenceStorePort,
  ImmutableArtifactWriter,
  PublishedTaskBinding,
  ResourceRef,
  RunExecutionBindingStore,
  RunStore,
  ScopeRef,
  Sha256Digest,
  TaskBindingStore,
  TaskFinalizationReceipt,
  TaskFinalizationReceiptStore,
  TaskKind,
  ToolContext,
  ToolCoverage,
  TypedResultManifest,
  Uuid,
  VersionRef,
  WorkflowManifestStore,
} from '@ontology/contracts'
import { canonicalJson, sha256DigestOf } from '../profiles/canonical'
import {
  TypedDraftWriterError,
  typedResultContextFor,
} from './typed-draft-writer'
import type {
  TypedDraftArtifactStore,
  TypedResultContext,
  TypedResultContextSource,
} from './typed-draft-writer'
import { typedResultManifestContentDigest } from './typed-result-manifest'

/**
 * Production `TypedResultContextSource` (SPEC v0.3a execution-evidence §EX-6.1, §EX-7.1;
 * issue V03-037 / #208).
 *
 * The typed draft writer only emits an `answer-draft@3` when the host can hand it the exact
 * archived typed result manifest and the pre-draft finalization receipt. This source builds
 * those from the run's *real* execution binding and published task binding — never from a
 * model-supplied value, a hash-only ref or the resolved profile. It archives the manifest and
 * the receipt through the same immutable stores the verifier and publication gate re-read, so
 * the @3 body is bound to an artifact a reader can actually re-hash.
 *
 * A run without a task execution binding (the legacy `facts:`/NL path) has no task binding to
 * finalize against; the source returns `undefined` and the writer stays on `answer-draft@2`.
 * A task that declares required result policies is not silently finalized without running
 * them: the source fails closed, so the controller never publishes a formal result whose
 * declared policies were skipped.
 */

export interface TypedResultContextSourceDependencies {
  readonly runs: RunStore
  readonly executionBindings: RunExecutionBindingStore
  readonly taskBindings: TaskBindingStore
  readonly manifests: WorkflowManifestStore
  readonly evidence: EvidenceStorePort
  readonly artifacts: TypedDraftArtifactStore
  readonly artifactWriter: ImmutableArtifactWriter
  readonly receipts: TaskFinalizationReceiptStore
  /** Host reads the immutable executed plan receipt; a model response is never a selection. */
  readonly questionTaskSelection?: (ctx: ToolContext) => Promise<{ readonly taskBindingRef: VersionRef; readonly parameters: Readonly<Record<string, unknown>> } | undefined>
  readonly newId?: () => Uuid
}

function scopeOf(ctx: ToolContext): ScopeRef {
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ManifestEvidence {
  readonly ref: ResourceRef
  readonly kind: EvidenceKind
  readonly resultDigest: Sha256Digest
  readonly dataMode: DataMode
  readonly outputRef: ResourceRef
  readonly returned: number
  readonly truncated: boolean
  readonly domainStatus: DomainResultStatus
  readonly limitations: readonly string[]
}

/**
 * Purely derive the manifest summary fields from already-authorized evidence records and their
 * archived payloads. Nothing here is a model judgement: coverage is read back from the exact
 * payload and a truncated/gapped result can never be reported as complete.
 */
export function summarizeTypedResultEvidence(
  scopeRef: ScopeRef,
  ref: ResourceRef,
  record: EvidenceRecord,
  payload: Record<string, unknown> | undefined,
  ctx: ToolContext,
): ManifestEvidence {
  void ctx
  void scopeRef
  const coverage = isRecordValue(payload?.['coverage']) ? payload?.['coverage'] : undefined
  const gaps = Array.isArray(payload?.['gaps']) ? payload?.['gaps'] : []
  let returned = 1
  if (Array.isArray(payload?.['items'])) returned = payload['items'].length
  else if (isRecordValue(payload?.['table']) && Array.isArray(payload['table']['rows'])) {
    returned = payload['table']['rows'].length
  }
  const truncated = coverage?.['truncated'] === true || gaps.length > 0
  const domainStatus: DomainResultStatus = truncated ? 'unknown' : 'known'
  const limitations = record.envelope.limitations ?? []
  const outputRef = record.envelope.payloadRef ?? ref
  return {
    ref,
    kind: record.envelope.kind,
    resultDigest: record.envelope.resultDigest,
    dataMode: record.envelope.dataMode,
    outputRef,
    returned,
    truncated,
    domainStatus,
    limitations,
  }
}

/** Build the `typed-result-manifest@1` body from its already-authorized summary fields. */
export function buildTypedResultManifest(input: {
  readonly executionBindingRef: ResourceRef
  readonly taskBindingRef: VersionRef
  readonly resultKind: TaskKind
  readonly outputSchemaRef: VersionRef
  readonly inputSnapshotRef: ResourceRef
  readonly outputDigest: Sha256Digest
  readonly evidence: readonly ManifestEvidence[]
}): TypedResultManifest {
  const coverage: ToolCoverage = {
    returned: input.evidence.reduce((total, entry) => total + entry.returned, 0),
    truncated: input.evidence.some((entry) => entry.truncated),
  }
  const dataMode: DataMode = input.evidence[0]?.dataMode ?? 'synthetic'
  const domainStatus: DomainResultStatus = coverage.truncated ? 'unknown' : 'known'
  const limitations = [...new Set(input.evidence.flatMap((entry) => entry.limitations))].sort()
  return {
    schemaVersion: 'typed-result-manifest@1',
    executionBindingRef: input.executionBindingRef,
    taskBindingRef: input.taskBindingRef,
    resultKind: input.resultKind,
    outputSchemaRef: input.outputSchemaRef,
    inputSnapshotRef: input.inputSnapshotRef,
    outputDigest: input.outputDigest,
    tables: [],
    limitations,
    coverage,
    domainStatus,
    dataMode,
  }
}

export class RunTypedResultContextSource implements TypedResultContextSource {
  readonly #deps: TypedResultContextSourceDependencies
  readonly #newId: () => Uuid

  constructor(dependencies: TypedResultContextSourceDependencies) {
    this.#deps = dependencies
    this.#newId = dependencies.newId ?? (() => globalThis.crypto.randomUUID())
  }

  async resolve(
    input: { readonly runId: Uuid },
    ctx: ToolContext,
  ): Promise<TypedResultContext | undefined> {
    const scopeRef = scopeOf(ctx)
    const run = await this.#deps.runs.getRun(scopeRef, input.runId, ctx)
    const executionBindingRef = run?.executionBindingRef
    if (run === undefined || executionBindingRef === undefined || !isResourceRef(executionBindingRef)) {
      // Not a task-bound run: the legacy path has no execution binding to pin, so the writer
      // stays on @2 rather than inventing one.
      return undefined
    }
    const archived = await this.#deps.executionBindings.getBindingByRef(scopeRef, executionBindingRef, ctx)
    if (archived === undefined) {
      throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'the run execution binding is not archived in this scope')
    }
    const request = archived.binding.request
    const selection = request.mode === 'task' ? request : await this.#deps.questionTaskSelection?.(ctx)
    if (selection === undefined) return undefined
    if (!archived.binding.allowedTaskBindingRefs.some((ref) => canonicalJson(ref) === canonicalJson(selection.taskBindingRef))) throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'the executed task is outside the immutable run allowlist')
    const taskBinding = await this.#requireTaskBinding(scopeRef, selection.taskBindingRef, ctx)
    this.#assertFinalizable(taskBinding)

    const runManifest = await this.#deps.manifests.getRunManifest(input.runId, ctx)
    if (runManifest === undefined) {
      throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'the run has no locked manifest for typed finalization')
    }
    const inputManifest = await this.#deps.manifests.getInputManifest(runManifest.inputManifestId, ctx)
    if (inputManifest === undefined) {
      throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'the run has no input manifest for typed finalization')
    }
    const evidence = await this.#collectEvidence(scopeRef, inputManifest.entries, ctx)
    if (evidence.length === 0) {
      // Nothing result-backed: the writer itself decides whether this is insufficient data.
      return undefined
    }

    const manifest = buildTypedResultManifest({
      executionBindingRef,
      taskBindingRef: selection.taskBindingRef,
      resultKind: taskBinding.kind,
      outputSchemaRef: taskBinding.resultSchemaRef,
      inputSnapshotRef: request.inputSnapshotRef,
      outputDigest: resultOutputDigest(evidence),
      evidence,
    })
    const resultManifestRef = await this.#archiveManifest(scopeRef, manifest, ctx)
    const resultManifestDigest = typedResultManifestContentDigest(manifest)
    if (resultManifestRef.digest !== resultManifestDigest) {
      throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'the archived typed result manifest ref does not match its content digest')
    }

    const parametersRef = await this.#archiveParameters(scopeRef, selection.parameters, ctx)
    const receipt: TaskFinalizationReceipt = {
      schemaVersion: 'task-finalization-receipt@1',
      executionBindingRef,
      taskBindingRef: selection.taskBindingRef,
      inputSnapshotRef: request.inputSnapshotRef,
      inputSnapshotDigest: request.inputSnapshotDigest,
      parametersRef,
      parametersDigest: parametersRef.digest,
      outputArtifactRefs: evidence.map((entry) => entry.outputRef),
      outputDigests: evidence.map((entry) => entry.outputRef.digest),
      typedResultManifestRef: resultManifestRef,
      typedResultManifestDigest: resultManifestDigest,
      requiredPolicyBindings: [],
      policyReportRefs: [],
    }
    const finalizationReceiptRef = await this.#archiveReceipt(scopeRef, receipt, ctx)
    return typedResultContextFor({
      executionBindingRef,
      resultManifest: manifest,
      resultManifestRef,
      finalizationReceiptRef,
      finalizationReceiptDigest: finalizationReceiptRef.digest,
    })
  }

  async #requireTaskBinding(
    scopeRef: ScopeRef,
    taskBindingRef: VersionRef,
    ctx: ToolContext,
  ): Promise<PublishedTaskBinding> {
    const binding = await this.#deps.taskBindings.getBinding(scopeRef, taskBindingRef, ctx)
    if (binding === undefined) {
      throw new TypedDraftWriterError('INCOMPLETE_RESULT', 'the published task binding of this run is not archived')
    }
    return binding
  }

  #assertFinalizable(binding: PublishedTaskBinding): void {
    const required = (binding.validationPolicies ?? []).filter((policy) => policy.required)
    if (required.length > 0) {
      throw new TypedDraftWriterError(
        'INCOMPLETE_RESULT',
        'the task declares required validation policies that have not been executed, so no formal typed result can be finalized',
      )
    }
  }

  async #collectEvidence(
    scopeRef: ScopeRef,
    entries: readonly { readonly kind: string; readonly ref?: ResourceRef }[],
    ctx: ToolContext,
  ): Promise<ManifestEvidence[]> {
    const collected: ManifestEvidence[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      const ref = entry.ref
      if (entry.kind !== 'evidence' || ref === undefined || ref.kind !== 'evidence' || seen.has(ref.id)) continue
      seen.add(ref.id)
      const record = await this.#deps.evidence.get(scopeRef, ref.id, ctx)
      if (record === undefined || !sameRef(record.evidenceRef, ref)) continue
      const payload = await this.#readPayload(scopeRef, record, ctx)
      collected.push(summarizeTypedResultEvidence(scopeRef, ref, record, payload, ctx))
    }
    return collected
  }

  async #readPayload(
    scopeRef: ScopeRef,
    record: EvidenceRecord,
    ctx: ToolContext,
  ): Promise<Record<string, unknown> | undefined> {
    const payloadRef = record.envelope.payloadRef
    if (payloadRef === undefined) return undefined
    try {
      const authorized = await this.#deps.artifacts.getAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      if (!authorized.integrityVerified) return undefined
      const bytes = await this.#deps.artifacts.readAuthorized({ scopeRef, blobRef: payloadRef }, ctx)
      const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      return isRecordValue(decoded) ? decoded : undefined
    } catch {
      return undefined
    }
  }

  async #archiveManifest(
    scopeRef: ScopeRef,
    manifest: TypedResultManifest,
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    const bytes = new TextEncoder().encode(canonicalJson(manifest))
    const written = await this.#deps.artifactWriter.putBytes(
      { scopeRef, content: bytes, mediaType: 'application/json' },
      ctx,
    )
    return written.blobRef
  }

  async #archiveParameters(
    scopeRef: ScopeRef,
    parameters: Readonly<Record<string, unknown>>,
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    const bytes = new TextEncoder().encode(canonicalJson(parameters))
    const written = await this.#deps.artifactWriter.putBytes(
      { scopeRef, content: bytes, mediaType: 'application/json' },
      ctx,
    )
    return written.blobRef
  }

  async #archiveReceipt(
    scopeRef: ScopeRef,
    receipt: TaskFinalizationReceipt,
    ctx: ToolContext,
  ): Promise<ResourceRef> {
    const receiptRef: ResourceRef = {
      id: this.#newId(),
      version: '1.0.0',
      digest: sha256DigestOf(canonicalJson(receipt)),
      kind: 'artifact',
    }
    await this.#deps.receipts.putReceipt(scopeRef, receiptRef, receipt, ctx)
    return receiptRef
  }
}

function resultOutputDigest(evidence: readonly ManifestEvidence[]): Sha256Digest {
  return sha256DigestOf(canonicalJson(
    [...evidence]
      .map((entry) => ({ ref: entry.ref, resultDigest: entry.resultDigest }))
      .sort((left, right) => (left.ref.id < right.ref.id ? -1 : left.ref.id > right.ref.id ? 1 : 0)),
  ))
}

function sameRef(value: ResourceRef, expected: ResourceRef): boolean {
  return value.id === expected.id && value.version === expected.version &&
    value.digest === expected.digest && value.kind === expected.kind
}
