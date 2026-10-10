import { answerDraftContentHash, inputManifestDigest, scenarioManifestHash } from '@ontology/application'
import { createToolContext, isRecord, isResourceRef, isRevisionString, isSha256Digest, isStructuredParseSelection, isToolContext, isUuid, isVersionRef, sha256OfCanonical } from '@ontology/contracts'
import type { AnswerStorePort, ArchivedRunExecutionBinding, BlobGetAuthorizedRequest, BlobGetAuthorizedResponse, CandidateStore, DataMode, DocumentParseStore, InstanceReviewStore, ProjectDocumentStore, ProjectMappingStore, ProjectRecordStore, ProjectStore, ProvenanceEvidenceView, PublishedAnswer, ResourceRef, RulePremiseReplayPort, RunExecutionBindingStore, RunStore, ScopeRef, SourceLocator, SourceReReadability, StructuredIngestionStore, ToolContext, VersionRef, WorkflowManifestStore } from '@ontology/contracts'
import { DocumentSpanReader, StructuredDocumentSpanReader, sha256DigestOfBytes, sha256DigestOfText } from '@ontology/adapter-extraction-document'
import type { DocumentArtifactStore, StructuredProjectionOrigin } from '@ontology/adapter-extraction-document'
import type { ProvenanceReadService } from '@ontology/provenance'
import { ForbiddenError } from '../http/shared'
import { createRequestNativeSourceReader } from './core-native-source-reader'
import type { RequestNativeSourceReader } from './core-native-source-reader'
import { readSavedCell } from './core-saved-cell-reader'
import type { SavedCellPorts, SavedCellRead, SavedCellSelector } from './core-saved-cell-reader'
import { readSavedInputSources } from './core-saved-input-sources'
import type { SavedInputArtifactView, SavedInputSourcePorts, SourceReadCoverage } from './core-saved-input-sources'

export interface CoreSourceCell {
  readonly raw: string | boolean | null
  readonly locator: SourceLocator
  readonly columnLabel?: string
  readonly rowLabel?: string
}

export interface CoreAnswerSourceView {
  readonly answerId: string
  readonly evidenceId: string
  /** Logical PublishedAnswer identity; this is not a blob reference. */
  readonly answerRef: VersionRef
  readonly evidenceRef: ResourceRef
  readonly family: 'document_span' | 'structured_qa' | 'rule_support' | 'data_query'
  readonly precision: 'exact' | 'approximate'
  readonly readability: SourceReReadability
  readonly title: string
  readonly text?: string
  readonly cells?: readonly CoreSourceCell[]
  readonly originalRef?: ResourceRef
  readonly parseRef?: ResourceRef
  readonly locator?: SourceLocator
  readonly support?: ProvenanceEvidenceView
  /** Every original stays attached to its own cells when one search returned several files. */
  readonly fragments?: readonly CoreSourceFragment[]
  readonly sourceReadLimitation?: string
  readonly archivedPayload?: Readonly<Record<string, unknown>>
  readonly fixedInputRef?: ResourceRef
  readonly fixedDatasetSnapshotRef?: ResourceRef
  readonly sourceCoverage?: SourceReadCoverage
  readonly inputArtifacts?: readonly SavedInputArtifactView[]
  readonly selectedCell?: SavedCellSelector
  readonly dataMode: DataMode
}

export interface CoreSourceFragment {
  readonly precision: 'exact' | 'approximate'
  readonly originalRef: ResourceRef
  readonly parseRef: ResourceRef
  readonly locator: SourceLocator
  readonly text?: string
  readonly cells?: readonly CoreSourceCell[]
}

export interface CoreInstanceFieldSourceView {
  readonly projectId: string
  readonly recordId: string
  readonly recordRevision: string
  readonly fieldId: string
  readonly precision: 'exact' | 'approximate'
  readonly readability: 're_readable'
  readonly originalRef: ResourceRef
  readonly parseRef: ResourceRef
  readonly parseId: string
  readonly locator: SourceLocator
  readonly text?: string
  readonly cells?: readonly CoreSourceCell[]
}

export interface CoreSourceViewOptions extends SavedCellPorts, SavedInputSourcePorts {
  readonly answers: Pick<AnswerStorePort, 'findByAnswer'>
  readonly evidence: Pick<import('@ontology/contracts').EvidenceStorePort, 'get'>
  readonly runs: Pick<RunStore, 'getRun'>
  readonly manifests: Pick<WorkflowManifestStore, 'getRunManifest' | 'getInputManifest'>
  readonly executionBindings: Pick<RunExecutionBindingStore, 'getBindingByRun'>
  readonly blobs: DocumentArtifactStore & {
    getAuthorizedMetadata(request: BlobGetAuthorizedRequest, ctx: ToolContext): Promise<Omit<BlobGetAuthorizedResponse, 'integrityVerified'>>
  }
  readonly parses: DocumentParseStore
  readonly ingestion: Pick<StructuredIngestionStore, 'findParseByDigest' | 'listRecords'>
  readonly projects: Pick<ProjectStore, 'getProject' | 'getRevision'>
  readonly documents: Pick<ProjectDocumentStore, 'getMembership' | 'getVisibility'>
  readonly instances: Pick<InstanceReviewStore, 'getRecord' | 'listConfirmations'>
  readonly candidates: Pick<CandidateStore, 'getCandidate'>
  readonly records: Pick<ProjectRecordStore, 'getRecord'>
  readonly mappings: Pick<ProjectMappingStore, 'getMapping'>
  readonly provenance: Pick<ProvenanceReadService, 'getEvidence'>
  /** Host constructs the real GAP014 snapshot replay only after this saved binding is authorized. */
  readonly publishedRuleReplay?: (binding: ArchivedRunExecutionBinding, ctx: ToolContext) => RulePremiseReplayPort | Promise<RulePremiseReplayPort>
}

