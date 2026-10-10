import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { LocalImmutableBlobStore } from '@ontology/adapter-blob-local'
import type { ArtifactRegistry, ImmutableObjectStore } from '@ontology/adapter-blob-local'
import { ArtifactGroundingDocumentSetReader, GROUNDING_DOCUMENT_SET_MEDIA_TYPE, LocalDocumentExtractionService, LocalStructuredIngestionService, ParsedSourceGroundingReader, deterministicUuid } from '@ontology/adapter-extraction-document'
import type { PostgresDocumentParseStore, PostgresStructuredIngestionStore } from '@ontology/adapter-extraction-document'
import type { GroundingDocumentSet, GroundingSourceApproval, IndustryWorkspaceStore, JobStore, OperationRegistry, ResourceRef, ToolContext } from '@ontology/contracts'
import { assertIndustryWorkspaceBoundaryShape, isRecord, isStructuredParseSelection, isUuid } from '@ontology/contracts'
import { IndustryWorkspaceService, SourceGroundingBudget, canonicalJson } from '@ontology/application'
import type { DefinitionTerminologySource } from '@ontology/application'
import { createRequestToolContext } from '../http/context'
import { authenticateRequest, ForbiddenError, InvalidRequestFieldError, readHeader, readRevisionHeader, readTraceId } from '../http/shared'
import type { RequestAuthenticator } from '../http/shared'
import type { CoreDefinitionLabelReader } from './core-definition-labels'

export interface CoreAuthoringOptions {
  readonly blobs: LocalImmutableBlobStore
  readonly objectStore: ImmutableObjectStore
  readonly registry: ArtifactRegistry
  readonly workspaces: IndustryWorkspaceStore
  readonly jobs: JobStore
  readonly parses: PostgresDocumentParseStore
  readonly structured: PostgresStructuredIngestionStore
  readonly operations: OperationRegistry
  readonly models: { readonly generationEnabled: boolean; readonly decisionEnabled: boolean }
  readonly terminology: DefinitionTerminologySource
  readonly termLabels?: CoreDefinitionLabelReader
}

