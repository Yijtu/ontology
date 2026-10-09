import {
  buildDefinitionRecord, canonicalJson, currentDefinitionProjection,
  currentRuleActionProjection, definitionApprovalPins, ruleActionPublicationPins, SourceGroundingBudget,
  definitionGeneratedContentDigest, definitionEditedContentDigest, ruleActionGroundedContentDigest, ruleActionDeclaredContentDigest,
  TBOX_RESPONSE_SCHEMA_REF, DEFINITION_EDIT_RESPONSE_SCHEMA_REF, DEFINITION_SOURCE_CONFIRMATION_SCHEMA_REF, RULE_ACTION_RESPONSE_SCHEMA_REF,
  groundingFragments, selectedGrounding,
} from '@ontology/application'
import {
  CompetencyQuestionError, isRecord, isToolContext, isUuid, isVersionRef,
  relationPremisesFromDefinition,
} from '@ontology/contracts'
import type {
  AssetCandidateStore, AssetCandidateVersion, CandidateSourceSpan, CandidateStore,
  CompetencyValidationTarget, GroundedSourceContent, IndustryWorkspaceStore,
  ResolvedProfileRef, ReviewableCandidateReader, RuleActionCandidateStore, RuleActionCandidateVersion, RuleActionGenerationStore,
  RuleCandidate, RuleCandidateVersion, RuleDependencyCandidateReference, ScopeRef,
  SemanticDefinitionStore, SemanticDefinitionVersion, SemanticPublicationStore, SourceGroundingPort,
  SemanticDefinitionRecord, ToolContext, VersionRef,
} from '@ontology/contracts'
import { definitionVersionDigest, FiniteGrammarRuleSupportValidator, publishedRuleRef } from '@ontology/semantic-engine'

/** Structural public seam shared with the actual project preparer; no private imports. */
export interface CompetencyTargetTemplate {
  readonly schemaVersion: 'competency-template-binding@1'
  readonly declarationDefinitionRef: VersionRef
  readonly definitionRef: VersionRef
  readonly namespace: string
  readonly packRef: VersionRef
  readonly profileRef: ResolvedProfileRef
  readonly rules: readonly { readonly declarationRef: VersionRef; readonly publishedRef: VersionRef; readonly sourceCandidateId: string; readonly publicationId: string }[]
  readonly dataMode: 'synthetic'
  readonly businessApproval: 'none'
}

export interface CompetencyValidationTargetReaderOptions {
  readonly workspaces: Pick<IndustryWorkspaceStore, 'getWorkspace' | 'getDraft'>
  readonly definitionCandidates: Pick<AssetCandidateStore, 'listCandidates' | 'getBatch' | 'getCandidate'>
  readonly ruleActions: Pick<RuleActionCandidateStore, 'list' | 'get'>
  readonly ruleGeneration: Pick<RuleActionGenerationStore, 'getById'>
  readonly reviews: Pick<SemanticPublicationStore, 'latestReviewRevision' | 'getReview' | 'listRuleVersions' | 'getPublication'>
  readonly reviewableCandidates: ReviewableCandidateReader
  readonly definitions: Pick<SemanticDefinitionStore, 'findVersion'>
  readonly candidates: Pick<CandidateStore, 'getCandidate'>
  readonly grounding: SourceGroundingPort
}

const MAX_CANDIDATES = 250
const same = (a: VersionRef, b: VersionRef): boolean => a.id === b.id && a.version === b.version && a.digest === b.digest
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
const ordered = <T extends { candidateId: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => a.candidateId.localeCompare(b.candidateId))

/** Formal fields retain all unknown keys; only display/audit/locator data are omitted. */
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['namespace', 'standardProvenance', 'displayName'].includes(key))
    .map(([key, row]) => [key, semantic(row)]))
}