export class CoreSourceViewError extends Error {
  readonly code: 'SOURCE_NOT_FOUND' | 'SOURCE_UNVERIFIABLE' | 'VERSION_CONFLICT'
  readonly httpStatus: number
  constructor(code: CoreSourceViewError['code'], message: string) {
    super(message)
    this.name = 'CoreSourceViewError'
    this.code = code
    this.httpStatus = code === 'SOURCE_NOT_FOUND' ? 404 : 409
  }
}

const equal = (a: unknown, b: unknown): boolean => sha256OfCanonical(a) === sha256OfCanonical(b)
function projectBodyMatches(revision: NonNullable<Awaited<ReturnType<ProjectStore['getRevision']>>>): boolean {
  const { ref, ...body } = revision
  return sha256OfCanonical({ ...body, schemaVersion: 'project-revision@1', projectId: ref.projectId, revision: ref.revision }) === ref.digest
}
function requireSource(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CoreSourceViewError('SOURCE_UNVERIFIABLE', message)
}
function scopeOf(ctx: ToolContext): ScopeRef {
  if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) throw new ForbiddenError('a consistent trusted scope is required')
  return { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
}
function check(signal: AbortSignal, ctx: ToolContext): void {
  signal.throwIfAborted()
  requireSource(Date.now() < Date.parse(ctx.deadline), 'the source read deadline expired')
}
function isSourceLocator(value: unknown): value is SourceLocator {
  if (!isRecord(value)) return false
  const integer = (key: string, minimum: number, required = true): boolean => value[key] === undefined ? !required : typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= minimum
  const optionalString = (key: string): boolean => value[key] === undefined || typeof value[key] === 'string'
  if (!optionalString('normalizationMapRef')) return false
  if (value['kind'] === 'offset') return integer('startOffset', 0) && integer('endOffset', 0)
  if (value['kind'] === 'page' || value['kind'] === 'approximate_locator') return integer('page', 1, value['kind'] === 'page') && integer('startOffset', 0, false) && integer('endOffset', 0, false)
  if (value['kind'] === 'json_pointer') return typeof value['pointer'] === 'string' && integer('startByte', 0) && integer('endByte', 0)
  if (value['kind'] !== 'table_cell' && value['kind'] !== 'table_row') return false
  return (value['format'] === 'csv' || value['format'] === 'xlsx') && integer('recordIndex', 1) && integer('row', 1) && optionalString('sheetId') && optionalString('sheetName')
    && (value['kind'] === 'table_cell' ? integer('column', 1) && optionalString('address') : integer('columnFrom', 1) && integer('columnTo', 1))
    && integer('startByte', 0, false) && integer('endByte', 0, false)
}
function textLocator(value: unknown): Extract<SourceLocator, { readonly kind: 'page' | 'offset' | 'approximate_locator' }> {
  requireSource(isSourceLocator(value) && (value.kind === 'page' || value.kind === 'offset' || value.kind === 'approximate_locator'), 'a real document-text locator is required')
  return value
}
function refs(value: unknown): ResourceRef[] {
  requireSource(Array.isArray(value) && value.length <= 256 && value.every(isResourceRef), 'the saved evidence reference set is malformed or oversized')
  return value
}
function bodyHash(answer: PublishedAnswer): string {
  const body = answer.v3Body ?? answer.body
  requireSource(body !== undefined && !(answer.v3Body !== undefined && answer.body !== undefined), 'the saved answer has no unique verified body')
  requireSource(body.schemaVersion !== 'answer-draft@1' || body.assertions.length === 0, 'a legacy draft cannot authorize unhashed assertions')
  if (body.schemaVersion === 'answer-draft@3') requireSource(equal(body.limitations, answer.limitations), 'the published limitations differ from the immutable verified body')
  return answerDraftContentHash(answer.runId, body.blocks, answer.evidenceManifestHash, body.claims, body.assertions,
    body.schemaVersion === 'answer-draft@3' ? body : body.schemaVersion === 'answer-draft@2' ? { schemaVersion: body.schemaVersion, limitations: answer.limitations } : undefined)
}

