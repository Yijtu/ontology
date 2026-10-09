import { createHash, randomUUID } from 'node:crypto'
import { CompetencyQuestionError, isRecord, isResourceRef, isToolContext, sha256OfCanonical } from '@ontology/contracts'
import type {
  CompetencyExecutionPort, CompetencyExecutionRequest, CompetencyExecutionResult, CompetencyExpectation,
  CompetencySourceLocation, CompetencySourceReader, ImmutableArtifactWriter, ProjectRevision,
  ProjectSnapshotQueryDescriptor, PublishedExecutableRule, ResourceRef, RulePremiseReplayPort,
  ScopedArtifactReader, ScopeRef, SemanticDefinitionVersion, ToolContext, ToolGateway, VersionRef,
} from '@ontology/contracts'
import { canonicalJson } from '@ontology/application'
import {
  publishedRuleConsequenceKey, publishedRuleApplicabilityKey, publishedRuleDependencyRef, publishedRuleRef, projectSnapshotMappingRef,
  sameUtcInstant, compareUtcInstants,
} from '@ontology/semantic-engine'
import type {
  IncrementalMaterializer, MaterializationPublishedSource, MaterializedRuleDerivationEvidenceProducer,
  ProjectSemanticQueryService, PublishedRelationNavigator,
} from '@ontology/semantic-engine'
import type { RegisteredOperation } from '@ontology/contracts'

export interface PreparedCompetencyCase {
  /** Re-read current project/source/template/target pins around actual execution I/O. */
  readonly validateCurrent: (ctx: ToolContext, signal: AbortSignal) => Promise<void>
  /** Actual archived source/project/definition/rule/event binding, re-read by the executor. */
  readonly executionInputRef: ResourceRef
  readonly recordedPoint: string
  readonly declaredProjectId: string
  readonly declarationDefinitionRef: VersionRef
  readonly project: ProjectRevision
  readonly definition: SemanticDefinitionVersion
  /** Only canonical entities obtained through real published identity decisions. */
  readonly entities: ReadonlyMap<string, string>
  readonly businessIds: ReadonlyMap<string, string>
  /** Actual original resources read by the import/publication/policy pipeline. */
  readonly consumedOriginals: readonly ResourceRef[]
  readonly validationTargetDigest?: string
  readonly facts: MaterializationPublishedSource
  readonly query?: { readonly service: ProjectSemanticQueryService; readonly descriptor: ProjectSnapshotQueryDescriptor; readonly context: ToolContext }
  readonly rules?: {
    readonly materializer: IncrementalMaterializer
    readonly projectionRef: VersionRef
    /** Logical fixture points resolve to real recorded events, never to latest. */
    readonly recordedPoint: string
    readonly versions: readonly { readonly declarationRef: VersionRef; readonly published: PublishedExecutableRule }[]
    readonly producer: MaterializedRuleDerivationEvidenceProducer
    readonly replay: RulePremiseReplayPort
  }
  readonly relations?: {
    readonly navigator: PublishedRelationNavigator
    /** Actual monotonic semantic read head; the navigator itself has no historical port. */
    readonly readRecordedPoint: (scope: ScopeRef, ctx: ToolContext) => Promise<string>
  }
  readonly compute?: { readonly gateway: ToolGateway; readonly context: ToolContext; readonly operation: RegisteredOperation; readonly inputRef: ResourceRef }
}

export type PreparedCompetencyInput =
  | { readonly status: 'prepared'; readonly input: PreparedCompetencyCase }
  | { readonly status: 'refused'; readonly reason: Extract<CompetencyExpectation, { kind: 'refusal' }>['reason']; readonly artifacts: readonly ResourceRef[]; readonly consumedOriginals: readonly ResourceRef[]; readonly validationTargetDigest?: string;
      readonly validateCurrent: (ctx: ToolContext, signal: AbortSignal) => Promise<void> }
  | { readonly status: 'not_yet_executable'; readonly reason: string }

