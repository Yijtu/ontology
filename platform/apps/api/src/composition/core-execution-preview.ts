import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { canonicalJson, currentDefinitionProjection, currentRuleActionProjection, definitionApprovalPins, ruleActionPublicationPins, sha256DigestOf } from '@ontology/application'
import type { IndustryAssetPublicationService, IndustryValidationService } from '@ontology/application'
import { IndustryAssetPublicationError, isRecord, isSha256Digest, isUuid, isVersionRef } from '@ontology/contracts'
import { createHash } from 'node:crypto'
import type { ActionCapabilityBindingInput, AssetCandidateStore, CompetencyExecutionRequest, CompetencyValidationTarget, IndustryWorkspaceStore, PublishedPackRuleVersion, PublishedPackAssetStore, PublishedRuleDeclarationReader, ResourceRef, ReviewableCandidateReader, RuleActionCandidateStore, ScopeRef, ScopedArtifactReader, SemanticDefinitionStore, SemanticDefinitionVersion, SemanticPublicationStore, ToolContext, VersionRef } from '@ontology/contracts'
import type { createCoreAuthoring } from './core-authoring'
import { createRequestToolContext } from '../http/context'
import { authenticateRequest, ForbiddenError, InvalidRequestFieldError, readHeader, readRevisionHeader, readTraceId } from '../http/shared'
import type { RequestAuthenticator } from '../http/shared'
import type { CoreDefinitionLabelReader } from './core-definition-labels'
import type { createCorePackExecutionProfiles } from './core-pack-execution-profiles'

/** A preview retains the real approved pack rule origin; it is never an extracted candidate. */
export interface PreviewBinding {
  readonly schemaVersion: 'competency-template-binding@1'
  readonly sourceOrigin: 'published_pack'
  readonly declarationDefinitionRef: VersionRef; readonly definitionRef: VersionRef; readonly namespace: string
  readonly packRef: VersionRef; readonly profileRef: { readonly id: string; readonly version: string; readonly snapshotHash: string }
  readonly rules: readonly { readonly origin: 'pack'; readonly declarationRef: VersionRef; readonly publishedRef: VersionRef; readonly sourceCandidateId: string; readonly publishedPackRef: VersionRef }[]
  readonly dataMode: 'synthetic'; readonly businessApproval: 'none'
}

function semanticTarget(target: CompetencyValidationTarget) {
  return { workspaceId: target.workspaceId, revision: target.revision,
    definitionApprovalPins: target.definitionApprovalPins.map(({ candidateId, contentDigest }) => ({ candidateId, contentDigest })).sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
    ruleActionPins: [...target.ruleActionPins].sort((a, b) => a.candidateId.localeCompare(b.candidateId)) }
}
const bindingIdentity = (target: CompetencyValidationTarget) => `execution-preview-binding:${sha256DigestOf(canonicalJson(semanticTarget(target)))}`

function bindingOf(value: unknown): PreviewBinding {
  if (!isRecord(value) || Object.keys(value).some((key) => !['schemaVersion', 'sourceOrigin', 'declarationDefinitionRef', 'definitionRef', 'namespace', 'packRef', 'profileRef', 'rules', 'dataMode', 'businessApproval'].includes(key)) || value['schemaVersion'] !== 'competency-template-binding@1' || value['sourceOrigin'] !== 'published_pack' || !isVersionRef(value['declarationDefinitionRef']) || !isVersionRef(value['definitionRef']) || !isVersionRef(value['packRef']) || typeof value['namespace'] !== 'string' || value['dataMode'] !== 'synthetic' || value['businessApproval'] !== 'none' || !isRecord(value['profileRef']) || Object.keys(value['profileRef']).some((key) => !['id', 'version', 'snapshotHash'].includes(key)) || typeof value['profileRef']['id'] !== 'string' || typeof value['profileRef']['version'] !== 'string' || !isSha256Digest(value['profileRef']['snapshotHash']) || !Array.isArray(value['rules']) || value['rules'].length > 16) throw new InvalidRequestFieldError('the immutable execution preview binding is malformed')
  const rules: PreviewBinding['rules'][number][] = value['rules'].map((row: unknown) => {
    if (!isRecord(row) || Object.keys(row).some((key) => !['origin', 'declarationRef', 'publishedRef', 'sourceCandidateId', 'publishedPackRef'].includes(key)) || row['origin'] !== 'pack' || !isVersionRef(row['declarationRef']) || !isVersionRef(row['publishedRef']) || !isUuid(row['sourceCandidateId']) || !isVersionRef(row['publishedPackRef'])) throw new InvalidRequestFieldError('the actual preview rule has another or malformed publication origin')
    return { origin: 'pack', declarationRef: row['declarationRef'], publishedRef: row['publishedRef'], sourceCandidateId: row['sourceCandidateId'], publishedPackRef: row['publishedPackRef'] }
  })
  return { schemaVersion: 'competency-template-binding@1', sourceOrigin: 'published_pack', declarationDefinitionRef: value['declarationDefinitionRef'], definitionRef: value['definitionRef'], namespace: value['namespace'], packRef: value['packRef'],
    profileRef: { id: value['profileRef']['id'], version: value['profileRef']['version'], snapshotHash: value['profileRef']['snapshotHash'] }, rules, dataMode: 'synthetic', businessApproval: 'none' }
}