function definitionSemantics(definition: Pick<SemanticDefinitionRecord, 'layer' | 'baseRef' | 'objects' | 'attributes' | 'relations' | 'identityScopes' | 'ruleConstraints'>) {
  const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id)).map((row) => semantic(row))
  return { layer: definition.layer, baseRef: definition.baseRef, objects: byId(definition.objects), attributes: byId(definition.attributes),
    relations: byId(definition.relations), identityScopes: byId(definition.identityScopes), ruleConstraints: byId(definition.ruleConstraints) }
}

function spanKey(span: CandidateSourceSpan): string {
  return span.kind === 'structured' ? canonicalJson({ kind: 'structured', parseId: span.parseId, recordId: span.recordId,
    sourceRowKey: span.sourceRowKey, rowDigest: span.rowDigest, locator: span.locator })
    : canonicalJson({ parseId: span.parseId, chunkId: span.chunkId, locator: span.locator, spanKind: span.spanKind,
      precision: span.precision, quoteDigest: span.quoteDigest, textDigest: span.textDigest })
}

function sourceSpans(contents: readonly GroundedSourceContent[]): CandidateSourceSpan[] {
  return contents.flatMap((content) => content.kind === 'text' ? [content.sourceSpan] : content.rows.map((row) => row.sourceSpan))
}

function ruleSpanKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const { parseId, chunkId, locator, spanKind, precision, quoteDigest } = value
  return canonicalJson({ parseId, chunkId, locator, spanKind, precision, quoteDigest })
}

function ruleOrigins(value: unknown, actual: ReadonlyMap<string, CandidateSourceSpan>, path: string,
  bindings: ReadonlyMap<string, CandidateSourceSpan> | undefined): boolean {
  if (Array.isArray(value)) return value.every((row, index) => ruleOrigins(row, actual, `${path}[${index}]`, bindings))
  if (!isRecord(value)) return true
  if (('op' in value || 'exceptionId' in value) && (!Array.isArray(value['spans']) || value['spans'].length === 0)) return false
  return Object.entries(value).every(([key, row]) => key !== 'spans' ? ruleOrigins(row, actual, `${path}.${key}`, bindings)
    : Array.isArray(row) && row.length > 0 && (bindings === undefined || row.length === 1) && row.every((span: unknown) => {
      if (!isRecord(span) || Object.keys(span).some((key) => !['parseId', 'chunkId', 'locator', 'spanKind', 'precision', 'quoteDigest', 'kind', 'textDigest'].includes(key))) return false
      const origin = actual.get(ruleSpanKey(span) ?? '')
      const bound = bindings?.get(path)
      if (bindings !== undefined && (bound === undefined || ruleSpanKey(bound) !== ruleSpanKey(span))) return false
      return origin !== undefined && origin.kind !== 'structured' && (span['kind'] === undefined || span['kind'] === 'text')
        && (span['textDigest'] === undefined || span['textDigest'] === origin.textDigest)
    }))
}