/** Exact saved-answer and current-field reads; no search, latest parser or client history switch. */
export function createCoreSourceViewReader(options: CoreSourceViewOptions) {
  const spans = new StructuredDocumentSpanReader(options)
  const textSpans = new DocumentSpanReader({ blobs: options.blobs, store: options.parses })
  const metadataOf = async (ref: ResourceRef, ctx: ToolContext, signal: AbortSignal, cap: number) => {
    check(signal, ctx)
    try {
      const meta = await options.blobs.getAuthorizedMetadata({ scopeRef: scopeOf(ctx), blobRef: ref }, ctx)
      check(signal, ctx)
      requireSource(equal(meta.blobRef, ref) && meta.contentDigest === ref.digest && Number.isSafeInteger(meta.byteSize) && meta.byteSize > 0 && meta.byteSize <= cap, 'the immutable source failed its full reference or pre-read byte bound')
      return meta
    } catch (error) {
      check(signal, ctx)
      if (error instanceof CoreSourceViewError) throw error
      throw new CoreSourceViewError('SOURCE_UNVERIFIABLE', 'the authorized source metadata is unavailable')
    }
  }
  const bytesOf = async (ref: ResourceRef, ctx: ToolContext, signal: AbortSignal, cap = 1_048_576): Promise<Uint8Array> => {
    check(signal, ctx)
    try {
      const request = { scopeRef: scopeOf(ctx), blobRef: ref }
      const meta = await metadataOf(ref, ctx, signal, cap)
      const bytes = await options.blobs.readAuthorized(request, ctx)
      check(signal, ctx)
      requireSource(bytes.byteLength === meta.byteSize && sha256DigestOfBytes(bytes) === ref.digest, 'the immutable source bytes differ from the saved reference')
      return bytes
    } catch (error) {
      check(signal, ctx)
      if (error instanceof CoreSourceViewError) throw error
      throw new CoreSourceViewError('SOURCE_UNVERIFIABLE', 'the authorized immutable source could not be read')
    }
  }
  const jsonOf = async (ref: ResourceRef, ctx: ToolContext, signal: AbortSignal, cap?: number): Promise<unknown> => {
    const bytes = await bytesOf(ref, ctx, signal, cap)
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
    catch { throw new CoreSourceViewError('SOURCE_UNVERIFIABLE', 'the immutable JSON source is malformed') }
  }
  const nativeFor = (ctx: ToolContext, signal: AbortSignal): RequestNativeSourceReader => {
    const native = createRequestNativeSourceReader({ scope: scopeOf(ctx), ctx, signal, ingestion: options.ingestion, readBytes: (ref, cap) => bytesOf(ref, ctx, signal, cap), check: () => check(signal, ctx) })
    return { read: async (...args) => {
      try { return await native.read(...args) }
      catch (error) {
        check(signal, ctx)
        if (error instanceof CoreSourceViewError) throw error
        throw new CoreSourceViewError('SOURCE_UNVERIFIABLE', error instanceof Error ? error.message : 'the actual original native source could not be replayed')
      }
    } }
  }
  const originCells = async (origin: StructuredProjectionOrigin, ctx: ToolContext, signal: AbortSignal, native: RequestNativeSourceReader) => {
    const parse = await options.parses.getParse(scopeOf(ctx), origin.parseId, ctx)
    requireSource(parse !== undefined && equal(parse.originalRef, origin.originalRef), 'the actual projection parse is unavailable')
    const map = await jsonOf(parse.spanMapRef, ctx, signal, 4 * 1_048_576)
    requireSource(isRecord(map) && map['structuredParseId'] === origin.parseId && typeof map['parserVersion'] === 'string' && isStructuredParseSelection(map['selection']), 'the immutable projection has no replayable actual selection')
    const row = await native.read(origin.originalRef, map['parserVersion'], origin.parseId, origin.recordId, origin.rowDigest, map['selection'], parse.spanMapRef)
    requireSource(equal(row.entry.locator, origin.rowLocator) && row.entry.sourceRowKey === origin.sourceRowKey && equal(row.cells.map((cell) => ({ locator: cell.locator, rawDigest: sha256DigestOfText(cell.raw), kind: cell.kind })), origin.cells), 'the archived projection cells differ from the genuine original row')
    return row.cells.map((cell, index): CoreSourceCell => ({ raw: cell.raw, locator: cell.locator,
      ...(row.columns[index] === undefined ? {} : { columnLabel: row.columns[index].header }), rowLabel: String(row.entry.row) }))
  }
  const loadEvidence = async (ref: ResourceRef, ctx: ToolContext, signal: AbortSignal) => {
    check(signal, ctx)
    const record = await options.evidence.get(scopeOf(ctx), ref.id, ctx)
    requireSource(record !== undefined && ref.kind === 'evidence' && equal(record.evidenceRef, ref) && equal(record.envelope.scopeRef, scopeOf(ctx)) && record.envelope.evidenceId === ref.id, 'the exact scoped evidence reference is unavailable')
    const { integrity, ...body } = record.envelope
    requireSource(integrity.algorithm === 'sha256' && sha256OfCanonical(body) === integrity.digest && integrity.digest === ref.digest && record.envelopeDigest === ref.digest, 'the saved evidence envelope failed its complete content hash')
    requireSource(record.envelope.payloadRef !== undefined, 'the evidence has no immutable source body')
    const payload = await jsonOf(record.envelope.payloadRef, ctx, signal)
    requireSource(isRecord(payload), 'the archived evidence body is not an object')
    const isBinding = payload['schemaVersion'] === 'rule-source-span-binding@1' || payload['schemaVersion'] === 'rule-policy-span-binding@1'
    if (isBinding) {
      requireSource(isResourceRef(payload['textArtifactRef']), 'the source binding has no original text artifact')
      requireSource(sha256DigestOfBytes(await bytesOf(payload['textArtifactRef'], ctx, signal)) === record.envelope.resultDigest, 'the original text artifact does not match the evidence result digest')
    } else requireSource(record.envelope.resultDigest === record.envelope.payloadRef.digest, 'the evidence result digest differs from its actual archived result')
    return { record, payload }
  }
  const answerSource = async (answerId: string, evidenceId: string, requestCtx: ToolContext, signal: AbortSignal, selector?: SavedCellSelector): Promise<CoreAnswerSourceView> => {
    const scope = scopeOf(requestCtx)
    check(signal, requestCtx)
    const answer = await options.answers.findByAnswer(answerId, requestCtx)
    if (answer === undefined) throw new CoreSourceViewError('SOURCE_NOT_FOUND', 'the saved answer is unavailable in this scope')
    requireSource(bodyHash(answer) === answer.contentHash, 'the saved answer body differs from its published content hash')
    const run = await options.runs.getRun(scope, answer.runId, requestCtx)
    if (run !== undefined && run.ownerSubjectId !== requestCtx.principal.subjectId && !requestCtx.principal.roles.some((role) => ['platform-admin', 'operator', 'scoped-reader'].includes(role))) throw new ForbiddenError('only the run owner or a scoped reader may read this saved answer source')
    const manifest = await options.manifests.getRunManifest(answer.runId, requestCtx)
    const archived = await options.executionBindings.getBindingByRun(scope, answer.runId, requestCtx)
    requireSource(run !== undefined && run.runId === answer.runId && manifest !== undefined && manifest.runId === answer.runId && archived !== undefined && run.executionBindingRef !== undefined && equal(run.executionBindingRef, archived.ref) && sha256OfCanonical(archived.binding) === archived.ref.digest && archived.binding.runId === answer.runId && equal(archived.binding.runtimeRef, run.runtimeRef) && archived.binding.request.inputSnapshotRef.digest === archived.binding.request.inputSnapshotDigest, 'the saved run has no exact immutable execution binding')
    const fixedRevision = await options.projects.getRevision(scope, archived.binding.request.projectRevisionRef.projectId, archived.binding.request.projectRevisionRef.revision, requestCtx)
    requireSource(fixedRevision !== undefined && projectBodyMatches(fixedRevision) && equal(fixedRevision.ref, archived.binding.request.projectRevisionRef), 'the saved answer execution points to an unavailable or changed immutable project revision')
    const input = await options.manifests.getInputManifest(manifest.inputManifestId, requestCtx)
    requireSource(input !== undefined && input.manifestId === manifest.inputManifestId && input.runId === answer.runId && input.entries.length <= 1_000 && input.digest === answer.evidenceManifestHash && inputManifestDigest(input.runId, input.entries) === input.digest && scenarioManifestHash(manifest, input) === answer.scenarioManifestHash && run.resolvedProfileHash === manifest.resolvedProfileRef.snapshotHash && equal(manifest.resolvedProfileRef, archived.binding.resolvedProfileRef) && equal(run.runtimeRef, manifest.runtimeRef), 'the saved answer is detached from its actual run/evidence manifest')
    if (answer.v3Body !== undefined) requireSource(equal(answer.v3Body.executionBindingRef, archived.ref), 'the typed answer pins a different execution binding')
    const ctx = createToolContext({ ...requestCtx, runId: answer.runId, resolvedProfileHash: run.resolvedProfileHash })
    const native = nativeFor(ctx, signal)
    const evidenceReads = new Map<string, Awaited<ReturnType<typeof loadEvidence>>>()
    const readEvidence = async (ref: ResourceRef) => {
      const prior = evidenceReads.get(ref.id)
      if (prior !== undefined) { requireSource(equal(prior.record.evidenceRef, ref), 'the saved support closure has ambiguous evidence refs'); return prior }
      requireSource(evidenceReads.size < 256, 'the saved support evidence exceeds its finite read bound')
      const loaded = await loadEvidence(ref, ctx, signal)
      evidenceReads.set(ref.id, loaded)
      return loaded
    }
    const body = answer.v3Body ?? answer.body
    requireSource(body !== undefined && body.claims.length + body.assertions.length <= 256, 'the saved answer exceeds its supported binding bound')
    const roots = new Map<string, ResourceRef>()
    let selectedCell: SavedCellRead | undefined
    if (selector !== undefined) {
      const entries = input.entries.filter((entry) => entry.kind === 'evidence' && entry.ref?.id === evidenceId)
      requireSource(entries.length === 1 && entries[0]?.ref !== undefined, 'the requested cell evidence is not uniquely in the saved answer manifest')
      selectedCell = await readSavedCell({ ports: options, answer, archived, scope, ctx, selector, evidenceRef: entries[0].ref, readJson: (ref, cap) => jsonOf(ref, ctx, signal, cap), check: () => check(signal, ctx) })
      const loaded = await readEvidence(selectedCell.binding.evidenceRef)
      requireSource(loaded.record.envelope.resultDigest === selectedCell.binding.resultDigest && (loaded.record.envelope.producedBy.runId === answer.runId || loaded.record.envelope.producedBy.runId === undefined && loaded.record.envelope.kind === 'rule_derivation'), 'the actual saved cell evidence belongs to another run or result')
      roots.set(selectedCell.binding.evidenceRef.id, selectedCell.binding.evidenceRef)
    }
    for (const statement of [...body.claims, ...body.assertions]) {
      requireSource(isRecord(statement) && Array.isArray(statement['references']) && statement['references'].length <= 256, 'a saved statement has no bounded result bindings')
      for (const binding of statement['references']) {
        requireSource(isRecord(binding) && isResourceRef(binding['evidenceRef']) && isSha256Digest(binding['resultDigest']), 'a saved statement result binding is malformed')
        const ref = binding['evidenceRef']
        requireSource(roots.has(ref.id) || roots.size < 64, 'the saved answer exceeds its cited root evidence bound')
        requireSource(input.entries.some((entry) => entry.kind === 'evidence' && equal(entry.ref, ref)), 'a cited root evidence is absent from the saved answer manifest')
        const loaded = await readEvidence(ref)
        const producerRun = loaded.record.envelope.producedBy.runId
        requireSource((producerRun === answer.runId || producerRun === undefined && loaded.record.envelope.kind === 'rule_derivation') && loaded.record.envelope.resultDigest === binding['resultDigest'], 'the cited root belongs to another run or result')
        roots.set(ref.id, ref)
      }
    }
    requireSource(roots.size > 0 && roots.size <= 64, 'the answer has no bounded cited evidence')
    const authorized = new Map(roots)
    const visited = new Set<string>()
    const pending = [...roots.values()].map((ref) => ({ ref, depth: 0 }))
    while (pending.length > 0) {
      const item = pending.shift()
      requireSource(item !== undefined && authorized.size <= 256, 'the verified support closure exceeds its finite bound')
      if (visited.has(item.ref.id)) continue
      visited.add(item.ref.id)
      const loaded = await readEvidence(item.ref)
      if (loaded.record.envelope.kind !== 'rule_derivation') continue
      requireSource(item.depth < 4 && options.publishedRuleReplay !== undefined, 'the actual archived rule replay is not available within its support bound')
      const replay = await options.publishedRuleReplay(archived, ctx)
      let verified = false
      try { verified = await replay.verify({ artifact: loaded.payload['artifact'] ?? loaded.payload, payload: loaded.payload }, ctx) }
      catch { check(signal, ctx) }
      requireSource(verified, 'the actual archived rule premises failed independent source replay')
      for (const ref of refs(loaded.payload['premiseRefs'])) {
        requireSource(ref.kind === 'evidence' && (!authorized.has(ref.id) || equal(authorized.get(ref.id), ref)), 'the verified support closure has an ambiguous evidence identity')
        authorized.set(ref.id, ref)
        pending.push({ ref, depth: item.depth + 1 })
      }
    }
    const ref = authorized.get(evidenceId)
    if (ref === undefined) throw new CoreSourceViewError('SOURCE_NOT_FOUND', 'this evidence is not cited by or verified reachable from the saved answer')
    const { record, payload } = await readEvidence(ref)
    const base = { answerId, evidenceId, answerRef: { id: answerId, version: '1.0.0', digest: answer.contentHash }, evidenceRef: ref, dataMode: record.envelope.dataMode }
    let view: CoreAnswerSourceView
    const membershipReads: { readonly projectId: string; readonly documentId: string; readonly membership: Awaited<ReturnType<ProjectDocumentStore['getMembership']>> }[] = []
    if (record.envelope.kind === 'rule_derivation') {
      const support = await options.provenance.getEvidence(evidenceId, {}, ctx)
      requireSource(support.integrityVerified && support.outcome === 'verifiable' && equal(support.scopeRef, scope) && support.resultDigest === record.envelope.resultDigest, 'the actual rule support view failed verification')
      view = { ...base, family: 'rule_support', precision: 'exact', readability: support.sources.some((source) => source.reReadability === 'unverifiable') ? 'unverifiable' : 'archived_snapshot_only', title: '已保存的规则依据', support }
    } else if (record.envelope.kind === 'document_span' && Array.isArray(payload['spans'])) {
      const snapshotRef = archived.binding.projectDocumentIndexSnapshotRef
      requireSource(snapshotRef !== undefined && payload['spans'].length > 0 && payload['spans'].length <= 10, 'document QA has no actual fixed document index snapshot')
      const snapshot = await jsonOf(snapshotRef, ctx, signal, 16_384)
      requireSource(isRecord(snapshot) && snapshot['schemaVersion'] === 'project-document-index-snapshot@1' && equal(snapshot['projectRevisionRef'], archived.binding.request.projectRevisionRef) && isResourceRef(snapshot['documentSetRef']) && isVersionRef(snapshot['indexRef']) && isRevisionString(snapshot['generation']) && isRevisionString(snapshot['visibilityEpoch']) && isRevisionString(snapshot['membershipRevision']), 'the saved document index snapshot is malformed')
      const producer = record.envelope.producedBy.componentRef
      requireSource(producer.id === 'tool-gateway' && producer.version === '1.0.0' && producer.digest === sha256DigestOfText('tool-gateway@1.0.0') && record.envelope.sourceSnapshots.some((source) => source.sourceRef.namespace === 'ontology.keyword_index') && isRecord(payload['indexVersion']) && equal(payload['indexVersion']['indexRef'], snapshot['indexRef']) && payload['indexVersion']['generation'] === snapshot['generation'], 'the archived QA producer/index identity differs from its fixed run')
      const revision = await options.projects.getRevision(scope, archived.binding.request.projectRevisionRef.projectId, archived.binding.request.projectRevisionRef.revision, ctx)
      requireSource(revision !== undefined && equal(revision.ref, archived.binding.request.projectRevisionRef) && equal(revision.documentSetRef, snapshot['documentSetRef']), 'the document snapshot differs from the actual saved project revision')
      const set = await jsonOf(snapshot['documentSetRef'], ctx, signal)
      requireSource(isRecord(set) && set['schemaVersion'] === 'project-document-set@1' && set['projectId'] === revision.ref.projectId && Array.isArray(set['members']) && set['members'].length <= 1_000, 'the saved document corpus is unavailable')
      const fragments: CoreSourceFragment[] = []
      let historical = false
      for (const span of payload['spans']) {
        requireSource(isRecord(span) && isResourceRef(span['documentRef']) && typeof span['quote'] === 'string' && isSha256Digest(span['quoteDigest']) && isSha256Digest(span['textDigest']), 'the saved QA span is malformed')
        const locator = textLocator(span['locator'])
        const members = set['members'].filter((member: unknown) => isRecord(member) && equal(member['documentRef'], span['documentRef']))
        requireSource(members.length === 1, 'the saved QA source is not uniquely in the fixed document corpus')
        const member = members[0]
        requireSource(isRecord(member) && isUuid(member['parseId']) && isUuid(member['documentId']) && isResourceRef(member['parseRef']) && isRevisionString(member['membershipRevision']), 'the fixed document member has invalid original/parse pins')
        const parse = await options.parses.getParse(scope, member['parseId'], ctx)
        requireSource(parse !== undefined && equal(parse.originalRef, span['documentRef']) && equal(parse.spanMapRef, member['parseRef']), 'the QA span differs from the actual immutable saved parse')
        await metadataOf(parse.originalRef, ctx, signal, 8 * 1_048_576)
        await metadataOf(parse.normalizedRef, ctx, signal, 8 * 1_048_576)
        await metadataOf(parse.spanMapRef, ctx, signal, 4 * 1_048_576)
        const read = await spans.readParsedSpan(parse, { documentRef: span['documentRef'], locator, maxBytes: 16_384 }, ctx)
        requireSource(read.truncated !== true && read.text === span['quote'] && read.textDigest === span['textDigest'] && read.textDigest === span['quoteDigest'], 'the QA text does not replay the original saved span')
        const origin = await spans.readOrigin({ documentRef: span['documentRef'], locator }, ctx)
        requireSource(equal(origin ?? null, span['sourceOrigin'] ?? null), 'the actual original cell origins differ from the archived QA result')
        const fragmentBase = { originalRef: parse.originalRef, parseRef: parse.spanMapRef, locator: origin?.rowLocator ?? locator }
        if (origin !== undefined) fragments.push({ ...fragmentBase, precision: 'approximate', cells: await originCells(origin, ctx, signal, native) })
        else { requireSource(span['spanKind'] === 'verbatim' && locator.kind !== 'approximate_locator', 'an approximate document has no original structured cells'); fragments.push({ ...fragmentBase, precision: 'exact', text: read.text }) }
        const current = await options.documents.getMembership(scope, revision.ref.projectId, member['documentId'], ctx)
        membershipReads.push({ projectId: revision.ref.projectId, documentId: member['documentId'], membership: current })
        historical ||= current?.state !== 'active' || current.membershipRevision !== member['membershipRevision'] || !equal(current.documentRef, span['documentRef'])
      }
      const first = fragments[0]
      requireSource(first !== undefined, 'the saved QA result has no original fragment')
      const approximate = first.precision === 'approximate'
      view = { ...base, family: approximate ? 'structured_qa' : 'document_span', readability: historical ? 'archived_snapshot_only' : 're_readable', title: approximate ? '原始表格单元格（近似问答）' : '原始文档片段', ...first, fragments }
    } else if (record.envelope.kind === 'document_span') {
      requireSource(payload['schemaVersion'] === 'rule-source-span-binding@1' || payload['schemaVersion'] === 'rule-policy-span-binding@1', 'the document evidence has no supported real source binding')
      requireSource(isResourceRef(payload['documentRef']) && isResourceRef(payload['textArtifactRef']), 'the policy/fact source binding has no original/text pins')
      const span = payload['sourceSpan'] ?? payload['span']
      requireSource(isRecord(span) && isUuid(span['parseId']), 'the policy/fact source has no exact parse identity')
      const parse = await options.parses.getParse(scope, span['parseId'], ctx)
      if (span['kind'] === 'structured') {
        requireSource(isUuid(payload['sourceStatementId']) && isUuid(span['recordId']) && isSha256Digest(span['rowDigest']) && isSourceLocator(span['locator']), 'the mapped rule premise has invalid actual row pins')
        const candidate = await options.candidates.getCandidate(scope, payload['sourceStatementId'], ctx)
        const pin = candidate?.inputVersion.projectFact?.sources.find((source) => source.parseId === span['parseId'])
        requireSource(candidate !== undefined && pin !== undefined, 'the mapped premise has no actual saved candidate/source pin')
        const mapping = await options.mappings.getMapping(scope, pin.projectRevisionRef.projectId, pin.mappingRef.id, pin.mappingRef.version, ctx)
        requireSource(mapping !== undefined && equal(mapping.ref, pin.mappingRef) && equal(mapping.originalRef, payload['documentRef']), 'the mapped rule premise has no actual confirmed mapping')
        const row = await native.read(mapping.originalRef, candidate.inputVersion.parserVersion, mapping.parseId, span['recordId'], span['rowDigest'], mapping.options, mapping.ref)
        const cell = row.cells.find((cell) => equal(cell.locator, span['locator']))
        requireSource(cell !== undefined, 'the mapped premise does not locate an original cell')
        requireSource(parse === undefined || equal(parse.originalRef, mapping.originalRef), 'the mapped premise projection belongs to another original')
        view = { ...base, family: 'document_span', precision: 'exact', readability: 'archived_snapshot_only', title: '规则依据的原始单元格', originalRef: mapping.originalRef, ...(parse === undefined ? {} : { parseRef: parse.spanMapRef }), locator: cell.locator, cells: [{ raw: cell.raw, locator: cell.locator }] }
      } else {
        requireSource(parse !== undefined && equal(parse.originalRef, payload['documentRef']) && parse.parserVersion === payload['parserVersion'], 'the original policy parse differs from its saved binding')
        const locator = textLocator(span['locator'])
        await bytesOf(parse.originalRef, ctx, signal, 8 * 1_048_576)
        await metadataOf(parse.normalizedRef, ctx, signal, 8 * 1_048_576)
        const read = await textSpans.readParsedSpan(parse, { documentRef: parse.originalRef, locator, maxBytes: 128 * 1024 }, ctx)
        const savedText = new TextDecoder('utf-8', { fatal: true }).decode(await bytesOf(payload['textArtifactRef'], ctx, signal))
        requireSource(read.truncated !== true && read.text === savedText && read.textDigest === record.envelope.resultDigest, 'the original policy/fact text differs from the archived binding')
        view = { ...base, family: 'document_span', precision: span['precision'] === 'approximate' ? 'approximate' : 'exact', readability: 'archived_snapshot_only', title: '规则依据的原始文档', originalRef: parse.originalRef, parseRef: parse.spanMapRef, locator, text: read.text }
      }
    } else {
      requireSource(record.envelope.kind === 'observation' || record.envelope.kind === 'computation', 'this evidence family has no supported business source projection')
      const originalInputs = await readSavedInputSources({ ports: options, candidates: options.candidates, mappings: options.mappings, parses: options.parses, confirmations: options.instances,
        scope, ctx, archived, revision: fixedRevision, payload, ...(selectedCell === undefined ? {} : { cell: selectedCell }), native,
        readJson: (ref, cap) => jsonOf(ref, ctx, signal, cap), readBytes: (ref, cap) => bytesOf(ref, ctx, signal, cap), check: () => check(signal, ctx) })
      view = { ...base, family: 'data_query', precision: 'exact', readability: 'archived_snapshot_only',
        title: record.envelope.kind === 'computation' ? '本次保存的计算结果' : '本次保存的查询结果',
        text: originalInputs.sourceCoverage.knownTotal === 0 ? '本次查询没有返回记录。' : (originalInputs.fragments?.length ?? 0) > 0 ? '这里展示本次已保存结果固定的原始输入来源，保留导入时的原始值和位置。' : '本次保存的查询或计算结果可核对；这份记录尚无可回读的原始表格单元格链。',
        sourceReadLimitation: '暂不支持回读原始表格单元格；此处展示本次答案实际保存的结果与固定输入版本。',
        ...(new TextEncoder().encode(JSON.stringify(payload)).byteLength <= 65_536 ? { archivedPayload: payload } : {}), fixedInputRef: archived.binding.request.inputSnapshotRef,
        ...(archived.binding.projectDatasetSnapshotRef === undefined ? {} : { fixedDatasetSnapshotRef: archived.binding.projectDatasetSnapshotRef }), ...originalInputs,
        ...(selectedCell === undefined ? {} : { selectedCell: selectedCell.selector }) }
    }
    check(signal, ctx)
    requireSource(equal(await options.answers.findByAnswer(answerId, ctx), answer) && equal(await options.executionBindings.getBindingByRun(scope, answer.runId, ctx), archived) && equal(await options.evidence.get(scope, evidenceId, ctx), record), 'the saved answer/evidence binding changed during the source read')
    requireSource(equal(await options.manifests.getInputManifest(manifest.inputManifestId, ctx), input), 'the saved evidence manifest changed during the source read')
    requireSource(equal(await options.projects.getRevision(scope, fixedRevision.ref.projectId, fixedRevision.ref.revision, ctx), fixedRevision), 'the fixed project revision changed during the source read')
    if (selectedCell !== undefined) requireSource(equal(await readSavedCell({ ports: options, answer, archived, scope, ctx, selector: selectedCell.selector, evidenceRef: ref, readJson: (ref, cap) => jsonOf(ref, ctx, signal, cap), check: () => check(signal, ctx) }), selectedCell), 'the saved table/cell/receipt changed during original source reads')
    for (const loaded of evidenceReads.values()) {
      check(signal, ctx)
      requireSource(equal(await options.evidence.get(scope, loaded.record.evidenceRef.id, ctx), loaded.record), 'a verified reachable support envelope changed during the source read')
    }
    for (const member of membershipReads) {
      const current = await options.documents.getMembership(scope, member.projectId, member.documentId, ctx)
      if (!equal(current, member.membership)) view = { ...view, readability: 'archived_snapshot_only' }
    }
    requireSource(new TextEncoder().encode(JSON.stringify(view)).byteLength <= 1_048_576, 'the source view exceeds its one-MiB response bound')
    check(signal, ctx)
    return view
  }

  const instanceFieldSource = async (projectId: string, recordId: string, fieldId: string, recordRevision: string, ctx: ToolContext, signal: AbortSignal): Promise<CoreInstanceFieldSourceView> => {
    const scope = scopeOf(ctx)
    if (!ctx.principal.roles.some((role) => ['platform-admin', 'operator', 'data-editor', 'semantic-reviewer', 'scoped-reader'].includes(role))) throw new ForbiddenError('instance source reading requires a reader or reviewer role')
    check(signal, ctx)
    const snapshot = async () => {
      const record = await options.instances.getRecord(scope, projectId, recordId, ctx)
      const binding = record?.identity.binding
      const project = await options.projects.getProject(scope, projectId, ctx)
      const revision = project === undefined ? undefined : await options.projects.getRevision(scope, projectId, project.headRevision, ctx)
      const candidate = binding === undefined ? undefined : await options.candidates.getCandidate(scope, binding.candidateId, ctx)
      const member = binding === undefined ? undefined : await options.documents.getMembership(scope, projectId, binding.documentId, ctx)
      const visibility = await options.documents.getVisibility(scope, projectId, ctx)
      requireSource(record !== undefined && binding !== undefined && candidate?.kind === 'entity' && project !== undefined && project.state !== 'archived' && revision !== undefined && member?.state === 'active' && visibility !== undefined, 'the current instance has no active actual candidate/project/source binding')
      if (record.recordRevision !== recordRevision) throw new CoreSourceViewError('VERSION_CONFLICT', 'the selected instance record revision is no longer current')
      requireSource(projectBodyMatches(revision) && equal(binding.projectRevisionRef, revision.ref) && equal(binding.definitionRef, revision.definitionRef) && equal(candidate.inputVersion.definitionRef, revision.definitionRef) && candidate.inputVersion.parseId === member.parseId && binding.membershipRevision === member.membershipRevision && binding.visibilityEpoch === visibility.epoch && equal(record.sourceRef, member.documentRef), 'the current instance source pins differ from its project, candidate or membership')
      const index = candidate.attributes.findIndex((attr) => attr.attributeId === fieldId)
      const span = candidate.inputVersion.projectFact === undefined ? candidate.sourceSpans[0] : candidate.sourceSpans[index]
      const field = record.fields.find((entry) => entry.fieldId === fieldId)
      if (field === undefined) throw new CoreSourceViewError('SOURCE_NOT_FOUND', 'this current record has no such field')
      requireSource(index >= 0 && span !== undefined && span.parseId === member.parseId && field.source.parseId === span.parseId && equal(field.source.documentRef, member.documentRef) && equal(field.source.locator, span.locator), 'the current field does not retain its actual candidate source locator')
      return { record, binding, candidate, member, visibility, revision, project, span, field }
    }
    const before = await snapshot()
    const native = nativeFor(ctx, signal)
    const { candidate, member, span, field } = before
    const parse = await options.parses.getParse(scope, span.parseId, ctx)
    requireSource(parse !== undefined && equal(parse.originalRef, member.documentRef) && equal(parse.spanMapRef, member.parseRef), 'the field source does not have the actual project document parse')
    const base = { projectId, recordId, recordRevision, fieldId, originalRef: member.documentRef, parseRef: parse.spanMapRef, parseId: span.parseId, readability: 're_readable' as const }
    let result: CoreInstanceFieldSourceView
    if (span.kind === 'structured') {
      requireSource(field.source.chunkId === span.recordId && field.source.quoteDigest === span.rowDigest && field.source.textDigest === span.rowDigest, 'the instance field row fingerprint differs from its actual candidate')
      const pins = candidate.inputVersion.projectFact?.sources
      requireSource(pins !== undefined && pins.length === 1, 'the mapped field requires one actual saved project source pin')
      const pin = pins[0]
      requireSource(pin !== undefined && pin.entityCandidateId === candidate.candidateId && pin.documentId === member.documentId && pin.parseId === span.parseId && equal(pin.projectRevisionRef, before.revision.ref) && equal(pin.definitionRef, before.revision.definitionRef) && pin.membershipRevision === member.membershipRevision && pin.visibilityEpoch === before.visibility.epoch, 'the mapped field candidate belongs to different source/project pins')
      const record = await options.records.getRecord(scope, projectId, pin.recordId, ctx)
      const mapping = await options.mappings.getMapping(scope, projectId, pin.mappingRef.id, pin.mappingRef.version, ctx)
      requireSource(record !== undefined && mapping !== undefined && record.revision === pin.recordRevision && record.contentDigest === pin.contentDigest && record.sourceDigest === pin.sourceDigest && record.sourceRowKey === span.sourceRowKey && record.recordId === span.recordId && equal(mapping.ref, pin.mappingRef) && equal(mapping.originalRef, member.documentRef) && mapping.parseId === span.parseId && before.revision.mappingRefs.some((ref) => equal(ref, mapping.ref)) && equal(mapping.definitionRef, before.revision.definitionRef), 'the mapped field differs from the actual current saved record/mapping')
      const mappingDigest = sha256OfCanonical({ definitionRef: mapping.definitionRef, format: mapping.format, parseId: mapping.parseId, originalMediaType: mapping.originalMediaType, options: mapping.options, objectId: mapping.objectId, sheetId: mapping.sheetId ?? null, sheetName: mapping.sheetName ?? null, entries: [...mapping.entries].sort((a, b) => a.columnIndex - b.columnIndex) })
      requireSource(mapping.digest === mappingDigest && mapping.ref.digest === mappingDigest && mapping.objectId === candidate.objectId, 'the saved mapping failed its actual complete content hash')
      const entry = mapping.entries.filter((entry) => entry.fieldRef === fieldId)
      requireSource(entry.length === 1 && entry[0] !== undefined && equal(record.fields.find((value) => value.fieldId === fieldId)?.locator, span.locator), 'the actual mapping does not uniquely bind this field locator')
      const row = await native.read(mapping.originalRef, candidate.inputVersion.parserVersion, mapping.parseId, span.recordId, span.rowDigest, mapping.options, mapping.ref)
      const cell = row.cells[entry[0].columnIndex]
      const column = row.columns[entry[0].columnIndex]
      requireSource(cell !== undefined && column !== undefined && column.header === entry[0].header && column.headerDigest === entry[0].headerDigest && equal(cell.locator, span.locator), 'the field locator does not name the actual confirmed original column/cell')
      result = { ...base, precision: 'exact', locator: cell.locator, cells: [{ raw: cell.raw, locator: cell.locator, columnLabel: column.header, rowLabel: String(row.entry.row) }] }
      requireSource(equal(await options.records.getRecord(scope, projectId, pin.recordId, ctx), record) && equal(await options.mappings.getMapping(scope, projectId, pin.mappingRef.id, pin.mappingRef.version, ctx), mapping), 'the actual mapped record changed during source read')
    } else {
      requireSource(field.source.chunkId === span.chunkId && field.source.textDigest === span.textDigest && field.source.quoteDigest === span.quoteDigest && parse.parserVersion === candidate.inputVersion.parserVersion, 'the field differs from its actual parsed text source')
      // Character/page readers otherwise touch only normalized text. Re-readable
      // means the actual original still passes its complete byte integrity proof.
      await bytesOf(member.documentRef, ctx, signal, 8 * 1_048_576)
      await metadataOf(parse.normalizedRef, ctx, signal, 8 * 1_048_576)
      const read = await textSpans.readParsedSpan(parse, { documentRef: member.documentRef, locator: span.locator, maxBytes: 128 * 1024 }, ctx)
      requireSource(read.truncated !== true && read.textDigest === span.textDigest && read.textDigest === span.quoteDigest, 'the original field text failed exact source replay')
      result = { ...base, precision: span.precision, locator: textLocator(span.locator), text: read.text }
    }
    check(signal, ctx)
    requireSource(equal(await snapshot(), before), 'the current instance source changed during the original read')
    requireSource(new TextEncoder().encode(JSON.stringify(result)).byteLength <= 1_048_576, 'the current field source exceeds its one-MiB response bound')
    check(signal, ctx)
    return result
  }
  return { answerSource, instanceFieldSource }
}