/** Explicit ordinary UI operation: real semantic-only publication, actual component/profile, no CQ gold. */
export function createCoreExecutionPreview(options: {
  readonly workspaces: IndustryWorkspaceStore; readonly definitions: SemanticDefinitionStore; readonly terms: AssetCandidateStore
  readonly actions: RuleActionCandidateStore; readonly reviews: SemanticPublicationStore; readonly reviewable: ReviewableCandidateReader
  readonly validation: IndustryValidationService; readonly publication: IndustryAssetPublicationService
  readonly packs: Pick<PublishedPackAssetStore, 'findByIdempotencyKey' | 'findByRef'>
  readonly executionProfiles: ReturnType<typeof createCorePackExecutionProfiles>; readonly rules: PublishedRuleDeclarationReader
  readonly authoring: ReturnType<typeof createCoreAuthoring>; readonly actionContext: (ctx: ToolContext) => ActionCapabilityBindingInput
  readonly reader: ScopedArtifactReader
  readonly termLabels: CoreDefinitionLabelReader
  readonly validateTarget: (target: CompetencyValidationTarget, binding: PreviewBinding, definition: SemanticDefinitionVersion, rules: readonly PublishedPackRuleVersion[], ctx: ToolContext, signal: AbortSignal) => Promise<boolean>
}) {
  const scope = (ctx: ToolContext): ScopeRef => ({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId })
  const readTarget = async (workspaceId: string, revision: string, ctx: ToolContext): Promise<CompetencyValidationTarget> => {
    const workspace = await options.workspaces.getWorkspace(scope(ctx), workspaceId, ctx)
    const terms = await options.terms.listCandidates(scope(ctx), workspaceId, { limit: 250 }, ctx)
    const actions = await options.actions.list(scope(ctx), workspaceId, { limit: 250 }, ctx)
    if (workspace?.headRevision !== revision) throw new IndustryAssetPublicationError('VERSION_CONFLICT', 'the actual reviewed draft moved; recover the saved publication receipt before creating another preview')
    if (terms.length === 250 || actions.length === 250) throw new InvalidRequestFieldError('the actual reviewed draft inventory is incomplete')
    const approvals = await definitionApprovalPins(currentDefinitionProjection(terms), scope(ctx), ctx, options.reviewable, options.reviews)
    if (approvals.blockers.length > 0) throw new InvalidRequestFieldError('the current full definition requires human review before execution preview')
    return { workspaceId, revision, definitionApprovalPins: approvals.pins, ruleActionPins: ruleActionPublicationPins(currentRuleActionProjection(actions)) }
  }
  const readSaved = async (target: CompetencyValidationTarget, ctx: ToolContext, signal: AbortSignal) => {
    const ref = await options.authoring.findStableArtifact(bindingIdentity(target), ctx)
    if (ref === undefined) return undefined
    const bytes = await options.reader.read({ approvedInputRefs: [ref] }, ctx)
    if (bytes.byteLength > 1_048_576 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== ref.digest) throw new InvalidRequestFieldError('the stored execution preview failed actual byte integrity')
    const binding = bindingOf(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
    const definition = await options.definitions.findVersion(binding.namespace, binding.definitionRef.id, binding.definitionRef.version, scope(ctx), ctx)
    const asset = await options.packs.findByRef(scope(ctx), binding.packRef, ctx)
    const termLabels = await options.termLabels(scope(ctx), binding.packRef, binding.definitionRef, ctx)
    const rules = await options.rules.read(scope(ctx), { packRef: binding.packRef, definitionRef: binding.definitionRef }, ctx)
    if (asset === undefined || definition === undefined || !await options.validateTarget(target, binding, definition, rules, ctx, signal)) throw new InvalidRequestFieldError('the saved actual preview source, component or current human approval is unavailable')
    const ruleChoices = []
    for (const rule of rules) {
      const declaration = asset.ruleDeclarations?.find((row) => row.candidateId === rule.sourceCandidateId)
      const candidate = await options.actions.get(scope(ctx), rule.sourceCandidateId, ctx)
      if (declaration === undefined || candidate?.kind !== 'rule' || candidate.workspaceId !== target.workspaceId || candidate.contentDigest !== declaration.contentDigest) throw new InvalidRequestFieldError('the actual immutable rule display declaration is missing')
      ruleChoices.push({ ref: rule.ruleRef, ruleId: rule.ruleId, objectId: rule.objectId, displayName: candidate.displayName, sourceRefs: declaration.sourceRefs, hasBusinessConclusion: declaration.payload.conclusion !== undefined })
    }
    const current = await options.authoring.listSources(target.workspaceId, ctx)
    if (canonicalJson(semanticTarget(await readTarget(target.workspaceId, target.revision, ctx))) !== canonicalJson(semanticTarget(target))) throw new InvalidRequestFieldError('the actual preview target changed during readback')
    signal.throwIfAborted()
    return { purpose: 'synthetic_execution_support' as const, businessApproval: 'none' as const, workspace: current.workspace, draft: current.draft,
      packRef: binding.packRef, definitionRef: definition.ref, profileRef: binding.profileRef, ruleRefs: rules.map((rule) => rule.ruleRef),
      ruleChoices,
      ...(termLabels === undefined ? {} : { termLabels }),
      sourceRefs: current.sources.map((source) => source.sourceRef), sources: current.sources, templateBindingRef: ref, definitions: definition,
      semanticPublished: true as const, deploymentExecutable: false as const }
  }
  return {
    bindingFor: async (request: CompetencyExecutionRequest, ctx: ToolContext): Promise<ResourceRef | undefined> => request.validationTarget === undefined ? undefined : options.authoring.findStableArtifact(bindingIdentity(request.validationTarget), ctx),
    register(app: FastifyInstance, authenticate: RequestAuthenticator) {
      app.get<{ Params: { workspaceId: string } }>('/api/v1/core/workspaces/:workspaceId/execution-preview', async (request, reply) => {
        const auth = authenticateRequest(authenticate, request, reply); if (auth === undefined) return reply
        if (!isUuid(request.params.workspaceId) || !isRecord(request.query) || Object.keys(request.query).length > 0) throw new InvalidRequestFieldError('execution preview read requires the exact workspace and no overrides')
        const traceId = readTraceId(request), ctx = createRequestToolContext({ ...auth, traceId, runId: randomUUID() })
        const cancellation = new AbortController(), abort = () => cancellation.abort(), close = () => { if (!reply.raw.writableEnded) abort() }
        request.raw.once('aborted', abort); reply.raw.once('close', close)
        if (request.raw.aborted) abort()
        try {
          const current = await options.authoring.readWorkspace(request.params.workspaceId, ctx)
          const target = await readTarget(request.params.workspaceId, current.workspace.headRevision, ctx)
          const data = await readSaved(target, ctx, cancellation.signal)
          if (data === undefined) throw new IndustryAssetPublicationError('DRAFT_NOT_FOUND', 'this current reviewed draft has no saved execution preview')
          return reply.send({ data, meta: { traceId } })
        } finally { request.raw.removeListener('aborted', abort); reply.raw.removeListener('close', close) }
      })
      app.post<{ Params: { workspaceId: string } }>('/api/v1/core/workspaces/:workspaceId/execution-preview', async (request, reply) => {
        const auth = authenticateRequest(authenticate, request, reply); if (auth === undefined) return reply
        if (!auth.principal.roles.includes('platform-admin')) throw new ForbiddenError('execution preview requires the deployment operator who can register its actual component/profile')
        const traceId = readTraceId(request), header = readRevisionHeader(request), key = readHeader(request, 'idempotency-key'), body = request.body
        if (!isUuid(request.params.workspaceId) || header.kind !== 'revision' || key === undefined || key.length < 8 || key.length > 200 || !isRecord(body) || Object.keys(body).some((field) => field !== 'exampleSetId') || !isUuid(body['exampleSetId'])) throw new InvalidRequestFieldError('preview requires the current revision and actual selected synthetic example set')
        const ctx = createRequestToolContext({ ...auth, traceId, runId: randomUUID() })
        const signal = new AbortController(), aborted = () => signal.abort()
        request.raw.once('aborted', aborted)
        const closed = () => { if (!reply.raw.writableEnded) aborted() }
        reply.raw.once('close', closed)
        try {
          // The immutable request pin also covers retries after a committed publication
          // whose HTTP response was lost, without authorizing a different body or principal.
          await options.authoring.stableWrite(`execution-preview-request:${sha256DigestOf(canonicalJson({ workspaceId: request.params.workspaceId, key }))}`,
            new TextEncoder().encode(canonicalJson({ schemaVersion: 'execution-preview-request@1', workspaceId: request.params.workspaceId, expectedRevision: header.value, exampleSetId: body['exampleSetId'], principal: ctx.principal })),
            'application/vnd.ontology.execution-preview-request+json', 'artifact', ctx)
          const replay = await options.packs.findByIdempotencyKey(scope(ctx), `preview-publication:${key}`, ctx)
          if (replay !== undefined && (replay.workspaceId !== request.params.workspaceId || replay.sourceDraftRef?.revision !== header.value || replay.actor !== ctx.principal.subjectId)) throw new InvalidRequestFieldError('the actual preview receipt belongs to another request')
          let target = await readTarget(request.params.workspaceId, replay?.revision ?? header.value, ctx)
          const existing = await readSaved(target, ctx, signal.signal)
          if (existing !== undefined) return reply.send({ data: existing, meta: { traceId } })
          const strategy = { kind: 'keep_independent' as const, reason: '仅保存当前已人工审核声明的合成执行预览；不授予业务或部署许可' }
          let asset = replay
          if (asset === undefined) {
          const report = await options.validation.validate(request.params.workspaceId, { exampleSetId: body['exampleSetId'], expectedRevision: header.value,
            idempotencyKey: `preview-validation:${key}`, strategy, actionBindingContext: options.actionContext(ctx), signal: signal.signal }, ctx.principal.subjectId, ctx)
          if (!report.semanticPublished.passed || report.deploymentExecutable.passed || report.competency !== undefined || report.competencyRequired !== true) throw new InvalidRequestFieldError('execution support requires genuine semantic-only validation with deployment still blocked')
          signal.signal.throwIfAborted()
          asset = await options.publication.publish(request.params.workspaceId, { packId: `execution-preview-${header.value}`, version: `0.0.${header.value}`, validationId: report.validationId,
            expectedRevision: header.value, idempotencyKey: `preview-publication:${key}`, strategy, requireDeploymentExecutable: false }, ctx.principal.subjectId, ctx)
          }
          target = await readTarget(request.params.workspaceId, asset.revision, ctx)
          if (!asset.capabilities.semanticPublished || asset.capabilities.deploymentExecutable) throw new InvalidRequestFieldError('the actual preview publication unexpectedly claims deployment authority')
          const { definition, profileRef: resolvedProfileRef } = await options.executionProfiles.prepare(asset, ctx)
          const rules = await options.rules.read(scope(ctx), { packRef: asset.packRef, definitionRef: definition.ref }, ctx)
          const binding: PreviewBinding = { schemaVersion: 'competency-template-binding@1', sourceOrigin: 'published_pack', declarationDefinitionRef: definition.ref, definitionRef: definition.ref,
            namespace: definition.namespace, packRef: asset.packRef, profileRef: resolvedProfileRef,
            rules: rules.map((rule) => ({ origin: 'pack', declarationRef: rule.ruleRef, publishedRef: rule.ruleRef, sourceCandidateId: rule.sourceCandidateId, publishedPackRef: rule.publishedPackRef })), dataMode: 'synthetic', businessApproval: 'none' }
          if (!await options.validateTarget(target, binding, definition, rules, ctx, signal.signal)) throw new InvalidRequestFieldError('the actual complete preview body, original source or current human approval changed')
          await options.authoring.stableWrite(bindingIdentity(target), new TextEncoder().encode(canonicalJson(binding)), 'application/vnd.ontology.competency-template-binding+json', 'artifact', ctx)
          const saved = await readSaved(target, ctx, signal.signal)
          if (saved === undefined) throw new InvalidRequestFieldError('the actual execution preview receipt disappeared')
          return reply.status(201).send({ data: saved, meta: { traceId } })
        } finally { request.raw.removeListener('aborted', aborted); reply.raw.removeListener('close', closed) }
      })
    },
  }
}