export interface CoreCompetencyExecutionOptions {
  /** Host loader/seeder uses stored approved inputs and real services, and cannot see gold. */
  readonly prepare: (request: CompetencyExecutionRequest, ctx: ToolContext, signal: AbortSignal) => Promise<PreparedCompetencyInput>
  readonly sources: CompetencySourceReader
  readonly artifacts: ImmutableArtifactWriter
  readonly reader: ScopedArtifactReader
}

const sameRef = (a: VersionRef, b: VersionRef): boolean => a.id === b.id && a.version === b.version && a.digest === b.digest
const entityKey = (objectId: string, businessId: string): string => `${objectId}\u0000${businessId}`

/** Finite execution over official facts, physical fixed SQL, saved rules, navigation and gateway. */
export function createCoreCompetencyExecution(options: CoreCompetencyExecutionOptions): CompetencyExecutionPort {
  const archive = async (body: unknown, ctx: ToolContext) => (await options.artifacts.putBytes({ scopeRef: { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId },
    mediaType: 'application/json', content: new TextEncoder().encode(canonicalJson(body)) }, ctx)).blobRef
  const readJson = async (ref: ResourceRef, ctx: ToolContext): Promise<unknown> => {
    const bytes = await options.reader.read({ approvedInputRefs: [ref] }, ctx)
    if (bytes.byteLength > 1_048_576) throw new CompetencyQuestionError('INVALID_DECLARATION', 'competency execution artifact exceeds one MiB')
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== ref.digest) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency execution artifact bytes failed their immutable digest')
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  }
  const coveredSources = async (request: CompetencyExecutionRequest, originals: readonly ResourceRef[], ctx: ToolContext, signal: AbortSignal): Promise<CompetencySourceLocation[]> => {
    const scope = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    const result: CompetencySourceLocation[] = []
    for (const location of request.requiredSources) {
      if (!originals.some((ref) => sameRef(ref, location.sourceRef))) continue
      const bytes = await options.sources.readSource(scope, location.sourceRef, ctx, signal)
      if (bytes !== undefined && location.endOffset <= bytes.byteLength && `sha256:${createHash('sha256').update(bytes.subarray(location.startOffset, location.endOffset)).digest('hex')}` === location.quoteDigest) result.push(location)
    }
    return result
  }
  return { async execute(request, ctx, signal): Promise<CompetencyExecutionResult> {
    signal.throwIfAborted()
    const prepared = await options.prepare(request, ctx, signal)
    signal.throwIfAborted()
    if (prepared.status === 'not_yet_executable') return prepared
    const finish = async (actual: CompetencyExpectation, artifactRefs: readonly ResourceRef[], originals: readonly ResourceRef[], validationTargetDigest?: string): Promise<CompetencyExecutionResult> => {
      const sources = await coveredSources(request, originals, ctx, signal)
      if (prepared.status === 'prepared') await prepared.input.validateCurrent(ctx, signal)
      else await prepared.validateCurrent(ctx, signal)
      signal.throwIfAborted()
      return { status: 'executed', actual, inputDigest: request.inputDigest, definitionRef: request.definitionRef, ruleRefs: request.ruleRefs,
        ...(validationTargetDigest === undefined ? {} : { validationTargetDigest }), artifactRefs, sources }
    }
    if (prepared.status === 'refused') return finish({ kind: 'refusal', reason: prepared.reason }, prepared.artifacts, prepared.consumedOriginals, prepared.validationTargetDigest)
    const input = prepared.input
    await input.validateCurrent(ctx, signal)
    signal.throwIfAborted()
    const captured = await readJson(input.executionInputRef, ctx)
    const actualRules = input.rules?.versions.map((row) => ({ declarationRef: row.declarationRef, actualRef: publishedRuleRef(row.published) })) ?? []
    const points = isRecord(captured) && Array.isArray(captured['recordedPoints']) ? captured['recordedPoints'] : []
    const selectedPoints = points.filter((point: unknown) => isRecord(point) && point['logical'] === request.input.asOfRecordedSeq)
    if (!isRecord(captured) || captured['schemaVersion'] !== 'competency-actual-input-binding@1' || captured['inputDigest'] !== request.inputDigest ||
        captured['declarationProjectId'] !== request.input.projectId || captured['dataMode'] !== 'synthetic' || captured['businessApproval'] !== 'none' ||
        sha256OfCanonical(captured['projectRevisionRef']) !== sha256OfCanonical(input.project.ref) ||
        sha256OfCanonical(captured['definitionRef']) !== sha256OfCanonical(input.definition.ref) ||
        sha256OfCanonical(captured['declarationDefinitionRef']) !== sha256OfCanonical(request.definitionRef) ||
        canonicalJson(captured['originals']) !== canonicalJson(input.consumedOriginals) || canonicalJson(captured['rules']) !== canonicalJson(actualRules) ||
        captured['selectedRecordedPoint'] !== input.recordedPoint ||
        points.length === 0 || points.length > 201 || selectedPoints.length !== 1 || !isRecord(selectedPoints[0]) || selectedPoints[0]['actual'] !== input.recordedPoint ||
        points.some((point: unknown) => !isRecord(point) || typeof point['logical'] !== 'string' || typeof point['actual'] !== 'string' || !/^\d+$/u.test(point['actual'])) ||
        new Set(points.map((point: unknown) => isRecord(point) ? point['logical'] : undefined)).size !== points.length ||
        canonicalJson(captured['entityBindings']) !== canonicalJson([...input.entities]) || canonicalJson(captured['businessBindings']) !== canonicalJson([...input.businessIds]) ||
        captured['validationTargetDigest'] !== input.validationTargetDigest || (input.rules !== undefined && input.rules.recordedPoint !== input.recordedPoint)) {
      throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual archived competency input lineage does not match the prepared case')
    }
    if (input.declaredProjectId !== request.input.projectId || !sameRef(input.declarationDefinitionRef, request.definitionRef) ||
        !sameRef(input.project.definitionRef, input.definition.ref) ||
        (request.validationTarget !== undefined && input.validationTargetDigest !== sha256OfCanonical(request.validationTarget))) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'competency prepared input changed its project, definition or reviewed draft binding')
    const intent = request.intent
    if (intent.projectId !== request.input.projectId) return { status: 'not_yet_executable', reason: 'cross-project refusal requires an actual host admission refusal artifact' }
    const originalRefs = input.consumedOriginals
    const inputArchive = await archive({ inputDigest: request.inputDigest, questionSetRef: request.questionSetRef, executionInputRef: input.executionInputRef,
      projectRevisionRef: input.project.ref, definitionRef: input.definition.ref, recordedPoint: input.recordedPoint,
      declarationDefinitionRef: input.declarationDefinitionRef, originals: originalRefs,
      ...(input.rules === undefined ? {} : { recordedPoint: input.rules.recordedPoint, rules: input.rules.versions.map((row) => ({ declarationRef: row.declarationRef, ruleRef: publishedRuleRef(row.published) })) }),
      ...(input.query === undefined ? {} : { snapshotRef: input.query.descriptor.snapshotRef }), businessApproval: 'none', dataMode: 'synthetic' }, ctx)
    let actual: CompetencyExpectation
    let proof: unknown
    const additional: ResourceRef[] = []
    if (intent.kind === 'attribute') {
      const entityId = input.entities.get(entityKey(intent.objectId, intent.subjectEntityId))
      if (entityId === undefined) return { status: 'not_yet_executable', reason: 'the business identifier has no unique actual confirmed entity' }
      if (!input.definition.attributes.some((field) => field.objectId === intent.objectId && field.id === intent.attributeId)) return { status: 'not_yet_executable', reason: 'definition mismatch requires an actual schema admission refusal artifact' }
      const read = await input.facts.load(request.input.scopeRef, ctx)
      if (read.complete !== true || read.definitionRef === undefined || !sameRef(read.definitionRef, input.definition.ref) || read.readRevision?.semantic !== input.recordedPoint) return { status: 'not_yet_executable', reason: 'official fact coverage, definition or exact recorded point is unavailable' }
      const facts = read.facts.filter((fact) => fact.projectId === input.project.ref.projectId && fact.subject === entityId && fact.objectId === intent.objectId && fact.attributeId === intent.attributeId && fact.op !== 'retract' &&
        (fact.validity.validFrom === undefined || (compareUtcInstants(fact.validity.validFrom, request.input.validAt) ?? 1) <= 0) &&
        (fact.validity.validTo === undefined || (compareUtcInstants(request.input.validAt, fact.validity.validTo) ?? 1) < 0))
      const values = [...new Map(facts.filter((fact) => fact.value !== undefined).map((fact) => [canonicalJson(fact.value), fact.value!])).values()]
      actual = values.length === 1 ? { kind: 'value', value: values[0]! } : { kind: 'unknown', reason: values.length === 0 ? 'no published observation' : 'conflicting published observations' }
      proof = { facts, readRevision: read.readRevision, definitionRef: read.definitionRef }
    } else if (intent.kind === 'quantity_sum') {
      if (input.query === undefined) return { status: 'not_yet_executable', reason: 'the official activated project SQL snapshot is not mounted' }
      const field = input.definition.attributes.find((row) => row.id === intent.attributeId && row.objectId === intent.objectId)
      const metadata = input.query.descriptor.metadata
      if (field?.valueType !== 'quantity' || field.unit === undefined || metadata === undefined ||
          sha256OfCanonical(metadata.body.projectRevisionRef) !== sha256OfCanonical(input.project.ref) ||
          metadata.body.definitionRef === undefined || !sameRef(metadata.body.definitionRef, input.definition.ref) || metadata.body.factRecordedPoint?.semantic !== input.recordedPoint || metadata.body.coverage.completeness !== 'complete' ||
          metadata.activation === undefined || !sameRef(metadata.activation.snapshotRef, input.query.descriptor.snapshotRef) ||
          sha256OfCanonical(metadata.activation.projectRevisionRef) !== sha256OfCanonical(input.project.ref)) return { status: 'not_yet_executable', reason: 'the fixed query snapshot has no exact activated project/definition/recorded-point quantity binding' }
      const queryContext = input.query.context
      if (!isToolContext(queryContext) || queryContext.runId !== ctx.runId || canonicalJson(queryContext.principal) !== canonicalJson(ctx.principal) ||
          queryContext.resolvedProfileHash !== input.project.profileRef.snapshotHash ||
          queryContext.allowedResources.tenantId !== ctx.principal.tenantId || queryContext.allowedResources.spaceId !== ctx.allowedResources.spaceId ||
          queryContext.allowedResources.maxRows < 1 || queryContext.allowedResources.maxRows > 2 || queryContext.allowedResources.sourceRefs.length !== 1 ||
          canonicalJson(queryContext.allowedResources.sourceRefs[0]) !== canonicalJson(input.query.descriptor.sourceObjectRef.sourceRef)) {
        throw new CompetencyQuestionError('SCOPE_MISMATCH', 'the host query context must grant only the exact activated snapshot and share the validation run and principal')
      }
      const queried = await input.query.service.execute({ descriptor: input.query.descriptor,
        plan: { mode: 'semantic', concepts: [intent.objectId], fields: [intent.attributeId], links: [], filters: [], orderBy: [], limit: 1,
          mappingVersion: projectSnapshotMappingRef({ descriptor: input.query.descriptor }), aggregation: { kind: 'sum', fieldRefs: [intent.attributeId], groupBy: [] } },
        limits: { maxRows: 2, maxBytes: 16_384, maxDurationMs: 10_000 } }, queryContext)
      const value = queried.rows[0]?.values[0]
      if (queried.coverage.truncated || (queried.coverage.completeness !== undefined && queried.coverage.completeness !== 'complete') || queried.rows.length !== 1 || typeof value !== 'string') return { status: 'not_yet_executable', reason: 'the physical quantity query did not return one complete exact decimal' }
      actual = { kind: 'value', value: { amount: value, unit: field.unit.unitCode } }; proof = queried
    } else if (intent.kind === 'rule') {
      const rules = input.rules
      const entityId = input.entities.get(entityKey(intent.objectId, intent.subjectEntityId))
      const rule = rules?.versions.find((row) => row.published.ruleId === intent.ruleId && request.ruleRefs.some((ref) => sameRef(ref, row.declarationRef)))
      if (rules === undefined || entityId === undefined || rule === undefined) return { status: 'not_yet_executable', reason: 'the pinned published rule or confirmed entity is unavailable' }
      const key = rule.published.conclusion === undefined
        ? publishedRuleApplicabilityKey({ tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId, definitionRef: input.definition.ref,
          ruleRef: publishedRuleRef(rule.published), objectId: rule.published.objectId, subjectEntityId: entityId, projectId: input.project.ref.projectId })
        : publishedRuleConsequenceKey(publishedRuleDependencyRef(rule.published, request.input.scopeRef, input.definition.ref), entityId)
      const read = await rules.materializer.read({ scopeRef: request.input.scopeRef, projectionRef: rules.projectionRef, validAt: request.input.validAt, asOfRecordedSeq: rules.recordedPoint, propositionKeys: [key] }, ctx)
      if (read.status !== 'materialized') return { status: 'not_yet_executable', reason: 'the exact persisted rule point is unavailable or fenced' }
      const ruleRef = publishedRuleRef(rule.published)
      const artifact = read.ruleArtifacts?.find((row) => sameRef(row.ruleRef, ruleRef) && row.objectId === intent.objectId && row.subjectEntityId === entityId)
      if (artifact === undefined || artifact.validAt === undefined || !sameUtcInstant(artifact.validAt, request.input.validAt) || artifact.asOfRecordedSeq !== rules.recordedPoint) return { status: 'not_yet_executable', reason: 'the exact captured rule computation is unavailable' }
      const evidence = await rules.producer.record({ scopeRef: request.input.scopeRef, ruleRef, definitionRef: input.definition.ref, objectId: intent.objectId,
        subjectEntityId: entityId, validAt: request.input.validAt, asOfRecordedSeq: rules.recordedPoint, observedAt: new Date().toISOString(), sourceSnapshots: [], dataMode: 'synthetic' }, ctx)
      const payloadRef = evidence.envelope.payloadRef
      if (payloadRef === undefined) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'real rule evidence has no immutable payload')
      const payload = await readJson(payloadRef, ctx)
      if (!await rules.replay.verify({ artifact, payload }, ctx)) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'actual published rule premises and original sources did not replay')
      const conclusion = read.conclusions.find((row) => row.propositionKey === key)
      const propositionState = rule.published.conclusion === undefined ? 'unknown' : conclusion?.domainStatus === 'conflict' ? 'conflict' : conclusion?.domainStatus === 'known' && typeof conclusion.value === 'boolean' ? (conclusion.value ? 'true' : 'false') : 'unknown'
      actual = { kind: 'rule', conditionState: artifact.applicability.conditionState, applicability: artifact.applicability.state, propositionState }
      proof = { artifact, conclusion, evidenceRef: evidence.evidenceRef, payloadRef }; additional.push(evidence.evidenceRef, payloadRef)
    } else if (intent.kind === 'relation') {
      const entityId = input.entities.get(entityKey(intent.objectId, intent.subjectEntityId))
      if (input.relations === undefined || entityId === undefined) return { status: 'not_yet_executable', reason: 'published relation navigation is not mounted or its entity is unresolved' }
      if (await input.relations.readRecordedPoint(request.input.scopeRef, ctx) !== input.recordedPoint) return { status: 'not_yet_executable', reason: 'historical relation navigation is not supported by the actual current navigation port' }
      const result = await input.relations.navigator.navigate({ startEntityId: entityId, relationIds: [intent.relationId], validAt: request.input.validAt, maxPaths: 32, signal }, ctx)
      if (await input.relations.readRecordedPoint(request.input.scopeRef, ctx) !== input.recordedPoint) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the actual relation read point changed during navigation')
      const targets = result.paths.map((path) => input.businessIds.get(path.endEntityId))
      if (targets.some((target) => target === undefined)) return { status: 'not_yet_executable', reason: 'a confirmed relation target lacks an actual business identity binding' }
      actual = { kind: 'relation', targetEntityIds: [...new Set(targets.filter((target): target is string => target !== undefined))].sort(), completeness: result.completeness }; proof = result
    } else {
      const compute = input.compute
      if (compute === undefined || compute.operation.operationRef.id !== intent.operationRef.id || compute.operation.operationRef.version !== intent.operationRef.version || !sameRef(compute.inputRef, intent.inputSourceRef)) return { status: 'not_yet_executable', reason: 'the exact registered operation or approved original input is unavailable' }
      if (!isToolContext(compute.context) || compute.context.runId !== ctx.runId || canonicalJson(compute.context.principal) !== canonicalJson(ctx.principal) ||
          compute.context.resolvedProfileHash !== input.project.profileRef.snapshotHash || compute.context.allowedResources.tenantId !== ctx.principal.tenantId ||
          compute.context.allowedResources.spaceId !== ctx.allowedResources.spaceId) throw new CompetencyQuestionError('SCOPE_MISMATCH', 'registered compute must share the actual validation run, full principal and pinned project profile')
      const result = await compute.gateway.invoke({ callId: randomUUID(), toolId: 'data_query', arguments: { kind: 'compute', operationRef: intent.operationRef,
        inputSchemaDigest: compute.operation.inputSchemaDigest, inputRefs: [compute.inputRef], parameters: {} } }, compute.context)
      if (result.status !== 'ok' || result.dataRef === undefined) throw new CompetencyQuestionError('INVALID_DECLARATION', 'the actual registered compute gateway failed', { cause: result.error })
      const payload = await readJson(result.dataRef, compute.context)
      const computation = isRecord(payload) ? payload['computation'] : undefined
      const metrics = isRecord(computation) ? computation['metrics'] : undefined
      if (!isRecord(computation) || !isRecord(metrics) || !isResourceRef(computation['resultRef'])) throw new CompetencyQuestionError('DIGEST_MISMATCH', 'the registered gateway did not archive a computation result')
      const value = metrics[intent.metric]
      if (intent.metric === 'record_count') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CompetencyQuestionError('INVALID_DECLARATION', 'the registered record count is invalid')
        actual = { kind: 'value', value: { kind: 'scalar_decimal', amount: String(value) } }
      } else {
        if (!isRecord(value) || typeof value['amount'] !== 'string') throw new CompetencyQuestionError('INVALID_DECLARATION', 'the registered metric has no exact amount')
        if (intent.metric === 'total_quantity' && typeof value['unit'] === 'string') actual = { kind: 'value', value: { amount: value['amount'], unit: value['unit'] } }
        else if (intent.metric === 'total_cost' && typeof value['currency'] === 'string') actual = { kind: 'value', value: { amount: value['amount'], currency: value['currency'] } }
        else throw new CompetencyQuestionError('INVALID_DECLARATION', 'registered quantity and currency axes do not match the finite metric')
      }
      proof = { result, payload }; additional.push(result.dataRef, computation['resultRef'], ...result.evidenceRefs)
    }
    signal.throwIfAborted()
    const resultRef = await archive({ inputDigest: request.inputDigest, inputArchive, actual, proof, dataMode: 'synthetic' }, ctx)
    signal.throwIfAborted()
    return finish(actual, [input.executionInputRef, inputArchive, resultRef, ...additional], originalRefs, input.validationTargetDigest)
  } }
}