/** Bounded authoritative target reader used by normal draft validation and deployment wiring. */
export function createCompetencyValidationTargetReader(options: CompetencyValidationTargetReaderOptions) {
  const support = new FiniteGrammarRuleSupportValidator()
  return async (target: CompetencyValidationTarget, template: CompetencyTargetTemplate,
    suppliedDefinition: SemanticDefinitionVersion, suppliedRules: readonly RuleCandidate[], ctx: ToolContext, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted()
    if (!isToolContext(ctx) || ctx.principal.tenantId !== ctx.allowedResources.tenantId) throw new CompetencyQuestionError('SCOPE_MISMATCH', 'competency target requires a consistent trusted scope')
    const scope: ScopeRef = { tenantId: ctx.principal.tenantId, spaceId: ctx.allowedResources.spaceId }
    if (!isUuid(target.workspaceId) || !/^[1-9]\d*$/u.test(target.revision) || target.definitionApprovalPins.length === 0
      || target.definitionApprovalPins.length > MAX_CANDIDATES || target.ruleActionPins.length > MAX_CANDIDATES
      || template.schemaVersion !== 'competency-template-binding@1' || template.dataMode !== 'synthetic' || template.businessApproval !== 'none'
      || template.rules.length > MAX_CANDIDATES || suppliedRules.length !== template.rules.length) return false

    const readTarget = async () => {
      const workspace = await options.workspaces.getWorkspace(scope, target.workspaceId, ctx)
      if (workspace === undefined || workspace.state === 'archived' || workspace.headRevision !== target.revision) return undefined
      const draft = await options.workspaces.getDraft(scope, target.workspaceId, workspace.headRevision, ctx)
      if (draft === undefined || draft.revision !== target.revision) return undefined
      const definitions = await options.definitionCandidates.listCandidates(scope, target.workspaceId, { limit: MAX_CANDIDATES }, ctx)
      const rules = await options.ruleActions.list(scope, target.workspaceId, { limit: MAX_CANDIDATES }, ctx)
      if (definitions.length >= MAX_CANDIDATES || rules.length >= MAX_CANDIDATES) return undefined
      const projection = currentDefinitionProjection(definitions)
      const current = currentRuleActionProjection(rules)
      if (new Set(projection.map((row) => `${row.kind}:${row.logicalId}`)).size !== projection.length) return undefined
      if (projection.length === 0 || projection.some((row) => row.workspaceId !== target.workspaceId
        || row.logicalId !== row.payload.logicalId || row.kind !== row.payload.kind || row.issues.length > 0 || row.pendingConfirmation
        || row.sourceRefs.length === 0 || row.sourceSpans.length === 0 || row.state === 'failed' || row.state === 'rejected')) return undefined
      if (current.some((row) => row.workspaceId !== target.workspaceId
        || row.lifecycle !== 'enabled' || row.enabledAt === undefined || row.sourceRefs.length === 0 || row.sourceSpans.length === 0)) return undefined
      // This preparer carries actual rule templates, not action implementations.
      // An enabled action cannot disappear from a supposedly complete semantic comparison.
      if (current.some((row) => row.kind !== 'rule' || row.payload.kind !== 'rule')) return undefined
      const approvals = await definitionApprovalPins(projection, scope, ctx, options.reviewableCandidates, options.reviews)
      if (approvals.blockers.length > 0 || approvals.pins.length !== target.definitionApprovalPins.length || new Set(target.definitionApprovalPins.map((row) => row.candidateId)).size !== target.definitionApprovalPins.length) return undefined
      for (const wanted of target.definitionApprovalPins) {
        const actual = approvals.pins.find((row) => row.candidateId === wanted.candidateId && row.contentDigest === wanted.contentDigest)
        const saved = await options.reviews.getReview(scope, wanted.candidateId, wanted.reviewRevision, ctx)
        if (actual === undefined || saved?.decision !== 'approve' || saved.contentDigest !== wanted.contentDigest) return undefined
      }
      if (!equal(ordered(ruleActionPublicationPins(current)), ordered(target.ruleActionPins))) return undefined
      const reviewPins = []
      const generationBatches = []
      const definitionBatches = []
      const predecessors = []
      for (const row of current) {
        const view = await options.reviewableCandidates.readCandidate(scope, row.candidateId, ctx)
        const revision = await options.reviews.latestReviewRevision(scope, row.candidateId, ctx)
        const review = await options.reviews.getReview(scope, row.candidateId, revision, ctx)
        if (view?.domain !== 'definition' || view.kind !== row.kind || view.state !== 'enabled' || view.contentDigest !== row.contentDigest
          || review?.decision !== 'approve' || review.contentDigest !== row.contentDigest) return undefined
        reviewPins.push({ candidateId: row.candidateId, contentDigest: row.contentDigest })
        const context = row.generationContext
        if (context !== undefined && (context.issues.length > 0 || context.inputDraftRef.workspaceId !== target.workspaceId
          || context.inputDraftRef.revision !== draft.revision || context.inputDraftRef.digest !== draft.digest
          || context.sourceBindings.length === 0)) return undefined
        if (context !== undefined) {
          const batch = await options.ruleGeneration.getById(scope, context.batchId, ctx)
          if (batch === undefined || batch.workspaceId !== target.workspaceId || batch.generationFamily !== 'rule_action' || batch.state !== 'completed'
            || !equal(batch.inputDraftRef, context.inputDraftRef) || batch.contextDigest !== context.contextDigest
            || !same(batch.documentSetRef, draft.documentSetRef) || !equal(batch.sourceRefs, context.inputSourceRefs)
            || !batch.candidateIds.includes(row.candidateId) || !same(batch.responseSchemaRef, RULE_ACTION_RESPONSE_SCHEMA_REF)
            || ruleActionGroundedContentDigest(row) !== row.contentDigest) return undefined
          if (batch.sourceConfirmationOf !== undefined) {
            const prior = await options.ruleActions.get(scope, batch.sourceConfirmationOf.candidateId, ctx)
            if (prior === undefined || prior.workspaceId !== row.workspaceId || prior.kind !== row.kind || prior.logicalId !== row.logicalId
              || prior.candidateId !== row.replacesCandidateId || prior.contentDigest !== batch.sourceConfirmationOf.contentDigest) return undefined
            predecessors.push(prior)
          }
          generationBatches.push(batch)
        } else if (ruleActionDeclaredContentDigest({ ...row, draftRevision: draft.revision, draftDigest: draft.digest }) !== row.contentDigest) {
          return undefined
        }
      }
      for (const row of projection) {
        if (row.inputDraftRef.workspaceId !== target.workspaceId || row.inputDraftRef.revision !== draft.revision || row.inputDraftRef.digest !== draft.digest) return undefined
        const batch = await options.definitionCandidates.getBatch(scope, row.batchId, ctx)
        if (batch === undefined || batch.workspaceId !== target.workspaceId || batch.state !== 'completed' || !equal(batch.inputDraftRef, row.inputDraftRef)
          || !same(batch.documentSetRef, draft.documentSetRef)) return undefined
        if (same(batch.responseSchemaRef, TBOX_RESPONSE_SCHEMA_REF)) {
          if (definitionGeneratedContentDigest(row) !== row.contentDigest || batch.schemaDigest !== row.inputDraftRef.contextDigest) return undefined
        } else if (same(batch.responseSchemaRef, DEFINITION_EDIT_RESPONSE_SCHEMA_REF)) {
          if (definitionEditedContentDigest(row) !== row.contentDigest) return undefined
        } else if (same(batch.responseSchemaRef, DEFINITION_SOURCE_CONFIRMATION_SCHEMA_REF)) {
          // The established confirmation producer includes a human reason which
          // is not saved. Its exact immutable candidate/review pins, actual
          // preserved predecessor body and source replay remain authoritative.
          const prior = row.replacesCandidateId === undefined ? undefined : await options.definitionCandidates.getCandidate(scope, row.replacesCandidateId, ctx)
          if (batch.modelRef.modelId !== 'definition-source-confirmation' || batch.modelRef.version !== '1.0.0'
            || !same(batch.generationPolicyRef, DEFINITION_SOURCE_CONFIRMATION_SCHEMA_REF) || batch.schemaDigest !== DEFINITION_SOURCE_CONFIRMATION_SCHEMA_REF.digest
            || prior === undefined || prior.workspaceId !== row.workspaceId || prior.kind !== row.kind || prior.logicalId !== row.logicalId
            || !equal(prior.payload, row.payload)) return undefined
          predecessors.push(prior)
        } else return undefined
        definitionBatches.push(batch)
      }
      return { workspace, draft, projection, rules: current, definitionBatches, generationBatches, predecessors, approvals: approvals.pins.map(({ candidateId, contentDigest }) => ({ candidateId, contentDigest })), reviewPins }
    }

    const initial = await readTarget()
    if (initial === undefined) return false
    const definition = await options.definitions.findVersion(template.namespace, template.definitionRef.id, template.definitionRef.version, scope, ctx)
    if (definition === undefined || !same(definition.ref, template.definitionRef) || definitionVersionDigest(definition) !== definition.ref.digest
      || !equal(definition, suppliedDefinition)) return false
    const assembled = buildDefinitionRecord({ workspace: initial.workspace, scopeRef: scope, definitionId: definition.definitionId,
      version: definition.version, projection: initial.projection, standardProvenance: [], publishedAt: definition.publishedAt })
    if (!equal(definitionSemantics(assembled), definitionSemantics(definition))) return false

    if (new Set(suppliedRules.map((row) => row.ruleId)).size !== suppliedRules.length) return false
    const actualRules = new Map<string, { candidate: RuleCandidate; declarationRef: VersionRef; publishedRef: VersionRef }>()
    for (const alias of template.rules) {
      if (!isUuid(alias.sourceCandidateId) || !isUuid(alias.publicationId)) return false
      const inventory = await options.reviews.listRuleVersions(scope, { sourceCandidateId: alias.sourceCandidateId, publicationId: alias.publicationId, limit: 2 }, ctx)
      if (inventory.length !== 1) return false
      const published = inventory.find((row) => same(publishedRuleRef(row), alias.publishedRef))
      const candidate = published === undefined ? undefined : await options.candidates.getCandidate(scope, published.sourceCandidateId, ctx)
      const declared = candidate?.kind === 'rule' ? suppliedRules.find((row) => row.candidateId === candidate.candidateId) : undefined
      if (candidate?.kind === 'rule' && (candidate.issues.length > 0 || candidate.state === 'failed' || candidate.state === 'rejected')) return false
      const origin = published === undefined ? undefined : await options.reviews.getPublication(scope, published.publicationId, ctx)
      if (published === undefined || candidate?.kind !== 'rule' || declared === undefined || !equal(candidate, declared) || origin === undefined || !same(origin.schemaRef, definition.ref)
        || !equal(candidate.expression, published.expression) || !equal(candidate.exceptions, published.exceptions)
        || !equal(candidate.conclusion, published.conclusion) || !equal(candidate.ruleDependencies ?? [], published.ruleDependencies ?? []) || !equal(candidate.dependencyRefs ?? [], published.dependencyRefs ?? [])) return false
      const revision = await options.reviews.latestReviewRevision(scope, candidate.candidateId, ctx)
      const review = await options.reviews.getReview(scope, candidate.candidateId, revision, ctx)
      const view = await options.reviewableCandidates.readCandidate(scope, candidate.candidateId, ctx)
      if (view?.domain !== 'instance' || view.kind !== 'rule' || view.candidateId !== candidate.candidateId || view.state !== candidate.state
        || view.contentDigest === undefined || review?.decision !== 'approve' || review.contentDigest !== view.contentDigest || actualRules.has(candidate.ruleId)) return false
      actualRules.set(candidate.ruleId, { candidate, declarationRef: alias.declarationRef, publishedRef: alias.publishedRef })
    }
    const currentRules = initial.rules.filter((row): row is RuleCandidateVersion => row.kind === 'rule' && row.payload.kind === 'rule')
    if (currentRules.length !== actualRules.size) return false
    const byId = new Map(currentRules.map((row) => [row.payload.ruleId, row]))
    if (byId.size !== currentRules.length) return false
    const resolver = (ref: VersionRef, side: 'target' | 'template'): string | undefined => {
      for (const [id, actual] of actualRules) {
        const targetRule = byId.get(id)
        if (targetRule === undefined) continue
        const matches = side === 'template' ? same(ref, actual.publishedRef)
          : same(ref, actual.declarationRef) || same(ref, { id: targetRule.candidateId, version: '1.0.0', digest: targetRule.contentDigest })
        if (matches) return id
      }
      return undefined
    }
    let unresolved = false
    const normalize = (value: unknown, side: 'target' | 'template'): unknown => {
      if (Array.isArray(value)) return value.map((row) => normalize(row, side))
      if (!isRecord(value)) return value
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'spans').map(([key, row]) => {
        if (key !== 'ruleRefs') return [key, normalize(row, side)]
        if (!Array.isArray(row) || row.some((ref: unknown) => !isVersionRef(ref) || resolver(ref, side) === undefined)) { unresolved = true; return [key, row] }
        return [key, row.map((ref: VersionRef) => resolver(ref, side))]
      }))
    }
    const deps = (refs: readonly RuleDependencyCandidateReference[], side: 'target' | 'template') => refs.map((ref) => {
      const id = resolver(ref.ruleRef, side), upstream = id === undefined ? undefined : actualRules.get(id)
      if (upstream === undefined || id !== ref.ruleId || upstream.candidate.objectId !== ref.objectId || !isRecord(upstream.candidate.conclusion)
        || upstream.candidate.conclusion['predicate'] !== ref.predicate || (ref.scopeRef !== undefined && !equal(ref.scopeRef, scope))
        || (ref.definitionRef !== undefined && !same(ref.definitionRef, side === 'template' ? template.definitionRef : template.declarationDefinitionRef))
        || ref.projectId !== undefined || ref.publishedPackRef !== undefined) { unresolved = true; return { unresolved: true, original: ref } }
      return { ruleId: id, objectId: ref.objectId, predicate: ref.predicate, scopeRef: scope, definition: 'validated-exact-semantic-definition' }
    }).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
    for (const row of currentRules) {
      const actual = actualRules.get(row.payload.ruleId)
      if (actual === undefined || !equal(row.payload.applicability, { objectId: actual.candidate.objectId })
        || !equal(normalize(row.payload.condition, 'target'), normalize(actual.candidate.expression, 'template'))
        || !equal(normalize(row.payload.exceptions, 'target'), normalize(actual.candidate.exceptions, 'template'))
        || !equal(row.payload.conclusion, actual.candidate.conclusion)
        || !equal([...row.payload.ruleDependencies].sort(), [...actual.candidate.ruleDependencies ?? []].sort())
        || !equal(deps(row.payload.dependencyRefs ?? [], 'target'), deps(actual.candidate.dependencyRefs ?? [], 'template'))) return false
      const checked = support.validate({ ruleId: row.payload.ruleId, condition: row.payload.condition, exceptions: row.payload.exceptions,
        ruleDependencies: row.payload.ruleDependencies, ...(row.payload.dependencyRefs === undefined ? {} : { dependencyRefs: row.payload.dependencyRefs }),
        dependencyLookup: new Map(currentRules.map((rule) => [rule.payload.ruleId, rule.payload.ruleDependencies])), relationPremises: relationPremisesFromDefinition(definition, row.payload.condition) })
      if (unresolved || !checked.executable || !row.payload.support.executable || !equal(row.payload.support.condition, row.payload.condition) || !equal(row.payload.support.exceptions, row.payload.exceptions)) return false
    }

    const rows: readonly (AssetCandidateVersion | RuleActionCandidateVersion)[] = [...initial.projection, ...initial.rules]
    const refs = [...new Map(rows.flatMap((row) => [...row.sourceRefs, ...('generationContext' in row ? row.generationContext?.inputSourceRefs ?? [] : [])]).map((ref) => [canonicalJson(ref), ref])).values()]
    if (refs.length === 0 || refs.length > 64) return false
    const budget = new SourceGroundingBudget(signal)
    const read = await options.grounding.read({ workspaceId: target.workspaceId, sourceRefs: refs,
      inputDraftRef: { workspaceId: target.workspaceId, revision: initial.draft.revision, digest: initial.draft.digest } }, ctx, budget)
    if (read.coverage !== 'complete' || !same(read.documentSetRef, initial.draft.documentSetRef) || read.sources.length !== refs.length
      || read.sources.some((source) => source.status !== 'complete' || source.reasons.length > 0 || source.contents.length === 0)) return false
    const sourceOrigins = new Map(read.sources.map((source) => [canonicalJson(source.sourceRef), new Set(sourceSpans(source.contents).map(spanKey))]))
    if (sourceOrigins.size !== refs.length || refs.some((ref) => !sourceOrigins.has(canonicalJson(ref)))) return false
    if (rows.some((row) => row.sourceSpans.some((span) => !row.sourceRefs.some((ref) => sourceOrigins.get(canonicalJson(ref))?.has(spanKey(span)))))) return false
    for (const row of currentRules) {
      const origins = read.sources.filter((source) => row.sourceRefs.some((ref) => same(ref, source.sourceRef)))
        .flatMap((source) => sourceSpans(source.contents)).filter((span) => span.kind !== 'structured')
      const actual = new Map(origins.map((span) => [ruleSpanKey(span) ?? '', span]))
      const bindings = row.generationContext === undefined ? undefined : new Map(row.generationContext.sourceBindings.map((binding) => [binding.path, binding.sourceSpan]))
      if (!ruleOrigins(row.payload.condition, actual, 'condition', bindings) || !ruleOrigins(row.payload.exceptions, actual, 'exceptions', bindings)) return false
    }
    for (const row of initial.rules) if (row.generationContext !== undefined) {
      const context = row.generationContext
      if (context.sourceSelections.length !== context.sourceBindings.length || new Set(context.sourceBindings.map((binding) => binding.path)).size !== context.sourceBindings.length) return false
      const sources = context.inputSourceRefs.flatMap((ref) => read.sources.filter((source) => same(source.sourceRef, ref)))
      if (sources.length !== context.inputSourceRefs.length) return false
      const fragments = groundingFragments(sources)
      for (const binding of context.sourceBindings) {
        const selection = context.sourceSelections.find((row) => row.path === binding.path)
        const selected = selection === undefined ? undefined : selectedGrounding(fragments, selection.sourceIndex, selection.fragmentIndex)
        if (selected === undefined || !same(selected.sourceRef, binding.sourceRef) || spanKey(selected.sourceSpan) !== spanKey(binding.sourceSpan)) return false
      }
    }
    // Template candidate bodies and their human review heads are fenced too.
    const finalDefinition = await options.definitions.findVersion(template.namespace, template.definitionRef.id, template.definitionRef.version, scope, ctx)
    if (!equal(finalDefinition, definition)) return false
    for (const actual of actualRules.values()) {
      const candidate = await options.candidates.getCandidate(scope, actual.candidate.candidateId, ctx)
      const revision = await options.reviews.latestReviewRevision(scope, actual.candidate.candidateId, ctx)
      const review = await options.reviews.getReview(scope, actual.candidate.candidateId, revision, ctx)
      const view = await options.reviewableCandidates.readCandidate(scope, actual.candidate.candidateId, ctx)
      if (!equal(candidate, actual.candidate) || view?.domain !== 'instance' || view.kind !== 'rule' || view.candidateId !== actual.candidate.candidateId
        || view.state !== actual.candidate.state || view.contentDigest === undefined || review?.decision !== 'approve' || review.contentDigest !== view.contentDigest) return false
    }
    const final = await readTarget()
    // Current same-content reapproval may advance audit revision; rejection/body,
    // source, complete candidate inventory and draft pins must remain unchanged.
    signal.throwIfAborted()
    return final !== undefined && equal({ ...initial, approvals: ordered(initial.approvals), reviewPins: ordered(initial.reviewPins) },
      { ...final, approvals: ordered(final.approvals), reviewPins: ordered(final.reviewPins) })
  }
}