/** Stable references are host-minted only after exact scoped byte readback. */
export function createCoreAuthoring(options: CoreAuthoringOptions) {
  const corpus = new ArtifactGroundingDocumentSetReader(options.blobs)
  const reader = new ParsedSourceGroundingReader({ blobs: options.blobs, documents: options.parses, tables: options.structured })
  const workspaces = new IndustryWorkspaceService({ store: options.workspaces, jobs: options.jobs })
  const scope = (ctx: ToolContext) => ({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId })
  const stableWrite = async (identity: string, bytes: Uint8Array, mediaType: string, purpose: 'artifact' | 'document', ctx: ToolContext, origin?: Readonly<Record<string, unknown>>): Promise<ResourceRef> => {
    const id = deterministicUuid(`${ctx.principal.tenantId}|${ctx.allowedResources.spaceId}|${identity}`)
    const scoped = scope(ctx)
    const staged = await options.blobs.stage(bytes, { scopeRef: scoped }, ctx)
    const readExisting = async (): Promise<ResourceRef | undefined> => {
      const found = await options.registry.findReference(scoped, id)
      if (found === undefined) return undefined
      if (found.reference.purpose !== purpose || found.reference.contentDigest !== staged.contentDigest || found.blob.mediaType !== mediaType || found.blob.byteSize !== bytes.byteLength) throw new InvalidRequestFieldError('the idempotency key already names different source bytes')
      const ref: ResourceRef = { id, version: '1.0.0', digest: staged.contentDigest, kind: purpose }
      const actual = await options.blobs.readAuthorized({ scopeRef: scoped, blobRef: ref }, ctx)
      if (actual.byteLength !== bytes.byteLength || actual.some((value, index) => value !== bytes[index])) throw new InvalidRequestFieldError('the existing immutable source failed byte readback')
      return ref
    }
    const existing = await readExisting()
    if (existing !== undefined) return existing
    const writer = new LocalImmutableBlobStore({ objectStore: options.objectStore, registry: options.registry, idFactory: () => id })
    try { return (await writer.publish({ scopeRef: scoped, contentDigest: staged.contentDigest, byteSize: bytes.byteLength, mediaType, purpose, ...(origin === undefined ? {} : { origin }) }, ctx)).blobRef }
    catch (cause) { const concurrent = await readExisting(); if (concurrent !== undefined) return concurrent; throw cause }
  }
  const readWorkspace = async (id: string, ctx: ToolContext) => {
    if (!isUuid(id)) throw new InvalidRequestFieldError('workspaceId must be a UUID')
    const workspace = await workspaces.getWorkspace(id, ctx)
    const draft = await workspaces.getDraft(id, workspace.headRevision, ctx)
    return { workspace, draft }
  }
  const listSources = async (id: string, ctx: ToolContext) => {
    const state = await readWorkspace(id, ctx)
    const budget = new SourceGroundingBudget(new AbortController().signal, { pages: 64 })
    const set = await corpus.read(scope(ctx), state.draft.documentSetRef, ctx, budget)
    if (set.workspaceId !== id) throw new InvalidRequestFieldError('the stored source set belongs to another workspace')
    const sources = []
    for (const source of set.sources) {
      if (source.state !== 'approved') continue
      const document = source.kind === 'document' ? await options.parses.getParse(scope(ctx), source.parseId, ctx) : undefined
      const table = source.kind === 'table' ? await options.structured.getParse(scope(ctx), source.parseId, ctx) : undefined
      const parsed = document ?? table
      if (parsed === undefined || canonicalJson(parsed.originalRef) !== canonicalJson(source.sourceRef) || parsed.parserVersion !== source.parserVersion) throw new InvalidRequestFieldError('an approved source has no matching stored parse')
      const size = await options.blobs.getAuthorizedMetadata({ scopeRef: scope(ctx), blobRef: source.sourceRef }, ctx)
      if (size.contentDigest !== source.sourceRef.digest || size.byteSize <= 0 || size.byteSize > 8_388_608) throw new InvalidRequestFieldError('the actual original source exceeds its bounded immutable metadata pin')
      const page = await reader.readPage(scope(ctx), source, { limit: 8 }, ctx, budget)
      const original = await options.registry.findReference(scope(ctx), source.sourceRef.id)
      const metadata = await options.blobs.getAuthorized({ scopeRef: scope(ctx), blobRef: source.sourceRef }, ctx)
      if (!metadata.integrityVerified || metadata.contentDigest !== source.sourceRef.digest || metadata.byteSize <= 0 || metadata.byteSize > 8_388_608) throw new InvalidRequestFieldError('the actual original source metadata failed its bounded immutable pin')
      sources.push({ ...source, ...(typeof original?.reference.origin['name'] === 'string' ? { name: original.reference.origin['name'] } : {}), status: table?.status ?? document?.coverage.status, coverage: parsed.coverage,
        previewCoverage: page.nextCursor === undefined && page.reasons.length === 0 ? 'complete' : 'partial',
        byteSize: metadata.byteSize, wholeSourceLocation: { sourceRef: { id: source.sourceRef.id, version: source.sourceRef.version, digest: source.sourceRef.digest }, startOffset: 0, endOffset: metadata.byteSize, quoteDigest: source.sourceRef.digest },
        mediaType: parsed.originalMediaType, originalMediaType: parsed.originalMediaType,
        ...(table === undefined ? {} : { format: table.format, ...(table.parseOptions === undefined ? {} : { options: table.parseOptions }) }),
        tables: page.contents.filter((content) => content.kind === 'table').map((content, index) => ({ tableId: `${source.parseId}:${content.sheetId ?? index}`, name: content.sheetName,
          sheetName: content.sheetName, sheetId: content.sheetId, headerRow: content.headerRow,
          columns: content.columns.map((column) => ({ columnIndex: column.index, header: column.header, headerDigest: column.headerDigest })),
          rows: content.rows.map((row) => ({ sourceRowKey: row.sourceSpan.kind === 'structured' ? row.sourceSpan.sourceRowKey : '', cells: row.cells.map((cell, columnIndex) => ({ columnIndex, raw: cell.raw, locator: cell.locator })) })) })) })
    }
    const after = await readWorkspace(id, ctx)
    if (canonicalJson(after) !== canonicalJson(state)) throw new InvalidRequestFieldError('workspace sources changed while reading the catalogue')
    return { ...state, sources }
  }
  const policyBody = { schemaVersion: 'core-generation-policy@1', maxCandidates: 64, sourceTrust: 'untrusted_source_data', requiresHumanSourceConfirmation: true, requiresHumanReview: true }
  const policy = async (ctx: ToolContext) => stableWrite('core-generation-policy@1', new TextEncoder().encode(canonicalJson(policyBody)), 'application/json', 'artifact', ctx)
  return {
    stableWrite, listSources, readWorkspace, policy,
    findStableArtifact: async (identity: string, ctx: ToolContext): Promise<ResourceRef | undefined> => {
      const id = deterministicUuid(`${ctx.principal.tenantId}|${ctx.allowedResources.spaceId}|${identity}`)
      const found = await options.registry.findReference(scope(ctx), id)
      if (found === undefined) return undefined
      if (found.reference.purpose !== 'artifact') throw new InvalidRequestFieldError('the saved host artifact has another purpose')
      return { id, version: '1.0.0', digest: found.reference.contentDigest, kind: 'artifact' }
    },
    register(app: FastifyInstance, authenticate: RequestAuthenticator) {
      const prepare = (request: Parameters<RequestAuthenticator>[0], reply: Parameters<typeof authenticateRequest>[2], editor: boolean) => {
        const auth = authenticateRequest(authenticate, request, reply)
        if (auth === undefined) return undefined
        if (editor && !auth.principal.roles.some((role) => role === 'profile-editor' || role === 'platform-admin')) throw new ForbiddenError('authoring requires an editor role')
        const traceId = readTraceId(request)
        return { traceId, ctx: createRequestToolContext({ ...auth, traceId, runId: randomUUID() }) }
      }
      const keyOf = (request: Parameters<RequestAuthenticator>[0]) => {
        const key = readHeader(request, 'idempotency-key')
        if (key === undefined || key.length < 8 || key.length > 200) throw new InvalidRequestFieldError('a bounded Idempotency-Key is required')
        return key
      }
      app.post('/api/v1/core/workspace-bootstrap', async (request, reply) => {
        const trusted = prepare(request, reply, true); if (trusted === undefined) return reply
        const body = request.body
        if (!isRecord(body) || Object.keys(body).some((key) => !['namespace', 'displayName', 'boundary'].includes(key)) || typeof body['namespace'] !== 'string' || typeof body['displayName'] !== 'string') throw new InvalidRequestFieldError('namespace, displayName and boundary are required')
        assertIndustryWorkspaceBoundaryShape(body['boundary'])
        if (!isRecord(body['boundary']) || Object.keys(body['boundary']).some((field) => !['goals', 'included', 'excluded', 'applicability'].includes(field)) || !isRecord(body['boundary']['applicability']) || Object.keys(body['boundary']['applicability']).some((field) => !['region', 'validFrom', 'validTo'].includes(field))) throw new InvalidRequestFieldError('boundary accepts only the closed industry declaration fields')
        const key = keyOf(request), workspaceId = deterministicUuid(`${trusted.ctx.principal.tenantId}|${trusted.ctx.allowedResources.spaceId}|workspace:${key}`)
        const manifest: GroundingDocumentSet = { schemaVersion: '1.0.0', scopeRef: scope(trusted.ctx), workspaceId, sources: [] }
        const documentSetRef = await stableWrite(`workspace:${key}:empty`, new TextEncoder().encode(JSON.stringify(manifest)), GROUNDING_DOCUMENT_SET_MEDIA_TYPE, 'artifact', trusted.ctx)
        let first = true
        const service = new IndustryWorkspaceService({ store: options.workspaces, jobs: options.jobs, newId: () => { if (first) { first = false; return workspaceId } return randomUUID() } })
        const result = await service.createWorkspace({ namespace: body['namespace'], displayName: body['displayName'], boundary: body['boundary'], documentSetRef }, key, trusted.ctx.principal.subjectId, trusted.ctx)
        return reply.status(result.created ? 201 : 200).send({ data: { ...result, scopeRef: scope(trusted.ctx) }, meta: { traceId: trusted.traceId } })
      })
      app.get<{ Params: { workspaceId: string } }>('/api/v1/core/workspaces/:workspaceId/sources', async (request, reply) => {
        const trusted = prepare(request, reply, false); if (trusted === undefined) return reply
        return reply.send({ data: await listSources(request.params.workspaceId, trusted.ctx), meta: { traceId: trusted.traceId } })
      })
      app.post<{ Params: { workspaceId: string } }>('/api/v1/core/workspaces/:workspaceId/sources', { bodyLimit: 12_000_000 }, async (request, reply) => {
        const trusted = prepare(request, reply, true); if (trusted === undefined) return reply
        const body = request.body, header = readRevisionHeader(request), key = keyOf(request)
        if (header.kind !== 'revision' || !isRecord(body) || Object.keys(body).some((field) => !['name', 'mediaType', 'contentEncoding', 'content', 'options'].includes(field)) || typeof body['name'] !== 'string' || body['name'].length > 256 || typeof body['mediaType'] !== 'string' || body['contentEncoding'] !== 'base64' || typeof body['content'] !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(body['content'])) throw new InvalidRequestFieldError('source upload requires exact revision, name, media type and base64 bytes')
        const bytes = Buffer.from(body['content'], 'base64')
        if (bytes.length === 0 || bytes.length > 8_388_608) throw new InvalidRequestFieldError('source bytes must be between one byte and eight MiB')
        if (!['text/plain', 'text/markdown', 'application/pdf', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(body['mediaType'])) throw new InvalidRequestFieldError('本体建模来源支持文本、Markdown、PDF、CSV 和 XLSX；当前入口尚不支持 DOCX 或 JSON')
        if (body['options'] !== undefined && !isStructuredParseSelection(body['options'])) throw new InvalidRequestFieldError('source options must be a closed native parser selection')
        const state = await readWorkspace(request.params.workspaceId, trusted.ctx)
        const budget = new SourceGroundingBudget(new AbortController().signal)
        const capturedDraft = await workspaces.getDraft(request.params.workspaceId, header.value, trusted.ctx)
        const set = await corpus.read(scope(trusted.ctx), capturedDraft.documentSetRef, trusted.ctx, budget)
        if (set.workspaceId !== state.workspace.workspaceId || set.sources.length >= 64) throw new InvalidRequestFieldError('the stored workspace corpus is invalid or full')
        const sourceRef = await stableWrite(`workspace:${request.params.workspaceId}:source:${key}`, bytes, body['mediaType'], 'document', trusted.ctx, { name: body['name'], workspaceId: request.params.workspaceId })
        let source: GroundingSourceApproval
        if (['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(body['mediaType'])) {
          const parsed = await new LocalStructuredIngestionService({ blobs: options.blobs, store: options.structured }).parse({ scopeRef: scope(trusted.ctx), originalRef: sourceRef, options: body['options'] ?? {} }, trusted.ctx)
          if (body['options'] !== undefined && canonicalJson(parsed.parse.parseOptions) !== canonicalJson(body['options'])) throw new InvalidRequestFieldError('these original bytes already have another native selection; use the actual stored sheet/header selection shown in the source catalogue')
          if (parsed.parse.status !== 'complete') throw new InvalidRequestFieldError('the source must parse completely before entering the approved corpus')
          source = { sourceRef: parsed.parse.originalRef, state: 'approved', kind: 'table', parserVersion: parsed.parse.parserVersion, parseId: parsed.parse.parseId, ...(parsed.parse.parseOptions === undefined ? {} : { tableOptions: parsed.parse.parseOptions }) }
        } else {
          if (body['options'] !== undefined) throw new InvalidRequestFieldError('document sources do not accept table selections')
          const parsed = await new LocalDocumentExtractionService({ blobs: options.blobs, store: options.parses }).parse({ scopeRef: scope(trusted.ctx), originalRef: sourceRef, documentVersionRef: sourceRef }, trusted.ctx)
          if (parsed.coverage.status !== 'complete') throw new InvalidRequestFieldError('the document must parse completely before entering the approved corpus')
          if (parsed.documentVersionRef?.kind !== 'document' || parsed.documentVersionRef.id !== parsed.originalRef.id || parsed.documentVersionRef.version !== parsed.originalRef.version || parsed.documentVersionRef.digest !== parsed.originalRef.digest) throw new InvalidRequestFieldError('该缓存来源缺少可核对的原始版本记录；请导入新的文件版本后重新确认来源')
          source = { sourceRef: parsed.originalRef, state: 'approved', kind: 'document', parserVersion: parsed.parserVersion, parseId: parsed.parseId }
        }
        const manifest: GroundingDocumentSet = { ...set, sources: [...set.sources.filter((row) => row.sourceRef.id !== source.sourceRef.id), source] }
        const documentSetRef = await stableWrite(`workspace:${request.params.workspaceId}:corpus:${key}`, new TextEncoder().encode(JSON.stringify(manifest)), GROUNDING_DOCUMENT_SET_MEDIA_TYPE, 'artifact', trusted.ctx)
        await workspaces.draftOperation(request.params.workspaceId, { operation: 'edit', expectedRevision: header.value, reason: `导入来源：${body['name']}`, documentSetRef }, key, trusted.ctx.principal.subjectId, trusted.ctx)
        const result = await listSources(request.params.workspaceId, trusted.ctx)
        return reply.status(201).send({ data: { workspace: result.workspace, draft: result.draft, source: result.sources.find((row) => row.sourceRef.id === source.sourceRef.id) }, meta: { traceId: trusted.traceId } })
      })
      app.get<{ Params: { workspaceId: string } }>('/api/v1/core/workspaces/:workspaceId/authoring-context', async (request, reply) => {
        const trusted = prepare(request, reply, false); if (trusted === undefined) return reply
        const state = await readWorkspace(request.params.workspaceId, trusted.ctx)
        const generationPolicyRef = await policy(trusted.ctx)
        const terminology = await options.terminology.getTerminology(scope(trusted.ctx), state.draft.basePackRef, trusted.ctx)
        const termLabels = state.draft.basePackRef === undefined || terminology?.definition === undefined ? undefined : await options.termLabels?.(scope(trusted.ctx), state.draft.basePackRef, terminology.definition.ref, trusted.ctx)
        const operations = []
        for (const operation of options.operations.operations) {
          const input = await stableWrite(`operation:${operation.operationRef.id}@${operation.operationRef.version}:input`, new TextEncoder().encode(canonicalJson(operation.inputSchema)), 'application/schema+json', 'artifact', trusted.ctx)
          const output = await stableWrite(`operation:${operation.operationRef.id}@${operation.operationRef.version}:output`, new TextEncoder().encode(canonicalJson(operation.outputSchema)), 'application/schema+json', 'artifact', trusted.ctx)
          if (input.digest !== operation.inputSchemaDigest || output.digest !== operation.outputSchemaDigest) throw new InvalidRequestFieldError('the registered operation schema bytes do not match their saved handler contract')
          operations.push({ ...operation, displayName: operation.operationRef.id,
            inputSchemaRef: { id: input.id, version: input.version, digest: input.digest }, outputSchemaRef: { id: output.id, version: output.version, digest: output.digest }, requiredPermissions: [], sideEffect: operation.readOnly ? 'read_only' : 'external' })
        }
        return reply.send({ data: { ...state, scopeRef: scope(trusted.ctx), generationPolicyRef, models: options.models,
          operations, ...(terminology?.definition === undefined ? {} : { definition: terminology.definition }),
          ...(termLabels === undefined ? {} : { termLabels }),
          generationLimits: { maxOutputTokens: 16_384, maxCandidatesPerCall: 25, maxSources: 64, sourceContextBytes: 65_536, sourceReadBytes: 33_554_432, sourceFragments: 32 } }, meta: { traceId: trusted.traceId } })
      })
    },
  }
}
